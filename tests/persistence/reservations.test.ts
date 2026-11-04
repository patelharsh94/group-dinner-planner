import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { isolatedDatabase } from "./database.js";
import { migrate } from "../../src/persistence/migrate.js";
import { PgStore, type DinnerRecord } from "../../src/persistence/store.js";
import {
  ReservationService,
  getReservation,
} from "../../src/application/reservations.js";
import { deleteReservationContactsForUser } from "../../src/persistence/reservations.js";
import {
  OpenTableProvider,
  type ReservationProvider,
} from "../../src/adapters/opentable.js";
import {
  createDinner,
  approveMember,
  updateConstraints,
  proposeOptions,
  confirmVersion,
} from "../../src/domain/index.js";
import type { AppDinner } from "../../src/application/model.js";
const now = "2026-11-02T12:00:00Z",
  key = Buffer.alloc(32).toString("base64");
function fixture(id: string): AppDinner {
  let d = createDinner(
    id,
    "a",
    {
      city: "Chicago",
      area: "Loop",
      windowStart: "2026-11-03",
      windowEnd: "2026-11-04",
      timezone: "America/Chicago",
      currency: "USD",
      timezoneConfirmed: true,
      currencyConfirmed: true,
      durationMinutes: 90,
      budget: { amount: 60, basis: "per-person" },
      intendedAttendees: ["a", "b"],
    },
    now,
  );
  d = approveMember(
    d,
    "a",
    { id: "b", consent: true, startedBot: true, remindersOptIn: true },
    now,
  );
  for (const user of ["a", "b"])
    d = updateConstraints(
      d,
      user,
      {
        availability: [
          {
            start: "2026-11-03T18:00:00-06:00",
            end: "2026-11-03T22:00:00-06:00",
          },
        ],
      },
      now,
    );
  const c = {
    status: "known" as const,
    url: "https://venue.example/reservations",
    retrievedAt: now,
    excerpt: "Verified fixture source",
  };
  d = {
    ...d,
    venues: [
      {
        id: "v",
        bookingLink: {url:"https://venue.example/reservations",sourceUrl:"https://venue.example",retrievedAt:now,provider:"Restaurant",provenance:"official_link"},
        name: "Venue",
        address: "1 Main",
        city: "Chicago",
        area: "Loop",
        evidence: {
          location: c,
          price: { ...c, amount: 40, currency: "USD", basis: "per-person" },
          opening: {
            ...c,
            intervals: [
              {
                start: "2026-11-03T18:00:00-06:00",
                end: "2026-11-03T23:00:00-06:00",
              },
            ],
          },
          reservation: { ...c, state: "not-booked" },
          dietary: {},
          travel: {},
        },
      },
    ],
  };
  d = proposeOptions(
    d,
    "a",
    [
      {
        venueId: "v",
        start: "2026-11-03T19:00:00-06:00",
        end: "2026-11-03T20:30:00-06:00",
        pricePerPerson: 40,
        priceBasis: "per-person",
        durationMinutes: 90,
      },
    ],
    now,
  );
  for (const user of ["a", "b"])
    d = confirmVersion(d, user, d.activeVersion!, now);
  return {
    dinner: d,
    roster: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
    consents: {
      a: { active: true, at: now, version: "1.0" },
      b: { active: true, at: now, version: "1.0" },
    },
    joinRequests: {},
    reminders: {},
    collectionNotified: true,
  };
}
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "reservation durable safety",
  () => {
    const db = isolatedDatabase(),
      store = new PgStore(db.pool);
    beforeAll(async () => {
      await db.setup();
      await migrate(db.pool);
      const table = await db.pool.query(
        "SELECT to_regclass('reservation_attempts') AS t",
      );
      if (!table.rows[0].t)
        await db.pool.query(
          await readFile(
            new URL("../../migrations/007_reservations.sql", import.meta.url),
            "utf8",
          ),
        );
    });
    afterAll(() => db.cleanup());
    const create = (id: string) =>
      store.transaction((tx) =>
        tx.createDinner({ id, organizerId: "a", state: fixture(id) }),
      );
    it("LINK02 never converts generic reservation evidence into a booking destination", async () => {
      const state = fixture("evidence-is-not-booking");
      delete state.dinner.venues[0].bookingLink;
      state.dinner.venues[0].evidence.reservation.url = "https://venue.example/menu";
      const record = await store.transaction(tx => tx.createDinner({id:"evidence-is-not-booking",organizerId:"a",state}));
      const service = new ReservationService(store,new OpenTableProvider(),key,{},()=>now);
      const review = await store.transaction(tx => service.review(tx,record,"a",{version:1}));
      expect(review.bookingUrl).toBeUndefined();
      expect(review.status).toBe("handoff_required");
    });
    it("supports verified handoff and honest organizer reports; blocks duplicate across plan changes", async () => {
      const record = await create("manual"),
        service = new ReservationService(
          store,
          new OpenTableProvider(),
          key,
          {},
          () => now,
        );
      const review = await store.transaction((tx) =>
        service.review(tx, record, "a", { version: 1 }),
      );
      expect(review.status).toBe("handoff_required");
      expect(review.bookingUrl).toBe("https://venue.example/reservations");
      await expect(
        store.transaction((tx) =>
          service.report(tx, record, "b", { version: 1, confirmed: true }),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const report = await store.transaction((tx) =>
        service.report(tx, record, "a", {
          version: 1,
          confirmed: true,
          reference: "Organizer says 123",
        }),
      );
      expect(report.status).toBe("organizer_reported");
      expect(report.provider).toBeUndefined();
      await expect(
        store.transaction((tx) =>
          service.report(tx, record, "a", { version: 1, confirmed: true }),
        ),
      ).rejects.toMatchObject({ code: "RESERVATION_EXISTS" });
      expect(
        (await store.transaction((tx) => getReservation(tx, record.id, 2)))
          .mismatch,
      ).toBe(true);
      await store.transaction((tx) => tx.deleteDinner(record.id));
      expect(
        (
          await db.pool.query(
            "SELECT * FROM reservation_attempts WHERE dinner_id=$1",
            [record.id],
          )
        ).rowCount,
      ).toBe(0);
    });
    it("encrypts contact, never retries ambiguous submission, and clears contact on user deletion", async () => {
      const record = await create("auto");
      const provider: ReservationProvider = {
        capability: () => ({
          available: true,
          provider: "fixture",
          message: "ready",
        }),
        availability: vi.fn(async () => ({
          status: "ready" as const,
          message: "No fees",
        })),
        create: vi.fn(async () => {
          throw new Error("timeout");
        }),
        lookup: vi.fn(async () => ({
          status: "unknown" as const,
          message: "unknown",
        })),
      };
      const service = new ReservationService(
        store,
        provider,
        key,
        { "https://venue.example/reservations": "42" },
        () => now,
      );
      const review = await store.transaction((tx) =>
        service.review(tx, record, "a", { version: 1 }),
      );
      let work = await store.claimOutbox("r", 60000, "reservation");
      await service.processReservation(work!, "r");
      const ready = (
        await store.transaction((tx) => getReservation(tx, record.id))
      ).review!;
      expect(ready.status).toBe("ready");
      const attempt = await store.transaction((tx) =>
        service.book(tx, record, "a", {
          version: 1,
          reviewId: review.reviewId,
          consent: true,
          contact: {
            firstName: "Secret",
            lastName: "Contact",
            email: "private@example.com",
            phone: "3125551234",
            countryCode: "US",
          },
        }),
      );
      const raw = await db.pool.query(
        "SELECT encrypted_contact,attempt FROM reservation_attempts WHERE id=$1",
        [attempt.id],
      );
      expect(JSON.stringify(raw.rows)).not.toContain("private@example.com");
      expect(raw.rows[0].encrypted_contact).toBeTruthy();
      work = await store.claimOutbox("r", 60000, "reservation");
      await service.processReservation(work!, "r");
      await service.processReservation(work!, "r");
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(
        (await store.transaction((tx) => getReservation(tx, record.id))).attempt
          ?.status,
      ).toBe("unknown");
      expect(
        (
          await db.pool.query(
            "SELECT encrypted_contact FROM reservation_attempts WHERE id=$1",
            [attempt.id],
          )
        ).rows[0].encrypted_contact,
      ).toBeNull();
      await db.pool.query(
        "UPDATE reservation_attempts SET encrypted_contact='fixture' WHERE id=$1",
        [attempt.id],
      );
      await store.transaction((tx) =>
        deleteReservationContactsForUser(tx, "a"),
      );
      expect(
        (
          await db.pool.query(
            "SELECT encrypted_contact,user_id FROM reservation_attempts WHERE id=$1",
            [attempt.id],
          )
        ).rows[0],
      ).toEqual({ encrypted_contact: null, user_id: null });
    });
    it("rejects stale versions, missing full group confirmation and missing explicit consent", async () => {
      const record = await create("gates"),
        service = new ReservationService(
          store,
          new OpenTableProvider(),
          key,
          {},
          () => now,
        );
      await expect(
        store.transaction((tx) =>
          service.review(tx, record, "a", { version: 2 }),
        ),
      ).rejects.toMatchObject({ code: "STALE" });
      const missing = structuredClone(record);
      missing.state.dinner.confirmations.b = 0;
      await expect(
        store.transaction((tx) =>
          service.review(tx, missing, "a", { version: 1 }),
        ),
      ).rejects.toMatchObject({ code: "NOT_READY" });
      await expect(
        store.transaction((tx) =>
          service.report(tx, record, "a", {
            version: 1,
            confirmed: false,
          } as never),
        ),
      ).rejects.toThrow();
    });
  },
);

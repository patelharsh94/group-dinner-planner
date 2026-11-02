import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { encrypt } from "../../src/adapters/security.js";
import {
  proposeOptions,
  setVenues,
  type Venue,
} from "../../src/domain/index.js";
import { Worker } from "../../src/application/worker.js";
import type { MuseClient, ResearchContext } from "../../src/adapters/muse.js";
import type { TelegramTransport } from "../../src/adapters/telegram.js";
import { MiniAppService } from "../../src/miniapp/service.js";
import { formVersion } from "../../src/miniapp/view.js";
import { Coordinator } from "../../src/application/coordinator.js";
import type { AppDinner } from "../../src/application/model.js";
import type { Config } from "../../src/config.js";
import { PgStore } from "../../src/persistence/store.js";
import { migrate } from "../../src/persistence/migrate.js";
import { isolatedDatabase } from "./database.js";
const now = "2026-11-01T18:00:00Z",
  owner = { id: "100", name: "Owner" },
  guest = { id: "200", name: "Guest" },
  other = { id: "300", name: "Other" };
const config = {
  MODEL_API_KEY: "test-only",
  MAX_ACTIVE_DINNERS: 100,
  MAX_UPDATES_PER_USER_PER_DAY: 1000,
  MAX_RESEARCH_PER_DINNER_PER_DAY: 10,
  SUPPORT_CONTACT: "support@example.test",
  PUBLIC_URL: "https://dinner.example.test",
  TELEGRAM_BOT_USERNAME: "dinnerbot",
  CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
} as Config;
const setup = {
  city: "Chicago",
  windowStart: "2026-11-05",
  windowEnd: "2026-11-07",
  timezone: "America/Chicago",
  currency: "USD",
  durationMinutes: 90,
  partySize: 2,
  budget: { amount: 60 },
  consent: true,
};
const preferences = {
  availability: [
    { start: "2026-11-05T18:00:00-06:00", end: "2026-11-05T22:00:00-06:00" },
  ],
  dietary: [],
  foodConfirmed: true,
};
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "Mini App service transactions",
  () => {
    const db = isolatedDatabase(),
      store = new PgStore(db.pool),
      coordinator = new Coordinator(config, undefined, () => now),
      service = new MiniAppService(store, coordinator, config);
    beforeAll(async () => {
      await db.setup();
      await migrate(db.pool);
    });
    afterAll(async () => db.cleanup());
    beforeEach(async () => {
      await db.pool.query(
        "TRUNCATE dinners,user_sessions,inbox,outbox,usage_counts,miniapp_receipts CASCADE",
      );
      for (const user of [owner, guest, other])
        await store.transaction((tx) =>
          tx.setSession(user.id, {
            currentDinnerId: null,
            pendingSetup: null,
            pendingOnboard: null,
          }),
        );
    });
    const create = async (partySize = 2) => {
      const response = await service.mutate(owner, {
        requestId: "create-request",
        action: "create",
        payload: { ...setup, partySize },
      });
      return {
        id: response.dinner!.id,
        view: response.dinner!,
        token: new URL(response.invitationUrl!).searchParams.get("start")!,
      };
    };
    const join = async (id: string, token: string, user = guest) =>
      service.mutate(user, {
        requestId: "join-request",
        action: "join",
        dinnerId: id,
        formVersion: (await service.bootstrap(user, token)).invitation!
          .formVersion,
        payload: { invite: token, consent: true, preferences },
      });
    const approve = async (id: string, user = guest) =>
      service.mutate(owner, {
        requestId: "approve-" + user.id,
        action: "approve",
        dinnerId: id,
        payload: { userId: user.id },
      });
    it("coordinates two Mini App attendees through agreement, an objection, and a rescheduled fresh agreement", async () => {
      const { id, token } = await create();
      let request = 0;
      const act = (
        actor: typeof owner,
        action: string,
        payload: unknown = {},
      ) =>
        service.mutate(actor, {
          requestId: `acceptance-${++request}`,
          action,
          dinnerId: id,
          payload,
        });
      const savePreferences = async (actor: typeof owner, payload: unknown) =>
        service.mutate(actor, {
          requestId: `acceptance-save-${++request}`,
          action: "savePreferences",
          dinnerId: id,
          formVersion: (await service.dinner(actor, id)).formVersion,
          payload,
        });
      const state = async () =>
        (await store.readDinner<AppDinner>(id))!.state.dinner;
      const muse = {
        research: vi.fn(async (context: ResearchContext) => {
          // Deterministic synthetic source fixtures only: no live restaurant/model calls.
          const claim = {
            status: "known" as const,
            url: "https://fixture.example/restaurant",
            retrievedAt: now,
            excerpt:
              "Synthetic acceptance-test evidence, not live restaurant evidence",
          };
          const venues = ["original", "alternative"].map((venueId) => ({
            id: venueId,
            name: `Synthetic ${venueId}`,
            address: `${venueId} Fixture Street`,
            city: context.setup.city,
            area: context.setup.area,
            evidence: {
              location: claim,
              price: {
                ...claim,
                amount: 40,
                basis: "per-person" as const,
                currency: context.setup.currency,
              },
              opening: { ...claim, intervals: context.slots },
              reservation: { ...claim, status: "unknown" as const },
              dietary: Object.fromEntries(
                context.dietary.map((d) => [
                  d.requirement,
                  { ...claim, supported: venueId === "alternative" },
                ]),
              ),
              travel: {},
            },
          }));
          return {
            venues,
            options: venues.map((venue) => ({
              venueId: venue.id,
              ...context.slots[0],
              pricePerPerson: 40,
              priceBasis: "per-person" as const,
              durationMinutes: context.setup.durationMinutes,
            })),
            gaps: [],
          };
        }),
      };
      const worker = new Worker(
        store,
        coordinator,
        { send: async () => {} } as unknown as TelegramTransport,
        muse as unknown as MuseClient,
      );
      const leaseOwner = "miniapp-acceptance-research";
      (worker as unknown as { workerId: string }).workerId = leaseOwner;
      const research = async () => {
        const work = await store.claimOutbox(leaseOwner, 180000, "research");
        expect(work).not.toBeNull();
        await worker.runJob(work!);
        expect(
          (
            await db.pool.query("SELECT status FROM outbox WHERE id=$1", [
              work!.id,
            ])
          ).rows[0].status,
        ).toBe("sent");
      };
      await savePreferences(owner, preferences);
      await join(id, token);
      await approve(id);
      await research();
      const originalVersion = (await state()).activeVersion!;
      expect((await state()).proposals.at(-1)!.options).toHaveLength(2);
      await act(owner, "confirm", { version: originalVersion });
      expect((await state()).status).toBe("proposed");
      await act(guest, "confirm", { version: originalVersion });
      expect((await state()).status).toBe("agreed");

      await act(guest, "change", {
        reason: "I need a firm vegan option; please revise the venue.",
      });
      const veganPreferences = {
        ...preferences,
        dietary: [
          { requirement: "vegan", strength: "firm" as const, allergy: false },
        ],
      };
      await savePreferences(guest, veganPreferences);
      expect(
        (
          await db.pool.query(
            "SELECT count(*)::int AS count FROM outbox WHERE kind='research' AND status='pending'",
          )
        ).rows[0].count,
      ).toBe(1);
      await research();
      let revised = await state();
      expect(revised.proposals.at(-1)!.options[0].venueId).toBe("alternative");
      expect(revised.confirmations).toEqual({});
      expect(revised.constraints[guest.id].availability).toEqual(
        preferences.availability,
      );
      await act(guest, "resolve");
      const revisedVersion = (await state()).activeVersion!;
      await act(owner, "confirm", { version: revisedVersion });
      await act(guest, "confirm", { version: revisedVersion });
      expect((await state()).status).toBe("agreed");

      const laterStart = "2026-11-05T20:00:00-06:00";
      await savePreferences(guest, {
        ...veganPreferences,
        availability: [{ start: laterStart, end: "2026-11-05T22:00:00-06:00" }],
      });
      expect((await state()).confirmations).toEqual({});
      await expect(
        act(owner, "confirm", { version: revisedVersion }),
      ).rejects.toMatchObject({ code: "STALE" });
      await research();
      revised = await state();
      const finalVersion = revised.activeVersion!;
      expect(finalVersion).toBeGreaterThan(revisedVersion);
      expect(
        Date.parse(revised.proposals.at(-1)!.options[0].start),
      ).toBeGreaterThanOrEqual(Date.parse(laterStart));
      expect(revised.constraints[guest.id].dietary).toEqual(
        veganPreferences.dietary,
      );
      await act(owner, "confirm", { version: finalVersion });
      expect((await state()).status).toBe("proposed");
      await act(guest, "confirm", { version: finalVersion });
      expect((await state()).status).toBe("agreed");
      expect((await state()).confirmations).toEqual({
        [owner.id]: finalVersion,
        [guest.id]: finalVersion,
      });
      const calendar = await service.calendar(guest, id);
      expect(calendar).toContain("BEGIN:VCALENDAR");
      expect(calendar).toContain(`SEQUENCE:${finalVersion}`);
      expect(calendar).toContain("Synthetic alternative");
      expect(muse.research).toHaveBeenCalledTimes(3);
    });
    it("requires trusted private bot start even for valid Telegram identity", async () => {
      await expect(
        service.bootstrap({ id: "900", name: "Unknown" }),
      ).rejects.toMatchObject({ code: "BOT_START_REQUIRED", status: 403 });
    });
    it("creates a two-person dinner without guest names and persistently deduplicates requests", async () => {
      const first = await create();
      expect(first.view.progress.expected).toBe(2);
      expect(first.view.setup.area).toBe("Chicago");
      const replay = await service.mutate(owner, {
        requestId: "create-request",
        action: "create",
        payload: setup,
      });
      expect(replay.dinner?.id).toBe(first.id);
      expect(await store.activeDinnerCount()).toBe(1);
      await expect(
        service.mutate(owner, {
          requestId: "create-request",
          action: "create",
          payload: { ...setup, city: "Paris" },
        }),
      ).rejects.toMatchObject({ code: "REQUEST_REUSED" });
    });
    it("stages consent and preferences until an organizer atomically approves a free place", async () => {
      const { id, token } = await create();
      const pending = await join(id, token);
      expect(pending.dinner?.role).toBe("pending");
      expect(pending.dinner?.members).toEqual([]);
      let record = (await store.readDinner<AppDinner>(id))!;
      expect(record.state.dinner.members).toHaveLength(1);
      expect(record.state.dinner.constraints[guest.id]).toBeUndefined();
      expect(record.state.joinRequests[guest.id].slot).toBeNull();
      const bootstrap = await service.bootstrap(guest, token);
      expect(bootstrap.invitation).toMatchObject({
        timezone: "America/Chicago",
        currency: "USD",
        pending: true,
      });
      await approve(id);
      record = (await store.readDinner<AppDinner>(id))!;
      expect(record.state.dinner.members.map((m) => m.id)).toContain(guest.id);
      expect(record.state.dinner.constraints[guest.id].availability).toEqual(
        preferences.availability,
      );
      expect(record.state.joinRequests[guest.id]).toBeUndefined();
      expect((await service.dinner(guest, id)).role).toBe("member");
    });
    it("never returns another participant constraints or staged preferences", async () => {
      const { id, token } = await create();
      await service.mutate(owner, {
        requestId: "owner-preferences",
        action: "savePreferences",
        dinnerId: id,
        formVersion: (await service.dinner(owner, id)).formVersion,
        payload: {
          ...preferences,
          travel: {
            maxMinutes: 30,
            strength: "firm",
            origin: "SECRET_OWNER_HOME",
          },
          dietary: [
            {
              requirement: "SECRET_OWNER_ALLERGY",
              allergy: true,
              strength: "firm",
            },
          ],
        },
      });
      await join(id, token);
      const pending = await service.dinner(guest, id);
      expect(JSON.stringify(pending)).not.toContain("SECRET_OWNER");
      expect(pending.pendingRequests).toBeUndefined();
      await approve(id);
      const member = await service.dinner(guest, id);
      expect(JSON.stringify(member)).not.toContain("SECRET_OWNER");
      expect(JSON.stringify(member)).not.toContain("proposals");
      expect(JSON.stringify(member)).not.toContain("busy");
      await expect(service.dinner(other, id)).rejects.toMatchObject({
        status: 403,
      });
    });
    it("scopes stale forms to own input and public setup, allowing concurrent guest saves", async () => {
      const { id, token } = await create(3);
      await join(id, token);
      await join(id, token, other);
      await approve(id);
      await approve(id, other);
      const guestForm = (await service.dinner(guest, id)).formVersion,
        otherForm = (await service.dinner(other, id)).formVersion;
      await service.mutate(guest, {
        requestId: "guest-save-1",
        action: "savePreferences",
        dinnerId: id,
        formVersion: guestForm,
        payload: { ...preferences, preferences: ["quiet"] },
      });
      expect((await service.dinner(other, id)).formVersion).toBe(otherForm);
      await service.mutate(other, {
        requestId: "other-save-1",
        action: "savePreferences",
        dinnerId: id,
        formVersion: otherForm,
        payload: { ...preferences, preferences: ["outdoors"] },
      });
      await expect(
        service.mutate(guest, {
          requestId: "guest-stale-2",
          action: "savePreferences",
          dinnerId: id,
          formVersion: guestForm,
          payload: preferences,
        }),
      ).rejects.toMatchObject({ code: "STALE_FORM" });
    });
    it("preserves dietary requirements absent explicit removal and clears confirmations", async () => {
      const { id } = await create();
      const save = async (requestId: string, payload: unknown) =>
        service.mutate(owner, {
          requestId,
          action: "savePreferences",
          dinnerId: id,
          formVersion: (await service.dinner(owner, id)).formVersion,
          payload,
        });
      await save("firm-dietary", {
        ...preferences,
        dietary: [{ requirement: "peanut", allergy: true, strength: "firm" }],
      });
      await save("missing-is-not-removal", preferences);
      expect(
        (await service.dinner(owner, id)).own.constraints.dietary,
      ).toHaveLength(1);
      await save("explicit-removal", {
        ...preferences,
        removeDietary: ["peanut"],
      });
      expect((await service.dinner(owner, id)).own.constraints.dietary).toEqual(
        [],
      );
      expect(
        (await store.readDinner<AppDinner>(id))!.state.dinner.confirmations,
      ).toEqual({});
    });
    it("queues one automatic research when the last approved response completes", async () => {
      const { id, token } = await create();
      await service.mutate(owner, {
        requestId: "owner-complete",
        action: "savePreferences",
        dinnerId: id,
        formVersion: (await service.dinner(owner, id)).formVersion,
        payload: preferences,
      });
      await join(id, token);
      expect(
        (
          await db.pool.query(
            "SELECT count(*)::int AS count FROM outbox WHERE kind='research'",
          )
        ).rows[0].count,
      ).toBe(0);
      await approve(id);
      await approve(id);
      expect(
        (
          await db.pool.query(
            "SELECT count(*)::int AS count FROM outbox WHERE kind='research'",
          )
        ).rows[0].count,
      ).toBe(1);
    });
    it("rejects a guest form after shared timezone changes and validates per-person budgets", async () => {
      const { id, token } = await create(),
        version = (await service.bootstrap(guest, token)).invitation!
          .formVersion;
      await service.mutate(owner, {
        requestId: "update-timezone",
        action: "updateDinner",
        dinnerId: id,
        formVersion: (await service.dinner(owner, id)).formVersion,
        payload: { timezone: "America/New_York" },
      });
      await expect(
        service.mutate(guest, {
          requestId: "stale-guestjoin",
          action: "join",
          dinnerId: id,
          formVersion: version,
          payload: { invite: token, consent: true, preferences },
        }),
      ).rejects.toMatchObject({ code: "STALE_FORM" });
      await expect(
        service.mutate(owner, {
          requestId: "update-total-budget",
          action: "updateDinner",
          dinnerId: id,
          formVersion: (await service.dinner(owner, id)).formVersion,
          payload: { budget: { amount: 200, basis: "total" } },
        }),
      ).rejects.toThrow();
    });
    it("allows a stopped attendee to reconsent to their own occupied place", async () => {
      const { id, token } = await create();
      await join(id, token);
      await approve(id);
      await service.mutate(guest, { requestId: "guest-stop", action: "stop" });
      await store.transaction((tx) =>
        tx.setSession(guest.id, {
          currentDinnerId: null,
          pendingSetup: null,
          pendingOnboard: null,
        }),
      );
      const invite = (await service.bootstrap(guest, token)).invitation!;
      expect(invite.availablePlaces).toBe(1);
      await service.mutate(guest, {
        requestId: "guest-rejoin",
        action: "join",
        dinnerId: id,
        formVersion: invite.formVersion,
        payload: { invite: token, consent: true, preferences },
      });
      await service.mutate(owner, {
        requestId: "approve-rejoin",
        action: "approve",
        dinnerId: id,
        payload: { userId: guest.id },
      });
      expect((await service.dinner(guest, id)).role).toBe("member");
      expect(
        (await store.readDinner<AppDinner>(id))!.state.dinner.members,
      ).toHaveLength(2);
    });
    it("allows a pending guest to edit only their staged response before approval", async () => {
      const { id, token } = await create();
      await join(id, token);
      const pending = await service.dinner(guest, id);
      const changed = await service.mutate(guest, {
        requestId: "pending-preference-edit",
        action: "savePreferences",
        dinnerId: id,
        formVersion: pending.formVersion,
        payload: { ...preferences, preferences: ["SECRET_STAGED_CHOICE"] },
      });
      expect(changed.dinner?.own.constraints.preferences).toEqual([
        "SECRET_STAGED_CHOICE",
      ]);
      const record = (await store.readDinner<AppDinner>(id))!;
      expect(record.state.dinner.constraints[guest.id]).toBeUndefined();
      expect(JSON.stringify(await service.dinner(owner, id))).not.toContain(
        "SECRET_STAGED_CHOICE",
      );
      await approve(id);
      expect(
        (await service.dinner(guest, id)).own.constraints.preferences,
      ).toEqual(["SECRET_STAGED_CHOICE"]);
    });
    it("stores no private view in receipts and reprojects current state on replay", async () => {
      const { id } = await create();
      const form = (await service.dinner(owner, id)).formVersion;
      const first = {
        requestId: "saved-first-response",
        action: "savePreferences",
        dinnerId: id,
        formVersion: form,
        payload: { ...preferences, preferences: ["old-choice"] },
      };
      await service.mutate(owner, first);
      await service.mutate(owner, {
        requestId: "saved-second-response",
        action: "savePreferences",
        dinnerId: id,
        formVersion: (await service.dinner(owner, id)).formVersion,
        payload: { ...preferences, preferences: ["new-choice"] },
      });
      const replay = await service.mutate(owner, first);
      expect(replay.dinner?.own.constraints.preferences).toEqual([
        "new-choice",
      ]);
      const receipts = await db.pool.query(
        "SELECT response FROM miniapp_receipts WHERE user_id=$1",
        [owner.id],
      );
      expect(JSON.stringify(receipts.rows)).not.toContain("old-choice");
      expect(JSON.stringify(receipts.rows)).not.toContain("availability");
    });
    it("rechecks consent for cached actions and cascades guest receipts when the host deletes a dinner", async () => {
      const { id, token } = await create();
      const joinInput = {
        requestId: "guest-cached-join",
        action: "join",
        dinnerId: id,
        formVersion: (await service.bootstrap(guest, token)).invitation!
          .formVersion,
        payload: { invite: token, consent: true, preferences },
      };
      await service.mutate(guest, joinInput);
      await approve(id);
      await store.transaction(async (tx) => {
        const r = (await tx.getDinner<AppDinner>(id))!;
        r.state.consents[guest.id].active = false;
        await tx.saveDinner(r, r.revision);
      });
      await expect(service.mutate(guest, joinInput)).rejects.toMatchObject({
        code: "MEMBERSHIP",
      });
      await service.mutate(owner, {
        requestId: "host-delete-with-guest",
        action: "delete",
      });
      expect(
        (
          await db.pool.query(
            "SELECT count(*)::int AS count FROM miniapp_receipts WHERE user_id=$1",
            [guest.id],
          )
        ).rows[0].count,
      ).toBe(0);
      await expect(service.mutate(guest, joinInput)).rejects.toMatchObject({
        code: "DINNER",
      });
    });
    it("rejects selection from an older displayed proposal without creating another version", async () => {
      const { id } = await create();
      const option = {
        venueId: "venue",
        start: "2026-11-05T18:00:00-06:00",
        end: "2026-11-05T19:30:00-06:00",
        pricePerPerson: 40,
        priceBasis: "per-person" as const,
        durationMinutes: 90,
      };
      for (let version = 1; version <= 2; version++)
        await store.transaction(async (tx) => {
          const r = (await tx.getDinner<AppDinner>(id))!,
            next = structuredClone(r.state);
          next.dinner = proposeOptions(next.dinner, owner.id, [option], now);
          await coordinator.save(tx, r, next);
        });
      await expect(
        service.mutate(owner, {
          requestId: "stale-option-select",
          action: "select",
          dinnerId: id,
          payload: { index: 0, version: 1 },
        }),
      ).rejects.toMatchObject({ code: "STALE_PROPOSAL" });
      expect(
        (await store.readDinner<AppDinner>(id))!.state.dinner.activeVersion,
      ).toBe(2);
      expect(
        (
          await db.pool.query(
            "SELECT count(*)::int AS count FROM proposal_versions WHERE dinner_id=$1",
            [id],
          )
        ).rows[0].count,
      ).toBe(2);
    });
    it("invalidates a prior proposal until activated calendar busy data has been fetched", async () => {
      const { id } = await create();
      await store.transaction(async (tx) => {
        const r = (await tx.getDinner<AppDinner>(id))!,
          next = structuredClone(r.state);
        next.dinner = proposeOptions(
          next.dinner,
          owner.id,
          [
            {
              venueId: "venue",
              start: "2026-11-05T18:00:00-06:00",
              end: "2026-11-05T19:30:00-06:00",
              pricePerPerson: 40,
              priceBasis: "per-person",
              durationMinutes: 90,
            },
          ],
          now,
        );
        next.dinner.confirmations = { [owner.id]: 1 };
        await coordinator.save(tx, r, next);
        await tx.setCalendarConnection(
          id,
          owner.id,
          encrypt(
            {
              access_token: "SECRET_CALENDAR_TOKEN",
              expires_at: Date.parse(now) + 3600000,
              active: false,
            },
            config.CREDENTIAL_ENCRYPTION_KEY,
            `${id}:${owner.id}`,
          ),
        );
      });
      const result = await service.mutate(owner, {
        requestId: "activate-calendar",
        action: "calendarActivate",
        dinnerId: id,
      });
      expect(result.dinner?.activeVersion).toBeNull();
      expect(result.dinner?.own.calendar).toBe("unavailable");
      expect(JSON.stringify(result)).not.toContain("SECRET_CALENDAR_TOKEN");
      const record = (await store.readDinner<AppDinner>(id))!;
      expect(record.state.dinner.confirmations).toEqual({});
      const work = (
        await db.pool.query(
          "SELECT payload FROM outbox WHERE kind='calendar' AND dinner_id=$1",
          [id],
        )
      ).rows[0];
      expect(work.payload.revision).toBe(record.revision);
    });
    it("erases a pending response on stop and prevents approval of withdrawn staging", async () => {
      const { id, token } = await create();
      await join(id, token);
      await service.mutate(guest, {
        requestId: "stop-pending-response",
        action: "stop",
      });
      expect(
        (await store.readDinner<AppDinner>(id))!.state.joinRequests[guest.id],
      ).toBeUndefined();
      await expect(approve(id)).rejects.toMatchObject({ code: "CONSENT" });
      expect((await service.bootstrap(guest)).currentDinnerId).toBeNull();
    });
    it("binds staff allergy reports to the displayed proposal when research reuses a venue id", async () => {
      const { id } = await create();
      await service.mutate(owner, {
        requestId: "staff-allergy-preferences",
        action: "savePreferences",
        dinnerId: id,
        formVersion: (await service.dinner(owner, id)).formVersion,
        payload: {
          ...preferences,
          dietary: [{ requirement: "peanut", allergy: true, strength: "firm" }],
        },
      });
      const claim = {
        status: "known" as const,
        url: "https://fixture.example/evidence",
        retrievedAt: now,
        excerpt:
          "Synthetic source fixture for staff-report proposal binding only",
      };
      const install = async (name: string) =>
        store.transaction(async (tx) => {
          const record = (await tx.getDinner<AppDinner>(id))!,
            next = structuredClone(record.state);
          const venue: Venue = {
            id: "reused-venue-id",
            name,
            address: `${name} fixture address`,
            city: "Chicago",
            area: "Chicago",
            evidence: {
              location: claim,
              price: {
                ...claim,
                amount: 40,
                basis: "per-person",
                currency: "USD",
              },
              opening: { ...claim, intervals: preferences.availability },
              reservation: { ...claim, status: "unknown" },
              dietary: { peanut: { ...claim, supported: true } },
              travel: {},
            },
          };
          next.dinner = setVenues(next.dinner, owner.id, [venue], now);
          next.dinner = proposeOptions(
            next.dinner,
            owner.id,
            [
              {
                venueId: venue.id,
                start: "2026-11-05T18:00:00-06:00",
                end: "2026-11-05T19:30:00-06:00",
                durationMinutes: 90,
                pricePerPerson: 40,
                priceBasis: "per-person",
              },
            ],
            now,
          );
          await coordinator.save(tx, record, next);
        });
      await install("Venue A");
      const oldVersion = (await service.dinner(owner, id)).activeVersion!;
      await install("Venue B");
      const currentVersion = (await service.dinner(owner, id)).activeVersion!;
      const report = {
        venueId: "reused-venue-id",
        requirement: "peanut",
        report: "Staff confirmed safe accommodation at the displayed venue.",
        accommodationConfirmed: true,
      };
      await expect(
        service.mutate(owner, {
          requestId: "stale-staff-report",
          action: "staffReport",
          dinnerId: id,
          payload: { ...report, version: oldVersion },
        }),
      ).rejects.toMatchObject({ code: "STALE_PROPOSAL" });
      expect(
        (await store.readDinner<AppDinner>(id))!.state.dinner.staffReports,
      ).toEqual([]);
      expect((await service.dinner(owner, id)).options[0].venueName).toBe(
        "Venue B",
      );
      await service.mutate(owner, {
        requestId: "current-staff-report",
        action: "staffReport",
        dinnerId: id,
        payload: { ...report, version: currentVersion },
      });
      const reports = (await store.readDinner<AppDinner>(id))!.state.dinner
        .staffReports;
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        memberId: owner.id,
        venueId: "reused-venue-id",
        requirement: "peanut",
        accommodationConfirmed: true,
      });
    });
    it("deletes private receipts with user data and rejects exports before agreement", async () => {
      const { id } = await create();
      await expect(service.calendar(owner, id)).rejects.toThrow();
      expect(
        (
          await db.pool.query(
            "SELECT count(*)::int AS count FROM miniapp_receipts",
          )
        ).rows[0].count,
      ).toBe(1);
      await service.mutate(owner, {
        requestId: "delete-data",
        action: "delete",
      });
      expect(
        (
          await db.pool.query(
            "SELECT count(*)::int AS count FROM miniapp_receipts",
          )
        ).rows[0].count,
      ).toBe(0);
      expect(await store.readDinner(id)).toBeNull();
      await expect(service.bootstrap(owner)).rejects.toMatchObject({
        code: "BOT_START_REQUIRED",
      });
    });
  },
);

import { isolatedDatabase } from "./database.js";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/persistence/migrate.js";
import { PgStore } from "../../src/persistence/store.js";
import { Coordinator } from "../../src/application/coordinator.js";
import { Worker } from "../../src/application/worker.js";
import type { AppDinner } from "../../src/application/model.js";
import type { Config } from "../../src/config.js";
import type { ResearchContext } from "../../src/adapters/muse.js";
import { googleCallback } from "../../src/application/oauth.js";
import type { GoogleCalendar } from "../../src/adapters/google.js";
import { tokenHash } from "../../src/adapters/security.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "Database-backed synthetic dinner conversation",
  () => {
    const database = isolatedDatabase(),
      pool = database.pool;
    const store = new PgStore(pool),
      workerId = "conversation-worker";
    const now = new Date().toISOString();
    const day = DateTime.fromISO(now)
      .setZone("America/Chicago")
      .plus({ days: 2 })
      .toISODate()!;
    const windowEnd = DateTime.fromISO(day).plus({ days: 7 }).toISODate()!;
    const config = {
      PUBLIC_URL: "https://planner.example",
      SUPPORT_CONTACT: "help@example.com",
      TELEGRAM_BOT_USERNAME: "syntheticbot",
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
      MODEL_API_KEY: "synthetic-test-only",
      MAX_ACTIVE_DINNERS: 100,
      MAX_UPDATES_PER_USER_PER_DAY: 1000,
      MAX_RESEARCH_PER_DINNER_PER_DAY: 10,
    } as Config;
    const coordinator = new Coordinator(config, undefined, () => now);
    let sequence = 0,
      dinnerId = "",
      invite = "",
      originalVersion = 0;
    const users = ["901", "902", "903", "904"];
    beforeAll(async () => {
      await database.setup();
      await migrate(pool);
    });
    afterAll(async () => {
      await database.cleanup();
    });
    async function send(user: string, text: string) {
      const eventId = `conversation-${++sequence}`;
      const input = {
        eventId,
        actorId: user,
        chatId: user,
        name: `Fixture ${user}`,
        text,
        ...(/^(choose|consent|approve|apply|confirm|select|staff):/.test(text)
          ? { callbackId: `fixture-${sequence}` }
          : {}),
      };
      await store.enqueueInbox(eventId, input);
      const work = await store.claimInbox(workerId);
      expect(work?.id).toBe(eventId);
      await store.processInbox(eventId, workerId, (tx, payload) =>
        coordinator.handle(tx, payload),
      );
      // A replay must not duplicate its state transition or outbound work.
      expect(await store.enqueueInbox(eventId, input)).toBe(false);
    }
    async function state() {
      return (await store.readDinner<AppDinner>(dinnerId))!.state;
    }
    const muse = {
      research: vi.fn(async (context: ResearchContext) => {
        // Explicitly synthetic evidence. No live claim is made by this deterministic test.
        const slot = context.slots[0];
        const claim = {
          status: "known" as const,
          url: "https://fixture.example/restaurant",
          retrievedAt: now,
          excerpt: "Synthetic source fixture, not live restaurant evidence",
        };
        const venues = ["first", "alternative"].map((id) => ({
          id,
          name: `Fixture ${id}`,
          address: `${id} Main St`,
          city: context.setup.city,
          area: context.setup.area,
          evidence: {
            location: claim,
            price: {
              ...claim,
              amount: 40,
              basis: "per-person" as const,
              currency: "USD",
            },
            opening: { ...claim, intervals: context.slots },
            reservation: { ...claim, status: "unknown" as const },
            dietary: Object.fromEntries(
              context.dietary.map((d) => [
                d.requirement,
                { ...claim, supported: id === "alternative" },
              ]),
            ),
            travel: {},
          },
        }));
        return {
          venues,
          options: venues.map((venue) => ({
            venueId: venue.id,
            ...slot,
            pricePerPerson: 40,
            priceBasis: "per-person" as const,
            durationMinutes: 90,
          })),
          gaps: [],
        };
      }),
    };
    const worker = new Worker(
      store,
      coordinator,
      { send: async () => {} } as any,
      muse as any,
    );
    async function research() {
      // An actual post-restart leased job; external provider is the explicitly labeled fixture above.
      const work = await store.claimOutbox("research-test", 180000, "research");
      expect(work).not.toBeNull();
      // Worker owns a unique lease identity; runJob uses it for the transactional result commit.
      (worker as any).workerId = "research-test";
      await worker.runJob(work!);
    }
    it("SET-01 JOIN-01 creates, invites, collects consent and approves all four people", async () => {
      // Resume a pre-Mini-App draft: legacy in-progress questionnaires remain compatible.
      await store.transaction((tx) =>
        tx.setSession(users[0], {
          currentDinnerId: null,
          pendingSetup: { step: 0, values: {}, name: "Organizer" },
          pendingOnboard: null,
        }),
      );
      for (const answer of [
        "Fixture City",
        "Centre",
        "America/Chicago",
        `${day} ${windowEnd}`,
        "90",
        "60 per-person",
        "USD",
        "Alex, Sam, Jo",
      ])
        await send(users[0], answer);
      await send(users[0], "/create");
      const session = await store.transaction((tx) => tx.getSession(users[0]));
      dinnerId = session!.currentDinnerId!;
      const createMessage = (
        await pool.query(
          "SELECT payload FROM outbox WHERE subject_user_id=$1 ORDER BY created_at DESC,id DESC",
          [users[0]],
        )
      ).rows.find((r) => r.payload.text?.includes("Share:"));
      invite = createMessage.payload.text.match(/start=([\w-]+)/)[1];
      for (let index = 1; index < users.length; index++) {
        await send(users[index], `/start ${invite}`);
        await send(users[index], `choose:${dinnerId}:${index}`);
        await send(users[index], `consent:${dinnerId}:${index}`);
        expect(
          (await state()).dinner.members.some((m) => m.id === users[index]),
        ).toBe(false);
        await send(users[0], `/approve ${users[index]} ${index + 1}`);
      }
      expect((await state()).dinner.members).toHaveLength(4);
    });
    it("PROP-01 produces two options from common explicit availability", async () => {
      for (const user of users)
        await send(
          user,
          `/availability ${day}T18:00:00-05:00 ${day}T22:00:00-05:00`,
        );
      await research();
      let s = await state();
      expect(s.dinner.activeVersion).toBe(1);
      expect(s.dinner.proposals[0].options).toHaveLength(2);
      for (const user of users) await send(user, "/confirm 1");
      s = await state();
      expect(s.dinner.status).toBe("agreed");
      originalVersion = s.dinner.activeVersion!;
    });
    it("MED-01 handles an objection and researches a supported suitable alternative", async () => {
      await send(
        users[1],
        "/change I need a firm vegan option. Please research an alternative.",
      );
      // The requirement save replaces the pending objection search with current complete inputs.
      await send(
        users[1],
        '/constraints {"dietary":[{"requirement":"vegan","strength":"firm","allergy":false}]}',
      );
      await research(); // coalesced current task reuses every unaffected requirement
      let s = await state();
      expect(s.dinner.proposals.at(-1)!.options[0].venueId).toBe("alternative");
      expect(s.dinner.confirmations).toEqual({});
      expect(s.dinner.constraints[users[1]].availability).toHaveLength(1);
      await send(users[1], "/resolve");
      s = await state();
      for (const user of users)
        await send(user, `/confirm ${s.dinner.activeVersion}`);
      expect((await state()).dinner.status).toBe("agreed");
    });
    it("REV-01 AGR-01 changes schedule, rejects old buttons, and requires fresh unanimity", async () => {
      await send(
        users[2],
        `/availability ${day}T20:00:00-05:00 ${day}T22:00:00-05:00`,
      );
      expect((await state()).dinner.confirmations).toEqual({});
      await send(users[0], `confirm:${dinnerId}:${originalVersion}`);
      expect((await state()).dinner.confirmations).toEqual({});
      await research();
      const s = await state(),
        version = s.dinner.activeVersion!;
      expect(version).toBeGreaterThan(originalVersion);
      expect(
        Date.parse(s.dinner.proposals.at(-1)!.options[0].start),
      ).toBeGreaterThanOrEqual(Date.parse(`${day}T20:00:00-05:00`));
      for (const user of users.slice(0, -1))
        await send(user, `/confirm ${version}`);
      expect((await state()).dinner.status).not.toBe("agreed");
      await send(users.at(-1)!, `/confirm ${version}`);
      expect((await state()).dinner.status).toBe("agreed");
      await send(users[0], "/export");
      const documents = (
        await pool.query("SELECT payload FROM outbox WHERE dinner_id=$1", [
          dinnerId,
        ])
      ).rows
        .map((r) => r.payload)
        .filter((p) => p.document);
      const expectedStart = DateTime.fromISO(`${day}T20:00:00-05:00`)
        .toUTC()
        .toFormat("yyyyMMdd'T'HHmmss'Z'");
      expect(documents).toHaveLength(1);
      expect(documents[0].document.content).toContain(`SEQUENCE:${version}`);
      expect(documents[0].document.content).toContain(
        `DTSTART:${expectedStart}`,
      );
      expect(documents[0].text).toContain("No booking");
      const snapshots = await pool.query(
        "SELECT count(*)::int AS count FROM proposal_versions WHERE dinner_id=$1",
        [dinnerId],
      );
      expect(snapshots.rows[0].count).toBe(version);
    });
    it("CAL-01 disconnect during token exchange cannot resurrect authorization", async () => {
      let finish!: (value: any) => void;
      const exchange = vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const revoke = vi.fn().mockResolvedValue(undefined);
      const google = { exchange, revoke } as unknown as GoogleCalendar;
      const token = "long-single-use-fixture-state-value";
      await store.transaction((tx) =>
        tx.createOAuthState(
          tokenHash(token),
          dinnerId,
          users[0],
          new Date(Date.now() + 600000),
        ),
      );
      const callback = googleCallback(store, coordinator, google);
      const result = callback({ state: token, code: "synthetic-code" });
      await vi.waitFor(() => expect(exchange).toHaveBeenCalled());
      await store.transaction((tx) =>
        tx.disconnectCalendar(dinnerId, users[0]),
      );
      finish({
        access_token: "synthetic-access-token",
        expires_at: Date.now() + 3600000,
        active: false,
      });
      expect((await result).status).toBe(400);
      expect(revoke).toHaveBeenCalled();
      expect(
        await store.transaction((tx) =>
          tx.getCalendarConnection(dinnerId, users[0]),
        ),
      ).toBeNull();
    });
    it("PRIV-02 deletes private history and blocks required attendance without silent removal", async () => {
      await send(users[1], "/delete");
      const s = await state();
      expect(s.dinner.constraints[users[1]]).toBeUndefined();
      expect(s.dinner.activeVersion).toBeNull();
      expect(s.dinner.members.filter((m) => m.required)).toHaveLength(4);
      expect(s.dinner.members.some((m) => m.id === users[1])).toBe(false);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM proposal_versions WHERE dinner_id=$1",
            [dinnerId],
          )
        ).rows[0].count,
      ).toBe(0);
      const privateWork = await pool.query(
        "SELECT payload FROM outbox WHERE subject_user_id=$1 AND status IN ('pending','sending')",
        [users[1]],
      );
      expect(privateWork.rows.every((r) => !r.payload.dinnerId)).toBe(true);
    });
  },
);

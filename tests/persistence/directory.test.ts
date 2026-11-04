import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isolatedDatabase } from "./database.js";
import { migrate } from "../../src/persistence/migrate.js";
import {
  getDirectoryBusinesses,
  putDirectoryBusinesses,
} from "../../src/persistence/directory.js";
import { PgStore } from "../../src/persistence/store.js";
import { Coordinator } from "../../src/application/coordinator.js";
import { Worker } from "../../src/application/worker.js";
import { researchVersion } from "../../src/application/research-version.js";
import { MiniAppService } from "../../src/miniapp/service.js";
import {
  approveMember,
  createDinner,
  updateConstraints,
} from "../../src/domain/index.js";
import type { AppDinner } from "../../src/application/model.js";

const now = "2026-11-03T12:00:00Z";
const business = (id: string) => ({
  id,
  name: `TRANSIENT_NAME_${id}`,
  address: `TRANSIENT_ADDRESS_${id}`,
  city: "Chicago",
  url: `https://www.yelp.com/biz/${id}`,
  categories: [],
  retrievedAt: now,
  expiresAt: "2026-11-03T12:15:00Z",
});
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "staged directory research",
  () => {
    const db = isolatedDatabase(),
      store = new PgStore(db.pool);
    beforeAll(async () => {
      await db.setup();
      await migrate(db.pool);
    });
    afterAll(() => db.cleanup());
    it("shares cache across connections and deletes expired content rather than serving it", async () => {
      await putDirectoryBusinesses(db.pool, [business("cache")], now);
      expect(
        await getDirectoryBusinesses(db.pool, ["cache"], now),
      ).toHaveLength(1);
      expect(
        await getDirectoryBusinesses(
          db.pool,
          ["cache"],
          "2026-11-03T12:15:00Z",
        ),
      ).toEqual([]);
      expect(
        (
          await db.pool.query(
            "SELECT * FROM directory_business_cache WHERE business_id='cache'",
          )
        ).rows,
      ).toEqual([]);
      await expect(
        putDirectoryBusinesses(
          db.pool,
          [{ ...business("invalid"), expiresAt: "2026-11-04T12:00:00Z" }],
          now,
        ),
      ).rejects.toThrow("lifetime");
    });
    async function setup(id: string) {
      let dinner = createDinner(
        id,
        "1001",
        {
          city: "Chicago",
          area: "Loop",
          timezone: "UTC",
          timezoneConfirmed: true,
          currency: "USD",
          currencyConfirmed: true,
          windowStart: "2026-11-05",
          windowEnd: "2026-11-06",
          durationMinutes: 90,
          budget: { amount: 60, basis: "per-person" },
          intendedAttendees: ["1001", "1002"],
        },
        now,
      );
      dinner = approveMember(
        dinner,
        "1001",
        { id: "1002", consent: true, startedBot: true },
        now,
      );
      for (const member of dinner.members)
        dinner = updateConstraints(
          dinner,
          member.id,
          {
            dietary: [],
            availability: [
              { start: "2026-11-05T18:00:00Z", end: "2026-11-05T23:00:00Z" },
            ],
          },
          now,
        );
      const state: AppDinner = {
        dinner,
        roster: dinner.members.map((m) => ({ id: m.id, name: m.id })),
        consents: Object.fromEntries(
          dinner.members.map((m) => [
            m.id,
            { active: true, at: now, version: "1.0" },
          ]),
        ),
        joinRequests: {},
        reminders: {},
        collectionNotified: false,
      };
      const coordinator = new Coordinator(
        {
          MODEL_API_KEY: "fixture",
          MAX_RESEARCH_PER_DINNER_PER_DAY: 100,
          MAX_UPDATES_PER_USER_PER_DAY: 1000,
          PUBLIC_URL: "https://fixture.example",
          TELEGRAM_BOT_USERNAME: "fixturebot",
        } as any,
        undefined,
        () => now,
      );
      await store.transaction(async (tx) => {
        const record = await tx.createDinner({
          id,
          organizerId: "1001",
          state,
        });
        await coordinator.job(tx, id, "research", id, "1001", record.revision, {
          researchVersion: researchVersion(state),
        });
      });
      return coordinator;
    }
    async function publish(id: string) {
      const coordinator = await setup(id);
      for (const user of ["1001", "1002"])
        await store.transaction((tx) =>
          tx.setSession(user, {
            currentDinnerId: id,
            pendingSetup: null,
            pendingOnboard: null,
          }),
        );
      const candidates = Array.from({ length: 10 }, (_, i) =>
        business(`${id}-${i}`),
      );
      const worker = new Worker(
        store,
        coordinator,
        {} as any,
        {
          rankCandidates: vi
            .fn()
            .mockResolvedValue(candidates.slice(-3).map((b) => b.id)),
        } as any,
        undefined,
        undefined,
        {
          search: vi.fn().mockResolvedValue(candidates),
          details: vi.fn(async (candidateId) => business(candidateId)),
        },
      );
      const workerId = `${id}-worker`;
      (worker as any).workerId = workerId;
      async function claim(kind: string) {
        let work = await store.claimOutbox(workerId, 180000, kind);
        while (work && (work.payload as any).dinnerId !== id) {
          await store.markSuppressed(work.id, workerId);
          work = await store.claimOutbox(workerId, 180000, kind);
        }
        expect(work).toBeTruthy();
        return work!;
      }
      await worker.runJob(await claim("research"));
      return {
        coordinator,
        worker,
        claim,
        service: new MiniAppService(store, coordinator, coordinator.config),
        record: (await store.readDinner<AppDinner>(id))!,
      };
    }
    async function pendingVerification(id: string) {
      const result = await db.pool.query(
        "SELECT payload FROM outbox WHERE dinner_id=$1 AND kind='research' AND status='pending' AND payload->>'verificationOnly'='true'",
        [id],
      );
      return result.rows.map((row) => row.payload);
    }
    it("selects the third choice and still schedules focused checks when ranking becomes stale", async () => {
      const id = "third-choice-race";
      const { service, worker, claim, record } = await publish(id);
      const version = record.state.dinner.activeVersion!;
      const selected = await service.mutate(
        { id: "1001", name: "Organizer" },
        {
          requestId: "select-third-option",
          action: "select",
          dinnerId: id,
          payload: { index: 2, version },
        },
      );
      expect(selected.dinner!.options[0].venueId).toBe(`directory:${id}-2`);
      const selectedVersion = selected.dinner!.activeVersion;
      await worker.runJob(await claim("directory_rank"));
      expect(
        (await store.readDinner<AppDinner>(id))!.state.dinner.activeVersion,
      ).toBe(selectedVersion);
      expect(await pendingVerification(id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ version: selectedVersion, pass: 1 }),
        ]),
      );
    });
    it("schedules focused checks after early group agreement without allowing late ranking to replace the choice", async () => {
      const id = "agreement-race";
      const { service, worker, claim, record } = await publish(id);
      const version = record.state.dinner.activeVersion!;
      for (const user of ["1001", "1002"])
        await service.mutate(
          { id: user, name: user },
          {
            requestId: `confirm-${user}`,
            action: "confirm",
            dinnerId: id,
            payload: { version },
          },
        );
      await worker.runJob(await claim("directory_rank"));
      const agreed = (await store.readDinner<AppDinner>(id))!.state.dinner;
      expect(agreed.status).toBe("agreed");
      expect(agreed.activeVersion).toBe(version);
      expect(agreed.proposals.at(-1)!.options).toEqual(
        record.state.dinner.proposals.at(-1)!.options,
      );
      expect(await pendingVerification(id)).toEqual(
        expect.arrayContaining([expect.objectContaining({ version, pass: 1 })]),
      );
    });
    it("blocks Mini App and Telegram confirmation when the selected listing expires", async () => {
      const id = "expired-confirm";
      const { service, coordinator, record, claim } = await publish(id);
      const version = record.state.dinner.activeVersion!;
      await db.pool.query(
        "UPDATE directory_business_cache SET retrieved_at=$2,expires_at=$3 WHERE business_id=$1",
        [`${id}-0`, "2026-11-03T11:00:00Z", "2026-11-03T11:59:59Z"],
      );
      await expect(
        service.mutate(
          { id: "1001", name: "Organizer" },
          {
            requestId: "confirm-expired-listing",
            action: "confirm",
            dinnerId: id,
            payload: { version },
          },
        ),
      ).rejects.toMatchObject({ code: "REFRESH" });
      await store.transaction((tx) =>
        coordinator.handle(tx, {
          eventId: "telegram-confirm-expired-listing",
          actorId: "1001",
          chatId: "1001",
          name: "Organizer",
          text: `confirm:${id}:${version}`,
          callbackId: "expired-listing-callback",
        }),
      );
      expect(
        (await store.readDinner<AppDinner>(id))!.state.dinner.confirmations,
      ).toEqual({});
      const messages = await db.pool.query(
        "SELECT payload FROM outbox WHERE dinner_id=$1 AND kind='message'",
        [id],
      );
      expect(JSON.stringify(messages.rows)).toContain(
        "refresh the restaurant details before confirming",
      );
      await store.markSuppressed(
        (await claim("directory_rank")).id,
        `${id}-worker`,
      );
    });
    it("publishes three active choices before ranking, stores only IDs durably, and uses fallback on ranking failure", async () => {
      const coordinator = await setup("staged");
      const candidates = Array.from({ length: 10 }, (_, i) =>
        business(`candidate-${i}`),
      );
      const rankCandidates = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("deadline"), { name: "TimeoutError" }),
        );
      const yelp = {
        search: vi.fn().mockResolvedValue(candidates),
        details: vi.fn(async (id: string) => business(id)),
      };
      const worker = new Worker(
        store,
        coordinator,
        {} as any,
        { rankCandidates } as any,
        undefined,
        undefined,
        yelp,
      );
      (worker as any).workerId = "staged-test";
      const work = (await store.claimOutbox(
        "staged-test",
        180000,
        "research",
      ))!;
      await worker.runJob(work);
      const published = (await store.readDinner<AppDinner>("staged"))!;
      const active = published.state.dinner.proposals.at(-1)!;
      expect(active.options).toHaveLength(3);
      expect(
        active.options.every((option) => option.priceEstimateKnown === false),
      ).toBe(true);
      expect(rankCandidates).not.toHaveBeenCalled();
      const durable = await db.pool.query(
        "SELECT state::text AS value FROM dinners WHERE id='staged' UNION ALL SELECT attempt::text FROM research_runs WHERE dinner_id='staged' UNION ALL SELECT payload::text FROM outbox WHERE dinner_id='staged'",
      );
      expect(JSON.stringify(durable.rows)).not.toMatch(
        /TRANSIENT_NAME|TRANSIENT_ADDRESS/,
      );
      const checkpoint = await store.transaction((tx) =>
        tx.getResearchAttempt(work.id),
      );
      expect(checkpoint?.discovery?.candidateIds).toHaveLength(10);
      expect(checkpoint?.selectedIds).toHaveLength(3);
      await worker.runJob(
        (await store.claimOutbox("staged-test", 180000, "directory_rank"))!,
      );
      expect(rankCandidates).toHaveBeenCalledTimes(1);
      expect(
        (await store.readDinner<AppDinner>("staged"))!.state.dinner
          .activeVersion,
      ).toBe(active.version);
      expect(
        (
          await db.pool.query(
            "SELECT * FROM outbox WHERE dinner_id='staged' AND kind='research' AND status='pending'",
          )
        ).rowCount,
      ).toBe(1);
    });
    it("preserves published IDs, confirmations, and version when a participant interacts before ranking", async () => {
      const coordinator = await setup("interaction");
      const candidates = Array.from({ length: 10 }, (_, i) =>
        business(`interact-${i}`),
      );
      const worker = new Worker(
        store,
        coordinator,
        {} as any,
        {
          rankCandidates: vi
            .fn()
            .mockResolvedValue(["interact-9", "interact-8", "interact-7"]),
        } as any,
        undefined,
        undefined,
        {
          search: vi.fn().mockResolvedValue(candidates),
          details: vi.fn(async (id) => business(id)),
        },
      );
      (worker as any).workerId = "interaction-test";
      // Consume the focused verification queued by the preceding case, leaving this dinner's discovery.
      let work = await store.claimOutbox(
        "interaction-test",
        180000,
        "research",
      );
      while (work && (work.payload as any).dinnerId !== "interaction") {
        await store.markSuppressed(work.id, "interaction-test");
        work = await store.claimOutbox("interaction-test", 180000, "research");
      }
      await worker.runJob(work!);
      const before = (await store.readDinner<AppDinner>("interaction"))!;
      await store.transaction(async (tx) => {
        const record = (await tx.getDinner<AppDinner>("interaction"))!;
        record.state.dinner.confirmations["1001"] =
          record.state.dinner.activeVersion!;
        await coordinator.save(tx, record, record.state);
      });
      await worker.runJob(
        (await store.claimOutbox(
          "interaction-test",
          180000,
          "directory_rank",
        ))!,
      );
      const after = (await store.readDinner<AppDinner>("interaction"))!;
      expect(after.state.dinner.activeVersion).toBe(
        before.state.dinner.activeVersion,
      );
      expect(after.state.dinner.confirmations["1001"]).toBe(
        before.state.dinner.activeVersion,
      );
      expect(after.state.dinner.proposals.at(-1)!.options).toEqual(
        before.state.dinner.proposals.at(-1)!.options,
      );
    });
    it("accepts an organizer website only for the current selected version", async () => {
      const { coordinator, service } = await publish("site-input");
      const before = (await store.readDinner<AppDinner>("site-input"))!;
      const version = before.state.dinner.activeVersion!;
      await expect(
        service.mutate(
          { id: "1002", name: "Guest" },
          {
            requestId: "site-guest",
            action: "setVenueWebsite",
            dinnerId: "site-input",
            payload: { version, url: "https://restaurant.example/menu" },
          },
        ),
      ).rejects.toThrow();
      await expect(
        service.mutate(
          { id: "1001", name: "Owner" },
          {
            requestId: "site-stale",
            action: "setVenueWebsite",
            dinnerId: "site-input",
            payload: {
              version: version + 1,
              url: "https://restaurant.example/menu",
            },
          },
        ),
      ).rejects.toThrow();
      await service.mutate(
        { id: "1001", name: "Owner" },
        {
          requestId: "site-owner",
          action: "setVenueWebsite",
          dinnerId: "site-input",
          payload: { version, url: "https://restaurant.example/menu" },
        },
      );
      const after = (await store.readDinner<AppDinner>("site-input"))!;
      expect(after.state.dinner.venues[0].officialWebsiteUrl).toBe(
        "https://restaurant.example/menu",
      );
      expect(after.state.dinner.activeVersion).toBe(version);
      expect(after.state.dinner.confirmations).toEqual(
        before.state.dinner.confirmations,
      );
      expect(researchVersion(after.state)).not.toBe(
        researchVersion(before.state),
      );
    });
  },
);

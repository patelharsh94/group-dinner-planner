import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { isolatedDatabase } from "./database.js";
import { migrate } from "../../src/persistence/migrate.js";
import { PgStore } from "../../src/persistence/store.js";
import { Coordinator } from "../../src/application/coordinator.js";
import { Worker } from "../../src/application/worker.js";
import { MiniAppService } from "../../src/miniapp/service.js";
import { ResearchFailure } from "../../src/application/research.js";
import type { Config } from "../../src/config.js";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "RES-02 research diagnostics conversation",
  () => {
    const db = isolatedDatabase(),
      store = new PgStore(db.pool),
      now = "2026-11-02T12:00:00Z";
    const config = {
      PUBLIC_URL: "https://fixture.example",
      TELEGRAM_BOT_USERNAME: "fixturebot",
      MODEL_API_KEY: "SECRET_FIXTURE_KEY",
      MAX_ACTIVE_DINNERS: 100,
      MAX_UPDATES_PER_USER_PER_DAY: 1000,
      MAX_RESEARCH_PER_DINNER_PER_DAY: 10,
      SUPPORT_CONTACT: "fixture-support",
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
    } as Config;
    const coordinator = new Coordinator(config, undefined, () => now),
      service = new MiniAppService(store, coordinator, config),
      owner = { id: "1001", name: "Fixture owner" },
      guest = { id: "1002", name: "Fixture guest" };
    beforeAll(async () => {
      await db.setup();
      await migrate(db.pool);
    });
    afterAll(() => db.cleanup());
    it("persists safe authentication diagnostics, isolates owner details and distinguishes a completed empty search on retry", async () => {
      for (const actor of [owner, guest])
        await store.transaction((tx) =>
          tx.setSession(actor.id, {
            currentDinnerId: null,
            pendingSetup: null,
            pendingOnboard: null,
          }),
        );
      const created = await service.mutate(owner, {
          requestId: "diagnostic-create",
          action: "create",
          payload: {
            city: "Fixture City",
            windowStart: "2026-11-05",
            windowEnd: "2026-11-06",
            timezone: "UTC",
            currency: "USD",
            durationMinutes: 90,
            partySize: 2,
            budget: { amount: 60 },
            consent: true,
          },
        }),
        id = created.dinner!.id;
      const preferences = {
        availability: [
          { start: "2026-11-05T18:00:00Z", end: "2026-11-05T22:00:00Z" },
        ],
        dietary: [],
        preferences: ["SECRET_PRIVATE_PREFERENCE"],
        foodConfirmed: true,
      };
      await service.mutate(owner, {
        requestId: "diagnostic-owner-answers",
        action: "savePreferences",
        dinnerId: id,
        formVersion: created.dinner!.formVersion,
        payload: preferences,
      });
      const invite = new URL(created.invitationUrl!).searchParams.get("start")!;
      await service.mutate(guest, {
        requestId: "diagnostic-guest-join",
        action: "join",
        dinnerId: id,
        formVersion: (await service.bootstrap(guest, invite)).invitation!
          .formVersion,
        payload: { invite, consent: true, preferences },
      });
      await service.mutate(owner, {
        requestId: "diagnostic-approve",
        action: "approve",
        dinnerId: id,
        payload: { userId: guest.id },
      });
      const research = vi
        .fn()
        .mockRejectedValueOnce(
          new ResearchFailure("AUTH_INVALID", "provider", {
            httpStatus: 401,
            providerRequestId: "safe-provider-request",
          }),
        )
        .mockResolvedValueOnce({
          venues: [],
          options: [],
          gaps: ["untrusted private provider text"],
          verification: {
            verifiedClaims: 0,
            unresolvedClaims: 0,
            sourcesFailed: 0,
            issues: [{ code: "excerpt_unmatched", count: 2 }],
          },
        });
      const worker = new Worker(
        store,
        coordinator,
        {} as any,
        { research } as any,
      );
      (worker as any).workerId = "research-diagnostics-test";
      const logger = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const first = await store.claimOutbox(
          "research-diagnostics-test",
          180000,
          "research",
        );
        expect(first).not.toBeNull();
        await worker.runJob(first!);
        const own = await service.dinner(owner, id),
          member = await service.dinner(guest, id);
        expect(own.researchDetails).toMatchObject({
          id: first!.id,
          status: "failed",
          code: "AUTH_INVALID",
          httpStatus: 401,
          stage: "provider",
        });
        expect(member.research).toMatchObject({
          id: first!.id,
          status: "failed",
        });
        expect(member.researchDetails).toBeUndefined();
        expect(member.research!.message).not.toContain("MODEL_API_KEY");
        const rows = (
          await db.pool.query(
            "SELECT attempt FROM research_runs WHERE dinner_id=$1",
            [id],
          )
        ).rows;
        expect(
          JSON.stringify(rows) + JSON.stringify(logger.mock.calls),
        ).not.toMatch(
          /SECRET_FIXTURE_KEY|SECRET_PRIVATE_PREFERENCE|untrusted private provider text/,
        );
        await service.mutate(owner, {
          requestId: "diagnostic-retry",
          action: "research",
          dinnerId: id,
        });
        const retry = await store.claimOutbox(
          "research-diagnostics-test",
          180000,
          "research",
        );
        expect(retry).not.toBeNull();
        await worker.runJob(retry!);
        const latest = await service.dinner(owner, id);
        expect(latest.researchDetails).toMatchObject({
          id: retry!.id,
          status: "needs_checks",
          code: "NO_SUITABLE_OPTIONS",
          verificationIssues: [{ code: "excerpt_unmatched", count: 2 }],
        });
        expect(latest.researchPending).toBe(false);
        expect(
          (await service.dinner(guest, id)).researchDetails,
        ).toBeUndefined();
      } finally {
        logger.mockRestore();
      }
    });
  },
);

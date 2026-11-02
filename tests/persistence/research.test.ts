import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { isolatedDatabase } from "./database.js";
import { PgStore } from "../../src/persistence/store.js";
import { migrate } from "../../src/persistence/migrate.js";
import { Coordinator } from "../../src/application/coordinator.js";
import { MiniAppService } from "../../src/miniapp/service.js";
import type { Config } from "../../src/config.js";
const owner = { id: "100", name: "Owner" },
  guest = { id: "200", name: "Guest" },
  now = "2026-11-01T18:00:00Z";
const config = {
  MODEL_API_KEY: "fixture",
  MAX_ACTIVE_DINNERS: 100,
  MAX_UPDATES_PER_USER_PER_DAY: 1000,
  MAX_RESEARCH_PER_DINNER_PER_DAY: 10,
  PUBLIC_URL: "https://fixture.example",
  TELEGRAM_BOT_USERNAME: "fixturebot",
  SUPPORT_CONTACT: "help@example.test",
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
const response = {
  availability: [
    { start: "2026-11-05T18:00:00-06:00", end: "2026-11-05T22:00:00-06:00" },
  ],
  dietary: [],
  foodConfirmed: true,
};
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "Research lifecycle and reviewed sharing boundaries",
  () => {
    const db = isolatedDatabase(),
      store = new PgStore(db.pool),
      coordinator = new Coordinator(config, undefined, () => now),
      service = new MiniAppService(store, coordinator, config);
    beforeAll(async () => {
      await db.setup();
      await migrate(db.pool);
    });
    afterAll(() => db.cleanup());
    beforeEach(async () => {
      await db.pool.query(
        "TRUNCATE dinners,user_sessions,inbox,outbox,usage_counts,miniapp_receipts CASCADE",
      );
      for (const user of [owner, guest])
        await store.transaction((tx) =>
          tx.setSession(user.id, {
            currentDinnerId: null,
            pendingSetup: null,
            pendingOnboard: null,
          }),
        );
    });
    async function create() {
      const result = await service.mutate(owner, {
        requestId: "create-fixture-dinner",
        action: "create",
        payload: setup,
      });
      return {
        id: result.dinner!.id,
        token: new URL(result.invitationUrl!).searchParams.get("start")!,
      };
    }
    async function queue(id: string, workId: string) {
      await store.transaction(async (tx) => {
        await tx.createResearchAttempt({
          id: workId,
          dinnerId: id,
          inputVersion: "fixture-version",
          requestedAt: now,
        });
        await tx.queue({
          id: workId,
          dedupeKey: workId,
          kind: "research",
          dinnerId: id,
          subjectUserId: owner.id,
          payload: { dinnerId: id, userId: owner.id, revision: 0 },
        });
      });
    }
    it("supersedes a stopped owner research attempt so resuming cannot show an active orphan run", async () => {
      const { id } = await create();
      await queue(id, "stopped-owner-run");
      await service.mutate(owner, {
        requestId: "stop-owner-with-queued-work",
        action: "stop",
      });
      expect(
        await store.transaction((tx) => tx.getLatestResearchAttempt(id)),
      ).toMatchObject({ status: "superseded", stage: "done" });
      await service.mutate(owner, {
        requestId: "resume-owner-after-stop",
        action: "resume",
        dinnerId: id,
        payload: { consent: true },
      });
      const view = await service.dinner(owner, id);
      expect(view.researchPending).toBe(false);
      expect(view.research?.status).toBe("superseded");
    });
    it("marks a research attempt failed after crash recovery exhausts its bounded leases", async () => {
      const { id } = await create();
      await queue(id, "exhausted-research-run");
      await queue(id, "recoverable-research-run");
      await store.transaction(async (tx) => {
        for (const workId of [
          "exhausted-research-run",
          "recoverable-research-run",
        ])
          await tx.updateResearchAttempt(workId, {
            status: "running",
            stage: "provider",
            startedAt: now,
          });
        await tx.client.query(
          "UPDATE outbox SET status='sending',attempts=CASE WHEN id='exhausted-research-run' THEN 5 ELSE 2 END,lease_owner='dead-process',lease_until=now()-interval '1 minute' WHERE kind='research'",
        );
      });
      await store.recoverLeases();
      await store.transaction(async (tx) => {
        expect(
          await tx.getResearchAttempt("exhausted-research-run"),
        ).toMatchObject({
          status: "failed",
          stage: "done",
          code: "UNEXPECTED_ERROR",
        });
        expect(
          (await tx.getResearchAttempt("exhausted-research-run"))?.finishedAt,
        ).toBeDefined();
        expect(
          (await tx.getResearchAttempt("recoverable-research-run"))?.status,
        ).toBe("running");
      });
      expect(
        (
          await db.pool.query(
            "SELECT status FROM outbox WHERE id='recoverable-research-run'",
          )
        ).rows[0].status,
      ).toBe("pending");
    });
    it.each(["approved", "pending"] as const)(
      "never grants sharing for inherited omitted fields on an %s response edit",
      async (phase) => {
        const { id, token } = await create();
        await service.mutate(guest, {
          requestId: "join-with-private-inherited-data",
          action: "join",
          dinnerId: id,
          formVersion: (await service.bootstrap(guest, token)).invitation!
            .formVersion,
          payload: {
            invite: token,
            consent: true,
            preferences: {
              ...response,
              shareAnswers: false,
              travel: {
                origin: "SECRET_OMITTED_HOME",
                maxMinutes: 30,
                strength: "firm",
              },
              budget: { amount: 40, strength: "firm" },
            },
          },
        });
        const approve = () =>
          service.mutate(owner, {
            requestId: "approve-review-test",
            action: "approve",
            dinnerId: id,
            payload: { userId: guest.id },
          });
        if (phase === "approved") await approve();
        const edited = await service.mutate(guest, {
          requestId: "edit-with-incomplete-sharing-preview",
          action: "savePreferences",
          dinnerId: id,
          formVersion: (await service.dinner(guest, id)).formVersion,
          payload: {
            ...response,
            shareAnswers: true,
            preferences: ["newly-reviewed-only"],
          },
        });
        expect(edited.dinner?.own.answerSharing).toBe(false);
        expect(edited.dinner?.own.constraints.travel?.origin).toBe(
          "SECRET_OMITTED_HOME",
        );
        if (phase === "pending") await approve();
        const host = await service.dinner(owner, id);
        expect(
          host.sharedResponses.find((r) => r.userId === guest.id)?.status,
        ).toBe("private");
        expect(JSON.stringify(host)).not.toContain("SECRET_OMITTED_HOME");
      },
    );
  },
);

import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import { isolatedDatabase } from "./database.js";
import { PgStore } from "../../src/persistence/store.js";
import { migrate } from "../../src/persistence/migrate.js";
import { MiniAppService } from "../../src/miniapp/service.js";
import { Coordinator } from "../../src/application/coordinator.js";
import { researchVersion } from "../../src/application/research-version.js";
import type { AppDinner } from "../../src/application/model.js";
import { ConfigSchema, type Config } from "../../src/config.js";
const owner = { id: "100", name: "Owner" },
  guest = { id: "200", name: "Guest" },
  other = { id: "300", name: "Other" },
  now = "2026-11-01T18:00:00Z";
const config = {
  MAX_ACTIVE_DINNERS_PER_ORGANIZER: 5,
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
const preferences = {
  availability: [
    { start: "2026-11-05T18:00:00-06:00", end: "2026-11-05T22:00:00-06:00" },
  ],
  dietary: [],
  foodConfirmed: true,
};
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "Multiple dinner ownership and explicit selection",
  () => {
    const db = isolatedDatabase(),
      store = new PgStore(db.pool),
      service = new MiniAppService(
        store,
        new Coordinator(config, undefined, () => now),
        config,
      );
    let seq = 0;
    beforeAll(async () => {
      await db.setup();
      await migrate(db.pool);
    });
    afterAll(() => db.cleanup());
    beforeEach(async () => {
      seq = 0;
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
    const create = (actor = owner, title?: string) =>
      service.mutate(actor, {
        requestId: `create-multiple-${++seq}`,
        action: "create",
        payload: { ...setup, ...(title === undefined ? {} : { title }) },
      });
    async function join(id: string, token: string) {
      await service.mutate(guest, {
        requestId: `join-multiple-${++seq}`,
        action: "join",
        dinnerId: id,
        formVersion: (await service.bootstrap(guest, token)).invitation!
          .formVersion,
        payload: { invite: token, consent: true, preferences },
      });
    }
    it("MULTI-01 upgrades the former unique organizer index without changing an existing dinner", async () => {
      const result = await create(owner, "Existing dinner"),
        id = result.dinner!.id;
      const before = await store.readDinner<AppDinner>(id);
      // Reconstruct migration 005's organizer index in this disposable schema.
      await db.pool.query("DROP INDEX active_dinners_by_organizer");
      await db.pool.query(
        "CREATE UNIQUE INDEX one_active_dinner_per_organizer ON dinners(organizer_id) WHERE ended_at IS NULL",
      );
      await db.pool.query("DELETE FROM schema_migrations WHERE version='006'");
      await migrate(db.pool);
      expect(await store.readDinner(id)).toEqual(before);
      await create(owner, "Additional dinner");
      await Promise.all([migrate(db.pool), migrate(db.pool)]);
      expect(await store.countActiveDinnersForOrganizer(owner.id)).toBe(2);
      expect(await store.readDinner(id)).toEqual(before);
    });
    it("serializes concurrent creations at five, retries once, counts blocked ownership, and frees cancelled capacity", async () => {
      const inputs = Array.from({ length: 6 }, (_, i) => ({
        requestId: `concurrent-create-${i}`,
        action: "create",
        payload: { ...setup, title: `Dinner ${i + 1}` },
      }));
      const results = await Promise.allSettled(
        inputs.map((input) => service.mutate(owner, input)),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({
        reason: { code: "ORGANIZER_LIMIT" },
      });
      expect(await store.countActiveDinnersForOrganizer(owner.id)).toBe(5);
      expect(await store.listActiveDinnersForOrganizer(owner.id)).toHaveLength(
        5,
      );
      const successIndex = results.findIndex((r) => r.status === "fulfilled"),
        result = results[successIndex];
      if (result.status !== "fulfilled")
        throw new Error("No creation succeeded");
      await service.mutate(owner, inputs[successIndex]);
      expect(await store.countActiveDinnersForOrganizer(owner.id)).toBe(5);
      await service.mutate(owner, {
        requestId: "stop-all-owned-dinners",
        action: "stop",
      });
      await expect(create()).rejects.toMatchObject({ code: "ORGANIZER_LIMIT" });
      const id = result.value.dinner!.id;
      await service.mutate(owner, {
        requestId: "resume-selected-owned-dinner",
        action: "resume",
        dinnerId: id,
        payload: { consent: true },
      });
      await service.mutate(owner, {
        requestId: "cancel-to-free-one-place",
        action: "cancelDinner",
        dinnerId: id,
        payload: { confirmed: true },
      });
      expect(await store.countActiveDinnersForOrganizer(owner.id)).toBe(4);
      await create();
      expect(await store.countActiveDinnersForOrganizer(owner.id)).toBe(5);
      expect(
        (await service.bootstrap(owner)).maxActiveDinnersPerOrganizer,
      ).toBe(5);
    });
    it("keeps joins separate from the organizers own creation cap", async () => {
      const dinner = await create(),
        id = dinner.dinner!.id,
        token = new URL(dinner.invitationUrl!).searchParams.get("start")!;
      for (let i = 0; i < 5; i++) await create(guest);
      await join(id, token);
      expect(await store.countActiveDinnersForOrganizer(guest.id)).toBe(5);
      expect((await service.dinner(guest, id)).role).toBe("member");
    });
    it("renames only metadata with stale and owner checks, preserving confirmations and research input identity", async () => {
      const result = await create(owner, "  Friday dinner  "),
        id = result.dinner!.id;
      expect(result.dinner?.title).toBe("Friday dinner");
      const token = new URL(result.invitationUrl!).searchParams.get("start")!;
      expect((await service.bootstrap(guest, token)).invitation?.title).toBe(
        "Friday dinner",
      );
      await join(id, token);
      await store.transaction(async (tx) => {
        const r = (await tx.getDinner<AppDinner>(id))!;
        r.state.dinner.confirmations = { [owner.id]: 9 };
        await tx.saveDinner(r, r.revision);
      });
      const before = (await store.readDinner<AppDinner>(id))!,
        form = (await service.dinner(owner, id)).formVersion;
      await expect(
        service.mutate(guest, {
          requestId: "guest-cannot-rename-dinner",
          action: "renameDinner",
          dinnerId: id,
          formVersion: (await service.dinner(guest, id)).formVersion,
          payload: { title: "Not yours" },
        }),
      ).rejects.toMatchObject({ status: 403 });
      await service.mutate(owner, {
        requestId: "rename-ongoing-dinner",
        action: "renameDinner",
        dinnerId: id,
        formVersion: form,
        payload: { title: "  New title  " },
      });
      const after = (await store.readDinner<AppDinner>(id))!;
      expect(after.state.title).toBe("New title");
      expect(after.state.dinner).toEqual(before.state.dinner);
      expect(researchVersion(after.state)).toBe(researchVersion(before.state));
      expect(
        (
          await db.pool.query(
            "SELECT count(*)::int AS count FROM outbox WHERE kind='research'",
          )
        ).rows[0].count,
      ).toBe(0);
      await expect(
        service.mutate(owner, {
          requestId: "stale-rename-dinner",
          action: "renameDinner",
          dinnerId: id,
          formVersion: form,
          payload: { title: "Old form" },
        }),
      ).rejects.toMatchObject({ code: "STALE_FORM" });
      await service.mutate(owner, {
        requestId: "clear-optional-title",
        action: "renameDinner",
        dinnerId: id,
        formVersion: (await service.dinner(owner, id)).formVersion,
        payload: { title: "   " },
      });
      expect((await service.dinner(owner, id)).title).toBeUndefined();
      await expect(create(owner, "x".repeat(81))).rejects.toThrow();
    });
    it("keeps stop/delete account-wide while resuming only the explicitly selected owned dinner", async () => {
      const a = (await create(owner, "Owned A")).dinner!.id,
        b = (await create(owner, "Owned B")).dinner!.id,
        joined = await create(other, "Joined C"),
        c = joined.dinner!.id,
        token = new URL(joined.invitationUrl!).searchParams.get("start")!;
      await service.mutate(owner, {
        requestId: "owner-joins-third-party-dinner",
        action: "join",
        dinnerId: c,
        formVersion: (await service.bootstrap(owner, token)).invitation!
          .formVersion,
        payload: { invite: token, consent: true, preferences },
      });
      await service.mutate(other, {
        requestId: "approve-owner-third-party-membership",
        action: "approve",
        dinnerId: c,
        payload: { userId: owner.id },
      });
      await service.mutate(owner, {
        requestId: "account-wide-stop-three-dinners",
        action: "stop",
      });
      for (const id of [a, b, c])
        expect(
          (await store.readDinner<AppDinner>(id))!.state.consents[owner.id]
            .active,
        ).toBe(false);
      await service.mutate(owner, {
        requestId: "resume-only-owned-a",
        action: "resume",
        dinnerId: a,
        payload: { consent: true },
      });
      expect(
        (await store.readDinner<AppDinner>(a))!.state.consents[owner.id].active,
      ).toBe(true);
      for (const id of [b, c])
        expect(
          (await store.readDinner<AppDinner>(id))!.state.consents[owner.id]
            .active,
        ).toBe(false);
      expect((await service.bootstrap(owner)).currentDinnerId).toBe(a);
      await service.mutate(owner, {
        requestId: "account-wide-delete-three-dinners",
        action: "delete",
      });
      expect(await store.readDinner(a)).toBeNull();
      expect(await store.readDinner(b)).toBeNull();
      const remaining = (await store.readDinner<AppDinner>(c))!;
      expect(remaining).not.toBeNull();
      expect(remaining.state.dinner.constraints[owner.id]).toBeUndefined();
      expect(remaining.state.consents[owner.id]).toBeUndefined();
    });
    it("cancels only dinner A while dinner B retains its plan inputs, invitation, credentials and queued research", async () => {
      const a = (await create(owner, "Cancel A")).dinner!.id,
        bResult = await create(owner, "Keep B"),
        b = bResult.dinner!.id,
        bToken = new URL(bResult.invitationUrl!).searchParams.get("start")!;
      await store.transaction(async (tx) => {
        const record = (await tx.getDinner<AppDinner>(b))!;
        record.state.dinner.constraints[owner.id] = {
          availability: preferences.availability,
          dietary: [],
          travel: {
            origin: "PRIVATE_B_ORIGIN",
            maxMinutes: 30,
            strength: "firm",
          },
        };
        record.state.dinner.confirmations = { [owner.id]: 7 };
        record.state.answerSharing = {
          [owner.id]: { enabled: true, at: now, version: "1.0" },
        };
        await tx.saveDinner(record, record.revision);
        await tx.setCalendarConnection(b, owner.id, "ENCRYPTED_B_CREDENTIAL");
        await tx.createOAuthState(
          "b-pending-oauth",
          b,
          owner.id,
          new Date(Date.now() + 600000),
        );
        await tx.createResearchAttempt({
          id: "research-for-b",
          dinnerId: b,
          inputVersion: "b-input-version",
          requestedAt: now,
        });
        await tx.queue({
          id: "research-for-b",
          dedupeKey: "research-for-b",
          dinnerId: b,
          subjectUserId: owner.id,
          kind: "research",
          payload: {
            dinnerId: b,
            userId: owner.id,
            revision: record.revision + 1,
          },
        });
      });
      const before = (await store.readDinner<AppDinner>(b))!;
      await service.mutate(owner, {
        requestId: "cancel-only-dinner-a",
        action: "cancelDinner",
        dinnerId: a,
        payload: { confirmed: true },
      });
      expect(await store.readDinner<AppDinner>(b)).toEqual(before);
      expect(
        (await service.bootstrap(guest, bToken)).invitation?.dinnerId,
      ).toBe(b);
      await store.transaction(async (tx) => {
        expect(await tx.getCalendarConnection(b, owner.id)).toBe(
          "ENCRYPTED_B_CREDENTIAL",
        );
        expect(await tx.getOAuthState("b-pending-oauth")).toMatchObject({
          dinnerId: b,
        });
        expect(await tx.getResearchAttempt("research-for-b")).toMatchObject({
          status: "queued",
        });
      });
      expect(
        (
          await db.pool.query(
            "SELECT status,payload FROM outbox WHERE id='research-for-b'",
          )
        ).rows[0],
      ).toMatchObject({ status: "pending", payload: { dinnerId: b } });
    });
    it("honors a configured owner cap independently of the global service cap", async () => {
      expect(
        ConfigSchema.shape.MAX_ACTIVE_DINNERS_PER_ORGANIZER.parse(undefined),
      ).toBe(5);
      const cappedConfig = {
          ...config,
          MAX_ACTIVE_DINNERS_PER_ORGANIZER: 2,
          MAX_ACTIVE_DINNERS: 3,
        },
        capped = new MiniAppService(
          store,
          new Coordinator(cappedConfig, undefined, () => now),
          cappedConfig,
        );
      const make = (actor: typeof owner, key: string) =>
        capped.mutate(actor, {
          requestId: key,
          action: "create",
          payload: setup,
        });
      await make(owner, "cap-two-owner-one");
      await make(owner, "cap-two-owner-two");
      await expect(make(owner, "cap-two-owner-three")).rejects.toMatchObject({
        code: "ORGANIZER_LIMIT",
      });
      await make(other, "global-third-dinner");
      await expect(make(other, "global-fourth-dinner")).rejects.toMatchObject({
        code: "LIMIT",
        status: 429,
      });
      expect(await store.countActiveDinnersForOrganizer(other.id)).toBe(1);
    });
    it("chooses only viewable dinners and never moves selection when replaying an older receipt", async () => {
      const first = await create(owner, "First"),
        second = await create(owner, "Second"),
        firstId = first.dinner!.id,
        secondId = second.dinner!.id;
      const choose = {
        requestId: "choose-first-dinner-once",
        action: "chooseDinner",
        dinnerId: firstId,
      };
      await store.transaction((tx) =>
        tx.setSession(owner.id, {
          currentDinnerId: secondId,
          pendingSetup: { title: "Unfinished setup" },
          pendingOnboard: {
            type: "staff",
            dinnerId: secondId,
            report: "private old context",
          },
        }),
      );
      await service.mutate(owner, choose);
      expect(await store.transaction((tx) => tx.getSession(owner.id))).toEqual({
        currentDinnerId: firstId,
        pendingSetup: null,
        pendingOnboard: null,
      });
      expect((await service.bootstrap(owner)).currentDinnerId).toBe(firstId);
      await service.mutate(owner, {
        requestId: "choose-second-dinner",
        action: "chooseDinner",
        dinnerId: secondId,
      });
      const freshDraft = {
        currentDinnerId: secondId,
        pendingSetup: { title: "New draft after choosing" },
        pendingOnboard: {
          type: "staff",
          dinnerId: secondId,
          report: "new private context",
        },
      };
      await store.transaction((tx) => tx.setSession(owner.id, freshDraft));
      await service.mutate(owner, choose);
      expect(await store.transaction((tx) => tx.getSession(owner.id))).toEqual(
        freshDraft,
      );
      expect((await service.bootstrap(owner)).currentDinnerId).toBe(secondId);
      const before = (await store.readDinner<AppDinner>(secondId))!;
      await expect(
        service.mutate(guest, {
          requestId: "cannot-choose-private-dinner",
          action: "chooseDinner",
          dinnerId: firstId,
        }),
      ).rejects.toMatchObject({ status: 403 });
      const token = new URL(first.invitationUrl!).searchParams.get("start")!;
      await join(firstId, token);
      await service.mutate(guest, {
        requestId: "choose-pending-dinner",
        action: "chooseDinner",
        dinnerId: firstId,
      });
      expect((await service.bootstrap(guest)).currentDinnerId).toBe(firstId);
      await store.transaction((tx) =>
        tx.setSession(other.id, {
          currentDinnerId: firstId,
          pendingSetup: null,
          pendingOnboard: null,
        }),
      );
      expect((await service.bootstrap(other)).currentDinnerId).toBeNull();
      await service.mutate(owner, {
        requestId: "stop-all-before-choose",
        action: "stop",
      });
      await service.mutate(owner, {
        requestId: "choose-withdrawn-owned-dinner",
        action: "chooseDinner",
        dinnerId: firstId,
      });
      expect((await service.bootstrap(owner)).currentDinnerId).toBe(firstId);
      expect(
        (await store.readDinner<AppDinner>(secondId))!.state.dinner.constraints,
      ).toEqual(before.state.dinner.constraints);
      await store.transaction((tx) => tx.deleteDinner(firstId));
      expect((await service.bootstrap(owner)).currentDinnerId).toBeNull();
    });
  },
);

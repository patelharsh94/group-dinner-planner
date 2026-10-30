import { isolatedDatabase } from "./database.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/persistence/migrate.js";
import { PgStore, RevisionConflict } from "../../src/persistence/store.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("Postgres durable state", () => {
  const database = isolatedDatabase(),
    pool = database.pool;
  const store = new PgStore(pool);
  const suffix = `${Date.now()}-${Math.random()}`;
  beforeAll(async () => {
    await database.setup();
    await migrate(pool);
  });
  afterAll(async () => {
    await database.cleanup();
  });
  it("atomically rolls back effects and deduplicates a replay", async () => {
    const event = `event-${suffix}`;
    await store.enqueueInbox(event, { message: "private" });
    await store.enqueueInbox(event, { message: "duplicate" });
    const claimed = await store.claimInbox("worker");
    expect(claimed?.id).toBe(event);
    await expect(
      store.processInbox(event, "worker", async (tx) => {
        await tx.createDinner({
          id: suffix,
          organizerId: suffix,
          state: { count: 0 },
        });
        await tx.queue({
          id: `out-${suffix}`,
          dedupeKey: suffix,
          payload: { text: "hello" },
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await store.readDinner(suffix)).toBeNull();
    await store.processInbox(event, "worker", async (tx) => {
      await tx.createDinner({
        id: suffix,
        organizerId: suffix,
        state: { count: 0 },
      });
      await tx.queue({
        id: `out-${suffix}`,
        dedupeKey: suffix,
        payload: { text: "hello" },
      });
    });
    expect(
      await store.processInbox(event, "worker", async () => {
        throw new Error("replayed");
      }),
    ).toBe(false);
    expect((await store.readDinner(suffix))?.state).toEqual({ count: 0 });
  });
  it("rejects stale revisions and prevents two active dinners", async () => {
    await store.transaction(async (tx) => {
      const d = await tx.getDinner(suffix);
      expect(d?.revision).toBe(0);
      await tx.saveDinner({ ...d!, state: { count: 1 } }, 0);
    });
    await expect(
      store.transaction((tx) =>
        tx.saveDinner(
          {
            id: suffix,
            organizerId: suffix,
            state: {},
            revision: 0,
            endedAt: null,
          },
          0,
        ),
      ),
    ).rejects.toBeInstanceOf(RevisionConflict);
    await expect(
      store.transaction((tx) =>
        tx.createDinner({
          id: `other-${suffix}`,
          organizerId: suffix,
          state: {},
        }),
      ),
    ).rejects.toThrow();
  });
  it("never requeues an abandoned delivery", async () => {
    const message = await store.claimOutbox("sender", 1);
    expect(message?.id).toBe(`out-${suffix}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.recoverLeases();
    const result = await pool.query("SELECT status FROM outbox WHERE id=$1", [
      message!.id,
    ]);
    expect(result.rows[0].status).toBe("ambiguous");
    expect(await store.claimOutbox("sender")).toBeNull();
  });
  it("allows one concurrent CAS update and atomically queues its work", async () => {
    const result = await Promise.allSettled(
      [1, 2].map((count) =>
        store.transactDinner<{ count: number }>(
          suffix,
          1,
          async (_state, tx) => {
            await tx.queue({
              id: `cas-${suffix}-${count}`,
              dedupeKey: `cas-${suffix}-${count}`,
              kind: "research",
              payload: { count },
            });
            return { count };
          },
        ),
      ),
    );
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
    const queued = await pool.query(
      "SELECT id FROM outbox WHERE dedupe_key LIKE $1",
      [`cas-${suffix}-%`],
    );
    expect(queued.rowCount).toBe(1);
  });
  it("recovers research work and bounds definite retries", async () => {
    const job = await store.claimOutbox("researcher", 1, "research");
    expect(job).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.recoverLeases();
    for (let attempt = 2; attempt <= 5; attempt++) {
      const retried = await store.claimOutbox("researcher", 60000, "research");
      expect(retried?.attempts).toBe(attempt);
      await store.retryOutbox(retried!.id, "researcher", 0);
    }
    expect(await store.claimOutbox("researcher", 60000, "research")).toBeNull();
    expect(
      (await pool.query("SELECT status FROM outbox WHERE id=$1", [job!.id]))
        .rows[0].status,
    ).toBe("failed");
  });
  it("suppresses and removes private queued data on opt out", async () => {
    await store.transaction(async (tx) => {
      await tx.setSession("private-" + suffix, {
        currentDinnerId: suffix,
        pendingSetup: { address: "secret" },
        pendingOnboard: null,
      });
      await tx.setCalendarConnection(suffix, "private-" + suffix, "ciphertext");
      await tx.createOAuthState(
        "privatehash-" + suffix,
        suffix,
        "private-" + suffix,
        new Date(Date.now() + 10000),
      );
      await tx.queue({
        id: "private-" + suffix,
        dedupeKey: "private-" + suffix,
        subjectUserId: "private-" + suffix,
        payload: { address: "secret" },
      });
      await tx.deleteUser("private-" + suffix);
      expect(await tx.getSession("private-" + suffix)).toBeNull();
      expect(
        await tx.getCalendarConnection(suffix, "private-" + suffix),
      ).toBeNull();
      expect(
        await tx.consumeOAuthState(
          "privatehash-" + suffix,
          "private-" + suffix,
        ),
      ).toBeNull();
    });
    const row = (
      await pool.query("SELECT status,payload FROM outbox WHERE id=$1", [
        "private-" + suffix,
      ])
    ).rows[0];
    expect(row).toEqual({ status: "suppressed", payload: {} });
    expect(
      (
        await pool.query("SELECT subject_user_id FROM outbox WHERE id=$1", [
          "private-" + suffix,
        ])
      ).rows[0].subject_user_id,
    ).toBeNull();
  });
  it("recovers abandoned incoming leases with bounded retries", async () => {
    const id = "restart-" + suffix;
    await store.enqueueInbox(id, { actorId: "restart-user-" + suffix });
    const first = await store.claimInbox("dead-process", 1);
    expect(first?.id).toBe(id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.recoverLeases();
    for (let attempt = 2; attempt <= 5; attempt++) {
      const retry = await store.claimInbox("live-process");
      expect(retry?.id).toBe(id);
      expect(retry?.attempts).toBe(attempt);
      await store.failInbox(id, "live-process", "definite local failure", 0);
    }
    expect(await store.claimInbox("live-process")).toBeNull();
    expect(
      (await pool.query("SELECT status FROM inbox WHERE id=$1", [id])).rows[0]
        .status,
    ).toBe("failed");
  });
  it("retries definite message rejection and clears delivered payloads", async () => {
    const id = "safe-retry-" + suffix;
    await store.transaction((tx) =>
      tx.queue({ id, dedupeKey: id, payload: { secret: "private" } }),
    );
    const first = await store.claimOutbox("sender");
    expect(first?.id).toBe(id);
    await store.retryOutbox(id, "sender", 0);
    const second = await store.claimOutbox("sender");
    expect(second?.attempts).toBe(2);
    await store.markSent(id, "sender");
    expect(
      (await pool.query("SELECT status,payload FROM outbox WHERE id=$1", [id]))
        .rows[0],
    ).toEqual({ status: "sent", payload: {} });
  });
  it("atomically enforces usage limits and finds members in dinner state", async () => {
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        store.transaction((tx) =>
          tx.consumeUsage("updates", suffix, "2026-10-28", 2),
        ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(2);
    await store.transaction(async (tx) => {
      const d = await tx.getDinner(suffix);
      await tx.saveDinner(
        { ...d!, state: { dinner: { members: [{ id: "joined-" + suffix }] } } },
        d!.revision,
      );
    });
    expect(
      (await store.listDinnersForUser("joined-" + suffix)).map((d) => d.id),
    ).toContain(suffix);
    expect(await store.activeDinnerCount()).toBeGreaterThanOrEqual(1);
    expect((await store.listActiveDinners()).map((d) => d.id)).toContain(
      suffix,
    );
  });
  it("purges pending incoming private data without removing dedupe tombstones", async () => {
    const id = "private-inbox-" + suffix;
    await store.enqueueInbox(id, {
      actorId: "erased-" + suffix,
      secret: "private",
    });
    await store.transaction((tx) => tx.deleteUser("erased-" + suffix));
    expect(
      (await pool.query("SELECT payload,status FROM inbox WHERE id=$1", [id]))
        .rows[0],
    ).toEqual({ payload: {}, status: "done" });
    expect(await store.enqueueInbox(id, { actorId: "erased-" + suffix })).toBe(
      false,
    );
  });
  it("consumes participant-bound OAuth state only once", async () => {
    await store.transaction((tx) =>
      tx.createOAuthState(
        "hash-" + suffix,
        suffix,
        "member",
        new Date(Date.now() + 10000),
      ),
    );
    expect(
      await store.transaction((tx) => tx.getOAuthState("hash-" + suffix)),
    ).toEqual({ dinnerId: suffix, userId: "member" });
    expect(
      await store.transaction((tx) =>
        tx.consumeOAuthState("hash-" + suffix, "stranger"),
      ),
    ).toBeNull();
    expect(
      await store.transaction((tx) =>
        tx.consumeOAuthState("hash-" + suffix, "member"),
      ),
    ).toEqual({ dinnerId: suffix, userId: "member" });
    expect(
      await store.transaction((tx) =>
        tx.consumeOAuthState("hash-" + suffix, "member"),
      ),
    ).toBeNull();
  });
  it("OPS-02 reserves at most one reminder across dinners in a 24-hour period", async () => {
    const first = "2026-10-28T15:00:00Z",
      user = "reminder-" + suffix;
    const results = await Promise.all(
      [1, 2].map(() =>
        store.transaction((tx) => tx.reserveReminder(user, first)),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await store.transaction((tx) =>
        tx.reserveReminder(user, "2026-10-29T14:59:59Z"),
      ),
    ).toBe(false);
    expect(
      await store.transaction((tx) =>
        tx.reserveReminder(user, "2026-10-29T15:00:00Z"),
      ),
    ).toBe(true);
  });
  it("OPS-01 concurrent container restarts leave completed migrations and stored state intact", async () => {
    const before = await store.readDinner(suffix);
    await Promise.all([migrate(pool), migrate(pool)]);
    expect(await store.readDinner(suffix)).toEqual(before);
    expect(
      (
        await pool.query(
          "SELECT version FROM schema_migrations ORDER BY version",
        )
      ).rows.map((row) => row.version),
    ).toEqual(["001", "002", "003"]);
  });
  it("PRIV-02 erases pending membership requests even when addressed to the organizer", async () => {
    const id = "join-notice-" + suffix,
      user = "pending-joiner-" + suffix;
    await store.transaction(async (tx) => {
      const record = await tx.getDinner(suffix);
      await tx.saveDinner(
        {
          ...record!,
          state: {
            dinner: { members: [] },
            consents: { [user]: { active: true } },
            joinRequests: { [user]: { name: "private" } },
          },
        },
        record!.revision,
      );
      await tx.queue({
        id,
        dedupeKey: id,
        subjectUserId: "organizer",
        payload: { relatedUserIds: [user], text: "private name" },
      });
    });
    expect((await store.listDinnersForUser(user)).map((d) => d.id)).toContain(
      suffix,
    );
    await store.transaction((tx) => tx.deleteUser(user));
    expect(
      (await pool.query("SELECT status,payload FROM outbox WHERE id=$1", [id]))
        .rows[0],
    ).toEqual({ status: "suppressed", payload: {} });
  });
});

import type { Pool, PoolClient } from "pg";

export interface DinnerRecord<S = unknown> {
  id: string;
  organizerId: string;
  revision: number;
  state: S;
  endedAt: Date | null;
}
export interface NewDinner<S = unknown> {
  id: string;
  organizerId: string;
  state: S;
  endedAt?: Date | null;
}
export interface Session {
  currentDinnerId: string | null;
  pendingSetup: unknown;
  pendingOnboard: unknown;
}
export interface Outgoing {
  id: string;
  dedupeKey: string;
  payload: unknown;
  kind?: string;
  subjectUserId?: string;
  dinnerId?: string;
  availableAt?: Date;
}
export interface ClaimedWork {
  id: string;
  payload: unknown;
  attempts: number;
  kind?: string;
}
export class RevisionConflict extends Error {
  constructor() {
    super("Dinner revision changed");
    this.name = "RevisionConflict";
  }
}
function dinner<S>(row: Record<string, unknown>): DinnerRecord<S> {
  return {
    id: row.id as string,
    organizerId: row.organizer_id as string,
    revision: row.revision as number,
    state: row.state as S,
    endedAt: row.ended_at as Date | null,
  };
}

/** No network calls in transaction callbacks: commit durable work for workers instead. */
export class DinnerTx {
  constructor(
    /** @internal Transaction-scoped connection; never retain it. */ readonly client: PoolClient,
  ) {}
  async getDinner<S = unknown>(id: string): Promise<DinnerRecord<S> | null> {
    const r = await this.client.query(
      "SELECT * FROM dinners WHERE id=$1 FOR UPDATE",
      [id],
    );
    return r.rows[0] ? dinner<S>(r.rows[0]) : null;
  }
  async findActiveDinner<S = unknown>(
    organizerId: string,
  ): Promise<DinnerRecord<S> | null> {
    const r = await this.client.query(
      "SELECT * FROM dinners WHERE organizer_id=$1 AND ended_at IS NULL FOR UPDATE",
      [organizerId],
    );
    return r.rows[0] ? dinner<S>(r.rows[0]) : null;
  }
  async listActiveDinners<S = unknown>(): Promise<DinnerRecord<S>[]> {
    const r = await this.client.query(
      "SELECT * FROM dinners WHERE ended_at IS NULL ORDER BY id",
    );
    return r.rows.map((row) => dinner<S>(row));
  }
  async listDinnersForUser<S = unknown>(
    userId: string,
  ): Promise<DinnerRecord<S>[]> {
    const r = await this.client.query(
      "SELECT * FROM dinners WHERE organizer_id=$1 OR state->'dinner'->'members' @> $2::jsonb OR (state->'consents') ? $1 OR (state->'joinRequests') ? $1 ORDER BY id",
      [userId, JSON.stringify([{ id: userId }])],
    );
    return r.rows.map((row) => dinner<S>(row));
  }
  async activeDinnerCount(): Promise<number> {
    const r = await this.client.query(
      "SELECT count(*)::int AS count FROM dinners WHERE ended_at IS NULL",
    );
    return r.rows[0].count;
  }
  async reserveReminder(userId: string, at: string): Promise<boolean> {
    const result = await this.client.query(
      "INSERT INTO reminder_limits(user_id,last_at) VALUES ($1,$2) ON CONFLICT(user_id) DO UPDATE SET last_at=$2 WHERE reminder_limits.last_at<=$2::timestamptz-interval '24 hours' RETURNING user_id",
      [userId, at],
    );
    return result.rowCount === 1;
  }
  async cancelDinnerWork(id: string): Promise<void> {
    await this.client.query(
      "UPDATE user_sessions SET pending_onboard=NULL,updated_at=now() WHERE pending_onboard->>'dinnerId'=$1",
      [id],
    );
    await this.client.query(
      "DELETE FROM calendar_connections WHERE dinner_id=$1",
      [id],
    );
    await this.client.query("DELETE FROM invitations WHERE dinner_id=$1", [id]);
    await this.client.query("DELETE FROM oauth_states WHERE dinner_id=$1", [
      id,
    ]);
    await this.client.query(
      "UPDATE outbox SET status=CASE WHEN kind='message' AND status='sending' THEN 'ambiguous' ELSE 'suppressed' END,payload='{}'::jsonb,completed_at=now(),lease_owner=NULL,lease_until=NULL WHERE dinner_id=$1 AND status IN ('pending','sending')",
      [id],
    );
  }
  async deleteDinner(id: string): Promise<void> {
    await this.client.query("DELETE FROM dinners WHERE id=$1", [id]);
  }
  async consumeUsage(
    scope: string,
    subjectId: string,
    day: string,
    limit: number,
    amount = 1,
  ): Promise<boolean> {
    if (
      !Number.isInteger(limit) ||
      !Number.isInteger(amount) ||
      amount <= 0 ||
      limit < amount
    )
      return false;
    const r = await this.client.query(
      "INSERT INTO usage_counts(scope,subject_id,day,count) VALUES ($1,$2,$3,$4) ON CONFLICT(scope,subject_id,day) DO UPDATE SET count=usage_counts.count+$4 WHERE usage_counts.count+$4<=$5 RETURNING count",
      [scope, subjectId, day, amount, limit],
    );
    return r.rowCount === 1;
  }
  async createDinner<S>(input: NewDinner<S>): Promise<DinnerRecord<S>> {
    const r = await this.client.query(
      "INSERT INTO dinners(id,organizer_id,state,ended_at) VALUES ($1,$2,$3,$4) RETURNING *",
      [
        input.id,
        input.organizerId,
        JSON.stringify(input.state),
        input.endedAt ?? null,
      ],
    );
    return dinner<S>(r.rows[0]);
  }
  async saveDinner<S>(
    input: DinnerRecord<S>,
    expectedRevision: number,
  ): Promise<DinnerRecord<S>> {
    const r = await this.client.query(
      "UPDATE dinners SET state=$2, ended_at=$3, revision=revision+1, updated_at=now() WHERE id=$1 AND revision=$4 RETURNING *",
      [input.id, JSON.stringify(input.state), input.endedAt, expectedRevision],
    );
    if (!r.rowCount) throw new RevisionConflict();
    return dinner<S>(r.rows[0]);
  }
  async saveProposal(
    dinnerId: string,
    version: number,
    snapshot: unknown,
  ): Promise<void> {
    await this.client.query(
      "INSERT INTO proposal_versions(dinner_id,version,snapshot) VALUES ($1,$2,$3)",
      [dinnerId, version, JSON.stringify(snapshot)],
    );
  }
  async getMiniAppReceipt(
    userId: string,
    requestId: string,
  ): Promise<{ requestHash: string; response: unknown } | null> {
    const result = await this.client.query(
      "SELECT request_hash,response FROM miniapp_receipts WHERE user_id=$1 AND request_id=$2",
      [userId, requestId],
    );
    return result.rows[0]
      ? {
          requestHash: result.rows[0].request_hash,
          response: result.rows[0].response,
        }
      : null;
  }
  async putMiniAppReceipt(
    userId: string,
    requestId: string,
    requestHash: string,
    response: unknown,
    dinnerId?: string,
  ): Promise<void> {
    await this.client.query(
      "INSERT INTO miniapp_receipts(user_id,request_id,request_hash,response,dinner_id) VALUES ($1,$2,$3,$4,$5)",
      [
        userId,
        requestId,
        requestHash,
        JSON.stringify(response),
        dinnerId ?? null,
      ],
    );
  }
  async getSession(userId: string): Promise<Session | null> {
    const r = await this.client.query(
      "SELECT * FROM user_sessions WHERE user_id=$1",
      [userId],
    );
    const row = r.rows[0];
    return row
      ? {
          currentDinnerId: row.current_dinner_id,
          pendingSetup: row.pending_setup,
          pendingOnboard: row.pending_onboard,
        }
      : null;
  }
  async setSession(userId: string, session: Session): Promise<void> {
    await this.client.query(
      "INSERT INTO user_sessions(user_id,current_dinner_id,pending_setup,pending_onboard) VALUES ($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET current_dinner_id=$2,pending_setup=$3,pending_onboard=$4,updated_at=now()",
      [
        userId,
        session.currentDinnerId,
        JSON.stringify(session.pendingSetup),
        JSON.stringify(session.pendingOnboard),
      ],
    );
  }
  async queue(work: Outgoing): Promise<void> {
    await this.client.query(
      "INSERT INTO outbox(id,dedupe_key,kind,subject_user_id,dinner_id,payload,available_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(dedupe_key) DO NOTHING",
      [
        work.id,
        work.dedupeKey,
        work.kind ?? "message",
        work.subjectUserId ?? null,
        work.dinnerId ?? null,
        JSON.stringify(work.payload),
        work.availableAt ?? new Date(),
      ],
    );
  }
  async createInvitation(
    tokenHash: string,
    dinnerId: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.client.query(
      "INSERT INTO invitations(token_hash,dinner_id,expires_at) VALUES ($1,$2,$3)",
      [tokenHash, dinnerId, expiresAt],
    );
  }
  async lookupInvitation(tokenHash: string): Promise<string | null> {
    const r = await this.client.query(
      "SELECT i.dinner_id FROM invitations i JOIN dinners d ON d.id=i.dinner_id WHERE token_hash=$1 AND expires_at>now() AND d.ended_at IS NULL",
      [tokenHash],
    );
    return r.rows[0]?.dinner_id ?? null;
  }
  async createOAuthState(
    tokenHash: string,
    dinnerId: string,
    userId: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.client.query(
      "INSERT INTO oauth_states(token_hash,dinner_id,user_id,expires_at) VALUES ($1,$2,$3,$4)",
      [tokenHash, dinnerId, userId, expiresAt],
    );
  }
  async getOAuthState(
    tokenHash: string,
  ): Promise<{ dinnerId: string; userId: string } | null> {
    const r = await this.client.query(
      "SELECT s.dinner_id,s.user_id FROM oauth_states s JOIN dinners d ON d.id=s.dinner_id WHERE s.token_hash=$1 AND s.expires_at>now() AND d.ended_at IS NULL",
      [tokenHash],
    );
    return r.rows[0]
      ? { dinnerId: r.rows[0].dinner_id, userId: r.rows[0].user_id }
      : null;
  }
  async consumeOAuthState(
    tokenHash: string,
    userId: string,
  ): Promise<{ dinnerId: string; userId: string } | null> {
    const r = await this.client.query(
      "DELETE FROM oauth_states WHERE token_hash=$1 AND user_id=$2 AND expires_at>now() RETURNING dinner_id,user_id",
      [tokenHash, userId],
    );
    return r.rows[0]
      ? { dinnerId: r.rows[0].dinner_id, userId: r.rows[0].user_id }
      : null;
  }
  async setCalendarConnection(
    dinnerId: string,
    userId: string,
    encryptedToken: string,
  ): Promise<void> {
    await this.client.query(
      "INSERT INTO calendar_connections(dinner_id,user_id,encrypted_token) VALUES ($1,$2,$3) ON CONFLICT(dinner_id,user_id) DO UPDATE SET encrypted_token=$3,updated_at=now()",
      [dinnerId, userId, encryptedToken],
    );
  }
  async getCalendarConnection(
    dinnerId: string,
    userId: string,
  ): Promise<string | null> {
    const r = await this.client.query(
      "SELECT encrypted_token FROM calendar_connections WHERE dinner_id=$1 AND user_id=$2",
      [dinnerId, userId],
    );
    return r.rows[0]?.encrypted_token ?? null;
  }
  async disconnectCalendar(dinnerId: string, userId: string): Promise<void> {
    await this.client.query(
      "DELETE FROM calendar_connections WHERE dinner_id=$1 AND user_id=$2",
      [dinnerId, userId],
    );
    await this.client.query(
      "DELETE FROM oauth_states WHERE dinner_id=$1 AND user_id=$2",
      [dinnerId, userId],
    );
  }
  /** Application must also redact this user from domain JSON before committing. */
  async deleteUser(userId: string): Promise<void> {
    await this.client.query("DELETE FROM miniapp_receipts WHERE user_id=$1", [
      userId,
    ]);
    await this.client.query(
      "UPDATE inbox SET payload='{}'::jsonb,status=CASE WHEN status IN ('pending','processing') THEN 'done' ELSE status END,completed_at=COALESCE(completed_at,now()),lease_owner=NULL,lease_until=NULL WHERE payload->>'actorId'=$1",
      [userId],
    );
    await this.client.query("DELETE FROM usage_counts WHERE subject_id=$1", [
      userId,
    ]);
    await this.client.query("DELETE FROM reminder_limits WHERE user_id=$1", [
      userId,
    ]);
    await this.client.query(
      "DELETE FROM calendar_connections WHERE user_id=$1",
      [userId],
    );
    await this.client.query("DELETE FROM oauth_states WHERE user_id=$1", [
      userId,
    ]);
    await this.client.query("DELETE FROM user_sessions WHERE user_id=$1", [
      userId,
    ]);
    await this.client.query(
      "UPDATE outbox SET payload='{}'::jsonb,dedupe_key=CASE WHEN subject_user_id=$1 THEN 'erased:'||id ELSE dedupe_key END,subject_user_id=CASE WHEN subject_user_id=$1 THEN NULL ELSE subject_user_id END,status=CASE WHEN status='sending' THEN 'ambiguous' WHEN status='pending' THEN 'suppressed' ELSE status END,completed_at=now() WHERE subject_user_id=$1 OR (payload->'relatedUserIds') ? $1",
      [userId],
    );
  }
}

export class PgStore {
  constructor(readonly pool: Pool) {}
  async transaction<T>(fn: (tx: DinnerTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Global serialization avoids cross-dinner/session lock-order deadlocks and lost setup updates.
      await client.query("SELECT pg_advisory_xact_lock(348245712)");
      const value = await fn(new DinnerTx(client));
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async readDinner<S = unknown>(id: string): Promise<DinnerRecord<S> | null> {
    const r = await this.pool.query("SELECT * FROM dinners WHERE id=$1", [id]);
    return r.rows[0] ? dinner<S>(r.rows[0]) : null;
  }
  async listActiveDinners<S = unknown>(): Promise<DinnerRecord<S>[]> {
    return this.transaction((tx) => tx.listActiveDinners<S>());
  }
  async listDinnersForUser<S = unknown>(
    userId: string,
  ): Promise<DinnerRecord<S>[]> {
    return this.transaction((tx) => tx.listDinnersForUser<S>(userId));
  }
  async activeDinnerCount(): Promise<number> {
    return this.transaction((tx) => tx.activeDinnerCount());
  }
  async transactDinner<S>(
    id: string,
    expectedRevision: number,
    fn: (state: S, tx: DinnerTx) => Promise<S>,
  ): Promise<DinnerRecord<S>> {
    return this.transaction(async (tx) => {
      const current = await tx.getDinner<S>(id);
      if (!current || current.revision !== expectedRevision)
        throw new RevisionConflict();
      const state = await fn(current.state, tx);
      return tx.saveDinner({ ...current, state }, expectedRevision);
    });
  }
  async enqueueInbox(id: string, payload: unknown): Promise<boolean> {
    const r = await this.pool.query(
      "INSERT INTO inbox(id,payload) VALUES ($1,$2) ON CONFLICT(id) DO NOTHING",
      [id, JSON.stringify(payload)],
    );
    return r.rowCount === 1;
  }
  async claimInbox(
    worker: string,
    leaseMs = 60000,
  ): Promise<ClaimedWork | null> {
    const r = await this.pool.query(
      "UPDATE inbox SET status='processing',lease_owner=$1,lease_until=now()+($2 * interval '1 millisecond'),attempts=attempts+1 WHERE id=(SELECT id FROM inbox WHERE status='pending' AND available_at<=now() AND attempts<5 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,payload,attempts",
      [worker, leaseMs],
    );
    return r.rows[0] ?? null;
  }
  async processInbox(
    id: string,
    worker: string,
    fn: (tx: DinnerTx, payload: unknown) => Promise<void>,
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      // Access through the same checked-out connection as the state mutation.
      const client = tx.client;
      const r = await client.query(
        "SELECT payload FROM inbox WHERE id=$1 AND status='processing' AND lease_owner=$2 AND lease_until>now() FOR UPDATE",
        [id, worker],
      );
      if (!r.rowCount) return false;
      await fn(tx, r.rows[0].payload);
      await client.query(
        "UPDATE inbox SET status='done',payload='{}'::jsonb,completed_at=now(),lease_owner=NULL,lease_until=NULL WHERE id=$1",
        [id],
      );
      return true;
    });
  }
  async failInbox(
    id: string,
    worker: string,
    error: string,
    retryMs = 1000,
  ): Promise<void> {
    await this.pool.query(
      "UPDATE inbox SET payload=CASE WHEN attempts>=5 THEN '{}'::jsonb ELSE payload END,status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,last_error=$3,available_at=now()+($4 * interval '1 millisecond'),lease_owner=NULL,lease_until=NULL,completed_at=CASE WHEN attempts>=5 THEN now() ELSE NULL END WHERE id=$1 AND lease_owner=$2 AND status='processing'",
      [id, worker, error.slice(0, 500), retryMs],
    );
  }
  async claimOutbox(
    worker: string,
    leaseMs = 60000,
    kind = "message",
  ): Promise<ClaimedWork | null> {
    const r = await this.pool.query(
      "UPDATE outbox SET status='sending',lease_owner=$1,lease_until=now()+($2 * interval '1 millisecond'),attempts=attempts+1 WHERE id=(SELECT id FROM outbox WHERE status='pending' AND available_at<=now() AND attempts<5 AND kind=$3 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,payload,attempts,kind",
      [worker, leaseMs, kind],
    );
    return r.rows[0] ?? null;
  }
  /** Commit a local research result and its state/outbox effects exactly once. */
  async processWork(
    id: string,
    worker: string,
    fn: (tx: DinnerTx, payload: unknown) => Promise<void>,
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      const r = await tx.client.query(
        "SELECT payload FROM outbox WHERE id=$1 AND kind<>'message' AND status='sending' AND lease_owner=$2 AND lease_until>now() FOR UPDATE",
        [id, worker],
      );
      if (!r.rowCount) return false;
      await fn(tx, r.rows[0].payload);
      await tx.client.query(
        "UPDATE outbox SET status='sent',payload='{}'::jsonb,completed_at=now(),lease_owner=NULL,lease_until=NULL WHERE id=$1",
        [id],
      );
      return true;
    });
  }
  async markSent(id: string, worker: string): Promise<void> {
    await this.finishOutbox(id, worker, "sent");
  }
  async markAmbiguous(id: string, worker: string): Promise<void> {
    await this.finishOutbox(id, worker, "ambiguous");
  }
  async markFailed(id: string, worker: string): Promise<void> {
    await this.finishOutbox(id, worker, "failed");
  }
  async markSuppressed(id: string, worker: string): Promise<void> {
    await this.finishOutbox(id, worker, "suppressed");
  }
  private async finishOutbox(
    id: string,
    worker: string,
    status: string,
  ): Promise<void> {
    await this.pool.query(
      "UPDATE outbox SET status=$3,payload='{}'::jsonb,completed_at=now(),lease_owner=NULL,lease_until=NULL WHERE id=$1 AND lease_owner=$2 AND status='sending'",
      [id, worker, status],
    );
  }
  /** Only for a provider response definitively confirming no delivery (e.g. HTTP 429). */
  async retryOutbox(
    id: string,
    worker: string,
    delayMs: number,
  ): Promise<void> {
    await this.pool.query(
      "UPDATE outbox SET payload=CASE WHEN attempts>=5 THEN '{}'::jsonb ELSE payload END,status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,available_at=now()+($3 * interval '1 millisecond'),completed_at=CASE WHEN attempts>=5 THEN now() ELSE NULL END,lease_owner=NULL,lease_until=NULL WHERE id=$1 AND lease_owner=$2 AND status='sending'",
      [id, worker, Math.max(0, delayMs)],
    );
  }
  async recoverLeases(): Promise<void> {
    await this.pool.query(
      "UPDATE inbox SET payload=CASE WHEN attempts>=5 THEN '{}'::jsonb ELSE payload END,status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,completed_at=CASE WHEN attempts>=5 THEN now() ELSE NULL END,lease_owner=NULL,lease_until=NULL WHERE status='processing' AND lease_until<now()",
    );
    await this.pool.query(
      "UPDATE outbox SET payload=CASE WHEN kind='message' OR attempts>=5 THEN '{}'::jsonb ELSE payload END,status=CASE WHEN kind='message' THEN 'ambiguous' WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,completed_at=CASE WHEN kind='message' OR attempts>=5 THEN now() ELSE NULL END,lease_owner=NULL,lease_until=NULL WHERE status='sending' AND lease_until<now()",
    );
  }
  async purgeExpired(): Promise<void> {
    await this.transaction(async (tx) => {
      const client = tx.client;
      await client.query(
        "UPDATE inbox SET payload='{}'::jsonb,status='failed',completed_at=now(),lease_owner=NULL,lease_until=NULL WHERE created_at<now()-interval '7 days' AND status IN ('pending','processing')",
      );
      await client.query(
        "UPDATE outbox SET payload='{}'::jsonb,status='suppressed',completed_at=now(),lease_owner=NULL,lease_until=NULL WHERE created_at<now()-interval '7 days' AND status='pending'",
      );
      await client.query(
        "DELETE FROM reminder_limits WHERE last_at<now()-interval '7 days'",
      );
      await client.query(
        "DELETE FROM miniapp_receipts WHERE created_at<now()-interval '7 days'",
      );
      await client.query("DELETE FROM usage_counts WHERE day<current_date-7");
      await client.query("DELETE FROM oauth_states WHERE expires_at<=now()");
      await client.query("DELETE FROM invitations WHERE expires_at<=now()");
      await client.query(
        "DELETE FROM calendar_connections WHERE dinner_id IN (SELECT id FROM dinners WHERE ended_at<now()-interval '7 days')",
      );
      await client.query(
        "DELETE FROM dinners WHERE ended_at<now()-interval '7 days'",
      );
      await client.query(
        "DELETE FROM inbox WHERE completed_at<now()-interval '7 days'",
      );
      await client.query(
        "DELETE FROM outbox WHERE completed_at<now()-interval '7 days'",
      );
      await client.query(
        "DELETE FROM user_sessions WHERE updated_at<now()-interval '7 days' AND current_dinner_id IS NULL",
      );
    });
  }
}

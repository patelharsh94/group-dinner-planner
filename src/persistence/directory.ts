import type { Pool, PoolClient } from "pg";
import type { DinnerTx } from "./store.js";
import type { YelpBusiness } from "../adapters/yelp.js";

type Database = Pool | PoolClient | DinnerTx;
const connection = (db: Database): Pool | PoolClient =>
  "client" in db ? db.client : db;
/** This table is ephemeral. Do not include its payloads in exports, snapshots or backups. */
export async function purgeDirectoryBusinesses(
  db: Database,
  now: string,
): Promise<void> {
  await connection(db).query(
    "DELETE FROM directory_business_cache WHERE expires_at <= $1",
    [now],
  );
}
export async function getDirectoryBusinesses(
  db: Database,
  ids: string[],
  now: string,
): Promise<YelpBusiness[]> {
  await purgeDirectoryBusinesses(db, now);
  if (!ids.length) return [];
  const result = await connection(db).query(
    "SELECT payload FROM directory_business_cache WHERE business_id=ANY($1::text[]) AND retrieved_at <= $2 AND expires_at > $2",
    [ids.slice(0, 100), now],
  );
  const byId = new Map(
    result.rows.map((row) => [row.payload.id, row.payload as YelpBusiness]),
  );
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}
export async function putDirectoryBusinesses(
  db: Database,
  businesses: YelpBusiness[],
  now: string,
): Promise<void> {
  await purgeDirectoryBusinesses(db, now);
  for (const business of businesses.slice(0, 10)) {
    const retrieved = Date.parse(business.retrievedAt),
      expires = Date.parse(business.expiresAt);
    if (
      !/^[A-Za-z0-9_-]{1,200}$/.test(business.id) ||
      !Number.isFinite(retrieved) ||
      !Number.isFinite(expires) ||
      retrieved > Date.parse(now) ||
      expires <= Date.parse(now) ||
      expires <= retrieved ||
      expires - retrieved > 23 * 3600000
    )
      throw new Error("Invalid directory cache lifetime");
    await connection(db).query(
      "INSERT INTO directory_business_cache(business_id,payload,retrieved_at,expires_at) VALUES($1,$2::jsonb,$3,$4) ON CONFLICT(business_id) DO UPDATE SET payload=excluded.payload,retrieved_at=excluded.retrieved_at,expires_at=excluded.expires_at WHERE directory_business_cache.retrieved_at<=excluded.retrieved_at",
      [
        business.id,
        JSON.stringify(business),
        business.retrievedAt,
        business.expiresAt,
      ],
    );
  }
}

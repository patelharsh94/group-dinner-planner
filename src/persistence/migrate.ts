import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import "../env.js";

/** Safe to invoke concurrently; the schema version and DDL commit together. */
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(348245711)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const [version, name] of [
      ["001", "001_initial.sql"],
      ["002", "002_usage.sql"],
      ["003", "003_reminder_limits.sql"],
      ["004", "004_miniapp.sql"],
      ["005", "005_research.sql"],
      ["006", "006_multiple_dinners.sql"],
      ["007", "007_reservations.sql"],
    ] as const) {
      const existing = await client.query(
        "SELECT version FROM schema_migrations WHERE version=$1",
        [version],
      );
      if (!existing.rowCount) {
        const sql = await readFile(
          new URL(`../../migrations/${name}`, import.meta.url),
          "utf8",
        );
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations(version) VALUES ($1)",
          [version],
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}

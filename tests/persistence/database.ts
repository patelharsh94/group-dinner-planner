import { Pool } from "pg";
import { randomBytes } from "node:crypto";

/** Each suite owns a disposable schema, including its own inbox/outbox leases. */
export function isolatedDatabase() {
  const schema = `dinner_test_${randomBytes(10).toString("hex")}`;
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  return {
    pool,
    setup: () => pool.query(`CREATE SCHEMA "${schema}"`),
    cleanup: async () => {
      try {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    },
  };
}

import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "dinner-pg-"));
const pg = new EmbeddedPostgres({
  databaseDir: directory,
  port: 55439,
  user: "postgres",
  password: "test-only",
  persistent: false,
  postgresFlags: ["-h", "127.0.0.1"],
  onLog: () => {},
  onError: () => {},
});
try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("dinner_test");
  const child = spawn(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", "tests/persistence"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        TEST_DATABASE_URL:
          "postgres://postgres:test-only@127.0.0.1:55439/dinner_test",
      },
    },
  );
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await pg.stop();
}

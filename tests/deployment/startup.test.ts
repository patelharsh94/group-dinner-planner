import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

function runStartup(migrationExit: number) {
  const directory = mkdtempSync(join(tmpdir(), "dinner-startup-"));
  const log = join(directory, "calls");
  try {
    // Exercise the container command without running the bot or touching a real database.
    writeFileSync(
      join(directory, "node"),
      '#!/bin/sh\nprintf "%s\\n" "$1" >> "$STARTUP_CALLS"\nif [ "$1" = "dist/persistence/migrate.js" ]; then exit "$MIGRATION_EXIT"; fi\n',
      { mode: 0o755 },
    );
    const dockerfile = readFileSync(
      new URL("../../Dockerfile", import.meta.url),
      "utf8",
    );
    const cmd = JSON.parse(dockerfile.match(/^CMD (.+)$/m)![1]) as string[];
    const result = spawnSync(cmd[0], cmd.slice(1), {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        STARTUP_CALLS: log,
        MIGRATION_EXIT: String(migrationExit),
      },
    });
    return {
      status: result.status,
      calls: readFileSync(log, "utf8").trim().split("\n"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
it("OPS-01 container applies migrations before starting the HTTP server and worker", () => {
  expect(runStartup(0)).toEqual({
    status: 0,
    calls: ["dist/persistence/migrate.js", "dist/main.js"],
  });
});
it("OPS-01 a failed migration aborts startup instead of serving against an incomplete schema", () => {
  expect(runStartup(17)).toEqual({
    status: 17,
    calls: ["dist/persistence/migrate.js"],
  });
});

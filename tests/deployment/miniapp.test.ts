import { afterEach, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPlannerStatic } from "../../src/miniapp-static.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it("UI-01 OPS-01 serves the built mobile app only below /app with scoped security/cache headers", async () => {
  const root = await mkdtemp(join(tmpdir(), "planner-static-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "assets"));
  await writeFile(
    join(root, "index.html"),
    "<!doctype html><title>Planner</title>",
  );
  await writeFile(
    join(root, "assets", "app-test.js"),
    "export const planner=true;",
  );
  const app = Fastify();
  cleanup.push(() => app.close());
  registerPlannerStatic(app, root);
  app.get("/health", async () => ({ ok: true }));
  expect((await app.inject("/app")).headers.location).toBe("/app/");
  const html = await app.inject("/app/");
  expect(html.statusCode).toBe(200);
  expect(html.body).toContain("<title>Planner");
  expect(html.headers["cache-control"]).toBe("no-store");
  expect(html.headers["content-security-policy"]).toContain(
    "https://telegram.org",
  );
  const asset = await app.inject("/app/assets/app-test.js");
  expect(asset.statusCode).toBe(200);
  expect(asset.headers["cache-control"]).toContain("immutable");
  for (const path of [
    "/api/missing",
    "/app/missing.js",
    "/app/%2e%2e/package.json",
    "/app/.env",
  ])
    expect((await app.inject(path)).statusCode).toBe(404);
  expect((await app.inject("/health")).json()).toEqual({ ok: true });
});

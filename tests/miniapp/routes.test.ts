import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerMiniAppRoutes } from "../../src/miniapp/routes.js";
import { Coordinator } from "../../src/application/coordinator.js";
import type { Config } from "../../src/config.js";
import type { PgStore } from "../../src/persistence/store.js";
const token = "123456:fake-token";
function signed() {
  const p = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 42, first_name: "Sam" }),
  });
  const check = [...p]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  p.set(
    "hash",
    createHmac(
      "sha256",
      createHmac("sha256", "WebAppData").update(token).digest(),
    )
      .update(check)
      .digest("hex"),
  );
  return "tma " + p.toString();
}
const config = {
  TELEGRAM_BOT_TOKEN: token,
  SUPPORT_CONTACT: "help@example.test",
  PUBLIC_URL: "https://example.test",
  TELEGRAM_BOT_USERNAME: "dinnerbot",
} as Config;
function fixture(started = true) {
  const tx = {
    getSession: vi
      .fn()
      .mockResolvedValue(started ? { currentDinnerId: null } : null),
    listDinnersForUser: vi.fn().mockResolvedValue([]),
    getDinner: vi.fn().mockResolvedValue(null),
  };
  const transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx));
  const app = Fastify({ logger: false });
  registerMiniAppRoutes(app, {
    store: { transaction } as unknown as PgStore,
    coordinator: new Coordinator(config),
    config,
  });
  return { app, tx, transaction };
}
describe("Mini App API boundary", () => {
  it("requires signed Telegram authorization before any database access", async () => {
    const { app, transaction } = fixture();
    try {
      for (const authorization of ["", "Bearer secret", "tma user=PRIVATE"]) {
        const r = await app.inject({
          url: "/api/miniapp/bootstrap",
          headers: { authorization },
        });
        expect(r.statusCode).toBe(401);
        expect(r.json()).toMatchObject({ error: { code: "AUTH" } });
        expect(r.body).not.toContain("PRIVATE");
      }
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("requires bot start and exposes only whitelisted bootstrap fields", async () => {
    const absent = fixture(false);
    try {
      const r = await absent.app.inject({
        url: "/api/miniapp/bootstrap",
        headers: { authorization: signed() },
      });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe("BOT_START_REQUIRED");
    } finally {
      await absent.app.close();
    }
    const { app } = fixture();
    try {
      const r = await app.inject({
        url: "/api/miniapp/bootstrap",
        headers: { authorization: signed() },
      });
      expect(r.statusCode).toBe(200);
      expect(Object.keys(r.json()).sort()).toEqual([
        "actor",
        "botUsername",
        "currentDinnerId",
        "dinners",
        "privacyUrl",
        "supportContact",
      ]);
      expect(r.json().actor).toEqual({ id: "42", name: "Sam" });
      expect(r.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });
  it("returns structured action validation and denies unknown private dinners", async () => {
    const { app } = fixture();
    try {
      const headers = { authorization: signed() };
      const invalid = await app.inject({
        method: "POST",
        url: "/api/miniapp/actions",
        headers,
        payload: { requestId: "bad", action: "rawAggregate" },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe("VALIDATION");
      const absent = await app.inject({
        url: "/api/miniapp/dinners/unknown",
        headers,
      });
      expect(absent.statusCode).toBe(404);
      expect(absent.json().error.code).toBe("DINNER");
    } finally {
      await app.close();
    }
  });
});

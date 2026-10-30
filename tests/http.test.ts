import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Config } from "../src/config.js";
import type { PgStore } from "../src/persistence/store.js";
import { createServer } from "../src/http.js";
const secret = "a".repeat(24);
const config = {
  TELEGRAM_WEBHOOK_SECRET: secret,
  SUPPORT_CONTACT: "support@example.test",
} as Config;
const message = {
  update_id: 12,
  message: {
    chat: { id: 42, type: "private" },
    from: { id: 42, first_name: "Sam" },
    text: "/start",
  },
};
describe("HTTP boundary", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    apps.length = 0;
  });
  function setup() {
    const enqueueInbox = vi.fn().mockResolvedValue(true),
      query = vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] });
    const oauthCallback = vi
      .fn()
      .mockResolvedValue({ status: 200, text: "Calendar connected." });
    const app = createServer({
      store: { enqueueInbox, pool: { query } } as unknown as PgStore,
      config,
      oauthCallback,
    });
    apps.push(app);
    return { app, enqueueInbox, query, oauthCallback };
  }
  it("authenticates before accepting and durably normalizes private updates", async () => {
    const { app, enqueueInbox } = setup();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/telegram/webhook",
          payload: message,
        })
      ).statusCode,
    ).toBe(401);
    expect(enqueueInbox).not.toHaveBeenCalled();
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": secret },
      payload: message,
    });
    expect(response.statusCode).toBe(200);
    expect(enqueueInbox).toHaveBeenCalledWith("12", {
      eventId: "12",
      actorId: "42",
      chatId: "42",
      name: "Sam",
      text: "/start",
    });
  });
  it("ignores groups, impersonating chat IDs, bot actors, and unsupported updates", async () => {
    const { app, enqueueInbox } = setup();
    for (const payload of [
      {
        ...message,
        message: { ...message.message, chat: { id: -42, type: "group" } },
      },
      {
        ...message,
        message: { ...message.message, from: { id: 43, first_name: "Other" } },
      },
      {
        ...message,
        message: {
          ...message.message,
          from: { id: 42, first_name: "Bot", is_bot: true },
        },
      },
      { update_id: 42 },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/telegram/webhook",
            headers: { "x-telegram-bot-api-secret-token": secret },
            payload,
          })
        ).statusCode,
      ).toBe(200);
    }
    expect(enqueueInbox).not.toHaveBeenCalled();
  });
  it("normalizes private callback data and acknowledges persistence errors with retryable 503", async () => {
    const { app, enqueueInbox } = setup();
    const payload = {
      update_id: 13,
      callback_query: {
        id: "callback",
        from: { id: 42, first_name: "Sam" },
        message: { chat: { id: 42, type: "private" } },
        data: "confirm:1",
      },
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/telegram/webhook",
          headers: { "x-telegram-bot-api-secret-token": secret },
          payload,
        })
      ).statusCode,
    ).toBe(200);
    expect(enqueueInbox).toHaveBeenCalledWith(
      "13",
      expect.objectContaining({ text: "confirm:1", callbackId: "callback" }),
    );
    enqueueInbox.mockRejectedValue(new Error("database credentials PRIVATE"));
    const failed = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": secret },
      payload: message,
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain("PRIVATE");
  });
  it("rejects malformed and oversized updates", async () => {
    const { app } = setup();
    const headers = { "x-telegram-bot-api-secret-token": secret };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/telegram/webhook",
          headers,
          payload: { update_id: "bad" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/telegram/webhook",
          headers,
          payload: { ...message, padding: "a".repeat(65536) },
        })
      ).statusCode,
    ).toBe(413);
  });
  it("AUTH-01 forwarded commands do not express authenticated willingness", async () => {
    const { app, enqueueInbox } = setup();
    for (const forwarded of [
      { forward_origin: { type: "user", sender_user: { id: 99 } } },
      { forward_date: 123, forward_from: { id: 99 } },
    ]) {
      await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: { "x-telegram-bot-api-secret-token": secret },
        payload: {
          ...message,
          message: { ...message.message, text: "/confirm 1", ...forwarded },
        },
      });
    }
    expect(enqueueInbox).not.toHaveBeenCalled();
  });
  it("checks database readiness and provides plain privacy/support", async () => {
    const { app, query } = setup();
    expect((await app.inject("/health")).statusCode).toBe(200);
    query.mockRejectedValue(new Error("private"));
    expect((await app.inject("/health")).statusCode).toBe(503);
    const privacy = await app.inject("/privacy");
    expect(privacy.headers["content-type"]).toContain("text/plain");
    expect(privacy.body).toContain("seven days");
    expect(privacy.body).toContain("Muse");
    expect((await app.inject("/support")).body).toContain(
      "support@example.test",
    );
  });
  it("delegates OAuth without reflecting errors or bearer codes", async () => {
    const { app, oauthCallback } = setup();
    expect(
      (await app.inject("/oauth/google/callback?code=PRIVATE&state=token"))
        .body,
    ).toBe("Calendar connected.");
    expect(oauthCallback).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PRIVATE", state: "token" }),
    );
    oauthCallback.mockRejectedValue(new Error("PRIVATE"));
    const failed = await app.inject("/oauth/google/callback?code=PRIVATE");
    expect(failed.statusCode).toBe(400);
    expect(failed.body).not.toContain("PRIVATE");
    expect(failed.headers["cache-control"]).toBe("no-store");
    expect(
      (await app.inject("/calendar/export?token=PRIVATE")).statusCode,
    ).toBe(404);
  });
});

import Fastify from "fastify";
import { z } from "zod";
import type { Config } from "./config.js";
import type { PgStore } from "./persistence/store.js";
import { IncomingSchema, type Incoming } from "./application/model.js";
import { secretMatches } from "./adapters/security.js";

const id = z.number().int().safe();
const actor = z.object({
  id,
  first_name: z.string().max(256),
  last_name: z.string().max(256).optional(),
  is_bot: z.boolean().optional(),
});
const chat = z.object({ id, type: z.string() });
const updateSchema = z.object({
  update_id: id.nonnegative(),
  message: z
    .object({
      from: actor.optional(),
      chat,
      text: z.string().max(10000).optional(),
      forward_origin: z.unknown().optional(),
      forward_from: z.unknown().optional(),
      forward_date: z.unknown().optional(),
      forward_sender_name: z.unknown().optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string().min(1).max(256),
      from: actor,
      message: z.object({ chat }).optional(),
      data: z.string().max(10000).optional(),
    })
    .optional(),
});
function normalize(update: z.infer<typeof updateSchema>): Incoming | null {
  if (
    update.message &&
    [
      "forward_origin",
      "forward_from",
      "forward_date",
      "forward_sender_name",
    ].some((key) => key in update.message!)
  )
    return null;
  const callback = update.callback_query;
  const from = callback?.from ?? update.message?.from;
  const target = callback ? callback.message?.chat : update.message?.chat;
  const text = callback ? callback.data : update.message?.text;
  if (
    !from ||
    from.is_bot ||
    !target ||
    target.type !== "private" ||
    target.id !== from.id ||
    from.id <= 0 ||
    !text
  )
    return null;
  return IncomingSchema.parse({
    eventId: String(update.update_id),
    actorId: String(from.id),
    chatId: String(target.id),
    name: [from.first_name, from.last_name].filter(Boolean).join(" "),
    text,
    ...(callback ? { callbackId: callback.id } : {}),
  });
}
export interface ServerOptions {
  store: PgStore;
  config: Config;
  oauthCallback: (query: unknown) => Promise<{ status: number; text: string }>;
}
export function createServer({ store, config, oauthCallback }: ServerOptions) {
  const app = Fastify({ logger: false, bodyLimit: 65536 });
  app.setErrorHandler((error, _request, reply) => {
    const code =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
    const status = code === 413 ? 413 : code === 400 ? 400 : 500;
    void reply.code(status).send({
      error:
        status === 413
          ? "Request too large"
          : status === 400
            ? "Invalid request"
            : "Request failed",
    });
  });
  app.post("/telegram/webhook", async (request, reply) => {
    const header = request.headers["x-telegram-bot-api-secret-token"];
    if (
      !secretMatches(
        config.TELEGRAM_WEBHOOK_SECRET,
        typeof header === "string" ? header : undefined,
      )
    )
      return reply.code(401).send({ error: "Unauthorized" });
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "Invalid update" });
    const incoming = normalize(parsed.data);
    if (!incoming) return { ok: true };
    try {
      await store.enqueueInbox(incoming.eventId, incoming);
    } catch {
      return reply.code(503).send({ error: "Temporarily unavailable" });
    }
    return { ok: true };
  });
  const health = async (
    _request: unknown,
    reply: import("fastify").FastifyReply,
  ) => {
    try {
      await store.pool.query("SELECT 1");
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  };
  app.get("/health", health);
  app.get("/healthz", health);
  app.get("/privacy", async (_request, reply) =>
    reply
      .type("text/plain; charset=utf-8")
      .send(
        "This private dinner coordinator requires explicit consent before participation and calendar access. Private constraints and calendar busy times are used only for coordination. Muse receives minimized planning inputs; private calendar credentials and raw busy events are not sent to the model. Google Calendar access is read-only: the bot never writes calendar events or makes reservations. Calendar exports are sent privately as files. Ended dinner data is deleted after seven days. Use /delete to remove your data, /disconnect to revoke stored calendar access, or /stop to opt out. Contact: " +
          config.SUPPORT_CONTACT,
      ),
  );
  app.get("/support", async (_request, reply) =>
    reply
      .type("text/plain; charset=utf-8")
      .send(
        "Support: " +
          config.SUPPORT_CONTACT +
          "\nUse /help in your private bot conversation for commands.",
      ),
  );
  app.get("/oauth/google/callback", async (request, reply) => {
    reply
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .type("text/plain; charset=utf-8");
    try {
      const result = await oauthCallback(request.query);
      return reply.code(result.status).send(result.text);
    } catch {
      return reply
        .code(400)
        .send(
          "Calendar connection could not be completed. Return to the bot and try again.",
        );
    }
  });
  return app;
}

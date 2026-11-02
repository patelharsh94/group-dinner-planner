import type { FastifyInstance } from "fastify";
import type { Coordinator } from "../application/coordinator.js";
import type { Config } from "../config.js";
import type { PgStore } from "../persistence/store.js";
import { MiniAppFault, verifyInitData } from "./auth.js";
import { MiniAppService, publicFault } from "./service.js";
export function registerMiniAppRoutes(
  app: FastifyInstance,
  options: { store: PgStore; coordinator: Coordinator; config: Config },
): void {
  const service = new MiniAppService(
    options.store,
    options.coordinator,
    options.config,
  );
  app.register(async (api) => {
    api.addHook("onRequest", async (_request, reply) => {
      reply
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer");
    });
    api.setErrorHandler((error, _request, reply) => {
      const fault = publicFault(error);
      void reply
        .code(fault.status)
        .send({ error: { code: fault.code, message: fault.message } });
    });
    const actor = (authorization: string | undefined) => {
      if (!authorization?.startsWith("tma "))
        throw new MiniAppFault(
          "AUTH",
          401,
          "Open this app from Telegram to continue.",
        );
      return verifyInitData(
        authorization.slice(4),
        options.config.TELEGRAM_BOT_TOKEN,
      );
    };
    api.get<{ Querystring: { invite?: string } }>(
      "/api/miniapp/bootstrap",
      async (request) =>
        service.bootstrap(
          actor(request.headers.authorization),
          typeof request.query.invite === "string"
            ? request.query.invite
            : undefined,
        ),
    );
    api.get<{ Params: { id: string } }>(
      "/api/miniapp/dinners/:id",
      async (request) =>
        service.dinner(actor(request.headers.authorization), request.params.id),
    );
    api.get<{ Params: { id: string } }>(
      "/api/miniapp/dinners/:id/calendar",
      async (request, reply) => {
        const contents = await service.calendar(
          actor(request.headers.authorization),
          request.params.id,
        );
        return reply
          .type("text/calendar; charset=utf-8")
          .header("content-disposition", 'attachment; filename="dinner.ics"')
          .send(contents);
      },
    );
    api.post("/api/miniapp/actions", async (request) =>
      service.mutate(actor(request.headers.authorization), request.body),
    );
  });
}

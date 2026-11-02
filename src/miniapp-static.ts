import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
/** Scoped static app: API, webhook and OAuth paths never fall through to HTML. */
export function registerPlannerStatic(
  app: FastifyInstance,
  root = fileURLToPath(new URL("../dist/web/", import.meta.url)),
): void {
  app.get("/app", async (_request, reply) => reply.redirect("/app/"));
  app.register(fastifyStatic, {
    root,
    prefix: "/app/",
    index: ["index.html"],
    setHeaders(reply, path) {
      reply.header("Referrer-Policy", "no-referrer");
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; form-action 'self'",
      );
      reply.header(
        "Cache-Control",
        path.endsWith(".html")
          ? "no-store"
          : "public, max-age=31536000, immutable",
      );
    },
  });
}

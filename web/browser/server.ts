import Fastify from "fastify";
import { registerPlannerStatic } from "../../src/miniapp-static.js";

// Production static serving only. Browser tests intercept their own synthetic API
// and Telegram responses; this server deliberately exposes no fixture/auth routes.
const app = Fastify();
registerPlannerStatic(app);
await app.listen({ host: "127.0.0.1", port: 4173 });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close();
  });
}

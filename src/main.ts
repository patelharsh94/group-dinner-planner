import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { PgStore } from "./persistence/store.js";
import { MuseClient } from "./adapters/muse.js";
import { GoogleCalendar } from "./adapters/google.js";
import { TelegramTransport } from "./adapters/telegram.js";
import { Coordinator } from "./application/coordinator.js";
import { Worker } from "./application/worker.js";
import { googleCallback } from "./application/oauth.js";
import { createServer } from "./http.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });
const store = new PgStore(pool);
const google =
  config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
    ? new GoogleCalendar({
        clientId: config.GOOGLE_CLIENT_ID,
        clientSecret: config.GOOGLE_CLIENT_SECRET,
        redirectUri: `${config.PUBLIC_URL}/oauth/google/callback`,
      })
    : undefined;
const muse = config.MODEL_API_KEY
  ? new MuseClient({
      apiKey: config.MODEL_API_KEY,
      baseUrl: config.MUSE_BASE_URL,
      model: config.MUSE_MODEL,
    })
  : undefined;
const coordinator = new Coordinator(config, google);
const worker = new Worker(
  store,
  coordinator,
  new TelegramTransport(config.TELEGRAM_BOT_TOKEN),
  muse,
  google,
);
const app = createServer({
  store,
  config,
  oauthCallback: googleCallback(store, coordinator, google),
});
await pool.query("SELECT 1 FROM dinners LIMIT 1");
await app.listen({ port: config.PORT, host: "0.0.0.0" });
worker.start();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await worker.stop();
  await app.close();
  await pool.end();
}
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());

import { Bot } from "grammy";
import { loadConfig } from "../src/config.js";
const config = loadConfig();
await new Bot(config.TELEGRAM_BOT_TOKEN).api.setWebhook(
  `${config.PUBLIC_URL}/telegram/webhook`,
  {
    secret_token: config.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
  },
);
console.log(
  "Authenticated Telegram webhook registered. Existing pending updates were preserved.",
);

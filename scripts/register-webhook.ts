import { Bot } from "grammy";
import { loadConfig } from "../src/config.js";
const config = loadConfig();
const api = new Bot(config.TELEGRAM_BOT_TOKEN).api;
await api.setWebhook(`${config.PUBLIC_URL}/telegram/webhook`, {
  secret_token: config.TELEGRAM_WEBHOOK_SECRET,
  allowed_updates: ["message", "callback_query"],
});
await api.setChatMenuButton({
  menu_button: {
    type: "web_app",
    text: "Open planner",
    web_app: { url: `${config.PUBLIC_URL}/app/` },
  },
});
console.log(
  "Authenticated Telegram webhook and planner menu registered. Existing pending updates were preserved.",
);

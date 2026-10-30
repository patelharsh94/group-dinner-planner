import { Bot } from "grammy";
import "../src/env.js";
import { MuseClient } from "../src/adapters/muse.js";
let blocked = false;
if (process.env.TELEGRAM_BOT_TOKEN) {
  try {
    const user = await new Bot(process.env.TELEGRAM_BOT_TOKEN).api.getMe();
    console.log(JSON.stringify({ integration: "telegram", ok: user.is_bot }));
  } catch {
    console.log(JSON.stringify({ integration: "telegram", ok: false }));
    process.exitCode = 1;
  }
} else {
  console.log("Telegram: BLOCKED (TELEGRAM_BOT_TOKEN absent)");
  blocked = true;
}
if (process.env.MODEL_API_KEY) {
  try {
    const result = await new MuseClient({
      apiKey: process.env.MODEL_API_KEY,
      baseUrl: process.env.MUSE_BASE_URL,
      model: process.env.MUSE_MODEL,
    }).extract({
      message: "Tuesday may work; I have not chosen a specific date or time.",
      ownConstraints: {},
      timezone: "UTC",
      now: new Date().toISOString(),
    });
    console.log(
      JSON.stringify({
        integration: "muse-structured-output",
        ok: result.kind === "clarify",
      }),
    );
    if (result.kind !== "clarify") process.exitCode = 1;
  } catch {
    console.log(
      JSON.stringify({ integration: "muse-structured-output", ok: false }),
    );
    process.exitCode = 1;
  }
} else {
  console.log(
    "Muse structured output + live search: BLOCKED (MODEL_API_KEY absent)",
  );
  blocked = true;
}
console.log(
  "Google OAuth: interactive verification required using /calendar, /calendar_activate and /disconnect. Config presence is not a successful authorization.",
);
console.log(
  "Live search: npm run eval:muse -- --research (requires MODEL_API_KEY). No restaurant booking or calendar write is performed.",
);
if (blocked) process.exitCode = 2;

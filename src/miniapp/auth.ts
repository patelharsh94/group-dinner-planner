import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
export class MiniAppFault extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface MiniAppActor {
  id: string;
  name: string;
}
export function verifyInitData(
  raw: string,
  token: string,
  nowMs = Date.now(),
): MiniAppActor {
  const invalid = () =>
    new MiniAppFault("AUTH", 401, "Open this app from Telegram to continue.");
  if (!raw || raw.length > 16384) throw invalid();
  const params = new URLSearchParams(raw),
    seen = new Set<string>();
  for (const [key] of params) {
    if (seen.has(key)) throw invalid();
    seen.add(key);
  }
  const hash = params.get("hash");
  if (!hash || !/^[a-fA-F0-9]{64}$/.test(hash)) throw invalid();
  const check = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) throw invalid();
  const timestamp = params.get("auth_date");
  if (!timestamp || !/^\d+$/.test(timestamp)) throw invalid();
  const age = nowMs - Number(timestamp) * 1000;
  if (!Number.isFinite(age) || age > 3600000 || age < -30000) throw invalid();
  try {
    const user = z
      .object({
        id: z.number().int().safe().positive(),
        first_name: z.string().min(1).max(256),
        last_name: z.string().max(256).optional(),
        is_bot: z.literal(false).optional(),
      })
      .parse(JSON.parse(params.get("user") ?? ""));
    return {
      id: String(user.id),
      name: [user.first_name, user.last_name].filter(Boolean).join(" "),
    };
  } catch {
    throw invalid();
  }
}

import { z } from "zod";
import "./env.js";

export const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.url().refine((value) => new URL(value).protocol === "https:"),
  TELEGRAM_BOT_TOKEN: z.string().min(10),
  TELEGRAM_BOT_USERNAME: z.string().regex(/^[A-Za-z0-9_]+bot$/i),
  TELEGRAM_WEBHOOK_SECRET: z.string().regex(/^[A-Za-z0-9_-]{24,256}$/),
  CREDENTIAL_ENCRYPTION_KEY: z
    .string()
    .refine(
      (value) => Buffer.from(value, "base64").length === 32,
      "Use 32 random bytes encoded as base64",
    ),
  MODEL_API_KEY: z.string().optional(),
  API_KEY: z.string().min(32).optional(),
  MUSE_BASE_URL: z.url().default("https://api.meta.ai/v1"),
  MUSE_MODEL: z.string().default("muse-spark-1.3"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  SUPPORT_CONTACT: z.string().min(3),
  MAX_ACTIVE_DINNERS: z.coerce.number().int().positive().default(100),
  MAX_UPDATES_PER_USER_PER_DAY: z.coerce.number().int().positive().default(150),
  MAX_RESEARCH_PER_DINNER_PER_DAY: z.coerce
    .number()
    .int()
    .positive()
    .default(10),
});
export type Config = z.infer<typeof ConfigSchema>;
export function loadConfig(): Config {
  return ConfigSchema.parse(process.env);
}

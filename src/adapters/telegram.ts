import { Bot, InputFile } from "grammy";
import { z } from "zod";

export interface MessagePayload {
  chatId: string;
  text: string;
  buttons?: { text: string; callback_data: string }[][];
  document?: { filename: string; content: string };
  dinnerId?: string;
  reminder?: boolean;
  reminderDay?: string;
  reply?: boolean;
  version?: number;
}
const button = z.object({
  text: z.string().min(1).max(64),
  callback_data: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value) <= 64),
});
const payloadSchema = z
  .object({
    chatId: z.string().regex(/^[1-9]\d{0,15}$/),
    text: z.string().min(1).max(4096),
    buttons: z.array(z.array(button).min(1).max(8)).max(12).optional(),
    document: z
      .object({
        filename: z.string().regex(/^[\w .-]{1,120}\.ics$/),
        content: z
          .string()
          .min(1)
          .refine((value) => Buffer.byteLength(value) <= 1_000_000),
      })
      .optional(),
  })
  .refine(
    (value) => !value.document || value.text.length <= 1024,
    "Document captions must be at most 1024 characters",
  );
type TelegramApi = Pick<
  Bot["api"],
  "sendMessage" | "sendDocument" | "answerCallbackQuery"
>;
export class TelegramTransport {
  private readonly api: TelegramApi;
  constructor(token: string, api?: TelegramApi) {
    this.api = api ?? new Bot(token, { client: { timeoutSeconds: 20 } }).api;
  }
  async send(payload: MessagePayload): Promise<void> {
    const value = payloadSchema.parse(payload);
    const keyboard = value.buttons
      ? { reply_markup: { inline_keyboard: value.buttons } }
      : {};
    if (value.document) {
      await this.api.sendDocument(
        value.chatId,
        new InputFile(
          Buffer.from(value.document.content, "utf8"),
          value.document.filename,
        ),
        { caption: value.text, ...keyboard },
      );
    } else {
      await this.api.sendMessage(value.chatId, value.text, keyboard);
    }
  }
  async answerCallback(id: string): Promise<void> {
    z.string().min(1).max(256).parse(id);
    await this.api.answerCallbackQuery(id);
  }
}
export type DeliveryError =
  | { kind: "retry"; delayMs: number }
  | { kind: "failed" }
  | { kind: "ambiguous" };
/** Transport uncertainty must never automatically replay a potentially delivered message. */
export function deliveryError(error: unknown): DeliveryError {
  if (error instanceof z.ZodError) return { kind: "failed" };
  if (typeof error !== "object" || error === null) return { kind: "ambiguous" };
  const candidate = error as {
    error_code?: unknown;
    parameters?: { retry_after?: unknown };
  };
  const seconds = candidate.parameters?.retry_after;
  if (
    candidate.error_code === 429 &&
    typeof seconds === "number" &&
    Number.isFinite(seconds) &&
    seconds >= 0
  )
    return { kind: "retry", delayMs: Math.max(1000, seconds * 1000) };
  if ([400, 401, 403, 404].includes(candidate.error_code as number))
    return { kind: "failed" };
  return { kind: "ambiguous" };
}

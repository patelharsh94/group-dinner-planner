import { describe, expect, it, vi } from "vitest";
import {
  deliveryError,
  TelegramTransport,
} from "../../src/adapters/telegram.js";

describe("Telegram transport", () => {
  const api = () => ({
    sendMessage: vi.fn().mockResolvedValue({}),
    sendDocument: vi.fn().mockResolvedValue({}),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
  });
  it("sends private plain text and inline callbacks without formatting mode", async () => {
    const mock = api(),
      transport = new TelegramTransport("123:token", mock);
    await transport.send({
      chatId: "42",
      text: "<private>",
      buttons: [[{ text: "Confirm", callback_data: "confirm:1" }]],
    });
    expect(mock.sendMessage).toHaveBeenCalledWith("42", "<private>", {
      reply_markup: {
        inline_keyboard: [[{ text: "Confirm", callback_data: "confirm:1" }]],
      },
    });
    await transport.answerCallback("callback");
    expect(mock.answerCallbackQuery).toHaveBeenCalledWith("callback");
  });
  it("sends calendar contents as a private document", async () => {
    const mock = api();
    await new TelegramTransport("123:token", mock).send({
      chatId: "42",
      text: "Your calendar export",
      document: {
        filename: "dinner.ics",
        content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
      },
    });
    expect(mock.sendDocument).toHaveBeenCalledOnce();
    expect(mock.sendDocument.mock.calls[0][0]).toBe("42");
    expect(mock.sendDocument.mock.calls[0][1].filename).toBe("dinner.ics");
    expect(mock.sendMessage).not.toHaveBeenCalled();
  });
  it("rejects oversized or public destinations before calling Telegram", async () => {
    const mock = api(),
      transport = new TelegramTransport("123:token", mock);
    await expect(
      transport.send({ chatId: "-42", text: "private" }),
    ).rejects.toThrow();
    await expect(
      transport.send({ chatId: "42", text: "a".repeat(4097) }),
    ).rejects.toThrow();
    await expect(
      transport.send({
        chatId: "42",
        text: "ok",
        buttons: [[{ text: "x", callback_data: "💛".repeat(20) }]],
      }),
    ).rejects.toThrow();
    expect(mock.sendMessage).not.toHaveBeenCalled();
  });
  it("classifies only definite non-delivery for retry", () => {
    expect(
      deliveryError({ error_code: 429, parameters: { retry_after: 7 } }),
    ).toEqual({ kind: "retry", delayMs: 7000 });
    expect(deliveryError({ error_code: 403 })).toEqual({ kind: "failed" });
    expect(deliveryError({ error_code: 500 })).toEqual({ kind: "ambiguous" });
    expect(deliveryError(new Error("socket closed"))).toEqual({
      kind: "ambiguous",
    });
  });
});

it("UI-01 sends HTTPS Mini App buttons and rejects insecure launch URLs", async () => {
  const sendMessage = vi.fn().mockResolvedValue({});
  const api = {
    sendMessage,
    sendDocument: vi.fn(),
    answerCallbackQuery: vi.fn(),
  } as any;
  const transport = new TelegramTransport("fixture-token", api);
  await transport.send({
    chatId: "42",
    text: "Open your planner",
    buttons: [
      [
        {
          text: "Open planner",
          web_app: { url: "https://planner.example/app/?dinner=abc" },
        },
      ],
    ],
  });
  expect(
    sendMessage.mock.calls[0][2].reply_markup.inline_keyboard[0][0],
  ).toEqual({
    text: "Open planner",
    web_app: { url: "https://planner.example/app/?dinner=abc" },
  });
  await expect(
    transport.send({
      chatId: "42",
      text: "Open",
      buttons: [
        [{ text: "Open", web_app: { url: "http://planner.example/app/" } }],
      ],
    }),
  ).rejects.toThrow();
});

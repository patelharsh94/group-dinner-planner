import { z } from "zod";
import type { PgStore } from "../persistence/store.js";
import type { GoogleCalendar } from "../adapters/google.js";
import { encrypt, tokenHash } from "../adapters/security.js";
import { authorized, type AppDinner } from "./model.js";
import type { Coordinator } from "./coordinator.js";

export function googleCallback(
  store: PgStore,
  coordinator: Coordinator,
  google?: GoogleCalendar,
) {
  return async (query: unknown): Promise<{ status: number; text: string }> => {
    const parsed = z
      .object({
        state: z.string().min(20).max(200),
        code: z.string().max(4096).optional(),
        error: z.string().optional(),
      })
      .safeParse(query);
    if (!google || !parsed.success)
      return {
        status: 400,
        text: "Calendar access unavailable. Return to the bot; manual availability works.",
      };
    const data = parsed.data;
    const binding = await store.transaction(async (tx) => {
      const pending = await tx.getOAuthState(tokenHash(data.state));
      if (!pending) return null;
      const record = await tx.getDinner<AppDinner>(pending.dinnerId);
      if (
        !record ||
        record.endedAt ||
        !authorized(record.state, pending.userId)
      )
        return null;
      const consumed = await tx.consumeOAuthState(
        tokenHash(data.state),
        pending.userId,
      );
      if (!consumed) return null;
      const marker = encrypt(
        { authorizing: tokenHash(data.state) },
        coordinator.config.CREDENTIAL_ENCRYPTION_KEY,
        `${pending.dinnerId}:${pending.userId}`,
      );
      const previous = await tx.getCalendarConnection(
        pending.dinnerId,
        pending.userId,
      );
      if (previous)
        await tx.queue({
          id: `revoke-${tokenHash(data.state)}`,
          dedupeKey: `revoke-${tokenHash(data.state)}`,
          kind: "revoke",
          subjectUserId: pending.userId,
          payload: {
            encrypted: previous,
            context: `${pending.dinnerId}:${pending.userId}`,
          },
        });
      await tx.setCalendarConnection(pending.dinnerId, pending.userId, marker);
      return { ...consumed, marker };
    });
    if (!binding)
      return {
        status: 400,
        text: "Authorization link expired or was already used. Request a new one in Telegram.",
      };
    if (data.error || !data.code) {
      await store.transaction(async (tx) => {
        if (
          (await tx.getCalendarConnection(binding.dinnerId, binding.userId)) ===
          binding.marker
        )
          await tx.disconnectCalendar(binding.dinnerId, binding.userId);
      });
      return {
        status: 200,
        text: "Calendar access was not authorized. Return to the bot and enter availability manually.",
      };
    }
    try {
      const tokens = await google.exchange(data.code);
      const saved = await store.transaction(async (tx) => {
        const record = await tx.getDinner<AppDinner>(binding.dinnerId);
        if (
          !record ||
          record.endedAt ||
          !authorized(record.state, binding.userId) ||
          (await tx.getCalendarConnection(binding.dinnerId, binding.userId)) !==
            binding.marker
        )
          return false;
        await tx.setCalendarConnection(
          binding.dinnerId,
          binding.userId,
          encrypt(
            { ...tokens, active: false },
            coordinator.config.CREDENTIAL_ENCRYPTION_KEY,
            `${binding.dinnerId}:${binding.userId}`,
          ),
        );
        await coordinator.message(
          tx,
          `oauth:${tokenHash(data.state)}`,
          binding.userId,
          "Google credentials are staged. If you just authorized your own Google account, send /calendar_activate in this dinner. Otherwise /disconnect. No calendar data has been read yet.",
          { dinnerId: binding.dinnerId },
        );
        return true;
      });
      if (!saved) {
        await google.revoke(tokens).catch(() => {});
        return {
          status: 400,
          text: "Authorization was canceled or superseded. Credentials were not saved. Return to Telegram.",
        };
      }
      return {
        status: 200,
        text: "Return to the same private Telegram chat and send /calendar_activate to activate your own account. No calendar data has been read yet.",
      };
    } catch {
      await store.transaction(async (tx) => {
        if (
          (await tx.getCalendarConnection(binding.dinnerId, binding.userId)) ===
          binding.marker
        )
          await tx.disconnectCalendar(binding.dinnerId, binding.userId);
      });
      return {
        status: 400,
        text: "Google authorization could not be completed. Return to the bot; manual availability remains usable.",
      };
    }
  };
}

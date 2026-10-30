import { z } from "zod";
import { IntervalSchema, type Interval } from "../domain/index.js";

export const TokensSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_at: z.number(),
  active: z.boolean().default(false),
});
export type Tokens = z.infer<typeof TokensSchema>;
export class CalendarUnavailable extends Error {}
type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetcher?: typeof fetch;
};
export class GoogleCalendar {
  private fetcher: typeof fetch;
  constructor(private config: GoogleConfig) {
    this.fetcher = config.fetcher ?? fetch;
  }
  authorizationUrl(state: string): string {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/calendar.freebusy",
      access_type: "offline",
      prompt: "consent",
      state,
    }).toString();
    return url.toString();
  }
  private async token(
    params: Record<string, string>,
    previous?: Tokens,
  ): Promise<Tokens> {
    const response = await this.fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...params,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
    });
    if (!response.ok)
      throw new CalendarUnavailable(
        "Calendar authorization unavailable; use manual availability.",
      );
    const body = z
      .object({
        access_token: z.string(),
        refresh_token: z.string().optional(),
        expires_in: z.number().positive(),
      })
      .parse(await response.json());
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token ?? previous?.refresh_token,
      expires_at: Date.now() + body.expires_in * 1000,
      active: previous?.active ?? false,
    };
  }
  exchange(code: string): Promise<Tokens> {
    return this.token({
      code,
      grant_type: "authorization_code",
      redirect_uri: this.config.redirectUri,
    });
  }
  async freeBusy(
    input: Tokens,
    start: string,
    end: string,
  ): Promise<{ tokens: Tokens; busy: Interval[] }> {
    if (!input.active)
      throw new CalendarUnavailable(
        "Activate the connection in Telegram first.",
      );
    let tokens = input;
    if (tokens.expires_at < Date.now() + 60000) {
      if (!tokens.refresh_token)
        throw new CalendarUnavailable("Calendar authorization expired.");
      tokens = await this.token(
        { refresh_token: tokens.refresh_token, grant_type: "refresh_token" },
        tokens,
      );
    }
    const response = await this.fetcher(
      "https://www.googleapis.com/calendar/v3/freeBusy",
      {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          timeMin: start,
          timeMax: end,
          items: [{ id: "primary" }],
        }),
      },
    );
    if (!response.ok)
      throw new CalendarUnavailable(
        "Calendar access unavailable; reconnect or use manual availability.",
      );
    const body = z
      .object({
        calendars: z.object({
          primary: z.object({
            busy: z.array(IntervalSchema),
            errors: z.array(z.unknown()).optional(),
          }),
        }),
      })
      .parse(await response.json());
    if (body.calendars.primary.errors?.length)
      throw new CalendarUnavailable("Primary calendar unavailable.");
    return { tokens, busy: body.calendars.primary.busy };
  }
  async revoke(tokens: Tokens): Promise<void> {
    const response = await this.fetcher(
      "https://oauth2.googleapis.com/revoke",
      {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: tokens.refresh_token ?? tokens.access_token,
        }),
      },
    );
    if (!response.ok && response.status !== 400)
      throw new CalendarUnavailable(
        "Could not verify Google revocation. Local credentials removed; revoke app access in your Google account.",
      );
  }
}

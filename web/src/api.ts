import type {
  BootstrapResponse,
  DinnerView,
  MutationEnvelope,
  MutationResponse,
} from "../../src/miniapp/contracts";

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
const messages: Record<string, string> = {
  ACTIVE_DINNER:
    "You already organize an active dinner. Return home to continue that dinner.",
  FULL: "This dinner has no places left. Please check with the organizer.",
  INCOMPLETE:
    "A few responses or membership approvals are still needed. Check the dinner progress before trying again.",
  DATE: "Please check the dates and times in this form.",
  VALIDATION:
    "Please check the form. Dates, availability and food requirements must be explicit.",
  LIMIT:
    "A planning limit has been reached. Please wait before trying again or check with the organizer.",
  MEMBERSHIP:
    "Your dinner membership or consent needs attention. Reopen your invitation or check with the organizer.",
  ENDED: "This dinner has already begun and its plan can no longer be changed.",
  STALE:
    "This dinner changed while you were editing. Your answers are still here. Return to the dinner, review the update, then edit again.",
  FORM_STALE:
    "This dinner changed while you were editing. Your answers are still here. Return to the dinner and review the update.",
  STALE_FORM:
    "This dinner changed while you were editing. Your answers are still here. Return to the dinner and review the update.",
  BOT_START_REQUIRED:
    "Open the Telegram bot and send /start before using Muse.",
  AUTH: "Your Telegram session expired. Close and reopen this Mini App from the bot.",
  CONFLICT:
    "Someone just updated this dinner. Refresh the dinner and try again.",
  FEASIBILITY:
    "A few details still need checking before this plan can be confirmed.",
  AUTHORIZATION: "You do not have permission for this action.",
  UNAUTHORIZED: "Please reopen this Mini App from Telegram to continue.",
  AUTH_EXPIRED: "Your Telegram session expired. Close and reopen the Mini App.",
  DISPUTE:
    "An open change request needs to be resolved before everyone can confirm.",
  ESCALATED:
    "The organizer needs to review this dinner before planning can continue.",
  STARTED: "This dinner has already begun. Its plan can no longer be changed.",
  CAPACITY:
    "This invitation has no places left. Please check with the organizer.",
  INVITATION:
    "This invitation is no longer available. Ask the organizer for a new one.",
  RATE_LIMIT: "Please wait a moment before trying again.",
  INVALID_INPUT: "Please check your answers and try again.",
};

export function friendlyError(error: unknown): string {
  if (error instanceof ApiError)
    return (
      messages[error.code] ??
      (error.status === 401
        ? messages.UNAUTHORIZED
        : error.status === 429
          ? messages.RATE_LIMIT
          : "We could not finish that just now. Your answers are safe here. Please try again.")
    );
  return "Could not reach Muse. Check your connection and try again.";
}
export class MiniAppApi {
  private readonly pending = new Map<
    string,
    { envelope: MutationEnvelope; attempt?: Promise<MutationResponse> }
  >();
  constructor(private readonly initData: string) {}
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
        Authorization: `tma ${this.initData}`,
      },
      cache: "no-store",
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new ApiError(
        body.error?.code ?? "REQUEST_FAILED",
        "Request failed",
        response.status,
      );
    }
    return response.json() as Promise<T>;
  }
  bootstrap(invite?: string): Promise<BootstrapResponse> {
    return this.request(
      `/api/miniapp/bootstrap${invite ? `?invite=${encodeURIComponent(invite)}` : ""}`,
    );
  }
  dinner(id: string): Promise<DinnerView> {
    return this.request(`/api/miniapp/dinners/${encodeURIComponent(id)}`);
  }
  action(
    input: Omit<MutationEnvelope, "requestId">,
  ): Promise<MutationResponse> {
    const key = JSON.stringify(input);
    let intent = this.pending.get(key);
    if (intent?.attempt) return intent.attempt;
    if (!intent) {
      intent = { envelope: { ...input, requestId: crypto.randomUUID() } };
      this.pending.set(key, intent);
    }
    const current = intent;
    current.attempt = this.request<MutationResponse>("/api/miniapp/actions", {
      method: "POST",
      body: JSON.stringify(current.envelope),
    })
      .then((result) => {
        this.pending.delete(key);
        return result;
      })
      .catch((error) => {
        if (
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500
        )
          this.pending.delete(key);
        throw error;
      })
      .finally(() => {
        current.attempt = undefined;
      });
    return current.attempt;
  }
  async calendar(id: string): Promise<Blob> {
    const response = await fetch(
      `/api/miniapp/dinners/${encodeURIComponent(id)}/calendar`,
      { headers: { Authorization: `tma ${this.initData}` }, cache: "no-store" },
    );
    if (!response.ok)
      throw new ApiError(
        "CALENDAR_EXPORT",
        "Calendar export unavailable",
        response.status,
      );
    return response.blob();
  }
}

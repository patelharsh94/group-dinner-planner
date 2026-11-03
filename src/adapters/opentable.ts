/** Consumer API v2 only. Wire contract: https://docs.opentable.com/ (checked 2026-11-02).
 * Partner production approval is external. No scraping, payments or invented lookup endpoints.
 */
import { z } from "zod";
export interface ReservationSlot {
  restaurantId: string;
  localDateTime: string;
  partySize: number;
}
export const BookingContactSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    email: z.email().max(254),
    phone: z.string().regex(/^\+?[0-9 ()-]{5,25}$/),
    countryCode: z.string().regex(/^[A-Z]{2}$/),
  })
  .strict();
export type BookingContact = z.infer<typeof BookingContactSchema>;
export type AvailabilityResult = {
  status: "ready" | "handoff_required" | "unavailable";
  message: string;
};
export type BookingResult = {
  status: "booked" | "unknown" | "failed" | "handoff_required";
  message: string;
  reference?: string;
};
export interface ReservationProvider {
  capability(): { available: boolean; provider: string; message: string };
  availability(slot: ReservationSlot): Promise<AvailabilityResult>;
  create(
    slot: ReservationSlot,
    contact: BookingContact,
    requestId: string,
    authorize?: () => Promise<boolean>,
  ): Promise<BookingResult>;
  lookup(restaurantId: string, reference: string): Promise<BookingResult>;
}
export interface OpenTableOptions {
  enabled?: boolean;
  approved?: boolean;
  clientId?: string;
  clientSecret?: string;
  baseUrl?: string;
  oauthUrl?: string;
}
const object = z.record(z.string(), z.unknown());
export class OpenTableProvider implements ReservationProvider {
  constructor(
    private options: OpenTableOptions = {},
    private fetcher: typeof fetch = fetch,
  ) {}
  capability() {
    const available = !!(
      this.options.enabled &&
      this.options.approved &&
      this.options.clientId &&
      this.options.clientSecret &&
      this.options.baseUrl
    );
    return {
      available,
      provider: "opentable",
      message: available
        ? "Approved OpenTable Consumer API v2"
        : "Automatic booking requires approved OpenTable Consumer API v2 production access.",
    };
  }
  private async request(
    path: string,
    method = "GET",
    body?: unknown,
    requestId?: string,
    authorize?: () => Promise<boolean>,
  ) {
    const oauth = this.options.oauthUrl ?? "https://oauth.opentable.com";
    const auth = await this.fetcher(
      `${oauth}/api/v2/oauth/token?grant_type=client_credentials`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString("base64")}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      },
    );
    if (!auth.ok) throw new Error("Provider authorization unavailable");
    const token = z
      .object({ access_token: z.string().min(1) })
      .parse(await auth.json()).access_token;
    if (authorize && !(await authorize()))
      throw new Error("Booking authorization changed");
    const response = await this.fetcher(`${this.options.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(requestId ? { "X-Request-Id": requestId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Provider request failed");
    return object.parse(await response.json());
  }
  async availability(slot: ReservationSlot): Promise<AvailabilityResult> {
    if (!this.capability().available)
      return { status: "handoff_required", message: this.capability().message };
    try {
      const q = new URLSearchParams({
        start_date_time: slot.localDateTime,
        party_size: String(slot.partySize),
        forward_minutes: "0",
        backward_minutes: "0",
        include_experiences: "false",
        include_credit_card_results: "false",
      });
      const raw = await this.request(
        `/v2/availability/${encodeURIComponent(slot.restaurantId)}?${q}`,
      );
      const data = object.parse(raw.data ?? raw);
      const times = z.array(object).parse(data.times_available);
      const matching = times.find(
        (t) =>
          t.time === slot.localDateTime ||
          t.time === `${slot.localDateTime}:00`,
      );
      if (!matching)
        return {
          status: "unavailable",
          message:
            "The exact confirmed time is unavailable. Choose another plan.",
        };
      const types = z.array(object).parse(matching.availability_types);
      const standard = types.find((t) => t.type === "Standard");
      if (
        !standard ||
        standard.cancellation_policy ||
        (Array.isArray(standard.experience_cancellation_policies) &&
          standard.experience_cancellation_policies.length > 0) ||
        standard.payment ||
        standard.fees
      )
        return {
          status: "handoff_required",
          message:
            "This slot has payment, policy, or fee requirements that need direct review with the restaurant.",
        };
      // Absence of cancellation policy for Standard inventory denotes ordinary no-card availability.
      return {
        status: "ready",
        message:
          "Standard reservation available; no deposit, card guarantee or cancellation charge shown. Availability will be checked again before booking.",
      };
    } catch {
      return {
        status: "handoff_required",
        message:
          "Availability or fee requirements could not be verified. Contact the restaurant directly.",
      };
    }
  }
  async create(
    slot: ReservationSlot,
    contact: BookingContact,
    requestId: string,
    authorize?: () => Promise<boolean>,
  ): Promise<BookingResult> {
    if (!this.capability().available)
      return { status: "handoff_required", message: this.capability().message };
    const valid = BookingContactSchema.parse(contact);
    const availability = await this.availability(slot);
    if (availability.status !== "ready")
      return {
        status:
          availability.status === "unavailable" ? "failed" : "handoff_required",
        message: availability.message,
      };
    let lockToken: string | undefined;
    try {
      const lock = await this.request(
        `/v2/booking/${encodeURIComponent(slot.restaurantId)}/slot_locks`,
        "POST",
        {
          party_size: slot.partySize,
          date_time: slot.localDateTime,
          reservation_attribute: "default",
        },
        `${requestId}-lock`,
      );
      const data = object.parse(lock.data ?? lock);
      lockToken = z.string().min(1).parse(data.reservation_token);
      if (
        data.payment_method ||
        data.cancellation_policy ||
        data.fees ||
        !data.expires_at ||
        !Number.isFinite(Date.parse(String(data.expires_at))) ||
        Date.parse(String(data.expires_at)) <= Date.now()
      ) {
        await this.request(
          `/v2/booking/${encodeURIComponent(slot.restaurantId)}/slot_locks/${encodeURIComponent(lockToken)}`,
          "DELETE",
          undefined,
          `${requestId}-release`,
        ).catch(() => undefined);
        return {
          status: "handoff_required",
          message:
            "Payment, fees or slot terms require direct restaurant review. No reservation created.",
        };
      }
      if (authorize && !(await authorize())) {
        await this.request(
          `/v2/booking/${encodeURIComponent(slot.restaurantId)}/slot_locks/${encodeURIComponent(lockToken)}`,
          "DELETE",
          undefined,
          `${requestId}-release`,
        ).catch(() => undefined);
        return {
          status: "failed",
          message: "Booking authorization changed. No reservation submitted.",
        };
      }
      const raw = await this.request(
        `/v2/booking/${encodeURIComponent(slot.restaurantId)}/reservations`,
        "POST",
        {
          reservation_token: lockToken,
          first_name: valid.firstName,
          last_name: valid.lastName,
          email_address: valid.email,
          phone: {
            number: valid.phone,
            country_code: valid.countryCode,
            phone_type: "mobile",
          },
          reservation_attribute: "default",
          restaurant_email_marketing_opt_in: false,
          opentable_marketing_opt_in: false,
          sms_notifications_opt_in: false,
        },
        requestId,
        authorize,
      );
      const result = object.parse(raw.data ?? raw);
      if (
        z.number().int().positive().safeParse(result.confirmation_number)
          .success &&
        result.party_size === slot.partySize &&
        typeof result.date_time === "string" &&
        result.date_time.slice(0, 16) === slot.localDateTime &&
        !result.payment &&
        (result.post_booking_required_action === undefined ||
          result.post_booking_required_action === "None")
      )
        return {
          status: "booked",
          reference: String(result.confirmation_number),
          message: "OpenTable confirmed this reservation.",
        };
      return {
        status: "unknown",
        message:
          "OpenTable did not return a final no-payment confirmation. Check directly before attempting another booking.",
      };
    } catch {
      return {
        status: "unknown",
        message:
          "Booking outcome is unknown. Do not book again; check with OpenTable or the restaurant.",
      };
    }
  }
  async lookup(
    _restaurantId: string,
    _reference: string,
  ): Promise<BookingResult> {
    return {
      status: "unknown",
      message:
        "Consumer API v2 lookup contract is not published in the available official documentation. Check the provider or restaurant directly; no automatic retry is allowed.",
    };
  }
}

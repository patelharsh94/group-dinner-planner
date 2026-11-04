/** Yelp Partner Reservations API, checked 2026-11-03.
 * https://docs.developer.yelp.com/docs/reservation
 * https://docs.developer.yelp.com/reference/v3_openings
 * https://docs.developer.yelp.com/reference/v3_holds
 * https://docs.developer.yelp.com/reference/v3_reservations
 * https://docs.developer.yelp.com/reference/v3_reservation_status
 * No retries: unique_id identifies a user and is NOT a documented idempotency key.
 */
import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  BookingContactSchema,
  type AvailabilityResult,
  type BookingContact,
  type BookingResult,
  type ReservationProvider,
  type ReservationSlot,
} from "./opentable.js";

export interface YelpReservationOptions {
  enabled?: boolean;
  approved?: boolean;
  apiKey?: string;
}
const record = z.record(z.string(), z.unknown());
function parts(slot: ReservationSlot) {
  if (
    !slot.restaurantId.trim() ||
    !Number.isInteger(slot.partySize) ||
    slot.partySize < 1 ||
    slot.partySize > 10 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(slot.localDateTime)
  )
    return undefined;
  // Parse strictly as a calendar value. Never convert the restaurant's wall time to UTC.
  if (!DateTime.fromISO(slot.localDateTime, { zone: "UTC" }).isValid)
    return undefined;
  return {
    date: slot.localDateTime.slice(0, 10),
    time: slot.localDateTime.slice(11),
    covers: String(slot.partySize),
  };
}
function requiresReview(data: Record<string, unknown>) {
  return !!(
    data.cancellation_policy ||
    data.last_cancellation_date ||
    data.fees ||
    data.payment ||
    data.deposit ||
    data.credit_card_required
  );
}
const unknown: BookingResult = {
  status: "unknown",
  message:
    "Yelp booking outcome is unknown. Do not book again; check Yelp or the restaurant directly.",
};
const review: BookingResult = {
  status: "handoff_required",
  message:
    "Payment, policy, fee or hold requirements could not be verified. Review directly with the restaurant. No reservation submitted.",
};

export class YelpReservationProvider implements ReservationProvider {
  constructor(
    private options: YelpReservationOptions = {},
    private fetcher: typeof fetch = fetch,
  ) {}
  capability() {
    const available = !!(
      this.options.enabled &&
      this.options.approved &&
      this.options.apiKey?.trim()
    );
    return {
      available,
      provider: "yelp",
      message: available
        ? "Approved Yelp Partner Reservations API"
        : "Automatic Yelp booking requires explicitly enabled, approved Yelp Partner Reservations API access. A discovery API key alone does not grant booking access.",
    };
  }
  private async request(path: string, body?: URLSearchParams) {
    const response = await this.fetcher(
      `https://api.yelp.com/v3/bookings/${path}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          Accept: "application/json",
          ...(body
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
        },
        ...(body ? { body: body.toString() } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
    // Do not interpret even an HTTP error after POST as permission to retry.
    if (!response.ok) throw new Error("Yelp request could not be verified");
    return record.parse(await response.json());
  }
  async availability(slot: ReservationSlot): Promise<AvailabilityResult> {
    if (!this.capability().available)
      return { status: "handoff_required", message: this.capability().message };
    const value = parts(slot);
    if (!value)
      return {
        status: "handoff_required",
        message:
          "Yelp requires a valid restaurant, local date and time, and party size from 1 to 10.",
      };
    try {
      const result = await this.request(
        `${encodeURIComponent(slot.restaurantId)}/openings?${new URLSearchParams(value)}`,
      );
      const days = z
        .array(z.object({ date: z.string(), times: z.array(record) }))
        .parse(result.reservation_times);
      const exact = days
        .filter((day) => day.date === value.date)
        .flatMap((day) => day.times)
        .find((time) => time.time === value.time);
      if (!exact)
        return {
          status: "unavailable",
          message:
            "The exact agreed date and time is unavailable. Choose another plan.",
        };
      if (exact.credit_card_required !== false || requiresReview(exact))
        return { status: "handoff_required", message: review.message };
      return {
        status: "ready",
        message:
          "The exact Yelp opening is available without a credit card. Hold terms will be checked before booking.",
      };
    } catch {
      return {
        status: "handoff_required",
        message:
          "Yelp availability could not be verified. Review directly with the restaurant.",
      };
    }
  }
  async create(
    slot: ReservationSlot,
    contact: BookingContact,
    _requestId: string,
    authorize?: () => Promise<boolean>,
  ): Promise<BookingResult> {
    if (!this.capability().available)
      return { status: "handoff_required", message: this.capability().message };
    const validContact = BookingContactSchema.safeParse(contact);
    const value = parts(slot);
    if (!validContact.success || !value)
      return {
        status: "failed",
        message:
          "Valid booking contact and restaurant local date, time and party size are required.",
      };
    const available = await this.availability(slot);
    if (available.status !== "ready")
      return {
        status:
          available.status === "unavailable" ? "failed" : "handoff_required",
        message: available.message,
      };
    // Yelp requires the same user/device identity across Holds requests. This hash
    // avoids transmitting the email in that field; it does not make POST retries safe.
    const unique_id = createHash("sha256")
      .update(validContact.data.email.trim().toLowerCase())
      .digest("hex");
    const canceled: BookingResult = {
      status: "failed",
      message:
        "Booking authorization changed or is missing. No reservation submitted.",
    };
    let posted = false;
    try {
      if (!authorize || !(await authorize())) return canceled;
      const holdStarted = Date.now();
      posted = true;
      const held = await this.request(
        `${encodeURIComponent(slot.restaurantId)}/holds`,
        new URLSearchParams({ ...value, unique_id }),
      );
      const holdId = z
        .string()
        .regex(/^[\w-]{22}$/)
        .safeParse(held.hold_id);
      const expiry = z.number().finite().safeParse(held.expires_at);
      // Holds expire automatically after five minutes; Yelp publishes no release
      // endpoint. Never create another hold to release or replace this one.
      const validUntil = expiry.success
        ? Math.min(expiry.data * 1000, holdStarted + 300000)
        : 0;
      if (
        !holdId.success ||
        held.credit_card_hold !== false ||
        requiresReview(held) ||
        validUntil <= Date.now()
      )
        return review;
      if (!(await authorize())) return canceled;
      // Authorization can wait on storage, so expiry must be checked afterward.
      if (validUntil <= Date.now()) return review;
      const reservation = await this.request(
        `${encodeURIComponent(slot.restaurantId)}/reservations`,
        new URLSearchParams({
          ...value,
          unique_id,
          hold_id: holdId.data,
          first_name: validContact.data.firstName,
          last_name: validContact.data.lastName,
          email: validContact.data.email,
          phone: validContact.data.phone,
        }),
      );
      const reference = z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,200}$/)
        .safeParse(reservation.reservation_id);
      if (!reference.success || requiresReview(reservation)) return unknown;
      return {
        status: "booked",
        reference: reference.data,
        message: "Yelp confirmed this reservation.",
      };
    } catch {
      return posted ? unknown : canceled;
    }
  }
  async lookup(
    restaurantId: string,
    reference: string,
    slot?: ReservationSlot,
  ): Promise<BookingResult> {
    if (!this.capability().available)
      return { status: "handoff_required", message: this.capability().message };
    // Current official status reference requires covers, unlike older deprecated
    // docs. Do not invent that value when the common provider contract omits it.
    const value =
      slot && slot.restaurantId === restaurantId ? parts(slot) : undefined;
    if (!value || !/^[A-Za-z0-9_-]{1,200}$/.test(reference))
      return {
        status: "unknown",
        message:
          "Yelp status needs the original reservation date, local time and party size. Check directly; do not retry booking.",
      };
    try {
      const result = await this.request(
        `reservation/${encodeURIComponent(reference)}/status?${new URLSearchParams({ covers: value.covers })}`,
      );
      if (result.active === false)
        return {
          status: "failed",
          message: "Yelp reports this reservation is no longer active.",
        };
      if (
        result.active === true &&
        result.date === value.date &&
        result.time === `${value.time}:00` &&
        result.covers === slot!.partySize
      )
        return {
          status: "booked",
          reference,
          message: "Yelp reports the agreed reservation is active.",
        };
      return unknown;
    } catch {
      return unknown;
    }
  }
}

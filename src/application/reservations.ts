import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  DomainError,
  evaluateFeasibility,
  PublicUrlSchema,
} from "../domain/index.js";
import { activeOption, organizer, type AppDinner } from "./model.js";
import { encrypt, decrypt } from "../adapters/security.js";
import {
  BookingContactSchema,
  type ReservationProvider,
  type ReservationSlot,
} from "../adapters/opentable.js";
import {
  DinnerTx,
  type DinnerRecord,
  type ClaimedWork,
  PgStore,
} from "../persistence/store.js";
import { getReservation } from "../persistence/reservations.js";
export { getReservation } from "../persistence/reservations.js";
export interface ReservationReview {
  reviewId: string;
  version: number;
  status: "checking" | "ready" | "handoff_required" | "action_needed";
  message: string;
  bookingUrl?: string;
  phone?: string;
  searchUrl?: string;
  provider?: string;
  expiresAt?: string;
  requiredContactFields?: string[];
}
export interface ReservationAttempt {
  id: string;
  version: number;
  status:
    | "queued"
    | "submitting"
    | "booked"
    | "unknown"
    | "failed"
    | "organizer_reported"
    | "superseded";
  message: string;
  reference?: string;
  provider?: string;
  createdAt: string;
}
export interface ReservationProjection {
  review?: ReservationReview;
  attempt?: ReservationAttempt;
  mismatch: boolean;
}
const versionSchema = z.object({ version: z.number().int().positive() });
function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}
function assertPlan(
  record: DinnerRecord<AppDinner>,
  actorId: string,
  version: number,
  now: string,
  requireVerified = true,
) {
  const s = record.state,
    d = s.dinner;
  if (!organizer(s, actorId))
    fail("FORBIDDEN", "Only the organizer can manage a reservation.");
  if (record.endedAt || d.status === "cancelled")
    fail("ENDED", "This dinner has ended.");
  if (d.activeVersion !== version)
    fail("STALE", "Review the current proposal version.");
  const option = activeOption(d);
  if (!option) fail("PLAN_REQUIRED", "A current plan is required.");
  if (
    d.disputes.some((x) => x.open) ||
    d.members.some(
      (m) => !s.consents[m.id]?.active || d.confirmations[m.id] !== version,
    ) ||
    (requireVerified &&
      evaluateFeasibility(d, option, now).status !== "feasible")
  )
    fail(
      "NOT_READY",
      "Every attendee must confirm the current verified plan before booking.",
    );
  return option;
}
function fallback(record: DinnerRecord<AppDinner>) {
  const option = activeOption(record.state.dinner),
    proposal = record.state.dinner.proposals.find(
      (p) => p.version === record.state.dinner.activeVersion,
    ),
    venue = proposal?.venues.find((v) => v.id === option?.venueId);
  const evidence =
    record.state.dinner.venues.find((v) => v.id === option?.venueId)?.evidence
      .reservation ?? venue?.evidence.reservation;
  const known = evidence?.status === "known";
  // Only independently verified evidence is allowed; arbitrary model reservation URLs never become booking links.
  const bookingUrl =
    known && PublicUrlSchema.safeParse(evidence.url).success
      ? evidence.url
      : undefined;
  const phone =
    known && (evidence as typeof evidence & { phone?: string })?.phone;
  return { bookingUrl, phone, venue };
}
export class ReservationService {
  constructor(
    private store: PgStore,
    private provider: ReservationProvider,
    private encryptionKey: string,
    private restaurantIds: Record<string, string> = {},
    private clock = () => new Date().toISOString(),
  ) {}
  private async unblocked(tx: DinnerTx, id: string) {
    const r = await tx.client.query(
      "SELECT id FROM reservation_attempts WHERE dinner_id=$1 AND attempt->>'status' IN ('queued','submitting','booked','unknown','organizer_reported') LIMIT 1",
      [id],
    );
    if (r.rowCount)
      fail(
        "RESERVATION_EXISTS",
        "An existing or unresolved reservation must be checked directly before another booking. Existing reservations are unchanged.",
      );
  }
  async review(
    tx: DinnerTx,
    record: DinnerRecord<AppDinner>,
    actorId: string,
    input: { version: number },
    now = this.clock(),
  ): Promise<ReservationReview> {
    const { version } = versionSchema.parse(input),
      option = assertPlan(record, actorId, version, now, false);
    await this.unblocked(tx, record.id);
    const { bookingUrl, phone, venue } = fallback(record),
      capability = this.provider.capability();
    const selectedVenue =
      record.state.dinner.venues.find(
        (candidate) => candidate.id === option.venueId,
      ) ?? venue;
    const restaurantId =
      capability.provider === "yelp"
        ? selectedVenue?.directoryBusinessId
        : bookingUrl
          ? this.restaurantIds[bookingUrl]
          : undefined;
    const slot: ReservationSlot | undefined =
      restaurantId &&
      (capability.provider === "yelp" || /^\d+$/.test(restaurantId))
        ? {
            restaurantId,
            partySize: record.state.dinner.members.length,
            localDateTime: DateTime.fromISO(option.start)
              .setZone(record.state.dinner.setup.timezone)
              .toFormat("yyyy-MM-dd'T'HH:mm"),
          }
        : undefined;
    const review: ReservationReview = {
      reviewId: randomUUID(),
      version,
      status: capability.available && slot ? "checking" : "handoff_required",
      message:
        capability.available && slot
          ? "Checking current availability and fee requirements."
          : bookingUrl
            ? "Open the verified reservation page, book the exact confirmed time and party size, then report the result."
            : phone
              ? "Call the verified restaurant number, request the confirmed time and party size, then report the result."
              : "Muse could not verify a booking page or phone number. Use Find restaurant contact below, then ask the restaurant to confirm your selected date, time, party size and any outstanding requirements.",
      ...(bookingUrl ? { bookingUrl } : {}),
      ...(phone ? { phone } : {}),
      ...(!bookingUrl && !phone && venue
        ? {
            searchUrl: `https://www.google.com/search?q=${encodeURIComponent(`${venue.name} ${venue.address} official reservations phone`)}`,
          }
        : {}),
      provider: capability.provider,
    };
    await tx.client.query(
      "INSERT INTO reservation_reviews(id,dinner_id,version,created_at,review,slot) VALUES($1,$2,$3,$4,$5,$6)",
      [
        review.reviewId,
        record.id,
        version,
        now,
        JSON.stringify(review),
        slot ? JSON.stringify(slot) : null,
      ],
    );
    if (review.status === "checking")
      await tx.queue({
        id: review.reviewId,
        dedupeKey: `reservation-review:${review.reviewId}`,
        kind: "reservation",
        dinnerId: record.id,
        payload: {
          operation: "review",
          reviewId: review.reviewId,
          dinnerId: record.id,
        },
      });
    return review;
  }
  async book(
    tx: DinnerTx,
    record: DinnerRecord<AppDinner>,
    actorId: string,
    input: {
      version: number;
      reviewId: string;
      consent: true;
      contact: unknown;
    },
    now = this.clock(),
  ): Promise<ReservationAttempt> {
    const value = z
      .object({
        version: z.number().int().positive(),
        reviewId: z.string().uuid(),
        consent: z.literal(true),
        contact: BookingContactSchema,
      })
      .strict()
      .parse(input);
    assertPlan(record, actorId, value.version, now);
    await this.unblocked(tx, record.id);
    const r = await tx.client.query(
        "SELECT review,slot FROM reservation_reviews WHERE id=$1 AND dinner_id=$2 AND version=$3 FOR UPDATE",
        [value.reviewId, record.id, value.version],
      ),
      review = r.rows[0]?.review as ReservationReview | undefined;
    if (
      !review ||
      review.provider !== this.provider.capability().provider ||
      review.status !== "ready" ||
      !review.expiresAt ||
      Date.parse(review.expiresAt) <= Date.parse(now) ||
      !r.rows[0].slot ||
      !this.provider.capability().available
    )
      fail(
        "REVIEW_REQUIRED",
        "Review current availability and booking terms again.",
      );
    const attempt: ReservationAttempt = {
      id: randomUUID(),
      version: value.version,
      status: "queued",
      message: "Booking authorized. Waiting for provider confirmation.",
      provider: this.provider.capability().provider,
      createdAt: now,
    };
    await tx.client.query(
      "INSERT INTO reservation_attempts(id,dinner_id,version,user_id,created_at,attempt,encrypted_contact,slot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        attempt.id,
        record.id,
        value.version,
        actorId,
        now,
        JSON.stringify(attempt),
        encrypt(
          value.contact,
          this.encryptionKey,
          `reservation:${record.id}:${attempt.id}`,
        ),
        JSON.stringify(r.rows[0].slot),
      ],
    );
    await tx.queue({
      id: attempt.id,
      dedupeKey: `reservation-create:${attempt.id}`,
      kind: "reservation",
      dinnerId: record.id,
      subjectUserId: actorId,
      payload: {
        operation: "book",
        attemptId: attempt.id,
        dinnerId: record.id,
      },
    });
    return attempt;
  }
  async report(
    tx: DinnerTx,
    record: DinnerRecord<AppDinner>,
    actorId: string,
    input: { version: number; confirmed: true; reference?: string },
    now = this.clock(),
  ): Promise<ReservationAttempt> {
    const value = z
      .object({
        version: z.number().int().positive(),
        confirmed: z.literal(true),
        reference: z.string().trim().min(1).max(120).optional(),
      })
      .strict()
      .parse(input);
    assertPlan(record, actorId, value.version, now, false);
    await this.unblocked(tx, record.id);
    const attempt: ReservationAttempt = {
      id: randomUUID(),
      version: value.version,
      status: "organizer_reported",
      message:
        "Organizer reports a reservation for this plan. The provider has not independently confirmed it.",
      createdAt: now,
      ...(value.reference ? { reference: value.reference } : {}),
    };
    await tx.client.query(
      "INSERT INTO reservation_attempts(id,dinner_id,version,user_id,created_at,attempt) VALUES($1,$2,$3,$4,$5,$6)",
      [
        attempt.id,
        record.id,
        value.version,
        actorId,
        now,
        JSON.stringify(attempt),
      ],
    );
    return attempt;
  }
  async processReservation(work: ClaimedWork, workerId: string): Promise<void> {
    const payload = z
      .object({
        operation: z.enum(["review", "book"]),
        dinnerId: z.string(),
        attemptId: z.string().optional(),
        reviewId: z.string().optional(),
      })
      .parse(work.payload);
    if (payload.operation === "review") {
      const pending = await this.store.transaction(async (tx) => {
        const r = await tx.client.query(
          "SELECT review,slot FROM reservation_reviews WHERE id=$1 AND dinner_id=$2",
          [payload.reviewId, payload.dinnerId],
        );
        return r.rows[0];
      });
      if (!pending) {
        await this.store.markSuppressed(work.id, workerId);
        return;
      }
      const providerMatches =
        pending.review.provider === this.provider.capability().provider;
      const result = providerMatches
        ? await this.provider.availability(pending.slot)
        : {
            status: "handoff_required" as const,
            message:
              "Reservation provider changed. Review the current plan again.",
          };
      await this.store.processWork(work.id, workerId, async (tx) => {
        const record = await tx.getDinner<AppDinner>(payload.dinnerId);
        let valid = false;
        if (record && providerMatches) {
          try {
            assertPlan(
              record,
              record.organizerId,
              pending.review.version,
              this.clock(),
            );
            valid = true;
          } catch {}
        }
        const review: ReservationReview = {
          ...pending.review,
          status: valid
            ? result.status === "ready"
              ? "ready"
              : result.status === "unavailable"
                ? "action_needed"
                : "handoff_required"
            : "action_needed",
          message: valid
            ? result.message
            : "Plan changed. Review the current plan again.",
          ...(valid && result.status === "ready"
            ? {
                expiresAt: new Date(
                  Date.parse(this.clock()) + 120000,
                ).toISOString(),
                requiredContactFields: [
                  "firstName",
                  "lastName",
                  "email",
                  "phone",
                  "countryCode",
                ],
              }
            : {}),
        };
        await tx.client.query(
          "UPDATE reservation_reviews SET review=$2 WHERE id=$1",
          [payload.reviewId, JSON.stringify(review)],
        );
      });
      return;
    }
    const pending = await this.store.transaction(async (tx) => {
      const lease = await tx.client.query(
        "SELECT id FROM outbox WHERE id=$1 AND status='sending' AND lease_owner=$2 AND lease_until>now() FOR UPDATE",
        [work.id, workerId],
      );
      if (!lease.rowCount) return null;
      const r = await tx.client.query(
          "SELECT * FROM reservation_attempts WHERE id=$1 AND dinner_id=$2 FOR UPDATE",
          [payload.attemptId, payload.dinnerId],
        ),
        row = r.rows[0];
      if (!row) return null;
      if (row.attempt.status !== "queued") return null;
      const record = await tx.getDinner<AppDinner>(payload.dinnerId);
      try {
        if (!record) throw new Error();
        assertPlan(record, record.organizerId, row.version, this.clock());
        if (!row.encrypted_contact) throw new Error();
        if (
          row.attempt.provider !== this.provider.capability().provider ||
          !this.provider.capability().available
        )
          throw new Error();
      } catch {
        await tx.client.query(
          "UPDATE reservation_attempts SET attempt=attempt || $2::jsonb,encrypted_contact=NULL WHERE id=$1",
          [
            row.id,
            JSON.stringify({
              status: "superseded",
              message:
                "Plan or booking authorization changed before submission. No booking submitted.",
            }),
          ],
        );
        return null;
      }
      await tx.client.query(
        'UPDATE reservation_attempts SET attempt=attempt || \'{"status":"submitting"}\'::jsonb WHERE id=$1',
        [row.id],
      );
      return row;
    });
    if (!pending) {
      await this.store.processWork(work.id, workerId, async (tx) => {
        await tx.client.query(
          "UPDATE reservation_attempts SET attempt=attempt || $2::jsonb,encrypted_contact=NULL WHERE id=$1 AND attempt->>'status'='submitting'",
          [
            payload.attemptId,
            JSON.stringify({
              status: "unknown",
              message:
                "A previous submission may have reached the provider. Check directly; do not book again.",
            }),
          ],
        );
      });
      return;
    }
    let result;
    try {
      const contact = BookingContactSchema.parse(
        decrypt(
          pending.encrypted_contact,
          this.encryptionKey,
          `reservation:${payload.dinnerId}:${pending.id}`,
        ),
      );
      result = await this.provider.create(
        pending.slot,
        contact,
        pending.id,
        async () =>
          this.store.transaction(async (tx) => {
            const current = await tx.getDinner<AppDinner>(payload.dinnerId);
            try {
              if (
                !current ||
                pending.attempt.provider !==
                  this.provider.capability().provider ||
                !this.provider.capability().available
              )
                return false;
              assertPlan(
                current,
                current.organizerId,
                pending.version,
                this.clock(),
              );
              return true;
            } catch {
              return false;
            }
          }),
      );
    } catch {
      result = {
        status: "unknown",
        message:
          "Booking outcome unknown. Check directly before booking again.",
      };
    }
    await this.store.processWork(work.id, workerId, async (tx) => {
      await tx.client.query(
        "UPDATE reservation_attempts SET attempt=attempt || $2::jsonb,encrypted_contact=NULL WHERE id=$1",
        [
          pending.id,
          JSON.stringify({
            ...result,
            status:
              result.status === "handoff_required" ? "failed" : result.status,
          }),
        ],
      );
    });
  }
}

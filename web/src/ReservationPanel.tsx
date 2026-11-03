import { useState } from "react";
import type {
  DinnerView,
  MiniAppActionName,
} from "../../src/miniapp/contracts";
import { Button, Field, Notice } from "./components";
export function ReservationPanel({
  dinner: d,
  busy,
  error,
  onAction,
}: {
  dinner: DinnerView;
  busy: boolean;
  error?: string;
  onAction: (action: MiniAppActionName, payload?: unknown) => Promise<boolean>;
}) {
  const [consent, setConsent] = useState(false),
    [reported, setReported] = useState(false),
    [reference, setReference] = useState("");
  const [contact, setContact] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    countryCode: "US",
  });
  const review = d.reservation?.review,
    attempt = d.reservation?.attempt;
  const blocked =
    !!attempt &&
    [
      "queued",
      "submitting",
      "booked",
      "unknown",
      "organizer_reported",
    ].includes(attempt.status);
  const owner = d.role === "organizer",
    active = !d.ended && d.status !== "cancelled";
  const agreed = d.agreement?.agreed ?? d.status === "agreed";
  const verified =
    d.verification?.status === "ready" ||
    (!d.verification && d.status === "agreed");
  if (!d.options.length && !attempt) return null;
  const canManage =
    owner && active && agreed && !blocked && !d.reservation?.mismatch;
  const freshReview = review?.version === d.activeVersion;
  return (
    <section
      id="reservation-panel"
      className="card form-card"
      aria-label="Reservation status"
    >
      <h2>Reservation</h2>
      <strong>
        {attempt?.status === "booked"
          ? "Reservation confirmed"
          : attempt?.status === "organizer_reported"
            ? "Organizer reported a reservation"
            : attempt?.status === "unknown"
              ? "Reservation outcome needs checking"
              : attempt?.status === "queued" || attempt?.status === "submitting"
                ? "Booking is in progress"
                : "No confirmed reservation yet"}
      </strong>
      {attempt && <p className="muted small">{attempt.message}</p>}
      {attempt?.reference && (
        <p className="small">Reference: {attempt.reference}</p>
      )}
      {d.reservation?.mismatch && (
        <Notice kind="error">
          The reservation belongs to a different plan version. Check with the
          restaurant before changing or booking anything else.
        </Notice>
      )}
      {blocked && (
        <p className="field-hint">
          Do not make another booking while this reservation is confirmed,
          pending or unresolved. Check directly with the restaurant if needed.
        </p>
      )}
      {!agreed || !verified ? (
        <p className="muted small">
          The group must agree and plan checks must be complete before booking.
          Agreement alone does not reserve a table.
        </p>
      ) : null}
      {canManage && !freshReview && (
        <Button
          busy={busy}
          onClick={() =>
            void onAction("reviewReservation", { version: d.activeVersion })
          }
        >
          Review reservation options
        </Button>
      )}
      {freshReview && review && (
        <>
          <p className="muted small">{review.message}</p>
          {review.status === "checking" && (
            <Notice>
              Reservation availability is being checked. No booking has been
              made.
            </Notice>
          )}
          {canManage && verified && review.status === "ready" && (
            <form
              className="form-stack"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!consent) return;
                if (
                  await onAction("bookReservation", {
                    version: review.version,
                    reviewId: review.reviewId,
                    consent: true,
                    contact,
                  })
                ) {
                  setConsent(false);
                  setContact({
                    firstName: "",
                    lastName: "",
                    email: "",
                    phone: "",
                    countryCode: "US",
                  });
                }
              }}
            >
              <p className="field-hint">
                These contact details are used for this reservation and are not
                shown in shared answers.
              </p>
              <div className="field-pair">
                <Field label="First name">
                  <input
                    required
                    maxLength={80}
                    autoComplete="given-name"
                    value={contact.firstName}
                    onChange={(e) =>
                      setContact({ ...contact, firstName: e.target.value })
                    }
                  />
                </Field>
                <Field label="Last name">
                  <input
                    required
                    maxLength={80}
                    autoComplete="family-name"
                    value={contact.lastName}
                    onChange={(e) =>
                      setContact({ ...contact, lastName: e.target.value })
                    }
                  />
                </Field>
              </div>
              <Field label="Email">
                <input
                  required
                  type="email"
                  autoComplete="email"
                  maxLength={254}
                  value={contact.email}
                  onChange={(e) =>
                    setContact({ ...contact, email: e.target.value })
                  }
                />
              </Field>
              <Field label="Phone">
                <input
                  required
                  type="tel"
                  autoComplete="tel"
                  value={contact.phone}
                  maxLength={25}
                  onChange={(e) =>
                    setContact({ ...contact, phone: e.target.value })
                  }
                />
              </Field>
              <Field label="Country code">
                <select
                  value={contact.countryCode}
                  onChange={(e) =>
                    setContact({ ...contact, countryCode: e.target.value })
                  }
                >
                  {["US", "CA", "GB", "AU", "IN", "FR", "DE", "SG", "JP"].map(
                    (code) => (
                      <option key={code}>{code}</option>
                    ),
                  )}
                </select>
              </Field>
              <a
                href="https://www.opentable.com/legal/terms-and-conditions"
                target="_blank"
                rel="noopener noreferrer"
              >
                Review OpenTable booking terms
              </a>
              <label className="check-label consent">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  I authorize this reservation for the current plan and accept
                  the provider’s booking terms. I understand this can create a
                  real restaurant booking.
                </span>
              </label>
              <Button type="submit" busy={busy} disabled={!consent}>
                Authorize and book this table
              </Button>
            </form>
          )}
          {canManage &&
            (review.status === "handoff_required" ||
              review.status === "action_needed") && (
              <>
                {review.bookingUrl && (
                  <a
                    className="button button-secondary"
                    href={review.bookingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open verified reservation handoff
                  </a>
                )}
                {review.phone && (
                  <a
                    className="button button-secondary"
                    href={`tel:${review.phone.replace(/[^+\d]/g, "")}`}
                  >
                    Call the restaurant · {review.phone}
                  </a>
                )}
                <Field label="Reservation reference" optional>
                  <input
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    maxLength={160}
                  />
                </Field>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={reported}
                    onChange={(e) => setReported(e.target.checked)}
                  />
                  <span>
                    I completed the reservation directly and it matches this
                    plan’s date, time and party size.
                  </span>
                </label>
                <Button
                  busy={busy}
                  disabled={!reported}
                  onClick={() =>
                    void onAction("reportReservation", {
                      version: d.activeVersion,
                      confirmed: true,
                      ...(reference.trim()
                        ? { reference: reference.trim() }
                        : {}),
                    })
                  }
                >
                  Report my completed reservation
                </Button>
              </>
            )}
        </>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </section>
  );
}

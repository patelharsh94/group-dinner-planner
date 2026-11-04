import type {
  DinnerView,
  MiniAppActionName,
} from "../../src/miniapp/contracts";
import { Button, Icon } from "./components";
import { planTime } from "./time";
export function GroupChoice({
  dinner: d,
  actorId,
  busy,
  onAction,
  onChange,
  onCalendar,
}: {
  dinner: DinnerView;
  actorId: string;
  busy: boolean;
  onAction: (action: MiniAppActionName, payload?: unknown) => Promise<boolean>;
  onChange: () => void;
  onCalendar: () => Promise<void>;
}) {
  const option = d.options[0];
  if (!option) return null;
  const agreement = d.agreement ?? {
    version: d.activeVersion,
    confirmed: d.progress.confirmed,
    required: d.members.filter((m) => m.required).length,
    agreed: d.status === "agreed",
  };
  const verified =
    d.verification?.status === "ready" ||
    (!d.verification && d.status === "agreed");
  const already = d.members.find((m) => m.id === actorId)?.confirmed;
  const eligible =
    (d.canConfirm ??
      (option.ownChecks.status === "feasible" &&
        d.progress.complete >= d.progress.expected)) &&
    option.ownChecks.status !== "infeasible" &&
    !d.own.disputeOpen;
  const active =
    !d.ended &&
    d.status !== "cancelled" &&
    d.role !== "pending" &&
    d.role !== "withdrawn" &&
    d.own.consent;
  return (
    <section
      className="card form-card current-choice"
      aria-label="Group current choice"
    >
      <div className="section-heading">
        <span className="eyebrow">Group current choice</span>
        <span className="version-label">Plan {agreement.version}</span>
      </div>
      <h2 className="choice-venue">{option.venueName}</h2>
      <p className="muted small">{option.address}</p>
      <div className="plan-facts">
        <p>
          <Icon name="calendar" size={17} />
          {planTime(option.start, option.end, d.setup.timezone)}
        </p>
        <p>
          <Icon name="clock" size={17} />
          {d.setup.durationMinutes} minutes ·{" "}
          {d.setup.timezone.replaceAll("_", " ")}
        </p>
        <p>
          <Icon name="people" size={17} />
          {d.members.filter((m) => m.required).length} people ·{" "}
          {option.priceEstimateKnown === false
            ? "Meal cost not confirmed"
            : `About ${option.currency} ${option.pricePerPerson} per person`}
        </p>
      </div>
      <div className="agreement-status">
        <strong>
          {agreement.agreed
            ? "Everyone agreed"
            : `${agreement.confirmed} of ${agreement.required} confirmed`}
        </strong>
        <p className="field-hint">
          {agreement.agreed
            ? "The group agrees on this version. Verification and reservation status are tracked separately below."
            : "Every required person must explicitly confirm this same version."}
        </p>
      </div>
      <div className="confirmation-names">
        {d.members
          .filter((m) => m.required)
          .map((m) => (
            <span key={m.id}>
              {m.id === actorId ? "You" : m.name} ·{" "}
              {m.confirmed ? "confirmed" : "not yet confirmed"}
            </span>
          ))}
      </div>
      {active && !agreement.agreed && (
        <div className="plan-actions">
          {already ? (
            <div className="confirmed-label">
              <Icon name="check" size={17} />
              You’re in for this version
            </div>
          ) : (
            <Button
              className="full"
              busy={busy}
              disabled={!eligible}
              onClick={() =>
                void onAction("confirm", { version: agreement.version })
              }
            >
              This works for me <Icon name="check" size={17} />
            </Button>
          )}
          <Button variant="quiet" onClick={onChange}>
            I need a change
          </Button>
        </div>
      )}
      {agreement.agreed && (
        <Button
          variant="secondary"
          busy={busy}
          onClick={() => void onCalendar()}
        >
          <Icon name="calendar" size={17} />
          Add to my calendar
        </Button>
      )}
    </section>
  );
}
export function VerificationStatus({ dinner }: { dinner: DinnerView }) {
  if (!dinner.options.length) return null;
  const verification = dinner.verification ?? {
    status: dinner.status === "agreed" ? "ready" : "pending",
    checks: [],
  };
  return (
    <section className="card form-card" aria-label="Plan verification">
      <div className="section-heading">
        <h2>Plan checks</h2>
        <span className="status-badge">
          {verification.status === "ready"
            ? "Ready"
            : verification.status === "action_needed"
              ? "Action needed"
              : "Some details unconfirmed"}
        </span>
      </div>
      <details className="source-details">
        <summary>Details to confirm</summary>
        {verification.checks.length ? (
          <ul className="verification-checks">
            {verification.checks.map((check, i) => (
              <li key={i}>
                <span className={`check-state ${check.status}`}>
                  {check.status === "ready" ? "✓" : "·"}
                </span>
                <span>{check.message}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">
            {verification.status === "ready"
              ? "The represented plan checks are complete."
              : "Some details could not be confirmed from available sources. You can still choose this restaurant when confirmation is available. A table has not been reserved."}
          </p>
        )}
      </details>
    </section>
  );
}

import { AnswersPreview } from "./AnswersPreview";
import { ResearchStatus } from "./ResearchStatus";
import { useState } from "react";
import type {
  DinnerView,
  MiniAppActionName,
} from "../../src/miniapp/contracts";
import { Brand, Button, Field, Icon, Notice, Sheet } from "./components";
import { dateLabel, friendlyZone, planTime } from "./time";

interface Props {
  dinner: DinnerView;
  actorId: string;
  busy: boolean;
  error?: string;
  notice?: string;
  onHome: () => void;
  onEdit: () => void;
  onSettings: () => void;
  onAction: (action: MiniAppActionName, payload?: unknown) => Promise<boolean>;
  onCalendar: () => Promise<void>;
}
const statusLabels: Record<string, string> = {
  collecting: "Bringing everyone together",
  proposed: "A plan to consider",
  agreed: "Everyone is in",
  escalated: "A little help needed",
  researching: "Finding your table",
  pending: "Waiting for the organizer",
};
export function Dashboard({
  dinner: d,
  actorId,
  busy,
  error,
  notice,
  onHome,
  onEdit,
  onSettings,
  onAction,
  onCalendar,
}: Props) {
  const researchPending = d.research
    ? d.research.status === "queued" || d.research.status === "running"
    : d.researchPending;
  const cancelled = d.status === "cancelled";
  const owner = d.role === "organizer",
    pending = d.role === "pending",
    withdrawn = d.role === "withdrawn" || !d.own.consent;
  const [change, setChange] = useState(false),
    [reason, setReason] = useState("");
  const [staff, setStaff] = useState(false),
    [requirement, setRequirement] = useState(""),
    [report, setReport] = useState(""),
    [affirmation, setAffirmation] = useState(false);
  const [staffPlan, setStaffPlan] = useState<{
    venueId: string;
    name: string;
    formVersion: string;
    version: number;
  }>();
  const ownMember = d.members.find((member) => member.id === actorId);
  const allergyRequirements =
    d.own.constraints.dietary?.filter((diet) => diet.allergy) ?? [];
  const canParticipate = !d.ended && !pending && !withdrawn;
  const complete = d.progress.complete,
    expected = d.progress.expected;
  return (
    <>
      <Brand back={onHome} settings={onSettings} />
      <main className="page dashboard">
        <div className="eyebrow">{d.city} · Dinner together</div>
        <h1>
          {cancelled ? (
            <>
              Plans change.
              <br />
              That’s okay.
            </>
          ) : d.status === "agreed" ? (
            <>
              A table.
              <br />A plan. Everyone.
            </>
          ) : (
            <>
              Good company.
              <br />
              Coming together.
            </>
          )}
        </h1>
        <div className="context-pill">
          <Icon name="calendar" size={16} />
          {dateLabel(d.windowStart)}–{dateLabel(d.windowEnd)}
          <span className="pill-dot" />
          {d.setup.durationMinutes} min
        </div>
        {!cancelled &&
          (d.setup.budget.basis === "total" ? (
            <Notice>
              Previous budget: {d.setup.currency} {d.setup.budget.amount} for
              the whole table. The organizer needs to enter an explicit
              per-person budget in shared dinner details.
            </Notice>
          ) : (
            <p className="field-hint">
              Budget per person: {d.setup.currency} {d.setup.budget.amount}.
              Maximum estimated meal cost for each person, not the group total.
            </p>
          ))}
        {error && <Notice kind="error">{error}</Notice>}
        {notice && <Notice kind="success">{notice}</Notice>}
        <ResearchStatus dinner={d} />
        {cancelled ? (
          <section className="card form-card">
            <span className="status-badge">Cancelled</span>
            <h2>This dinner is cancelled.</h2>
            <p className="muted">
              Planning and reminders have stopped for everyone. This dinner
              cannot be reopened.
            </p>
            <p className="muted small">
              Any restaurant reservation or calendar event must be cancelled
              manually. Muse has not changed those for you.
            </p>
          </section>
        ) : withdrawn ? (
          <section className="card form-card">
            <h2>You're taking a break</h2>
            <p className="muted">
              Muse will not send you planning messages for this dinner.
            </p>
            {owner && !d.ended ? (
              <Button
                busy={busy}
                onClick={() => void onAction("resume", { consent: true })}
              >
                Rejoin dinner coordination
              </Button>
            ) : (
              <p className="muted">
                Ask the organizer for a fresh invitation to rejoin.
              </p>
            )}
          </section>
        ) : pending ? (
          <section className="card form-card">
            <span className="status-badge">
              <span className="pulse-dot" />
              Answers saved
            </span>
            <h2>The organizer will let you in.</h2>
            <p className="muted">
              Your seat is waiting for approval. Your answers are saved. Any
              chosen sharing starts only after approval, and you can still
              update your answers.
            </p>
            <Button variant="secondary" onClick={onEdit}>
              Edit my answers
            </Button>
          </section>
        ) : (
          <>
            <section className="card progress-card">
              <div className="section-heading">
                <div>
                  <span
                    className={`status-badge ${d.status === "agreed" ? "success" : ""}`}
                  >
                    <span className="pulse-dot" />
                    {researchPending
                      ? "Finding your table"
                      : (statusLabels[d.status] ?? "Dinner in progress")}
                  </span>
                  <h2>
                    {d.status === "agreed"
                      ? `${d.progress.confirmed} people, one agreed plan.`
                      : `${complete} of ${expected} answers in`}
                  </h2>
                </div>
                <div className="progress-count">
                  {d.progress.approved}
                  <span>/{expected}</span>
                </div>
              </div>
              <div
                className="progress-track"
                aria-label={`${complete} of ${expected} participants answered`}
              >
                <span
                  style={{
                    width: `${Math.min(100, expected ? (complete / expected) * 100 : 0)}%`,
                  }}
                />
              </div>
              <div className="roster">
                {d.members.map((member, index) => (
                  <div className="roster-member" key={member.id}>
                    <span className={`avatar avatar-${index % 4}`}>
                      {member.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span>
                      {member.id === actorId ? "You" : member.name}
                      {!member.required && <small>Optional</small>}
                    </span>
                    {member.confirmed ? (
                      <span
                        className="member-check"
                        aria-label={`${member.name} confirmed`}
                      >
                        <Icon name="check" size={14} />
                      </span>
                    ) : null}
                  </div>
                ))}
                {d.progress.approved < expected && (
                  <p className="field-hint">
                    {expected - d.progress.approved}{" "}
                    {expected - d.progress.approved === 1 ? "place" : "places"}{" "}
                    still to join.
                  </p>
                )}
              </div>
              {owner && !d.ended && d.progress.approved < expected && (
                <Button
                  variant="secondary"
                  className="full"
                  busy={busy}
                  onClick={() => void onAction("invite")}
                >
                  <Icon name="share" size={17} />
                  Share invitation
                </Button>
              )}
            </section>
            {owner && (d.pendingRequests?.length ?? 0) > 0 && (
              <section className="card form-card">
                <h2>A friend is at the door</h2>
                <p className="muted small">
                  Only approve people you invited to this dinner.
                </p>
                {d.pendingRequests!.map((request) => (
                  <div className="join-request" key={request.userId}>
                    <span className="avatar">
                      {request.name.slice(0, 1).toUpperCase()}
                    </span>
                    <strong>{request.name}</strong>
                    <div>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          void onAction("reject", { userId: request.userId })
                        }
                      >
                        Not now
                      </button>
                      <Button
                        variant="secondary"
                        busy={busy}
                        onClick={() =>
                          void onAction("approve", { userId: request.userId })
                        }
                      >
                        Approve
                      </Button>
                    </div>
                  </div>
                ))}
              </section>
            )}
            {!d.ended && (
              <section className="card own-card">
                <span className="small-icon-circle">
                  <Icon name="leaf" />
                </span>
                <div>
                  <h2>
                    {d.own.foodConfirmed &&
                    d.own.constraints.availability?.length
                      ? "Your answers are in"
                      : "Start with your availability"}
                  </h2>
                  <p className="muted small">
                    {d.own.foodConfirmed
                      ? d.own.answerSharing
                        ? "Shared by your choice. Easy to change."
                        : "Private unless you choose to share. Easy to change."
                      : "Pick your dates and tell Muse about food."}
                  </p>
                </div>
                <button
                  className="icon-button"
                  onClick={onEdit}
                  aria-label="Edit my answers"
                >
                  <Icon name="chevron" />
                </button>
              </section>
            )}

            {researchPending && !d.research && (
              <Notice>
                <strong>Muse is checking dinner options.</strong>
                <p>
                  Research is in progress. This page will update when your
                  options are ready.
                </p>
              </Notice>
            )}
            {d.options.length > 0 ? (
              <section className="options-section">
                <div className="section-heading">
                  <h2>
                    {d.status === "agreed"
                      ? "Your dinner"
                      : "A table worth gathering around"}
                  </h2>
                  <span className="version-label">Plan {d.activeVersion}</span>
                </div>
                {d.options.slice(0, 2).map((option, index) => (
                  <article
                    key={`${d.activeVersion}-${option.index}`}
                    className={`card plan-card ${index === 0 ? "recommended" : ""}`}
                  >
                    <div className="plan-heading">
                      <span className="eyebrow">
                        {index === 0
                          ? d.status === "agreed"
                            ? "The agreed plan"
                            : "Recommended"
                          : "Another good option"}
                      </span>
                      <span className="restaurant-mark" aria-hidden="true">
                        ✳
                      </span>
                    </div>
                    <h3>{option.venueName}</h3>
                    <p className="muted small">{option.address}</p>
                    <div className="plan-facts">
                      <p>
                        <Icon name="calendar" size={17} />
                        {planTime(option.start, option.end, d.setup.timezone)}
                      </p>
                      <p>
                        <Icon name="clock" size={17} />
                        {d.setup.durationMinutes} minutes ·{" "}
                        {friendlyZone(d.setup.timezone)}
                      </p>
                      <p>
                        <span className="price-symbol" aria-hidden="true">
                          $
                        </span>
                        About{" "}
                        {new Intl.NumberFormat(undefined, {
                          style: "currency",
                          currency: option.currency,
                          maximumFractionDigits: 2,
                        }).format(option.pricePerPerson)}{" "}
                        per person
                      </p>
                    </div>
                    <div className="reservation-note">
                      Reservation:{" "}
                      {option.reservationState === "booked"
                        ? "check with the organizer"
                        : option.reservationState === "handoff"
                          ? "manual handoff available"
                          : option.reservationState === "not-booked"
                            ? "not booked"
                            : option.reservationState === "unavailable"
                              ? "unavailable"
                              : "not confirmed"}
                      . Agreement does not book a table.
                    </div>
                    {option.sources?.length > 0 && (
                      <details className="source-details">
                        <summary>Sources &amp; checks</summary>
                        <ul>
                          {option.sources.map((source, i) => (
                            <li key={i}>
                              <a
                                href={source.url}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {source.label} <Icon name="arrow" size={12} />
                              </a>
                              <span>
                                {source.status === "known"
                                  ? "Sourced"
                                  : source.status === "contradictory"
                                    ? "Conflicting sources"
                                    : "Needs checking"}{" "}
                                · Checked{" "}
                                {dateLabel(source.retrievedAt.slice(0, 10))}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {option.ownChecks && (
                      <div className={`own-checks ${option.ownChecks.status}`}>
                        <div>
                          <Icon
                            name={
                              option.ownChecks.status === "feasible"
                                ? "check"
                                : "clock"
                            }
                            size={16}
                          />
                          <strong>
                            {option.ownChecks.status === "feasible"
                              ? "Fits your answers"
                              : option.ownChecks.status === "unresolved"
                                ? "A few checks are still open"
                                : "A requirement needs attention"}
                          </strong>
                        </div>
                        {option.ownChecks.reasons.length > 0 && (
                          <ul>
                            {option.ownChecks.reasons.map((item, i) => (
                              <li key={i}>{item}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                    {canParticipate && index === 0 && d.status !== "agreed" && (
                      <div className="plan-actions">
                        {ownMember?.confirmed ? (
                          <div className="confirmed-label">
                            <Icon name="check" size={18} />
                            You're in for this version
                          </div>
                        ) : (
                          <Button
                            busy={busy}
                            disabled={
                              option.ownChecks?.status !== "feasible" ||
                              d.own.disputeOpen ||
                              d.status === "escalated"
                            }
                            className="full"
                            onClick={() =>
                              void onAction("confirm", {
                                version: d.activeVersion,
                              })
                            }
                          >
                            This works for me <Icon name="check" size={18} />
                          </Button>
                        )}
                        <Button
                          variant="quiet"
                          className="full"
                          onClick={() => setChange(true)}
                        >
                          I need a change
                        </Button>
                      </div>
                    )}
                    {owner &&
                      canParticipate &&
                      index > 0 &&
                      d.status !== "agreed" && (
                        <Button
                          variant="secondary"
                          busy={busy}
                          className="full"
                          onClick={() =>
                            void onAction("select", {
                              index: option.index,
                              version: d.activeVersion,
                            })
                          }
                        >
                          Choose this option instead
                        </Button>
                      )}
                    {index === 0 && d.status === "agreed" && (
                      <div className="plan-actions">
                        <Button
                          variant="primary"
                          className="full"
                          busy={busy}
                          onClick={() => void onCalendar()}
                        >
                          <Icon name="calendar" size={18} />
                          Add to my calendar
                        </Button>
                        {option.reservationUrl && (
                          <a
                            className="button button-secondary full"
                            href={option.reservationUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            View reservation handoff{" "}
                            <Icon name="arrow" size={16} />
                          </a>
                        )}
                      </div>
                    )}
                  </article>
                ))}
              </section>
            ) : (
              owner &&
              canParticipate && (
                <section className="empty-plans">
                  <div className="table-illustration" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                    <span />
                    <div>✳</div>
                  </div>
                  <h2>
                    {d.research?.status === "failed"
                      ? "Research is paused."
                      : complete < expected
                        ? "First, a little from everyone."
                        : "Ready to find your table?"}
                  </h2>
                  <p className="muted">
                    {d.research?.status === "failed"
                      ? "See the latest research status above. Your group's saved answers are preserved."
                      : complete < expected
                        ? "Once everyone has joined and answered, Muse can check times and research places."
                        : "Muse will look for places that fit the whole group and bring back up to two plans."}
                  </p>
                  <Button
                    busy={busy}
                    disabled={
                      researchPending ||
                      complete < expected ||
                      d.progress.approved < expected
                    }
                    onClick={() => void onAction("research")}
                  >
                    Find dinner options <Icon name="arrow" size={18} />
                  </Button>
                </section>
              )
            )}
            {canParticipate && d.own.disputeOpen && (
              <Notice>
                <strong>Your change request is open.</strong>
                <p>
                  Once the current plan addresses it, explicitly resolve your
                  request before confirming.
                </p>
                <Button
                  variant="secondary"
                  busy={busy}
                  onClick={() => void onAction("resolve")}
                >
                  This addresses my request
                </Button>
              </Notice>
            )}
            {canParticipate &&
              allergyRequirements.length > 0 &&
              d.options.length > 0 && (
                <section className="card form-card">
                  <h2>A safety check, from you</h2>
                  <p className="muted small">
                    For an allergy, talk directly with restaurant staff about
                    accommodation and cross-contact. Muse cannot make that
                    decision for you.
                  </p>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setRequirement(allergyRequirements[0]?.requirement ?? "");
                      setStaffPlan({
                        venueId: d.options[0]!.venueId,
                        name: d.options[0]!.venueName,
                        formVersion: d.formVersion,
                        version: d.activeVersion!,
                      });
                      setStaff(true);
                    }}
                  >
                    Record my staff conversation
                  </Button>
                </section>
              )}
            {owner &&
              canParticipate &&
              d.options.length > 0 &&
              d.status !== "agreed" && (
                <Button
                  variant="quiet"
                  busy={busy || researchPending}
                  className="full"
                  onClick={() => void onAction("research")}
                >
                  Refresh dinner options
                </Button>
              )}
            {d.ended && (
              <Notice>This dinner has begun. The plan is now read-only.</Notice>
            )}
          </>
        )}
        {(d.role === "organizer" || d.role === "member") &&
          d.own.consent &&
          (d.sharedResponses?.length ?? 0) > 0 && (
            <section className="card form-card" aria-label="Party answers">
              <h2>Party answers</h2>
              <p className="muted small">
                Each person chooses whether to share their form answers with
                approved dinner members. Private answers are never shown.
              </p>
              {d.sharedResponses.map((response) => (
                <details className="party-response" key={response.userId}>
                  <summary>
                    <strong>
                      {response.userId === actorId ? "You" : response.name}
                    </strong>
                    <span className="status-badge">
                      {response.status === "shared"
                        ? "Shared"
                        : response.status === "private"
                          ? "Private"
                          : "Not submitted"}
                    </span>
                  </summary>
                  {response.status === "shared" && response.constraints ? (
                    <AnswersPreview
                      answers={response.constraints}
                      timezone={d.setup.timezone}
                      currency={d.setup.currency}
                    />
                  ) : (
                    <p className="muted small">
                      {response.status === "private"
                        ? "This person's answers stay private."
                        : "No submitted answers to share."}
                    </p>
                  )}
                </details>
              ))}
            </section>
          )}
        <p className="footnote">
          Your sharing choice. Shared plans. Actual agreement.
        </p>
      </main>
      {change && (
        <Sheet title="What needs to change?" onClose={() => setChange(false)}>
          <div className="form-stack">
            <p className="muted">
              Tell Muse what the plan needs to address. Your private details
              will not be shared with the group.
            </p>
            <Field label="Your change request">
              <textarea
                rows={4}
                placeholder="I need an earlier time, or…"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={1000}
              />
            </Field>
            {error && <Notice kind="error">{error}</Notice>}
            <Button
              busy={busy}
              disabled={!reason.trim()}
              onClick={async () => {
                if (await onAction("change", { reason: reason.trim() })) {
                  setChange(false);
                  setReason("");
                }
              }}
            >
              Send change request
            </Button>
          </div>
        </Sheet>
      )}
      {staff && (
        <Sheet
          title="Your allergy safety check"
          onClose={() => setStaff(false)}
        >
          <div className="form-stack">
            <Field label="Requirement discussed">
              <select
                value={requirement}
                onChange={(e) => {
                  setRequirement(e.target.value);
                  setAffirmation(false);
                }}
              >
                {allergyRequirements.map((diet) => (
                  <option key={diet.requirement}>{diet.requirement}</option>
                ))}
              </select>
            </Field>
            <Field label="What did staff confirm?">
              <textarea
                rows={3}
                value={report}
                onChange={(e) => {
                  setReport(e.target.value);
                  setAffirmation(false);
                }}
                placeholder="Note who you spoke to and what they confirmed."
                maxLength={1000}
              />
            </Field>
            <label className="check-label consent">
              <input
                type="checkbox"
                checked={affirmation}
                onChange={(e) => setAffirmation(e.target.checked)}
              />
              <span>
                I spoke directly with staff at {staffPlan?.name} and they
                confirmed they can accommodate this allergy, including
                cross-contact precautions. I am comfortable proceeding.
              </span>
            </label>
            {(staffPlan?.formVersion !== d.formVersion ||
              staffPlan?.version !== d.activeVersion) && (
              <Notice kind="error">
                This plan changed while you were writing. Close this check and
                review the current venue before reporting.
              </Notice>
            )}
            {error && <Notice kind="error">{error}</Notice>}
            <Button
              busy={busy}
              disabled={
                !affirmation ||
                !report.trim() ||
                staffPlan?.formVersion !== d.formVersion ||
                staffPlan?.version !== d.activeVersion
              }
              onClick={async () => {
                if (
                  await onAction("staffReport", {
                    venueId: staffPlan!.venueId,
                    version: staffPlan!.version,
                    requirement,
                    report: report.trim(),
                    accommodationConfirmed: true,
                  })
                ) {
                  setStaff(false);
                  setReport("");
                  setAffirmation(false);
                }
              }}
            >
              Confirm my staff report
            </Button>
          </div>
        </Sheet>
      )}
    </>
  );
}

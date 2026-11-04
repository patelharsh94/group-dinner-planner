import { DateTime } from "luxon";
import type { DinnerView } from "../../src/miniapp/contracts";
import type { ResearchCode } from "../../src/application/research";
import { verificationIssueGuidance } from "./plan-checks";

const guidance: Record<ResearchCode, string> = {
  AUTH_INVALID:
    "The service owner needs to replace MODEL_API_KEY in Render and redeploy before retrying. Do not enter an API key in this app. The group does not need to change its answers.",
  ACCESS_DENIED:
    "The service owner should check API key permissions and model access before retrying.",
  QUOTA_EXCEEDED:
    "The service owner should check the service account billing or quota before retrying.",
  RATE_LIMITED: "Wait for the provider rate limit to clear before retrying.",
  PROVIDER_UNAVAILABLE:
    "The research service is temporarily unavailable. Try again later.",
  REQUEST_REJECTED:
    "The research request was rejected. The service owner should check the connection configuration before retrying.",
  TIMEOUT:
    "The attempt timed out. Retry research; the saved answers are unchanged.",
  NETWORK:
    "The service could not reach Muse. Retry after the connection is restored.",
  INVALID_OUTPUT:
    "The response did not pass validation. Retry; unsupported results were not accepted.",
  INCOMPLETE_OUTPUT:
    "The response was incomplete. Retry; no unfinished answer was accepted.",
  SEARCH_NOT_EXECUTED:
    "The live search did not complete. Retry research; no sample or invented result was substituted.",
  NO_SUITABLE_OPTIONS:
    "Retry research with your saved answers. The search did not produce a usable shortlist; this does not establish that your preferences are impossible.",
  EVIDENCE_UNRESOLVED:
    "Review the suggested options. Some restaurant details are not confirmed yet; this does not confirm a reservation.",
  NO_COMMON_TIME:
    "There is no common dinner time yet. Ask participants to review their availability.",
  SERVICE_UNCONFIGURED:
    "The service owner needs to configure MODEL_API_KEY in Render before retrying. Do not enter credentials here.",
  USAGE_LIMIT:
    "This dinner has reached its daily research limit. Try again tomorrow.",
  UNEXPECTED_ERROR: "Contact support using the attempt reference below.",
};
const titles = {
  queued: "Research queued",
  running: "Research in progress",
  succeeded: "Research complete",
  needs_checks: "Research needs another pass",
  failed: "Research needs attention",
  superseded: "Earlier research was superseded",
  cancelled: "Research cancelled",
};
const stages: Record<string, string> = {
  queued: "Waiting to start",
  provider: "Researching restaurant details",
  directory_discovery: "Finding restaurants on Yelp",
  restaurant_details: "Checking restaurant details",
  group_fit: "Matching the group’s answers",
  booking_availability: "Checking booking availability",
  output_validation: "Checking the research response",
  source_verification: "Verifying sources",
  planning: "Checking possible plans",
  done: "Finished",
};
export function ResearchStatus({ dinner }: { dinner: DinnerView }) {
  const approved =
    (dinner.role === "organizer" || dinner.role === "member") &&
    dinner.own.consent;
  const attempt = dinner.research;
  if (!approved || !attempt) return null;
  // Only whitelisted safe metadata is rendered. Members never receive organizer diagnostics here.
  const details =
    dinner.role === "organizer" ? dinner.researchDetails : undefined;
  return (
    <section
      className="card form-card research-status"
      aria-label="Latest research"
    >
      <div>
        <span className="eyebrow">Latest research</span>
        <h2>
          {attempt.status === "failed" && dinner.options.length
            ? "Your restaurant choices are saved"
            : details?.code === "NO_SUITABLE_OPTIONS"
              ? "We couldn’t finish your shortlist"
              : attempt.status === "needs_checks" && dinner.options.length
                ? "Dinner options ready"
                : titles[attempt.status]}
        </h2>
      </div>
      <p className="muted small">
        {attempt.status === "failed" && dinner.options.length
          ? "The background check couldn’t finish. Your choices are still available; review any question for the organizer below."
          : attempt.status === "needs_checks" && dinner.options.length
            ? "You can choose an option and confirm if it works for you. Confirm any food or allergy accommodation with the restaurant before relying on it. A table is not reserved until the reservation is confirmed."
            : attempt.status === "queued" || attempt.status === "running"
              ? "We’re finding restaurants and checking the group’s dinner details. This page will update as we go."
              : attempt.status === "failed"
                ? "The organizer is reviewing the next step. Your saved answers are unchanged."
                : attempt.status === "cancelled"
                  ? "Research has stopped. Your saved answers are unchanged."
                  : attempt.status === "superseded"
                    ? "The group’s answers changed. The latest dinner details will be used for the next search."
                    : "The latest research is ready to review."}
      </p>
      {(attempt.status === "queued" || attempt.status === "running") && (
        <p className="field-hint" role="status">
          {stages[details?.stage ?? "queued"] ?? "Checking dinner details"}
        </p>
      )}
      {details && (
        <details className="research-diagnostics">
          <summary>Research details for organizer</summary>
          <div className="form-stack">
            <p className="small">
              {details.code
                ? guidance[details.code]
                : attempt.status === "queued" || attempt.status === "running"
                  ? "Research is working through the saved group answers."
                  : "This is the latest recorded attempt."}
            </p>
            <dl className="answers-list">
              <div>
                <dt>Stage</dt>
                <dd>{stages[details.stage] ?? "Checking dinner details"}</dd>
              </div>
              {details.code && (
                <div>
                  <dt>Result code</dt>
                  <dd>{details.code}</dd>
                </div>
              )}
              {details.httpStatus !== undefined && (
                <div>
                  <dt>HTTP status</dt>
                  <dd>{details.httpStatus}</dd>
                </div>
              )}
              <div>
                <dt>Last updated</dt>
                <dd>
                  {DateTime.fromISO(details.updatedAt)
                    .setZone(dinner.setup.timezone)
                    .toFormat("LLL d, h:mm:ss a")}
                </dd>
              </div>
              {details.durationMs !== undefined && (
                <div>
                  <dt>Attempt time</dt>
                  <dd>{(details.durationMs / 1000).toFixed(1)} seconds</dd>
                </div>
              )}
              {details.retryAfterSeconds !== undefined && (
                <div>
                  <dt>Retry guidance</dt>
                  <dd>
                    Wait at least {details.retryAfterSeconds} seconds before
                    retrying.
                  </dd>
                </div>
              )}
              {details.discovery && (
                <div>
                  <dt>Restaurant discovery</dt>
                  <dd>
                    {details.discovery.status === "used"
                      ? "Discovery assisted by "
                      : details.discovery.status === "empty"
                        ? "No Yelp candidates; using web search. "
                        : "Yelp unavailable; using web search. "}
                    <a
                      href="https://www.yelp.com"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Yelp
                    </a>
                    {details.discovery.code && ` (${details.discovery.code})`}
                  </dd>
                </div>
              )}
              {details.verificationIssues?.length ? (
                <div>
                  <dt>What the source checks found</dt>
                  <dd>
                    <ul>
                      {details.verificationIssues.map((issue) => (
                        <li key={issue.code}>
                          {verificationIssueGuidance[issue.code]} ({issue.count}
                          )
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              ) : null}
              {details.phases?.length ? <div><dt>Research phases</dt><dd><ul>{details.phases.map((phase, i) => <li key={i}>{phase.phase.replaceAll("_", " ")}: {phase.outcome}{phase.code ? ` (${phase.code.replaceAll("_", " ")})` : ""}{phase.durationMs !== undefined ? ` · ${(phase.durationMs / 1000).toFixed(1)}s` : ""}{phase.model ? ` · ${phase.model}` : ""}</li>)}</ul></dd></div> : null}
              {details.counts && (
                <div>
                  <dt>Research checks</dt>
                  <dd>
                    {details.counts.venues} venues · {details.counts.options}{" "}
                    options · {details.counts.verifiedClaims} verified claims ·{" "}
                    {details.counts.unresolvedClaims} details not confirmed ·{" "}
                    {details.counts.sourcesFailed} source checks failed
                  </dd>
                </div>
              )}
              <div>
                <dt>Support reference</dt>
                <dd className="support-reference">{details.id}</dd>
              </div>
              {details.providerRequestId && (
                <div>
                  <dt>Provider reference</dt>
                  <dd className="support-reference">
                    {details.providerRequestId}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        </details>
      )}
    </section>
  );
}

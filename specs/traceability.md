# Contract to executable scenarios

Canonical IDs in SPEC.md map to executable Vitest scenarios below. Domain scenarios retain more granular diagnostic IDs; they implement the canonical requirement they are grouped under here.

- **SET-01 / SET-02:** `tests/application/coordinator.test.ts` setup-review scenario; `tests/domain/dinner.test.ts` SETUP-01, TIME-01, TIME-02 and BOUNDS-01.
- **JOIN-01 / AUTH-01:** `tests/application/coordinator.test.ts` invitation/consent/approval, nonmember isolation, expiry and rejoin scenarios; `tests/http.test.ts` authentication, private identity, forwarded commands and callback normalization; domain JOIN-01 and MEMBER-01.
- **PRIV-01:** `tests/application/projections.test.ts`, coordinator shared-plan scenario, worker alias scenario and `tests/adapters/muse.test.ts` minimized extraction.
- **PRIV-02:** `tests/persistence/conversation.test.ts` deletion scenario; `tests/persistence/store.test.ts` pending inbox/outbox deletion and pending-joiner notices.
- **CON-01 / FEAS-01:** domain CONSTRAINT-01..04, DIETARY-01, FEASIBILITY-01..02, TRAVEL-01, PRICE-01; application candidate-slot intersection, all-day and bounded-input scenarios.
- **CAL-01:** domain CALENDAR-01; `tests/adapters/security.test.ts` authenticated encryption and Google scope; Postgres single-use OAuth and delayed-exchange disconnect scenarios.
- **RES-01 / DIET-01:** domain EVIDENCE-01..04, ALLERGY-01, FEASIBILITY-03 and VENUE-01; `tests/adapters/{muse,sources}.test.ts`; staged staff-report scenarios in coordinator acceptance tests.
- **PROP-01 / REV-01 / AGR-01:** domain PROPOSAL-01..02, AGREEMENT-01 and REVISION-01; coordinator stale buttons and scope changes; database conversation fresh-confirmation scenario.
- **MED-01:** domain DISPUTE-01..03 and MEMBER-02; database objection/alternative scenario.
- **FIN-01:** domain ICS-01..02 and database export scenario; adapter tests prohibit unsourced booking assertions.
- **OPS-01:** `tests/persistence/store.test.ts` inbox/outbox rollback, replay, CAS concurrency, leases, ambiguity and retry bounds; HTTP durable enqueue/retryable failure; Telegram delivery classification.
- **OPS-02:** domain REMINDER-01..03; worker opt-out/stale-day suppression; database global reminder reservation and usage counters.
- **EVAL-01:** `evals/v1/cases.json` and `scripts/evaluate-muse.ts` provide the live evaluation harness. Execution requires a Muse key; critical failures block release. Deterministic privacy/auth tests above exercise application enforcement separately.

- **UI-01 / UI-02:** coordinator planner-entry tests; `web/src` form/time tests; browser mobile form scenarios.
- **UI-03 / UI-04 / UI-05 / UI-06:** `tests/miniapp` signed auth tests and `tests/persistence/miniapp.test.ts` private staging, approval, independent forms, deduplication and two-person replanning. Research fingerprint checks in `tests/application/research-version.test.ts`; legacy four-person conversation verifies compatibility.

- **UI-07 / UI-08:** `web/tests/brand.test.tsx`, frontend follow-up editor/budget scenarios and `web/browser/layout.pw.ts` exercise branding, native control containment, mobile stacking and availability editing. Browser scenarios run in Chromium and iPhone WebKit.
- **CANCEL-01:** domain cancellation scenarios; `tests/persistence/miniapp.test.ts` terminal lifecycle, privacy cleanup, notification deduplication and racing provider/confirmation; worker/coordinator cancellation scenarios protect delivery, legacy commands and privacy opt-out; frontend cancellation confirmation and read-only views.

- **SHARE-01:** real-Postgres sharing/revocation/inherited-field scenarios, `tests/persistence/research.test.ts`, frontend sharing preview and terminal revocation tests, and mobile sharing/research browser flows.
- **RES-02:** adapter typed error and malformed output tests, real-Postgres `research-flow.test.ts` safe 401/retry conversation, research lifecycle reconciliation tests, and organizer/member diagnostic UI isolation.

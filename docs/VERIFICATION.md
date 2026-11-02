# Verification record

2026-10-29, local implementation verification. All participant names, conversations and venue evidence in deterministic tests are synthetic.

- `npm run typecheck`: passed.
- `npm test`: 80 scenarios passed across nine files, with database suites deliberately excluded from this command.
- `npm run test:db:embedded`: 19 scenarios passed against real PostgreSQL in disposable schemas. Includes the four-person invitation/consent/approval → researched options → objection → suitable alternative → schedule change → renewed unanimous confirmation → calendar export conversation, plus transactional rollback, duplicate processing, concurrency, OAuth cancellation and deletion.
- `npm run build`: passed.
- `npm audit`: zero reported vulnerabilities, including development dependencies.
- Formatting and whitespace checks passed.
- `npm run test:live`: blocked, exit code 2. `TELEGRAM_BOT_TOKEN` and `MODEL_API_KEY` were absent. No live provider success was inferred from fixture results.

Source research has deterministic protocol and evidence checks, including citation membership, public HTTPS/DNS/redirect restrictions, source excerpt presence, claim-specific dietary and currency/basis checks, and explicit opening-hour schedules. These checks are conservative and cannot establish restaurant staff accommodation or guarantee source truth. Unsupported formats remain unresolved. Allergy reports require the affected participant's separate affirmative interaction.

Not executed: deployed Telegram conversation, actual Muse extraction/search evaluation, interactive Google authorization/publication review, Railway deployment, real-group trial, demonstration recording, and official submission. Follow INTEGRATIONS.md and TRIAL.md when credentials, a consenting group and the official event page are available. These remain live-feature release gates; no scope reduction has been accepted.

## Render startup follow-up

The Docker startup now applies migrations before starting the application, so Render does not require a separate pre-deploy hook. Two startup regression tests passed: successful migrations precede the server, and migration failure aborts startup. Typecheck and build passed. The real-Postgres suite now passes 20 scenarios, including concurrent migration reruns preserving schema versions and stored state. No Render deployment was performed by this change.

Before publishing the implementation to GitHub, the full suite passed: 82 unit/application/deployment scenarios and 20 real-Postgres scenarios, plus typecheck, build and formatting checks. The publishable files were checked for configured credentials and private-key material; `.env` remains excluded from Git. Live Render deployment status is verified separately from these local checks.

## Mini App redesign — 2026-11-01

The planner now uses React forms served by the existing Fastify service, with shared organizer settings and a two-person default (2–6 supported). Verification used synthetic participants and restaurant evidence only.

- TypeScript checks and production server/frontend builds passed.
- 97 server/domain/adapter/deployment tests and 13 frontend tests passed.
- 38 real PostgreSQL tests passed, including two-person versioned agreement, private staged responses, approval races, independent form saves, stale selections, receipt replay after revision/withdrawal/deletion, stale allergy attestations on replaced venues, and the legacy four-person objection/schedule-change conversation.
- Five mobile Chromium flows passed, covering creation, availability, approval, research/confirmation, guest consent, shared-detail changes during polling, deletion and outside-Telegram privacy. The final browser pass uses the production bundle served by Fastify with production CSP/cache headers.
- Mobile light/dark screenshots were inspected; no clipping was observed. Independent review findings were resolved and covered by regressions, including stopped-host recovery and clearing obsolete calendar checks when returning to manual planning.
- `npm audit` reported zero vulnerabilities; whitespace checks passed.
- Full Docker image build could not run because the local Docker daemon was stopped. The same Node 22 TypeScript/Vite build steps and container startup-order regression tests passed.

At the time of the local checks above, this change had not yet been deployed to Render or registered as the live bot menu. The subsequent `8865107` deployment succeeded and its Telegram menu/webhook were verified. Real Telegram WebView behavior, Google authorization, provider research and a consenting two-person trial remain live checks after rollout. No live-feature scope was reduced.

## iPhone usability and cancellation — 2026-11-02

- TypeScript checks and the production server/frontend builds passed.
- 101 core tests, 22 frontend tests and 40 real PostgreSQL tests passed. Cancellation coverage includes consent/organizer authorization, duplicate requests, seven-day retention, pending-answer and legacy-stage cleanup, private views, replacement dinner creation, and racing leased research/confirmation without resurrection.
- 16 browser scenarios passed against the production bundle served by Fastify, across Chromium and iPhone WebKit. Layout checks cover creation, shared details and availability at 393px and 320px widths; controls stack and remain inside their containers. CI now installs both engines.
- Mobile light/dark availability and cancellation screenshots were inspected. Branding, per-person budget wording, single-editor apply/edit/remove behavior and irreversible cancellation confirmation were verified.
- Independent review found two medium issues; regressions now cover dinner-timezone summary formatting during a browser-only DST gap and removal of legacy pending private stages scoped to the cancelled dinner.
- Cancellation is a terminal JSON state using the existing `ended_at`; no database migration is required. Existing dinner and proposal data remains compatible with the updated service.
- No live participant dinner was cancelled during automated verification. Actual iPhone Telegram WebView feedback remains a user trial after deployment.

## Answer sharing and research diagnostics — 2026-11-02

- TypeScript checks and production builds passed. 106 core tests, 31 frontend tests, 49 real PostgreSQL scenarios and 20 Chromium/iPhone WebKit browser scenarios passed.
- Sharing tests cover explicit preview/opt-in, private defaults for existing clients, approved-member isolation, stale enable/revoke, receipt replay after revocation, unseen retained constraints after rejoining, and revocation after cancellation. Browser screenshots of light/dark previews, party answers and organizer diagnostics were inspected without clipping.
- Research tests cover safe provider error categories, malformed/incomplete output, completed search enforcement, progress messages before final JSON, provider-attested source URLs, independent source checks, owner/member diagnostic isolation, manual retry, cancellation and orphaned-job recovery. Independent review found no remaining actionable findings after inherited-field sharing and lifecycle regressions were fixed.
- Actual `/responses` calls accepted the existing credential. The original request failed with HTTP 400 because `tool_choice: "required"` is unsupported; only `"auto"` is accepted. A second incompatibility was concatenating progress messages with the final structured answer. Both were reproduced and corrected. An earlier `/models` discovery rejection was not valid evidence of a bad `/responses` credential; no credential replacement was needed.
- A live public synthetic Chicago/Loop two-person search completed with two venues and two options. Structured JSON supplied no inline citation annotations, so completed provider search results are requested as URL provenance. Independent checks still yielded zero verified claims, eight unresolved claims and one failed source fetch in the final smoke check. These are provisional options, not evidence of feasible agreement or restaurant accommodation. Conservative evidence rules were preserved.
- Migration 005 adds durable research attempt records and is applied by the existing startup migration runner. No private participant input or live dinner was changed for these checks. A consenting Telegram trial and full Google authorization/publication checks remain separate live gates.

## Multiple dinners — 2026-11-02

- 111 core tests, 40 frontend tests and 57 real PostgreSQL scenarios passed. Independent frontend TypeScript checks passed. The production server build passed.
- 24 mobile Chromium/iPhone WebKit scenarios passed across the full run and a focused rerun of four layout checks. Their mock API was updated to support the explicit selection mutation; no production layout workaround was needed. New browser cases cover grouped lists, names, metadata-only renaming of an agreed plan, late polling responses, explicit dinner/create/invitation links and an 80-character unbroken name.
- Migration 006 replaces the unique active-organizer index with a nonunique lookup index. A real-Postgres upgrade test reconstructs the prior index with an existing dinner, applies the migration, creates another dinner and reruns concurrent migrations without changing stored dinner state.
- Capacity tests enforce five under concurrent creation, reject a sixth without duplicate retries, retain consent-blocked ownership, exclude joined dinners, free a cancelled slot, and distinguish a custom per-organizer cap from global service capacity.
- Cancellation isolation preserves another dinner's aggregate, sharing, confirmations, invitation, OAuth state, credentials and queued research. Account-wide stop/delete and selective resumption are covered across two owned dinners and one joined dinner.
- Review findings were reproduced and fixed: named onboarding prompts must remain deliverable before consent, chooser labels must fit Telegram limits, and a new selection after an ambiguous network failure must use a fresh request ID rather than replay an old focus receipt. Independent review reported no remaining findings in the bounded changes.
- Dependency audit reported zero vulnerabilities, and the publishable tree contained no configured production credentials. No live dinner was created, renamed or cancelled during automated verification. Actual Telegram WebView feedback remains a user trial after rollout.

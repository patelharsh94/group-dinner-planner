# Architecture decisions

## ADR-001: one Node.js/TypeScript service

Fastify exposes webhook, OAuth, privacy, support, health, authenticated Mini App APIs and scoped `/app/` static assets. grammY implements Telegram transport. Domain rules are pure functions; orchestration authenticates actors; adapters perform external IO; Postgres is authoritative. No runtime multi-agent system, Redis or separate queue service. Render or Railway runs one process with database jobs. Node 22 is the deployment baseline.

## ADR-002: versioned aggregate and transactional inbox/outbox

Dinner state is a Zod-validated JSONB aggregate with revision CAS inside a Postgres transaction. Immutable proposal snapshots and version-bound confirmations remain inside the aggregate and are also archived as appropriate by persistence. Inbox update IDs and outbox deduplication keys are unique. Transactional changes queue authorized work before acknowledging processing. Failed transactions may retry; uncertain Telegram sends may not. This favors correctness at the small v1 scale over normalized-query flexibility. JSONB still contains sensitive data; database access and backups require restricted access and retention controls.

## ADR-003: least-context model execution

Muse produces typed proposals, never authorizations or confirmations. Extraction contains only the actor's own private constraints and current message. Restaurant research uses anonymous aggregate requirements and plan parameters; it contains no raw conversations, names or calendar events. Output is parsed using Zod. Shared messages use fixed application templates. Research does not auto-fetch arbitrary model URLs, avoiding SSRF; evidence URLs must be public HTTPS and attested by completed provider search results or citation annotations. Only URLs used by structured claims are fetched, with a 16-source cap, public DNS/redirect checks, excerpt matching and claim-specific validation. Provider search provenance alone does not verify a claim. Source truth and allergy accommodation still require human verification.

## ADR-004: identity-bound optional Google connection

Only `calendar.freebusy`, primary calendar, no event contents or writes. Random state hashes bind a short expiry and one use to a Telegram actor and dinner. AES-256-GCM protects tokens; stable encryption key is mandatory. After browser authorization the original Telegram participant explicitly activates the staged connection, preventing an intercepted link from silently substituting someone else's calendar. Disconnected/revoked access never disables the manual path.

## ADR-005: bounded, conservative agreement

Everyone approved is required. Model prose cannot relax requirements. All material changes invalidate all confirmations. Unknown firm evidence and unresolved objections block agreement. At most two revised rounds per disagreement, then organizer escalation. Reservation status remains handoff only; the bot never books or changes a booking.

## ADR-006: verification levels

Vitest acceptance IDs link to SPEC.md. Real Postgres tests check locks, races, retries, rollback and deletion. Provider protocol tests use clearly labeled fixtures. Opt-in live checks use actual credentials and make no bookings. A real trial and submission are tracked separately; passing local tests does not establish them.

## ADR-007: form-based Telegram coordination

React/Vite builds a mobile Mini App served by the existing Fastify process, avoiding another service, hosting account or domain. Inline and menu Web App buttons carry Telegram-signed identity. Server validation of each request plus trusted private bot session and current membership protects APIs; no browser identity override exists. One host form owns location/timezone and a required per-person budget; group size includes dates for two. Each guest supplies willingness, so a suggested host time never becomes silent availability.

Pending guest responses live in the validated aggregate's private join request until approval claims a place atomically. API projections whitelist shared plan fields and the caller's own inputs. Per-user form hashes bind shared settings and own inputs without rejecting unrelated concurrent saves. Database action receipts persist request hashes/results in the same transaction as state and outbox effects. Research fingerprints bind planning inputs while ignoring delivery/reminder metadata; pending searches coalesce and obsolete results are silent. Telegram messages focus on milestones; forms and dashboards show routine feedback.

## ADR-008: cancellation ends one dinner without deleting its history

Whole-dinner cancellation is an organizer-authorized terminal transition, distinct from personal opt-out and deletion. A cancelled domain state and the existing database end timestamp commit together, freeing the organizer's active-dinner slot and starting seven-day retention. Queued work, invitation/OAuth links, scoped calendar credentials, staged guest answers and legacy private stages are removed atomically. Immutable proposal history remains; repeated requests neither resend notices nor reset the timestamp. Delivery rechecks consent and allows only typed cancellation notices after cancellation. Provider results and privacy flows cannot restore active planning. Restaurant bookings and previously exported calendar events require manual cleanup.

## ADR-009: participant-controlled answer sharing

Manual form answers remain private unless their author reviews an exact preview and opts in. Approved members receive an explicit projection of availability, food requirements, preferences, personal budget and travel input. Chats, calendar busy data and staff conversations are excluded. Grants bind the author's current form version; omitted sharing input, unseen inherited fields and private chat edits cannot publish new answers. Revocation accepts stale forms and remains available after dinner cancellation or completion. Idempotent receipt replay projects current permissions instead of restoring a revoked grant.

## ADR-010: durable, sanitized research diagnostics

An additive research_runs table records each queued attempt, stages, safe error categories, HTTP status, provider request identifier, timing and aggregate evidence counts. Members see a basic outcome; only the organizer receives diagnostic details and remediation. Provider response bodies, prompts and private answers are never retained in diagnostic records or operational logs. The outbox job identifier doubles as a support reference. Cancellation, supersession, exhausted retries and retention reconcile attempts transactionally. Retries remain explicit.

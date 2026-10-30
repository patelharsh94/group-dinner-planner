# Architecture decisions

## ADR-001: one Node.js/TypeScript service

Fastify exposes only webhook, OAuth, privacy, support and health routes. grammY implements Telegram transport. Domain rules are pure functions; orchestration authenticates actors; adapters perform external IO; Postgres is authoritative. No runtime multi-agent system, Redis or separate queue service. Railway runs one process with database jobs. Node 22 is the deployment baseline.

## ADR-002: versioned aggregate and transactional inbox/outbox

Dinner state is a Zod-validated JSONB aggregate with revision CAS inside a Postgres transaction. Immutable proposal snapshots and version-bound confirmations remain inside the aggregate and are also archived as appropriate by persistence. Inbox update IDs and outbox deduplication keys are unique. Transactional changes queue authorized work before acknowledging processing. Failed transactions may retry; uncertain Telegram sends may not. This favors correctness at the small v1 scale over normalized-query flexibility. JSONB still contains sensitive data; database access and backups require restricted access and retention controls.

## ADR-003: least-context model execution

Muse produces typed proposals, never authorizations or confirmations. Extraction contains only the actor's own private constraints and current message. Restaurant research uses anonymous aggregate requirements and plan parameters; it contains no raw conversations, names or calendar events. Output is parsed using Zod. Shared messages use fixed application templates. Research does not auto-fetch arbitrary model URLs, avoiding SSRF; evidence URLs must be public HTTPS and be present in search citations before they can support claims. Source truth and allergy accommodation still require human verification.

## ADR-004: identity-bound optional Google connection

Only `calendar.freebusy`, primary calendar, no event contents or writes. Random state hashes bind a short expiry and one use to a Telegram actor and dinner. AES-256-GCM protects tokens; stable encryption key is mandatory. After browser authorization the original Telegram participant explicitly activates the staged connection, preventing an intercepted link from silently substituting someone else's calendar. Disconnected/revoked access never disables the manual path.

## ADR-005: bounded, conservative agreement

Everyone approved is required. Model prose cannot relax requirements. All material changes invalidate all confirmations. Unknown firm evidence and unresolved objections block agreement. At most two revised rounds per disagreement, then organizer escalation. Reservation status remains handoff only; the bot never books or changes a booking.

## ADR-006: verification levels

Vitest acceptance IDs link to SPEC.md. Real Postgres tests check locks, races, retries, rollback and deletion. Provider protocol tests use clearly labeled fixtures. Opt-in live checks use actual credentials and make no bookings. A real trial and submission are tracked separately; passing local tests does not establish them.

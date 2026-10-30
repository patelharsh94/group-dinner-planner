# Group Dinner Planner v1 — normative contract

Version 1.0.0, 2026-10-28. This document overrides background briefs and draft prompts. MUST denotes required application behavior. Requirement IDs appear in executable Vitest test names and `specs/`. Fixtures are test/rehearsal data only.

## Scope and setup

- **SET-01** A private Telegram organizer creates one active dinner for 3–6 intended attendees, including themselves, in one destination city. Setup MUST collect city, bounded search area, date window, IANA timezone, currency, duration, budget amount and basis, and intended attendee names. Timezone and currency require explicit confirmation. Defaults offered for confirmation: next two weeks, 90 minutes. The trial city MUST NOT be hardcoded.
- **SET-02** Dates with missing zones, ambiguous relative wording, invalid local times, or DST ambiguity MUST be clarified; the system MUST NOT silently choose an interpretation. All intervals are stored as offset-bearing instants; local display uses the dinner timezone. Revisions are allowed only before the active dinner starts.

## Identity and privacy

- **JOIN-01** Dinner invitations are unguessable, dinner-specific and expire. Starting the bot with an invitation grants neither consent nor membership. Each person must explicitly consent to Muse processing of their input and sharing of plan details (attendees, venue, time, duration, cost and reservation handoff). The organizer must approve each joining membership. All approved members, including the organizer, are required by default.
- **AUTH-01** Every action MUST authenticate the private Telegram sender, bind to the correct dinner, verify consent/approved role and expected state revision, and reject unauthorized actions. Display names, usernames, model instructions and forwarded messages confer no authority. Group-chat updates MUST NOT initiate dinner processing.
- **PRIV-01** Private requirements, raw messages, calendar busy intervals and OAuth credentials MUST NOT appear in another member's context or shared summaries. Muse extraction gets the requesting member's input and constraints; research gets anonymous aggregated requirements and authorized setup. Public summaries use fixed application projections, never unreviewed model prose. Operational logs exclude request bodies, query strings, tokens and conversations.
- **PRIV-02** `/stop` withdraws participation and cancels pending communication; required membership MUST NOT silently disappear. `/delete` removes the requesting user's constraints, consent, credentials and pending private work; affected dinners remain blocked until an explicit membership decision. Deleting the organizer deletes the dinner. Dinner-scoped data expires seven days after dinner end/window end. Privacy, support and disconnect commands MUST be available before joining.

## Collection, research and feasibility

- **CON-01** Manual availability supports the entire workflow. Patch updates preserve unaffected requirements and record firm versus flexible input. Explicit willingness is mandatory; free calendar slots alone do not establish willingness.
- **CAL-01** Optional Google access requests only primary-calendar free/busy. OAuth state is random, expiring, single-use and bound to the requesting member/dinner. Token credentials are encrypted with authenticated encryption. A browser callback only stages credentials: the requesting Telegram identity must activate the connection. Revocation and disconnect remove access; unavailable calendars are reported honestly and manual input continues.
- **RES-01** Live Muse web search discovers venues within the selected area. Each claim has a source URL, retrieval time and supporting evidence. Price, budget basis, opening, dietary, travel and reservation claims are distinct. Missing, stale or contradictory support remains unresolved. Cuisine is not dietary evidence. The runtime MUST never fabricate availability or claim a reservation exists.
- **FEAS-01** Deterministic code checks required attendance, explicit availability, known calendar conflicts, duration, area, budget basis, firm dietary requirements and travel limits. Unknown firm constraints block agreement. Flexible preferences may influence recommendations but MUST NOT silently become firm constraints or erase firm requirements.
- **DIET-01** Every firm dietary requirement needs specific venue evidence. Contradictory sources require resolution. An allergy remains provisional until that participant explicitly reports confirmation from restaurant staff for the proposed venue; another participant or the model cannot attest on their behalf. Their affirmative staff report is private evidence for their own allergy and may resolve a missing website claim, while contradictory or known negative sources still block agreement.

## Proposals and agreement

- **PROP-01** Present at most two researched options and recommend one active proposal. Choosing an alternative is an organizer action that creates a new active version. Every proposal snapshot is immutable.
- **REV-01** Material changes to time, venue, attendees, duration or price basis create a fresh proposal version and clear all confirmations. Constraint changes recheck feasibility and invalidate agreement. Historical buttons cannot confirm the new version. Existing reservations are never automatically modified.
- **MED-01** Objections are clarified privately. Preserve firm requirements; seek explicit willingness before relaxing flexible input. Permit at most two revised rounds per open disagreement, then escalate to the organizer. An unresolved required objection blocks agreement. A schedule change initiates research/replanning rather than retaining agreement.
- **AGR-01** Agreement requires every required approved participant to explicitly confirm the current feasible version. Silence, messages sent, a free calendar, tentative responses and model-generated decisions never count. Concurrency MUST NOT allow a confirmation to race past a material revision.
- **FIN-01** An agreed plan provides a correct `.ics` event with stable UID, version/sequence, UTC instants and escaped/folded text, plus a sourced reservation link or explicit manual handoff. Booking status always distinguishes handoff from an actual booking. No bookings, payments, calendar writes, automated restaurant contact or travel booking in v1.

## Reliability and communication

- **OPS-01** Authenticate Telegram webhooks with a secret header; durably deduplicate update IDs. Atomically persist dinner state, inbox completion and outbound work. Use transactional state version checks. Recover pending work after restart. Outbound network ambiguity MUST be recorded and MUST NOT trigger blind resend; successful delivery is not agreement.
- **OPS-02** Notify the organizer at setup, collection completion, proposals, agreement and blockers. Shared updates contain aggregate progress only. Reminders require opt-in, at most once per participant per dinner-local date, and only 09:00–20:59 local time. Recheck delivery eligibility at send time. Rate and usage limits are configurable.
- **EVAL-01** Versioned Muse evaluations cover extraction, follow-ups, disagreement, dietary search, privacy probes and prompt injection. Evaluate structured decisions and source grounding, not exact wording. Critical authorization/privacy failures block release. Live checks and real-group trial are distinct from deterministic fixtures.

## Release acceptance

The defining demo is: four consenting attendees join privately; Muse researches two sourced choices; a dietary objection and a schedule change force a suitable alternative; all required people freshly confirm the same version; an accurate calendar export and reservation handoff follow. A real-group trial, working credentials, Google publication review and official submission requirements are release gates, never implied by passing fixture tests. Scope reductions require an explicit user decision.

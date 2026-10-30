# Group Dinner Planner

A Telegram dinner coordinator powered by Muse. An organizer delegates dinner planning, the bot gathers input from friends in private chats, and the organizer receives meaningful progress updates and decisions requiring their attention.

## Status

The Node.js/TypeScript service, migrations, Telegram workflow, Muse and Google adapters, tests, and Railway configuration are implemented. Live provider verification, a real-group trial and submission remain gated on credentials, consenting participants and official event instructions. Tests use labeled synthetic data and never substitute fixtures into the live bot.

The normative contract is [SPEC.md](SPEC.md); architecture choices are in [DECISIONS.md](DECISIONS.md). Background briefs below are historical context.

## First version

- Dinner for 3–6 friends in one city.
- Dinner-specific invitations and participant onboarding through a Telegram bot.
- Private availability and preferences, two proposed plans, and revisions when constraints change.
- Explicit confirmation of the same plan version by all required participants.
- Organizer milestone updates, calendar export, and an accurate reservation handoff.

## Planning documents

- [Product brief](group-dinner-product-brief.md): scope, user journey, behavior, demo and validation.
- [Planning prompt](group-dinner-planning-prompt.md): reusable prompt for product and implementation planning.
- [Telegram coordinator prompt](telegram-dinner-coordinator-prompt.md): draft runtime behavior and application enforcement boundaries.
- [Superseded WhatsApp prompt reference](whatsapp-dinner-coordinator-prompt.md): redirect retained for historical links.

## Run locally

Use Node 22.13 or newer and PostgreSQL 17 or newer.

```sh
npm ci
cp .env.example .env
# Fill in DATABASE_URL, Telegram token/username, public HTTPS URL, support contact,
# webhook secret (24+ random URL-safe characters) and a 32-byte base64 encryption key.
# Add MODEL_API_KEY for live extraction/research; Google credentials are optional.
npm run db:migrate
npm run dev
```

Local `.env` values load automatically; environment variables provided by hosting take precedence. The encryption key must remain stable across restarts. An HTTPS endpoint reachable by Telegram is needed for the webhook. Once deployed, `npm run telegram:register` registers the authenticated webhook. The service does not register or replace webhooks on startup.

See [integration setup and release gates](docs/INTEGRATIONS.md) for Google consent-screen publication, scopes, provider protocol references and Render/Railway deployment. The Docker image runs migrations before starting the app, so Render's separate Pre-Deploy Command can stay empty. Manual willingness works without Google; live restaurant research requires Muse access and usable public source evidence.

## Private Telegram workflow

1. Organizer sends `/new`, completes the focused setup questions, then reviews timezone, currency, budget basis and attendees before `/create`. The default is 90 minutes and a two-week window; windows are bounded to 31 days.
2. Share the dinner invitation. Each friend selects their assigned name and consents; the organizer verifies identity and approves the membership request.

Before dinner begins, the organizer can `/add_attendee NAME` up to six intended people. Joining, consent, approval and new confirmations are required; earlier private requirements remain intact. 3. Each person privately describes their requirements. Muse extracts a patch for explicit review. Manual commands work without model extraction:

```text
/availability 2026-11-06T18:00:00-06:00 2026-11-06T22:00:00-06:00
/constraints {"dietary":[{"requirement":"vegan","strength":"firm","allergy":false}],"budget":{"amount":50,"strength":"firm"}}
```

`/availability` replaces your willingness windows with that one interval; `/constraints` accepts an array of windows. Other fields are preserved. Dietary additions merge with existing requirements. `/remove_diet EXACT_REQUIREMENT` and `/remove_limit budget|travel` explicitly withdraw your own limits. Times require explicit offsets; ambiguous local dates are clarified.

4. Research starts after availability collection, or the organizer sends `/research`. At most two sourced options appear. Option 1 is active; the organizer can `/select 2`. Missing, stale or contradictory firm evidence blocks agreement. Source checks conservatively recognize explicit days/hours, dietary support, locations, prices and travel origins; unsupported page formats remain unknown.
5. `/change REASON` records a private objection, then provide the changed requirement. `/resolve` closes your own objection. Two revised rounds are allowed before escalation. Schedule/scope changes clear prior confirmations. Everyone required must explicitly confirm the current feasible version.
6. For allergies, `/staff VENUE_ID REQUIREMENT | what staff said` stages a report. A separate fixed-text button requires the affected person to affirm that staff said they can accommodate the allergy. Uncertain or negative staff responses must remain unresolved.
7. After agreement, `/export` sends `.ics` privately. Reservation status is a link or manual handoff; the bot makes no bookings or calendar writes, and replanning never changes an existing reservation.

`/calendar` connects primary free/busy only; `/calendar_activate` must come from the requesting Telegram identity. `/calendar_sync` refreshes; `/disconnect` removes access and explicitly returns to manual planning. Calendar evidence expires after 24 hours and must cover the proposed interval. `/reminders on` opts in, with local quiet hours and a global 24-hour limit. `/stop` withdraws consent, `/delete` erases private data, and `/resume` lets a stopped organizer explicitly reconsent. Use `/help`, `/privacy`, `/support` and `/status` at any point.

## Verify

```sh
npm run typecheck
npm test
npm run test:db:embedded
npm run build
npm audit
```

The embedded command starts isolated real Postgres on localhost:55439, creates disposable test schemas, runs persistence and full-conversation acceptance tests, and stops it. Alternatively set `TEST_DATABASE_URL` to a dedicated disposable database and run `npm run test:db`. CI uses PostgreSQL 17. The database tests include the objection → alternative → schedule change → fresh unanimous confirmation story, rollback, duplicate updates, concurrent writes, deletion and an OAuth disconnect race.

`npm run test:live` performs read-only Telegram/Muse checks and exits 2 when credentials are absent. `npm run eval:muse -- --research` runs the versioned live evaluation set. See [the trial checklist](docs/TRIAL.md) for the actual group and demo. Neither a deterministic test nor configured credentials establish successful live verification.

See [the verification record](docs/VERIFICATION.md) for executed checks and remaining release gates.

Never commit API tokens, calendar credentials, private conversations or real participant data.

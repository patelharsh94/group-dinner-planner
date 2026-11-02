# Group Dinner Planner

Dinner Planner is a Telegram dinner coordinator powered by Muse. An organizer delegates dinner planning, the bot gathers input from friends in private chats, and the organizer receives meaningful progress updates and decisions requiring their attention.

## Status

The Node.js/TypeScript service includes a React Telegram Mini App, migrations, Muse and Google adapters, tests, and Render/Railway configuration. Live provider verification, a real-group trial and submission remain gated on credentials, consenting participants and official event instructions. Tests use labeled synthetic data and never substitute fixtures into the live bot.

The normative contract is [SPEC.md](SPEC.md); architecture choices are in [DECISIONS.md](DECISIONS.md). Background briefs below are historical context.

## First version

- Dinner for 2–6 people in one city.
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
npm run build:web
npm run dev
```

Local `.env` values load automatically; environment variables provided by hosting take precedence. The encryption key must remain stable across restarts. An HTTPS endpoint reachable by Telegram is needed for the webhook. Once deployed, `npm run telegram:register` registers the authenticated webhook and the **Open planner** menu button. The service does not register or replace webhooks on startup.

See [integration setup and release gates](docs/INTEGRATIONS.md) for Google consent-screen publication, scopes, provider protocol references and Render/Railway deployment. The Docker image runs migrations before starting the app, so Render's separate Pre-Deploy Command can stay empty. Manual willingness works without Google; live restaurant research requires Muse access and usable public source evidence.

## Private Telegram workflow

1. Send `/start` or `/new`, then tap **Open planner**. Set the city, optional area, dates, party size (2–6) and per-person budget in one form. Timezone, currency and duration are visible editable settings owned by the organizer.
2. Pick your own willing dates, apply your available hours with one editor, and choose no food requirements or enter yours. Saved time ranges have Edit and Remove controls. Optional advanced settings cover personal budget, travel and preferences. No willing dates are preselected.
3. Share the dinner-specific invitation. Guests start the bot, open their private form, consent and submit once. The organizer approves their Telegram name; pending private responses stay out of planning until then.
4. Review up to two researched options in the dashboard. The organizer can choose the alternative. Each required attendee explicitly confirms the current feasible version. Missing or contradictory firm evidence blocks agreement.
5. Use **Request a change** and edit your response when needed. Material revisions clear confirmations. Two revised rounds per open disagreement are allowed before organizer escalation. Allergy accommodation requires the affected person's explicit staff confirmation.
6. After agreement, download the calendar file and use the reservation handoff. The bot never books, writes calendars or changes existing reservations.

The organizer can **Cancel dinner** in settings after reviewing a confirmation. This ends that dinner for everyone, stops planning and reminders, and allows a new dinner. Cancelled dinners remain read-only for seven days; existing reservations and downloaded calendar events need manual cleanup. **Stop coordination for me** remains a separate personal opt-out.

Calendar free/busy is optional; connect and activate it under settings. Manual availability works throughout. Reminders require opt-in. Privacy, stop and deletion are available in the app and via `/privacy`, `/stop`, `/delete`. Existing commands and in-progress chat setup drafts continue to work. `/help` opens the planner.

For frontend development, run `npm run dev:web` alongside `npm run dev`; Vite proxies `/api` to port 3000. The production build serves `/app/` and its APIs from the same Fastify process and HTTPS domain. Opening the app outside Telegram shows the bot link; there is no production authentication bypass. A public HTTPS URL, including the existing Render URL, is sufficient; a custom domain is optional.

Your form answers are private by default. The sharing checkbox previews availability, food requirements, preferences, budget and travel starting point before sharing them with approved members. **Party answers** shows only opted-in responses; calendar busy times, private chats and staff conversations are excluded. Sharing can be disabled in settings even after dinner ends or is cancelled.

**Latest research** distinguishes a queued search, a provider failure and options needing evidence checks. Organizers can expand **Research details** for a safe error code, stage, timestamp, HTTP status, retry guidance and support reference. Credentials belong in hosting configuration, never in the Mini App or chat. The live adapter uses Muse-supported `tool_choice: "auto"` and independently verifies that a live search actually completed.

## Verify

```sh
npm run typecheck
npm test
npm run test:db:embedded
npm run build
npx playwright install chromium webkit
npm run test:browser
npm audit
```

The embedded command starts isolated real Postgres on localhost:55439, creates disposable test schemas, runs persistence and full-conversation acceptance tests, and stops it. Alternatively set `TEST_DATABASE_URL` to a dedicated disposable database and run `npm run test:db`. CI uses PostgreSQL 17. The database tests include the objection → alternative → schedule change → fresh unanimous confirmation story, rollback, duplicate updates, concurrent writes, deletion and an OAuth disconnect race.

`npm run test:live` performs read-only Telegram/Muse checks and exits 2 when credentials are absent. `npm run eval:muse -- --research` runs the versioned live evaluation set. See [the trial checklist](docs/TRIAL.md) for the actual group and demo. Neither a deterministic test nor configured credentials establish successful live verification.

See [the verification record](docs/VERIFICATION.md) for executed checks and remaining release gates.

Never commit API tokens, calendar credentials, private conversations or real participant data.

Organizers can manage up to five active dinners at once (configurable with `MAX_ACTIVE_DINNERS_PER_ORGANIZER`, independently of service capacity). Add an optional name, switch through **Your dinners**, and rename ongoing plans in settings without resetting confirmations. Each dinner keeps separate participants, consent, answers, calendar connections and research. `/resume DINNER_ID` resumes one organizer role; `/stop` and `/delete` apply across all your dinners. Reminders remain limited to one per 24 hours per person across dinners.

# Group Dinner Planner

A Telegram bot that plans group dinners (2–6 people). The organizer sets up one dinner. Each guest answers privately. The bot suggests restaurants and tracks agreement.

No account or install needed to try it.

## Try it live

Open Telegram and start the bot:

**[t.me/FunPlannerBot](https://t.me/FunPlannerBot)**

Then:

1. Send `/start` and tap **Open planner**.
2. Fill in the city, dates, party size, and per-person budget.
3. Share the invite link with your group. Each guest opens it, consents, and submits their own dates and food needs privately.
4. Review the suggested options (up to two). Everyone confirms the same plan when ready.

After agreement, you get a calendar file and a reservation handoff. The bot never books tables for you.

Tips:

- The organizer approves each guest's Telegram name before their answers count.
- Use **Request a change** if plans shift. Big changes clear old confirmations so everyone re-confirms the new version.
- Commands: `/new` starts a dinner, `/help` opens the planner, `/privacy`, `/stop`, and `/delete` manage your data.

## How it works

- **Organizer:** creates the dinner, invites friends, picks between two researched options, sees milestone updates.
- **Guests:** answer only for themselves in a private chat. Answers stay private unless they opt in to sharing.
- **Agreement:** every required person must explicitly confirm the same plan version. Missing or conflicting info blocks agreement instead of guessing.
- **Changes:** objections and schedule changes trigger a re-check and fresh confirmations.

Details: [SPEC.md](SPEC.md). Design choices: [DECISIONS.md](DECISIONS.md).

Background docs:

- [Product brief](group-dinner-product-brief.md)
- [Planning prompt](group-dinner-planning-prompt.md)
- [Telegram coordinator prompt](telegram-dinner-coordinator-prompt.md)

## Run it yourself

You need Node 22.13+ and PostgreSQL 17+.

```sh
npm ci
cp .env.example .env
# Fill in DATABASE_URL, Telegram token/username, public HTTPS URL,
# support contact, webhook secret, encryption key, and MODEL_API_KEY.
npm run db:migrate
npm run build:web
npm run dev
```

Notes:

- The encryption key must stay the same across restarts.
- Telegram needs a public HTTPS URL for the webhook.
- After deploy, run `npm run telegram:register`. This sets the webhook and adds the **Open planner** menu button. Startup does not do this for you.
- For frontend work, run `npm run dev:web` alongside `npm run dev`. Vite proxies `/api` to port 3000.
- Opening the app outside Telegram shows the bot link. There is no login bypass.

Deployment, Google setup, and provider details: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

## Check your changes

```sh
npm run typecheck
npm test
npm run test:db:embedded
npm run build
npx playwright install chromium webkit
npm run test:browser
npm audit
```

The embedded DB test starts its own Postgres, runs persistence and full-conversation tests, then stops it. Or point `TEST_DATABASE_URL` at a disposable database and run `npm run test:db`. CI uses PostgreSQL 17.

Live checks (`npm run test:live`) need real credentials and exit 2 without them. They are read-only. See [docs/VERIFICATION.md](docs/VERIFICATION.md) and [docs/TRIAL.md](docs/TRIAL.md).

Never commit API tokens, calendar credentials, or real participant data.

## Limits

- One dinner: 2–6 people, one city.
- One organizer: up to 5 active dinners at once (see `MAX_ACTIVE_DINNERS_PER_ORGANIZER`).
- Reminders are opt-in, max one per person per 24 hours.
- Cancelled dinners stay read-only for 7 days. Cleanup of existing reservations and downloaded calendar events is manual.
- Calendar free/busy is optional. Manual availability always works.

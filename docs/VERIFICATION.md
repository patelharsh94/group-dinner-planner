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

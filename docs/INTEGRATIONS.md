# Integration verification and release gates

Reviewed 2026-10-28. Documentation was checked against official sources. No live Telegram token, Muse key, Google OAuth client or Railway deployment is included in this repository. A configured adapter is not evidence of a successful live integration.

- Telegram [Bot API](https://core.telegram.org/bots/api#setwebhook): authenticated webhooks use `X-Telegram-Bot-Api-Secret-Token`; retries require durable update deduplication. Private users must start the bot themselves. `npm run telegram:register` registers the deployed HTTPS endpoint and the **Open planner** Mini App menu without dropping pending updates. Inline/menu Mini Apps use server-validated Telegram `initData`; keyboard-button Mini Apps do not provide the identity proof required here. The existing Render HTTPS hostname is sufficient.
- Meta [Responses API](https://dev.meta.ai/docs/protocols/responses) and [search grounding](https://dev.meta.ai/docs/cookbook/search-grounding): `https://api.meta.ai/v1/responses`, Bearer `MODEL_API_KEY`, configurable `muse-spark-1.3`; structured output uses `text.format`, and web search is a Responses tool. Runtime sets `store:false`; provider account retention terms still apply. Live source verification rejects unsupported citations and unreachable/unsafe URLs; these remain unknown instead of being replaced with fixtures. Source interpretation remains subject to model error; participant staff affirmation is required for allergies.
- Google [scopes](https://developers.google.com/workspace/calendar/api/auth) and [free/busy](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query): request only `calendar.freebusy`, query only `primary`. Publish a privacy policy and register the HTTPS redirect URI `/oauth/google/callback`. Confirm the project's consent screen, testing audience and applicable sensitive-scope verification in Google Cloud before public onboarding. Testing restrictions and token lifetime can differ from production; do not claim public access from a developer-account trial.
- Railway: add Postgres, set required environment variables from `.env.example`, deploy Dockerfile, run the configured migration predeploy step, and check `/health` before registering the Telegram webhook. Store the credential encryption key as a stable secret; losing it makes stored tokens unusable. Use one replica for v1's conservative send throughput. Migrations and leases still enforce database consistency.

## Render deployment

Deploy the repository as a Docker web service in the same region as its Render Postgres database. Use one instance and `/health` as the health-check path. Set `DATABASE_URL` to the database's internal connection URL and supply the remaining environment variables from `.env.example`.

The Dockerfile runs migrations at container startup before starting the application. The migration runner is transactional, versioned and protected by a database advisory lock; restarts do not reapply completed migrations. If a migration fails, the container exits without starting the bot. The final `exec` passes shutdown signals directly to Node.

Leave Render's Pre-Deploy Command and Docker Command fields empty to use this startup behavior. A separate paid pre-deploy hook is not required. Once the service's generated HTTPS address is available, set `PUBLIC_URL` to that base address, redeploy, and run `npm run telegram:register` using the same public URL and webhook secret to register both the webhook and planner menu. The app is served at `${PUBLIC_URL}/app/`; no new secret, second service or custom domain is needed.

Render's free web services sleep after 15 minutes without incoming traffic. Background reminders, cleanup and job processing pause while asleep; this setup supports an initial interactive test, but the full always-on trial requires continuously running hosting. This limitation does not remove those features from the agreed scope. See [Render's Docker documentation](https://render.com/docs/docker) and [free-service limitations](https://render.com/docs/free).

## Checks to execute with actual credentials

1. `npm run test:live`: Telegram identity and actual Muse structured output. A blocked result exits 2 rather than reporting a pass.
2. `npm run eval:muse -- --research`: versioned extraction/privacy and actual live search/source checks. Investigate every failure; privacy or authorization failures block release.
3. Three consenting people use `/calendar`, authorize their own account, then `/calendar_activate`. Verify primary busy exclusions, denial, token refresh, revoked access, state reuse/expiry, and disconnect during authorization. No calendar writes are performed.
4. Follow `docs/TRIAL.md` with the actual group, preserving only consented, redacted trial notes.

## Submission gate

The event and official submission URL were not identified in the source materials. No deadline, deliverable list, model eligibility rule, judging rubric or submission was invented. Obtain the official instructions and fill in `docs/TRIAL.md` before claiming submission readiness. No live-feature scope reduction has been accepted.

# Live trial and demonstration

Status: not executed. Deterministic tests use explicitly synthetic participants and venue evidence. Do not present them as live research or a real group trial.

## Preparation

Record the official event URL and submission requirements, test city/neighborhood, consenting 2–6 attendees, date window, timezone, currency and reservation handoff owner. Ensure the public privacy/support URLs are deployed and Google access audience is appropriate. Run local, database and live integration checks. Do not record private requirements or calendar contents in the demo.

## Defining demonstration

1. Organizer `/new`: complete setup and explicitly `/create` after timezone/currency/privacy review. Share the dinner invite.
2. Friends select their names, consent, and wait for organizer approval. Each privately states willingness, firm dietary needs, flexible preferences and travel limits. Manual availability must work without Google.
3. Muse performs live research. Show at most two sourced options, explicit unknowns, one active recommendation and reservation status. A model failure must appear as a blocker, never fixture substitution.
4. One person privately objects. Record it with `/change`, clarify firmness and update their constraints. Muse researches an alternative. Close the objection with `/resolve` only when addressed.
5. Before dinner, another person changes their schedule. Confirm all earlier confirmations are cleared; try an old button to show it is stale. Research a feasible new version. An allergy requires that person's explicit staff affirmation; uncertainty remains provisional.
6. Every required participant explicitly confirms the fresh feasible version. Export `.ics`; compare time, duration, timezone and venue. Open the reservation link or make an explicit manual handoff. Existing reservations are not changed by replanning.

## Evidence and outcome

Capture organizer active time, elapsed time to agreement, join/completion counts, follow-ups, number of revisions, any firm constraint violations, whether the dinner occurred, and qualitative feedback. Redact private details and do not infer general effectiveness from one trial. Record remaining blockers, fixes and rerun results. Prepare the demo recording and deliverables to match the official submission page, then obtain actual submission confirmation.

## Mini App rollout check

Redeploy the current commit to the existing Render web service; startup applies migration 004 and the Docker build includes `/app/`. Keep the existing secrets and domain. Run `npm run telegram:register` to refresh the authenticated webhook and add the planner menu. In a real private Telegram chat, send `/start`, create a dinner for two and share its invitation; verify a second account can start, consent, submit and receive approval. Check real iOS/Android time pickers, Google external authorization/return, calendar-file download, and stale controls after an actual shared-detail change. A bot menu update alone does not deploy application code.

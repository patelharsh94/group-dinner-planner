# Observable acceptance conversations

Each requirement is exercised by named tests in `tests/domain`, `tests/application`, `tests/adapters` and `tests/persistence`.

1. **SET-01 / SET-02** Organizer starts setup; missing city/window/timezone/currency/budget basis elicits a focused question. A local time in a DST gap/overlap is rejected pending an explicit offset. Explicit setup review records timezone and currency confirmation.
2. **JOIN-01 / AUTH-01** Friend opens a dinner invite, sees privacy terms, actively consents, waits for organizer approval, then supplies private input. A stranger cannot approve themselves, read state, confirm or reuse another dinner's controls.
3. **CON-01 / CAL-01** Manual willingness remains required even when Google says free. A calendar conflict blocks the candidate. OAuth denial/revocation leaves manual entry usable. Expired/reused state fails; tokens are encrypted; the originating Telegram participant activates staged credentials.
4. **RES-01 / DIET-01 / FEAS-01** Cuisine-only allergy claims, missing price, unknown travel and conflicting sources leave a proposal provisional. A participant's own staff report can resolve their allergy for that venue. Other firm requirements remain unchanged.
5. **PROP-01 / MED-01 / REV-01 / AGR-01** Organizer selects one of two sourced options. A private objection leads to a revised option. Two unsuccessful rounds escalate. A schedule change clears old confirmations; old buttons fail. Every required person must confirm the new feasible version.
6. **FIN-01** Calendar export matches the current agreed instants, duration, venue and sequence; reservation text says link/manual handoff and never claims a booking.
7. **PRIV-01 / PRIV-02 / OPS-01 / OPS-02** A duplicate webhook is a no-op. A crash rolls back state and outbox together. Concurrent confirmation/change cannot agree an obsolete plan. Quiet hours and opt-out suppress reminders; deletion erases pending private payloads; retention sweeps dinner records.
8. **EVAL-01** Misleading participant/web-page instructions cannot authorize a send, expose another person's input, set confirmations or alter membership. Live runs measure structured outcomes and evidence with privacy/auth violations blocking release.

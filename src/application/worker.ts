import {
  ResearchFailure,
  classifyResearchFailure,
  researchGuidance,
  researchRetryable,
  type ResearchAttempt,
} from "./research.js";
import { researchVersion } from "./research-version.js";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  evaluateFeasibility,
  proposeOptions,
  reminderEligibility,
  setVenues,
  updateConstraints,
} from "../domain/index.js";
import { MuseClient, type ResearchContext } from "../adapters/muse.js";
import { GoogleCalendar, TokensSchema } from "../adapters/google.js";
import { decrypt, encrypt } from "../adapters/security.js";
import {
  deliveryError,
  TelegramTransport,
  type MessagePayload,
} from "../adapters/telegram.js";
import type {
  PgStore,
  ClaimedWork,
  DinnerRecord,
  DinnerTx,
} from "../persistence/store.js";
import { Coordinator } from "./coordinator.js";
import {
  AppDinnerSchema,
  IncomingSchema,
  authorized,
  canPlan,
  candidateSlots,
  type AppDinner,
} from "./model.js";

const JobSchema = z.object({
  dinnerId: z.string(),
  userId: z.string(),
  revision: z.number().int(),
  message: z.string().optional(),
  researchVersion: z.string().optional(),
});
export class Worker {
  private workerId = randomUUID();
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private ticks = 0;
  private stopped = false;
  private activeJobs = new Set<string>();
  constructor(
    readonly store: PgStore,
    readonly coordinator: Coordinator,
    readonly telegram: TelegramTransport,
    readonly muse?: MuseClient,
    readonly google?: GoogleCalendar,
  ) {}
  start(): void {
    this.stopped = false;
    void this.loop();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    while (this.running || this.activeJobs.size)
      await new Promise((resolve) => setTimeout(resolve, 20));
  }
  private async loop(): Promise<void> {
    if (this.stopped) return;
    this.running = true;
    try {
      await this.tick();
    } catch {
      console.error(JSON.stringify({ event: "worker_tick_failed" }));
    } finally {
      this.running = false;
      if (!this.stopped) this.timer = setTimeout(() => void this.loop(), 1000);
    }
  }
  async tick(): Promise<void> {
    await this.store.recoverLeases();
    // One process and a bounded batch respect Telegram global throughput. Jobs are database leased.
    await this.drainInbox();
    for (const kind of ["extract", "calendar", "research", "revoke"]) {
      if (this.activeJobs.has(kind)) continue;
      const work = await this.store.claimOutbox(this.workerId, 180000, kind);
      if (work) {
        this.activeJobs.add(kind);
        // Provider IO runs outside the inbox loop so stop/delete and changed constraints
        // can commit promptly. Result commits recheck the current authorization/revision.
        void this.runJob(work)
          .catch(() =>
            console.error(
              JSON.stringify({ event: "background_job_failed", kind }),
            ),
          )
          .finally(() => this.activeJobs.delete(kind));
      }
    }
    for (let i = 0; i < 10; i++) {
      await this.drainInbox();
      const work = await this.store.claimOutbox(this.workerId);
      if (!work) break;
      await this.send(work);
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    if (this.ticks++ % 30 === 0) {
      await this.sweep();
      await this.store.purgeExpired();
    }
  }
  private async drainInbox(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const work = await this.store.claimInbox(this.workerId);
      if (!work) break;
      try {
        await this.store.processInbox(work.id, this.workerId, (tx, payload) =>
          this.coordinator.handle(tx, payload),
        );
        const incoming = IncomingSchema.safeParse(work.payload);
        if (incoming.success && incoming.data.callbackId)
          await this.telegram
            .answerCallback(incoming.data.callbackId)
            .catch(() => {});
      } catch {
        await this.store.failInbox(work.id, this.workerId, "processing_failed");
      }
    }
  }
  async send(work: ClaimedWork): Promise<void> {
    const payload = work.payload as MessagePayload;
    const allowed = await this.store.transaction(async (tx) => {
      if (!payload.chatId || !payload.text) return false;
      // Replies follow an authenticated inbound request. Background dinner messages need live membership.
      if (!payload.dinnerId) return payload.reply === true;
      const record = await tx.getDinner<AppDinner>(payload.dinnerId);
      if (!record) return false;
      const state = AppDinnerSchema.parse(record.state);
      if (state.dinner.status === "cancelled") {
        return (
          payload.notification === "dinner-cancelled" &&
          !!state.consents[payload.chatId]?.active &&
          (state.dinner.members.some(
            (member) => member.id === payload.chatId,
          ) ||
            !!state.joinRequests[payload.chatId])
        );
      }
      if (
        payload.notification === "dinner-cancelled" ||
        !authorized(state, payload.chatId)
      )
        return false;
      if (
        payload.version !== undefined &&
        record.state.dinner.activeVersion !== payload.version
      )
        return false;
      if (payload.reminder) {
        if (record.endedAt) return false;
        if (
          payload.reminderDay !==
          DateTime.fromISO(this.coordinator.now())
            .setZone(record.state.dinner.setup.timezone)
            .toISODate()
        )
          return false;
        const eligibility = reminderEligibility(
          record.state.dinner,
          payload.chatId,
          this.coordinator.now(),
          [],
        );
        if (!eligibility.allowed) return false;
      }
      return true;
    });
    if (!allowed) {
      await this.store.markSuppressed(work.id, this.workerId);
      return;
    }
    try {
      await this.telegram.send(payload);
      await this.store.markSent(work.id, this.workerId);
    } catch (error) {
      const result = deliveryError(error);
      if (result.kind === "retry")
        await this.store.retryOutbox(work.id, this.workerId, result.delayMs);
      else if (result.kind === "failed")
        await this.store.markFailed(work.id, this.workerId);
      else await this.store.markAmbiguous(work.id, this.workerId);
      if (
        payload.dinnerId &&
        !payload.reply &&
        result.kind !== "retry" &&
        !payload.text.startsWith("Delivery blocker:")
      )
        await this.deliveryBlocker(payload.dinnerId, work.id, result.kind);
    }
  }
  private async deliveryBlocker(
    dinnerId: string,
    eventId: string,
    status: string,
  ): Promise<void> {
    await this.store.transaction(async (tx) => {
      const record = await tx.getDinner<AppDinner>(dinnerId);
      if (
        !record ||
        record.endedAt ||
        record.state.dinner.status === "cancelled"
      )
        return;
      await this.coordinator.message(
        tx,
        eventId,
        record.state.dinner.organizerId,
        `Delivery blocker: a planning message is ${status === "ambiguous" ? "uncertain" : "undelivered"}. No attendance confirmation was inferred. Participants can request /status.`,
        { dinnerId, key: `${eventId}:delivery-blocker` },
      );
    });
  }
  async runJob(work: ClaimedWork): Promise<void> {
    if (work.kind === "revoke") {
      try {
        const data = z
          .object({ encrypted: z.string(), context: z.string() })
          .parse(work.payload);
        if (this.google)
          await this.google.revoke(
            TokensSchema.parse(
              decrypt(
                data.encrypted,
                this.coordinator.config.CREDENTIAL_ENCRYPTION_KEY,
                data.context,
              ),
            ),
          );
        await this.store.markSent(work.id, this.workerId);
      } catch {
        await this.store.markFailed(work.id, this.workerId);
      }
      return;
    }
    const parsed = JobSchema.safeParse(work.payload);
    if (!parsed.success) {
      await this.store.markFailed(work.id, this.workerId);
      return;
    }
    const job = parsed.data,
      record = await this.store.readDinner<AppDinner>(job.dinnerId);
    if (
      !record ||
      record.endedAt ||
      !authorized(AppDinnerSchema.parse(record.state), job.userId)
    ) {
      await this.store.markSuppressed(work.id, this.workerId);
      return;
    }
    if (
      record.revision !== job.revision &&
      !(
        work.kind === "research" &&
        job.researchVersion === researchVersion(record.state)
      )
    ) {
      await this.stale(work, job.userId, record.id);
      return;
    }
    const startedMs = Date.now();
    try {
      if (work.kind === "research")
        await this.researchProgress(work, record, {
          status: "running",
          stage: "provider",
          startedAt: this.coordinator.now(),
        });
      if (work.kind === "extract") {
        if (!this.muse) throw new Error("Muse unavailable");
        const decision = await this.muse.extract({
          message: job.message ?? "",
          ownConstraints: record.state.dinner.constraints[job.userId] ?? {},
          timezone: record.state.dinner.setup.timezone,
          currency: record.state.dinner.setup.currency,
          now: this.coordinator.now(),
        });
        await this.commitResult(work, record, job.userId, (tx, current) =>
          this.coordinator.stageDecision(
            tx,
            current,
            job.userId,
            decision,
            work.id,
          ),
        );
      } else if (work.kind === "research") {
        if (!this.muse)
          throw new ResearchFailure("SERVICE_UNCONFIGURED", "provider");
        if (!canPlan(record.state))
          throw new Error("Required consent unavailable");
        const { context, aliases } = researchContext(
          record.state,
          this.coordinator.now(),
        );
        if (!context.slots.length)
          throw new ResearchFailure("NO_COMMON_TIME", "planning");
        const result = await this.muse.research(
          context,
          this.coordinator.now(),
          async (stage) => {
            await this.researchProgress(work, record, { stage });
          },
        );
        await this.researchProgress(work, record, { stage: "planning" });
        const counts = {
          venues: result.venues.length,
          options: result.options.length,
          verifiedClaims: result.verification?.verifiedClaims ?? 0,
          unresolvedClaims: result.verification?.unresolvedClaims ?? 0,
          sourcesFailed: result.verification?.sourcesFailed ?? 0,
        };
        await this.commitResult(
          work,
          record,
          job.userId,
          async (tx, current) => {
            const s = structuredClone(current.state),
              old = s.dinner;
            for (const venue of result.venues) {
              venue.evidence.travel = Object.fromEntries(
                Object.entries(venue.evidence.travel)
                  .filter(([alias]) => aliases[alias])
                  .map(([alias, claim]) => [aliases[alias], claim]),
              );
            }
            s.dinner = setVenues(
              old,
              old.organizerId,
              result.venues,
              this.coordinator.now(),
            );
            // Staff reports are venue-specific; preserve only when identity/address are unchanged.
            s.dinner.staffReports = old.staffReports.filter((report) =>
              result.venues.some(
                (v) =>
                  v.id === report.venueId &&
                  old.venues.some(
                    (before) =>
                      before.id === v.id &&
                      before.address === v.address &&
                      before.name === v.name &&
                      before.city === v.city &&
                      before.area === v.area &&
                      before.evidence.location.url === v.evidence.location.url,
                  ),
              ),
            );
            const candidates = result.options.filter(
              (option) =>
                result.venues.some((venue) => venue.id === option.venueId) &&
                context.slots.some(
                  (slot) =>
                    Date.parse(slot.start) === Date.parse(option.start) &&
                    Date.parse(slot.end) === Date.parse(option.end),
                ),
            );
            const ranked = candidates
              .map((option) => ({
                option,
                feasibility: evaluateFeasibility(
                  s.dinner,
                  option,
                  this.coordinator.now(),
                ),
              }))
              .filter((x) => x.feasibility.status !== "infeasible")
              .sort(
                (a, b) =>
                  Number(b.feasibility.status === "feasible") -
                  Number(a.feasibility.status === "feasible"),
              );
            if (!ranked.length) {
              await tx.updateResearchAttempt(work.id, {
                status: "needs_checks",
                stage: "done",
                code: "NO_SUITABLE_OPTIONS",
                finishedAt: this.coordinator.now(),
                updatedAt: this.coordinator.now(),
                durationMs: Math.max(0, Date.now() - startedMs),
                counts,
              });
              await this.coordinator.save(tx, current, s);
              await this.coordinator.message(
                tx,
                work.id,
                old.organizerId,
                "Research blocker: no supported suitable alternative was found. Requirements remain unchanged. Ask participants which preferences may change, or try live research again.",
                { dinnerId: record.id },
              );
              return;
            }
            s.dinner = proposeOptions(
              s.dinner,
              old.organizerId,
              ranked.slice(0, 2).map((x) => x.option),
              this.coordinator.now(),
            );
            await this.coordinator.save(tx, current, s);
            await tx.updateResearchAttempt(work.id, {
              status:
                ranked[0].feasibility.status === "feasible"
                  ? "succeeded"
                  : "needs_checks",
              stage: "done",
              ...(ranked[0].feasibility.status === "feasible"
                ? {}
                : { code: "EVIDENCE_UNRESOLVED" as const }),
              finishedAt: this.coordinator.now(),
              updatedAt: this.coordinator.now(),
              durationMs: Math.max(0, Date.now() - startedMs),
              counts,
            });
            await this.coordinator.announce(tx, s, work.id);
            if (s.dinner.status === "escalated")
              await this.coordinator.message(
                tx,
                work.id,
                old.organizerId,
                "Negotiation limit reached after two revised rounds. Resolve the remaining conflict explicitly; no firm requirement or attendee was removed.",
                { dinnerId: record.id },
              );
          },
        );
      } else if (work.kind === "calendar") {
        if (!this.google) throw new Error("Google unavailable");
        const stored = await this.store.transaction((tx) =>
          tx.getCalendarConnection(record.id, job.userId),
        );
        if (!stored) throw new Error("Calendar disconnected");
        const tokens = TokensSchema.parse(
          decrypt(
            stored,
            this.coordinator.config.CREDENTIAL_ENCRYPTION_KEY,
            `${record.id}:${job.userId}`,
          ),
        );
        const start = DateTime.fromISO(record.state.dinner.setup.windowStart, {
          zone: record.state.dinner.setup.timezone,
        })
          .startOf("day")
          .toUTC()
          .toISO()!;
        const end = DateTime.fromISO(record.state.dinner.setup.windowEnd, {
          zone: record.state.dinner.setup.timezone,
        })
          .endOf("day")
          .toUTC()
          .toISO()!;
        const result = await this.google.freeBusy(tokens, start, end);
        await this.commitResult(
          work,
          record,
          job.userId,
          async (tx, current) => {
            // A disconnect while IO was running must not resurrect credentials.
            if (
              (await tx.getCalendarConnection(record.id, job.userId)) !== stored
            )
              return;
            await tx.setCalendarConnection(
              record.id,
              job.userId,
              encrypt(
                result.tokens,
                this.coordinator.config.CREDENTIAL_ENCRYPTION_KEY,
                `${record.id}:${job.userId}`,
              ),
            );
            const s = structuredClone(current.state);
            s.dinner = updateConstraints(
              s.dinner,
              job.userId,
              {
                busy: result.busy,
                calendarStatus: "connected",
                calendarCheckedAt: this.coordinator.now(),
                calendarWindow: { start, end },
              },
              this.coordinator.now(),
            );
            const next = await this.coordinator.save(tx, current, s);
            await this.coordinator.message(
              tx,
              work.id,
              job.userId,
              "Primary calendar free/busy checked. Explicit willingness remains required. Prior confirmations are cleared; schedule feasibility will be checked again.",
              { dinnerId: record.id },
            );
            await this.coordinator.scheduleResearch(tx, next, work.id);
          },
        );
      }
    } catch (error) {
      await this.store.processWork(work.id, this.workerId, async (tx) => {
        const current = await tx.getDinner<AppDinner>(record.id);
        if (
          !current ||
          current.endedAt ||
          current.state.dinner.status === "cancelled" ||
          !authorized(current.state, job.userId)
        )
          return;
        if (work.kind === "research") {
          const now = this.coordinator.now();
          if (
            researchVersion(current.state) !== researchVersion(record.state)
          ) {
            await tx.updateResearchAttempt(work.id, {
              status: "superseded",
              stage: "done",
              updatedAt: now,
              finishedAt: now,
            });
            return;
          }
          const failure = classifyResearchFailure(error, "planning");
          await tx.updateResearchAttempt(work.id, {
            status: "failed",
            stage: failure.stage,
            code: failure.code,
            retryable: researchRetryable(failure.code),
            ...failure.metadata,
            updatedAt: now,
            finishedAt: now,
            durationMs: Math.max(0, Date.now() - startedMs),
          });
          console.error(
            JSON.stringify({
              event: "research_failed",
              reference: work.id,
              code: failure.code,
              stage: failure.stage,
              ...failure.metadata,
            }),
          );
          await this.coordinator.message(
            tx,
            work.id,
            job.userId,
            `${researchGuidance(failure.code)} Reference: ${work.id}`,
            {
              dinnerId: record.id,
              buttons: this.coordinator.plannerButtons({ dinner: record.id }),
            },
          );
          return;
        }
        if (work.kind === "calendar" && current.revision === record.revision) {
          await tx.disconnectCalendar(record.id, job.userId);
          const s = structuredClone(current.state);
          s.dinner = updateConstraints(
            s.dinner,
            job.userId,
            { calendarStatus: "unavailable" },
            this.coordinator.now(),
          );
          await this.coordinator.save(tx, current, s);
        }
        await this.coordinator.message(
          tx,
          work.id,
          job.userId,
          work.kind === "calendar"
            ? "Calendar access unavailable; the connection was removed. Known conflicts are preserved. Reconnect, or /disconnect to explicitly rely on manual availability."
            : work.kind === "research"
              ? "Live research failed or returned unsupported evidence. Venue gaps remain unresolved. Try /research again."
              : "I could not safely extract that input. Please clarify or use /availability and /constraints for explicit input.",
          { dinnerId: record.id },
        );
      });
    }
  }
  private async commitResult(
    work: ClaimedWork,
    record: DinnerRecord<AppDinner>,
    user: string,
    apply: (tx: DinnerTx, current: DinnerRecord<AppDinner>) => Promise<void>,
  ): Promise<void> {
    await this.store.processWork(work.id, this.workerId, async (tx) => {
      const current = await tx.getDinner<AppDinner>(record.id);
      if (
        !current ||
        current.endedAt ||
        current.state.dinner.status === "cancelled" ||
        !authorized(current.state, user)
      )
        return;
      if (
        current.revision !== record.revision &&
        !(
          work.kind === "research" &&
          researchVersion(current.state) === researchVersion(record.state)
        )
      ) {
        // A newer constraint save queues current research; stale provider results stay silent.
        if (work.kind === "research")
          await tx.updateResearchAttempt(work.id, {
            status: "superseded",
            stage: "done",
            updatedAt: this.coordinator.now(),
            finishedAt: this.coordinator.now(),
          });
        await this.refreshCalendarTask(tx, work, current, user);
        return;
      }
      await apply(tx, current);
    });
  }
  private async stale(
    work: ClaimedWork,
    user: string,
    dinnerId: string,
  ): Promise<void> {
    await this.store.processWork(work.id, this.workerId, async (tx) => {
      const current = await tx.getDinner<AppDinner>(dinnerId);
      if (work.kind === "research")
        await tx.updateResearchAttempt(work.id, {
          status:
            current?.endedAt || current?.state.dinner.status === "cancelled"
              ? "cancelled"
              : "superseded",
          stage: "done",
          updatedAt: this.coordinator.now(),
          finishedAt: this.coordinator.now(),
        });
      if (current) await this.refreshCalendarTask(tx, work, current, user);
    });
  }

  private async researchProgress(
    work: ClaimedWork,
    record: DinnerRecord<AppDinner>,
    patch: Partial<ResearchAttempt>,
  ): Promise<void> {
    await this.store.transaction(async (tx) => {
      const current = await tx.getDinner<AppDinner>(record.id);
      if (
        !current ||
        current.endedAt ||
        !authorized(current.state, record.organizerId)
      )
        return;
      let attempt = await tx.getResearchAttempt(work.id);
      if (!attempt)
        attempt = await tx.createResearchAttempt({
          id: work.id,
          dinnerId: record.id,
          inputVersion: researchVersion(record.state),
          requestedAt: this.coordinator.now(),
        });
      if (researchVersion(current.state) !== researchVersion(record.state)) {
        await tx.updateResearchAttempt(work.id, {
          status: "superseded",
          stage: "done",
          updatedAt: this.coordinator.now(),
          finishedAt: this.coordinator.now(),
        });
        return;
      }
      await tx.updateResearchAttempt(work.id, {
        ...patch,
        updatedAt: this.coordinator.now(),
      });
    });
  }
  private async refreshCalendarTask(
    tx: DinnerTx,
    work: ClaimedWork,
    current: DinnerRecord<AppDinner>,
    user: string,
  ): Promise<void> {
    if (
      work.kind !== "calendar" ||
      current.endedAt ||
      !authorized(current.state, user)
    )
      return;
    if (!(await tx.getCalendarConnection(current.id, user))) return;
    await this.coordinator.job(
      tx,
      work.id,
      "calendar",
      current.id,
      user,
      current.revision,
    );
  }
  async sweep(): Promise<void> {
    const now = this.coordinator.now();
    await this.store.transaction(async (tx) => {
      for (const record of await tx.listActiveDinners<AppDinner>()) {
        const s = AppDinnerSchema.parse(record.state),
          d = s.dinner;
        const active = d.proposals.find((p) => p.version === d.activeVersion),
          option = active?.options[active.selectedIndex];
        const end =
          d.status === "agreed" && option
            ? DateTime.fromISO(option.end)
            : DateTime.fromISO(d.setup.windowEnd, {
                zone: d.setup.timezone,
              }).endOf("day");
        if (end.toMillis() < Date.parse(now)) {
          await tx.saveDinner(
            { ...record, endedAt: end.toJSDate() },
            record.revision,
          );
          continue;
        }
        let changed = false;
        for (const member of d.members) {
          if (!authorized(s, member.id)) continue;
          if (
            !reminderEligibility(
              d,
              member.id,
              now,
              s.reminders[member.id] ?? [],
            ).allowed
          )
            continue;
          if (!(await tx.reserveReminder(member.id, now))) continue;
          s.reminders[member.id] = [...(s.reminders[member.id] ?? []), now];
          changed = true;
          const localDay = DateTime.fromISO(now)
            .setZone(d.setup.timezone)
            .toISODate();
          await this.coordinator.message(
            tx,
            `reminder:${record.id}:${localDay}`,
            member.id,
            "Opted-in dinner reminder: please send any missing availability or review /status. Silence never confirms attendance.",
            {
              dinnerId: record.id,
              reminder: true,
              reminderDay: localDay!,
              key: `reminder:${record.id}:${member.id}:${localDay}`,
            },
          );
        }
        if (changed) await this.coordinator.save(tx, record, s);
      }
    });
  }
}

export function researchContext(
  s: AppDinner,
  now: string,
): { context: ResearchContext; aliases: Record<string, string> } {
  const d = s.dinner,
    required = d.members.filter((m) => m.required),
    aliases: Record<string, string> = {};
  required.forEach((member, index) => {
    aliases[`person-${index + 1}`] = member.id;
  });
  const groupLimit =
    d.setup.budget.basis === "total"
      ? d.setup.budget.amount / required.length
      : d.setup.budget.amount;
  const budgets = required
    .map((m) => d.constraints[m.id]?.budget)
    .filter((b) => b?.strength === "firm")
    .map((b) => b!.amount);
  const dietary = required
    .flatMap((m) => d.constraints[m.id]?.dietary ?? [])
    .filter((x) => x.strength === "firm" || x.allergy)
    .map(({ requirement, allergy }) => ({ requirement, allergy }));
  const travel = Object.entries(aliases).flatMap(([alias, memberId]) => {
    const t = d.constraints[memberId]?.travel;
    return t?.strength === "firm"
      ? [{ alias, origin: t.origin, maxMinutes: t.maxMinutes }]
      : [];
  });
  return {
    aliases,
    context: {
      setup: {
        ...d.setup,
        intendedAttendees: Object.keys(aliases),
        budget: {
          amount: Math.min(groupLimit, ...budgets),
          basis: "per-person",
        },
      },
      slots: candidateSlots(d, now),
      dietary,
      preferences: [
        ...new Set(
          required
            .flatMap((member) => {
              const own = d.constraints[member.id];
              return [
                ...(own?.preferences ?? []),
                ...(own?.dietary ?? [])
                  .filter(
                    (item) => item.strength === "flexible" && !item.allergy,
                  )
                  .map((item) => item.requirement),
              ];
            })
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ].slice(0, 64),
      travel,
      partySize: required.length,
    },
  };
}

import {
  getDirectoryBusinesses,
  putDirectoryBusinesses,
  purgeDirectoryBusinesses,
} from "../persistence/directory.js";
import {
  bounded,
  discoverDirectory,
  directoryVenue,
  directoryOptions,
  type DirectoryClient,
} from "./directory-research.js";
import { YelpError } from "../adapters/yelp.js";
import type { ReservationService } from "./reservations.js";
import {
  ResearchFailure,
  classifyResearchFailure,
  researchGuidance,
  researchRetryable,
  type ResearchAttempt,
} from "./research.js";
import { bookingResearchVersion, researchVersion } from "./research-version.js";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  BookingLinkSchema,
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
  verificationOnly: z.boolean().optional(),
  pass: z.number().int().optional(),
  version: z.number().int().optional(),
  candidateIds: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/))
    .max(10)
    .optional(),
  attemptId: z.string().optional(),
  venueId: z.string().optional(),
  websiteHint: z.string().optional(),
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
    readonly reservations?: ReservationService,
    readonly yelp?: DirectoryClient,
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
    for (const kind of [
      "extract",
      "calendar",
      "research",
      "directory_rank",
      "directory_refresh",
      "web_discovery",
      "verify",
      "reservation",
      "revoke",
    ]) {
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
    for (let slot = 0; slot < 2; slot++) {
      const work = await this.store.claimBookingEnrichment(this.workerId);
      if (!work) break;
      this.activeJobs.add(work.id);
      void this.runJob(work).catch(() => {}).finally(() => this.activeJobs.delete(work.id));
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
      await purgeDirectoryBusinesses(this.store.pool, this.coordinator.now());
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
    if (work.kind === "reservation") {
      if (this.reservations)
        await this.reservations.processReservation(work, this.workerId);
      else await this.store.markFailed(work.id, this.workerId);
      return;
    }
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
        [
          "research",
          "directory_rank",
          "directory_refresh",
          "web_discovery",
          "booking_enrichment",
        ].includes(work.kind ?? "") &&
        job.researchVersion === (work.kind === "booking_enrichment" ? bookingResearchVersion(record.state) : researchVersion(record.state))
      )
    ) {
      await this.stale(work, job.userId, record.id);
      return;
    }
    const startedMs = Date.now();
    try {
      if (work.kind === "booking_enrichment") {
        await this.enrichBooking(work, record, job);
        return;
      }
      if (work.kind === "web_discovery") {
        await this.discoverWeb(work, record, job);
        return;
      }
      if (work.kind === "directory_refresh") {
        await this.refreshDirectory(work, record, job);
        return;
      }
      if (work.kind === "directory_rank") {
        await this.rankDirectory(work, record, job);
        return;
      }
      if (work.kind === "research" && !job.verificationOnly && this.yelp) {
        await this.discoverAndPublish(work, record, job);
        return;
      }
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
        if (job.verificationOnly) {
          const proposal = record.state.dinner.proposals.find(
            (p) => p.version === record.state.dinner.activeVersion,
          );
          const option = proposal?.options[proposal.selectedIndex];
          const venue = record.state.dinner.venues.find(
            (v) => v.id === option?.venueId,
          );
          if (option && venue) {
            context.slots = [{ start: option.start, end: option.end }];
            const cached = venue.directoryBusinessId
              ? (
                  await getDirectoryBusinesses(
                    this.store.pool,
                    [venue.directoryBusinessId],
                    this.coordinator.now(),
                  )
                )[0]
              : undefined;
            if (venue.directoryBusinessId && !cached) {
              await this.commitResult(work, record, job.userId, async (tx) => {
                await tx.updateResearchAttempt(work.id, {
                  status: "needs_checks",
                  stage: "done",
                  code: "EVIDENCE_UNRESOLVED",
                  finishedAt: this.coordinator.now(),
                  updatedAt: this.coordinator.now(),
                });
              });
              return;
            }
            context.targetVenue = {
              name: cached?.name ?? venue.name,
              address: cached?.address ?? venue.address,
              websiteUrl: venue.officialWebsiteUrl,
              menuUrl: cached?.menuUrl,
            };
          }
        }
        const result = await this.muse.research(
          context,
          this.coordinator.now(),
          async (stage) => {
            await this.researchProgress(work, record, { stage });
          },
        );
        await this.researchProgress(work, record, {
          stage: "planning",
          ...(result.phases ? {phases: result.phases} : {}),
          ...(result.discovery ? { discovery: result.discovery } : {}),
          ...(result.verification?.issues
            ? { verificationIssues: result.verification.issues }
            : {}),
        });
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
            if (job.verificationOnly) {
              if (s.dinner.activeVersion !== job.version) return;
              const p = s.dinner.proposals.find(
                  (p) => p.version === s.dinner.activeVersion,
                ),
                o = p?.options[p.selectedIndex];
              const oldVenue = s.dinner.venues.find((v) => v.id === o?.venueId);
              const normalize = (v: string) =>
                v
                  .normalize("NFKC")
                  .toLocaleLowerCase()
                  .replace(/[^\p{L}\p{N}]/gu, "");
              const checked = result.venues.find(
                (v) =>
                  oldVenue &&
                  normalize(v.name) ===
                    normalize(context.targetVenue?.name ?? oldVenue.name) &&
                  normalize(v.address) ===
                    normalize(context.targetVenue?.address ?? oldVenue.address),
              );
              if (checked && oldVenue)
                for (const key of [
                  "location",
                  "price",
                  "opening",
                  "reservation",
                ] as const) {
                  if (
                    checked.evidence[key].status === "known" ||
                    checked.evidence[key].status === "contradictory"
                  )
                    Object.assign(
                      oldVenue.evidence[key],
                      checked.evidence[key],
                    );
                }
              if (checked && oldVenue) {
                if (checked.bookingLink) oldVenue.bookingLink = checked.bookingLink;
                if (checked.officialWebsiteUrl)
                  oldVenue.officialWebsiteUrl = checked.officialWebsiteUrl;
                for (const key of ["dietary", "travel"] as const) {
                  const allowedKeys =
                    key === "dietary"
                      ? new Set(context.dietary.map((item) => item.requirement))
                      : new Set(Object.values(aliases));
                  for (const [requirement, claim] of Object.entries(
                    checked.evidence[key],
                  ))
                    if (
                      allowedKeys.has(requirement) &&
                      (claim.status === "known" ||
                        claim.status === "contradictory")
                    )
                      (oldVenue.evidence[key] as Record<string, unknown>)[
                        requirement
                      ] = structuredClone(claim);
                }
              }
              let materialPriceChange = false;
              if (oldVenue && o && p && o.priceEstimateKnown === false) {
                const price = oldVenue.evidence.price;
                if (
                  price.status === "known" &&
                  price.amount !== undefined &&
                  price.currency === s.dinner.setup.currency &&
                  price.basis
                ) {
                  const amount =
                    price.basis === "total"
                      ? price.amount / context.partySize
                      : price.amount;
                  const updated = {
                    ...o,
                    pricePerPerson: amount,
                    priceEstimateKnown: true,
                  };
                  s.dinner = proposeOptions(
                    s.dinner,
                    s.dinner.organizerId,
                    [updated, ...p.options.filter((option) => option !== o)],
                    this.coordinator.now(),
                  );
                  materialPriceChange = true;
                }
              }
              const saved = await this.coordinator.save(tx, current, s);
              if (materialPriceChange)
                await this.coordinator.announce(tx, s, work.id);
              await tx.updateResearchAttempt(work.id, {
                status: "needs_checks",
                stage: "done",
                code: "EVIDENCE_UNRESOLVED",
                updatedAt: this.coordinator.now(),
                finishedAt: this.coordinator.now(),
                counts,
              });
              if (
                o &&
                evaluateFeasibility(s.dinner, o, this.coordinator.now())
                  .status !== "feasible" &&
                !result.focusedSite &&
                (job.pass ?? 1) < 2
              )
                await this.coordinator.scheduleVerification(
                  tx,
                  saved,
                  work.id,
                  (job.pass ?? 1) + 1,
                );
              return;
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
                "Muse could not finish a usable shortlist from the available sources. Retry research with your saved answers. You do not need to change your preferences or re-enter your availability.",
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
            if (ranked[0].feasibility.status !== "feasible")
              await this.coordinator.scheduleVerification(
                tx,
                { ...current, state: s },
                work.id,
                1,
              );
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
        if (
          work.kind === "directory_rank" ||
          work.kind === "directory_refresh" ||
          work.kind === "web_discovery"
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
  private async enrichBooking(work: ClaimedWork, record: DinnerRecord<AppDinner>, job: z.infer<typeof JobSchema>): Promise<void> {
    const d = record.state.dinner;
    const proposal = d.proposals.find(p => p.version === job.version);
    const venue = d.venues.find(v => v.id === job.venueId);
    if (!venue || d.activeVersion !== job.version || !proposal?.options.some(o => o.venueId === venue.id) || (venue.officialWebsiteUrl ?? "") !== job.websiteHint || !canPlan(record.state)) {
      await this.store.markSuppressed(work.id, this.workerId); return;
    }
    let result: {bookingLink?: import("../domain/index.js").BookingLink; outcome: "complete"|"partial"|"unavailable"; code?: "timeout"|"invalid_response"|"source_unavailable"|"absent"|"identity_unmatched"} = {outcome:"unavailable",code:"absent"};
    try {
      const cached = venue.directoryBusinessId ? (await getDirectoryBusinesses(this.store.pool, [venue.directoryBusinessId], this.coordinator.now()))[0] : undefined;
      const target = {...venue, ...(cached ? {name:cached.name,address:cached.address} : {})};
      if (this.muse?.enrichBookingLink) result = await bounded(this.muse.enrichBookingLink(target, this.coordinator.now()), 35000);
      if (result.bookingLink && !BookingLinkSchema.safeParse(result.bookingLink).success) result = {outcome:"unavailable",code:"invalid_response"};
    } catch (error) {
      result = {outcome:"unavailable",code: error instanceof Error && ["TimeoutError","AbortError"].includes(error.name) ? "timeout" : "source_unavailable"};
    }
    await this.commitResult(work, record, job.userId, async (tx, current) => {
      const s = structuredClone(current.state), active = s.dinner.proposals.find(p => p.version === s.dinner.activeVersion);
      const currentVenue = s.dinner.venues.find(v => v.id === job.venueId);
      if (s.dinner.activeVersion !== job.version || !currentVenue || (currentVenue.officialWebsiteUrl ?? "") !== job.websiteHint || !active?.options.some(o => o.venueId === currentVenue.id) || !canPlan(s)) return;
      if (result.bookingLink) currentVenue.bookingLink = result.bookingLink;
      s.bookingResearch ??= {};
      s.bookingResearch[currentVenue.id] = {phase:"booking_link",outcome:result.outcome,...(result.code ? {code:result.code} : {}),updatedAt:this.coordinator.now(),version:job.version!,venueId:currentVenue.id};
      await this.coordinator.save(tx, current, s);
    });
  }
  private async discoverAndPublish(
    work: ClaimedWork,
    record: DinnerRecord<AppDinner>,
    job: z.infer<typeof JobSchema>,
  ): Promise<void> {
    if (!canPlan(record.state)) throw new Error("Required consent unavailable");
    const { context } = researchContext(record.state, this.coordinator.now());
    if (!context.slots.length)
      throw new ResearchFailure("NO_COMMON_TIME", "planning");
    await this.researchProgress(work, record, {
      status: "running",
      stage: "discovery",
      startedAt: this.coordinator.now(),
    });
    // Resume the most recent checkpoint for these exact planning inputs. Only IDs are durable.
    const checkpoint = await this.store.transaction(async (tx) => {
      const result = await tx.client.query(
        "SELECT attempt FROM research_runs WHERE dinner_id=$1 AND input_version=$2 AND attempt->'discovery'->>'status'='used' ORDER BY requested_at DESC,sequence DESC LIMIT 1",
        [record.id, researchVersion(record.state)],
      );
      return result.rows[0]?.attempt as ResearchAttempt | undefined;
    });
    const activeProposal = record.state.dinner.proposals.find(
      (proposal) => proposal.version === record.state.dinner.activeVersion,
    );
    const sameInputs =
      activeProposal &&
      JSON.stringify(activeProposal.constraints) ===
        JSON.stringify(record.state.dinner.constraints) &&
      JSON.stringify(activeProposal.setup) ===
        JSON.stringify(record.state.dinner.setup);
    const reusableIds =
      checkpoint?.discovery?.candidateIds ??
      (sameInputs
        ? record.state.dinner.venues
            .flatMap((venue) =>
              venue.directoryBusinessId ? [venue.directoryBusinessId] : [],
            )
            .slice(0, 10)
        : []);
    let candidates = await getDirectoryBusinesses(
      this.store.pool,
      reusableIds,
      this.coordinator.now(),
    );
    if (!candidates.length) {
      try {
        candidates = await bounded(
          discoverDirectory(this.yelp!, context),
          16000,
        );
      } catch (error) {
        await this.researchProgress(work, record, {
          discovery: {
            provider: "yelp",
            status: "unavailable",
            candidateIds: [],
            code: error instanceof YelpError ? error.code : "network",
          },
        });
        const code =
          error instanceof YelpError
            ? (
                {
                  unauthorized: "AUTH_INVALID",
                  forbidden: "ACCESS_DENIED",
                  rate_limited: "RATE_LIMITED",
                  network: "NETWORK",
                  invalid_response: "INVALID_OUTPUT",
                  invalid_request: "REQUEST_REJECTED",
                  upstream: "PROVIDER_UNAVAILABLE",
                } as const
              )[error.code]
            : "TIMEOUT";
        await this.queueWebDiscovery(work, record, job, code);
        return;
      }
    }
    if (!candidates.length) {
      await this.researchProgress(work, record, {
        discovery: { provider: "yelp", status: "empty", candidateIds: [] },
      });
      await this.queueWebDiscovery(work, record, job, "NO_SUITABLE_OPTIONS");
      return;
    }
    await putDirectoryBusinesses(
      this.store.pool,
      candidates,
      this.coordinator.now(),
    );
    const ids = candidates.map((candidate) => candidate.id).slice(0, 10);
    await this.researchProgress(work, record, {
      stage: "details",
      discovery: { provider: "yelp", status: "used", candidateIds: ids },
    });
    const details = await Promise.allSettled(
      candidates.map((candidate) =>
        bounded(this.yelp!.details(candidate.id), 15000),
      ),
    );
    candidates = candidates.map((candidate, index) =>
      details[index].status === "fulfilled" &&
      details[index].value.id === candidate.id
        ? details[index].value
        : candidate,
    );
    await putDirectoryBusinesses(
      this.store.pool,
      candidates,
      this.coordinator.now(),
    );
    candidates = candidates.filter((candidate) => candidate.isClosed !== true);
    const openIds = candidates.map((candidate) => candidate.id);
    if (!openIds.length) {
      await this.queueWebDiscovery(work, record, job, "NO_SUITABLE_OPTIONS");
      return;
    }
    await this.commitResult(work, record, job.userId, async (tx, current) => {
      const s = structuredClone(current.state);
      // A resumed job must not replace a published choice set or clear interactions.
      const active = s.dinner.proposals.find(
        (p) => p.version === s.dinner.activeVersion,
      );
      const reuse =
        active &&
        active.options.every((option) =>
          option.venueId.startsWith("directory:"),
        ) &&
        JSON.stringify(active.constraints) ===
          JSON.stringify(s.dinner.constraints) &&
        JSON.stringify(active.setup) === JSON.stringify(s.dinner.setup) &&
        JSON.stringify(active.memberIds) ===
          JSON.stringify(
            s.dinner.members
              .filter((member) => member.required)
              .map((member) => member.id),
          );
      if (!reuse) {
        s.dinner = setVenues(
          s.dinner,
          s.dinner.organizerId,
          openIds.map((id, index) =>
            directoryVenue(id, index, context, this.coordinator.now()),
          ),
          this.coordinator.now(),
        );
        const options = directoryOptions(openIds, context).filter(
          (option) =>
            evaluateFeasibility(s.dinner, option, this.coordinator.now())
              .status !== "infeasible",
        );
        if (!options.length)
          throw new ResearchFailure("NO_SUITABLE_OPTIONS", "planning");
        s.dinner = proposeOptions(
          s.dinner,
          s.dinner.organizerId,
          options,
          this.coordinator.now(),
        );
      }
      const next = reuse
        ? current
        : await this.coordinator.save(tx, current, s);
      const selectedIds = next.state.dinner.proposals
        .find((p) => p.version === next.state.dinner.activeVersion)!
        .options.map((option) => option.venueId.replace(/^directory:/, ""));
      await tx.updateResearchAttempt(work.id, {
        status: "needs_checks",
        stage: "ranking",
        code: "EVIDENCE_UNRESOLVED",
        selectedIds,
        updatedAt: this.coordinator.now(),
        finishedAt: this.coordinator.now(),
      });
      // The discovery lease completes with a usable active shortlist BEFORE any model call.
      await this.coordinator.job(
        tx,
        work.id,
        "directory_rank",
        record.id,
        job.userId,
        next.revision,
        {
          candidateIds: openIds,
          researchVersion: researchVersion(next.state),
          version: next.state.dinner.activeVersion,
          attemptId: work.id,
        },
      );
      await this.coordinator.scheduleBookingEnrichment(tx, next);
      if (!reuse) await this.coordinator.announce(tx, next.state, work.id);
    });
  }
  private async queueWebDiscovery(
    work: ClaimedWork,
    record: DinnerRecord<AppDinner>,
    job: z.infer<typeof JobSchema>,
    code: import("./research.js").ResearchCode,
  ): Promise<void> {
    await this.commitResult(work, record, job.userId, async (tx, current) => {
      await tx.updateResearchAttempt(work.id, {
        status: "needs_checks",
        stage: "discovery",
        code,
        updatedAt: this.coordinator.now(),
      });
      await this.coordinator.job(
        tx,
        work.id,
        "web_discovery",
        current.id,
        job.userId,
        current.revision,
        { researchVersion: researchVersion(current.state), attemptId: work.id },
      );
    });
  }
  private async discoverWeb(
    work: ClaimedWork,
    record: DinnerRecord<AppDinner>,
    job: z.infer<typeof JobSchema>,
  ): Promise<void> {
    const { context } = researchContext(record.state, this.coordinator.now());
    let venues: Awaited<ReturnType<MuseClient["discoverCandidates"]>> = [];
    try {
      if (this.muse && context.slots.length)
        venues = await bounded(
          this.muse.discoverCandidates(context, this.coordinator.now()),
          35000,
        );
    } catch {
      /* Keep any existing active choices if independent discovery cannot finish. */
    }
    await this.commitResult(work, record, job.userId, async (tx, current) => {
      const s = structuredClone(current.state);
      const active = s.dinner.proposals.find(
        (proposal) => proposal.version === s.dinner.activeVersion,
      );
      if (active || !venues.length) {
        if (job.attemptId)
          await tx.updateResearchAttempt(job.attemptId, {
            status: "needs_checks",
            stage: "done",
            code: venues.length ? "EVIDENCE_UNRESOLVED" : "NO_SUITABLE_OPTIONS",
            updatedAt: this.coordinator.now(),
            finishedAt: this.coordinator.now(),
          });
        if (!venues.length)
          await this.coordinator.message(
            tx,
            work.id,
            job.userId,
            active
              ? "The restaurant search could not find additional verified choices. Your current options are still available. Open the planner to review or adjust the area or cuisine."
              : "The restaurant directory and focused web search could not find verified choices. Which nearby area or cuisine should we try? Open the planner to adjust the search and retry.",
            {
              dinnerId: record.id,
              buttons: this.coordinator.plannerButtons({ dinner: record.id }),
            },
          );
        return;
      }
      s.dinner = setVenues(
        s.dinner,
        s.dinner.organizerId,
        venues,
        this.coordinator.now(),
      );
      const options = venues
        .slice(0, 3)
        .map((venue) => ({
          venueId: venue.id,
          ...context.slots[0],
          pricePerPerson: 0,
          priceEstimateKnown: false,
          priceBasis: "per-person" as const,
          durationMinutes: context.setup.durationMinutes,
        }))
        .filter(
          (option) =>
            evaluateFeasibility(s.dinner, option, this.coordinator.now())
              .status !== "infeasible",
        );
      if (!options.length) return;
      s.dinner = proposeOptions(
        s.dinner,
        s.dinner.organizerId,
        options,
        this.coordinator.now(),
      );
      const next = await this.coordinator.save(tx, current, s);
      if (job.attemptId)
        await tx.updateResearchAttempt(job.attemptId, {
          status: "needs_checks",
          stage: "followup",
          code: "EVIDENCE_UNRESOLVED",
          updatedAt: this.coordinator.now(),
          finishedAt: this.coordinator.now(),
        });
      await this.coordinator.announce(tx, s, work.id);
      await this.coordinator.scheduleVerification(tx, next, work.id, 1);
    });
  }
  private async refreshDirectory(
    work: ClaimedWork,
    record: DinnerRecord<AppDinner>,
    job: z.infer<typeof JobSchema>,
  ): Promise<void> {
    if (!this.yelp) {
      await this.store.markSuppressed(work.id, this.workerId);
      return;
    }
    const results = await Promise.allSettled(
      (job.candidateIds ?? []).map((id) =>
        bounded(this.yelp!.details(id), 15000),
      ),
    );
    await this.commitResult(work, record, job.userId, async (tx) => {
      const businesses = results.flatMap((result, index) =>
        result.status === "fulfilled" &&
        result.value.id === job.candidateIds?.[index]
          ? [result.value]
          : [],
      );
      await putDirectoryBusinesses(tx, businesses, this.coordinator.now());
    });
  }
  private async rankDirectory(
    work: ClaimedWork,
    record: DinnerRecord<AppDinner>,
    job: z.infer<typeof JobSchema>,
  ): Promise<void> {
    const { context } = researchContext(record.state, this.coordinator.now());
    const candidates = await getDirectoryBusinesses(
      this.store.pool,
      job.candidateIds ?? [],
      this.coordinator.now(),
    );
    let selectedIds = candidates.slice(0, 3).map((candidate) => candidate.id);
    if (this.muse && candidates.length) {
      try {
        const enriched =
          typeof this.muse.readCandidateMenus === "function"
            ? await bounded(this.muse.readCandidateMenus(candidates), 4100)
            : candidates;
        selectedIds = await bounded(
          this.muse.rankCandidates(context, enriched),
          15000,
        );
      } catch {
        /* Stable directory ordering is the deterministic ranking fallback. */
      }
    }
    await this.commitResult(work, record, job.userId, async (tx, current) => {
      if (
        !selectedIds.length ||
        current.state.dinner.activeVersion !== job.version
      )
        return;
      let next = current;
      const s = structuredClone(current.state),
        d = s.dinner;
      const active = d.proposals.find((p) => p.version === d.activeVersion)!;
      const untouched =
        current.revision === job.revision &&
        !Object.values(d.confirmations).some(
          (version) => version === d.activeVersion,
        ) &&
        !d.disputes.some((dispute) => dispute.open) &&
        active.selectedIndex === 0;
      const changed =
        JSON.stringify(active.options.map((option) => option.venueId)) !==
        JSON.stringify(selectedIds.map((id) => `directory:${id}`));
      if (
        untouched &&
        changed &&
        selectedIds.every((id) =>
          d.venues.some((venue) => venue.directoryBusinessId === id),
        )
      ) {
        const options = directoryOptions(selectedIds, context).filter(
          (option) =>
            evaluateFeasibility(d, option, this.coordinator.now()).status !==
            "infeasible",
        );
        if (options.length) {
          s.dinner = proposeOptions(
            d,
            d.organizerId,
            options,
            this.coordinator.now(),
          );
          next = await this.coordinator.save(tx, current, s);
          await this.coordinator.announce(tx, s, work.id);
        }
      }
      if (job.attemptId)
        await tx.updateResearchAttempt(job.attemptId, {
          stage: "followup",
          selectedIds,
          updatedAt: this.coordinator.now(),
        });
      // One venue and one slot per follow-up; no whole-shortlist web request.
      await this.coordinator.scheduleVerification(tx, next, work.id, 1);
    });
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
          [
            "research",
            "directory_rank",
            "directory_refresh",
            "web_discovery",
          "booking_enrichment",
          ].includes(work.kind ?? "") &&
          (work.kind === "booking_enrichment" ? bookingResearchVersion(current.state) === bookingResearchVersion(record.state) : researchVersion(current.state) === researchVersion(record.state))
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
  const preferenceGroups = required.map((member) => {
    const own = d.constraints[member.id];
    return [
      ...(own?.preferences ?? []),
      ...(own?.dietary ?? [])
        .filter((item) => item.strength === "flexible" && !item.allergy)
        .map((item) => item.requirement),
    ]
      .map((value) => value.trim())
      .filter(Boolean);
  });
  const preferences = [
    ...new Set(
      Array.from(
        {
          length: Math.max(0, ...preferenceGroups.map((group) => group.length)),
        },
        (_, index) =>
          preferenceGroups.flatMap((group) =>
            group[index] ? [group[index]] : [],
          ),
      ).flat(),
    ),
  ].slice(0, 64);
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
      preferences,
      travel,
      partySize: required.length,
    },
  };
}

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DateTime } from "luxon";
import {
  ConstraintSchema,
  DinnerSetupSchema,
  DomainError,
  approveMember,
  confirmVersion,
  cancelDinner,
  createDinner,
  exportIcs,
  raiseDispute,
  removeDietary,
  removeFirmLimit,
  reportAllergySafety,
  resolveDispute,
  selectAlternative,
  setReminderConsent,
  updateConstraints,
  updateSetup,
  type Constraints,
} from "../domain/index.js";
import {
  AppDinnerSchema,
  DinnerTitleSchema,
  authorized,
  availabilityShared,
  canPlan,
  organizer,
  type AppDinner,
} from "../application/model.js";
import type { Coordinator } from "../application/coordinator.js";
import {
  decrypt,
  encrypt,
  randomToken,
  tokenHash,
} from "../adapters/security.js";
import { TokensSchema } from "../adapters/google.js";
import { respondCoordination } from "../application/coordination.js";
import type { ReservationService } from "../application/reservations.js";
import type { Config } from "../config.js";
import type { DinnerRecord, DinnerTx, PgStore } from "../persistence/store.js";
import type {
  BootstrapResponse,
  MutationEnvelope,
  MutationResponse,
} from "./contracts.js";
import { MiniAppFault, type MiniAppActor } from "./auth.js";
import { stableHash } from "./hash.js";
import { formVersion, invitation, project, summary } from "./view.js";
const uid = () => randomBytes(12).toString("hex");
const actions = [
  "respondCoordination",
  "reviewReservation",
  "bookReservation",
  "reportReservation",
  "setAvailabilitySharing",
  "resetInvitation",
  "renameDinner",
  "chooseDinner",
  "setAnswerSharing",
  "cancelDinner",
  "create",
  "join",
  "approve",
  "reject",
  "savePreferences",
  "updateDinner",
  "research",
  "select",
  "confirm",
  "change",
  "resolve",
  "staffReport",
  "invite",
  "calendarConnect",
  "calendarActivate",
  "calendarSync",
  "calendarDisconnect",
  "reminders",
  "stop",
  "delete",
  "resume",
] as const;
export const EnvelopeSchema = z
  .object({
    requestId: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    action: z.enum(actions),
    dinnerId: z.string().min(1).max(128).optional(),
    formVersion: z.string().max(128).optional(),
    payload: z.unknown().optional(),
  })
  .strict();
const setupInput = z
  .object({
    title: DinnerTitleSchema,
    city: z.string().trim().min(1).max(100),
    area: z.string().trim().max(100).optional(),
    windowStart: z.string().date(),
    windowEnd: z.string().date(),
    timezone: z.string().max(100),
    currency: z.string().regex(/^[A-Z]{3}$/),
    durationMinutes: z.number().int().min(15).max(480),
    partySize: z.number().int().min(2).max(6),
    budget: z.object({
      amount: z.number().positive(),
      basis: z.literal("per-person").default("per-person"),
    }),
    consent: z.literal(true),
  })
  .strict();
export const PreferencesSchema = ConstraintSchema.pick({
  availability: true,
  dietary: true,
  preferences: true,
  budget: true,
  travel: true,
})
  .extend({
    availability: ConstraintSchema.shape.availability.unwrap().min(1),
    dietary: ConstraintSchema.shape.dietary.unwrap().default([]),
    foodConfirmed: z.literal(true),
    shareAnswers: z.boolean().optional(),
    shareAvailability: z.boolean().optional(),
    removeDietary: z.array(z.string().min(1).max(200)).max(32).optional(),
    removeLimits: z
      .array(z.enum(["budget", "travel"]))
      .max(2)
      .optional(),
  })
  .strict();
function requireOwner(s: AppDinner, user: string) {
  if (!organizer(s, user))
    throw new MiniAppFault(
      "AUTHORIZATION",
      403,
      "Only the organizer can do that.",
    );
}
function ready(s: AppDinner): boolean {
  return (
    canPlan(s) &&
    s.dinner.setup.intendedAttendees.every((id) =>
      s.dinner.members.some((m) => m.id === id),
    ) &&
    s.dinner.members
      .filter((m) => m.required)
      .every(
        (m) =>
          !!s.dinner.constraints[m.id]?.availability?.length &&
          s.dinner.constraints[m.id]?.dietary !== undefined,
      )
  );
}
function applyPreferences(
  s: AppDinner,
  user: string,
  raw: unknown,
  now: string,
): void {
  const {
    foodConfirmed: _,
    shareAnswers: _sharing,
    shareAvailability: _availabilitySharing,
    removeDietary: removals = [],
    removeLimits = [],
    ...patch
  } = PreferencesSchema.parse(raw);
  for (const requirement of removals)
    s.dinner = removeDietary(s.dinner, user, requirement, now);
  for (const kind of removeLimits)
    s.dinner = removeFirmLimit(s.dinner, user, kind, now);
  s.dinner = updateConstraints(s.dinner, user, patch, now);
}
function stagedPreferences(
  existing: Constraints | undefined,
  raw: unknown,
): Constraints {
  const {
    foodConfirmed: _,
    shareAnswers: _sharing,
    shareAvailability: _availabilitySharing,
    removeDietary: removals = [],
    removeLimits = [],
    ...patch
  } = PreferencesSchema.parse(raw);
  const previous: Constraints = structuredClone(existing ?? {});
  for (const limit of removeLimits) delete previous[limit];
  const dietary = new Map(
    (previous.dietary ?? [])
      .filter((d) => !removals.includes(d.requirement))
      .map((d) => [d.requirement, d]),
  );
  for (const entry of patch.dietary) {
    const old = dietary.get(entry.requirement);
    if (
      old &&
      ((old.allergy && !entry.allergy) ||
        (old.strength === "firm" && entry.strength === "flexible"))
    )
      throw new MiniAppFault(
        "EXPLICIT_REMOVAL",
        409,
        "Explicitly remove an existing requirement before relaxing it.",
      );
    dietary.set(entry.requirement, entry);
  }
  for (const key of ["budget", "travel"] as const)
    if (
      previous[key]?.strength === "firm" &&
      patch[key]?.strength === "flexible"
    )
      throw new MiniAppFault(
        "EXPLICIT_REMOVAL",
        409,
        "Explicitly remove a firm limit before relaxing it.",
      );
  return ConstraintSchema.parse({
    ...previous,
    ...patch,
    dietary: [...dietary.values()],
  });
}
function reviewedAnswersMatch(
  reviewed: Constraints | undefined,
  effective: Constraints | undefined,
): boolean {
  if (!reviewed) return false;
  const project = (input: Constraints | undefined) =>
    Object.fromEntries(
      (["availability", "dietary", "preferences", "budget", "travel"] as const)
        .filter((key) => input?.[key] !== undefined)
        .map((key) => [key, input![key]]),
    );
  return stableHash(project(reviewed)) === stableHash(project(effective));
}
function setAvailability(
  s: AppDinner,
  user: string,
  enabled: boolean,
  now: string,
): void {
  s.availabilitySharing ??= {};
  s.availabilitySharing[user] = { enabled, at: now, version: "1.0" };
  if (!enabled && s.answerSharing?.[user]?.enabled)
    setSharing(s, user, false, now);
}
function savedAvailabilityChoice(
  s: AppDinner,
  user: string,
  raw: unknown,
  now: string,
): void {
  const p = PreferencesSchema.parse(raw);
  setAvailability(
    s,
    user,
    p.shareAvailability ??
      (p.shareAnswers === true && s.answerSharing?.[user]?.enabled === true),
    now,
  );
}
function setSharing(
  s: AppDinner,
  user: string,
  enabled: boolean,
  now: string,
): void {
  s.answerSharing ??= {};
  s.answerSharing[user] = { enabled, at: now, version: "1.0" };
}
export class MiniAppService {
  constructor(
    readonly store: PgStore,
    readonly coordinator: Coordinator,
    readonly config: Config,
    readonly reservations?: ReservationService,
  ) {}
  private async started(tx: DinnerTx, user: string) {
    if (!(await tx.getSession(user)))
      throw new MiniAppFault(
        "BOT_START_REQUIRED",
        403,
        "Start the bot in your private Telegram chat first.",
      );
  }
  async bootstrap(
    actor: MiniAppActor,
    invite?: string,
  ): Promise<BootstrapResponse> {
    return this.store.transaction(async (tx) => {
      await this.started(tx, actor.id);
      const records = await tx.listDinnersForUser<AppDinner>(actor.id),
        session = await tx.getSession(actor.id);
      let invited;
      if (invite) {
        const dinnerId = await tx.lookupInvitation(tokenHash(invite));
        const record = dinnerId
          ? await tx.getDinner<AppDinner>(dinnerId)
          : null;
        if (!record || record.endedAt)
          throw new MiniAppFault(
            "INVITATION",
            404,
            "Invitation expired or unavailable.",
          );
        AppDinnerSchema.parse(record.state);
        invited = invitation(record, actor.id);
      }
      return {
        actor,
        dinners: records.map((r) => summary(r, actor.id)),
        currentDinnerId: records.some(
          (record) =>
            record.id === session?.currentDinnerId &&
            (authorized(record.state, actor.id) ||
              !!record.state.joinRequests[actor.id] ||
              record.organizerId === actor.id),
        )
          ? session!.currentDinnerId
          : null,
        maxActiveDinnersPerOrganizer:
          this.config.MAX_ACTIVE_DINNERS_PER_ORGANIZER ?? 5,
        ...(invited ? { invitation: invited } : {}),
        supportContact: this.config.SUPPORT_CONTACT,
        privacyUrl: this.config.PUBLIC_URL + "/privacy",
        botUsername: this.config.TELEGRAM_BOT_USERNAME,
      };
    });
  }
  async dinner(actor: MiniAppActor, id: string) {
    return this.store.transaction(async (tx) => {
      await this.started(tx, actor.id);
      const record = await this.record(tx, id);
      return project(tx, record, actor.id, this.coordinator.now());
    });
  }
  async calendar(actor: MiniAppActor, id: string): Promise<string> {
    return this.store.transaction(async (tx) => {
      await this.started(tx, actor.id);
      const r = await this.record(tx, id);
      if (!authorized(r.state, actor.id) || !canPlan(r.state))
        throw new MiniAppFault(
          "MEMBERSHIP",
          403,
          "Current consent and approval are required.",
        );
      return exportIcs(r.state.dinner, this.coordinator.now());
    });
  }
  private async record(
    tx: DinnerTx,
    id?: string,
  ): Promise<DinnerRecord<AppDinner>> {
    const record = id ? await tx.getDinner<AppDinner>(id) : null;
    if (!record)
      throw new MiniAppFault("DINNER", 404, "This dinner is unavailable.");
    AppDinnerSchema.parse(record.state);
    return record;
  }
  async mutate(actor: MiniAppActor, raw: unknown): Promise<MutationResponse> {
    const envelope = EnvelopeSchema.parse(raw),
      hash = stableHash(envelope);
    return this.store.transaction(async (tx) => {
      await this.started(tx, actor.id);
      const receipt = await tx.getMiniAppReceipt(actor.id, envelope.requestId);
      if (receipt) {
        if (receipt.requestHash !== hash)
          throw new MiniAppFault(
            "REQUEST_REUSED",
            409,
            "Use a new request ID for a different action.",
          );
        const outcome = receipt.response as Omit<MutationResponse, "dinner"> & {
          dinnerId?: string;
        };
        const { dinnerId, ...result } = outcome;
        if (dinnerId) {
          const record = await this.record(tx, dinnerId);
          if (
            envelope.action !== "chooseDinner" &&
            (!record.state.consents[actor.id]?.active ||
              (!authorized(record.state, actor.id) &&
                !record.state.joinRequests[actor.id]))
          )
            throw new MiniAppFault(
              "MEMBERSHIP",
              403,
              "Current consent and approval are required.",
            );
          return {
            ...result,
            dinner: await project(tx, record, actor.id, this.coordinator.now()),
          };
        }
        return result;
      }
      if (
        !["stop", "delete"].includes(envelope.action) &&
        !(await tx.consumeUsage(
          "user-updates",
          actor.id,
          this.coordinator.now().slice(0, 10),
          this.config.MAX_UPDATES_PER_USER_PER_DAY,
        ))
      )
        throw new MiniAppFault(
          "LIMIT",
          429,
          "Daily limit reached. Try again tomorrow.",
        );
      const response = await this.action(tx, actor, envelope);
      if (!["stop", "delete"].includes(envelope.action)) {
        const { dinner, ...outcome } = response,
          dinnerId = dinner?.id ?? envelope.dinnerId;
        await tx.putMiniAppReceipt(
          actor.id,
          envelope.requestId,
          hash,
          { ...outcome, ...(dinnerId ? { dinnerId } : {}) },
          dinnerId,
        );
      }
      return response;
    });
  }
  private async action(
    tx: DinnerTx,
    actor: MiniAppActor,
    input: MutationEnvelope,
  ): Promise<MutationResponse> {
    const user = actor.id,
      now = this.coordinator.now(),
      event = `miniapp:${user}:${input.requestId}`,
      payload = input.payload ?? {};
    if (input.action === "stop" || input.action === "delete") {
      await this.coordinator.withdraw(
        tx,
        user,
        event,
        input.action === "delete",
      );
      return {
        ok: true,
        deleted: input.action === "delete",
        message:
          input.action === "delete"
            ? "Your data across all dinners and every dinner you organize were deleted."
            : "Participation stopped across all your dinners.",
      };
    }
    if (input.action === "create") {
      const p = setupInput.parse(payload);
      if (
        (await tx.countActiveDinnersForOrganizer(user)) >=
        (this.config.MAX_ACTIVE_DINNERS_PER_ORGANIZER ?? 5)
      )
        throw new MiniAppFault(
          "ORGANIZER_LIMIT",
          409,
          "You have reached your active dinner limit.",
        );
      if ((await tx.activeDinnerCount()) >= this.config.MAX_ACTIVE_DINNERS)
        throw new MiniAppFault("LIMIT", 429, "The service is at capacity.");
      const id = uid(),
        roster = [
          { id: user, name: actor.name },
          ...Array.from({ length: p.partySize - 1 }, (_, i) => ({
            id: `slot-${id}-${i}`,
            name: `Guest ${i + 1}`,
          })),
        ];
      const { title, ...details } = p;
      const setup = DinnerSetupSchema.parse({
        ...details,
        area: p.area || p.city,
        budget: p.budget,
        timezoneConfirmed: true,
        currencyConfirmed: true,
        intendedAttendees: roster.map((r) => r.id),
      });
      if (
        setup.windowEnd <
        DateTime.fromISO(now).setZone(setup.timezone).toISODate()!
      )
        throw new MiniAppFault(
          "DATE",
          400,
          "Choose a current or future date window.",
        );
      const state: AppDinner = {
        ...(title ? { title } : {}),
        dinner: createDinner(id, user, setup, now),
        roster,
        consents: { [user]: { active: true, at: now, version: "1.0" } },
        joinRequests: {},
        reminders: {},
        collectionNotified: false,
      };
      const record = await tx.createDinner({ id, organizerId: user, state });
      await tx.setSession(user, {
        currentDinnerId: id,
        pendingSetup: null,
        pendingOnboard: null,
      });
      const token = randomToken();
      await tx.createInvitation(
        tokenHash(token),
        id,
        new Date(Date.parse(now) + 14 * 86400000),
      );
      return {
        ok: true,
        dinner: await project(tx, record, user, now),
        invitationUrl: this.inviteUrl(token),
      };
    }
    if (input.action === "join") {
      const p = z
        .object({
          invite: z.string().min(1).max(256).optional(),
          consent: z.literal(true),
          shareAvailability: z.boolean().optional(),
          preferences: PreferencesSchema.optional(),
        })
        .strict()
        .parse(payload);
      const invited = p.invite
        ? await tx.lookupInvitation(tokenHash(p.invite))
        : input.dinnerId;
      const record = await this.record(tx, invited ?? undefined),
        s = AppDinnerSchema.parse(record.state),
        pending = s.joinRequests[user];
      if (!p.invite && (!pending || !s.consents[user]?.active))
        throw new MiniAppFault(
          "INVITATION",
          403,
          "Open a current dinner invitation first.",
        );
      if (record.endedAt || s.dinner.status === "cancelled")
        throw new MiniAppFault("ENDED", 409, "This dinner has ended.");
      if (input.dinnerId && input.dinnerId !== record.id)
        throw new MiniAppFault(
          "INVITATION",
          400,
          "Invitation does not match this dinner.",
        );
      if (
        (p.preferences || input.formVersion) &&
        input.formVersion !== formVersion(s, user)
      )
        throw new MiniAppFault(
          "STALE_FORM",
          409,
          "Dinner details changed. Reload before saving.",
        );
      if (authorized(s, user))
        return { ok: true, dinner: await project(tx, record, user, now) };
      const ownSlot = s.roster.findIndex((r) => r.id === user),
        requested = pending?.slot;
      const available = (slot: number) =>
        slot >= 0 &&
        !!s.roster[slot] &&
        !s.dinner.members.some(
          (m) => m.id === s.roster[slot].id && m.id !== user,
        );
      const slot = available(ownSlot)
        ? ownSlot
        : requested !== null && requested !== undefined && available(requested)
          ? requested
          : s.roster.findIndex((_, index) => available(index));
      if (slot < 0)
        throw new MiniAppFault(
          "FULL",
          409,
          "This dinner has no available places.",
        );
      const reviewed = p.preferences
        ? PreferencesSchema.parse(p.preferences)
        : pending?.preferences;
      const old = s.roster[slot].id;
      s.roster[slot] = { id: user, name: actor.name };
      s.dinner = updateSetup(
        s.dinner,
        s.dinner.organizerId,
        {
          intendedAttendees: s.dinner.setup.intendedAttendees.map((id) =>
            id === old ? user : id,
          ),
        },
        now,
      );
      s.dinner = approveMember(
        s.dinner,
        s.dinner.organizerId,
        { id: user, consent: true, startedBot: true },
        now,
      );
      s.consents[user] = { active: true, at: now, version: "1.0" };
      if (reviewed)
        applyPreferences(s, user, { ...reviewed, foodConfirmed: true }, now);
      const fullGrant =
        (p.preferences
          ? p.preferences.shareAnswers === true
          : s.answerSharing?.[user]?.enabled === true) &&
        reviewedAnswersMatch(reviewed, s.dinner.constraints[user]);
      setSharing(s, user, fullGrant, now);
      setAvailability(
        s,
        user,
        p.shareAvailability ?? p.preferences?.shareAvailability ?? fullGrant,
        now,
      );
      delete s.joinRequests[user];
      const next = await this.coordinator.save(tx, record, s);
      await tx.setSession(user, {
        currentDinnerId: record.id,
        pendingSetup: null,
        pendingOnboard: null,
      });
      await this.coordinator.message(
        tx,
        event,
        s.dinner.organizerId,
        `${actor.name} joined your dinner.`,
        {
          dinnerId: record.id,
          relatedUserIds: [user],
          key: `${event}:joined`,
          buttons: this.coordinator.plannerButtons({ dinner: record.id }),
        },
      );
      if (ready(s)) await this.coordinator.scheduleResearch(tx, next, event);
      return {
        ok: true,
        dinner: await project(tx, next, user, now),
        message: "You joined the dinner. Add your own response next.",
      };
    }
    let record = await this.record(tx, input.dinnerId),
      s = AppDinnerSchema.parse(record.state);
    if (input.action === "chooseDinner") {
      const view = await project(tx, record, user, now);
      await tx.setSession(user, {
        currentDinnerId: record.id,
        pendingSetup: null,
        pendingOnboard: null,
      });
      return { ok: true, dinner: view };
    }
    if (input.action === "setAvailabilitySharing") {
      const { enabled } = z
        .object({ enabled: z.boolean() })
        .strict()
        .parse(payload);
      if (!s.dinner.members.some((m) => m.id === user) && !s.joinRequests[user])
        throw new MiniAppFault(
          "MEMBERSHIP",
          403,
          "This dinner is unavailable.",
        );
      if (enabled) {
        if (record.endedAt || s.dinner.status === "cancelled")
          throw new MiniAppFault("ENDED", 409, "This dinner has ended.");
        if (!s.consents[user]?.active)
          throw new MiniAppFault(
            "CONSENT",
            403,
            "Current consent is required.",
          );
        if (input.formVersion !== formVersion(s, user))
          throw new MiniAppFault(
            "STALE_FORM",
            409,
            "Review your availability again before sharing.",
          );
      }
      setAvailability(s, user, enabled, now);
      record = await this.coordinator.save(tx, record, s);
      if (
        !authorized(s, user) &&
        !s.joinRequests[user] &&
        s.dinner.organizerId !== user
      )
        return { ok: true, message: "Your availability is private." };
      return { ok: true, dinner: await project(tx, record, user, now) };
    }
    if (input.action === "setAnswerSharing") {
      const { enabled } = z
          .object({ enabled: z.boolean() })
          .strict()
          .parse(payload),
        recognized =
          s.dinner.members.some((m) => m.id === user) || !!s.joinRequests[user];
      if (!recognized)
        throw new MiniAppFault(
          "MEMBERSHIP",
          403,
          "This dinner is unavailable.",
        );
      if (enabled) {
        if (record.endedAt || s.dinner.status === "cancelled")
          throw new MiniAppFault("ENDED", 409, "This dinner has ended.");
        if (!s.consents[user]?.active)
          throw new MiniAppFault(
            "CONSENT",
            403,
            "Current consent is required.",
          );
        if (input.formVersion !== formVersion(s, user))
          throw new MiniAppFault(
            "STALE_FORM",
            409,
            "Your answers changed. Review them again before sharing.",
          );
      }
      setSharing(s, user, enabled, now);
      record = await this.coordinator.save(tx, record, s);
      if (
        !authorized(s, user) &&
        !s.joinRequests[user] &&
        s.dinner.organizerId !== user
      )
        return { ok: true, message: "Your answers are private." };
      return { ok: true, dinner: await project(tx, record, user, now) };
    }
    if (input.action === "cancelDinner") {
      z.object({ confirmed: z.literal(true) })
        .strict()
        .parse(payload);
      requireOwner(s, user);
      if (s.dinner.status === "cancelled")
        return { ok: true, dinner: await project(tx, record, user, now) };
      if (record.endedAt)
        throw new MiniAppFault("ENDED", 409, "This dinner has ended.");
      s.dinner = cancelDinner(s.dinner, user, now);
      for (const request of Object.values(s.joinRequests))
        delete request.preferences;
      record = await this.coordinator.save(
        tx,
        { ...record, endedAt: new Date(now) },
        s,
      );
      await tx.cancelDinnerWork(record.id, now);
      const recipients = new Set([
        ...s.dinner.members.filter((m) => authorized(s, m.id)).map((m) => m.id),
        ...Object.keys(s.joinRequests).filter((id) => s.consents[id]?.active),
      ]);
      for (const target of recipients)
        await this.coordinator.message(
          tx,
          event,
          target,
          "This dinner was cancelled by its organizer. Existing reservations are unchanged.",
          {
            dinnerId: record.id,
            notification: "dinner-cancelled",
            key: `dinner-cancelled:${record.id}:${target}`,
            buttons: this.coordinator.plannerButtons({ dinner: record.id }),
          },
        );
      return { ok: true, dinner: await project(tx, record, user, now) };
    }
    if (
      s.dinner.status === "cancelled" &&
      input.action !== "calendarDisconnect"
    )
      throw new MiniAppFault("CANCELLED", 409, "This dinner was cancelled.");
    if (input.action === "resume") {
      z.object({ consent: z.literal(true) })
        .strict()
        .parse(payload);
      if (record.organizerId !== user || record.endedAt)
        throw new MiniAppFault(
          "AUTHORIZATION",
          403,
          "Organizer resumption unavailable.",
        );
      s.consents[user] = { active: true, at: now, version: "1.0" };
      delete s.joinRequests[user];
      record = await this.coordinator.save(tx, record, s);
      await tx.setSession(user, {
        currentDinnerId: record.id,
        pendingSetup: null,
        pendingOnboard: null,
      });
      return { ok: true, dinner: await project(tx, record, user, now) };
    }
    if (
      input.action === "savePreferences" &&
      s.joinRequests[user] &&
      s.consents[user]?.active
    ) {
      if (record.endedAt)
        throw new MiniAppFault("ENDED", 409, "This dinner has ended.");
      if (input.formVersion !== formVersion(s, user))
        throw new MiniAppFault(
          "STALE_FORM",
          409,
          "Your response changed. Reload before saving.",
        );
      s.joinRequests[user].preferences = stagedPreferences(
        s.joinRequests[user].preferences ?? s.dinner.constraints[user],
        payload,
      );
      setSharing(
        s,
        user,
        PreferencesSchema.parse(payload).shareAnswers === true &&
          reviewedAnswersMatch(
            PreferencesSchema.parse(payload),
            s.joinRequests[user].preferences,
          ),
        now,
      );
      savedAvailabilityChoice(s, user, payload, now);
      record = await this.coordinator.save(tx, record, s);
      return { ok: true, dinner: await project(tx, record, user, now) };
    }
    if (!authorized(s, user))
      throw new MiniAppFault(
        "MEMBERSHIP",
        403,
        "Current consent and approval are required.",
      );
    if (
      record.endedAt &&
      !["calendarDisconnect", "reminders"].includes(input.action)
    )
      throw new MiniAppFault("ENDED", 409, "This dinner has ended.");
    if (
      ["savePreferences", "updateDinner", "renameDinner"].includes(
        input.action,
      ) &&
      input.formVersion !== formVersion(s, user)
    )
      throw new MiniAppFault(
        "STALE_FORM",
        409,
        "Your dinner or response changed. Reload before saving.",
      );
    const wasAgreed = s.dinner.status === "agreed";
    let changed = false,
      schedule = false,
      activatedCalendar = false;
    switch (input.action) {
      case "respondCoordination": {
        const p = z
          .object({
            suggestionId: z.string().min(1),
            response: z.enum(["accept", "decline"]),
          })
          .strict()
          .parse(payload);
        s = respondCoordination(s, user, p, now);
        changed = true;
        schedule = true;
        break;
      }
      case "reviewReservation": {
        if (!this.reservations)
          throw new MiniAppFault(
            "RESERVATION",
            503,
            "Reservation management is unavailable.",
          );
        await this.reservations.review(
          tx,
          record,
          user,
          z.object({ version: z.number().int().positive() }).parse(payload),
          now,
        );
        break;
      }
      case "bookReservation": {
        if (!this.reservations)
          throw new MiniAppFault(
            "RESERVATION",
            503,
            "Reservation management is unavailable.",
          );
        await this.reservations.book(
          tx,
          record,
          user,
          z
            .object({
              version: z.number().int().positive(),
              reviewId: z.string(),
              consent: z.literal(true),
              contact: z.unknown(),
            })
            .parse(payload),
          now,
        );
        break;
      }
      case "reportReservation": {
        if (!this.reservations)
          throw new MiniAppFault(
            "RESERVATION",
            503,
            "Reservation management is unavailable.",
          );
        await this.reservations.report(
          tx,
          record,
          user,
          z
            .object({
              version: z.number().int().positive(),
              confirmed: z.literal(true),
              reference: z.string().optional(),
            })
            .parse(payload),
          now,
        );
        break;
      }
      case "renameDinner": {
        requireOwner(s, user);
        const { title } = z
          .object({ title: z.string().trim().max(80) })
          .strict()
          .parse(payload);
        s.title = title || undefined;
        changed = true;
        break;
      }
      case "savePreferences":
        applyPreferences(s, user, payload, now);
        setSharing(
          s,
          user,
          PreferencesSchema.parse(payload).shareAnswers === true &&
            reviewedAnswersMatch(
              PreferencesSchema.parse(payload),
              s.dinner.constraints[user],
            ),
          now,
        );
        savedAvailabilityChoice(s, user, payload, now);
        changed = true;
        schedule = true;
        break;
      case "updateDinner": {
        requireOwner(s, user);
        const p = setupInput
          .partial()
          .omit({ consent: true, title: true })
          .parse(payload);
        const { partySize, ...patch } = p;
        if (partySize !== undefined && partySize !== s.roster.length)
          throw new MiniAppFault(
            "MEMBERSHIP",
            400,
            "Party size cannot change after creation.",
          );
        s.dinner = updateSetup(
          s.dinner,
          user,
          {
            ...patch,
            ...(patch.area !== undefined
              ? { area: patch.area || patch.city || s.dinner.setup.city }
              : {}),
          },
          now,
        );
        changed = true;
        schedule = true;
        break;
      }
      case "approve": {
        requireOwner(s, user);
        const { userId } = z
            .object({ userId: z.string().min(1) })
            .parse(payload),
          request = s.joinRequests[userId];
        if (!request && authorized(s, userId)) break;
        if (
          !request ||
          !s.consents[userId]?.active ||
          !(await tx.getSession(userId))
        )
          throw new MiniAppFault(
            "CONSENT",
            409,
            "An active consent request is required.",
          );
        const slot =
          request.slot ??
          s.roster.findIndex(
            (r) => !s.dinner.members.some((m) => m.id === r.id),
          );
        if (
          slot < 0 ||
          !s.roster[slot] ||
          s.dinner.members.some(
            (m) => m.id === s.roster[slot].id && m.id !== userId,
          )
        )
          throw new MiniAppFault(
            "FULL",
            409,
            "This place is no longer available.",
          );
        const old = s.roster[slot].id;
        s.roster[slot] = { id: userId, name: request.name };
        s.dinner = updateSetup(
          s.dinner,
          user,
          {
            intendedAttendees: s.dinner.setup.intendedAttendees.map((id) =>
              id === old ? userId : id,
            ),
          },
          now,
        );
        s.dinner = approveMember(
          s.dinner,
          user,
          { id: userId, consent: true, startedBot: true },
          now,
        );
        if (request.preferences)
          applyPreferences(
            s,
            userId,
            { ...request.preferences, foodConfirmed: true },
            now,
          );
        // A returning participant may have firm private limits preserved by the domain merge.
        // Their new submission cannot grant access to inherited answers they did not review.
        if (
          s.answerSharing?.[userId]?.enabled &&
          !reviewedAnswersMatch(
            request.preferences,
            s.dinner.constraints[userId],
          )
        )
          setSharing(s, userId, false, now);
        delete s.joinRequests[userId];
        changed = true;
        schedule = true;
        await this.coordinator.message(
          tx,
          event,
          userId,
          "Your dinner membership was approved. Open the dinner app to see the plan.",
          {
            dinnerId: record.id,
            key: `${event}:approved`,
            buttons: this.coordinator.plannerButtons({ dinner: record.id }),
          },
        );
        break;
      }
      case "reject": {
        requireOwner(s, user);
        const { userId } = z
          .object({ userId: z.string().min(1) })
          .parse(payload);
        if (!s.joinRequests[userId])
          throw new MiniAppFault("MEMBERSHIP", 404, "Request unavailable.");
        delete s.joinRequests[userId];
        delete s.consents[userId];
        await tx.client.query(
          "DELETE FROM miniapp_receipts WHERE user_id=$1 AND dinner_id=$2",
          [userId, record.id],
        );
        changed = true;
        break;
      }
      case "research":
        requireOwner(s, user);
        if (!ready(s))
          throw new MiniAppFault(
            "INCOMPLETE",
            409,
            "All intended attendees need approval and a completed response.",
          );
        await this.coordinator.scheduleResearch(tx, record, event);
        break;
      case "select": {
        requireOwner(s, user);
        const p = z
          .object({
            index: z.number().int().min(0).max(1),
            version: z.number().int().positive(),
          })
          .parse(payload);
        if (p.version !== s.dinner.activeVersion)
          throw new MiniAppFault(
            "STALE_PROPOSAL",
            409,
            "The dinner options changed. Reload before choosing.",
          );
        s.dinner = selectAlternative(s.dinner, user, p.index, now);
        changed = true;
        break;
      }
      case "confirm": {
        const p = z
          .object({ version: z.number().int().positive() })
          .parse(payload);
        s.dinner = confirmVersion(s.dinner, user, p.version, now);
        changed = true;
        break;
      }
      case "change": {
        const p = z
          .object({ reason: z.string().trim().min(1).max(2000) })
          .parse(payload);
        s.dinner = raiseDispute(s.dinner, user, p.reason, now);
        changed = true;
        schedule = true;
        break;
      }
      case "resolve":
        s.dinner = resolveDispute(s.dinner, user, now);
        changed = true;
        schedule = true;
        break;
      case "staffReport": {
        const p = z
          .object({
            version: z.number().int().positive(),
            venueId: z.string(),
            requirement: z.string(),
            report: z.string().min(1).max(2000),
            accommodationConfirmed: z.literal(true),
          })
          .strict()
          .parse(payload);
        const active = s.dinner.proposals.find(
          (proposal) => proposal.version === s.dinner.activeVersion,
        );
        if (
          p.version !== s.dinner.activeVersion ||
          !active?.options.some((option) => option.venueId === p.venueId)
        )
          throw new MiniAppFault(
            "STALE_PROPOSAL",
            409,
            "Choose a venue from the current proposal.",
          );
        s.dinner = reportAllergySafety(s.dinner, user, p, now);
        changed = true;
        schedule = true;
        break;
      }
      case "reminders": {
        const p = z.object({ enabled: z.boolean() }).parse(payload);
        s.dinner = setReminderConsent(s.dinner, user, p.enabled);
        changed = true;
        break;
      }
      case "resetInvitation": {
        requireOwner(s, user);
        await tx.revokeInvitations(record.id);
        const token = randomToken();
        await tx.createInvitation(
          tokenHash(token),
          record.id,
          new Date(Date.parse(now) + 14 * 86400000),
        );
        return {
          ok: true,
          dinner: await project(tx, record, user, now),
          invitationUrl: this.inviteUrl(token),
        };
      }
      case "invite": {
        requireOwner(s, user);
        const token = randomToken();
        await tx.createInvitation(
          tokenHash(token),
          record.id,
          new Date(Date.parse(now) + 14 * 86400000),
        );
        return {
          ok: true,
          invitationUrl: this.inviteUrl(token),
          dinner: await project(tx, record, user, now),
        };
      }
      case "calendarConnect": {
        if (!this.coordinator.google)
          throw new MiniAppFault(
            "CALENDAR",
            503,
            "Calendar connection is unavailable. Manual availability still works.",
          );
        const state = randomToken();
        await tx.createOAuthState(
          tokenHash(state),
          record.id,
          user,
          new Date(Date.parse(now) + 600000),
        );
        return {
          ok: true,
          calendarUrl: this.coordinator.google.authorizationUrl(state),
        };
      }
      case "calendarActivate": {
        const stored = await tx.getCalendarConnection(record.id, user);
        if (!stored)
          throw new MiniAppFault(
            "CALENDAR",
            409,
            "Authorize your calendar first.",
          );
        const context = `${record.id}:${user}`,
          tokens = TokensSchema.parse(
            decrypt(stored, this.config.CREDENTIAL_ENCRYPTION_KEY, context),
          );
        await tx.setCalendarConnection(
          record.id,
          user,
          encrypt(
            { ...tokens, active: true },
            this.config.CREDENTIAL_ENCRYPTION_KEY,
            context,
          ),
        );
        s.dinner = updateConstraints(
          s.dinner,
          user,
          { calendarStatus: "unavailable" },
          now,
        );
        changed = true;
        activatedCalendar = true;
        break;
      }
      case "calendarSync": {
        const stored = await tx.getCalendarConnection(record.id, user);
        if (!stored)
          throw new MiniAppFault(
            "CALENDAR",
            409,
            "Connect your calendar first.",
          );
        await this.coordinator.job(
          tx,
          event,
          "calendar",
          record.id,
          user,
          record.revision,
        );
        break;
      }
      case "calendarDisconnect": {
        const stored = await tx.getCalendarConnection(record.id, user);
        await tx.disconnectCalendar(record.id, user);
        if (stored)
          await tx.queue({
            id: uid(),
            dedupeKey: `${event}:revoke`,
            kind: "revoke",
            subjectUserId: user,
            payload: { encrypted: stored, context: `${record.id}:${user}` },
          });
        const last =
          s.dinner.proposals.find(
            (p) => p.version === s.dinner.activeVersion,
          ) ?? s.dinner.proposals.at(-1);
        const started =
          !!last &&
          Date.parse(last.options[last.selectedIndex].start) <= Date.parse(now);
        s.dinner =
          record.endedAt || started
            ? {
                ...s.dinner,
                revision: s.dinner.revision + 1,
                constraints: {
                  ...s.dinner.constraints,
                  [user]: {
                    ...s.dinner.constraints[user],
                    busy: [],
                    calendarStatus: "not-connected",
                  },
                },
              }
            : updateConstraints(
                s.dinner,
                user,
                { busy: [], calendarStatus: "not-connected" },
                now,
              );
        changed = true;
        schedule = !record.endedAt && !started;
        break;
      }
    }
    if (changed) record = await this.coordinator.save(tx, record, s);
    if (activatedCalendar)
      await this.coordinator.job(
        tx,
        event,
        "calendar",
        record.id,
        user,
        record.revision,
      );
    if (schedule && ready(s))
      await this.coordinator.scheduleResearch(tx, record, event);
    if (
      changed &&
      (input.action === "select" ||
        (input.action === "confirm" &&
          !wasAgreed &&
          s.dinner.status === "agreed"))
    )
      await this.coordinator.announce(tx, s, event);
    return { ok: true, dinner: await project(tx, record, user, now) };
  }
  private inviteUrl(token: string): string {
    return `https://t.me/${this.config.TELEGRAM_BOT_USERNAME}?start=${token}`;
  }
}
export function publicFault(error: unknown): MiniAppFault {
  if (error instanceof MiniAppFault) return error;
  if (error instanceof DomainError)
    return new MiniAppFault(
      error.code,
      ["AUTHORIZATION", "MEMBERSHIP", "CONSENT"].includes(error.code)
        ? 403
        : 409,
      "This action cannot be completed. Check your own response and refresh the dinner.",
    );
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    (error.statusCode === 400 || error.statusCode === 413)
  )
    return new MiniAppFault(
      "VALIDATION",
      error.statusCode,
      "The request is invalid or too large.",
    );
  if (error instanceof z.ZodError)
    return new MiniAppFault(
      "VALIDATION",
      400,
      "Check the form fields and use dates with explicit timezone offsets.",
    );
  return new MiniAppFault(
    "INTERNAL",
    500,
    "The request could not be completed. Please try again.",
  );
}

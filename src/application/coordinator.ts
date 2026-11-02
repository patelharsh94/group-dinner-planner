import { researchGuidance, type ResearchCode } from "./research.js";
import { researchVersion } from "./research-version.js";
import type { TelegramButton } from "../adapters/telegram.js";
import { randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  ConfirmationSchema,
  approveMember,
  confirmVersion,
  createDinner,
  DinnerSetupSchema,
  DomainError,
  evaluateFeasibility,
  exportIcs,
  proposeOptions,
  raiseDispute,
  reportAllergySafety,
  resolveDispute,
  removeDietary,
  removeFirmLimit,
  selectAlternative,
  setMemberRequired,
  setReminderConsent,
  updateConstraints,
  updateSetup,
  type Constraints,
  type Dinner,
  type DinnerSetup,
} from "../domain/index.js";
import type { Config } from "../config.js";
import {
  randomToken,
  tokenHash,
  decrypt,
  encrypt,
} from "../adapters/security.js";
import { TokensSchema, type GoogleCalendar } from "../adapters/google.js";
import type { CoordinatorDecision } from "../adapters/muse.js";
import type { DinnerRecord, DinnerTx, Session } from "../persistence/store.js";
import {
  AppDinnerSchema,
  authorized,
  canPlan,
  candidateSlots,
  IncomingSchema,
  ManualConstraintSchema,
  organizer,
  progress,
  sharedPlan,
  type AppDinner,
  type Incoming,
} from "./model.js";

const id = () => randomBytes(8).toString("hex");
const emptySession = (): Session => ({
  currentDinnerId: null,
  pendingSetup: null,
  pendingOnboard: null,
});
const privacy =
  "I am Muse, the dinner planning assistant. I process your private dinner input with Meta Muse to coordinate this dinner. Attendees, venue, time, duration, estimated cost and reservation handoff are shared with approved attendees. Private conversations and Google busy intervals stay private. Form answers stay private unless you explicitly share them with approved dinner members, including budget and travel starting point. All approved attendees are required by default. /stop withdraws consent; /delete erases your data. Retention: seven days after dinner. Reminders are optional. /privacy /support";
type Buttons = TelegramButton[][];
type SetupDraft = {
  step: number;
  values: Record<string, unknown>;
  name: string;
};
const questions = [
  "Which destination city?",
  "Which bounded area or neighborhood in that city?",
  "Which IANA timezone, e.g. America/Chicago?",
  "Date window: YYYY-MM-DD YYYY-MM-DD, or default for the next two weeks?",
  "Dinner duration in minutes, or default for 90?",
  "Budget amount and basis: e.g. 60 per-person or 240 total. Include your intended estimate for food/drink/tax/tip.",
  "Currency: three-letter code, e.g. USD or EUR?",
  "Names of the other 1–5 attendees, separated by commas. You are included automatically.",
];

export class Coordinator {
  constructor(
    readonly config: Config,
    readonly google?: GoogleCalendar,
    readonly now: () => string = () => new Date().toISOString(),
  ) {}
  plannerButtons(query: Record<string, string> = {}): Buttons {
    const url = new URL(`${this.config.PUBLIC_URL}/app/`);
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
    return [[{ text: "Open planner", web_app: { url: url.toString() } }]];
  }
  async message(
    tx: DinnerTx,
    eventId: string,
    chatId: string,
    text: string,
    options: {
      dinnerId?: string;
      buttons?: Buttons;
      reply?: boolean;
      version?: number;
      document?: { filename: string; content: string };
      reminder?: boolean;
      reminderDay?: string;
      key?: string;
      relatedUserIds?: string[];
      notification?: "dinner-cancelled";
    } = {},
  ): Promise<void> {
    if (eventId.startsWith("miniapp:") && options.reply && !options.document)
      return;
    const workId = id();
    await tx.queue({
      id: workId,
      dedupeKey: options.key ?? `${eventId}:${chatId}:${workId}`,
      kind: "message",
      subjectUserId: chatId,
      dinnerId: options.dinnerId,
      payload: { chatId, text: text.slice(0, 4000), ...options },
    });
  }
  async broadcast(
    tx: DinnerTx,
    s: AppDinner,
    eventId: string,
    text: string,
    buttons?: Buttons,
    version?: number,
  ): Promise<void> {
    for (const member of s.dinner.members)
      if (authorized(s, member.id))
        await this.message(tx, eventId, member.id, text, {
          dinnerId: s.dinner.id,
          buttons,
          version,
        });
  }
  async save(
    tx: DinnerTx,
    record: DinnerRecord<AppDinner>,
    next: AppDinner,
  ): Promise<DinnerRecord<AppDinner>> {
    AppDinnerSchema.parse(next);
    for (const proposal of next.dinner.proposals)
      if (
        !record.state.dinner.proposals.some(
          (p) => p.version === proposal.version,
        )
      )
        await tx.saveProposal(record.id, proposal.version, proposal);
    return tx.saveDinner({ ...record, state: next }, record.revision);
  }
  async current(
    tx: DinnerTx,
    userId: string,
    dinnerId?: string,
  ): Promise<DinnerRecord<AppDinner>> {
    const selected = dinnerId ?? (await tx.getSession(userId))?.currentDinnerId;
    if (!selected)
      throw new DomainError(
        "MEMBERSHIP",
        "Choose a dinner with /use DINNER_ID first.",
      );
    const record = await tx.getDinner<AppDinner>(selected);
    if (!record || !authorized(AppDinnerSchema.parse(record.state), userId))
      throw new DomainError(
        "MEMBERSHIP",
        "Approved membership and current consent are required.",
      );
    return record;
  }
  private requireOrganizer(s: AppDinner, userId: string): void {
    if (!organizer(s, userId))
      throw new DomainError("AUTHORIZATION", "Only the organizer can do that.");
  }
  private requireOngoing(record: DinnerRecord<AppDinner>): void {
    if (record.endedAt)
      throw new DomainError("ENDED", "This dinner has ended.");
  }

  async handle(tx: DinnerTx, raw: unknown): Promise<void> {
    const input = IncomingSchema.parse(raw);
    try {
      await this.command(tx, input);
    } catch (error) {
      if (
        !(error instanceof DomainError) &&
        !(error instanceof z.ZodError) &&
        !(error instanceof SyntaxError)
      )
        throw error;
      // Do not forward feasibility reasons or raw validation dumps: they may refer to other users.
      const text =
        error instanceof DomainError
          ? publicError(error)
          : "That input needs clarification. Check the requested format; dates need explicit offsets. /help";
      await this.message(tx, input.eventId, input.chatId, text, {
        reply: true,
      });
    }
  }

  private async command(tx: DinnerTx, input: Incoming): Promise<void> {
    const { actorId: user, eventId, chatId, name } = input;
    const text = input.text.trim(),
      [command, ...args] = text.split(/\s+/);
    const now = this.now(),
      day = now.slice(0, 10);
    const session = (await tx.getSession(user)) ?? emptySession();
    const reply = (value: string, buttons?: Buttons) =>
      this.message(tx, eventId, chatId, value, { reply: true, buttons });

    if (["/stop", "/delete"].includes(command)) {
      await this.withdraw(tx, user, eventId, command === "/delete");
      return;
    }
    if (command === "/privacy") {
      await reply(`${privacy}\nPolicy: ${this.config.PUBLIC_URL}/privacy`);
      return;
    }
    if (command === "/support") {
      await reply(`Support: ${this.config.SUPPORT_CONTACT}`);
      return;
    }
    if (
      !(await tx.consumeUsage(
        "user-updates",
        user,
        day,
        this.config.MAX_UPDATES_PER_USER_PER_DAY,
      ))
    ) {
      await reply(
        "Daily message limit reached. /stop, /delete and /support remain available.",
      );
      return;
    }
    if (command === "/help" || text === "/start") {
      // Only trusted private webhook updates can establish bot-start proof.
      await tx.setSession(user, session);
      await reply(
        "Plan dinner for 2–6 people. Set the shared details, invite someone, and add your availability in the planner.\n\n/privacy · /support · /stop · /delete",
        this.plannerButtons(),
      );
      return;
    }
    if (command === "/resume") {
      const record = await tx.findActiveDinner<AppDinner>(user);
      if (!record) {
        await reply(
          "No active dinner you organize was found. /new starts a dinner.",
        );
        return;
      }
      await tx.setSession(user, {
        ...session,
        pendingOnboard: { type: "resume", dinnerId: record.id },
      });
      await reply(privacy, [
        [
          {
            text: "I consent to resume my organizer role",
            callback_data: `resume:${record.id}`,
          },
        ],
      ]);
      return;
    }
    if (input.callbackId && text.startsWith("resume:")) {
      const dinnerId = text.split(":")[1],
        pending = session.pendingOnboard as {
          type: string;
          dinnerId: string;
        } | null;
      const record = await tx.getDinner<AppDinner>(dinnerId);
      if (
        pending?.type !== "resume" ||
        pending.dinnerId !== dinnerId ||
        !record ||
        record.endedAt ||
        record.organizerId !== user
      )
        throw new DomainError(
          "AUTHORIZATION",
          "Organizer resumption unavailable.",
        );
      const s = AppDinnerSchema.parse(record.state);
      s.consents[user] = { active: true, at: now, version: "1.0" };
      delete s.joinRequests[user];
      await this.save(tx, record, s);
      await tx.setSession(user, {
        currentDinnerId: dinnerId,
        pendingSetup: null,
        pendingOnboard: null,
      });
      await reply(
        "You explicitly reconsented and resumed your existing organizer role. Earlier confirmations remain cleared. /status",
      );
      return;
    }
    if (command === "/new") {
      await tx.setSession(user, session);
      await reply(
        "Set your dinner details in one form.",
        this.plannerButtons({ view: "create" }),
      );
      return;
    }
    if (command === "/cancel") {
      await tx.setSession(user, {
        ...session,
        pendingSetup: null,
        pendingOnboard: null,
      });
      await reply("Draft canceled.");
      return;
    }
    if (
      (session.pendingSetup && !command.startsWith("/")) ||
      command === "/create"
    ) {
      await this.setupStep(tx, input, session);
      return;
    }
    if (command === "/start" && args[0]) {
      const dinnerId = await tx.lookupInvitation(tokenHash(args[0]));
      if (!dinnerId) {
        await reply(
          "Invitation expired or unavailable. Ask the organizer for a new link.",
        );
        return;
      }
      const record = await tx.getDinner<AppDinner>(dinnerId);
      if (!record) return;
      const s = AppDinnerSchema.parse(record.state);
      if (authorized(s, user)) {
        await tx.setSession(user, {
          ...session,
          currentDinnerId: dinnerId,
          pendingOnboard: null,
        });
        await reply(
          "Your dinner is ready to open.",
          this.plannerButtons({ dinner: dinnerId }),
        );
        return;
      }
      await tx.setSession(user, {
        ...session,
        pendingOnboard: {
          type: "invite",
          dinnerId,
          invitationHash: tokenHash(args[0]),
          validUntil: Date.parse(now) + 10 * 60000,
        },
      });
      await reply(
        `You're invited to dinner in ${s.dinner.setup.city}. Add your availability and food needs in one form. Approval is required.`,
        this.plannerButtons({ invite: args[0] }),
      );
      return;
    }
    if (input.callbackId && text.startsWith("choose:")) {
      const [, dinnerId, index] = text.split(":");
      const pending = session.pendingOnboard as {
        type: string;
        dinnerId: string;
        invitationHash: string;
        validUntil: number;
      } | null;
      if (
        pending?.type !== "invite" ||
        pending.dinnerId !== dinnerId ||
        pending.validUntil < Date.parse(now) ||
        (await tx.lookupInvitation(pending.invitationHash)) !== dinnerId
      )
        throw new DomainError("STALE", "Invitation selection expired.");
      const r = await tx.getDinner<AppDinner>(dinnerId),
        slot = Number(index);
      if (!r || !r.state.roster[slot] || !Number.isInteger(slot))
        throw new DomainError("MEMBERSHIP", "Unknown invitation.");
      if (
        r.state.dinner.members.some((m) => m.id === r.state.roster[slot].id) &&
        r.state.roster[slot].id !== user
      )
        throw new DomainError(
          "MEMBERSHIP",
          "That attendee has already joined.",
        );
      await tx.setSession(user, {
        ...session,
        pendingOnboard: { ...pending, type: "consent", slot },
      });
      await reply(privacy, [
        [
          {
            text: "I consent to processing and sharing plan details",
            callback_data: `consent:${dinnerId}:${slot}`,
          },
        ],
      ]);
      return;
    }
    if (input.callbackId && text.startsWith("consent:")) {
      const [, dinnerId, index] = text.split(":"),
        slot = Number(index);
      const pending = session.pendingOnboard as {
        type: string;
        dinnerId: string;
        slot: number;
        invitationHash: string;
        validUntil: number;
      } | null;
      if (
        pending?.type !== "consent" ||
        pending.dinnerId !== dinnerId ||
        pending.slot !== slot ||
        pending.validUntil < Date.parse(now) ||
        (await tx.lookupInvitation(pending.invitationHash)) !== dinnerId
      )
        throw new DomainError(
          "CONSENT",
          "Invitation expired. Start from a current invitation.",
        );
      const record = await tx.getDinner<AppDinner>(dinnerId);
      if (!record || record.endedAt)
        throw new DomainError("ENDED", "Invitation unavailable.");
      const s = AppDinnerSchema.parse(record.state);
      if (user === s.dinner.organizerId && s.roster[slot]?.id === user) {
        s.consents[user] = { active: true, at: now, version: "1.0" };
        delete s.joinRequests[user];
        await this.save(tx, record, s);
        await tx.setSession(user, {
          ...session,
          currentDinnerId: dinnerId,
          pendingOnboard: null,
        });
        await reply(
          "You explicitly reconsented and resumed your existing organizer role. Earlier confirmations remain cleared. /status",
        );
        return;
      }
      s.joinRequests[user] = { slot, name, at: now };
      s.consents[user] = { active: true, at: now, version: "1.0" };
      await this.save(tx, record, s);
      await tx.setSession(user, {
        ...session,
        currentDinnerId: dinnerId,
        pendingOnboard: null,
      });
      await reply(
        "Consent recorded. Waiting for organizer membership approval.",
      );
      await this.message(
        tx,
        eventId,
        s.dinner.organizerId,
        `Membership request from ${name} (Telegram ID ${user}) for attendee ${slot + 1}: ${s.roster[slot].name}. Verify their identity before approval.`,
        {
          dinnerId,
          relatedUserIds: [user],
          buttons: [
            [
              {
                text: "Approve membership",
                callback_data: `approve:${dinnerId}:${user}:${slot}`,
              },
            ],
          ],
        },
      );
      return;
    }
    if (command === "/use") {
      const record = await this.current(tx, user, args[0]);
      await tx.setSession(user, {
        ...session,
        currentDinnerId: record.id,
        pendingOnboard: null,
      });
      await reply(sharedPlan(record.state, now));
      return;
    }

    const callback = input.callbackId ? text.split(":") : undefined;
    const record = await this.current(tx, user, callback?.[1]);
    const s = AppDinnerSchema.parse(record.state),
      d = s.dinner;
    const dinnerReply = (value: string, buttons?: Buttons) =>
      this.message(tx, eventId, chatId, value, {
        dinnerId: record.id,
        reply: true,
        buttons,
      });
    if (command === "/status") {
      await this.message(tx, eventId, chatId, sharedPlan(s, now), {
        dinnerId: record.id,
        reply: true,
        version: d.activeVersion ?? undefined,
        buttons:
          d.status === "cancelled"
            ? this.plannerButtons({ dinner: record.id })
            : proposalButtons(d),
        ...(d.status === "cancelled"
          ? { notification: "dinner-cancelled" as const }
          : {}),
      });
      return;
    }
    if (command === "/export") {
      if (!canPlan(s))
        throw new DomainError(
          "CONSENT",
          "All required attendees need current consent.",
        );
      await this.message(
        tx,
        eventId,
        chatId,
        "Agreed dinner calendar. No booking has been made.",
        {
          dinnerId: record.id,
          reply: true,
          version: d.activeVersion ?? undefined,
          document: { filename: "dinner.ics", content: exportIcs(d, now) },
        },
      );
      return;
    }
    if (!["/disconnect", "/reminders"].includes(command))
      this.requireOngoing(record);
    if (command === "/invite") {
      this.requireOrganizer(s, user);
      const token = randomToken();
      await tx.createInvitation(
        tokenHash(token),
        record.id,
        new Date(Date.parse(now) + 14 * 86400000),
      );
      await dinnerReply(
        `Share this dinner-specific invitation: https://t.me/${this.config.TELEGRAM_BOT_USERNAME}?start=${token}\nEach friend must start the bot, consent and receive your approval.`,
      );
      return;
    }
    if (command === "/approve" || callback?.[0] === "approve") {
      this.requireOrganizer(s, user);
      const target = callback?.[2] ?? args[0],
        slot = callback ? Number(callback[3]) : Number(args[1]) - 1;
      const request = s.joinRequests[target];
      if (
        !request ||
        request.slot !== slot ||
        !s.consents[target]?.active ||
        !s.roster[slot]
      )
        throw new DomainError(
          "CONSENT",
          "An active matching consent request is required.",
        );
      const old = s.roster[slot].id;
      if (
        (d.members.some((m) => m.id === old) && old !== target) ||
        (d.members.some((m) => m.id === target) && old !== target)
      )
        throw new DomainError("MEMBERSHIP", "Already assigned.");
      s.roster[slot].id = target;
      const prepared = updateSetup(
        d,
        user,
        {
          intendedAttendees: d.setup.intendedAttendees.map((x) =>
            x === old ? target : x,
          ),
        },
        now,
      );
      s.dinner = approveMember(
        prepared,
        user,
        { id: target, consent: true, startedBot: true },
        now,
      );
      delete s.joinRequests[target];
      await this.save(tx, record, s);
      await this.message(
        tx,
        eventId,
        target,
        "Membership approved. Tell me your availability with explicit dates and timezone, firm dietary/allergy requirements, flexible preferences, private budget and travel limit. /availability START END works without any calendar connection.",
        { dinnerId: record.id },
      );
      await dinnerReply(progress(s));
      return;
    }
    if (command === "/reject") {
      this.requireOrganizer(s, user);
      delete s.joinRequests[args[0]];
      delete s.consents[args[0]];
      await this.save(tx, record, s);
      await dinnerReply("Membership request rejected.");
      return;
    }
    if (command === "/constraints" || command === "/availability") {
      const patch =
        command === "/availability"
          ? ManualConstraintSchema.parse({
              availability: [{ start: args[0], end: args[1] }],
            })
          : ManualConstraintSchema.parse(
              JSON.parse(text.slice(command.length)),
            );
      await this.applyPatch(tx, record, user, patch, eventId);
      return;
    }
    if (callback?.[0] === "apply") {
      const pending = session.pendingOnboard as {
        type: string;
        dinnerId: string;
        revision: number;
        nonce: string;
        patch: Constraints;
      } | null;
      if (
        pending?.type !== "patch" ||
        pending.dinnerId !== record.id ||
        pending.nonce !== callback[2] ||
        pending.revision !== record.revision
      )
        throw new DomainError(
          "STALE",
          "Recheck your update against the latest dinner.",
        );
      await this.applyPatch(
        tx,
        record,
        user,
        ManualConstraintSchema.parse(pending.patch),
        eventId,
      );
      await tx.setSession(user, { ...session, pendingOnboard: null });
      return;
    }
    if (command === "/confirm" || callback?.[0] === "confirm") {
      if (!canPlan(s))
        throw new DomainError(
          "CONSENT",
          "A required participant has withdrawn consent.",
        );
      const requestedVersion = Number(callback?.[2] ?? args[0]);
      if (requestedVersion !== d.activeVersion)
        throw new DomainError("STALE", "Confirmation is for an old proposal.");
      const confirmation = ConfirmationSchema.parse({
        dinnerId: record.id,
        participantId: user,
        proposalVersion: requestedVersion,
      });
      const version = confirmation.proposalVersion;
      s.dinner = confirmVersion(d, user, version, now);
      await this.save(tx, record, s);
      await dinnerReply(
        `Your explicit confirmation of version ${version} is recorded.`,
      );
      if (s.dinner.status === "agreed")
        await this.broadcast(
          tx,
          s,
          eventId,
          `Everyone required confirmed version ${version}.\n${sharedPlan(s, now)}\n/export provides your calendar file. Reservation link or manual handoff only; no booking has been made.`,
          undefined,
          version,
        );
      return;
    }
    if (command === "/select" || callback?.[0] === "select") {
      this.requireOrganizer(s, user);
      const version = callback ? Number(callback[2]) : d.activeVersion;
      if (version !== d.activeVersion)
        throw new DomainError("STALE", "Old proposal button.");
      s.dinner = selectAlternative(
        d,
        user,
        Number(callback?.[3] ?? args[0]) - 1,
        now,
      );
      await this.save(tx, record, s);
      await this.announce(tx, s, eventId);
      return;
    }
    if (command === "/change") {
      s.dinner = raiseDispute(d, user, text.slice(command.length).trim(), now);
      await this.save(tx, record, s);
      await dinnerReply(
        "Objection recorded privately. Which part is firm, and which part could change? State the new availability or requirement. /resolve closes your objection once addressed.",
      );
      await this.message(
        tx,
        eventId,
        d.organizerId,
        "A required participant requested a change. Agreement is paused; private details remain private.",
        { dinnerId: record.id },
      );
      await this.scheduleResearch(
        tx,
        { ...record, state: s, revision: record.revision + 1 },
        eventId,
      );
      return;
    }
    if (command === "/resolve") {
      s.dinner = resolveDispute(d, user, now);
      await this.save(tx, record, s);
      await dinnerReply(
        "Your objection is closed. Confirm the current proposal explicitly, or request research if no proposal is active.",
      );
      return;
    }
    if (command === "/staff") {
      const match = text
        .slice(command.length)
        .trim()
        .match(/^(\S+)\s+(.+?)\s*\|\s*(.+)$/);
      if (!match)
        throw new DomainError(
          "ALLERGY",
          "Use /staff VENUE_ID REQUIREMENT | what staff confirmed.",
        );
      const nonce = id();
      await tx.setSession(user, {
        ...session,
        pendingOnboard: {
          type: "staff",
          dinnerId: record.id,
          revision: record.revision,
          nonce,
          venueId: match[1],
          requirement: match[2],
          report: match[3],
        },
      });
      await dinnerReply(
        "Only confirm below if restaurant staff explicitly said they can accommodate your allergy safely. A refusal, uncertainty, or a warning must remain unresolved. This is your report, not a guarantee by Muse. /cancel discards it.",
        [
          [
            {
              text: "I confirm staff said they can accommodate my allergy",
              callback_data: `staff:${record.id}:${nonce}`,
            },
          ],
        ],
      );
      return;
    }
    if (callback?.[0] === "staff") {
      const pending = session.pendingOnboard as {
        type: string;
        dinnerId: string;
        revision: number;
        nonce: string;
        venueId: string;
        requirement: string;
        report: string;
      } | null;
      if (
        pending?.type !== "staff" ||
        pending.dinnerId !== record.id ||
        pending.nonce !== callback[2] ||
        pending.revision !== record.revision
      )
        throw new DomainError("STALE", "Review your staff report again.");
      s.dinner = reportAllergySafety(
        d,
        user,
        {
          venueId: pending.venueId,
          requirement: pending.requirement,
          report: pending.report,
          accommodationConfirmed: true,
        },
        now,
      );
      const previous = d.proposals.at(-1);
      const validOptions =
        previous?.options.filter((option) =>
          s.dinner.venues.some((venue) => venue.id === option.venueId),
        ) ?? [];
      if (validOptions.length)
        s.dinner = proposeOptions(s.dinner, d.organizerId, validOptions, now);
      await tx.setSession(user, { ...session, pendingOnboard: null });
      await this.save(tx, record, s);
      await dinnerReply(
        "Your staff confirmation is recorded for that venue and allergy. All prior confirmations are cleared.",
      );
      if (validOptions.length) await this.announce(tx, s, eventId);
      return;
    }
    if (command === "/remove_diet") {
      const requirement = text.slice(command.length).trim();
      if (!requirement)
        throw new DomainError(
          "DIETARY",
          "Use /remove_diet EXACT_REQUIREMENT only to explicitly withdraw your own requirement.",
        );
      if (s.answerSharing) delete s.answerSharing[user];
      s.dinner = removeDietary(d, user, requirement, now);
      const next = await this.save(tx, record, s);
      await dinnerReply(
        "You explicitly withdrew that dietary requirement. Prior confirmations are cleared.",
      );
      await this.scheduleResearch(tx, next, eventId);
      return;
    }
    if (command === "/remove_limit") {
      const kind = z.enum(["budget", "travel"]).parse(args[0]);
      if (s.answerSharing) delete s.answerSharing[user];
      s.dinner = removeFirmLimit(d, user, kind, now);
      const next = await this.save(tx, record, s);
      await dinnerReply(
        `You explicitly withdrew your own ${kind} limit. Prior confirmations are cleared.`,
      );
      await this.scheduleResearch(tx, next, eventId);
      return;
    }
    if (command === "/setup") {
      this.requireOrganizer(s, user);
      const patch = z
        .object(DinnerSetupSchema.shape)
        .omit({ intendedAttendees: true })
        .partial()
        .strict()
        .parse(JSON.parse(text.slice(command.length)));
      s.dinner = updateSetup(d, user, patch, now);
      await this.save(tx, record, s);
      await this.broadcast(
        tx,
        s,
        eventId,
        "The organizer revised the dinner scope. Prior confirmations are cleared; a fresh proposal is required. Existing reservations are unchanged.",
      );
      await this.scheduleResearch(
        tx,
        { ...record, state: s, revision: record.revision + 1 },
        eventId,
      );
      return;
    }
    if (command === "/required") {
      this.requireOrganizer(s, user);
      if (!["yes", "no"].includes(args[1]))
        throw new DomainError("MEMBERSHIP", "Use /required USER_ID yes|no.");
      s.dinner = setMemberRequired(d, user, args[0], args[1] === "yes", now);
      const next = await this.save(tx, record, s);
      const memberName =
        s.roster.find((r) => r.id === args[0])?.name ?? "An attendee";
      await this.broadcast(
        tx,
        s,
        eventId,
        `${memberName} is now ${args[1] === "yes" ? "required" : "optional"} by organizer decision. Everyone must confirm a fresh proposal. Existing reservations are unchanged.`,
      );
      await this.scheduleResearch(tx, next, eventId);
      return;
    }
    if (command === "/add_attendee") {
      this.requireOrganizer(s, user);
      const name = z
        .string()
        .trim()
        .min(1)
        .max(80)
        .parse(text.slice(command.length));
      if (s.roster.length >= 6)
        throw new DomainError(
          "MEMBERSHIP",
          "A dinner supports at most six intended attendees.",
        );
      if (s.roster.some((r) => r.name === name))
        throw new DomainError("MEMBERSHIP", "Use a distinct attendee name.");
      const slotId = `slot-${id()}`;
      s.dinner = updateSetup(
        d,
        user,
        { intendedAttendees: [...d.setup.intendedAttendees, slotId] },
        now,
      );
      s.roster.push({ id: slotId, name });
      s.collectionNotified = false;
      await this.save(tx, record, s);
      await this.broadcast(
        tx,
        s,
        eventId,
        `The organizer added ${name} to the intended attendees. Prior confirmations are cleared. They must join, consent and receive approval before planning can finish. Existing reservations are unchanged.`,
      );
      await dinnerReply(
        "Attendee added. Use /invite to share an invitation; membership approval and their availability are required.",
      );
      return;
    }
    if (command === "/retry") {
      this.requireOrganizer(s, user);
      if (d.disputes.some((x) => x.open))
        throw new DomainError(
          "DISPUTE",
          "Authors must resolve open objections first.",
        );
      s.dinner = {
        ...d,
        status: "collecting",
        activeVersion: null,
        confirmations: {},
        revision: d.revision + 1,
      };
      await this.save(tx, record, s);
      await this.scheduleResearch(
        tx,
        { ...record, state: s, revision: record.revision + 1 },
        eventId,
      );
      return;
    }
    if (command === "/reminders") {
      if (!["on", "off"].includes(args[0]))
        throw new DomainError("CONSENT", "Use /reminders on or off.");
      s.dinner = setReminderConsent(d, user, args[0] === "on");
      await this.save(tx, record, s);
      await dinnerReply(
        `Reminders ${args[0]}. At most one daily outside 9 PM–9 AM dinner-local quiet hours.`,
      );
      return;
    }
    if (command === "/calendar") {
      if (!this.google) {
        await dinnerReply(
          "Google access is not configured. Manual availability supports the full workflow.",
        );
        return;
      }
      const state = randomToken();
      await tx.createOAuthState(
        tokenHash(state),
        record.id,
        user,
        new Date(Date.parse(now) + 10 * 60000),
      );
      await dinnerReply(
        `Optional primary calendar free/busy only; no event titles or writes. Open within 10 minutes, then return here to /calendar_activate:\n${this.google.authorizationUrl(state)}\nExplicit willingness is still needed.`,
      );
      return;
    }
    if (command === "/calendar_activate") {
      const stored = await tx.getCalendarConnection(record.id, user);
      if (!stored) {
        await dinnerReply(
          "No staged connection. Use /calendar to authorize or enter availability manually.",
        );
        return;
      }
      const tokens = TokensSchema.parse(
        decrypt(
          stored,
          this.config.CREDENTIAL_ENCRYPTION_KEY,
          `${record.id}:${user}`,
        ),
      );
      await tx.setCalendarConnection(
        record.id,
        user,
        encrypt(
          { ...tokens, active: true },
          this.config.CREDENTIAL_ENCRYPTION_KEY,
          `${record.id}:${user}`,
        ),
      );
      await this.job(tx, eventId, "calendar", record.id, user, record.revision);
      await dinnerReply(
        "Connection activated by your Telegram identity. Checking primary free/busy; please still state your willingness.",
      );
      return;
    }
    if (command === "/calendar_sync") {
      await this.job(tx, eventId, "calendar", record.id, user, record.revision);
      await dinnerReply("Calendar refresh queued.");
      return;
    }
    if (command === "/disconnect") {
      const stored = await tx.getCalendarConnection(record.id, user);
      await tx.disconnectCalendar(record.id, user);
      if (stored)
        await tx.queue({
          id: id(),
          dedupeKey: `${eventId}:revoke`,
          kind: "revoke",
          subjectUserId: user,
          payload: { encrypted: stored, context: `${record.id}:${user}` },
        });
      const last =
        d.proposals.find((p) => p.version === d.activeVersion) ??
        d.proposals.at(-1);
      const started =
        last &&
        Date.parse(last.options[last.selectedIndex].start) <= Date.parse(now);
      s.dinner =
        started || record.endedAt
          ? {
              ...d,
              constraints: {
                ...d.constraints,
                [user]: {
                  ...d.constraints[user],
                  busy: [],
                  calendarStatus: "not-connected",
                },
              },
              revision: d.revision + 1,
            }
          : updateConstraints(
              d,
              user,
              { busy: [], calendarStatus: "not-connected" },
              now,
            );
      const next = await this.save(tx, record, s);
      await dinnerReply(
        "Local calendar credentials removed; Google revocation queued. You can also revoke access in your Google account. Manual availability remains.",
      );
      if (!started && !record.endedAt)
        await this.scheduleResearch(tx, next, eventId);
      return;
    }
    if (command === "/research") {
      this.requireOrganizer(s, user);
      await this.scheduleResearch(tx, record, eventId);
      await dinnerReply(
        "Research requested. Unknown evidence will remain visibly unresolved.",
      );
      return;
    }
    if (command.startsWith("/")) {
      await dinnerReply("Unknown command. /help");
      return;
    }
    if (!this.config.MODEL_API_KEY) {
      await dinnerReply(
        "Muse access is unavailable. Use /availability START END with ISO dates and offsets, or /constraints JSON for dietary, budget, travel and flexible preferences. Research needs live Muse access.",
      );
      return;
    }
    await this.job(tx, eventId, "extract", record.id, user, record.revision, {
      message: text,
    });
    await dinnerReply(
      "I will extract your update privately for your review. Nothing changes until you approve it.",
    );
  }

  private async setupStep(
    tx: DinnerTx,
    input: Incoming,
    session: Session,
  ): Promise<void> {
    const draft = session.pendingSetup as SetupDraft | null;
    if (!draft) throw new DomainError("SETUP", "Use /new first.");
    const text = input.text.trim(),
      values = { ...draft.values },
      now = this.now();
    if (text === "/create") {
      if (draft.step !== questions.length)
        throw new DomainError("SETUP", "Complete setup first.");
      if (await tx.findActiveDinner(input.actorId))
        throw new DomainError("SETUP", "One active dinner per organizer.");
      if ((await tx.activeDinnerCount()) >= this.config.MAX_ACTIVE_DINNERS)
        throw new DomainError("LIMIT", "Service capacity reached.");
      const names = values.names as string[];
      const dinnerId = id(),
        roster = [
          { id: input.actorId, name: draft.name },
          ...names.map((name, index) => ({ id: `slot-${index}`, name })),
        ];
      const setup = DinnerSetupSchema.parse({
        ...values,
        intendedAttendees: roster.map((r) => r.id),
        timezoneConfirmed: true,
        currencyConfirmed: true,
      });
      const dinner = createDinner(dinnerId, input.actorId, setup, now);
      const state: AppDinner = {
        dinner,
        roster,
        consents: {
          [input.actorId]: { active: true, at: now, version: "1.0" },
        },
        joinRequests: {},
        reminders: {},
        collectionNotified: false,
      };
      await tx.createDinner({
        id: dinnerId,
        organizerId: input.actorId,
        state,
      });
      await tx.setSession(input.actorId, {
        currentDinnerId: dinnerId,
        pendingSetup: null,
        pendingOnboard: null,
      });
      const token = randomToken();
      await tx.createInvitation(
        tokenHash(token),
        dinnerId,
        new Date(Date.parse(now) + 14 * 86400000),
      );
      await this.message(
        tx,
        input.eventId,
        input.chatId,
        `Dinner ${dinnerId} created. Consent, timezone ${setup.timezone} and currency ${setup.currency} confirmed.\nShare: https://t.me/${this.config.TELEGRAM_BOT_USERNAME}?start=${token}\nThen send your own availability and requirements. /help`,
        { dinnerId, reply: true },
      );
      return;
    }
    if (draft.step >= questions.length)
      throw new DomainError(
        "SETUP",
        "Review setup then /create, or /cancel to restart.",
      );
    switch (draft.step) {
      case 0:
        values.city = z.string().min(2).max(120).parse(text);
        break;
      case 1:
        values.area = z.string().min(2).max(200).parse(text);
        break;
      case 2: {
        const valid =
          DateTime.now().setZone(text).isValid &&
          (text === "UTC" || text.includes("/"));
        if (!valid) throw new DomainError("TIMEZONE", "Use an IANA timezone.");
        values.timezone = text;
        break;
      }
      case 3: {
        const local = DateTime.fromISO(now).setZone(values.timezone as string);
        const parts =
          text === "default"
            ? [local.toISODate(), local.plus({ days: 14 }).toISODate()]
            : text.split(/\s+/);
        values.windowStart = z.string().date().parse(parts[0]);
        values.windowEnd = z.string().date().parse(parts[1]);
        if (
          (values.windowEnd as string) < (values.windowStart as string) ||
          (values.windowStart as string) < local.toISODate()!
        )
          throw new DomainError(
            "DATE",
            "Choose an ordered future date window.",
          );
        break;
      }
      case 4:
        values.durationMinutes =
          text === "default"
            ? 90
            : z.coerce.number().int().min(15).max(480).parse(text);
        break;
      case 5: {
        const [amount, basis] = text.split(/\s+/);
        values.budget = {
          amount: z.coerce.number().positive().parse(amount),
          basis: z.enum(["per-person", "total"]).parse(basis),
        };
        break;
      }
      case 6:
        values.currency = z
          .string()
          .regex(/^[A-Z]{3}$/)
          .parse(text.toUpperCase());
        break;
      case 7:
        values.names = z
          .array(z.string().trim().min(1).max(80))
          .min(1)
          .max(5)
          .refine((names) => new Set(names).size === names.length)
          .parse(text.split(","));
        break;
    }
    const step = draft.step + 1;
    await tx.setSession(input.actorId, {
      ...session,
      pendingSetup: { ...draft, step, values },
    });
    const prompt =
      step < questions.length
        ? questions[step]
        : `Review: ${values.city}, ${values.area}; ${values.windowStart}–${values.windowEnd}; ${values.timezone}; ${values.durationMinutes} min; budget ${JSON.stringify(values.budget)} ${values.currency}; attendees ${[draft.name, ...(values.names as string[])].join(", ")}.\n/create explicitly confirms this timezone, currency, setup, and consent to the processing and sharing described above. /cancel restarts.`;
    await this.message(tx, input.eventId, input.chatId, prompt, {
      reply: true,
    });
  }

  async applyPatch(
    tx: DinnerTx,
    record: DinnerRecord<AppDinner>,
    user: string,
    patch: Constraints,
    eventId: string,
  ): Promise<void> {
    const s = structuredClone(record.state),
      old = s.dinner.activeVersion;
    if (s.answerSharing) delete s.answerSharing[user];
    s.dinner = updateConstraints(s.dinner, user, patch, this.now());
    const complete =
      s.dinner.members.length === s.roster.length &&
      s.dinner.members.every(
        (m) => s.dinner.constraints[m.id]?.availability?.length,
      );
    const notify = complete && !s.collectionNotified;
    s.collectionNotified ||= complete;
    const next = await this.save(tx, record, s);
    await this.message(
      tx,
      eventId,
      user,
      "Your private update is saved. Other requirements are preserved. Prior confirmations are cleared.",
      { dinnerId: record.id, reply: true },
    );
    if (old !== null)
      await this.broadcast(
        tx,
        s,
        eventId,
        "A requirement changed. Previous confirmations are cleared; a fresh proposal and confirmations are needed. Existing reservations are unchanged.",
      );
    if (notify)
      await this.message(
        tx,
        eventId,
        s.dinner.organizerId,
        `Collection milestone: ${progress(s)}`,
        { dinnerId: record.id },
      );
    if (complete) await this.scheduleResearch(tx, next, eventId);
  }
  async job(
    tx: DinnerTx,
    eventId: string,
    kind: string,
    dinnerId: string,
    userId: string,
    revision: number,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const workId = id();
    if (kind === "research")
      await tx.createResearchAttempt({
        id: workId,
        dinnerId,
        inputVersion: String(extra.researchVersion ?? revision),
        requestedAt: this.now(),
      });
    await tx.queue({
      id: workId,
      dedupeKey: `${eventId}:${kind}:${dinnerId}:${userId}`,
      kind,
      subjectUserId: userId,
      dinnerId,
      payload: { dinnerId, userId, revision, ...extra },
    });
  }
  async scheduleResearch(
    tx: DinnerTx,
    record: DinnerRecord<AppDinner>,
    eventId: string,
  ): Promise<void> {
    const s = record.state;
    if (
      record.endedAt ||
      s.dinner.status === "cancelled" ||
      !canPlan(s) ||
      s.dinner.status === "escalated"
    )
      return;
    if (!candidateSlots(s.dinner, this.now()).length) {
      await this.blockedResearch(tx, record, eventId, "NO_COMMON_TIME");
      return;
    }
    if (!this.config.MODEL_API_KEY) {
      await this.blockedResearch(tx, record, eventId, "SERVICE_UNCONFIGURED");
      return;
    }
    if (
      !(await tx.consumeUsage(
        "dinner-research",
        record.id,
        this.now().slice(0, 10),
        this.config.MAX_RESEARCH_PER_DINNER_PER_DAY,
      ))
    ) {
      await this.blockedResearch(tx, record, eventId, "USAGE_LIMIT");
      return;
    }
    await tx.client.query(
      "UPDATE research_runs SET attempt=attempt || jsonb_build_object('status','superseded','stage','done','finishedAt',$2::text,'updatedAt',$2::text) WHERE dinner_id=$1 AND id IN (SELECT id FROM outbox WHERE dinner_id=$1 AND kind='research' AND status='pending') AND attempt->>'status'='queued'",
      [record.id, this.now()],
    );
    // Pending work is durable but only the most recent complete inputs need a search.
    await tx.client.query(
      "UPDATE outbox SET status='suppressed',payload='{}'::jsonb,completed_at=now() WHERE kind='research' AND dinner_id=$1 AND status='pending'",
      [record.id],
    );
    await this.job(
      tx,
      eventId,
      "research",
      record.id,
      s.dinner.organizerId,
      record.revision,
      { researchVersion: researchVersion(s) },
    );
  }
  private async blockedResearch(
    tx: DinnerTx,
    record: DinnerRecord<AppDinner>,
    eventId: string,
    code: ResearchCode,
  ): Promise<void> {
    const attemptId = id(),
      now = this.now();
    await tx.createResearchAttempt({
      id: attemptId,
      dinnerId: record.id,
      inputVersion: researchVersion(record.state),
      requestedAt: now,
    });
    await tx.updateResearchAttempt(attemptId, {
      status: code === "NO_COMMON_TIME" ? "needs_checks" : "failed",
      stage: code === "NO_COMMON_TIME" ? "planning" : "provider",
      code,
      finishedAt: now,
      updatedAt: now,
      durationMs: 0,
    });
    await this.message(
      tx,
      eventId,
      record.organizerId,
      `${researchGuidance(code)} Reference: ${attemptId}`,
      {
        dinnerId: record.id,
        buttons: this.plannerButtons({ dinner: record.id }),
      },
    );
  }
  async announce(tx: DinnerTx, s: AppDinner, eventId: string): Promise<void> {
    const proposal = s.dinner.proposals.find(
      (p) => p.version === s.dinner.activeVersion,
    );
    if (!proposal) return;
    const feasible = evaluateFeasibility(
      s.dinner,
      proposal.options[0],
      this.now(),
    ).status;
    const selected = proposal.options[proposal.selectedIndex];
    const venue = proposal.venues.find((v) => v.id === selected.venueId);
    const when = DateTime.fromISO(selected.start)
      .setZone(s.dinner.setup.timezone)
      .toFormat("ccc, LLL d 'at' h:mm a");
    await this.broadcast(
      tx,
      s,
      eventId,
      s.dinner.status === "agreed"
        ? `Dinner agreed: ${venue?.name ?? "your venue"}, ${when}. Open the planner for the calendar and reservation handoff.`
        : `Dinner option ready: ${venue?.name ?? "a new venue"}, ${when}. ${feasible === "feasible" ? "Review and confirm in the planner." : "Some checks still need attention. Open the planner to review."}`,
      this.plannerButtons({ dinner: s.dinner.id }),
      proposal.version,
    );
  }

  async stageDecision(
    tx: DinnerTx,
    record: DinnerRecord<AppDinner>,
    user: string,
    decision: CoordinatorDecision,
    eventId: string,
  ): Promise<void> {
    const session = (await tx.getSession(user)) ?? emptySession();
    if (decision.kind === "clarify" || decision.questions.length) {
      await this.message(
        tx,
        eventId,
        user,
        `Please clarify privately: ${decision.questions.join(" ")}`,
        { dinnerId: record.id },
      );
      return;
    }
    if (decision.kind === "object") {
      await this.message(
        tx,
        eventId,
        user,
        "Use /change REASON to record an objection. Which requirement is firm and what is flexible?",
        { dinnerId: record.id },
      );
      return;
    }
    const patch = ManualConstraintSchema.parse(decision.patch),
      nonce = id();
    await tx.setSession(user, {
      ...session,
      pendingOnboard: {
        type: "patch",
        dinnerId: record.id,
        revision: record.revision,
        nonce,
        patch,
      },
    });
    await this.message(
      tx,
      eventId,
      user,
      `Review this update to your own private requirements. Budget amounts are ${record.state.dinner.setup.currency} per person:\n${JSON.stringify(patch, null, 2)}\nOnly apply if this accurately captures your willingness and requirements.`,
      {
        dinnerId: record.id,
        buttons: [
          [
            {
              text: "Apply my private update",
              callback_data: `apply:${record.id}:${nonce}`,
            },
          ],
        ],
      },
    );
  }
  async withdraw(
    tx: DinnerTx,
    user: string,
    eventId: string,
    remove: boolean,
  ): Promise<void> {
    const records = await tx.listDinnersForUser<AppDinner>(user);
    for (const record of records) {
      const s = AppDinnerSchema.parse(record.state);
      if (remove && s.dinner.organizerId === user) {
        await tx.deleteDinner(record.id);
        continue;
      }
      if (s.answerSharing) delete s.answerSharing[user];
      if (s.consents[user]) s.consents[user].active = false;
      // Unapproved answers must not remain eligible for later approval after opt-out.
      delete s.joinRequests[user];
      const ownConstraints = s.dinner.constraints[user];
      if (ownConstraints) {
        ownConstraints.busy = [];
        ownConstraints.calendarStatus = "not-connected";
        delete ownConstraints.calendarCheckedAt;
        delete ownConstraints.calendarWindow;
      }
      if (s.dinner.members.some((m) => m.id === user)) {
        // Preserve required membership as a blocker; no silent removal.
        s.dinner = {
          ...s.dinner,
          activeVersion: null,
          confirmations: {},
          status: s.dinner.status === "cancelled" ? "cancelled" : "collecting",
          revision: s.dinner.revision + 1,
          members: s.dinner.members.map((m) =>
            m.id === user ? { ...m, remindersOptIn: false } : m,
          ),
        };
      }
      if (remove) {
        delete s.dinner.constraints[user];
        delete s.joinRequests[user];
        delete s.consents[user];
        delete s.reminders[user];
        s.dinner.staffReports = s.dinner.staffReports.filter(
          (r) => r.memberId !== user,
        );
        s.dinner.disputes = s.dinner.disputes.filter(
          (r) => r.memberId !== user,
        );
        const tombstone = `deleted-${id()}`;
        s.roster = s.roster.map((r) =>
          r.id === user ? { id: tombstone, name: "Deleted participant" } : r,
        );
        s.dinner.members = s.dinner.members.map((m) =>
          m.id === user ? { ...m, id: tombstone } : m,
        );
        s.dinner.setup.intendedAttendees = s.dinner.setup.intendedAttendees.map(
          (memberId) => (memberId === user ? tombstone : memberId),
        );
        for (const venue of s.dinner.venues) delete venue.evidence.travel[user];
        // Immutable planning history is deleted for privacy rather than altered into misleading historical evidence.
        s.dinner.proposals = [];
        await tx.client.query(
          "DELETE FROM proposal_versions WHERE dinner_id=$1",
          [record.id],
        );
      }
      await this.save(tx, record, s);
      if (s.dinner.status !== "cancelled")
        await this.message(
          tx,
          eventId,
          s.dinner.organizerId,
          "A required participant withdrew participation. Agreement is blocked until you explicitly resolve membership; no attendee was silently removed.",
          { dinnerId: record.id },
        );
    }
    await tx.deleteUser(user);
    if (!remove) await tx.setSession(user, emptySession());
    await this.message(
      tx,
      eventId,
      user,
      remove
        ? "Your private data and calendar credentials were deleted. Dinners you organized were deleted. Revoke Google app access in your Google account if previously connected."
        : "Consent withdrawn. Pending messages and calendar credentials removed; required membership remains a planning blocker. To rejoin, use a new invitation.",
      { reply: true },
    );
  }
}

export function proposalButtons(d: Dinner): Buttons | undefined {
  if (d.activeVersion === null) return undefined;
  const p = d.proposals.find((p) => p.version === d.activeVersion)!;
  const buttons: Buttons = [
    [
      {
        text: `Confirm version ${p.version}`,
        callback_data: `confirm:${d.id}:${p.version}`,
      },
    ],
  ];
  if (p.options.length === 2)
    buttons.push([
      {
        text: "Organizer: select option 2",
        callback_data: `select:${d.id}:${p.version}:2`,
      },
    ]);
  return buttons;
}
function publicError(error: DomainError): string {
  if (error.code === "FEASIBILITY")
    return "This proposal still has unresolved or conflicting requirements. Agreement is blocked; request research or update your own requirements.";
  if (error.code === "DISPUTE")
    return "An objection remains open. Its author must resolve it; private objection details stay private.";
  if (error.code === "STALE")
    return "That control is stale. Use /status and review the current version before confirming.";
  return error.message;
}

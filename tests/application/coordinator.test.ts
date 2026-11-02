import { expect, it } from "vitest";
import {
  createDinner,
  approveMember,
  updateConstraints,
  setVenues,
  proposeOptions,
} from "../../src/domain/index.js";
import { Coordinator } from "../../src/application/coordinator.js";
import type { AppDinner } from "../../src/application/model.js";
import type {
  DinnerRecord,
  DinnerTx,
  Session,
} from "../../src/persistence/store.js";
import { tokenHash } from "../../src/adapters/security.js";

const now = "2026-10-28T12:00:00.000Z";
const setup = {
  city: "Chicago",
  area: "Loop",
  timezone: "America/Chicago",
  timezoneConfirmed: true as const,
  currency: "USD",
  currencyConfirmed: true as const,
  windowStart: "2026-10-29",
  windowEnd: "2026-11-05",
  durationMinutes: 90,
  budget: { amount: 60, basis: "per-person" as const },
  intendedAttendees: ["1", "2", "3"],
};
function base(): AppDinner {
  let dinner = createDinner("d1", "1", setup, now);
  dinner = approveMember(
    dinner,
    "1",
    { id: "2", consent: true, startedBot: true },
    now,
  );
  dinner = approveMember(
    dinner,
    "1",
    { id: "3", consent: true, startedBot: true },
    now,
  );
  return {
    dinner,
    roster: [
      { id: "1", name: "Organizer" },
      { id: "2", name: "Alex" },
      { id: "3", name: "Sam" },
    ],
    consents: {
      "1": { active: true, at: now, version: "1.0" },
      "2": { active: true, at: now, version: "1.0" },
      "3": { active: true, at: now, version: "1.0" },
    },
    joinRequests: {},
    reminders: {},
    collectionNotified: false,
  };
}
const claim = {
  status: "known" as const,
  url: "https://example.com/source",
  retrievedAt: now,
  excerpt: "checked",
};
function venue(id = "v1") {
  return {
    id,
    name: "Test Restaurant",
    address: "1 Main St",
    city: "Chicago",
    area: "Loop",
    evidence: {
      location: claim,
      price: {
        ...claim,
        amount: 40,
        basis: "per-person" as const,
        currency: "USD",
      },
      opening: {
        ...claim,
        intervals: [
          { start: "2026-10-30T00:00:00Z", end: "2026-10-30T05:00:00Z" },
        ],
      },
      reservation: { ...claim, state: "not-booked" as const },
      dietary: {},
      travel: {},
    },
  };
}
function withProposal(s = base()): AppDinner {
  for (const id of ["1", "2", "3"])
    s.dinner = updateConstraints(
      s.dinner,
      id,
      {
        availability: [
          { start: "2026-10-30T00:00:00Z", end: "2026-10-30T05:00:00Z" },
        ],
      },
      now,
    );
  s.dinner = setVenues(s.dinner, "1", [venue()], now);
  s.dinner = proposeOptions(
    s.dinner,
    "1",
    [
      {
        venueId: "v1",
        start: "2026-10-30T01:00:00Z",
        end: "2026-10-30T02:30:00Z",
        pricePerPerson: 40,
        priceBasis: "per-person",
        durationMinutes: 90,
      },
    ],
    now,
  );
  return s;
}
function fakeTx(
  state: AppDinner,
  session: Session | null = {
    currentDinnerId: "d1",
    pendingSetup: null,
    pendingOnboard: null,
  },
) {
  let record: DinnerRecord<AppDinner> = {
    id: "d1",
    organizerId: "1",
    revision: 0,
    state,
    endedAt: null,
  };
  const out: any[] = [];
  const sessions = new Map<string, Session>();
  for (const member of state.dinner.members)
    sessions.set(member.id, {
      currentDinnerId: "d1",
      pendingSetup: null,
      pendingOnboard: null,
    });
  if (session) sessions.set("1", session);
  const tx: any = {
    out,
    getSession: async (id: string) => sessions.get(id) ?? null,
    setSession: async (id: string, value: Session) => sessions.set(id, value),
    getDinner: async (id: string) => (id === "d1" ? record : null),
    saveDinner: async (next: DinnerRecord<AppDinner>, expected: number) => {
      record = { ...next, revision: expected + 1 };
      return record;
    },
    saveProposal: async () => {},
    queue: async (w: any) => out.push(w),
    consumeUsage: async () => true,
    findActiveDinner: async () => null,
    activeDinnerCount: async () => 0,
    createDinner: async () => {},
    createInvitation: async () => {},
    lookupInvitation: async (hash: string) =>
      hash === tokenHash("join-token") ? "d1" : null,
    listDinnersForUser: async (user: string) =>
      record.state.dinner.members.some((m) => m.id === user) ||
      record.organizerId === user
        ? [record]
        : [],
    deleteUser: async (user: string) => sessions.delete(user),
    client: { query: async () => ({ rowCount: 1, rows: [] }) },
    get state() {
      return record.state;
    },
    get record() {
      return record;
    },
  };
  return tx as DinnerTx & {
    out: any[];
    state: AppDinner;
    record: DinnerRecord<AppDinner>;
  };
}
const config: any = {
  PUBLIC_URL: "https://planner.example",
  SUPPORT_CONTACT: "help@example.com",
  MAX_UPDATES_PER_USER_PER_DAY: 100,
  MAX_ACTIVE_DINNERS: 20,
  MAX_RESEARCH_PER_DINNER_PER_DAY: 10,
  TELEGRAM_BOT_USERNAME: "plannerbot",
  MODEL_API_KEY: undefined,
};
const send = async (
  coordinator: Coordinator,
  tx: any,
  actorId: string,
  text: string,
  chatId = actorId,
  eventId = `e-${Math.random()}`,
) =>
  coordinator.handle(tx, {
    eventId,
    actorId,
    chatId,
    name: `User ${actorId}`,
    text,
    ...(/^(choose|consent|approve|apply|confirm|select|staff):/.test(text)
      ? { callbackId: "synthetic-button-click" }
      : {}),
  });

it("blocks a nonmember using a selected dinner id without exposing private data", async () => {
  const s = base();
  s.dinner.constraints["2"] = { preferences: ["SECRET allergy and budget"] };
  const tx = fakeTx(s, {
    currentDinnerId: "d1",
    pendingSetup: null,
    pendingOnboard: null,
  });
  (tx as any).setSession("outsider", {
    currentDinnerId: "d1",
    pendingSetup: null,
    pendingOnboard: null,
  });
  await send(
    new Coordinator(config, undefined, () => now),
    tx,
    "outsider",
    "/status",
  );
  const reply = tx.out.at(-1).payload.text;
  expect(reply).toContain(
    "Approved membership and current consent are required",
  );
  expect(reply).not.toContain("SECRET");
});

it("requires invite selection, active consent, and organizer approval before membership", async () => {
  const dinner = createDinner("d1", "1", setup, now);
  const s: AppDinner = {
    dinner,
    roster: [
      { id: "1", name: "Organizer" },
      { id: "2", name: "Alex" },
      { id: "3", name: "Sam" },
    ],
    consents: { "1": { active: true, at: now, version: "1.0" } },
    joinRequests: {},
    reminders: {},
    collectionNotified: false,
  };
  const tx = fakeTx(s, {
      currentDinnerId: "d1",
      pendingSetup: null,
      pendingOnboard: null,
    }),
    coordinator = new Coordinator(config, undefined, () => now);
  await send(coordinator, tx, "99", "/start join-token");
  expect(tx.out.at(-1).payload.text).toContain("Approval is required");
  await send(coordinator, tx, "99", "choose:d1:1");
  expect(tx.out.at(-1).payload.text).toContain("/stop withdraws consent");
  await send(coordinator, tx, "99", "consent:d1:1");
  expect(tx.state.dinner.members.some((m) => m.id === "99")).toBe(false);
  await send(coordinator, tx, "1", "/approve 99 2");
  expect(tx.state.dinner.members.some((m) => m.id === "99")).toBe(true);
  expect(tx.state.consents["99"].active).toBe(true);
});

it("requires a new invitation, consent and organizer reapproval after a participant stops", async () => {
  const tx = fakeTx(base());
  const coordinator = new Coordinator(config, undefined, () => now);
  await send(coordinator, tx, "2", "/stop");
  expect(tx.state.consents["2"].active).toBe(false);
  expect(tx.state.dinner.members.find((m) => m.id === "2")?.required).toBe(
    true,
  );
  await send(coordinator, tx, "2", "/start join-token");
  await send(coordinator, tx, "2", "choose:d1:1");
  await send(coordinator, tx, "2", "consent:d1:1");
  // Consent alone is not reapproval: the member remains blocked until the organizer acts.
  await send(coordinator, tx, "2", "/status");
  expect(tx.out.at(-1).payload.text).toContain(
    "Approved membership and current consent are required",
  );
  await send(coordinator, tx, "1", "/approve 2 2");
  expect(tx.state.consents["2"].active).toBe(true);
  await send(coordinator, tx, "2", "/status");
  expect(tx.out.at(-1).payload.text).toContain("Dinner d1:");
});

it("expires invitation selection ten minutes after the invitation was opened", async () => {
  let clock = now;
  const tx = fakeTx(createInviteFixture());
  const coordinator = new Coordinator(config, undefined, () => clock);
  await send(coordinator, tx, "99", "/start join-token");
  clock = "2026-10-28T12:11:00.000Z";
  await send(coordinator, tx, "99", "choose:d1:1");
  expect(tx.state.consents["99"]).toBeUndefined();
  expect(tx.state.joinRequests["99"]).toBeUndefined();
  expect(tx.out.at(-1).payload.text).toMatch(/stale|expired/i);
});

function createInviteFixture(): AppDinner {
  const dinner = createDinner("d1", "1", setup, now);
  return {
    dinner,
    roster: [
      { id: "1", name: "Organizer" },
      { id: "2", name: "Alex" },
      { id: "3", name: "Sam" },
    ],
    consents: { "1": { active: true, at: now, version: "1.0" } },
    joinRequests: {},
    reminders: {},
    collectionNotified: false,
  };
}

it("requires organizer review completion before setup can be created", async () => {
  const tx = fakeTx(base(), null);
  const coordinator = new Coordinator(config, undefined, () => now);
  (tx as any).getSession = async () => ({
    currentDinnerId: null,
    pendingSetup: { step: 7, values: { city: "Chicago" }, name: "Organizer" },
    pendingOnboard: null,
  });
  await send(coordinator, tx, "1", "/create");
  expect(tx.out.at(-1).payload.text).toMatch(
    /Complete setup first|Review setup/i,
  );
  expect(tx.record.state.dinner.id).toBe("d1");
  let created: any;
  (tx as any).createDinner = async (value: any) => {
    created = value;
  };
  (tx as any).getSession = async () => ({
    currentDinnerId: null,
    pendingSetup: {
      step: 8,
      name: "Organizer",
      values: {
        city: "Chicago",
        area: "Loop",
        timezone: "America/Chicago",
        windowStart: "2026-10-29",
        windowEnd: "2026-11-05",
        durationMinutes: 90,
        budget: { amount: 60, basis: "per-person" },
        currency: "USD",
        names: ["Alex", "Sam"],
      },
    },
    pendingOnboard: null,
  });
  await send(coordinator, tx, "1", "/create");
  expect(created.state.dinner.setup.timezone).toBe("America/Chicago");
  expect(created.state.dinner.setup.intendedAttendees).toHaveLength(3);
  expect(tx.out.at(-1).payload.text).toContain("created");
});
it("REV-01 adding an attendee preserves constraints and invalidates an agreed proposal until joining is complete", async () => {
  const s = withProposal();
  s.dinner.status = "agreed";
  s.dinner.confirmations = { "1": 1, "2": 1, "3": 1 };
  const originalConstraints = structuredClone(s.dinner.constraints),
    tx = fakeTx(s),
    coordinator = new Coordinator(config, undefined, () => now);
  await send(coordinator, tx, "2", "/add_attendee Jo");
  expect(tx.state.roster).toHaveLength(3);
  await send(coordinator, tx, "1", "/add_attendee Jo");
  expect(tx.state.roster).toHaveLength(4);
  expect(tx.state.dinner.setup.intendedAttendees).toHaveLength(4);
  expect(tx.state.dinner.constraints).toEqual(originalConstraints);
  expect(tx.state.dinner.activeVersion).toBeNull();
  expect(tx.state.dinner.confirmations).toEqual({});
  expect(tx.state.dinner.proposals).toHaveLength(1);
});

it("rejects a confirmation callback for a stale proposal version", async () => {
  const tx = fakeTx(withProposal());
  await send(
    new Coordinator(config, undefined, () => now),
    tx,
    "2",
    "confirm:d1:0",
  );
  expect(tx.state.dinner.confirmations).toEqual({});
  expect(tx.out.at(-1).payload.text).toMatch(/stale|current proposal/i);
});

it("publishes a shared plan without private constraints or objection text", async () => {
  const s = withProposal();
  s.dinner.constraints["2"] = { preferences: ["SECRET private appointment"] };
  const tx = fakeTx(s);
  await send(new Coordinator(config, undefined, () => now), tx, "2", "/status");
  const reply = tx.out.at(-1).payload.text;
  expect(reply).toContain("Test Restaurant");
  expect(reply).toContain("no booking made");
  expect(reply).not.toContain("SECRET");
});

it("adds a new dietary requirement without replacing existing firm requirements", async () => {
  const s = base();
  s.dinner.constraints["2"] = {
    dietary: [{ requirement: "gluten", strength: "firm", allergy: false }],
  };
  const tx = fakeTx(s);
  await send(
    new Coordinator(config, undefined, () => now),
    tx,
    "2",
    '/constraints {"dietary":[{"requirement":"peanut","strength":"firm","allergy":true}]}',
  );
  expect(tx.state.dinner.constraints["2"].dietary).toEqual([
    { requirement: "gluten", strength: "firm", allergy: false },
    { requirement: "peanut", strength: "firm", allergy: true },
  ]);
});

it("routes ordinary budget prose through Muse extraction instead of treating it as a control callback", async () => {
  const tx = fakeTx(base());
  const coordinator = new Coordinator(
    { ...config, MODEL_API_KEY: "test-key" },
    undefined,
    () => now,
  );
  await send(coordinator, tx, "2", "Budget: $55 per person, including tip");
  const extraction = tx.out.find((work: any) => work.kind === "extract");
  expect(extraction.payload.message).toBe(
    "Budget: $55 per person, including tip",
  );
  expect(tx.state.dinner.constraints["2"]?.budget).toBeUndefined();
  expect(
    tx.out.some((work: any) =>
      /review it|Nothing changes until you approve/i.test(work.payload.text),
    ),
  ).toBe(true);
});

it("invalidates confirmations when the organizer changes the dinner schedule", async () => {
  const s = withProposal();
  s.dinner.confirmations = { "1": 1 };
  s.dinner.status = "proposed";
  const tx = fakeTx(s);
  await send(
    new Coordinator(config, undefined, () => now),
    tx,
    "1",
    '/setup {"durationMinutes":120}',
  );
  expect(tx.state.dinner.activeVersion).toBeNull();
  expect(tx.state.dinner.confirmations).toEqual({});
});

it("does not treat an unconfirmed negative or uncertain staff report as safety evidence", async () => {
  const s = withProposal();
  s.dinner.constraints["2"] = {
    dietary: [{ requirement: "peanut", strength: "firm", allergy: true }],
  };
  s.dinner.confirmations = { "1": 1 };
  s.dinner.status = "proposed";
  const tx = fakeTx(s);
  await send(
    new Coordinator(config, undefined, () => now),
    tx,
    "2",
    "/staff v1 peanut | staff could not confirm safe handling",
  );
  expect(tx.state.dinner.staffReports).toEqual([]);
  expect(tx.state.dinner.activeVersion).toBe(1);
  expect(tx.state.dinner.confirmations).toEqual({ "1": 1 });
});
it("JOIN-01 a stopped organizer explicitly reconsents without needing an unauthorized self-approval", async () => {
  const tx = fakeTx(base()),
    coordinator = new Coordinator(config, undefined, () => now);
  await send(coordinator, tx, "1", "/stop");
  (tx as any).findActiveDinner = async (user: string) =>
    user === "1" ? tx.record : null;
  await send(coordinator, tx, "1", "/resume");
  const callback = tx.out.at(-1).payload.buttons[0][0].callback_data;
  await coordinator.handle(tx, {
    eventId: "organizer-resume-click",
    actorId: "1",
    chatId: "1",
    name: "Organizer",
    text: callback,
    callbackId: "fixture-click",
  });
  expect(tx.state.consents["1"].active).toBe(true);
  expect(tx.state.joinRequests["1"]).toBeUndefined();
  await send(coordinator, tx, "1", "/status");
  expect(tx.out.at(-1).payload.text).toContain("Dinner d1");
});

it("records a staff safety report only after the affected participant explicitly confirms it", async () => {
  const s = withProposal();
  s.dinner.constraints["2"] = {
    dietary: [{ requirement: "peanut", strength: "firm", allergy: true }],
  };
  s.dinner.confirmations = { "1": 1 };
  s.dinner.status = "proposed";
  const tx = fakeTx(s),
    coordinator = new Coordinator(config, undefined, () => now);
  await send(
    coordinator,
    tx,
    "2",
    "/staff v1 peanut | staff confirmed dedicated clean cookware",
  );
  expect(tx.state.dinner.staffReports).toEqual([]);
  const callback = tx.out.at(-1).payload.buttons[0][0].callback_data;
  expect(callback).toMatch(/^staff:d1:/);
  await send(coordinator, tx, "2", callback);
  expect(tx.state.dinner.staffReports).toMatchObject([
    {
      memberId: "2",
      venueId: "v1",
      requirement: "peanut",
      report: "staff confirmed dedicated clean cookware",
    },
  ]);
  expect(tx.state.dinner.activeVersion).toBeGreaterThan(1);
  expect(tx.state.dinner.confirmations).toEqual({});
  expect(tx.state.dinner.proposals.at(-1)?.version).toBe(
    tx.state.dinner.activeVersion,
  );
  expect(
    tx.out.some((work: any) =>
      /version 2|fresh proposal|Dinner option ready/i.test(work.payload.text),
    ),
  ).toBe(true);
});

it("UI-01 /start establishes trusted bot access and opens one form without a questionnaire", async () => {
  const tx = fakeTx(base());
  const coordinator = new Coordinator(config, undefined, () => now);
  await send(coordinator, tx, "999", "/start");
  expect(await tx.getSession("999")).not.toBeNull();
  expect(tx.out.at(-1).payload.buttons[0][0]).toEqual({
    text: "Open planner",
    web_app: { url: "https://planner.example/app/" },
  });
  expect(tx.out.at(-1).payload.text).not.toContain("/constraints JSON");
  await send(coordinator, tx, "999", "/new");
  expect((await tx.getSession("999"))?.pendingSetup).toBeNull();
  expect(tx.out.at(-1).payload.buttons[0][0].web_app.url).toContain(
    "view=create",
  );
});
it("UI-01 invitations open a private response form without name selection", async () => {
  const tx = fakeTx(createInviteFixture());
  await send(
    new Coordinator(config, undefined, () => now),
    tx,
    "999",
    "/start join-token",
  );
  expect(tx.out.at(-1).payload.buttons[0][0].web_app.url).toContain(
    "invite=join-token",
  );
  expect(tx.out.at(-1).payload.text).not.toContain("Select the name");
});

it("CAL-01 PRIV-02 stop clears obsolete calendar checks while preserving manual willingness", async () => {
  const state = base();
  state.dinner.constraints["2"] = {
    ...state.dinner.constraints["2"],
    availability: [
      { start: "2026-10-30T00:00:00Z", end: "2026-10-30T05:00:00Z" },
    ],
    busy: [{ start: "2026-10-30T00:00:00Z", end: "2026-10-30T01:00:00Z" }],
    calendarStatus: "unavailable",
    calendarCheckedAt: now,
    calendarWindow: {
      start: "2026-10-30T00:00:00Z",
      end: "2026-10-30T05:00:00Z",
    },
  };
  const tx = fakeTx(state);
  await send(new Coordinator(config, undefined, () => now), tx, "2", "/stop");
  expect(tx.state.dinner.constraints["2"].calendarStatus).toBe("not-connected");
  expect(tx.state.dinner.constraints["2"].busy).toEqual([]);
  expect(tx.state.dinner.constraints["2"].calendarCheckedAt).toBeUndefined();
  expect(tx.state.dinner.constraints["2"].calendarWindow).toBeUndefined();
  expect(tx.state.dinner.constraints["2"].availability).toHaveLength(1);
  expect(await tx.getSession("2")).toEqual({
    currentDinnerId: null,
    pendingSetup: null,
    pendingOnboard: null,
  });
});

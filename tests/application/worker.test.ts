import { expect, it } from "vitest";
import {
  createDinner,
  approveMember,
  updateConstraints,
} from "../../src/domain/index.js";
import { Worker, researchContext } from "../../src/application/worker.js";
import { Coordinator } from "../../src/application/coordinator.js";
import type { AppDinner } from "../../src/application/model.js";

const now = "2026-10-28T12:00:00.000Z";
function dinnerState(): AppDinner {
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
    budget: { amount: 180, basis: "total" as const },
    intendedAttendees: ["1001", "1002", "1003"],
  };
  let dinner = createDinner("d1", "1001", setup, now);
  dinner = approveMember(
    dinner,
    "1001",
    { id: "1002", consent: true, startedBot: true },
    now,
  );
  dinner = approveMember(
    dinner,
    "1001",
    { id: "1003", consent: true, startedBot: true },
    now,
  );
  for (const id of ["1001", "1002", "1003"])
    dinner = updateConstraints(
      dinner,
      id,
      {
        availability: [
          { start: "2026-10-30T00:00:00Z", end: "2026-10-30T05:00:00Z" },
        ],
      },
      now,
    );
  dinner = updateConstraints(
    dinner,
    "1002",
    {
      budget: { amount: 45, strength: "firm" },
      dietary: [
        { requirement: "peanut allergy", strength: "firm", allergy: true },
      ],
      travel: { origin: "private home", maxMinutes: 25, strength: "firm" },
    },
    now,
  );
  return {
    dinner,
    roster: [1001, 1002, 1003].map((id, i) => ({
      id: String(id),
      name: `Person ${i + 1}`,
    })),
    consents: Object.fromEntries(
      [1001, 1002, 1003].map((id) => [
        String(id),
        { active: true, at: now, version: "1.0" as const },
      ]),
    ),
    joinRequests: {},
    reminders: {},
    collectionNotified: false,
  };
}

it("maps research aliases back to private identities only in the application-side alias table", () => {
  const s = dinnerState(),
    { context, aliases } = researchContext(s, now);
  expect(aliases).toEqual({
    "person-1": "1001",
    "person-2": "1002",
    "person-3": "1003",
  });
  expect(context.setup.intendedAttendees).toEqual([
    "person-1",
    "person-2",
    "person-3",
  ]);
  expect(context.dietary).toEqual([
    { requirement: "peanut allergy", allergy: true },
  ]);
  expect(context.travel).toEqual([
    { alias: "person-2", origin: "private home", maxMinutes: 25 },
  ]);
  expect(context.setup.budget).toEqual({ amount: 45, basis: "per-person" });
  expect(JSON.stringify(context)).not.toContain("1002");
});

it("suppresses an already queued dinner message after recipient withdraws consent", async () => {
  const state = dinnerState();
  state.consents["1002"].active = false;
  const record = {
    id: "d1",
    organizerId: "1001",
    revision: 0,
    state,
    endedAt: null,
  };
  const store: any = {
    transaction: async (fn: any) => fn({ getDinner: async () => record }),
    markSuppressed: async (id: string) => store.suppressed.push(id),
    suppressed: [],
  };
  const sends: any[] = [];
  const telegram: any = { send: async (payload: any) => sends.push(payload) };
  const config: any = {
    PUBLIC_URL: "https://planner.example",
    SUPPORT_CONTACT: "help@example.com",
    MAX_UPDATES_PER_USER_PER_DAY: 100,
    MAX_ACTIVE_DINNERS: 20,
    MAX_RESEARCH_PER_DINNER_PER_DAY: 10,
    TELEGRAM_BOT_USERNAME: "plannerbot",
    CREDENTIAL_ENCRYPTION_KEY: "unused",
  };
  const worker = new Worker(
    store,
    new Coordinator(config, undefined, () => now),
    telegram,
  );
  await worker.send({
    id: "out-1",
    payload: { chatId: "1002", dinnerId: "d1", text: "Private dinner update" },
    attempts: 1,
    kind: "message",
  } as any);
  expect(sends).toEqual([]);
  expect(store.suppressed).toEqual(["out-1"]);
});

it("suppresses a reminder when reminder opt-in has been withdrawn", async () => {
  const state = dinnerState();
  state.dinner.members.find((m) => m.id === "1002")!.remindersOptIn = false;
  const record = {
    id: "d1",
    organizerId: "1001",
    revision: 0,
    state,
    endedAt: null,
  };
  const store: any = {
    transaction: async (fn: any) => fn({ getDinner: async () => record }),
    markSuppressed: async (id: string) => store.suppressed.push(id),
    suppressed: [],
  };
  const sends: any[] = [];
  const worker = new Worker(
    store,
    new Coordinator(
      {
        PUBLIC_URL: "https://planner.example",
        SUPPORT_CONTACT: "help@example.com",
      } as any,
      undefined,
      () => now,
    ),
    { send: async (p: any) => sends.push(p) } as any,
  );
  await worker.send({
    id: "reminder-1",
    payload: {
      chatId: "1002",
      dinnerId: "d1",
      text: "Reminder",
      reminder: true,
    },
    attempts: 1,
    kind: "message",
  } as any);
  expect(sends).toEqual([]);
  expect(store.suppressed).toEqual(["reminder-1"]);
});

it("suppresses an opted-in reminder whose local reminder day is stale", async () => {
  const state = dinnerState();
  state.dinner.members.find((m) => m.id === "1002")!.remindersOptIn = true;
  const record = {
    id: "d1",
    organizerId: "1001",
    revision: 0,
    state,
    endedAt: null,
  };
  const store: any = {
    transaction: async (fn: any) => fn({ getDinner: async () => record }),
    markSuppressed: async (id: string) => store.suppressed.push(id),
    suppressed: [],
  };
  const sends: any[] = [];
  const worker = new Worker(
    store,
    new Coordinator(
      {
        PUBLIC_URL: "https://planner.example",
        SUPPORT_CONTACT: "help@example.com",
      } as any,
      undefined,
      () => now,
    ),
    { send: async (p: any) => sends.push(p) } as any,
  );
  await worker.send({
    id: "reminder-old-day",
    payload: {
      chatId: "1002",
      dinnerId: "d1",
      text: "Reminder",
      reminder: true,
      reminderDay: "2026-10-27",
    },
    attempts: 1,
    kind: "message",
  } as any);
  expect(sends).toEqual([]);
  expect(store.suppressed).toEqual(["reminder-old-day"]);
});

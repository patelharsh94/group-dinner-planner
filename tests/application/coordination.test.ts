import { expect, it } from "vitest";
import {
  ensureCoordination,
  respondCoordination,
  coordinationView,
} from "../../src/application/coordination.js";
import {
  createDinner,
  approveMember,
  updateConstraints,
} from "../../src/domain/index.js";
import type { AppDinner } from "../../src/application/model.js";
const now = "2026-11-02T12:00:00Z";
function fixture(): AppDinner {
  let d = createDinner(
    "coord-dinner",
    "a",
    {
      city: "Chicago",
      area: "Loop",
      timezone: "America/Chicago",
      timezoneConfirmed: true,
      currency: "USD",
      currencyConfirmed: true,
      windowStart: "2026-11-10",
      windowEnd: "2026-11-12",
      durationMinutes: 90,
      budget: { amount: 60, basis: "per-person" },
      intendedAttendees: ["a", "b"],
    },
    now,
  );
  d = approveMember(d, "a", { id: "b", consent: true, startedBot: true }, now);
  for (const [user, date] of [
    ["a", "10"],
    ["b", "11"],
  ])
    d = updateConstraints(
      d,
      user,
      {
        dietary: [],
        availability: [
          {
            start: `2026-11-${date}T18:00:00-06:00`,
            end: `2026-11-${date}T22:00:00-06:00`,
          },
        ],
      },
      now,
    );
  return {
    dinner: d,
    roster: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
    consents: {
      a: { active: true, at: now, version: "1.0" },
      b: { active: true, at: now, version: "1.0" },
    },
    joinRequests: {},
    reminders: {},
    collectionNotified: false,
  };
}
it("TIME-COORD creates two bounded suggestions; silence never adds willingness", () => {
  const s = fixture(),
    next = ensureCoordination(s, now);
  expect(next.coordination?.round).toBe(1);
  expect(next.coordination?.suggestions).toHaveLength(2);
  expect(next.dinner.constraints).toEqual(s.dinner.constraints);
  expect(ensureCoordination(next, now)).toEqual(next);
  expect(coordinationView(next, "a")?.suggestions.length).toBe(2);
});
it("TIME-COORD explicit acceptance adds only that window and respects busy conflicts", () => {
  let s = ensureCoordination(fixture(), now);
  const suggestion = s.coordination!.suggestions.find(
    (x) =>
      !s.dinner.constraints.b.availability!.some(
        (w) =>
          Date.parse(w.start) <= Date.parse(x.start) &&
          Date.parse(w.end) >= Date.parse(x.end),
      ),
  )!;
  const original = structuredClone(s.dinner.constraints.a);
  const next = respondCoordination(
    s,
    "b",
    { suggestionId: suggestion.id, response: "accept" },
    now,
  );
  expect(next.dinner.constraints.b.availability).toContainEqual({
    start: suggestion.start,
    end: suggestion.end,
  });
  expect(next.dinner.constraints.a).toEqual(original);
  s.dinner.constraints.b.busy = [
    { start: suggestion.start, end: suggestion.end },
  ];
  expect(() =>
    respondCoordination(
      s,
      "b",
      { suggestionId: suggestion.id, response: "accept" },
      now,
    ),
  ).toThrow();
});
it("TIME-COORD declines preserve inputs and escalate after two rounds; stale/unauthorized responses cannot apply", () => {
  let s = ensureCoordination(fixture(), now);
  for (let round = 1; round <= 2; round++) {
    for (const suggestion of s.coordination!.suggestions)
      for (const user of ["a", "b"])
        s = respondCoordination(
          s,
          user,
          { suggestionId: suggestion.id, response: "decline" },
          now,
        );
    s = ensureCoordination(s, now);
  }
  expect(s.coordination?.status).toBe("escalated");
  const old = s.coordination!.suggestions[0].id;
  expect(() =>
    respondCoordination(
      s,
      "outsider",
      { suggestionId: old, response: "accept" },
      now,
    ),
  ).toThrow();
  s.dinner.constraints.a.availability = [];
  expect(() =>
    respondCoordination(s, "b", { suggestionId: old, response: "accept" }, now),
  ).toThrow();
});

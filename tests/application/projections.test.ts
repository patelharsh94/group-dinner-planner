import { expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import {
  createDinner,
  approveMember,
  updateConstraints,
} from "../../src/domain/index.js";
import {
  candidateSlots,
  progress,
  sharedPlan,
  type AppDinner,
} from "../../src/application/model.js";
const now = "2026-10-28T12:00:00Z";
function fixture(): AppDinner {
  let dinner = createDinner(
    "test",
    "one",
    {
      city: "Test City",
      area: "Centre",
      timezone: "America/Chicago",
      timezoneConfirmed: true,
      currency: "USD",
      currencyConfirmed: true,
      windowStart: "2026-10-29",
      windowEnd: "2026-11-05",
      durationMinutes: 90,
      budget: { amount: 60, basis: "per-person" },
      intendedAttendees: ["one", "two", "three"],
    },
    now,
  );
  for (const id of ["two", "three"])
    dinner = approveMember(
      dinner,
      "one",
      { id, consent: true, startedBot: true },
      now,
    );
  return {
    dinner,
    roster: ["one", "two", "three"].map((id) => ({ id, name: id })),
    consents: {},
    joinRequests: {},
    reminders: {},
    collectionNotified: false,
  };
}
it("PRIV-01 shared summaries never contain raw requirements or objection reasons", () => {
  const s = fixture();
  s.dinner.constraints.one = { preferences: ["PRIVATE cancer appointment"] };
  expect(sharedPlan(s, now)).not.toContain("PRIVATE");
  expect(progress(s)).toContain("3/3 approved");
});
it("CON-01 CAL-01 intersects willingness and subtracts calendar busy without assuming willingness", () => {
  const s = fixture();
  expect(candidateSlots(s.dinner, now)).toEqual([]);
  for (const id of ["one", "two", "three"])
    s.dinner = updateConstraints(
      s.dinner,
      id,
      {
        availability: [
          {
            start: "2026-10-29T18:00:00-05:00",
            end: "2026-10-29T22:00:00-05:00",
          },
        ],
      },
      now,
    );
  s.dinner.constraints.two.busy = [
    { start: "2026-10-29T18:30:00-05:00", end: "2026-10-29T20:00:00-05:00" },
  ];
  const slots = candidateSlots(s.dinner, now);
  expect(slots[0].start).toBe("2026-10-30T01:00:00.000Z");
  expect(
    slots.every(
      (s) => Date.parse(s.start) >= Date.parse("2026-10-29T20:00:00-05:00"),
    ),
  ).toBe(true);
});

it("treats all-day willingness as including evening dinner slots", () => {
  const s = fixture();
  for (const id of ["one", "two", "three"])
    s.dinner = updateConstraints(
      s.dinner,
      id,
      {
        availability: [
          {
            start: "2026-10-29T00:00:00-05:00",
            end: "2026-10-30T00:00:00-05:00",
          },
        ],
      },
      now,
    );
  const slots = candidateSlots(s.dinner, now);
  expect(slots.some((slot) => slot.start === "2026-10-30T00:00:00.000Z")).toBe(
    true,
  );
});

it("clips huge availability and irrelevant busy intervals to the bounded dinner window", () => {
  const s = fixture();
  for (const id of ["one", "two", "three"])
    s.dinner = updateConstraints(
      s.dinner,
      id,
      {
        availability: [
          { start: "1900-01-01T00:00:00Z", end: "9999-12-31T23:59:00Z" },
        ],
        ...(id === "two"
          ? {
              busy: [
                { start: "1800-01-01T00:00:00Z", end: "1899-12-31T23:59:00Z" },
              ],
            }
          : {}),
      },
      now,
    );
  const started = performance.now(),
    slots = candidateSlots(s.dinner, now),
    elapsed = performance.now() - started;
  expect(elapsed).toBeLessThan(3000);
  expect(slots.length).toBeGreaterThan(0);
  expect(
    slots.every(
      (slot) =>
        slot.start >= "2026-10-29T05:00:00.000Z" &&
        slot.end <= "2026-11-06T06:00:00.000Z",
    ),
  ).toBe(true);
});

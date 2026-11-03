import { createHash, randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  DomainError,
  updateConstraints,
  type Interval,
} from "../domain/index.js";
import type { AppDinner } from "./model.js";
const suggestionSchema = z.object({
  id: z.string(),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  acceptedBy: z.array(z.string()),
  declinedBy: z.array(z.string()),
});
export const CoordinationSchema = z.object({
  id: z.string(),
  inputVersion: z.string(),
  round: z.number().int().min(1).max(2),
  status: z.enum(["waiting", "resolved", "escalated"]),
  createdAt: z.string().datetime({ offset: true }),
  suggestions: z.array(suggestionSchema).max(2),
});
type Suggestion = z.infer<typeof suggestionSchema>;
function required(s: AppDinner) {
  return s.dinner.members.filter((m) => m.required);
}
function fingerprint(s: AppDinner) {
  const d = s.dinner;
  return createHash("sha256")
    .update(
      JSON.stringify({
        setup: d.setup,
        members: required(s).map((m) => m.id),
        inputs: required(s).map((m) => ({
          id: m.id,
          consent: s.consents[m.id]?.active,
          availability: d.constraints[m.id]?.availability,
          busy: d.constraints[m.id]?.busy,
          calendar: d.constraints[m.id]?.calendarStatus,
        })),
      }),
    )
    .digest("hex");
}
function active(s: AppDinner, user: string) {
  return (
    !!s.consents[user]?.active &&
    !s.joinRequests[user] &&
    s.dinner.members.some((m) => m.id === user)
  );
}
function covers(s: AppDinner, user: string, slot: Interval) {
  const c = s.dinner.constraints[user];
  return (
    !!c?.availability?.some(
      (w) =>
        Date.parse(w.start) <= Date.parse(slot.start) &&
        Date.parse(w.end) >= Date.parse(slot.end),
    ) &&
    !c?.busy?.some(
      (w) =>
        Date.parse(w.start) < Date.parse(slot.end) &&
        Date.parse(w.end) > Date.parse(slot.start),
    )
  );
}
function candidates(
  s: AppDinner,
  now: string,
  excluded: Set<string>,
): Interval[] {
  const d = s.dinner,
    found = new Map<string, Interval>(),
    duration = d.setup.durationMinutes * 60000;
  const first = DateTime.fromISO(d.setup.windowStart, {
      zone: d.setup.timezone,
    })
      .startOf("day")
      .toMillis(),
    last = DateTime.fromISO(d.setup.windowEnd, { zone: d.setup.timezone })
      .endOf("day")
      .toMillis();
  for (const m of required(s))
    for (const w of d.constraints[m.id]?.availability ?? []) {
      const lower = Math.max(
          first,
          Date.parse(now) + 60000,
          Date.parse(w.start),
        ),
        upper = Math.min(last, Date.parse(w.end));
      for (
        let start = Math.ceil(lower / 1800000) * 1800000;
        start + duration <= upper;
        start += 1800000
      ) {
        const slot = {
          start: new Date(start).toISOString(),
          end: new Date(start + duration).toISOString(),
        };
        if (!excluded.has(slot.start) && covers(s, m.id, slot))
          found.set(slot.start, slot);
      }
    }
  const count = (slot: Interval) =>
    required(s).filter((m) => covers(s, m.id, slot)).length;
  const dinnerDistance = (slot: Interval) =>
    Math.abs(
      DateTime.fromISO(slot.start).setZone(d.setup.timezone).hour * 60 +
        DateTime.fromISO(slot.start).setZone(d.setup.timezone).minute -
        19 * 60,
    );
  const ranked = [...found.values()].sort(
    (a, b) =>
      count(b) - count(a) ||
      dinnerDistance(a) - dinnerDistance(b) ||
      Date.parse(a.start) - Date.parse(b.start),
  );
  const picks: Interval[] = [],
    dates = new Set<string>();
  for (const slot of ranked) {
    const date = DateTime.fromISO(slot.start)
      .setZone(d.setup.timezone)
      .toISODate()!;
    if (!dates.has(date)) {
      picks.push(slot);
      dates.add(date);
    }
    if (picks.length === 2) return picks;
  }
  return [
    ...picks,
    ...ranked.filter((slot) => !picks.some((p) => p.start === slot.start)),
  ].slice(0, 2);
}
/** Called only after all required members supplied manual answers and no common slot exists. */
export function ensureCoordination(input: AppDinner, now: string): AppDinner {
  const s = structuredClone(input),
    version = fingerprint(s),
    previous = s.coordination;
  if (previous?.inputVersion === version) {
    if (previous.status !== "waiting") return s;
    const finished = previous.suggestions.every((slot) =>
      required(s).every(
        (m) => covers(s, m.id, slot) || slot.declinedBy.includes(m.id),
      ),
    );
    if (!finished) return s;
    if (previous.round === 2) {
      previous.status = "escalated";
      return s;
    }
  }
  const same = previous?.inputVersion === version;
  const slots = candidates(
    s,
    now,
    new Set(same ? previous?.suggestions.map((x) => x.start) : []),
  );
  s.coordination = {
    id: randomUUID(),
    inputVersion: version,
    round: same ? 2 : 1,
    status: slots.length ? "waiting" : "escalated",
    createdAt: now,
    suggestions: slots.map((slot) => ({
      ...slot,
      id: randomUUID(),
      acceptedBy: [],
      declinedBy: [],
    })),
  };
  return s;
}
export function respondCoordination(
  input: AppDinner,
  user: string,
  response: { suggestionId: string; response: "accept" | "decline" },
  now: string,
): AppDinner {
  if (!active(input, user))
    throw new DomainError(
      "MEMBERSHIP",
      "Current dinner membership is required.",
    );
  const s = structuredClone(input),
    c = s.coordination,
    slot = c?.suggestions.find((x) => x.id === response.suggestionId);
  if (
    !c ||
    !slot ||
    c.status !== "waiting" ||
    c.inputVersion !== fingerprint(s) ||
    Date.parse(slot.start) <= Date.parse(now)
  )
    throw new DomainError(
      "STALE",
      "This time suggestion changed. Review the current times.",
    );
  if (response.response === "accept") {
    if (
      s.dinner.constraints[user]?.busy?.some(
        (w) =>
          Date.parse(w.start) < Date.parse(slot.end) &&
          Date.parse(w.end) > Date.parse(slot.start),
      )
    )
      throw new DomainError(
        "CALENDAR",
        "This time conflicts with your connected calendar. Review your availability.",
      );
    const availability = s.dinner.constraints[user]?.availability ?? [];
    if (
      !availability.some(
        (w) =>
          Date.parse(w.start) <= Date.parse(slot.start) &&
          Date.parse(w.end) >= Date.parse(slot.end),
      )
    )
      s.dinner = updateConstraints(
        s.dinner,
        user,
        {
          availability: [...availability, { start: slot.start, end: slot.end }],
        },
        now,
      );
    slot.acceptedBy = [...new Set([...slot.acceptedBy, user])];
    slot.declinedBy = slot.declinedBy.filter((id) => id !== user);
    if (s.answerSharing) delete s.answerSharing[user];
    if (required(s).every((m) => covers(s, m.id, slot))) c.status = "resolved";
  } else {
    // An explicit refusal withdraws this interval while retaining other willingness.
    const remaining: Interval[] = [];
    for (const window of s.dinner.constraints[user]?.availability ?? []) {
      if (
        Date.parse(window.end) <= Date.parse(slot.start) ||
        Date.parse(window.start) >= Date.parse(slot.end)
      )
        remaining.push(window);
      else {
        if (Date.parse(window.start) < Date.parse(slot.start))
          remaining.push({ start: window.start, end: slot.start });
        if (Date.parse(window.end) > Date.parse(slot.end))
          remaining.push({ start: slot.end, end: window.end });
      }
    }
    s.dinner = updateConstraints(
      s.dinner,
      user,
      { availability: remaining },
      now,
    );
    slot.declinedBy = [...new Set([...slot.declinedBy, user])];
    slot.acceptedBy = slot.acceptedBy.filter((id) => id !== user);
  }
  c.inputVersion = fingerprint(s);
  return s;
}
export function coordinationView(s: AppDinner, user: string) {
  const c = s.coordination;
  if (!c || !active(s, user) || c.inputVersion !== fingerprint(s))
    return undefined;
  return {
    round: c.round,
    status: c.status,
    suggestions: c.suggestions.map((slot) => ({
      id: slot.id,
      start: slot.start,
      end: slot.end,
      response: (slot.declinedBy.includes(user)
        ? "declined"
        : covers(s, user, slot)
          ? "accepted"
          : undefined) as "accepted" | "declined" | undefined,
      available: required(s).filter((m) => covers(s, m.id, slot)).length,
      required: required(s).length,
    })),
  };
}

import { z } from "zod";
import { DateTime } from "luxon";
import {
  DinnerSchema,
  ConstraintSchema,
  type Dinner,
  type Interval,
  type PlanOption,
} from "../domain/index.js";

export const DinnerTitleSchema = z
  .string()
  .trim()
  .max(80)
  .transform((value) => value || undefined)
  .optional();
export const AppDinnerSchema = z.object({
  title: DinnerTitleSchema,
  dinner: DinnerSchema,
  roster: z.array(z.object({ name: z.string(), id: z.string() })),
  consents: z.record(
    z.string(),
    z.object({
      active: z.boolean(),
      at: z.string(),
      version: z.literal("1.0"),
    }),
  ),
  joinRequests: z.record(
    z.string(),
    z.object({
      slot: z.number().int().nullable(),
      name: z.string(),
      at: z.string(),
      preferences: ConstraintSchema.optional(),
    }),
  ),
  answerSharing: z
    .record(
      z.string(),
      z.object({
        enabled: z.boolean(),
        at: z.string().datetime({ offset: true }),
        version: z.literal("1.0"),
      }),
    )
    .optional(),
  reminders: z.record(z.string(), z.array(z.string())),
  collectionNotified: z.boolean().default(false),
});
export type AppDinner = z.infer<typeof AppDinnerSchema>;
export const IncomingSchema = z.object({
  eventId: z.string(),
  actorId: z.string(),
  chatId: z.string(),
  name: z.string(),
  text: z.string().max(10000),
  callbackId: z.string().optional(),
});
export type Incoming = z.infer<typeof IncomingSchema>;
export const ManualConstraintSchema = ConstraintSchema.omit({
  busy: true,
  calendarStatus: true,
  calendarCheckedAt: true,
  calendarWindow: true,
}).strict();
export function authorized(s: AppDinner, userId: string): boolean {
  return (
    !!s.consents[userId]?.active &&
    !s.joinRequests[userId] &&
    s.dinner.members.some((member) => member.id === userId)
  );
}
export function organizer(s: AppDinner, userId: string): boolean {
  return authorized(s, userId) && s.dinner.organizerId === userId;
}
export function activeOption(d: Dinner): PlanOption | undefined {
  const proposal = d.proposals.find((p) => p.version === d.activeVersion);
  return proposal?.options[proposal.selectedIndex];
}
export function canPlan(s: AppDinner): boolean {
  return s.dinner.members
    .filter((m) => m.required)
    .every((m) => authorized(s, m.id));
}
export function progress(s: AppDinner): string {
  const approved = s.dinner.members.length,
    collected = s.dinner.members.filter(
      (m) => s.dinner.constraints[m.id]?.availability?.length,
    ).length;
  return `${approved}/${s.roster.length} approved; ${collected}/${s.roster.length} availability received. ${Object.keys(s.dinner.confirmations).length}/${s.dinner.members.filter((m) => m.required).length} confirmed the current version. State: ${s.dinner.status}.`;
}
/** Shared projection intentionally has no private constraints, reasons or model drafts. */
export function sharedPlan(s: AppDinner, now: string): string {
  if (s.dinner.status === "cancelled")
    return "Dinner cancelled. Planning and reminders have stopped. Update any reservation or downloaded calendar event yourself.";
  const d = s.dinner,
    proposal = d.proposals.find((p) => p.version === d.activeVersion);
  if (!proposal)
    return `Dinner ${d.id}: ${progress(s)}\nA current proposal is needed. Existing reservations are unchanged.`;
  const options = proposal.options.map((option, i) => {
    const venue = proposal.venues.find((v) => v.id === option.venueId)!;
    const local = DateTime.fromISO(option.start)
      .setZone(d.setup.timezone)
      .toFormat("ccc dd LLL yyyy HH:mm ZZZZ");
    const reservation =
      venue.evidence.reservation.status === "known"
        ? (venue.evidence.reservation.state ?? "unknown")
        : "unknown";
    return `${i + 1}. ${venue.name}, ${venue.address}\n${local} (${d.setup.timezone}), ${option.durationMinutes} min. Estimate ${option.pricePerPerson} ${d.setup.currency} per person.\nLocation: ${venue.evidence.location.url}\nPrice (${venue.evidence.price.status}, checked ${venue.evidence.price.retrievedAt}): ${venue.evidence.price.url}\nHours (${venue.evidence.opening.status}): ${venue.evidence.opening.url}\nReservation: ${reservation} (${venue.evidence.reservation.status}); no booking made. ${venue.evidence.reservation.url}`;
  });
  return `Dinner ${d.id}, version ${proposal.version}. Option 1 is active/recommended.\nAttendees: ${s.roster
    .filter((r) => proposal.memberIds.includes(r.id))
    .map((r) => r.name)
    .join(
      ", ",
    )}\n${options.join("\n\n")}\n${progress(s)}\nChecked ${now}. Any unresolved firm requirement blocks agreement. Existing reservations are unchanged.`;
}
/** Intersects explicit willingness; Google busy can remove time but cannot add willingness. */
export function candidateSlots(d: Dinner, now: string): Interval[] {
  const required = d.members.filter((m) => m.required);
  if (
    !required.length ||
    required.some((m) => !d.constraints[m.id]?.availability?.length)
  )
    return [];
  function union(intervals: Interval[]): Interval[] {
    const output: Interval[] = [];
    for (const interval of [...intervals].sort(
      (a, b) => Date.parse(a.start) - Date.parse(b.start),
    )) {
      const last = output.at(-1);
      if (last && Date.parse(interval.start) <= Date.parse(last.end)) {
        if (Date.parse(interval.end) > Date.parse(last.end))
          last.end = interval.end;
      } else output.push({ ...interval });
    }
    return output;
  }
  let intervals = union(d.constraints[required[0].id].availability!);
  for (const member of required.slice(1)) {
    const next: Interval[] = [];
    for (const a of intervals)
      for (const b of union(d.constraints[member.id].availability!)) {
        const start = Math.max(Date.parse(a.start), Date.parse(b.start)),
          end = Math.min(Date.parse(a.end), Date.parse(b.end));
        if (end > start)
          next.push({
            start: new Date(start).toISOString(),
            end: new Date(end).toISOString(),
          });
      }
    intervals = union(next);
  }
  const output: Interval[] = [],
    seen = new Set<string>();
  const windowStart = DateTime.fromISO(d.setup.windowStart, {
    zone: d.setup.timezone,
  })
    .startOf("day")
    .toMillis();
  const windowEnd = Math.min(
    DateTime.fromISO(d.setup.windowEnd, { zone: d.setup.timezone })
      .endOf("day")
      .toMillis(),
    windowStart + 32 * 86400000,
  );
  for (const interval of intervals.sort(
    (a, b) => Date.parse(a.start) - Date.parse(b.start),
  )) {
    const lower = Math.max(
        Date.parse(interval.start),
        Date.parse(now) + 60000,
        windowStart,
      ),
      upper = Math.min(Date.parse(interval.end), windowEnd);
    for (
      let start = Math.ceil(lower / 1800000) * 1800000;
      start + d.setup.durationMinutes * 60000 <= upper;
      start += 1800000
    ) {
      const end = start + d.setup.durationMinutes * 60000;
      const localStart = DateTime.fromMillis(start)
        .setZone(d.setup.timezone)
        .toISODate()!;
      const localEnd = DateTime.fromMillis(end)
        .setZone(d.setup.timezone)
        .toISODate()!;
      if (localStart < d.setup.windowStart || localEnd > d.setup.windowEnd)
        continue;
      if (
        required.some((m) =>
          d.constraints[m.id]?.busy?.some(
            (b) => Date.parse(b.start) < end && Date.parse(b.end) > start,
          ),
        )
      )
        continue;
      const value = new Date(start).toISOString();
      if (!seen.has(value)) {
        output.push({ start: value, end: new Date(end).toISOString() });
        seen.add(value);
      }
    }
  }
  // Prefer dinner around 19:00, with a first candidate from each willing date.
  // This avoids spending the search budget on eight adjacent midnight slots.
  const score = (slot: Interval) =>
    Math.abs(
      DateTime.fromISO(slot.start).setZone(d.setup.timezone).hour * 60 +
        DateTime.fromISO(slot.start).setZone(d.setup.timezone).minute -
        19 * 60,
    );
  output.sort(
    (a, b) => score(a) - score(b) || Date.parse(a.start) - Date.parse(b.start),
  );
  const dates = new Set<string>(),
    first: Interval[] = [],
    rest: Interval[] = [];
  for (const slot of output) {
    const date = DateTime.fromISO(slot.start)
      .setZone(d.setup.timezone)
      .toISODate()!;
    if (!dates.has(date)) {
      first.push(slot);
      dates.add(date);
    } else rest.push(slot);
  }
  first.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return [...first, ...rest].slice(0, 8);
}

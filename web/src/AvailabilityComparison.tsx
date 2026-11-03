import { DateTime } from "luxon";
import type { Interval } from "../../src/domain/index";
export interface SharedSchedule {
  userId: string;
  name: string;
  status: "shared" | "private" | "not-submitted";
  availability?: Interval[];
}
function merge(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter(
      (i) =>
        Number.isFinite(Date.parse(i.start)) &&
        Date.parse(i.end) > Date.parse(i.start),
    )
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const result: Interval[] = [];
  for (const interval of sorted) {
    const last = result.at(-1);
    if (last && Date.parse(interval.start) <= Date.parse(last.end))
      last.end = new Date(
        Math.max(Date.parse(last.end), Date.parse(interval.end)),
      ).toISOString();
    else result.push({ ...interval });
  }
  return result;
}
export function commonManualWindows(
  schedules: Interval[][],
  durationMinutes: number,
): Interval[] {
  if (schedules.length < 2) return [];
  let common = merge(schedules[0]);
  for (const schedule of schedules.slice(1)) {
    const next: Interval[] = [];
    for (const a of common)
      for (const b of merge(schedule)) {
        const start = Math.max(Date.parse(a.start), Date.parse(b.start)),
          end = Math.min(Date.parse(a.end), Date.parse(b.end));
        if (end > start)
          next.push({
            start: new Date(start).toISOString(),
            end: new Date(end).toISOString(),
          });
      }
    common = merge(next);
  }
  return common.filter(
    (i) => Date.parse(i.end) - Date.parse(i.start) >= durationMinutes * 60000,
  );
}
export function AvailabilityTimes({
  intervals,
  timezone,
}: {
  intervals: Interval[];
  timezone: string;
}) {
  return (
    <ul className="availability-times">
      {intervals.map((range, i) => {
        const start = DateTime.fromISO(range.start).setZone(timezone),
          end = DateTime.fromISO(range.end).setZone(timezone);
        return (
          <li key={i}>
            {start.toFormat("ccc, LLL d · h:mm a")}–
            {end.toFormat(
              start.toISODate() === end.toISODate()
                ? "h:mm a"
                : "ccc, LLL d · h:mm a",
            )}
          </li>
        );
      })}
    </ul>
  );
}
export function AvailabilityComparison({
  schedules,
  ownDraft,
  actorId,
  timezone,
  durationMinutes,
}: {
  schedules: SharedSchedule[];
  ownDraft: Interval[];
  actorId?: string;
  timezone: string;
  durationMinutes: number;
}) {
  const others = schedules.filter((s) => s.userId !== actorId);
  const known = [
    ...others
      .filter((s) => s.status === "shared" && s.availability?.length)
      .map((s) => s.availability!),
    ...(ownDraft.length ? [ownDraft] : []),
  ];
  const common = commonManualWindows(known, durationMinutes);
  return (
    <section className="card form-card" aria-label="Shared availability">
      <h2>See what works together</h2>
      <p className="muted small">
        Only manually shared times appear here. Your own draft is used locally
        for this comparison. Calendar busy times are never shown.
      </p>
      <p className="field-hint">
        All times use {timezone.replaceAll("_", " ")}. {known.length} schedules
        visible to you.
      </p>
      {ownDraft.length > 0 && (
        <div className="schedule-row">
          <h3>You · current draft</h3>
          <AvailabilityTimes intervals={ownDraft} timezone={timezone} />
        </div>
      )}
      {others.map((person) => (
        <div className="schedule-row" key={person.userId}>
          <h3>{person.name}</h3>
          {person.status === "shared" && person.availability?.length ? (
            <AvailabilityTimes
              intervals={person.availability}
              timezone={timezone}
            />
          ) : (
            <p className="muted small">
              {person.status === "private"
                ? "Private — no times shown."
                : "No available times submitted yet."}
            </p>
          )}
        </div>
      ))}
      <div className="common-windows">
        <h3>Common windows for the visible schedules</h3>
        {common.length ? (
          <AvailabilityTimes intervals={common} timezone={timezone} />
        ) : (
          <p className="muted small">
            {known.length < 2
              ? "At least two visible schedules are needed to compare."
              : `No common window fits the ${durationMinutes}-minute dinner yet.`}
          </p>
        )}
        <p className="field-hint">
          Private or unanswered schedules are unknown. These windows do not
          prove the whole group is available.
        </p>
      </div>
    </section>
  );
}

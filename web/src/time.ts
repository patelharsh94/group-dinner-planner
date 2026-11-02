import { DateTime } from "luxon";

export interface LocalCandidate {
  iso: string;
  offset: number;
  label: string;
}
export type LocalTimeResult =
  | { kind: "invalid"; message: string }
  | { kind: "valid" | "ambiguous"; candidates: LocalCandidate[] };
export function localCandidates(
  date: string,
  time: string,
  timezone: string,
): LocalTimeResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time))
    return { kind: "invalid", message: "Choose a date and time." };
  const wall = `${date}T${time}:00`;
  const local = DateTime.fromISO(wall, { zone: timezone });
  if (!local.isValid || local.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall)
    return {
      kind: "invalid",
      message:
        "This time does not exist because the clocks change. Choose another time.",
    };
  const possible = local
    .getPossibleOffsets()
    .sort((a, b) => a.toMillis() - b.toMillis());
  return {
    kind: possible.length > 1 ? "ambiguous" : "valid",
    candidates: possible.map((item, i) => ({
      iso: item.toISO({ suppressMilliseconds: true })!,
      offset: item.offset,
      label: `${i === 0 ? "First" : "Second"} ${item.toFormat("h:mm a")} (UTC${item.toFormat("ZZ")})`,
    })),
  };
}
export function localIso(
  date: string,
  time: string,
  timezone: string,
  selectedOffset?: number,
): string {
  const result = localCandidates(date, time, timezone);
  if (result.kind === "invalid") throw new Error(result.message);
  if (result.kind === "ambiguous" && selectedOffset === undefined)
    throw new Error(
      "The clocks change on this date. Choose which occurrence of the repeated time you mean.",
    );
  const candidate =
    selectedOffset === undefined
      ? result.candidates[0]
      : result.candidates.find((item) => item.offset === selectedOffset);
  if (!candidate) throw new Error("Choose a valid time for this timezone.");
  return candidate.iso;
}
export function friendlyZone(zone: string): string {
  const city = zone.split("/").at(-1)?.replaceAll("_", " ") ?? zone;
  const name = DateTime.now().setZone(zone).offsetNameLong;
  return `${city} · ${name ?? zone}`;
}
export function dateLabel(
  date: string,
  options: "short" | "long" = "short",
): string {
  return DateTime.fromISO(date).toFormat(
    options === "long" ? "cccc, LLLL d" : "LLL d",
  );
}
export function planTime(start: string, end: string, zone: string): string {
  const first = DateTime.fromISO(start).setZone(zone),
    last = DateTime.fromISO(end).setZone(zone);
  return `${first.toFormat("ccc, LLL d")} · ${first.toFormat("h:mm a")}–${last.toFormat("h:mm a")}`;
}

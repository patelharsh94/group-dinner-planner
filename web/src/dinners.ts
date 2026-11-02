import type { DinnerSummary, DinnerView } from "../../src/miniapp/contracts";
export function dinnerName(
  dinner: Pick<DinnerSummary, "title" | "city">,
): string {
  return dinner.title?.trim() || `Dinner in ${dinner.city}`;
}
export function dinnerSummary(view: DinnerView): DinnerSummary {
  return {
    id: view.id,
    title: view.title,
    city: view.city,
    windowStart: view.windowStart,
    windowEnd: view.windowEnd,
    status: view.status,
    role: view.role,
    ended: view.ended,
    cancellation: view.cancellation,
  };
}
export function ownedActiveCount(dinners: DinnerSummary[]): number {
  return dinners.filter((d) => d.role === "organizer" && !d.ended).length;
}
export const chronological = (a: DinnerSummary, b: DinnerSummary): number =>
  a.windowStart.localeCompare(b.windowStart) || a.id.localeCompare(b.id);

import { createHash } from "node:crypto";
import type { AppDinner } from "./model.js";
/** Ignore delivery/reminder metadata while binding research to every planning input. */
export function researchVersion(state: AppDinner): string {
  const d = state.dinner;
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          setup: d.setup,
          members: d.members.map(({ id, required }) => ({ id, required })),
          constraints: d.constraints,
          staffReports: d.staffReports,
          disputes: d.disputes,
          activeVersion: d.activeVersion,
          websiteHints: d.venues
            .filter((v) => v.officialWebsiteUrl)
            .map((v) => ({ id: v.id, url: v.officialWebsiteUrl })),
          status: d.status,
          consent: Object.fromEntries(
            Object.entries(state.consents).map(([id, c]) => [id, c.active]),
          ),
        }),
      ),
    )
    .digest("hex");
}

/** Sibling website discoveries do not invalidate unrelated booking jobs; each job also binds its own source hint. */
export function bookingResearchVersion(state: AppDinner): string {
  return researchVersion({...state,dinner:{...state.dinner,venues:state.dinner.venues.map(venue => ({...venue,officialWebsiteUrl:undefined}))}});
}

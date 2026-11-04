import type { YelpBusiness, YelpClient } from "../adapters/yelp.js";
import { preferredCuisineTerms } from "../adapters/cuisine.js";
import type { ResearchContext } from "../adapters/muse.js";
import type { PlanOption, Venue } from "../domain/index.js";

export type DirectoryClient = Pick<YelpClient, "search" | "details">;
/** Interleave preferences, deduplicate IDs, and cap all downstream work at ten businesses. */
export async function discoverDirectory(
  client: DirectoryClient,
  context: ResearchContext,
): Promise<YelpBusiness[]> {
  const lookups = await Promise.allSettled(
    preferredCuisineTerms(context.preferences).map((term) =>
      client.search({
        city: context.setup.city,
        area: context.setup.area,
        term,
      }),
    ),
  );
  const lists = lookups.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (!lists.length) throw (lookups[0] as PromiseRejectedResult).reason;
  const candidates: YelpBusiness[] = [];
  const seen = new Set<string>();
  for (let row = 0; row < 10 && candidates.length < 10; row++) {
    for (const list of lists) {
      const candidate = list[row];
      if (candidate && !seen.has(candidate.id)) {
        candidates.push(candidate);
        seen.add(candidate.id);
        if (candidates.length === 10) break;
      }
    }
  }
  return candidates;
}
/** No directory content crosses this boundary into durable dinner JSON. */
export function directoryVenue(
  id: string,
  index: number,
  context: ResearchContext,
  now: string,
): Venue {
  const unknown = {
    status: "unknown" as const,
    url: `https://www.yelp.com/biz/${encodeURIComponent(id)}`,
    retrievedAt: now,
    excerpt: "Restaurant details require verification from a current source.",
  };
  return {
    id: `directory:${id}`,
    directoryBusinessId: id,
    name: `Restaurant option ${index + 1}`,
    address: "View current restaurant listing",
    city: context.setup.city,
    area: context.setup.area,
    evidence: {
      location: { ...unknown },
      price: { ...unknown },
      opening: { ...unknown },
      reservation: { ...unknown, state: "unknown" },
      dietary: {},
      travel: {},
    },
  };
}
export function directoryOptions(
  ids: string[],
  context: ResearchContext,
): PlanOption[] {
  return ids.slice(0, 3).map((id) => ({
    venueId: `directory:${id}`,
    ...context.slots[0],
    pricePerPerson: 0,
    priceEstimateKnown: false,
    priceBasis: "per-person",
    durationMinutes: context.setup.durationMinutes,
  }));
}
/** Enforce a deadline even when a test/transport ignores AbortSignal. */
export async function bounded<T>(
  operation: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error("Deadline exceeded"), {
                name: "TimeoutError",
              }),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

import type { Dinner } from "../domain/index.js";
import type { YelpBusiness } from "../adapters/yelp.js";
/** A transient display copy only. Never save it to dinners, snapshots or outbox. */
export function displayDirectoryDinner(
  dinner: Dinner,
  businesses: YelpBusiness[],
  now: string,
): Dinner {
  const copy = structuredClone(dinner);
  const cached = new Map(
    businesses
      .filter(
        (b) =>
          Date.parse(b.retrievedAt) <= Date.parse(now) &&
          Date.parse(b.expiresAt) > Date.parse(now),
      )
      .map((b) => [b.id, b]),
  );
  for (const venue of [
    ...copy.venues,
    ...copy.proposals.flatMap((p) => p.venues),
  ]) {
    const business = venue.directoryBusinessId
      ? cached.get(venue.directoryBusinessId)
      : undefined;
    if (business) {
      venue.name = business.name;
      venue.address = business.address;
    }
  }
  return copy;
}
export function activeDirectoryIds(dinner: Dinner): string[] {
  const proposal = dinner.proposals.find(
    (p) => p.version === dinner.activeVersion,
  );
  return [
    ...new Set(
      (proposal?.options ?? []).flatMap((option) => {
        const venue =
          dinner.venues.find((v) => v.id === option.venueId) ??
          proposal?.venues.find((v) => v.id === option.venueId);
        return venue?.directoryBusinessId ? [venue.directoryBusinessId] : [];
      }),
    ),
  ];
}

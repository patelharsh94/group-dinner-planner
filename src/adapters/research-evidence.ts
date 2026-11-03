import type { Venue } from "../domain/index.js";
import {
  claimSupported,
  normalizedSourceText,
  sourceContains,
} from "./sources.js";

type Source = { url: string; excerpt: string; retrievedAt: string };

function independentUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host !== "yelp.com" && !host.endsWith(".yelp.com");
  } catch {
    return false;
  }
}

/** Preserve URL queries and paths; only fragments and implicit root slashes are equivalent. */
export function canonicalEvidenceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

/** Retain identity independently of feasibility; no transient directory evidence survives. */
export function retainIndependentlyVerifiedVenues(
  venues: Venue[],
  citations: ReadonlySet<string>,
  sources: ReadonlyMap<string, string>,
  now: string,
  identityFallback: ReadonlyMap<string, string> = new Map(),
): { venues: Venue[]; rejectedIdentities: number } {
  const retained: Venue[] = [];
  const grounded = (source: Pick<Source, "url" | "excerpt">) =>
    independentUrl(source.url) &&
    citations.has(canonicalEvidenceUrl(source.url)) &&
    sourceContains(
      sources.get(canonicalEvidenceUrl(source.url)) ?? "",
      source.excerpt,
    );
  const normalizeName = (value: string) =>
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const normalizeLocation = (value: string) =>
    normalizeName(value).replace(
      /\b(east|west|north|south|road|street|avenue)\b/g,
      (word) =>
        ({
          east: "e",
          west: "w",
          north: "n",
          south: "s",
          road: "rd",
          street: "st",
          avenue: "ave",
        })[word]!,
    );
  const containsTokens = (text: string, value: string) =>
    !!value && ` ${text} `.includes(` ${value} `);
  for (const venue of venues) {
    const claims = [
      venue.evidence.location,
      venue.evidence.price,
      venue.evidence.opening,
      venue.evidence.reservation,
      ...Object.values(venue.evidence.dietary),
      ...Object.values(venue.evidence.travel),
    ];
    // Claims may quote separate portions of the same independently fetched page.
    const byUrl = new Map<string, string[]>();
    for (const claim of claims) {
      for (const source of [claim, ...(claim.relatedSources ?? [])]) {
        if (!grounded(source)) continue;
        byUrl.set(canonicalEvidenceUrl(source.url), [
          ...(byUrl.get(canonicalEvidenceUrl(source.url)) ?? []),
          source.excerpt,
        ]);
      }
    }
    // Fallbacks are provider tool excerpts from failed fetches, never model-authored claims.
    for (const [url, text] of identityFallback) {
      const key = canonicalEvidenceUrl(url);
      if (independentUrl(key) && citations.has(key) && !sources.has(key))
        byUrl.set(key, [text]);
    }
    const identity = [...byUrl].find(([url, excerpts]) => {
      const excerpt = excerpts.join(" ");
      const city = normalizeLocation(venue.city);
      const street = normalizeLocation(venue.address).split(city)[0].trim();
      const location = normalizeLocation(excerpt);
      const publishedText = normalizedSourceText(
        sources.get(url) ?? identityFallback.get(url) ?? "",
      );
      const published = normalizeLocation(publishedText);
      return (
        containsTokens(
          normalizeName(publishedText),
          normalizeName(venue.name),
        ) &&
        containsTokens(published, street) &&
        containsTokens(published, city) &&
        containsTokens(location, street) &&
        containsTokens(location, city) &&
        !!normalizeName(venue.name) &&
        ` ${normalizeName(excerpt)} `.includes(
          ` ${normalizeName(venue.name)} `,
        ) &&
        claimSupported("location", excerpt, {
          address: venue.address,
          city: venue.city,
          area: venue.city,
        })
      );
    });
    if (!identity) continue;
    for (const claim of claims) {
      const primaryGrounded = grounded(claim);
      if (
        !primaryGrounded ||
        (claim !== venue.evidence.location && claim.status === "unknown")
      ) {
        for (const key of Object.keys(claim))
          delete (claim as Record<string, unknown>)[key];
        Object.assign(claim, {
          status: "unknown",
          url: identity[0],
          excerpt: "This detail remains unresolved.",
          retrievedAt: now,
        });
      } else {
        claim.relatedSources = claim.relatedSources
          ?.filter(grounded)
          .map((source) => ({ ...source, retrievedAt: now }));
        claim.retrievedAt = now;
      }
    }
    retained.push(venue);
  }
  return {
    venues: retained,
    rejectedIdentities: venues.length - retained.length,
  };
}

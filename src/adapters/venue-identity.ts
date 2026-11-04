import { PublicUrlSchema } from "../domain/index.js";
import { normalizedSourceText } from "./sources.js";

type Identity = { name: string; address: string; city: string };
const clean = (value: string) =>
  normalizedSourceText(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(
      /\b(street|road|avenue|east|west|north|south)\b/g,
      (word) =>
        ({
          street: "st",
          road: "rd",
          avenue: "ave",
          east: "e",
          west: "w",
          north: "n",
          south: "s",
        })[word]!,
    )
    .trim();
/** Include only structured restaurant identity/hours, never arbitrary script instructions. */
export function sourceDocument(html: string): string {
  const structured: string[] = [];
  for (const match of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const visit = (value: unknown, depth = 0): void => {
        if (depth > 12 || !value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          value.forEach((item) => visit(item, depth + 1));
          return;
        }
        const record = value as Record<string, unknown>;
        if (
          [record["@type"]]
            .flat()
            .some(
              (t) =>
                typeof t === "string" &&
                /^(Restaurant|FoodEstablishment|LocalBusiness)$/.test(t),
            )
        ) {
          const address =
            record.address && typeof record.address === "object"
              ? (record.address as Record<string, unknown>)
              : {};
          structured.push(
            [
              record.name,
              address.streetAddress,
              address.addressLocality,
              address.addressRegion,
              address.postalCode,
              record.telephone,
            ]
              .filter((v) => typeof v === "string")
              .join(" "),
          );
        }
        if (record["@graph"]) visit(record["@graph"], depth + 1);
        if (record.department) visit(record.department, depth + 1);
        if (record.subOrganization) visit(record.subOrganization, depth + 1);
      };
      visit(JSON.parse(match[1]));
    } catch {
      /* malformed JSONLD is not evidence */
    }
  }
  return normalizedSourceText(
    `${normalizedSourceText(html)} ${structured.join(" ")}`,
  );
}
/** Inherit only from a uniquely identified site; explicit conflicting addresses always win. */
export function associatedVenuePage(
  target: Identity,
  text: string,
  inherited = false,
  html?: string,
): boolean {
  const normalized = clean(text),
    street = clean(target.address).split(clean(target.city))[0].trim();
  const addresses = [
    ...normalized.matchAll(
      /\b\d{1,6}\s+(?:[\p{L}][\p{L}'’-]*\s+){0,6}?(?:st|rd|ave|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway)\b/gu,
    ),
  ].map((match) => match[0]);
  if (
    addresses.some(
      (address) => !street.includes(address) && !address.includes(street),
    )
  )
    return false;
  if (new Set(addresses).size > 1) return false;
  if (
    /\b(?:locations|branches)\b|\b(?:other|another|second|new)\s+(?:[\p{L}-]+\s+){0,3}(?:location|branch)\b/u.test(
      normalized,
    )
  )
    return false;
  const own =
    normalized.includes(clean(target.name)) &&
    normalized.includes(street) &&
    normalized.includes(clean(target.city));
  if (html) {
    const headings = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)];
    for (const heading of headings) {
      const rest = clean(heading[1])
        .replace(clean(target.name), "")
        .replace(clean(target.city), "")
        .replace(
          /\b(?:welcome|to|our|us|the|restaurant|dinner|lunch|brunch|breakfast|food|drink|drinks|menu|menus|contact|hours|visit|about|reservations|reservation|reserve|book|booking|a|table|home)\b/g,
          "",
        )
        .trim();
      if (
        rest &&
        (!own ||
          /\b(?:menu|menus|hours|contact|location|branch)\b/i.test(heading[1]))
      )
        return false;
    }
  }
  if (own) return true;
  return inherited && addresses.length === 0;
}
export function publishedLinks(
  html: string,
  base: string,
): { url: string; label: string }[] {
  const document = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const links: { url: string; label: string }[] = [];
  for (const match of document.matchAll(
    /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi,
  )) {
    try {
      const url = new URL(match[2].replace(/&amp;/g, "&"), base);
      url.hash = "";
      if (PublicUrlSchema.safeParse(url.toString()).success)
        links.push({
          url: url.toString(),
          label: normalizedSourceText(match[3]),
        });
    } catch {}
  }
  return links;
}
export function officialBookingLink(
  html: string,
  sourceUrl: string,
  retrievedAt: string,
) {
  for (const link of publishedLinks(html, sourceUrl)) {
    const host = new URL(link.url).hostname.replace(/^www\./, "");
    const provider = [
      "opentable.com",
      "resy.com",
      "exploretock.com",
      "sevenrooms.com",
      "resdiary.com",
    ].find((domain) => host === domain || host.endsWith(`.${domain}`));
    const destination = new URL(link.url);
    const publishedBooking =
      /\b(?:reservations?|reserve|book(?:ing)?|find a table)\b/i.test(
        link.label,
      ) ||
      /(?:^|\/)(?:reserve|reservation[s]?|book|booking)(?:\/|$)/i.test(
        destination.pathname,
      );
    const specific =
      destination.pathname.replace(/\//g, "").length > 0 ||
      [...destination.searchParams.keys()].some((key) =>
        /rid|restaurant|venue|widget|id/i.test(key),
      );
    if (
      publishedBooking &&
      specific &&
      !/\bmenus?\b|\.(?:pdf|jpg|png)$/i.test(destination.pathname)
    )
      return {
        url: link.url,
        sourceUrl,
        retrievedAt,
        provider:
          provider?.split(".")[0] ??
          (destination.origin === new URL(sourceUrl).origin
            ? "official"
            : host),
        provenance: "official_link" as const,
      };
  }
  return undefined;
}

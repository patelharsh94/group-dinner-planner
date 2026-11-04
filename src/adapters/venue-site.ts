import { bounded } from "../application/directory-research.js";
import { PublicUrlSchema } from "../domain/index.js";
import { canonicalEvidenceUrl } from "./research-evidence.js";
import { readPublicSource } from "./sources.js";
import { sourceDocument, publishedLinks } from "./venue-identity.js";

export class VenueSitePages extends Map<string, string> {
  readonly html = new Map<string, string>();
  failures = 0;
  readCount = 0;
  timedOut = false;
}

/** These services can identify a restaurant but are not its own website. */
export function isRestaurantSiteUrl(value: string): boolean {
  if (!PublicUrlSchema.safeParse(value).success) return false;
  const host = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
  const excluded = [
    "yelp.com",
    "opentable.com",
    "resy.com",
    "facebook.com",
    "fb.com",
    "instagram.com",
    "tiktok.com",
    "twitter.com",
    "x.com",
    "youtube.com",
    "doordash.com",
    "grubhub.com",
    "ubereats.com",
    "seamless.com",
    "postmates.com",
    "delivery.com",
    "chownow.com",
    "toasttab.com",
    "exploretock.com",
    "foursquare.com",
    "restaurantji.com",
    "linktr.ee",
  ];
  return (
    !excluded.some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    ) && !/(^|\.)(?:google|tripadvisor)\.[a-z.]+$/.test(host)
  );
}

/** Transient, untrusted page text: never persist this map or treat it as instructions. */
export async function readVenueSite(
  seed: string,
  reader: typeof readPublicSource = readPublicSource,
  menuUrl?: string,
): Promise<VenueSitePages> {
  const pages = new VenueSitePages();
  if (!isRestaurantSiteUrl(seed)) return pages;
  const homepage = canonicalEvidenceUrl(seed);
  const origin = new URL(homepage).origin;
  const allow = (value: string) =>
    PublicUrlSchema.safeParse(value).success &&
    (new URL(value).origin === origin ||
      published.has(canonicalEvidenceUrl(value)));
  const deadline = Date.now() + 10000;
  const signal = AbortSignal.timeout(10000);
  let remainingCharacters = 24000;
  const published = new Set<string>();
  const read = async (url: string) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || remainingCharacters <= 0 || !allow(url)) return "";
    try {
      pages.readCount++;
      const html = await bounded(
        reader(url, 0, signal, allow, 2_000_000),
        remaining,
      );
      pages.html.set(url, html);
      const text = sourceDocument(html).slice(
        0,
        Math.min(8000, remainingCharacters),
      );
      if (text.length >= 12) {
        pages.set(url, text);
        remainingCharacters -= text.length;
      }
      return html;
    } catch {
      pages.failures++;
      pages.timedOut ||= Date.now() >= deadline;
      return "";
    }
  };
  const html = await read(homepage);
  if (!html || Date.now() >= deadline) return pages;
  const links: string[] = [];
  // Only explicitly published external menu/booking destinations can cross origins.
  // Redirects remain restricted to the published URL or this official origin.
  for (const link of publishedLinks(html, homepage)) {
    const sameOrigin = new URL(link.url).origin === origin;
    const relevant =
      /\b(menu|menus|hours|contact|visit|location|locations|reservations|reserve|booking|book)\b/i.test(
        `${link.url} ${link.label}`,
      );
    if (!relevant) continue;
    if (!sameOrigin && /menu|reserv|book/i.test(`${link.url} ${link.label}`))
      published.add(link.url);
    if (allow(link.url) && link.url !== homepage && !links.includes(link.url))
      links.push(link.url);
  }
  // A caller's menu hint alone never authorizes an arbitrary external fetch.
  if (
    menuUrl &&
    allow(menuUrl) &&
    canonicalEvidenceUrl(menuUrl) !== homepage &&
    !links.includes(canonicalEvidenceUrl(menuUrl))
  )
    links.unshift(canonicalEvidenceUrl(menuUrl));
  for (const link of links.slice(0, 5)) await read(link);
  return pages;
}

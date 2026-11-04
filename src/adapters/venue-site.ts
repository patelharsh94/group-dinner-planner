import { bounded } from "../application/directory-research.js";
import { PublicUrlSchema } from "../domain/index.js";
import { canonicalEvidenceUrl } from "./research-evidence.js";
import { normalizedSourceText, readPublicSource } from "./sources.js";

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
): Promise<Map<string, string>> {
  const pages = new Map<string, string>();
  if (!isRestaurantSiteUrl(seed)) return pages;
  const homepage = canonicalEvidenceUrl(seed);
  const origin = new URL(homepage).origin;
  const allow = (value: string) =>
    PublicUrlSchema.safeParse(value).success &&
    new URL(value).origin === origin;
  const deadline = Date.now() + 5000;
  const signal = AbortSignal.timeout(5000);
  let remainingCharacters = 12000;
  const read = async (url: string) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || remainingCharacters <= 0 || !allow(url)) return "";
    try {
      const html = await bounded(
        reader(url, 0, signal, allow, 2_000_000),
        remaining,
      );
      const text = normalizedSourceText(html).slice(
        0,
        Math.min(4000, remainingCharacters),
      );
      if (text.length >= 12) {
        pages.set(url, text);
        remainingCharacters -= text.length;
      }
      return html;
    } catch {
      return "";
    }
  };
  const html = await read(homepage);
  if (!html || Date.now() >= deadline) return pages;
  const links: string[] = [];
  if (menuUrl && allow(menuUrl) && canonicalEvidenceUrl(menuUrl) !== homepage)
    links.push(canonicalEvidenceUrl(menuUrl));
  // Follow published links only. Scripts and style blocks cannot supply links.
  const document = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  for (const match of document.matchAll(
    /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi,
  )) {
    if (
      !/\b(menu|menus|hours|contact|visit|location|locations)\b/i.test(
        `${match[2]} ${normalizedSourceText(match[3])}`,
      )
    )
      continue;
    try {
      const url = canonicalEvidenceUrl(
        new URL(match[2].replace(/&amp;/g, "&"), homepage).toString(),
      );
      if (allow(url) && url !== homepage && !links.includes(url))
        links.push(url);
    } catch {
      /* Malformed untrusted links are ignored. */
    }
    if (links.length >= 2) break;
  }
  await Promise.allSettled(links.slice(0, 2).map(read));
  return pages;
}

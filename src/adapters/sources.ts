import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { DateTime } from "luxon";
import { PublicUrlSchema } from "../domain/index.js";

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  if (isIP(address) === 6) {
    const ip = address.toLowerCase();
    return (
      /^[23][0-9a-f]{3}:/.test(ip) &&
      !ip.startsWith("2001:db8:") &&
      !ip.startsWith("2001:0:")
    );
  }
  return false;
}
/** Pin a validated DNS result; never follow an unchecked redirect or fetch a private address. */
export async function readPublicSource(
  input: string,
  redirects = 0,
  signal: AbortSignal = AbortSignal.timeout(15000),
): Promise<string> {
  const url = new URL(PublicUrlSchema.parse(input));
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true }),
    new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Source deadline exceeded"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new Error("Source deadline exceeded")),
        { once: true },
      );
    }),
  ]);
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    throw new Error("Nonpublic source address");
  const target = addresses[0];
  return new Promise<string>((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        signal,
        headers: {
          "user-agent": "GroupDinnerPlanner/0.1 (source verification)",
          accept: "text/html,text/plain,application/json",
        },
        lookup: (_host, options, callback) => {
          // Modern Node may request all addresses for automatic family selection.
          if (options.all)
            (
              callback as unknown as (
                error: null,
                values: { address: string; family: number }[],
              ) => void
            )(null, [target]);
          else callback(null, target.address, target.family);
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirects >= 3) {
            reject(new Error("Too many source redirects"));
            return;
          }
          readPublicSource(
            new URL(response.headers.location, url).toString(),
            redirects + 1,
            signal,
          ).then(resolve, reject);
          return;
        }
        const type = response.headers["content-type"] ?? "";
        if (
          status !== 200 ||
          !/(text\/html|text\/plain|application\/json)/i.test(type)
        ) {
          response.resume();
          reject(new Error("Unsupported source"));
          return;
        }
        let body = "",
          size = 0;
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          size += Buffer.byteLength(chunk);
          if (size > 512000) {
            req.destroy(new Error("Source too large"));
            return;
          }
          body += chunk;
        });
        response.once("end", () => resolve(body));
        response.once("error", reject);
      },
    );
    req.setTimeout(12000, () => req.destroy(new Error("Source timeout")));
    req.once("error", reject);
    req.end();
  });
}
function normalized(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, n) => String.fromCodePoint(Number(n)))
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
export function sourceContains(source: string, excerpt: string): boolean {
  return (
    normalized(excerpt).length >= 12 &&
    normalized(source).includes(normalized(excerpt))
  );
}
/** Conservative checks supplement grounded extraction; unknown support never becomes a known claim. */
export function claimSupported(
  kind: string,
  excerpt: string,
  fields: Record<string, unknown>,
): boolean {
  const value = normalized(excerpt);
  if (kind === "dietary" && fields.supported === true) {
    if (typeof fields.requirement !== "string") return false;
    if (
      /\b(cannot|can't|unable|unavailable|not available|not offered|do not offer|no guarantee|not guaranteed|not safe|unsafe|may contain|cross[ -]?contaminat\w*|contains? (?:peanut|nut|gluten|dairy|milk|egg|shellfish)|(?:not|no) (?:vegan|vegetarian|halal|kosher|gluten|nut|allergen)[ -]?(?:free)?)\b/.test(
        value,
      )
    )
      return false;
    const requirement = normalized(fields.requirement);
    for (const label of ["vegan", "vegetarian", "halal", "kosher"])
      if ([label, `${label} diet`, `${label} options`].includes(requirement))
        return new RegExp(`\\b${label}\\b`).test(value);
    if (
      [
        "gluten-free",
        "gluten free",
        "celiac",
        "celiac disease",
        "coeliac",
        "coeliac disease",
      ].includes(requirement)
    )
      return /\bgluten[ -]?free\b/.test(value);
    const allergens = [
      ["peanut", "peanut"],
      ["tree nut", "tree nut"],
      ["shellfish", "shellfish"],
      ["sesame", "sesame"],
      ["dairy", "(?:dairy|milk)"],
      ["lactose", "(?:lactose|dairy|milk)"],
      ["milk", "milk"],
      ["egg", "egg"],
      ["soy", "soy"],
      ["wheat", "wheat"],
      ["fish", "fish"],
      ["nut", "nut"],
    ];
    for (const [key, pattern] of allergens)
      if (
        new RegExp(
          `^(?:no )?${key}s?(?: allergy| intolerance|[ -]free)?$`,
        ).test(requirement)
      ) {
        return new RegExp(
          `\\b${pattern}[ -]?free\\b|\\bno ${pattern}s?\\b|\\b(?:accommodat\\w*|dedicated|safe)[^.]*\\b${pattern}s?\\b`,
        ).test(value);
      }
    return (
      value.includes(requirement) &&
      /\b(?:available|option\w*|accommodat\w*|offer\w*)\b/.test(value)
    );
  }
  if (kind === "price") {
    if (
      typeof fields.amount !== "number" ||
      typeof fields.currency !== "string"
    )
      return false;
    const amount = new RegExp(
      `(?:^|[^\\d])${String(fields.amount).replace(".", "\\.")}(?:[.,]00)?(?:[^\\d]|$)`,
    );
    const symbols: Record<string, string> = {
      USD: "us$",
      EUR: "€",
      INR: "₹",
    };
    const basis =
      fields.basis === "per-person"
        ? /\b(per person|per guest|each person|each guest|prix fixe|pp)\b/.test(
            value,
          )
        : fields.basis === "total" &&
          /\b(total|for the (?:party|group)|party of)\b/.test(value);
    return (
      !!basis &&
      amount.test(value) &&
      (new RegExp(`(?<![a-z])${fields.currency.toLowerCase()}(?![a-z])`).test(
        value,
      ) ||
        (!!symbols[fields.currency] &&
          value.includes(symbols[fields.currency])))
    );
  }
  if (kind === "travel")
    return (
      typeof fields.minutes === "number" &&
      typeof fields.origin === "string" &&
      !!fields.origin.trim() &&
      value.includes(normalized(fields.origin)) &&
      new RegExp(`\\b${fields.minutes}\\s*(?:min|minute)`).test(value)
    );
  if (kind === "opening") return openingSupported(excerpt, fields);
  if (kind === "location") {
    if (
      typeof fields.address !== "string" ||
      typeof fields.city !== "string" ||
      typeof fields.area !== "string"
    )
      return false;
    const clean = (text: string) =>
      normalized(text)
        .replace(/[.,]/g, "")
        .replace(
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
    const address = clean(fields.address),
      text = clean(excerpt);
    const street = address.split(clean(fields.city))[0].trim();
    return (
      !!street &&
      text.includes(street) &&
      text.includes(clean(fields.city)) &&
      (fields.area.toLowerCase() === fields.city.toLowerCase() ||
        text.includes(clean(fields.area)))
    );
  }
  return true;
}

/** Deliberately supports explicit weekly/date schedules, leaving ambiguous hours unknown. */
function openingSupported(
  excerpt: string,
  fields: Record<string, unknown>,
): boolean {
  if (
    typeof fields.timezone !== "string" ||
    !Array.isArray(fields.intervals) ||
    !fields.intervals.length
  )
    return false;
  if (/\bclosed\b/i.test(excerpt)) return false;
  const day =
    "(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)";
  const labels = new RegExp(
    `\\b${day}(?:\\s*(?:-|–|—|to|,|&|and)\\s*${day})*\\b|\\b(?:daily|every day)\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`,
    "gi",
  );
  const text = normalized(excerpt),
    matches = [...text.matchAll(labels)];
  const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const ranges: {
    date?: string;
    days: number[];
    open: number;
    close: number;
  }[] = [];
  const clock = "(?:\\d{1,2}:\\d{2}\\s*(?:am|pm)?|\\d{1,2}\\s*(?:am|pm))";
  function minutes(input: string): number {
    const match = input.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (!match) return NaN;
    let hour = Number(match[1]);
    const minute = Number(match[2] ?? 0);
    if (minute > 59 || hour > 23 || (match[3] && (hour < 1 || hour > 12)))
      return NaN;
    if (match[3]) hour = (hour % 12) + (match[3] === "pm" ? 12 : 0);
    return hour * 60 + minute;
  }
  for (let index = 0; index < matches.length; index++) {
    const label = matches[index][0],
      section = text.slice(
        matches[index].index! + label.length,
        matches[index + 1]?.index ?? text.length,
      );
    const date = /^\d{4}-\d{2}-\d{2}$/.test(label) ? label : undefined;
    let weekdays = days.flatMap((d, i) => (label.includes(d) ? [i + 1] : []));
    if (label === "daily" || label === "every day")
      weekdays = [1, 2, 3, 4, 5, 6, 7];
    else if (/-|–|—|\bto\b/.test(label) && weekdays.length === 2) {
      const tokens = [...label.matchAll(new RegExp(day, "g"))].map(
        (match) => days.indexOf(match[0].slice(0, 3)) + 1,
      );
      const first = tokens[0],
        last = tokens.at(-1)!;
      weekdays = [];
      if (first && last)
        for (let n = 0; n < 7; n++) {
          const value = ((first - 1 + n) % 7) + 1;
          weekdays.push(value);
          if (value === last) break;
        }
    }
    for (const match of section.matchAll(
      new RegExp(`(${clock})\\s*(?:-|–|—|to)\\s*(${clock})`, "g"),
    )) {
      const open = minutes(match[1].trim()),
        close = minutes(match[2].trim());
      if (Number.isFinite(open) && Number.isFinite(close) && open !== close)
        ranges.push({ date, days: weekdays, open, close });
    }
  }
  return fields.intervals.every((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const interval = raw as { start?: string; end?: string };
    const start = DateTime.fromISO(interval.start ?? "").setZone(
        fields.timezone as string,
      ),
      end = DateTime.fromISO(interval.end ?? "").setZone(
        fields.timezone as string,
      );
    if (!start.isValid || !end.isValid || end.toMillis() <= start.toMillis())
      return false;
    return ranges.some((range) =>
      [start.startOf("day"), start.minus({ days: 1 }).startOf("day")].some(
        (date) => {
          if (
            range.date
              ? date.toISODate() !== range.date
              : !range.days.includes(date.weekday)
          )
            return false;
          const open = date.set({
            hour: Math.floor(range.open / 60),
            minute: range.open % 60,
          });
          const close = date
            .plus({ days: range.close < range.open ? 1 : 0 })
            .set({
              hour: Math.floor(range.close / 60),
              minute: range.close % 60,
            });
          return (
            open.toMillis() <= start.toMillis() &&
            close.toMillis() >= end.toMillis()
          );
        },
      ),
    );
  });
}

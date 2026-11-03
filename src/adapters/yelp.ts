/** Yelp Places discovery only. Never persist this content; only business IDs may be durable. */
import { z } from "zod";

export interface YelpBusiness {
  id: string;
  name: string;
  url: string;
  address: string;
  city: string;
  phone?: string;
  /** Yelp's relative $–$$$$ tier, never a per-person amount. */
  priceLevel?: string;
  categories: { alias: string; title: string }[];
  /** Local business time; day 0 = Monday. Not dated availability or a booking. */
  hours?: { day: number; start: string; end: string; isOvernight: boolean }[];
  retrievedAt: string;
  expiresAt: string;
}
export interface YelpSearch {
  city: string;
  area?: string;
  term?: string;
}
export type YelpErrorCode =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "network"
  | "invalid_response"
  | "invalid_request"
  | "upstream";
export class YelpError extends Error {
  constructor(
    public readonly code: YelpErrorCode,
    public readonly status?: number,
  ) {
    super(`Yelp discovery unavailable (${code})`);
    this.name = "YelpError";
  }
}
export interface YelpOptions {
  apiKey: string;
  fetcher?: typeof fetch;
  now?: () => number;
  cacheTtlMs?: number;
  timeoutMs?: number;
}
const text = z.string().max(1000);
const hoursSchema = z
  .array(
    z.object({
      hours_type: z.string().optional(),
      open: z
        .array(
          z.object({
            day: z.number().int().min(0).max(6),
            start: z.string().regex(/^(?:[01][0-9]|2[0-3])[0-5][0-9]$/),
            end: z.string().regex(/^(?:[01][0-9]|2[0-3])[0-5][0-9]$/),
            is_overnight: z.boolean(),
          }),
        )
        .max(100),
    }),
  )
  .max(10);
const businessSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  name: text.min(1),
  url: z
    .url()
    .max(3000)
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        (url.hostname === "yelp.com" || url.hostname.endsWith(".yelp.com"))
      );
    }),
  location: z.object({
    address1: text.nullish(),
    address2: text.nullish(),
    address3: text.nullish(),
    city: text.optional(),
    state: text.optional(),
    zip_code: text.optional(),
    display_address: z.array(text).max(10).optional(),
  }),
  phone: text.optional(),
  price: z
    .string()
    .regex(/^\${1,4}$/)
    .optional(),
  categories: z
    .array(z.object({ alias: text, title: text }))
    .max(100)
    .default([]),
  business_hours: hoursSchema.optional(),
  hours: hoursSchema.optional(),
});

export class YelpClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly timeout: number;
  private readonly cache = new Map<
    string,
    { expires: number; value: YelpBusiness[] }
  >();
  private readonly cleanup: ReturnType<typeof setInterval>;

  constructor(private readonly options: YelpOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.ttl = options.cacheTtlMs ?? 15 * 60 * 1000;
    this.timeout = options.timeoutMs ?? 15000;
    if (
      !options.apiKey.trim() ||
      !Number.isFinite(this.ttl) ||
      this.ttl <= 0 ||
      this.ttl > 23 * 60 * 60 * 1000 ||
      !Number.isFinite(this.timeout) ||
      this.timeout <= 0 ||
      this.timeout > 15000
    )
      throw new YelpError("invalid_request");
    // Evict even if nobody searches again; expired content cannot linger past the legal retention limit.
    this.cleanup = setInterval(() => this.prune(), Math.min(this.ttl, 60000));
    this.cleanup.unref();
  }

  async search(input: YelpSearch): Promise<YelpBusiness[]> {
    const valid = z
      .object({
        city: z.string().trim().min(1).max(120),
        area: z.string().trim().max(120).optional(),
        term: z.string().trim().max(100).optional(),
      })
      .safeParse(input);
    if (!valid.success) throw new YelpError("invalid_request");
    const { city, area, term } = valid.data;
    const query = new URLSearchParams({
      location: area ? `${area}, ${city}` : city,
      term: term || "restaurants",
      categories: "restaurants",
      limit: "5",
    });
    return this.load(`/businesses/search?${query}`, true);
  }

  async details(id: string): Promise<YelpBusiness> {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id))
      throw new YelpError("invalid_request");
    const result = await this.load(
      `/businesses/${encodeURIComponent(id)}`,
      false,
    );
    return result[0];
  }

  private prune() {
    const now = this.now();
    for (const [key, item] of this.cache)
      if (item.expires <= now) this.cache.delete(key);
  }

  private async load(path: string, search: boolean): Promise<YelpBusiness[]> {
    this.prune();
    const cached = this.cache.get(path);
    if (cached) return structuredClone(cached.value);
    try {
      const response = await this.fetcher(`https://api.yelp.com/v3${path}`, {
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          Accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeout),
      });
      if (!response.ok) {
        const code: YelpErrorCode =
          response.status === 401
            ? "unauthorized"
            : response.status === 403
              ? "forbidden"
              : response.status === 429
                ? "rate_limited"
                : "upstream";
        throw new YelpError(code, response.status);
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new YelpError("invalid_response");
      }
      const list = search
        ? z.object({ businesses: z.array(z.unknown()).max(50) }).safeParse(data)
        : undefined;
      if (search && !list?.success) throw new YelpError("invalid_response");
      const records =
        search && list?.success ? list.data.businesses.slice(0, 5) : [data];
      const retrieved = this.now();
      const expires = retrieved + this.ttl;
      const value = records.map((record): YelpBusiness => {
        const parsed = businessSchema.safeParse(record);
        if (!parsed.success) throw new YelpError("invalid_response");
        const b = parsed.data;
        const regular = (b.business_hours ?? b.hours)?.find(
          (h) => !h.hours_type || h.hours_type === "REGULAR",
        );
        return {
          id: b.id,
          name: b.name,
          url: b.url,
          address:
            b.location.display_address?.join(", ") ||
            [
              b.location.address1,
              b.location.address2,
              b.location.address3,
              b.location.city,
              b.location.state,
              b.location.zip_code,
            ]
              .filter(Boolean)
              .join(", "),
          city: b.location.city ?? "",
          phone: b.phone || undefined,
          priceLevel: b.price,
          categories: b.categories,
          hours: regular?.open.map((h) => ({
            day: h.day,
            start: h.start,
            end: h.end,
            isOvernight: h.is_overnight,
          })),
          retrievedAt: new Date(retrieved).toISOString(),
          expiresAt: new Date(expires).toISOString(),
        };
      });
      if (this.cache.size >= 100)
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(path, { expires, value });
      return structuredClone(value);
    } catch (error) {
      if (error instanceof YelpError) throw error;
      throw new YelpError("network");
    }
  }
}

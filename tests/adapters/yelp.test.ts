import { describe, expect, it, vi } from "vitest";
import { YelpClient, YelpError } from "../../src/adapters/yelp.js";

const raw = {
  id: "public-id",
  name: "Public Restaurant",
  url: "https://www.yelp.com/biz/public-id",
  location: { display_address: ["10 Main St", "Chicago, IL"], city: "Chicago" },
  phone: "+13125551234",
  price: "$$",
  categories: [{ alias: "italian", title: "Italian" }],
  business_hours: [
    {
      hours_type: "REGULAR",
      open: [{ day: 0, start: "1700", end: "2200", is_overnight: false }],
    },
  ],
  photos: ["private-photo"],
  reviews: ["not retained"],
  rating: 5,
  attributes: { menu_url: "https://restaurant.example/menu" },
};
const response = (data: unknown) => new Response(JSON.stringify(data));

describe("Yelp Places boundary", () => {
  it("uses only fixed HTTPS search, bounded public query and Bearer auth; whitelists results", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ businesses: [raw] }));
    const client = new YelpClient({ apiKey: "test-secret", fetcher });
    const result = await client.search({
      city: "Chicago",
      area: "Loop",
      term: "Italian",
      participantName: "DO NOT SEND",
    } as never);
    const [url, init] = fetcher.mock.calls[0];
    expect(new URL(url).origin).toBe("https://api.yelp.com");
    expect(new URL(url).pathname).toBe("/v3/businesses/search");
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({
      location: "Loop, Chicago",
      term: "Italian",
      categories: "restaurants",
      limit: "10",
    });
    expect(init).toMatchObject({
      headers: { Authorization: "Bearer test-secret" },
      redirect: "error",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(result[0]).toMatchObject({
      id: "public-id",
      address: "10 Main St, Chicago, IL",
      city: "Chicago",
      priceLevel: "$$",
      menuUrl: "https://restaurant.example/menu",
      hours: [{ day: 0, start: "1700", end: "2200", isOvernight: false }],
    });
    expect(result[0]).not.toHaveProperty("photos");
    expect(result[0]).not.toHaveProperty("reviews");
    expect(result[0]).not.toHaveProperty("rating");
  });

  it("caches fresh data, clones it, and never returns expired results on failure", async () => {
    let now = 1000;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ businesses: [raw] }))
      .mockRejectedValue(new Error("secret body"));
    const client = new YelpClient({
      apiKey: "test-secret",
      fetcher,
      now: () => now,
      cacheTtlMs: 100,
    });
    const first = await client.search({ city: "Chicago" });
    first[0].name = "mutated";
    expect((await client.search({ city: "Chicago" }))[0].name).toBe(
      "Public Restaurant",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 100;
    await expect(client.search({ city: "Chicago" })).rejects.toMatchObject({
      code: "network",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fetches encoded details without reviews or photos endpoints", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(raw));
    const client = new YelpClient({ apiKey: "test-secret", fetcher });
    await client.details("public-id");
    await client.details("public-id");
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://api.yelp.com/v3/businesses/public-id",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(client.details("../reviews")).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate_limited"],
    [500, "upstream"],
  ])("maps %s without provider bodies or retries", async (status, code) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("SECRET", { status: Number(status) }));
    const client = new YelpClient({ apiKey: "test-secret", fetcher });
    await expect(client.search({ city: "Chicago" })).rejects.toMatchObject({
      code,
      status,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(client.search({ city: "Chicago" })).rejects.not.toThrow(
      "SECRET",
    );
  });

  it.each([
    { businesses: [{}] },
    { businesses: [{ ...raw, url: "https://evil.example" }] },
    { businesses: "bad" },
  ])("rejects malformed or unsafe content", async (data) => {
    const client = new YelpClient({
      apiKey: "test-secret",
      fetcher: vi.fn().mockResolvedValue(response(data)),
    });
    await expect(client.search({ city: "Chicago" })).rejects.toBeInstanceOf(
      YelpError,
    );
    await expect(client.search({ city: "Chicago" })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("caps requested businesses even when upstream sends more and rejects invalid options", async () => {
    const client = new YelpClient({
      apiKey: "test-secret",
      fetcher: vi
        .fn()
        .mockResolvedValue(response({ businesses: Array(12).fill(raw) })),
    });
    expect(await client.search({ city: "Chicago" })).toHaveLength(10);
    expect(
      () => new YelpClient({ apiKey: "test-secret", cacheTtlMs: 86_400_000 }),
    ).toThrow();
    expect(
      () => new YelpClient({ apiKey: "test-secret", timeoutMs: 15_001 }),
    ).toThrow();
    await expect(client.search({ city: "" })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("aborts a hung request within the configured deadline without retries", async () => {
    const fetcher = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("abort secret")),
          ),
        ),
    );
    const client = new YelpClient({
      apiKey: "test-secret",
      fetcher: fetcher as typeof fetch,
      timeoutMs: 10,
    });
    await expect(client.search({ city: "Chicago" })).rejects.toMatchObject({
      code: "network",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

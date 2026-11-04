import { expect, it, vi } from "vitest";
import { readVenueSite } from "../../src/adapters/venue-site.js";

it("reads only the supplied homepage and at most two linked same-origin relevant pages", async () => {
  const reader = vi.fn(
    async (
      url: string,
      _redirects?: number,
      _signal?: AbortSignal,
      allow?: (url: string) => boolean,
      maxBytes?: number,
    ) => {
      expect(maxBytes).toBe(2_000_000);
      expect(allow?.("https://evil.example/menu")).toBe(false);
      expect(allow?.("https://gaijin.example/menu")).toBe(true);
      return url === "https://gaijin.example/"
        ? `<p>Gaijin Chicago official restaurant homepage</p><a href="https://evil.example/menu">Menu</a><a href="http://gaijin.example/menu">Menu</a><a href="https://127.0.0.1/menu">Menu</a><a href="/menu">Dinner Menu</a><a href="/hours">Hours</a><a href="/contact">Contact</a><a href="/news">News</a>`
        : "Useful restaurant page ".repeat(1000);
    },
  );
  const pages = await readVenueSite("https://gaijin.example/", reader);
  expect(reader.mock.calls.map(([url]) => url)).toEqual([
    "https://gaijin.example/",
    "https://gaijin.example/menu",
    "https://gaijin.example/hours",
  ]);
  expect([...pages.values()].join("").length).toBeLessThanOrEqual(12000);
  expect(
    reader.mock.calls.every((call) => call[2] instanceof AbortSignal),
  ).toBe(true);
});

it("rejects unsafe seeds before any network call and does not guess paths", async () => {
  const reader = vi.fn().mockResolvedValue("Restaurant homepage without links");
  for (const url of [
    "http://gaijin.example",
    "https://127.0.0.1/",
    "https://user:pass@gaijin.example",
    "https://localhost/",
    "https://gaijin.internal/",
  ]) {
    expect((await readVenueSite(url, reader)).size).toBe(0);
  }
  expect(reader).not.toHaveBeenCalled();
  expect((await readVenueSite("https://gaijin.example", reader)).size).toBe(1);
  expect(reader).toHaveBeenCalledTimes(1);
});

it("limits the full site read to five seconds even when a reader hangs", async () => {
  vi.useFakeTimers();
  try {
    const reader = vi.fn(() => new Promise<string>(() => {}));
    const pending = readVenueSite("https://gaijin.example", reader);
    await vi.advanceTimersByTimeAsync(5001);
    expect((await pending).size).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("blocks off-origin and credential redirects through the guarded public reader", async () => {
  const reader = vi.fn(
    async (
      _url: string,
      _redirects?: number,
      _signal?: AbortSignal,
      allow?: (url: string) => boolean,
    ) => {
      for (const redirected of [
        "https://evil.example/menu",
        "https://user:password@gaijin.example/menu",
        "https://127.0.0.1/menu",
        "http://gaijin.example/menu",
      ]) {
        expect(allow?.(redirected)).toBe(false);
      }
      throw new Error("Excluded source domain");
    },
  );
  expect((await readVenueSite("https://gaijin.example", reader)).size).toBe(0);
  expect(reader).toHaveBeenCalledTimes(1);
});

it("ignores script-injected links and fetches a supplied same-origin menu only once", async () => {
  const reader = vi
    .fn()
    .mockResolvedValue(
      `<p>Gaijin restaurant homepage Chicago</p><script><a href="/private-menu">Menu</a></script><a href="/menu">Menu</a><a href="/hours">Hours</a>`,
    );
  await readVenueSite(
    "https://gaijin.example",
    reader,
    "https://gaijin.example/menu",
  );
  expect(reader.mock.calls.map(([url]) => url)).toEqual([
    "https://gaijin.example/",
    "https://gaijin.example/menu",
    "https://gaijin.example/hours",
  ]);
});

it("rejects supplied directory, social, booking and delivery hosts including subdomains", async () => {
  const reader = vi.fn();
  for (const url of [
    "https://www.yelp.com/biz/gaijin",
    "https://m.facebook.com/gaijin",
    "https://instagram.com/gaijin",
    "https://tripadvisor.co.uk/gaijin",
    "https://resy.com/gaijin",
    "https://opentable.com/gaijin",
    "https://maps.google.com/gaijin",
    "https://doordash.com/gaijin",
    "https://ubereats.com/gaijin",
  ]) {
    expect((await readVenueSite(url, reader)).size).toBe(0);
  }
  expect(reader).not.toHaveBeenCalled();
});

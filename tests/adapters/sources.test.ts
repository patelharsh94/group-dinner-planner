import { expect, it } from "vitest";
import {
  isPublicAddress,
  readPublicSource,
  sourceContains,
  claimSupported,
} from "../../src/adapters/sources.js";
it("RES-01 rejects private, mapped, loopback and reserved source addresses", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.2",
    "169.254.169.254",
    "192.168.1.1",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
  ])
    expect(isPublicAddress(ip), ip).toBe(false);
  expect(isPublicAddress("8.8.8.8")).toBe(true);
  expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
});
it("DIET-01 binds positive dietary evidence to the actual requirement", () => {
  expect(
    claimSupported("dietary", "Halal options are available", {
      supported: true,
      requirement: "halal certified",
    }),
  ).toBe(false);
  expect(
    claimSupported("dietary", "Vegan options are available", {
      supported: true,
      requirement: "vegan and gluten-free",
    }),
  ).toBe(false);
  expect(
    claimSupported(
      "dietary",
      "Vegan options are available on our dinner menu",
      { supported: true, requirement: "gluten-free" },
    ),
  ).toBe(false);
  expect(
    claimSupported(
      "dietary",
      "Vegan options are available on our dinner menu",
      { supported: true, requirement: "vegan" },
    ),
  ).toBe(true);
  expect(
    claimSupported(
      "dietary",
      "No vegan options are available on our dinner menu",
      { supported: true, requirement: "vegan" },
    ),
  ).toBe(false);
  expect(
    claimSupported(
      "dietary",
      "We can accommodate peanut allergies with dedicated cookware",
      { supported: true, requirement: "peanut allergy" },
    ),
  ).toBe(true);
});
it("RES-01 checks opening intervals against explicitly posted days and times", () => {
  const fields = {
    timezone: "America/Chicago",
    intervals: [
      { start: "2026-10-30T19:00:00-05:00", end: "2026-10-30T20:30:00-05:00" },
    ],
  };
  expect(
    claimSupported("opening", "Welcome to our lovely restaurant", fields),
  ).toBe(false);
  expect(claimSupported("opening", "Friday: 5 PM – 10 PM", fields)).toBe(true);
  expect(claimSupported("opening", "Saturday: 5 PM – 10 PM", fields)).toBe(
    false,
  );
  expect(claimSupported("opening", "Friday: 5 PM – 6 PM", fields)).toBe(false);
  expect(claimSupported("opening", "Monday–Friday 17:00–22:00", fields)).toBe(
    true,
  );
});
it("RES-01 requires literal normalized source support for individual claim excerpts", () => {
  expect(
    claimSupported("price", "Dinner CAD 40 per person", {
      amount: 40,
      currency: "USD",
      basis: "per-person",
    }),
  ).toBe(false);
  expect(
    claimSupported("price", "Dinner $40 per person", {
      amount: 40,
      currency: "USD",
      basis: "per-person",
    }),
  ).toBe(false);
  expect(
    claimSupported("price", "Dinner USD 40 per person", {
      amount: 40,
      currency: "USD",
      basis: "per-person",
    }),
  ).toBe(true);
  expect(
    sourceContains(
      "<p>Vegan &amp; gluten-free<br> options available.</p>",
      "Vegan & gluten-free options available.",
    ),
  ).toBe(true);
  expect(
    sourceContains("Menu: all dishes contain peanuts", "No peanuts in kitchen"),
  ).toBe(false);
  expect(
    claimSupported(
      "dietary",
      "Contains peanuts and cannot accommodate peanut allergies",
      { supported: true },
    ),
  ).toBe(false);
  expect(
    claimSupported("price", "Menu dinner $30 per person", {
      amount: 60,
      currency: "USD",
    }),
  ).toBe(false);
});

it("YELP-01 rejects an excluded source before DNS or HTTP, including redirected inputs", async () => {
  await expect(
    readPublicSource(
      "https://www.yelp.com/biz/example",
      1,
      AbortSignal.timeout(1000),
      () => false,
    ),
  ).rejects.toThrow("Excluded source domain");
});

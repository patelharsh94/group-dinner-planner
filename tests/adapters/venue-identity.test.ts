import { expect, it } from "vitest";
import {
  associatedVenuePage,
  officialBookingLink,
  sourceDocument,
} from "../../src/adapters/venue-identity.js";
const target = { name: "Fixture", address: "1 Main St", city: "Chicago" };
it("associates separated footer identity and hours on a single branch page", () => {
  const text = sourceDocument(
    "<h1>Fixture</h1><p>Monday 5pm - 10pm</p><footer>1 Main St, Chicago</footer>",
  );
  expect(associatedVenuePage(target, text)).toBe(true);
});
it("uses Restaurant JSONLD identity without losing grounded page text", () => {
  const text = sourceDocument(
    '<script type="application/ld+json">{"@type":"Restaurant","name":"Fixture","address":{"streetAddress":"1 Main St","addressLocality":"Chicago"}}</script><p>Vegan options available</p>',
  );
  expect(associatedVenuePage(target, text)).toBe(true);
  expect(text).toContain("vegan options available");
});
it("rejects ambiguous branch pages and conflicting address when inheriting identity", () => {
  expect(
    associatedVenuePage(target, "Fixture 1 Main St Chicago 9 Other St Chicago"),
  ).toBe(false);
  expect(associatedVenuePage(target, "9 Other St Chicago", true)).toBe(false);
  expect(
    associatedVenuePage(target, "Dinner menu vegan options available", true),
  ).toBe(true);
});
it("extracts published booking anchor even without fetching provider; ignores scripts", () => {
  const url = "https://fixture.example/";
  expect(
    officialBookingLink(
      '<a href="https://resy.com/cities/chi/fixture">Reserve a table</a>',
      url,
      "2026-11-03T00:00:00Z",
    ),
  ).toMatchObject({
    url: "https://resy.com/cities/chi/fixture",
    sourceUrl: url,
    provider: "resy",
    provenance: "official_link",
  });
  expect(
    officialBookingLink(
      '<script><a href="https://resy.com/evil">Reserve</a></script>',
      url,
      "now",
    ),
  ).toBeUndefined();
});
it("rejects branch context even with a target footer, while allowing normal marketing headings", () => {
  const page = "Fixture 1 Main St Chicago Vegan options available";
  expect(
    associatedVenuePage(target, page, false, "<h1>Milwaukee Menu</h1>"),
  ).toBe(false);
  expect(
    associatedVenuePage(
      target,
      page,
      false,
      "<h1>Fixture — Japanese comfort food</h1>",
    ),
  ).toBe(true);
  expect(
    associatedVenuePage(
      target,
      "Vegan options available",
      true,
      "<h1>Milwaukee</h1>",
    ),
  ).toBe(false);
});
it("supports own site and custom booking navigation but never confuses menu words with bookings", () => {
  const site = "https://fixture.example/";
  for (const html of [
    '<a href="/menu">Vegetable menu</a>',
    '<a href="/book-menu.pdf">Book menu</a>',
    '<a href="https://resy.com/">Reserve</a>',
  ])
    expect(officialBookingLink(html, site, "now")).toBeUndefined();
  expect(
    officialBookingLink(
      '<a href="/reservations">Reservations</a>',
      site,
      "now",
    ),
  ).toMatchObject({
    provider: "official",
    url: "https://fixture.example/reservations",
  });
  expect(
    officialBookingLink(
      '<a href="https://tables.example/fixture">Book a table</a>',
      site,
      "now",
    ),
  ).toMatchObject({ provider: "tables.example" });
});

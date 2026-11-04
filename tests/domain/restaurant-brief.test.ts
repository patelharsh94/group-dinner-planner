import { expect, it } from "vitest";
import { RestaurantBriefSchema } from "../../src/domain/index.js";

const brief = {
  version: 1, retrievedAt: "2026-11-03T19:00:00Z", sources: [],
  address: { status: "unknown" }, hours: { status: "partial" },
  booking: { status: "unknown" }, dietary: { status: "unknown" },
};
it("retains independently incomplete restaurant categories in a versioned brief", () => {
  const parsed = RestaurantBriefSchema.parse(brief);
  expect(parsed.hours.status).toBe("partial");
  expect(parsed.dietary.assessments).toEqual([]);
});
it("rejects unsupported brief versions and nonpublic booking destinations", () => {
  expect(RestaurantBriefSchema.safeParse({ ...brief, version: 2 }).success).toBe(false);
  expect(RestaurantBriefSchema.safeParse({ ...brief, booking: { status: "complete", destinationUrl: "http://localhost/book" } }).success).toBe(false);
});
it("does not publish freeform participant health descriptions as restaurant diet categories", () => {
  const dietary = { status: "partial", assessments: [{ requirement: "Alice's private allergy condition", assessment: "unknown" }] };
  expect(RestaurantBriefSchema.safeParse({...brief,dietary}).success).toBe(false);
});

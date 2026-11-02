import { it, expect } from "vitest";
import { researchVersion } from "../../src/application/research-version.js";
import type { AppDinner } from "../../src/application/model.js";
it("UI-05 research binds planning changes and ignores reminder/delivery-only saves", () => {
  const state = {
    dinner: {
      setup: { area: "City" },
      members: [{ id: "1", required: true, remindersOptIn: false }],
      constraints: { "1": { availability: [] } },
      staffReports: [],
      disputes: [],
      activeVersion: null,
      status: "collecting",
    },
    consents: { "1": { active: true, at: "old" } },
    reminders: {},
    joinRequests: {},
    collectionNotified: false,
  } as unknown as AppDinner;
  const next = structuredClone(state);
  next.dinner.members[0].remindersOptIn = true;
  next.consents["1"].at = "new";
  next.reminders["1"] = ["today"];
  expect(researchVersion(next)).toBe(researchVersion(state));
  next.dinner.setup.area = "New area";
  expect(researchVersion(next)).not.toBe(researchVersion(state));
});

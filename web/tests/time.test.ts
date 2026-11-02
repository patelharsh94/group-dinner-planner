import { describe, expect, it } from "vitest";
import { localCandidates, localIso } from "../src/time";
describe("browser wall-clock interpretation", () => {
  it("does not normalize nonexistent spring times", () => {
    expect(localCandidates("2026-03-08", "02:30", "America/Chicago").kind).toBe(
      "invalid",
    );
  });
  it("asks which repeated hour and preserves the selected explicit offset", () => {
    expect(localCandidates("2026-11-01", "01:30", "America/Chicago").kind).toBe(
      "ambiguous",
    );
    expect(() => localIso("2026-11-01", "01:30", "America/Chicago")).toThrow(
      "clocks change",
    );
    expect(localIso("2026-11-01", "01:30", "America/Chicago", -300)).toBe(
      "2026-11-01T01:30:00-05:00",
    );
    expect(localIso("2026-11-01", "01:30", "America/Chicago", -360)).toBe(
      "2026-11-01T01:30:00-06:00",
    );
  });
  it("creates explicit dinner-zone offsets for ordinary times", () => {
    expect(localIso("2026-11-10", "19:00", "America/Chicago")).toBe(
      "2026-11-10T19:00:00-06:00",
    );
  });
});

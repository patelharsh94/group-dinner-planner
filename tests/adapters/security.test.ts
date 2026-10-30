import { describe, expect, it } from "vitest";
import {
  encrypt,
  decrypt,
  tokenHash,
  secretMatches,
} from "../../src/adapters/security.js";
import { GoogleCalendar } from "../../src/adapters/google.js";

describe("CAL-01 credential and OAuth boundary", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  it("authenticates ciphertext and dinner/member binding", () => {
    const value = encrypt({ refresh_token: "private" }, key, "dinner:user");
    expect(value).not.toContain("private");
    expect(decrypt(value, key, "dinner:user")).toEqual({
      refresh_token: "private",
    });
    expect(() => decrypt(value, key, "other:user")).toThrow();
    expect(() =>
      decrypt(value.slice(0, -4) + "AAAA", key, "dinner:user"),
    ).toThrow();
    expect(tokenHash("abc")).toHaveLength(64);
  });
  it("requests primary freebusy scope only and no calendar write", () => {
    const google = new GoogleCalendar({
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "https://example.org/oauth/google/callback",
    });
    const url = new URL(google.authorizationUrl("random-state"));
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/calendar.freebusy",
    );
    expect(url.searchParams.get("state")).toBe("random-state");
  });
});
it("OPS-01 checks secret headers without accepting missing/mismatched values", () => {
  expect(secretMatches("expected", undefined)).toBe(false);
  expect(secretMatches("expected", "expected")).toBe(true);
  expect(secretMatches("expected", "Expected")).toBe(false);
});

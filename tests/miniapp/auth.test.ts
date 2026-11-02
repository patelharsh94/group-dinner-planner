import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyInitData } from "../../src/miniapp/auth.js";
const token = "123456:test-token",
  now = Date.now();
function sign(values: Record<string, string>) {
  const p = new URLSearchParams(values);
  const check = [...p]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  p.set(
    "hash",
    createHmac(
      "sha256",
      createHmac("sha256", "WebAppData").update(token).digest(),
    )
      .update(check)
      .digest("hex"),
  );
  return p.toString();
}
const fields = {
  auth_date: String(Math.floor(now / 1000)),
  user: JSON.stringify({ id: 42, first_name: "Sam", last_name: "Guest" }),
};
describe("Mini App Telegram authentication", () => {
  it("validates signed identity without trusting client user fields", () => {
    expect(verifyInitData(sign(fields), token, now)).toEqual({
      id: "42",
      name: "Sam Guest",
    });
  });
  it("rejects tampering, absent/invalid signatures and duplicate fields", () => {
    for (const value of [
      sign(fields) + "&user=x",
      sign(fields) + "&hash=abc",
      sign(fields).replace("Guest", "Other"),
      "auth_date=1&user={}",
      sign(fields).replace(/hash=[^&]+/, "hash=zzz"),
    ])
      expect(() => verifyInitData(value, token, now)).toThrow();
  });
  it("expires data after one hour and rejects timestamps over 30s in the future", () => {
    for (const delta of [-3601, 31])
      expect(() =>
        verifyInitData(
          sign({
            ...fields,
            auth_date: String(Math.floor(now / 1000) + delta),
          }),
          token,
          now,
        ),
      ).toThrow();
  });
  it("rejects malformed users and bot accounts even with valid signatures", () => {
    for (const user of [
      { id: -1, first_name: "A" },
      { id: 42, first_name: "A", is_bot: true },
      { id: "42", first_name: "A" },
      {},
    ])
      expect(() =>
        verifyInitData(
          sign({ ...fields, user: JSON.stringify(user) }),
          token,
          now,
        ),
      ).toThrow();
  });
});

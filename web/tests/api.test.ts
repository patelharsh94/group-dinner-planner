import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, MiniAppApi, friendlyError } from "../src/api";
describe("Mini App transport security and retries", () => {
  beforeEach(() =>
    vi.stubGlobal("crypto", {
      randomUUID: vi
        .fn()
        .mockReturnValueOnce("request-one")
        .mockReturnValueOnce("request-two"),
    }),
  );
  it("sends only raw signed initData as authorization, never an unsafe user", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await new MiniAppApi("signed raw data").bootstrap();
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(
      "tma signed raw data",
    );
  });
  it("retains the exact request ID after an ambiguous network failure", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const api = new MiniAppApi("test-signed");
    const input = {
      action: "research" as const,
      dinnerId: "d",
      formVersion: "v",
    };
    await expect(api.action(input)).rejects.toThrow();
    await api.action(input);
    expect(JSON.parse(fetch.mock.calls[0][1].body).requestId).toBe(
      JSON.parse(fetch.mock.calls[1][1].body).requestId,
    );
  });
  it("reuses ID for server uncertainty but creates a fresh ID after definite rejection", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"error":{"code":"TEMPORARY"}}', { status: 503 }),
      )
      .mockResolvedValueOnce(
        new Response('{"error":{"code":"STALE_FORM"}}', { status: 409 }),
      )
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const api = new MiniAppApi("test");
    const input = { action: "research" as const };
    await expect(api.action(input)).rejects.toThrow();
    await expect(api.action(input)).rejects.toThrow();
    await api.action(input);
    const ids = fetch.mock.calls.map(
      (call) => JSON.parse(call[1].body).requestId,
    );
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[1]);
  });
  it("gives a safe stale-form message and does not expose provider errors", () => {
    expect(
      friendlyError(new ApiError("STALE_FORM", "private provider text", 409)),
    ).toContain("answers are still here");
    expect(
      friendlyError(new ApiError("PROVIDER", "secret provider text", 502)),
    ).not.toContain("secret");
  });
});

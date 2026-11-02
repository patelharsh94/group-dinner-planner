import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, MiniAppApi, friendlyError } from "../src/api";
describe("Mini App transport security and retries", () => {
  it("uses a fresh selection ID after a committed choice loses its response, another dinner is chosen, then the first is chosen again", async () => {
    let sequence = 0,
      focus = "",
      calls = 0;
    vi.stubGlobal("crypto", { randomUUID: () => `selection-${++sequence}` });
    const receipts = new Set<string>(),
      requestIds: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const input = JSON.parse(String(init.body));
        requestIds.push(input.requestId);
        calls++;
        if (!receipts.has(input.requestId)) {
          receipts.add(input.requestId);
          focus = input.dinnerId;
        }
        if (calls === 1) throw new TypeError("Response lost after commit");
        return new Response(
          JSON.stringify({ ok: true, dinner: { id: input.dinnerId } }),
        );
      }),
    );
    const api = new MiniAppApi("TEST-ONLY");
    await expect(
      api.action({ action: "chooseDinner", dinnerId: "a" }),
    ).rejects.toThrow();
    await api.action({ action: "chooseDinner", dinnerId: "b" });
    expect(focus).toBe("b");
    await api.action({ action: "chooseDinner", dinnerId: "a" });
    expect(requestIds[2]).not.toBe(requestIds[0]);
    expect(focus).toBe("a");
  });
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

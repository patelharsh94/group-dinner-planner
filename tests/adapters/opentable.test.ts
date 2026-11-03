import { describe, it, expect, vi } from "vitest";
import { OpenTableProvider } from "../../src/adapters/opentable.js";
describe("OpenTable approved Consumer v2 boundary", () => {
  it("never contacts provider without approval and credentials", async () => {
    const fetcher = vi.fn();
    const provider = new OpenTableProvider({}, fetcher);
    expect(provider.capability().available).toBe(false);
    expect(
      (
        await provider.availability({
          restaurantId: "42",
          localDateTime: "2026-11-05T19:00",
          partySize: 2,
        })
      ).status,
    ).toBe("handoff_required");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("requests standard no-card availability and rejects fee policies", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token" })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              rid: 42,
              times_available: [
                {
                  time: "2026-11-05T19:00",
                  availability_types: [
                    { type: "Standard", cancellation_policy: { type: "Hold" } },
                  ],
                },
              ],
            },
          }),
        ),
      );
    const p = new OpenTableProvider(
      {
        enabled: true,
        approved: true,
        clientId: "id",
        clientSecret: "secret",
        baseUrl: "https://platform.opentable.com",
      },
      fetcher,
    );
    expect(
      (
        await p.availability({
          restaurantId: "42",
          localDateTime: "2026-11-05T19:00",
          partySize: 2,
        })
      ).status,
    ).toBe("handoff_required");
    const url = new URL(fetcher.mock.calls[1][0]);
    expect(url.pathname).toBe("/v2/availability/42");
    expect(url.searchParams.get("include_experiences")).toBe("false");
  });
  it("does not invent a lookup endpoint", async () => {
    const f = vi.fn();
    const p = new OpenTableProvider({}, f);
    expect((await p.lookup("42", "ref")).status).toBe("unknown");
    expect(f).not.toHaveBeenCalled();
  });
});
describe("OpenTable network contract", () => {
  const slot = {
      restaurantId: "42",
      localDateTime: "2026-11-05T19:00",
      partySize: 2,
    },
    contact = {
      firstName: "A",
      lastName: "B",
      email: "a@example.com",
      phone: "3125551234",
      countryCode: "US",
    };
  const options = {
    enabled: true,
    approved: true,
    clientId: "id",
    clientSecret: "secret",
    baseUrl: "https://platform.opentable.com",
  };
  function transport(booking: unknown, payment = false) {
    return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.includes("oauth"))
        return new Response(JSON.stringify({ access_token: "token" }));
      if (path.includes("availability"))
        return new Response(
          JSON.stringify({
            rid: 42,
            party_size: 2,
            times_available: [
              {
                time: slot.localDateTime,
                availability_types: [
                  { type: "Standard", experience_cancellation_policies: [] },
                ],
              },
            ],
          }),
        );
      if (init?.method === "DELETE") return new Response("{}");
      if (path.endsWith("slot_locks"))
        return new Response(
          JSON.stringify({
            reservation_token: "LOCK",
            expires_at: new Date(Date.now() + 300000).toISOString(),
            ...(payment
              ? { payment_method: { paymentProviderType: "SPREEDLY" } }
              : {}),
          }),
        );
      return new Response(JSON.stringify(booking));
    });
  }
  it("creates only after a no-payment slot lock and uses stable request ID without marketing", async () => {
    const fetcher = transport({
        confirmation_number: 123,
        party_size: 2,
        date_time: slot.localDateTime,
        post_booking_required_action: "None",
      }),
      p = new OpenTableProvider(options, fetcher as typeof fetch);
    expect(await p.create(slot, contact, "attempt-1")).toMatchObject({
      status: "booked",
      reference: "123",
    });
    const create = fetcher.mock.calls.find(([url]) =>
      String(url).endsWith("/reservations"),
    )!;
    expect(create[1]?.headers).toMatchObject({ "X-Request-Id": "attempt-1" });
    expect(JSON.parse(String(create[1]?.body))).toMatchObject({
      first_name: "A",
      last_name: "B",
      email_address: "a@example.com",
      phone: { number: "3125551234", country_code: "US", phone_type: "mobile" },
      restaurant_email_marketing_opt_in: false,
    });
  });
  it("releases payment-required locks and never creates a reservation", async () => {
    const f = transport({}, true),
      p = new OpenTableProvider(options, f as typeof fetch);
    expect((await p.create(slot, contact, "a")).status).toBe(
      "handoff_required",
    );
    expect(
      f.mock.calls.some(([u]) => String(u).endsWith("/reservations")),
    ).toBe(false);
    expect(f.mock.calls.some(([, i]) => i?.method === "DELETE")).toBe(true);
  });
  it("requires final provider confirmation and leaves ambiguous output unknown", async () => {
    const p = new OpenTableProvider(
      options,
      transport({ message: "maybe" }) as typeof fetch,
    );
    expect((await p.create(slot, contact, "a")).status).toBe("unknown");
  });
});

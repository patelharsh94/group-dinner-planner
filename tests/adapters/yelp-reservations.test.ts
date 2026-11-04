import { describe, expect, it, vi } from "vitest";
import { YelpReservationProvider } from "../../src/adapters/yelp-reservations.js";
const slot = {
  restaurantId: "opaque-yelp-business",
  localDateTime: "2026-11-10T19:30",
  partySize: 4,
};
const contact = {
  firstName: "Sam",
  lastName: "Lee",
  email: "sam@example.com",
  phone: "+13125550123",
  countryCode: "US",
};
const opening = {
  reservation_times: [
    {
      date: "2026-11-10",
      times: [{ time: "19:30", credit_card_required: false }],
    },
  ],
};
const hold = () => ({
  hold_id: "KiXJLFFBnwW6NJbK34uKBQ",
  credit_card_hold: false,
  expires_at: Date.now() / 1000 + 300,
});
const reference = "e33b40ef-f6b1-4f17-987c-d850892564b";
function setup(responses: unknown[] = []) {
  const fetcher = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return Response.json(next);
    },
  );
  return {
    fetcher,
    provider: new YelpReservationProvider(
      { enabled: true, approved: true, apiKey: "test-key" },
      fetcher as typeof fetch,
    ),
  };
}
describe("Yelp approved reservation adapter", () => {
  it("requires explicit enablement, approval and key before any request", async () => {
    for (const options of [
      {},
      { apiKey: "key" },
      { enabled: true, apiKey: "key" },
      { approved: true, apiKey: "key" },
      { enabled: true, approved: true },
    ]) {
      const fetcher = vi.fn();
      const provider = new YelpReservationProvider(options, fetcher);
      expect((await provider.availability(slot)).status).toBe(
        "handoff_required",
      );
      expect(
        (await provider.create(slot, contact, "request", async () => true))
          .status,
      ).toBe("handoff_required");
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
  it("matches the exact restaurant local date/time and sends party size", async () => {
    const { provider, fetcher } = setup([opening]);
    expect((await provider.availability(slot)).status).toBe("ready");
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.pathname).toBe("/v3/bookings/opaque-yelp-business/openings");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      covers: "4",
      date: "2026-11-10",
      time: "19:30",
    });
  });
  it("does not substitute nearby dates or times", async () => {
    const { provider } = setup([
      {
        reservation_times: [
          {
            date: "2026-11-11",
            times: [{ time: "19:30", credit_card_required: false }],
          },
          {
            date: "2026-11-10",
            times: [{ time: "19:45", credit_card_required: false }],
          },
        ],
      },
    ]);
    expect((await provider.availability(slot)).status).toBe("unavailable");
  });
  it.each([true, undefined])(
    "requires explicit no-card opening (%s)",
    async (card) => {
      const { provider } = setup([
        {
          reservation_times: [
            {
              date: "2026-11-10",
              times: [{ time: "19:30", credit_card_required: card }],
            },
          ],
        },
      ]);
      expect((await provider.availability(slot)).status).toBe(
        "handoff_required",
      );
    },
  );
  it("places form encoded hold then reservation with authorization before each", async () => {
    const { provider, fetcher } = setup([
      opening,
      hold(),
      {
        reservation_id: reference,
        confirmation_url: "https://www.yelp.com/reservations/confirmed",
      },
    ]);
    const counts: number[] = [];
    const authorize = vi.fn(async () => {
      counts.push(fetcher.mock.calls.length);
      return true;
    });
    expect(
      await provider.create(slot, contact, "request-1", authorize),
    ).toMatchObject({ status: "booked", reference });
    expect(counts).toEqual([1, 2]);
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    const held = new URLSearchParams(String(calls[1]![1].body));
    const booked = new URLSearchParams(String(calls[2]![1].body));
    expect(calls[1]![0]).toBe(
      "https://api.yelp.com/v3/bookings/opaque-yelp-business/holds",
    );
    expect(calls[2]![0]).toBe(
      "https://api.yelp.com/v3/bookings/opaque-yelp-business/reservations",
    );
    expect(calls[2]![1].headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Bearer test-key",
    });
    expect(booked.get("unique_id")).toBe(held.get("unique_id"));
    expect(held.get("unique_id")).not.toContain(contact.email);
    for (const field of ["date", "time", "covers"])
      expect(booked.get(field)).toBe(held.get(field));
    expect(booked.get("hold_id")).toBe(hold().hold_id);
    expect(booked.get("email")).toBe(contact.email);
  });
  it.each([undefined, false])(
    "does not hold without current authorization (%s)",
    async (permission) => {
      const { provider, fetcher } = setup([opening]);
      expect(
        (
          await provider.create(
            slot,
            contact,
            "request",
            permission === undefined ? undefined : async () => false,
          )
        ).status,
      ).toBe("failed");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("stops if authorization changes after hold", async () => {
    const { provider, fetcher } = setup([opening, hold()]);
    let count = 0;
    expect(
      (
        await provider.create(
          slot,
          contact,
          "request",
          async () => ++count === 1,
        )
      ).status,
    ).toBe("failed");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    { credit_card_hold: true },
    { credit_card_hold: undefined },
    { expires_at: 1 },
    { cancellation_policy: "Cancellation charge" },
    { fees: [{ amount: 10 }] },
    { hold_id: null },
  ])("does not reserve unsafe hold %j", async (change) => {
    const { provider, fetcher } = setup([opening, { ...hold(), ...change }]);
    expect(
      (await provider.create(slot, contact, "request", async () => true))
        .status,
    ).toBe("handoff_required");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rechecks hold expiry after asynchronous authorization", async () => {
    const { provider, fetcher } = setup([
      opening,
      { ...hold(), expires_at: Date.now() / 1000 + 60 },
    ]);
    let count = 0;
    const now = vi.spyOn(Date, "now");
    const initial = Date.now();
    try {
      expect(
        (
          await provider.create(slot, contact, "request", async () => {
            if (++count === 2) now.mockReturnValue(initial + 120000);
            return true;
          })
        ).status,
      ).toBe("handoff_required");
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });
  it.each([
    {},
    { confirmation_url: "https://www.yelp.com/confirmed" },
    new Error("timeout"),
  ])(
    "never claims booking without reservation ID or retries ambiguous POST",
    async (result) => {
      const { provider, fetcher } = setup([opening, hold(), result]);
      expect(
        (await provider.create(slot, contact, "request", async () => true))
          .status,
      ).toBe("unknown");
      expect(fetcher).toHaveBeenCalledTimes(3);
    },
  );
  it("keeps unique_id stable across user operations rather than using request IDs", async () => {
    const { provider, fetcher } = setup([
      opening,
      hold(),
      { reservation_id: reference },
      opening,
      hold(),
      { reservation_id: reference },
    ]);
    await provider.create(slot, contact, "one", async () => true);
    await provider.create(slot, contact, "two", async () => true);
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(
      new URLSearchParams(String(calls[1]![1].body)).get("unique_id"),
    ).toBe(new URLSearchParams(String(calls[4]![1].body)).get("unique_id"));
  });
  it("requires slot context for documented status covers query", async () => {
    const { provider, fetcher } = setup([]);
    expect((await provider.lookup(slot.restaurantId, reference)).status).toBe(
      "unknown",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("checks status and confirmed slot when context exists", async () => {
    const { provider, fetcher } = setup([
      { active: true, date: "2026-11-10", time: "19:30:00", covers: 4 },
    ]);
    expect(
      (await provider.lookup(slot.restaurantId, reference, slot)).status,
    ).toBe("booked");
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      `https://api.yelp.com/v3/bookings/reservation/${reference}/status?covers=4`,
    );
  });
  it.each([
    { active: false, date: "2026-11-10", time: "19:30:00", covers: 4 },
    { active: true, date: "2026-11-11", time: "19:30:00", covers: 4 },
    {},
  ])("rejects unverified status %j", async (status) => {
    const { provider } = setup([status]);
    expect(
      (await provider.lookup(slot.restaurantId, reference, slot)).status,
    ).not.toBe("booked");
  });
  it.each([
    { ...slot, partySize: 11 },
    { ...slot, localDateTime: "2026-02-30T19:30" },
    { ...slot, localDateTime: "2026-11-10T19:30Z" },
    { ...slot, restaurantId: "" },
  ])("rejects invalid slot before network %j", async (invalid) => {
    const { provider, fetcher } = setup();
    expect((await provider.availability(invalid)).status).toBe(
      "handoff_required",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

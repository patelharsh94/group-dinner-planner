import { describe, expect, it, vi } from "vitest";
import { ReservationService } from "../../src/application/reservations.js";
import { ConfigSchema } from "../../src/config.js";
import type { ReservationProvider } from "../../src/adapters/opentable.js";
import type { AppDinner } from "../../src/application/model.js";
import type {
  ClaimedWork,
  DinnerRecord,
  DinnerTx,
  PgStore,
} from "../../src/persistence/store.js";
function fixture(directoryBusinessId?: string) {
  const venue = {
    id: "venue",
    name: "Chosen restaurant",
    address: "City centre",
    ...(directoryBusinessId ? { directoryBusinessId } : {}),
    evidence: { reservation: { status: "unknown" } },
  };
  return {
    id: "dinner",
    endedAt: null,
    state: {
      consents: { organizer: { active: true } },
      joinRequests: {},
      dinner: {
        organizerId: "organizer",
        members: [{ id: "organizer" }],
        activeVersion: 1,
        confirmations: { organizer: 1 },
        disputes: [],
        status: "ready",
        venues: [venue],
        proposals: [
          {
            version: 1,
            selectedIndex: 0,
            venues: [venue],
            options: [{ venueId: "venue", start: "2026-11-10T01:30:00Z" }],
          },
        ],
        setup: { timezone: "America/Chicago" },
      },
    },
  } as unknown as DinnerRecord<AppDinner>;
}
function setup(providerName = "yelp", enabled = true) {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({
    rowCount: 0,
    rows: [],
  }));
  const queue = vi.fn();
  const tx = { client: { query }, queue } as unknown as DinnerTx;
  const provider = {
    capability: () => ({
      available: enabled,
      provider: providerName,
      message: "Partner access required",
    }),
  } as ReservationProvider;
  const service = new ReservationService({} as PgStore, provider, "unused", {});
  return { query, tx, service, queue };
}
describe("Yelp reservation routing", () => {
  it("uses chosen venue's opaque Yelp business ID with the restaurant local wall time", async () => {
    const { service, tx, query, queue } = setup();
    const review = await service.review(
      tx,
      fixture("aB_yelp-opaque"),
      "organizer",
      { version: 1 },
    );
    expect(review.status).toBe("checking");
    expect(review.provider).toBe("yelp");
    expect(queue).toHaveBeenCalledTimes(1);
    const insert = query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO reservation_reviews"),
    )!;
    expect(JSON.parse(String(insert[1]![5]))).toEqual({
      restaurantId: "aB_yelp-opaque",
      localDateTime: "2026-11-09T19:30",
      partySize: 1,
    });
  });
  it("hands off when approved access is unavailable", async () => {
    const { service, tx, queue } = setup("yelp", false);
    expect(
      (await service.review(tx, fixture("opaque"), "organizer", { version: 1 }))
        .status,
    ).toBe("handoff_required");
    expect(queue).not.toHaveBeenCalled();
  });
  it("never invents a Yelp ID from app venue IDs", async () => {
    const { service, tx, queue } = setup();
    expect(
      (await service.review(tx, fixture(), "organizer", { version: 1 })).status,
    ).toBe("handoff_required");
    expect(queue).not.toHaveBeenCalled();
  });
  it("does not use a Yelp business ID for OpenTable", async () => {
    const { service, tx } = setup("opentable");
    expect(
      (await service.review(tx, fixture("opaque"), "organizer", { version: 1 }))
        .status,
    ).toBe("handoff_required");
  });
  it("preserves unanimous current plan confirmation before review", async () => {
    const { service, tx } = setup();
    const record = fixture("opaque");
    record.state.dinner.confirmations = {};
    await expect(
      service.review(tx, record, "organizer", { version: 1 }),
    ).rejects.toMatchObject({ code: "NOT_READY" });
  });
  it("defaults Yelp reservations approval off and accepts only explicit booleans", () => {
    expect(ConfigSchema.shape.YELP_RESERVATIONS_APPROVED.parse(undefined)).toBe(
      false,
    );
    expect(ConfigSchema.shape.YELP_RESERVATIONS_APPROVED.parse("true")).toBe(
      true,
    );
    expect(() =>
      ConfigSchema.shape.YELP_RESERVATIONS_APPROVED.parse("yes"),
    ).toThrow();
  });
});

it("does not query a different provider for persisted availability work", async () => {
  const availability = vi.fn();
  const provider = {
    capability: () => ({ available: true, provider: "yelp", message: "" }),
    availability,
  } as unknown as ReservationProvider;
  const pending = {
    review: { version: 1, provider: "opentable", status: "checking" },
    slot: {
      restaurantId: "42",
      localDateTime: "2026-11-09T19:30",
      partySize: 1,
    },
  };
  const writes: unknown[][] = [];
  const store = {
    transaction: async (run: (tx: unknown) => unknown) =>
      run({ client: { query: async () => ({ rows: [pending] }) } }),
    processWork: async (
      _id: string,
      _worker: string,
      run: (tx: unknown) => unknown,
    ) =>
      run({
        getDinner: async () => null,
        client: {
          query: async (...args: unknown[]) => {
            writes.push(args);
          },
        },
      }),
  } as unknown as PgStore;
  await new ReservationService(store, provider, "unused").processReservation(
    {
      id: "work",
      payload: { operation: "review", dinnerId: "dinner", reviewId: "review" },
    } as ClaimedWork,
    "worker",
  );
  expect(availability).not.toHaveBeenCalled();
  expect(JSON.parse(String((writes[0]![1] as unknown[])[1])).status).toBe(
    "action_needed",
  );
});

import { it, expect, vi } from "vitest";
import { MuseClient } from "../../src/adapters/muse.js";
const now = "2026-11-03T12:00:00Z";
const context = {
  setup: {
    city: "Chicago",
    area: "Loop",
    windowStart: "2026-11-10",
    windowEnd: "2026-11-11",
    timezone: "America/Chicago",
    timezoneConfirmed: true as const,
    currency: "USD",
    currencyConfirmed: true as const,
    durationMinutes: 90,
    budget: { amount: 60, basis: "per-person" as const },
    intendedAttendees: ["a", "b"],
  },
  slots: [],
  dietary: [],
  travel: [],
  partySize: 2,
};
function fetcher() {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        status: "completed",
        output: [
          { type: "web_search_call", status: "completed" },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({ venues: [], options: [], gaps: [] }),
              },
            ],
          },
        ],
      }),
    ),
  );
}
it("YELP-01 uses ephemeral candidates for independent web lookup and persists IDs only", async () => {
  const search = vi.fn().mockResolvedValue([
    {
      id: "business-id",
      name: "Public Restaurant",
      address: "1 Main St",
      city: "Chicago",
      url: "https://www.yelp.com/biz/business-id",
      categories: [],
      retrievedAt: now,
      expiresAt: "2026-11-03T12:15:00Z",
      phone: "PRIVATE-IN-CONTEXT",
      priceLevel: "$$$$",
    },
  ]);
  const fetch = fetcher();
  const client = new MuseClient({
    apiKey: "test",
    fetcher: fetch,
    yelp: { search } as any,
  });
  const result = await client.research(context, now);
  expect(search).toHaveBeenCalledWith({
    city: "Chicago",
    area: "Loop",
    term: "restaurants",
  });
  const input = JSON.parse(fetch.mock.calls[0][1].body).input;
  expect(input).toContain("Public Restaurant");
  expect(input).not.toContain("PRIVATE-IN-CONTEXT");
  expect(input).not.toContain("$$$$");
  expect(JSON.stringify(result)).not.toContain("Public Restaurant");
  expect(result.discovery).toMatchObject({
    status: "used",
    candidateIds: ["business-id"],
  });
});
it("YELP-01 a failed directory lookup preserves web search and exposes a safe outcome", async () => {
  const client = new MuseClient({
    apiKey: "test",
    fetcher: fetcher(),
    yelp: {
      search: vi.fn().mockRejectedValue(new Error("secret provider text")),
    } as any,
  });
  const result = await client.research(context, now);
  expect(result.discovery?.status).toBe("unavailable");
  expect(JSON.stringify(result)).not.toContain("secret provider text");
});
it("YELP-01 focused venue verification does not discover replacements", async () => {
  const search = vi.fn();
  const client = new MuseClient({
    apiKey: "test",
    fetcher: fetcher(),
    yelp: { search } as any,
  });
  await client.research(
    {
      ...context,
      targetVenue: { name: "Current venue", address: "Public address" },
    },
    now,
  );
  expect(search).not.toHaveBeenCalled();
});

it.each([
  [true, "Public Restaurant", true],
  [false, "Public Restaurant", false],
  [true, "東京", false],
] as const)(
  "YELP-01 only retains a candidate with independently sourced identity (grounded=%s)",
  async (grounded, name, accepted) => {
    const url = "https://restaurant.example/contact";
    const excerpt = "Public Restaurant, 1 Main St, Chicago, Loop";
    const claim = { status: "known", url, excerpt, retrievedAt: now };
    const venue = {
      id: "venue",
      name,
      address: "1 Main St",
      city: "Chicago",
      area: "Loop",
      evidence: {
        location: {
          ...claim,
          relatedSources: [
            {
              url: "https://unfetched.example/page",
              excerpt: "SECOND TRANSIENT DIRECTORY TEXT",
              retrievedAt: now,
            },
          ],
        },
        price: {
          ...claim,
          status: "unknown",
          excerpt: "TRANSIENT DIRECTORY TEXT",
        },
        opening: { ...claim, status: "unknown", intervals: [] },
        reservation: { ...claim, status: "unknown" },
        dietary: {},
        travel: {},
      },
    };
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              type: "web_search_call",
              status: "completed",
              results: [{ url }],
            },
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    venues: [venue],
                    options: [],
                    gaps: ["Public Restaurant directory gap"],
                  }),
                },
              ],
            },
          ],
        }),
      ),
    );
    const search = vi.fn().mockResolvedValue([
      {
        id: "business-id",
        name: venue.name,
        address: venue.address,
        city: venue.city,
      },
    ]);
    const client = new MuseClient({
      apiKey: "test",
      fetcher: fetch,
      yelp: { search },
      sourceReader: async () => (grounded ? excerpt : "unrelated content"),
    });
    const result = await client.research(context, now);
    expect(result.venues).toHaveLength(accepted ? 1 : 0);
    expect(result.gaps.join(" ")).not.toContain("Public Restaurant");
    expect(JSON.stringify(result)).not.toContain("TRANSIENT DIRECTORY TEXT");
    expect(JSON.stringify(result)).not.toContain(
      "SECOND TRANSIENT DIRECTORY TEXT",
    );
    if (!grounded)
      expect(JSON.stringify(result)).not.toContain("Public Restaurant");
  },
);

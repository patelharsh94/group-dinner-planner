import { expect, it } from "vitest";
import type { Venue } from "../../src/domain/index.js";
import { retainIndependentlyVerifiedVenues } from "../../src/adapters/research-evidence.js";

const now = "2026-11-03T12:00:00Z";
const url = "https://restaurant.example/about";
function fixture(): Venue {
  const claim = {
    status: "unknown" as const,
    url,
    excerpt: "Cafe Fixture, 12 North Main Street, Chicago",
    retrievedAt: now,
  };
  return {
    id: "v",
    name: "Cafe Fixture",
    address: "12 N Main St",
    city: "Chicago",
    area: "West Loop",
    evidence: {
      location: { ...claim },
      price: { ...claim },
      opening: { ...claim },
      reservation: { ...claim },
      dietary: {},
      travel: {},
    },
  };
}
function retain(
  venue = fixture(),
  body = "Cafe Fixture, 12 North Main Street, Chicago",
) {
  return retainIndependentlyVerifiedVenues(
    [venue],
    new Set([url]),
    new Map([[url, body]]),
    now,
  );
}

it("retains independently verified identity while neighborhood remains unknown", () => {
  const result = retain();
  expect(result.venues).toHaveLength(1);
  expect(result.venues[0].evidence.location.status).toBe("unknown");
  expect(result.rejectedIdentities).toBe(0);
});

it.each(["travel", "dietary"] as const)(
  "does not promote private %s source URLs into shared identity evidence",
  (kind) => {
    const privateUrl =
      "https://directions.example/route?origin=private-home&destination=cafe";
    const text = fixture().evidence.location.excerpt;
    for (const fallback of [false, true]) {
      const venue = fixture();
      const claim = {
        status: "unknown" as const,
        url: privateUrl,
        excerpt: text,
        retrievedAt: now,
      };
      if (kind === "travel") venue.evidence.travel.person = claim;
      else venue.evidence.dietary.privateRequirement = claim;
      const result = retainIndependentlyVerifiedVenues(
        [venue],
        new Set([url, privateUrl]),
        fallback ? new Map() : new Map([[privateUrl, text]]),
        now,
        fallback ? new Map([[privateUrl, text]]) : new Map(),
      );
      expect(result.venues).toEqual([]);
      expect(result.rejectedIdentities).toBe(1);
    }
  },
);

it("scrubs unknown Yelp price instead of discarding independently identified venue", () => {
  const venue = fixture();
  venue.evidence.price = {
    status: "unknown",
    url: "https://www.yelp.com/biz/fixture",
    excerpt: "Yelp directory pricing",
    retrievedAt: now,
    amount: 40,
    currency: "USD",
  };
  const result = retain(venue);
  expect(result.venues).toHaveLength(1);
  expect(result.venues[0].evidence.price).toEqual({
    status: "unknown",
    url,
    excerpt: "This detail remains unresolved.",
    retrievedAt: now,
  });
  expect(JSON.stringify(result)).not.toContain("yelp");
});

it("requires grounded name, street address and city rather than neighborhood feasibility", () => {
  for (const text of [
    "Cafe Fixture has wonderful dinners",
    "Cafe Fixture, Chicago",
    "12 North Main Street, Chicago",
  ]) {
    const venue = fixture();
    venue.evidence.location.excerpt = text;
    expect(retain(venue, text).venues).toEqual([]);
  }
  expect(
    retainIndependentlyVerifiedVenues(
      [fixture()],
      new Set(),
      new Map([[url, fixture().evidence.location.excerpt]]),
      now,
    ).venues,
  ).toEqual([]);
});

it("preserves independently sourced non-ASCII identity", () => {
  const venue = fixture();
  venue.name = "Étoile 京都";
  venue.address = "12 Rue de l'Église";
  venue.city = "Montréal";
  venue.evidence.location.excerpt = "Étoile 京都, 12 Rue de l'Église, Montréal";
  const result = retain(venue, venue.evidence.location.excerpt);
  expect(result.venues[0].name).toBe("Étoile 京都");
  expect(result.venues[0].address).toBe("12 Rue de l'Église");
});

it("removes ungrounded and Yelp secondary sources and ungrounded contradictory claims", () => {
  const venue = fixture();
  venue.evidence.location.relatedSources = [
    { url, excerpt: "A made up secondary source claim", retrievedAt: now },
    {
      url: "https://yelp.com/fixture",
      excerpt: "Cafe Fixture, 12 North Main Street, Chicago",
      retrievedAt: now,
    },
  ];
  venue.evidence.price = {
    status: "contradictory",
    url,
    excerpt: "Ungrounded contradiction about a private diner",
    retrievedAt: now,
    amount: 200,
  };
  const result = retain(venue);
  expect(result.venues[0].evidence.location.relatedSources).toEqual([]);
  expect(result.venues[0].evidence.price.status).toBe("unknown");
  expect(JSON.stringify(result)).not.toContain("private diner");
});

it("preserves grounded known and contradictory claims for domain feasibility checks", () => {
  const venue = fixture();
  venue.evidence.price = {
    status: "known",
    url,
    excerpt: "Dinner USD 90 per person",
    retrievedAt: now,
    amount: 90,
    currency: "USD",
    basis: "per-person",
  };
  venue.evidence.reservation = {
    status: "contradictory",
    url,
    excerpt: "No reservations available for the requested time",
    retrievedAt: now,
    state: "unavailable",
  };
  const result = retain(
    venue,
    `${venue.evidence.location.excerpt}. Dinner USD 90 per person. No reservations available for the requested time`,
  );
  expect(result.venues[0].evidence.price.amount).toBe(90);
  expect(result.venues[0].evidence.reservation.status).toBe("contradictory");
});

it("Muse keeps a candidate whose independent identity is known but neighborhood and price are unresolved", async () => {
  const { MuseClient } = await import("../../src/adapters/muse.js");
  const venue = fixture();
  venue.evidence.location.status = "known";
  venue.evidence.price.url = "https://www.yelp.com/biz/fixture";
  venue.evidence.price.excerpt = "Directory price range";
  const client = new MuseClient({
    apiKey: "test-only",
    yelp: {
      search: async () => [
        {
          id: "seed",
          name: venue.name,
          address: venue.address,
          city: venue.city,
          url: "https://www.yelp.com/biz/fixture",
          categories: [],
          retrievedAt: now,
          expiresAt: "2026-11-04T12:00:00Z",
        },
      ],
    },
    sourceReader: async () => venue.evidence.location.excerpt,
    fetcher: async () =>
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
                    options: [
                      {
                        venueId: "v",
                        start: "2026-11-05T19:00:00Z",
                        end: "2026-11-05T20:30:00Z",
                        pricePerPerson: 40,
                        priceBasis: "per-person",
                        durationMinutes: 90,
                      },
                    ],
                    gaps: [],
                  }),
                },
              ],
            },
          ],
        }),
      ),
  });
  const result = await client.research(
    {
      setup: {
        city: "Chicago",
        area: "West Loop",
        timezone: "America/Chicago",
        timezoneConfirmed: true,
        currency: "USD",
        currencyConfirmed: true,
        windowStart: "2026-11-05",
        windowEnd: "2026-11-05",
        durationMinutes: 90,
        budget: { amount: 60, basis: "per-person" },
        intendedAttendees: ["a", "b", "c"],
      },
      slots: [],
      dietary: [],
      travel: [],
      partySize: 3,
    },
    now,
  );
  expect(result.venues).toHaveLength(1);
  expect(result.options).toHaveLength(1);
  expect(result.venues[0].evidence.location.status).toBe("unknown");
  expect(result.venues[0].evidence.price.excerpt).toBe(
    "This detail remains unresolved.",
  );
  expect(JSON.stringify(result)).not.toContain("yelp.com");
  expect(result.verification?.issues).toEqual(
    expect.arrayContaining([
      { code: "claim_unsupported", count: 1 },
      { code: "provider_unknown", count: 3 },
    ]),
  );
});

it("does not mistake a longer restaurant name for a corroborated identity", () => {
  const venue = fixture();
  venue.evidence.location.excerpt =
    "Cafe Fixturehouse, 12 North Main Street, Chicago";
  expect(retain(venue, venue.evidence.location.excerpt).venues).toEqual([]);
});

it.each([
  "Cafe Fixture, 112 North Main Street, Chicago",
  "Cafe Fixture, 12 North Main Street, Chicagoland",
  "Cafe Fixture, 12 North Main Streetway, Chicago",
  "Cafe Fixture, 12A North Main Street, Chicago",
])("rejects partial street or city identity matches: %s", (excerpt) => {
  const venue = fixture();
  venue.evidence.location.excerpt = excerpt;
  expect(retain(venue, excerpt).venues).toEqual([]);
});

async function researchWithEvidence({
  results,
  claimUrl = url,
  sourceBody,
  sourceError,
  directory = true,
}: {
  results: { url: string; title?: string; snippet?: string }[];
  claimUrl?: string;
  sourceBody?: string;
  sourceError?: string;
  directory?: boolean;
}) {
  const { MuseClient } = await import("../../src/adapters/muse.js");
  const venue = fixture();
  for (const claim of [
    venue.evidence.location,
    venue.evidence.price,
    venue.evidence.opening,
    venue.evidence.reservation,
  ]) {
    claim.url = claimUrl;
    claim.status = "known";
  }
  const client = new MuseClient({
    apiKey: "test-only",
    yelp: directory
      ? {
          search: async () => [
            {
              id: "seed",
              name: venue.name,
              address: venue.address,
              city: venue.city,
              url: "https://yelp.com/biz/fixture",
              categories: [],
              retrievedAt: now,
              expiresAt: "2026-11-04T12:00:00Z",
            },
          ],
        }
      : undefined,
    sourceReader: async () => {
      if (sourceError) throw new Error(sourceError);
      if (sourceBody === undefined) throw new Error("Source unavailable");
      return sourceBody;
    },
    fetcher: async () =>
      new Response(
        JSON.stringify({
          status: "completed",
          output: [
            { type: "web_search_call", status: "completed", results },
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    venues: [venue],
                    options: [],
                    gaps: [],
                  }),
                },
              ],
            },
          ],
        }),
      ),
  });
  return client.research(
    {
      setup: {
        city: "Chicago",
        area: "West Loop",
        timezone: "America/Chicago",
        timezoneConfirmed: true,
        currency: "USD",
        currencyConfirmed: true,
        windowStart: "2026-11-05",
        windowEnd: "2026-11-05",
        durationMinutes: 90,
        budget: { amount: 60, basis: "per-person" },
        intendedAttendees: ["a", "b", "c"],
      },
      slots: [],
      dietary: [],
      travel: [],
      partySize: 3,
    },
    now,
  );
}

it("uses attested tool snippets only to retain identity when fetching fails", async () => {
  const result = await researchWithEvidence({
    results: [
      { url, title: "Cafe Fixture", snippet: "12 North Main Street, Chicago" },
    ],
  });
  expect(result.venues).toHaveLength(1);
  expect(result.venues[0].evidence.location.status).toBe("unknown");
  expect(result.venues[0].evidence.price.status).toBe("unknown");
  expect(result.verification?.verifiedClaims).toBe(0);
});

it("does not use model-authored identity text when fetching fails", async () => {
  const result = await researchWithEvidence({ results: [{ url }] });
  expect(result.venues).toHaveLength(0);
});

it("does not use Yelp snippets or override successfully fetched unrelated evidence", async () => {
  const snippet = fixture().evidence.location.excerpt;
  expect(
    (
      await researchWithEvidence({
        results: [{ url: "https://yelp.com/biz/fixture", snippet }],
      })
    ).venues,
  ).toHaveLength(0);
  expect(
    (
      await researchWithEvidence({
        results: [{ url, snippet }],
        sourceBody: "A different restaurant at an unrelated address",
      })
    ).venues,
  ).toHaveLength(0);
});

it.each([
  ["https://restaurant.example", "https://restaurant.example/"],
  [
    "https://restaurant.example/about#location",
    "https://restaurant.example/about",
  ],
])(
  "matches safe equivalent citation URLs %s and %s",
  async (claimUrl, citationUrl) => {
    const result = await researchWithEvidence({
      claimUrl,
      results: [{ url: citationUrl }],
      sourceBody: fixture().evidence.location.excerpt,
    });
    expect(result.venues).toHaveLength(1);
  },
);

it("does not equate citation URLs with different queries", async () => {
  const result = await researchWithEvidence({
    claimUrl: `${url}?venue=a`,
    results: [{ url: `${url}?venue=b` }],
    sourceBody: fixture().evidence.location.excerpt,
  });
  expect(result.venues).toHaveLength(0);
});

it.each([
  "Excluded source domain",
  "Nonpublic source address",
  "Too many source redirects",
  "Invalid URL",
])(
  "does not use snippets after unsafe source failure: %s",
  async (sourceError) => {
    const result = await researchWithEvidence({
      results: [{ url, snippet: fixture().evidence.location.excerpt }],
      sourceError,
    });
    expect(result.venues).toHaveLength(0);
  },
);

it("retains snippet-backed identity in web-only research with failed page retrieval", async () => {
  const result = await researchWithEvidence({
    directory: false,
    results: [
      { url, title: "Cafe Fixture", snippet: "12 North Main Street, Chicago" },
    ],
  });
  expect(result.venues).toHaveLength(1);
  expect(result.venues[0].evidence.location.status).toBe("unknown");
  expect(result.verification?.verifiedClaims).toBe(0);
});

import { expect, it, vi } from "vitest";
import { MuseClient, type ResearchContext } from "../../src/adapters/muse.js";
const now = "2026-11-03T12:00:00Z";
const url = "https://gaijin.example/";
const text =
  "Gaijin 950 W Lake St Chicago. Dinner USD 40 per person. Vegan options available.";
const context: ResearchContext = {
  targetVenue: { name: "Gaijin", address: "950 W Lake St", websiteUrl: url },
  setup: {
    city: "Chicago",
    area: "Chicago",
    timezone: "America/Chicago",
    timezoneConfirmed: true,
    currency: "USD",
    currencyConfirmed: true,
    windowStart: "2026-11-05",
    windowEnd: "2026-11-05",
    durationMinutes: 90,
    budget: { amount: 60, basis: "per-person" },
    intendedAttendees: ["a", "b"],
  },
  slots: [],
  dietary: [],
  travel: [],
  partySize: 2,
};
function result(name = "Gaijin") {
  const claim = { status: "known", url, retrievedAt: now, excerpt: text };
  return {
    venues: [
      {
        id: "v",
        name,
        address: "950 W Lake St",
        city: "Chicago",
        area: "Chicago",
        evidence: {
          location: claim,
          price: { ...claim, amount: 40, currency: "USD", basis: "per-person" },
          opening: { ...claim, status: "unknown" },
          reservation: { ...claim, status: "unknown" },
          dietary: {},
          travel: {},
        },
      },
    ],
    options: [],
    gaps: [],
  };
}
function response(value: unknown, searchUrls?: string[]) {
  if (value && typeof value === "object" && "venues" in value) {
    const answer = value as ReturnType<typeof result>;
    value = { evidence: answer.venues[0].evidence, gaps: answer.gaps };
  }
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        ...(searchUrls
          ? [
              {
                type: "web_search_call",
                status: "completed",
                results: searchUrls.map((url) => ({ url })),
              },
            ]
          : []),
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(value) }],
        },
      ],
    }),
  );
}
it("uses the official website directly, then tool-free extraction and fetched text verification without another fetch", async () => {
  const fetcher = vi.fn().mockImplementation(async () => response(result()));
  const sourceReader = vi.fn().mockResolvedValue(text);
  const client = new MuseClient({ apiKey: "fixture", fetcher, sourceReader });
  const actual = await client.research(context, now);
  expect(sourceReader).toHaveBeenCalledTimes(1);
  expect(sourceReader).toHaveBeenCalledWith(url);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.tools).toBeUndefined();
  expect(body.input).toContain(text.toLowerCase());
  expect(body.instructions).toMatch(/untrusted/);
  expect(actual.venues[0].evidence.price.status).toBe("known");
  expect(actual.venues[0].evidence.location.status).toBe("known");
});
it("does one focused official URL lookup only when the seed is missing", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response({ websiteUrl: url }, [url]))
    .mockResolvedValueOnce(response(result()));
  const sourceReader = vi.fn().mockResolvedValue(text);
  const client = new MuseClient({ apiKey: "fixture", fetcher, sourceReader });
  await client.research(
    { ...context, targetVenue: { name: "Gaijin", address: "950 W Lake St" } },
    now,
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  const bodies = fetcher.mock.calls.map((call) => JSON.parse(call[1].body));
  expect(bodies[0].tools).toEqual([{ type: "web_search" }]);
  expect(JSON.parse(bodies[0].input)).toEqual({
    name: "Gaijin",
    address: "950 W Lake St",
    city: "Chicago",
  });
  expect(bodies[1].tools).toBeUndefined();
});
it("rejects model-authored URLs without provider search attestation and does not retry", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      response({ websiteUrl: url }, ["https://unrelated.example/"]),
    );
  const sourceReader = vi.fn();
  const client = new MuseClient({ apiKey: "fixture", fetcher, sourceReader });
  const actual = await client.research(
    { ...context, targetVenue: { name: "Gaijin", address: "950 W Lake St" } },
    now,
  );
  expect(sourceReader).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(actual.venues).toEqual([]);
  expect(actual.options).toEqual([]);
  expect(actual.gaps.length).toBeGreaterThan(0);
});
it("returns safe gaps on blocked pages and never falls back to broad research", async () => {
  const fetcher = vi.fn();
  const sourceReader = vi
    .fn()
    .mockRejectedValue(new Error("Nonpublic source address"));
  const actual = await new MuseClient({
    apiKey: "fixture",
    fetcher,
    sourceReader,
  }).research(context, now);
  expect(fetcher).not.toHaveBeenCalled();
  expect(actual.venues).toEqual([]);
  expect(actual.gaps.join(" ")).not.toContain("Nonpublic");
});
it("discards unrelated website identities even when the provider returns evidence", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(response(result("Other Restaurant")));
  const sourceReader = vi
    .fn()
    .mockResolvedValue(
      "Other Restaurant 950 W Lake St Chicago. Dinner USD 40 per person.",
    );
  const actual = await new MuseClient({
    apiKey: "fixture",
    fetcher,
    sourceReader,
  }).research(context, now);
  expect(actual.venues).toEqual([]);
  expect(actual.options).toEqual([]);
});

it("preserves fetched restaurant identity when extraction times out after forty-five seconds", async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const sourceReader = vi.fn().mockResolvedValue(text);
    const pending = new MuseClient({
      apiKey: "fixture",
      fetcher,
      sourceReader,
    }).research(context, now);
    await vi.advanceTimersByTimeAsync(45001);
    const actual = await pending;
    expect(actual.focusedSite).toBe(true);
    expect(actual.venues[0].name).toBe("Gaijin");
    expect(actual.venues[0].evidence.location.status).toBe("known");
    expect(actual.venues[0].evidence.price.status).toBe("unknown");
    expect(actual.options).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sourceReader).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("bounds missing-site lookup to twenty seconds and returns a safe gap", async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const sourceReader = vi.fn();
    const pending = new MuseClient({
      apiKey: "fixture",
      fetcher,
      sourceReader,
    }).research(
      { ...context, targetVenue: { name: "Gaijin", address: "950 W Lake St" } },
      now,
    );
    await vi.advanceTimersByTimeAsync(20001);
    expect(await pending).toMatchObject({
      venues: [],
      options: [],
      focusedSite: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sourceReader).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("retains only the independently verified official URL and rejects unrelated authored citations", async () => {
  const answer = result();
  Object.assign(answer.venues[0], {
    officialWebsiteUrl: "https://evil.example/",
  });
  answer.venues[0].evidence.price.url = "https://evil.example/prices";
  const sourceReader = vi.fn().mockResolvedValue(text);
  const actual = await new MuseClient({
    apiKey: "fixture",
    sourceReader,
    fetcher: vi.fn().mockResolvedValue(response(answer)),
  }).research(context, now);
  expect(actual.venues[0].officialWebsiteUrl).toBe(url);
  expect(actual.venues[0].evidence.price.status).toBe("unknown");
  expect(sourceReader).toHaveBeenCalledTimes(1);
});

it("rejects provider-attested social and aggregator URLs instead of calling them official", async () => {
  for (const websiteUrl of [
    "https://www.facebook.com/gaijin",
    "https://www.tripadvisor.com/Restaurant-gaijin",
    "https://www.opentable.com/gaijin",
    "https://resy.com/cities/chicago/gaijin",
  ]) {
    const fetcher = vi
      .fn()
      .mockResolvedValue(response({ websiteUrl }, [websiteUrl]));
    const sourceReader = vi.fn();
    const actual = await new MuseClient({
      apiKey: "fixture",
      fetcher,
      sourceReader,
    }).research(
      { ...context, targetVenue: { name: "Gaijin", address: "950 W Lake St" } },
      now,
    );
    expect(actual).toMatchObject({
      venues: [],
      options: [],
      focusedSite: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sourceReader).not.toHaveBeenCalled();
  }
});

it("preserves identity only when extraction is invalid", async () => {
  const siteText = `${text} Call (312) 929-4444. Thursday 5 PM - 10 PM.`;
  const slot = {
    start: "2026-11-05T19:00:00-06:00",
    end: "2026-11-05T20:30:00-06:00",
  };
  const fetcher = vi
    .fn()
    .mockResolvedValue(response({ broken: "invalid evidence schema" }));
  const actual = await new MuseClient({
    apiKey: "fixture",
    fetcher,
    sourceReader: vi.fn().mockResolvedValue(siteText),
  }).research({ ...context, slots: [slot] }, now);
  expect(actual).toMatchObject({ focusedSite: true, options: [] });
  expect(actual.venues[0].evidence.location.status).toBe("known");
  expect(actual.venues[0].evidence.reservation.status).toBe("unknown");
  expect(actual.venues[0].evidence.reservation.phone).toBeUndefined();
  expect(actual.venues[0].evidence.opening.status).toBe("unknown");
  expect(actual.venues[0].evidence.price.status).toBe("unknown");
  expect(actual.venues[0].evidence.dietary).toEqual({});
  expect(actual.venues[0].evidence.travel).toEqual({});
  expect(actual.venues[0].evidence.location.excerpt.length).toBeLessThanOrEqual(
    660,
  );
});

it("returns safe gaps on incomplete extraction when fetched pages cannot prove identity", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ status: "incomplete", output: [] })),
    );
  const actual = await new MuseClient({
    apiKey: "fixture",
    fetcher,
    sourceReader: vi
      .fn()
      .mockResolvedValue(
        "Welcome to a restaurant whose name and street address are absent.",
      ),
  }).research(context, now);
  expect(actual).toMatchObject({ venues: [], options: [], focusedSite: true });
  expect(actual.gaps.length).toBeGreaterThan(0);
});

it("does not suppress typed quota failures during selected extraction", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), {
      status: 429,
    }),
  );
  await expect(
    new MuseClient({
      apiKey: "fixture",
      fetcher,
      sourceReader: vi.fn().mockResolvedValue(text),
    }).research(context, now),
  ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
});

it("preserves verified site facts when a successful extraction leaves identity and contact unknown", async () => {
  const answer = result();
  answer.venues[0].evidence.location = {
    ...answer.venues[0].evidence.location,
    status: "unknown",
    excerpt: "This detail remains unresolved.",
  };
  const fetcher = vi.fn().mockResolvedValue(response(answer));
  const slot = {
    start: "2026-11-05T19:00:00-06:00",
    end: "2026-11-05T20:30:00-06:00",
  };
  const actual = await new MuseClient({
    apiKey: "fixture",
    fetcher,
    sourceReader: vi
      .fn()
      .mockResolvedValue(`${text} Call (312) 929-4444. Thursday 5 PM - 10 PM.`),
  }).research(
    {
      ...context,
      slots: [slot],
      preferences: ["PRIVATE_PREFERENCE"],
      travel: [{ alias: "a", origin: "PRIVATE_ORIGIN", maxMinutes: 20 }],
    },
    now,
  );
  expect(actual.venues[0].evidence.location.status).toBe("known");
  expect(actual.venues[0].evidence.reservation.phone).toBeUndefined();
  expect(actual.venues[0].evidence.opening.status).toBe("unknown");
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.max_output_tokens).toBe(3500);
  expect(body.input).not.toMatch(
    /PRIVATE_ORIGIN|PRIVATE_PREFERENCE|intendedAttendees|budget/,
  );
  expect(body.text.format.schema.properties).not.toHaveProperty("venues");
});

it("does not borrow a different location's phone from a linked page during fallback", async () => {
  const homepage = `<p>${text} Call (312) 929-4444.</p><a href="/contact">Contact</a>`;
  const sourceReader = vi.fn(async (page: string) =>
    page === url
      ? homepage
      : "Other Restaurant 25 Other Street Other City. Call (415) 555-1212.",
  );
  const fetcher = vi.fn().mockResolvedValue(response({ invalid: true }));
  const actual = await new MuseClient({
    apiKey: "fixture",
    fetcher,
    sourceReader,
  }).research(context, now);
  expect(actual.venues[0].evidence.reservation.phone).toBeUndefined();
});

it("never assigns another location's phone or hours on a shared chain page", async () => {
  const siteText =
    "Gaijin 950 W Lake St Chicago. Our Milwaukee location: Gaijin 25 Water St Milwaukee. Call (414) 555-1212. Thursday 5 PM - 10 PM.";
  const slot = {
    start: "2026-11-05T19:00:00-06:00",
    end: "2026-11-05T20:30:00-06:00",
  };
  for (const valid of [false, true]) {
    const answer = result();
    Object.assign(answer.venues[0].evidence.reservation, {
      status: "known",
      excerpt: siteText,
      phone: "(414) 555-1212",
    });
    Object.assign(answer.venues[0].evidence.opening, {
      status: "known",
      excerpt: siteText,
      intervals: [slot],
    });
    const actual = await new MuseClient({
      apiKey: "fixture",
      fetcher: vi
        .fn()
        .mockResolvedValue(response(valid ? answer : { invalid: true })),
      sourceReader: vi.fn().mockResolvedValue(siteText),
    }).research({ ...context, slots: [slot] }, now);
    expect(actual.venues[0].evidence.location.status).toBe("known");
    expect(actual.venues[0].evidence.reservation.status).toBe("unknown");
    expect(actual.venues[0].evidence.reservation.phone).toBeUndefined();
    expect(actual.venues[0].evidence.opening.status).toBe("unknown");
  }
});

it("retains extracted phone and hours when their primary excerpt proves one exact location", async () => {
  const siteText =
    "Gaijin 950 W Lake St Chicago. Call (312) 929-4444. Thursday 5 PM - 10 PM.";
  const slot = {
    start: "2026-11-05T19:00:00-06:00",
    end: "2026-11-05T20:30:00-06:00",
  };
  const answer = result();
  Object.assign(answer.venues[0].evidence.reservation, {
    status: "known",
    excerpt: siteText,
    phone: "(312) 929-4444",
  });
  Object.assign(answer.venues[0].evidence.opening, {
    status: "known",
    excerpt: siteText,
    intervals: [slot],
  });
  const actual = await new MuseClient({
    apiKey: "fixture",
    fetcher: vi.fn().mockResolvedValue(response(answer)),
    sourceReader: vi.fn().mockResolvedValue(siteText),
  }).research({ ...context, slots: [slot] }, now);
  expect(actual.venues[0].evidence.reservation).toMatchObject({
    status: "known",
    phone: "(312) 929-4444",
  });
  expect(actual.venues[0].evidence.opening).toMatchObject({
    status: "known",
    intervals: [slot],
  });
});

it("cannot combine target identity with another page's phone or hours through related sources", async () => {
  const menuUrl = "https://gaijin.example/contact";
  const identity = "Gaijin 950 W Lake St Chicago.";
  const other =
    "Gaijin 25 Water St Milwaukee. Call (414) 555-1212. Thursday 5 PM - 10 PM.";
  const slot = {
    start: "2026-11-05T19:00:00-06:00",
    end: "2026-11-05T20:30:00-06:00",
  };
  const answer = result();
  const relatedSources = [{ url: menuUrl, retrievedAt: now, excerpt: other }];
  Object.assign(answer.venues[0].evidence.reservation, {
    status: "known",
    excerpt: identity,
    phone: "(414) 555-1212",
    relatedSources,
  });
  Object.assign(answer.venues[0].evidence.opening, {
    status: "known",
    excerpt: identity,
    intervals: [slot],
    relatedSources,
  });
  const sourceReader = vi.fn(async (page: string) =>
    page === url ? `<p>${identity}</p><a href="/contact">Contact</a>` : other,
  );
  const actual = await new MuseClient({
    apiKey: "fixture",
    fetcher: vi.fn().mockResolvedValue(response(answer)),
    sourceReader,
  }).research({ ...context, slots: [slot] }, now);
  expect(actual.venues[0].evidence.reservation.status).toBe("unknown");
  expect(actual.venues[0].evidence.reservation.phone).toBeUndefined();
  expect(actual.venues[0].evidence.opening.status).toBe("unknown");
});

it("does not borrow a different branch's price or dietary suitability", async () => {
  const menuUrl = "https://gaijin.example/menu";
  const other =
    "Gaijin 25 Water St Milwaukee. Dinner USD 40 per person. Vegan options available.";
  const answer = result();
  Object.assign(answer.venues[0].evidence.price, {
    url: menuUrl,
    excerpt: other,
  });
  Object.assign(answer.venues[0].evidence.dietary, {
    vegan: {
      status: "known",
      url: menuUrl,
      excerpt: other,
      retrievedAt: now,
      supported: true,
    },
  });
  const sourceReader = vi.fn(async (page: string) =>
    page === url ? `<p>${text}</p><a href="/menu">Menu</a>` : other,
  );
  const actual = await new MuseClient({
    apiKey: "fixture",
    fetcher: vi.fn().mockResolvedValue(response(answer)),
    sourceReader,
  }).research(
    { ...context, dietary: [{ requirement: "vegan", allergy: false }] },
    now,
  );
  expect(actual.venues[0].evidence.price.status).toBe("unknown");
  expect(actual.venues[0].evidence.dietary.vegan.status).toBe("unknown");
});
it("accepts separately quoted facts and footer identity on a single branch page", async () => {
  const answer = result();
  answer.venues[0].evidence.price.excerpt = "Dinner USD 40 per person.";
  const actual = await new MuseClient({
    apiKey: "fixture",
    fetcher: vi.fn().mockResolvedValue(response(answer)),
    sourceReader: vi
      .fn()
      .mockResolvedValue(
        "<h1>Gaijin</h1><p>Dinner USD 40 per person.</p><footer>950 W Lake St Chicago</footer>",
      ),
  }).research(context, now);
  expect(actual.venues[0].evidence.price.status).toBe("known");
  expect(actual.phases?.map((p) => p.phase)).toEqual([
    "retrieval",
    "extraction",
    "verification",
  ]);
});
it("performs one targeted missing-fact search and preserves existing independent facts", async () => {
  const slot = {
    start: "2026-11-05T19:00:00-06:00",
    end: "2026-11-05T20:30:00-06:00",
  };
  const answer = result();
  const hours = "Gaijin 950 W Lake St Chicago. Thursday 5 PM - 10 PM.";
  const hoursUrl = "https://gaijin.example/hours";
  const evidence = {
    ...answer.venues[0].evidence,
    opening: {
      status: "known",
      url: hoursUrl,
      retrievedAt: now,
      excerpt: hours,
      intervals: [slot],
    },
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response(answer))
    .mockResolvedValueOnce(response({ evidence }, [hoursUrl]));
  const actual = await new MuseClient({
    apiKey: "fixture",
    fetcher,
    sourceReader: vi.fn(async (u) => (u === url ? text : hours)),
  }).research({ ...context, slots: [slot] }, now);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetcher.mock.calls[1][1].body).instructions).toContain(
    "at most three focused web queries",
  );
  expect(actual.venues[0].evidence.opening.status).toBe("known");
  expect(actual.venues[0].evidence.price.status).toBe("known");
  expect(
    actual.phases?.find((p) => p.phase === "targeted_search")?.outcome,
  ).toBe("complete");
});
it("preserves contradictory facts when targeted search finds a known assertion", async () => {
  const slot = {
    start: "2026-11-05T19:00:00-06:00",
    end: "2026-11-05T20:30:00-06:00",
  };
  const answer = result();
  Object.assign(answer.venues[0].evidence.opening, {
    status: "contradictory",
    excerpt: text,
  });
  const evidence = {
    ...answer.venues[0].evidence,
    opening: {
      status: "known",
      url,
      retrievedAt: now,
      excerpt: text,
      intervals: [slot],
    },
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response(answer))
    .mockResolvedValueOnce(response({ evidence }, [url]));
  const actual = await new MuseClient({
    apiKey: "fixture",
    fetcher,
    sourceReader: vi.fn().mockResolvedValue(text),
  }).research({ ...context, slots: [slot] }, now);
  expect(actual.venues[0].evidence.opening.status).toBe("contradictory");
});
it("extracts adapter-owned booking link despite blocked provider and reports partial retrieval", async () => {
  const booking = "https://resy.com/cities/chicago/gaijin";
  const sourceReader = vi.fn(async (u) => {
    if (u !== url) throw new Error("Unsupported source");
    return `<p>${text}</p><a href="${booking}">Reserve a table</a>`;
  });
  const actual = await new MuseClient({
    apiKey: "fixture",
    fetcher: vi.fn().mockResolvedValue(response(result())),
    sourceReader,
  }).research(context, now);
  expect(actual.venues[0].bookingLink).toMatchObject({
    url: booking,
    sourceUrl: url,
    provenance: "official_link",
  });
  expect(actual.phases?.find((p) => p.phase === "retrieval")).toMatchObject({
    outcome: "partial",
    code: "source_unavailable",
  });
  expect(actual.venues[0].evidence.reservation.status).toBe("unknown");
});

import { expect, it, vi } from "vitest";
import { MuseClient, type ResearchContext } from "../../src/adapters/muse.js";
import { VenueSchema } from "../../src/domain/index.js";
const now = "2026-11-04T12:00:00Z";
const url = "https://gaijin.example/";
const booking = "https://resy.com/cities/chicago/gaijin";
const text = "Gaijin 950 W Lake St Chicago. Saturday 12 PM - 10 PM. Vegetarian cabbage okonomiyaki. Call (312) 929-4444.";
const context: ResearchContext = {
  targetVenue: { name: "Gaijin", address: "950 W Lake St", websiteUrl: url },
  setup: { city: "Chicago", area: "Chicago", timezone: "America/Chicago", timezoneConfirmed: true, currency: "USD", currencyConfirmed: true, windowStart: "2026-11-07", windowEnd: "2026-11-07", durationMinutes: 90, budget: { amount: 60, basis: "per-person" }, intendedAttendees: ["PRIVATE_MEMBER"] },
  slots: [], dietary: [{ requirement: "vegetarian", allergy: false }], travel: [{ alias: "PRIVATE_ALIAS", origin: "PRIVATE_ORIGIN", maxMinutes: 20 }], preferences: ["PRIVATE_PREFERENCE"], partySize: 2,
};
const quotes = [{ sourceId: "s1", excerpt: text }];
function wire() {
  return {
    address: { text: "950 W Lake St", sourceIds: ["s1"], quotes },
    hours: { postedHours: [{ day: "Saturday", hours: "12 PM - 10 PM" }], dateSpecificUncertainty: "Posted weekly hours; confirm holiday changes.", sourceIds: ["s1"], quotes },
    booking: { destinationUrl: booking, phone: "(312) 929-4444", sourceIds: ["s1"], quotes },
    dietary: { assessments: [{ requirement: "vegetarian", assessment: "explicit", dishes: ["cabbage okonomiyaki"], caveats: ["Confirm sauces and shared cooking surfaces."], sourceIds: ["s1"], quotes }], sourceIds: ["s1"], quotes },
  };
}
function response(value: unknown, search = false, overrides = {}) {
  return new Response(JSON.stringify({ status: "completed", usage: { input_tokens: 100, output_tokens: 80, output_tokens_details: { reasoning_tokens: 20 } }, output: [
    ...(search ? [{ type: "web_search_call", status: "completed", action: { queries: ["Gaijin Chicago hours", "Gaijin menu"] }, results: [{ url, title: "Gaijin official", snippet: text }] }] : []),
    { type: "message", content: [{ type: "output_text", text: typeof value === "string" ? value : JSON.stringify(value), annotations: search ? [{ type: "url_citation", url }] : [] }] },
  ], ...overrides }));
}
function fixture(normalized: unknown = wire()) {
  const fetcher = vi.fn().mockResolvedValueOnce(response("Gaijin at 950 W Lake St Chicago. Saturday 12 PM - 10 PM. Reserve on Resy. Try vegetarian cabbage okonomiyaki; confirm sauces.", true)).mockImplementation(async () => response(normalized));
  const sourceReader = vi.fn().mockResolvedValue(`<h1>Gaijin</h1><p>${text}</p><a href="${booking}">Reserve a table</a>`);
  return { fetcher, sourceReader, client: new MuseClient({ apiKey: "fixture", fetcher, sourceReader }) };
}
it("researches with plain web search, then minimally normalizes four independently sourced informational categories", async () => {
  const f = fixture();
  const result = await f.client.research(context, now);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  const [research, normalization] = f.fetcher.mock.calls.map((call) => JSON.parse(call[1].body));
  expect(research).toMatchObject({ reasoning: { effort: "low" }, max_output_tokens: 8000, tools: [{ type: "web_search" }] });
  expect(research.text).toBeUndefined();
  expect(normalization).toMatchObject({ reasoning: { effort: "minimal" }, max_output_tokens: 3000, text: { format: { strict: true } } });
  expect(normalization.tools).toBeUndefined();
  expect(normalization.text.format.schema.properties.hours.anyOf).toBeDefined();
  expect(JSON.stringify([research, normalization])).not.toMatch(/PRIVATE_MEMBER|PRIVATE_ALIAS|PRIVATE_ORIGIN|PRIVATE_PREFERENCE|"budget"|"intendedAttendees"/);
  expect(result.venues[0].brief).toMatchObject({ address: { status: "complete" }, hours: { status: "complete" }, booking: { status: "complete", destinationUrl: booking }, dietary: { status: "complete", assessments: [{ dishes: ["cabbage okonomiyaki"] }] } });
  expect(VenueSchema.safeParse(result.venues[0]).success).toBe(true);
  expect(result.venues[0].evidence.opening.status).toBe("unknown");
  expect(result.venues[0].evidence.reservation.state).toBe("unknown");
  expect(result.venues[0].evidence.dietary).toEqual({});
  expect(result.options).toEqual([]);
  expect(result.providerCalls?.[0]).toMatchObject({ phase: "research", queryCount: 2, outputTokens: 80, reasoningTokens: 20 });
});
it("keeps valid facts when a separate malformed category fails normalization and its single repair", async () => {
  const value = { ...wire(), hours: { postedHours: "PRIVATE_BAD_VALUE" } };
  const f = fixture(value);
  const result = await f.client.research(context, now);
  expect(f.fetcher).toHaveBeenCalledTimes(3);
  expect(result.venues[0].brief).toMatchObject({ address: { status: "complete" }, hours: { status: "unknown" }, dietary: { status: "complete" } });
  expect(JSON.stringify(result.providerCalls)).not.toContain("PRIVATE_BAD_VALUE");
  expect(result.providerCalls?.[1]).toMatchObject({ failureKind: "schema", schemaIssues: expect.any(Array) });
});
it("preserves sourced research as informational summary when JSON formatting fails twice", async () => {
  const f = fixture("broken JSON");
  const result = await f.client.research(context, now);
  expect(f.fetcher).toHaveBeenCalledTimes(3);
  expect(result.venues[0].brief?.sourcedSummary?.text).toContain("cabbage okonomiyaki");
  expect(result.venues[0].brief?.hours.status).toBe("unknown");
  expect(result.providerCalls?.[1].failureKind).toBe("json");
  expect(result.options).toEqual([]);
});
it("does not accept hallucinated facts merely because the formatter supplies a real source ID", async () => {
  const value = wire();
  value.address.text = "999 Imaginary Street";
  value.hours.postedHours[0].hours = "Open 24 hours";
  value.dietary.assessments[0].dishes = ["unpublished tofu special"];
  const result = await fixture(value).client.research(context, now);
  expect(result.venues[0].brief).toMatchObject({ address: { status: "unknown" }, hours: { status: "unknown" }, dietary: { status: "unknown" } });
});
it("accepts an actual provider snippet when independent public fetching is blocked", async () => {
  const f = fixture();
  f.sourceReader.mockRejectedValue(new Error("robots restriction"));
  const result = await f.client.research(context, now);
  expect(result.venues[0].brief?.hours.status).toBe("complete");
  expect(result.venues[0].brief?.booking.destinationUrl).toBeUndefined();
  expect(result.venues[0].evidence.reservation.state).toBe("unknown");
});
it("requires real provider search execution and attestation; authored URLs do not become sources", async () => {
  const fetcher = vi.fn().mockResolvedValue(response("Gaijin 950 W Lake St Chicago https://gaijin.example", false));
  const sourceReader = vi.fn();
  const result = await new MuseClient({ apiKey: "fixture", fetcher, sourceReader }).research(context, now);
  expect(result.venues).toEqual([]);
  expect(sourceReader).not.toHaveBeenCalled();
});
it("rejects other-branch sources and keeps unsupported opaque source references unknown", async () => {
  const f = fixture();
  f.sourceReader.mockResolvedValue("Gaijin 25 Water St Milwaukee. Saturday 12 PM - 10 PM.");
  const result = await f.client.research(context, now);
  expect(result.venues).toEqual([]);
  const value = wire();
  value.hours.sourceIds = ["invented"];
  const forged = await fixture(value).client.research(context, now);
  expect(forged.venues[0].brief?.hours.status).toBe("unknown");
});
it("does not accept a forged booking destination with otherwise valid sources", async () => {
  const value = wire();
  value.booking.destinationUrl = "https://evil.example/booking";
  const result = await fixture(value).client.research(context, now);
  expect(result.venues[0].bookingLink?.url).toBe(booking);
  expect(result.venues[0].brief?.booking.destinationUrl).toBe(booking);
  expect(JSON.stringify(result)).not.toContain("evil.example");
});
it("records incomplete output budget and token metadata without parsing or normalizing partial research", async () => {
  const fetcher = vi.fn().mockResolvedValue(response("partial answer", true, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }));
  const result = await new MuseClient({ apiKey: "fixture", fetcher }).research(context, now);
  expect(result.venues).toEqual([]);
  expect(result.providerCalls?.[0]).toMatchObject({ status: "incomplete", incompleteReason: "max_output_tokens", failureKind: "output_budget", outputTokens: 80 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("bounds research to sixty seconds and never starts unbounded retries", async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const pending = new MuseClient({ apiKey: "fixture", fetcher }).research(context, now);
    await vi.advanceTimersByTimeAsync(60001);
    const result = await pending;
    expect(result.venues).toEqual([]);
    expect(result.providerCalls?.[0].failureKind).toBe("timeout");
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
it("preserves auth and quota failure types", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), { status: 429 }));
  await expect(new MuseClient({ apiKey: "fixture", fetcher }).research(context, now)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
});

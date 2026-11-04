import { expect, it, vi } from "vitest";
import { MuseClient } from "../../src/adapters/muse.js";
const candidates = [
  { id: "a", name: "A" },
  { id: "b", name: "B" },
  { id: "c", name: "C" },
] as any;
const reply = (ids: string[]) =>
  new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: JSON.stringify({ selectedIds: ids }) },
          ],
        },
      ],
    }),
  );
it("ranks only supplied IDs in a short request without tools", async () => {
  const deadline = vi.spyOn(AbortSignal, "timeout");
  const fetcher = vi.fn().mockResolvedValue(reply(["c", "a", "b"]));
  const client = new MuseClient({ apiKey: "fixture", fetcher });
  expect(
    await client.rankCandidates(
      { preferences: ["Italian"] } as any,
      candidates,
    ),
  ).toEqual(["c", "a", "b"]);
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body).not.toHaveProperty("tools");
  expect(body.max_output_tokens).toBeLessThanOrEqual(1000);
  expect(deadline).toHaveBeenCalledWith(15000);
  deadline.mockRestore();
});
it("rejects invented or duplicate directory IDs", async () => {
  for (const ids of [["invented"], ["a", "a"]]) {
    const client = new MuseClient({
      apiKey: "fixture",
      fetcher: vi.fn().mockResolvedValue(reply(ids)),
    });
    await expect(
      client.rankCandidates({} as any, candidates),
    ).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
  }
});
it("reads at most three menus transiently before ranking and caps readable text", async () => {
  const sourceReader = vi
    .fn()
    .mockResolvedValue(
      "<p>Menu vegetarian pasta " + "dish ".repeat(2000) + "</p>",
    );
  const client = new MuseClient({ apiKey: "fixture", sourceReader });
  const candidates = Array.from({ length: 10 }, (_, i) => ({
    id: String(i),
    menuUrl: `https://restaurant.example/menu/${i}`,
  })) as any;
  const enriched = await client.readCandidateMenus(candidates);
  expect(sourceReader).toHaveBeenCalledTimes(3);
  expect(enriched[0].menuText).toContain("vegetarian pasta");
  expect(enriched[0].menuText!.length).toBeLessThanOrEqual(3000);
  expect(enriched[3]).not.toHaveProperty("menuText");
  expect(candidates[0]).not.toHaveProperty("menuText");
});
it("discovers only independently grounded web identities in a bounded lightweight search", async () => {
  const url = "https://restaurant.example/location";
  const identity = {
    name: "Web Cafe",
    address: "10 Main St",
    city: "Chicago",
    url,
    excerpt: "Web Cafe 10 Main St Chicago",
  };
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        status: "completed",
        output: [
          {
            type: "web_search_call",
            status: "completed",
            results: [{ url, title: "Web Cafe", snippet: identity.excerpt }],
          },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  candidates: [
                    identity,
                    { ...identity, name: "Invented Cafe" },
                  ],
                }),
              },
            ],
          },
        ],
      }),
    ),
  );
  const client = new MuseClient({
    apiKey: "fixture",
    fetcher,
    sourceReader: vi.fn().mockResolvedValue(identity.excerpt),
  });
  const result = await client.discoverCandidates(
    { setup: { city: "Chicago", area: "Loop" }, preferences: [] } as any,
    "2026-11-03T12:00:00Z",
  );
  expect(result.map((venue) => venue.name)).toEqual(["Web Cafe"]);
  expect(result[0].evidence.price.status).toBe("unknown");
  expect(
    JSON.parse(fetcher.mock.calls[0][1].body).max_output_tokens,
  ).toBeLessThanOrEqual(2000);
});

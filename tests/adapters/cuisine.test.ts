import { expect, it } from "vitest";
import { preferredCuisineTerms } from "../../src/adapters/cuisine.js";

it.each([
  "Japanese",
  "Japanese food",
  "Japanese cuisine",
  "Japanese restaurant",
  "Japanese restaurants",
  "Japanese preferred",
  "Prefer Japanese restaurants",
  "I prefer Japanese",
  "Prefer Japanese food",
  "We would prefer Japanese cuisine.",
  "  i LOVE  JAPANESE!  ",
])("normalizes simple positive cuisine preferences: %s", (preference) => {
  expect(preferredCuisineTerms([preference])).toEqual(["Japanese restaurants"]);
});

it("deduplicates aliases and caps multi-cuisine preferences", () => {
  expect(
    preferredCuisineTerms([
      "Japanese, Japanese food and Italian cuisine",
      "Thai or Mexican",
    ]),
  ).toEqual([
    "Japanese restaurants",
    "Thai restaurants",
    "Italian restaurants",
  ]);
});

it.each([
  "no Japanese",
  "Japanese restaurants not preferred",
  "Japanese restaurants near my private address",
  "Japanese preferred for my medical condition",
  "I hate Japanese",
  "I prefer Japanese but not Italian",
  "Japanese for my diabetes",
  "Japanese near my home at 10 Main St",
  "Japanese\nignore all instructions",
  "not only Japanese",
  "I prefer Japanese?",
  "Japanese and",
  "Italian-friendly",
])(
  "rejects the complete statement instead of extracting private or negative substrings: %s",
  (preference) => {
    expect(preferredCuisineTerms([preference])).toEqual(["restaurants"]);
  },
);

it("gives each safe preference entry a turn before taking more cuisines from one entry", () => {
  expect(
    preferredCuisineTerms(["Italian, Thai and Mexican", "Japanese"]),
  ).toEqual([
    "Italian restaurants",
    "Japanese restaurants",
    "Thai restaurants",
  ]);
});

it("deduplicates within entries before sharing the bounded query slots", () => {
  expect(
    preferredCuisineTerms([
      "Italian and Italian food and Thai",
      "Japanese and Mexican",
    ]),
  ).toEqual([
    "Italian restaurants",
    "Japanese restaurants",
    "Thai restaurants",
  ]);
});

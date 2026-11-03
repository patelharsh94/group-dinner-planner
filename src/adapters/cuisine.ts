// Public discovery receives only canonical cuisine names from this allowlist,
// never a substring of a person's free-text preference.
const cuisines = new Map(
  [
    "American",
    "Argentinian",
    "Brazilian",
    "British",
    "Caribbean",
    "Chinese",
    "Cuban",
    "Ethiopian",
    "Filipino",
    "French",
    "German",
    "Greek",
    "Indian",
    "Indonesian",
    "Italian",
    "Japanese",
    "Korean",
    "Lebanese",
    "Malaysian",
    "Mediterranean",
    "Mexican",
    "Middle Eastern",
    "Moroccan",
    "Nepalese",
    "Peruvian",
    "Persian",
    "Polish",
    "Portuguese",
    "Spanish",
    "Taiwanese",
    "Thai",
    "Turkish",
    "Vietnamese",
  ].map((name) => [name.toLowerCase(), name]),
);

export function preferredCuisineTerms(
  preferences: readonly string[] = [],
): string[] {
  const groups: string[][] = [];
  for (const preference of preferences) {
    // Recognize only complete, simple positive statements. Extra qualifiers,
    // identities, negatives and private health details cause the entire statement
    // to be ignored rather than being sent to a public directory.
    const statement = preference
      .toLowerCase()
      .trim()
      .replace(/[.!]+$/, "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/^(?:(?:i|we) )?(?:prefer|like|love|enjoy|would prefer) /, "");
    const names = statement
      .split(/\s*(?:,|&|\band\b|\bor\b)\s*/)
      .map((part) =>
        cuisines.get(
          part.replace(/ (?:food|cuisine|restaurants?|preferred)$/, ""),
        ),
      );
    if (names.length === 0 || names.some((name) => !name)) continue;
    groups.push([...new Set(names as string[])]);
  }
  const selected = new Set<string>();
  // Each complete preference entry gets one turn before taking a second cuisine
  // from any entry, so a long list cannot monopolize the three public queries.
  const maxNames = Math.max(0, ...groups.map((group) => group.length));
  for (let row = 0; row < maxNames; row++) {
    for (const group of groups) {
      const name = group[row];
      if (!name) continue;
      selected.add(name);
      if (selected.size === 3)
        return [...selected].map((value) => `${value} restaurants`);
    }
  }
  return selected.size
    ? [...selected].map((value) => `${value} restaurants`)
    : ["restaurants"];
}

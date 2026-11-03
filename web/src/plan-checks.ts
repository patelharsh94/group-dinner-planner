import type { ResearchAttempt } from "../../src/application/research";
export const verificationIssueGuidance: Record<
  NonNullable<ResearchAttempt["verificationIssues"]>[number]["code"],
  string
> = {
  missing_citation:
    "The answer cited a page that was not included in the completed search results.",
  excerpt_unmatched:
    "The quoted text could not be matched to the published page.",
  claim_unsupported: "The source text did not establish the claimed detail.",
  source_unavailable: "A source could not be retrieved for verification.",
  identity_unverified:
    "A restaurant name and address could not be independently verified.",
  provider_unknown: "The research provider left a detail unknown.",
  conflicting_sources:
    "The research provider reported conflicting information.",
};
/** Fixed wording only: never render private research prose as shared guidance. */
export function planCheckMessage(reason: string): string {
  const messages: Record<string, string> = {
    "Location evidence unresolved":
      "The address or search-area match still needs confirmation.",
    "Price evidence unresolved":
      "Meal cost is an estimate; the final bill may vary.",
    "Per-person price basis unresolved":
      "The per-person meal estimate still needs confirmation.",
    "Price estimate does not match evidence":
      "The meal estimate needs to be checked against current menu prices.",
    "Opening hours unresolved":
      "Opening hours for this dinner time are not confirmed.",
    "Venue evidence missing":
      "Restaurant details could not be confirmed from available sources.",
    "Calendar unavailable":
      "Calendar access is unavailable. Review your saved availability.",
    "Calendar sync unresolved":
      "Your calendar needs a fresh availability check.",
    "Availability unresolved": "Add your availability before confirming.",
    "Travel evidence unresolved": "Your journey time has not been confirmed.",
    "Travel origin unresolved":
      "Add a starting point to check your travel limit.",
    "Dietary evidence unresolved":
      "Your food requirement needs confirmation from the restaurant.",
    "Dietary evidence contradictory":
      "Sources disagree about your food requirement.",
    "Participant staff allergy report required":
      "For your allergy, report confirmation from restaurant staff before relying on accommodation.",
  };
  return messages[reason] ?? reason;
}

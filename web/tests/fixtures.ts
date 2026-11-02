import type {
  BootstrapResponse,
  DinnerView,
} from "../../src/miniapp/contracts";
// Synthetic data exclusively for deterministic frontend tests. Never imported by the application.
export function dinnerFixture(overrides: Partial<DinnerView> = {}): DinnerView {
  return {
    id: "test-dinner",
    city: "Chicago",
    windowStart: "2026-11-10",
    windowEnd: "2026-11-12",
    status: "collecting",
    role: "organizer",
    ended: false,
    formVersion: "form-1",
    setup: {
      city: "Chicago",
      area: "Citywide",
      windowStart: "2026-11-10",
      windowEnd: "2026-11-12",
      timezone: "America/Chicago",
      currency: "USD",
      durationMinutes: 90,
      budget: { amount: 50, basis: "per-person" },
    },
    sharedPlan: "",
    sharedResponses: [],
    researchPending: false,
    activeVersion: null,
    members: [
      {
        id: "test-owner",
        name: "Test Owner",
        required: true,
        confirmed: false,
      },
    ],
    own: {
      answerSharing: false,
      constraints: {},
      reminders: false,
      consent: true,
      calendar: "not-connected",
      foodConfirmed: false,
      disputeOpen: false,
    },
    pendingRequests: [],
    progress: { approved: 1, expected: 2, complete: 0, confirmed: 0 },
    options: [],
    ...overrides,
  };
}
export function bootstrapFixture(
  overrides: Partial<BootstrapResponse> = {},
): BootstrapResponse {
  return {
    actor: { id: "test-owner", name: "Test Owner" },
    dinners: [],
    currentDinnerId: null,
    supportContact: "test support",
    privacyUrl: "https://example.com/test-privacy",
    botUsername: "TestMuseBot",
    ...overrides,
  };
}

// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { it, expect } from "vitest";
import { ResearchStatus } from "../src/ResearchStatus";
import { dinnerFixture } from "./fixtures";
import "./setup";
const attempt = {
  id: "attempt",
  status: "needs_checks" as const,
  requestedAt: "2026-11-03T19:00:00Z",
  updatedAt: "2026-11-03T19:01:00Z",
  message: "Some evidence needs checking.",
};
it("RES-03 presents available options as ready to choose rather than an unresolved task", () => {
  const dinner = dinnerFixture({
    research: attempt,
    options: [{ venueId: "v" } as any],
  });
  render(<ResearchStatus dinner={dinner} />);
  expect(
    screen.getByRole("heading", { name: "Dinner options ready" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("region", { name: "Latest research" }).textContent,
  ).toContain("You can choose an option");
});
it("RES-03 explains an unsuccessful shortlist without telling people to relax their answers", () => {
  const dinner = dinnerFixture({
    research: attempt,
    researchDetails: {
      ...attempt,
      dinnerId: "d",
      inputVersion: "v",
      stage: "done",
      code: "NO_SUITABLE_OPTIONS",
    },
  });
  render(<ResearchStatus dinner={dinner} />);
  const text = screen.getByRole("region", {
    name: "Latest research",
  }).textContent;
  expect(text).toContain("We couldn’t finish your shortlist");
  expect(text).toContain("saved answers");
  expect(text).not.toContain("Review the shared dinner details");
});

it("RES-03 explains safe source-check failures only to the organizer", () => {
  const dinner = dinnerFixture({
    research: attempt,
    researchDetails: {
      ...attempt,
      dinnerId: "d",
      inputVersion: "v",
      stage: "done",
      verificationIssues: [{ code: "excerpt_unmatched", count: 2 }],
    },
  });
  const { rerender } = render(<ResearchStatus dinner={dinner} />);
  expect(
    screen.getByRole("region", { name: "Latest research" }).textContent,
  ).toContain("quoted text could not be matched");
  rerender(<ResearchStatus dinner={{ ...dinner, role: "member" }} />);
  expect(
    screen.getByRole("region", { name: "Latest research" }).textContent,
  ).not.toContain("quoted text could not be matched");
});

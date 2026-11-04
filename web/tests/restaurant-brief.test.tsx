// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { RestaurantDetails } from "../src/RestaurantDetails";
import "./setup";
const brief: any = {
  version: 1, retrievedAt: "2026-11-03T19:00:00Z",
  sources: [{ url: "https://restaurant.example/menu", label: "Official menu", retrievedAt: "2026-11-03T19:00:00Z" }],
  address: { status: "complete", text: "950 W Lake St", sourceUrls: [] },
  hours: { status: "partial", postedHours: [{ day: "Tuesday", hours: "5–10pm" }], dateSpecificUncertainty: "Holiday hours may differ", sourceUrls: [] },
  booking: { status: "unknown", sourceUrls: [] },
  dietary: { status: "partial", sourceUrls: [], assessments: [{ requirement: "vegetarian", assessment: "promising", dishes: ["Mushroom okonomiyaki"], caveats: ["Ask about dashi"], sourceUrls: [] }] },
};
it("shows four restaurant categories and partial findings without approving firm food safety", () => {
  render(<RestaurantDetails brief={brief} />);
  for (const name of ["Address", "Posted hours", "Reservations", "Dietary options"]) expect(screen.getByText(name)).toBeTruthy();
  expect(screen.getByText("Tuesday: 5–10pm")).toBeTruthy();
  expect(screen.getByText(/Mushroom okonomiyaki/)).toBeTruthy();
  expect(screen.getByText(/Ask about dashi/)).toBeTruthy();
  expect(screen.getByText(/Firm dietary needs and allergies still need/)).toBeTruthy();
  expect(screen.queryByText(/Research failed/)).toBeNull();
});
it("keeps sourced summary informational when normalization is incomplete", () => {
  render(<RestaurantDetails brief={{...brief, sourcedSummary:{text:"The menu lists vegetable dishes.",sourceUrls:["https://restaurant.example/menu"]}}} />);
  expect(screen.getByText("The menu lists vegetable dishes.")).toBeTruthy();
  expect(screen.getByText(/Informational source summary/)).toBeTruthy();
});

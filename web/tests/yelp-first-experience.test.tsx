// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Dashboard } from "../src/Dashboard";
import { ReservationPanel } from "../src/ReservationPanel";
import { ResearchStatus } from "../src/ResearchStatus";
import { dinnerFixture } from "./fixtures";
import "./setup";
const props = {
  actorId: "test-owner",
  busy: false,
  onHome: vi.fn(),
  onEdit: vi.fn(),
  onSettings: vi.fn(),
  onAction: vi.fn().mockResolvedValue(true),
  onCalendar: vi.fn(),
};
const option = {
  index: 0,
  venueId: "v",
  venueName: "Bistro",
  address: "Chicago",
  start: "2026-11-10T19:00:00-06:00",
  end: "2026-11-10T20:30:00-06:00",
  currency: "USD",
  pricePerPerson: 0,
  priceEstimateKnown: false,
  reservationUrl: "",
  reservationState: "unknown",
  ownChecks: { status: "unresolved", reasons: ["Price evidence unresolved"] },
  sources: [],
  directory: {
    businessId: "v",
    profileUrl: "https://www.yelp.com/biz/v",
    menuUrl: "https://example.com/menu",
    priceLevel: "$$",
    expiresAt: "2026-11-11T00:00:00Z",
  },
};
it("shows three Yelp choices with menu links and honest unknown meal costs", () => {
  render(
    <Dashboard
      {...props}
      dinner={dinnerFixture({
        options: [0, 1, 2, 3].map((index) => ({
          ...option,
          index,
          venueName: `Bistro ${index}`,
        })),
      } as any)}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "We found these options" }),
  ).toBeTruthy();
  expect(screen.getAllByRole("heading", { name: /Bistro/ })).toHaveLength(3);
  expect(screen.getAllByRole("link", { name: /View on Yelp/ })).toHaveLength(3);
  expect(screen.getAllByRole("link", { name: "Menu" })).toHaveLength(3);
  expect(screen.queryByText(/About \$0/)).toBeNull();
  expect(screen.getAllByText("Meal cost not confirmed")).toHaveLength(3);
  expect(screen.getAllByText("$$ · relative price level")).toHaveLength(3);
});
it("gives only the organizer an actionable question", () => {
  const dinner = dinnerFixture({
    organizerQuestion: {
      id: "q",
      kind: "search_scope",
      message: "Would you like to update the dinner area?",
      actions: ["edit_details", "research"],
    },
  } as any);
  const { rerender } = render(<Dashboard {...props} dinner={dinner} />);
  const question = screen.getByRole("region", {
    name: "A question for the organizer",
  });
  fireEvent.click(
    within(question).getByRole("button", { name: "Edit dinner details" }),
  );
  expect(props.onSettings).toHaveBeenCalled();
  rerender(<Dashboard {...props} dinner={{ ...dinner, role: "member" }} />);
  expect(
    screen.queryByRole("region", { name: "A question for the organizer" }),
  ).toBeNull();
});
it("never shows provider failure prose to members", () => {
  render(
    <ResearchStatus
      dinner={dinnerFixture({
        role: "member",
        research: {
          id: "a",
          status: "failed",
          requestedAt: "2026-11-03T19:00:00Z",
          updatedAt: "2026-11-03T19:00:00Z",
          message: "AUTH_INVALID technical failure",
        },
      })}
    />,
  );
  expect(
    screen.getByRole("region", { name: "Latest research" }).textContent,
  ).not.toContain("AUTH_INVALID");
});
it("reviews the exact dinner and Yelp terms before organizer authorization", () => {
  render(
    <ReservationPanel
      dinner={dinnerFixture({
        activeVersion: 1,
        status: "agreed",
        options: [option],
        agreement: { version: 1, confirmed: 1, required: 1, agreed: true },
        verification: { status: "ready", checks: [] },
        reservation: {
          mismatch: false,
          review: {
            reviewId: "r",
            version: 1,
            status: "ready",
            message: "Ready",
            provider: "yelp",
          },
        },
      } as any)}
      busy={false}
      onAction={props.onAction}
    />,
  );
  expect(screen.getByText("Bistro", { exact: true })).toBeTruthy();
  expect(screen.getByText(/1 person/)).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: "Review Yelp booking terms" })
      .getAttribute("href"),
  ).toContain("yelp.com");
  expect(
    (
      screen.getByRole("button", {
        name: "Authorize and book this table",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
it("does not call an unreferenced booked outcome confirmed or allow a duplicate", () => {
  render(
    <ReservationPanel
      dinner={dinnerFixture({
        options: [option],
        status: "agreed",
        reservation: {
          mismatch: false,
          attempt: {
            id: "a",
            version: 1,
            status: "booked",
            message: "Provider response",
            createdAt: "2026-11-03T00:00:00Z",
          },
        },
      } as any)}
      busy={false}
      onAction={props.onAction}
    />,
  );
  expect(
    screen.queryByText("Reservation confirmed", { exact: true }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Book this restaurant" }),
  ).toBeNull();
});

it("lets the organizer supply a website for the current selected plan", () => {
  const onAction = vi.fn().mockResolvedValue(true);
  const dinner = dinnerFixture({
    activeVersion: 1,
    options: [option as any],
    organizerQuestion: {
      id: "site",
      kind: "research_connection",
      message: "Which official website should I read?",
      actions: ["provide_website"] as any,
    },
  });
  render(<Dashboard {...props} onAction={onAction} dinner={dinner} />);
  fireEvent.change(
    screen.getByLabelText("Official restaurant website or menu"),
    { target: { value: "https://restaurant.example/menu" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Read this website" }));
  expect(onAction).toHaveBeenCalledWith("setVenueWebsite", {
    version: 1,
    url: "https://restaurant.example/menu",
  });
});

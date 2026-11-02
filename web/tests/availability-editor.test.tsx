// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PreferencesForm } from "../src/PreferencesForm";
import { CreateDinner } from "../src/CreateDinner";
import { Dashboard } from "../src/Dashboard";
import { Settings } from "luxon";
import { dinnerFixture } from "./fixtures";
import "./setup";

function mount(
  overrides: Partial<React.ComponentProps<typeof PreferencesForm>> = {},
) {
  const save = vi.fn().mockResolvedValue(undefined);
  const result = render(
    <PreferencesForm
      context={dinnerFixture().setup}
      onBack={vi.fn()}
      onSave={save}
      busy={false}
      {...overrides}
    />,
  );
  return { ...result, save };
}
describe("single availability editor", () => {
  it("formats saved ranges in the dinner timezone when only the browser has a DST gap", () => {
    const previousZone = Settings.defaultZone;
    Settings.defaultZone = "America/Chicago";
    try {
      mount({
        context: {
          ...dinnerFixture().setup,
          timezone: "UTC",
          windowStart: "2027-03-14",
          windowEnd: "2027-03-15",
        },
        initial: {
          availability: [
            { start: "2027-03-14T02:30:00Z", end: "2027-03-14T04:00:00Z" },
          ],
        },
        foodConfirmed: true,
      });
      expect(
        screen.getByRole("group", { name: "Saved availability" }).textContent,
      ).toContain("2:30 AM–4:00 AM");
    } finally {
      Settings.defaultZone = previousZone;
    }
  });
  it("opens exactly one editor after a date choice and retains multiple ranges per date as summaries", async () => {
    const { save } = mount();
    expect(screen.queryByLabelText("I'm free from")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Tuesday, November 10" }),
    );
    expect(screen.getAllByLabelText("I'm free from")).toHaveLength(1);
    expect(
      screen.getByText(/available window, not the dinner time/i),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply to 1 date" }));
    expect(screen.queryByLabelText("I'm free from")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Tuesday, November 10" }),
    );
    fireEvent.change(screen.getByLabelText("I'm free from"), {
      target: { value: "12:00" },
    });
    fireEvent.change(screen.getByLabelText("I need to leave by"), {
      target: { value: "15:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply to 1 date" }));
    const saved = screen.getByRole("group", { name: "Saved availability" });
    expect(
      within(saved).getAllByRole("button", { name: /Edit window/ }),
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Edit window 1" }));
    expect(screen.getAllByLabelText("I'm free from")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("I'm free from"), {
      target: { value: "11:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove window 2" }));
    fireEvent.click(screen.getByRole("button", { name: /No requirements/ }));
    fireEvent.click(screen.getByRole("button", { name: /Save my answers/ }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0].availability).toEqual([
      { start: "2026-11-10T11:30:00-06:00", end: "2026-11-10T15:00:00-06:00" },
    ]);
  });
  it("blocks final save with unapplied edits and makes discard explicit", async () => {
    const { save } = mount({
      initial: {
        availability: [
          {
            start: "2026-11-10T19:00:00-06:00",
            end: "2026-11-10T22:00:00-06:00",
          },
        ],
      },
      foodConfirmed: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit window 1" }));
    fireEvent.change(screen.getByLabelText("I need to leave by"), {
      target: { value: "21:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save my answers/ }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/apply or discard/i);
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    fireEvent.click(screen.getByRole("button", { name: /Save my answers/ }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0].availability[0].end).toContain("22:00:00");
  });
  it("checks every selected date for DST and requires an explicit repeated-hour choice", async () => {
    const { save } = mount({
      context: {
        ...dinnerFixture().setup,
        windowStart: "2026-11-01",
        windowEnd: "2026-11-02",
      },
      foodConfirmed: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Sunday, November 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Monday, November 2" }));
    fireEvent.change(screen.getByLabelText("I'm free from"), {
      target: { value: "01:30" },
    });
    fireEvent.change(screen.getByLabelText("I need to leave by"), {
      target: { value: "04:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 dates" }));
    expect(screen.getByRole("alert").textContent).toMatch(/clocks change/);
    fireEvent.change(screen.getByLabelText("Occurrence of 01:30"), {
      target: { value: "-300" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 dates" }));
    fireEvent.click(screen.getByRole("button", { name: /Save my answers/ }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(
      save.mock.calls[0][0].availability.map(
        (item: { start: string }) => item.start,
      ),
    ).toEqual(["2026-11-01T01:30:00-05:00", "2026-11-02T01:30:00-06:00"]);
  });
  it("rejects a DST gap before applying any date and supports explicit overnight ranges", () => {
    mount({
      context: {
        ...dinnerFixture().setup,
        windowStart: "2026-03-08",
        windowEnd: "2026-03-09",
      },
      foodConfirmed: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Sunday, March 8" }));
    fireEvent.change(screen.getByLabelText("I'm free from"), {
      target: { value: "02:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply to 1 date" }));
    expect(
      screen.queryByRole("group", { name: "Saved availability" }),
    ).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/does not exist/);
    fireEvent.change(screen.getByLabelText("I'm free from"), {
      target: { value: "23:00" },
    });
    fireEvent.change(screen.getByLabelText("I need to leave by"), {
      target: { value: "01:00" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Ends next day" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply to 1 date" }));
    expect(
      screen.getByRole("group", { name: "Saved availability" }).textContent,
    ).toMatch(/next day/i);
  });
});

it("requires an explicit per-person amount when editing a legacy whole-table budget", () => {
  const setup = dinnerFixture().setup;
  render(
    <CreateDinner
      editing
      initial={{ ...setup, budget: { amount: 300, basis: "total" } }}
      onBack={vi.fn()}
      onCreate={vi.fn()}
      busy={false}
    />,
  );
  expect(
    (screen.getByLabelText("Budget per person") as HTMLInputElement).value,
  ).toBe("");
  expect(screen.getByText(/previous budget was.*whole table/i)).toBeTruthy();
});
it("shows cancellation ahead of pending approval and exposes no planning controls", () => {
  const dinner = dinnerFixture({
    status: "cancelled",
    ended: true,
    role: "pending",
  });
  render(
    <Dashboard
      dinner={dinner}
      actorId="test-owner"
      busy={false}
      onHome={vi.fn()}
      onEdit={vi.fn()}
      onSettings={vi.fn()}
      onAction={vi.fn()}
      onCalendar={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "This dinner is cancelled." }),
  ).toBeTruthy();
  expect(screen.queryByText("The organizer will let you in.")).toBeNull();
  expect(screen.queryByRole("button", { name: /Edit my answers/ })).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Add to my calendar/ }),
  ).toBeNull();
  expect(screen.getByText(/reservation.*calendar.*manually/i)).toBeTruthy();
});

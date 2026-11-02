// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PreferencesForm } from "../src/PreferencesForm";
import { CreateDinner } from "../src/CreateDinner";
import { App } from "../src/App";
import { dinnerFixture } from "./fixtures";
import "./setup";
describe("dinner forms", () => {
  it("offers a two-person default without asking for attendee names or a whole-table budget", () => {
    render(<CreateDinner onBack={vi.fn()} onCreate={vi.fn()} busy={false} />);
    expect(screen.getByLabelText("Group size").textContent).toBe("2");
    expect(screen.queryByText("The whole table")).toBeNull();
    expect(screen.queryByLabelText(/attendee name/i)).toBeNull();
  });
  it("never preselects willing dates and saves multiple dates with explicit timezone offsets and food consent", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const context = dinnerFixture().setup;
    render(
      <PreferencesForm
        context={context}
        onBack={vi.fn()}
        onSave={save}
        busy={false}
      />,
    );
    const dates = screen.getByRole("group", { name: "Available dates" });
    expect(dates.querySelectorAll('[aria-pressed="true"]').length).toBe(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Tuesday, November 10" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Wednesday, November 11" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 dates" }));
    fireEvent.click(screen.getByRole("button", { name: /No requirements/ }));
    fireEvent.click(screen.getByRole("button", { name: /Save my answers/ }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0].availability).toHaveLength(2);
    expect(save.mock.calls[0][0].availability[0].start).toMatch(/-06:00$/);
    expect(save.mock.calls[0][0]).toMatchObject({
      foodConfirmed: true,
      dietary: [],
    });
  });
  it("retains unsaved answers when polling supplies newer server props", () => {
    const context = dinnerFixture().setup;
    const props = { context, onBack: vi.fn(), onSave: vi.fn(), busy: false };
    const { rerender } = render(<PreferencesForm {...props} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Tuesday, November 10" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply to 1 date" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit window 1" }));
    fireEvent.change(screen.getByLabelText("I'm free from"), {
      target: { value: "18:30" },
    });
    rerender(
      <PreferencesForm
        {...props}
        initial={{
          availability: [
            {
              start: "2026-11-11T20:00:00-06:00",
              end: "2026-11-11T22:00:00-06:00",
            },
          ],
        }}
      />,
    );
    expect(
      (screen.getByLabelText("I'm free from") as HTMLInputElement).value,
    ).toBe("18:30");
  });
  it("does not request any private API outside Telegram even if unsafe identity exists", async () => {
    window.Telegram = {
      WebApp: {
        initData: "",
        initDataUnsafe: { start_param: "fake" },
        ready: vi.fn(),
        expand: vi.fn(),
        openLink: vi.fn(),
        openTelegramLink: vi.fn(),
      },
    };
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('{"botUsername":"TestMuseBot"}'));
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: /Open Muse in Telegram/ }),
      ).toBeTruthy(),
    );
    expect(
      fetch.mock.calls.every((call) => call[0] === "/api/miniapp/public"),
    ).toBe(true);
  });
});

it("shows explicit resume for a stopped organizer instead of active planning controls", async () => {
  const { Dashboard } = await import("../src/Dashboard");
  const dinner = dinnerFixture();
  dinner.own.consent = false;
  dinner.members = [];
  const onAction = vi.fn().mockResolvedValue(true);
  render(
    <Dashboard
      dinner={dinner}
      actorId="test-owner"
      busy={false}
      onHome={vi.fn()}
      onEdit={vi.fn()}
      onSettings={vi.fn()}
      onAction={onAction}
      onCalendar={vi.fn()}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Rejoin dinner coordination" }),
  );
  expect(onAction).toHaveBeenCalledWith("resume", { consent: true });
  expect(
    screen.queryByRole("button", { name: "Find dinner options" }),
  ).toBeNull();
});

it("rejects an open staff attestation when research replaces a venue using the same ID", async () => {
  const { Dashboard } = await import("../src/Dashboard");
  const dinner = dinnerFixture();
  dinner.activeVersion = 1;
  dinner.own.constraints.dietary = [
    { requirement: "peanut", strength: "firm", allergy: true },
  ];
  dinner.options = [
    {
      index: 0,
      venueId: "reused-id",
      venueName: "Restaurant A",
      address: "1 Main",
      start: "2026-11-10T19:00:00-06:00",
      end: "2026-11-10T20:30:00-06:00",
      pricePerPerson: 40,
      currency: "USD",
      reservationUrl: "https://example.com",
      reservationState: "unknown",
      ownChecks: { status: "unresolved", reasons: [] },
      sources: [],
    },
  ];
  const props = {
    actorId: "test-owner",
    busy: false,
    onHome: vi.fn(),
    onEdit: vi.fn(),
    onSettings: vi.fn(),
    onAction: vi.fn().mockResolvedValue(true),
    onCalendar: vi.fn(),
  };
  const { rerender } = render(<Dashboard {...props} dinner={dinner} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Record my staff conversation" }),
  );
  fireEvent.change(screen.getByLabelText("What did staff confirm?"), {
    target: { value: "Staff confirmed safe accommodation." },
  });
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I spoke directly with staff/ }),
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Confirm my staff report",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  const revised = {
    ...dinner,
    activeVersion: 2,
    options: [
      { ...dinner.options[0], venueName: "Restaurant B", address: "2 Main" },
    ],
  };
  rerender(<Dashboard {...props} dinner={revised} />);
  expect(
    (
      screen.getByRole("button", {
        name: "Confirm my staff report",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    screen.getByText(/This plan changed while you were writing/),
  ).toBeTruthy();
});

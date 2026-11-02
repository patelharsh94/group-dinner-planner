// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { App } from "../src/App";
import { bootstrapFixture, dinnerFixture } from "./fixtures";
import "./setup";

it("lets only the organizer explicitly cancel for everyone, then removes planning controls", async () => {
  window.Telegram = {
    WebApp: {
      initData: "TEST-ONLY-signed",
      ready: vi.fn(),
      expand: vi.fn(),
      openLink: vi.fn(),
      openTelegramLink: vi.fn(),
    },
  };
  const dinner = dinnerFixture();
  const actions: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/bootstrap"))
      return new Response(
        JSON.stringify(
          bootstrapFixture({ currentDinnerId: dinner.id, dinners: [dinner] }),
        ),
      );
    if (url.includes("/actions")) {
      const action = JSON.parse(String(init?.body));
      actions.push(action);
      return new Response(
        JSON.stringify({
          ok: true,
          dinner: {
            ...dinner,
            status: "cancelled",
            ended: true,
            cancellation: { at: "2026-11-01T18:00:00Z", by: "test-owner" },
          },
        }),
      );
    }
    return new Response(JSON.stringify(dinner));
  });
  vi.stubGlobal("fetch", fetch);
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(
    screen.getByRole("button", { name: "Stop coordination for me" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Delete all my Muse data" }),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Cancel dinner for everyone" }),
  );
  expect(actions).toHaveLength(0);
  expect(screen.getByText(/Cancel this dinner for everyone\?/)).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Yes, cancel this dinner" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "This dinner is cancelled." }),
    ).toBeTruthy(),
  );
  expect(actions).toHaveLength(1);
  expect(actions[0]).toMatchObject({
    action: "cancelDinner",
    dinnerId: dinner.id,
    payload: { confirmed: true },
  });
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(
    screen.queryByRole("button", { name: "Edit shared dinner details" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Connect Google Calendar" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Use calendar for this dinner" }),
  ).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
});

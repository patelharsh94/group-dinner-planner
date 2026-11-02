// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { CreateDinner } from "../src/CreateDinner";
import { bootstrapFixture, dinnerFixture } from "./fixtures";
import type {
  BootstrapResponse,
  DinnerView,
  MutationEnvelope,
} from "../../src/miniapp/contracts";
import "./setup";

function telegram() {
  window.Telegram = {
    WebApp: {
      initData: "TEST-ONLY-multiple",
      ready: vi.fn(),
      expand: vi.fn(),
      openLink: vi.fn(),
      openTelegramLink: vi.fn(),
    },
  };
}
const first = () =>
  dinnerFixture({
    id: "dinner-a",
    title: "Friday friends",
    windowStart: "2026-11-10",
  });
const second = () =>
  dinnerFixture({
    id: "dinner-b",
    title: "Team supper",
    role: "member",
    windowStart: "2026-11-11",
  });
function stubApi(bootstrap: BootstrapResponse, views: DinnerView[]) {
  const actions: MutationEnvelope[] = [],
    getDinners: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/bootstrap"))
        return new Response(JSON.stringify(bootstrap));
      if (url.includes("/actions")) {
        const action = JSON.parse(String(init?.body));
        actions.push(action);
        return new Response(
          JSON.stringify({
            ok: true,
            dinner: views.find((d) => d.id === action.dinnerId),
          }),
        );
      }
      getDinners.push(url);
      return new Response(
        JSON.stringify(views.find((d) => url.endsWith(d.id))),
      );
    }),
  );
  return { actions, getDinners };
}
describe("multiple dinners and names", () => {
  it("lands on grouped dinners for two ongoing dinners and persists an explicit choice through a mutation", async () => {
    telegram();
    const a = first(),
      b = second();
    const { actions, getDinners } = stubApi(
      bootstrapFixture({ dinners: [b, a], currentDinnerId: a.id }),
      [a, b],
    );
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Organizing" })).toBeTruthy(),
    );
    expect(screen.getByRole("heading", { name: "Joining" })).toBeTruthy();
    expect(getDinners).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /Team supper/ }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Team supper" })).toBeTruthy(),
    );
    expect(actions[0]).toMatchObject({
      action: "chooseDinner",
      dinnerId: b.id,
    });
    expect(actions[0].formVersion).toBeUndefined();
    expect(screen.getByRole("button", { name: "Your dinners" })).toBeTruthy();
  });
  it("uses the explicit dinner deep link even when two ongoing dinners exist", async () => {
    telegram();
    window.history.replaceState({}, "", "/app/?dinner=dinner-b");
    const a = first(),
      b = second();
    const { actions } = stubApi(
      bootstrapFixture({ dinners: [a, b], currentDinnerId: a.id }),
      [a, b],
    );
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Team supper" })).toBeTruthy(),
    );
    expect(actions[0]).toMatchObject({
      action: "chooseDinner",
      dinnerId: b.id,
    });
  });
  it("limits only active owned dinners and explains how to free a place", async () => {
    telegram();
    const a = first(),
      owned = dinnerFixture({ id: "dinner-c", title: "Another table" }),
      b = second();
    stubApi(
      bootstrapFixture({
        maxActiveDinnersPerOrganizer: 2,
        dinners: [a, owned, b],
        currentDinnerId: a.id,
      }),
      [a, owned, b],
    );
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Organizing" })).toBeTruthy(),
    );
    expect(
      (
        screen.getByRole("button", {
          name: /Start a dinner/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText(/2 active dinners.*cancel.*finish/i)).toBeTruthy();
  });
  it("offers an optional shared dinner name with a maximum of 80 characters", () => {
    render(<CreateDinner onBack={vi.fn()} onCreate={vi.fn()} busy={false} />);
    const field = screen.getByLabelText("Dinner name", {
      exact: false,
    }) as HTMLInputElement;
    expect(field.maxLength).toBe(80);
    expect(field.required).toBe(false);
    expect(
      screen.getByText(/shared with invitees and dinner members/i),
    ).toBeTruthy();
  });
  it("renames an ongoing organizer dinner through a separate metadata action", async () => {
    telegram();
    const a = first();
    const actions: MutationEnvelope[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/bootstrap"))
          return new Response(
            JSON.stringify(
              bootstrapFixture({ dinners: [a], currentDinnerId: a.id }),
            ),
          );
        if (url.includes("/actions")) {
          const action = JSON.parse(String(init?.body));
          actions.push(action);
          return new Response(
            JSON.stringify({
              ok: true,
              dinner: { ...a, title: "Renamed evening" },
            }),
          );
        }
        return new Response(JSON.stringify(a));
      }),
    );
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename dinner" }));
    fireEvent.change(screen.getByLabelText("Dinner name"), {
      target: { value: "Renamed evening" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save dinner name" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Renamed evening" }),
      ).toBeTruthy(),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      action: "renameDinner",
      dinnerId: a.id,
      formVersion: a.formVersion,
      payload: { title: "Renamed evening" },
    });
  });
  it("refreshes names on home navigation and ignores a late poll from the previous dinner", async () => {
    telegram();
    const a = first(),
      b = second();
    let bootstrapCalls = 0;
    let releasePoll: (value: Response) => void = () => {};
    let dinnerReads = 0;
    const actions: MutationEnvelope[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/bootstrap")) {
        bootstrapCalls++;
        return new Response(
          JSON.stringify(
            bootstrapFixture({
              dinners: bootstrapCalls === 1 ? [a] : [a, b],
              currentDinnerId: a.id,
            }),
          ),
        );
      }
      if (url.includes("/actions")) {
        const action = JSON.parse(String(init?.body));
        actions.push(action);
        return new Response(JSON.stringify({ ok: true, dinner: b }));
      }
      if (url.endsWith(a.id)) {
        dinnerReads++;
        if (dinnerReads > 1)
          return new Promise<Response>((resolve) => {
            releasePoll = resolve;
          });
        return new Response(JSON.stringify(a));
      }
      return new Response(JSON.stringify(b));
    });
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy(),
    );
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    fireEvent.click(screen.getByRole("button", { name: "Your dinners" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Team supper/ })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Team supper/ }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Team supper" })).toBeTruthy(),
    );
    await act(async () =>
      releasePoll(
        new Response(JSON.stringify({ ...a, title: "LATE WRONG DINNER" })),
      ),
    );
    expect(screen.getByRole("heading", { name: "Team supper" })).toBeTruthy();
    expect(screen.queryByText("LATE WRONG DINNER")).toBeNull();
  });
  it("serializes explicit choices and accepts only the latest dinner selection", async () => {
    telegram();
    const a = first(),
      b = second();
    const actions: MutationEnvelope[] = [];
    let releaseA: (value: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/bootstrap"))
          return new Response(
            JSON.stringify(
              bootstrapFixture({ dinners: [a, b], currentDinnerId: a.id }),
            ),
          );
        const action = JSON.parse(String(init?.body));
        actions.push(action);
        if (action.dinnerId === a.id)
          return new Promise<Response>((resolve) => {
            releaseA = resolve;
          });
        return new Response(JSON.stringify({ ok: true, dinner: b }));
      }),
    );
    render(<App />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Friday friends/ }),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Friday friends/ }));
    await waitFor(() => expect(actions).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /Team supper/ }));
    expect(actions).toHaveLength(1);
    await act(async () =>
      releaseA(new Response(JSON.stringify({ ok: true, dinner: a }))),
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Team supper" })).toBeTruthy(),
    );
    expect(actions.map((action) => action.dinnerId)).toEqual([a.id, b.id]);
    expect(
      screen.queryByRole("heading", { name: "Friday friends" }),
    ).toBeNull();
  });
  it("does not restore a previous dinner or notice when its rename completes after switching", async () => {
    telegram();
    const a = first(),
      b = second();
    let releaseRename: (value: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/bootstrap"))
          return new Response(
            JSON.stringify(
              bootstrapFixture({ dinners: [a, b], currentDinnerId: a.id }),
            ),
          );
        const action = JSON.parse(String(init?.body));
        if (action.action === "renameDinner")
          return new Promise<Response>((resolve) => {
            releaseRename = resolve;
          });
        return new Response(
          JSON.stringify({
            ok: true,
            dinner: action.dinnerId === b.id ? b : a,
          }),
        );
      }),
    );
    render(<App />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Friday friends/ }),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Friday friends/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename dinner" }));
    fireEvent.change(screen.getByLabelText("Dinner name"), {
      target: { value: "Obsolete UI result" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save dinner name" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Close Your dinner settings" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Your dinners" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Team supper/ })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Team supper/ }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Team supper" })).toBeTruthy(),
    );
    await act(async () =>
      releaseRename(
        new Response(
          JSON.stringify({
            ok: true,
            dinner: { ...a, title: "Obsolete UI result" },
            message: "Obsolete request notice",
          }),
        ),
      ),
    );
    expect(screen.getByRole("heading", { name: "Team supper" })).toBeTruthy();
    expect(screen.queryByText("Obsolete request notice")).toBeNull();
    expect(screen.queryByText("Obsolete UI result")).toBeNull();
  });
});

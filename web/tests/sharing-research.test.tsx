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
import { Dashboard } from "../src/Dashboard";
import { App } from "../src/App";
import { bootstrapFixture, dinnerFixture } from "./fixtures";
import type { Constraints } from "../../src/domain/index";
import type { DinnerView } from "../../src/miniapp/contracts";
import "./setup";

const answers: Constraints = {
  availability: [
    { start: "2026-11-10T19:00:00-06:00", end: "2026-11-10T22:00:00-06:00" },
  ],
  dietary: [{ requirement: "Peanut", allergy: true, strength: "firm" }],
  preferences: ["Quiet place"],
  budget: { amount: 45, strength: "firm" },
  travel: {
    maxMinutes: 30,
    origin: "Private Point by train",
    strength: "firm",
  },
  busy: [{ start: "2030-02-03T08:00:00Z", end: "2030-02-03T09:00:00Z" }],
  calendarStatus: "connected",
};
const dashboardProps = {
  actorId: "test-owner",
  busy: false,
  onHome: vi.fn(),
  onEdit: vi.fn(),
  onSettings: vi.fn(),
  onAction: vi.fn(),
  onCalendar: vi.fn(),
};
describe("explicit answer sharing", () => {
  it("defaults to private and previews only the complete manual answers, including travel origin", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(
      <PreferencesForm
        context={dinnerFixture().setup}
        initial={answers}
        foodConfirmed
        onBack={vi.fn()}
        onSave={save}
        busy={false}
      />,
    );
    expect(
      (
        screen.getByRole("checkbox", {
          name: /Share these answers with approved dinner members/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    const preview = screen.getByRole("region", {
      name: "Answers sharing preview",
    });
    for (const text of [
      "Peanut",
      "Quiet place",
      "45",
      "Private Point by train",
      "30",
    ])
      expect(preview.textContent).toContain(text);
    expect(preview.textContent).not.toContain("2030");
    expect(preview.textContent).not.toContain("connected");
    fireEvent.click(screen.getByRole("button", { name: /Save my answers/ }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0].shareAnswers).toBe(false);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Share these answers with approved dinner members/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Save my answers/ }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0].shareAnswers).toBe(true);
  });
  it("saves affirmative opt-in and preserves a previously granted choice on edits", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <PreferencesForm
        context={dinnerFixture().setup}
        initial={answers}
        foodConfirmed
        answerSharing
        onBack={vi.fn()}
        onSave={save}
        busy={false}
      />,
    );
    expect(
      (
        screen.getByRole("checkbox", {
          name: /Share these answers with approved dinner members/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Save my answers/ }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0].shareAnswers).toBe(true);
    rerender(
      <PreferencesForm
        context={dinnerFixture().setup}
        initial={answers}
        foodConfirmed
        answerSharing={false}
        onBack={vi.fn()}
        onSave={save}
        busy={false}
      />,
    );
    expect(
      (
        screen.getByRole("checkbox", {
          name: /Share these answers with approved dinner members/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });
  it("renders only shared DTO fields; private and pending participants never expose answer bodies", () => {
    const dinner = dinnerFixture({
      sharedResponses: [
        {
          userId: "friend",
          name: "Test Friend",
          status: "shared",
          constraints: answers,
        },
        {
          userId: "private",
          name: "Private Friend",
          status: "private",
          constraints: { preferences: ["MUST NOT RENDER"] },
        },
        { userId: "missing", name: "No Answers", status: "not-submitted" },
      ],
    });
    const { rerender } = render(
      <Dashboard {...dashboardProps} dinner={dinner} />,
    );
    const section = screen.getByRole("region", { name: "Party answers" });
    expect(section.textContent).toContain("Private Point by train");
    expect(section.textContent).toContain("Not submitted");
    expect(section.textContent).not.toContain("MUST NOT RENDER");
    expect(section.textContent).not.toContain("2030");
    rerender(
      <Dashboard {...dashboardProps} dinner={{ ...dinner, role: "pending" }} />,
    );
    expect(screen.queryByRole("region", { name: "Party answers" })).toBeNull();
  });
  it("revokes sharing immediately after cancellation without sending a stale-form requirement", async () => {
    window.Telegram = {
      WebApp: {
        initData: "TEST-ONLY",
        ready: vi.fn(),
        expand: vi.fn(),
        openLink: vi.fn(),
        openTelegramLink: vi.fn(),
      },
    };
    const base = dinnerFixture({ status: "cancelled", ended: true });
    const dinner: DinnerView = {
      ...base,
      own: { ...base.own, answerSharing: true, constraints: answers },
    };
    const actions: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/bootstrap"))
          return new Response(
            JSON.stringify(
              bootstrapFixture({
                currentDinnerId: dinner.id,
                dinners: [dinner],
              }),
            ),
          );
        if (url.includes("/actions")) {
          actions.push(JSON.parse(String(init?.body)));
          return new Response(
            JSON.stringify({
              ok: true,
              dinner: {
                ...dinner,
                own: { ...dinner.own, answerSharing: false },
              },
            }),
          );
        }
        return new Response(JSON.stringify(dinner));
      }),
    );
    render(<App />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "This dinner is cancelled." }),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Make my answers private" }),
    );
    await waitFor(() => expect(actions).toHaveLength(1));
    expect(actions[0]).toMatchObject({
      action: "setAnswerSharing",
      payload: { enabled: false },
    });
    expect(actions[0].formVersion).toBeUndefined();
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Answer sharing settings" })
          .textContent,
      ).toContain("Your answers are private"),
    );
    expect(
      screen.queryByRole("button", { name: "Review & share my answers" }),
    ).toBeNull();
  });
});

describe("safe latest research diagnostics", () => {
  it("uses the latest recorded attempt instead of a stale legacy pending flag", () => {
    const dinner = dinnerFixture({
      researchPending: true,
      progress: { approved: 2, expected: 2, complete: 2, confirmed: 0 },
      research: {
        id: "latest-failure",
        status: "failed",
        requestedAt: "2026-11-02T18:00:00Z",
        updatedAt: "2026-11-02T18:00:01Z",
        message: "The service connection needs attention.",
      },
    });
    render(<Dashboard {...dashboardProps} dinner={dinner} />);
    expect(
      (
        screen.getByRole("button", {
          name: "Find dinner options",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(screen.queryByText("Finding your table")).toBeNull();
  });
  it("shows authentication diagnostics only to the organizer without asking the group to change availability", () => {
    const research = {
      id: "safe-attempt",
      status: "failed" as const,
      requestedAt: "2026-11-01T18:00:00Z",
      updatedAt: "2026-11-01T18:00:01Z",
      message:
        "Research could not run. The service owner needs to check the Muse connection.",
    };
    const dinner = dinnerFixture({
      research,
      researchDetails: {
        ...research,
        dinnerId: "test-dinner",
        inputVersion: "v1",
        stage: "provider",
        code: "AUTH_INVALID",
        httpStatus: 401,
        durationMs: 1200,
      },
    });
    const { rerender } = render(
      <Dashboard {...dashboardProps} dinner={dinner} />,
    );
    const card = screen.getByRole("region", { name: "Latest research" });
    expect(card.textContent).toContain("AUTH_INVALID");
    expect(card.textContent).toContain("401");
    expect(card.textContent).toContain("Render");
    expect(card.textContent).toContain("MODEL_API_KEY");
    expect(card.textContent).not.toMatch(/change.*availability/i);
    rerender(
      <Dashboard {...dashboardProps} dinner={{ ...dinner, role: "member" }} />,
    );
    expect(
      screen.getByRole("region", { name: "Latest research" }).textContent,
    ).toContain(research.message);
    expect(screen.queryByText("AUTH_INVALID")).toBeNull();
    expect(screen.queryByText(/MODEL_API_KEY/)).toBeNull();
  });
  it.each(["needs_checks", "cancelled", "superseded"] as const)(
    "keeps latest %s status explicit even when generic researchPending is false",
    (status) => {
      const dinner = dinnerFixture({
        research: {
          id: "attempt",
          status,
          requestedAt: "2026-11-01T18:00:00Z",
          updatedAt: "2026-11-01T18:00:01Z",
          message: `Safe ${status} message`,
        },
      });
      render(<Dashboard {...dashboardProps} dinner={dinner} />);
      expect(
        screen.getByRole("region", { name: "Latest research" }).textContent,
      ).toContain(`Safe ${status} message`);
    },
  );
});

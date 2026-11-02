import { test, expect, type Page } from "@playwright/test";
import { bootstrapFixture, dinnerFixture } from "../tests/fixtures";
import type { DinnerView, MutationEnvelope } from "../../src/miniapp/contracts";

// Synthetic Telegram/API fixtures are test-side interceptions only.
async function fixture(page: Page) {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "" }),
  );
  await page.addInitScript(() => {
    (window as any).Telegram = {
      WebApp: {
        initData: "TEST-ONLY-multiple",
        ready() {},
        expand() {},
        openTelegramLink() {},
        openLink() {},
        colorScheme: "light",
      },
    };
  });
  await page.clock.install({ time: new Date("2026-11-02T18:00:00Z") });
  const base = dinnerFixture();
  const a = dinnerFixture({
    id: "dinner-a",
    title: "Friday friends",
    status: "agreed",
    activeVersion: 7,
    members: base.members.map((m) => ({ ...m, confirmed: true })),
    progress: { approved: 2, expected: 2, complete: 2, confirmed: 2 },
    options: [
      {
        index: 0,
        venueId: "synthetic-v",
        venueName: "Synthetic Bistro",
        address: "Test address",
        start: "2026-11-10T19:00:00-06:00",
        end: "2026-11-10T20:30:00-06:00",
        pricePerPerson: 40,
        currency: "USD",
        reservationUrl: "https://example.com/test",
        reservationState: "not-booked",
        ownChecks: { status: "feasible", reasons: [] },
        sources: [],
      },
    ],
  });
  const b = dinnerFixture({
    id: "dinner-b",
    title: "Team supper",
    role: "member",
  });
  const c = dinnerFixture({
    id: "dinner-c",
    city: "Madison",
    windowStart: "2026-11-09",
  });
  let dinners = [a, b, c],
    selected = a.id,
    holdPoll = false;
  let releasePoll: (() => Promise<void>) | undefined;
  const actions: MutationEnvelope[] = [];
  await page.route("**/api/miniapp/bootstrap*", (route) => {
    const invitation = route.request().url().includes("invite=")
      ? {
          ...base.setup,
          title: "Neighborhood supper",
          formVersion: "invite-version",
          dinnerId: "invited-dinner",
          partySize: 4,
          availablePlaces: 2,
          alreadyJoined: false,
          pending: false,
        }
      : undefined;
    return route.fulfill({
      json: bootstrapFixture({
        dinners,
        currentDinnerId: selected,
        invitation,
      }),
    });
  });
  await page.route("**/api/miniapp/dinners/*", async (route) => {
    const id = route.request().url().split("/").at(-1)!;
    if (holdPoll && id === a.id) {
      holdPoll = false;
      await new Promise<void>((resolve) => {
        releasePoll = async () => {
          await route.fulfill({ json: { ...a, title: "LATE WRONG DINNER" } });
          resolve();
        };
      });
      return;
    }
    await route.fulfill({ json: dinners.find((d) => d.id === id) });
  });
  await page.route("**/api/miniapp/actions", async (route) => {
    const action = route.request().postDataJSON() as MutationEnvelope;
    actions.push(action);
    let view = dinners.find((d) => d.id === action.dinnerId);
    if (action.action === "chooseDinner") {
      expect(action.formVersion).toBeUndefined();
      selected = action.dinnerId!;
    }
    if (action.action === "renameDinner") {
      expect(action.formVersion).toBe(view!.formVersion);
      view = {
        ...view!,
        title: (action.payload as { title: string }).title || undefined,
      };
      dinners = dinners.map((d) => (d.id === view!.id ? view! : d));
    }
    if (action.action === "create") {
      const payload = action.payload as any;
      view = dinnerFixture({
        id: "new-dinner",
        title: payload.title,
        setup: { ...base.setup, ...payload },
        city: payload.city,
        windowStart: payload.windowStart,
        windowEnd: payload.windowEnd,
      });
      dinners = [...dinners, view];
      selected = view.id;
    }
    await route.fulfill({ json: { ok: true, dinner: view } });
  });
  return {
    a,
    b,
    actions,
    hold: () => {
      holdPoll = true;
    },
    release: async () => {
      expect(releasePoll).toBeDefined();
      await releasePoll!();
    },
    captured: () => !!releasePoll,
  };
}
test("multiple dinners: grouped home, metadata rename, and late previous-dinner poll cannot replace the selected dinner", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/app/");
  await expect(page.getByRole("heading", { name: "Organizing" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Joining" })).toBeVisible();
  const organizing = page.getByRole("region", { name: "Organizing" });
  await expect(organizing.getByRole("button").first()).toContainText(
    "Dinner in Madison",
  );
  await page.getByRole("button", { name: /Friday friends/ }).click();
  await expect(
    page.getByRole("heading", { name: "Friday friends" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Rename dinner", exact: true })
    .click();
  await page.getByLabel("Dinner name", { exact: true }).fill("Friday, renamed");
  await page.getByRole("button", { name: "Save dinner name" }).click();
  await expect(
    page.getByRole("heading", { name: "Friday, renamed" }),
  ).toBeVisible();
  await expect(page.getByText("Plan 7", { exact: true })).toBeVisible();
  await expect(
    page.getByText("2 people, one agreed plan.", { exact: true }),
  ).toBeVisible();
  f.hold();
  await page.clock.fastForward(5500);
  await expect.poll(f.captured).toBe(true);
  await page.getByRole("button", { name: "Your dinners", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Friday, renamed/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Team supper/ }).click();
  await expect(
    page.getByRole("heading", { name: "Team supper" }),
  ).toBeVisible();
  await f.release();
  await expect(
    page.getByRole("heading", { name: "Team supper" }),
  ).toBeVisible();
  await expect(page.getByText("LATE WRONG DINNER")).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Rename dinner", exact: true }),
  ).toHaveCount(0);
  expect(f.actions.map((a) => a.action)).toEqual([
    "chooseDinner",
    "renameDinner",
    "chooseDinner",
  ]);
});
test("multiple dinners: explicit selection/create/invitation deep links take precedence and long names fit the phone", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/app/?dinner=dinner-b");
  await expect(
    page.getByRole("heading", { name: "Team supper" }),
  ).toBeVisible();
  await page.goto("/app/?view=create");
  await expect(
    page.getByRole("button", { name: "Create dinner" }),
  ).toBeVisible();
  const longName = "W".repeat(80);
  await page.getByLabel("Dinner name", { exact: true }).fill(longName);
  await page.getByLabel("Where are we meeting?").fill("Chicago");
  await page.getByRole("checkbox", { name: /I agree to Muse/ }).check();
  await page.getByRole("button", { name: "Create dinner" }).click();
  await expect(
    page.getByRole("heading", { name: /What works for you/ }),
  ).toBeVisible();
  expect(
    (f.actions.find((a) => a.action === "create")!.payload as any).title,
  ).toBe(longName);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: longName, exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const beforeInvite = f.actions.length;
  await page.goto("/app/?invite=TEST-ONLY-invitation");
  await expect(
    page.getByRole("heading", { name: "Neighborhood supper" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add my answers" }),
  ).toBeVisible();
  expect(f.actions.length).toBe(beforeInvite);
});

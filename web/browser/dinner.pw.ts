import { test, expect, type Page } from "@playwright/test";
import { bootstrapFixture, dinnerFixture } from "../tests/fixtures";
import type { MutationEnvelope } from "../../src/miniapp/contracts";

// This is a real rendered browser with explicitly synthetic Telegram and API fixtures.
// No development auth bypass, fixture API, or fixture identity is shipped in the app.
async function telegramFixture(page: Page) {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: "/* Synthetic Telegram SDK for browser tests only. */",
    }),
  );
  await page.addInitScript(() => {
    (window as any).Telegram = {
      WebApp: {
        initData: "TEST-ONLY-signed-fixture",
        ready() {},
        expand() {},
        openTelegramLink() {},
        openLink() {},
        colorScheme: "light",
      },
    };
  });
  await page.clock.install({ time: new Date("2026-11-01T18:00:00Z") });
}
test("synthetic host: create, save own answers, invite, automatic joining and confirm a plan", async ({
  page,
}) => {
  await telegramFixture(page);
  let dinner = dinnerFixture();
  const actions: MutationEnvelope[] = [];
  await page.route("**/api/miniapp/bootstrap*", (route) =>
    route.fulfill({ json: bootstrapFixture() }),
  );
  await page.route("**/api/miniapp/dinners/test-dinner", (route) =>
    route.fulfill({ json: dinner }),
  );
  await page.route("**/api/miniapp/actions", async (route) => {
    const action = route.request().postDataJSON() as MutationEnvelope;
    actions.push(action);
    expect(route.request().headers().authorization).toBe(
      "tma TEST-ONLY-signed-fixture",
    );
    if (action.action === "create") {
      expect(action.payload).toMatchObject({
        city: "Chicago",
        partySize: 2,
        budget: { amount: 50, basis: "per-person" },
      });
    }
    if (action.action === "savePreferences") {
      const payload = action.payload as any;
      expect(payload.availability).toHaveLength(2);
      expect(payload.foodConfirmed).toBe(true);
      dinner = {
        ...dinner,
        formVersion: "form-2",
        own: { ...dinner.own, constraints: payload, foodConfirmed: true },
        progress: { ...dinner.progress, complete: 1 },
        pendingRequests: [{ userId: "test-friend", name: "Test Friend" }],
      };
    }
    if (action.action === "invite")
      dinner = {
        ...dinner,
        formVersion: "form-3",
        members: [
          ...dinner.members,
          {
            id: "test-friend",
            name: "Test Friend",
            required: true,
            confirmed: false,
          },
        ],
        pendingRequests: [],
        progress: { ...dinner.progress, approved: 2, complete: 2 },
      };
    if (action.action === "research")
      dinner = {
        ...dinner,
        status: "proposed",
        activeVersion: 1,
        options: [
          {
            index: 0,
            venueId: "synthetic-venue",
            venueName: "Synthetic Test Bistro",
            address: "Test address",
            start: "2026-11-10T19:00:00-06:00",
            end: "2026-11-10T20:30:00-06:00",
            pricePerPerson: 40,
            currency: "USD",
            reservationUrl: "https://example.com/test-booking",
            reservationState: "not-booked",
            ownChecks: { status: "feasible", reasons: [] },
            sources: [
              {
                label: "Menu price",
                url: "https://example.com/test-menu",
                retrievedAt: "2026-11-01T18:00:00Z",
                status: "known",
              },
            ],
          },
        ],
      };
    if (action.action === "confirm")
      dinner = {
        ...dinner,
        status: "agreed",
        members: dinner.members.map((member) => ({
          ...member,
          confirmed: true,
        })),
        progress: { ...dinner.progress, confirmed: 2 },
      };
    await route.fulfill({
      json: {
        ok: true,
        dinner,
        ...(action.action === "invite"
          ? { invitationUrl: "https://t.me/TestMuseBot?start=TEST-ONLY-invite" }
          : {}),
      },
    });
  });
  await page.goto("/app/");
  await page.getByRole("button", { name: /Start a dinner/ }).click();
  await page.getByLabel("Where are we meeting?").fill("Chicago");
  await page.getByLabel("Earliest date").fill("2026-11-10");
  await page.getByLabel("Latest date").fill("2026-11-12");
  await page.getByRole("checkbox", { name: /I agree to Muse/ }).check();
  await page.getByRole("button", { name: /Create dinner/ }).click();
  await expect(
    page.getByRole("heading", { name: /What works for you/ }),
  ).toBeVisible();
  await expect(page.locator(".date-cell[aria-pressed=true]")).toHaveCount(0);
  await page.getByRole("button", { name: "Tuesday, November 10" }).click();
  await page.getByRole("button", { name: "Wednesday, November 11" }).click();
  await page.getByRole("button", { name: "Apply to 2 dates" }).click();
  await page.getByRole("button", { name: /No requirements/ }).click();
  await page.getByRole("button", { name: /Save my answers/ }).click();
  await page.getByRole("button", { name: "Share invitation" }).click();
  await expect
    .poll(() => actions.some((action) => action.action === "invite"))
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "Approve", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /Find dinner options/ }).click();
  await expect(
    page.getByRole("heading", { name: "Synthetic Test Bistro" }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: /This works for me/ }).click();
  await expect(
    page.getByRole("button", { name: /Add to my calendar/ }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
});

test("synthetic guest: consent joins automatically before answers", async ({
  page,
}) => {
  await telegramFixture(page);
  const actions: MutationEnvelope[] = [];
  const invitation = {
    dinnerId: "test-dinner",
    city: "Chicago",
    windowStart: "2026-11-10",
    windowEnd: "2026-11-12",
    partySize: 2,
    availablePlaces: 1,
    alreadyJoined: false,
    pending: false,
    timezone: "America/Chicago",
    currency: "USD",
    durationMinutes: 90,
    area: "Citywide",
    budget: { amount: 50, basis: "per-person" },
    formVersion: "invite-form-1",
  };
  await page.route("**/api/miniapp/bootstrap*", (route) =>
    route.fulfill({
      json: bootstrapFixture({
        actor: { id: "test-guest", name: "Test Guest" },
        invitation,
      } as any),
    }),
  );
  let dinner = dinnerFixture({
    role: "member",
    own: {
      constraints: {},
      consent: true,
      foodConfirmed: false,
      availabilitySharing: true,
      answerSharing: false,
      reminders: false,
      calendar: "not-connected",
      disputeOpen: false,
    },
  } as any);
  await page.route("**/api/miniapp/dinners/test-dinner", (route) =>
    route.fulfill({ json: dinner }),
  );
  await page.route("**/api/miniapp/actions", (route) => {
    const input = route.request().postDataJSON();
    actions.push(input);
    if (input.action === "savePreferences")
      dinner = {
        ...dinner,
        own: { ...dinner.own, constraints: input.payload, foodConfirmed: true },
      };
    return route.fulfill({ json: { ok: true, dinner } });
  });
  await page.goto("/app/?invite=TEST-ONLY-invite");
  await page
    .getByRole("checkbox", {
      name: /join this dinner and share my manual availability/,
    })
    .check();
  await page.getByRole("button", { name: "Join dinner", exact: true }).click();
  await page.getByRole("button", { name: "Tuesday, November 10" }).click();
  await page.getByRole("button", { name: "Apply to 1 date" }).click();
  await page.getByRole("button", { name: /No requirements/ }).click();
  await page.getByRole("button", { name: /Save my answers/ }).click();
  await expect(
    page.getByRole("heading", { name: "Your answers are in" }),
  ).toBeVisible();
  expect(actions.map((a) => a.action)).toEqual(["join", "savePreferences"]);
  await expect(
    page.getByRole("button", { name: "Approve", exact: true }),
  ).toHaveCount(0);
});

test("synthetic owner: shared detail edits keep the original form version through polling", async ({
  page,
}) => {
  await telegramFixture(page);
  let dinner = dinnerFixture();
  const actions: MutationEnvelope[] = [];
  await page.route("**/api/miniapp/bootstrap*", (route) =>
    route.fulfill({
      json: bootstrapFixture({ currentDinnerId: dinner.id, dinners: [dinner] }),
    }),
  );
  await page.route("**/api/miniapp/dinners/test-dinner", (route) =>
    route.fulfill({ json: dinner }),
  );
  await page.route("**/api/miniapp/actions", async (route) => {
    const action = route.request().postDataJSON() as MutationEnvelope;
    actions.push(action);
    await route.fulfill({
      json: {
        ok: true,
        dinner: {
          ...dinner,
          formVersion: "updated-form",
          setup: {
            ...dinner.setup,
            budget: { amount: 60, basis: "per-person" },
          },
        },
      },
    });
  });
  await page.goto("/app/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit shared dinner details" })
    .click();
  await page.getByLabel("Budget per person").fill("60");
  dinner = { ...dinner, formVersion: "newer-server-form" };
  await page.clock.fastForward(5500);
  await expect(page.getByLabel("Budget per person")).toHaveValue("60");
  await page.getByRole("button", { name: /Save shared details/ }).click();
  await expect.poll(() => actions.length).toBe(1);
  expect(actions[0]).toMatchObject({
    action: "updateDinner",
    formVersion: "form-1",
    payload: { budget: { amount: 60, basis: "per-person" } },
  });
  expect((actions[0].payload as any).partySize).toBeUndefined();
});

test("synthetic deletion: explicit all-data warning and no authenticated bootstrap after deletion", async ({
  page,
}) => {
  await telegramFixture(page);
  const dinner = dinnerFixture();
  let bootstrapCalls = 0;
  await page.route("**/api/miniapp/bootstrap*", (route) => {
    bootstrapCalls++;
    return route.fulfill({
      json: bootstrapFixture({ currentDinnerId: dinner.id, dinners: [dinner] }),
    });
  });
  await page.route("**/api/miniapp/public", (route) =>
    route.fulfill({ json: { botUsername: "TestMuseBot" } }),
  );
  await page.route("**/api/miniapp/dinners/test-dinner", (route) =>
    route.fulfill({ json: dinner }),
  );
  await page.route("**/api/miniapp/actions", (route) =>
    route.fulfill({ json: { ok: true, deleted: true } }),
  );
  await page.goto("/app/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Delete all my Muse data" }).click();
  await expect(page.getByText(/across every dinner/)).toBeVisible();
  const beforeDelete = bootstrapCalls;
  await page.getByRole("button", { name: "Delete all my Muse data" }).click();
  await expect(
    page.getByRole("heading", { name: /Your data is deleted/ }),
  ).toBeVisible();
  expect(bootstrapCalls).toBe(beforeDelete);
});

test("outside Telegram fetches public config only and exposes no dinner data", async ({
  page,
}) => {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "" }),
  );
  const privateRequests: string[] = [];
  await page.route("**/api/miniapp/**", (route) => {
    if (!route.request().url().endsWith("/public"))
      privateRequests.push(route.request().url());
    return route.fulfill({ json: { botUsername: "TestMuseBot" } });
  });
  await page.goto("/app/");
  await expect(
    page.getByRole("link", { name: /Open Muse in Telegram/ }),
  ).toHaveAttribute("href", "https://t.me/TestMuseBot");
  expect(privateRequests).toEqual([]);
});

test("synthetic organizer cancellation is explicit and terminal, with manual cleanup guidance", async ({
  page,
}) => {
  await telegramFixture(page);
  let dinner = dinnerFixture();
  const actions: MutationEnvelope[] = [];
  await page.route("**/api/miniapp/bootstrap*", (route) =>
    route.fulfill({
      json: bootstrapFixture({ currentDinnerId: dinner.id, dinners: [dinner] }),
    }),
  );
  await page.route("**/api/miniapp/dinners/test-dinner", (route) =>
    route.fulfill({ json: dinner }),
  );
  await page.route("**/api/miniapp/actions", async (route) => {
    const action = route.request().postDataJSON() as MutationEnvelope;
    actions.push(action);
    expect(action).toMatchObject({
      action: "cancelDinner",
      payload: { confirmed: true },
    });
    dinner = {
      ...dinner,
      status: "cancelled",
      ended: true,
      own: { ...dinner.own, calendar: "staged" },
      cancellation: { at: "2026-11-01T18:00:00Z", by: "test-owner" },
    };
    await route.fulfill({ json: { ok: true, dinner } });
  });
  await page.goto("/app/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Cancel dinner for everyone" })
    .click();
  expect(actions).toHaveLength(0);
  await expect(
    page.getByText(/Cancel this dinner for everyone\?/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep dinner planned" }).click();
  expect(actions).toHaveLength(0);
  await page
    .getByRole("button", { name: "Cancel dinner for everyone" })
    .click();
  await page.getByRole("button", { name: "Yes, cancel this dinner" }).click();
  await expect(
    page.getByRole("heading", { name: "This dinner is cancelled." }),
  ).toBeVisible();
  expect(actions).toHaveLength(1);
  await expect(
    page.getByText(/reservation or calendar event must be cancelled manually/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Edit shared dinner details" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Use calendar for this dinner" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Close Your dinner settings" })
    .click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
  await expect(page.getByText("Dinner has begun", { exact: true })).toHaveCount(
    0,
  );
});

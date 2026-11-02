import { test, expect, type Page } from "@playwright/test";
import { bootstrapFixture, dinnerFixture } from "../tests/fixtures";
import type { MutationEnvelope } from "../../src/miniapp/contracts";

// Synthetic fixtures are intercepted by Playwright, never exposed by the app server.
async function signedFixture(page: Page) {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "" }),
  );
  await page.addInitScript(() => {
    (window as any).Telegram = {
      WebApp: {
        initData: "TEST-ONLY-sharing",
        ready() {},
        expand() {},
        openLink() {},
        openTelegramLink() {},
        colorScheme: "light",
      },
    };
  });
  await page.clock.install({ time: new Date("2026-11-02T18:00:00Z") });
}
test("synthetic sharing: explicit preview grant, stale snapshot rejection, and immediate terminal revocation", async ({
  page,
}) => {
  await signedFixture(page);
  const base = dinnerFixture();
  let dinner = dinnerFixture({
    own: {
      ...base.own,
      foodConfirmed: true,
      constraints: {
        availability: [
          {
            start: "2026-11-10T19:00:00-06:00",
            end: "2026-11-10T22:00:00-06:00",
          },
        ],
        dietary: [{ requirement: "Vegan", strength: "firm", allergy: false }],
        preferences: ["Quiet"],
        budget: { amount: 45, strength: "firm" },
        travel: {
          maxMinutes: 30,
          origin: "Owner starting point by train",
          strength: "firm",
        },
        busy: [{ start: "2030-02-03T08:00:00Z", end: "2030-02-03T09:00:00Z" }],
      },
    },
    sharedResponses: [
      { userId: "test-owner", name: "Test Owner", status: "private" },
      { userId: "friend", name: "Test Friend", status: "private" },
    ],
  });
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
    const enabled = (action.payload as { enabled: boolean }).enabled;
    if (enabled && action.formVersion !== dinner.formVersion)
      return route.fulfill({
        status: 409,
        json: { error: { code: "STALE_FORM", message: "Safe stale response" } },
      });
    if (!enabled) expect(action.formVersion).toBeUndefined();
    dinner = {
      ...dinner,
      own: { ...dinner.own, answerSharing: enabled },
      sharedResponses: [
        {
          userId: "test-owner",
          name: "Test Owner",
          status: enabled ? "shared" : "private",
          ...(enabled ? { constraints: dinner.own.constraints } : {}),
        },
        dinner.sharedResponses[1],
      ],
    };
    return route.fulfill({ json: { ok: true, dinner } });
  });
  await page.goto("/app/");
  await expect(
    page.getByText("Owner starting point by train", { exact: false }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Review & share my answers" }).click();
  const preview = page.getByRole("region", { name: "Confirm answer sharing" });
  await expect(preview).toContainText("Owner starting point by train");
  await expect(preview).not.toContainText("2030");
  await expect(
    page.getByRole("button", { name: "Share my answers", exact: true }),
  ).toBeDisabled();
  await page.getByRole("checkbox", { name: /I want approved members/ }).check();
  dinner = { ...dinner, formVersion: "new-current-form" };
  await page.clock.fastForward(5500);
  await page
    .getByRole("button", { name: "Share my answers", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "answers are still here",
  );
  expect(actions[0].formVersion).toBe("form-1");
  await page.getByRole("button", { name: "Keep answers private" }).click();
  await page.getByRole("button", { name: "Review & share my answers" }).click();
  await page.getByRole("checkbox", { name: /I want approved members/ }).check();
  await page
    .getByRole("button", { name: "Share my answers", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Make my answers private" }),
  ).toBeVisible();
  expect(actions[1]).toMatchObject({
    action: "setAnswerSharing",
    formVersion: "new-current-form",
    payload: { enabled: true },
  });
  await page
    .getByRole("button", { name: "Close Your dinner settings" })
    .click();
  await page
    .getByRole("region", { name: "Party answers" })
    .getByText("You", { exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Party answers" }),
  ).toContainText("Owner starting point by train");
  dinner = {
    ...dinner,
    status: "cancelled",
    ended: true,
    formVersion: "terminal-form",
  };
  await page.clock.fastForward(5500);
  await expect(
    page.getByRole("heading", { name: "This dinner is cancelled." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Make my answers private" }).click();
  await expect(
    page.getByRole("region", { name: "Answer sharing settings" }),
  ).toContainText("Your answers are private");
  expect(actions[2]).toMatchObject({
    action: "setAnswerSharing",
    payload: { enabled: false },
  });
});

test("synthetic research: 401 authentication guidance is organizer-only, members see safe latest status", async ({
  page,
}) => {
  await signedFixture(page);
  const research = {
    id: "safe-research-ref",
    status: "failed" as const,
    requestedAt: "2026-11-02T18:00:00Z",
    updatedAt: "2026-11-02T18:00:02Z",
    message:
      "Research could not run. The service owner needs to check the Muse connection.",
  };
  const details = {
    ...research,
    dinnerId: "test-dinner",
    inputVersion: "v1",
    stage: "provider" as const,
    code: "AUTH_INVALID" as const,
    httpStatus: 401,
    durationMs: 1800,
  };
  let dinner = dinnerFixture({ research, researchDetails: details });
  await page.route("**/api/miniapp/bootstrap*", (route) =>
    route.fulfill({
      json: bootstrapFixture({ currentDinnerId: dinner.id, dinners: [dinner] }),
    }),
  );
  await page.route("**/api/miniapp/dinners/test-dinner", (route) =>
    route.fulfill({ json: dinner }),
  );
  await page.goto("/app/");
  await page
    .getByText("Research details for organizer", { exact: true })
    .click();
  const card = page.getByRole("region", { name: "Latest research" });
  await expect(card).toContainText("401");
  await expect(card).toContainText("AUTH_INVALID");
  await expect(card).toContainText("MODEL_API_KEY in Render");
  await expect(card.locator("input")).toHaveCount(0);
  dinner = { ...dinner, role: "member", researchDetails: undefined };
  await page.clock.fastForward(5500);
  await expect(
    page.getByText("Research details for organizer", { exact: true }),
  ).toHaveCount(0);
  await expect(card).toContainText(research.message);
  await expect(card).not.toContainText("MODEL_API_KEY");
  await expect(card).not.toContainText("AUTH_INVALID");
});

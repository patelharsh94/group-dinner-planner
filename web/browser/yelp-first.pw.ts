import { test, expect } from "@playwright/test";
import { bootstrapFixture, dinnerFixture } from "../tests/fixtures";

test("three Yelp choices lead to a reviewed, explicitly authorized booking", async ({
  page,
}) => {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "" }),
  );
  await page.addInitScript(() => {
    (window as any).Telegram = {
      WebApp: {
        initData: "TEST-ONLY-yelp",
        ready() {},
        expand() {},
        openLink() {},
        openTelegramLink() {},
      },
    };
  });
  const option = {
    index: 0,
    venueId: "v",
    venueName: "Test Bistro",
    address: "Test address, Chicago",
    start: "2026-11-10T19:00:00-06:00",
    end: "2026-11-10T20:30:00-06:00",
    currency: "USD",
    pricePerPerson: 0,
    priceEstimateKnown: false,
    reservationUrl: "",
    reservationState: "unknown",
    ownChecks: { status: "feasible" as const, reasons: [] },
    sources: [],
    directory: {
      businessId: "v",
      profileUrl: "https://www.yelp.com/biz/test",
      menuUrl: "https://example.com/menu",
      priceLevel: "$$",
      expiresAt: "2026-11-11T00:00:00Z",
    },
  };
  let dinner = dinnerFixture({
    status: "agreed",
    activeVersion: 1,
    options: [0, 1, 2, 3].map((index) => ({
      ...option,
      index,
      venueName: `Test Bistro ${index}`,
    })),
    agreement: { version: 1, confirmed: 1, required: 1, agreed: true },
    verification: { status: "ready", checks: [] },
  });
  const actions: any[] = [];
  await page.route("**/api/miniapp/bootstrap*", (route) =>
    route.fulfill({
      json: bootstrapFixture({ currentDinnerId: dinner.id, dinners: [dinner] }),
    }),
  );
  await page.route("**/api/miniapp/dinners/test-dinner", (route) =>
    route.fulfill({ json: dinner }),
  );
  await page.route("**/api/miniapp/actions", (route) => {
    const action = route.request().postDataJSON();
    actions.push(action);
    if (action.action === "reviewReservation")
      dinner = {
        ...dinner,
        reservation: {
          mismatch: false,
          review: {
            reviewId: "r",
            version: 1,
            status: "ready",
            message: "Review and authorize this booking.",
            provider: "yelp",
          },
        },
      };
    else if (action.action === "bookReservation")
      dinner = {
        ...dinner,
        reservation: {
          mismatch: false,
          attempt: {
            id: "a",
            version: 1,
            status: "unknown",
            message: "Check the outcome before booking again.",
            createdAt: "2026-11-03T00:00:00Z",
          },
        },
      };
    return route.fulfill({ json: { ok: true, dinner } });
  });
  await page.goto("/app/");
  await expect(page.locator(".plan-card")).toHaveCount(3);
  await expect(page.getByRole("link", { name: "View on Yelp" })).toHaveCount(3);
  await expect(page.locator(".plan-card").first()).toContainText(
    "Meal cost not confirmed",
  );
  await expect(page.locator(".plan-card").first()).toContainText(
    "$$ · relative price level",
  );
  await page
    .getByRole("button", { name: "Book this restaurant", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "Reservation status" });
  await expect(panel).toContainText("Test Bistro 0");
  await expect(panel).toContainText("1 person");
  await expect(
    panel.getByRole("link", { name: "Review Yelp booking terms" }),
  ).toHaveAttribute("href", "https://terms.yelp.com/tos/en_us/");
  const submit = panel.getByRole("button", {
    name: "Authorize and book this table",
  });
  await expect(submit).toBeDisabled();
  await panel.getByLabel("First name").fill("Test");
  await panel.getByLabel("Last name").fill("Owner");
  await panel.getByLabel("Email", { exact: true }).fill("test@example.com");
  await panel.getByLabel("Phone", { exact: true }).fill("+13125550123");
  await panel
    .getByRole("checkbox", { name: /I authorize this reservation/ })
    .check();
  await submit.click();
  await expect(panel).toContainText("Reservation outcome needs checking");
  await expect(
    panel.getByRole("button", { name: "Book this restaurant" }),
  ).toHaveCount(0);
  expect(actions.map((a) => a.action)).toEqual([
    "reviewReservation",
    "bookReservation",
  ]);
  expect(actions[1].payload).toMatchObject({
    version: 1,
    reviewId: "r",
    consent: true,
  });
});

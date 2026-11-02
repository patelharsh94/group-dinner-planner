import { test, expect, type Page } from "@playwright/test";
import { bootstrapFixture, dinnerFixture } from "../tests/fixtures";
async function setup(page: Page, existing = false) {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: "/* Test-only Telegram SDK fixture */",
    }),
  );
  await page.addInitScript(() => {
    (window as any).Telegram = {
      WebApp: {
        initData: "TEST-ONLY-layout",
        ready() {},
        expand() {},
        openTelegramLink() {},
        openLink() {},
        colorScheme: "light",
      },
    };
  });
  await page.clock.install({ time: new Date("2026-11-01T18:00:00Z") });
  const dinner = dinnerFixture();
  dinner.own.constraints.availability = [
    { start: "2026-11-10T19:00:00-06:00", end: "2026-11-10T22:00:00-06:00" },
  ];
  dinner.own.constraints.dietary = [];
  dinner.own.foodConfirmed = true;
  await page.route("**/api/miniapp/bootstrap*", (route) =>
    route.fulfill({
      json: bootstrapFixture(
        existing ? { currentDinnerId: dinner.id, dinners: [dinner] } : {},
      ),
    }),
  );
  await page.route("**/api/miniapp/dinners/test-dinner", (route) =>
    route.fulfill({ json: dinner }),
  );
  await page.route("**/api/miniapp/actions", (route) => {
    const action = route.request().postDataJSON();
    expect(action.action).toBe("chooseDinner");
    expect(action.dinnerId).toBe(dinner.id);
    return route.fulfill({ json: { ok: true, dinner } });
  });
}
async function assertNativeFieldsFit(page: Page) {
  const report = await page.evaluate(() => {
    const inputs = [
      ...document.querySelectorAll<HTMLInputElement>(
        'input[type="date"],input[type="time"]',
      ),
    ].filter((el) => el.getBoundingClientRect().width > 0);
    const pairs = [...document.querySelectorAll(".field-pair")]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((pair) => {
        const rects = [...pair.querySelectorAll("input")].map((el) =>
          el.getBoundingClientRect(),
        );
        return rects.length < 2 || rects[1].top >= rects[0].bottom + 4;
      });
    return {
      count: inputs.length,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      fit: inputs.every((el) => {
        const rect = el.getBoundingClientRect(),
          parent = el.closest(".field")!.getBoundingClientRect();
        return (
          rect.left >= parent.left - 1 &&
          rect.right <= parent.right + 1 &&
          rect.right <= window.innerWidth + 1 &&
          Number.parseFloat(getComputedStyle(el).fontSize) >= 16
        );
      }),
      stacked: pairs.every(Boolean),
    };
  });
  expect(report.count).toBeGreaterThan(0);
  expect(report.overflow).toBe(false);
  expect(report.fit).toBe(true);
  expect(report.stacked).toBe(true);
}
for (const width of [393, 320]) {
  test(`UI-07 native date/time controls fit a ${width}px phone in create, shared details and availability`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 852 });
    await setup(page);
    await page.goto("/app/?view=create");
    await expect(page.getByLabel(/Earliest date|From date/)).toBeVisible();
    await assertNativeFieldsFit(page);
    await expect(
      page.getByText("Dinner Planner", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Powered by Muse", { exact: true }),
    ).toBeVisible();
    await setup(page, true);
    await page.goto("/app/?dinner=test-dinner");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", { name: "Edit shared dinner details" })
      .click();
    await expect(
      page.getByRole("heading", { name: /change.*plans/i }),
    ).toBeVisible();
    await assertNativeFieldsFit(page);
    await page.goto("/app/?dinner=test-dinner");
    await page
      .getByRole("button", { name: "Edit my answers", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: /Edit.*availability|Edit.*window|Edit.*November|^Edit$/,
      })
      .first()
      .click();
    await assertNativeFieldsFit(page);
  });
}

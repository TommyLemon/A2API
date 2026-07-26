/**
 * Watchable UI: Admin Apply / Call lists must load without auth/SQL errors.
 *
 *   HEADED=1 SLOW_MO=600 npm run test:ui -- e2e/admin-list.ui.spec.ts
 */

import { expect, test } from "@playwright/test";

const ADMIN_UI = "http://127.0.0.1:5174";

test.describe("Admin lists (watchable)", () => {
  test("Apply list loads without Failed / SQL hint", async ({ page }) => {
    await page.goto(ADMIN_UI);
    await expect(page.getByText("A2API Admin")).toBeVisible();
    await page.locator("#btn-refresh").click();

    // Must not show the auth/SQL failure banner
    await expect(page.locator("#app-list")).not.toContainText(/Failed:/i, {
      timeout: 15_000,
    });
    await expect(page.locator("#app-list")).not.toContainText(
      /sys_Apply\.sql/i,
    );
    await expect(
      page.locator('[data-testid="apply-item"]').first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("Call logs load without Failed", async ({ page }) => {
    await page.goto(ADMIN_UI);
    await page.locator('.main-tab[data-view="calls"]').click();
    await page.locator("#btn-refresh").click();
    await expect(page.locator("#call-list")).not.toContainText(/Failed:/i, {
      timeout: 15_000,
    });
    await expect(page.locator("#call-list")).not.toContainText(
      /Unexpected non-whitespace/i,
    );
    // Seed data or empty — either is OK as long as not Failed
    await expect(page.locator("#call-list")).toBeVisible();
    const text = await page.locator("#call-list").innerText();
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/Failed:/i);
  });
});

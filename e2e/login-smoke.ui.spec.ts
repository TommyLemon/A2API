import { expect, test } from "@playwright/test";

test("chat-demo Login opens modal and signs in via /apijson BFF", async ({
  page,
}) => {
  const badModule404: string[] = [];
  page.on("response", (res) => {
    const u = res.url();
    if (
      res.status() === 404 &&
      /127\.0\.0\.1:5173\/.*\.(ts|js)/.test(u) &&
      !u.includes("favicon")
    ) {
      badModule404.push(`${res.status()} ${u}`);
    }
  });

  await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.removeItem("a2api.account");
  });
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("#account-login-btn")).toHaveText("Login");

  await page.locator("#account-login-btn").click();
  const modal = page.locator(".auth-modal");
  await expect(modal).toBeVisible({ timeout: 5000 });
  await modal.locator("input").first().fill("13000082001");
  await modal.locator('input[type="password"]').fill("123456");
  await modal.getByRole("button", { name: /^Login$/ }).click();

  await expect(page.locator("#account-login-btn")).not.toHaveText("Login", {
    timeout: 10000,
  });

  const cookies = await page.context().cookies("http://127.0.0.1:5173");
  expect(cookies.some((c) => c.name === "a2api_aj")).toBeTruthy();
  expect(badModule404, badModule404.join("\n")).toEqual([]);
});

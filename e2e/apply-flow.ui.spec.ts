/**
 * Watchable UI E2E: submit Apply → Admin approve/reject → Chat notify on reload.
 *
 * Run (browser stays visible, slowed):
 *   npm run test:ui
 */

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const ADMIN_UI = "http://127.0.0.1:5174";
const ADMIN_API = "http://127.0.0.1:3001";
const CHAT_UI = "http://127.0.0.1:5173";

async function submitApply(
  request: APIRequestContext,
  requestId: string,
  operation: "delete" | "put",
) {
  const res = await request.post(`${ADMIN_API}/api/applications`, {
    data: {
      table: "Moment",
      operation,
      role: "OWNER",
      version: 1,
      method: "POST",
      type: "JSON",
      url: `http://localhost:8080/${operation}`,
      json: { Moment: { id: 1 }, tag: "Moment" },
      tag: "Moment",
      name: `${operation.toUpperCase()} Moment`,
      detail: `ui-e2e ${operation}`,
      requestId,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { item: { id: string; status: string } };
  expect(body.item.status).toBe("pending");
  return body.item;
}

async function openAdminApply(page: Page, requestId: string) {
  await page.goto(ADMIN_UI);
  await expect(page.getByText("A2API Admin")).toBeVisible();
  await page.locator("#btn-refresh").click();
  const item = page.locator(
    `[data-testid="apply-item"][data-request-id="${requestId}"]`,
  );
  await expect(item).toBeVisible({ timeout: 20_000 });
  await item.click();
  await expect(page.locator("#detail-form")).toBeVisible();
}

async function seedChatTracked(page: Page, requestId: string, summary: string) {
  await page.addInitScript(
    ({ rid, sum }) => {
      localStorage.setItem(
        "a2api.trackedApprovals",
        JSON.stringify([
          {
            requestId: rid,
            sessionId: "ui-e2e",
            summary: sum,
            at: new Date().toISOString(),
            lastStatus: "pending",
          },
        ]),
      );
    },
    { rid: requestId, sum: summary },
  );
}

test.describe("UI Apply flow (watchable)", () => {
  test("submit → approve in Admin → Chat notifies on reload", async ({
    page,
    context,
    request,
  }) => {
    const requestId = `ui_approve_${Date.now()}`;
    await submitApply(request, requestId, "delete");

    // Admin: review & approve (visible browser)
    await openAdminApply(page, requestId);
    await page.locator("#f-approved").check();
    await page.getByTestId("btn-approve").click();
    await expect(
      page.locator(`[data-testid="apply-item"][data-request-id="${requestId}"] .badge-approved`),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#form-status")).toContainText(/Approved/i, {
      timeout: 10_000,
    });

    // Chat: reload with tracked pending → should announce approval
    const chat = await context.newPage();
    await seedChatTracked(chat, requestId, "DELETE Moment (ui-e2e)");
    await chat.goto(CHAT_UI);
    await expect(chat.getByTestId("chat-messages")).toContainText(
      /Apply approved/i,
      { timeout: 20_000 },
    );
  });

  test("submit → reject in Admin → Chat notifies on reload", async ({
    page,
    context,
    request,
  }) => {
    const requestId = `ui_reject_${Date.now()}`;
    await submitApply(request, requestId, "put");

    page.on("dialog", (d) => d.accept());
    await openAdminApply(page, requestId);
    // Show rejected filter so item remains visible after reject
    await page.locator("#f-rejected").check();
    await page.getByTestId("btn-reject").click();
    await expect(
      page.locator(`[data-testid="apply-item"][data-request-id="${requestId}"] .badge-rejected`),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#form-status")).toContainText(/Rejected/i, {
      timeout: 10_000,
    });

    const chat = await context.newPage();
    await seedChatTracked(chat, requestId, "PUT Moment (ui-e2e)");
    await chat.goto(CHAT_UI);
    await expect(chat.getByTestId("chat-messages")).toContainText(
      /Apply rejected/i,
      { timeout: 20_000 },
    );
  });
});

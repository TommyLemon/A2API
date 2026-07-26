/**
 * E2E: submit Apply → poll status → approve/reject → notify on change.
 * Uses FileApplicationStore + dry-run approve (no live APIJSON).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminApp } from "./app.js";
import { FileApplicationStore } from "./application-store.js";
import type { ConfigApplication } from "./types.js";

type StatusItem = {
  requestId: string;
  status: string;
  decision: string | null;
  applyId: string | null;
};

function normalizeNotifyStatus(item: StatusItem): string {
  if (item.status === "pending" || item.decision === "pending") return "pending";
  if (
    item.status === "approved" ||
    item.decision === "approved" ||
    item.decision === "auto_approved"
  ) {
    return "approved";
  }
  if (item.status === "rejected" || item.decision === "rejected") {
    return "rejected";
  }
  return item.status || "unknown";
}

/** Mirrors chat-demo syncTrackedApprovals: notify only when status changes. */
function notifyOnChange(
  prev: string | undefined,
  next: string,
): string | null {
  if (prev == null) return null; // first track — no toast
  if (prev === next) return null;
  return `${prev} → ${next}`;
}

function tmpStore(): { store: FileApplicationStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2api-apply-e2e-"));
  const file = path.join(dir, "applications.jsonl");
  return { store: new FileApplicationStore(file), dir };
}

function testApp(store: FileApplicationStore) {
  return createAdminApp({
    store,
    apijsonBaseUrl: "http://localhost:8080",
    enableCatalog: false,
    ensureSession: async () => ({ ok: true }),
    approveWriter: async (app) => ({
      ok: true,
      application: {
        ...app,
        writeResults: {
          Access: { ok: true, action: "put" },
          Request: { ok: true, action: "post" },
          Document: { ok: true, action: "post" },
          Chain: { ok: true, action: "post" },
        },
      },
      results: {
        Access: { ok: true, action: "put" },
        Request: { ok: true, action: "post" },
        Document: { ok: true, action: "post" },
        Chain: { ok: true, action: "post" },
      },
    }),
  });
}

async function json<T>(
  app: ReturnType<typeof createAdminApp>,
  pathAndQuery: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const res = await app.request(pathAndQuery, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

const sampleBody = {
  table: "Moment",
  operation: "delete",
  role: "OWNER",
  version: 1,
  method: "POST",
  type: "JSON" as const,
  url: "http://localhost:8080/delete",
  json: { Moment: { id: 1 }, tag: "Moment" },
  tag: "Moment",
  name: "DELETE Moment",
  detail: "e2e permission gate",
};

describe("E2E Apply flow: submit → decide → notify", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  it("approve path: pending → approved and notifies on change", async () => {
    const { store, dir } = tmpStore();
    dirs.push(dir);
    const app = testApp(store);
    const requestId = `e2e_approve_${Date.now()}`;

    // 1) Submit
    const submitted = await json<{ item: ConfigApplication }>(
      app,
      "/api/applications",
      {
        method: "POST",
        body: JSON.stringify({ ...sampleBody, requestId }),
      },
    );
    expect(submitted.status).toBe(201);
    expect(submitted.body.item.status).toBe("pending");
    expect(submitted.body.item.requestId).toBe(requestId);
    const applyId = submitted.body.item.id;

    // 2) Poll — still pending (chat-demo tracks lastStatus=pending, no notify)
    const pendingPoll = await json<{ items: StatusItem[] }>(
      app,
      `/api/applications/status?requestIds=${encodeURIComponent(requestId)}`,
    );
    expect(pendingPoll.status).toBe(200);
    expect(pendingPoll.body.items).toHaveLength(1);
    expect(pendingPoll.body.items[0]!.decision).toBe("pending");
    expect(pendingPoll.body.items[0]!.applyId).toBe(applyId);
    const prev = normalizeNotifyStatus(pendingPoll.body.items[0]!);
    expect(prev).toBe("pending");
    expect(notifyOnChange("pending", prev)).toBeNull();

    // 3) Approve
    const decided = await json<{ ok: boolean; item: ConfigApplication }>(
      app,
      `/api/applications/${encodeURIComponent(applyId)}/decide`,
      {
        method: "POST",
        body: JSON.stringify({ action: "approve", decidedBy: "e2e-admin" }),
      },
    );
    expect(decided.status).toBe(200);
    expect(decided.body.ok).toBe(true);
    expect(decided.body.item.status).toBe("approved");
    expect(decided.body.item.decidedBy).toBe("e2e-admin");

    // 4) Poll — approved → notify
    const approvedPoll = await json<{ items: StatusItem[] }>(
      app,
      `/api/applications/status?requestIds=${encodeURIComponent(requestId)}`,
    );
    const next = normalizeNotifyStatus(approvedPoll.body.items[0]!);
    expect(next).toBe("approved");
    expect(notifyOnChange(prev, next)).toBe("pending → approved");
  });

  it("reject path: pending → rejected and notifies on change", async () => {
    const { store, dir } = tmpStore();
    dirs.push(dir);
    const app = testApp(store);
    const requestId = `e2e_reject_${Date.now()}`;

    const submitted = await json<{ item: ConfigApplication }>(
      app,
      "/api/applications",
      {
        method: "POST",
        body: JSON.stringify({ ...sampleBody, requestId, operation: "put" }),
      },
    );
    expect(submitted.status).toBe(201);
    const applyId = submitted.body.item.id;

    const pendingPoll = await json<{ items: StatusItem[] }>(
      app,
      `/api/applications/status?ids=${encodeURIComponent(requestId)}`,
    );
    const prev = normalizeNotifyStatus(pendingPoll.body.items[0]!);
    expect(prev).toBe("pending");

    const rejected = await json<{ ok: boolean; item: ConfigApplication }>(
      app,
      `/api/applications/${encodeURIComponent(applyId)}/decide`,
      {
        method: "POST",
        body: JSON.stringify({ action: "reject", decidedBy: "e2e-admin" }),
      },
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body.ok).toBe(true);
    expect(rejected.body.item.status).toBe("rejected");

    const rejectedPoll = await json<{ items: StatusItem[] }>(
      app,
      `/api/applications/status?requestIds=${encodeURIComponent(requestId)}`,
    );
    const next = normalizeNotifyStatus(rejectedPoll.body.items[0]!);
    expect(next).toBe("rejected");
    expect(notifyOnChange(prev, next)).toBe("pending → rejected");
    // No duplicate notify when still rejected
    expect(notifyOnChange(next, next)).toBeNull();
  });

  it("idempotent resubmit updates pending Apply for same requestId", async () => {
    const { store, dir } = tmpStore();
    dirs.push(dir);
    const app = testApp(store);
    const requestId = `e2e_idem_${Date.now()}`;

    const first = await json<{ item: ConfigApplication }>(
      app,
      "/api/applications",
      {
        method: "POST",
        body: JSON.stringify({
          ...sampleBody,
          requestId,
          detail: "first",
        }),
      },
    );
    const second = await json<{ item: ConfigApplication }>(
      app,
      "/api/applications",
      {
        method: "POST",
        body: JSON.stringify({
          ...sampleBody,
          requestId,
          detail: "second-update",
        }),
      },
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.item.id).toBe(first.body.item.id);
    expect(second.body.item.detail).toContain("second-update");
  });

  it("unknown requestId stays unknown (no false notify)", async () => {
    const { store, dir } = tmpStore();
    dirs.push(dir);
    const app = testApp(store);
    const poll = await json<{ items: StatusItem[] }>(
      app,
      "/api/applications/status?requestIds=missing_req",
    );
    expect(poll.body.items[0]!.status).toBe("unknown");
    expect(poll.body.items[0]!.decision).toBeNull();
    expect(notifyOnChange("pending", "unknown")).toBe("pending → unknown");
  });
});

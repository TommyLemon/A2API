/**
 * List Call logs via APIJSON with admin session (BFF).
 */

import type { ApiJsonClient } from "@a2api/runtime";
import { ensureAdminSession } from "./approve-writer.js";

export type CallLogRow = Record<string, unknown>;

/** APIJSON Demo rejects []/count outside 0–100. */
const PAGE_SIZE = 100;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function resultOk(body: unknown): boolean {
  const root = asRecord(body);
  if (!root) return false;
  const code = root.code;
  return code === 200 || code === "200" || code == null;
}

function errMsg(body: unknown, fallback: string): string {
  const root = asRecord(body);
  const msg = root?.msg ?? root?.message;
  return typeof msg === "string" && msg.trim() ? msg : fallback;
}

function rowsFromList(
  body: unknown,
  table: string,
): Record<string, unknown>[] {
  const root = asRecord(body);
  const arr = root?.["[]"];
  if (!Array.isArray(arr)) return [];
  const out: Record<string, unknown>[] = [];
  for (const wrap of arr) {
    const row = asRecord(asRecord(wrap)?.[table]);
    if (row) out.push(row);
  }
  return out;
}

function isUnauthorized(body: unknown, error?: string): boolean {
  const root = asRecord(body);
  const code = root?.code;
  if (
    code === 401 ||
    code === "401" ||
    code === 407 ||
    code === "407"
  ) {
    return true;
  }
  return /未登录|登录过期|请登录/i.test(errMsg(body, error || ""));
}

export async function listCallLogs(
  client: ApiJsonClient,
  opts?: {
    operation?: string;
    ok?: boolean;
    limit?: number;
    login?: string;
    password?: string;
  },
): Promise<CallLogRow[]> {
  const want = Math.min(Math.max(opts?.limit ?? 50, 1), 500);
  // Demo APIJSON rejects @role ADMIN — LOGIN session is enough for Call Access.
  const filter: Record<string, unknown> = {
    "@order": "date-",
  };
  if (opts?.operation) filter.operation = opts.operation.toLowerCase();
  if (opts?.ok === true) filter.ok = 1;
  if (opts?.ok === false) filter.ok = 0;

  const session = await ensureAdminSession(
    client,
    opts?.login,
    opts?.password,
    { force: true },
  );
  if (!session.ok) {
    throw new Error(session.error || "APIJSON admin login failed");
  }

  const out: CallLogRow[] = [];
  const pages = Math.ceil(want / PAGE_SIZE);
  for (let page = 0; page < pages; page++) {
    const count = Math.min(PAGE_SIZE, want - out.length);
    const query = {
      "[]": {
        count,
        page,
        Call: filter,
      },
    };
    let res = await client.execute("get", query);
    if (isUnauthorized(res.body, res.error)) {
      const again = await ensureAdminSession(
        client,
        opts?.login,
        opts?.password,
        { force: true },
      );
      if (!again.ok) {
        throw new Error(again.error || "APIJSON admin login failed");
      }
      res = await client.execute("get", query);
    }
    if (!res.ok || !resultOk(res.body)) {
      throw new Error(res.error || errMsg(res.body, "list Call failed"));
    }
    const batch = rowsFromList(res.body, "Call");
    out.push(...batch);
    if (batch.length < count) break;
  }
  return out;
}

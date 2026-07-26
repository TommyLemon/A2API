/**
 * List Call logs via APIJSON with admin session (BFF).
 */

import type { ApiJsonClient } from "@a2api/runtime";
import { ensureAdminSession } from "./approve-writer.js";
import {
  clampPage,
  clampPageSize,
  normalizeOrder,
  parseTotal,
} from "./list-query.js";

export type CallLogRow = Record<string, unknown>;

export const CALL_ORDER_FIELDS = [
  "date",
  "id",
  "durationMs",
  "operation",
  "ok",
  "source",
  "bizTable",
] as const;

export type CallListQuery = {
  operation?: string;
  ok?: boolean;
  source?: string;
  table?: string;
  q?: string;
  page?: number;
  pageSize?: number;
  /** @deprecated use pageSize */
  limit?: number;
  order?: string;
  login?: string;
  password?: string;
};

export type CallListResult = {
  items: CallLogRow[];
  total: number;
  page: number;
  pageSize: number;
  order: string;
};

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
  opts?: CallListQuery,
): Promise<CallListResult> {
  const page = clampPage(opts?.page, 0);
  const pageSize = clampPageSize(
    opts?.pageSize ?? opts?.limit,
    20,
  );
  const order = normalizeOrder(opts?.order, CALL_ORDER_FIELDS, "date-");

  // Demo APIJSON rejects @role ADMIN — LOGIN session is enough for Call Access.
  const filter: Record<string, unknown> = {
    "@order": order,
  };
  if (opts?.operation) filter.operation = opts.operation.toLowerCase();
  if (opts?.ok === true) filter.ok = 1;
  if (opts?.ok === false) filter.ok = 0;
  if (opts?.source?.trim()) filter.source = opts.source.trim();
  if (opts?.table?.trim()) filter.bizTable$ = `%${opts.table.trim()}%`;
  if (opts?.q?.trim()) {
    const needle = `%${opts.q.trim()}%`;
    filter.bizTable$ = needle;
    filter.tag$ = needle;
    filter.submitter$ = needle;
    filter.url$ = needle;
    filter.source$ = needle;
    filter["@combine"] = "bizTable$ | tag$ | submitter$ | url$ | source$";
  }

  const session = await ensureAdminSession(
    client,
    opts?.login,
    opts?.password,
    { force: true },
  );
  if (!session.ok) {
    throw new Error(session.error || "APIJSON admin login failed");
  }

  const query = {
    "[]": {
      count: pageSize,
      page,
      query: 2,
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

  const items = rowsFromList(res.body, "Call");
  const reported = parseTotal(res.body, -1);
  const total =
    reported >= 0
      ? reported
      : items.length < pageSize
        ? page * pageSize + items.length
        : (page + 1) * pageSize + 1;

  return {
    items,
    total: Math.max(total, items.length),
    page,
    pageSize,
    order,
  };
}

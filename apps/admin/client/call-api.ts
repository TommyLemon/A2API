/** Call table read + client-side stats via APIJSON HTTP. */

import {
  apijsonPost,
  ensureApijson,
  isUnauthorizedCode,
  notifySessionExpired,
  rowsFromList,
} from "./aj-http.js";

export type CallLog = {
  id: string;
  userId?: number | string;
  submitter?: string;
  sessionId?: string;
  requestId?: string;
  source: string;
  operation: string;
  method: string;
  type: string;
  url: string;
  bizTable?: string;
  tag?: string;
  role?: string;
  request?: string;
  response?: string;
  ok: boolean;
  code?: number;
  durationMs?: number;
  usedLlm: boolean;
  error?: string;
  detail?: string;
  date: string;
};

export type CallStats = {
  total: number;
  ok: number;
  failed: number;
  avgDurationMs: number | null;
  usedLlm: number;
  byOperation: Array<{ key: string; total: number; ok: number; failed: number }>;
  byTable: Array<{ key: string; total: number; ok: number; failed: number }>;
  bySource: Array<{ key: string; total: number; ok: number; failed: number }>;
  byDay: Array<{ key: string; total: number; ok: number; failed: number }>;
  topErrors: Array<{ key: string; count: number }>;
};

function isoFromSql(v: unknown): string {
  if (v == null || v === "") return new Date().toISOString();
  const s = String(v);
  const d = new Date(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

function rowToCall(row: Record<string, unknown>): CallLog {
  return {
    id: String(row.id ?? ""),
    userId: row.userId != null ? (row.userId as number | string) : undefined,
    submitter: row.submitter != null ? String(row.submitter) : undefined,
    sessionId: row.sessionId != null ? String(row.sessionId) : undefined,
    requestId: row.requestId != null ? String(row.requestId) : undefined,
    source: String(row.source || "unknown"),
    operation: String(row.operation || "").toLowerCase(),
    method: String(row.method || "POST").toUpperCase(),
    type: String(row.type || "JSON").toUpperCase(),
    url: String(row.url || ""),
    bizTable: row.bizTable != null ? String(row.bizTable) : undefined,
    tag: row.tag != null ? String(row.tag) : undefined,
    role: row.role != null ? String(row.role) : undefined,
    request: row.request != null ? String(row.request) : undefined,
    response: row.response != null ? String(row.response) : undefined,
    ok: row.ok === 1 || row.ok === true || row.ok === "1",
    code: row.code != null ? Number(row.code) : undefined,
    durationMs: row.durationMs != null ? Number(row.durationMs) : undefined,
    usedLlm: row.usedLlm === 1 || row.usedLlm === true || row.usedLlm === "1",
    error: row.error != null ? String(row.error) : undefined,
    detail: row.detail != null ? String(row.detail) : undefined,
    date: isoFromSql(row.date),
  };
}

function bump(
  map: Map<string, { total: number; ok: number; failed: number }>,
  key: string,
  ok: boolean,
) {
  const k = key || "(none)";
  const cur = map.get(k) || { total: 0, ok: 0, failed: 0 };
  cur.total += 1;
  if (ok) cur.ok += 1;
  else cur.failed += 1;
  map.set(k, cur);
}

export function computeCallStats(items: CallLog[]): CallStats {
  const byOperation = new Map<string, { total: number; ok: number; failed: number }>();
  const byTable = new Map<string, { total: number; ok: number; failed: number }>();
  const bySource = new Map<string, { total: number; ok: number; failed: number }>();
  const byDay = new Map<string, { total: number; ok: number; failed: number }>();
  const errCounts = new Map<string, number>();
  let ok = 0;
  let failed = 0;
  let usedLlm = 0;
  let durationSum = 0;
  let durationN = 0;

  for (const c of items) {
    if (c.ok) ok += 1;
    else failed += 1;
    if (c.usedLlm) usedLlm += 1;
    if (typeof c.durationMs === "number" && !Number.isNaN(c.durationMs)) {
      durationSum += c.durationMs;
      durationN += 1;
    }
    bump(byOperation, c.operation, c.ok);
    bump(byTable, c.bizTable || "(none)", c.ok);
    bump(bySource, c.source || "unknown", c.ok);
    bump(byDay, c.date.slice(0, 10), c.ok);
    if (!c.ok && c.error) {
      const e = c.error.slice(0, 120);
      errCounts.set(e, (errCounts.get(e) || 0) + 1);
    }
  }

  const toArr = (
    m: Map<string, { total: number; ok: number; failed: number }>,
  ) =>
    [...m.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.total - a.total);

  return {
    total: items.length,
    ok,
    failed,
    avgDurationMs: durationN ? Math.round(durationSum / durationN) : null,
    usedLlm,
    byOperation: toArr(byOperation),
    byTable: toArr(byTable),
    bySource: toArr(bySource),
    byDay: toArr(byDay).sort((a, b) => a.key.localeCompare(b.key)),
    topErrors: [...errCounts.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15),
  };
}

export async function listCalls(opts?: {
  operation?: string;
  ok?: boolean;
  limit?: number;
}): Promise<CallLog[]> {
  // APIJSON Demo max []/count is 100; BFF pages if higher is requested.
  const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 500);
  // Prefer BFF (admin session) — browser LOGIN often hits missing/stale Call Access.
  try {
    const q = new URLSearchParams();
    q.set("limit", String(limit));
    if (opts?.operation) q.set("operation", opts.operation);
    if (opts?.ok === true) q.set("ok", "true");
    if (opts?.ok === false) q.set("ok", "false");
    const res = await fetch(`/api/calls?${q}`);
    const text = await res.text();
    let data: {
      items?: Record<string, unknown>[];
      error?: string;
      code?: number | string;
      msg?: string;
    };
    try {
      data = (text ? JSON.parse(text) : {}) as typeof data;
    } catch {
      throw new Error(
        `Invalid JSON from /api/calls (HTTP ${res.status}): ${text.slice(0, 120)}`,
      );
    }
    if (isUnauthorizedCode(data.code)) {
      notifySessionExpired();
      throw new Error(data.msg || data.error || "Unauthorized");
    }
    if (!res.ok) {
      throw new Error(data.error || res.statusText);
    }
    if (Array.isArray(data.items)) {
      return data.items.map(rowToCall);
    }
  } catch (bffErr) {
    // Fall back to direct APIJSON if BFF unavailable
    try {
      await ensureApijson();
      const filter: Record<string, unknown> = {
        "@order": "date-",
      };
      if (opts?.operation) filter.operation = opts.operation.toLowerCase();
      if (opts?.ok === true) filter.ok = 1;
      if (opts?.ok === false) filter.ok = 0;
      const data = await apijsonPost("get", {
        "[]": {
          count: Math.min(limit, 100),
          Call: filter,
        },
      });
      return rowsFromList(data, "Call").map(rowToCall);
    } catch {
      throw bffErr instanceof Error ? bffErr : new Error(String(bffErr));
    }
  }
  return [];
}

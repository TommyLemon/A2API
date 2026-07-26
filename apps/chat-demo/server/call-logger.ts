/**
 * Fire-and-forget Call rows via APIJSON Server HTTP (`POST /post` tag=Call).
 */

import type { ApiJsonClient } from "@a2api/runtime";

const MAX_TEXT = 4000;

export type CallLogPayload = {
  userId?: number | string;
  submitter?: string;
  sessionId?: string;
  requestId?: string;
  source?: string;
  operation: string;
  method?: string;
  type?: string;
  url: string;
  bizTable?: string;
  tag?: string;
  role?: string;
  request?: unknown;
  response?: unknown;
  ok: boolean;
  code?: number;
  durationMs?: number;
  usedLlm?: boolean;
  error?: string;
  detail?: string;
};

function truncateJson(v: unknown): string | null {
  if (v == null) return null;
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s;
  } catch {
    return String(v).slice(0, MAX_TEXT);
  }
}

function sqlDate(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/** Best-effort; never throws to callers. */
export function logApiCall(
  client: ApiJsonClient,
  payload: CallLogPayload,
): void {
  if (!payload.operation?.trim() || !payload.url?.trim()) return;
  const row = {
    id: Date.now(),
    userId: payload.userId ?? null,
    submitter: payload.submitter ?? null,
    sessionId: payload.sessionId ?? null,
    requestId: payload.requestId ?? null,
    source: payload.source || "unknown",
    operation: payload.operation.toLowerCase(),
    method: (payload.method || "POST").toUpperCase(),
    type: (payload.type || "JSON").toUpperCase(),
    url: payload.url.trim(),
    bizTable: payload.bizTable ?? null,
    tag: payload.tag ?? null,
    role: payload.role ?? null,
    request: truncateJson(payload.request),
    response: truncateJson(payload.response),
    ok: payload.ok ? 1 : 0,
    code: payload.code ?? null,
    durationMs: payload.durationMs ?? null,
    usedLlm: payload.usedLlm ? 1 : 0,
    error: payload.error ?? null,
    detail: payload.detail ?? null,
    date: sqlDate(),
  };
  void client
    .execute("post", { Call: row, tag: "Call" })
    .catch(() => {
      /* ignore logging failures */
    });
}

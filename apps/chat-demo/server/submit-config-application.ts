/**
 * Submit permission-gate Apply via admin BFF (`POST /api/applications`).
 */

import { extractRequestTables } from "@a2api/protocol";
import type { PendingRequest } from "@a2api/runtime";

function opFromPending(pending: PendingRequest): string {
  if (pending.method) return pending.method.toLowerCase();
  const url = pending.url || "";
  const last = url.split("?")[0]?.split("/").filter(Boolean).pop() || "";
  return last.toLowerCase() || "get";
}

function roleFromBody(body: Record<string, unknown>, op: string): string {
  const top = body["@role"];
  if (typeof top === "string" && top.trim()) return top.trim().toUpperCase();
  return op === "get" || op === "head" ? "LOGIN" : "OWNER";
}

function adminBaseUrl(): string {
  return (
    process.env.ADMIN_BASE_URL?.replace(/\/+$/, "") ||
    `http://127.0.0.1:${process.env.ADMIN_PORT || 3001}`
  );
}

export async function submitConfigApplication(opts: {
  pending: PendingRequest;
  sessionId?: string;
  submitter?: string;
  apijsonBaseUrl?: string;
  /** @deprecated unused — Apply goes through admin API */
  client?: unknown;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const { pending } = opts;
  if (!pending.permissionGate && !pending.sensitive) {
    return { ok: false, error: "not a config application" };
  }
  if (!pending.permissionGate) {
    return { ok: false, error: "skip non-permission-gate" };
  }

  const tables = extractRequestTables(pending.body);
  const tag =
    typeof pending.body.tag === "string" ? pending.body.tag.trim() : "";
  const table = tag || tables[0] || "Unknown";
  const operation = opFromPending(pending);
  const version =
    typeof pending.body.version === "number" && pending.body.version > 0
      ? pending.body.version
      : 1;
  const base =
    opts.apijsonBaseUrl?.replace(/\/+$/, "") ||
    process.env.APIJSON_BASE_URL?.replace(/\/+$/, "") ||
    "http://localhost:8080";
  const url = pending.url || `${base}/${operation}`;

  try {
    const res = await fetch(`${adminBaseUrl()}/api/applications`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        table,
        operation,
        role: roleFromBody(pending.body, operation),
        version,
        method: "POST",
        type: "JSON",
        url,
        json: pending.body,
        tag: tag || table,
        name: `${operation.toUpperCase()} ${table}`,
        detail:
          pending.rationale ||
          pending.issues?.join("; ") ||
          "Permission gate — needs Access/Request",
        requestId: pending.requestId,
        sessionId: opts.sessionId,
        submitter: opts.submitter,
        issues: pending.issues,
      }),
    });
    const data = (await res.json().catch(() => null)) as {
      item?: { id?: string | number };
      error?: string;
    } | null;
    if (!res.ok) {
      return {
        ok: false,
        error: data?.error || `admin Apply submit failed (${res.status})`,
      };
    }
    const id = data?.item?.id;
    return { ok: true, id: id != null ? String(id) : undefined };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

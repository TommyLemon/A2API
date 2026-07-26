/**
 * Build available API catalog from Access + Request + Document via APIJSON.
 */

import { ApiJsonClient } from "@a2api/runtime";
import { ensureAdminSession } from "./approve-writer.js";

export type AvailableRequest = {
  /** APIJSON path method: get/post/put/… */
  operation: string;
  /** Request.tag (or Access.alias for open GET/HEAD) */
  tag: string;
  version: number;
  structure?: Record<string, unknown>;
  detail?: string;
  /** Access alias / name */
  accessAlias?: string;
  accessName?: string;
  /** Roles allowed for this operation from Access */
  roles: string[];
  /** Linked Document sample if found */
  document?: {
    id: string | number;
    name?: string;
    method?: string;
    type?: string;
    url?: string;
    request?: string;
    operation?: string;
  };
  /** true when no Request row (open GET/HEAD style) */
  open?: boolean;
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
  return code === 200 || code === "200";
}

function parseRoles(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const p = JSON.parse(raw) as unknown;
    if (Array.isArray(p)) return p.map(String);
  } catch {
    /* csv */
  }
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseStructure(raw: unknown): Record<string, unknown> | undefined {
  if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      const p = JSON.parse(raw) as unknown;
      if (p && typeof p === "object" && !Array.isArray(p)) {
        return p as Record<string, unknown>;
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

async function listTable(
  client: ApiJsonClient,
  table: string,
  column?: string,
  pages = 20,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let page = 0; page < pages; page++) {
    const body: Record<string, unknown> = {
      "[]": {
        count: 100,
        page,
        [table]: column ? { "@column": column } : {},
      },
    };
    const res = await client.execute("get", body);
    if (!res.ok || !resultOk(res.body)) break;
    const arr = asRecord(res.body)?.["[]"];
    if (!Array.isArray(arr) || !arr.length) break;
    for (const wrap of arr) {
      const w = asRecord(wrap);
      const row = asRecord(w?.[table]);
      if (row) out.push(row);
    }
    if (arr.length < 100) break;
  }
  return out;
}

const OPS = [
  "get",
  "head",
  "gets",
  "heads",
  "post",
  "put",
  "delete",
] as const;

function docKey(method: string, tag: string, url?: string): string[] {
  const keys = [
    `${method.toUpperCase()}::${tag}`,
    tag,
    method.toLowerCase(),
  ];
  if (url) {
    keys.push(url);
    const last = url.split("?")[0]?.split("/").filter(Boolean).pop();
    if (last) keys.push(last.toLowerCase());
  }
  return keys;
}

export async function loadAvailableRequests(
  client: ApiJsonClient,
): Promise<AvailableRequest[]> {
  const session = await ensureAdminSession(client);
  if (!session.ok) {
    throw new Error(session.error || "APIJSON login failed");
  }

  const [accessRows, requestRows, documentRows] = await Promise.all([
    listTable(
      client,
      "Access",
      "id,name,alias,get,head,gets,heads,post,put,delete,detail",
    ),
    listTable(client, "Request", "id,method,tag,version,structure,detail"),
    listTable(
      client,
      "Document",
      "id,name,operation,method,type,url,request,apijson,version,detail",
    ),
  ]);

  const accessByKey = new Map<string, Record<string, unknown>>();
  for (const a of accessRows) {
    const alias = String(a.alias ?? "").trim();
    const name = String(a.name ?? "").trim();
    if (alias) accessByKey.set(alias, a);
    if (name) accessByKey.set(name, a);
  }

  const docsByKey = new Map<string, Record<string, unknown>>();
  for (const d of documentRows) {
    const name = String(d.name ?? "").trim();
    const op = String(d.operation ?? "").trim();
    const url = String(d.url ?? "").trim();
    const method = String(d.method ?? "POST").trim();
    for (const k of [name, op, url, ...docKey(method, name || op, url)]) {
      if (k && !docsByKey.has(k)) docsByKey.set(k, d);
    }
  }

  const pickDoc = (
    operation: string,
    tag: string,
  ): AvailableRequest["document"] | undefined => {
    const candidates = [
      tag,
      `${operation.toUpperCase()} ${tag}`,
      `${operation.toUpperCase()}::${tag}`,
      operation.toLowerCase(),
      `/${operation.toLowerCase()}`,
    ];
    for (const k of candidates) {
      const d = docsByKey.get(k);
      if (d) {
        return {
          id: d.id as string | number,
          name: d.name != null ? String(d.name) : undefined,
          method: d.method != null ? String(d.method) : undefined,
          type: d.type != null ? String(d.type) : undefined,
          url: d.url != null ? String(d.url) : undefined,
          request:
            d.request != null
              ? String(d.request)
              : d.apijson != null
                ? String(d.apijson)
                : undefined,
          operation: d.operation != null ? String(d.operation) : undefined,
        };
      }
    }
    // fuzzy: Document.url ends with /get|/post…
    for (const d of documentRows) {
      const url = String(d.url ?? "");
      if (url.toLowerCase().endsWith(`/${operation.toLowerCase()}`)) {
        const n = String(d.name ?? "").toLowerCase();
        if (n.includes(tag.toLowerCase()) || !tag) {
          return {
            id: d.id as string | number,
            name: d.name != null ? String(d.name) : undefined,
            method: d.method != null ? String(d.method) : undefined,
            type: d.type != null ? String(d.type) : undefined,
            url,
            request:
              d.request != null
                ? String(d.request)
                : d.apijson != null
                  ? String(d.apijson)
                  : undefined,
            operation: d.operation != null ? String(d.operation) : undefined,
          };
        }
      }
    }
    return undefined;
  };

  const out: AvailableRequest[] = [];
  const seen = new Set<string>();

  for (const r of requestRows) {
    const method = String(r.method ?? "").trim().toUpperCase();
    const tag = String(r.tag ?? "").trim();
    if (!method || !tag) continue;
    const operation = method.toLowerCase();
    if (!(OPS as readonly string[]).includes(operation)) continue;

    const access = accessByKey.get(tag);
    const roles = access ? parseRoles(access[operation]) : [];
    // Skip if Access explicitly forbids (empty list) when Access row exists
    if (access && roles.length === 0) continue;

    const key = `${operation}::${tag}::${Number(r.version) || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      operation,
      tag,
      version: Number(r.version) || 0,
      structure: parseStructure(r.structure),
      detail: typeof r.detail === "string" ? r.detail : undefined,
      accessAlias: access
        ? String(access.alias || access.name || tag)
        : tag,
      accessName: access ? String(access.name || "") || undefined : undefined,
      roles: roles.length ? roles : ["UNKNOWN"],
      document: pickDoc(operation, tag),
      open: false,
    });
  }

  // Open GET/HEAD from Access without Request tag
  for (const a of accessRows) {
    const alias = String(a.alias || a.name || "").trim();
    if (!alias) continue;
    for (const operation of ["get", "head"] as const) {
      const roles = parseRoles(a[operation]);
      if (!roles.length) continue;
      const key = `${operation}::${alias}::open`;
      if (seen.has(`${operation}::${alias}::0`) || seen.has(key)) continue;
      // only add open entry if no Request-backed row for same tag+op
      if ([...seen].some((s) => s.startsWith(`${operation}::${alias}::`))) {
        continue;
      }
      seen.add(key);
      out.push({
        operation,
        tag: alias,
        version: 0,
        detail: typeof a.detail === "string" ? a.detail : "Open Access GET/HEAD",
        accessAlias: alias,
        accessName: String(a.name || "") || undefined,
        roles,
        document: pickDoc(operation, alias),
        open: true,
      });
    }
  }

  out.sort((a, b) => {
    const t = a.tag.localeCompare(b.tag);
    if (t) return t;
    return a.operation.localeCompare(b.operation);
  });
  return out;
}

export type WriteGateDecision = "call" | "apply" | "try";

export type WriteGate = {
  operation: string;
  tag: string;
  decision: WriteGateDecision;
  roles: string[];
  document: AvailableRequest["document"] | null;
  reason: string;
};

/**
 * Edit/delete gate from Document + Access:
 * - Document found + Access roles for op → call
 * - Document found + no Access → apply (do not call)
 * - No Document → try (call; apply only after permission error)
 */
export async function resolveWriteGate(
  client: ApiJsonClient,
  operation: string,
  tag: string,
): Promise<WriteGate> {
  const op = operation.trim().toLowerCase();
  const t = tag.trim();
  const session = await ensureAdminSession(client);
  if (!session.ok) {
    throw new Error(session.error || "APIJSON login failed");
  }
  if (!op || !t) {
    return {
      operation: op,
      tag: t,
      decision: "try",
      roles: [],
      document: null,
      reason: "Missing operation or tag — try then apply on permission error",
    };
  }

  const [accessRows, documentRows] = await Promise.all([
    listTable(
      client,
      "Access",
      "id,name,alias,get,head,gets,heads,post,put,delete,detail",
    ),
    listTable(
      client,
      "Document",
      "id,name,operation,method,type,url,request,apijson,version,detail",
    ),
  ]);

  const accessByKey = new Map<string, Record<string, unknown>>();
  for (const a of accessRows) {
    const alias = String(a.alias ?? "").trim();
    const name = String(a.name ?? "").trim();
    if (alias) accessByKey.set(alias, a);
    if (name) accessByKey.set(name, a);
  }

  const toDoc = (
    d: Record<string, unknown>,
  ): AvailableRequest["document"] => ({
    id: d.id as string | number,
    name: d.name != null ? String(d.name) : undefined,
    method: d.method != null ? String(d.method) : undefined,
    type: d.type != null ? String(d.type) : undefined,
    url: d.url != null ? String(d.url) : undefined,
    request:
      d.request != null
        ? String(d.request)
        : d.apijson != null
          ? String(d.apijson)
          : undefined,
    operation: d.operation != null ? String(d.operation) : undefined,
  });

  let document: AvailableRequest["document"] | null = null;
  const nameExact = `${op.toUpperCase()} ${t}`;
  for (const d of documentRows) {
    const name = String(d.name ?? "").trim();
    const dop = String(d.operation ?? "").trim().toLowerCase();
    const url = String(d.url ?? "").toLowerCase();
    if (
      name === nameExact ||
      name === t ||
      (dop === op && name.toLowerCase().includes(t.toLowerCase())) ||
      (url.endsWith(`/${op}`) && name.toLowerCase().includes(t.toLowerCase()))
    ) {
      document = toDoc(d);
      break;
    }
  }
  if (!document) {
    for (const d of documentRows) {
      const url = String(d.url ?? "").toLowerCase();
      const name = String(d.name ?? "").toLowerCase();
      if (url.endsWith(`/${op}`) && name.includes(t.toLowerCase())) {
        document = toDoc(d);
        break;
      }
    }
  }

  const access = accessByKey.get(t);
  const roles = access ? parseRoles(access[op]) : [];

  if (document) {
    if (roles.length > 0) {
      return {
        operation: op,
        tag: t,
        decision: "call",
        roles,
        document,
        reason: "Document found and Access allows this operation",
      };
    }
    return {
      operation: op,
      tag: t,
      decision: "apply",
      roles,
      document,
      reason:
        "Document found but Access has no roles for this operation — submit Apply",
    };
  }

  return {
    operation: op,
    tag: t,
    decision: "try",
    roles,
    document: null,
    reason: "No Document — try call; apply on permission error",
  };
}

/** Apply table CRUD via APIJSON HTTP (no custom REST). */

import {
  apijsonPost,
  ensureApijson,
  rowsFromList,
  sqlDate,
} from "./aj-http.js";

export type ApplicationStatus = "pending" | "approved" | "rejected";

export type ConfigApplication = {
  id: string;
  status: ApplicationStatus;
  createdAt: string;
  updatedAt?: string;
  decidedAt?: string;
  decidedBy?: string;
  table: string;
  operation: string;
  role: string;
  version: number;
  method: string;
  type: string;
  url: string;
  json: Record<string, unknown>;
  tag?: string;
  structure?: Record<string, unknown>;
  accessAlias?: string;
  accessName?: string;
  name?: string;
  detail?: string;
  requestId?: string;
  sessionId?: string;
  submitter?: string;
  issues?: string[];
  writeResults?: Record<string, unknown>;
  error?: string;
};

function parseJsonField<T>(raw: unknown, fallback: T): T {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "object") return raw as T;
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isoFromSql(v: unknown): string | undefined {
  if (v == null || v === "") return undefined;
  const s = String(v);
  const d = new Date(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

export function rowToApp(row: Record<string, unknown>): ConfigApplication {
  const status = String(row.status || "pending") as ApplicationStatus;
  return {
    id: String(row.id ?? ""),
    status:
      status === "approved" || status === "rejected" || status === "pending"
        ? status
        : "pending",
    createdAt: isoFromSql(row.date) || new Date().toISOString(),
    updatedAt: isoFromSql(row.updatedAt),
    decidedAt: isoFromSql(row.decidedAt),
    decidedBy: row.decidedBy != null ? String(row.decidedBy) : undefined,
    table: String(row.bizTable || ""),
    operation: String(row.operation || "").toLowerCase(),
    role: String(row.role || "OWNER").toUpperCase(),
    version: Number(row.version) > 0 ? Number(row.version) : 1,
    method: String(row.method || "POST").toUpperCase(),
    type: String(row.type || "JSON").toUpperCase(),
    url: String(row.url || ""),
    json: parseJsonField(row.request, {}),
    tag: row.tag != null ? String(row.tag) : undefined,
    structure: parseJsonField(row.structure, undefined),
    accessAlias: row.accessAlias != null ? String(row.accessAlias) : undefined,
    accessName: row.accessName != null ? String(row.accessName) : undefined,
    name: row.name != null ? String(row.name) : undefined,
    detail: row.detail != null ? String(row.detail) : undefined,
    requestId: row.requestId != null ? String(row.requestId) : undefined,
    sessionId: row.sessionId != null ? String(row.sessionId) : undefined,
    submitter: row.submitter != null ? String(row.submitter) : undefined,
    issues: parseJsonField(row.issues, undefined),
    writeResults: parseJsonField(row.writeResults, undefined),
    error: row.error != null ? String(row.error) : undefined,
  };
}

function appToRow(app: Partial<ConfigApplication> & { id: string }): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: /^\d+$/.test(app.id) ? Number(app.id) : app.id,
  };
  if (app.status != null) row.status = app.status;
  if (app.table != null) row.bizTable = app.table;
  if (app.operation != null) row.operation = app.operation;
  if (app.role != null) row.role = app.role;
  if (app.version != null) row.version = app.version;
  if (app.method != null) row.method = app.method;
  if (app.type != null) row.type = app.type;
  if (app.url != null) row.url = app.url;
  if (app.json != null) row.request = JSON.stringify(app.json);
  if (app.structure !== undefined) {
    row.structure =
      app.structure != null ? JSON.stringify(app.structure) : null;
  }
  if (app.tag !== undefined) row.tag = app.tag ?? null;
  if (app.accessAlias !== undefined) row.accessAlias = app.accessAlias ?? null;
  if (app.accessName !== undefined) row.accessName = app.accessName ?? null;
  if (app.name !== undefined) row.name = app.name ?? null;
  if (app.detail !== undefined) row.detail = app.detail ?? null;
  if (app.issues !== undefined) {
    row.issues = app.issues != null ? JSON.stringify(app.issues) : null;
  }
  if (app.writeResults !== undefined) {
    row.writeResults =
      app.writeResults != null ? JSON.stringify(app.writeResults) : null;
  }
  if (app.error !== undefined) row.error = app.error ?? null;
  if (app.decidedBy !== undefined) row.decidedBy = app.decidedBy ?? null;
  if (app.decidedAt !== undefined) {
    row.decidedAt = app.decidedAt ? sqlDate(app.decidedAt) : null;
  }
  row.updatedAt = sqlDate();
  return row;
}

export type ApplyListQuery = {
  status?: ApplicationStatus | ApplicationStatus[];
  operation?: string;
  table?: string;
  q?: string;
  page?: number;
  pageSize?: number;
  order?: string;
};

export type ApplyListResult = {
  items: ConfigApplication[];
  total: number;
  page: number;
  pageSize: number;
  order: string;
};

export async function listApplies(
  opts?: ApplyListQuery,
): Promise<ConfigApplication[]> {
  const result = await listAppliesPage(opts);
  return result.items;
}

export async function listAppliesPage(
  opts?: ApplyListQuery,
): Promise<ApplyListResult> {
  const page = Math.max(0, Math.floor(Number(opts?.page) || 0));
  const pageSize = Math.min(
    Math.max(Math.floor(Number(opts?.pageSize) || 20), 1),
    100,
  );
  const order = (opts?.order || "id-").trim() || "id-";
  await ensureApijson();
  const filter: Record<string, unknown> = { "@order": order };
  if (opts?.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    if (statuses.length === 1) filter.status = statuses[0];
    else if (statuses.length > 1) filter["status{}"] = statuses;
  }
  if (opts?.operation) filter.operation = opts.operation.toLowerCase();
  if (opts?.table?.trim()) filter.bizTable$ = `%${opts.table.trim()}%`;
  if (opts?.q?.trim()) {
    const needle = `%${opts.q.trim()}%`;
    filter.bizTable$ = needle;
    filter.tag$ = needle;
    filter.submitter$ = needle;
    filter.url$ = needle;
    filter["@combine"] = "bizTable$ | tag$ | submitter$ | url$";
  }
  const data = await apijsonPost("get", {
    "[]": {
      count: pageSize,
      page,
      query: 2,
      Apply: filter,
    },
  });
  const items = rowsFromList(data, "Apply").map(rowToApp);
  const totalRaw = (data as { total?: unknown }).total;
  const total =
    typeof totalRaw === "number"
      ? totalRaw
      : items.length < pageSize
        ? page * pageSize + items.length
        : (page + 1) * pageSize + 1;
  return { items, total, page, pageSize, order };
}

export async function getApply(id: string): Promise<ConfigApplication | null> {
  await ensureApijson();
  const key = /^\d+$/.test(id) ? Number(id) : id;
  const data = await apijsonPost("get", { Apply: { id: key } });
  const row = data.Apply;
  if (row == null || typeof row !== "object" || Array.isArray(row)) return null;
  return rowToApp(row as Record<string, unknown>);
}

export async function updateApply(
  id: string,
  patch: Partial<ConfigApplication>,
): Promise<ConfigApplication> {
  await ensureApijson();
  const existing = await getApply(id);
  if (!existing) throw new Error("not found");
  const next = { ...existing, ...patch, id };
  const data = await apijsonPost("put", {
    Apply: appToRow(next),
    tag: "Apply",
  });
  const row = data.Apply as Record<string, unknown> | undefined;
  return row ? rowToApp({ ...appToRow(next), ...row }) : next;
}

/**
 * Persist config applications + approval results in DB via APIJSON (`Apply`).
 * Requires apps/admin/sql/sys_Apply.sql applied + Access/Request reload.
 */

import { ApiJsonClient } from "@a2api/runtime";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ApplicationListQuery,
  type ApplicationListResult,
  type ApplicationStore,
  FileApplicationStore,
  buildNewApplication,
  normalizeApplyListQuery,
  normalizeOp,
  parseJsonBody,
} from "./application-store.js";
import { ensureAdminSession } from "./approve-writer.js";
import { parseTotal } from "./list-query.js";
import type {
  ApplicationStatus,
  ApplicationSubmitInput,
  ApplicationWriteResults,
  ConfigApplication,
  HttpBodyType,
} from "./types.js";

const TABLE = "Apply";
/** POST create tag/alias — avoids historic Apply POST Request that MUST:id while APIJSON refuses id. */
const CREATE_TAG = "A2Apply";

/** APIJSON Demo uses 407 for expired session; 401 also seen on some builds. */
function isUnauthorizedBody(body: unknown, error?: string): boolean {
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
  const msg = `${typeof root?.msg === "string" ? root.msg : ""} ${error || ""}`;
  return /未登录|登录过期|请登录|not logged|session\s*expired/i.test(msg);
}

const defaultFallbackPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "applications.jsonl",
);

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

function errMsg(body: unknown, fallback: string): string {
  const root = asRecord(body);
  const msg = root?.msg ?? root?.message;
  return typeof msg === "string" && msg.trim() ? msg : fallback;
}

function sqlDate(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 19).replace("T", " ");
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function isoFromSql(v: unknown): string | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number") return new Date(v).toISOString();
  const s = String(v).trim();
  if (!s) return undefined;
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return s;
  return d.toISOString();
}

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

function toNumericId(id: string): number {
  // Prefer numeric ids for APIJSON bigint PK; UUID → stable hash-ish timestamp id
  if (/^\d+$/.test(id)) return Number(id);
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  // Keep in 13-digit-ish range like Demo snowflakes
  return Number(`${Date.now()}${String(h % 1000).padStart(3, "0")}`.slice(0, 15));
}

function rowToApp(row: Record<string, unknown>): ConfigApplication {
  const id = row.id != null ? String(row.id) : "";
  const json = parseJsonField<Record<string, unknown>>(row.request, {});
  const structure = parseJsonField<Record<string, unknown> | undefined>(
    row.structure,
    undefined,
  );
  const issues = parseJsonField<string[] | undefined>(row.issues, undefined);
  const writeResults = parseJsonField<ApplicationWriteResults | undefined>(
    row.writeResults,
    undefined,
  );
  const status = String(row.status || "pending") as ApplicationStatus;
  return {
    id,
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
    type: String(row.type || "JSON").toUpperCase() as HttpBodyType,
    url: String(row.url || ""),
    json,
    tag: row.tag != null ? String(row.tag) : undefined,
    structure,
    accessAlias: row.accessAlias != null ? String(row.accessAlias) : undefined,
    accessName: row.accessName != null ? String(row.accessName) : undefined,
    name: row.name != null ? String(row.name) : undefined,
    detail: row.detail != null ? String(row.detail) : undefined,
    requestId: row.requestId != null ? String(row.requestId) : undefined,
    sessionId: row.sessionId != null ? String(row.sessionId) : undefined,
    submitter: row.submitter != null ? String(row.submitter) : undefined,
    issues: Array.isArray(issues) ? issues.map(String) : undefined,
    writeResults,
    error: row.error != null ? String(row.error) : undefined,
  };
}

function appToRow(
  app: ConfigApplication,
  opts?: { includeId?: boolean },
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    status: app.status,
    bizTable: app.table,
    operation: String(app.operation).toLowerCase(),
    role: app.role,
    version: app.version,
    method: app.method,
    type: app.type,
    url: app.url,
    request: JSON.stringify(app.json ?? {}),
    structure: app.structure != null ? JSON.stringify(app.structure) : null,
    tag: app.tag ?? null,
    accessAlias: app.accessAlias ?? null,
    accessName: app.accessName ?? null,
    name: app.name ?? null,
    detail: app.detail ?? null,
    requestId: app.requestId ?? null,
    sessionId: app.sessionId ?? null,
    submitter: app.submitter ?? null,
    issues: app.issues != null ? JSON.stringify(app.issues) : null,
    writeResults:
      app.writeResults != null ? JSON.stringify(app.writeResults) : null,
    error: app.error ?? null,
    decidedBy: app.decidedBy ?? null,
    decidedAt: app.decidedAt ? sqlDate(app.decidedAt) : null,
    date: sqlDate(app.createdAt),
    updatedAt: sqlDate(app.updatedAt || new Date().toISOString()),
  };
  if (opts?.includeId !== false && app.id) {
    row.id = /^\d+$/.test(app.id) ? Number(app.id) : toNumericId(app.id);
  }
  return row;
}

export class DbApplicationStore implements ApplicationStore {
  private readonly client: ApiJsonClient;
  private ready: Promise<void> | null = null;
  /** Used when APIJSON Apply POST Request is misconfigured (MUST id vs refuse id). */
  private readonly fallback: FileApplicationStore;

  constructor(client: ApiJsonClient, fallbackPath = defaultFallbackPath) {
    this.client = client;
    this.fallback = new FileApplicationStore(fallbackPath);
  }

  private async ensureSession(force = false): Promise<void> {
    if (force) {
      this.ready = null;
      this.client.cookie = "";
    }
    if (!this.ready) {
      this.ready = (async () => {
        const s = await ensureAdminSession(this.client, undefined, undefined, {
          force,
        });
        if (!s.ok) {
          this.ready = null;
          throw new Error(
            s.error ||
              "APIJSON admin login failed — set APIJSON_ADMIN_LOGIN/PASSWORD",
          );
        }
      })();
    }
    await this.ready;
  }

  private failHint(msg: string): Error {
    // Never blame SQL for auth / unsupported-role errors
    if (
      isUnauthorizedBody({ msg, code: 407 }, msg) ||
      /不支持\s*ADMIN|ADMIN\s*角色/i.test(msg)
    ) {
      return new Error(msg);
    }
    return new Error(
      `${msg}. Apply apps/admin/sql/sys_Apply.sql and reload Access/Request.`,
    );
  }

  async list(query?: ApplicationListQuery): Promise<ApplicationListResult> {
    const q = normalizeApplyListQuery(query);
    const statuses = q.status
      ? Array.isArray(q.status)
        ? q.status
        : [q.status]
      : null;

    const tableFilter: Record<string, unknown> = {
      "@order": q.order,
    };
    if (statuses?.length === 1) tableFilter.status = statuses[0];
    if (statuses && statuses.length > 1) tableFilter["status{}"] = statuses;
    if (q.operation) tableFilter.operation = q.operation.toLowerCase();
    if (q.table?.trim()) tableFilter.bizTable$ = `%${q.table.trim()}%`;
    if (q.q?.trim()) {
      // APIJSON combine: match table / tag / submitter / url
      const needle = `%${q.q.trim()}%`;
      tableFilter.bizTable$ = needle;
      tableFilter.tag$ = needle;
      tableFilter.submitter$ = needle;
      tableFilter.url$ = needle;
      tableFilter["@combine"] = "bizTable$ | tag$ | submitter$ | url$";
    }

    // Demo APIJSON does not support @role ADMIN (403). LOGIN session is enough.
    // query:2 asks Demo builds for total count when supported.
    const body: Record<string, unknown> = {
      "[]": {
        count: q.pageSize,
        page: q.page,
        query: 2,
        [TABLE]: tableFilter,
      },
    };

    const fetchRemote = async () =>
      this.client.execute("get", body, undefined, { injectRole: true });

    let res: Awaited<ReturnType<typeof fetchRemote>>;
    try {
      // Always re-login — shared client cookie goes stale across requests.
      await this.ensureSession(true);
      res = await fetchRemote();
      if (isUnauthorizedBody(res.body, res.error)) {
        await this.ensureSession(true);
        res = await fetchRemote();
      }
    } catch (e) {
      // Login failed — still show local JSONL applies
      const localOnly = await this.fallback.list(q);
      if (localOnly.total > 0) return localOnly;
      throw e instanceof Error ? e : new Error(String(e));
    }

    if (!res.ok || !resultOk(res.body)) {
      const localOnly = await this.fallback.list(q);
      if (isUnauthorizedBody(res.body, res.error)) {
        if (localOnly.total > 0) return localOnly;
        throw new Error(
          errMsg(res.body, res.error || "list Apply failed — please Login"),
        );
      }
      if (localOnly.total > 0) return localOnly;
      throw this.failHint(
        errMsg(res.body, res.error || "list Apply failed"),
      );
    }

    const root = asRecord(res.body);
    const arr = root?.["[]"];
    let items: ConfigApplication[] = [];
    if (Array.isArray(arr)) {
      for (const wrap of arr) {
        const w = asRecord(wrap);
        const row = asRecord(w?.[TABLE]);
        if (row) items.push(rowToApp(row));
      }
    }
    if (statuses && statuses.length > 1) {
      const want = new Set(statuses);
      items = items.filter((r) => want.has(r.status));
    }

    const reported = parseTotal(res.body, -1);
    let total =
      reported >= 0
        ? reported
        : items.length < q.pageSize
          ? q.page * q.pageSize + items.length
          : (q.page + 1) * q.pageSize + 1;

    // Merge local-only rows (JSONL fallback) onto page 0 so pending file applies stay visible.
    if (q.page === 0) {
      const local = await this.fallback.list({
        ...q,
        page: 0,
        pageSize: 100,
      });
      const seen = new Set(items.map((r) => r.id));
      const extras = local.items.filter((r) => !seen.has(r.id));
      if (extras.length) {
        items = [...extras, ...items].slice(0, q.pageSize);
        total += extras.length;
      }
    }

    return {
      items,
      total: Math.max(total, items.length),
      page: q.page,
      pageSize: q.pageSize,
      order: q.order,
    };
  }

  async get(id: string): Promise<ConfigApplication | null> {
    const fromFile = await this.fallback.get(id);
    if (fromFile) return fromFile;
    await this.ensureSession();
    const key = /^\d+$/.test(id) ? Number(id) : id;
    const res = await this.client.execute("get", {
      [TABLE]: { id: key },
    });
    if (!res.ok || !resultOk(res.body)) return null;
    const row = asRecord(asRecord(res.body)?.[TABLE]);
    return row ? rowToApp(row) : null;
  }

  async getByRequestId(requestId: string): Promise<ConfigApplication | null> {
    const fromFile = await this.fallback.getByRequestId(requestId);
    if (fromFile) return fromFile;
    await this.ensureSession();
    const res = await this.client.execute("get", {
      [TABLE]: {
        requestId,
        "@order": "id-",
      },
    });
    if (!res.ok || !resultOk(res.body)) return null;
    const row = asRecord(asRecord(res.body)?.[TABLE]);
    return row ? rowToApp(row) : null;
  }

  async submit(input: ApplicationSubmitInput): Promise<ConfigApplication> {
    await this.ensureSession();

    if (input.requestId) {
      const existing = await this.getByRequestId(input.requestId);
      if (existing && existing.status === "pending") {
        return (await this.update(existing.id, {
          table: input.table.trim(),
          operation: normalizeOp(input.operation),
          role: (input.role || "OWNER").toUpperCase(),
          version: input.version && input.version > 0 ? input.version : 1,
          method: input.method.toUpperCase(),
          type: (input.type || "JSON") as HttpBodyType,
          url: input.url.trim(),
          json: parseJsonBody(input.json),
          tag: input.tag?.trim() || input.table.trim(),
          structure: input.structure,
          accessAlias: input.accessAlias?.trim(),
          accessName: input.accessName?.trim(),
          name: input.name?.trim(),
          detail: input.detail,
          sessionId: input.sessionId,
          submitter: input.submitter,
          issues: input.issues,
        }))!;
      }
    }

    const app = buildNewApplication(input);
    const row = appToRow(app, { includeId: false });

    // 1) Prefer Apply alias (fixed Request without MUST:id)
    let res = await this.client.execute("post", {
      [CREATE_TAG]: row,
      tag: CREATE_TAG,
    });
    // 2) Legacy tag Apply
    if (!res.ok || !resultOk(res.body)) {
      res = await this.client.execute("post", {
        [TABLE]: row,
        tag: TABLE,
      });
    }
    if (res.ok && resultOk(res.body)) {
      const created =
        asRecord(asRecord(res.body)?.[CREATE_TAG]) ||
        asRecord(asRecord(res.body)?.[TABLE]);
      if (created?.id != null) app.id = String(created.id);
      else if (!/^\d+$/.test(app.id)) app.id = String(Date.now());
      return app;
    }

    // 3) Local JSONL fallback so chat-demo Apply submit never hard-fails on Request misconfig
    const local = await this.fallback.submit(input);
    local.detail = [
      local.detail,
      `stored locally (APIJSON: ${errMsg(res.body, res.error || "POST failed")}). Run apps/admin/sql/patch_Apply_post_request.sql + reload Request for DB persistence.`,
    ]
      .filter(Boolean)
      .join(" | ");
    await this.fallback.update(local.id, { detail: local.detail });
    return local;
  }

  async update(
    id: string,
    patch: Partial<ConfigApplication>,
  ): Promise<ConfigApplication | null> {
    const fromFile = await this.fallback.get(id);
    if (fromFile) {
      return this.fallback.update(id, patch);
    }

    await this.ensureSession();
    const existing = await this.get(id);
    if (!existing) return null;

    const { id: _i, createdAt: _c, ...rest } = patch;
    const next: ConfigApplication = {
      ...existing,
      ...rest,
      updatedAt: new Date().toISOString(),
    };

    const row = appToRow(next, { includeId: true });
    // PUT must include id; avoid rewriting created date unless present
    row.date = sqlDate(existing.createdAt);

    const res = await this.client.execute("put", {
      [TABLE]: row,
      tag: TABLE,
    });
    if (!res.ok || !resultOk(res.body)) {
      throw this.failHint(
        errMsg(res.body, res.error || "PUT Apply failed"),
      );
    }
    return next;
  }
}

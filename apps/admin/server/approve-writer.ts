/**
 * On approve: write Access / Request / Document / Chain via APIJSON.
 * Schemas align with APIJSON-Demo StarRocks/MySQL quickstart_*.sql / sys_*.sql.
 *
 * Writes rely on an APIJSON admin session (login); runtime strips client `@role` on POST/PUT.
 */

import { ApiJsonClient } from "@a2api/runtime";
import {
  enrichApplication,
  mergeRole,
  opFromUrl,
  rolesJson,
} from "./infer.js";
import type {
  ApplicationWriteResults,
  ConfigApplication,
  WriteTargetResult,
} from "./types.js";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function pickId(body: unknown, table: string): number | string | undefined {
  const root = asRecord(body);
  if (!root) return undefined;
  const row = asRecord(root[table]);
  const id = row?.id ?? root[`${table}Id`] ?? root.id;
  if (typeof id === "number" || typeof id === "string") return id;
  return undefined;
}

function resultOk(body: unknown): boolean {
  const root = asRecord(body);
  if (!root) return false;
  const code = root.code;
  return code === 200 || code === "200";
}

function errFrom(body: unknown, fallback: string): string {
  const root = asRecord(body);
  const msg = root?.msg ?? root?.message;
  return typeof msg === "string" && msg.trim() ? msg : fallback;
}

/** POST/PUT via ApiJsonClient (session auth + Request INSERT defaults). */
async function rawPost(
  client: ApiJsonClient,
  method: "get" | "post" | "put",
  body: Record<string, unknown>,
): Promise<WriteTargetResult> {
  const res = await client.execute(method, body);
  if (!res.ok || !resultOk(res.body)) {
    const table = Object.keys(body).find((k) => /^[A-Z]/.test(k)) || "Row";
    return {
      ok: false,
      action: method === "get" ? "skip" : method,
      error: res.error || errFrom(res.body, `${table} ${method.toUpperCase()} failed`),
      body: res.body,
    };
  }
  const table = Object.keys(body).find((k) => /^[A-Z]/.test(k)) || "";
  return {
    ok: true,
    action: method === "get" ? "skip" : method,
    id: table ? pickId(res.body, table) : undefined,
    body: res.body,
  };
}

async function postTable(
  client: ApiJsonClient,
  table: string,
  row: Record<string, unknown>,
  tag?: string,
): Promise<WriteTargetResult> {
  return rawPost(client, "post", {
    [table]: row,
    tag: tag || table,
  });
}

async function putTable(
  client: ApiJsonClient,
  table: string,
  row: Record<string, unknown>,
  tag?: string,
): Promise<WriteTargetResult> {
  return rawPost(client, "put", {
    [table]: row,
    tag: tag || table,
  });
}

async function findAccess(
  client: ApiJsonClient,
  alias: string,
  name?: string,
): Promise<Record<string, unknown> | null> {
  const tries: Record<string, unknown>[] = [];
  if (alias) {
    tries.push({
      Access: {
        alias,
        "@column":
          "id,debug,schema,name,alias,get,head,gets,heads,post,put,delete,detail",
      },
    });
  }
  if (name && name !== alias) {
    tries.push({
      Access: {
        name,
        "@column":
          "id,debug,schema,name,alias,get,head,gets,heads,post,put,delete,detail",
      },
    });
  }
  if (alias) {
    tries.push({
      Access: {
        name: alias,
        "@column":
          "id,debug,schema,name,alias,get,head,gets,heads,post,put,delete,detail",
      },
    });
  }

  for (const body of tries) {
    const res = await client.execute("get", body);
    if (!res.ok || !resultOk(res.body)) continue;
    const root = asRecord(res.body);
    const row = asRecord(root?.Access);
    if (row?.id != null) return row;
  }
  return null;
}

async function writeAccess(
  client: ApiJsonClient,
  app: ConfigApplication,
): Promise<WriteTargetResult> {
  const op = String(app.operation || opFromUrl(app.url) || "get").toLowerCase();
  const alias = app.accessAlias || app.table;
  const name = app.accessName || alias;
  const existing = await findAccess(client, alias, app.accessName);

  if (existing?.id != null) {
    const patched = {
      id: existing.id,
      [op]: mergeRole(existing[op], app.role),
      detail:
        typeof existing.detail === "string" && existing.detail.trim()
          ? existing.detail
          : app.detail || `A2API admin grant ${op} ${app.role}`,
    };
    const put = await putTable(client, "Access", patched, "Access");
    if (put.ok) return put;
  }

  const empty = rolesJson([]);
  const row: Record<string, unknown> = {
    debug: 0,
    name,
    alias,
    get: empty,
    head: empty,
    gets: empty,
    heads: empty,
    post: empty,
    put: empty,
    delete: empty,
    detail: app.detail || `A2API admin created for ${op} ${app.role}`,
  };
  row[op] = mergeRole([], app.role);
  if (op === "post" || op === "put" || op === "delete") {
    row.get = mergeRole([], "LOGIN");
    row.head = mergeRole([], "LOGIN");
  }
  return postTable(client, "Access", row, "Access");
}

async function writeRequest(
  client: ApiJsonClient,
  app: ConfigApplication,
): Promise<WriteTargetResult> {
  const method = String(app.operation || "get").toUpperCase();
  const tag = app.tag || app.table;
  const structure = app.structure || {};
  const row: Record<string, unknown> = {
    debug: 0,
    version: app.version > 0 ? app.version : 1,
    method,
    tag,
    structure,
    detail:
      app.detail ||
      `A2API approved: ${method} ${tag} v${app.version} role=${app.role}`,
  };
  return postTable(client, "Request", row, "Request");
}

function jsonText(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

async function writeDocument(
  client: ApiJsonClient,
  app: ConfigApplication,
  userId: number,
): Promise<WriteTargetResult> {
  const requestText = jsonText(app.json);
  const row: Record<string, unknown> = {
    debug: 0,
    from: 0,
    userId,
    project: "A2API",
    testAccountId: 0,
    version: app.version > 0 ? app.version : 1,
    group: app.table,
    name: app.name || `${String(app.operation).toUpperCase()} ${app.table}`,
    operation: String(app.operation || "").toUpperCase(),
    method: app.method || "POST",
    type: app.type || "JSON",
    url: app.url,
    request: requestText,
    apijson: requestText,
    detail: app.detail || null,
  };

  const withTest = await rawPost(client, "post", {
    Document: row,
    TestRecord: {
      response: jsonText({ code: 200, msg: "success", A2API: "approved" }),
    },
    tag: "Document",
  });
  if (withTest.ok) {
    return {
      ...withTest,
      id: pickId(withTest.body, "Document"),
    };
  }
  return postTable(client, "Document", row, "Document");
}

async function writeChain(
  client: ApiJsonClient,
  app: ConfigApplication,
  documentId: number | string | undefined,
  userId: number,
): Promise<WriteTargetResult> {
  if (documentId == null) {
    return {
      ok: false,
      action: "skip",
      error: "documentId missing — skip Chain",
    };
  }
  const groupId = Date.now();
  const groupName = `A2API · ${app.table} · ${String(app.operation).toUpperCase()}`;
  const row: Record<string, unknown> = {
    userId,
    project: "A2API",
    testAccountId: "0",
    toGroupId: 0,
    groupId,
    groupName,
    documentId,
    documentName: app.name || groupName,
    randomId: 0,
    scriptId: 0,
    tagList: ["A2API", app.table],
  };
  return postTable(client, "Chain", row, "Chain");
}

export type ApproveWriterOptions = {
  client: ApiJsonClient;
  /** APIJSON user id stamped on Document/Chain (default 82001 demo admin). */
  userId?: number;
};

export async function ensureAdminSession(
  client: ApiJsonClient,
  login?: string,
  password?: string,
  opts?: { force?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  if (client.cookie && !opts?.force) return { ok: true };
  if (opts?.force) client.cookie = "";
  const user = login || process.env.APIJSON_ADMIN_LOGIN || "13000082001";
  const pass = password || process.env.APIJSON_ADMIN_PASSWORD || "123456";
  const result = await client.login(user, pass);
  if (!result.ok) {
    return { ok: false, error: result.error || "APIJSON admin login failed" };
  }
  return { ok: true };
}

export async function applyApprovedApplication(
  app: ConfigApplication,
  options: ApproveWriterOptions,
): Promise<{
  application: ConfigApplication;
  results: ApplicationWriteResults;
  ok: boolean;
}> {
  const enriched = enrichApplication(app);
  const userId =
    options.userId ??
    (Number(process.env.APIJSON_ADMIN_USER_ID) || 82001);
  const results: ApplicationWriteResults = {};

  results.Access = await writeAccess(options.client, enriched);
  results.Request = await writeRequest(options.client, enriched);
  results.Document = await writeDocument(options.client, enriched, userId);
  results.Chain = await writeChain(
    options.client,
    enriched,
    results.Document.id,
    userId,
  );

  // Request + Document are the critical path; Access may be blocked by stock Demo ACL.
  const ok = Boolean(results.Request?.ok && results.Document?.ok);

  return {
    application: {
      ...enriched,
      writeResults: results,
    },
    results,
    ok,
  };
}

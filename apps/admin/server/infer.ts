/**
 * Infer Access / Request fields from a submitted APIJSON call.
 */

import { extractRequestTables } from "@a2api/protocol";
import type { ApiJsonOp, ConfigApplication } from "./types.js";

const OPS: ApiJsonOp[] = [
  "get",
  "head",
  "gets",
  "heads",
  "post",
  "put",
  "delete",
  "crud",
];

const ACCESS_OPS = [
  "get",
  "head",
  "gets",
  "heads",
  "post",
  "put",
  "delete",
] as const;

export function opFromUrl(url: string): ApiJsonOp | null {
  try {
    const path = (url.split("?")[0] || "").replace(/\/+$/, "");
    const last = path.split("/").filter(Boolean).pop()?.toLowerCase() || "";
    if ((OPS as string[]).includes(last)) return last as ApiJsonOp;
  } catch {
    /* ignore */
  }
  return null;
}

/** Access columns to grant — CRUD expands via body @get/@post/@put/@delete. */
export function accessOpsForApp(app: ConfigApplication): string[] {
  const fromUrl = opFromUrl(app.url);
  const raw = String(app.operation || "").trim().toLowerCase();
  const operation =
    fromUrl === "crud" || raw === "crud"
      ? "crud"
      : raw || fromUrl || "get";
  if (operation !== "crud") return [operation];

  const fromBody: string[] = [];
  const json = app.json && typeof app.json === "object" ? app.json : {};
  for (const key of Object.keys(json)) {
    const m = /^@(get|head|gets|heads|post|put|delete)$/i.exec(key);
    if (m) fromBody.push(m[1]!.toLowerCase());
  }
  if (fromBody.length) return [...new Set(fromBody)];
  return ["post", "put", "delete"];
}

export function isAccessOp(op: string): boolean {
  return (ACCESS_OPS as readonly string[]).includes(op);
}

export function defaultStructure(
  operation: string,
  table: string,
  role: string,
): Record<string, unknown> {
  const op = operation.toLowerCase();
  const r = role.toUpperCase() || "OWNER";
  if (op === "post") {
    return {
      INSERT: { "@role": r },
      REFUSE: "id",
    };
  }
  if (op === "put") {
    return {
      MUST: "id",
      INSERT: { "@role": r },
      REFUSE: "userId,date",
    };
  }
  if (op === "delete") {
    return {
      [table]: {
        MUST: "id",
        INSERT: { "@role": r },
      },
    };
  }
  if (op === "gets" || op === "heads") {
    return {
      INSERT: { "@role": r },
    };
  }
  if (op === "crud") {
    return {
      INSERT: { "@role": r },
    };
  }
  return {};
}

export function enrichApplication(
  app: ConfigApplication,
): ConfigApplication {
  const tables = extractRequestTables(app.json);
  const table =
    app.table ||
    (typeof app.json.tag === "string" ? app.json.tag : "") ||
    tables[0] ||
    "";
  const tag =
    app.tag ||
    (typeof app.json.tag === "string" ? app.json.tag : "") ||
    table;
  const version =
    app.version > 0
      ? app.version
      : typeof app.json.version === "number" && app.json.version > 0
        ? app.json.version
        : 1;
  // Prefer /crud URL over a stale form value (admin select used to lack crud → get).
  const fromUrl = opFromUrl(app.url);
  const rawOp = String(app.operation || "").trim().toLowerCase();
  const operation = (
    fromUrl === "crud" || rawOp === "crud"
      ? "crud"
      : rawOp || fromUrl || "get"
  ).toLowerCase();
  let role = app.role;
  if (!role || role === "UNKNOWN") {
    const top = app.json["@role"];
    if (typeof top === "string" && top.trim()) role = top.trim().toUpperCase();
    else role = operation === "get" || operation === "head" ? "LOGIN" : "OWNER";
  } else {
    role = role.toUpperCase();
  }
  const structure =
    app.structure && Object.keys(app.structure).length
      ? app.structure
      : defaultStructure(operation, table || tag, role);
  const name =
    app.name ||
    `${operation.toUpperCase()} ${table || tag}`.trim();

  return {
    ...app,
    table: table || tag,
    tag,
    version,
    operation,
    role,
    structure,
    name,
    accessAlias: app.accessAlias || table || tag,
  };
}

/** Roles JSON string stored in Access.get/post/… columns. */
export function rolesJson(roles: string[]): string {
  const uniq = [...new Set(roles.map((r) => r.toUpperCase()).filter(Boolean))];
  return JSON.stringify(uniq);
}

export function parseRoles(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).toUpperCase()).filter(Boolean);
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return [];
    try {
      const parsed = JSON.parse(t) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((x) => String(x).toUpperCase()).filter(Boolean);
      }
    } catch {
      return t
        .split(/[,;\s]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    }
  }
  return [];
}

export function mergeRole(existing: unknown, role: string): string {
  const roles = parseRoles(existing);
  const r = role.toUpperCase();
  if (!roles.includes(r)) roles.push(r);
  // Keep ADMIN as a safe companion for write ops when granting OWNER/LOGIN
  if ((r === "OWNER" || r === "LOGIN") && !roles.includes("ADMIN")) {
    roles.push("ADMIN");
  }
  return rolesJson(roles);
}

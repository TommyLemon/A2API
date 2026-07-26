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
];

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
  const operation =
    String(app.operation || opFromUrl(app.url) || "get").toLowerCase();
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

/** Manage which tables participate in the bound list query (`[]`). */

import { listReadableTables } from "./access-roles.js";
import {
  defaultFkColumns,
  fkEdgesFor,
  type FkJoinSpec,
} from "./fk-expand.js";
import { listTablesInBody, setListJoin } from "./join-query.js";

/** Demo fallback when Access / available-requests has not loaded yet. */
export const CATALOG_TABLES = ["Moment", "User", "Comment"] as const;

/**
 * APIJSON config / schema-introspection tables (not business data).
 * Aligns with APIJSON CONFIG_TABLE_LIST + Demo sys_* + A2API Apply/Call.
 */
const APIJSON_CONFIG_TABLES = new Set(
  [
    "Access",
    "Request",
    "Response",
    "Function",
    "Document",
    "Script",
    "Test",
    "TestRecord",
    "Random",
    "Method",
    "Verify",
    "Login",
    "Table",
    "Column",
    "SysTable",
    "SysColumn",
    "AllTable",
    "AllColumn",
    "PgAttribute",
    "PgClass",
    "ExtendedProperty",
    /** A2API admin permission queue — not chat business data */
    "Apply",
    "Call",
  ].map((t) => t.toLowerCase()),
);

/** MySQL / MariaDB engine & catalog schemas (and common sys schema tables). */
const DB_SYSTEM_SCHEMA_PREFIXES = [
  "mysql.",
  "information_schema.",
  "performance_schema.",
  "sys.",
];

const DB_SYSTEM_TABLES = new Set(
  [
    "general_log",
    "slow_log",
    "columns_priv",
    "db",
    "engine_cost",
    "event",
    "func",
    "gtid_executed",
    "help_category",
    "help_keyword",
    "help_relation",
    "help_topic",
    "innodb_index_stats",
    "innodb_table_stats",
    "plugin",
    "proc",
    "procs_priv",
    "proxies_priv",
    "servers",
    "slave_master_info",
    "slave_relay_log_info",
    "slave_worker_info",
    "tables_priv",
    "time_zone",
    "time_zone_leap_second",
    "time_zone_name",
    "time_zone_transition",
    "time_zone_transition_type",
    "user", // mysql.user — Access alias User is PascalCase and kept via exact business check below
  ].map((t) => t.toLowerCase()),
);

/**
 * True for app business tables shown in Add-table / Relate pickers.
 * Hides MySQL system catalogs and APIJSON Access/Request/… config tables.
 */
export function isBusinessTable(name: string): boolean {
  const raw = name.trim();
  if (!raw) return false;
  // Synthetic / non-table keys
  if (raw === "Record" || raw === "[]" || raw.includes(":")) return false;

  const lower = raw.toLowerCase();
  for (const p of DB_SYSTEM_SCHEMA_PREFIXES) {
    if (lower.startsWith(p)) return false;
  }
  // Schema-qualified leftovers: `mysql`.`user` style without dots after normalize
  if (lower.includes("`")) return false;

  if (APIJSON_CONFIG_TABLES.has(lower)) return false;

  // Bare mysql system table names (only when clearly not PascalCase business User)
  if (DB_SYSTEM_TABLES.has(lower) && raw === lower) return false;

  // Common physical dumps: sys_Access → still config if after strip
  const noSys = lower.startsWith("sys_") ? lower.slice(4) : lower;
  if (APIJSON_CONFIG_TABLES.has(noSys)) return false;

  // Prefer real entity names (PascalCase / letter start); drop pure engine junk
  if (!/^[A-Za-z]/.test(raw)) return false;

  return true;
}

/** Prefer Access-backed readable tables; fall back to demo catalog. */
export function catalogTables(): string[] {
  const fromAccess = listReadableTables().filter(isBusinessTable);
  if (fromAccess.length) return fromAccess;
  return [...CATALOG_TABLES].filter(isBusinessTable);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

export function ensureListObject(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const next = structuredClone(body);
  if (!isPlainObject(next["[]"])) {
    next["[]"] = { count: 20, page: 0 };
  }
  return next;
}

/** Infer primary = first PascalCase table without id@, else first table. */
export function inferPrimaryFromBody(
  body: Record<string, unknown>,
): string | null {
  const tables = listTablesInBody(body);
  if (!tables.length) return null;
  const list = body["[]"];
  if (!isPlainObject(list)) return tables[0]!;
  for (const t of tables) {
    const obj = list[t];
    if (isPlainObject(obj) && obj["id@"] == null) return t;
  }
  return tables[0]!;
}

export function addQueryTable(
  body: Record<string, unknown>,
  table: string,
  primary: string | null,
): {
  body: Record<string, unknown>;
  fkExpandPatch: Record<string, FkJoinSpec>;
} {
  const next = ensureListObject(body);
  const list = next["[]"] as Record<string, unknown>;
  const fkExpandPatch: Record<string, FkJoinSpec> = {};

  if (isPlainObject(list[table])) {
    setListJoin(list, primary || inferPrimaryFromBody(next));
    return { body: next, fkExpandPatch };
  }

  const primaryTable = primary || inferPrimaryFromBody(next);
  if (!primaryTable || primaryTable === table) {
    // Adding as (or becoming) primary
    list[table] = isPlainObject(list[table]) ? list[table]! : {};
    setListJoin(list, table);
    return { body: next, fkExpandPatch };
  }

  const edge = fkEdgesFor(primaryTable).find((e) => e.target === table);
  if (edge) {
    list[table] = {
      "id@": `/${primaryTable}/${edge.column}`,
      "@column": defaultFkColumns(table).join(","),
    };
    fkExpandPatch[table] = {
      enabled: true,
      columns: defaultFkColumns(table),
    };
  } else {
    // No known FK — still allow selecting the table (APP association / empty)
    list[table] = {};
  }
  setListJoin(list, primaryTable);
  return { body: next, fkExpandPatch };
}

export function removeQueryTable(
  body: Record<string, unknown>,
  table: string,
): {
  body: Record<string, unknown>;
  removedPrimary: boolean;
  newPrimary: string | null;
} {
  const next = ensureListObject(body);
  const list = next["[]"] as Record<string, unknown>;
  const beforePrimary = inferPrimaryFromBody(next);
  delete list[table];
  const left = listTablesInBody(next);
  const removedPrimary = beforePrimary === table;
  const newPrimary = left[0] ?? null;
  setListJoin(list, removedPrimary ? newPrimary : beforePrimary);
  return {
    body: next,
    removedPrimary,
    newPrimary,
  };
}

/** Promote a table to primary: clear its id@, re-link other FK tables. */
export function setPrimaryTable(
  body: Record<string, unknown>,
  primary: string,
  fkExpand: Record<string, FkJoinSpec>,
): {
  body: Record<string, unknown>;
  fkExpand: Record<string, FkJoinSpec>;
} {
  const next = ensureListObject(body);
  const list = next["[]"] as Record<string, unknown>;
  if (!isPlainObject(list[primary])) {
    list[primary] = {};
  } else {
    const p = { ...(list[primary] as Record<string, unknown>) };
    delete p["id@"];
    // Drop JOIN-narrowed @column so primary returns all fields
    // (e.g. User tag/head/pictureList, not just name).
    delete p["@column"];
    list[primary] = p;
  }

  const nextExpand: Record<string, FkJoinSpec> = { ...fkExpand };
  const edges = fkEdgesFor(primary);
  const edgeTargets = new Set(edges.map((e) => e.target));

  for (const t of listTablesInBody(next)) {
    if (t === primary) continue;
    const edge = edges.find((e) => e.target === t);
    if (edge) {
      const cols =
        nextExpand[t]?.columns?.length
          ? nextExpand[t]!.columns
          : defaultFkColumns(t);
      list[t] = {
        ...(isPlainObject(list[t]) ? list[t]! : {}),
        "id@": `/${primary}/${edge.column}`,
        "@column": cols.join(","),
      };
      nextExpand[t] = {
        enabled: nextExpand[t]?.enabled ?? true,
        columns: cols,
      };
    } else if (edgeTargets.size && isPlainObject(list[t])) {
      // Was FK of old primary — leave as empty secondary
      const cur = { ...(list[t] as Record<string, unknown>) };
      if (typeof cur["id@"] === "string") delete cur["id@"];
      list[t] = cur;
    }
  }

  setListJoin(list, primary);
  return { body: next, fkExpand: nextExpand };
}

export function tablesAvailableToAdd(current: string[]): string[] {
  const set = new Set(current);
  return catalogTables().filter((t) => !set.has(t));
}

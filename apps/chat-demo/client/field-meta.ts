/** Field types + Excel-like column meta (visibility / filter / sort). */

import { resolveFkTable } from "./fk-nav.js";
import type { SchemaComments } from "./schema-types.js";

export type FieldType =
  | "text"
  | "number"
  | "time"
  | "date"
  | "percent"
  | "formula"
  | "json";

/** Join / association mode for ON clause ("" = APIJSON APP `@` in `[]`.join). */
export type OnJoinMode = "&" | "|" | "!" | "<" | ">" | ")" | "(" | "";

/** How a selected field is returned in `@column`. */
export type ColumnReturnAgg =
  | "data"
  | "sum"
  | "avg"
  | "max"
  | "min"
  | "count"
  | "custom";

export const COLUMN_RETURN_OPTIONS: Array<{
  agg: ColumnReturnAgg;
  label: string;
}> = [
  { agg: "data", label: "Data" },
  { agg: "sum", label: "Sum" },
  { agg: "avg", label: "Avg" },
  { agg: "max", label: "Max" },
  { agg: "min", label: "Min" },
  { agg: "count", label: "Count" },
  { agg: "custom", label: "Custom" },
];

export type ColumnMeta = {
  path: string;
  type: FieldType;
  visible: boolean;
  filterable: boolean;
  sortable: boolean;
  /** Custom table header label */
  displayName?: string;
  /** Related table, e.g. Moment */
  onTable?: string;
  /** Related field, e.g. userId */
  onField?: string;
  /** Join mode: APP @ / INNER & / LEFT < … */
  onJoin?: OnJoinMode;
  /** Return shape for `@column` (Data / Sum / … / Custom) */
  returnAgg?: ColumnReturnAgg;
  /** When returnAgg=custom: expression body, e.g. sum(commentCount) */
  returnExpr?: string;
};

/** Safe subset for custom `@column` expressions. */
export function sanitizeColumnReturnExpr(raw: string): string {
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t) return "";
  if (!/^[a-zA-Z_][a-zA-Z0-9_.,()+\-*/%\s]*$/.test(t)) return "";
  if (t.length > 120) return "";
  return t;
}

/** Build one `@column` token from field + return mode. */
export function formatColumnReturnToken(
  col: string,
  agg: ColumnReturnAgg = "data",
  customExpr?: string,
): string {
  if (agg === "data") return col;
  if (agg === "custom") {
    const e = sanitizeColumnReturnExpr(customExpr || "");
    return e ? `${e}:${col}` : col;
  }
  return `${agg}(${col}):${col}`;
}

/** Parse `@column` token → field name + return mode. */
export function parseColumnReturnToken(token: string): {
  col: string;
  returnAgg: ColumnReturnAgg;
  returnExpr?: string;
} {
  const t = token.trim();
  if (!t) return { col: "", returnAgg: "data" };
  const builtin = t.match(
    /^(sum|avg|max|min|count)\(([a-zA-Z_][\w]*)\)(?::([a-zA-Z_][\w]*))?$/i,
  );
  if (builtin) {
    return {
      col: builtin[3] || builtin[2]!,
      returnAgg: builtin[1]!.toLowerCase() as ColumnReturnAgg,
    };
  }
  const aliased = t.match(/^(.+):([a-zA-Z_][\w]*)$/);
  if (aliased && !/^[a-zA-Z_][\w]*$/.test(aliased[1]!)) {
    return {
      col: aliased[2]!,
      returnAgg: "custom",
      returnExpr: aliased[1]!.trim(),
    };
  }
  return { col: t, returnAgg: "data" };
}

const FIELD_TYPES: FieldType[] = [
  "text",
  "number",
  "time",
  "date",
  "percent",
  "formula",
  "json",
];

export function fieldTypeLabel(t: FieldType): string {
  switch (t) {
    case "text":
      return "Text";
    case "number":
      return "Number";
    case "time":
      return "Time";
    case "date":
      return "Date";
    case "percent":
      return "Percent";
    case "formula":
      return "Formula";
    case "json":
      return "JSON";
  }
}

export function allFieldTypes(): FieldType[] {
  return [...FIELD_TYPES];
}

function colName(path: string): string {
  return path.includes(".") ? path.split(".").pop()! : path;
}

function ddlTypeOf(path: string, comments?: SchemaComments | null): string {
  if (!comments) return "";
  if (comments.types?.[path]) return comments.types[path]!.toLowerCase();
  const c = comments.columns[path] || "";
  const m = c.match(/\(([^)]+)\)\s*$/);
  return (m?.[1] || "").toLowerCase();
}

function commentOf(path: string, comments?: SchemaComments | null): string {
  if (!comments?.columns[path]) return "";
  return comments.columns[path]!.replace(/\s*\([^)]*\)\s*$/, "");
}

/** Infer field type from DDL, comment semantics, and sample values. */
export function inferFieldType(
  path: string,
  samples: unknown[],
  comments?: SchemaComments | null,
): FieldType {
  const name = colName(path).toLowerCase();
  const ddl = ddlTypeOf(path, comments);
  const comment = commentOf(path, comments);

  if (
    /formula|表达式|计算/.test(comment) ||
    name.includes("formula") ||
    name.startsWith("calc")
  ) {
    return "formula";
  }
  if (
    /percent|ratio|rate|占比|百分|比例/.test(name + comment) ||
    /%/.test(comment)
  ) {
    return "percent";
  }
  if (
    ddl.includes("datetime") ||
    ddl.includes("timestamp") ||
    /日期时间|创建时间|更新时间/.test(comment) ||
    /(^|_)(datetime|timestamp|createdat|updatedat)(_|$)/.test(name)
  ) {
    return "time";
  }
  if (
    ddl === "date" ||
    (/date/.test(ddl) && !ddl.includes("time")) ||
    (/日期/.test(comment) && !/时间/.test(comment)) ||
    /(^|_)date(_|$)/.test(name)
  ) {
    // APIJSON Demo Moment.date is timestamp but comment says 创建日期 — prefer time if ddl has time
    if (ddl.includes("timestamp") || ddl.includes("datetime")) return "time";
    return "date";
  }
  if (
    /time/.test(ddl) ||
    /时间/.test(comment) ||
    /(^|_)time(_|$)/.test(name)
  ) {
    return "time";
  }
  // JSON / list columns (contactIdList, pictureList, …) before *Id number heuristic
  if (
    ddl.includes("json") ||
    /\bjson\b|列表|数组/.test(comment) ||
    /list$/i.test(name) ||
    samples.some((v) => Array.isArray(v))
  ) {
    return "json";
  }
  if (
    /int|decimal|numeric|double|float|bigint|smallint|tinyint|real/.test(ddl) ||
    name === "id" ||
    name.endsWith("id") ||
    name.endsWith("count") ||
    name.endsWith("num")
  ) {
    return "number";
  }

  // sample-based
  const vals = samples.filter((v) => v != null && v !== "");
  if (vals.length) {
    const asNum = vals.every(
      (v) => typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)),
    );
    const asDate = vals.every(
      (v) =>
        typeof v === "string" &&
        (/^\d{4}-\d{2}-\d{2}$/.test(v) ||
          /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(v)),
    );
    if (asDate) {
      return vals.some(
        (v) => typeof v === "string" && /\d{2}:\d{2}/.test(v),
      )
        ? "time"
        : "date";
    }
    if (asNum) return "number";
  }

  return "text";
}

/** True when FK target table already contributes non-id columns in this view. */
export function fkTargetFieldsPresent(
  paths: string[],
  fkTable: string,
): boolean {
  return paths.some((p) => {
    if (!p.startsWith(`${fkTable}.`)) return false;
    const col = p.slice(fkTable.length + 1);
    return Boolean(col && col !== "id");
  });
}

/**
 * Hide primary-table FK columns (userId…) when the related table is JOINed
 * and its fields are already in the column set. Otherwise keep the FK column
 * so the id (or mapped label) remains visible.
 */
function shouldHideFkColumn(
  path: string,
  allPaths: string[],
  comments?: SchemaComments | null,
): boolean {
  const fkTable = resolveFkTable(path, comments);
  if (!fkTable) return false;
  // Only hide the FK field itself (*Id), not unrelated columns
  if (!/_?[Ii]d$/.test(colName(path)) || colName(path) === "id") return false;
  return fkTargetFieldsPresent(allPaths, fkTable);
}

export function buildDefaultMetas(
  paths: string[],
  rows: Array<{ cells: Record<string, unknown> }>,
  comments?: SchemaComments | null,
  prev?: Record<string, ColumnMeta>,
): Record<string, ColumnMeta> {
  const out: Record<string, ColumnMeta> = {};
  for (const path of paths) {
    if (prev?.[path]) {
      out[path] = { ...prev[path]! };
      continue;
    }
    const samples = rows.map((r) => r.cells[path]).slice(0, 20);
    const type = inferFieldType(path, samples, comments);
    const isId = colName(path) === "id";
    const hideFk = shouldHideFkColumn(path, paths, comments);
    const fkTable = resolveFkTable(path, comments);
    out[path] = {
      path,
      type,
      // PK id / joined-away FK columns default hidden (toggle in ⚙)
      visible: !isId && !hideFk,
      filterable: !isId,
      sortable: true,
      ...(fkTable
        ? { onTable: fkTable, onField: "id", onJoin: "" as const }
        : {}),
    };
  }
  return out;
}

/** Column names that appear under more than one table → need Table.column label. */
export function ambiguousColumnNames(paths: string[]): Set<string> {
  const tablesByCol = new Map<string, Set<string>>();
  for (const path of paths) {
    if (!path.includes(".")) continue;
    const [table, col] = path.split(".");
    if (!table || !col) continue;
    if (!tablesByCol.has(col)) tablesByCol.set(col, new Set());
    tablesByCol.get(col)!.add(table);
  }
  const out = new Set<string>();
  for (const [col, tables] of tablesByCol) {
    if (tables.size > 1) out.add(col);
  }
  return out;
}

/** Header text: custom displayName, else field name (Table.col if ambiguous). */
export function headerLabel(
  path: string,
  ambiguous: Set<string>,
  displayName?: string,
): string {
  if (displayName?.trim()) return displayName.trim();
  if (!path.includes(".")) return path;
  const col = path.split(".").pop()!;
  const table = path.split(".")[0]!;
  return ambiguous.has(col) ? `${table}.${col}` : col;
}

function sampleWidth(
  path: string,
  rows: Array<{ cells: Record<string, unknown> }>,
): number {
  const header = headerLabel(path, ambiguousColumnNames([path]));
  let max = header.length;
  for (const r of rows.slice(0, 40)) {
    const v = r.cells[path];
    let s = "";
    if (v == null) s = "";
    else if (typeof v === "string") s = v;
    else if (typeof v === "number" || typeof v === "boolean") s = String(v);
    else s = JSON.stringify(v);
    max = Math.max(max, Math.min(s.length, 64));
  }
  return max;
}

/** Narrower display content first (left → right) so more columns fit. */
export function orderByContentWidth(
  paths: string[],
  rows: Array<{ cells: Record<string, unknown> }>,
): string[] {
  return [...paths].sort((a, b) => {
    const d = sampleWidth(a, rows) - sampleWidth(b, rows);
    return d || a.localeCompare(b);
  });
}

/**
 * Default order: date/time columns leftmost, then narrower content.
 */
export function defaultColumnOrder(
  paths: string[],
  rows: Array<{ cells: Record<string, unknown> }>,
  comments?: SchemaComments | null,
): string[] {
  if (!paths.length) return [];
  const scored = paths.map((path) => {
    const samples = rows.map((r) => r.cells[path]).slice(0, 20);
    const type = inferFieldType(path, samples, comments);
    const isDt = type === "date" || type === "time";
    return {
      path,
      type,
      isDt,
      width: rows.length ? sampleWidth(path, rows) : 0,
    };
  });
  scored.sort((a, b) => {
    if (a.isDt !== b.isDt) return a.isDt ? -1 : 1;
    if (a.isDt && b.isDt) {
      if (a.type !== b.type) return a.type === "date" ? -1 : 1;
      return a.path.localeCompare(b.path);
    }
    return a.width - b.width || a.path.localeCompare(b.path);
  });
  return scored.map((s) => s.path);
}

export function ensureColumnOrder(
  paths: string[],
  order?: string[],
  rows?: Array<{ cells: Record<string, unknown> }>,
  comments?: SchemaComments | null,
): string[] {
  const set = new Set(paths);
  if (!order?.length) {
    return defaultColumnOrder(paths, rows ?? [], comments);
  }
  const kept = order.filter((p) => set.has(p));
  const missing = paths.filter((p) => !kept.includes(p));
  const missingOrdered = defaultColumnOrder(missing, rows ?? [], comments);
  return [...kept, ...missingOrdered];
}

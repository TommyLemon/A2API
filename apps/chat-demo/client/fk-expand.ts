/**
 * Auto-expand FK tables into list `[]` with key columns (configurable).
 * Uses APIJSON association: `"id@": "/Primary/fkCol"` plus `[]`.join
 * (e.g. `"join": "@/User"`). NOT `/[]/Primary/fkCol` — that path fails in 8.x.
 */

import { setListJoin } from "./join-query.js";

export type FkEdge = {
  /** FK column on primary table, e.g. userId */
  column: string;
  /** Target table, e.g. User */
  target: string;
};

export type FkJoinSpec = {
  enabled: boolean;
  /** Columns for `@column` — default is a single text field */
  columns: string[];
  /** Optional override for id@ → /onTable/onField */
  onTable?: string;
  onField?: string;
};

/** Primary table → outgoing FK edges. */
export const TABLE_FK_EDGES: Record<string, FkEdge[]> = {
  Moment: [{ column: "userId", target: "User" }],
  Comment: [
    { column: "userId", target: "User" },
    { column: "momentId", target: "Moment" },
  ],
};

/**
 * Default JOIN columns: only one text label field (no id / date / time).
 * Users can multi-select more via table-chip DDL popup checkboxes.
 */
export const DEFAULT_FK_COLUMNS: Record<string, string[]> = {
  User: ["name"],
  Moment: ["content"],
  Comment: ["content"],
};

/** Extra columns offered in the multi-select UI (beyond the default text field). */
export const FK_OPTIONAL_COLUMNS: Record<string, string[]> = {
  User: ["id", "name", "head", "tag", "sex", "date"],
  Moment: ["id", "content", "userId", "date"],
  Comment: ["id", "content", "userId", "momentId", "date"],
};

export function defaultFkColumns(table: string): string[] {
  return [...(DEFAULT_FK_COLUMNS[table] ?? ["name"])];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

export function fkEdgesFor(primary: string | null | undefined): FkEdge[] {
  if (!primary) return [];
  return TABLE_FK_EDGES[primary] ?? [];
}

export function defaultFkExpandState(
  primary: string | null | undefined,
): Record<string, FkJoinSpec> {
  const out: Record<string, FkJoinSpec> = {};
  for (const e of fkEdgesFor(primary)) {
    if (out[e.target]) continue;
    out[e.target] = {
      enabled: true,
      columns: defaultFkColumns(e.target),
    };
  }
  return out;
}

/**
 * Inject / update FK tables on list body according to expand config.
 * Disabled targets are removed only if they look like our FK injections
 * (have id@ pointing at primary). Existing unrelated tables are left alone.
 */
export function applyFkExpand(
  body: Record<string, unknown>,
  primaryTable: string | null,
  expand: Record<string, FkJoinSpec>,
): Record<string, unknown> {
  const next = structuredClone(body);
  const list = next["[]"];
  if (!isPlainObject(list) || !primaryTable) return next;

  const edges = fkEdgesFor(primaryTable);
  if (!edges.length) return next;

  // Group edges by target (first wins for id@ path if multiple — rare)
  const byTarget = new Map<string, FkEdge>();
  for (const e of edges) {
    if (!byTarget.has(e.target)) byTarget.set(e.target, e);
  }

  for (const [target, edge] of byTarget) {
    const spec = expand[target] ?? {
      enabled: true,
      columns: defaultFkColumns(target),
    };
    const idAt =
      spec.onTable && spec.onField
        ? `/${spec.onTable}/${spec.onField}`
        : `/${primaryTable}/${edge.column}`;

    if (!spec.enabled || !spec.columns.length) {
      const cur = list[target];
      if (
        isPlainObject(cur) &&
        String(cur["id@"] || "").includes(`/${edge.column}`)
      ) {
        delete list[target];
      }
      continue;
    }

    const cols = [
      ...new Set([
        "id",
        ...(spec.columns.length ? spec.columns : defaultFkColumns(target)),
      ]),
    ];
    const existing = isPlainObject(list[target]) ? list[target]! : {};
    const prevAt = typeof existing["id@"] === "string" ? existing["id@"] : "";
    // Prefer configured ON; rewrite broken `/[]/…` refs
    const nextAt =
      (spec.onTable && spec.onField && idAt) ||
      (!prevAt || prevAt.includes("/[]/") ? idAt : prevAt);
    list[target] = {
      ...existing,
      "id@": nextAt,
      "@column": cols.join(","),
    };
  }

  setListJoin(list, primaryTable);
  return next;
}

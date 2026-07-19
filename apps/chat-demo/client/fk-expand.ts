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
  User: [
    "id",
    "name",
    "head",
    "tag",
    "sex",
    "date",
    "contactIdList",
    "pictureList",
  ],
  Moment: [
    "id",
    "content",
    "userId",
    "date",
    "praiseUserIdList",
    "pictureList",
  ],
  Comment: ["id", "content", "userId", "momentId", "toId", "date"],
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
    // OWNER queries are already scoped to the visitor — do not JOIN User by default.
    // Other FK tables (e.g. Comment→Moment) stay on so list context remains useful.
    out[e.target] = {
      enabled: e.target !== "User",
      columns: defaultFkColumns(e.target),
    };
  }
  return out;
}

/**
 * Mark JOIN tables already present in `[]` as enabled so later applyFkExpand
 * does not strip them (e.g. after table-chip Apply on the primary).
 */
export function syncFkExpandFromBody(
  body: Record<string, unknown>,
  primaryTable: string | null,
  expand: Record<string, FkJoinSpec>,
): Record<string, FkJoinSpec> {
  const list = body["[]"];
  if (!isPlainObject(list) || !primaryTable) return { ...expand };
  const next: Record<string, FkJoinSpec> = { ...expand };
  for (const key of Object.keys(list)) {
    if (!/^[A-Z]/.test(key) || key === primaryTable || !isPlainObject(list[key])) {
      continue;
    }
    const tableObj = list[key] as Record<string, unknown>;
    const raw = tableObj["@column"];
    const cols =
      typeof raw === "string" && raw.trim()
        ? raw
            .split(",")
            .map((s) => {
              const t = s.trim();
              const aliased = t.match(/:([a-zA-Z_][\w]*)$/);
              if (aliased) return aliased[1]!;
              const builtin = t.match(
                /^(?:sum|avg|max|min|count)\(([a-zA-Z_][\w]*)\)/i,
              );
              return builtin?.[1] ?? t;
            })
            .filter((c) => c && c !== "id")
        : [];
    const prev = next[key];
    next[key] = {
      enabled: true,
      columns: cols.length
        ? cols
        : prev?.columns?.length
          ? prev.columns
          : defaultFkColumns(key),
      onTable: prev?.onTable,
      onField: prev?.onField,
    };
    // Recover ON from id@ when missing
    const idAt = tableObj["id@"];
    if (typeof idAt === "string" && idAt.startsWith("/")) {
      const parts = idAt.slice(1).split("/");
      if (parts.length >= 2 && !next[key]!.onTable) {
        next[key] = {
          ...next[key]!,
          onTable: parts[0],
          onField: parts[1],
        };
      }
    }
  }
  return next;
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
      enabled: false,
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

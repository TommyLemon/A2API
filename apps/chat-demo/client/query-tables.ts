/** Manage which tables participate in the bound list query (`[]`). */

import {
  defaultFkColumns,
  fkEdgesFor,
  type FkJoinSpec,
} from "./fk-expand.js";
import { listTablesInBody, setListJoin } from "./join-query.js";

export const CATALOG_TABLES = ["Moment", "User", "Comment"] as const;

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
  return CATALOG_TABLES.filter((t) => !set.has(t));
}

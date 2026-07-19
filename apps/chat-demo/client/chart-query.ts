/**
 * Chart data: prefer local page aggregation, then upgrade via APIJSON
 * GROUP BY / HAVING (and related) queries when the server accepts them.
 */

import {
  parseChartValue,
  type ChartAggOp,
  type ChartPoint,
  type ChartValueSpec,
} from "./charts.js";
import { fkEdgesFor } from "./fk-expand.js";
import { setListJoin } from "./join-query.js";

/** Alias must not start with `_` — APIJSON 8.x drops such keys. */
const VALUE_ALIAS = "chartVal";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Flatten APIJSON `[]` aggregate rows → Table.col (+ bare alias) cells. */
function flattenAggRows(
  response: unknown,
): Array<Record<string, unknown>> {
  if (!isPlainObject(response)) return [];
  const list = response["[]"];
  if (!Array.isArray(list)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const item of list) {
    if (!isPlainObject(item)) continue;
    const cells: Record<string, unknown> = {};
    for (const [table, obj] of Object.entries(item)) {
      if (!isPlainObject(obj) || !/^[A-Z]/.test(table)) continue;
      for (const [k, v] of Object.entries(obj)) {
        if (k.startsWith("@")) continue;
        cells[`${table}.${k}`] = v;
        // Aggregate aliases often appear as bare keys on the table object
        cells[k] = v;
      }
    }
    rows.push(cells);
  }
  return rows;
}

function colOf(path: string): string {
  return path.includes(".") ? path.split(".").pop()! : path;
}

function tableOf(path: string): string | null {
  return path.includes(".") ? path.split(".")[0]! : null;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    return Number(v.trim());
  }
  return null;
}

export type ChartAggMeta = {
  /** Bare group columns on the aggregate table */
  groupCols: string[];
  /** Paths used to build chart labels from the response */
  labelPaths: string[];
  valueAlias: string;
  groupTable: string;
  /** true → count(id); false → agg(metric) */
  useCount: boolean;
  metricCol?: string;
  aggOp?: ChartAggOp;
};

type JoinNeed = {
  table: string;
  /** Display columns to pull (e.g. name) */
  columns: string[];
  /** Primary FK column used in id@ */
  viaFk: string;
};

/**
 * Map chart label fields → GROUP BY keys on the primary (list) table,
 * plus optional JOIN tables for display names.
 */
function resolveGroupPlan(
  primaryTable: string,
  labelPaths: string[],
): {
  groupTable: string;
  groupCols: string[];
  joins: JoinNeed[];
  labelPaths: string[];
} | null {
  const paths = labelPaths.filter(Boolean);
  if (!paths.length) return null;

  const onlyTable = tableOf(paths[0]!);
  if (
    onlyTable &&
    onlyTable !== primaryTable &&
    paths.every((p) => tableOf(p) === onlyTable)
  ) {
    const edge = fkEdgesFor(primaryTable).find((e) => e.target === onlyTable);
    if (edge) {
      // Prefer grouping on primary FK so counts reflect list rows (e.g. Moments)
      return {
        groupTable: primaryTable,
        groupCols: [edge.column],
        joins: [
          {
            table: onlyTable,
            columns: [
              "id",
              ...paths.map(colOf).filter((c) => c !== "id"),
            ],
            viaFk: edge.column,
          },
        ],
        labelPaths: paths,
      };
    }
    return {
      groupTable: onlyTable,
      groupCols: paths.map(colOf),
      joins: [],
      labelPaths: paths,
    };
  }

  const edges = fkEdgesFor(primaryTable);
  const groupCols: string[] = [];
  const joinsByTable = new Map<string, JoinNeed>();

  for (const path of paths) {
    const table = tableOf(path) || primaryTable;
    const col = colOf(path);

    if (table === primaryTable) {
      if (!groupCols.includes(col)) groupCols.push(col);
      continue;
    }

    const edge = edges.find((e) => e.target === table);
    if (edge) {
      if (!groupCols.includes(edge.column)) groupCols.push(edge.column);
      const prev = joinsByTable.get(table);
      if (prev) {
        if (!prev.columns.includes(col) && col !== "id") prev.columns.push(col);
      } else {
        joinsByTable.set(table, {
          table,
          columns: col === "id" ? ["id"] : ["id", col],
          viaFk: edge.column,
        });
      }
      continue;
    }

    // Unknown relation — group by bare column name on primary if possible
    if (!groupCols.includes(col)) groupCols.push(col);
  }

  if (!groupCols.length) return null;
  return {
    groupTable: primaryTable,
    groupCols,
    joins: [...joinsByTable.values()],
    labelPaths: paths,
  };
}

/** Copy non-@ filter keys from template primary onto agg table object. */
function copyWhereFromTemplate(
  bodyTemplate: Record<string, unknown> | null,
  primaryTable: string,
  target: Record<string, unknown>,
) {
  if (!isPlainObject(bodyTemplate?.["[]"])) return;
  const src = bodyTemplate!["[]"]![primaryTable];
  if (!isPlainObject(src)) return;
  for (const [k, v] of Object.entries(src)) {
    if (k.startsWith("@")) continue;
    if (k.endsWith("@")) continue;
    target[k] = structuredClone(v);
  }
}

/**
 * Build an APIJSON get body for chart aggregation:
 * `@column` + `@group` (+ `@having` when useful).
 */
function sqlAggFn(op: ChartAggOp, col: string): string {
  switch (op) {
    case "avg":
      return `avg(${col})`;
    case "max":
      return `max(${col})`;
    case "min":
      return `min(${col})`;
    case "count":
      return `count(${col})`;
    case "sum":
    default:
      return `sum(${col})`;
  }
}

export function buildChartAggregateBody(opts: {
  primaryTable: string;
  labelPaths: string[];
  valuePath: string | ChartValueSpec;
  bodyTemplate?: Record<string, unknown> | null;
  /** Max groups to return */
  count?: number;
}): { body: Record<string, unknown>; meta: ChartAggMeta } | null {
  const primary = opts.primaryTable;
  if (!primary) return null;

  const plan = resolveGroupPlan(primary, opts.labelPaths);
  if (!plan) return null;

  const spec =
    typeof opts.valuePath === "string"
      ? parseChartValue(opts.valuePath)
      : opts.valuePath;

  // Array-length metrics are not portable SQL in APIJSON → skip server agg
  if (spec.measureKind === "arrayLen") return null;

  const useCount = spec.path === "__count__";
  let metricCol: string | undefined;
  let aggOp: ChartAggOp = useCount ? "count" : spec.agg;
  const groupTable = plan.groupTable;

  if (!useCount) {
    const vt = tableOf(spec.path);
    const col = colOf(spec.path);
    if (!vt || vt === groupTable) {
      metricCol = col;
    }
  }

  const effectiveUseCount = useCount || !metricCol;
  if (effectiveUseCount) aggOp = "count";
  const groupCols = plan.groupCols;

  const aggExpr = effectiveUseCount
    ? `count(id):${VALUE_ALIAS}`
    : `${sqlAggFn(aggOp, metricCol!)}:${VALUE_ALIAS}`;

  const having = effectiveUseCount
    ? "count(id)>0"
    : `${sqlAggFn(aggOp, metricCol!)}>0`;

  // Ensure metric column is available on the table object when aggregating
  const tableObj: Record<string, unknown> = {
    "@column": `${groupCols.join(",")};${aggExpr}`,
    "@group": groupCols.join(","),
    "@having": having,
  };
  if (groupTable === primary) {
    copyWhereFromTemplate(opts.bodyTemplate ?? null, primary, tableObj);
  }

  const list: Record<string, unknown> = {
    count: Math.min(100, Math.max(opts.count ?? 100, 1)),
    page: 0,
    [groupTable]: tableObj,
  };

  // JOIN display tables when grouping on primary via FK
  if (groupTable === primary) {
    for (const j of plan.joins) {
      const cols = [...new Set(["id", ...j.columns.filter((c) => c !== "id")])];
      list[j.table] = {
        "id@": `/${primary}/${j.viaFk}`,
        "@column": cols.join(","),
      };
    }
  }

  // APIJSON: multi-table must declare join inside []
  setListJoin(list, groupTable);

  return {
    body: { "[]": list },
    meta: {
      groupCols,
      labelPaths: plan.labelPaths,
      valueAlias: VALUE_ALIAS,
      groupTable,
      useCount: effectiveUseCount,
      metricCol,
      aggOp,
    },
  };
}

/** Turn aggregate list response into chart points. */
export function pointsFromAggregateResponse(
  response: unknown,
  meta: ChartAggMeta,
): ChartPoint[] | null {
  const rows = flattenAggRows(response);
  if (!rows.length) return [];

  const points: ChartPoint[] = [];
  for (const cells of rows) {
    const parts = meta.labelPaths.map((path) => {
      const v = cells[path];
      if (v != null && String(v).trim() !== "") return String(v).trim();
      const col = colOf(path);
      const g = cells[`${meta.groupTable}.${col}`];
      if (g != null && String(g).trim() !== "") return String(g).trim();
      return String(cells[col] ?? "—");
    });
    const raw = parts.join(" / ") || "(空)";
    const label = raw.length > 28 ? raw.slice(0, 27) + "…" : raw;

    let value =
      toNumber(cells[`${meta.groupTable}.${meta.valueAlias}`]) ??
      toNumber(cells[meta.valueAlias]) ??
      null;

    if (value == null) {
      for (const [k, v] of Object.entries(cells)) {
        if (k.endsWith(`.${meta.valueAlias}`) || k === meta.valueAlias) {
          value = toNumber(v);
          if (value != null) break;
        }
      }
    }
    if (value == null) continue;
    points.push({ label, value });
  }

  return points;
}

export type ChartQueryResult = {
  points: ChartPoint[];
  body: Record<string, unknown>;
  response: unknown;
  meta: ChartAggMeta;
};

async function postGet(
  apijsonBase: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ ok: true; json: unknown } | { ok: false }> {
  try {
    const res = await fetch(`${apijsonBase.replace(/\/$/, "")}/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      credentials: "include",
      body: JSON.stringify(body),
      signal,
    });
    const json = (await res.json()) as { code?: number };
    if (!res.ok || json.code !== 200) return { ok: false };
    return { ok: true, json };
  } catch {
    return { ok: false };
  }
}

function stripHaving(body: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(body);
  const list = next["[]"];
  if (!isPlainObject(list)) return next;
  for (const v of Object.values(list)) {
    if (isPlainObject(v) && "@having" in v) delete v["@having"];
  }
  return next;
}

/**
 * Query APIJSON for grouped chart data. Returns null on failure
 * (caller keeps local preview). Retries without @having if needed.
 */
export async function fetchChartAggregate(opts: {
  apijsonBase: string;
  primaryTable: string;
  labelPaths: string[];
  valuePath: string | ChartValueSpec;
  bodyTemplate?: Record<string, unknown> | null;
  signal?: AbortSignal;
}): Promise<ChartQueryResult | null> {
  const built = buildChartAggregateBody({
    primaryTable: opts.primaryTable,
    labelPaths: opts.labelPaths,
    valuePath: opts.valuePath,
    bodyTemplate: opts.bodyTemplate,
  });
  if (!built) return null;

  const attempts = [built.body, stripHaving(built.body)];
  for (const body of attempts) {
    const res = await postGet(opts.apijsonBase, body, opts.signal);
    if (!res.ok) continue;
    const points = pointsFromAggregateResponse(res.json, built.meta);
    if (points == null) continue;
    return {
      points,
      body,
      response: res.json,
      meta: built.meta,
    };
  }
  return null;
}

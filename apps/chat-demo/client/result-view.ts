/** Parse APIJSON responses into flat rows for table / detail form rendering. */

import {
  buildPoints,
  CHART_KIND_OPTIONS,
  chartKindLabel,
  chartValueTitle,
  colorForField,
  ensureFieldColors,
  isIdLikeColumn,
  listChartMeasures,
  defaultDimensionName,
  listFieldValueOptions,
  listLabelColumns,
  listNumericColumns,
  newChartDimensionId,
  parseChartValue,
  pickChartFields,
  serializeChartValue,
  toCssColor,
  type ChartDimension,
  type ChartKind,
  type ChartValueSpec,
} from "./charts.js";
import {
  disposeChart,
  renderEcharts,
  type ChartSeriesInput,
} from "./chart-echarts.js";
import { fetchChartAggregate } from "./chart-query.js";

export type { ChartDimension };
import {
  allFieldTypes,
  ambiguousColumnNames,
  buildDefaultMetas,
  ensureColumnOrder,
  fieldTypeLabel,
  headerLabel,
  inferFieldType,
  type ColumnMeta,
  type FieldType,
} from "./field-meta.js";
import { mountFkFieldControl } from "./fk-picker.js";
import {
  buildFkGetBody,
  cellFkJumpMeta,
  FK_DISPLAY_FIELDS,
  joinedFkTableLinkMeta,
  resolveFkTable,
  resolveHighConfidenceFkTable,
  type FkJumpMeta,
} from "./fk-nav.js";
import {
  DEFAULT_FK_COLUMNS,
  FK_OPTIONAL_COLUMNS,
  defaultFkColumns,
  fkEdgesFor,
  type FkJoinSpec,
} from "./fk-expand.js";
import {
  JOIN_OP_OPTIONS,
  listTablesInBody,
  type JoinOp,
} from "./join-query.js";
import { CATALOG_TABLES, tablesAvailableToAdd } from "./query-tables.js";
import type { SchemaComments } from "./schema-types.js";
import type { OnJoinMode } from "./field-meta.js";
import {
  emptyCondition,
  filterHasValue,
  filtersForPath,
  newConditionId,
  sortDirOf,
  type ColumnFilter,
  type ColumnSort,
  type FilterCondition,
  type FilterJoin,
  type FilterOp,
} from "./table-query.js";

export type { SchemaComments } from "./schema-types.js";
export type { ColumnMeta, FieldType } from "./field-meta.js";

export type ViewMode = "list" | "detail";
export type DisplayKind = "combined" | "table" | ChartKind;

/** Registered by list render; toolbar「新增」calls this. */
let listCreateAction: (() => void) | null = null;

export function triggerListCreate(): boolean {
  if (!listCreateAction) return false;
  listCreateAction();
  return true;
}

function makeBackIconButton(onClick: () => void): HTMLButtonElement {
  const back = document.createElement("button");
  back.type = "button";
  back.className = "detail-back-icon";
  back.title = "返回";
  back.setAttribute("aria-label", "返回");
  back.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
  back.onclick = onClick;
  return back;
}

export type FlatRow = {
  key: string;
  cells: Record<string, unknown>;
  raw: unknown;
};

/** Top-level APIJSON envelope keys — never business data. */
const META_KEYS = new Set([
  "code",
  "msg",
  "ok",
  "count",
  "span",
  "time",
  "warn",
  "throw",
  "config",
  "sql",
  "debug",
  "depth",
  "sql:generate|cache|execute|maxExecute",
  "debug:info|help",
  "depth:count|max",
  "time:start|duration|end|parse|sql",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Envelope / debug keys: code, msg, debug:info|help, sql:…, time:… */
function isMetaKey(key: string): boolean {
  if (META_KEYS.has(key)) return true;
  if (key.includes(":")) return true;
  if (/^(code|msg|ok|count|span|time|warn|throw|config)$/i.test(key)) {
    return true;
  }
  return false;
}

/** Business table object: PascalCase name (User, Moment, …). */
function isTableKey(key: string): boolean {
  return /^[A-Z][A-Za-z0-9_]*$/.test(key);
}

/** List container: `[]` or `Moment[]` / `User[]` … */
function isListKey(key: string): boolean {
  return key === "[]" || key.endsWith("[]");
}

/**
 * Pick list array from response: prefer `[]`, else first `Key[]`.
 */
function extractListArray(
  response: Record<string, unknown>,
): { key: string; arr: unknown[] } | null {
  if (Array.isArray(response["[]"])) {
    return { key: "[]", arr: response["[]"] as unknown[] };
  }
  for (const [k, v] of Object.entries(response)) {
    if (isListKey(k) && Array.isArray(v)) return { key: k, arr: v };
  }
  return null;
}

/**
 * Only table objects from a response / list item (drop meta & lists).
 */
function extractTableObjects(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isMetaKey(k) || isListKey(k)) continue;
    if (isTableKey(k) && isPlainObject(v)) out[k] = v;
  }
  return out;
}

function flattenObject(
  obj: Record<string, unknown>,
  prefix = "",
  out: Record<string, unknown> = {},
): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    if (isMetaKey(k) || isListKey(k)) continue;
    // At root of a payload, only descend into table objects
    if (!prefix && !isTableKey(k)) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v) && !Array.isArray(v)) {
      const keys = Object.keys(v);
      const looksLikeEntity =
        keys.some((x) => x === "id" || x === "name" || x === "content") ||
        isTableKey(k);
      if (looksLikeEntity || prefix === "") {
        flattenObject(v, path, out);
      } else {
        out[path] = JSON.stringify(v);
      }
    } else if (Array.isArray(v)) {
      // Keep real arrays so detail/table can show JSON content (not "[N items]")
      out[path] = v;
    } else {
      out[path] = v;
    }
  }
  return out;
}

function rowIdFromCells(
  cells: Record<string, unknown>,
  fallback: string | number,
): string {
  for (const t of ["Moment", "Comment", "User"]) {
    const id = cells[`${t}.id`];
    if (id != null && id !== "") return String(id);
  }
  for (const [k, v] of Object.entries(cells)) {
    if (k.endsWith(".id") && v != null && v !== "") return String(v);
  }
  return String(fallback);
}

function columnsFromRows(rows: FlatRow[]): string[] {
  const colSet = new Set<string>();
  for (const r of rows) {
    for (const c of Object.keys(r.cells)) colSet.add(c);
  }
  const preferred = [
    "Moment.id",
    "Moment.content",
    "Moment.date",
    "User.id",
    "User.name",
    "Comment.id",
    "Comment.content",
    "Comment.date",
  ];
  return [
    ...preferred.filter((c) => colSet.has(c)),
    ...[...colSet].filter((c) => !preferred.includes(c)).sort(),
  ];
}

export function inferViewMode(
  response: unknown,
  preferred?: ViewMode,
): ViewMode {
  if (preferred) return preferred;
  if (!isPlainObject(response)) return "detail";
  if (extractListArray(response)) return "list";
  if (Object.keys(extractTableObjects(response)).length) return "detail";
  return "detail";
}

/**
 * Parse APIJSON response:
 * - list: `[]` or `Table[]` arrays
 * - detail: top-level PascalCase table objects only
 * Envelope fields (code/msg/debug:…/sql:…) are never business columns.
 */
export function parseResponse(response: unknown): {
  mode: ViewMode;
  rows: FlatRow[];
  columns: string[];
} {
  if (!isPlainObject(response)) {
    return { mode: "detail", rows: [], columns: [] };
  }

  const list = extractListArray(response);
  if (list) {
    const rows: FlatRow[] = list.arr.map((item, idx) => {
      const tables = isPlainObject(item)
        ? extractTableObjects(item)
        : {};
      const cells = flattenObject(tables);
      return {
        key: rowIdFromCells(cells, idx),
        cells,
        raw: item,
      };
    });
    return { mode: "list", rows, columns: columnsFromRows(rows) };
  }

  const tables = extractTableObjects(response);
  const cells = flattenObject(tables);
  const columns = Object.keys(cells).sort((a, b) => {
    const score = (x: string) =>
      x.endsWith(".id")
        ? 0
        : x.endsWith(".name")
          ? 1
          : x.endsWith(".content")
            ? 2
            : 3;
    return score(a) - score(b) || a.localeCompare(b);
  });
  return {
    mode: "detail",
    rows: columns.length
      ? [
          {
            key: rowIdFromCells(cells, "detail"),
            cells,
            raw: tables,
          },
        ]
      : [],
    columns,
  };
}

function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) || (typeof v === "object" && v)) {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function cellPrettyJson(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") {
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v;
    }
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return cellText(v);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Resolve DDL comment for "Table.column" or bare "Table". */
export function commentFor(
  path: string,
  comments?: SchemaComments | null,
): string {
  if (!comments) return "";
  if (comments.columns[path]) return comments.columns[path]!;
  if (comments.tables[path]) return comments.tables[path]!;
  const dot = path.indexOf(".");
  if (dot > 0) {
    const table = path.slice(0, dot);
    const col = path.slice(dot + 1);
    const colC = comments.columns[`${table}.${col}`] || "";
    const tabC = comments.tables[table] || "";
    if (colC && tabC) return `${tabC} · ${colC}`;
    return colC || tabC;
  }
  return comments.tables[path] || "";
}

function tooltip(path: string, comments?: SchemaComments | null): string {
  const c = commentFor(path, comments);
  return c ? `${path}\n${c}` : path;
}

function shortLabel(
  path: string,
  ambiguous: Set<string>,
  displayName?: string,
): string {
  return headerLabel(path, ambiguous, displayName);
}

export interface ResultViewState {
  viewMode: ViewMode;
  parsed: ReturnType<typeof parseResponse>;
  selectedKey: string | null;
  page: number;
  count: number;
}

export type TableDdlApplyPayload = {
  table: string;
  /** Checked columns for @column / FK expand */
  selectedColumns: string[];
  /** Per-field meta patch (displayName / ON …) */
  fieldMetas: Record<string, Partial<ColumnMeta>>;
  /** Table-level join op for secondary tables */
  joinOp: JoinOp;
  /** id@ reference: /onTable/onField */
  onTable: string;
  onField: string;
};

export function renderResultView(
  container: HTMLElement,
  opts: {
    response: unknown;
    viewMode?: ViewMode;
    page?: number;
    count?: number;
    comments?: SchemaComments | null;
    sorts?: ColumnSort[];
    filters?: ColumnFilter[];
    columnOrder?: string[];
    columnMetas?: Record<string, ColumnMeta>;
    displayKind?: DisplayKind;
    /** @deprecated prefer chartDimensions */
    chartLabelPath?: string;
    /** @deprecated use chartFieldValues — global fallback for migration */
    chartValuePath?: string;
    chartDimensions?: ChartDimension[];
    /** Per classification-field colors */
    chartFieldColors?: Record<string, string>;
    /** Per classification-field Y-axis value (serialized ChartValueSpec) */
    chartFieldValues?: Record<string, string>;
    /** 综合模式是否同时显示表格 */
    combinedShowTable?: boolean;
    onSortCycle?: (path: string) => void;
    onFilterApply?: (filter: ColumnFilter | null, path: string) => void;
    filterCombineExpr?: string;
    onCombineExprChange?: (expr: string) => void;
    onColumnOrderChange?: (order: string[]) => void;
    onColumnMetasChange?: (metas: Record<string, ColumnMeta>) => void;
    onDisplayKindChange?: (kind: DisplayKind) => void;
    onChartConfigChange?: (
      dimensions: ChartDimension[],
      fieldValues: Record<string, string>,
      combinedShowTable?: boolean,
      fieldColors?: Record<string, string>,
    ) => void;
    /** Debug: chart aggregate APIJSON request / response */
    onChartAggregate?: (info: {
      body: Record<string, unknown>;
      response: unknown;
      ok: boolean;
    }) => void;
    onBackToList?: () => void;
    onSaveDetail?: (payload: WritePayload) => void | Promise<void>;
    onWrite?: (payload: WritePayload) => void | Promise<void>;
    primaryTable?: string | null;
    bodyTemplate?: Record<string, unknown> | null;
    apijsonBaseUrl?: string;
    /** Secondary table → JOIN op (`&` `|` `!` `<` `>` `)` `(` or `` APP). */
    tableJoins?: Record<string, JoinOp>;
    onJoinChange?: (table: string, op: JoinOp) => void;
    fkExpand?: Record<string, FkJoinSpec>;
    /** Add / remove / set-primary query tables in bodyTemplate. */
    onAddQueryTable?: (table: string) => void;
    onRemoveQueryTable?: (table: string) => void;
    onSetPrimaryTable?: (table: string) => void;
    onTableDdlApply?: (payload: TableDdlApplyPayload) => void;
  },
): ResultViewState {
  const preferred = opts.viewMode;
  const parsed = parseResponse(opts.response);
  const mode: ViewMode =
    preferred === "detail"
      ? "detail"
      : parsed.mode === "list"
        ? "list"
        : "detail";
  const comments = opts.comments ?? null;
  const sorts = opts.sorts ?? [];
  const filters = opts.filters ?? [];
  const displayKind = opts.displayKind ?? "table";
  const write = opts.onWrite ?? opts.onSaveDetail;
  const apijsonBase = (opts.apijsonBaseUrl || "http://localhost:8080").replace(
    /\/$/,
    "",
  );

  container.innerHTML = "";
  container.classList.remove("hidden");
  listCreateAction = null;

  const state: ResultViewState = {
    viewMode: mode,
    parsed,
    selectedKey: null,
    page: opts.page ?? 0,
    count: opts.count ?? parsed.rows.length,
  };

  const primaryTable =
    opts.primaryTable ||
    inferPrimaryTable(parsed.columns, opts.bodyTemplate) ||
    null;

  if (mode === "detail" && parsed.rows[0]) {
    renderDetailForm(container, parsed.rows[0], {
      comments,
      mode: "edit",
      apijsonBase,
      onBack: opts.onBackToList ?? null,
      onSave: write,
      onDelete: write
        ? () => {
            const table = pickPrimaryTable(parsed.rows[0]!) || primaryTable;
            if (!table) return;
            const id = parsed.rows[0]!.cells[`${table}.id`] ?? parsed.rows[0]!.key;
            const payload = buildDeleteBody(table, [id as string | number]);
            if (payload) void write(payload);
          }
        : undefined,
    });
    return state;
  }

  if (!parsed.rows.length) {
    if (primaryTable && write) {
      listCreateAction = () =>
        openCreateForm(container, {
          table: primaryTable,
          columns: parsed.columns,
          comments,
          apijsonBase,
          onBack: () => renderResultView(container, opts),
          onSubmit: write,
        });
    }
    const empty = document.createElement("div");
    empty.className = "result-empty";
    empty.textContent =
      opts.response == null ? "等待数据…" : "无数据（或请求未返回业务字段）";
    container.appendChild(empty);
    return state;
  }

  const order = ensureColumnOrder(
    parsed.columns,
    opts.columnOrder,
    parsed.rows,
    comments,
  );
  const metas = buildDefaultMetas(
    parsed.columns,
    parsed.rows,
    comments,
    opts.columnMetas,
  );
  const ambiguous = ambiguousColumnNames(parsed.columns);
  const visibleCols = order.filter((p) => metas[p]?.visible !== false);

  // 表格 | 图表(已配置组合) | 具体类型(只显示该类型)
  const viewTabs = document.createElement("div");
  viewTabs.className = "display-tabs";
  for (const [kind, label] of [
    ["table", "表格"],
    ["combined", "图表"],
    ["bar", "柱状图"],
    ["line", "折线图"],
    ["area", "面积图"],
    ["pie", "饼状图"],
    ["doughnut", "环形图"],
  ] as const) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "display-tab" + (displayKind === kind ? " active" : "");
    b.textContent = label;
    if (kind === "combined") {
      b.title = "显示左侧已配置的图表（可多维度、多字段同图不同色）";
    } else if (kind !== "table") {
      b.title = `只显示${label}`;
    }
    b.onclick = () => opts.onDisplayKindChange?.(kind);
    viewTabs.appendChild(b);
  }
  container.appendChild(viewTabs);

  const isCombined = displayKind === "combined";
  const isChartOnly =
    displayKind !== "table" && displayKind !== "combined";

  const tablesInView = [
    ...new Set(
      parsed.columns
        .map((c) => c.split(".")[0]!)
        .filter((t) => /^[A-Z]/.test(t)),
    ),
  ];

  const registerCreate = () => {
    if (!primaryTable || !write) return;
    listCreateAction = () =>
      openCreateForm(container, {
        table: primaryTable,
        columns: parsed.columns,
        comments,
        apijsonBase,
        onBack: () => {
          for (const el of Array.from(
            container.querySelectorAll(LIST_HIDE_SEL),
          )) {
            el.classList.remove("hidden");
          }
          container
            .querySelector("#result-detail-host")
            ?.classList.add("hidden");
        },
        onSubmit: write,
      });
  };
  registerCreate();

  if (isCombined || isChartOnly) {
    const chartHost = document.createElement("div");
    chartHost.className = "chart-host" + (isCombined ? " chart-host-combined" : "");
    chartHost.id = "result-chart-host";
    container.appendChild(chartHost);

    const numeric = listNumericColumns(parsed.columns, parsed.rows);
    const labels = listLabelColumns(visibleCols, numeric);
    const labelChoices = labels.length
      ? labels
      : visibleCols.filter((c) => !isIdLikeColumn(c));

    // 图表字段池：本查询全部表全部字段（与表格「可见列」配置解耦）
    const queryTablesForChart =
      opts.bodyTemplate && isPlainObject(opts.bodyTemplate["[]"])
        ? listTablesInBody(opts.bodyTemplate)
        : tablesInView;
    const queryFieldChoices = (() => {
      const paths = new Set<string>();
      for (const c of parsed.columns) paths.add(c);
      for (const c of Object.keys(metas)) {
        if (c.includes(".")) paths.add(c);
      }
      if (comments?.columns) {
        for (const key of Object.keys(comments.columns)) {
          if (key.includes(".")) paths.add(key);
        }
      }
      const tables = queryTablesForChart.length
        ? queryTablesForChart
        : tablesInView;
      for (const t of tables) {
        for (const col of collectTableColumns(t, parsed.columns, comments)) {
          paths.add(`${t}.${col}`);
        }
      }
      return [...paths].sort((a, b) => a.localeCompare(b));
    })();
    const fieldOptionLabel = (c: string) =>
      queryTablesForChart.length > 1 ||
      ambiguous.has(c.split(".").pop() || "")
        ? c
        : shortLabel(c, ambiguous);

    const numberPathsFromMeta = Object.entries(metas)
      .filter(([, m]) => m.type === "number")
      .map(([p]) => p);
    const measures = listChartMeasures(
      parsed.columns,
      parsed.rows,
      (p) => shortLabel(p, ambiguous),
      {
        activeTables: tablesInView.length ? tablesInView : undefined,
        numberPathsFromMeta,
      },
    );
    const pick = pickChartFields(
      parsed.columns,
      parsed.rows,
      undefined,
      opts.chartLabelPath,
    );

    const nextUnusedQueryField = (dims: ChartDimension[]): string | null => {
      const used = new Set<string>();
      for (const d of dims) {
        if (d.groupBy) used.add(d.groupBy);
        for (const f of d.fields) used.add(f);
      }
      return (
        queryFieldChoices.find((c) => !used.has(c) && !isIdLikeColumn(c)) ??
        queryFieldChoices.find((c) => !used.has(c)) ??
        null
      );
    };

    const defaultKindForIndex = (i: number): ChartKind =>
      CHART_KIND_OPTIONS[i % CHART_KIND_OPTIONS.length]!.kind;

    let seededDefaultDims = false;
    let fieldColors = ensureFieldColors(
      queryFieldChoices,
      opts.chartFieldColors ?? {},
    );
    const defaultGroupBy = (): string =>
      opts.chartLabelPath ||
      pick?.labelPath ||
      labelChoices[0] ||
      queryFieldChoices.find((c) => !isIdLikeColumn(c)) ||
      queryFieldChoices[0] ||
      "";

    const normalizeDim = (d: ChartDimension, i: number): ChartDimension => {
      const groupBy =
        d.groupBy && queryFieldChoices.includes(d.groupBy)
          ? d.groupBy
          : d.fields[0] && queryFieldChoices.includes(d.fields[0])
            ? d.fields[0]
            : defaultGroupBy();
      return {
        id: d.id,
        name: (d.name && d.name.trim()) || defaultDimensionName(i),
        groupBy: groupBy || defaultGroupBy(),
        fields: [...d.fields],
        chartKind: d.chartKind ?? defaultKindForIndex(i),
        enabled: d.enabled !== false,
        fieldsOpen: d.fieldsOpen !== false,
      };
    };

    let dimensions: ChartDimension[];
    if (opts.chartDimensions && opts.chartDimensions.length) {
      dimensions = opts.chartDimensions.map(normalizeDim);
    } else {
      const g = defaultGroupBy();
      dimensions = [
        {
          id: newChartDimensionId(),
          name: defaultDimensionName(0),
          groupBy: g,
          fields: g ? [g] : [],
          chartKind: "bar",
          enabled: true,
        },
      ];
      if (isCombined) {
        const second = nextUnusedQueryField(dimensions);
        if (second) {
          dimensions.push({
            id: newChartDimensionId(),
            name: defaultDimensionName(1),
            groupBy: second,
            fields: [second],
            chartKind: "pie",
            enabled: true,
          });
        }
      }
      seededDefaultDims = true;
    }

    const toolbar = document.createElement("div");
    toolbar.className = "chart-toolbar";

    const addDimBtn = document.createElement("button");
    addDimBtn.type = "button";
    addDimBtn.className = "chart-dim-add";
    addDimBtn.textContent = "+ 维度";
    addDimBtn.title = isCombined
      ? "新增一张图表（自带分类字段栏）"
      : "新增一张图（自带分类字段栏）";
    toolbar.appendChild(addDimBtn);
    chartHost.appendChild(toolbar);

    // Per category-field Y value (serialized). Migrate legacy global chartValuePath.
    let fieldValues: Record<string, string> = {
      ...(opts.chartFieldValues ?? {}),
    };
    if (opts.chartValuePath && !Object.keys(fieldValues).length) {
      const legacy = opts.chartValuePath;
      for (const c of queryFieldChoices) fieldValues[c] = legacy;
    }

    const valueSpecForField = (fieldPath: string): ChartValueSpec => {
      const spec = parseChartValue(fieldValues[fieldPath]);
      if (spec.path === "__count__") return { path: "__count__", agg: "count" };
      // Only allow aggregating this field itself (not other fields)
      if (spec.path !== fieldPath) return { path: "__count__", agg: "count" };
      const kind =
        measures.find((x) => x.path === fieldPath)?.kind ??
        (/List$/i.test(fieldPath.split(".").pop() || "")
          ? "arrayLen"
          : "number");
      return { ...spec, measureKind: kind };
    };

    const plots = document.createElement("div");
    plots.className = "chart-plots";
    chartHost.appendChild(plots);

    const emitConfig = () => {
      opts.onChartConfigChange?.(
        dimensions.map((d, i) => ({
          id: d.id,
          name: (d.name && d.name.trim()) || defaultDimensionName(i),
          groupBy: d.groupBy || defaultGroupBy(),
          fields: [...d.fields],
          chartKind: d.chartKind,
          enabled: d.enabled !== false,
          fieldsOpen: d.fieldsOpen !== false,
        })),
        { ...fieldValues },
        undefined,
        { ...fieldColors },
      );
    };

    const measureKindOf = (
      fieldPath: string,
    ): "number" | "arrayLen" | null => {
      const m = measures.find((x) => x.path === fieldPath);
      if (m) return m.kind;
      const name = fieldPath.split(".").pop() || fieldPath;
      if (/List$/i.test(name)) return "arrayLen";
      if (/Count$/i.test(name)) return "number";
      const meta = metas[fieldPath];
      if (meta?.type === "number") return "number";
      return null;
    };

    /** Y-axis for this field only: 行数 | 求和 | 平均 | 最大 | 最小 */
    const mountFieldValueControls = (
      host: HTMLElement,
      fieldPath: string,
    ): void => {
      const wrap = document.createElement("div");
      wrap.className = "chart-dim-field-value";
      wrap.title = "本字段 Y 轴：行数，或对本字段求和 / 平均 / 最大 / 最小";

      let spec = valueSpecForField(fieldPath);
      // Drop stale cross-field measure selections
      if (spec.path !== "__count__" && spec.path !== fieldPath) {
        spec = { path: "__count__", agg: "count" };
      }
      const kind = measureKindOf(fieldPath);
      if (spec.path === fieldPath && kind) {
        spec = { ...spec, measureKind: kind };
      }

      const valueSel = document.createElement("select");
      valueSel.className = "chart-field-select chart-field-metric";
      valueSel.title = "行数或聚合函数";

      const options = listFieldValueOptions(fieldPath, kind ?? "number");
      const current = serializeChartValue(spec);
      for (const opt of options) {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        if (opt.value === current) o.selected = true;
        valueSel.appendChild(o);
      }
      if (![...valueSel.options].some((o) => o.value === current)) {
        valueSel.value = "__count__";
      }

      valueSel.onchange = () => {
        const next = parseChartValue(valueSel.value);
        if (next.path !== "__count__") {
          next.measureKind = kind ?? next.measureKind ?? "number";
        }
        fieldValues = {
          ...fieldValues,
          [fieldPath]: serializeChartValue(next),
        };
        emitConfig();
      };

      wrap.appendChild(valueSel);
      host.appendChild(wrap);
    };

    let chartQueryGen = 0;
    let chartAbort: AbortController | null = null;

    const kindForDim = (dim: ChartDimension): ChartKind => {
      if (isCombined) {
        return dim.chartKind ?? "bar";
      }
      return displayKind as ChartKind;
    };

    const setSourceLabel = (
      sourceEl: HTMLElement,
      source: "local" | "server" | "pending" | "fallback",
    ) => {
      sourceEl.className = `chart-source chart-source-${source}`;
      if (source === "local") {
        sourceEl.textContent = "本地预览 · 已加载本页数据";
      } else if (source === "pending") {
        sourceEl.textContent = "本地预览 · 正在请求 APIJSON 聚合…";
      } else if (source === "server") {
        sourceEl.textContent = "APIJSON · @group / @having 聚合 · ECharts";
      } else {
        sourceEl.textContent = "本地预览 · 聚合查询未成功，仍显示本页数据";
      }
    };

    const paintMulti = (
      host: HTMLElement,
      sourceEl: HTMLElement,
      series: ChartSeriesInput[],
      title: string,
      source: "local" | "server" | "pending" | "fallback",
      kind: ChartKind,
    ) => {
      const canvas = host.querySelector(".chart-canvas") as HTMLElement | null;
      if (!canvas) return;
      renderEcharts(canvas, kind, series, title);
      setSourceLabel(sourceEl, source);
    };

    const mountSeriesChip = (
      host: HTMLElement,
      dim: ChartDimension,
      c: string,
    ) => {
      const checked = dim.fields.includes(c);
      const chip = document.createElement("div");
      chip.className = "chart-dim-field" + (checked ? " is-checked" : "");

      const fieldColor = document.createElement("input");
      fieldColor.type = "color";
      fieldColor.className = "chart-color-input chart-field-color";
      fieldColor.title = `颜色 · ${fieldOptionLabel(c)}`;
      fieldColor.value = toCssColor(
        colorForField(c, fieldColors, queryFieldChoices),
      );
      fieldColor.oninput = () => {
        fieldColors = {
          ...fieldColors,
          [c]: toCssColor(fieldColor.value),
        };
        emitConfig();
      };

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "chart-dim-field-cb";
      cb.checked = checked;
      cb.title = "加入本图系列（多选=同图多色）";
      cb.onchange = () => {
        if (cb.checked) {
          if (!dim.fields.includes(c)) dim.fields.push(c);
          fieldColors = ensureFieldColors([c], fieldColors);
          if (!fieldValues[c]) {
            fieldValues = {
              ...fieldValues,
              [c]: serializeChartValue({
                path: "__count__",
                agg: "count",
              }),
            };
          }
        } else {
          dim.fields = dim.fields.filter((f) => f !== c);
        }
        emitConfig();
      };

      const name = document.createElement("span");
      name.className = "chart-dim-field-name";
      name.textContent = fieldOptionLabel(c);
      name.title = c;
      name.onclick = () => {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change"));
      };

      chip.append(fieldColor, cb, name);
      if (checked) mountFieldValueControls(chip, c);
      host.appendChild(chip);
    };

    /** Category title bar for one dimension — sits above that chart only. */
    const mountDimTitleBar = (
      host: HTMLElement,
      dim: ChartDimension,
      idx: number,
    ) => {
      const bar = document.createElement("div");
      bar.className = "chart-dim-titlebar";

      const head = document.createElement("div");
      head.className = "chart-dim-head";

      if (isCombined) {
        const enLab = document.createElement("label");
        enLab.className = "chart-dim-enable";
        const enCb = document.createElement("input");
        enCb.type = "checkbox";
        enCb.checked = dim.enabled !== false;
        enCb.title = "显示此图";
        enCb.onchange = () => {
          dim.enabled = enCb.checked;
          emitConfig();
        };
        enLab.append(enCb);
        head.appendChild(enLab);

        const kindSel = document.createElement("select");
        kindSel.className = "chart-dim-kind";
        kindSel.title = "图表形式";
        for (const opt of CHART_KIND_OPTIONS) {
          const o = document.createElement("option");
          o.value = opt.kind;
          o.textContent = opt.label;
          if ((dim.chartKind ?? "bar") === opt.kind) o.selected = true;
          kindSel.appendChild(o);
        }
        kindSel.onchange = () => {
          dim.chartKind = kindSel.value as ChartKind;
          emitConfig();
        };
        head.appendChild(kindSel);
      } else {
        const kindTag = document.createElement("span");
        kindTag.className = "chart-dim-kind-tag";
        kindTag.textContent = chartKindLabel(kindForDim(dim));
        head.appendChild(kindTag);
      }

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "chart-dim-title-input";
      nameInput.value = dim.name || defaultDimensionName(idx);
      nameInput.title = "维度名称（可编辑）";
      nameInput.placeholder = defaultDimensionName(idx);
      nameInput.onchange = () => {
        dim.name = nameInput.value.trim() || defaultDimensionName(idx);
        emitConfig();
      };
      nameInput.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          nameInput.blur();
        }
      };
      head.appendChild(nameInput);

      const groupLab = document.createElement("label");
      groupLab.className = "chart-dim-groupby";
      groupLab.title = "分类 / X 轴分组字段（本查询全部表字段）";
      const groupPrefix = document.createElement("span");
      groupPrefix.textContent = "分组";
      const groupSel = document.createElement("select");
      groupSel.className = "chart-dim-groupby-select";
      for (const c of queryFieldChoices) {
        const o = document.createElement("option");
        o.value = c;
        o.textContent = fieldOptionLabel(c);
        if ((dim.groupBy || "") === c) o.selected = true;
        groupSel.appendChild(o);
      }
      if (
        dim.groupBy &&
        ![...groupSel.options].some((o) => o.value === dim.groupBy)
      ) {
        const o = document.createElement("option");
        o.value = dim.groupBy;
        o.textContent = dim.groupBy;
        o.selected = true;
        groupSel.appendChild(o);
      }
      groupSel.onchange = () => {
        dim.groupBy = groupSel.value;
        emitConfig();
      };
      groupLab.append(groupPrefix, groupSel);
      head.appendChild(groupLab);

      const fieldsOpen = dim.fieldsOpen !== false;
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "chart-dim-fields-toggle";
      const syncToggleLabel = (open: boolean) => {
        toggleBtn.textContent = open ? "折叠" : "展开";
        toggleBtn.title = open
          ? "折叠可选字段"
          : "展开可选字段（本查询全部表字段）";
        toggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
      };
      syncToggleLabel(fieldsOpen);
      head.appendChild(toggleBtn);

      if (dimensions.length > 1) {
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "chart-dim-x";
        rm.textContent = "×";
        rm.title = "移除此图";
        rm.onclick = () => {
          dimensions = dimensions.filter((d) => d.id !== dim.id);
          emitConfig();
        };
        head.appendChild(rm);
      }
      bar.appendChild(head);

      // 可选多选：可折叠；默认展开
      const picker = document.createElement("div");
      picker.className = "chart-dim-fields chart-dim-fields-picker";
      picker.title = "可选系列字段（本查询全部表字段）";
      if (!fieldsOpen) picker.classList.add("is-collapsed");
      for (const c of queryFieldChoices) {
        mountSeriesChip(picker, dim, c);
      }
      toggleBtn.onclick = () => {
        const next = dim.fieldsOpen === false;
        dim.fieldsOpen = next;
        picker.classList.toggle("is-collapsed", !next);
        syncToggleLabel(next);
        emitConfig();
      };
      bar.appendChild(picker);
      host.appendChild(bar);
    };

    const fillDimChart = (
      wrap: HTMLElement,
      sourceEl: HTMLElement,
      dim: ChartDimension,
      gen: number,
      signal: AbortSignal,
    ) => {
      const kind = kindForDim(dim);
      const groupBy = dim.groupBy || defaultGroupBy();
      const fieldPaths = [...dim.fields];
      const dimTitle =
        (dim.name && dim.name.trim()) ||
        defaultDimensionName(dimensions.indexOf(dim));

      if (!groupBy || (isCombined && dim.enabled === false)) {
        const canvas = wrap.querySelector(".chart-canvas") as HTMLElement | null;
        if (canvas) {
          disposeChart(canvas);
          canvas.innerHTML = `<div class="result-empty">${
            isCombined && dim.enabled === false
              ? "已关闭显示"
              : "请选择分组字段"
          }</div>`;
        }
        setSourceLabel(sourceEl, "local");
        return;
      }

      // No series checked → single series: 行数 by groupBy
      const seriesPaths = fieldPaths.length ? fieldPaths : [groupBy];
      const localSeries: ChartSeriesInput[] = seriesPaths.map((fieldPath) => {
        const spec = fieldPaths.length
          ? valueSpecForField(fieldPath)
          : { path: "__count__" as const, agg: "count" as const };
        const valueTitle = chartValueTitle(spec, (p) =>
          shortLabel(p, ambiguous),
        );
        const seriesName = fieldPaths.length
          ? `${fieldOptionLabel(fieldPath)} · ${valueTitle}`
          : valueTitle;
        return {
          name: seriesName,
          color: toCssColor(
            colorForField(fieldPath, fieldColors, queryFieldChoices),
          ),
          // Shared X = groupBy; Y = this series field's agg
          points: buildPoints(parsed.rows, [groupBy], spec),
        };
      });

      const groupLabel = fieldOptionLabel(groupBy);
      const title = `${dimTitle} · ${chartKindLabel(kind)} · 按 ${groupLabel}`;
      paintMulti(wrap, sourceEl, localSeries, title, "pending", kind);

      if (!primaryTable || !apijsonBase) {
        paintMulti(wrap, sourceEl, localSeries, title, "local", kind);
        return;
      }

      void (async () => {
        const results = await Promise.all(
          seriesPaths.map(async (fieldPath) => {
            const spec = fieldPaths.length
              ? valueSpecForField(fieldPath)
              : { path: "__count__" as const, agg: "count" as const };
            const valueTitle = chartValueTitle(spec, (p) =>
              shortLabel(p, ambiguous),
            );
            const color = toCssColor(
              colorForField(fieldPath, fieldColors, queryFieldChoices),
            );
            const name = fieldPaths.length
              ? `${fieldOptionLabel(fieldPath)} · ${valueTitle}`
              : valueTitle;
            const result = await fetchChartAggregate({
              apijsonBase,
              primaryTable,
              labelPaths: [groupBy],
              valuePath: spec,
              bodyTemplate: opts.bodyTemplate ?? null,
              signal,
            });
            if (result) {
              opts.onChartAggregate?.({
                body: result.body,
                response: result.response,
                ok: true,
              });
              return {
                name,
                color,
                points: result.points,
                ok: true as const,
              };
            }
            return {
              name,
              color,
              points: localSeries.find((s) => s.name === name)?.points ?? [],
              ok: false as const,
            };
          }),
        );
        if (gen !== chartQueryGen || signal.aborted) return;
        const serverSeries: ChartSeriesInput[] = results.map((r) => ({
          name: r.name,
          color: r.color,
          points: r.points,
        }));
        const allOk = results.every((r) => r.ok);
        const anyOk = results.some((r) => r.ok);
        paintMulti(
          wrap,
          sourceEl,
          anyOk ? serverSeries : localSeries,
          anyOk ? `${title}（全量聚合）` : title,
          allOk ? "server" : anyOk ? "server" : "fallback",
          kind,
        );
      })();
    };

    /** Each dimension → own chart card with its category title bar. */
    const renderCharts = () => {
      chartAbort?.abort();
      chartAbort = new AbortController();
      const gen = ++chartQueryGen;
      const signal = chartAbort.signal;

      for (const el of Array.from(
        plots.querySelectorAll<HTMLElement>(".chart-canvas"),
      )) {
        disposeChart(el);
      }
      plots.innerHTML = "";

      if (!dimensions.length) {
        plots.innerHTML =
          `<div class="result-empty">点击「+ 维度」添加图表</div>`;
        return;
      }

      dimensions.forEach((dim, idx) => {
        const wrap = document.createElement("div");
        wrap.className =
          "chart-plot" +
          (isCombined && dim.enabled === false ? " is-off" : "");
        wrap.dataset.dim = dim.id;

        mountDimTitleBar(wrap, dim, idx);

        const sourceEl = document.createElement("div");
        sourceEl.className = "chart-source chart-source-local";
        const canvas = document.createElement("div");
        canvas.className = "chart-canvas";
        wrap.append(sourceEl, canvas);
        plots.appendChild(wrap);

        fillDimChart(wrap, sourceEl, dim, gen, signal);
      });
    };

    addDimBtn.onclick = () => {
      const next = nextUnusedQueryField(dimensions);
      const g = next || defaultGroupBy();
      if (g) fieldColors = ensureFieldColors([g], fieldColors);
      const i = dimensions.length;
      dimensions = [
        ...dimensions,
        {
          id: newChartDimensionId(),
          name: defaultDimensionName(i),
          groupBy: g,
          fields: g ? [g] : [],
          chartKind: defaultKindForIndex(i),
          enabled: true,
        },
      ];
      emitConfig();
    };
    renderCharts();
    if (seededDefaultDims) {
      emitConfig();
    }

    // 图表 / 具体类型：只出图，不附带底部表格
    if (isChartOnly || isCombined) {
      return state;
    }
  }

  if (displayKind === "table") {
  const tableWrap = document.createElement("div");
  tableWrap.className = "table-wrap";
  tableWrap.id = "result-table-wrap";

  const selected = new Set<string>();
  const queryTables =
    opts.bodyTemplate && isPlainObject(opts.bodyTemplate["[]"])
      ? listTablesInBody(opts.bodyTemplate)
      : tablesInView;
  const joinTables = queryTables.filter((t) => t !== (primaryTable || ""));
  const statusBar = buildTableStatusBar({
    pageCount: parsed.rows.length,
    selectedCount: 0,
    tables: queryTables.length ? queryTables : tablesInView,
    columns: parsed.columns,
    comments,
    primaryTable: primaryTable || "记录",
    joinTables,
    tableJoins: opts.tableJoins ?? {},
    onJoinChange: opts.onJoinChange,
    fkExpand: opts.fkExpand ?? {},
    columnMetas: metas,
    bodyTemplate: opts.bodyTemplate ?? null,
    onTableDdlApply: opts.onTableDdlApply,
    onAddQueryTable: opts.onAddQueryTable,
    onRemoveQueryTable: opts.onRemoveQueryTable,
    onSetPrimaryTable: opts.onSetPrimaryTable,
    onBatchDelete:
      primaryTable && write
        ? () => {
            const ids = [...selected].map((k) => {
              const row = parsed.rows.find((r) => r.key === k);
              const id =
                row?.cells[`${primaryTable}.id`] ?? (Number(k) || k);
              return id as string | number;
            });
            const payload = buildDeleteBody(primaryTable, ids);
            if (payload) void write(payload);
          }
        : undefined,
  });
  tableWrap.appendChild(statusBar);

  const activeFilters = filters.filter((f) =>
    f.conditions.some((c) => c.value.trim()),
  );
  if (activeFilters.length > 0) {
    tableWrap.appendChild(
      buildCombineExprBar({
        value: opts.filterCombineExpr ?? "",
        filters: activeFilters,
        onApply: opts.onCombineExprChange,
      }),
    );
  }

  const table = document.createElement("table");
  table.className = "data-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.id = "result-head-row";

  const thCheck = document.createElement("th");
  thCheck.className = "col-check";
  const checkAll = document.createElement("input");
  checkAll.type = "checkbox";
  checkAll.title = "全选本页";
  thCheck.appendChild(checkAll);
  headRow.appendChild(thCheck);

  for (const col of visibleCols) {
    headRow.appendChild(
      buildColumnHeader(col, {
        comments,
        sorts,
        filters,
        meta: metas[col]!,
        ambiguous,
        rows: parsed.rows,
        onSortCycle: opts.onSortCycle,
        onFilterApply: opts.onFilterApply,
      }),
    );
  }

  // Rightmost: column settings
  const thSettings = document.createElement("th");
  thSettings.className = "col-settings-head";
  const settingsBtn = document.createElement("button");
  settingsBtn.type = "button";
  settingsBtn.className = "col-icon settings-icon";
  settingsBtn.title = "字段显示 / 筛选 / 排序 / 类型";
  settingsBtn.textContent = "⚙";
  settingsBtn.onclick = (e) => {
    e.stopPropagation();
    openColumnSettings(settingsBtn, order, metas, comments, ambiguous, (next) => {
      opts.onColumnMetasChange?.(next);
    });
  };
  thSettings.appendChild(settingsBtn);
  const thAction = document.createElement("th");
  thAction.textContent = "操作";
  headRow.appendChild(thSettings);
  headRow.appendChild(thAction);
  thead.appendChild(headRow);
  table.appendChild(thead);

  enableColumnDrag(headRow, visibleCols, order, (nextOrder) => {
    opts.onColumnOrderChange?.(nextOrder);
  });

  const syncBatchUi = () => {
    const label = statusBar.querySelector(".status-selected");
    const delBtn = statusBar.querySelector(".batch-del") as HTMLElement | null;
    if (label) label.textContent = `已选 ${selected.size} 项`;
    label?.classList.toggle("is-active", selected.size > 0);
    if (delBtn) delBtn.classList.toggle("hidden", selected.size === 0);
    const boxes = tbody.querySelectorAll<HTMLInputElement>("input.row-check");
    checkAll.checked = boxes.length > 0 && selected.size === boxes.length;
    checkAll.indeterminate =
      selected.size > 0 && selected.size < boxes.length;
  };

  const openRowDetail = (
    key: string,
    mode: "view" | "edit",
  ) =>
    showDetail(container, state, key, comments, {
      mode,
      apijsonBase,
      onBack: opts.onBackToList,
      onSave: mode === "edit" ? write : undefined,
      onDelete: write
        ? () => {
            const row = parsed.rows.find((r) => r.key === key);
            const table =
              (row && pickPrimaryTable(row)) || primaryTable;
            if (!table || !row) return;
            const id = row.cells[`${table}.id`] ?? row.key;
            const payload = buildDeleteBody(table, [id as string | number]);
            if (payload) void write(payload);
          }
        : undefined,
    });

  const tbody = document.createElement("tbody");
  for (const row of parsed.rows) {
    const tr = document.createElement("tr");
    tr.dataset.key = row.key;

    const tdCheck = document.createElement("td");
    tdCheck.className = "col-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "row-check";
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => {
      if (cb.checked) selected.add(row.key);
      else selected.delete(row.key);
      syncBatchUi();
    };
    tdCheck.appendChild(cb);
    tr.appendChild(tdCheck);

    for (const col of visibleCols) {
      const td = document.createElement("td");
      const rawVal = row.cells[col];
      const text = formatCell(rawVal, metas[col]?.type ?? "text");
      const tip = commentFor(col, comments);
      const typeTip = metas[col] ? fieldTypeLabel(metas[col]!.type) : "";
      const fk = cellFkJumpMeta(
        col,
        rawVal,
        row.cells,
        comments,
        primaryTable,
      );
      if (fk) {
        const a = document.createElement("button");
        a.type = "button";
        a.className = "fk-link";
        // Prefer real joined field (User.name…); never invent "User#id"
        const shown = fk.label || text;
        a.textContent = truncate(shown, 48);
        const mapField = (FK_DISPLAY_FIELDS[fk.table] ?? ["name"])[0];
        const isJoinedCol = col.startsWith(`${fk.table}.`);
        a.title = [
          tip,
          typeTip && `类型: ${typeTip}`,
          isJoinedCol
            ? `${col} → ${fk.table}#${fk.id}`
            : fk.label
              ? `${col}=${text} → ${fk.table}.${mapField}=${fk.label}`
              : `${col}=${text}（未关联到 ${fk.table}.${mapField}，请检查 JOIN）`,
          "点击查看详情",
        ]
          .filter(Boolean)
          .join("\n");
        a.onclick = (e) => {
          e.stopPropagation();
          void openFkDetail(container, {
            table: fk.table,
            id: fk.id,
            comments,
            apijsonBase,
            onBack: opts.onBackToList,
            onWrite: write,
          });
        };
        td.appendChild(a);
      } else {
        td.textContent = truncate(text, 48);
        td.title = [tip, typeTip && `类型: ${typeTip}`, `值: ${text}`]
          .filter(Boolean)
          .join("\n");
      }
      tr.appendChild(td);
    }
    tr.appendChild(document.createElement("td")); // settings spacer
    const tdAct = document.createElement("td");
    tdAct.className = "row-actions";
    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "linkish";
    viewBtn.textContent = "查看";
    viewBtn.onclick = (e) => {
      e.stopPropagation();
      openRowDetail(row.key, "view");
    };
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "linkish";
    editBtn.textContent = "编辑";
    editBtn.onclick = (e) => {
      e.stopPropagation();
      openRowDetail(row.key, "edit");
    };
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "linkish danger-link";
    delBtn.textContent = "删除";
    delBtn.onclick = (e) => {
      e.stopPropagation();
      if (!write || !primaryTable) return;
      if (!confirm(`确认删除 #${row.key}？此操作不可撤销。`)) return;
      const id = row.cells[`${primaryTable}.id`] ?? row.key;
      const payload = buildDeleteBody(primaryTable, [id as string | number]);
      if (payload) void write(payload);
    };
    tdAct.append(viewBtn, sep(), editBtn, sep(), delBtn);
    tr.appendChild(tdAct);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  checkAll.onchange = () => {
    const boxes = tbody.querySelectorAll<HTMLInputElement>("input.row-check");
    selected.clear();
    for (const box of Array.from(boxes)) {
      box.checked = checkAll.checked;
      const key = box.closest("tr")?.dataset.key;
      if (checkAll.checked && key) selected.add(key);
    }
    syncBatchUi();
  };
  tableWrap.appendChild(table);
  container.appendChild(tableWrap);
  }

  const detailHost = document.createElement("div");
  detailHost.id = "result-detail-host";
  detailHost.className = "hidden";
  container.appendChild(detailHost);

  return state;
}

function formatCell(v: unknown, type: FieldType): string {
  const raw = cellText(v);
  if (type === "percent" && raw && /^-?\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    return n <= 1 && n >= -1 ? `${(n * 100).toFixed(1)}%` : `${n}%`;
  }
  return raw;
}

function sep(): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "row-action-sep";
  s.textContent = "|";
  return s;
}

function buildColumnHeader(
  col: string,
  opts: {
    comments: SchemaComments | null;
    sorts: ColumnSort[];
    filters: ColumnFilter[];
    meta: ColumnMeta;
    ambiguous: Set<string>;
    rows?: FlatRow[];
    onSortCycle?: (path: string) => void;
    onFilterApply?: (filter: ColumnFilter | null, path: string) => void;
  },
): HTMLTableCellElement {
  const th = document.createElement("th");
  th.className = "col-head";
  th.dataset.path = col;
  th.title = `${tooltip(col, opts.comments)}\n类型: ${fieldTypeLabel(opts.meta.type)}\n长按拖拽调序`;

  const wrap = document.createElement("div");
  wrap.className = "col-head-inner";

  if (opts.meta.filterable) {
    const filterBtn = document.createElement("button");
    filterBtn.type = "button";
    filterBtn.className = "col-icon filter-icon";
    const colFilter = filtersForPath(opts.filters, col);
    const active = colFilter ? filterHasValue(colFilter) : false;
    if (active) filterBtn.classList.add("active");
    const n = colFilter?.conditions.filter((c) => c.value.trim()).length ?? 0;
    filterBtn.title = `筛选（${fieldTypeLabel(opts.meta.type)}）· 可多条件与/或/非${n ? ` · ${n}条` : ""}`;
    filterBtn.textContent = n > 1 ? `▽${n}` : "▽";
    filterBtn.onclick = (e) => {
      e.stopPropagation();
      openFilterPopover(
        filterBtn,
        col,
        opts.meta.type,
        opts.filters,
        opts.comments,
        opts.onFilterApply,
        opts.rows ?? [],
      );
    };
    wrap.appendChild(filterBtn);
  }

  const label = document.createElement("span");
  label.className = "col-label";
  label.textContent = shortLabel(col, opts.ambiguous, opts.meta.displayName);
  wrap.appendChild(label);

  if (opts.meta.sortable) {
    const sortBtn = document.createElement("button");
    sortBtn.type = "button";
    sortBtn.className = "col-icon sort-icon";
    const dir = sortDirOf(opts.sorts, col);
    sortBtn.dataset.dir = dir;
    sortBtn.title =
      dir === "none"
        ? "点击升序"
        : dir === "asc"
          ? "升序 · 点击降序"
          : "降序 · 点击取消";
    sortBtn.innerHTML =
      dir === "asc"
        ? "<span class='on'>↑</span><span>↓</span>"
        : dir === "desc"
          ? "<span>↑</span><span class='on'>↓</span>"
          : "<span>↑</span><span>↓</span>";
    sortBtn.onclick = (e) => {
      e.stopPropagation();
      opts.onSortCycle?.(col);
    };
    wrap.appendChild(sortBtn);
  }

  th.appendChild(wrap);
  return th;
}

/** Long-press (~350ms) then drag to reorder columns. */
function enableColumnDrag(
  headRow: HTMLTableRowElement,
  visibleCols: string[],
  fullOrder: string[],
  onChange: (order: string[]) => void,
) {
  let pressTimer: number | null = null;
  let draggingPath: string | null = null;

  for (const th of Array.from(headRow.querySelectorAll<HTMLElement>("th.col-head"))) {
    const path = th.dataset.path!;
    th.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      pressTimer = window.setTimeout(() => {
        draggingPath = path;
        th.classList.add("dragging");
        th.setPointerCapture(e.pointerId);
      }, 350);
    });
    th.addEventListener("pointerup", (e) => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      if (!draggingPath) return;
      th.classList.remove("dragging");
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const targetTh = el?.closest("th.col-head") as HTMLElement | null;
      const targetPath = targetTh?.dataset.path;
      if (targetPath && targetPath !== draggingPath) {
        const vis = [...visibleCols];
        const from = vis.indexOf(draggingPath);
        const to = vis.indexOf(targetPath);
        if (from >= 0 && to >= 0) {
          vis.splice(from, 1);
          vis.splice(to, 0, draggingPath);
          // merge back into full order
          const next = [...fullOrder];
          const hidden = next.filter((p) => !vis.includes(p));
          onChange([...vis, ...hidden]);
        }
      }
      draggingPath = null;
    });
    th.addEventListener("pointermove", (e) => {
      if (!draggingPath) return;
      // visual hint: highlight drop target
      for (const other of Array.from(
        headRow.querySelectorAll<HTMLElement>("th.col-head"),
      )) {
        other.classList.remove("drop-target");
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const targetTh = el?.closest("th.col-head") as HTMLElement | null;
      if (targetTh && targetTh.dataset.path !== draggingPath) {
        targetTh.classList.add("drop-target");
      }
    });
    th.addEventListener("pointercancel", () => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = null;
      draggingPath = null;
      th.classList.remove("dragging");
    });
  }
}

function isRangeFieldType(type: FieldType): boolean {
  return (
    type === "number" ||
    type === "percent" ||
    type === "date" ||
    type === "time"
  );
}

function opsForType(type: FieldType): Array<{ value: FilterOp; label: string }> {
  if (type === "text" || type === "formula") {
    return [
      { value: "contains", label: "任意匹配" },
      { value: "prefix", label: "左前缀匹配" },
      { value: "suffix", label: "右后缀匹配" },
      { value: "eq", label: "等于" },
    ];
  }
  if (type === "number" || type === "percent") {
    return [
      { value: "gte", label: "大于等于" },
      { value: "lte", label: "小于等于" },
      { value: "eq", label: "等于" },
      { value: "gt", label: "大于" },
      { value: "lt", label: "小于" },
    ];
  }
  // date / time — default range is >= & <=
  return [
    { value: "gte", label: "不早于" },
    { value: "lte", label: "不晚于" },
    { value: "eq", label: "等于" },
    { value: "gt", label: "晚于" },
    { value: "lt", label: "早于" },
  ];
}

/** Min/max of a column on current rows, formatted for filter inputs. */
function columnRangeDefaults(
  path: string,
  fieldType: FieldType,
  rows: FlatRow[],
): { min: string; max: string } | null {
  if (!isRangeFieldType(fieldType) || !rows.length) return null;

  if (fieldType === "number" || fieldType === "percent") {
    let min = Infinity;
    let max = -Infinity;
    for (const row of rows) {
      const v = row.cells[path];
      const n =
        typeof v === "number"
          ? v
          : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())
            ? Number(v.trim())
            : NaN;
      if (!Number.isFinite(n)) continue;
      if (n < min) min = n;
      if (n > max) max = n;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    return { min: String(min), max: String(max) };
  }

  // date / time
  let minMs = Infinity;
  let maxMs = -Infinity;
  let minRaw = "";
  let maxRaw = "";
  for (const row of rows) {
    const v = row.cells[path];
    if (v == null || v === "") continue;
    const raw = String(v).trim();
    const ms = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T"));
    if (!Number.isFinite(ms)) continue;
    if (ms < minMs) {
      minMs = ms;
      minRaw = raw;
    }
    if (ms > maxMs) {
      maxMs = ms;
      maxRaw = raw;
    }
  }
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) return null;

  const toInput = (raw: string, ms: number): string => {
    if (fieldType === "date") {
      if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
      const d = new Date(ms);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }
    // time → datetime-local
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw)) {
      return raw.replace(" ", "T").slice(0, 16);
    }
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${day}T${hh}:${mm}`;
  };

  return {
    min: toInput(minRaw, minMs),
    max: toInput(maxRaw, maxMs),
  };
}

function defaultRangeConditions(
  fieldType: FieldType,
  rows: FlatRow[],
  path: string,
): FilterCondition[] {
  const range = columnRangeDefaults(path, fieldType, rows);
  return [
    {
      ...emptyCondition("gte"),
      value: range?.min ?? "",
      join: "and",
    },
    {
      ...emptyCondition("lte"),
      value: range?.max ?? "",
      join: "and",
    },
  ];
}

function inputTypeForField(type: FieldType): string {
  if (type === "date") return "date";
  if (type === "time") return "datetime-local";
  if (type === "number" || type === "percent") return "number";
  return "text";
}

function normalizeTimeValue(fieldType: FieldType, value: string): string {
  if (fieldType === "time" && value.includes("T")) {
    return value.replace("T", " ");
  }
  return value;
}

function formatDateInputValue(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDateTimeLocalValue(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${hh}:${mm}`;
}

function displayTimeValue(fieldType: FieldType, value: string): string {
  if (!value) return "";
  if (/^\d+$/.test(value)) {
    const ms = Number(value);
    if (Number.isFinite(ms)) {
      return fieldType === "date"
        ? formatDateInputValue(ms)
        : formatDateTimeLocalValue(ms);
    }
  }
  if (fieldType === "date") {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    const ms = Date.parse(value.includes("T") ? value : value.replace(" ", "T"));
    if (Number.isFinite(ms)) return formatDateInputValue(ms);
  }
  if (fieldType === "time") {
    if (value.includes(" ")) return value.replace(" ", "T").slice(0, 16);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return value.slice(0, 16);
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return formatDateTimeLocalValue(ms);
  }
  return value;
}

function looksLikeJsonField(path: string, value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (value != null && typeof value === "object") return true;
  const col = path.includes(".") ? path.split(".").pop()! : path;
  if (/list$/i.test(col) || /ids$/i.test(col)) return true;
  if (typeof value === "string") {
    const t = value.trim();
    if (
      (t.startsWith("[") && t.endsWith("]")) ||
      (t.startsWith("{") && t.endsWith("}"))
    ) {
      try {
        JSON.parse(t);
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == b;
  if (typeof a === "object" || typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return String(a) === String(b);
}

function openFilterPopover(
  anchor: HTMLElement,
  path: string,
  fieldType: FieldType,
  filters: ColumnFilter[],
  comments: SchemaComments | null,
  onApply?: (filter: ColumnFilter | null, path: string) => void,
  rows: FlatRow[] = [],
) {
  document.getElementById("filter-popover")?.remove();

  const existing = filtersForPath(filters, path);
  const ops = opsForType(fieldType);
  const defaultOp = ops[0]!.value;
  const rangeType = isRangeFieldType(fieldType);
  let draft: FilterCondition[] = existing?.conditions.length
    ? existing.conditions.map((c) => ({ ...c }))
    : rangeType
      ? defaultRangeConditions(fieldType, rows, path)
      : [emptyCondition(defaultOp)];

  const pop = document.createElement("div");
  pop.id = "filter-popover";
  pop.className = "filter-popover filter-popover-multi";

  const title = document.createElement("div");
  title.className = "filter-popover-title";
  const tip = commentFor(path, comments);
  title.textContent = tip
    ? `${path} — ${tip.split(" (")[0]} · ${fieldTypeLabel(fieldType)}`
    : `${path} · ${fieldTypeLabel(fieldType)}`;
  title.title = tooltip(path, comments);
  pop.appendChild(title);

  const hint = document.createElement("div");
  hint.className = "filter-combine-hint";
  hint.textContent = rangeType
    ? "默认两个条件：≥ 最小值 与 ≤ 最大值（可改）；条件间用 与 / 或，单项可勾选 非"
    : "同一字段可多条件；条件间用 与 / 或，单项可勾选 非";
  pop.appendChild(hint);

  const list = document.createElement("div");
  list.className = "filter-cond-list";
  pop.appendChild(list);

  const renderRows = () => {
    list.innerHTML = "";
    draft.forEach((cond, idx) => {
      const row = document.createElement("div");
      row.className = "filter-cond-row";

      if (idx === 0) {
        const first = document.createElement("span");
        first.className = "filter-join-label";
        first.textContent = "当";
        row.appendChild(first);
      } else {
        const joinSel = document.createElement("select");
        joinSel.className = "filter-join";
        for (const [v, lab] of [
          ["and", "与"],
          ["or", "或"],
        ] as const) {
          const o = document.createElement("option");
          o.value = v;
          o.textContent = lab;
          if ((cond.join ?? "and") === v) o.selected = true;
          joinSel.appendChild(o);
        }
        joinSel.onchange = () => {
          cond.join = joinSel.value as FilterJoin;
        };
        row.appendChild(joinSel);
      }

      const notLab = document.createElement("label");
      notLab.className = "filter-not";
      const notCb = document.createElement("input");
      notCb.type = "checkbox";
      notCb.checked = Boolean(cond.not);
      notCb.onchange = () => {
        cond.not = notCb.checked;
      };
      notLab.append(notCb, document.createTextNode("非"));
      row.appendChild(notLab);

      const opSel = document.createElement("select");
      opSel.className = "filter-op";
      for (const o of ops) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        if (cond.op === o.value) opt.selected = true;
        opSel.appendChild(opt);
      }
      opSel.onchange = () => {
        cond.op = opSel.value as FilterOp;
      };
      row.appendChild(opSel);

      const valInput = document.createElement("input");
      valInput.className = "filter-val";
      valInput.type = inputTypeForField(fieldType);
      if (fieldType === "percent") valInput.step = "0.01";
      valInput.value = displayTimeValue(fieldType, cond.value);
      valInput.placeholder =
        fieldType === "text"
          ? "值"
          : fieldType === "percent"
            ? "0-100"
            : "";
      valInput.oninput = () => {
        cond.value = valInput.value;
      };
      row.appendChild(valInput);

      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "filter-cond-rm";
      rm.title = "删除条件";
      rm.textContent = "×";
      rm.disabled = draft.length <= 1;
      rm.onclick = () => {
        draft = draft.filter((c) => c.id !== cond.id);
        if (!draft.length) {
          draft = rangeType
            ? defaultRangeConditions(fieldType, rows, path)
            : [emptyCondition(defaultOp)];
        }
        renderRows();
      };
      row.appendChild(rm);

      list.appendChild(row);
    });
  };
  renderRows();

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "filter-add-cond";
  addBtn.textContent = "+ 添加条件";
  addBtn.onclick = () => {
    draft.push({
      ...emptyCondition(defaultOp),
      id: newConditionId(),
      join: "and",
    });
    renderRows();
  };
  pop.appendChild(addBtn);

  const actions = document.createElement("div");
  actions.className = "filter-popover-actions";
  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = "primary";
  applyBtn.textContent = "应用";
  applyBtn.onclick = () => {
    const conditions = draft
      .map((c) => ({
        ...c,
        value: normalizeTimeValue(fieldType, c.value.trim()),
      }))
      .filter((c) => c.value !== "");
    if (!conditions.length) onApply?.(null, path);
    else onApply?.({ path, conditions }, path);
    pop.remove();
  };
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.textContent = "清除";
  clearBtn.onclick = () => {
    onApply?.(null, path);
    pop.remove();
  };
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "取消";
  cancelBtn.onclick = () => pop.remove();
  actions.append(applyBtn, clearBtn, cancelBtn);
  pop.appendChild(actions);

  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.top = `${rect.bottom + window.scrollY + 6}px`;
  pop.style.left = `${Math.min(rect.left + window.scrollX, window.innerWidth - 360)}px`;

  const closer = (ev: MouseEvent) => {
    if (!pop.contains(ev.target as Node) && ev.target !== anchor) {
      pop.remove();
      document.removeEventListener("mousedown", closer);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", closer), 0);
  list.querySelector<HTMLInputElement>(".filter-val")?.focus();
}

function openColumnSettings(
  anchor: HTMLElement,
  order: string[],
  metas: Record<string, ColumnMeta>,
  comments: SchemaComments | null,
  ambiguous: Set<string>,
  onSave: (metas: Record<string, ColumnMeta>) => void,
) {
  document.getElementById("col-settings-popover")?.remove();
  const pop = document.createElement("div");
  pop.id = "col-settings-popover";
  pop.className = "filter-popover col-settings-popover";

  const title = document.createElement("div");
  title.className = "filter-popover-title";
  title.textContent = "字段属性（类似 Excel）";
  pop.appendChild(title);

  const draft: Record<string, ColumnMeta> = structuredClone(metas);
  const list = document.createElement("div");
  list.className = "col-settings-list";

  for (const path of order) {
    const m = draft[path]!;
    const row = document.createElement("div");
    row.className = "col-settings-row";
    const name = document.createElement("div");
    name.className = "col-settings-name";
    name.textContent = shortLabel(path, ambiguous, m.displayName);
    name.title = tooltip(path, comments);
    row.appendChild(name);

    const typeSel = document.createElement("select");
    for (const t of allFieldTypes()) {
      const o = document.createElement("option");
      o.value = t;
      o.textContent = fieldTypeLabel(t);
      if (m.type === t) o.selected = true;
      typeSel.appendChild(o);
    }
    typeSel.onchange = () => {
      m.type = typeSel.value as FieldType;
    };
    row.appendChild(typeSel);

    for (const [key, label] of [
      ["visible", "显示"],
      ["filterable", "筛选"],
      ["sortable", "排序"],
    ] as const) {
      const lab = document.createElement("label");
      lab.className = "col-settings-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = m[key];
      cb.onchange = () => {
        m[key] = cb.checked;
      };
      lab.append(cb, document.createTextNode(label));
      row.appendChild(lab);
    }
    list.appendChild(row);
  }
  pop.appendChild(list);

  const actions = document.createElement("div");
  actions.className = "filter-popover-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary";
  saveBtn.textContent = "应用";
  saveBtn.onclick = () => {
    onSave(draft);
    pop.remove();
  };
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "取消";
  cancelBtn.onclick = () => pop.remove();
  actions.append(saveBtn, cancelBtn);
  pop.appendChild(actions);

  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.top = `${rect.bottom + window.scrollY + 6}px`;
  pop.style.left = `${Math.max(8, rect.right + window.scrollX - 420)}px`;

  const closer = (ev: MouseEvent) => {
    if (!pop.contains(ev.target as Node) && ev.target !== anchor) {
      pop.remove();
      document.removeEventListener("mousedown", closer);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", closer), 0);
}

export type WritePayload = {
  method: "put" | "post" | "delete";
  body: Record<string, unknown>;
  table: string;
};

/** @deprecated alias — use WritePayload */
export type DetailSavePayload = WritePayload;

export function inferPrimaryTable(
  columns: string[],
  bodyTemplate?: Record<string, unknown> | null,
): string | null {
  if (bodyTemplate && isPlainObject(bodyTemplate["[]"])) {
    const list = bodyTemplate["[]"] as Record<string, unknown>;
    for (const k of Object.keys(list)) {
      if (/^[A-Z]/.test(k) && isPlainObject(list[k])) return k;
    }
  }
  const fromCols = [
    ...new Set(
      columns.filter((c) => c.includes(".")).map((c) => c.split(".")[0]!),
    ),
  ];
  for (const t of ["Moment", "Comment", "User"]) {
    if (fromCols.includes(t)) return t;
  }
  return fromCols[0] ?? null;
}

export function createFieldDefaults(table: string): Record<string, unknown> {
  switch (table) {
    case "Moment":
      return { content: "" };
    case "Comment":
      return { content: "" };
    case "User":
      return { name: "", sex: 0 };
    default:
      return {};
  }
}

export function buildDeleteBody(
  table: string,
  ids: Array<string | number>,
): WritePayload | null {
  const nums = ids
    .map((id) => (typeof id === "number" ? id : Number(id)))
    .filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  if (nums.length === 1) {
    return {
      method: "delete",
      table,
      body: { [table]: { id: nums[0] }, tag: table },
    };
  }
  return {
    method: "delete",
    table,
    body: { [table]: { "id{}": nums }, tag: `${table}[]` },
  };
}

export function buildPostBody(
  table: string,
  fields: Record<string, unknown>,
): WritePayload {
  return {
    method: "post",
    table,
    body: { [table]: fields, tag: table },
  };
}

function pickPrimaryTable(row: FlatRow): string | null {
  const tables = [
    ...new Set(
      Object.keys(row.cells)
        .filter((k) => k.includes("."))
        .map((k) => k.split(".")[0]!),
    ),
  ];
  if (!tables.length) return null;
  const byId = tables.find(
    (t) => String(row.cells[`${t}.id`] ?? "") === row.key,
  );
  if (byId) return byId;
  for (const t of ["Moment", "Comment", "User"]) {
    if (tables.includes(t)) return t;
  }
  return tables[0]!;
}

function coerceField(original: unknown, text: string, path = ""): unknown {
  if (
    Array.isArray(original) ||
    (original != null && typeof original === "object") ||
    looksLikeJsonField(path, original)
  ) {
    const t = text.trim();
    if (t === "") return null;
    try {
      return JSON.parse(t);
    } catch {
      return text;
    }
  }
  const fieldType = path ? inferFieldType(path, [original]) : "text";
  if (fieldType === "time" || fieldType === "date") {
    if (text === "" && (original == null || original === "")) return null;
    const v =
      fieldType === "time" ? normalizeTimeValue("time", text) : text;
    if (typeof original === "number" && v) {
      const ms = Date.parse(v.includes(" ") ? v.replace(" ", "T") : v);
      if (Number.isFinite(ms)) return ms;
    }
    return v;
  }
  if (typeof original === "number") {
    const n = Number(text);
    return Number.isFinite(n) ? n : text;
  }
  if (typeof original === "boolean") {
    return text === "true" || text === "1";
  }
  if (text === "" && original == null) return null;
  if (
    (original == null || typeof original === "string") &&
    /^-?\d+(\.\d+)?$/.test(text) &&
    typeof original !== "string"
  ) {
    return Number(text);
  }
  return text;
}

/** Build APIJSON PUT body from edited primary-table fields. */
export function buildPutFromDetail(
  row: FlatRow,
  edited: Record<string, string>,
): DetailSavePayload | null {
  const table = pickPrimaryTable(row);
  if (!table) return null;
  const id = row.cells[`${table}.id`];
  if (id == null || id === "") return null;

  const entity: Record<string, unknown> = { id };
  let changed = false;
  for (const [path, text] of Object.entries(edited)) {
    if (!path.startsWith(`${table}.`)) continue;
    const col = path.slice(table.length + 1);
    if (!col || col === "id") continue;
    const next = coerceField(row.cells[path], text, path);
    const prev = row.cells[path];
    if (!valuesEqual(prev, next)) changed = true;
    entity[col] = next;
  }
  if (!changed && Object.keys(entity).length <= 1) return null;
  // still allow save if user explicitly hits save with same values? require change
  if (!changed) return null;

  return {
    method: "put",
    table,
    body: { [table]: entity, tag: table },
  };
}

const LIST_HIDE_SEL =
  "#result-table-wrap, .display-tabs, #result-chart-host, .table-status, .filter-combine-bar";

function buildCombineExprBar(opts: {
  value: string;
  filters: ColumnFilter[];
  onApply?: (expr: string) => void;
}): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "filter-combine-bar";

  const label = document.createElement("label");
  label.className = "filter-combine-label";
  label.textContent = "条件组合";
  label.title =
    "字段间与/或/非，例如：date & (name | tag) 或 !date & content";
  bar.appendChild(label);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "filter-combine-input";
  input.spellcheck = false;
  input.placeholder = "date & (name | tag)";
  input.value = opts.value;
  input.title = "可编辑：& 与 | 或 ! 非，括号分组；回车或失焦应用";
  bar.appendChild(input);

  const hint = document.createElement("span");
  hint.className = "filter-combine-hint-inline";
  const tokens = opts.filters.map((f) => {
    const col = f.path.includes(".") ? f.path.split(".").pop()! : f.path;
    return col;
  });
  hint.textContent = tokens.length ? `字段: ${tokens.join(", ")}` : "";
  bar.appendChild(hint);

  const apply = () => {
    const next = input.value.trim();
    if (next !== (opts.value || "").trim()) opts.onApply?.(next);
    else if (next) opts.onApply?.(next);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      apply();
    }
  });
  input.addEventListener("change", apply);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "应用";
  btn.onclick = apply;
  bar.appendChild(btn);

  return bar;
}

function buildTableStatusBar(opts: {
  pageCount: number;
  selectedCount: number;
  tables: string[];
  columns: string[];
  comments: SchemaComments | null;
  primaryTable: string;
  joinTables?: string[];
  tableJoins?: Record<string, JoinOp>;
  onJoinChange?: (table: string, op: JoinOp) => void;
  fkExpand?: Record<string, FkJoinSpec>;
  columnMetas?: Record<string, ColumnMeta>;
  bodyTemplate?: Record<string, unknown> | null;
  onTableDdlApply?: (payload: TableDdlApplyPayload) => void;
  onAddQueryTable?: (table: string) => void;
  onRemoveQueryTable?: (table: string) => void;
  onSetPrimaryTable?: (table: string) => void;
  onBatchDelete?: () => void;
}): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "table-status";

  const page = document.createElement("span");
  page.className = "status-page";
  page.textContent = `本页 ${opts.pageCount} 条`;
  bar.appendChild(page);

  const selected = document.createElement("span");
  selected.className =
    "status-selected" + (opts.selectedCount > 0 ? " is-active" : "");
  selected.textContent = `已选 ${opts.selectedCount} 项`;
  bar.appendChild(selected);

  if (opts.onBatchDelete) {
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className =
      "danger batch-del" + (opts.selectedCount > 0 ? "" : " hidden");
    delBtn.textContent = "删除";
    delBtn.onclick = () => {
      if (confirm(`确认删除选中的 ${opts.primaryTable}？`)) {
        opts.onBatchDelete?.();
      }
    };
    bar.appendChild(delBtn);
  }

  // Query tables: [+] then editable chips
  const tablesWrap = document.createElement("div");
  tablesWrap.className = "query-tables";

  if (opts.onAddQueryTable) {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "table-chip table-chip-add";
    addBtn.textContent = "+";
    addBtn.title = "添加要查询的表";
    addBtn.onclick = (e) => {
      e.stopPropagation();
      openAddTablePopover(addBtn, opts.tables, opts.onAddQueryTable!);
    };
    tablesWrap.appendChild(addBtn);
  }

  for (const t of opts.tables) {
    const chipWrap = document.createElement("span");
    chipWrap.className =
      "table-chip-wrap" +
      (t === opts.primaryTable ? " is-primary" : "");

    const isSecondary =
      opts.joinTables?.includes(t) &&
      t !== opts.primaryTable &&
      opts.onJoinChange;
    if (isSecondary) {
      const joinWrap = document.createElement("label");
      joinWrap.className = "join-op-wrap";
      joinWrap.title =
        "JOIN 方式：& INNER · | FULL · ! OUTER · < LEFT · > RIGHT · ( ANTI · ) SIDE · APP @";
      const joinSel = document.createElement("select");
      joinSel.className = "join-op-select";
      joinSel.setAttribute("aria-label", `${t} JOIN`);
      for (const opt of JOIN_OP_OPTIONS) {
        const o = document.createElement("option");
        o.value = opt.op;
        o.textContent = opt.label;
        if ((opts.tableJoins?.[t] ?? "") === opt.op) o.selected = true;
        joinSel.appendChild(o);
      }
      joinSel.onchange = () => {
        opts.onJoinChange?.(t, joinSel.value as JoinOp);
      };
      joinWrap.appendChild(joinSel);
      chipWrap.appendChild(joinWrap);
    }

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "table-chip";
    chip.textContent = t === opts.primaryTable ? `${t}·主` : t;
    chip.title =
      t === opts.primaryTable
        ? "主表 · 点击查看 DDL / 管理"
        : "点击查看 DDL / 设为主表 / 移除";
    chip.onclick = (e) => {
      e.stopPropagation();
      openTableDdlPopover(chip, {
        table: t,
        primaryTable: opts.primaryTable,
        columns: opts.columns,
        comments: opts.comments,
        fkExpand: opts.fkExpand ?? {},
        columnMetas: opts.columnMetas ?? {},
        bodyTemplate: opts.bodyTemplate ?? null,
        tableJoins: opts.tableJoins ?? {},
        queryTables: opts.tables,
        onApply: opts.onTableDdlApply,
        onSetPrimary:
          t !== opts.primaryTable && opts.onSetPrimaryTable
            ? () => opts.onSetPrimaryTable?.(t)
            : undefined,
        onRemove:
          opts.tables.length > 1 && opts.onRemoveQueryTable
            ? () => opts.onRemoveQueryTable?.(t)
            : undefined,
      });
    };
    chipWrap.appendChild(chip);

    if (opts.onRemoveQueryTable && opts.tables.length > 1) {
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "table-chip-x";
      rm.title = `从查询中移除 ${t}`;
      rm.textContent = "×";
      rm.onclick = (e) => {
        e.stopPropagation();
        if (t === opts.primaryTable) {
          if (
            !confirm(
              `移除主表 ${t}？将改用剩余表中的第一张作为主表。`,
            )
          ) {
            return;
          }
        }
        opts.onRemoveQueryTable?.(t);
      };
      chipWrap.appendChild(rm);
    }

    tablesWrap.appendChild(chipWrap);
  }

  bar.appendChild(tablesWrap);
  return bar;
}

function openAddTablePopover(
  anchor: HTMLElement,
  current: string[],
  onAdd: (table: string) => void,
) {
  document.getElementById("add-table-popover")?.remove();
  const available = tablesAvailableToAdd(current);
  const pop = document.createElement("div");
  pop.id = "add-table-popover";
  pop.className = "filter-popover add-table-popover";

  const title = document.createElement("div");
  title.className = "filter-popover-title";
  title.textContent = "添加查询表";
  pop.appendChild(title);

  if (!available.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "没有更多可添加的表";
    pop.appendChild(empty);
  } else {
    for (const t of available) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "add-table-item";
      btn.textContent = t;
      btn.onclick = () => {
        onAdd(t);
        pop.remove();
      };
      pop.appendChild(btn);
    }
  }

  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.top = `${rect.bottom + window.scrollY + 6}px`;
  pop.style.left = `${rect.left + window.scrollX}px`;
  const closer = (ev: MouseEvent) => {
    if (!pop.contains(ev.target as Node) && ev.target !== anchor) {
      pop.remove();
      document.removeEventListener("mousedown", closer);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", closer), 0);
}

function collectTableColumns(
  table: string,
  columns: string[],
  comments: SchemaComments | null,
): string[] {
  const cols = columns
    .filter((c) => c.startsWith(`${table}.`))
    .map((c) => c.slice(table.length + 1));
  if (comments?.columns) {
    for (const key of Object.keys(comments.columns)) {
      if (key.startsWith(`${table}.`)) {
        const col = key.slice(table.length + 1);
        if (col && !cols.includes(col)) cols.push(col);
      }
    }
  }
  for (const c of FK_OPTIONAL_COLUMNS[table] ?? []) {
    if (!cols.includes(c)) cols.push(c);
  }
  for (const c of DEFAULT_FK_COLUMNS[table] ?? []) {
    if (!cols.includes(c)) cols.push(c);
  }
  cols.sort((a, b) => a.localeCompare(b));
  return cols;
}

function selectedColumnsForTable(
  table: string,
  primaryTable: string,
  fkExpand: Record<string, FkJoinSpec>,
  bodyTemplate: Record<string, unknown> | null,
): string[] {
  if (table !== primaryTable) {
    const spec = fkExpand[table];
    if (spec?.enabled === false) return [];
    if (spec?.columns?.length) return [...spec.columns];
    return defaultFkColumns(table);
  }
  const list = bodyTemplate?.["[]"];
  if (isPlainObject(list) && isPlainObject(list[table])) {
    const col = list[table]!["@column"];
    if (typeof col === "string" && col.trim()) {
      return col.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  // Primary with no @column → default: all non-id from optional/known
  return (FK_OPTIONAL_COLUMNS[table] ?? ["id", "name", "content"]).filter(
    (c) => c !== "id",
  );
}

/**
 * Per-field ON defaults: only high-confidence FKs get filled; others stay empty.
 * - Primary *Id → ON 关联表.id
 * - Join table `id` with a known edge → ON 主表.fkCol
 */
function defaultOnForField(
  table: string,
  col: string,
  primaryTable: string,
  comments: SchemaComments | null,
): { onTable: string; onField: string; onJoin: OnJoinMode } {
  const empty = { onTable: "", onField: "", onJoin: "" as OnJoinMode };
  const path = `${table}.${col}`;

  if (table !== primaryTable && col === "id") {
    const edge = fkEdgesFor(primaryTable).find((e) => e.target === table);
    if (edge) {
      return {
        onTable: primaryTable,
        onField: edge.column,
        onJoin: "",
      };
    }
    return empty;
  }

  const fkTable = resolveHighConfidenceFkTable(path, comments);
  if (fkTable) {
    return { onTable: fkTable, onField: "id", onJoin: "" };
  }
  return empty;
}

function openTableDdlPopover(
  anchor: HTMLElement,
  opts: {
    table: string;
    primaryTable: string;
    columns: string[];
    comments: SchemaComments | null;
    fkExpand: Record<string, FkJoinSpec>;
    columnMetas: Record<string, ColumnMeta>;
    bodyTemplate: Record<string, unknown> | null;
    tableJoins: Record<string, JoinOp>;
    queryTables: string[];
    onApply?: (payload: TableDdlApplyPayload) => void;
    onSetPrimary?: () => void;
    onRemove?: () => void;
  },
) {
  document.getElementById("table-ddl-popover")?.remove();
  const pop = document.createElement("div");
  pop.id = "table-ddl-popover";
  pop.className = "filter-popover table-ddl-popover table-ddl-editor";

  const title = document.createElement("div");
  title.className = "filter-popover-title";
  const tableComment = opts.comments?.tables[opts.table] || "";
  const isPrimary = opts.table === opts.primaryTable;
  title.textContent = tableComment
    ? `${opts.table}${isPrimary ? "·主" : ""} — ${tableComment}`
    : `${opts.table}${isPrimary ? "·主" : ""}`;
  pop.appendChild(title);

  const tip = document.createElement("div");
  tip.className = "filter-combine-hint";
  tip.textContent = isPrimary
    ? "勾选要查询的字段；可设列显示名。外键列可配置关联表/关联字段/方式。"
    : "勾选要 JOIN 出来的字段（默认仅文本字段）；可设列显示名与关联表/字段。";
  pop.appendChild(tip);

  const headActions = document.createElement("div");
  headActions.className = "table-ddl-head-actions";
  if (opts.onSetPrimary) {
    const setPri = document.createElement("button");
    setPri.type = "button";
    setPri.textContent = "设为主表";
    setPri.onclick = () => {
      pop.remove();
      opts.onSetPrimary?.();
    };
    headActions.appendChild(setPri);
  }
  if (opts.onRemove) {
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "danger";
    rm.textContent = "移除表";
    rm.onclick = () => {
      pop.remove();
      opts.onRemove?.();
    };
    headActions.appendChild(rm);
  }
  if (headActions.childNodes.length) pop.appendChild(headActions);

  const list = document.createElement("div");
  list.className = "table-ddl-list";
  pop.appendChild(list);

  let joinOp: JoinOp = opts.tableJoins[opts.table] ?? "";

  type RowDraft = {
    col: string;
    selected: boolean;
    displayName: string;
    onTable: string;
    onField: string;
    onJoin: OnJoinMode;
  };

  const selectedSet = new Set(
    selectedColumnsForTable(
      opts.table,
      opts.primaryTable,
      opts.fkExpand,
      opts.bodyTemplate,
    ),
  );

  const renderEditor = (comments: SchemaComments | null) => {
    list.innerHTML = "";
    const cols = collectTableColumns(opts.table, opts.columns, comments);
    if (!cols.length) {
      list.innerHTML = `<div class="muted">暂无列信息</div>`;
      return;
    }

    const drafts: RowDraft[] = cols.map((col) => {
      const path = `${opts.table}.${col}`;
      const meta = opts.columnMetas[path];
      const defOn = defaultOnForField(
        opts.table,
        col,
        opts.primaryTable,
        comments,
      );
      return {
        col,
        selected: selectedSet.has(col),
        displayName: meta?.displayName ?? "",
        onTable: meta?.onTable ?? defOn.onTable,
        onField: meta?.onField ?? defOn.onField,
        onJoin: (meta?.onJoin ?? defOn.onJoin) as OnJoinMode,
      };
    });

    const header = document.createElement("div");
    header.className = "table-ddl-row table-ddl-head-row";
    header.innerHTML =
      "<span></span><span>字段</span><span>类型</span><span>注释</span><span>显示名</span><span>关联表</span><span>关联字段</span><span>方式</span>";
    list.appendChild(header);

    const otherTables = [
      ...new Set([
        ...CATALOG_TABLES,
        ...opts.queryTables,
        opts.primaryTable,
      ]),
    ].filter((t) => t && t !== "记录");

    const fillRelFieldOptions = (
      sel: HTMLSelectElement,
      relTable: string,
      selected: string,
    ) => {
      sel.innerHTML = "";
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "—";
      sel.appendChild(empty);
      if (!relTable) {
        sel.value = "";
        return;
      }
      const fields = collectTableColumns(relTable, opts.columns, comments);
      for (const f of fields) {
        const o = document.createElement("option");
        o.value = f;
        o.textContent = f;
        sel.appendChild(o);
      }
      if (selected && fields.includes(selected)) {
        sel.value = selected;
      } else if (selected) {
        // Preserve known value even if not in catalog yet
        const o = document.createElement("option");
        o.value = selected;
        o.textContent = selected;
        sel.appendChild(o);
        sel.value = selected;
      } else {
        sel.value = "";
      }
    };

    for (const d of drafts) {
      const path = `${opts.table}.${d.col}`;
      const row = document.createElement("div");
      row.className = "table-ddl-row table-ddl-edit-row";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = d.selected;
      cb.title = "勾选 = 查询/JOIN 此字段";
      cb.onchange = () => {
        d.selected = cb.checked;
      };

      const name = document.createElement("code");
      name.textContent = d.col;

      const type = document.createElement("span");
      type.className = "table-ddl-type";
      type.textContent = comments?.types?.[path] || "—";

      const comment = document.createElement("span");
      comment.className = "table-ddl-comment";
      const raw = comments?.columns?.[path] || "";
      comment.textContent = raw.replace(/\s*\([^)]*\)\s*$/, "") || "—";
      comment.title = raw;

      const displayIn = document.createElement("input");
      displayIn.type = "text";
      displayIn.className = "ddl-display-name";
      displayIn.placeholder = d.col;
      displayIn.value = d.displayName;
      displayIn.oninput = () => {
        d.displayName = displayIn.value;
      };

      const onTableSel = document.createElement("select");
      onTableSel.className = "ddl-on-select";
      onTableSel.setAttribute("aria-label", "关联表");
      const emptyT = document.createElement("option");
      emptyT.value = "";
      emptyT.textContent = "—";
      onTableSel.appendChild(emptyT);
      for (const t of otherTables) {
        const o = document.createElement("option");
        o.value = t;
        o.textContent = t;
        if (t === d.onTable) o.selected = true;
        onTableSel.appendChild(o);
      }

      const onFieldSel = document.createElement("select");
      onFieldSel.className = "ddl-on-select";
      onFieldSel.setAttribute("aria-label", "关联字段");
      fillRelFieldOptions(onFieldSel, d.onTable, d.onField);

      onTableSel.onchange = () => {
        d.onTable = onTableSel.value;
        d.onField = "";
        fillRelFieldOptions(onFieldSel, d.onTable, "");
      };
      onFieldSel.onchange = () => {
        d.onField = onFieldSel.value;
      };

      const onJoinSel = document.createElement("select");
      onJoinSel.className = "ddl-on-select";
      for (const opt of JOIN_OP_OPTIONS) {
        const o = document.createElement("option");
        o.value = opt.op;
        o.textContent = opt.label;
        if (opt.op === d.onJoin) o.selected = true;
        onJoinSel.appendChild(o);
      }
      onJoinSel.onchange = () => {
        d.onJoin = onJoinSel.value as OnJoinMode;
      };

      row.append(
        cb,
        name,
        type,
        comment,
        displayIn,
        onTableSel,
        onFieldSel,
        onJoinSel,
      );
      list.appendChild(row);
    }

    // stash drafts on list for apply
    (list as unknown as { __drafts?: RowDraft[] }).__drafts = drafts;
  };

  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = "primary";
  applyBtn.textContent = "应用";
  applyBtn.onclick = () => {
    const drafts =
      (list as unknown as { __drafts?: RowDraft[] }).__drafts ?? [];
    const selectedColumns = drafts.filter((d) => d.selected).map((d) => d.col);
    const fieldMetas: Record<string, Partial<ColumnMeta>> = {};
    for (const d of drafts) {
      const path = `${opts.table}.${d.col}`;
      fieldMetas[path] = {
        displayName: d.displayName.trim() || undefined,
        onTable: d.onTable || undefined,
        onField: d.onField || undefined,
        onJoin: d.onJoin,
      };
    }
    // Prefer ON from a selected field that has association filled
    const onSrc =
      drafts.find((d) => d.selected && d.onTable && d.onField) ||
      drafts.find((d) => d.onTable && d.onField);
    opts.onApply?.({
      table: opts.table,
      selectedColumns:
        selectedColumns.length > 0
          ? selectedColumns
          : isPrimary
            ? selectedColumns
            : defaultFkColumns(opts.table),
      fieldMetas,
      joinOp: (onSrc?.onJoin || joinOp) as JoinOp,
      onTable: onSrc?.onTable ?? "",
      onField: onSrc?.onField ?? "",
    });
    pop.remove();
  };

  const actions = document.createElement("div");
  actions.className = "filter-popover-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "关闭";
  cancel.onclick = () => pop.remove();
  actions.append(applyBtn, cancel);
  pop.appendChild(actions);

  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.top = `${rect.bottom + window.scrollY + 6}px`;
  pop.style.left = `${Math.min(rect.left + window.scrollX, window.innerWidth - 720)}px`;

  const closer = (ev: MouseEvent) => {
    if (!pop.contains(ev.target as Node) && ev.target !== anchor) {
      // don't close while interacting with selects inside
      if (pop.contains(ev.target as Node)) return;
      pop.remove();
      document.removeEventListener("mousedown", closer);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", closer), 0);

  const hasCols =
    opts.comments &&
    Object.keys(opts.comments.columns).some((k) =>
      k.startsWith(`${opts.table}.`),
    );
  if (!hasCols) {
    list.innerHTML = `<div class="muted">加载注释中…</div>`;
    void fetch(
      `/api/schema-comments?tables=${encodeURIComponent(opts.table)}`,
    )
      .then((r) => r.json())
      .then((data: SchemaComments) => {
        if (!document.body.contains(pop)) return;
        const next: SchemaComments = {
          tables: { ...(opts.comments?.tables ?? {}), ...(data.tables ?? {}) },
          columns: {
            ...(opts.comments?.columns ?? {}),
            ...(data.columns ?? {}),
          },
          types: { ...(opts.comments?.types ?? {}), ...(data.types ?? {}) },
        };
        const tc = next.tables[opts.table] || "";
        title.textContent = tc
          ? `${opts.table}${isPrimary ? "·主" : ""} — ${tc}`
          : `${opts.table}${isPrimary ? "·主" : ""}`;
        (
          window as unknown as {
            __a2apiSetComments?: (c: SchemaComments) => void;
          }
        ).__a2apiSetComments?.(next);
        renderEditor(next);
      })
      .catch(() => {
        if (document.body.contains(pop)) renderEditor(opts.comments);
      });
  } else {
    renderEditor(opts.comments);
  }
}

function createFkColumnHints(table: string): string[] {
  switch (table) {
    case "Moment":
      return ["userId"];
    case "Comment":
      return ["userId", "momentId"];
    default:
      return [];
  }
}

function openCreateForm(
  container: HTMLElement,
  opts: {
    table: string;
    columns: string[];
    comments: SchemaComments | null;
    apijsonBase: string;
    onBack: () => void;
    onSubmit: (payload: WritePayload) => void | Promise<void>;
  },
) {
  for (const el of Array.from(container.querySelectorAll(LIST_HIDE_SEL))) {
    el.classList.add("hidden");
  }
  let detailHost = container.querySelector("#result-detail-host");
  if (!(detailHost instanceof HTMLElement)) {
    detailHost = document.createElement("div");
    detailHost.id = "result-detail-host";
    container.appendChild(detailHost);
  }
  detailHost.classList.remove("hidden");
  detailHost.innerHTML = "";

  const defaults = createFieldDefaults(opts.table);
  const colNames = [
    ...new Set([
      ...createFkColumnHints(opts.table),
      ...Object.keys(defaults),
      ...opts.columns
        .filter((c) => c.startsWith(`${opts.table}.`))
        .map((c) => c.slice(opts.table.length + 1))
        .filter((c) => c && c !== "id"),
    ]),
  ];

  const card = document.createElement("div");
  card.className = "detail-form";
  const header = document.createElement("div");
  header.className = "detail-form-header";
  const goBack = () => {
    detailHost!.classList.add("hidden");
    detailHost!.innerHTML = "";
    for (const el of Array.from(container.querySelectorAll(LIST_HIDE_SEL))) {
      el.classList.remove("hidden");
    }
    opts.onBack();
  };
  header.appendChild(makeBackIconButton(goBack));
  const title = document.createElement("h3");
  title.textContent = `新增 ${opts.table}`;
  header.appendChild(title);
  card.appendChild(header);

  const section = document.createElement("div");
  section.className = "detail-table-title";
  section.textContent = opts.table;
  card.appendChild(section);

  const form = document.createElement("div");
  form.className = "detail-fields";
  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  const fkGetters = new Map<string, () => string | number | null>();
  for (const col of colNames) {
    const path = `${opts.table}.${col}`;
    const field = document.createElement("label");
    field.className = "detail-field";
    const name = document.createElement("span");
    name.className = "field-name";
    const tip = commentFor(path, opts.comments);
    name.textContent = tip ? `${path} — ${tip.split(" (")[0]}` : path;
    field.appendChild(name);

    const fkTable = resolveFkTable(path, opts.comments);
    const fieldType = inferFieldType(path, [defaults[col]], opts.comments);
    const defaultVal = defaults[col];
    if (fkTable) {
      const host = document.createElement("div");
      const ctl = mountFkFieldControl(host, {
        path,
        table: fkTable,
        apijsonBase: opts.apijsonBase,
        comments: opts.comments,
        onChange: () => undefined,
      });
      fkGetters.set(col, ctl.getValue);
      field.appendChild(host);
    } else if (looksLikeJsonField(path, defaultVal)) {
      const ta = document.createElement("textarea");
      ta.className = "detail-json-input";
      ta.dataset.kind = "json";
      ta.spellcheck = false;
      ta.rows = 4;
      ta.value =
        defaultVal == null || defaultVal === ""
          ? "[]"
          : cellPrettyJson(defaultVal);
      ta.placeholder = "[]";
      inputs.set(col, ta);
      field.appendChild(ta);
    } else if (fieldType === "date" || fieldType === "time") {
      const input = document.createElement("input");
      input.type = inputTypeForField(fieldType);
      input.dataset.kind = fieldType;
      input.value = displayTimeValue(fieldType, cellText(defaultVal ?? ""));
      inputs.set(col, input);
      field.appendChild(input);
    } else if (fieldType === "number") {
      const input = document.createElement("input");
      input.type = "number";
      input.dataset.kind = "number";
      input.value = cellText(defaultVal ?? "");
      inputs.set(col, input);
      field.appendChild(input);
    } else {
      const input = document.createElement(
        col === "content" ? "textarea" : "input",
      ) as HTMLInputElement | HTMLTextAreaElement;
      input.value = cellText(defaultVal ?? "");
      if (input instanceof HTMLTextAreaElement) input.rows = 3;
      inputs.set(col, input);
      field.appendChild(input);
    }
    form.appendChild(field);
  }
  card.appendChild(form);

  const actions = document.createElement("div");
  actions.className = "detail-form-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary";
  saveBtn.textContent = "创建";
  saveBtn.onclick = () => {
    const fields: Record<string, unknown> = {};
    for (const [col, el] of inputs) {
      const raw = el.value.trim();
      if (raw === "") continue;
      const fieldPath = `${opts.table}.${col}`;
      if (el.dataset.kind === "json") {
        try {
          fields[col] = JSON.parse(raw);
        } catch {
          saveBtn.textContent = `${col} JSON 无效`;
          setTimeout(() => {
            saveBtn.textContent = "创建";
          }, 1400);
          return;
        }
        continue;
      }
      if (el.dataset.kind === "time" || el.dataset.kind === "date") {
        fields[col] = coerceField(null, raw, fieldPath);
        continue;
      }
      if (el.dataset.kind === "number") {
        const n = Number(raw);
        fields[col] = Number.isFinite(n) ? n : raw;
        continue;
      }
      fields[col] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    }
    for (const [col, get] of fkGetters) {
      const id = get();
      if (id == null) {
        saveBtn.textContent = `请选择 ${col}`;
        setTimeout(() => {
          saveBtn.textContent = "创建";
        }, 1400);
        return;
      }
      fields[col] = id;
    }
    if (!Object.keys(fields).length) {
      saveBtn.textContent = "请填写字段";
      setTimeout(() => {
        saveBtn.textContent = "创建";
      }, 1200);
      return;
    }
    void opts.onSubmit(buildPostBody(opts.table, fields));
  };
  actions.appendChild(saveBtn);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "取消";
  cancel.onclick = goBack;
  actions.appendChild(cancel);
  card.appendChild(actions);
  detailHost.appendChild(card);
}

async function openFkDetail(
  container: HTMLElement,
  opts: {
    table: string;
    id: string | number;
    comments: SchemaComments | null;
    apijsonBase: string;
    onBack?: () => void;
    onWrite?: (payload: WritePayload) => void | Promise<void>;
  },
) {
  for (const el of Array.from(container.querySelectorAll(LIST_HIDE_SEL))) {
    el.classList.add("hidden");
  }
  const foundHost = container.querySelector("#result-detail-host");
  const detailHost: HTMLElement =
    foundHost instanceof HTMLElement
      ? foundHost
      : (() => {
          const el = document.createElement("div");
          el.id = "result-detail-host";
          container.appendChild(el);
          return el;
        })();
  detailHost.classList.remove("hidden");
  detailHost.innerHTML = `<div class="result-empty">加载 ${opts.table}#${opts.id}…</div>`;

  try {
    const body = buildFkGetBody(opts.table, opts.id);
    const res = await fetch(`${opts.apijsonBase}/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { code?: number; msg?: string };
    if (!res.ok || json.code !== 200) {
      detailHost.innerHTML = `<div class="result-empty">加载失败：${json.msg || res.statusText}</div>`;
      return;
    }
    const parsed = parseResponse(json);
    const row = parsed.rows[0];
    if (!row) {
      detailHost.innerHTML = `<div class="result-empty">未找到 ${opts.table}#${opts.id}</div>`;
      return;
    }
    detailHost.innerHTML = "";
    renderDetailForm(detailHost, row, {
      comments: opts.comments,
      mode: "view",
      apijsonBase: opts.apijsonBase,
      onBack: () => {
        detailHost.classList.add("hidden");
        detailHost.innerHTML = "";
        for (const el of Array.from(container.querySelectorAll(LIST_HIDE_SEL))) {
          el.classList.remove("hidden");
        }
        opts.onBack?.();
      },
      onDelete: opts.onWrite
        ? () => {
            const payload = buildDeleteBody(opts.table, [opts.id]);
            if (payload) void opts.onWrite?.(payload);
          }
        : undefined,
      onWrite: opts.onWrite,
    });
  } catch (e) {
    detailHost.innerHTML = `<div class="result-empty">${e instanceof Error ? e.message : String(e)}</div>`;
  }
}

function showDetail(
  container: HTMLElement,
  state: ResultViewState,
  key: string,
  comments: SchemaComments | null,
  callbacks?: {
    mode?: "view" | "edit";
    onBack?: () => void;
    onSave?: (payload: WritePayload) => void | Promise<void>;
    onDelete?: () => void;
    apijsonBase?: string;
  },
) {
  const row = state.parsed.rows.find((r) => r.key === key);
  if (!row) return;
  state.selectedKey = key;
  for (const el of Array.from(container.querySelectorAll(LIST_HIDE_SEL))) {
    el.classList.add("hidden");
  }
  const detailHost = container.querySelector("#result-detail-host");
  if (detailHost instanceof HTMLElement) {
    detailHost.classList.remove("hidden");
    detailHost.innerHTML = "";
    renderDetailForm(detailHost, row, {
      comments,
      mode: callbacks?.mode ?? "view",
      apijsonBase: callbacks?.apijsonBase,
      onBack: () => {
        state.selectedKey = null;
        detailHost.classList.add("hidden");
        detailHost.innerHTML = "";
        for (const el of Array.from(container.querySelectorAll(LIST_HIDE_SEL))) {
          el.classList.remove("hidden");
        }
        callbacks?.onBack?.();
      },
      onSave: callbacks?.onSave,
      onDelete: callbacks?.onDelete,
      onWrite: callbacks?.onSave,
    });
  }
}

function renderDetailForm(
  container: HTMLElement,
  row: FlatRow,
  opts: {
    comments: SchemaComments | null;
    mode?: "view" | "edit";
    apijsonBase?: string;
    onBack: (() => void) | null;
    onSave?: (payload: WritePayload) => void | Promise<void>;
    onDelete?: () => void;
    onWrite?: (payload: WritePayload) => void | Promise<void>;
  },
) {
  const comments = opts.comments;
  const editableMode = opts.mode === "edit";
  const primary = pickPrimaryTable(row);
  const writeFn = opts.onWrite ?? opts.onSave;
  const card = document.createElement("div");
  card.className = "detail-form";

  const header = document.createElement("div");
  header.className = "detail-form-header";
  if (opts.onBack) {
    header.appendChild(makeBackIconButton(opts.onBack));
  }
  const title = document.createElement("h3");
  title.textContent = primary
    ? `${primary} ${editableMode ? "编辑" : "查看"} #${row.key}`
    : `${editableMode ? "编辑" : "查看"} #${row.key}`;
  header.appendChild(title);
  card.appendChild(header);

  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  const fkValues = new Map<string, string | number | null>();

  // Group by table
  const groups = new Map<string, Array<[string, unknown]>>();
  for (const [key, value] of Object.entries(row.cells)) {
    const table = key.includes(".") ? key.split(".")[0]! : "_";
    if (!groups.has(table)) groups.set(table, []);
    groups.get(table)!.push([key, value]);
  }

  const jumpToFk = (fk: FkJumpMeta) => {
    if (!opts.apijsonBase) return;
    const hostEl =
      container.closest(".result-view") || container.parentElement;
    if (!(hostEl instanceof HTMLElement)) return;
    void openFkDetail(hostEl, {
      table: fk.table,
      id: fk.id,
      comments,
      apijsonBase: opts.apijsonBase,
      onBack: opts.onBack || undefined,
      onWrite: writeFn,
    });
  };

  for (const [table, fields] of groups) {
    if (table !== "_") {
      const sectionFk =
        table !== primary
          ? joinedFkTableLinkMeta(
              `${table}.id`,
              row.cells[`${table}.id`],
              row.cells,
              primary,
              comments,
            )
          : null;
      if (sectionFk && opts.apijsonBase) {
        const section = document.createElement("button");
        section.type = "button";
        section.className = "detail-table-title fk-link";
        section.textContent = `${table}（关联）· 查看详情`;
        section.title = `查看 ${table}#${sectionFk.id}`;
        section.onclick = () => jumpToFk(sectionFk);
        card.appendChild(section);
      } else {
        const section = document.createElement("div");
        section.className = "detail-table-title";
        section.textContent =
          editableMode && table === primary
            ? `${table}（可编辑）`
            : table === primary
              ? table
              : `${table}（关联）`;
        section.title = tooltip(table, comments);
        card.appendChild(section);
      }
    }
    const form = document.createElement("div");
    form.className = "detail-fields";
    for (const [key, value] of fields) {
      const field = document.createElement("label");
      field.className = "detail-field";
      field.title = tooltip(key, comments);
      const name = document.createElement("span");
      name.className = "field-name";
      const tip = commentFor(key, comments);
      const amb = ambiguousColumnNames(Object.keys(row.cells));
      name.textContent = tip
        ? `${shortLabel(key, amb)} — ${tip.split(" (")[0]}`
        : shortLabel(key, amb);
      name.title = tooltip(key, comments);
      field.appendChild(name);

      const col = key.includes(".") ? key.split(".").pop()! : key;
      const isComplex = looksLikeJsonField(key, value);
      const editable =
        editableMode && table === primary && col !== "id";
      const fkTable = resolveFkTable(key, comments);
      const fk = cellFkJumpMeta(key, value, row.cells, comments, primary);
      const fieldType = inferFieldType(key, [value], comments);

      if (editable && fkTable && opts.apijsonBase && !isComplex) {
        const host = document.createElement("div");
        const initialId =
          typeof value === "number" || typeof value === "string"
            ? value
            : null;
        fkValues.set(key, initialId);
        mountFkFieldControl(host, {
          path: key,
          table: fkTable,
          apijsonBase: opts.apijsonBase,
          comments,
          initialId,
          initialLabel: fk?.label ?? undefined,
          onChange: (id) => {
            fkValues.set(key, id);
          },
        });
        if (fk) {
          const jump = document.createElement("button");
          jump.type = "button";
          jump.className = "fk-link";
          jump.textContent = fk.label
            ? `查看 ${fk.label}`
            : `查看 ${fk.table}`;
          jump.onclick = () => jumpToFk(fk);
          host.appendChild(jump);
        }
        field.appendChild(host);
      } else if (fk && opts.apijsonBase && !editable && !isComplex) {
        const a = document.createElement("button");
        a.type = "button";
        a.className = "fk-link detail-fk-value";
        a.textContent = fk.label || cellText(value) || `${fk.table}#${fk.id}`;
        a.title = `查看 ${fk.table} 详情 (id=${fk.id})`;
        a.onclick = (e) => {
          e.preventDefault();
          jumpToFk(fk);
        };
        field.appendChild(a);
      } else if (isComplex) {
        // Arrays / objects / *List: full JSON editor (never collapsed "[N items]")
        const ta = document.createElement("textarea");
        ta.className = "detail-json-input";
        ta.readOnly = !editable;
        ta.dataset.path = key;
        ta.dataset.kind = "json";
        const pretty = cellPrettyJson(value);
        ta.rows = Math.min(12, Math.max(4, pretty.split("\n").length + 1));
        ta.value = pretty;
        ta.spellcheck = false;
        ta.title = tooltip(key, comments);
        if (editable) inputs.set(key, ta);
        field.appendChild(ta);
      } else if (fieldType === "date" || fieldType === "time") {
        const input = document.createElement("input");
        input.type = inputTypeForField(fieldType);
        input.readOnly = !editable;
        input.dataset.path = key;
        input.dataset.kind = fieldType;
        input.value = displayTimeValue(fieldType, cellText(value));
        input.title = tooltip(key, comments);
        if (editable) inputs.set(key, input);
        field.appendChild(input);
      } else if (fieldType === "number") {
        const input = document.createElement("input");
        input.type = "number";
        input.readOnly = !editable;
        input.dataset.path = key;
        input.value = cellText(value);
        input.title = tooltip(key, comments);
        if (editable) inputs.set(key, input);
        field.appendChild(input);
      } else {
        const text = cellText(value);
        const input = document.createElement(
          text.length > 60 ? "textarea" : "input",
        ) as HTMLInputElement | HTMLTextAreaElement;
        input.readOnly = !editable;
        input.dataset.path = key;
        input.value = text;
        input.title = tooltip(key, comments);
        if (input instanceof HTMLTextAreaElement) input.rows = 3;
        if (editable) inputs.set(key, input);
        field.appendChild(input);
      }
      form.appendChild(field);
    }
    card.appendChild(form);
  }

  const actions = document.createElement("div");
  actions.className = "detail-form-actions";
  if (opts.onSave && primary && editableMode) {
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "primary";
    saveBtn.textContent = "保存";
    saveBtn.onclick = () => {
      if (!confirm(`确认保存对 #${row.key} 的修改？`)) return;
      const edited: Record<string, string> = {};
      for (const [path, el] of inputs) edited[path] = el.value;
      for (const [path, id] of fkValues) {
        if (id == null) {
          saveBtn.textContent = `请选择外键`;
          setTimeout(() => {
            saveBtn.textContent = "保存";
          }, 1400);
          return;
        }
        edited[path] = String(id);
      }
      const payload = buildPutFromDetail(row, edited);
      if (!payload) {
        saveBtn.textContent = "无变更";
        setTimeout(() => {
          saveBtn.textContent = "保存";
        }, 1200);
        return;
      }
      void opts.onSave?.(payload);
    };
    actions.appendChild(saveBtn);
  }
  if (opts.onDelete) {
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "danger";
    delBtn.textContent = "删除";
    delBtn.onclick = () => {
      if (confirm(`确认删除 ${primary || ""} #${row.key}？此操作不可撤销。`)) {
        opts.onDelete?.();
      }
    };
    actions.appendChild(delBtn);
  }
  if (actions.childNodes.length) card.appendChild(actions);

  container.appendChild(card);
}

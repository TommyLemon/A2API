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
  COLUMN_RETURN_OPTIONS,
  ensureColumnOrder,
  fieldTypeLabel,
  formatColumnReturnToken,
  headerLabel,
  inferFieldType,
  parseColumnReturnToken,
  type ColumnMeta,
  type ColumnReturnAgg,
  type FieldType,
} from "./field-meta.js";
import {
  mountFkFieldControl,
  mountFkIdListControl,
  resolveFkIdListTable,
} from "./fk-picker.js";
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
import { withRequestRole } from "./access-roles.js";
import {
  ensureRemoteImageList,
  ensureRemoteImageUrl,
  uploadFiles,
} from "./upload.js";
import {
  createRulesFromRequest,
  ensureRequestStructures,
} from "./request-structures.js";
import { stripApiJsonRole, type SchemaComments } from "./schema-types.js";
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

/** Registered by list render; toolbar Add calls this. */
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
  back.title = "Back";
  back.setAttribute("aria-label", "Back");
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

/**
 * Row key for list selection / click.
 * Prefer Comment before Moment: Comment rows often JOIN Moment, and using
 * Moment.id as the key made every row on the same moment open Moment#15.
 */
function rowIdFromCells(
  cells: Record<string, unknown>,
  fallback: string | number,
  preferTable?: string | null,
): string {
  if (preferTable) {
    const id = cells[`${preferTable}.id`];
    if (id != null && id !== "") return String(id);
  }
  for (const t of ["Comment", "Moment", "User"]) {
    if (preferTable && t === preferTable) continue;
    const id = cells[`${t}.id`];
    if (id != null && id !== "") return String(id);
  }
  for (const [k, v] of Object.entries(cells)) {
    if (k.endsWith(".id") && v != null && v !== "") return String(v);
  }
  return String(fallback);
}

/** Re-key list rows to the primary table's id (joined FK ids must not win). */
function withPrimaryRowKeys(
  rows: FlatRow[],
  primary: string | null | undefined,
): FlatRow[] {
  if (!primary) return rows;
  return rows.map((r, idx) => {
    const id = r.cells[`${primary}.id`];
    if (id == null || id === "") {
      return { ...r, key: rowIdFromCells(r.cells, idx, primary) };
    }
    return { ...r, key: String(id) };
  });
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

/** Empty right pane: short how-to guide (fills the former Workspace title area). */
export function mountWorkspaceGuide(host: HTMLElement): void {
  host.innerHTML = "";
  const guide = document.createElement("article");
  guide.className = "workspace-guide";
  guide.innerHTML = `
    <h3 class="workspace-guide-title">Get started</h3>
    <p class="workspace-guide-lead">
      Use chat on the left to load data here. After that, filter, sort, and edit without calling AI again.
    </p>
    <ol class="workspace-guide-steps">
      <li>
        <strong>Ask or tap a chip</strong>
        <span>Try “List users” or “List the latest 3 moments”.</span>
      </li>
      <li>
        <strong>Explore the table</strong>
        <span>Filter and sort from column headers. Open ⚙ to show or hide fields (including JSON lists).</span>
      </li>
      <li>
        <strong>Open a row</strong>
        <span>View or edit a record, then save to return to the list.</span>
      </li>
      <li>
        <strong>Charts</strong>
        <span>Switch to Charts / Bar / Line to visualize the same query.</span>
      </li>
      <li>
        <strong>Data tab</strong>
        <span>Inspect the exact request and response when you need to debug.</span>
      </li>
    </ol>
    <p class="workspace-guide-foot">
      Sensitive deletes wait for admin approval; other writes run automatically with an audit trail.
    </p>
  `;
  host.appendChild(guide);
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
    /** Whether combined mode also shows the table */
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
    /** Prefill values for Add / create form */
    createInitialValues?: Record<string, unknown> | null;
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

  // List rows must key by primary.id — not a joined Moment/User id
  if (mode === "list" && primaryTable && parsed.rows.length) {
    parsed.rows = withPrimaryRowKeys(parsed.rows, primaryTable);
  }

  if (mode === "detail" && parsed.rows[0]) {
    const detailTable =
      primaryTable || pickPrimaryTable(parsed.rows[0]) || null;
    const detailId =
      (detailTable
        ? parsed.rows[0].cells[`${detailTable}.id`]
        : undefined) ?? parsed.rows[0].key;
    // Always re-GET by id without @column so detail shows full fields
    if (
      apijsonBase &&
      detailTable &&
      detailId != null &&
      String(detailId) !== ""
    ) {
      void openFkDetail(container, {
        table: detailTable,
        id: detailId as string | number,
        comments,
        apijsonBase,
        mode: write ? "edit" : "view",
        onBack: opts.onBackToList,
        onWrite: write,
      });
      return state;
    }
    const detailRow = detailTable
      ? expandDetailRowFields(parsed.rows[0], detailTable, comments)
      : parsed.rows[0];
    renderDetailForm(container, detailRow, {
      comments,
      mode: write ? "edit" : "view",
      apijsonBase,
      onBack: opts.onBackToList ?? null,
      onSave: write,
      onDelete: write
        ? () => {
            const table = pickPrimaryTable(detailRow) || primaryTable;
            if (!table) return;
            const id = detailRow.cells[`${table}.id`] ?? detailRow.key;
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
          initialValues: opts.createInitialValues ?? undefined,
          onBack: () => renderResultView(container, opts),
          onSubmit: write,
        });
    }
    if (opts.response == null) {
      mountWorkspaceGuide(container);
    } else {
      const empty = document.createElement("div");
      empty.className = "result-empty";
      empty.textContent = "No matching records";
      container.appendChild(empty);
    }
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

  // Table | Charts (configured combo) | specific type (that type only)
  const viewTabs = document.createElement("div");
  viewTabs.className = "display-tabs";
  for (const [kind, label] of [
    ["table", "Table"],
    ["combined", "Charts"],
    ["bar", "Bar"],
    ["line", "Line"],
    ["area", "Area"],
    ["pie", "Pie"],
    ["doughnut", "Doughnut"],
  ] as const) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "display-tab" + (displayKind === kind ? " active" : "");
    b.textContent = label;
    if (kind === "combined") {
      b.title = "Show charts configured on the left (multi-dimension, multi-field, same chart different colors)";
    } else if (kind !== "table") {
      b.title = `Show ${label} only`;
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
        initialValues: opts.createInitialValues ?? undefined,
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

    // Chart field pool: all fields from all tables in this query (decoupled from table visible columns)
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
    addDimBtn.textContent = "+ Dimension";
    addDimBtn.title = isCombined
      ? "Add a chart (includes its own group-by field bar)"
      : "Add a chart (includes its own group-by field bar)";
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

    /** Y-axis: Count | Data | Sum | Avg | Max | Min | Custom(expr) */
    const mountFieldValueControls = (
      host: HTMLElement,
      fieldPath: string,
    ): void => {
      const wrap = document.createElement("div");
      wrap.className = "chart-dim-field-value";
      wrap.title =
        "Y axis: Count, Data, Sum / Average / Max / Min, or a custom function";

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
      valueSel.title = "Count, Data, aggregate, or Custom";

      const options = listFieldValueOptions(fieldPath, kind ?? "number");
      const current = serializeChartValue(spec);
      const currentAgg = spec.agg;
      for (const opt of options) {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        // Custom options share a prefix — match by agg for custom
        if (opt.label === "Custom" && currentAgg === "custom") {
          o.selected = true;
        } else if (opt.label !== "Custom" && opt.value === current) {
          o.selected = true;
        }
        valueSel.appendChild(o);
      }
      if (
        currentAgg !== "custom" &&
        ![...valueSel.options].some((o) => o.value === current)
      ) {
        valueSel.value = "__count__";
      }

      const customInp = document.createElement("input");
      customInp.type = "text";
      customInp.className = "chart-field-custom-expr";
      customInp.placeholder = "e.g. sum(commentCount)";
      customInp.title =
        "Custom aggregate expression for APIJSON @column (letters, digits, () , + - * /)";
      customInp.value = spec.agg === "custom" ? spec.customExpr || "" : "";
      customInp.hidden = currentAgg !== "custom";

      const persist = (next: ReturnType<typeof parseChartValue>) => {
        if (next.path !== "__count__") {
          next.measureKind = kind ?? next.measureKind ?? "number";
        }
        fieldValues = {
          ...fieldValues,
          [fieldPath]: serializeChartValue(next),
        };
        emitConfig();
      };

      valueSel.onchange = () => {
        const next = parseChartValue(valueSel.value);
        if (next.agg === "custom") {
          next.customExpr = customInp.value.trim();
          customInp.hidden = false;
          customInp.focus();
        } else {
          customInp.hidden = true;
        }
        persist(next);
      };

      customInp.onchange = () => {
        persist({
          path: fieldPath,
          agg: "custom",
          measureKind: kind ?? "number",
          customExpr: customInp.value.trim(),
        });
      };
      customInp.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          customInp.blur();
        }
      };

      wrap.append(valueSel, customInp);
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

    const paintMulti = (
      host: HTMLElement,
      series: ChartSeriesInput[],
      title: string,
      kind: ChartKind,
    ) => {
      const canvas = host.querySelector(".chart-canvas") as HTMLElement | null;
      if (!canvas) return;
      renderEcharts(canvas, kind, series, title);
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
      fieldColor.title = `Color · ${fieldOptionLabel(c)}`;
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
      cb.title = "Add to this chart series (multi-select = same chart, different colors)";
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
        enCb.title = "Show this chart";
        enCb.onchange = () => {
          dim.enabled = enCb.checked;
          emitConfig();
        };
        enLab.append(enCb);
        head.appendChild(enLab);

        const kindSel = document.createElement("select");
        kindSel.className = "chart-dim-kind";
        kindSel.title = "Chart type";
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
      nameInput.title = "Dimension name (editable)";
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
      groupLab.title = "Category / X-axis group field (all table fields in this query)";
      const groupPrefix = document.createElement("span");
      groupPrefix.textContent = "Group by";
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
        toggleBtn.textContent = open ? "Collapse" : "Expand";
        toggleBtn.title = open
          ? "Collapse optional fields"
          : "Expand optional fields (all table fields in this query)";
        toggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
      };
      syncToggleLabel(fieldsOpen);
      head.appendChild(toggleBtn);

      if (dimensions.length > 1) {
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "chart-dim-x";
        rm.textContent = "×";
        rm.title = "Remove this chart";
        rm.onclick = () => {
          dimensions = dimensions.filter((d) => d.id !== dim.id);
          emitConfig();
        };
        head.appendChild(rm);
      }
      bar.appendChild(head);

      // Optional multi-select: collapsible; expanded by default
      const picker = document.createElement("div");
      picker.className = "chart-dim-fields chart-dim-fields-picker";
      picker.title = "Optional series fields (all table fields in this query)";
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
              ? "Display disabled"
              : "Select a group-by field"
          }</div>`;
        }
        return;
      }

      // No series checked → single series: Count by groupBy
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
      const title = `${dimTitle} · ${chartKindLabel(kind)} · by ${groupLabel}`;
      paintMulti(wrap, localSeries, title, kind);

      if (!primaryTable || !apijsonBase) {
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
              sorts,
              filters,
              filterCombineExpr: opts.filterCombineExpr,
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
        const anyOk = results.some((r) => r.ok);
        if (!anyOk) return;
        paintMulti(wrap, serverSeries, title, kind);
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
          `<div class="result-empty">Click "+ Dimension" to add a chart</div>`;
        return;
      }

      dimensions.forEach((dim, idx) => {
        const wrap = document.createElement("div");
        wrap.className =
          "chart-plot" +
          (isCombined && dim.enabled === false ? " is-off" : "");
        wrap.dataset.dim = dim.id;

        mountDimTitleBar(wrap, dim, idx);

        const canvas = document.createElement("div");
        canvas.className = "chart-canvas";
        wrap.append(canvas);
        plots.appendChild(wrap);

        fillDimChart(wrap, dim, gen, signal);
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

    // Charts / specific type: charts only, no table below
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
    primaryTable: primaryTable || "Record",
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
  checkAll.title = "Select all on this page";
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
  settingsBtn.title = "Column visibility / filter / sort / type";
  settingsBtn.textContent = "⚙";
  settingsBtn.onclick = (e) => {
    e.stopPropagation();
    openColumnSettings(
      settingsBtn,
      order,
      metas,
      comments,
      ambiguous,
      (next) => {
        // Keep newly revealed schema fields (json lists…) in column order.
        // Update metas first, then order — order change re-renders and must
        // already see the new visibility/type flags.
        const nextOrder = ensureColumnOrder(
          Object.keys(next),
          order,
          parsed.rows,
          comments,
        );
        opts.onColumnMetasChange?.(next);
        if (nextOrder.join("\0") !== order.join("\0")) {
          opts.onColumnOrderChange?.(nextOrder);
        }
      },
      parsed.columns,
    );
  };
  thSettings.appendChild(settingsBtn);
  const thAction = document.createElement("th");
  thAction.textContent = "Actions";
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
    if (label) label.textContent = `${selected.size} selected`;
    label?.classList.toggle("is-active", selected.size > 0);
    if (delBtn) delBtn.classList.toggle("hidden", selected.size === 0);
    const boxes = tbody.querySelectorAll<HTMLInputElement>("input.row-check");
    checkAll.checked = boxes.length > 0 && selected.size === boxes.length;
    checkAll.indeterminate =
      selected.size > 0 && selected.size < boxes.length;
  };

  /** Open detail by id with a full-field GET (not sparse list columns). */
  const openRowDetail = (key: string, mode: "view" | "edit") => {
    const row = parsed.rows.find((r) => r.key === key);
    if (!row) return;
    // Always the list primary table + that row's primary id (never joined Moment#15)
    const table = primaryTable || pickPrimaryTable(row);
    const id =
      (table != null &&
      row.cells[`${table}.id`] != null &&
      row.cells[`${table}.id`] !== ""
        ? row.cells[`${table}.id`]
        : null) ??
      key;
    if (apijsonBase && table && id != null && String(id) !== "") {
      void openFkDetail(container, {
        table,
        id: id as string | number,
        comments,
        apijsonBase,
        mode,
        onBack: opts.onBackToList,
        onWrite: write,
      });
      return;
    }
    showDetail(container, state, key, comments, {
      mode,
      apijsonBase,
      onBack: opts.onBackToList,
      onSave: mode === "edit" ? write : undefined,
      onDelete: write
        ? () => {
            if (!table) return;
            const rid = row.cells[`${table}.id`] ?? row.key;
            const payload = buildDeleteBody(table, [rid as string | number]);
            if (payload) void write(payload);
          }
        : undefined,
    });
  };

  const tbody = document.createElement("tbody");
  for (const row of parsed.rows) {
    const tr = document.createElement("tr");
    tr.dataset.key = row.key;
    tr.className = "result-row-clickable";
    tr.title = write
      ? "Click row to edit details (full fields)"
      : "Click row to view details (full fields)";
    // If writes are allowed, open editable detail by default
    tr.onclick = () => openRowDetail(row.key, write ? "edit" : "view");

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
          typeTip && `Type: ${typeTip}`,
          isJoinedCol
            ? `${col} → ${fk.table}#${fk.id}`
            : fk.label
              ? `${col}=${text} → ${fk.table}.${mapField}=${fk.label}`
              : `${col}=${text} (not linked to ${fk.table}.${mapField}; check JOIN)`,
          "Click to view details",
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
            mode: write ? "edit" : "view",
            onBack: opts.onBackToList,
            onWrite: write,
          });
        };
        td.appendChild(a);
      } else {
        td.textContent = truncate(text, 48);
        td.title = [tip, typeTip && `Type: ${typeTip}`, `Value: ${text}`]
          .filter(Boolean)
          .join("\n");
      }
      tr.appendChild(td);
    }
    tr.appendChild(document.createElement("td")); // settings spacer
    const tdAct = document.createElement("td");
    tdAct.className = "row-actions";
    tdAct.onclick = (e) => e.stopPropagation();
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "linkish";
    editBtn.textContent = "Edit";
    editBtn.title = "Edit this record";
    editBtn.onclick = (e) => {
      e.stopPropagation();
      openRowDetail(row.key, "edit");
    };
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "linkish danger-link";
    delBtn.textContent = "Delete";
    delBtn.onclick = (e) => {
      e.stopPropagation();
      if (!write || !primaryTable) return;
      if (!confirm(`Delete #${row.key}? This cannot be undone.`)) return;
      const id = row.cells[`${primaryTable}.id`] ?? row.key;
      const payload = buildDeleteBody(primaryTable, [id as string | number]);
      if (payload) void write(payload);
    };
    tdAct.append(editBtn, sep(), delBtn);
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
  th.title = `${tooltip(col, opts.comments)}\nType: ${fieldTypeLabel(opts.meta.type)}\nLong-press to drag reorder`;

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
    filterBtn.title = `Filter (${fieldTypeLabel(opts.meta.type)}) · multiple conditions AND/OR/NOT${n ? ` · ${n} active` : ""}`;
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
        ? "Click for ascending"
        : dir === "asc"
          ? "Ascending · click for descending"
          : "Descending · click to clear";
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
      { value: "contains", label: "Contains" },
      { value: "prefix", label: "Starts with" },
      { value: "suffix", label: "Ends with" },
      { value: "eq", label: "Equals" },
    ];
  }
  if (type === "number" || type === "percent") {
    return [
      { value: "gte", label: "Greater or equal" },
      { value: "lte", label: "Less or equal" },
      { value: "eq", label: "Equals" },
      { value: "gt", label: "Greater than" },
      { value: "lt", label: "Less than" },
    ];
  }
  // date / time — default range is >= & <=
  return [
    { value: "gte", label: "Not before" },
    { value: "lte", label: "Not after" },
    { value: "eq", label: "Equals" },
    { value: "gt", label: "After" },
    { value: "lt", label: "Before" },
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

function isImageUrlField(path: string, value: unknown): boolean {
  const col = (path.includes(".") ? path.split(".").pop()! : path).toLowerCase();
  if (
    /^(head|avatar|photo|icon|img|image|portrait|face|cover)$/.test(col) ||
    /avatar|photo|image|headurl|imgurl/.test(col)
  ) {
    const s = String(value ?? "").trim();
    return (
      !s ||
      /^https?:\/\//i.test(s) ||
      s.startsWith("/") ||
      s.startsWith("data:image")
    );
  }
  if (typeof value === "string") {
    const s = value.trim();
    return (
      /^https?:\/\/.+\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(s) ||
      s.startsWith("data:image")
    );
  }
  return false;
}

function parseArrayValue(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return [];
    try {
      const parsed = JSON.parse(t);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function isUrlLike(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const t = v.trim();
  return (
    /^https?:\/\//i.test(t) ||
    t.startsWith("data:image") ||
    t.startsWith("blob:") ||
    (t.startsWith("/") && t.length > 1)
  );
}

function isImageUrlLike(v: unknown): boolean {
  if (!isUrlLike(v)) return false;
  const t = String(v).trim();
  if (t.startsWith("data:image") || t.startsWith("blob:")) return true;
  if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?|#|$)/i.test(t)) return true;
  // Many CDN image URLs omit extension — still treat as image when field is list-like
  return /^https?:\/\//i.test(t);
}

/** pictureList / photos / images[] — or arrays that are mostly image URLs. */
function isImageListField(path: string, value: unknown): boolean {
  const col = (path.includes(".") ? path.split(".").pop()! : path).toLowerCase();
  const nameSuggests =
    /(picture|photo|image|img|gallery|media|banner|cover).*list/.test(col) ||
    /^(pictures|photos|images|imgs|gallery|media)$/.test(col) ||
    (/list$/.test(col) && /(picture|photo|image|img)/.test(col));
  const arr = parseArrayValue(value);
  if (nameSuggests) return arr != null || value == null || value === "";
  if (!arr || !arr.length) return false;
  const asUrls = arr.filter(isImageUrlLike);
  return asUrls.length > 0 && asUrls.length >= Math.ceil(arr.length * 0.5);
}

function openImageLightbox(
  getUrls: () => string[],
  startIndex: number,
): void {
  document.getElementById("detail-image-lightbox")?.remove();
  let urls = getUrls().filter(Boolean);
  if (!urls.length) return;
  let idx = Math.max(0, Math.min(startIndex, urls.length - 1));

  // Mount on <body> as a true viewport overlay (not in-page flow / bottom bar)
  const modal = document.createElement("div");
  modal.id = "detail-image-lightbox";
  modal.className = "detail-lightbox";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  // Inline critical geometry so overlay cannot collapse into page layout
  Object.assign(modal.style, {
    position: "fixed",
    top: "0",
    left: "0",
    right: "0",
    bottom: "0",
    width: "100vw",
    height: "100vh",
    zIndex: "2147483646",
    margin: "0",
    display: "flex",
    flexDirection: "column",
    background: "rgba(0, 0, 0, 0.88)",
    boxSizing: "border-box",
  });

  const body = document.createElement("div");
  body.className = "detail-lightbox-body";

  const stage = document.createElement("div");
  stage.className = "detail-lightbox-stage";
  const img = document.createElement("img");
  img.className = "detail-lightbox-img";
  img.referrerPolicy = "no-referrer";
  stage.appendChild(img);

  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "detail-lightbox-nav";
  prev.textContent = "<";
  prev.title = "Previous";
  prev.setAttribute("aria-label", "Previous");
  const next = document.createElement("button");
  next.type = "button";
  next.className = "detail-lightbox-nav detail-lightbox-nav-next";
  next.textContent = ">";
  next.title = "Next";
  next.setAttribute("aria-label", "Next");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "detail-lightbox-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close");

  const caption = document.createElement("div");
  caption.className = "detail-lightbox-caption";

  const strip = document.createElement("div");
  strip.className = "detail-lightbox-strip";

  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";

  const teardown = () => {
    document.body.style.overflow = prevOverflow;
    document.removeEventListener("keydown", onKey);
    modal.remove();
  };

  const paint = () => {
    urls = getUrls().filter(Boolean);
    if (!urls.length) {
      teardown();
      return;
    }
    if (idx >= urls.length) idx = urls.length - 1;
    if (idx < 0) idx = 0;
    img.src = urls[idx] || "";
    caption.textContent = `${idx + 1} / ${urls.length}`;
    prev.style.visibility = urls.length > 1 ? "visible" : "hidden";
    next.style.visibility = urls.length > 1 ? "visible" : "hidden";
    strip.innerHTML = "";
    urls.forEach((u, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className =
        "detail-lightbox-strip-item" + (i === idx ? " is-active" : "");
      const t = document.createElement("img");
      t.src = u;
      t.alt = "";
      t.referrerPolicy = "no-referrer";
      t.loading = "lazy";
      b.appendChild(t);
      b.onclick = (e) => {
        e.stopPropagation();
        idx = i;
        paint();
      };
      strip.appendChild(b);
    });
    const active = strip.querySelector(".is-active");
    active?.scrollIntoView({
      behavior: "smooth",
      inline: "center",
      block: "nearest",
    });
  };

  prev.onclick = (e) => {
    e.stopPropagation();
    idx = (idx - 1 + urls.length) % urls.length;
    paint();
  };
  next.onclick = (e) => {
    e.stopPropagation();
    idx = (idx + 1) % urls.length;
    paint();
  };
  close.onclick = (e) => {
    e.stopPropagation();
    teardown();
  };
  modal.onclick = (e) => {
    if (e.target === modal || e.target === body) teardown();
  };
  stage.onclick = (e) => e.stopPropagation();
  strip.onclick = (e) => e.stopPropagation();

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") teardown();
    if (e.key === "ArrowLeft") prev.click();
    if (e.key === "ArrowRight") next.click();
  }
  document.addEventListener("keydown", onKey);

  body.append(stage, caption, strip);
  modal.append(close, prev, next, body);
  document.body.appendChild(modal);
  paint();
}

/** Pick images → POST /upload → absolute http URLs (host + path). */
function pickAndUploadImages(
  apijsonBase: string,
  multiple: boolean,
): Promise<string[]> {
  return new Promise((resolve) => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/*";
    inp.multiple = multiple;
    inp.onchange = async () => {
      const files = [...(inp.files || [])];
      if (!files.length) {
        resolve([]);
        return;
      }
      try {
        resolve(await uploadFiles(apijsonBase, files));
      } catch (e) {
        window.alert(e instanceof Error ? e.message : String(e));
        resolve([]);
      }
    };
    inp.oncancel = () => resolve([]);
    inp.click();
  });
}

/**
 * Fixed-height horizontal pager for image URL(s).
 * - Click center → fullscreen portal overlay (covers chat + records)
 * - Top-left % → replace from device (edit)
 * - Top-right × → remove (edit)
 * - Right-side + → add from device (edit)
 * mode "single": stores one URL string; "list": JSON array
 */
function mountImageListEditor(
  host: HTMLElement,
  opts: {
    path: string;
    value: unknown;
    editable: boolean;
    mode?: "list" | "single";
    /** APIJSON host for POST /upload (required when editable). */
    apijsonBase?: string;
    registerInput?: (
      el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    ) => void;
  },
): void {
  const uploadBase = (opts.apijsonBase || "").replace(/\/+$/, "");
  const mode = opts.mode ?? "list";
  let urls: string[] =
    mode === "single"
      ? (() => {
          const s = cellText(opts.value).trim();
          return s ? [s] : [];
        })()
      : (parseArrayValue(opts.value) ?? [])
          .map((v) => String(v ?? "").trim())
          .filter(Boolean);

  const wrap = document.createElement("div");
  wrap.className = "detail-image-pager";

  const hidden =
    mode === "single"
      ? document.createElement("input")
      : document.createElement("textarea");
  if (mode === "single") {
    const inp = hidden as HTMLInputElement;
    inp.type = "text";
    inp.dataset.path = opts.path;
    inp.dataset.kind = "text";
  } else {
    const ta = hidden as HTMLTextAreaElement;
    ta.dataset.path = opts.path;
    ta.dataset.kind = "json";
  }
  hidden.className = "hidden";
  hidden.readOnly = !opts.editable;

  const syncHidden = () => {
    if (mode === "single") {
      (hidden as HTMLInputElement).value = urls[0] ?? "";
    } else {
      (hidden as HTMLTextAreaElement).value = JSON.stringify(urls, null, 2);
    }
  };
  syncHidden();
  if (opts.editable && opts.registerInput) opts.registerInput(hidden);

  const viewport = document.createElement("div");
  viewport.className = "detail-image-viewport";
  const track = document.createElement("div");
  track.className = "detail-image-track";
  viewport.appendChild(track);

  const pagePrev = document.createElement("button");
  pagePrev.type = "button";
  pagePrev.className = "detail-image-page-btn detail-image-page-prev";
  pagePrev.textContent = "<";
  pagePrev.title = "Previous page";
  pagePrev.setAttribute("aria-label", "Previous page");
  const pageNext = document.createElement("button");
  pageNext.type = "button";
  pageNext.className = "detail-image-page-btn detail-image-page-next";
  pageNext.textContent = ">";
  pageNext.title = "Next page";
  pageNext.setAttribute("aria-label", "Next page");
  const pageDots = document.createElement("div");
  pageDots.className = "detail-image-page-dots";

  let page = 0;
  const perPage = () => {
    // ~96px cells + gap in ~available width; fallback 3
    const w = viewport.clientWidth || 320;
    return Math.max(1, Math.floor((w - 8) / 104));
  };

  const openAt = (i: number) => {
    openImageLightbox(() => urls, i);
  };

  const paint = () => {
    syncHidden();
    track.innerHTML = "";
    pageDots.innerHTML = "";
    const n = Math.max(1, perPage());
    const pageCount = Math.max(1, Math.ceil(Math.max(urls.length, 1) / n));
    if (page >= pageCount) page = pageCount - 1;
    if (page < 0) page = 0;

    if (!urls.length) {
      const empty = document.createElement("div");
      empty.className = "detail-image-empty muted";
      empty.textContent = opts.editable ? "No image" : "No image";
      track.appendChild(empty);
    } else {
      const start = page * n;
      const slice = urls.slice(start, start + n);
      slice.forEach((url, j) => {
        const i = start + j;
        const cell = document.createElement("div");
        cell.className = "detail-image-slide";
        // Use <div>, NOT <button>: nested buttons are illegal HTML and
        // browsers hoist %/× outside → they appear beside the thumb.
        const mid = document.createElement("div");
        mid.className = "detail-image-mid";
        mid.setAttribute("role", "button");
        mid.tabIndex = 0;
        mid.title = "Click to enlarge";
        const img = document.createElement("img");
        img.src = url;
        img.alt = `image ${i + 1}`;
        img.referrerPolicy = "no-referrer";
        img.loading = "lazy";
        img.draggable = false;
        img.onerror = () => {
          mid.classList.add("is-broken");
          img.replaceWith(document.createTextNode("!"));
        };
        mid.appendChild(img);
        mid.onclick = (e) => {
          if ((e.target as HTMLElement).closest(".detail-image-hit")) return;
          openAt(i);
        };
        mid.onkeydown = (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openAt(i);
          }
        };
        if (opts.editable) {
          const replaceBtn = document.createElement("button");
          replaceBtn.type = "button";
          replaceBtn.className = "detail-image-hit detail-image-replace";
          replaceBtn.textContent = "%";
          replaceBtn.title = "Replace from device";
          // Inline geometry — survives global `button { padding }` rules
          Object.assign(replaceBtn.style, {
            position: "absolute",
            top: "0",
            left: "0",
            width: "28px",
            height: "28px",
            margin: "0",
            padding: "0",
            zIndex: "5",
          });
          replaceBtn.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!uploadBase) {
              window.alert("Set APIJSON host in Settings before uploading.");
              return;
            }
            const picked = await pickAndUploadImages(uploadBase, false);
            if (!picked[0]) return;
            urls[i] = picked[0]!;
            if (mode === "single") urls = [picked[0]!];
            paint();
          };
          const rm = document.createElement("button");
          rm.type = "button";
          rm.className = "detail-image-hit detail-image-x";
          rm.textContent = "×";
          rm.title = "Remove";
          Object.assign(rm.style, {
            position: "absolute",
            top: "0",
            right: "0",
            left: "auto",
            width: "28px",
            height: "28px",
            margin: "0",
            padding: "0",
            zIndex: "5",
          });
          rm.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            urls = urls.filter((_, k) => k !== i);
            if (mode === "single") urls = urls.slice(0, 1);
            paint();
          };
          mid.append(replaceBtn, rm);
        }
        cell.appendChild(mid);
        track.appendChild(cell);
      });
    }

    for (let p = 0; p < pageCount; p++) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className =
        "detail-image-dot" + (p === page ? " is-active" : "");
      dot.setAttribute("aria-label", `Page ${p + 1}`);
      dot.onclick = () => {
        page = p;
        paint();
      };
      pageDots.appendChild(dot);
    }
    pagePrev.disabled = page <= 0;
    pageNext.disabled = page >= pageCount - 1;
    // display:none (not visibility) so left edge aligns with other form controls
    pagePrev.style.display = pageCount > 1 ? "" : "none";
    pageNext.style.display = pageCount > 1 ? "" : "none";
  };

  pagePrev.onclick = () => {
    page -= 1;
    paint();
  };
  pageNext.onclick = () => {
    page += 1;
    paint();
  };

  const main = document.createElement("div");
  main.className = "detail-image-main";
  main.append(pagePrev, viewport, pageNext);

  wrap.append(main, pageDots, hidden);

  if (opts.editable) {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "detail-image-add";
    addBtn.textContent = "+";
    addBtn.title =
      mode === "single"
        ? "Add / replace from device"
        : "Add image from device";
    addBtn.onclick = async () => {
      if (!uploadBase) {
        window.alert("Set APIJSON host in Settings before uploading.");
        return;
      }
      const picked = await pickAndUploadImages(uploadBase, mode === "list");
      if (!picked.length) return;
      if (mode === "single") {
        urls = [picked[0]!];
      } else {
        urls = [...urls, ...picked];
      }
      // Jump to last page
      page = 9999;
      paint();
    };
    wrap.appendChild(addBtn);
  }

  host.appendChild(wrap);
  // Layout after attach for perPage width
  requestAnimationFrame(() => paint());
  const ro =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => paint())
      : null;
  ro?.observe(viewport);
}

function isGenderField(path: string): boolean {
  const col = (path.includes(".") ? path.split(".").pop()! : path).toLowerCase();
  return /^(sex|gender)$/.test(col);
}

const GENDER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "0", label: "Male" },
  { value: "1", label: "Female" },
  { value: "2", label: "Other" },
];

function genderLabel(value: unknown): string {
  const s = String(value ?? "").trim();
  return GENDER_OPTIONS.find((o) => o.value === s)?.label ?? (s || "—");
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
    ? "Default two conditions: ≥ min and ≤ max (editable); combine with AND / OR; check NOT per row"
    : "Multiple conditions on one field; combine with AND / OR; check NOT per row";
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
        first.textContent = "When";
        row.appendChild(first);
      } else {
        const joinSel = document.createElement("select");
        joinSel.className = "filter-join";
        for (const [v, lab] of [
          ["and", "AND"],
          ["or", "OR"],
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
      notLab.append(notCb, document.createTextNode("NOT"));
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
          ? "Value"
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
      rm.title = "Remove condition";
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
  addBtn.textContent = "+ Add condition";
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
  applyBtn.textContent = "Apply";
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
  clearBtn.textContent = "Clear";
  clearBtn.onclick = () => {
    onApply?.(null, path);
    pop.remove();
  };
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
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

/** Paths shown in Column properties: current order + schema/json fields for those tables. */
function columnSettingsPaths(
  order: string[],
  responseColumns: string[],
  comments: SchemaComments | null,
): string[] {
  const tables = new Set<string>();
  for (const p of [...order, ...responseColumns]) {
    const t = p.includes(".") ? p.split(".")[0]! : "";
    if (t && /^[A-Z]/.test(t)) tables.add(t);
  }
  const seen = new Set(order);
  const extras: string[] = [];
  for (const t of tables) {
    for (const col of collectTableColumns(t, responseColumns, comments)) {
      const path = `${t}.${col}`;
      if (!seen.has(path)) {
        seen.add(path);
        extras.push(path);
      }
    }
  }
  extras.sort((a, b) => a.localeCompare(b));
  return [...order, ...extras];
}

function openColumnSettings(
  anchor: HTMLElement,
  order: string[],
  metas: Record<string, ColumnMeta>,
  comments: SchemaComments | null,
  ambiguous: Set<string>,
  onSave: (metas: Record<string, ColumnMeta>) => void,
  responseColumns?: string[],
) {
  document.getElementById("col-settings-popover")?.remove();
  const pop = document.createElement("div");
  pop.id = "col-settings-popover";
  pop.className = "filter-popover col-settings-popover";

  const title = document.createElement("div");
  title.className = "filter-popover-title";
  title.textContent = "Column properties (Excel-like)";
  pop.appendChild(title);

  const paths = columnSettingsPaths(
    order,
    responseColumns ?? order,
    comments,
  );
  const draft: Record<string, ColumnMeta> = structuredClone(metas);
  // Ensure schema-only json fields (contactIdList / pictureList…) have meta rows
  for (const path of paths) {
    if (!draft[path]) {
      const type = inferFieldType(path, [], comments);
      draft[path] = {
        path,
        type,
        visible: false,
        filterable: type !== "json",
        sortable: type !== "json",
      };
    }
  }
  const list = document.createElement("div");
  list.className = "col-settings-list";

  for (const path of paths) {
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
      ["visible", "Visible"],
      ["filterable", "Filterable"],
      ["sortable", "Sortable"],
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
  saveBtn.textContent = "Apply";
  saveBtn.onclick = () => {
    onSave(draft);
    pop.remove();
  };
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
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
    const tables = Object.keys(list).filter(
      (k) => /^[A-Z]/.test(k) && isPlainObject(list[k]),
    );
    // Primary = table without id@ (JOIN targets have id@)
    for (const t of tables) {
      const obj = list[t] as Record<string, unknown>;
      if (obj["id@"] == null) return t;
    }
    if (tables[0]) return tables[0];
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

/** Columns omitted from create forms (server injects / Request REFUSE). */
function createOmitColumns(table: string): Set<string> {
  const omit = new Set(["id", "date"]);
  if (table === "Moment" || table === "Comment") omit.add("userId");
  const rules = createRulesFromRequest(table);
  for (const f of rules?.refuse ?? []) omit.add(f);
  return omit;
}

/**
 * Required create fields — Request.structure MUST when available,
 * else Demo fallbacks. Shown with * and validated before submit.
 */
export function createRequiredColumns(table: string): string[] {
  const fromRequest = (createRulesFromRequest(table)?.must ?? []).filter(
    (f) => !f.includes(".") && !f.includes("[]"),
  );
  if (fromRequest.length) return fromRequest;
  switch (table) {
    case "Moment":
      return ["content"];
    case "Comment":
      return ["content", "momentId"];
    case "User":
      return ["name"];
    default:
      return [];
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
      body: stripApiJsonRole({ [table]: { id: nums[0] }, tag: table }),
    };
  }
  return {
    method: "delete",
    table,
    body: stripApiJsonRole({ [table]: { "id{}": nums }, tag: `${table}[]` }),
  };
}

export function buildPostBody(
  table: string,
  fields: Record<string, unknown>,
): WritePayload {
  return {
    method: "post",
    table,
    body: stripApiJsonRole({ [table]: fields, tag: table }),
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
  // Prefer list entity order: Comment before Moment (JOIN Moment must not win)
  for (const t of ["Comment", "Moment", "User"]) {
    if (
      tables.includes(t) &&
      String(row.cells[`${t}.id`] ?? "") === String(row.key)
    ) {
      return t;
    }
  }
  const byId = tables.find(
    (t) => String(row.cells[`${t}.id`] ?? "") === String(row.key),
  );
  if (byId) return byId;
  for (const t of ["Comment", "Moment", "User"]) {
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
    if (!col || isDetailReadonlyCol(col)) continue;
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
    body: stripApiJsonRole({ [table]: entity, tag: table }),
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
  label.textContent = "Condition combine";
  label.title =
    "Combine fields with AND/OR/NOT, e.g. date & (name | tag) or !date & content";
  bar.appendChild(label);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "filter-combine-input";
  input.spellcheck = false;
  input.placeholder = "date & (name | tag)";
  input.value = opts.value;
  input.title = "Editable: & AND | OR ! NOT, parentheses; Enter or blur to apply";
  bar.appendChild(input);

  const hint = document.createElement("span");
  hint.className = "filter-combine-hint-inline";
  const tokens = opts.filters.map((f) => {
    const col = f.path.includes(".") ? f.path.split(".").pop()! : f.path;
    return col;
  });
  hint.textContent = tokens.length ? `Fields: ${tokens.join(", ")}` : "";
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
  btn.textContent = "Apply";
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
  page.textContent = `${opts.pageCount} rows on this page`;
  bar.appendChild(page);

  const selected = document.createElement("span");
  selected.className =
    "status-selected" + (opts.selectedCount > 0 ? " is-active" : "");
  selected.textContent = `${opts.selectedCount} selected`;
  bar.appendChild(selected);

  if (opts.onBatchDelete) {
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className =
      "danger batch-del" + (opts.selectedCount > 0 ? "" : " hidden");
    delBtn.textContent = "Delete";
    delBtn.onclick = () => {
      if (confirm(`Delete selected ${opts.primaryTable} records?`)) {
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
    addBtn.title = "Add a table to the query";
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
        "JOIN mode: & INNER · | FULL · ! OUTER · < LEFT · > RIGHT · ( ANTI · ) SIDE · APP @";
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
    chip.textContent = t === opts.primaryTable ? `${t} (primary)` : t;
    chip.title =
      t === opts.primaryTable
        ? "Primary table · click for DDL / manage"
        : "Click for DDL / set as primary / remove";
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
      rm.title = `Remove ${t} from query`;
      rm.textContent = "×";
      rm.onclick = (e) => {
        e.stopPropagation();
        if (t === opts.primaryTable) {
          if (
            !confirm(
              `Remove primary table ${t}? The first remaining table will become primary.`,
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
  title.textContent = "Add query table";
  pop.appendChild(title);

  if (!available.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No more tables to add";
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

function columnsFromBodyTemplate(
  table: string,
  bodyTemplate: Record<string, unknown> | null,
): string[] | null {
  const list = bodyTemplate?.["[]"];
  if (!isPlainObject(list) || !isPlainObject(list[table])) return null;
  const col = list[table]!["@column"];
  if (typeof col !== "string" || !col.trim()) return null;
  const cols = col
    .split(",")
    .map((s) => parseColumnReturnToken(s.trim()).col)
    .filter(Boolean);
  return cols.length ? cols : null;
}

function selectedColumnsForTable(
  table: string,
  primaryTable: string,
  fkExpand: Record<string, FkJoinSpec>,
  bodyTemplate: Record<string, unknown> | null,
): string[] {
  // Prefer live body @column (source of truth after Apply / template)
  const fromBody = columnsFromBodyTemplate(table, bodyTemplate);
  if (fromBody) return fromBody;

  if (table !== primaryTable) {
    const spec = fkExpand[table];
    // Table present in body but no @column yet → still treat as selected defaults
    const list = bodyTemplate?.["[]"];
    const inBody =
      isPlainObject(list) && isPlainObject(list[table]);
    if (spec?.enabled === false && !inBody) return [];
    if (spec?.columns?.length) return [...spec.columns];
    return defaultFkColumns(table);
  }
  // Primary with no @column → default: all non-id from optional/known
  return (FK_OPTIONAL_COLUMNS[table] ?? ["id", "name", "content"]).filter(
    (c) => c !== "id",
  );
}

/**
 * Per-field ON defaults: only high-confidence FKs get filled; others stay empty.
 * - Primary *Id → ON related_table.id
 * - Join table `id` with a known edge → ON primary_table.fkCol
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
    ? `${opts.table}${isPrimary ? " (primary)" : ""} — ${tableComment}`
    : `${opts.table}${isPrimary ? " (primary)" : ""}`;
  pop.appendChild(title);

  const tip = document.createElement("div");
  tip.className = "filter-combine-hint";
  tip.textContent = isPrimary
    ? "Select fields to query; set column display names. FK columns can configure related table/field/mode."
    : "Select fields to JOIN (text fields by default); set display names and related table/field.";
  pop.appendChild(tip);

  const headActions = document.createElement("div");
  headActions.className = "table-ddl-head-actions";
  if (opts.onSetPrimary) {
    const setPri = document.createElement("button");
    setPri.type = "button";
    setPri.textContent = "Set as primary";
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
    rm.textContent = "Remove table";
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
    returnAgg: ColumnReturnAgg;
    returnExpr: string;
  };

  const selectedSet = new Set(
    selectedColumnsForTable(
      opts.table,
      opts.primaryTable,
      opts.fkExpand,
      opts.bodyTemplate,
    ),
  );

  /** Restore return mode from bodyTemplate @column when meta missing. */
  const returnFromBody = new Map<
    string,
    { returnAgg: ColumnReturnAgg; returnExpr?: string }
  >();
  {
    const listObj = opts.bodyTemplate?.["[]"];
    if (isPlainObject(listObj) && isPlainObject(listObj[opts.table])) {
      const tableObj = listObj[opts.table] as Record<string, unknown>;
      const raw = tableObj["@column"];
      if (typeof raw === "string") {
        for (const part of raw.split(",")) {
          const parsed = parseColumnReturnToken(part.trim());
          if (parsed.col) {
            returnFromBody.set(parsed.col, {
              returnAgg: parsed.returnAgg,
              returnExpr: parsed.returnExpr,
            });
          }
        }
      }
    }
  }

  const renderEditor = (comments: SchemaComments | null) => {
    list.innerHTML = "";
    const cols = collectTableColumns(opts.table, opts.columns, comments);
    if (!cols.length) {
      list.innerHTML = `<div class="muted">No column info</div>`;
      return;
    }

    const drafts: RowDraft[] = cols.map((col) => {
      const path = `${opts.table}.${col}`;
      const meta = opts.columnMetas[path];
      const fromBody = returnFromBody.get(col);
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
        returnAgg: meta?.returnAgg ?? fromBody?.returnAgg ?? "data",
        returnExpr: meta?.returnExpr ?? fromBody?.returnExpr ?? "",
      };
    });

    const header = document.createElement("div");
    header.className = "table-ddl-row table-ddl-head-row";
    header.innerHTML =
      "<span></span><span>Field</span><span>Type</span><span>Display name</span><span>Related table</span><span>Related field</span><span>Mode</span><span>Return</span><span>Comment</span>";
    list.appendChild(header);

    const otherTables = [
      ...new Set([
        ...CATALOG_TABLES,
        ...opts.queryTables,
        opts.primaryTable,
      ]),
    ].filter((t) => t && t !== "Record");

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
      cb.title = "Checked = query/JOIN this field";
      cb.onchange = () => {
        d.selected = cb.checked;
      };

      const name = document.createElement("code");
      name.textContent = d.col;

      const type = document.createElement("span");
      type.className = "table-ddl-type";
      type.textContent = comments?.types?.[path] || "—";

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
      onTableSel.setAttribute("aria-label", "Related table");
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
      onFieldSel.setAttribute("aria-label", "Related field");
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

      const returnWrap = document.createElement("div");
      returnWrap.className = "table-ddl-return";
      const returnSel = document.createElement("select");
      returnSel.className = "ddl-return-select";
      returnSel.title = "Return: Data or aggregate for @column";
      for (const opt of COLUMN_RETURN_OPTIONS) {
        const o = document.createElement("option");
        o.value = opt.agg;
        o.textContent = opt.label;
        if (opt.agg === d.returnAgg) o.selected = true;
        returnSel.appendChild(o);
      }
      const returnExpr = document.createElement("input");
      returnExpr.type = "text";
      returnExpr.className = "ddl-return-expr";
      returnExpr.placeholder = "e.g. sum(commentCount)";
      returnExpr.title = "Custom @column expression";
      returnExpr.value = d.returnExpr;
      returnExpr.hidden = d.returnAgg !== "custom";
      returnSel.onchange = () => {
        d.returnAgg = returnSel.value as ColumnReturnAgg;
        returnExpr.hidden = d.returnAgg !== "custom";
        if (d.returnAgg === "custom") returnExpr.focus();
      };
      returnExpr.oninput = () => {
        d.returnExpr = returnExpr.value;
      };
      returnWrap.append(returnSel, returnExpr);

      const comment = document.createElement("span");
      comment.className = "table-ddl-comment";
      const raw = comments?.columns?.[path] || "";
      comment.textContent = raw.replace(/\s*\([^)]*\)\s*$/, "") || "—";
      comment.title = raw;

      row.append(
        cb,
        name,
        type,
        displayIn,
        onTableSel,
        onFieldSel,
        onJoinSel,
        returnWrap,
        comment,
      );
      list.appendChild(row);
    }

    // stash drafts on list for apply
    (list as unknown as { __drafts?: RowDraft[] }).__drafts = drafts;
  };

  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = "primary";
  applyBtn.textContent = "Apply";
  applyBtn.onclick = () => {
    const drafts =
      (list as unknown as { __drafts?: RowDraft[] }).__drafts ?? [];
    if (!drafts.length) {
      // Editor not ready (still loading comments) — don't wipe @column
      return;
    }
    const selectedColumns = drafts.filter((d) => d.selected).map((d) => d.col);
    const fieldMetas: Record<string, Partial<ColumnMeta>> = {};
    for (const d of drafts) {
      const path = `${opts.table}.${d.col}`;
      fieldMetas[path] = {
        displayName: d.displayName.trim() || undefined,
        onTable: d.onTable || undefined,
        onField: d.onField || undefined,
        onJoin: d.onJoin,
        returnAgg: d.returnAgg,
        returnExpr:
          d.returnAgg === "custom" ? d.returnExpr.trim() || undefined : undefined,
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
  cancel.textContent = "Close";
  cancel.onclick = () => pop.remove();
  actions.append(applyBtn, cancel);
  pop.appendChild(actions);

  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  const popW = Math.min(1100, window.innerWidth - 16);
  const left = Math.max(
    8,
    Math.min(rect.left + window.scrollX, window.scrollX + window.innerWidth - popW - 8),
  );
  pop.style.top = `${rect.bottom + window.scrollY + 6}px`;
  pop.style.left = `${left}px`;

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
    list.innerHTML = `<div class="muted">Loading comments…</div>`;
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
          ? `${opts.table}${isPrimary ? " (primary)" : ""} — ${tc}`
          : `${opts.table}${isPrimary ? " (primary)" : ""}`;
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
      // userId omitted — OWNER injects the logged-in visitor
      return [];
    case "Comment":
      return ["momentId"];
    default:
      return [];
  }
}

function createFormColumnNames(
  table: string,
  columns: string[],
  comments: SchemaComments | null,
  defaults: Record<string, unknown>,
): string[] {
  const omit = createOmitColumns(table);
  const required = createRequiredColumns(table);
  const cols = collectTableColumns(table, columns, comments).filter(
    (c) => !omit.has(c),
  );
  for (const c of [
    ...createFkColumnHints(table),
    ...Object.keys(defaults),
    ...required,
  ]) {
    if (!omit.has(c) && !cols.includes(c)) cols.push(c);
  }
  const req = new Set(required);
  cols.sort((a, b) => {
    const ra = req.has(a) ? 0 : 1;
    const rb = req.has(b) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });
  return cols;
}

function openCreateForm(
  container: HTMLElement,
  opts: {
    table: string;
    columns: string[];
    comments: SchemaComments | null;
    apijsonBase: string;
    initialValues?: Record<string, unknown>;
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
  title.textContent = `Add ${opts.table}`;
  header.appendChild(title);
  card.appendChild(header);

  const section = document.createElement("div");
  section.className = "detail-table-title";
  section.textContent = opts.table;
  card.appendChild(section);

  const form = document.createElement("div");
  form.className = "detail-fields";
  card.appendChild(form);

  const actions = document.createElement("div");
  actions.className = "detail-form-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary";
  saveBtn.textContent = "Create";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.onclick = goBack;
  actions.append(saveBtn, cancel);
  card.appendChild(actions);
  detailHost.appendChild(card);

  const flashSave = (msg: string, ms = 1400) => {
    saveBtn.textContent = msg;
    setTimeout(() => {
      saveBtn.textContent = "Create";
    }, ms);
  };

  const paint = (comments: SchemaComments | null) => {
    form.innerHTML = "";
    const reqRules = createRulesFromRequest(opts.table);
    const defaults = {
      ...createFieldDefaults(opts.table),
      ...(reqRules?.insert ?? {}),
      ...(opts.initialValues ?? {}),
    };
    // Ensure INSERT-only columns (e.g. pictureList) appear in the form
    for (const col of Object.keys(reqRules?.insert ?? {})) {
      if (!(col in defaults)) defaults[col] = reqRules!.insert[col];
    }
    const required = new Set(createRequiredColumns(opts.table));
    const colNames = createFormColumnNames(
      opts.table,
      opts.columns,
      comments,
      defaults,
    );
    const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
    const fkGetters = new Map<string, () => string | number | null>();

    for (const col of colNames) {
      const path = `${opts.table}.${col}`;
      const field = document.createElement("label");
      field.className = "detail-field";
      const name = document.createElement("span");
      name.className = "field-name";
      const tip = commentFor(path, comments);
      name.textContent = tip ? `${path} — ${tip.split(" (")[0]}` : path;
      if (required.has(col)) {
        const star = document.createElement("span");
        star.className = "field-required";
        star.textContent = " *";
        star.title = "Required";
        name.appendChild(star);
      }
      field.appendChild(name);

      const fkTable = resolveFkTable(path, comments);
      const fkIdListTable = resolveFkIdListTable(path, comments);
      const fieldType = inferFieldType(path, [defaults[col]], comments);
      const defaultVal = defaults[col];
      if (fkTable) {
        const host = document.createElement("div");
        const ctl = mountFkFieldControl(host, {
          path,
          table: fkTable,
          apijsonBase: opts.apijsonBase,
          comments,
          onChange: () => undefined,
        });
        fkGetters.set(col, ctl.getValue);
        field.appendChild(host);
      } else if (fkIdListTable) {
        field.classList.add("detail-field-block");
        const host = document.createElement("div");
        mountFkIdListControl(host, {
          path,
          table: fkIdListTable,
          apijsonBase: opts.apijsonBase,
          comments,
          initialIds: defaultVal ?? [],
          editable: true,
          registerInput: (el) => {
            if (
              el instanceof HTMLTextAreaElement ||
              el instanceof HTMLInputElement
            ) {
              inputs.set(col, el);
            }
          },
        });
        field.appendChild(host);
      } else if (isImageListField(path, defaultVal)) {
        mountImageListEditor(field, {
          path,
          value: defaultVal ?? [],
          editable: true,
          mode: "list",
          apijsonBase: opts.apijsonBase,
          registerInput: (el) => {
            if (
              el instanceof HTMLTextAreaElement ||
              el instanceof HTMLInputElement
            ) {
              inputs.set(col, el);
            }
          },
        });
      } else if (isImageUrlField(path, defaultVal)) {
        mountImageListEditor(field, {
          path,
          value: defaultVal ?? "",
          editable: true,
          mode: "single",
          apijsonBase: opts.apijsonBase,
          registerInput: (el) => {
            if (
              el instanceof HTMLTextAreaElement ||
              el instanceof HTMLInputElement
            ) {
              inputs.set(col, el);
            }
          },
        });
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

    saveBtn.onclick = () => {
      void (async () => {
        for (const col of required) {
          if (fkGetters.has(col)) {
            if (fkGetters.get(col)!() == null) {
              flashSave(`${col} * required`);
              return;
            }
            continue;
          }
          const el = inputs.get(col);
          if (!el || !String(el.value ?? "").trim()) {
            flashSave(`${col} * required`);
            return;
          }
        }
        const fields: Record<string, unknown> = {};
        for (const [col, el] of inputs) {
          const raw = el.value.trim();
          if (raw === "") continue;
          const fieldPath = `${opts.table}.${col}`;
          if (el.dataset.kind === "json") {
            try {
              fields[col] = JSON.parse(raw);
            } catch {
              flashSave(`${col} JSON invalid`);
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
            if (required.has(col)) {
              flashSave(`${col} * required`);
              return;
            }
            continue;
          }
          fields[col] = id;
        }
        if (!Object.keys(fields).length) {
          flashSave("Fill in at least one field", 1200);
          return;
        }
        // Safety: any leftover data:/blob: → /upload → host+path before /post
        try {
          for (const col of Object.keys(fields)) {
            const path = `${opts.table}.${col}`;
            const val = fields[col];
            if (isImageListField(path, val) && Array.isArray(val)) {
              fields[col] = await ensureRemoteImageList(
                opts.apijsonBase,
                val,
              );
            } else if (
              isImageUrlField(path, val) &&
              typeof val === "string"
            ) {
              fields[col] = await ensureRemoteImageUrl(
                opts.apijsonBase,
                val,
              );
            }
          }
        } catch (e) {
          flashSave(e instanceof Error ? e.message : String(e));
          return;
        }
        void opts.onSubmit(buildPostBody(opts.table, fields));
      })();
    };
  };

  const hasCols =
    opts.comments &&
    Object.keys(opts.comments.columns).some((k) =>
      k.startsWith(`${opts.table}.`),
    );

  const boot = async () => {
    form.innerHTML = `<div class="muted">Loading fields…</div>`;
    await ensureRequestStructures(opts.apijsonBase).catch(() => undefined);
    let comments = opts.comments;
    if (!hasCols) {
      try {
        const data = (await fetch(
          `/api/schema-comments?tables=${encodeURIComponent(opts.table)}`,
        ).then((r) => r.json())) as SchemaComments;
        comments = {
          tables: { ...(opts.comments?.tables ?? {}), ...(data.tables ?? {}) },
          columns: {
            ...(opts.comments?.columns ?? {}),
            ...(data.columns ?? {}),
          },
          types: { ...(opts.comments?.types ?? {}), ...(data.types ?? {}) },
        };
        (
          window as unknown as {
            __a2apiSetComments?: (c: SchemaComments) => void;
          }
        ).__a2apiSetComments?.(comments);
      } catch {
        /* keep opts.comments */
      }
    }
    if (document.body.contains(card)) paint(comments);
  };
  void boot();
}

/** Detail fields that stay read-only even in edit mode. */
const DETAIL_READONLY_COLS = new Set(["id", "userid", "date"]);

function isDetailReadonlyCol(col: string): boolean {
  return DETAIL_READONLY_COLS.has(col.toLowerCase());
}

/** Ensure detail row includes every known schema column (null if missing). */
function expandDetailRowFields(
  row: FlatRow,
  table: string,
  comments: SchemaComments | null,
): FlatRow {
  const known = collectTableColumns(
    table,
    Object.keys(row.cells),
    comments,
  );
  const cells = { ...row.cells };
  for (const col of known) {
    const path = `${table}.${col}`;
    if (!(path in cells)) cells[path] = null;
  }
  return { ...row, cells };
}

async function openFkDetail(
  container: HTMLElement,
  opts: {
    table: string;
    id: string | number;
    comments: SchemaComments | null;
    apijsonBase: string;
    mode?: "view" | "edit";
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
  detailHost.innerHTML = `<div class="result-empty">Loading ${opts.table}#${opts.id}…</div>`;

  const mode: "view" | "edit" =
    opts.mode ?? (opts.onWrite ? "edit" : "view");

  try {
    // Full-field GET by id (no @column)
    const body = await withRequestRole(
      buildFkGetBody(opts.table, opts.id),
      "get",
      opts.apijsonBase,
    );
    const res = await fetch(`${opts.apijsonBase}/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { code?: number; msg?: string };
    if (!res.ok || json.code !== 200) {
      detailHost.innerHTML = `<div class="result-empty">Load failed: ${json.msg || res.statusText}</div>`;
      return;
    }
    const parsed = parseResponse(json);
    let row = parsed.rows[0];
    if (!row) {
      detailHost.innerHTML = `<div class="result-empty">Not found: ${opts.table}#${opts.id}</div>`;
      return;
    }
    row = expandDetailRowFields(row, opts.table, opts.comments);
    detailHost.innerHTML = "";
    renderDetailForm(detailHost, row, {
      comments: opts.comments,
      mode,
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
      onSave: opts.onWrite,
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
    ? `${primary} ${editableMode ? "Edit" : "View"} #${row.key}`
    : `${editableMode ? "Edit" : "View"} #${row.key}`;
  header.appendChild(title);

  let rawMode = false;
  const modeToggle = document.createElement("button");
  modeToggle.type = "button";
  modeToggle.className = "detail-raw-toggle";
  modeToggle.textContent = "Raw";
  modeToggle.title = "Toggle smart display vs raw values";
  header.appendChild(modeToggle);
  card.appendChild(header);

  const fieldsHost = document.createElement("div");
  fieldsHost.className = "detail-fields-host";
  card.appendChild(fieldsHost);

  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
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

  const paintFields = () => {
    fieldsHost.innerHTML = "";
    inputs.clear();
    fkValues.clear();

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
        section.textContent = `${table} (related) · View details`;
        section.title = `View ${table}#${sectionFk.id}`;
        section.onclick = () => jumpToFk(sectionFk);
        fieldsHost.appendChild(section);
      } else {
        const section = document.createElement("div");
        section.className = "detail-table-title";
        section.textContent =
          editableMode && table === primary
            ? `${table} (editable)`
            : table === primary
              ? table
              : `${table} (related)`;
        section.title = tooltip(table, comments);
        fieldsHost.appendChild(section);
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
      // Edit mode: all primary fields editable except id / userId / date
      const editable =
        editableMode &&
        table === primary &&
        !isDetailReadonlyCol(col);
      const fkTable = resolveFkTable(key, comments);
      const fkIdListTable = resolveFkIdListTable(key, comments);
      const fk = cellFkJumpMeta(key, value, row.cells, comments, primary);
      const fieldType = inferFieldType(key, [value], comments);
      const useSmart = !rawMode;

      if (useSmart && fkIdListTable && opts.apijsonBase) {
        field.classList.add("detail-field-block");
        const host = document.createElement("div");
        mountFkIdListControl(host, {
          path: key,
          table: fkIdListTable,
          apijsonBase: opts.apijsonBase,
          comments,
          initialIds: value,
          editable,
          registerInput: (el) => {
            if (editable) inputs.set(key, el);
          },
        });
        field.appendChild(host);
      } else if (useSmart && isImageListField(key, value)) {
        field.classList.add("detail-field-block");
        mountImageListEditor(field, {
          path: key,
          value,
          editable,
          mode: "list",
          apijsonBase: opts.apijsonBase,
          registerInput: (el) => {
            if (editable) inputs.set(key, el);
          },
        });
      } else if (useSmart && isImageUrlField(key, value) && !isComplex) {
        field.classList.add("detail-field-block");
        mountImageListEditor(field, {
          path: key,
          value,
          editable,
          mode: "single",
          apijsonBase: opts.apijsonBase,
          registerInput: (el) => {
            if (editable) inputs.set(key, el);
          },
        });
      } else if (useSmart && isGenderField(key) && !isComplex) {
        if (editable) {
          const sel = document.createElement("select");
          sel.dataset.path = key;
          sel.dataset.kind = "number";
          const cur = String(value ?? "");
          let matched = false;
          for (const opt of GENDER_OPTIONS) {
            const o = document.createElement("option");
            o.value = opt.value;
            o.textContent = `${opt.label} (${opt.value})`;
            if (opt.value === cur) {
              o.selected = true;
              matched = true;
            }
            sel.appendChild(o);
          }
          if (!matched && cur !== "") {
            const o = document.createElement("option");
            o.value = cur;
            o.textContent = `Raw: ${cur}`;
            o.selected = true;
            sel.appendChild(o);
          }
          inputs.set(key, sel);
          field.appendChild(sel);
        } else {
          const span = document.createElement("span");
          span.className = "detail-smart-text";
          span.textContent = genderLabel(value);
          span.title = `raw: ${cellText(value)}`;
          field.appendChild(span);
        }
      } else if (editable && fkTable && opts.apijsonBase && !isComplex) {
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
            ? `View ${fk.label}`
            : `View ${fk.table}`;
          jump.onclick = () => jumpToFk(fk);
          host.appendChild(jump);
        }
        field.appendChild(host);
      } else if (fk && opts.apijsonBase && !editable && !isComplex) {
        const a = document.createElement("button");
        a.type = "button";
        a.className = "fk-link detail-fk-value";
        a.textContent = fk.label || cellText(value) || `${fk.table}#${fk.id}`;
        a.title = `View ${fk.table} details (id=${fk.id})`;
        a.onclick = (e) => {
          e.preventDefault();
          jumpToFk(fk);
        };
        field.appendChild(a);
      } else if (isComplex) {
        // Non-image arrays/objects: JSON; image lists already handled above
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
      } else if (!rawMode && (fieldType === "date" || fieldType === "time")) {
        const input = document.createElement("input");
        input.type = inputTypeForField(fieldType);
        input.readOnly = !editable;
        input.dataset.path = key;
        input.dataset.kind = fieldType;
        input.value = displayTimeValue(fieldType, cellText(value));
        input.title = tooltip(key, comments);
        if (editable) inputs.set(key, input);
        field.appendChild(input);
      } else if (!rawMode && fieldType === "number") {
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
    fieldsHost.appendChild(form);
  }
  };

  modeToggle.onclick = () => {
    rawMode = !rawMode;
    modeToggle.textContent = rawMode ? "Smart" : "Raw";
    modeToggle.classList.toggle("is-raw", rawMode);
    paintFields();
  };
  paintFields();

  const actions = document.createElement("div");
  actions.className = "detail-form-actions";
  if (writeFn && primary && editableMode) {
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "primary";
    saveBtn.textContent = "Save";
    saveBtn.onclick = () => {
      void (async () => {
        if (!confirm(`Save changes to #${row.key}?`)) return;
        const edited: Record<string, string> = {};
        for (const [path, el] of inputs) edited[path] = el.value;
        for (const [path, id] of fkValues) {
          if (id == null) {
            saveBtn.textContent = `Select foreign key`;
            setTimeout(() => {
              saveBtn.textContent = "Save";
            }, 1400);
            return;
          }
          edited[path] = String(id);
        }
        const base = (opts.apijsonBase || "").replace(/\/+$/, "");
        if (base) {
          try {
            for (const [path, text] of Object.entries(edited)) {
              if (isImageListField(path, text)) {
                let arr: unknown[];
                try {
                  arr = JSON.parse(text) as unknown[];
                } catch {
                  continue;
                }
                if (!Array.isArray(arr)) continue;
                edited[path] = JSON.stringify(
                  await ensureRemoteImageList(base, arr),
                );
              } else if (isImageUrlField(path, text)) {
                edited[path] = await ensureRemoteImageUrl(base, text);
              }
            }
          } catch (e) {
            saveBtn.textContent =
              e instanceof Error ? e.message.slice(0, 40) : "Upload failed";
            setTimeout(() => {
              saveBtn.textContent = "Save";
            }, 2000);
            return;
          }
        }
        const payload = buildPutFromDetail(row, edited);
        if (!payload) {
          saveBtn.textContent = "No changes";
          setTimeout(() => {
            saveBtn.textContent = "Save";
          }, 1200);
          return;
        }
        void writeFn(payload);
      })();
    };
    actions.appendChild(saveBtn);
  }
  if (opts.onDelete) {
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "danger";
    delBtn.textContent = "Delete";
    delBtn.onclick = () => {
      if (confirm(`Delete ${primary || ""} #${row.key}? This cannot be undone.`)) {
        opts.onDelete?.();
      }
    };
    actions.appendChild(delBtn);
  }
  if (actions.childNodes.length) card.appendChild(actions);

  container.appendChild(card);
}

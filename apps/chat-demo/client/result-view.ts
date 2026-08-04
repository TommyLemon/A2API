/** Parse APIJSON responses into flat rows for table / detail form rendering. */

import { loadSettings, logoutIfApijsonAuthFailed } from "./account.js";
import { APIJSON_BROWSER_BASE } from "./aj-base.js";
import { withApijsonAuth } from "./aj-auth.js";
import { t } from "./i18n/index.js";
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
  pickPreferredGroupBy,
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
  COLUMN_SHOW_OPTIONS,
  ensureColumnOrder,
  fieldTypeLabel,
  formatColumnReturnToken,
  headerLabel,
  inferColumnShow,
  inferFieldType,
  parseColumnReturnToken,
  type ColumnMeta,
  type ColumnReturnAgg,
  type ColumnShow,
  type FieldType,
  type OnJoinMode,
} from "./field-meta.js";
import {
  mountFkFieldControl,
  mountFkIdListControl,
  parseIdList,
  resolveFkIdListTable,
} from "./fk-picker.js";
import {
  buildFkGetBody,
  cellFkJumpMeta,
  FK_DISPLAY_FIELDS,
  resolveFkRef,
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
import { catalogTables, isBusinessTable } from "./query-tables.js";
import { ensureAccessRoles, withRequestRole } from "./access-roles.js";
import {
  ensureRemoteImageList,
  ensureRemoteImageUrl,
  uploadFiles,
} from "./upload.js";
import {
  collectFileUrl,
  fieldSuggestsImage,
  fieldSuggestsImageList,
  parseArrayValue,
  pickBestImageUrl,
  resolveImageSrc,
  resolveSmartImageField,
  type ImageShowMode,
} from "./smart-image-fields.js";
import {
  createRulesFromRequest,
  ensureRequestStructures,
} from "./request-structures.js";
import {
  applyRelateToColumnMetas,
  buildCrudPayload,
  CRUD_OP_OPTIONS,
  crudOpLabel,
  defaultRelateForTable,
  newDetailSlotId,
  RELATE_OP_OPTIONS,
  resolveRelateLocalField,
  slotLocalField,
  type CrudOp,
  type DetailTableSlot,
  type RelateOp,
  type RelateSyncPayload,
} from "./detail-crud.js";
import { pageTitleForTable } from "./saved-pages.js";
import { stripApiJsonRole, type SchemaComments } from "./schema-types.js";
import {
  isAuthVerifyField,
  mountAuthVerifyField,
  attachAuthVerifyToWritePayload,
  pickAuthVerifyCode,
  requireAuthVerifyCodes,
  verifyTypeForWrite,
  type AuthVerifyControl,
} from "./verify-code.js";
import {
  ALL_FILTER_OPS,
  FILTER_OP_LABELS,
  defaultFilterOp,
  emptyCondition,
  filterHasValue,
  filtersForPath,
  newConditionId,
  normalizeFilterOp,
  sortDirOf,
  type ColumnFilter,
  type ColumnSort,
  type FilterCondition,
  type FilterJoin,
  type FilterOp,
} from "./table-query.js";

export type { SchemaComments } from "./schema-types.js";
export type { ColumnMeta, ColumnShow, FieldType } from "./field-meta.js";

export type ViewMode = "list" | "detail";
export type DisplayKind = "combined" | "table" | "grid" | ChartKind;

function columnShowOf(
  path: string,
  metas?: Record<string, ColumnMeta> | null,
): ImageShowMode {
  return (metas?.[path]?.show as ImageShowMode | undefined) ?? "auto";
}

function showMapFromMetas(
  metas: Record<string, ColumnMeta>,
): Record<string, ImageShowMode | undefined> {
  const out: Record<string, ImageShowMode | undefined> = {};
  for (const [p, m] of Object.entries(metas)) out[p] = m.show;
  return out;
}

/** Registered by list render; toolbar Add calls this. */
let listCreateAction: (() => void) | null = null;

/** Table list: false = smart (images/gender…), true = raw text. Survives re-renders. */
let tableValueRawMode = false;

export function triggerListCreate(): boolean {
  if (!listCreateAction) return false;
  listCreateAction();
  return true;
}

/**
 * Mount an empty Add/create detail form (no Table chrome).
 * Used by New comment / New moment chips.
 */
export function mountCreateView(
  container: HTMLElement,
  opts: {
    table: string;
    comments?: SchemaComments | null;
    columnMetas?: Record<string, ColumnMeta> | null;
    fkExpand?: Record<string, FkJoinSpec> | null;
    apijsonBaseUrl?: string;
    initialValues?: Record<string, unknown> | null;
    /** Restore multi-table slots (e.g. register = User + Privacy) */
    initialSlots?: DetailTableSlot[] | null;
    pageTitle?: string;
    onSubmit: (payload: WritePayload) => void | Promise<void>;
    onBack?: () => void;
    onRelateSync?: (payload: RelateSyncPayload) => void;
    onColumnMetasChange?: (metas: Record<string, ColumnMeta>) => void;
    onPageTitleChange?: (title: string) => void;
    onDetailSlotsChange?: (slots: DetailTableSlot[]) => void;
  },
): void {
  container.innerHTML = "";
  container.classList.remove("hidden");
  listCreateAction = null;
  const apijsonBase = (opts.apijsonBaseUrl || APIJSON_BROWSER_BASE).replace(
    /\/+$/,
    "",
  );
  openCreateForm(container, {
    table: opts.table,
    columns: [],
    comments: opts.comments ?? null,
    columnMetas: opts.columnMetas ?? null,
    fkExpand: opts.fkExpand ?? null,
    apijsonBase,
    initialValues: opts.initialValues ?? undefined,
    initialSlots: opts.initialSlots ?? undefined,
    pageTitle: opts.pageTitle,
    onRelateSync: opts.onRelateSync,
    onColumnMetasChange: opts.onColumnMetasChange,
    onPageTitleChange: opts.onPageTitleChange,
    onDetailSlotsChange: opts.onDetailSlotsChange,
    onBack: () => {
      if (opts.onBack) opts.onBack();
      else mountWorkspaceGuide(container);
    },
    onSubmit: opts.onSubmit,
  });
}

function makeBackIconButton(onClick: () => void): HTMLButtonElement {
  const back = document.createElement("button");
  back.type = "button";
  back.className = "detail-back-icon";
  back.title = t("common.back");
  back.setAttribute("aria-label", "Back");
  back.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
  back.onclick = onClick;
  return back;
}

/** Drop trailing `#id` from a page title — id lives in the header control. */
function stripTitleRecordId(title: string): string {
  return title.replace(/\s*#\S+\s*$/u, "").trim();
}

/**
 * Editable page title on detail/create — same store as top page selector.
 * Rename to e.g. "register" to keep User+Privacy as a reusable page.
 */
function mountDetailPageTitleInput(
  host: HTMLElement,
  opts: {
    value: string;
    placeholder?: string;
    onCommit?: (title: string) => void;
  },
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "detail-page-title-input";
  input.value = opts.value;
  input.placeholder = opts.placeholder || "Page title";
  input.title =
    "Rename to save as a new page (e.g. register) — the current page stays unchanged";
  input.setAttribute("aria-label", "Page title");
  const commit = () => {
    const next = input.value.trim();
    if (!next) {
      input.value = opts.value;
      return;
    }
    opts.onCommit?.(next);
  };
  input.onchange = commit;
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      input.blur();
    }
  };
  host.appendChild(input);
  return input;
}

/**
 * `#` + searchable id — Enter / blur loads that record (right of page title).
 */
function mountDetailRecordIdControl(
  host: HTMLElement,
  opts: {
    id: string | number;
    onSwitch?: (id: string | number) => void;
  },
): HTMLInputElement {
  const wrap = document.createElement("div");
  wrap.className = "detail-record-id";
  const hash = document.createElement("span");
  hash.className = "detail-record-id-hash";
  hash.textContent = "#";
  hash.setAttribute("aria-hidden", "true");
  const input = document.createElement("input");
  input.type = "search";
  input.className = "detail-record-id-input";
  input.value = String(opts.id ?? "");
  input.placeholder = t("result.idPlaceholder");
  input.size = 13;
  input.title = t("result.idSearchTitle");
  input.setAttribute("aria-label", "Record id");
  input.autocomplete = "off";
  input.spellcheck = false;
  const commit = () => {
    const raw = input.value.trim().replace(/^#/, "");
    if (!raw) {
      input.value = String(opts.id ?? "");
      return;
    }
    if (raw === String(opts.id)) return;
    const id = /^-?\d+$/.test(raw) ? Number(raw) : raw;
    opts.onSwitch?.(id);
  };
  input.onchange = commit;
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      commit();
      input.blur();
    }
  };
  wrap.append(hash, input);
  host.appendChild(wrap);
  return input;
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
    <h3 class="workspace-guide-title">${t("guide.title")}</h3>
    <p class="workspace-guide-lead">
      ${t("guide.lead")}
    </p>
    <ol class="workspace-guide-steps">
      <li>
        <strong>${t("guide.step1Title")}</strong>
        <span>${t("guide.step1Body")}</span>
      </li>
      <li>
        <strong>${t("guide.step2Title")}</strong>
        <span>${t("guide.step2Body")}</span>
      </li>
      <li>
        <strong>${t("guide.step3Title")}</strong>
        <span>${t("guide.step3Body")}</span>
      </li>
      <li>
        <strong>${t("guide.step4Title")}</strong>
        <span>${t("guide.step4Body")}</span>
      </li>
      <li>
        <strong>${t("guide.step5Title")}</strong>
        <span>${t("guide.step5Body")}</span>
      </li>
      <li>
        <strong>${t("guide.step6Title")}</strong>
        <span>${t("guide.step6Body")}</span>
      </li>
    </ol>
    <p class="workspace-guide-foot">
      ${t("guide.foot")}
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

/** FK id-list cell: each id → related detail; · all / +N → related list filtered. */
function appendFkIdListLinks(
  td: HTMLElement,
  opts: {
    table: string;
    field: string;
    ids: Array<string | number>;
    titleParts: string[];
    /** Single id → open related detail */
    onOpenDetail?: (info: {
      table: string;
      id: string | number;
      field: string;
    }) => void;
    /** · all / +N → open related list filtered by all ids */
    onOpenList?: (info: {
      table: string;
      ids: Array<string | number>;
      field?: string;
    }) => void;
  },
): void {
  td.classList.add("fk-idlist-cell");
  const field = opts.field.trim() || "id";
  const maxShow = 8;
  const shown = opts.ids.slice(0, maxShow);
  const rest = opts.ids.length - shown.length;

  for (let i = 0; i < shown.length; i++) {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "fk-idlist-sep";
      sep.textContent = ", ";
      td.appendChild(sep);
    }
    const id = shown[i]!;
    const a = document.createElement("button");
    a.type = "button";
    a.className = "fk-link";
    a.textContent = String(id);
    a.title = [
      ...opts.titleParts,
      `${opts.table}.${field}=${id}`,
      "Click to view details",
    ]
      .filter(Boolean)
      .join("\n");
    a.onclick = (e) => {
      e.stopPropagation();
      opts.onOpenDetail?.({ table: opts.table, id, field });
    };
    td.appendChild(a);
  }

  if (rest > 0) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "fk-link fk-idlist-more";
    more.textContent = ` +${rest}`;
    more.title = [
      ...opts.titleParts,
      `Open ${opts.table} list filtered by all ${opts.ids.length} ids`,
    ]
      .filter(Boolean)
      .join("\n");
    more.onclick = (e) => {
      e.stopPropagation();
      opts.onOpenList?.({ table: opts.table, ids: opts.ids, field });
    };
    td.appendChild(more);
  } else if (opts.ids.length > 1 && opts.onOpenList) {
    const all = document.createElement("button");
    all.type = "button";
    all.className = "fk-link fk-idlist-all";
    all.textContent = t("result.allLink");
    all.title = `Open ${opts.table} list filtered by id ∈ [${opts.ids.join(", ")}]`;
    all.onclick = (e) => {
      e.stopPropagation();
      opts.onOpenList?.({ table: opts.table, ids: opts.ids, field });
    };
    td.appendChild(all);
  }
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
    /** List → detail/create: parent updates independent page title (not bare table name). */
    onOpenDetail?: (info: {
      table: string;
      id?: string | number | null;
      create?: boolean;
    }) => void;
    /**
     * FK id-list cell/chip click → open related table list filtered by id(s).
     * e.g. praiseUserIdList [12,34] → User List with id IN / eq filter.
     */
    onOpenFkList?: (info: {
      table: string;
      ids: Array<string | number>;
      field?: string;
    }) => void;
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
    /**
     * Detail/create Relate Table·Field changed — sync columnMetas / fkExpand
     * (same store as Table DDL Target/Relate). Do not remount detail.
     */
    onRelateSync?: (payload: RelateSyncPayload) => void;
    /** Current saved-page title (detail/create header input). */
    pageTitle?: string;
    /** Restore multi-table slots on detail/create. */
    detailSlots?: DetailTableSlot[] | null;
    onPageTitleChange?: (title: string) => void;
    onDetailSlotsChange?: (slots: DetailTableSlot[]) => void;
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
  const apijsonBase = (opts.apijsonBaseUrl || APIJSON_BROWSER_BASE).replace(
    /\/+$/,
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
        columnMetas: metas,
        fkExpand: opts.fkExpand ?? null,
        apijsonBase,
        mode: write ? "edit" : "view",
        pageTitle: opts.pageTitle,
        initialSlots: opts.detailSlots,
        onBack: opts.onBackToList,
        onWrite: write,
        onRelateSync: opts.onRelateSync,
        onColumnMetasChange: opts.onColumnMetasChange,
        onPageTitleChange: opts.onPageTitleChange,
        onDetailSlotsChange: opts.onDetailSlotsChange,
        onOpenFkList: opts.onOpenFkList,
      });
      return state;
    }
    const detailRow = detailTable
      ? expandDetailRowFields(parsed.rows[0], detailTable, comments)
      : parsed.rows[0];
    renderDetailForm(container, detailRow, {
      comments,
      columnMetas: opts.columnMetas ?? null,
      fkExpand: opts.fkExpand ?? null,
      mode: write ? "edit" : "view",
      apijsonBase,
      pageTitle: opts.pageTitle,
      initialSlots: opts.detailSlots,
      onRelateSync: opts.onRelateSync,
      onColumnMetasChange: opts.onColumnMetasChange,
      onPageTitleChange: opts.onPageTitleChange,
      onDetailSlotsChange: opts.onDetailSlotsChange,
      onOpenFkList: opts.onOpenFkList,
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
      listCreateAction = () => {
        opts.onOpenDetail?.({ table: primaryTable, create: true });
        openCreateForm(container, {
          table: primaryTable,
          columns: parsed.columns,
          comments,
          columnMetas: opts.columnMetas ?? null,
          fkExpand: opts.fkExpand ?? null,
          apijsonBase,
          initialValues: opts.createInitialValues ?? undefined,
          initialSlots: opts.detailSlots ?? undefined,
          pageTitle: pageTitleForTable(primaryTable, "create"),
          onRelateSync: opts.onRelateSync,
          onColumnMetasChange: opts.onColumnMetasChange,
          onPageTitleChange: opts.onPageTitleChange,
          onDetailSlotsChange: opts.onDetailSlotsChange,
          onBack: () => {
            opts.onBackToList?.();
            renderResultView(container, opts);
          },
          onSubmit: write,
        });
      };
    }
    if (opts.response == null) {
      mountWorkspaceGuide(container);
    } else {
      const empty = document.createElement("div");
      empty.className = "result-empty";
      empty.textContent = t("result.noMatching");
      container.appendChild(empty);
    }
    return state;
  }

  // Table | Grid | Charts (configured combo) | specific type (that type only)
  const viewTabs = document.createElement("div");
  viewTabs.className = "display-tabs";
  for (const [kind, label] of [
    ["table", "Table"],
    ["grid", "Grid"],
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
      b.title = t("result.chartsTitle");
    } else if (kind === "grid") {
      b.title = t("result.gridTitle");
    } else if (kind !== "table") {
      b.title = `Show ${label} only`;
    }
    b.onclick = () => opts.onDisplayKindChange?.(kind);
    viewTabs.appendChild(b);
  }
  if (displayKind === "table") {
    const modeToggle = document.createElement("button");
    modeToggle.type = "button";
    modeToggle.className =
      "detail-raw-toggle" + (tableValueRawMode ? " is-raw" : "");
    modeToggle.textContent = tableValueRawMode ? t("result.smart") : t("result.raw");
    modeToggle.title = t("result.smartToggle");
    modeToggle.onclick = () => {
      tableValueRawMode = !tableValueRawMode;
      renderResultView(container, opts);
    };
    viewTabs.appendChild(modeToggle);
  }
  container.appendChild(viewTabs);

  const isCombined = displayKind === "combined";
  const isChartOnly =
    displayKind !== "table" &&
    displayKind !== "grid" &&
    displayKind !== "combined";

  const tablesInView = [
    ...new Set(
      parsed.columns
        .map((c) => c.split(".")[0]!)
        .filter((t) => /^[A-Z]/.test(t)),
    ),
  ];

  const registerCreate = () => {
    if (!primaryTable || !write) return;
    listCreateAction = () => {
      opts.onOpenDetail?.({ table: primaryTable, create: true });
      openCreateForm(container, {
        table: primaryTable,
        columns: parsed.columns,
        comments,
        columnMetas: metas,
        fkExpand: opts.fkExpand ?? null,
        apijsonBase,
        initialValues: opts.createInitialValues ?? undefined,
        initialSlots: opts.detailSlots ?? undefined,
        pageTitle: pageTitleForTable(primaryTable, "create"),
        onRelateSync: opts.onRelateSync,
        onColumnMetasChange: opts.onColumnMetasChange,
        onPageTitleChange: opts.onPageTitleChange,
        onDetailSlotsChange: opts.onDetailSlotsChange,
        onBack: () => {
          for (const el of Array.from(
            container.querySelectorAll(LIST_HIDE_SEL),
          )) {
            el.classList.remove("hidden");
          }
          container
            .querySelector("#result-detail-host")
            ?.classList.add("hidden");
          opts.onBackToList?.();
        },
        onSubmit: write,
      });
    };
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
      const unused = queryFieldChoices.filter((c) => !used.has(c));
      return pickPreferredGroupBy(unused) || null;
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
      pickPreferredGroupBy(queryFieldChoices) ||
      pick?.labelPath ||
      labelChoices[0] ||
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
    addDimBtn.textContent = t("result.addDimension");
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
      valueSel.title = t("result.valueSelTitle");

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
      customInp.placeholder = t("result.customAggPlaceholder");
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
      cb.title = t("result.seriesCbTitle");
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
        enCb.title = t("result.showChart");
        enCb.onchange = () => {
          dim.enabled = enCb.checked;
          emitConfig();
        };
        enLab.append(enCb);
        head.appendChild(enLab);

        const kindSel = document.createElement("select");
        kindSel.className = "chart-dim-kind";
        kindSel.title = t("result.chartType");
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
      nameInput.title = t("result.dimName");
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
      groupLab.title = t("result.groupLabTitle");
      const groupPrefix = document.createElement("span");
      groupPrefix.textContent = t("result.groupBy");
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
        rm.title = t("result.removeChart");
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
      picker.title = t("result.pickerTitle");
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

  if (displayKind === "table" || displayKind === "grid") {
  const listWrap = document.createElement("div");
  listWrap.className = displayKind === "grid" ? "grid-wrap" : "table-wrap";
  listWrap.id =
    displayKind === "grid" ? "result-grid-wrap" : "result-table-wrap";

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
      primaryTable && write && displayKind === "table"
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
  listWrap.appendChild(statusBar);

  const activeFilters = filters.filter((f) =>
    f.conditions.some((c) => c.value.trim()),
  );
  if (activeFilters.length > 0) {
    listWrap.appendChild(
      buildCombineExprBar({
        value: opts.filterCombineExpr ?? "",
        filters: activeFilters,
        onApply: opts.onCombineExprChange,
      }),
    );
  }

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
    if (table) {
      const detailId =
        typeof id === "string" || typeof id === "number" ? id : String(id ?? "");
      opts.onOpenDetail?.({ table, id: detailId });
    }
    // Never reuse list title ("Moment List") on the detail header
    const detailPageTitle = table
      ? pageTitleForTable(table, "detail", id as string | number)
      : opts.pageTitle;
    if (apijsonBase && table && id != null && String(id) !== "") {
      void openFkDetail(container, {
        table,
        id: id as string | number,
        comments,
        columnMetas: metas,
        apijsonBase,
        mode,
        pageTitle: detailPageTitle,
        initialSlots: opts.detailSlots,
        onBack: opts.onBackToList,
        onWrite: write,
        onRelateSync: opts.onRelateSync,
        onColumnMetasChange: opts.onColumnMetasChange,
        onPageTitleChange: opts.onPageTitleChange,
        onDetailSlotsChange: opts.onDetailSlotsChange,
        onOpenFkList: opts.onOpenFkList,
        fkExpand: opts.fkExpand,
      });
      return;
    }
    showDetail(container, state, key, comments, {
      mode,
      columnMetas: metas,
      apijsonBase,
      onBack: opts.onBackToList,
      onColumnMetasChange: opts.onColumnMetasChange,
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

  if (displayKind === "grid") {
    const grid = document.createElement("div");
    grid.className = "result-grid";
    const captionCols = visibleCols.length ? visibleCols : parsed.columns;
    for (const row of parsed.rows) {
      const fieldPool = [
        ...new Set([
          ...captionCols,
          ...parsed.columns,
          ...Object.keys(row.cells),
        ]),
      ];
      const card = document.createElement("button");
      card.type = "button";
      card.className = "result-grid-card";
      card.dataset.key = row.key;
      card.title = write
        ? "Click to edit details (full fields)"
        : "Click to view details (full fields)";

      const thumb = document.createElement("div");
      thumb.className = "result-grid-thumb";
      const imageUrl = pickBestImageUrl(
        row.cells,
        primaryTable,
        fieldPool,
        comments,
        showMapFromMetas(metas),
      );
      if (imageUrl) {
        const img = document.createElement("img");
        img.src = resolveImageSrc(imageUrl, apijsonBase);
        img.alt = "";
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        img.draggable = false;
        img.onerror = () => {
          thumb.classList.add("is-empty");
          img.replaceWith(document.createTextNode("Broken"));
        };
        thumb.appendChild(img);
      } else {
        thumb.classList.add("is-empty");
        thumb.textContent = t("result.noImage");
      }

      const caption = document.createElement("div");
      caption.className = "result-grid-caption";
      const full = pickGridCaption(
        row.cells,
        primaryTable,
        fieldPool,
        comments,
      );
      caption.textContent = truncate(full, 20) || `#${row.key}`;
      caption.title = full || `#${row.key}`;

      card.append(thumb, caption);
      card.onclick = () => openRowDetail(row.key, write ? "edit" : "view");
      grid.appendChild(card);
    }
    if (!parsed.rows.length) {
      const empty = document.createElement("div");
      empty.className = "result-grid-empty muted";
      empty.textContent = t("result.noRows");
      grid.appendChild(empty);
    }
    listWrap.appendChild(grid);
    container.appendChild(listWrap);
  } else {

  const table = document.createElement("table");
  table.className = "data-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.id = "result-head-row";

  const thCheck = document.createElement("th");
  thCheck.className = "col-check";
  const checkAll = document.createElement("input");
  checkAll.type = "checkbox";
  checkAll.title = t("result.selectAllPage");
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
  settingsBtn.title = t("result.columnSettings");
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
  thAction.textContent = t("common.actions");
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
      const titleParts = [tip, typeTip && `Type: ${typeTip}`].filter(Boolean);
      const useSmart = !tableValueRawMode;
      const fkIdListTable = useSmart
        ? (() => {
            const auto = resolveFkIdListTable(col, comments);
            if (!auto) return null;
            const override = metas[col]?.onTable?.trim();
            return override || auto;
          })()
        : null;
      const fkIdListIds = fkIdListTable ? parseIdList(rawVal) : [];
      const fk =
        !fkIdListTable
          ? cellFkJumpMeta(
              col,
              rawVal,
              row.cells,
              comments,
              primaryTable,
              metas[col],
            )
          : null;

      if (useSmart) {
        const show = columnShowOf(col, metas);
        if (show === "file") {
          const fileUrl = collectFileUrl(rawVal);
          if (fileUrl) {
            appendTableFileCell(td, fileUrl, apijsonBase, [
              ...titleParts,
              `Value: ${text}`,
            ]
              .filter(Boolean)
              .join("\n"));
            tr.appendChild(td);
            continue;
          }
        }
        const smartImg = resolveSmartImageField(col, rawVal, comments, show);
        if (smartImg.kind !== "none" && smartImg.urls.length) {
          appendTableImageCell(td, smartImg.urls, apijsonBase, [
            ...titleParts,
            `Value: ${text}`,
            "Click image to preview",
          ]
            .filter(Boolean)
            .join("\n"));
          tr.appendChild(td);
          continue;
        }
        if (isGenderField(col)) {
          const label = genderLabel(rawVal);
          td.textContent = label;
          td.classList.add("table-smart-text");
          td.title = [...titleParts, `raw: ${text}`].filter(Boolean).join("\n");
          tr.appendChild(td);
          continue;
        }
      }

      if (fkIdListTable && fkIdListIds.length) {
        appendFkIdListLinks(td, {
          table: fkIdListTable,
          field: metas[col]?.onField?.trim() || "id",
          ids: fkIdListIds,
          titleParts,
          onOpenDetail: ({ table, id, field }) => {
            void openFkDetail(container, {
              table,
              id,
              field,
              comments,
              columnMetas: metas,
              apijsonBase,
              mode: write ? "edit" : "view",
              onBack: opts.onBackToList,
              onWrite: write,
              onRelateSync: opts.onRelateSync,
              onColumnMetasChange: opts.onColumnMetasChange,
              onPageTitleChange: opts.onPageTitleChange,
              onDetailSlotsChange: opts.onDetailSlotsChange,
              onOpenFkList: opts.onOpenFkList,
              fkExpand: opts.fkExpand,
            });
          },
          onOpenList: opts.onOpenFkList,
        });
      } else if (fk) {
        const a = document.createElement("button");
        a.type = "button";
        a.className = "fk-link";
        // Prefer real joined field (User.name…); never invent "User#id"
        const shown = fk.label || text;
        a.textContent = truncate(shown, 48);
        const mapField = (FK_DISPLAY_FIELDS[fk.table] ?? ["name"])[0];
        const isJoinedCol = col.startsWith(`${fk.table}.`);
        a.title = [
          ...titleParts,
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
            field: fk.field,
            comments,
            columnMetas: metas,
            apijsonBase,
            mode: write ? "edit" : "view",
            onBack: opts.onBackToList,
            onWrite: write,
            onRelateSync: opts.onRelateSync,
            onColumnMetasChange: opts.onColumnMetasChange,
            onPageTitleChange: opts.onPageTitleChange,
            onDetailSlotsChange: opts.onDetailSlotsChange,
            onOpenFkList: opts.onOpenFkList,
            fkExpand: opts.fkExpand,
          });
        };
        td.appendChild(a);
      } else {
        td.textContent = truncate(text, 48);
        td.title = [...titleParts, `Value: ${text}`]
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
    editBtn.textContent = t("common.edit");
    editBtn.title = t("result.editRecord");
    editBtn.onclick = (e) => {
      e.stopPropagation();
      openRowDetail(row.key, "edit");
    };
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "linkish danger-link";
    delBtn.textContent = t("common.delete");
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
  listWrap.appendChild(table);
  container.appendChild(listWrap);
  }
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

/** All APIJSON-supported filter ops (fixed list); default selection is smart. */
function allFilterOpOptions(): Array<{ value: FilterOp; label: string }> {
  return ALL_FILTER_OPS.map((value) => ({
    value,
    label: FILTER_OP_LABELS[value],
  }));
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

/** File link in a table cell (DDL Show = File). */
function appendTableFileCell(
  td: HTMLTableCellElement,
  url: string,
  apijsonBase: string,
  title: string,
): void {
  td.classList.add("table-cell-file");
  td.title = title;
  const href = resolveImageSrc(url, apijsonBase);
  const a = document.createElement("a");
  a.className = "table-file-link";
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  const name = href.split("/").pop()?.split("?")[0] || href;
  a.textContent = truncate(decodeURIComponent(name), 28);
  a.onclick = (e) => e.stopPropagation();
  td.appendChild(a);
}

/** Compact image thumbs in a table cell; click opens lightbox. */
function appendTableImageCell(
  td: HTMLTableCellElement,
  urls: string[],
  apijsonBase: string,
  title: string,
): void {
  td.classList.add("table-cell-images");
  td.title = title;
  const wrap = document.createElement("div");
  wrap.className = "table-img-stack";
  const resolved = urls.map((u) => resolveImageSrc(u, apijsonBase));
  const shown = resolved.slice(0, 3);
  shown.forEach((src, i) => {
    const img = document.createElement("img");
    img.className = "table-cell-img";
    img.src = src;
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.draggable = false;
    img.onerror = () => {
      img.classList.add("is-broken");
      img.replaceWith(document.createTextNode("!"));
    };
    img.onclick = (e) => {
      e.stopPropagation();
      openImageLightbox(() => resolved, i);
    };
    wrap.appendChild(img);
  });
  if (resolved.length > 3) {
    const more = document.createElement("span");
    more.className = "table-img-more";
    more.textContent = `+${resolved.length - 3}`;
    more.title = `${resolved.length} images`;
    more.onclick = (e) => {
      e.stopPropagation();
      openImageLightbox(() => resolved, 3);
    };
    wrap.appendChild(more);
  }
  td.appendChild(wrap);
}

const GRID_CAPTION_COLS = [
  "name",
  "title",
  "content",
  "description",
  "tag",
  "remark",
  "note",
  "text",
  "message",
];

/** Name / description-like text for grid caption (caller truncates). */
function pickGridCaption(
  cells: Record<string, unknown>,
  primaryTable: string | null,
  columns: string[],
  comments?: SchemaComments | null,
): string {
  const rank = (path: string): number => {
    if (fieldSuggestsImage(path, comments) || fieldSuggestsImageList(path, comments)) {
      return -1;
    }
    const col = (path.includes(".") ? path.split(".").pop()! : path).toLowerCase();
    if (isIdLikeColumn(path)) return -1;
    const preferred = primaryTable
      ? [
          ...(FK_DISPLAY_FIELDS[primaryTable] ?? []),
          ...GRID_CAPTION_COLS,
        ]
      : GRID_CAPTION_COLS;
    const idx = preferred.findIndex((f) => f.toLowerCase() === col);
    let score = idx >= 0 ? 100 - idx : 0;
    if (primaryTable && path.startsWith(`${primaryTable}.`)) score += 10;
    return score;
  };

  let best: { text: string; score: number } | null = null;
  for (const path of columns) {
    const score = rank(path);
    if (score < 0) continue;
    const text = formatCell(cells[path], "text").trim();
    if (!text) continue;
    if (!best || score > best.score) best = { text, score };
  }
  if (best) return best.text;
  for (const path of columns) {
    if (isIdLikeColumn(path)) continue;
    const text = formatCell(cells[path], "text").trim();
    if (text) return text;
  }
  return "";
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
  prev.title = t("common.previous");
  prev.setAttribute("aria-label", "Previous");
  const next = document.createElement("button");
  next.type = "button";
  next.className = "detail-lightbox-nav detail-lightbox-nav-next";
  next.textContent = ">";
  next.title = t("common.next");
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
    comments?: SchemaComments | null;
    show?: ImageShowMode;
    /** APIJSON host for POST /upload (required when editable). */
    apijsonBase?: string;
    registerInput?: (
      el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    ) => void;
  },
): void {
  const uploadBase = (opts.apijsonBase || "").replace(/\/+$/, "");
  const mode = opts.mode ?? "list";
  const comments = opts.comments ?? null;
  const smartImg = resolveSmartImageField(
    opts.path,
    opts.value,
    comments,
    opts.show ?? "auto",
  );
  let urls: string[] =
    mode === "single"
      ? smartImg.urls.slice(0, 1)
      : smartImg.urls.length
        ? [...smartImg.urls]
        : // Preserve non-empty array entries even when not URL-like yet
          (parseArrayValue(opts.value) ?? [])
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
  pagePrev.title = t("common.previousPage");
  pagePrev.setAttribute("aria-label", "Previous page");
  const pageNext = document.createElement("button");
  pageNext.type = "button";
  pageNext.className = "detail-image-page-btn detail-image-page-next";
  pageNext.textContent = ">";
  pageNext.title = t("common.nextPage");
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
        mid.title = t("result.clickEnlarge");
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
          replaceBtn.title = t("result.replaceDevice");
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
          rm.title = t("common.remove");
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
  const ops = allFilterOpOptions();
  const defaultOp = defaultFilterOp(fieldType, path);
  const rangeType = isRangeFieldType(fieldType);
  let draft: FilterCondition[] = existing?.conditions.length
    ? existing.conditions.map((c) => ({
        ...c,
        op: normalizeFilterOp(c.op),
      }))
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
        first.textContent = t("common.when");
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
      const valInput = document.createElement("input");
      valInput.className = "filter-val";
      valInput.type = inputTypeForField(fieldType);
      if (fieldType === "percent") valInput.step = "0.01";
      valInput.value = displayTimeValue(fieldType, cond.value);
      const syncPlaceholder = () => {
        if (cond.op === "in") valInput.placeholder = "a, b, c";
        else if (cond.op === "regexp") valInput.placeholder = "^pattern$";
        else if (cond.op === "contains" && fieldType === "json") {
          valInput.placeholder = "json_contains value";
        } else if (cond.op === "contains") valInput.placeholder = "%…%";
        else if (fieldType === "percent") valInput.placeholder = "0-100";
        else valInput.placeholder = "Value";
      };
      syncPlaceholder();
      opSel.onchange = () => {
        cond.op = opSel.value as FilterOp;
        syncPlaceholder();
      };
      row.appendChild(opSel);
      valInput.oninput = () => {
        cond.value = valInput.value;
      };
      row.appendChild(valInput);

      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "filter-cond-rm";
      rm.title = t("result.removeCondition");
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
  addBtn.textContent = t("result.addCondition");
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
  applyBtn.textContent = t("common.apply");
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
  clearBtn.textContent = t("common.clear");
  clearBtn.onclick = () => {
    onApply?.(null, path);
    pop.remove();
  };
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = t("common.cancel");
  cancelBtn.onclick = () => pop.remove();
  actions.append(applyBtn, clearBtn, cancelBtn);
  pop.appendChild(actions);

  document.body.appendChild(pop);
  placeFloatingPopover(pop, anchor);

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
  title.textContent = t("result.columnProps");
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
  saveBtn.textContent = t("common.apply");
  saveBtn.onclick = () => {
    onSave(draft);
    pop.remove();
  };
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = t("common.cancel");
  cancelBtn.onclick = () => pop.remove();
  actions.append(saveBtn, cancelBtn);
  pop.appendChild(actions);

  document.body.appendChild(pop);
  placeFloatingPopover(pop, anchor);

  const closer = (ev: MouseEvent) => {
    if (!pop.contains(ev.target as Node) && ev.target !== anchor) {
      pop.remove();
      document.removeEventListener("mousedown", closer);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", closer), 0);
}

export type WritePayload = {
  method: "put" | "post" | "delete" | "crud";
  body: Record<string, unknown>;
  table: string;
  /** Request.structure fragments (UPDATE field@) for multi-table Apply */
  structure?: Record<string, unknown>;
};

export type { CrudOp, DetailTableSlot, RelateSyncPayload } from "./detail-crud.js";

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
  // Single-record GET/POST: { User: { id } } / { Moment: {…} } (no [])
  if (bodyTemplate && isPlainObject(bodyTemplate)) {
    const top = Object.keys(bodyTemplate).filter(
      (k) => /^[A-Z]/.test(k) && isPlainObject(bodyTemplate[k]),
    );
    if (top.length === 1) return top[0]!;
    for (const t of ["Moment", "Comment", "User"]) {
      if (top.includes(t)) return t;
    }
    if (top[0]) return top[0]!;
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
  "#result-table-wrap, #result-grid-wrap, .display-tabs, #result-chart-host, .table-status, .filter-combine-bar";

function buildCombineExprBar(opts: {
  value: string;
  filters: ColumnFilter[];
  onApply?: (expr: string) => void;
}): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "filter-combine-bar";

  const label = document.createElement("label");
  label.className = "filter-combine-label";
  label.textContent = t("result.conditionCombine");
  label.title =
    "Combine fields with AND/OR/NOT, e.g. date & (name | tag) or !date & content";
  bar.appendChild(label);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "filter-combine-input";
  input.spellcheck = false;
  input.placeholder = t("result.combinePlaceholder");
  input.value = opts.value;
  input.title = t("result.combineTitle");
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
  btn.textContent = t("common.apply");
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
    delBtn.textContent = t("common.delete");
    delBtn.onclick = () => {
      if (confirm(`Delete selected ${opts.primaryTable} records?`)) {
        opts.onBatchDelete?.();
      }
    };
    bar.appendChild(delBtn);
  }

  // Query tables: selected chips, then [+] add
  const tablesWrap = document.createElement("div");
  tablesWrap.className = "query-tables";

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

  if (opts.onAddQueryTable) {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "table-chip table-chip-add";
    addBtn.textContent = "+";
    addBtn.title = t("result.addTable");
    addBtn.onclick = (e) => {
      e.stopPropagation();
      openAddTablePopover(addBtn, opts.tables, opts.onAddQueryTable!, opts.comments);
    };
    tablesWrap.appendChild(addBtn);
  }

  bar.appendChild(tablesWrap);
  return bar;
}

const ADD_TABLE_PAGE_SIZE = 8;

type AddTableSort =
  | "name+"
  | "name-"
  | "comment+"
  | "comment-";

/**
 * Position a body-level popover so it stays on screen.
 * Prefer below the anchor; flip above when the bottom would be clipped.
 * Uses position:fixed + viewport coords; caps max-height for scrolling.
 */
function placeFloatingPopover(
  pop: HTMLElement,
  anchor: HTMLElement,
  opts?: { gap?: number; margin?: number },
) {
  const gap = opts?.gap ?? 6;
  const margin = opts?.margin ?? 8;
  pop.style.position = "fixed";
  pop.style.zIndex = "var(--z-float)";

  const place = () => {
    if (!document.body.contains(pop)) return;
    const rect = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const popW = Math.min(
      pop.offsetWidth || 520,
      vw - margin * 2,
    );
    pop.style.width = `${popW}px`;
    pop.style.maxWidth = `${vw - margin * 2}px`;

    // Provisional height: allow measuring, then cap to viewport
    pop.style.maxHeight = `${Math.max(160, vh - margin * 2)}px`;
    const popH = pop.offsetHeight || 280;

    const spaceBelow = vh - rect.bottom - gap - margin;
    const spaceAbove = rect.top - gap - margin;
    const preferBelow = spaceBelow >= Math.min(popH, 200) || spaceBelow >= spaceAbove;

    let top: number;
    let maxH: number;
    if (preferBelow) {
      top = rect.bottom + gap;
      maxH = Math.max(120, vh - top - margin);
    } else {
      maxH = Math.max(120, spaceAbove);
      top = Math.max(margin, rect.top - gap - Math.min(popH, maxH));
      // Recompute after flip so the box sits fully above the anchor
      const h = Math.min(popH, maxH);
      top = Math.max(margin, rect.top - gap - h);
    }
    pop.style.top = `${top}px`;
    pop.style.maxHeight = `${maxH}px`;
    // Nested scroll regions (add-table-body) keep overflow; otherwise scroll the pop
    if (!pop.classList.contains("add-table-popover")) {
      pop.style.overflow = "auto";
    } else {
      pop.style.overflow = "hidden";
    }

    let left = rect.left;
    if (left + popW > vw - margin) left = vw - margin - popW;
    if (left < margin) left = margin;
    pop.style.left = `${left}px`;
    pop.style.right = "auto";
    pop.style.bottom = "auto";
  };

  place();
  // Content may grow (async table list) — re-place next frames
  requestAnimationFrame(place);
  return place;
}

type TablePickPopoverOpts = {
  title?: string;
  /** Hide these tables (e.g. already in the Join query). */
  exclude?: string[];
  /** Highlight current choice; still listed unless excluded. */
  selected?: string;
  /** Show a clear/none row at the top. */
  allowEmpty?: boolean;
  emptyLabel?: string;
  comments?: SchemaComments | null;
  /** Extra candidates merged into catalog (must pass isBusinessTable). */
  extra?: string[];
  onPick: (table: string) => void;
};

/**
 * Shared table picker: filter + sort + page.
 * Used by list Join (+), detail table / Relate, and DDL Relate Table.
 */
function openTablePickPopover(
  anchor: HTMLElement,
  opts: TablePickPopoverOpts,
) {
  document.getElementById("add-table-popover")?.remove();
  const pop = document.createElement("div");
  pop.id = "add-table-popover";
  pop.className = "filter-popover add-table-popover";

  const title = document.createElement("div");
  title.className = "filter-popover-title";
  title.textContent = opts.title || "Choose table";
  pop.appendChild(title);

  const toolbar = document.createElement("div");
  toolbar.className = "add-table-toolbar";
  const search = document.createElement("input");
  search.type = "search";
  search.className = "add-table-search";
  search.placeholder = t("result.filterTables");
  search.setAttribute("aria-label", "Filter tables");
  const sortSel = document.createElement("select");
  sortSel.className = "add-table-sort";
  sortSel.setAttribute("aria-label", "Sort tables");
  for (const opt of [
    { value: "name+" as const, label: "Name A–Z" },
    { value: "name-" as const, label: "Name Z–A" },
    { value: "comment+" as const, label: "Comment A–Z" },
    { value: "comment-" as const, label: "Comment Z–A" },
  ]) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    sortSel.appendChild(o);
  }
  toolbar.append(search, sortSel);
  pop.appendChild(toolbar);

  const body = document.createElement("div");
  body.className = "add-table-body";
  const loading = document.createElement("div");
  loading.className = "muted";
  loading.textContent = t("result.loadingTables");
  body.appendChild(loading);
  pop.appendChild(body);

  const pager = document.createElement("div");
  pager.className = "add-table-pager";
  pager.hidden = true;
  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "add-table-pager-btn";
  prevBtn.textContent = t("common.prev");
  const pageMeta = document.createElement("span");
  pageMeta.className = "add-table-pager-meta muted";
  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "add-table-pager-btn";
  nextBtn.textContent = t("common.next");
  pager.append(prevBtn, pageMeta, nextBtn);
  pop.appendChild(pager);

  document.body.appendChild(pop);
  const reposition = placeFloatingPopover(pop, anchor);
  const onWin = () => reposition();
  window.addEventListener("resize", onWin);
  window.addEventListener("scroll", onWin, true);
  const teardown = () => {
    pop.remove();
    document.removeEventListener("mousedown", closer);
    window.removeEventListener("resize", onWin);
    window.removeEventListener("scroll", onWin, true);
  };
  const closer = (ev: MouseEvent) => {
    if (!pop.contains(ev.target as Node) && ev.target !== anchor) {
      teardown();
    }
  };
  setTimeout(() => document.addEventListener("mousedown", closer), 0);

  const choose = (table: string) => {
    opts.onPick(table);
    teardown();
  };

  void (async () => {
    const base =
      loadSettings().apijsonBaseUrl?.replace(/\/+$/, "") || APIJSON_BROWSER_BASE;
    await ensureAccessRoles(base);
    if (!document.body.contains(pop)) return;

    const exclude = new Set(opts.exclude ?? []);
    const available = [
      ...new Set([
        ...catalogTables(),
        ...(opts.extra ?? []).filter(isBusinessTable),
        ...(opts.selected && isBusinessTable(opts.selected)
          ? [opts.selected]
          : []),
      ]),
    ].filter((t) => !exclude.has(t));

    if (!available.length && !opts.allowEmpty) {
      body.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = t("result.noTables");
      body.appendChild(empty);
      toolbar.hidden = true;
      return;
    }

    const seedComments = opts.comments ?? null;
    let tableComments: Record<string, string> = {
      ...(seedComments?.tables ?? {}),
    };
    const missing = available.filter((t) => !(t in tableComments));
    if (missing.length) {
      try {
        const data = (await fetch(
          `/api/schema-comments?tables=${encodeURIComponent(missing.join(","))}`,
        ).then((r) => r.json())) as SchemaComments;
        tableComments = { ...tableComments, ...(data.tables ?? {}) };
        (
          window as unknown as {
            __a2apiSetComments?: (c: SchemaComments) => void;
          }
        ).__a2apiSetComments?.({
          tables: {
            ...(seedComments?.tables ?? {}),
            ...(data.tables ?? {}),
          },
          columns: {
            ...(seedComments?.columns ?? {}),
            ...(data.columns ?? {}),
          },
          types: { ...(seedComments?.types ?? {}), ...(data.types ?? {}) },
        });
      } catch {
        /* keep what we have */
      }
    }
    if (!document.body.contains(pop)) return;

    let page = 0;
    const paint = (): void => {
      const q = search.value.trim().toLowerCase();
      const sort = sortSel.value as AddTableSort;
      let rows = available.map((name) => ({
        name,
        comment: tableComments[name] || "",
      }));
      if (q) {
        rows = rows.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.comment.toLowerCase().includes(q),
        );
      }
      rows.sort((a, b) => {
        const byName = a.name.localeCompare(b.name);
        const byComment = (a.comment || "\uffff").localeCompare(
          b.comment || "\uffff",
        );
        switch (sort) {
          case "name-":
            return -byName;
          case "comment+":
            return byComment || byName;
          case "comment-":
            return -byComment || byName;
          default:
            return byName;
        }
      });

      const total = rows.length;
      const pageCount = Math.max(1, Math.ceil(total / ADD_TABLE_PAGE_SIZE));
      if (page >= pageCount) page = pageCount - 1;
      if (page < 0) page = 0;
      const slice = rows.slice(
        page * ADD_TABLE_PAGE_SIZE,
        (page + 1) * ADD_TABLE_PAGE_SIZE,
      );

      body.replaceChildren();
      if (opts.allowEmpty && page === 0 && !q) {
        const none = document.createElement("button");
        none.type = "button";
        none.className =
          "add-table-item" + (!opts.selected ? " is-selected" : "");
        none.textContent = opts.emptyLabel || "— None —";
        none.onclick = () => choose("");
        body.appendChild(none);
      }
      if (!total) {
        const empty = document.createElement("div");
        empty.className = "muted";
        empty.textContent = q ? "No tables match" : "No tables available";
        body.appendChild(empty);
      } else {
        for (const r of slice) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className =
            "add-table-item" +
            (r.name === opts.selected ? " is-selected" : "");
          const label = r.comment ? `${r.name}: ${r.comment}` : `${r.name}: —`;
          btn.textContent = label;
          btn.title = label;
          btn.onclick = () => choose(r.name);
          body.appendChild(btn);
        }
      }

      const showPager = total > ADD_TABLE_PAGE_SIZE;
      pager.hidden = !showPager;
      if (showPager) {
        pageMeta.textContent = `${page + 1} / ${pageCount} · ${total}`;
        prevBtn.disabled = page <= 0;
        nextBtn.disabled = page >= pageCount - 1;
      }
      reposition();
    };

    search.oninput = () => {
      page = 0;
      paint();
    };
    sortSel.onchange = () => {
      page = 0;
      paint();
    };
    prevBtn.onclick = () => {
      page -= 1;
      paint();
    };
    nextBtn.onclick = () => {
      page += 1;
      paint();
    };
    paint();
    search.focus();
  })();
}

/** List Join (+) — exclude tables already in the query. */
function openAddTablePopover(
  anchor: HTMLElement,
  current: string[],
  onAdd: (table: string) => void,
  seedComments?: SchemaComments | null,
) {
  openTablePickPopover(anchor, {
    title: "Add table to query",
    exclude: current,
    comments: seedComments,
    onPick: onAdd,
  });
}

/** Compact control that opens the shared table picker (looks like a select). */
function mountTablePickControl(opts: {
  value: string;
  placeholder?: string;
  className?: string;
  title?: string;
  ariaLabel?: string;
  exclude?: string[];
  allowEmpty?: boolean;
  emptyLabel?: string;
  comments?: SchemaComments | null;
  extra?: string[];
  pickTitle?: string;
  onPick: (table: string) => void;
}): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = opts.className || "table-pick-btn";
  btn.setAttribute("aria-label", opts.ariaLabel || "Table");
  btn.title = opts.title || "Choose table";
  const syncLabel = () => {
    btn.textContent = opts.value
      ? `${opts.value} ▾`
      : `${opts.placeholder || "Choose…"} ▾`;
  };
  syncLabel();
  btn.onclick = (e) => {
    e.stopPropagation();
    openTablePickPopover(btn, {
      title: opts.pickTitle || "Choose table",
      exclude: opts.exclude,
      selected: opts.value,
      allowEmpty: opts.allowEmpty,
      emptyLabel: opts.emptyLabel,
      comments: opts.comments,
      extra: opts.extra,
      onPick: (table) => {
        opts.value = table;
        syncLabel();
        opts.onPick(table);
      },
    });
  };
  return btn;
}

/**
 * Logical ↔ physical APIJSON Demo table names (Access.name vs alias).
 * Keep in sync with server schema-comments LOGICAL_TO_PHYSICAL.
 */
const TABLE_NAME_ALIASES: Record<string, string> = {
  User: "apijson_user",
  Privacy: "apijson_privacy",
  apijson_user: "User",
  apijson_privacy: "Privacy",
};

function tableNameAliases(table: string): string[] {
  const alt = TABLE_NAME_ALIASES[table];
  return alt ? [table, alt] : [table];
}

function collectTableColumns(
  table: string,
  columns: string[],
  comments: SchemaComments | null,
): string[] {
  const aliases = tableNameAliases(table);
  const cols: string[] = [];
  for (const t of aliases) {
    for (const c of columns) {
      if (!c.startsWith(`${t}.`)) continue;
      const col = c.slice(t.length + 1);
      if (col && !cols.includes(col)) cols.push(col);
    }
  }
  if (comments?.columns) {
    for (const key of Object.keys(comments.columns)) {
      for (const t of aliases) {
        if (!key.startsWith(`${t}.`)) continue;
        const col = key.slice(t.length + 1);
        if (col && !cols.includes(col)) cols.push(col);
      }
    }
  }
  // types map also lists every known column
  if (comments?.types) {
    for (const key of Object.keys(comments.types)) {
      for (const t of aliases) {
        if (!key.startsWith(`${t}.`)) continue;
        const col = key.slice(t.length + 1);
        if (col && !cols.includes(col)) cols.push(col);
      }
    }
  }
  for (const t of aliases) {
    for (const c of FK_OPTIONAL_COLUMNS[t] ?? []) {
      if (!cols.includes(c)) cols.push(c);
    }
    for (const c of DEFAULT_FK_COLUMNS[t] ?? []) {
      if (!cols.includes(c)) cols.push(c);
    }
  }
  if (!cols.includes("id")) cols.unshift("id");
  cols.sort((a, b) => {
    if (a === "id") return -1;
    if (b === "id") return 1;
    return a.localeCompare(b);
  });
  return cols;
}

function mergeSchemaComments(
  into: SchemaComments | null | undefined,
  from: SchemaComments | null | undefined,
): SchemaComments {
  return {
    tables: { ...(into?.tables ?? {}), ...(from?.tables ?? {}) },
    columns: { ...(into?.columns ?? {}), ...(from?.columns ?? {}) },
    types: { ...(into?.types ?? {}), ...(from?.types ?? {}) },
  };
}

/** True when schema already lists columns for this table (logical or physical). */
function hasTableSchema(
  table: string,
  comments: SchemaComments | null,
): boolean {
  if (!table || !comments) return false;
  return tableNameAliases(table).some((t) => {
    const prefix = `${t}.`;
    const keys = [
      ...Object.keys(comments.columns || {}),
      ...Object.keys(comments.types || {}),
    ];
    // Need more than a lone id — sparse partial loads still refetch
    const cols = keys
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
    return cols.length > 1 || (cols.length === 1 && cols[0] !== "id");
  });
}

/**
 * Fetch missing table/column comments so pickers & detail forms can show all fields.
 */
async function ensureTableSchemaComments(
  tables: string[],
  seed: SchemaComments | null,
): Promise<SchemaComments> {
  let next = mergeSchemaComments(seed, null);
  const missing = [...new Set(tables.filter(Boolean))].filter(
    (t) => !hasTableSchema(t, next),
  );
  if (!missing.length) return next;
  try {
    const data = (await fetch(
      `/api/schema-comments?tables=${encodeURIComponent(missing.join(","))}`,
    ).then((r) => r.json())) as SchemaComments;
    next = mergeSchemaComments(next, data);
    (
      window as unknown as {
        __a2apiSetComments?: (c: SchemaComments) => void;
      }
    ).__a2apiSetComments?.(next);
  } catch {
    /* keep seed */
  }
  return next;
}

function defaultColumnMeta(path: string): ColumnMeta {
  return {
    path,
    type: "text",
    visible: true,
    filterable: true,
    sortable: true,
  };
}

/** Detail/create: field shown unless ColumnMeta.visible === false. */
function isDetailFieldVisible(
  path: string,
  metas: Record<string, ColumnMeta> | null | undefined,
): boolean {
  if (!metas) return true;
  if (metas[path]?.visible === false) return false;
  // Honor alias key (Privacy.phone ↔ apijson_privacy.phone)
  const dot = path.indexOf(".");
  if (dot > 0) {
    const table = path.slice(0, dot);
    const col = path.slice(dot + 1);
    for (const t of tableNameAliases(table)) {
      if (t === table) continue;
      if (metas[`${t}.${col}`]?.visible === false) return false;
    }
  }
  return true;
}

/** Columns currently shown on the detail/create form for a table. */
function visibleDetailColumns(
  table: string,
  columns: string[],
  comments: SchemaComments | null,
  metas: Record<string, ColumnMeta> | null | undefined,
): string[] {
  return collectTableColumns(table, columns, comments).filter((col) =>
    isDetailFieldVisible(`${table}.${col}`, metas),
  );
}

/**
 * Apply list-style DDL to detail/create: selected → visible, rest of table → hidden.
 * Also merges Show / displayName / Relate patches.
 */
function applyDetailFormDdl(
  metas: Record<string, ColumnMeta>,
  payload: TableDdlApplyPayload,
  allCols: string[],
): Record<string, ColumnMeta> {
  const next = { ...metas };
  for (const [path, patch] of Object.entries(payload.fieldMetas)) {
    const prev = next[path];
    next[path] = {
      ...(prev ?? defaultColumnMeta(path)),
      ...patch,
      path,
    };
  }
  const selected = new Set(payload.selectedColumns);
  for (const col of allCols) {
    const path = `${payload.table}.${col}`;
    const prev = next[path];
    next[path] = {
      ...(prev ?? defaultColumnMeta(path)),
      path,
      visible: selected.has(col),
    };
  }
  return next;
}

function hideDetailField(
  metas: Record<string, ColumnMeta>,
  path: string,
): Record<string, ColumnMeta> {
  const prev = metas[path];
  return {
    ...metas,
    [path]: {
      ...(prev ?? defaultColumnMeta(path)),
      path,
      visible: false,
    },
  };
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
  // Primary with no @column → default: rich column set (User tag/head/…)
  // Prefer DEFAULT_FK_COLUMNS ∪ optional, excluding bare id.
  const preferred = [
    ...new Set([
      ...(DEFAULT_FK_COLUMNS[table] ?? []),
      ...(FK_OPTIONAL_COLUMNS[table] ?? ["name", "content"]),
    ]),
  ].filter((c) => c !== "id");
  return preferred.length ? preferred : ["name"];
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
    /**
     * Detail/create form: force which columns start checked (field show/hide).
     * When set, skips list @column / fkExpand selection.
     */
    selectionOverride?: string[] | null;
    /** list = query @column; form = detail/create field visibility */
    purpose?: "list" | "form";
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
  const isForm = opts.purpose === "form" || opts.selectionOverride != null;
  title.textContent = tableComment
    ? `${opts.table}${isPrimary ? " (primary)" : ""} — ${tableComment}`
    : `${opts.table}${isPrimary ? " (primary)" : ""}`;
  pop.appendChild(title);

  const tip = document.createElement("div");
  tip.className = "filter-combine-hint";
  tip.textContent = isForm
    ? "Check fields to show on this form. Unchecked fields are hidden and omitted from Save. Show / Relate Table / Relate Field match the list table DDL."
    : isPrimary
      ? "Select fields to query; set Show (picture/file) and display names. FK *Id columns: Relate Table + optional Relate Field (default id) — shared with detail multi-table CRUD."
      : "Select fields to JOIN; set Show / display names. Relate Table + Relate Field configure id@ / FK overrides (shared with detail).";
  pop.appendChild(tip);

  const headActions = document.createElement("div");
  headActions.className = "table-ddl-head-actions";
  if (opts.onSetPrimary) {
    const setPri = document.createElement("button");
    setPri.type = "button";
    setPri.textContent = t("result.setPrimary");
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
    rm.textContent = t("result.removeTable");
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
    show: ColumnShow;
    onTable: string;
    onField: string;
    onJoin: OnJoinMode;
    returnAgg: ColumnReturnAgg;
    returnExpr: string;
  };

  const selectedSet = new Set(
    opts.selectionOverride != null
      ? opts.selectionOverride
      : selectedColumnsForTable(
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
      list.innerHTML = `<div class="muted">${t("result.noColumnInfo")}</div>`;
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
        show: meta?.show ?? inferColumnShow(path, [], comments),
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
      t("result.ddlHeaders");
    list.appendChild(header);

    const otherTables = [
      ...new Set([
        ...catalogTables(),
        ...opts.queryTables,
        opts.primaryTable,
      ]),
    ].filter((t) => t && isBusinessTable(t));

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
      cb.title = isForm
        ? "Checked = show this field on the form"
        : "Checked = query/JOIN this field";
      cb.onchange = () => {
        d.selected = cb.checked;
      };

      const name = document.createElement("code");
      name.textContent = d.col;

      const type = document.createElement("span");
      type.className = "table-ddl-type";
      type.textContent = comments?.types?.[path] || "—";

      const showSel = document.createElement("select");
      showSel.className = "ddl-show-select";
      showSel.title =
        "Show: how cells render (Auto / Text / Picture / File). Prompt assigns; editable here.";
      for (const opt of COLUMN_SHOW_OPTIONS) {
        const o = document.createElement("option");
        o.value = opt.show;
        o.textContent = opt.label;
        if (opt.show === d.show) o.selected = true;
        showSel.appendChild(o);
      }
      showSel.onchange = () => {
        d.show = showSel.value as ColumnShow;
      };

      const displayIn = document.createElement("input");
      displayIn.type = "text";
      displayIn.className = "ddl-display-name";
      displayIn.placeholder = d.col;
      displayIn.value = d.displayName;
      displayIn.oninput = () => {
        d.displayName = displayIn.value;
      };

      const onFieldSel = document.createElement("select");
      onFieldSel.className = "ddl-on-select";
      onFieldSel.setAttribute("aria-label", "Relate Field");
      onFieldSel.title =
        "Field on the linked table (usually id)";
      fillRelFieldOptions(onFieldSel, d.onTable, d.onField);

      const onTableSel = mountTablePickControl({
        value: d.onTable,
        placeholder: "—",
        className: "table-pick-btn ddl-on-select",
        ariaLabel: "Relate Table",
        title: "Which table this field links to",
        pickTitle: "Link to table",
        allowEmpty: true,
        emptyLabel: "— None —",
        comments,
        extra: otherTables,
        onPick: (table) => {
          d.onTable = table;
          d.onField = "";
          fillRelFieldOptions(onFieldSel, d.onTable, "");
        },
      });

      onFieldSel.onchange = () => {
        d.onField = onFieldSel.value;
      };

      const returnWrap = document.createElement("div");
      returnWrap.className = "table-ddl-return";
      const returnSel = document.createElement("select");
      returnSel.className = "ddl-return-select";
      returnSel.title = t("result.returnTitle");
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
      returnExpr.placeholder = t("result.customAggPlaceholder");
      returnExpr.title = t("result.returnExprTitle");
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

      const onJoinSel = document.createElement("select");
      onJoinSel.className = "ddl-on-select";
      onJoinSel.setAttribute("aria-label", "Join");
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

      const comment = document.createElement("span");
      comment.className = "table-ddl-comment";
      const raw = comments?.columns?.[path] || "";
      comment.textContent = raw.replace(/\s*\([^)]*\)\s*$/, "") || "—";
      comment.title = raw;

      row.append(
        cb,
        name,
        type,
        showSel,
        returnWrap,
        displayIn,
        onJoinSel,
        onTableSel,
        onFieldSel,
        comment,
      );
      list.appendChild(row);
    }

    // stash drafts on list for apply
    (list as unknown as { __drafts?: RowDraft[] }).__drafts = drafts;
  };

  let liveComments: SchemaComments | null = opts.comments;

  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = "primary";
  applyBtn.textContent = t("common.apply");
  applyBtn.onclick = () => {
    const drafts =
      (list as unknown as { __drafts?: RowDraft[] }).__drafts ?? [];
    if (!drafts.length) {
      // Editor not ready (still loading comments) — don't wipe @column
      return;
    }
    // Stash latest schema so form onApply can expand all columns
    (
      window as unknown as { __a2apiComments?: SchemaComments | null }
    ).__a2apiComments = liveComments;
    const selectedColumns = drafts.filter((d) => d.selected).map((d) => d.col);
    const fieldMetas: Record<string, Partial<ColumnMeta>> = {};
    for (const d of drafts) {
      const path = `${opts.table}.${d.col}`;
      fieldMetas[path] = {
        displayName: d.displayName.trim() || undefined,
        show: d.show,
        onTable: d.onTable || undefined,
        onField: d.onField || undefined,
        onJoin: d.onJoin,
        returnAgg: d.returnAgg,
        returnExpr:
          d.returnAgg === "custom" ? d.returnExpr.trim() || undefined : undefined,
        // Form DDL: checkbox = detail/create field visibility
        ...(isForm ? { visible: d.selected } : {}),
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
  cancel.textContent = t("common.close");
  cancel.onclick = () => pop.remove();
  actions.append(applyBtn, cancel);
  pop.appendChild(actions);

  document.body.appendChild(pop);
  placeFloatingPopover(pop, anchor);

  const closer = (ev: MouseEvent) => {
    const t = ev.target as Node;
    if (pop.contains(t) || t === anchor) return;
    // Nested shared table picker is mounted on body
    const tablePop = document.getElementById("add-table-popover");
    if (tablePop?.contains(t)) return;
    pop.remove();
    document.removeEventListener("mousedown", closer);
  };
  setTimeout(() => document.addEventListener("mousedown", closer), 0);

  const bootEditor = (comments: SchemaComments | null) => {
    if (!document.body.contains(pop)) return;
    liveComments = comments;
    // Form DDL: selection = currently visible detail fields (after schema load)
    if (isForm) {
      const all = collectTableColumns(opts.table, opts.columns, comments);
      selectedSet.clear();
      const vis = all.filter((col) => {
        for (const t of tableNameAliases(opts.table)) {
          if (opts.columnMetas[`${t}.${col}`]?.visible === false) return false;
        }
        return true;
      });
      const hasMeta = all.some((col) =>
        tableNameAliases(opts.table).some(
          (t) => opts.columnMetas[`${t}.${col}`] != null,
        ),
      );
      for (const col of hasMeta ? vis : all) selectedSet.add(col);
    }
    const tc =
      comments?.tables[opts.table] ||
      comments?.tables[TABLE_NAME_ALIASES[opts.table] || ""] ||
      "";
    title.textContent = tc
      ? `${opts.table}${isPrimary ? " (primary)" : ""} — ${tc}`
      : `${opts.table}${isPrimary ? " (primary)" : ""}`;
    renderEditor(comments);
  };

  if (!hasTableSchema(opts.table, opts.comments)) {
    list.innerHTML = `<div class="muted">${t("result.loadingFields")}</div>`;
    void ensureTableSchemaComments([opts.table], opts.comments)
      .then((next) => bootEditor(next))
      .catch(() => bootEditor(opts.comments));
  } else {
    bootEditor(opts.comments);
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

function fillFieldSelect(
  sel: HTMLSelectElement,
  table: string,
  selected: string,
  columns: string[],
  comments: SchemaComments | null,
) {
  sel.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "—";
  sel.appendChild(empty);
  if (!table) {
    sel.value = "";
    return;
  }
  const fields = collectTableColumns(table, columns, comments);
  const list = fields.length ? fields : selected ? [selected] : ["id"];
  if (selected && !list.includes(selected)) list.push(selected);
  if (!list.includes("id")) list.unshift("id");
  for (const f of [...new Set(list)]) {
    const o = document.createElement("option");
    o.value = f;
    o.textContent = f;
    sel.appendChild(o);
  }
  sel.value = selected && list.includes(selected) ? selected : selected || "id";
}

/**
 * Slot header: [Add|View|Edit|Remove ▼] [Table DDL] [▾]
 * Secondary: [Vice field ▼] [=|IN|Contains] [Relate table] [Relate field] [×]
 * → Request.structure UPDATE "viceKey@":"/RelateTable/relateKey" (or {}@ / <>@).
 */
function mountDetailSlotHeader(
  host: HTMLElement,
  opts: {
    slot: DetailTableSlot;
    isPrimary: boolean;
    columns: string[];
    comments: SchemaComments | null;
    columnMetas?: Record<string, ColumnMeta> | null;
    fkExpand?: Record<string, FkJoinSpec> | null;
    primaryTable?: string | null;
    canRemove: boolean;
    onChange: () => void;
    onRemove: () => void;
    onRelateSync?: (payload: RelateSyncPayload) => void;
    onColumnMetasChange?: (metas: Record<string, ColumnMeta>) => void;
  },
) {
  const row = document.createElement("div");
  row.className =
    "detail-slot-header" + (opts.isPrimary ? " is-primary" : "");

  const opSel = document.createElement("select");
  opSel.className = "detail-op-select";
  opSel.setAttribute("aria-label", "Action");
  opSel.title = t("result.slotOpTitle");
  for (const opt of CRUD_OP_OPTIONS) {
    const o = document.createElement("option");
    o.value = opt.op;
    o.textContent = opt.label;
    o.title = opt.title;
    if (opt.op === opts.slot.op) o.selected = true;
    opSel.appendChild(o);
  }
  opSel.onchange = () => {
    opts.slot.op = opSel.value as CrudOp;
    opts.onChange();
  };

  const tableWrap = document.createElement("div");
  tableWrap.className = "detail-table-ctl";
  const tableChip = document.createElement("button");
  tableChip.type = "button";
  tableChip.className = "table-chip detail-table-select";
  tableChip.setAttribute("aria-label", "Table fields");
  tableChip.title =
    "Field show/hide (same DDL as list table chips). Unchecked fields are omitted from Save.";
  tableChip.textContent = opts.slot.table;
  tableChip.onclick = (e) => {
    e.stopPropagation();
    const metas = opts.columnMetas ?? {};
    openTableDdlPopover(tableChip, {
      table: opts.slot.table,
      primaryTable: opts.primaryTable || opts.slot.table,
      columns: opts.columns,
      comments: opts.comments,
      fkExpand: opts.fkExpand ?? {},
      columnMetas: metas,
      bodyTemplate: null,
      tableJoins: {},
      queryTables: [opts.slot.table],
      purpose: "form",
      selectionOverride: visibleDetailColumns(
        opts.slot.table,
        opts.columns,
        opts.comments,
        metas,
      ),
      onApply: (payload) => {
        // Prefer schema loaded inside the popover (logical+physical keys)
        const commentsNow =
          (
            window as unknown as {
              __a2apiComments?: SchemaComments;
            }
          ).__a2apiComments ?? opts.comments;
        const allCols = collectTableColumns(
          opts.slot.table,
          opts.columns,
          commentsNow,
        );
        const next = applyDetailFormDdl(metas, payload, allCols);
        opts.onColumnMetasChange?.(next);
        // Relate patches from DDL → same store as Relate dropdowns
        for (const [path, patch] of Object.entries(payload.fieldMetas)) {
          if (!patch.onTable) continue;
          const local = path.includes(".")
            ? path.slice(path.indexOf(".") + 1)
            : path;
          opts.onRelateSync?.({
            table: opts.slot.table,
            localField: local,
            onTable: patch.onTable,
            onField: patch.onField || "id",
          });
        }
        opts.onChange();
      },
    });
  };
  const changeBtn = document.createElement("button");
  changeBtn.type = "button";
  changeBtn.className = "detail-table-change";
  changeBtn.setAttribute("aria-label", "Change table");
  changeBtn.title = t("result.changeTable");
  changeBtn.textContent = "▾";
  changeBtn.onclick = (e) => {
    e.stopPropagation();
    openTablePickPopover(changeBtn, {
      title: "Choose table",
      selected: opts.slot.table,
      comments: opts.comments,
      onPick: (table) => {
        opts.slot.table = table;
        tableChip.textContent = table;
        if (!opts.isPrimary) {
          const d = defaultRelateForTable(
            opts.slot.table,
            opts.primaryTable || null,
            opts.columnMetas,
            opts.fkExpand,
          );
          opts.slot.relateTable = d.relateTable;
          opts.slot.relateField = d.relateField;
          opts.slot.localField = d.localField || undefined;
          opts.slot.relateOp = d.relateOp;
        }
        opts.onChange();
      },
    });
  };
  tableWrap.append(tableChip, changeBtn);

  row.append(opSel, tableWrap);

  if (!opts.isPrimary) {
    // Ensure defaults once so vice field shows a sensible pick
    if (!opts.slot.localField && opts.slot.relateTable) {
      opts.slot.localField =
        resolveRelateLocalField(
          opts.slot.table,
          opts.slot.relateTable,
          opts.columnMetas,
        ) || undefined;
    }
    if (!opts.slot.relateOp) opts.slot.relateOp = "eq";

    let relFieldSel: HTMLSelectElement | null = null;
    let localFieldSel: HTMLSelectElement | null = null;

    const syncRelate = () => {
      const local =
        (opts.slot.localField || "").trim() ||
        resolveRelateLocalField(
          opts.slot.table,
          opts.slot.relateTable || "",
          opts.columnMetas,
        );
      if (local) opts.slot.localField = local;
      if (local && opts.slot.relateTable) {
        opts.onRelateSync?.({
          table: opts.slot.table,
          localField: local,
          onTable: opts.slot.relateTable,
          onField: opts.slot.relateField || "id",
          relateOp: opts.slot.relateOp || "eq",
        });
      }
      opts.onChange();
    };

    localFieldSel = document.createElement("select");
    localFieldSel.className = "detail-relate-select detail-vice-field";
    localFieldSel.setAttribute("aria-label", "Vice field");
    localFieldSel.title =
      "Vice-table field (left side). Request.structure UPDATE key, e.g. momentId@";
    fillFieldSelect(
      localFieldSel,
      opts.slot.table,
      opts.slot.localField || "",
      opts.columns,
      opts.comments,
    );
    localFieldSel.onchange = () => {
      opts.slot.localField = localFieldSel!.value || undefined;
      syncRelate();
    };

    const opSelRel = document.createElement("select");
    opSelRel.className = "detail-relate-op";
    opSelRel.setAttribute("aria-label", "Relate operator");
    opSelRel.title =
      "Link type: = (field@), IN (field{}@), Contains (field<>@)";
    for (const opt of RELATE_OP_OPTIONS) {
      const o = document.createElement("option");
      o.value = opt.op;
      o.textContent = opt.label;
      o.title = opt.title;
      if (opt.op === (opts.slot.relateOp || "eq")) o.selected = true;
      opSelRel.appendChild(o);
    }
    opSelRel.onchange = () => {
      opts.slot.relateOp = opSelRel.value as RelateOp;
      syncRelate();
    };

    const eqHint = document.createElement("span");
    eqHint.className = "detail-relate-eq muted";
    eqHint.textContent = "→";
    eqHint.title = t("result.relateHint");

    const relTableBtn = mountTablePickControl({
      value: opts.slot.relateTable || "",
      placeholder: "Relate table…",
      className: "table-pick-btn detail-relate-select",
      ariaLabel: "Relate Table",
      title: "Related table (right side of UPDATE path)",
      pickTitle: "Relate table",
      allowEmpty: true,
      emptyLabel: "— No link —",
      comments: opts.comments,
      extra: [opts.slot.table, opts.primaryTable || ""].filter(Boolean),
      onPick: (table) => {
        opts.slot.relateTable = table;
        if (!opts.slot.localField && table) {
          const guessed = resolveRelateLocalField(
            opts.slot.table,
            table,
            opts.columnMetas,
          );
          if (guessed && localFieldSel) {
            fillFieldSelect(
              localFieldSel,
              opts.slot.table,
              guessed,
              opts.columns,
              opts.comments,
            );
            opts.slot.localField = localFieldSel.value || guessed;
          }
        }
        if (relFieldSel) {
          fillFieldSelect(
            relFieldSel,
            opts.slot.relateTable,
            opts.slot.relateField || "id",
            opts.columns,
            opts.comments,
          );
          opts.slot.relateField = relFieldSel.value || "id";
        } else {
          opts.slot.relateField = "id";
        }
        syncRelate();
      },
    });

    relFieldSel = document.createElement("select");
    relFieldSel.className = "detail-relate-select";
    relFieldSel.setAttribute("aria-label", "Relate Field");
    relFieldSel.title =
      "Related-table field (right side), e.g. id in /Moment/id";
    fillFieldSelect(
      relFieldSel,
      opts.slot.relateTable || "",
      opts.slot.relateField || "id",
      opts.columns,
      opts.comments,
    );
    relFieldSel.onchange = () => {
      opts.slot.relateField = relFieldSel!.value || "id";
      syncRelate();
    };
    row.append(localFieldSel, opSelRel, eqHint, relTableBtn, relFieldSel);
  }

  const badge = document.createElement("span");
  badge.className = "detail-slot-badge";
  badge.textContent = `${crudOpLabel(opts.slot.op)} ${opts.slot.table}`;
  row.appendChild(badge);

  if (opts.canRemove) {
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "detail-slot-x";
    rm.title = t("result.removeSlot");
    rm.textContent = "×";
    rm.onclick = () => opts.onRemove();
    row.appendChild(rm);
  }

  host.appendChild(row);
}

function appendDetailFieldName(
  field: HTMLElement,
  nameEl: HTMLElement,
  onHide?: () => void,
) {
  if (!onHide) {
    field.appendChild(nameEl);
    return;
  }
  const row = document.createElement("div");
  row.className = "detail-field-name-row";
  row.appendChild(nameEl);
  const hideBtn = document.createElement("button");
  hideBtn.type = "button";
  hideBtn.className = "detail-field-x";
  hideBtn.title = t("result.hideField");
  hideBtn.setAttribute("aria-label", "Hide field");
  hideBtn.textContent = "×";
  // Only the × control hides — do not put this inside a <label> (label click
  // would activate the first button and hide the whole row by accident).
  hideBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onHide();
  });
  hideBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  row.appendChild(hideBtn);
  field.appendChild(row);
}

function openCreateForm(
  container: HTMLElement,
  opts: {
    table: string;
    columns: string[];
    comments: SchemaComments | null;
    columnMetas?: Record<string, ColumnMeta> | null;
    apijsonBase: string;
    initialValues?: Record<string, unknown>;
    initialSlots?: DetailTableSlot[];
    pageTitle?: string;
    onBack: () => void;
    onSubmit: (payload: WritePayload) => void | Promise<void>;
    onRelateSync?: (payload: RelateSyncPayload) => void;
    onColumnMetasChange?: (metas: Record<string, ColumnMeta>) => void;
    onPageTitleChange?: (title: string) => void;
    onDetailSlotsChange?: (slots: DetailTableSlot[]) => void;
    fkExpand?: Record<string, FkJoinSpec> | null;
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
  const defaultTitle = opts.pageTitle?.trim() || `Create ${opts.table}`;
  const titleInput = mountDetailPageTitleInput(header, {
    value: defaultTitle,
    placeholder: `Create ${opts.table}`,
    onCommit: (title) => {
      opts.onPageTitleChange?.(title);
    },
  });
  card.appendChild(header);

  const slots: DetailTableSlot[] = opts.initialSlots?.length
    ? opts.initialSlots.map((s) => ({
        ...s,
        id: s.id || newDetailSlotId(),
      }))
    : [{ id: newDetailSlotId(), table: opts.table, op: "post" }];
  const emitSlots = () => {
    opts.onDetailSlotsChange?.(slots.map((s) => ({ ...s })));
  };
  emitSlots();
  let liveComments = opts.comments;
  let columnMetas = opts.columnMetas ?? null;
  let schemaLoadGen = 0;

  type SlotCollectors = {
    table: string;
    inputs: Map<string, HTMLInputElement | HTMLTextAreaElement>;
    fkGetters: Map<string, () => string | number | null>;
    required: Set<string>;
    authVerifiers: AuthVerifyControl[];
  };
  let collectors: SlotCollectors[] = [];

  const slotsHost = document.createElement("div");
  slotsHost.className = "detail-slots-host";
  card.appendChild(slotsHost);

  const actions = document.createElement("div");
  actions.className = "detail-form-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary";
  saveBtn.textContent = t("common.save");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = t("common.cancel");
  cancel.onclick = goBack;
  actions.append(saveBtn, cancel);
  card.appendChild(actions);
  detailHost.appendChild(card);

  const flashSave = (msg: string, ms = 1400) => {
    saveBtn.textContent = msg;
    setTimeout(() => {
      saveBtn.textContent = t("common.save");
    }, ms);
  };

  const paintCreateSlotFields = (
    form: HTMLElement,
    table: string,
    comments: SchemaComments | null,
    isPrimary: boolean,
    editable = true,
  ): SlotCollectors => {
    const reqRules = createRulesFromRequest(table);
    const defaults = {
      ...createFieldDefaults(table),
      ...(reqRules?.insert ?? {}),
      ...(isPrimary ? opts.initialValues ?? {} : {}),
    };
    for (const col of Object.keys(reqRules?.insert ?? {})) {
      if (!(col in defaults)) defaults[col] = reqRules!.insert[col];
    }
    const required = new Set(createRequiredColumns(table));
    // FK auto-filled via Relate / structure UPDATE — not required in UI
    if (!isPrimary) {
      const slot = slots.find((s) => s.table === table);
      const local = slot ? slotLocalField(slot, columnMetas) : null;
      if (local) required.delete(local);
    }
    const colNames = createFormColumnNames(
      table,
      opts.columns,
      comments,
      defaults,
    ).filter((c) => {
      const path = `${table}.${c}`;
      if (!isDetailFieldVisible(path, columnMetas)) return false;
      if (isPrimary) return true;
      const slot = slots.find((s) => s.table === table);
      const local = slot ? slotLocalField(slot, columnMetas) : null;
      return !local || c !== local;
    });
    // Hidden fields are not required in the UI / Save payload
    for (const col of [...required]) {
      if (!colNames.includes(col)) required.delete(col);
    }
    const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
    const fkGetters = new Map<string, () => string | number | null>();
    const authVerifiers: AuthVerifyControl[] = [];

    for (const col of colNames) {
      const path = `${table}.${col}`;
      // div — not label: a label would activate the row's × and hide on any click
      const field = document.createElement("div");
      field.className = "detail-field";
      const name = document.createElement("span");
      name.className = "field-name";
      const tip = commentFor(path, comments);
      const label =
        columnMetas?.[path]?.displayName?.trim() || col;
      name.textContent = tip ? `${label} — ${tip.split(" (")[0]}` : label;
      if (required.has(col)) {
        const star = document.createElement("span");
        star.className = "field-required";
        star.textContent = " *";
        star.title = t("common.required");
        name.appendChild(star);
      }
      appendDetailFieldName(field, name, () => {
        columnMetas = hideDetailField(columnMetas ?? {}, path);
        opts.onColumnMetasChange?.(columnMetas);
        ensureSchemasThenPaint();
      });

      const fkRef = resolveFkRef(path, comments, columnMetas?.[path]);
      const fkIdListTable = resolveFkIdListTable(path, comments);
      const fieldType = inferFieldType(path, [defaults[col]], comments);
      const defaultVal = defaults[col];
      if (fkRef) {
        const host = document.createElement("div");
        const ctl = mountFkFieldControl(host, {
          path,
          table: fkRef.table,
          apijsonBase: opts.apijsonBase,
          comments,
          onChange: () => undefined,
        });
        if (editable) fkGetters.set(col, ctl.getValue);
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
          editable,
          registerInput: (el) => {
            if (
              editable &&
              (el instanceof HTMLTextAreaElement ||
                el instanceof HTMLInputElement)
            ) {
              inputs.set(col, el);
            }
          },
        });
        field.appendChild(host);
      } else {
        const createShow = columnShowOf(path, columnMetas);
        const createImg = resolveSmartImageField(
          path,
          defaultVal,
          comments,
          createShow,
        );
        if (createImg.kind === "list" || createImg.kind === "single") {
          mountImageListEditor(field, {
            path,
            value: defaultVal ?? (createImg.kind === "list" ? [] : ""),
            editable,
            mode: createImg.kind === "list" ? "list" : "single",
            comments,
            show: createShow,
            apijsonBase: opts.apijsonBase,
            registerInput: (el) => {
              if (
                editable &&
                (el instanceof HTMLTextAreaElement ||
                  el instanceof HTMLInputElement)
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
          ta.readOnly = !editable;
          ta.rows = 4;
          ta.value =
            defaultVal == null || defaultVal === ""
              ? "[]"
              : cellPrettyJson(defaultVal);
          ta.placeholder = "[]";
          if (editable) inputs.set(col, ta);
          field.appendChild(ta);
        } else if (fieldType === "date" || fieldType === "time") {
          const input = document.createElement("input");
          input.type = inputTypeForField(fieldType);
          input.dataset.kind = fieldType;
          input.readOnly = !editable;
          input.value = displayTimeValue(fieldType, cellText(defaultVal ?? ""));
          if (editable) inputs.set(col, input);
          field.appendChild(input);
        } else if (fieldType === "number") {
          const input = document.createElement("input");
          input.type = "number";
          input.dataset.kind = "number";
          input.readOnly = !editable;
          input.value = cellText(defaultVal ?? "");
          if (editable) inputs.set(col, input);
          field.appendChild(input);
        } else {
          const input = document.createElement(
            col === "content" ? "textarea" : "input",
          ) as HTMLInputElement | HTMLTextAreaElement;
          input.value = cellText(defaultVal ?? "");
          input.readOnly = !editable;
          if (input instanceof HTMLTextAreaElement) input.rows = 3;
          if (editable) inputs.set(col, input);
          field.appendChild(input);
        }
      }
      form.appendChild(field);

      const authKind = isAuthVerifyField(path, comments);
      if (authKind && opts.apijsonBase) {
        const sourceEl = inputs.get(col);
        authVerifiers.push(
          mountAuthVerifyField(form, {
            path,
            kind: authKind,
            apijsonBase: opts.apijsonBase,
            verifyType: verifyTypeForWrite("post"),
            getTarget: () => {
              if (sourceEl) return String(sourceEl.value ?? "").trim();
              return cellText(defaultVal ?? "").trim();
            },
          }),
        );
      }
    }
    if (!colNames.length) {
      const note = document.createElement("div");
      note.className = "muted detail-slot-note";
      const anyKnown = collectTableColumns(table, opts.columns, comments).length;
      note.textContent = anyKnown
        ? "All fields hidden — click the table name to show fields in DDL"
        : "No fields found for this table yet…";
      form.appendChild(note);
    }
    return {
      table,
      inputs,
      fkGetters,
      required: editable ? required : new Set(),
      authVerifiers,
    };
  };

  const ensureSchemasThenPaint = () => {
    const need = slots
      .map((s) => s.table)
      .filter((t) => !hasTableSchema(t, liveComments));
    if (!need.length) {
      paint(liveComments);
      return;
    }
    const gen = ++schemaLoadGen;
    slotsHost.innerHTML = `<div class="muted detail-slot-note">${t("result.loadingFields")}</div>`;
    void ensureTableSchemaComments(need, liveComments).then((next) => {
      if (gen !== schemaLoadGen) return;
      liveComments = next;
      paint(liveComments);
    });
  };

  const paint = (comments: SchemaComments | null) => {
    liveComments = comments;
    slotsHost.innerHTML = "";
    collectors = [];
    // Keep editable page title; only hint when still the default Create X
    if (
      !titleInput.value.trim() ||
      /^Create\s/i.test(titleInput.value) ||
      /^Add\s/i.test(titleInput.value)
    ) {
      const hint =
        slots.length > 1
          ? `Create ${slots.map((s) => s.table).join(" + ")}`
          : `Create ${slots[0]?.table ?? opts.table}`;
      if (!opts.pageTitle?.trim()) titleInput.value = hint;
    }
    emitSlots();

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      const block = document.createElement("div");
      block.className = "detail-slot-block";
      const head = document.createElement("div");
      mountDetailSlotHeader(head, {
        slot,
        isPrimary: i === 0,
        columns: opts.columns,
        comments,
        columnMetas,
        fkExpand: opts.fkExpand,
        primaryTable: slots[0]?.table ?? opts.table,
        canRemove: slots.length > 1,
        onRelateSync: (p) => {
          columnMetas = applyRelateToColumnMetas(columnMetas ?? {}, p);
          opts.onRelateSync?.(p);
        },
        onColumnMetasChange: (next) => {
          columnMetas = next;
          opts.onColumnMetasChange?.(next);
        },
        onChange: () => ensureSchemasThenPaint(),
        onRemove: () => {
          slots.splice(i, 1);
          ensureSchemasThenPaint();
        },
      });
      block.appendChild(head);
      if (slot.op === "delete") {
        const note = document.createElement("div");
        note.className = "muted detail-slot-note";
        note.textContent =
          "Remove needs a record id (open an existing row, or switch to Edit)";
        block.appendChild(note);
        collectors.push({
          table: slot.table,
          inputs: new Map(),
          fkGetters: new Map(),
          required: new Set(),
          authVerifiers: [],
        });
      } else {
        const form = document.createElement("div");
        form.className = "detail-fields";
        if (slot.op === "get") {
          const note = document.createElement("div");
          note.className = "muted detail-slot-note";
          note.textContent = t("result.viewOnly");
          form.appendChild(note);
        }
        collectors.push(
          paintCreateSlotFields(
            form,
            slot.table,
            comments,
            i === 0,
            slot.op !== "get",
          ),
        );
        block.appendChild(form);
      }
      slotsHost.appendChild(block);
    }

    const addRow = document.createElement("div");
    addRow.className = "detail-slots-add";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "table-chip table-chip-add";
    addBtn.textContent = "+";
    addBtn.title = "Add another related table";
    addBtn.onclick = (e) => {
      e.stopPropagation();
      openAddTablePopover(
        addBtn,
        slots.map((s) => s.table),
        (table) => {
          const rel = defaultRelateForTable(
            table,
            slots[0]?.table ?? opts.table,
            columnMetas,
            opts.fkExpand,
          );
          slots.push({
            id: newDetailSlotId(),
            table,
            op: "post",
            relateTable: rel.relateTable || slots[0]?.table,
            relateField: rel.relateField || "id",
            localField: rel.localField || undefined,
            relateOp: rel.relateOp || "eq",
          });
          if (rel.localField && (rel.relateTable || slots[0]?.table)) {
            const p: RelateSyncPayload = {
              table,
              localField: rel.localField,
              onTable: rel.relateTable || slots[0]!.table,
              onField: rel.relateField || "id",
              relateOp: rel.relateOp || "eq",
            };
            columnMetas = applyRelateToColumnMetas(columnMetas ?? {}, p);
            opts.onRelateSync?.(p);
          }
          ensureSchemasThenPaint();
        },
        comments,
      );
    };
    addRow.appendChild(addBtn);
    const hint = document.createElement("span");
    hint.className = "muted detail-slot-hint";
    hint.textContent =
      "Add tables to edit together. Set vice field =/in/contains relate table.field";
    addRow.appendChild(hint);
    slotsHost.appendChild(addRow);

    saveBtn.onclick = () => {
      void (async () => {
        // Persist slots / field visibility / DDL before write
        opts.onColumnMetasChange?.(columnMetas ?? {});
        opts.onDetailSlotsChange?.(slots.map((s) => ({ ...s })));
        const allVerifiers = collectors.flatMap((c) => c.authVerifiers);
        const verifyErr = await requireAuthVerifyCodes(
          allVerifiers,
          verifyTypeForWrite("post"),
        );
        if (verifyErr) {
          flashSave(verifyErr, 2200);
          return;
        }
        const entities: Record<string, Record<string, unknown>> = {};
        for (let i = 0; i < slots.length; i++) {
          const slot = slots[i]!;
          const col = collectors[i];
          if (!col) continue;
          if (slot.op === "get") {
            entities[slot.table] = {};
            continue;
          }
          if (slot.op === "delete") {
            flashSave("Delete needs an id — use edit detail");
            return;
          }
          for (const req of col.required) {
            if (col.fkGetters.has(req)) {
              if (col.fkGetters.get(req)!() == null) {
                flashSave(`${slot.table}.${req} * required`);
                return;
              }
              continue;
            }
            const el = col.inputs.get(req);
            if (!el || !String(el.value ?? "").trim()) {
              flashSave(`${slot.table}.${req} * required`);
              return;
            }
          }
          const fields: Record<string, unknown> = {};
          for (const [c, el] of col.inputs) {
            const raw = el.value.trim();
            if (raw === "") continue;
            const fieldPath = `${slot.table}.${c}`;
            if (el.dataset.kind === "json") {
              try {
                fields[c] = JSON.parse(raw);
              } catch {
                flashSave(`${c} JSON invalid`);
                return;
              }
              continue;
            }
            if (el.dataset.kind === "time" || el.dataset.kind === "date") {
              fields[c] = coerceField(null, raw, fieldPath);
              continue;
            }
            if (el.dataset.kind === "number") {
              const n = Number(raw);
              fields[c] = Number.isFinite(n) ? n : raw;
              continue;
            }
            fields[c] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
          }
          for (const [c, get] of col.fkGetters) {
            const id = get();
            if (id == null) {
              if (col.required.has(c)) {
                flashSave(`${slot.table}.${c} * required`);
                return;
              }
              continue;
            }
            fields[c] = id;
          }
          try {
            for (const c of Object.keys(fields)) {
              const path = `${slot.table}.${c}`;
              const val = fields[c];
              const img = resolveSmartImageField(
                path,
                val,
                comments,
                columnShowOf(path, columnMetas),
              );
              if (img.kind === "list" && Array.isArray(val)) {
                fields[c] = await ensureRemoteImageList(
                  opts.apijsonBase,
                  val,
                );
              } else if (img.kind === "single" && typeof val === "string") {
                fields[c] = await ensureRemoteImageUrl(
                  opts.apijsonBase,
                  val,
                );
              }
            }
          } catch (e) {
            flashSave(e instanceof Error ? e.message : String(e));
            return;
          }
          entities[slot.table] = fields;
        }
        if (!Object.keys(entities).length) {
          flashSave("Fill in at least one field", 1200);
          return;
        }
        const payload = buildCrudPayload({
          slots,
          entities,
          columnMetas,
        });
        if (!payload) {
          flashSave("Nothing to save");
          return;
        }
        // `"Verify": { "verify" }` + `"@delete":"Verify"` + Apply UPDATE phone@/email@
        attachAuthVerifyToWritePayload(
          payload,
          pickAuthVerifyCode(allVerifiers),
        );
        void opts.onSubmit(payload);
      })();
    };
  };

  const boot = async () => {
    slotsHost.innerHTML = `<div class="muted detail-slot-note">${t("result.loadingFields")}</div>`;
    await ensureRequestStructures(opts.apijsonBase).catch(() => undefined);
    liveComments = await ensureTableSchemaComments(
      [opts.table, ...slots.map((s) => s.table)],
      opts.comments,
    );
    if (document.body.contains(card)) paint(liveComments);
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
    /** Target key when FK key is not id (optional) */
    field?: string;
    comments: SchemaComments | null;
    columnMetas?: Record<string, ColumnMeta> | null;
    fkExpand?: Record<string, FkJoinSpec> | null;
    apijsonBase: string;
    mode?: "view" | "edit";
    pageTitle?: string;
    initialSlots?: DetailTableSlot[] | null;
    onBack?: () => void;
    onWrite?: (payload: WritePayload) => void | Promise<void>;
    onRelateSync?: (payload: RelateSyncPayload) => void;
    onColumnMetasChange?: (metas: Record<string, ColumnMeta>) => void;
    onPageTitleChange?: (title: string) => void;
    onDetailSlotsChange?: (slots: DetailTableSlot[]) => void;
    onOpenFkList?: (info: {
      table: string;
      ids: Array<string | number>;
      field?: string;
    }) => void;
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
  const targetKey = (opts.field || "id").trim() || "id";
  detailHost.innerHTML = `<div class="result-empty">${t("result.loadingRecord", { table: opts.table, key: targetKey, id: opts.id })}</div>`;

  const mode: "view" | "edit" =
    opts.mode ?? (opts.onWrite ? "edit" : "view");

  try {
    // Full-field GET by target key (no @column)
    const body = await withRequestRole(
      buildFkGetBody(opts.table, opts.id, targetKey),
      "get",
      opts.apijsonBase,
    );
    const res = await fetch(
      `${opts.apijsonBase}/get`,
      withApijsonAuth({
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      }),
    );
    const json = (await res.json()) as { code?: number; msg?: string };
    if (!res.ok || json.code !== 200) {
      logoutIfApijsonAuthFailed(json);
      detailHost.innerHTML = `<div class="result-empty">${t("result.loadFailed", { msg: json.msg || res.statusText })}</div>`;
      return;
    }
    const parsed = parseResponse(json);
    let row = parsed.rows[0];
    if (!row) {
      detailHost.innerHTML = `<div class="result-empty">${t("result.notFound", { table: opts.table, id: opts.id })}</div>`;
      return;
    }
    row = expandDetailRowFields(row, opts.table, opts.comments);
    detailHost.innerHTML = "";
    renderDetailForm(detailHost, row, {
      comments: opts.comments,
      columnMetas: opts.columnMetas ?? null,
      fkExpand: opts.fkExpand ?? null,
      mode,
      apijsonBase: opts.apijsonBase,
      pageTitle: opts.pageTitle,
      initialSlots: opts.initialSlots,
      onRelateSync: opts.onRelateSync,
      onColumnMetasChange: opts.onColumnMetasChange,
      onPageTitleChange: opts.onPageTitleChange,
      onDetailSlotsChange: opts.onDetailSlotsChange,
      onOpenFkList: opts.onOpenFkList,
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
    columnMetas?: Record<string, ColumnMeta> | null;
    onBack?: () => void;
    onSave?: (payload: WritePayload) => void | Promise<void>;
    onDelete?: () => void;
    apijsonBase?: string;
    onColumnMetasChange?: (metas: Record<string, ColumnMeta>) => void;
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
      columnMetas: callbacks?.columnMetas ?? null,
      mode: callbacks?.mode ?? "view",
      apijsonBase: callbacks?.apijsonBase,
      onColumnMetasChange: callbacks?.onColumnMetasChange,
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
    columnMetas?: Record<string, ColumnMeta> | null;
    mode?: "view" | "edit";
    apijsonBase?: string;
    fkExpand?: Record<string, FkJoinSpec> | null;
    columns?: string[];
    pageTitle?: string;
    initialSlots?: DetailTableSlot[] | null;
    onBack: (() => void) | null;
    onSave?: (payload: WritePayload) => void | Promise<void>;
    onDelete?: () => void;
    onWrite?: (payload: WritePayload) => void | Promise<void>;
    onRelateSync?: (payload: RelateSyncPayload) => void;
    onColumnMetasChange?: (metas: Record<string, ColumnMeta>) => void;
    onPageTitleChange?: (title: string) => void;
    onDetailSlotsChange?: (slots: DetailTableSlot[]) => void;
    onOpenFkList?: (info: {
      table: string;
      ids: Array<string | number>;
      field?: string;
    }) => void;
  },
) {
  let comments = opts.comments;
  let columnMetas = opts.columnMetas ?? null;
  const editableMode = opts.mode === "edit";
  const primary = pickPrimaryTable(row);
  const writeFn = opts.onWrite ?? opts.onSave;
  const columns = opts.columns ?? Object.keys(row.cells);
  const card = document.createElement("div");
  card.className = "detail-form";
  /** Avoid overlapping schema fetches when switching tables quickly. */
  let schemaLoadGen = 0;

  const header = document.createElement("div");
  header.className = "detail-form-header";
  if (opts.onBack) {
    header.appendChild(makeBackIconButton(opts.onBack));
  }
  const fallbackTitle = primary
    ? `${primary} ${editableMode ? "Edit" : "View"}`
    : `${editableMode ? "Edit" : "View"}`;
  const titleValue =
    stripTitleRecordId(opts.pageTitle?.trim() || "") || fallbackTitle;
  mountDetailPageTitleInput(header, {
    value: titleValue,
    placeholder: fallbackTitle,
    onCommit: (title) => opts.onPageTitleChange?.(title),
  });
  const recordId =
    (primary ? row.cells[`${primary}.id`] : undefined) ?? row.key;
  const switchHost =
    container.id === "result-detail-host"
      ? container.parentElement ?? container
      : container;
  mountDetailRecordIdControl(header, {
    id: recordId as string | number,
    onSwitch:
      primary && opts.apijsonBase
        ? (id) => {
            void openFkDetail(switchHost, {
              table: primary,
              id,
              comments,
              columnMetas,
              fkExpand: opts.fkExpand ?? null,
              apijsonBase: opts.apijsonBase!,
              mode: editableMode ? "edit" : "view",
              pageTitle: opts.pageTitle,
              initialSlots: opts.initialSlots,
              onBack: opts.onBack || undefined,
              onWrite: writeFn,
              onRelateSync: opts.onRelateSync,
              onColumnMetasChange: opts.onColumnMetasChange,
              onPageTitleChange: opts.onPageTitleChange,
              onDetailSlotsChange: opts.onDetailSlotsChange,
              onOpenFkList: opts.onOpenFkList,
            });
          }
        : undefined,
  });

  let rawMode = false;
  const modeToggle = document.createElement("button");
  modeToggle.type = "button";
  modeToggle.className = "detail-raw-toggle";
  modeToggle.textContent = t("result.raw");
  modeToggle.title = t("result.smartToggle");
  header.appendChild(modeToggle);
  card.appendChild(header);

  const fieldsHost = document.createElement("div");
  fieldsHost.className = "detail-fields-host";
  card.appendChild(fieldsHost);

  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
  const fkValues = new Map<string, string | number | null>();
  let authVerifiers: AuthVerifyControl[] = [];

  // Group by table
  const groups = new Map<string, Array<[string, unknown]>>();
  for (const [key, value] of Object.entries(row.cells)) {
    const table = key.includes(".") ? key.split(".")[0]! : "_";
    if (!groups.has(table)) groups.set(table, []);
    groups.get(table)!.push([key, value]);
  }

  const tableOrder = [
    ...(primary && groups.has(primary) ? [primary] : []),
    ...[...groups.keys()].filter((t) => t !== "_" && t !== primary),
  ];
  const slots: DetailTableSlot[] = opts.initialSlots?.length
    ? opts.initialSlots.map((s) => ({
        ...s,
        id: s.id || newDetailSlotId(),
      }))
    : tableOrder.map((table, i) => {
        const rel =
          i === 0
            ? {
                relateTable: "",
                relateField: "",
                localField: null as string | null,
                relateOp: "eq" as const,
              }
            : defaultRelateForTable(
                table,
                primary,
                columnMetas,
                opts.fkExpand,
              );
        return {
          id: newDetailSlotId(),
          table,
          op: (editableMode
            ? i === 0
              ? "put"
              : "get"
            : "get") as CrudOp,
          relateTable: rel.relateTable || undefined,
          relateField: rel.relateField || undefined,
          localField: rel.localField || undefined,
          relateOp: rel.relateOp || "eq",
        };
      });
  if (!slots.length && primary) {
    slots.push({
      id: newDetailSlotId(),
      table: primary,
      op: editableMode ? "put" : "get",
    });
  }
  const emitSlots = () => {
    opts.onDetailSlotsChange?.(slots.map((s) => ({ ...s })));
  };
  emitSlots();

  const jumpToFk = (fk: FkJumpMeta) => {
    if (!opts.apijsonBase) return;
    const hostEl =
      container.closest(".result-view") || container.parentElement;
    if (!(hostEl instanceof HTMLElement)) return;
    void openFkDetail(hostEl, {
      table: fk.table,
      id: fk.id,
      field: fk.field,
      comments,
      columnMetas,
      apijsonBase: opts.apijsonBase,
      onBack: opts.onBack || undefined,
      onWrite: writeFn,
      onRelateSync: opts.onRelateSync,
      onColumnMetasChange: opts.onColumnMetasChange,
      onPageTitleChange: opts.onPageTitleChange,
      onDetailSlotsChange: opts.onDetailSlotsChange,
      onOpenFkList: opts.onOpenFkList,
      fkExpand: opts.fkExpand,
    });
  };

  /** Always expand to full schema columns (not sparse JOIN @column). */
  const ensureGroupFields = (table: string): Array<[string, unknown]> => {
    const cols = collectTableColumns(table, columns, comments);
    const prev = new Map(groups.get(table) ?? []);
    const fields: Array<[string, unknown]> = cols.map((c) => {
      const path = `${table}.${c}`;
      const fromRow = row.cells[path];
      const fromPrev = prev.get(path);
      return [
        path,
        fromPrev !== undefined
          ? fromPrev
          : fromRow !== undefined
            ? fromRow
            : null,
      ];
    });
    groups.set(table, fields);
    return fields;
  };

  const ensureSchemasThenPaint = () => {
    const need = slots.map((s) => s.table).filter((t) => !hasTableSchema(t, comments));
    if (!need.length) {
      paintFields();
      return;
    }
    const gen = ++schemaLoadGen;
    fieldsHost.innerHTML = `<div class="muted detail-slot-note">${t("result.loadingFields")}</div>`;
    void ensureTableSchemaComments(need, comments).then((next) => {
      if (gen !== schemaLoadGen) return;
      comments = next;
      paintFields();
    });
  };

  const paintFields = () => {
    fieldsHost.innerHTML = "";
    inputs.clear();
    fkValues.clear();
    authVerifiers = [];
    emitSlots();

  for (let si = 0; si < slots.length; si++) {
    const slot = slots[si]!;
    const table = slot.table;
    const fields = ensureGroupFields(table);
    const isPrimarySlot = si === 0;
    const headHost = document.createElement("div");
    mountDetailSlotHeader(headHost, {
      slot,
      isPrimary: isPrimarySlot,
      columns,
      comments,
      columnMetas,
      fkExpand: opts.fkExpand,
      primaryTable: primary || slots[0]?.table,
      canRemove: slots.length > 1,
      onRelateSync: (p) => {
        columnMetas = applyRelateToColumnMetas(columnMetas ?? {}, p);
        opts.onRelateSync?.(p);
      },
      onColumnMetasChange: (next) => {
        columnMetas = next;
        opts.onColumnMetasChange?.(next);
      },
      onChange: () => ensureSchemasThenPaint(),
      onRemove: () => {
        slots.splice(si, 1);
        ensureSchemasThenPaint();
      },
    });
    fieldsHost.appendChild(headHost);

    if (slot.op === "delete") {
      const note = document.createElement("div");
      note.className = "muted detail-slot-note";
      const idVal = row.cells[`${table}.id`];
      note.textContent =
        idVal != null && idVal !== ""
          ? `Will delete ${table} #${idVal}`
          : `Cannot delete ${table} — missing id`;
      fieldsHost.appendChild(note);
      continue;
    }

    const form = document.createElement("div");
    form.className = "detail-fields";
    const visibleFields = fields.filter(([key]) =>
      isDetailFieldVisible(key, columnMetas),
    );
    if (!visibleFields.length) {
      const note = document.createElement("div");
      note.className = "muted detail-slot-note";
      note.textContent = fields.length
        ? "All fields hidden — click the table name to show fields in DDL"
        : "No fields found for this table yet…";
      form.appendChild(note);
      fieldsHost.appendChild(form);
      continue;
    }
    const slotWritable =
      editableMode && (slot.op === "put" || slot.op === "post");
    for (const [key, value] of visibleFields) {
      // div — not label: a label would activate the row's × and hide on any click
      const field = document.createElement("div");
      field.className = "detail-field";
      field.title = tooltip(key, comments);
      const name = document.createElement("span");
      name.className = "field-name";
      const tip = commentFor(key, comments);
      const col = key.includes(".") ? key.split(".").pop()! : key;
      const label =
        columnMetas?.[key]?.displayName?.trim() || col;
      name.textContent = tip
        ? `${label} — ${tip.split(" (")[0]}`
        : label;
      name.title = tooltip(key, comments);
      appendDetailFieldName(field, name, () => {
        columnMetas = hideDetailField(columnMetas ?? {}, key);
        opts.onColumnMetasChange?.(columnMetas);
        ensureSchemasThenPaint();
      });

      const isComplex = looksLikeJsonField(key, value);
      // Writable when slot op is Add/Edit; hide auto-relate FK on secondary
      const relateLocal =
        !isPrimarySlot && slot.relateTable
          ? slotLocalField(slot, columnMetas)
          : null;
      if (relateLocal && col === relateLocal && slotWritable) {
        continue;
      }
      const editable =
        slotWritable &&
        !isDetailReadonlyCol(col);
      const colMeta = columnMetas?.[key];
      const fkRef = resolveFkRef(key, comments, colMeta);
      const fkIdListTable = resolveFkIdListTable(key, comments);
      const fk = cellFkJumpMeta(
        key,
        value,
        row.cells,
        comments,
        primary,
        colMeta,
      );
      const fieldType = inferFieldType(key, [value], comments);
      const useSmart = !rawMode;
      const detailImg = useSmart
        ? resolveSmartImageField(
            key,
            value,
            comments,
            columnShowOf(key, columnMetas),
          )
        : { kind: "none" as const, urls: [] as string[] };

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
          onIdClick: ({ table, id }) => {
            jumpToFk({ table, id, field: "id", label: null });
          },
          idClickTitle: `Open ${fkIdListTable} detail #{id}`,
        });
        field.appendChild(host);
      } else if (detailImg.kind === "list") {
        field.classList.add("detail-field-block");
        mountImageListEditor(field, {
          path: key,
          value,
          editable,
          mode: "list",
          comments,
          show: columnShowOf(key, columnMetas),
          apijsonBase: opts.apijsonBase,
          registerInput: (el) => {
            if (editable) inputs.set(key, el);
          },
        });
      } else if (detailImg.kind === "single" && !isComplex) {
        field.classList.add("detail-field-block");
        mountImageListEditor(field, {
          path: key,
          value,
          editable,
          mode: "single",
          comments,
          show: columnShowOf(key, columnMetas),
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
      } else if (editable && fkRef && opts.apijsonBase && !isComplex) {
        const host = document.createElement("div");
        const initialId =
          typeof value === "number" || typeof value === "string"
            ? value
            : null;
        fkValues.set(key, initialId);
        mountFkFieldControl(host, {
          path: key,
          table: fkRef.table,
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

      const authKind = isAuthVerifyField(key, comments);
      if (authKind && opts.apijsonBase) {
        const sourceEl = inputs.get(key);
        const fallback = cellText(value).trim();
        authVerifiers.push(
          mountAuthVerifyField(form, {
            path: key,
            kind: authKind,
            apijsonBase: opts.apijsonBase,
            verifyType: verifyTypeForWrite("put"),
            getTarget: () => {
              if (sourceEl) return String(sourceEl.value ?? "").trim();
              return fallback;
            },
          }),
        );
      }
    }
    fieldsHost.appendChild(form);
  }

    if (editableMode && writeFn) {
      const addRow = document.createElement("div");
      addRow.className = "detail-slots-add";
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "table-chip table-chip-add";
      addBtn.textContent = "+";
      addBtn.title = "Add another related table";
      addBtn.onclick = (e) => {
        e.stopPropagation();
        openAddTablePopover(
          addBtn,
          slots.map((s) => s.table),
          (table) => {
            const rel = defaultRelateForTable(
              table,
              primary || slots[0]?.table || null,
              columnMetas,
              opts.fkExpand,
            );
            slots.push({
              id: newDetailSlotId(),
              table,
              op: "post",
              relateTable: rel.relateTable || primary || undefined,
              relateField: rel.relateField || "id",
              localField: rel.localField || undefined,
              relateOp: rel.relateOp || "eq",
            });
            if (rel.localField && (rel.relateTable || primary)) {
              const p: RelateSyncPayload = {
                table,
                localField: rel.localField,
                onTable: rel.relateTable || primary!,
                onField: rel.relateField || "id",
                relateOp: rel.relateOp || "eq",
              };
              columnMetas = applyRelateToColumnMetas(columnMetas ?? {}, p);
              opts.onRelateSync?.(p);
            }
            ensureSchemasThenPaint();
          },
          comments,
        );
      };
      addRow.appendChild(addBtn);
      const hint = document.createElement("span");
      hint.className = "muted detail-slot-hint";
      hint.textContent =
        "Add tables to edit together. Set vice field =/in/contains relate table.field";
      addRow.appendChild(hint);
      fieldsHost.appendChild(addRow);
    }
  };

  modeToggle.onclick = () => {
    rawMode = !rawMode;
    modeToggle.textContent = rawMode ? t("result.smart") : t("result.raw");
    modeToggle.classList.toggle("is-raw", rawMode);
    paintFields();
  };
  ensureSchemasThenPaint();

  const actions = document.createElement("div");
  actions.className = "detail-form-actions";
  if (writeFn && primary && editableMode) {
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "primary";
    saveBtn.textContent = t("common.save");
    const flushPageLayout = () => {
      opts.onColumnMetasChange?.(columnMetas ?? {});
      opts.onDetailSlotsChange?.(slots.map((s) => ({ ...s })));
    };

    saveBtn.onclick = () => {
      void (async () => {
        if (!confirm(`Save changes to #${row.key}?`)) return;
        // Always persist page layout/config (slots, field show/hide, DDL)
        flushPageLayout();
        const verifyErr = await requireAuthVerifyCodes(
          authVerifiers,
          verifyTypeForWrite("put"),
        );
        if (verifyErr) {
          saveBtn.textContent = verifyErr.slice(0, 48);
          setTimeout(() => {
            saveBtn.textContent = t("common.save");
          }, 2200);
          return;
        }
        const edited: Record<string, string> = {};
        for (const [path, el] of inputs) edited[path] = el.value;
        for (const [path, id] of fkValues) {
          if (id == null) {
            saveBtn.textContent = `Select foreign key`;
            setTimeout(() => {
              saveBtn.textContent = t("common.save");
            }, 1400);
            return;
          }
          edited[path] = String(id);
        }
        const base = (opts.apijsonBase || "").replace(/\/+$/, "");
        if (base) {
          try {
            for (const [path, text] of Object.entries(edited)) {
              const img = resolveSmartImageField(
                path,
                text,
                comments,
                columnShowOf(path, columnMetas),
              );
              if (img.kind === "list") {
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
              } else if (img.kind === "single") {
                edited[path] = await ensureRemoteImageUrl(base, text);
              }
            }
          } catch (e) {
            saveBtn.textContent =
              e instanceof Error ? e.message.slice(0, 40) : "Upload failed";
            setTimeout(() => {
              saveBtn.textContent = t("common.save");
            }, 2000);
            return;
          }
        }

        const entities: Record<string, Record<string, unknown>> = {};
        for (const slot of slots) {
          if (slot.op === "get") {
            const id = row.cells[`${slot.table}.id`];
            if (id != null && id !== "") entities[slot.table] = { id };
            else entities[slot.table] = {};
            continue;
          }
          if (slot.op === "delete") {
            const id = row.cells[`${slot.table}.id`];
            if (id != null && id !== "") entities[slot.table] = { id };
            continue;
          }
          const entity: Record<string, unknown> = {};
          if (slot.op === "put") {
            const id = row.cells[`${slot.table}.id`];
            if (id != null && id !== "") entity.id = id;
          }
          const prefix = `${slot.table}.`;
          for (const [path, text] of Object.entries(edited)) {
            if (!path.startsWith(prefix)) continue;
            if (!isDetailFieldVisible(path, columnMetas)) continue;
            const col = path.slice(prefix.length);
            if (!col || isDetailReadonlyCol(col)) continue;
            entity[col] = coerceField(row.cells[path], text, path);
          }
          for (const [path, id] of fkValues) {
            if (!path.startsWith(prefix) || id == null) continue;
            if (!isDetailFieldVisible(path, columnMetas)) continue;
            const col = path.slice(prefix.length);
            entity[col] = id;
          }
          // Include unchanged id-only put from original when no edits on primary
          if (slot.op === "put" && Object.keys(entity).length <= 1) {
            const putOne = buildPutFromDetail(row, edited);
            if (putOne && putOne.table === slot.table) {
              const e = putOne.body[slot.table];
              if (e && typeof e === "object") {
                const filtered: Record<string, unknown> = {};
                for (const [col, val] of Object.entries(
                  e as Record<string, unknown>,
                )) {
                  if (
                    col === "id" ||
                    isDetailFieldVisible(`${slot.table}.${col}`, columnMetas)
                  ) {
                    filtered[col] = val;
                  }
                }
                entities[slot.table] = filtered;
                continue;
              }
            }
          }
          if (Object.keys(entity).length) entities[slot.table] = entity;
        }

        const writeSlots = slots.filter((s) => {
          if (s.op === "get") return slots.length > 1;
          return entities[s.table] != null;
        });
        const payload = buildCrudPayload({
          slots: writeSlots.length ? writeSlots : slots,
          entities,
          columnMetas,
        });
        if (!payload) {
          // Layout already flushed — no record field changes
          saveBtn.textContent = t("common.saved");
          setTimeout(() => {
            saveBtn.textContent = t("common.save");
          }, 1200);
          return;
        }
        attachAuthVerifyToWritePayload(
          payload,
          pickAuthVerifyCode(authVerifiers),
        );
        void writeFn(payload);
      })();
    };
    actions.appendChild(saveBtn);
  }
  if (opts.onDelete) {
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "danger";
    delBtn.textContent = t("common.delete");
    delBtn.onclick = () => {
      void (async () => {
        if (
          !confirm(
            `Delete ${primary || ""} #${row.key}? This cannot be undone.`,
          )
        ) {
          return;
        }
        const verifyErr = await requireAuthVerifyCodes(
          authVerifiers,
          verifyTypeForWrite("delete"),
        );
        if (verifyErr) {
          delBtn.textContent = verifyErr.slice(0, 40);
          setTimeout(() => {
            delBtn.textContent = t("common.delete");
          }, 2200);
          return;
        }
        opts.onDelete?.();
      })();
    };
    actions.appendChild(delBtn);
  }
  if (actions.childNodes.length) card.appendChild(actions);

  container.appendChild(card);
}

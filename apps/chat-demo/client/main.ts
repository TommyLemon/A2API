import { applyDomI18n, mountLocaleToggle, t } from "./i18n/index.js";
import {
  inferPrimaryTable,
  mountCreateView,
  mountWorkspaceGuide,
  parseResponse,
  renderResultView,
  triggerListCreate,
  type ChartDimension,
  type ColumnMeta,
  type DisplayKind,
  type RelateSyncPayload,
  type SchemaComments,
  type TableDdlApplyPayload,
  type ViewMode,
  type WritePayload,
} from "./result-view.js";
import {
  applyRelateToColumnMetas,
  mergeStructureForApply,
} from "./detail-crud.js";
import { formatColumnReturnToken } from "./field-meta.js";
import {
  applyPaging,
  applyTableQuery,
  buildDefaultFieldCombine,
  cycleSort,
  filterHasValue,
  newConditionId,
  type ColumnFilter,
  type ColumnSort,
} from "./table-query.js";
import { applyTableJoins, type JoinOp } from "./join-query.js";
import {
  applyFkExpand,
  defaultFkExpandState,
  fkEdgesFor,
  syncFkExpandFromBody,
  type FkJoinSpec,
} from "./fk-expand.js";
import {
  addQueryTable,
  removeQueryTable,
  setPrimaryTable,
} from "./query-tables.js";
import { initDataPanel, type DataPanelApi } from "./data-panel.js";
import { initAdminPanel } from "./admin-panel.js";
import { ensureAccessRoles, withRequestRole } from "./access-roles.js";
import { isApplyTriggerIssue } from "./permission-check.js";
import { reloadRequestStructures } from "./request-structures.js";
import { stripPostIds, stripWriteUserIds } from "./owner-body.js";
import {
  buildVerifyApplyStructure,
  prioritizeVerifyInBody,
  prioritizeVerifyInStructure,
  resolvePhoneEmailTable,
} from "./verify-code.js";
import { mountVerticalSplit } from "./split-resize.js";

import {
  inferBodyTable,
  loadWriteTemplate,
  mergeWriteTemplate,
  type WriteMethod,
} from "./write-templates.js";
import {
  isAdminUser,
  loadAccount,
  loadSettings,
  llmConfigForApi,
  logoutIfApijsonAuthFailed,
  mountAccountUi,
  saveSettings,
} from "./account.js";
import {
  APIJSON_BROWSER_BASE,
  isLegacyDirectApijsonBase,
  toBrowserApijsonUrl,
} from "./aj-base.js";
import { withApijsonAuth } from "./aj-auth.js";
import type { DetailTableSlot } from "./detail-crud.js";
import {
  addPageVersion,
  deletePageVersion,
  deleteSavedPage,
  formatVersionOption,
  formatVersionShort,
  getActivePageRef,
  getPageVersion,
  getSavedPage,
  getSavedPageThumb,
  listSavedPages,
  normalizePageIdentity,
  renameSavedPage,
  requestTagFromPageTitle,
  setActivePageRef,
  slugPageTitle,
  updatePageVersion,
  type PageKind,
  type SavedPage,
  type SavedPageSnapshot,
} from "./saved-pages.js";
import {
  cancelPageThumbCapture,
  captureAndSavePageThumb,
  capturePageThumbAfterSwitch,
  schedulePageThumbCapture,
  setPageThumbSavedHandler,
} from "./page-thumb.js";

applyDomI18n();
mountLocaleToggle();
document.title = t("meta.title");

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

/** Admin tab is vendor-admin only — never show chat/workspace there. */
function syncAdminAccess() {
  const adminBtn = document.querySelector<HTMLButtonElement>(
    ".main-tab[data-tab='admin']",
  );
  const allowed = isAdminUser();
  if (adminBtn) {
    adminBtn.classList.toggle("hidden", !allowed);
    adminBtn.hidden = !allowed;
  }
  const adminPane = $("tab-admin");
  if (!allowed && adminPane && !adminPane.classList.contains("hidden")) {
    switchTab("ui");
  }
}

// Mount account chrome first so Login/Settings always appear even if other init fails
mountAccountUi({
  headerEl: document.querySelector(".top") as HTMLElement,
  onAccountChange: () => syncAdminAccess(),
  onSettingsChange: (s) => {
    apijsonBaseUrl = s.apijsonBaseUrl || apijsonBaseUrl;
  },
});

const dataPanel: DataPanelApi = initDataPanel($("tab-data"));

{
  const uiTab = $("tab-ui");
  const uiHandle = document.getElementById("ui-split-handle");
  if (uiHandle) {
    mountVerticalSplit({
      split: uiTab,
      handle: uiHandle,
      cssVar: "--ui-chat-pct",
      storageKey: "a2api.uiChatSplitPct",
      defaultPct: 42,
      minPct: 18,
      maxPct: 72,
      bodyClass: "is-resizing-ui",
    });
  }
}
const adminPanel = initAdminPanel($("tab-admin"));

/** Sync Agent / UI traffic into Data tab (APIAuto-like debugger). */
function syncDataPanel(opts: {
  method?: string;
  url?: string;
  json?: unknown;
  response?: unknown;
  autoSend?: boolean;
  useApiAuto?: boolean;
}) {
  const method = (opts.method || "POST").toUpperCase();
  void dataPanel.agentDebug({
    method,
    url: opts.url,
    json: opts.json,
    send: Boolean(opts.autoSend),
    useApiAuto: opts.useApiAuto,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
  if (opts.response !== undefined && !opts.autoSend) {
    dataPanel.fill({ response: opts.response });
  }
}

function switchTab(tab: "ui" | "data" | "admin") {
  if (tab === "admin" && !isAdminUser()) {
    tab = "ui";
  }
  const ui = $("tab-ui");
  const data = $("tab-data");
  const admin = $("tab-admin");
  const show = (el: HTMLElement, on: boolean) => {
    el.classList.toggle("hidden", !on);
    el.hidden = !on;
    el.setAttribute("aria-hidden", String(!on));
  };
  // Force exclusive panes — never leave UI visible under Admin
  show(ui, tab === "ui");
  show(data, tab === "data");
  show(admin, tab === "admin");
  for (const btn of Array.from(
    document.querySelectorAll<HTMLButtonElement>(".main-tab"),
  )) {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  }
  if (tab === "admin") void adminPanel.refresh();
}

for (const btn of Array.from(
  document.querySelectorAll<HTMLButtonElement>(".main-tab"),
)) {
  btn.onclick = () =>
    switchTab((btn.dataset.tab as "ui" | "data" | "admin") || "ui");
}

syncAdminAccess();

// Expose for Agent / console automation
(window as unknown as { a2apiAgent: unknown }).a2apiAgent = {
  switchTab,
  fillData: dataPanel.fill,
  sendData: dataPanel.send,
  debug: dataPanel.agentDebug,
  loadApiAuto: dataPanel.loadApiAuto,
  refreshApprovals: adminPanel.refresh,
};

type FilterDef = {
  key: string;
  label: string;
  type: "text" | "number" | "select";
  options?: string[];
};

type SessionUi = {
  sessionId: string | null;
  pendingRequestId: string | null;
  filters: FilterDef[];
  hasBind: boolean;
  viewMode: ViewMode;
  comments: SchemaComments | null;
  awaitingWrite: boolean;
  columnSorts: ColumnSort[];
  columnFilters: ColumnFilter[];
  /** Cross-field combine expr, e.g. `date & (name | tag)` */
  filterCombineExpr: string;
  /** Secondary table → JOIN op for APIJSON `[]`.join */
  tableJoins: Record<string, JoinOp>;
  /** FK table expand: which related tables/columns to pull */
  fkExpand: Record<string, FkJoinSpec>;
  columnOrder: string[];
  columnMetas: Record<string, ColumnMeta>;
  displayKind: DisplayKind;
  chartLabelPath: string;
  /** @deprecated migrated into chartFieldValues */
  chartValuePath: string;
  chartDimensions: ChartDimension[];
  chartFieldColors: Record<string, string>;
  /** category field path → serialized value spec */
  chartFieldValues: Record<string, string>;
  combinedShowTable: boolean;
  lastResponse: unknown;
  /** Prefill for Add form (e.g. Create moment with content "…") */
  createInitialValues: Record<string, unknown> | null;
  bindMeta: {
    url: string;
    method: string;
    bodyTemplate: Record<string, unknown>;
  } | null;
  /** Saved generated page id (surfaceId) + active version */
  activePageId: string | null;
  activeVersion: number | null;
  pageTitle: string;
  /** list | detail | create — create pages restore via mountCreateView */
  pageKind: PageKind;
  /** Multi-table detail/create slots (persisted for pages like register) */
  detailSlots: DetailTableSlot[];
  /** Remember list page when drilling into an independent detail page */
  listPageRef: { pageId: string; version: number; title: string } | null;
};

const state: SessionUi = {
  sessionId: null,
  pendingRequestId: null,
  filters: [],
  hasBind: false,
  viewMode: "list",
  comments: null,
  awaitingWrite: false,
  columnSorts: [],
  columnFilters: [],
  filterCombineExpr: "",
  tableJoins: {},
  fkExpand: {},
  columnOrder: [],
  columnMetas: {},
  displayKind: "table",
  chartLabelPath: "",
  chartValuePath: "",
  chartDimensions: [],
  chartFieldColors: {},
  chartFieldValues: {},
  combinedShowTable: true,
  lastResponse: null,
  createInitialValues: null,
  bindMeta: null,
  activePageId: null,
  activeVersion: null,
  pageTitle: "",
  pageKind: "list",
  detailSlots: [],
  listPageRef: null,
};

function syncCombineExprAfterFilterChange(prevFilters: ColumnFilter[]) {
  const prevDefault = buildDefaultFieldCombine(prevFilters);
  const nextDefault = buildDefaultFieldCombine(state.columnFilters);
  if (
    !state.filterCombineExpr.trim() ||
    state.filterCombineExpr.trim() === prevDefault
  ) {
    state.filterCombineExpr = nextDefault;
  }
  if (!state.columnFilters.some(filterHasValue)) {
    state.filterCombineExpr = "";
  }
}

let apijsonBaseUrl =
  loadSettings().apijsonBaseUrl || APIJSON_BROWSER_BASE;

/** Credentials so the Node server can open an APIJSON OWNER session. */
function apijsonAuthPayload():
  | { login: string; password: string; userId?: string | number }
  | undefined {
  const u = loadAccount();
  if (!u?.password) return undefined;
  const login = (u.login || u.name || "").trim();
  if (!login) return undefined;
  return {
    login,
    password: u.password,
    ...(u.userId != null ? { userId: u.userId } : {}),
  };
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const auth = apijsonAuthPayload();
  const payload =
    body && typeof body === "object" && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>), ...(auth ? { apijsonAuth: auth } : {}) }
      : body;
  const res = await fetch(path, {
    method: payload !== undefined ? "POST" : "GET",
    headers:
      payload !== undefined
        ? { "Content-Type": "application/json" }
        : undefined,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data as T;
}

function addMessage(role: "user" | "assistant", content: string) {
  const box = $("messages");
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  el.textContent = content;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function renderRows(response: unknown) {
  state.lastResponse = response;
  const ui = readUi();
  renderResultView($("result-view"), {
    response,
    viewMode: state.viewMode,
    page: Number(ui.page ?? 0),
    count: Number(ui.count ?? 0),
    comments: state.comments,
    sorts: state.columnSorts,
    filters: state.columnFilters,
    filterCombineExpr: state.filterCombineExpr,
    columnOrder: state.columnOrder,
    columnMetas: state.columnMetas,
    displayKind: state.displayKind,
    chartLabelPath: state.chartLabelPath || undefined,
    chartValuePath: state.chartValuePath || undefined,
    chartDimensions: state.chartDimensions,
    chartFieldColors: state.chartFieldColors,
    chartFieldValues: state.chartFieldValues,
    combinedShowTable: state.combinedShowTable,
    onSortCycle: (path) => {
      state.columnSorts = cycleSort(state.columnSorts, path);
      void bound("sort_change");
    },
    onFilterApply: (filter, path) => {
      const prev = state.columnFilters.map((f) => ({
        ...f,
        conditions: f.conditions.map((c) => ({ ...c })),
      }));
      state.columnFilters = state.columnFilters.filter((f) => f.path !== path);
      if (filter) state.columnFilters.push(filter);
      syncCombineExprAfterFilterChange(prev);
      void bound("filter_change");
    },
    onCombineExprChange: (expr) => {
      state.filterCombineExpr = expr.trim();
      void bound("filter_change");
    },
    onColumnOrderChange: (order) => {
      state.columnOrder = order;
      renderRows(state.lastResponse);
    },
    onColumnMetasChange: (metas) => {
      state.columnMetas = metas;
      // drop filters/sorts on columns that lost those capabilities
      state.columnFilters = state.columnFilters.filter(
        (f) => metas[f.path]?.filterable !== false,
      );
      state.columnSorts = state.columnSorts.filter(
        (s) => metas[s.path]?.sortable !== false,
      );
      persistCurrentPageVersion();
      // Detail/create already re-paints in place — remounting would wipe the form
      const detailHost = document.querySelector("#result-detail-host");
      const detailOpen =
        detailHost instanceof HTMLElement &&
        !detailHost.classList.contains("hidden");
      if (!detailOpen) renderRows(state.lastResponse);
    },
    onDisplayKindChange: (kind) => {
      state.displayKind = kind;
      renderRows(state.lastResponse);
    },
    onChartConfigChange: (
      dimensions,
      fieldValues,
      combinedShowTable,
      fieldColors,
    ) => {
      state.chartDimensions = dimensions;
      state.chartFieldValues = fieldValues;
      state.chartValuePath = "";
      state.chartLabelPath = dimensions[0]?.fields[0] ?? "";
      if (combinedShowTable !== undefined) {
        state.combinedShowTable = combinedShowTable;
      }
      if (fieldColors) state.chartFieldColors = fieldColors;
      renderRows(state.lastResponse);
    },
    onChartAggregate: (info) => {
      if (!info.ok || !Object.keys(info.body).length) return;
      syncDataPanel({
        method: "POST",
        url: `${apijsonBaseUrl}/get`,
        json: info.body,
        response: info.response,
      });
    },
    tableJoins: state.tableJoins,
    onJoinChange: (table, op) => {
      if (op) state.tableJoins[table] = op;
      else delete state.tableJoins[table];
      void bound("join_change");
    },
    fkExpand: state.fkExpand,
    onTableDdlApply: (payload: TableDdlApplyPayload) => {
      if (!state.bindMeta) return;
      const primary = inferPrimaryTable([], state.bindMeta.bodyTemplate);
      // Keep existing JOIN tables enabled so applyFkExpand won't strip them
      state.fkExpand = syncFkExpandFromBody(
        state.bindMeta.bodyTemplate,
        primary,
        state.fkExpand,
      );
      const body = structuredClone(state.bindMeta.bodyTemplate);
      const list = body["[]"];
      if (!list || typeof list !== "object" || Array.isArray(list)) return;
      const listObj = list as Record<string, unknown>;
      const tableObj = (
        listObj[payload.table] &&
        typeof listObj[payload.table] === "object" &&
        !Array.isArray(listObj[payload.table])
          ? { ...(listObj[payload.table] as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;

      for (const [path, patch] of Object.entries(payload.fieldMetas)) {
        const prev = state.columnMetas[path];
        state.columnMetas[path] = {
          ...(prev ?? {
            path,
            type: "text" as const,
            visible: true,
            filterable: true,
            sortable: true,
          }),
          ...patch,
          path,
        };
      }

      const columnTokens = payload.selectedColumns.map((col) => {
        const meta = payload.fieldMetas[`${payload.table}.${col}`];
        return formatColumnReturnToken(
          col,
          meta?.returnAgg ?? "data",
          meta?.returnExpr,
        );
      });

      if (payload.table === primary) {
        if (columnTokens.length) {
          // Always keep PK id in @column (UI may hide it) so row→detail has a real id
          const withId = [...new Set(["id", ...payload.selectedColumns])];
          tableObj["@column"] = withId
            .map((col) => {
              const meta = payload.fieldMetas[`${payload.table}.${col}`];
              return formatColumnReturnToken(
                col,
                meta?.returnAgg ?? "data",
                meta?.returnExpr,
              );
            })
            .join(",");
        } else {
          delete tableObj["@column"];
        }
        listObj[payload.table] = tableObj;
      } else {
        // Infer ON from payload, existing id@, or known FK edge
        let onTable = payload.onTable || "";
        let onField = payload.onField || "";
        if ((!onTable || !onField) && typeof tableObj["id@"] === "string") {
          const parts = String(tableObj["id@"]).replace(/^\//, "").split("/");
          if (parts.length >= 2) {
            onTable = onTable || parts[0] || "";
            onField = onField || parts[1] || "";
          }
        }
        if ((!onTable || !onField) && primary) {
          const edge = fkEdgesFor(primary).find(
            (e) => e.target === payload.table,
          );
          if (edge) {
            onTable = onTable || primary;
            onField = onField || edge.column;
          }
        }

        state.fkExpand[payload.table] = {
          enabled: payload.selectedColumns.length > 0,
          columns: [...payload.selectedColumns],
          onTable: onTable || undefined,
          onField: onField || undefined,
        };
        if (payload.joinOp) state.tableJoins[payload.table] = payload.joinOp;
        else delete state.tableJoins[payload.table];

        if (!payload.selectedColumns.length) {
          delete listObj[payload.table];
        } else {
          if (onTable && onField) {
            tableObj["id@"] = `/${onTable}/${onField}`;
          }
          tableObj["@column"] = columnTokens.join(",");
          listObj[payload.table] = tableObj;
        }
      }

      state.bindMeta.bodyTemplate = applyFkExpand(
        body,
        primary,
        state.fkExpand,
      );
      // applyFkExpand rewrites JOIN @column with bare names — restore Return tokens
      if (payload.table !== primary && columnTokens.length) {
        const listAfter = state.bindMeta.bodyTemplate["[]"];
        if (
          listAfter &&
          typeof listAfter === "object" &&
          !Array.isArray(listAfter)
        ) {
          const tObj = (listAfter as Record<string, unknown>)[payload.table];
          if (tObj && typeof tObj === "object" && !Array.isArray(tObj)) {
            const withId = [
              ...new Set(["id", ...payload.selectedColumns]),
            ];
            (tObj as Record<string, unknown>)["@column"] = withId
              .map((col) => {
                const meta = state.columnMetas[`${payload.table}.${col}`];
                return formatColumnReturnToken(
                  col,
                  meta?.returnAgg ?? "data",
                  meta?.returnExpr,
                );
              })
              .join(",");
          }
        }
      }
      // displayName / visibility meta apply without waiting for network
      if (state.lastResponse != null) renderRows(state.lastResponse);
      void bound("ddl_change");
    },
    onAddQueryTable: (table) => {
      if (!state.bindMeta) return;
      const primary = inferPrimaryTable([], state.bindMeta.bodyTemplate);
      const { body, fkExpandPatch } = addQueryTable(
        state.bindMeta.bodyTemplate,
        table,
        primary,
      );
      state.bindMeta.bodyTemplate = body;
      state.fkExpand = { ...state.fkExpand, ...fkExpandPatch };
      state.columnOrder = [];
      state.columnMetas = {};
      void bound("tables_change");
    },
    onRemoveQueryTable: (table) => {
      if (!state.bindMeta) return;
      const { body, newPrimary } = removeQueryTable(
        state.bindMeta.bodyTemplate,
        table,
      );
      state.bindMeta.bodyTemplate = body;
      delete state.fkExpand[table];
      delete state.tableJoins[table];
      if (newPrimary) {
        state.fkExpand = {
          ...defaultFkExpandState(newPrimary),
          ...state.fkExpand,
        };
        state.bindMeta.bodyTemplate = applyFkExpand(
          state.bindMeta.bodyTemplate,
          newPrimary,
          state.fkExpand,
        );
      }
      state.columnOrder = [];
      state.columnMetas = {};
      void bound("tables_change");
    },
    onSetPrimaryTable: (table) => {
      if (!state.bindMeta) return;
      const { body, fkExpand } = setPrimaryTable(
        state.bindMeta.bodyTemplate,
        table,
        state.fkExpand,
      );
      state.bindMeta.bodyTemplate = body;
      state.fkExpand = fkExpand;
      state.columnOrder = [];
      state.columnMetas = {};
      void bound("tables_change");
    },
    onBackToList: () => {
      void returnToListPage();
    },
    onOpenDetail: (info) => {
      activateIndependentPage({
        table: info.table,
        kind: info.create ? "create" : "detail",
        id: info.id,
        drillFromList: true,
      });
      renderFilters(state.filters);
      // Fresh slots for this navigation (table + Add/Edit) — not stale list state
      return state.detailSlots.map((s) => structuredClone(s));
    },
    onOpenFkList: (info) => {
      void openFkTableFiltered(info);
    },
    // Generated UI CRUD → reliable APIJSON only (no AI / HITL propose)
    onWrite: (payload) => void executeWriteDirect(payload),
    onRelateSync: (payload: RelateSyncPayload) => {
      syncRelateFromDetail(payload);
    },
    pageTitle: state.pageTitle,
    detailSlots: state.detailSlots,
    onPageTitleChange: (title) => commitPageTitle(title),
    onDetailSlotsChange: (slots) => {
      state.detailSlots = slots;
      persistCurrentPageVersion();
    },
    primaryTable: inferPrimaryTable(
      [],
      state.bindMeta?.bodyTemplate ?? null,
    ),
    bodyTemplate: state.bindMeta?.bodyTemplate ?? null,
    apijsonBaseUrl,
    createInitialValues: state.createInitialValues,
  });
}

/** Back from detail → list page (independent page identity). */
async function returnToListPage() {
  // Persist create/detail layout BEFORE clearing in-memory slots/kind.
  // switchToSavedPage also persists first — if we wipe state here, that
  // write would empty Register User / forked pages in localStorage.
  persistCurrentPageVersion();
  const ref = state.listPageRef;
  state.listPageRef = null;
  state.viewMode = "list";
  state.pageKind = "list";
  state.detailSlots = [];
  if (ref) {
    // Already persisted above; skipPersist so wiped slots aren't written back
    await switchToSavedPage(ref.pageId, ref.version, { skipPersist: true });
    return;
  }
  // Already on a list bind — just refresh chrome title
  const primary = inferPrimaryTable([], state.bindMeta?.bodyTemplate ?? null);
  if (primary && state.hasBind) {
    const { title } = normalizePageIdentity({
      table: primary,
      kind: "list",
      surfaceId: state.activePageId,
      title: state.pageTitle,
    });
    syncPageTitleInput(title);
    void bound("refresh");
    return;
  }
  if (state.hasBind) void bound("refresh");
  else mountWorkspaceGuide($("result-view"));
}

/**
 * FK id-list link → related table list, filtered by id (eq or IN).
 * e.g. Moment.praiseUserIdList [12,34] → User List where id ∈ {12,34}.
 */
async function openFkTableFiltered(info: {
  table: string;
  ids: Array<string | number>;
  field?: string;
}) {
  const table = info.table.trim();
  const field = (info.field || "id").trim() || "id";
  const ids = info.ids.filter(
    (id) =>
      (typeof id === "number" && Number.isFinite(id)) ||
      (typeof id === "string" && /^-?\d+$/.test(id.trim())),
  );
  if (!table || !ids.length) return;

  persistCurrentPageVersion();
  state.listPageRef = null;
  state.detailSlots = [];
  state.viewMode = "list";
  state.pageKind = "list";

  const { surfaceId, title } = normalizePageIdentity({
    table,
    kind: "list",
  });
  const existing = getSavedPage(surfaceId);
  const latest = existing?.versions.length
    ? existing.versions.reduce((a, b) => (a.version >= b.version ? a : b))
    : null;

  const ui = readUi();
  const count = normalizePageCount(ui.count ?? DEFAULT_PAGE_COUNT);

  if (
    latest?.bindMeta?.bodyTemplate &&
    bodyLooksLikeListQuery(latest.bindMeta.bodyTemplate)
  ) {
    state.activePageId = surfaceId;
    applyPageSnapshot(latest, existing!.title || title);
    setActivePageRef({ pageId: surfaceId, version: latest.version });
  } else {
    state.hasBind = true;
    state.bindMeta = {
      url: `${apijsonBaseUrl.replace(/\/+$/, "")}/get`,
      method: "get",
      bodyTemplate: {
        "[]": {
          count,
          page: 0,
          [table]: {},
        },
      },
    };
    state.fkExpand = defaultFkExpandState(table);
    state.bindMeta.bodyTemplate = applyFkExpand(
      state.bindMeta.bodyTemplate,
      table,
      state.fkExpand,
    );
    state.columnSorts = [];
    state.columnOrder = [];
    state.columnMetas = {};
    state.tableJoins = {};
    state.displayKind = "table";
    state.chartLabelPath = "";
    state.chartValuePath = "";
    state.chartDimensions = [];
    state.chartFieldColors = {};
    state.chartFieldValues = {};
    state.combinedShowTable = true;
    state.filterCombineExpr = "";
    saveGeneratedPage(surfaceId, title, [
      { key: "page", label: "Page", type: "number" },
      { key: "count", label: "Count", type: "number" },
    ]);
  }

  // Ensure PK id is filterable/visible so the active filter shows in the header
  const idPath = `${table}.${field}`;
  const prevMeta = state.columnMetas[idPath];
  state.columnMetas = {
    ...state.columnMetas,
    [idPath]: {
      path: idPath,
      type: prevMeta?.type ?? "number",
      show: prevMeta?.show ?? "auto",
      visible: true,
      filterable: true,
      sortable: prevMeta?.sortable ?? true,
      ...(prevMeta?.displayName
        ? { displayName: prevMeta.displayName }
        : {}),
      ...(prevMeta?.onTable ? { onTable: prevMeta.onTable } : {}),
      ...(prevMeta?.onField ? { onField: prevMeta.onField } : {}),
    },
  };

  state.columnFilters = [
    {
      path: idPath,
      conditions: [
        {
          id: newConditionId(),
          op: ids.length === 1 ? "eq" : "in",
          value: ids.join(","),
          join: "and",
          not: false,
        },
      ],
    },
  ];
  state.filterCombineExpr = "";

  syncPageTitleInput(state.pageTitle || title);
  renderFilters(state.filters);
  setUi({ ...readUi(), page: 0, count });
  await bound("search");
}

/** Detail ↔ Table DDL: same onTable/onField store (no remount). */
function syncRelateFromDetail(payload: RelateSyncPayload) {
  state.columnMetas = applyRelateToColumnMetas(state.columnMetas, payload);
  const prev = state.fkExpand[payload.table];
  if (prev) {
    state.fkExpand[payload.table] = {
      ...prev,
      onTable: payload.onTable || undefined,
      onField: payload.onField || undefined,
    };
  }
  // Keep list JOIN id@ in sync when this table is already in the query
  const body = state.bindMeta?.bodyTemplate;
  if (body && typeof body["[]"] === "object" && body["[]"] && !Array.isArray(body["[]"])) {
    const list = body["[]"] as Record<string, unknown>;
    const tableObj = list[payload.table];
    if (
      tableObj &&
      typeof tableObj === "object" &&
      !Array.isArray(tableObj) &&
      payload.onTable &&
      payload.onField
    ) {
      (tableObj as Record<string, unknown>)["id@"] =
        `/${payload.onTable}/${payload.onField}`;
    }
  }
}

const PAGE_COUNT_OPTIONS = [5, 10, 15, 20, 50, 100] as const;
const DEFAULT_PAGE_COUNT = 20;

function normalizePageCount(n: unknown): number {
  const num = Number(n);
  if (
    Number.isFinite(num) &&
    (PAGE_COUNT_OPTIONS as readonly number[]).includes(num)
  ) {
    return num;
  }
  return DEFAULT_PAGE_COUNT;
}

function capturePageSnapshot(): Omit<
  SavedPageSnapshot,
  "version" | "createdAt"
> | null {
  if (!state.bindMeta) return null;
  return {
    viewMode: state.viewMode,
    pageKind: state.pageKind,
    detailSlots: state.detailSlots.length
      ? structuredClone(state.detailSlots)
      : undefined,
    filters: state.filters.length
      ? state.filters
      : [
          { key: "page", label: "Page", type: "number" },
          { key: "count", label: "Count", type: "number" },
        ],
    bindMeta: {
      url: state.bindMeta.url,
      method: state.bindMeta.method,
      bodyTemplate: structuredClone(state.bindMeta.bodyTemplate),
    },
    columnSorts: structuredClone(state.columnSorts),
    columnFilters: structuredClone(state.columnFilters),
    filterCombineExpr: state.filterCombineExpr,
    tableJoins: structuredClone(state.tableJoins),
    fkExpand: structuredClone(state.fkExpand),
    columnOrder: [...state.columnOrder],
    columnMetas: structuredClone(state.columnMetas),
    displayKind: state.displayKind,
    chartLabelPath: state.chartLabelPath,
    chartValuePath: state.chartValuePath,
    chartDimensions: structuredClone(state.chartDimensions),
    chartFieldColors: { ...state.chartFieldColors },
    chartFieldValues: { ...state.chartFieldValues },
    combinedShowTable: state.combinedShowTable,
    ui: readUi(),
  };
}

/** Sync page title input without remounting the whole filters bar. */
function syncPageTitleInput(title: string) {
  state.pageTitle = title;
  const input = document.getElementById(
    "page-title-input",
  ) as HTMLInputElement | null;
  if (input) input.value = title;
}

/**
 * Point chrome at an independent detail/create page (never share List's bare table id).
 * - drillFromList: keep list bind for Back; only switch title / page id chrome
 * - otherwise: persist a detail/create page shell (chat open create/detail)
 */
function activateIndependentPage(opts: {
  table: string;
  kind: Exclude<PageKind, "list">;
  id?: string | number | null;
  title?: string;
  surfaceId?: string;
  bodyTemplate?: Record<string, unknown> | null;
  /** Row click from a list — don't replace list bindMeta */
  drillFromList?: boolean;
}) {
  const { surfaceId, title } = normalizePageIdentity({
    table: opts.table,
    kind: opts.kind,
    surfaceId: opts.surfaceId,
    title: opts.title,
    id: opts.id,
  });

  // Capture list page before switching — even if viewMode already flipped to detail
  if (
    !state.listPageRef &&
    state.activePageId &&
    state.activeVersion != null &&
    (/_list$/i.test(state.activePageId) || state.viewMode === "list")
  ) {
    state.listPageRef = {
      pageId: state.activePageId,
      version: state.activeVersion,
      title: state.pageTitle,
    };
    persistCurrentPageVersion();
  }

  state.viewMode = "detail";
  state.pageKind = opts.kind;
  /** Add only for create; list/grid → detail defaults to Edit (put). */
  const primaryOp = opts.kind === "create" ? "post" : "put";
  const seedSlot = (): DetailTableSlot => ({
    id: `dt_${opts.table}`,
    table: opts.table,
    op: primaryOp,
  });

  /** Keep multi-table layout only when primary table matches; force primary op. */
  const slotsForPage = (
    saved: DetailTableSlot[] | undefined,
  ): DetailTableSlot[] => {
    if (saved?.length && saved[0]?.table === opts.table) {
      return saved.map((s, i) => {
        const next = structuredClone(s);
        if (i === 0) {
          next.table = opts.table;
          next.op = primaryOp;
        }
        return next;
      });
    }
    return [seedSlot()];
  };

  if (opts.drillFromList) {
    // Title + active page id only — list bind stays for Back / refresh
    state.activePageId = surfaceId;
    const existing = getSavedPage(surfaceId);
    const latest = existing?.versions[0];
    state.activeVersion = latest?.version ?? null;
    setActivePageRef(
      latest
        ? { pageId: surfaceId, version: latest.version }
        : null,
    );
    state.detailSlots = slotsForPage(latest?.detailSlots);
    // Restore detail layout/config (not the list page's column metas)
    if (latest?.columnMetas && Object.keys(latest.columnMetas).length) {
      state.columnMetas = structuredClone(latest.columnMetas);
    }
    if (latest?.columnOrder?.length) {
      state.columnOrder = [...latest.columnOrder];
    }
    if (latest?.fkExpand && Object.keys(latest.fkExpand).length) {
      state.fkExpand = structuredClone(latest.fkExpand);
    }
    // Ensure Detail appears in the page menu once (lightweight shell)
    if (!existing) {
      const listBind = state.bindMeta;
      state.bindMeta = {
        url: `${apijsonBaseUrl.replace(/\/+$/, "")}/get`,
        method: "get",
        bodyTemplate:
          opts.id != null && String(opts.id) !== ""
            ? { [opts.table]: { id: opts.id } }
            : { [opts.table]: {} },
      };
      const snap = capturePageSnapshot();
      if (snap) {
        const { page, snapshot } = addPageVersion(surfaceId, title, {
          ...snap,
          pageKind: opts.kind,
          viewMode: "detail",
        });
        state.activePageId = page.id;
        state.activeVersion = snapshot.version;
        schedulePageThumbCapture(page.id);
      }
      state.bindMeta = listBind;
    }
    syncPageTitleInput(title);
    renderFilters(state.filters);
    return;
  }

  state.detailSlots = slotsForPage(
    getSavedPage(surfaceId)?.versions[0]?.detailSlots,
  );

  const stubBody =
    opts.bodyTemplate && Object.keys(opts.bodyTemplate).length
      ? structuredClone(opts.bodyTemplate)
      : opts.id != null && String(opts.id) !== ""
        ? { [opts.table]: { id: opts.id } }
        : { [opts.table]: {} };

  state.bindMeta = {
    url: `${apijsonBaseUrl.replace(/\/+$/, "")}/get`,
    method: "get",
    bodyTemplate: stubBody,
  };
  state.hasBind = false;
  const snap = capturePageSnapshot();
  if (snap) {
    const { page, snapshot } = addPageVersion(surfaceId, title, {
      ...snap,
      viewMode: "detail",
      pageKind: opts.kind,
    });
    state.activePageId = page.id;
    state.activeVersion = snapshot.version;
    schedulePageThumbCapture(page.id);
  }
  syncPageTitleInput(title);
  renderFilters(state.filters);
}

/** List bind uses `[]` — must not be written onto detail/create page snapshots. */
function bodyLooksLikeListQuery(body: Record<string, unknown>): boolean {
  const arr = body["[]"];
  return arr != null && typeof arr === "object" && !Array.isArray(arr);
}

function detailBindStub(
  table: string,
  id?: string | number | null,
): SavedPageSnapshot["bindMeta"] {
  return {
    url: `${apijsonBaseUrl.replace(/\/+$/, "")}/get`,
    method: "get",
    bodyTemplate:
      id != null && String(id) !== ""
        ? { [table]: { id } }
        : { [table]: {} },
  };
}

function persistCurrentPageVersion(opts?: { captureThumb?: boolean }) {
  if (!state.activePageId || state.activeVersion == null) return;
  if (!state.bindMeta) ensureBindForSnapshot();
  if (!state.bindMeta) return;
  const snap = capturePageSnapshot();
  if (!snap) return;

  const existing = getPageVersion(state.activePageId, state.activeVersion);

  // Drilled detail/create keeps list bindMeta in memory for Back — snapshot a
  // detail-shaped bind so layout Save doesn't overwrite the detail page with
  // the list query body.
  if (
    state.listPageRef &&
    (state.pageKind === "detail" || state.pageKind === "create")
  ) {
    const table =
      state.detailSlots[0]?.table ||
      inferPrimaryTable([], existing?.bindMeta.bodyTemplate ?? null) ||
      inferPrimaryTable([], state.bindMeta.bodyTemplate) ||
      "Page";
    const prevBind = existing?.bindMeta;
    const keepPrev =
      prevBind &&
      !bodyLooksLikeListQuery(prevBind.bodyTemplate) &&
      (existing?.pageKind === "detail" ||
        existing?.pageKind === "create" ||
        existing?.viewMode === "detail");
    snap.bindMeta = keepPrev
      ? {
          url: toBrowserApijsonUrl(prevBind.url, apijsonBaseUrl),
          method: prevBind.method,
          bodyTemplate: structuredClone(prevBind.bodyTemplate),
        }
      : detailBindStub(table);
    snap.viewMode = "detail";
    snap.pageKind = state.pageKind;
    snap.detailSlots = state.detailSlots.length
      ? structuredClone(state.detailSlots)
      : snap.detailSlots;
  }

  // Guard: never downgrade a saved create/detail page to an empty list shell
  // (happens if callers clear pageKind/detailSlots then persist/switch).
  if (
    existing &&
    (existing.pageKind === "create" || existing.pageKind === "detail") &&
    snap.pageKind === "list"
  ) {
    snap.pageKind = existing.pageKind;
    snap.viewMode = "detail";
    if (!snap.detailSlots?.length && existing.detailSlots?.length) {
      snap.detailSlots = structuredClone(existing.detailSlots);
    }
    if (
      bodyLooksLikeListQuery(snap.bindMeta.bodyTemplate) &&
      existing.bindMeta &&
      !bodyLooksLikeListQuery(existing.bindMeta.bodyTemplate)
    ) {
      snap.bindMeta = {
        url: toBrowserApijsonUrl(existing.bindMeta.url, apijsonBaseUrl),
        method: existing.bindMeta.method,
        bodyTemplate: structuredClone(existing.bindMeta.bodyTemplate),
      };
    }
  }

  updatePageVersion(state.activePageId, state.activeVersion, snap);
  if (opts?.captureThumb !== false) {
    schedulePageThumbCapture(state.activePageId);
  }
}

/** Resolve list vs detail vs create from snapshot (+ forked ids like Register_User). */
function pageKindFromSnapshot(
  snap: SavedPageSnapshot,
  pageId: string,
): PageKind {
  const body = snap.bindMeta?.bodyTemplate ?? {};
  const listBody = bodyLooksLikeListQuery(body);
  const slots = snap.detailSlots ?? [];
  const createOps =
    slots.length > 0 && slots.every((s) => s.op === "post" || s.op === "get");
  const hasPost = slots.some((s) => s.op === "post");

  if (snap.pageKind === "create" || snap.pageKind === "detail") {
    return snap.pageKind;
  }
  // Recover pages corrupted to pageKind=list (or legacy snaps without pageKind)
  if (!listBody && (hasPost || snap.viewMode === "detail" || slots.length)) {
    if (hasPost && createOps) return "create";
    if (/_create$/i.test(pageId)) return "create";
    if (snap.viewMode === "detail" || slots.length || /_detail$/i.test(pageId)) {
      return hasPost ? "create" : "detail";
    }
  }
  if (/_create$/i.test(pageId) && !listBody) return "create";
  if (/_detail$/i.test(pageId) && !listBody) return "detail";
  if (snap.pageKind === "list" || listBody) return "list";
  return "list";
}

function applyPageSnapshot(snap: SavedPageSnapshot, title: string) {
  const kind = pageKindFromSnapshot(snap, state.activePageId || "");
  state.pageKind = kind;
  state.viewMode = kind === "list" ? "list" : "detail";
  state.hasBind = kind === "list";
  state.pageTitle = title;
  state.activeVersion = snap.version;
  state.detailSlots = snap.detailSlots?.length
    ? structuredClone(snap.detailSlots)
    : [];
  if (state.viewMode === "list") state.listPageRef = null;
  state.filters = snap.filters.filter(
    (f) => f.key === "page" || f.key === "count",
  );
  state.bindMeta = {
    url: toBrowserApijsonUrl(snap.bindMeta.url, apijsonBaseUrl),
    method: snap.bindMeta.method,
    bodyTemplate: structuredClone(snap.bindMeta.bodyTemplate),
  };
  state.columnSorts = structuredClone(snap.columnSorts);
  state.columnFilters = structuredClone(snap.columnFilters);
  state.filterCombineExpr = snap.filterCombineExpr || "";
  state.tableJoins = structuredClone(snap.tableJoins);
  state.fkExpand = structuredClone(snap.fkExpand);
  state.columnOrder = [...(snap.columnOrder || [])];
  state.columnMetas = structuredClone(snap.columnMetas || {});
  state.displayKind = snap.displayKind || "table";
  state.chartLabelPath = snap.chartLabelPath || "";
  state.chartValuePath = snap.chartValuePath || "";
  state.chartDimensions = structuredClone(snap.chartDimensions || []);
  state.chartFieldColors = { ...(snap.chartFieldColors || {}) };
  state.chartFieldValues = { ...(snap.chartFieldValues || {}) };
  state.combinedShowTable = snap.combinedShowTable !== false;
  state.createInitialValues = null;
  setActivePageRef({
    pageId: state.activePageId!,
    version: snap.version,
  });
  renderFilters(state.filters);
  setUi({
    page: snap.ui?.page ?? 0,
    count: normalizePageCount(snap.ui?.count ?? DEFAULT_PAGE_COUNT),
  });
}

/** Restore a create page (e.g. register = Add User + Add Privacy). */
function mountSavedCreatePage(title: string) {
  const primary =
    state.detailSlots[0]?.table ||
    inferPrimaryTable([], state.bindMeta?.bodyTemplate ?? null) ||
    "User";
  state.hasBind = false;
  state.viewMode = "detail";
  state.pageKind = "create";
  mountCreateView($("result-view"), {
    table: primary,
    comments: state.comments,
    columnMetas: state.columnMetas,
    fkExpand: state.fkExpand,
    apijsonBaseUrl,
    initialValues: state.createInitialValues,
    initialSlots: state.detailSlots.length ? state.detailSlots : undefined,
    pageTitle: title,
    onSubmit: (payload) => void executeWriteDirect(payload),
    onRelateSync: (payload) => syncRelateFromDetail(payload),
    onColumnMetasChange: (metas) => {
      state.columnMetas = metas;
      persistCurrentPageVersion();
    },
    onPageTitleChange: (t) => commitPageTitle(t),
    onDetailSlotsChange: (slots) => {
      state.detailSlots = slots;
      persistCurrentPageVersion();
    },
    onBack: () => void returnToListPage(),
  });
}

/** Bumped on every page switch — discard stale bound/detail fetches. */
let pageSwitchGen = 0;

function switchStillActive(gen: number, pageId: string): boolean {
  return pageSwitchGen === gen && state.activePageId === pageId;
}

/** Load a saved detail page from its bindMeta (list `bound` must not run). */
async function fetchBoundDetail(opts: {
  switchGen: number;
  pageId: string;
}): Promise<void> {
  if (!state.bindMeta) {
    mountWorkspaceGuide($("result-view"));
    return;
  }
  const listUrl = toBrowserApijsonUrl(
    state.bindMeta.url || `${apijsonBaseUrl}/get`,
    apijsonBaseUrl,
  );
  const method = (
    (state.bindMeta.method || "get").toLowerCase() === "gets" ? "gets" : "get"
  ) as "get" | "gets";
  let body = structuredClone(state.bindMeta.bodyTemplate);
  body = await withRequestRole(body, method, apijsonBaseUrl);
  if (!switchStillActive(opts.switchGen, opts.pageId)) return;

  syncDataPanel({
    method: "POST",
    url: listUrl,
    json: body,
  });

  const host = $("result-view");
  const primary =
    state.detailSlots[0]?.table ||
    inferPrimaryTable([], state.bindMeta.bodyTemplate) ||
    "Record";
  host.innerHTML = `<div class="result-empty">${t("result.loadingRecord", {
    table: primary,
    key: "id",
    id: "…",
  })}</div>`;

  try {
    const res = await fetch(
      listUrl,
      withApijsonAuth({
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      }),
    );
    const json = (await res.json()) as { code?: number; msg?: string };
    if (!switchStillActive(opts.switchGen, opts.pageId)) return;
    const ok = res.ok && json.code === 200;
    if (ok) {
      state.viewMode = "detail";
      state.pageKind = "detail";
      renderRows(json);
      dataPanel.fill({ response: json });
      persistCurrentPageVersion({ captureThumb: false });
    } else {
      logoutIfApijsonAuthFailed(json);
      host.innerHTML = `<div class="result-empty">${t("result.loadFailed", {
        msg: json.msg || res.statusText,
      })}</div>`;
      dataPanel.fill({ response: json });
    }
  } catch (e) {
    if (!switchStillActive(opts.switchGen, opts.pageId)) return;
    host.innerHTML = `<div class="result-empty">${t("result.loadFailed", {
      msg: e instanceof Error ? e.message : String(e),
    })}</div>`;
  }
}

async function switchToSavedPage(
  pageId: string,
  version?: number,
  opts?: { search?: boolean; skipPersist?: boolean },
) {
  const switchGen = ++pageSwitchGen;
  // Drop deferred stay-on-page jobs; leave capture is critical and awaited.
  cancelPageThumbCapture();
  const prevId = state.activePageId;
  if (!opts?.skipPersist) {
    persistCurrentPageVersion({ captureThumb: false });
  }
  // Screenshot the page we're leaving *before* mutating #results, then
  // refresh the grid so the new thumb is visible when the menu remounts.
  if (prevId) {
    await captureAndSavePageThumb(prevId, { critical: true });
    if (pageSwitchGen !== switchGen) return;
    refreshPagePickerGrid();
  }
  if (pageSwitchGen !== switchGen) return;
  const page = getSavedPage(pageId);
  if (!page?.versions.length) return;
  const snap =
    version != null
      ? getPageVersion(pageId, version)
      : page.versions.reduce((a, b) => (a.version >= b.version ? a : b));
  if (!snap) return;
  // Another click already superseded this switch
  if (pageSwitchGen !== switchGen) return;
  state.activePageId = pageId;
  applyPageSnapshot(snap, page.title);
  if (!state.sessionId) {
    state.sessionId = `local_${pageId}`;
  }
  if (!switchStillActive(switchGen, pageId)) return;

  const afterSwitch = () => {
    void capturePageThumbAfterSwitch(pageId, () =>
      switchStillActive(switchGen, pageId),
    ).then((ok) => {
      if (ok && switchStillActive(switchGen, pageId)) refreshPagePickerGrid();
    });
  };

  if (state.pageKind === "create") {
    mountSavedCreatePage(page.title);
    afterSwitch();
    return;
  }
  if (state.pageKind === "detail") {
    // Always fetch detail — `search: false` only skips list Search on restore.
    await fetchBoundDetail({ switchGen, pageId });
    if (!switchStillActive(switchGen, pageId)) return;
    afterSwitch();
    return;
  }
  if (opts?.search !== false) {
    await bound("search");
  }
  if (!switchStillActive(switchGen, pageId)) return;
  afterSwitch();
}

async function switchToSavedVersion(version: number) {
  if (!state.activePageId) return;
  if (state.activeVersion === version) return;
  await switchToSavedPage(state.activePageId, version);
}

function clearActivePageUi() {
  state.activePageId = null;
  state.activeVersion = null;
  state.pageTitle = "";
  state.pageKind = "list";
  state.detailSlots = [];
  state.listPageRef = null;
  state.hasBind = false;
  state.bindMeta = null;
  state.lastResponse = null;
  setActivePageRef(null);
  renderFilters([]);
  mountWorkspaceGuide($("result-view"));
}

async function confirmDeleteSavedPage(pageId: string, title: string) {
  if (!confirm(`确定删除 ${title}？`)) return;
  const wasActive = state.activePageId === pageId;
  if (wasActive) persistCurrentPageVersion();
  if (!deleteSavedPage(pageId)) return;
  closePageMenus();
  if (!wasActive) {
    const ui = readUi();
    renderFilters(state.filters);
    setUi(ui);
    return;
  }
  const next = listSavedPages()[0];
  if (next?.versions.length) {
    await switchToSavedPage(next.id);
  } else {
    clearActivePageUi();
  }
}

async function confirmDeleteSavedVersion(
  pageId: string,
  version: number,
  label: string,
) {
  if (!confirm(`确定删除 ${label}？`)) return;
  const wasActive =
    state.activePageId === pageId && state.activeVersion === version;
  if (wasActive) {
    // Don't persist into a version we're about to remove
  } else {
    persistCurrentPageVersion();
  }
  const page = deletePageVersion(pageId, version);
  closePageMenus();
  if (!page) {
    if (state.activePageId === pageId) {
      const next = listSavedPages()[0];
      if (next?.versions.length) await switchToSavedPage(next.id);
      else clearActivePageUi();
    } else {
      const ui = readUi();
      renderFilters(state.filters);
      setUi(ui);
    }
    return;
  }
  if (wasActive) {
    const latest = page.versions.reduce((a, b) =>
      a.version >= b.version ? a : b,
    );
    await switchToSavedPage(pageId, latest.version);
    return;
  }
  const ui = readUi();
  renderFilters(state.filters);
  setUi(ui);
}

function makePageMenuRow(opts: {
  label: string;
  active?: boolean;
  onSelect: () => void;
  onDelete: () => void;
}): HTMLElement {
  const row = document.createElement("div");
  row.className = "page-menu-item";
  if (opts.active) row.classList.add("active");
  const labelBtn = document.createElement("button");
  labelBtn.type = "button";
  labelBtn.className = "page-menu-item-label";
  labelBtn.textContent = opts.label;
  labelBtn.onclick = () => {
    closePageMenus();
    opts.onSelect();
  };
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "page-menu-item-del";
  delBtn.textContent = "×";
  delBtn.title = t("common.delete");
  delBtn.setAttribute("aria-label", `Delete ${opts.label}`);
  delBtn.onclick = (ev) => {
    ev.stopPropagation();
    opts.onDelete();
  };
  row.append(labelBtn, delBtn);
  return row;
}

/** 4 columns × 3 rows */
const PAGE_PICKER_PAGE_SIZE = 12;

type PagePickerUiState = {
  q: string;
  sort: "asc" | "desc";
  page: number;
};

let pagePickerUi: PagePickerUiState = { q: "", sort: "asc", page: 0 };

/** Re-render open page-picker grid cards (thumbs / active) from localStorage. */
function refreshPagePickerGrid() {
  const menu = document.querySelector(
    ".page-picker-menu",
  ) as HTMLElement | null;
  if (!menu) return;
  renderPagePickerLists(menu);
}

setPageThumbSavedHandler(() => {
  refreshPagePickerGrid();
});

function makePagePickerCard(p: SavedPage): HTMLElement {
  const card = document.createElement("div");
  card.className = "page-picker-card";
  if (p.id === state.activePageId) card.classList.add("active");

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "page-picker-open";
  openBtn.title = p.title;
  openBtn.onclick = () => {
    // Keep the grid open through leave-page capture so the new thumb paints,
    // then close after the switch settles.
    void switchToSavedPage(p.id).finally(() => closePageMenus());
  };

  const thumb = document.createElement("div");
  thumb.className = "page-picker-thumb";
  const thumbUrl = getSavedPageThumb(p.id);
  if (thumbUrl) {
    const img = document.createElement("img");
    img.src = thumbUrl;
    img.alt = "";
    img.draggable = false;
    thumb.appendChild(img);
  } else {
    thumb.classList.add("is-empty");
    thumb.textContent = t("workspace.noPreview");
  }

  const caption = document.createElement("div");
  caption.className = "page-picker-caption";
  caption.textContent = p.title;

  openBtn.append(thumb, caption);

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "page-picker-del";
  delBtn.textContent = "×";
  delBtn.title = t("common.delete");
  delBtn.setAttribute("aria-label", `Delete ${p.title}`);
  delBtn.onclick = (ev) => {
    ev.stopPropagation();
    void confirmDeleteSavedPage(p.id, p.title);
  };

  card.append(openBtn, delBtn);
  return card;
}

function filteredPickerPages(): SavedPage[] {
  let pages = listSavedPages();
  const q = pagePickerUi.q.trim().toLowerCase();
  if (q) {
    pages = pages.filter(
      (p) =>
        p.title.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
    );
  }
  pages = [...pages].sort((a, b) => {
    const cmp = a.title.localeCompare(b.title, undefined, {
      sensitivity: "base",
    });
    return pagePickerUi.sort === "asc" ? cmp : -cmp;
  });
  return pages;
}

function renderPagePickerLists(menu: HTMLElement) {
  const body = menu.querySelector(".page-picker-body") as HTMLElement | null;
  const pager = menu.querySelector(".page-picker-pager") as HTMLElement | null;
  const sortBtn = menu.querySelector(
    ".page-picker-sort",
  ) as HTMLButtonElement | null;
  if (!body || !pager) return;

  if (sortBtn) {
    sortBtn.textContent = pagePickerUi.sort === "asc" ? "A→Z" : "Z→A";
    sortBtn.setAttribute(
      "aria-label",
      pagePickerUi.sort === "asc"
        ? t("workspace.sortNameAsc")
        : t("workspace.sortNameDesc"),
    );
  }

  const pages = filteredPickerPages();
  const total = pages.length;
  const pageSize = PAGE_PICKER_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);
  if (pagePickerUi.page >= totalPages) pagePickerUi.page = totalPages - 1;
  if (pagePickerUi.page < 0) pagePickerUi.page = 0;

  const slice = pages.slice(
    pagePickerUi.page * pageSize,
    pagePickerUi.page * pageSize + pageSize,
  );

  body.replaceChildren();
  if (!total) {
    const empty = document.createElement("div");
    empty.className = "page-menu-empty";
    empty.textContent = t("workspace.noPages");
    body.appendChild(empty);
  } else {
    const grid = document.createElement("div");
    grid.className = "page-picker-grid";
    for (const p of slice) grid.appendChild(makePagePickerCard(p));
    body.appendChild(grid);
  }

  pager.replaceChildren();
  if (total > pageSize) {
    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "page-picker-page-btn";
    prev.textContent = "‹";
    prev.title = t("common.previousPage");
    prev.disabled = pagePickerUi.page <= 0;
    prev.onclick = (ev) => {
      ev.stopPropagation();
      pagePickerUi.page -= 1;
      renderPagePickerLists(menu);
    };

    const info = document.createElement("span");
    info.className = "page-picker-page-info";
    info.textContent = t("workspace.pageOf", {
      page: pagePickerUi.page + 1,
      total: totalPages,
    });

    const next = document.createElement("button");
    next.type = "button";
    next.className = "page-picker-page-btn";
    next.textContent = "›";
    next.title = t("common.nextPage");
    next.disabled = pagePickerUi.page >= totalPages - 1;
    next.onclick = (ev) => {
      ev.stopPropagation();
      pagePickerUi.page += 1;
      renderPagePickerLists(menu);
    };

    pager.append(prev, info, next);
  }
}

/** Grid page switcher: search (name) · sort (name) · paginated thumbs. */
function mountPagePickerMenu(menu: HTMLElement) {
  menu.className = "page-menu page-title-menu page-picker-menu";
  menu.replaceChildren();

  const toolbar = document.createElement("div");
  toolbar.className = "page-picker-toolbar";

  const search = document.createElement("input");
  search.type = "search";
  search.className = "page-picker-search";
  search.placeholder = t("workspace.searchPages");
  search.value = pagePickerUi.q;
  search.setAttribute("aria-label", t("workspace.searchPages"));
  search.onmousedown = (ev) => ev.stopPropagation();
  search.onclick = (ev) => ev.stopPropagation();
  search.onkeydown = (ev) => ev.stopPropagation();
  search.oninput = () => {
    pagePickerUi.q = search.value;
    pagePickerUi.page = 0;
    renderPagePickerLists(menu);
  };

  const sortBtn = document.createElement("button");
  sortBtn.type = "button";
  sortBtn.className = "page-picker-sort";
  sortBtn.title = t("workspace.sortByName");
  sortBtn.onclick = (ev) => {
    ev.stopPropagation();
    pagePickerUi.sort = pagePickerUi.sort === "asc" ? "desc" : "asc";
    pagePickerUi.page = 0;
    renderPagePickerLists(menu);
  };

  toolbar.append(search, sortBtn);

  const body = document.createElement("div");
  body.className = "page-picker-body";
  const pager = document.createElement("div");
  pager.className = "page-picker-pager";

  menu.append(toolbar, body, pager);
  renderPagePickerLists(menu);
}

function syncTitleInputs(title: string) {
  state.pageTitle = title;
  const top = document.getElementById(
    "page-title-input",
  ) as HTMLInputElement | null;
  if (top) top.value = title;
  const detail = document.querySelector(
    ".detail-page-title-input",
  ) as HTMLInputElement | null;
  if (detail && detail.value.trim() !== title) detail.value = title;
}

/** Unique page id from a custom title (register → register, register_2, …). */
function allocatePageId(title: string): string {
  const base = slugPageTitle(title) || `page_${Date.now().toString(36)}`;
  if (!getSavedPage(base)) return base;
  let n = 2;
  while (getSavedPage(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

function ensureBindForSnapshot() {
  if (state.bindMeta) return;
  const table =
    state.detailSlots[0]?.table ||
    inferPrimaryTable([], null) ||
    "Page";
  state.bindMeta = {
    url: `${apijsonBaseUrl.replace(/\/+$/, "")}/get`,
    method: "get",
    bodyTemplate: { [table]: {} },
  };
}

/**
 * Detail/create: editing the title forks a new saved page (e.g. Create User →
 * register) and leaves the previous page untouched.
 */
function forkDetailPageWithTitle(title: string) {
  if (title === (state.pageTitle || "").trim()) {
    syncTitleInputs(title);
    return;
  }
  // Snapshot the current page under its old id/title first
  if (state.activePageId && state.activeVersion != null) {
    persistCurrentPageVersion();
  }
  ensureBindForSnapshot();
  const snap = capturePageSnapshot();
  if (!snap) return;
  const kind: PageKind =
    state.pageKind === "create" ? "create" : "detail";
  const pageId = allocatePageId(title);
  const { page, snapshot } = addPageVersion(pageId, title, {
    ...snap,
    viewMode: "detail",
    pageKind: kind,
    detailSlots: state.detailSlots.length
      ? structuredClone(state.detailSlots)
      : snap.detailSlots,
  });
  state.activePageId = page.id;
  state.activeVersion = snapshot.version;
  state.pageKind = kind;
  state.viewMode = "detail";
  syncTitleInputs(page.title);
  schedulePageThumbCapture(page.id);
  const ui = readUi();
  renderFilters(state.filters);
  setUi(ui);
}

function commitPageTitle(nextTitle: string) {
  const title = nextTitle.trim();
  if (!title) return;
  // Detail/create header (or top bar while on detail) → new page, not rename
  const onDetail =
    state.pageKind === "detail" ||
    state.pageKind === "create" ||
    state.viewMode === "detail";
  if (onDetail) {
    forkDetailPageWithTitle(title);
    return;
  }
  if (!state.activePageId) return;
  const page = renameSavedPage(state.activePageId, title);
  if (!page) return;
  const changed = page.title !== state.pageTitle;
  syncTitleInputs(page.title);
  persistCurrentPageVersion();
  if (!changed) return;
  const ui = readUi();
  renderFilters(state.filters);
  setUi(ui);
}

function saveGeneratedPage(
  surfaceId: string,
  title: string,
  filters: FilterDef[],
) {
  if (!state.bindMeta) return;
  state.filters = filters.filter((f) => f.key === "page" || f.key === "count");
  const snap = capturePageSnapshot();
  if (!snap) return;
  const { page, snapshot } = addPageVersion(
    surfaceId,
    title || surfaceId,
    snap,
  );
  state.activePageId = page.id;
  state.activeVersion = snapshot.version;
  state.pageTitle = page.title;
  schedulePageThumbCapture(page.id);
}

function closePageMenus() {
  for (const menu of Array.from(
    document.querySelectorAll<HTMLElement>(".page-menu"),
  )) {
    menu.classList.remove("is-open");
  }
}

/** Desktop: CSS :hover. Touch / no-hover: click toggles `.is-open`. */
function bindHoverMenu(trigger: HTMLElement, menu: HTMLElement) {
  trigger.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const wasOpen = menu.classList.contains("is-open");
    closePageMenus();
    if (!wasOpen) menu.classList.add("is-open");
  });
}

/** Left: page title + version · Right: Search · Clear · paging · Analyze · Add */
function renderFilters(filters: FilterDef[]) {
  const pagingOnly = filters.filter(
    (f) => f.key === "page" || f.key === "count",
  );
  const root = $("filters");
  const saved = listSavedPages();
  const showActions =
    pagingOnly.length > 0 ||
    state.hasBind ||
    state.viewMode === "detail" ||
    !!state.activePageId;
  if (!showActions && !saved.length && !state.activePageId) {
    root.classList.add("hidden");
    root.innerHTML = "";
    return;
  }
  state.filters = pagingOnly.length
    ? pagingOnly
    : [
        { key: "page", label: "Page", type: "number" },
        { key: "count", label: "Count", type: "number" },
      ];
  root.classList.remove("hidden");
  root.innerHTML = "";

  const left = document.createElement("div");
  left.className = "filters-left";

  const titleWrap = document.createElement("div");
  titleWrap.className = "page-title-control";
  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "page-title-input";
  titleInput.id = "page-title-input";
  titleInput.placeholder = t("workspace.pageTitle");
  titleInput.value = state.pageTitle || saved[0]?.title || "";
  titleInput.title = t("workspace.editPageName");
  titleInput.disabled = !state.activePageId;
  const titleDropBtn = document.createElement("button");
  titleDropBtn.type = "button";
  titleDropBtn.className = "page-dd-btn";
  titleDropBtn.setAttribute("aria-label", t("workspace.selectPage"));
  titleDropBtn.title = t("workspace.selectPage");
  titleDropBtn.textContent = "▾";
  titleDropBtn.disabled = saved.length === 0;
  const titleMenu = document.createElement("div");
  mountPagePickerMenu(titleMenu);
  const titleDdWrap = document.createElement("div");
  titleDdWrap.className = "page-dd-wrap";
  if (!titleDropBtn.disabled) bindHoverMenu(titleDropBtn, titleMenu);
  titleInput.onchange = () => commitPageTitle(titleInput.value);
  titleInput.onkeydown = (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      titleInput.blur();
    }
  };
  titleDdWrap.append(titleDropBtn, titleMenu);
  titleWrap.append(titleInput, titleDdWrap);
  left.appendChild(titleWrap);

  const page = state.activePageId
    ? getSavedPage(state.activePageId)
    : null;
  const versions = page?.versions ?? [];
  if (versions.length) {
    const verWrap = document.createElement("div");
    verWrap.className = "page-version-control";
    const verBtn = document.createElement("button");
    verBtn.type = "button";
    verBtn.className = "page-version-btn";
    verBtn.id = "page-version-btn";
    const activeVer =
      state.activeVersion ??
      versions.reduce((m, v) => Math.max(m, v.version), 0);
    verBtn.textContent = formatVersionShort(activeVer);
    verBtn.title = t("workspace.selectVersion");
    const verMenu = document.createElement("div");
    verMenu.className = "page-menu page-version-menu";
    const sorted = [...versions].sort((a, b) => b.version - a.version);
    for (const v of sorted) {
      const label = formatVersionOption(v.version, v.createdAt);
      verMenu.appendChild(
        makePageMenuRow({
          label,
          active: v.version === activeVer,
          onSelect: () => void switchToSavedVersion(v.version),
          onDelete: () =>
            void confirmDeleteSavedVersion(
              state.activePageId!,
              v.version,
              label,
            ),
        }),
      );
    }
    bindHoverMenu(verBtn, verMenu);
    verWrap.append(verBtn, verMenu);
    left.appendChild(verWrap);
  }

  root.appendChild(left);

  const spacer = document.createElement("span");
  spacer.className = "toolbar-spacer";
  root.appendChild(spacer);

  const right = document.createElement("div");
  right.className = "filters-right";

  const searchBtn = document.createElement("button");
  searchBtn.type = "button";
  searchBtn.className = "primary";
  searchBtn.id = "btn-search";
  searchBtn.textContent = t("common.search");
  searchBtn.disabled = !state.hasBind;
  right.appendChild(searchBtn);

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.id = "btn-clear-filters";
  clearBtn.textContent = t("common.clear");
  clearBtn.title =
    "Clear column filters (recover when empty results hide the table header)";
  clearBtn.disabled = !state.hasBind;
  right.appendChild(clearBtn);

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.id = "btn-prev";
  prevBtn.className = "toolbar-icon-btn";
  prevBtn.textContent = "<";
  prevBtn.title = t("common.previousPage");
  prevBtn.setAttribute("aria-label", t("common.previousPage"));
  prevBtn.disabled = !state.hasBind;
  right.appendChild(prevBtn);

  const pageWrap = document.createElement("span");
  pageWrap.className = "toolbar-inline";
  const pageInput = document.createElement("input");
  pageInput.type = "number";
  pageInput.min = "0";
  pageInput.dataset.key = "page";
  pageInput.value = "0";
  pageInput.title = t("workspace.pageZeroBased");
  pageInput.disabled = !state.hasBind;
  pageWrap.appendChild(pageInput);
  right.appendChild(pageWrap);

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.id = "btn-next";
  nextBtn.className = "toolbar-icon-btn";
  nextBtn.textContent = ">";
  nextBtn.title = t("common.nextPage");
  nextBtn.setAttribute("aria-label", t("common.nextPage"));
  nextBtn.disabled = !state.hasBind;
  right.appendChild(nextBtn);

  const countWrap = document.createElement("span");
  countWrap.className = "toolbar-inline";
  const countSel = document.createElement("select");
  countSel.dataset.key = "count";
  countSel.title = t("workspace.rowsPerPage");
  countSel.disabled = !state.hasBind;
  for (const n of PAGE_COUNT_OPTIONS) {
    const o = document.createElement("option");
    o.value = String(n);
    o.textContent = String(n);
    if (n === DEFAULT_PAGE_COUNT) o.selected = true;
    countSel.appendChild(o);
  }
  countWrap.appendChild(countSel);
  right.appendChild(countWrap);

  const analyzeBtn = document.createElement("button");
  analyzeBtn.type = "button";
  analyzeBtn.id = "btn-analyze";
  analyzeBtn.textContent = t("common.analyze");
  analyzeBtn.title = t("workspace.analyzeTitle");
  analyzeBtn.disabled = !state.hasBind;
  right.appendChild(analyzeBtn);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.id = "btn-create";
  addBtn.className = "primary";
  addBtn.textContent = t("common.add");
  addBtn.title = t("workspace.addRecord");
  addBtn.disabled = !state.hasBind;
  right.appendChild(addBtn);

  root.appendChild(right);

  searchBtn.onclick = () => bound("search");
  clearBtn.onclick = () => {
    state.columnFilters = [];
    state.filterCombineExpr = "";
    void bound("search", { page: 0 });
  };
  addBtn.onclick = () => {
    if (!triggerListCreate()) {
      addMessage("assistant", t("workspace.runListThenAdd"));
    }
  };
  analyzeBtn.onclick = () => void runAnalyze(analyzeBtn);
  prevBtn.onclick = () => {
    const pageNum = Number(readUi().page || 0);
    void bound("page_change", { page: Math.max(0, pageNum - 1) });
  };
  nextBtn.onclick = () => {
    const pageNum = Number(readUi().page || 0);
    void bound("page_change", { page: pageNum + 1 });
  };
  pageInput.onchange = () => void bound("page_change");
  countSel.onchange = () => void bound("search");
}

function simpleMarkdownToHtml(md: string): string {
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const lines = md.split(/\r?\n/);
  const html: string[] = [];
  let inUl = false;
  const flushUl = () => {
    if (inUl) {
      html.push("</ul>");
      inUl = false;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushUl();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushUl();
      const level = heading[1]!.length;
      html.push(`<h${level}>${inlineMd(esc(heading[2]!))}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!inUl) {
        html.push("<ul>");
        inUl = true;
      }
      html.push(`<li>${inlineMd(esc(bullet[1]!))}</li>`);
      continue;
    }
    flushUl();
    html.push(`<p>${inlineMd(esc(line))}</p>`);
  }
  flushUl();
  return html.join("\n");
}

function inlineMd(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function showAnalyzeReport(report: string, source: string) {
  document.getElementById("analyze-report-modal")?.remove();
  const modal = document.createElement("div");
  modal.id = "analyze-report-modal";
  modal.className = "analyze-modal";
  const panel = document.createElement("div");
  panel.className = "analyze-panel";
  const head = document.createElement("div");
  head.className = "analyze-head";
  const h = document.createElement("h3");
  h.textContent = t("workspace.analysisReport");
  const meta = document.createElement("span");
  meta.className = "muted";
  meta.textContent = source === "llm" ? t("workspace.aiGenerated") : t("workspace.localSummary");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "detail-back-icon";
  close.setAttribute("aria-label", t("common.close"));
  close.textContent = "×";
  close.onclick = () => modal.remove();
  head.append(h, meta, close);
  const body = document.createElement("div");
  body.className = "analyze-body";
  body.innerHTML = simpleMarkdownToHtml(report);
  panel.append(head, body);
  modal.appendChild(panel);
  modal.addEventListener("mousedown", (e) => {
    if (e.target === modal) modal.remove();
  });
  document.body.appendChild(modal);
}

async function runAnalyze(btn: HTMLButtonElement) {
  if (state.lastResponse == null) {
    addMessage("assistant", t("workspace.runListFirst"));
    return;
  }
  const parsed = parseResponse(state.lastResponse);
  if (!parsed.rows.length) {
    addMessage("assistant", t("workspace.noDataAnalyze"));
    return;
  }
  const primary = inferPrimaryTable(
    parsed.columns,
    state.bindMeta?.bodyTemplate ?? null,
  );
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = t("common.analyzing");
  try {
    const data = await api<{ report: string; source: string }>("/api/analyze", {
      title: primary ? t("workspace.analysisTitle", { table: primary }) : t("workspace.analysisTitleFallback"),
      primaryTable: primary,
      columns: parsed.columns,
      rows: parsed.rows.map((r) => ({ key: r.key, cells: r.cells })),
      llm: llmConfigForApi(),
    });
    showAnalyzeReport(data.report, data.source);
    addMessage(
      "assistant",
      data.source === "llm"
        ? t("workspace.aiReportDone")
        : "Analysis report generated (local summary when no model key is configured).",
    );
  } catch (e) {
    addMessage("assistant", e instanceof Error ? e.message : String(e));
  } finally {
    btn.disabled = false;
    btn.textContent = prev || t("common.analyze");
  }
}

type TrackedApproval = {
  requestId: string;
  sessionId: string;
  summary: string;
  at: string;
  /** Last known poll status — notify only when this changes. */
  lastStatus?: string;
};

const TRACKED_APPROVALS_KEY = "a2api.trackedApprovals";

function loadTrackedApprovals(): TrackedApproval[] {
  try {
    const raw = localStorage.getItem(TRACKED_APPROVALS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as TrackedApproval[]) : [];
  } catch {
    return [];
  }
}

function saveTrackedApprovals(rows: TrackedApproval[]) {
  try {
    localStorage.setItem(TRACKED_APPROVALS_KEY, JSON.stringify(rows.slice(0, 40)));
  } catch {
    /* ignore */
  }
}

function trackApproval(row: TrackedApproval) {
  const next = loadTrackedApprovals().filter((r) => r.requestId !== row.requestId);
  next.unshift(row);
  saveTrackedApprovals(next);
}

function untrackApproval(requestId: string) {
  saveTrackedApprovals(
    loadTrackedApprovals().filter((r) => r.requestId !== requestId),
  );
}

function normalizeTrackedStatus(item: {
  status: string;
  decision: string | null;
}): string {
  if (item.status === "awaiting_approval" || item.decision === "pending") {
    return "pending";
  }
  if (
    item.status === "done" ||
    item.decision === "approved" ||
    item.decision === "auto_approved" ||
    item.status === "approved"
  ) {
    return "approved";
  }
  if (item.status === "rejected" || item.decision === "rejected") {
    return "rejected";
  }
  if (item.status === "unknown") return "unknown";
  return item.status || "unknown";
}

/** On every page load: re-check Apply/approval status; notify only on change. */
async function syncTrackedApprovalsOnLoad() {
  const tracked = loadTrackedApprovals();
  if (!tracked.length) return;
  try {
    const ids = tracked.map((t) => t.requestId).join(",");
    const data = await api<{
      items: Array<{
        requestId: string;
        status: string;
        decision: string | null;
        issues?: string[];
        error?: string | null;
        permissionGate?: boolean;
        method?: string | null;
        applyId?: string | null;
      }>;
    }>(`/api/approvals/status?ids=${encodeURIComponent(ids)}`);
    const byId = new Map(tracked.map((t) => [t.requestId, { ...t }]));
    for (const item of data.items) {
      const meta = byId.get(item.requestId);
      if (!meta) continue;
      const next = normalizeTrackedStatus(item);
      const prev = meta.lastStatus;
      const changed = prev != null && prev !== next;

      if (next === "pending") {
        if (!state.sessionId && meta.sessionId) {
          state.sessionId = meta.sessionId;
        }
        state.pendingRequestId = item.requestId;
        state.awaitingWrite = true;
        if (changed) {
          addMessage(
            "assistant",
            `Apply status changed for ${meta.summary || item.requestId}: ${prev} → pending` +
              (item.issues?.length ? ` (${item.issues.join("; ")})` : "") +
              ". Approve/Reject only in Admin (http://localhost:5174).",
          );
        }
        byId.set(item.requestId, { ...meta, lastStatus: "pending" });
        continue;
      }
      if (next === "approved") {
        if (changed || prev == null) {
          addMessage(
            "assistant",
            `Apply approved for ${meta.summary || item.requestId}. Access/Request/Document are ready — retry edit/delete.`,
          );
        }
        byId.delete(item.requestId);
        continue;
      }
      if (next === "rejected") {
        if (changed || prev == null) {
          addMessage(
            "assistant",
            `Apply rejected for ${meta.summary || item.requestId}.`,
          );
        }
        byId.delete(item.requestId);
        continue;
      }
      if (next === "unknown") {
        if (changed) {
          addMessage(
            "assistant",
            `Apply status cleared for ${meta.summary || item.requestId}.`,
          );
        }
        byId.delete(item.requestId);
        continue;
      }
      byId.set(item.requestId, { ...meta, lastStatus: next });
    }
    saveTrackedApprovals([...byId.values()]);
  } catch {
    /* ignore — server may be restarting */
  }
}

const MAX_WRITE_AI_REPAIRS = 2;

function requestTagForCurrentPage(table: string): string {
  return (
    requestTagFromPageTitle(
      state.pageTitle,
      state.activePageId || table,
    ) || table.toLowerCase()
  );
}

function isPlainBodyObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Demo /crud|/post "success" with no table ids means nothing was written
 * (common when Request.tag / Access is missing). Ignore Verify (check object).
 */
function writeResponseMissingIds(
  body: Record<string, unknown>,
  json: Record<string, unknown> | null,
): boolean {
  if (!json) return true;
  const tables = Object.keys(body).filter(
    (k) => /^[A-Z]/.test(k) && k !== "Verify",
  );
  if (!tables.length) return false;
  return !tables.some((t) => {
    const lower = t.charAt(0).toLowerCase() + t.slice(1);
    const obj = json[t] ?? json[lower];
    if (!isPlainBodyObject(obj)) return false;
    return obj.id != null || obj.count != null;
  });
}

async function prepareWriteBody(
  method: WriteMethod,
  body: Record<string, unknown>,
  base: string,
  table?: string,
): Promise<Record<string, unknown>> {
  let next = stripWriteUserIds(body);
  if (method === "post" || method === "crud") next = stripPostIds(next);
  // Writes use Request.tag derived from the page title (not bare table name)
  const tagTable =
    table ||
    inferBodyTable(next) ||
    "";
  if (tagTable) {
    next = { ...next, tag: requestTagForCurrentPage(tagTable) };
  }
  return withRequestRole(next, method, base);
}

async function requestBodyRepair(
  method: WriteMethod,
  body: Record<string, unknown>,
  error: string,
): Promise<Record<string, unknown> | null> {
  try {
    const data = await api<{
      ok?: boolean;
      body?: Record<string, unknown> | null;
    }>("/api/repair-body", {
      method,
      body,
      error,
      llm: llmConfigForApi(),
    });
    return data.body ?? null;
  } catch {
    return null;
  }
}

async function submitUiApply(opts: {
  method: WriteMethod;
  table: string;
  body: Record<string, unknown>;
  url: string;
  requestId: string;
  issues?: string[];
  detail: string;
  /** Request.structure (UPDATE viceKey@ …) written on approve */
  structure?: Record<string, unknown>;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    // Request.tag ← page title → lowercase English, spaces→_, strip specials
    const tag = requestTagForCurrentPage(opts.table);
    const json = { ...opts.body, tag };
    const res = await fetch("/api/applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        table: opts.table,
        operation: opts.method,
        role: "OWNER",
        version:
          typeof opts.body.version === "number" && opts.body.version > 0
            ? opts.body.version
            : 1,
        method: "POST",
        type: "JSON",
        url: opts.url,
        json,
        tag,
        name:
          state.pageTitle.trim() ||
          `${opts.method.toUpperCase()} ${tag}`,
        detail: opts.detail,
        requestId: opts.requestId,
        sessionId: state.sessionId || undefined,
        issues: opts.issues,
        structure: opts.structure,
      }),
    });
    const data = (await res.json().catch(() => null)) as {
      item?: { id?: string | number };
      error?: string;
    } | null;
    if (!res.ok) {
      return {
        ok: false,
        error: data?.error || `Apply submit failed (${res.status})`,
      };
    }
    return {
      ok: true,
      id: data?.item?.id != null ? String(data.item.id) : undefined,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Generated-UI CRUD → APIJSON /post|/put|/delete|/crud.
 * Multi-table always uses POST /crud (@post/@put/…).
 * On permission / parameter / illegal errors → auto-submit Admin Apply.
 */
async function executeWriteDirect(payload: WritePayload) {
  const verb =
    payload.method === "post"
      ? t("common.create")
      : payload.method === "delete"
        ? t("common.delete")
        : payload.method === "crud"
          ? t("common.crud")
          : t("common.save");
  const allowApply =
    payload.method === "put" ||
    payload.method === "delete" ||
    payload.method === "crud" ||
    payload.method === "post";
  const account = loadAccount();
  if (!account) {
    addMessage(
      "assistant",
      `${verb} requires Login (top-right) so the browser can call APIJSON with a session cookie.`,
    );
    return;
  }
  const base = apijsonBaseUrl.replace(/\/+$/, "");
  const method = payload.method as WriteMethod;
  try {
    const raw = structuredClone(payload.body) as Record<string, unknown>;
    const table =
      payload.table ||
      inferBodyTable(raw) ||
      t("common.unknown");
    const entity = (
      raw[table] && typeof raw[table] === "object" && !Array.isArray(raw[table])
        ? { ...(raw[table] as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;

    const saved =
      method === "crud" ? null : loadWriteTemplate(table, method);
    let body = await prepareWriteBody(
      method,
      method === "crud"
        ? raw
        : mergeWriteTemplate(saved?.body ?? raw, method, table, entity),
      base,
      table,
    );
    // Preserve Verify check object from the form (not a write template field).
    // Keep `"@delete":"Verify"` + Verify ahead of User / other tables.
    if (isPlainBodyObject(raw.Verify)) {
      body.Verify = { ...raw.Verify };
    }
    if (typeof raw["@delete"] === "string" && raw["@delete"].trim()) {
      body["@delete"] = raw["@delete"];
    }
    delete body.verify;
    body = prioritizeVerifyInBody(body);

    const savedUrl = saved?.url?.replace(/\/+$/, "") || "";
    const finalUrl =
      savedUrl && new RegExp(`/${method}$`, "i").test(savedUrl)
        ? savedUrl
        : `${base}/${method}`;

    if (saved) {
      addMessage(
        "assistant",
        `${verb}: using saved template ${table}:${method}` +
          (saved.buttons ? ` → ${saved.buttons}` : "") +
          ".",
      );
    }
    const relateStructure =
      payload.structure && Object.keys(payload.structure).length
        ? payload.structure
        : undefined;
    const structureTables = [
      ...new Set([
        table,
        ...Object.keys(relateStructure || {}),
        ...Object.keys(body).filter((k) => /^[A-Z]/.test(k)),
        ...Object.keys(raw).filter((k) => /^[A-Z]/.test(k)),
      ]),
    ];
    let structureForApply = mergeStructureForApply(relateStructure, {
      operation: method,
      tables: structureTables,
      role: "OWNER",
    });
    if (
      isPlainBodyObject(body.Verify) &&
      !(structureForApply && structureForApply.Verify)
    ) {
      structureForApply = prioritizeVerifyInStructure({
        ...(structureForApply || {}),
        ...buildVerifyApplyStructure(resolvePhoneEmailTable(body)),
      });
    } else if (structureForApply?.Verify) {
      structureForApply = prioritizeVerifyInStructure(structureForApply);
    }
    const requestId = `ui_${Date.now().toString(36)}`;

    let repairAttempts = 0;
    let lastErr = "APIJSON request failed";

    while (true) {
      syncDataPanel({
        method: "POST",
        url: finalUrl,
        json: body,
      });

      const res = await fetch(
        finalUrl,
        withApijsonAuth({
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(body),
        }),
      );
      const json = (await res.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      dataPanel.fill({ response: json });
      const code =
        json && typeof json.code === "number" ? json.code : undefined;
      const msg =
        json && typeof json.msg === "string" ? json.msg : undefined;
      let ok =
        res.ok &&
        json != null &&
        (code === 200 || code === 0 || json.ok === true);

      // Empty success (ok but no row ids) → treat as failure so Apply can fix Request
      if (
        ok &&
        (method === "post" ||
          method === "put" ||
          method === "delete" ||
          method === "crud") &&
        writeResponseMissingIds(body, json)
      ) {
        ok = false;
        lastErr =
          "APIJSON returned success but no row ids — nothing was written (check Request.tag / Access for this /crud)";
      }

      if (ok) {
        const repairNote =
          repairAttempts > 0
            ? ` (auto-repaired ${repairAttempts}×)`
            : "";
        addMessage(
          "assistant",
          `${verb} ${payload.table} succeeded.${repairNote}`,
        );
        await returnToListAndRefresh();
        return;
      }

      lastErr =
        lastErr.startsWith("APIJSON returned success")
          ? lastErr
          : msg || res.statusText || "APIJSON request failed";

      if (logoutIfApijsonAuthFailed(json)) {
        addMessage(
          "assistant",
          `${verb} failed: ${lastErr} Signed out — please Login again, then retry.`,
        );
        return;
      }

      // Demo never Approves/Rejects — only Admin. Auto-Apply on gate errors.
      if (allowApply && isApplyTriggerIssue(lastErr, code)) {
        const submitted = await submitUiApply({
          method,
          table,
          body,
          url: finalUrl,
          requestId,
          issues: [lastErr],
          detail: `API error after try: ${lastErr}`,
          structure: structureForApply,
        });
        if (submitted.ok) {
          trackApproval({
            requestId,
            sessionId: state.sessionId || "",
            summary: `${method.toUpperCase()} ${table}`,
            at: new Date().toISOString(),
            lastStatus: "pending",
          });
          state.pendingRequestId = requestId;
          state.awaitingWrite = true;
          addMessage(
            "assistant",
            `${verb} failed (${lastErr}) — submitted Apply${submitted.id ? ` #${submitted.id}` : ""} to Admin (http://localhost:5174). Approve/Reject there, then retry.`,
          );
        } else {
          addMessage(
            "assistant",
            `${verb} failed (${lastErr}); Apply submit failed: ${submitted.error}`,
          );
        }
        return;
      }

      if (repairAttempts >= MAX_WRITE_AI_REPAIRS) break;

      repairAttempts += 1;
      addMessage(
        "assistant",
        `${verb} failed: ${lastErr}. Trying auto-repair (${repairAttempts}/${MAX_WRITE_AI_REPAIRS})…`,
      );
      const repaired = await requestBodyRepair(method, body, lastErr);
      if (!repaired) break;
      body = await prepareWriteBody(method, repaired, base, table);
      if (isPlainBodyObject(raw.Verify)) body.Verify = { ...raw.Verify };
      if (typeof raw["@delete"] === "string" && raw["@delete"].trim()) {
        body["@delete"] = raw["@delete"];
      }
      delete body.verify;
      body = prioritizeVerifyInBody(body);
    }

    if (allowApply) {
      addMessage(
        "assistant",
        repairAttempts > 0
          ? `${verb} still failing after ${repairAttempts} auto-repair(s): ${lastErr}. Stay in Chat and retry (not jumping to Data API).`
          : `${verb} failed: ${lastErr}. Stay in Chat and retry (not jumping to Data API).`,
      );
      return;
    }

    addMessage(
      "assistant",
      repairAttempts > 0
        ? `${verb} still failing after ${repairAttempts} auto-repair(s): ${lastErr}. Open the Data API tab to edit the request, then Send.`
        : `${verb} failed: ${lastErr}. Open the Data API tab to edit the request, then Send.`,
    );
    switchTab("data");
  } catch (e) {
    addMessage("assistant", e instanceof Error ? e.message : String(e));
    if (!allowApply) switchTab("data");
  }
}

async function returnToListAndRefresh() {
  state.awaitingWrite = false;
  await returnToListPage();
}

function readUi(): {
  page?: number;
  count?: number;
  order?: string;
  keyword?: string;
} {
  const ui: Record<string, string | number> = {};
  for (const el of Array.from(
    $("filters").querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      "input[data-key], select[data-key]",
    ),
  )) {
    const key = el.dataset.key!;
    if (key === "count") {
      ui[key] = normalizePageCount(el.value);
    } else if (el instanceof HTMLInputElement && el.type === "number") {
      ui[key] = Number(el.value);
    } else {
      ui[key] = el.value;
    }
  }
  return ui as {
    page?: number;
    count?: number;
    order?: string;
    keyword?: string;
  };
}

function setUi(ui: {
  page?: number;
  count?: number;
  order?: string;
  keyword?: string;
}) {
  for (const [key, value] of Object.entries(ui)) {
    const el = $("filters").querySelector<HTMLInputElement | HTMLSelectElement>(
      `[data-key="${key}"]`,
    );
    if (!el || value === undefined) continue;
    el.value =
      key === "count" ? String(normalizePageCount(value)) : String(value);
  }
}

async function bound(
  action: string,
  uiOverride?: {
    page?: number;
    count?: number;
    order?: string;
    keyword?: string;
  },
) {
  if (!state.hasBind || !state.bindMeta) {
    // Detail/create pages are not list-bound — avoid spamming chat on switch
    if (state.pageKind === "list") {
      addMessage("assistant", t("workspace.askChatFirst"));
    }
    return;
  }
  const boundPageId = state.activePageId;
  const boundGen = pageSwitchGen;
  const ui = { ...readUi(), ...uiOverride };
  if (uiOverride) setUi(ui);

  // Prefer building request on client so sort/filter work even if API server
  // hasn't been restarted with the latest boundAction changes.
  const primary = inferPrimaryTable([], state.bindMeta.bodyTemplate);
  const listMethod = (
    (state.bindMeta.method || "get").toLowerCase() === "gets" ? "gets" : "get"
  ) as "get" | "gets";
  const savedList =
    primary != null ? loadWriteTemplate(primary, listMethod) : null;
  // Saved get/gets template for this table → Search / paging / filter buttons
  const shell =
    savedList?.body && typeof savedList.body === "object"
      ? savedList.body
      : state.bindMeta.bodyTemplate;
  const listUrl = toBrowserApijsonUrl(
    savedList?.url && /\/(get|gets)\/?$/i.test(savedList.url)
      ? savedList.url
      : state.bindMeta.url || `${apijsonBaseUrl}/get`,
    apijsonBaseUrl,
  );

  let body = applyPaging(
    shell,
    Number(ui.page ?? 0),
    normalizePageCount(ui.count ?? DEFAULT_PAGE_COUNT),
  );
  const filterFieldTypes: Record<string, string> = {};
  for (const f of state.columnFilters) {
    const meta = state.columnMetas[f.path];
    if (meta?.type) filterFieldTypes[f.path] = meta.type;
  }
  body = applyTableQuery(
    body,
    shell,
    state.columnSorts,
    state.columnFilters,
    state.filterCombineExpr,
    filterFieldTypes,
  );
  if (!Object.keys(state.fkExpand).length && primary) {
    state.fkExpand = defaultFkExpandState(primary);
  }
  // Don't strip JOIN tables that are already in the bound template
  state.fkExpand = syncFkExpandFromBody(shell, primary, state.fkExpand);
  body = applyFkExpand(body, primary, state.fkExpand);
  body = applyTableJoins(body, primary, state.tableJoins);
  const method = listMethod;
  body = await withRequestRole(body, method, apijsonBaseUrl);
  if (
    boundPageId != null &&
    !switchStillActive(boundGen, boundPageId)
  ) {
    return;
  }

  syncDataPanel({
    method: "POST",
    url: listUrl,
    json: body,
  });

  try {
    const res = await fetch(
      listUrl,
      withApijsonAuth({
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      }),
    );
    const json = (await res.json()) as { code?: number; msg?: string };
    if (
      boundPageId != null &&
      !switchStillActive(boundGen, boundPageId)
    ) {
      return;
    }
    const ok = res.ok && json.code === 200;
    if (ok) {
      renderRows(json);
      dataPanel.fill({ response: json });
      persistCurrentPageVersion();
    } else {
      logoutIfApijsonAuthFailed(json);
      addMessage("assistant", `Direct call failed: ${json.msg || res.statusText}`);
      dataPanel.fill({ response: json });
      if (state.lastResponse != null) renderRows(state.lastResponse);
    }

    // Best-effort sync session on server (ignore failures / old servers)
    if (state.sessionId && !state.sessionId.startsWith("local_")) {
      void api("/api/bound", {
        sessionId: state.sessionId,
        action,
        ui,
        sorts: state.columnSorts,
        filters: state.columnFilters,
        combineExpr: state.filterCombineExpr,
      }).catch(() => undefined);
    }
  } catch (e) {
    if (
      boundPageId != null &&
      !switchStillActive(boundGen, boundPageId)
    ) {
      return;
    }
    addMessage("assistant", e instanceof Error ? e.message : String(e));
  }
}

async function sendChat(message: string) {
  addMessage("user", message);
  try {
    const data = await api<{
      sessionId: string;
      assistantMessage: string;
      guideToDataApi?: boolean;
      pending: {
        requestId: string;
        method: string;
        body: unknown;
        status: string;
        sensitive?: boolean;
        permissionGate?: boolean;
        issues?: string[];
        approvalId?: string;
      };
      kind?: string;
      plan: {
        filters: FilterDef[];
        writeForm?: {
          fields?: Array<{ key: string; label: string; path: string }>;
          defaults?: Record<string, unknown>;
        };
        openCreate?: boolean;
        surfaceId: string;
        viewMode?: ViewMode;
        title?: string;
      };
      bind?: {
        bodyTemplate?: Record<string, unknown>;
        url?: string;
        method?: string;
      };
      lastResult?: unknown;
      schemaComments?: SchemaComments;
      dataModel: { ui: Record<string, unknown>; rows: unknown };
    }>("/api/chat", {
      sessionId: state.sessionId,
      message,
      llm: llmConfigForApi(),
    });

    state.sessionId = data.sessionId;
    state.viewMode = data.plan?.viewMode ?? "list";
    const isOpenCreate =
      data.plan?.openCreate === true ||
      data.kind === "create_moment" ||
      data.kind === "create_comment";
    const createTable =
      data.kind === "create_comment"
        ? "Comment"
        : data.kind === "create_moment"
          ? "Moment"
          : inferPrimaryTable([], data.bind?.bodyTemplate ?? null);
    // Single-record templates (User Detail, etc.) must never become a bound table
    if (
      data.kind === "get_user" ||
      data.kind === "get_moment" ||
      data.kind === "get_comment" ||
      data.plan?.viewMode === "detail" ||
      isOpenCreate
    ) {
      persistCurrentPageVersion();
      state.viewMode = "detail";
      state.hasBind = false;
      state.bindMeta = null;
    }
    state.createInitialValues =
      data.plan?.writeForm?.defaults &&
      typeof data.plan.writeForm.defaults === "object"
        ? { ...data.plan.writeForm.defaults }
        : null;
    if (data.schemaComments) {
      state.comments = mergeComments(state.comments, data.schemaComments);
    }
    addMessage("assistant", data.assistantMessage);

    // Approve/Reject only in Admin — demo tracks Apply / syncs Data panel.
    if (data.pending?.status === "awaiting_approval") {
      state.awaitingWrite = true;
      state.pendingRequestId = data.pending.requestId;
      if (data.pending.body) {
        syncDataPanel({
          method: "POST",
          url: `${apijsonBaseUrl.replace(/\/+$/, "")}/${data.pending.method}`,
          json: data.pending.body,
        });
      }
    } else {
      state.awaitingWrite = false;
    }
    const pendingMethod = (data.pending?.method || "").toLowerCase();
    const isPendingEditDelete =
      pendingMethod === "put" || pendingMethod === "delete";
    if (data.guideToDataApi && !isPendingEditDelete) {
      switchTab("data");
      if (data.pending?.body) {
        syncDataPanel({
          method: "POST",
          url: `${apijsonBaseUrl.replace(/\/+$/, "")}/${data.pending.method || "get"}`,
          json: data.pending.body,
        });
      }
    }

    // New comment / New moment → empty detail create form (never Table)
    if (isOpenCreate && createTable) {
      state.hasBind = false;
      activateIndependentPage({
        table: createTable,
        kind: "create",
        title: data.plan?.title,
        surfaceId: data.plan?.surfaceId,
        bodyTemplate: data.bind?.bodyTemplate ?? { [createTable]: {} },
      });
      renderFilters([]);
      mountCreateView($("result-view"), {
        table: createTable,
        comments: state.comments,
        columnMetas: state.columnMetas,
        fkExpand: state.fkExpand,
        apijsonBaseUrl,
        initialValues: state.createInitialValues,
        initialSlots: state.detailSlots.length ? state.detailSlots : undefined,
        pageTitle: state.pageTitle,
        onSubmit: (payload) => void executeWriteDirect(payload),
        onRelateSync: (payload) => syncRelateFromDetail(payload),
        onColumnMetasChange: (metas) => {
          state.columnMetas = metas;
          persistCurrentPageVersion();
        },
        onPageTitleChange: (title) => commitPageTitle(title),
        onDetailSlotsChange: (slots) => {
          state.detailSlots = slots;
          persistCurrentPageVersion();
        },
        onBack: () => void returnToListPage(),
      });
      return;
    }

    const forceDetail =
      data.kind === "get_user" ||
      data.kind === "get_moment" ||
      data.kind === "get_comment" ||
      data.plan?.viewMode === "detail";

    if (data.bind?.bodyTemplate && data.bind.url && !forceDetail) {
      persistCurrentPageVersion();
      state.hasBind = true;
      state.columnSorts = [];
      state.columnFilters = [];
      state.filterCombineExpr = "";
      state.tableJoins = {};
      state.columnOrder = [];
      state.columnMetas = {};
      state.displayKind = "table";
      state.chartLabelPath = "";
      state.chartValuePath = "";
      state.chartDimensions = [];
      state.chartFieldColors = {};
      state.chartFieldValues = {};
      state.combinedShowTable = true;
      state.bindMeta = {
        url: toBrowserApijsonUrl(data.bind.url, apijsonBaseUrl),
        method: data.bind.method || "get",
        bodyTemplate: data.bind.bodyTemplate,
      };
      const primary = inferPrimaryTable([], data.bind.bodyTemplate);
      state.fkExpand = defaultFkExpandState(primary);
      // Persist expanded FK tables into template so columns appear consistently
      state.bindMeta.bodyTemplate = applyFkExpand(
        data.bind.bodyTemplate,
        primary,
        state.fkExpand,
      );
      const pageFilters = data.plan.filters || [];
      renderFilters(pageFilters);
      setUi(data.dataModel.ui as {
        page?: number;
        count?: number;
        order?: string;
        keyword?: string;
      });
      const identity = normalizePageIdentity({
        table: primary,
        kind: "list",
        surfaceId: data.plan.surfaceId,
        title: data.plan.title,
      });
      state.viewMode = "list";
      state.listPageRef = null;
      saveGeneratedPage(identity.surfaceId, identity.title, pageFilters);
      renderFilters(state.filters);
      setUi(data.dataModel.ui as {
        page?: number;
        count?: number;
        order?: string;
        keyword?: string;
      });
      syncDataPanel({
        method: "POST",
        url: state.bindMeta.url,
        json: data.bind.bodyTemplate,
        response: data.lastResult,
      });
    } else if (data.pending.status === "awaiting_approval") {
      state.hasBind = false;
      renderFilters([]);
      syncDataPanel({
        method: "POST",
        url: `${apijsonBaseUrl.replace(/\/+$/, "")}/${data.pending.method}`,
        json: data.pending.body,
      });
      trackApproval({
        requestId: data.pending.requestId,
        sessionId: data.sessionId,
        summary: `${data.pending.method.toUpperCase()} (chat)`,
        at: new Date().toISOString(),
        lastStatus: "pending",
      });
      // put/delete: stay on Chat; only admin users jump to Admin tab for sensitive.
      if (data.pending.sensitive && isAdminUser()) {
        switchTab("admin");
        void adminPanel.refresh();
      } else if (!data.pending.sensitive && !isPendingEditDelete) {
        switchTab("data");
      }
    } else if (state.viewMode === "detail") {
      state.hasBind = false;
      // Prefer chat kind — single-record bodies like { User: {} } used to
      // miss inferPrimaryTable (no []) and leave a stale Comment title.
      const detailTable =
        data.kind === "get_user"
          ? "User"
          : data.kind === "get_moment"
            ? "Moment"
            : data.kind === "get_comment"
              ? "Comment"
              : createTable ||
                inferPrimaryTable([], data.bind?.bodyTemplate ?? null) ||
                inferPrimaryTable(
                  [],
                  (data.pending?.body as Record<string, unknown>) ?? null,
                );
      if (detailTable) {
        activateIndependentPage({
          table: detailTable,
          kind: "detail",
          title: data.plan?.title,
          surfaceId: data.plan?.surfaceId,
          bodyTemplate:
            data.bind?.bodyTemplate ??
            (data.pending?.body as Record<string, unknown> | undefined) ??
            { [detailTable]: {} },
        });
      }
      renderFilters([]);
      if (data.pending.body) {
        syncDataPanel({
          method: "POST",
          url: `${apijsonBaseUrl.replace(/\/+$/, "")}/${data.pending.method}`,
          json: data.pending.body,
          response: data.lastResult,
        });
      }
    } else {
      state.hasBind = false;
    }

    if (data.lastResult) {
      renderRows(data.lastResult);
      dataPanel.fill({ response: data.lastResult });
    } else if (data.dataModel?.rows) {
      renderRows(data.dataModel.rows);
      dataPanel.fill({ response: data.dataModel.rows });
    }
  } catch (e) {
    addMessage("assistant", e instanceof Error ? e.message : String(e));
  }
}

$("chat-form").onsubmit = (ev) => {
  ev.preventDefault();
  const input = $("chat-input") as HTMLInputElement;
  const msg = input.value.trim();
  if (!msg) return;
  input.value = "";
  void sendChat(msg);
};

for (const btn of Array.from(
  document.querySelectorAll<HTMLButtonElement>(".chips button"),
)) {
  btn.onclick = () => void sendChat(btn.dataset.msg || "");
}

function mergeComments(
  into: SchemaComments | null,
  from: SchemaComments,
): SchemaComments {
  return {
    tables: { ...(into?.tables ?? {}), ...from.tables },
    columns: { ...(into?.columns ?? {}), ...from.columns },
    types: { ...(into?.types ?? {}), ...from.types },
  };
}

(
  window as unknown as {
    __a2apiSetComments?: (c: SchemaComments) => void;
    __a2apiComments?: SchemaComments;
  }
).__a2apiSetComments = (c) => {
  state.comments = mergeComments(state.comments, c);
  (
    window as unknown as { __a2apiComments?: SchemaComments }
  ).__a2apiComments = state.comments;
};

// Prefetch Demo schema comments for tooltips before first query
api<SchemaComments>(
  "/api/schema-comments?tables=User,Moment,Comment,Privacy,apijson_privacy",
)
  .then((c) => {
    state.comments = mergeComments(state.comments, c);
    (
      window as unknown as { __a2apiComments?: SchemaComments }
    ).__a2apiComments = state.comments;
    if (state.lastResponse != null) renderRows(state.lastResponse);
  })
  .catch(() => {
    /* ignore until first successful chat */
  });

// Re-check any writes still waiting on admin approval (every page load)
void syncTrackedApprovalsOnLoad();

api<{ ok: boolean; apijsonBaseUrl: string }>("/api/health")
  .then((h) => {
    const fromServer = (h.apijsonBaseUrl || APIJSON_BROWSER_BASE).trim();
    // Migrate legacy direct :8080 hosts → same-origin /apijson proxy
    const cur = loadSettings();
    if (isLegacyDirectApijsonBase(cur.apijsonBaseUrl || "")) {
      saveSettings({ ...cur, apijsonBaseUrl: fromServer });
    }
    apijsonBaseUrl = loadSettings().apijsonBaseUrl || fromServer;
    void ensureAccessRoles(apijsonBaseUrl);
    void reloadRequestStructures(apijsonBaseUrl);
  })
  .catch(() => {
    const cur = loadSettings();
    if (isLegacyDirectApijsonBase(cur.apijsonBaseUrl || "")) {
      saveSettings({ ...cur, apijsonBaseUrl: APIJSON_BROWSER_BASE });
      apijsonBaseUrl = APIJSON_BROWSER_BASE;
    }
    void ensureAccessRoles(apijsonBaseUrl);
    void reloadRequestStructures(apijsonBaseUrl);
  });

// Right pane: guide until the first successful query fills data
if (state.lastResponse == null) {
  mountWorkspaceGuide($("result-view"));
}

document.addEventListener("mousedown", (ev) => {
  const t = ev.target as Node | null;
  if (!t) return;
  if (
    (t as HTMLElement).closest?.(
      ".page-title-control, .page-version-control",
    )
  ) {
    return;
  }
  closePageMenus();
});

// Restore last generated page chrome after refresh (Search to reload data)
{
  const ref = getActivePageRef();
  const page = ref ? getSavedPage(ref.pageId) : null;
  if (ref && page) {
    const snap =
      getPageVersion(ref.pageId, ref.version) ||
      page.versions.reduce((a, b) => (a.version >= b.version ? a : b));
    if (snap) {
      void switchToSavedPage(ref.pageId, snap.version, { search: false });
    } else {
      renderFilters([]);
    }
  } else if (listSavedPages().length) {
    renderFilters([]);
  }
}

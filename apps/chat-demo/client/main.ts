import {
  inferPrimaryTable,
  parseResponse,
  renderResultView,
  triggerListCreate,
  type ChartDimension,
  type ColumnMeta,
  type DisplayKind,
  type SchemaComments,
  type TableDdlApplyPayload,
  type ViewMode,
  type WritePayload,
} from "./result-view.js";
import {
  applyPaging,
  applyTableQuery,
  buildDefaultFieldCombine,
  cycleSort,
  filterHasValue,
  type ColumnFilter,
  type ColumnSort,
} from "./table-query.js";
import { applyTableJoins, type JoinOp } from "./join-query.js";
import {
  applyFkExpand,
  defaultFkExpandState,
  type FkJoinSpec,
} from "./fk-expand.js";
import {
  addQueryTable,
  removeQueryTable,
  setPrimaryTable,
} from "./query-tables.js";
import { initDataPanel, type DataPanelApi } from "./data-panel.js";
import { initAdminPanel } from "./admin-panel.js";
import {
  isAdminUser,
  llmConfigForApi,
  mountAccountUi,
} from "./account.js";

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
  metaEl: $("meta"),
  onAccountChange: () => syncAdminAccess(),
});

const dataPanel: DataPanelApi = initDataPanel($("tab-data"));
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
  bindMeta: {
    url: string;
    method: string;
    bodyTemplate: Record<string, unknown>;
  } | null;
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
  bindMeta: null,
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

let apijsonBaseUrl = "http://localhost:8080";

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
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
      renderRows(state.lastResponse);
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

      if (payload.table === primary) {
        if (payload.selectedColumns.length) {
          tableObj["@column"] = payload.selectedColumns.join(",");
        } else {
          delete tableObj["@column"];
        }
        listObj[payload.table] = tableObj;
      } else {
        state.fkExpand[payload.table] = {
          enabled: payload.selectedColumns.length > 0,
          columns: [...payload.selectedColumns],
          onTable: payload.onTable || undefined,
          onField: payload.onField || undefined,
        };
        if (payload.joinOp) state.tableJoins[payload.table] = payload.joinOp;
        else delete state.tableJoins[payload.table];
        if (payload.selectedColumns.length && payload.onTable && payload.onField) {
          tableObj["id@"] = `/${payload.onTable}/${payload.onField}`;
          tableObj["@column"] = payload.selectedColumns.join(",");
          listObj[payload.table] = tableObj;
        } else if (!payload.selectedColumns.length) {
          delete listObj[payload.table];
        }
      }

      state.bindMeta.bodyTemplate = applyFkExpand(
        body,
        primary,
        state.fkExpand,
      );
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
    onBackToList: state.hasBind
      ? () => {
          state.viewMode = "list";
          void bound("refresh");
        }
      : undefined,
    onWrite: (payload) => void proposeWrite(payload),
    primaryTable: inferPrimaryTable(
      [],
      state.bindMeta?.bodyTemplate ?? null,
    ),
    bodyTemplate: state.bindMeta?.bodyTemplate ?? null,
    apijsonBaseUrl,
  });
}

const PAGE_COUNT_OPTIONS = [2, 3, 4, 5, 6, 10, 15, 20, 50, 100] as const;
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

/** Single-row toolbar: Search/refresh · Prev · [$page] · Next · [$count] per page */
function renderFilters(filters: FilterDef[]) {
  const pagingOnly = filters.filter(
    (f) => f.key === "page" || f.key === "count",
  );
  const root = $("filters");
  state.filters = pagingOnly;
  if (!pagingOnly.length) {
    root.classList.add("hidden");
    root.innerHTML = "";
    return;
  }
  root.classList.remove("hidden");
  root.innerHTML = "";

  const searchBtn = document.createElement("button");
  searchBtn.type = "button";
  searchBtn.className = "primary";
  searchBtn.id = "btn-search";
  searchBtn.textContent = "Search";
  root.appendChild(searchBtn);

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.id = "btn-prev";
  prevBtn.textContent = "Prev";
  root.appendChild(prevBtn);

  const pageWrap = document.createElement("span");
  pageWrap.className = "toolbar-inline";
  const pageInput = document.createElement("input");
  pageInput.type = "number";
  pageInput.min = "0";
  pageInput.dataset.key = "page";
  pageInput.value = "0";
  pageInput.title = "Page (0-based)";
  pageWrap.appendChild(pageInput);
  root.appendChild(pageWrap);

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.id = "btn-next";
  nextBtn.textContent = "Next";
  root.appendChild(nextBtn);

  const countWrap = document.createElement("span");
  countWrap.className = "toolbar-inline";
  countWrap.appendChild(document.createTextNode("Per page"));
  const countSel = document.createElement("select");
  countSel.dataset.key = "count";
  countSel.title = "Rows per page";
  for (const n of PAGE_COUNT_OPTIONS) {
    const o = document.createElement("option");
    o.value = String(n);
    o.textContent = String(n);
    if (n === DEFAULT_PAGE_COUNT) o.selected = true;
    countSel.appendChild(o);
  }
  countWrap.appendChild(countSel);
  countWrap.appendChild(document.createTextNode("rows"));
  root.appendChild(countWrap);

  const spacer = document.createElement("span");
  spacer.className = "toolbar-spacer";
  root.appendChild(spacer);

  const analyzeBtn = document.createElement("button");
  analyzeBtn.type = "button";
  analyzeBtn.id = "btn-analyze";
  analyzeBtn.textContent = "Analyze";
  analyzeBtn.title = "AI analyzes this page and generates a report";
  root.appendChild(analyzeBtn);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.id = "btn-create";
  addBtn.className = "primary";
  addBtn.textContent = "Add";
  addBtn.title = "Add record";
  root.appendChild(addBtn);

  searchBtn.onclick = () => bound("search");
  addBtn.onclick = () => {
    if (!triggerListCreate()) {
      addMessage("assistant", "Run a list query first, then add a record.");
    }
  };
  analyzeBtn.onclick = () => void runAnalyze(analyzeBtn);
  prevBtn.onclick = () => {
    const page = Number(readUi().page || 0);
    void bound("page_change", { page: Math.max(0, page - 1) });
  };
  nextBtn.onclick = () => {
    const page = Number(readUi().page || 0);
    void bound("page_change", { page: page + 1 });
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
  h.textContent = "Analysis report";
  const meta = document.createElement("span");
  meta.className = "muted";
  meta.textContent = source === "llm" ? "AI generated" : "Local summary";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "detail-back-icon";
  close.setAttribute("aria-label", "Close");
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
    addMessage("assistant", "Run a list query first, then analyze.");
    return;
  }
  const parsed = parseResponse(state.lastResponse);
  if (!parsed.rows.length) {
    addMessage("assistant", "No data to analyze on this page.");
    return;
  }
  const primary = inferPrimaryTable(
    parsed.columns,
    state.bindMeta?.bodyTemplate ?? null,
  );
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Analyzing…";
  try {
    const data = await api<{ report: string; source: string }>("/api/analyze", {
      title: primary ? `${primary} data analysis` : "Data analysis report",
      primaryTable: primary,
      columns: parsed.columns,
      rows: parsed.rows.map((r) => ({ key: r.key, cells: r.cells })),
      llm: llmConfigForApi(),
    });
    showAnalyzeReport(data.report, data.source);
    addMessage(
      "assistant",
      data.source === "llm"
        ? "AI analysis report generated."
        : "Analysis report generated (local summary when no model key is configured).",
    );
  } catch (e) {
    addMessage("assistant", e instanceof Error ? e.message : String(e));
  } finally {
    btn.disabled = false;
    btn.textContent = prev || "Analyze";
  }
}

async function proposeWrite(payload: WritePayload) {
  const verb =
    payload.method === "post"
      ? "Create"
      : payload.method === "delete"
        ? "Delete"
        : "Save";
  try {
    const data = await api<{
      sessionId: string;
      pending: {
        requestId: string;
        method: string;
        body: unknown;
        status: string;
        issues?: string[];
        sensitive?: boolean;
        approvalId?: string;
      };
    }>("/api/propose", {
      sessionId: state.sessionId,
      method: payload.method,
      body: payload.body,
      rationale: `${verb} ${payload.table} from UI`,
    });
    state.sessionId = data.sessionId;
    showHitl(data.pending);
    syncDataPanel({
      method: "POST",
      url: `http://localhost:8080/${payload.method}`,
      json: payload.body,
    });
    if (data.pending.status === "awaiting_approval") {
      addMessage(
        "assistant",
        `${verb} is sensitive — queued for admin approval (${payload.method.toUpperCase()} ${payload.table}).`,
      );
      if (isAdminUser()) {
        switchTab("admin");
        void adminPanel.refresh();
      }
      return;
    }
    if (data.pending.status === "done") {
      const audit = data.pending.approvalId
        ? ` Auto-approved (${data.pending.approvalId}).`
        : "";
      addMessage("assistant", `${verb} succeeded.${audit}`);
      await returnToListAndRefresh();
      return;
    }
    addMessage(
      "assistant",
      `${verb} failed: ${data.pending.issues?.join("; ") || data.pending.status}`,
    );
  } catch (e) {
    addMessage("assistant", e instanceof Error ? e.message : String(e));
  }
}

async function returnToListAndRefresh() {
  state.viewMode = "list";
  state.awaitingWrite = false;
  if (state.hasBind) {
    await bound("refresh");
  } else if (state.lastResponse != null) {
    renderRows(state.lastResponse);
  }
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

function showHitl(pending: {
  requestId: string;
  method: string;
  body: unknown;
  status: string;
  sensitive?: boolean;
}) {
  if (pending.status !== "awaiting_approval") {
    $("hitl").classList.add("hidden");
    state.awaitingWrite = false;
    return;
  }
  state.awaitingWrite = true;
  state.pendingRequestId = pending.requestId;
  $("hitl").classList.remove("hidden");
  const hint = $("hitl").querySelector(".hint-inline");
  if (hint) {
    hint.textContent = pending.sensitive
      ? isAdminUser()
        ? "Sensitive op — approve in Admin tab (or here)"
        : "Sensitive op — waiting for vendor admin approval"
      : "Write pending approval — edit in Data tab, then Approve";
  }
  syncDataPanel({
    method: "POST",
    url: `http://localhost:8080/${pending.method}`,
    json: pending.body,
  });
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
  if (!state.sessionId || !state.hasBind || !state.bindMeta) {
    addMessage("assistant", "Bootstrap a list request via chat first.");
    return;
  }
  const ui = { ...readUi(), ...uiOverride };
  if (uiOverride) setUi(ui);

  // Prefer building request on client so sort/filter work even if API server
  // hasn't been restarted with the latest boundAction changes.
  let body = applyPaging(
    state.bindMeta.bodyTemplate,
    Number(ui.page ?? 0),
    normalizePageCount(ui.count ?? DEFAULT_PAGE_COUNT),
  );
  body = applyTableQuery(
    body,
    state.bindMeta.bodyTemplate,
    state.columnSorts,
    state.columnFilters,
    state.filterCombineExpr,
  );
  const primary = inferPrimaryTable([], state.bindMeta.bodyTemplate);
  if (!Object.keys(state.fkExpand).length && primary) {
    state.fkExpand = defaultFkExpandState(primary);
  }
  body = applyFkExpand(body, primary, state.fkExpand);
  body = applyTableJoins(body, primary, state.tableJoins);

  syncDataPanel({
    method: "POST",
    url: state.bindMeta.url,
    json: body,
  });

  try {
    const res = await fetch(state.bindMeta.url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { code?: number; msg?: string };
    const ok = res.ok && json.code === 200;
    if (ok) {
      renderRows(json);
      dataPanel.fill({ response: json });
      $("mode-hint").textContent =
        "Headers: ▽ filter (left) · ↑↓ sort (right, multi-field) · hover for DDL comments; switch to Data tab to debug.";
    } else {
      addMessage("assistant", `Direct call failed: ${json.msg || res.statusText}`);
      dataPanel.fill({ response: json });
      if (state.lastResponse != null) renderRows(state.lastResponse);
    }

    // Best-effort sync session on server (ignore failures / old servers)
    void api("/api/bound", {
      sessionId: state.sessionId,
      action,
      ui,
      sorts: state.columnSorts,
      filters: state.columnFilters,
      combineExpr: state.filterCombineExpr,
    }).catch(() => undefined);
  } catch (e) {
    addMessage("assistant", e instanceof Error ? e.message : String(e));
  }
}

async function sendChat(message: string) {
  addMessage("user", message);
  try {
    const data = await api<{
      sessionId: string;
      assistantMessage: string;
      pending: {
        requestId: string;
        method: string;
        body: unknown;
        status: string;
        sensitive?: boolean;
        approvalId?: string;
      };
      plan: {
        filters: FilterDef[];
        writeForm?: unknown;
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
    if (data.schemaComments) {
      state.comments = mergeComments(state.comments, data.schemaComments);
    }
    addMessage("assistant", data.assistantMessage);
    $("surface-title").textContent =
      data.plan?.title || data.plan?.surfaceId || "Workspace";

    showHitl(data.pending);

    if (data.bind?.bodyTemplate && data.bind.url) {
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
        url: data.bind.url,
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
      renderFilters(data.plan.filters || []);
      setUi(data.dataModel.ui as {
        page?: number;
        count?: number;
        order?: string;
        keyword?: string;
      });
      $("mode-hint").textContent =
        "Bound. Toolbar paging · header filter/sort/drag columns · edit detail and save to return to list.";
      syncDataPanel({
        method: "POST",
        url: data.bind.url,
        json: data.bind.bodyTemplate,
        response: data.lastResult,
      });
    } else if (data.pending.status === "awaiting_approval") {
      state.hasBind = false;
      renderFilters([]);
      $("mode-hint").textContent = data.pending.sensitive
        ? "Sensitive write queued for admin approval."
        : "Write pending approval — synced to Data tab; edit there, then Approve in UI.";
      syncDataPanel({
        method: "POST",
        url: `http://localhost:8080/${data.pending.method}`,
        json: data.pending.body,
      });
      if (data.pending.sensitive && isAdminUser()) {
        switchTab("admin");
        void adminPanel.refresh();
      } else if (!data.pending.sensitive) {
        switchTab("data");
      }
    } else if (state.viewMode === "detail") {
      state.hasBind = false;
      renderFilters([]);
      $("mode-hint").textContent = "Single-record detail (hover fields for DDL comments).";
      if (data.pending.body) {
        syncDataPanel({
          method: "POST",
          url: `http://localhost:8080/${data.pending.method}`,
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

$("btn-approve").onclick = async () => {
  if (!state.sessionId || !state.pendingRequestId) return;
  try {
    // Body comes from Data tab (edit there before Approve)
    const dataJson = dataPanel.readRequest().json;
    const fromData = JSON.parse(dataJson || "{}") as Record<string, unknown>;
    const bodyObj =
      fromData.body && typeof fromData.body === "object"
        ? (fromData.body as Record<string, unknown>)
        : fromData;
    const parsed = { body: bodyObj };
    const data = await api<{
      pending: { status: string; result?: { body: unknown } };
      lastResult?: unknown;
      schemaComments?: SchemaComments;
    }>("/api/decide", {
      sessionId: state.sessionId,
      requestId: state.pendingRequestId,
      action: "approve",
      body: parsed.body,
    });
    $("hitl").classList.add("hidden");
    state.awaitingWrite = false;
    addMessage(
      "assistant",
      data.pending.status === "done"
        ? "Approved and executed successfully."
        : `Status: ${data.pending.status}`,
    );
    if (data.pending.status === "done") {
      // Detail save / writes: return to bound list and refresh when possible
      if (state.hasBind) {
        await returnToListAndRefresh();
      } else if (data.lastResult) {
        state.viewMode = "detail";
        renderRows(data.lastResult);
      }
    }
  } catch (e) {
    addMessage("assistant", e instanceof Error ? e.message : String(e));
  }
};

$("btn-reject").onclick = async () => {
  if (!state.sessionId || !state.pendingRequestId) return;
  try {
    await api("/api/decide", {
      sessionId: state.sessionId,
      requestId: state.pendingRequestId,
      action: "reject",
    });
    $("hitl").classList.add("hidden");
    state.awaitingWrite = false;
    addMessage("assistant", "Write operation rejected.");
  } catch (e) {
    addMessage("assistant", e instanceof Error ? e.message : String(e));
  }
};

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
  window as unknown as { __a2apiSetComments?: (c: SchemaComments) => void }
).__a2apiSetComments = (c) => {
  state.comments = mergeComments(state.comments, c);
};

// Prefetch Demo schema comments for tooltips before first query
api<SchemaComments>("/api/schema-comments?tables=User,Moment,Comment")
  .then((c) => {
    state.comments = mergeComments(state.comments, c);
    if (state.lastResponse != null) renderRows(state.lastResponse);
  })
  .catch(() => {
    /* ignore until first successful chat */
  });

api<{ ok: boolean; apijsonBaseUrl: string }>("/api/health")
  .then((h) => {
    apijsonBaseUrl = h.apijsonBaseUrl || apijsonBaseUrl;
    $("meta").textContent = `APIJSON → ${apijsonBaseUrl}`;
  })
  .catch(() => {
    $("meta").textContent = "API offline";
  });

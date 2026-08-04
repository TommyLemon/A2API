/**
 * Admin SPA: ordinary Apply/Call CRUD → APIJSON Server HTTP.
 * Approve workflow → admin server only.
 */

import {
  hydrateAccountFromSession,
  loadSettings,
  logoutAccount,
  mountAccountUi,
  saveSettings,
} from "./account.js";
import {
  ensureApijson,
  isUnauthorizedCode,
  loadSavedCreds,
  notifySessionExpired,
  resetApijsonSession,
  setSessionExpiredHandler,
} from "./aj-http.js";
import {
  getApply,
  listAppliesPage,
  updateApply,
  type ApplicationStatus,
  type ConfigApplication,
} from "./apply-api.js";
import {
  computeCallStats,
  listCalls,
  listCallsPage,
  type CallLog,
  type CallStats,
} from "./call-api.js";
import { applyDomI18n, mountLocaleToggle, t } from "./i18n/index.js";
import { mountVerticalSplit } from "./split-resize.js";

applyDomI18n();
mountLocaleToggle();
document.title = t("meta.title");

type WriteTargetResult = {
  ok: boolean;
  action?: string;
  id?: number | string;
  error?: string;
};

type ViewId = "apply" | "calls" | "stats";

async function adminApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let data: T & {
    error?: string;
    msg?: string;
    code?: number | string;
  };
  try {
    data = (text ? JSON.parse(text) : {}) as typeof data;
  } catch {
    throw new Error(
      `Invalid JSON from ${path} (HTTP ${res.status}): ${text.slice(0, 120)}`,
    );
  }
  if (isUnauthorizedCode(data.code)) {
    notifySessionExpired();
    throw new Error(data.msg || data.error || "Unauthorized");
  }
  if (!res.ok) {
    throw new Error(data.error || data.msg || res.statusText);
  }
  return data;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

function fmtTime(iso?: string): string {
  if (!iso) return t("common.dash");
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const listEl = $("app-list");
const form = $("detail-form") as HTMLFormElement;
const emptyEl = $("detail-empty");
const actionsEl = $("detail-actions");
const issuesEl = $("issues");
const writeEl = $("write-results");
const statusEl = $("form-status");
const hintEl = $("apijson-hint");

let items: ConfigApplication[] = [];
let selectedId: string | null = null;
let currentView: ViewId = "apply";

const PAGE_SIZE = 20;
let applyPage = 0;
let applyTotal = 0;
let applyOrder = "id-";
let applySearchTimer: ReturnType<typeof setTimeout> | null = null;

let callPage = 0;
let callTotal = 0;
let callOrder = "date-";
let callSearchTimer: ReturnType<typeof setTimeout> | null = null;

const accountUi = mountAccountUi({
  headerEl: document.querySelector(".top-right") as HTMLElement,
  onSettingsChange: (s) => {
    resetApijsonSession();
    void ensureApijson({
      baseUrl: s.apijsonBaseUrl,
      login: loadSavedCreds().login,
      password: loadSavedCreds().password,
    })
      .then(() => hydrateAccountFromSession())
      .then(() => {
        accountUi.refresh();
        hintEl.textContent = "";
        return refreshCurrent();
      })
      .catch(() => {
        hintEl.textContent = t("apply.loginRequired", { url: s.apijsonBaseUrl });
      });
  },
  onAccountChange: () => {
    // Creds already cleared on logout; just refresh lists (BFF works without session).
    void refreshCurrent();
  },
});

{
  const applyLayout = $("view-apply");
  const callsLayout = $("view-calls");
  const splitOpts = {
    cssVar: "--admin-list-pct",
    storageKey: "a2api.adminListSplitPct",
    defaultPct: 32,
    minPct: 18,
    maxPct: 60,
    bodyClass: "is-resizing-admin",
  } as const;
  mountVerticalSplit({
    split: applyLayout,
    handle: $("apply-split-handle"),
    ...splitOpts,
    syncSplits: [callsLayout],
  });
  mountVerticalSplit({
    split: callsLayout,
    handle: $("calls-split-handle"),
    ...splitOpts,
    syncSplits: [applyLayout],
  });
}

setSessionExpiredHandler(() => {
  logoutAccount();
  accountUi.refresh();
  hintEl.textContent = t("apply.sessionExpired");
  setStatus(t("apply.sessionExpired"), "err");
});

function selectedStatuses(): ApplicationStatus[] {
  const out: ApplicationStatus[] = [];
  if ((document.getElementById("f-pending") as HTMLInputElement).checked)
    out.push("pending");
  if ((document.getElementById("f-approved") as HTMLInputElement).checked)
    out.push("approved");
  if ((document.getElementById("f-rejected") as HTMLInputElement).checked)
    out.push("rejected");
  return out;
}

function applyQueryOpts() {
  const statuses = selectedStatuses();
  const op = (document.getElementById("apply-filter-op") as HTMLSelectElement)
    .value;
  const q = (document.getElementById("apply-q") as HTMLInputElement).value.trim();
  applyOrder =
    (document.getElementById("apply-sort") as HTMLSelectElement).value || "id-";
  return {
    status: statuses.length ? statuses : undefined,
    operation: op || undefined,
    q: q || undefined,
    page: applyPage,
    pageSize: PAGE_SIZE,
    order: applyOrder,
  };
}

function callQueryOpts() {
  const op = (document.getElementById("call-filter-op") as HTMLSelectElement)
    .value;
  const ok = (document.getElementById("call-filter-ok") as HTMLSelectElement)
    .value;
  const source = (
    document.getElementById("call-filter-source") as HTMLSelectElement
  ).value;
  const q = (document.getElementById("call-q") as HTMLInputElement).value.trim();
  callOrder =
    (document.getElementById("call-sort") as HTMLSelectElement).value || "date-";
  return {
    operation: op || undefined,
    ok: ok === "true" ? true : ok === "false" ? false : undefined,
    source: source || undefined,
    q: q || undefined,
    page: callPage,
    pageSize: PAGE_SIZE,
    order: callOrder,
  };
}

function updatePager(
  prevId: string,
  nextId: string,
  metaId: string,
  page: number,
  pageSize: number,
  total: number,
  itemCount: number,
) {
  const pageCount = Math.max(1, Math.ceil(Math.max(total, 1) / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const from = itemCount === 0 ? 0 : safePage * pageSize + 1;
  const to = safePage * pageSize + itemCount;
  ($(metaId) as HTMLElement).textContent =
    itemCount === 0
      ? t("apply.zeroResults")
      : t("apply.pageMeta", { from, to, total, page: safePage + 1 });
  ($(prevId) as HTMLButtonElement).disabled = safePage <= 0;
  ($(nextId) as HTMLButtonElement).disabled =
    itemCount === 0 ||
    itemCount < pageSize ||
    (safePage + 1) * pageSize >= total;
}

function setStatus(msg: string, kind: "" | "ok" | "err" = "") {
  statusEl.textContent = msg;
  statusEl.className = `status${kind ? ` ${kind}` : ""}`;
}

function readForm(): Partial<ConfigApplication> {
  const fd = new FormData(form);
  const structureRaw = String(fd.get("structure") || "").trim();
  const jsonRaw = String(fd.get("json") || "").trim();
  let structure: Record<string, unknown> | undefined;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(jsonRaw) as Record<string, unknown>;
  } catch {
    throw new Error(t("apply.invalidBody"));
  }
  if (structureRaw) {
    try {
      structure = JSON.parse(structureRaw) as Record<string, unknown>;
    } catch {
      throw new Error(t("apply.invalidStructure"));
    }
  }
  return {
    table: String(fd.get("table") || "").trim(),
    operation: String(fd.get("operation") || "").trim().toLowerCase(),
    role: String(fd.get("role") || "").trim().toUpperCase(),
    version: Number(fd.get("version") || 1),
    tag: String(fd.get("tag") || "").trim(),
    accessAlias: String(fd.get("accessAlias") || "").trim() || undefined,
    accessName: String(fd.get("accessName") || "").trim() || undefined,
    name: String(fd.get("name") || "").trim() || undefined,
    method: String(fd.get("method") || "POST").trim().toUpperCase(),
    type: String(fd.get("type") || "JSON").trim().toUpperCase(),
    url: String(fd.get("url") || "").trim(),
    detail: String(fd.get("detail") || "").trim() || undefined,
    structure,
    json,
  };
}

function fillForm(row: ConfigApplication) {
  const set = (name: string, value: string | number) => {
    const el = form.elements.namedItem(name) as
      | HTMLInputElement
      | HTMLSelectElement
      | HTMLTextAreaElement
      | null;
    if (el) el.value = String(value ?? "");
  };
  set("table", row.table);
  set("operation", row.operation);
  set("role", row.role);
  set("version", row.version);
  set("tag", row.tag || row.table);
  set("accessAlias", row.accessAlias || "");
  set("accessName", row.accessName || "");
  set("name", row.name || "");
  set("method", row.method || "POST");
  set("type", row.type || "JSON");
  set("url", row.url);
  set("detail", row.detail || "");
  set("structure", JSON.stringify(row.structure ?? {}, null, 2));
  set("json", JSON.stringify(row.json ?? {}, null, 2));

  if (row.issues?.length) {
    issuesEl.hidden = false;
    issuesEl.textContent = t("apply.issues", { list: row.issues.join("\n") });
  } else {
    issuesEl.hidden = true;
    issuesEl.textContent = "";
  }

  if (row.writeResults || row.error) {
    writeEl.hidden = false;
    const lines: string[] = [];
    if (row.error) lines.push(row.error);
    for (const [k, v] of Object.entries(row.writeResults || {})) {
      const wr = v as WriteTargetResult;
      lines.push(
        `${k}: ${wr.ok ? t("apply.writeOk", { id: wr.id != null ? ` id=${wr.id}` : "" }) : wr.error || t("apply.writeFailed")}`,
      );
    }
    writeEl.textContent = lines.join("\n");
  } else {
    writeEl.hidden = true;
    writeEl.textContent = "";
  }

  const editable = row.status === "pending";
  for (const el of Array.from(form.elements)) {
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
    ) {
      el.disabled = !editable;
    }
  }
  ($("btn-save") as HTMLButtonElement).disabled = !editable;
  ($("btn-approve") as HTMLButtonElement).disabled = !editable;
  ($("btn-reject") as HTMLButtonElement).disabled = !editable;
}

function renderList() {
  listEl.innerHTML = "";
  updatePager(
    "apply-prev",
    "apply-next",
    "apply-page-meta",
    applyPage,
    PAGE_SIZE,
    applyTotal,
    items.length,
  );
  if (!items.length) {
    listEl.innerHTML = `<div class="muted pad">${t("apply.noApplications")}</div>`;
    return;
  }
  for (const row of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `app-item${row.id === selectedId ? " active" : ""}`;
    btn.dataset.testid = "apply-item";
    btn.dataset.applyId = row.id;
    btn.dataset.requestId = row.requestId || "";
    const tag = row.tag?.trim();
    const tagHtml =
      tag && tag !== row.table
        ? ` <span class="app-tag">${escapeHtml(tag)}</span>`
        : "";
    btn.innerHTML = `
      <div class="title">
        ${escapeHtml(row.operation.toUpperCase())} ${escapeHtml(row.table)}${tagHtml}
        <span class="badge badge-${row.status}">${
          row.status === "pending"
            ? t("apply.pending")
            : row.status === "approved"
              ? t("apply.approved")
              : row.status === "rejected"
                ? t("apply.rejected")
                : row.status
        }</span>
      </div>
      <div class="meta">${escapeHtml(row.role)} · v${row.version} · ${fmtTime(row.createdAt)}</div>
      <div class="meta">${escapeHtml(row.method)} ${escapeHtml(row.type)} ${escapeHtml(row.url)}</div>
    `;
    btn.onclick = () => void select(row.id);
    listEl.appendChild(btn);
  }
}

async function select(id: string) {
  selectedId = id;
  renderList();
  // Prefer admin BFF (includes local JSONL fallback); APIJSON get as secondary
  let item: ConfigApplication | null = null;
  try {
    const data = await adminApi<{ item: ConfigApplication }>(
      `/api/applications/${encodeURIComponent(id)}`,
    );
    item = data.item;
  } catch {
    item = await getApply(id);
  }
  if (!item) throw new Error("not found");
  emptyEl.hidden = true;
  form.hidden = false;
  actionsEl.hidden = false;
  fillForm(item);
  setStatus("");
}

async function initApijson(): Promise<void> {
  const cfg = await adminApi<{ apijsonBaseUrl: string }>("/api/config");
  const settings = loadSettings();
  const baseUrl =
    settings.apijsonBaseUrl?.trim() || cfg.apijsonBaseUrl || "http://localhost:8080";
  if (!settings.apijsonBaseUrl?.trim()) {
    saveSettings({ ...settings, apijsonBaseUrl: baseUrl });
  }
  const creds = loadSavedCreds();
  await ensureApijson({
    baseUrl,
    login: creds.login,
    password: creds.password,
  });
  await hydrateAccountFromSession();
  accountUi.refresh();
  hintEl.textContent = "";
}

async function refreshApply() {
  try {
    // BFF list first (DB + local fallback). APIJSON login optional for approve writes.
    try {
      await initApijson();
    } catch {
      hintEl.textContent = t("apply.loginSkipped");
    }
    const opts = applyQueryOpts();
    const q = new URLSearchParams();
    q.set("page", String(opts.page));
    q.set("pageSize", String(opts.pageSize));
    q.set("order", opts.order);
    if (opts.status?.length) q.set("status", opts.status.join(","));
    if (opts.operation) q.set("operation", opts.operation);
    if (opts.q) q.set("q", opts.q);
    const data = await adminApi<{
      items: ConfigApplication[];
      total?: number;
      page?: number;
      pageSize?: number;
      order?: string;
    }>(`/api/applications?${q}`);
    items = data.items || [];
    applyTotal = typeof data.total === "number" ? data.total : items.length;
    applyPage = typeof data.page === "number" ? data.page : applyPage;
    // Merge APIJSON rows if BFF list is empty
    if (!items.length && applyPage === 0) {
      try {
        const fallback = await listAppliesPage(opts);
        items = fallback.items;
        applyTotal = fallback.total;
        applyPage = fallback.page;
      } catch {
        /* keep BFF result */
      }
    }
    renderList();
    if (selectedId && items.some((r) => r.id === selectedId)) {
      await select(selectedId);
    }
  } catch (e) {
    listEl.innerHTML = `<div class="muted pad">${t("apply.failed", {
      msg: escapeHtml(e instanceof Error ? e.message : String(e)),
    })}</div>`;
    updatePager(
      "apply-prev",
      "apply-next",
      "apply-page-meta",
      applyPage,
      PAGE_SIZE,
      0,
      0,
    );
  }
}

const callListEl = $("call-list");
const callDetailEl = $("call-detail");
const callEmptyEl = $("call-detail-empty");
let calls: CallLog[] = [];
let selectedCallId: string | null = null;

function renderCallList() {
  callListEl.innerHTML = "";
  updatePager(
    "call-prev",
    "call-next",
    "call-page-meta",
    callPage,
    PAGE_SIZE,
    callTotal,
    calls.length,
  );
  if (!calls.length) {
    callListEl.innerHTML = `<div class="muted pad">${t("calls.noCalls")}</div>`;
    return;
  }
  for (const row of calls) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `app-item${row.id === selectedCallId ? " active" : ""}`;
    btn.innerHTML = `
      <div class="title">
        ${escapeHtml(row.operation.toUpperCase())} ${escapeHtml(row.bizTable || row.tag || "")}
        <span class="badge ${row.ok ? "badge-ok" : "badge-fail"}">${row.ok ? t("calls.badgeOk") : t("calls.badgeFail")}</span>
      </div>
      <div class="meta">${escapeHtml(row.source)} · ${row.durationMs ?? "—"}ms · ${fmtTime(row.date)}</div>
      <div class="meta">${escapeHtml(row.url)}</div>
    `;
    btn.onclick = () => selectCall(row.id);
    callListEl.appendChild(btn);
  }
}

function selectCall(id: string) {
  selectedCallId = id;
  renderCallList();
  const row = calls.find((c) => c.id === id);
  if (!row) return;
  callEmptyEl.hidden = true;
  callDetailEl.hidden = false;
  callDetailEl.innerHTML = `
    <dl class="call-kv">
      <dt>${t("calls.status")}</dt><dd>${t("calls.statusLine", {
        status: row.ok ? t("calls.badgeOk") : t("calls.badgeFail"),
        code: row.code ?? t("common.dash"),
      })}</dd>
      <dt>${t("calls.operation")}</dt><dd>${escapeHtml(row.operation)} · ${escapeHtml(row.method)} ${escapeHtml(row.type)}</dd>
      <dt>${t("calls.tableTag")}</dt><dd>${escapeHtml(row.bizTable || t("common.dash"))} / ${escapeHtml(row.tag || t("common.dash"))}</dd>
      <dt>${t("calls.sourceLabel")}</dt><dd>${escapeHtml(row.source)}${row.usedLlm ? " · usedLlm" : ""}</dd>
      <dt>${t("calls.duration")}</dt><dd>${t("calls.durationMs", { ms: row.durationMs ?? t("common.dash") })}</dd>
      <dt>${t("calls.url")}</dt><dd>${escapeHtml(row.url)}</dd>
      <dt>${t("calls.submitter")}</dt><dd>${t("calls.submitterLine", {
        submitter: escapeHtml(String(row.submitter ?? t("common.dash"))),
        userId: escapeHtml(String(row.userId ?? t("common.dash"))),
      })}</dd>
      <dt>${t("calls.session")}</dt><dd>${escapeHtml(row.sessionId || t("common.dash"))}</dd>
      <dt>${t("calls.requestId")}</dt><dd>${escapeHtml(row.requestId || t("common.dash"))}</dd>
      <dt>${t("calls.when")}</dt><dd>${fmtTime(row.date)}</dd>
      <dt>${t("calls.error")}</dt><dd>${escapeHtml(row.error || t("common.dash"))}</dd>
      <dt>${t("calls.detailLabel")}</dt><dd>${escapeHtml(row.detail || t("common.dash"))}</dd>
    </dl>
    <div class="muted" style="margin-bottom:4px">${t("calls.request")}</div>
    <pre class="pre-block">${escapeHtml(row.request || "{}")}</pre>
    <div class="muted" style="margin-bottom:4px">${t("calls.response")}</div>
    <pre class="pre-block">${escapeHtml(row.response || t("common.dash"))}</pre>
  `;
}

async function refreshCalls() {
  try {
    try {
      await initApijson();
    } catch {
      /* BFF list does not require browser APIJSON session */
    }
    const opts = callQueryOpts();
    const result = await listCallsPage(opts);
    calls = result.items;
    callTotal = result.total;
    callPage = result.page;
    renderCallList();
    if (selectedCallId && calls.some((c) => c.id === selectedCallId)) {
      selectCall(selectedCallId);
    }
  } catch (e) {
    callListEl.innerHTML = `<div class="muted pad">${t("calls.failed", {
      msg: escapeHtml(e instanceof Error ? e.message : String(e)),
    })}</div>`;
    updatePager(
      "call-prev",
      "call-next",
      "call-page-meta",
      callPage,
      PAGE_SIZE,
      0,
      0,
    );
  }
}

function renderBucketTable(
  el: HTMLElement,
  rows: Array<{ key: string; total: number; ok: number; failed: number }>,
) {
  if (!rows.length) {
    el.innerHTML = `<div class="muted">${t("stats.noData")}</div>`;
    return;
  }
  el.innerHTML = `
    <table class="stats-table">
      <thead><tr><th>${t("stats.key")}</th><th class="num">${t("stats.total")}</th><th class="num">${t("stats.ok")}</th><th class="num">${t("stats.fail")}</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `<tr>
              <td>${escapeHtml(r.key)}</td>
              <td class="num">${r.total}</td>
              <td class="num">${r.ok}</td>
              <td class="num">${r.failed}</td>
            </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

async function refreshStats() {
  const summary = $("stats-summary");
  try {
    try {
      await initApijson();
    } catch {
      /* BFF list does not require browser APIJSON session */
    }
    const items = await listCalls({ limit: 500 });
    const s: CallStats = computeCallStats(items);
    const rate = s.total ? Math.round((s.ok / s.total) * 100) : 0;
    summary.innerHTML = `
      <div class="stat-pill"><div class="label">${t("stats.total")}</div><div class="value">${s.total}</div></div>
      <div class="stat-pill"><div class="label">${t("stats.ok")}</div><div class="value">${s.ok}</div></div>
      <div class="stat-pill"><div class="label">${t("stats.failed")}</div><div class="value">${s.failed}</div></div>
      <div class="stat-pill"><div class="label">${t("stats.successRate")}</div><div class="value">${rate}%</div></div>
      <div class="stat-pill"><div class="label">${t("stats.avgDuration")}</div><div class="value">${s.avgDurationMs ?? t("common.dash")}ms</div></div>
      <div class="stat-pill"><div class="label">${t("stats.usedLlm")}</div><div class="value">${s.usedLlm}</div></div>
    `;
    renderBucketTable($("stats-op"), s.byOperation);
    renderBucketTable($("stats-table"), s.byTable);
    renderBucketTable($("stats-source"), s.bySource);
    renderBucketTable($("stats-day"), s.byDay);
    const errEl = $("stats-errors");
    if (!s.topErrors.length) {
      errEl.innerHTML = `<div class="muted">${t("stats.noErrors")}</div>`;
    } else {
      errEl.innerHTML = `
        <table class="stats-table">
          <thead><tr><th>${t("stats.error")}</th><th class="num">${t("stats.count")}</th></tr></thead>
          <tbody>
            ${s.topErrors
              .map(
                (e) => `<tr><td>${escapeHtml(e.key)}</td><td class="num">${e.count}</td></tr>`,
              )
              .join("")}
          </tbody>
        </table>`;
    }
  } catch (e) {
    summary.innerHTML = `<div class="muted">${t("stats.failedLoad", {
      msg: escapeHtml(e instanceof Error ? e.message : String(e)),
    })}</div>`;
  }
}

function setView(view: ViewId) {
  currentView = view;
  for (const v of ["apply", "calls", "stats"] as ViewId[]) {
    const el = $(`view-${v}`);
    const on = v === view;
    el.classList.toggle("hidden", !on);
    el.hidden = !on;
  }
  document.querySelectorAll<HTMLButtonElement>(".main-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  void refreshCurrent();
}

async function refreshCurrent() {
  if (currentView === "apply") await refreshApply();
  else if (currentView === "calls") await refreshCalls();
  else await refreshStats();
}

document.querySelectorAll<HTMLButtonElement>(".main-tab").forEach((btn) => {
  btn.onclick = () => setView((btn.dataset.view || "apply") as ViewId);
});

$("btn-refresh").onclick = () => void refreshCurrent();

function resetApplyPageAndRefresh() {
  applyPage = 0;
  void refreshApply();
}

function resetCallPageAndRefresh() {
  callPage = 0;
  void refreshCalls();
}

for (const id of ["f-pending", "f-approved", "f-rejected"]) {
  document.getElementById(id)?.addEventListener("change", resetApplyPageAndRefresh);
}
for (const id of ["apply-filter-op", "apply-sort"]) {
  document.getElementById(id)?.addEventListener("change", resetApplyPageAndRefresh);
}
document.getElementById("apply-q")?.addEventListener("input", () => {
  if (applySearchTimer) clearTimeout(applySearchTimer);
  applySearchTimer = setTimeout(resetApplyPageAndRefresh, 280);
});
$("apply-prev").onclick = () => {
  if (applyPage <= 0) return;
  applyPage -= 1;
  void refreshApply();
};
$("apply-next").onclick = () => {
  applyPage += 1;
  void refreshApply();
};

for (const id of ["call-filter-op", "call-filter-ok", "call-filter-source", "call-sort"]) {
  document.getElementById(id)?.addEventListener("change", resetCallPageAndRefresh);
}
document.getElementById("call-q")?.addEventListener("input", () => {
  if (callSearchTimer) clearTimeout(callSearchTimer);
  callSearchTimer = setTimeout(resetCallPageAndRefresh, 280);
});
$("call-prev").onclick = () => {
  if (callPage <= 0) return;
  callPage -= 1;
  void refreshCalls();
};
$("call-next").onclick = () => {
  callPage += 1;
  void refreshCalls();
};

$("btn-save").onclick = async () => {
  if (!selectedId) return;
  try {
    const patch = readForm();
    await updateApply(selectedId, patch);
    setStatus(t("apply.saved"), "ok");
    await refreshApply();
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), "err");
  }
};

$("btn-reject").onclick = async () => {
  if (!selectedId) return;
  if (!window.confirm(t("apply.confirmReject"))) return;
  try {
    // Prefer admin BFF (works for local JSONL fallback + DB Apply)
    await adminApi(`/api/applications/${encodeURIComponent(selectedId)}/decide`, {
      method: "POST",
      body: JSON.stringify({
        action: "reject",
        decidedBy: "admin-ui",
      }),
    });
    await refreshApply();
    setStatus(t("apply.rejectedOk"), "ok");
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), "err");
  }
};

$("btn-approve").onclick = async () => {
  if (!selectedId) return;
  try {
    const patch = readForm();
    setStatus(t("apply.approving"));
    const creds = loadSavedCreds();
    const result = await adminApi<{
      ok: boolean;
      item: ConfigApplication;
      results?: Record<string, WriteTargetResult>;
      error?: string;
    }>(`/api/applications/${encodeURIComponent(selectedId)}/decide`, {
      method: "POST",
      body: JSON.stringify({
        action: "approve",
        decidedBy: "admin-ui",
        patch,
        login: creds.login,
        password: creds.password,
      }),
    });
    if (result.ok) {
      await refreshApply();
      setStatus(t("apply.approvedOk"), "ok");
    } else {
      const parts = Object.entries(result.results || {})
        .map(([k, v]) => `${k}: ${v.ok ? "OK" : v.error || "fail"}`)
        .join("; ");
      await refreshApply();
      setStatus(
        t("apply.partialBlocked", { parts }),
        "err",
      );
    }
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), "err");
  }
};

void refreshApply();

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
  getApijsonBase,
  isUnauthorizedCode,
  loadSavedCreds,
  notifySessionExpired,
  resetApijsonSession,
  setSessionExpiredHandler,
} from "./aj-http.js";
import {
  getApply,
  listApplies,
  updateApply,
  type ApplicationStatus,
  type ConfigApplication,
} from "./apply-api.js";
import {
  computeCallStats,
  listCalls,
  type CallLog,
  type CallStats,
} from "./call-api.js";

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
  if (!iso) return "—";
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
        hintEl.textContent = `APIJSON ${getApijsonBase()} · CRUD direct · approve via admin API`;
        return refreshCurrent();
      })
      .catch(() => {
        hintEl.textContent = `APIJSON ${s.apijsonBaseUrl} · login required`;
      });
  },
  onAccountChange: () => {
    // Creds already cleared on logout; just refresh lists (BFF works without session).
    void refreshCurrent();
  },
});

setSessionExpiredHandler(() => {
  logoutAccount();
  accountUi.refresh();
  hintEl.textContent = "Session expired — please Login again";
  setStatus("Session expired — please Login again", "err");
});

hintEl.title = "APIJSON host — change under Settings";

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
    throw new Error("APIJSON body is not valid JSON");
  }
  if (structureRaw) {
    try {
      structure = JSON.parse(structureRaw) as Record<string, unknown>;
    } catch {
      throw new Error("Request.structure is not valid JSON");
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
    issuesEl.textContent = `Issues:\n${row.issues.join("\n")}`;
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
        `${k}: ${wr.ok ? `OK${wr.id != null ? ` id=${wr.id}` : ""}` : wr.error || "failed"}`,
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
  const want = new Set(selectedStatuses());
  const filtered = items.filter((r) => want.has(r.status));
  listEl.innerHTML = "";
  if (!filtered.length) {
    listEl.innerHTML = `<div class="muted pad">No applications</div>`;
    return;
  }
  for (const row of filtered) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `app-item${row.id === selectedId ? " active" : ""}`;
    btn.dataset.testid = "apply-item";
    btn.dataset.applyId = row.id;
    btn.dataset.requestId = row.requestId || "";
    btn.innerHTML = `
      <div class="title">
        ${escapeHtml(row.operation.toUpperCase())} ${escapeHtml(row.table)}
        <span class="badge badge-${row.status}">${row.status}</span>
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
  hintEl.textContent = `APIJSON ${getApijsonBase()} · CRUD direct · approve via admin API`;
}

async function refreshApply() {
  try {
    // BFF list first (DB + local fallback). APIJSON login optional for approve writes.
    try {
      await initApijson();
    } catch {
      hintEl.textContent = "APIJSON login skipped — listing via admin API";
    }
    const data = await adminApi<{ items: ConfigApplication[] }>(
      "/api/applications",
    );
    items = data.items || [];
    // Merge APIJSON rows if BFF list is empty / partial
    if (!items.length) {
      try {
        items = await listApplies();
      } catch {
        /* keep BFF result */
      }
    }
    renderList();
    if (selectedId && items.some((r) => r.id === selectedId)) {
      await select(selectedId);
    }
  } catch (e) {
    listEl.innerHTML = `<div class="muted pad">Failed: ${escapeHtml(
      e instanceof Error ? e.message : String(e),
    )}</div>`;
  }
}

const callListEl = $("call-list");
const callDetailEl = $("call-detail");
const callEmptyEl = $("call-detail-empty");
let calls: CallLog[] = [];
let selectedCallId: string | null = null;

function renderCallList() {
  callListEl.innerHTML = "";
  if (!calls.length) {
    callListEl.innerHTML = `<div class="muted pad">No call logs</div>`;
    return;
  }
  for (const row of calls) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `app-item${row.id === selectedCallId ? " active" : ""}`;
    btn.innerHTML = `
      <div class="title">
        ${escapeHtml(row.operation.toUpperCase())} ${escapeHtml(row.bizTable || row.tag || "")}
        <span class="badge ${row.ok ? "badge-ok" : "badge-fail"}">${row.ok ? "OK" : "FAIL"}</span>
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
      <dt>Status</dt><dd>${row.ok ? "OK" : "FAIL"} · code ${row.code ?? "—"}</dd>
      <dt>Operation</dt><dd>${escapeHtml(row.operation)} · ${escapeHtml(row.method)} ${escapeHtml(row.type)}</dd>
      <dt>Table / tag</dt><dd>${escapeHtml(row.bizTable || "—")} / ${escapeHtml(row.tag || "—")}</dd>
      <dt>Source</dt><dd>${escapeHtml(row.source)}${row.usedLlm ? " · usedLlm" : ""}</dd>
      <dt>Duration</dt><dd>${row.durationMs ?? "—"} ms</dd>
      <dt>URL</dt><dd>${escapeHtml(row.url)}</dd>
      <dt>Submitter</dt><dd>${escapeHtml(String(row.submitter ?? "—"))} · user ${escapeHtml(String(row.userId ?? "—"))}</dd>
      <dt>Session</dt><dd>${escapeHtml(row.sessionId || "—")}</dd>
      <dt>RequestId</dt><dd>${escapeHtml(row.requestId || "—")}</dd>
      <dt>When</dt><dd>${fmtTime(row.date)}</dd>
      <dt>Error</dt><dd>${escapeHtml(row.error || "—")}</dd>
      <dt>Detail</dt><dd>${escapeHtml(row.detail || "—")}</dd>
    </dl>
    <div class="muted" style="margin-bottom:4px">Request</div>
    <pre class="pre-block">${escapeHtml(row.request || "{}")}</pre>
    <div class="muted" style="margin-bottom:4px">Response</div>
    <pre class="pre-block">${escapeHtml(row.response || "—")}</pre>
  `;
}

async function refreshCalls() {
  try {
    try {
      await initApijson();
    } catch {
      /* BFF list does not require browser APIJSON session */
    }
    const op = (document.getElementById("call-filter-op") as HTMLSelectElement)
      .value;
    const ok = (document.getElementById("call-filter-ok") as HTMLSelectElement)
      .value;
    calls = await listCalls({
      operation: op || undefined,
      ok: ok === "true" ? true : ok === "false" ? false : undefined,
      limit: 100,
    });
    renderCallList();
    if (selectedCallId && calls.some((c) => c.id === selectedCallId)) {
      selectCall(selectedCallId);
    }
  } catch (e) {
    callListEl.innerHTML = `<div class="muted pad">Failed: ${escapeHtml(
      e instanceof Error ? e.message : String(e),
    )}</div>`;
  }
}

function renderBucketTable(
  el: HTMLElement,
  rows: Array<{ key: string; total: number; ok: number; failed: number }>,
) {
  if (!rows.length) {
    el.innerHTML = `<div class="muted">No data</div>`;
    return;
  }
  el.innerHTML = `
    <table class="stats-table">
      <thead><tr><th>Key</th><th class="num">Total</th><th class="num">OK</th><th class="num">Fail</th></tr></thead>
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
      <div class="stat-pill"><div class="label">Total</div><div class="value">${s.total}</div></div>
      <div class="stat-pill"><div class="label">OK</div><div class="value">${s.ok}</div></div>
      <div class="stat-pill"><div class="label">Failed</div><div class="value">${s.failed}</div></div>
      <div class="stat-pill"><div class="label">Success rate</div><div class="value">${rate}%</div></div>
      <div class="stat-pill"><div class="label">Avg duration</div><div class="value">${s.avgDurationMs ?? "—"}ms</div></div>
      <div class="stat-pill"><div class="label">Used LLM</div><div class="value">${s.usedLlm}</div></div>
    `;
    renderBucketTable($("stats-op"), s.byOperation);
    renderBucketTable($("stats-table"), s.byTable);
    renderBucketTable($("stats-source"), s.bySource);
    renderBucketTable($("stats-day"), s.byDay);
    const errEl = $("stats-errors");
    if (!s.topErrors.length) {
      errEl.innerHTML = `<div class="muted">No errors</div>`;
    } else {
      errEl.innerHTML = `
        <table class="stats-table">
          <thead><tr><th>Error</th><th class="num">Count</th></tr></thead>
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
    summary.innerHTML = `<div class="muted">Failed: ${escapeHtml(
      e instanceof Error ? e.message : String(e),
    )}</div>`;
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
for (const id of ["f-pending", "f-approved", "f-rejected"]) {
  document.getElementById(id)?.addEventListener("change", () => renderList());
}
for (const id of ["call-filter-op", "call-filter-ok"]) {
  document.getElementById(id)?.addEventListener("change", () => void refreshCalls());
}

$("btn-save").onclick = async () => {
  if (!selectedId) return;
  try {
    const patch = readForm();
    await updateApply(selectedId, patch);
    setStatus("Saved via APIJSON PUT Apply", "ok");
    await refreshApply();
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), "err");
  }
};

$("btn-reject").onclick = async () => {
  if (!selectedId) return;
  if (!window.confirm("Reject this application?")) return;
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
    setStatus("Rejected", "ok");
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), "err");
  }
};

$("btn-approve").onclick = async () => {
  if (!selectedId) return;
  try {
    const patch = readForm();
    setStatus("Approving — writing Access / Request / Document / Chain…");
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
      setStatus("Approved and written", "ok");
    } else {
      const parts = Object.entries(result.results || {})
        .map(([k, v]) => `${k}: ${v.ok ? "OK" : v.error || "fail"}`)
        .join("; ");
      await refreshApply();
      setStatus(
        `Partial / blocked — fix Access ACL or fields, then retry. ${parts}`,
        "err",
      );
    }
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), "err");
  }
};

void refreshApply();

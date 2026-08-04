/** Admin approval queue UI (sensitive ops + audit trail) — vendor admins only. */

import { t } from "./i18n/index.js";

type ApprovalDecision =
  | "pending"
  | "auto_approved"
  | "approved"
  | "rejected";

type ApprovalRecord = {
  id: string;
  requestId: string;
  sessionId?: string;
  method: string;
  body: Record<string, unknown>;
  rationale?: string;
  sensitive: boolean;
  decision: ApprovalDecision;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  resultOk?: boolean;
  error?: string;
};

type PendingRequest = {
  requestId: string;
  method: string;
  body: Record<string, unknown>;
  status: string;
  sensitive?: boolean;
  permissionGate?: boolean;
  issues?: string[];
  approvalId?: string;
  rationale?: string;
};

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body
      ? { "Content-Type": "application/json" }
      : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText);
  return data;
}

function previewBody(body: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(body);
    return s.length > 120 ? s.slice(0, 119) + "…" : s;
  } catch {
    return String(body);
  }
}

function fmtTime(iso?: string): string {
  if (!iso) return t("common.dash");
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function decisionLabel(d: ApprovalDecision): string {
  switch (d) {
    case "auto_approved":
      return t("admin.autoApproved");
    case "approved":
      return t("admin.approved");
    case "rejected":
      return t("admin.rejected");
    default:
      return t("admin.pendingStatus");
  }
}

export function initAdminPanel(root: HTMLElement): { refresh: () => Promise<void> } {
  const pendingEl = root.querySelector("#admin-pending") as HTMLElement;
  const auditEl = root.querySelector("#admin-audit") as HTMLElement;
  const hint = root.querySelector("#admin-sensitive-hint") as HTMLElement;
  const refreshBtn = root.querySelector("#admin-refresh") as HTMLButtonElement;

  const renderPending = (items: PendingRequest[]) => {
    pendingEl.innerHTML = "";
    if (!items.length) {
      pendingEl.innerHTML = `<div class="muted">${t("admin.noPending")}</div>`;
      return;
    }
    const table = document.createElement("table");
    table.className = "admin-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th>${t("admin.method")}</th>
          <th>${t("admin.request")}</th>
          <th>${t("admin.reason")}</th>
          <th>${t("admin.body")}</th>
          <th>${t("admin.actions")}</th>
        </tr>
      </thead>
    `;
    const tbody = document.createElement("tbody");
    for (const p of items) {
      const tr = document.createElement("tr");
      const tdMethod = document.createElement("td");
      tdMethod.textContent = p.method.toUpperCase();
      const tdId = document.createElement("td");
      tdId.className = "admin-mono";
      tdId.textContent = p.requestId;
      const tdReason = document.createElement("td");
      tdReason.textContent =
        p.issues?.join("; ") ||
        p.rationale ||
        (p.permissionGate
          ? t("admin.permissionGate")
          : p.sensitive
            ? t("admin.sensitive")
            : t("admin.write"));
      const tdBody = document.createElement("td");
      tdBody.className = "admin-mono admin-body-cell";
      tdBody.title = previewBody(p.body);
      tdBody.textContent = previewBody(p.body);
      const tdAct = document.createElement("td");
      tdAct.className = "admin-actions-cell";
      const approve = document.createElement("button");
      approve.type = "button";
      approve.className = "primary";
      approve.textContent = t("admin.approve");
      const reject = document.createElement("button");
      reject.type = "button";
      reject.className = "danger";
      reject.textContent = t("admin.reject");
      approve.onclick = () => void decide(p.requestId, "approve");
      reject.onclick = () => void decide(p.requestId, "reject");
      tdAct.append(approve, reject);
      tr.append(tdMethod, tdId, tdReason, tdBody, tdAct);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    pendingEl.appendChild(table);
  };

  const selectedDecisions = (): ApprovalDecision[] => {
    const out: ApprovalDecision[] = [];
    if ((root.querySelector("#admin-filter-auto") as HTMLInputElement)?.checked)
      out.push("auto_approved");
    if (
      (root.querySelector("#admin-filter-approved") as HTMLInputElement)?.checked
    )
      out.push("approved");
    if (
      (root.querySelector("#admin-filter-rejected") as HTMLInputElement)?.checked
    )
      out.push("rejected");
    if (
      (root.querySelector("#admin-filter-pending") as HTMLInputElement)?.checked
    )
      out.push("pending");
    return out;
  };

  const renderAudit = (records: ApprovalRecord[]) => {
    auditEl.innerHTML = "";
    const want = new Set(selectedDecisions());
    const filtered = records.filter((r) => want.has(r.decision));
    if (!filtered.length) {
      auditEl.innerHTML = `<div class="muted">${t("admin.noMatching")}</div>`;
      return;
    }
    const table = document.createElement("table");
    table.className = "admin-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th>${t("admin.decision")}</th>
          <th>${t("admin.method")}</th>
          <th>${t("admin.created")}</th>
          <th>${t("admin.by")}</th>
          <th>${t("admin.body")}</th>
          <th>${t("admin.result")}</th>
        </tr>
      </thead>
    `;
    const tbody = document.createElement("tbody");
    for (const r of filtered) {
      const tr = document.createElement("tr");
      tr.dataset.decision = r.decision;
      const tdDec = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `admin-badge admin-badge-${r.decision}`;
      badge.textContent = decisionLabel(r.decision);
      tdDec.appendChild(badge);
      const tdMethod = document.createElement("td");
      tdMethod.textContent = r.method.toUpperCase();
      const tdCreated = document.createElement("td");
      tdCreated.textContent = fmtTime(r.createdAt);
      const tdBy = document.createElement("td");
      tdBy.textContent = r.decidedBy || t("common.dash");
      const tdBody = document.createElement("td");
      tdBody.className = "admin-mono admin-body-cell";
      tdBody.title = previewBody(r.body);
      tdBody.textContent = previewBody(r.body);
      const tdResult = document.createElement("td");
      if (r.error) tdResult.textContent = r.error;
      else if (r.resultOk === false) tdResult.textContent = t("common.failed");
      else if (r.resultOk === true) tdResult.textContent = t("common.ok");
      else tdResult.textContent = r.sensitive
        ? t("admin.sensitive")
        : t("common.dash");
      tr.append(tdDec, tdMethod, tdCreated, tdBy, tdBody, tdResult);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    auditEl.appendChild(table);
  };

  let lastRecords: ApprovalRecord[] = [];

  const refresh = async () => {
    try {
      const data = await api<{
        awaiting: PendingRequest[];
        records: ApprovalRecord[];
        sensitiveMethods: string[];
      }>("/api/admin/approvals");
      hint.textContent = t("admin.sensitiveHint", {
        methods: data.sensitiveMethods.join(", ") || "delete",
      });
      renderPending(data.awaiting);
      lastRecords = data.records;
      renderAudit(lastRecords);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pendingEl.innerHTML = `<div class="muted">${t("admin.failedLoad", { msg })}</div>`;
      auditEl.innerHTML = "";
    }
  };

  const decide = async (
    requestId: string,
    action: "approve" | "reject",
  ) => {
    const result = await api<{
      pending?: { status?: string; issues?: string[] };
    }>(`/api/admin/approvals/${encodeURIComponent(requestId)}/decide`, {
      action,
      decidedBy: "admin-ui",
    });
    await refresh();
    if (
      action === "approve" &&
      result.pending?.status === "awaiting_approval" &&
      result.pending.issues?.length
    ) {
      window.alert(
        `Still blocked after reload of Access/Request:\n${result.pending.issues.join("\n")}\n\nConfigure Access/Request, then Approve again.`,
      );
    }
  };

  refreshBtn.onclick = () => void refresh();
  for (const id of [
    "admin-filter-auto",
    "admin-filter-approved",
    "admin-filter-rejected",
    "admin-filter-pending",
  ]) {
    root.querySelector(`#${id}`)?.addEventListener("change", () => {
      renderAudit(lastRecords);
    });
  }

  return { refresh };
}

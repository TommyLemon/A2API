/** Data tab: APIAuto-like request | response + optional APIAuto iframe. */

import {
  ensureAccessRoles,
  withRequestRole,
  withRequestRoleSync,
} from "./access-roles.js";
import { stripWriteUserIds } from "./owner-body.js";
import type { ApiJsonMethod } from "./schema-types.js";
import { mountVerticalSplit } from "./split-resize.js";
import {
  inferBodyTable,
  isReqMethod,
  saveWriteTemplate,
  templateButtonLabels,
  type ReqMethod,
} from "./write-templates.js";

function apijsonMethodFromUrl(url: string): ApiJsonMethod {
  const path = (url.split("?")[0] || "").replace(/\/+$/, "");
  const last = path.split("/").filter(Boolean).pop()?.toLowerCase() || "get";
  if (
    last === "get" ||
    last === "gets" ||
    last === "head" ||
    last === "heads" ||
    last === "post" ||
    last === "put" ||
    last === "delete"
  ) {
    return last;
  }
  return "get";
}

function baseFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "http://localhost:8080";
  }
}

const APIAUTO_BASE = "http://localhost:8080/api/index.html";

export type DataRequest = {
  method: string;
  url: string;
  type: "JSON" | "PARAM" | "FORM";
  json: string;
  headers: string;
};

/** Always attach send=false so APIAuto never auto-fires on open/embed. */
export function buildApiAutoShareUrl(req: {
  method?: string;
  url: string;
  json: unknown;
  type?: string;
}): string {
  const params = new URLSearchParams();
  params.set("send", "false");
  params.set("type", req.type || "JSON");
  params.set("url", req.url);
  const jsonStr =
    typeof req.json === "string" ? req.json : JSON.stringify(req.json ?? {});
  params.set("json", jsonStr);
  if (req.method) params.set("method", req.method.toUpperCase());
  return `${APIAUTO_BASE}?${params.toString()}`;
}

export function initDataPanel(root: HTMLElement) {
  const methodEl = root.querySelector<HTMLSelectElement>("#data-method")!;
  const typeEl = root.querySelector<HTMLSelectElement>("#data-type")!;
  const urlEl = root.querySelector<HTMLInputElement>("#data-url")!;
  const jsonEl = root.querySelector<HTMLTextAreaElement>("#data-json")!;
  const headerEl = root.querySelector<HTMLTextAreaElement>("#data-headers")!;
  const respEl = root.querySelector<HTMLPreElement>("#data-response")!;
  const sendBtn = root.querySelector<HTMLButtonElement>("#data-send")!;
  const saveTplBtn =
    root.querySelector<HTMLButtonElement>("#data-save-template");
  const tplHint = root.querySelector<HTMLElement>("#data-template-hint");
  const tplBind = root.querySelector<HTMLElement>("#data-template-bind");
  const tplTableEl = root.querySelector<HTMLInputElement>("#data-tpl-table");
  const tplMethodEl = root.querySelector<HTMLSelectElement>("#data-tpl-method");
  const tplButtonsEl = root.querySelector<HTMLElement>("#data-tpl-buttons");
  const tplConfirmBtn =
    root.querySelector<HTMLButtonElement>("#data-tpl-confirm");
  const tplCancelBtn =
    root.querySelector<HTMLButtonElement>("#data-tpl-cancel");
  const openApiAutoBtn =
    root.querySelector<HTMLButtonElement>("#data-open-apiauto")!;
  const embedBtn = root.querySelector<HTMLButtonElement>("#data-embed-apiauto")!;
  const frame = root.querySelector<HTMLIFrameElement>("#data-apiauto-frame")!;
  const embedWrap = root.querySelector<HTMLElement>("#data-apiauto-wrap")!;
  const builtinWrap = root.querySelector<HTMLElement>("#data-builtin")!;
  const dataSplitHandle =
    builtinWrap.querySelector<HTMLElement>("#data-split-handle");

  if (dataSplitHandle) {
    mountVerticalSplit({
      split: builtinWrap,
      handle: dataSplitHandle,
      cssVar: "--data-req-pct",
      storageKey: "a2api.dataSplitPct",
      defaultPct: 40,
      bodyClass: "is-resizing-data",
    });
  }

  let pendingTplBody: Record<string, unknown> | null = null;
  let pendingTplUrl = "";
  let pendingTplHeaders = "";

  function hideTplBind() {
    if (!tplBind) return;
    tplBind.hidden = true;
    tplBind.classList.add("hidden");
    pendingTplBody = null;
  }

  function showTplBind(table: string, method: ReqMethod) {
    if (!tplBind || !tplTableEl || !tplMethodEl || !tplButtonsEl) return;
    tplTableEl.value = table;
    tplMethodEl.value = method;
    tplButtonsEl.textContent = `Buttons: ${templateButtonLabels(method)}`;
    tplBind.hidden = false;
    tplBind.classList.remove("hidden");
  }

  function syncTplButtonHint() {
    if (!tplMethodEl || !tplButtonsEl) return;
    const m = tplMethodEl.value;
    if (isReqMethod(m)) {
      tplButtonsEl.textContent = `Buttons: ${templateButtonLabels(m)}`;
    }
  }
  tplMethodEl?.addEventListener("change", syncTplButtonHint);

  function flashTemplateHint(msg: string) {
    if (!tplHint) return;
    tplHint.hidden = false;
    tplHint.textContent = msg;
    window.setTimeout(() => {
      tplHint.hidden = true;
    }, 3200);
  }

  function prepareWriteBody(
    parsed: Record<string, unknown>,
    method: ApiJsonMethod,
  ): Record<string, unknown> {
    if (method === "post" || method === "put" || method === "delete") {
      return stripWriteUserIds(parsed);
    }
    return parsed;
  }

  function readRequest(): DataRequest {
    return {
      method: methodEl.value || "POST",
      url: urlEl.value.trim(),
      type: (typeEl.value as DataRequest["type"]) || "JSON",
      json: jsonEl.value,
      headers: headerEl.value,
    };
  }

  function parseHeaders(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || t.startsWith("//")) continue;
      const i = t.indexOf(":");
      if (i <= 0) continue;
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return out;
  }

  /** Agent / host: fill the Data panel fields. */
  function fill(req: {
    method?: string;
    url?: string;
    type?: string;
    json?: unknown;
    headers?: Record<string, string> | string;
    response?: unknown;
  }) {
    if (req.method) methodEl.value = req.method.toUpperCase();
    if (req.type) typeEl.value = req.type;
    if (req.url) urlEl.value = req.url;
    if (req.json !== undefined) {
      const method = apijsonMethodFromUrl(req.url || urlEl.value);
      const base = baseFromUrl(req.url || urlEl.value);
      void ensureAccessRoles(base);
      if (typeof req.json === "string") {
        try {
          const parsed = JSON.parse(req.json) as unknown;
          jsonEl.value =
            parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? JSON.stringify(
                  withRequestRoleSync(
                    parsed as Record<string, unknown>,
                    method,
                  ),
                  null,
                  2,
                )
              : req.json;
        } catch {
          jsonEl.value = req.json;
        }
      } else if (
        req.json &&
        typeof req.json === "object" &&
        !Array.isArray(req.json)
      ) {
        jsonEl.value = JSON.stringify(
          withRequestRoleSync(req.json as Record<string, unknown>, method),
          null,
          2,
        );
      } else {
        jsonEl.value = JSON.stringify(req.json, null, 2);
      }
    }
    if (req.headers !== undefined) {
      headerEl.value =
        typeof req.headers === "string"
          ? req.headers
          : Object.entries(req.headers)
              .map(([k, v]) => `${k}: ${v}`)
              .join("\n");
    }
    if (req.response !== undefined) {
      respEl.textContent = JSON.stringify(req.response, null, 2);
    }
  }

  async function send(): Promise<unknown> {
    const req = readRequest();
    if (!req.url) {
      respEl.textContent = JSON.stringify({ error: "URL cannot be empty" }, null, 2);
      return null;
    }
    let body: string | undefined;
    const headers = parseHeaders(req.headers);
    if (req.type === "JSON") {
      headers["Content-Type"] =
        headers["Content-Type"] || "application/json; charset=utf-8";
      try {
        const parsed = JSON.parse(req.json || "{}") as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const method = apijsonMethodFromUrl(req.url);
          const cleaned = prepareWriteBody(
            parsed as Record<string, unknown>,
            method,
          );
          const withRole = await withRequestRole(
            cleaned,
            method,
            baseFromUrl(req.url),
          );
          body = JSON.stringify(withRole);
          jsonEl.value = JSON.stringify(withRole, null, 2);
        } else {
          body = req.json || "{}";
        }
      } catch (e) {
        respEl.textContent = JSON.stringify(
          { error: "Invalid request JSON", detail: String(e) },
          null,
          2,
        );
        return null;
      }
    } else if (req.type === "PARAM" && req.method === "GET") {
      body = undefined;
    } else {
      body = req.json;
    }

    respEl.textContent = "Sending…";
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers,
        credentials: "include",
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* keep text */
      }
      respEl.textContent =
        typeof parsed === "string"
          ? parsed
          : JSON.stringify(parsed, null, 2);
      return parsed;
    } catch (e) {
      const err = { error: e instanceof Error ? e.message : String(e) };
      respEl.textContent = JSON.stringify(err, null, 2);
      return err;
    }
  }

  /** Reload APIAuto iframe with share-link params (always send=false). */
  function loadApiAuto(_opts?: { send?: boolean }) {
    const req = readRequest();
    let json: unknown = {};
    try {
      json = JSON.parse(req.json || "{}");
    } catch {
      json = req.json;
    }
    frame.src = buildApiAutoShareUrl({
      method: req.method,
      url: req.url,
      json,
      type: req.type,
    });
    embedWrap.classList.remove("hidden");
    builtinWrap.classList.add("hidden");
  }

  function showBuiltin() {
    embedWrap.classList.add("hidden");
    builtinWrap.classList.remove("hidden");
    frame.src = "about:blank";
  }

  sendBtn.onclick = () => void send();

  if (saveTplBtn) {
    saveTplBtn.onclick = () => {
      const req = readRequest();
      let parsed: Record<string, unknown>;
      try {
        const raw = JSON.parse(req.json || "{}") as unknown;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          flashTemplateHint("Request JSON must be an object.");
          return;
        }
        parsed = raw as Record<string, unknown>;
      } catch {
        flashTemplateHint("Invalid Request JSON — cannot save.");
        return;
      }
      const method = apijsonMethodFromUrl(
        req.url || `${baseFromUrl(req.url || "http://localhost:8080")}/get`,
      );
      if (!isReqMethod(method)) {
        flashTemplateHint("URL must end with /get, /post, /put, /delete, …");
        return;
      }
      const cleaned = prepareWriteBody(parsed, method);
      const table = inferBodyTable(cleaned) || "";
      pendingTplBody = cleaned;
      pendingTplUrl = req.url.trim();
      pendingTplHeaders = req.headers;
      jsonEl.value = JSON.stringify(cleaned, null, 2);
      showTplBind(table, method);
      if (!table) {
        flashTemplateHint("Pick the table this template belongs to, then Confirm.");
      } else {
        flashTemplateHint(
          `Bind ${table}:${method} → ${templateButtonLabels(method)}. Confirm to save.`,
        );
      }
    };
  }

  tplCancelBtn?.addEventListener("click", () => {
    hideTplBind();
    flashTemplateHint("Save cancelled.");
  });

  tplConfirmBtn?.addEventListener("click", () => {
    if (!pendingTplBody) {
      flashTemplateHint("Click Save template first.");
      return;
    }
    const table = (tplTableEl?.value || "").trim();
    const methodRaw = tplMethodEl?.value || "";
    if (!table || !/^[A-Z][A-Za-z0-9]*$/.test(table)) {
      flashTemplateHint("Table is required (e.g. Moment, User, Comment).");
      return;
    }
    if (!isReqMethod(methodRaw)) {
      flashTemplateHint("Pick a valid operation.");
      return;
    }
    const buttons = templateButtonLabels(methodRaw);
    saveWriteTemplate({
      url: pendingTplUrl || undefined,
      method: methodRaw,
      table,
      body: pendingTplBody,
      headers: pendingTplHeaders,
      savedAt: new Date().toISOString(),
      buttons,
    });
    hideTplBind();
    flashTemplateHint(`Saved ${table}:${methodRaw} → ${buttons}`);
  });

  openApiAutoBtn.onclick = () => {
    const req = readRequest();
    let json: unknown = {};
    try {
      json = JSON.parse(req.json || "{}");
    } catch {
      json = req.json;
    }
    window.open(
      buildApiAutoShareUrl({
        method: req.method,
        url: req.url || "http://localhost:8080/get",
        json,
        type: req.type,
      }),
      "_blank",
    );
  };
  embedBtn.onclick = () => {
    if (embedWrap.classList.contains("hidden")) loadApiAuto();
    else showBuiltin();
    embedBtn.textContent = embedWrap.classList.contains("hidden")
      ? "Embed APIAuto"
      : "Back to built-in console";
  };

  if (!urlEl.value) urlEl.value = "http://localhost:8080/get";
  if (!jsonEl.value) jsonEl.value = "{\n  \n}";
  if (!headerEl.value) {
    headerEl.value = "Content-Type: application/json; charset=utf-8\n";
  }

  return {
    fill,
    send,
    loadApiAuto,
    showBuiltin,
    readRequest,
    async agentDebug(req: {
      method?: string;
      url?: string;
      json?: unknown;
      headers?: Record<string, string> | string;
      send?: boolean;
      useApiAuto?: boolean;
    }) {
      fill(req);
      if (req.useApiAuto) {
        loadApiAuto();
        return null;
      }
      if (req.send !== false) return send();
      return null;
    },
  };
}

export type DataPanelApi = ReturnType<typeof initDataPanel>;

/** Data tab: APIAuto-like request | response + optional APIAuto iframe. */

const APIAUTO_BASE = "http://localhost:8080/api/index.html";

export type DataRequest = {
  method: string;
  url: string;
  type: "JSON" | "PARAM" | "FORM";
  json: string;
  headers: string;
};

export function buildApiAutoShareUrl(req: {
  method?: string;
  url: string;
  json: unknown;
  send?: boolean;
  type?: string;
}): string {
  const params = new URLSearchParams();
  if (req.send !== false) params.set("send", "true");
  params.set("type", req.type || "JSON");
  params.set("url", req.url);
  // APIAuto shares often put raw JSON in query (see README); encodeURIComponent is safer
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
  const openApiAutoBtn =
    root.querySelector<HTMLButtonElement>("#data-open-apiauto")!;
  const embedBtn = root.querySelector<HTMLButtonElement>("#data-embed-apiauto")!;
  const frame = root.querySelector<HTMLIFrameElement>("#data-apiauto-frame")!;
  const embedWrap = root.querySelector<HTMLElement>("#data-apiauto-wrap")!;
  const builtinWrap = root.querySelector<HTMLElement>("#data-builtin")!;

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
      jsonEl.value =
        typeof req.json === "string"
          ? req.json
          : JSON.stringify(req.json, null, 2);
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
        // validate JSON
        JSON.parse(req.json || "{}");
        body = req.json || "{}";
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

  /** Reload APIAuto iframe with share-link style params (auto fill + optional send). */
  function loadApiAuto(opts?: { send?: boolean }) {
    const req = readRequest();
    let json: unknown = {};
    try {
      json = JSON.parse(req.json || "{}");
    } catch {
      json = req.json;
    }
    const src = buildApiAutoShareUrl({
      method: req.method,
      url: req.url,
      json,
      send: opts?.send !== false,
      type: req.type,
    });
    frame.src = src;
    embedWrap.classList.remove("hidden");
    builtinWrap.classList.add("hidden");
  }

  function showBuiltin() {
    embedWrap.classList.add("hidden");
    builtinWrap.classList.remove("hidden");
    frame.src = "about:blank";
  }

  sendBtn.onclick = () => void send();
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
        send: true,
        type: req.type,
      }),
      "_blank",
    );
  };
  embedBtn.onclick = () => {
    if (embedWrap.classList.contains("hidden")) loadApiAuto({ send: true });
    else showBuiltin();
    embedBtn.textContent = embedWrap.classList.contains("hidden")
      ? "Embed APIAuto"
      : "Back to built-in console";
  };

  // defaults
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
    /** Agent helper: fill then send (builtin) and optionally sync APIAuto iframe */
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
        loadApiAuto({ send: req.send !== false });
        return null;
      }
      if (req.send !== false) return send();
      return null;
    },
  };
}

export type DataPanelApi = ReturnType<typeof initDataPanel>;

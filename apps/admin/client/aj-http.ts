/**
 * Thin browser client for ordinary CRUD against APIJSON Server HTTP API.
 * Complex workflows (approve → Access/Request/Document/Chain) stay on admin server.
 */

export type ApijsonConfig = {
  baseUrl: string;
  login?: string;
  password?: string;
};

const LS_LOGIN = "a2api.admin.login";
const LS_PASSWORD = "a2api.admin.password";

let baseUrl = "http://localhost:8080";
let ready: Promise<void> | null = null;
let sessionExpiredHandler: (() => void) | null = null;
let sessionExpiredNotified = false;

/**
 * Top-level APIJSON auth codes:
 * - 401: unauthorized (some builds)
 * - 407: session expired / 未登录或登录过期 (APIJSON Demo)
 */
export function isUnauthorizedCode(code: unknown): boolean {
  return (
    code === 401 ||
    code === "401" ||
    code === 407 ||
    code === "407"
  );
}

/** Host wires Logout + UI refresh (avoid circular import with account.ts). */
export function setSessionExpiredHandler(fn: (() => void) | null): void {
  sessionExpiredHandler = fn;
}

/** Clear session state and notify UI once per expiry burst. */
export function notifySessionExpired(): void {
  resetApijsonSession();
  clearCreds();
  if (sessionExpiredNotified) return;
  sessionExpiredNotified = true;
  try {
    sessionExpiredHandler?.();
  } finally {
    // Allow a later real login + new expiry to fire again
    setTimeout(() => {
      sessionExpiredNotified = false;
    }, 500);
  }
}

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, "");
}

export function getApijsonBase(): string {
  return baseUrl;
}

export function loadSavedCreds(): { login: string; password: string } {
  return {
    login: localStorage.getItem(LS_LOGIN) || "",
    password: localStorage.getItem(LS_PASSWORD) || "",
  };
}

export function saveCreds(login: string, password: string): void {
  localStorage.setItem(LS_LOGIN, login);
  localStorage.setItem(LS_PASSWORD, password);
}

export function clearCreds(): void {
  localStorage.removeItem(LS_LOGIN);
  localStorage.removeItem(LS_PASSWORD);
}

async function parseJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`Invalid JSON from APIJSON (${res.status})`);
  }
}

function assertOk(data: Record<string, unknown>, fallback: string): void {
  const code = data.code;
  if (isUnauthorizedCode(code)) notifySessionExpired();
  if (code !== 200 && code !== "200") {
    const msg =
      typeof data.msg === "string" && data.msg.trim()
        ? data.msg
        : fallback;
    throw new Error(msg);
  }
}

export async function apijsonPost(
  method: "get" | "head" | "gets" | "heads" | "post" | "put" | "delete",
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/${method}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const data = await parseJson(res);
  if (!res.ok && data.code == null) {
    throw new Error(`HTTP ${res.status}`);
  }
  assertOk(data, `${method.toUpperCase()} failed`);
  return data;
}

async function login(loginId: string, password: string): Promise<void> {
  const payloads: Record<string, unknown>[] = /^\d{5,}$/.test(loginId.trim())
    ? [
        { phone: loginId, password, defaults: { "@role": "LOGIN" } },
        { phone: Number(loginId), password, defaults: { "@role": "LOGIN" } },
      ]
    : [{ User: { name: loginId, password }, defaults: { "@role": "LOGIN" } }];

  let lastErr = "login failed";
  for (const body of payloads) {
    try {
      const res = await fetch(`${baseUrl}/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      });
      const data = await parseJson(res);
      const code = data.code;
      if (code === 200 || code === "200" || code === 0 || data.User || data.userId) {
        saveCreds(loginId, password);
        return;
      }
      if (typeof data.msg === "string") lastErr = data.msg;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(lastErr);
}

/** Init base URL; login only when credentials are present (no silent default login). */
export async function ensureApijson(cfg?: Partial<ApijsonConfig>): Promise<void> {
  if (cfg?.baseUrl) baseUrl = normalizeBase(cfg.baseUrl);
  if (!ready) {
    ready = (async () => {
      const creds = {
        login: (cfg?.login || loadSavedCreds().login).trim(),
        password: (cfg?.password || loadSavedCreds().password).trim(),
      };
      if (!creds.login || !creds.password) return;
      await login(creds.login, creds.password);
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  await ready;
}

export function resetApijsonSession(): void {
  ready = null;
}

/** List rows from `[]` response. */
export function rowsFromList(
  data: Record<string, unknown>,
  table: string,
): Record<string, unknown>[] {
  const arr = data["[]"];
  if (!Array.isArray(arr)) return [];
  const out: Record<string, unknown>[] = [];
  for (const wrap of arr) {
    if (wrap != null && typeof wrap === "object" && !Array.isArray(wrap)) {
      const row = (wrap as Record<string, unknown>)[table];
      if (row != null && typeof row === "object" && !Array.isArray(row)) {
        out.push(row as Record<string, unknown>);
      }
    }
  }
  return out;
}

export function sqlDate(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  return d.toISOString().slice(0, 19).replace("T", " ");
}

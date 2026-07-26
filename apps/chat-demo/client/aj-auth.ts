/**
 * Auth for Node /apijson BFF: sid cookie + optional login/password headers
 * so Node can rebuild the JSESSIONID jar after restart.
 *
 * Named aj-auth (not apijson-*) so Vite's /apijson proxy never steals this module URL.
 * Reads localStorage directly to avoid circular imports with account.ts.
 */

import { APIJSON_BROWSER_BASE } from "./aj-base.js";

const ACCOUNT_KEY = "a2api.account";
const SETTINGS_KEY = "a2api.settings";

function readAccountCreds(): { login: string; password: string } | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw) as {
      login?: string;
      name?: string;
      password?: string;
    };
    const login = String(u.login || u.name || "").trim();
    const password = u.password || "";
    if (!login || !password) return null;
    return { login, password };
  } catch {
    return null;
  }
}

function apijsonBase(): string {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const s = JSON.parse(raw) as { apijsonBaseUrl?: string };
      if (s.apijsonBaseUrl) return s.apijsonBaseUrl.replace(/\/+$/, "");
    }
  } catch {
    /* ignore */
  }
  return APIJSON_BROWSER_BASE;
}

export function apijsonAuthHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  const creds = readAccountCreds();
  if (creds) {
    headers.set("X-A2API-Login", creds.login);
    headers.set("X-A2API-Password", creds.password);
  }
  return headers;
}

/** Merge credentials:include + auth headers into fetch init. */
export function withApijsonAuth(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    credentials: "include",
    headers: apijsonAuthHeaders(init.headers),
  };
}

export async function clearApijsonBffSession(): Promise<void> {
  try {
    await fetch(`${apijsonBase()}/logout`, withApijsonAuth({ method: "POST" }));
  } catch {
    /* ignore */
  }
}

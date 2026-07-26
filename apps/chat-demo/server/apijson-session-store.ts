/**
 * Shared APIJSON HttpSession jar for browser BFF + Orchestrator.
 * Browser holds only `a2api_aj` sid; JSESSIONID never leaves Node.
 */

import { randomBytes } from "node:crypto";
import { ApiJsonClient } from "@a2api/runtime";

export const A2API_AJ_COOKIE = "a2api_aj";

export type ApijsonNodeSession = {
  id: string;
  login: string;
  password: string;
  cookie: string;
  userId?: string | number;
};

const byId = new Map<string, ApijsonNodeSession>();
const byLogin = new Map<string, string>();

export function getApijsonSessionById(
  id: string | undefined | null,
): ApijsonNodeSession | undefined {
  if (!id) return undefined;
  return byId.get(id);
}

export function getApijsonSessionByLogin(
  login: string | undefined | null,
): ApijsonNodeSession | undefined {
  if (!login) return undefined;
  const id = byLogin.get(login);
  return id ? byId.get(id) : undefined;
}

export function upsertApijsonSession(opts: {
  login: string;
  password: string;
  cookie: string;
  userId?: string | number;
  existingId?: string;
}): ApijsonNodeSession {
  const login = opts.login.trim();
  const prevId = byLogin.get(login);
  const id =
    opts.existingId ||
    prevId ||
    randomBytes(16).toString("hex");

  if (prevId && prevId !== id) {
    byId.delete(prevId);
  }

  const session: ApijsonNodeSession = {
    id,
    login,
    password: opts.password,
    cookie: opts.cookie || "",
    userId: opts.userId,
  };
  byId.set(id, session);
  byLogin.set(login, id);
  return session;
}

export function touchApijsonCookie(
  login: string,
  cookie: string,
): void {
  const s = getApijsonSessionByLogin(login);
  if (!s) return;
  s.cookie = cookie;
}

export function clearApijsonSession(id: string | undefined | null): void {
  if (!id) return;
  const s = byId.get(id);
  if (!s) return;
  byId.delete(id);
  if (byLogin.get(s.login) === id) byLogin.delete(s.login);
}

export async function loginApijsonSession(
  baseUrl: string,
  login: string,
  password: string,
  existingId?: string,
): Promise<
  | { ok: true; session: ApijsonNodeSession; body: unknown }
  | { ok: false; error: string; body?: unknown }
> {
  const client = new ApiJsonClient({ baseUrl });
  const result = await client.login(login, password);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error || "APIJSON login failed",
      body: result.body,
    };
  }
  const session = upsertApijsonSession({
    login,
    password,
    cookie: client.cookie || "",
    existingId,
  });
  return { ok: true, session, body: result.body };
}

/** Re-login when jar empty or after upstream 401. */
export async function ensureApijsonNodeCookie(
  baseUrl: string,
  session: ApijsonNodeSession,
): Promise<{ ok: true; cookie: string } | { ok: false; error: string }> {
  if (session.cookie) return { ok: true, cookie: session.cookie };
  const again = await loginApijsonSession(
    baseUrl,
    session.login,
    session.password,
    session.id,
  );
  if (!again.ok) return { ok: false, error: again.error };
  return { ok: true, cookie: again.session.cookie };
}

export function parseCookieHeader(
  header: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function sidSetCookie(id: string): string {
  return `${A2API_AJ_COOKIE}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax`;
}

export function sidClearCookie(): string {
  return `${A2API_AJ_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function credsFromLoginBody(
  body: unknown,
): { login: string; password: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const user =
    b.User && typeof b.User === "object" && !Array.isArray(b.User)
      ? (b.User as Record<string, unknown>)
      : null;
  const password = String(b.password ?? user?.password ?? "").trim();
  const login = String(
    b.phone ?? user?.phone ?? user?.name ?? b.login ?? b.name ?? "",
  ).trim();
  if (!login || !password) return null;
  return { login, password };
}

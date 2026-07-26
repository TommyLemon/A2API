/**
 * Browser → Node BFF → APIJSON.
 * JSESSIONID stays in Node (shared jar); browser only gets `a2api_aj` sid.
 */

import type { Context, Hono } from "hono";
import {
  A2API_AJ_COOKIE,
  clearApijsonSession,
  credsFromLoginBody,
  ensureApijsonNodeCookie,
  getApijsonSessionById,
  getApijsonSessionByLogin,
  loginApijsonSession,
  parseCookieHeader,
  sidClearCookie,
  sidSetCookie,
  touchApijsonCookie,
  upsertApijsonSession,
  type ApijsonNodeSession,
} from "./apijson-session-store.js";

export const APIJSON_BROWSER_BASE = "/apijson";

function mergeCookieJar(existing: string, setCookieLines: string[]): string {
  const map = new Map<string, string>();
  for (const part of existing.split(";")) {
    const t = part.trim();
    if (!t) continue;
    const i = t.indexOf("=");
    if (i > 0) map.set(t.slice(0, i), t.slice(i + 1));
  }
  for (const line of setCookieLines) {
    const first = line.split(";")[0]?.trim() || "";
    const i = first.indexOf("=");
    if (i > 0) map.set(first.slice(0, i), first.slice(i + 1));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function readSetCookie(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function apijsonPath(c: Context): string {
  const src = new URL(c.req.url);
  const suffix = src.pathname.replace(/^\/apijson/, "") || "/";
  return suffix.startsWith("/") ? suffix : `/${suffix}`;
}

function resolveSession(c: Context): ApijsonNodeSession | undefined {
  const cookies = parseCookieHeader(c.req.header("cookie"));
  const sid = cookies[A2API_AJ_COOKIE];
  let session = getApijsonSessionById(sid);

  const hdrLogin = (c.req.header("x-a2api-login") || "").trim();
  const hdrPass = c.req.header("x-a2api-password") || "";
  if (hdrLogin && hdrPass) {
    const byLogin = getApijsonSessionByLogin(hdrLogin);
    if (byLogin && byLogin.password === hdrPass) {
      session = byLogin;
    } else if (!session || session.login !== hdrLogin) {
      session = upsertApijsonSession({
        login: hdrLogin,
        password: hdrPass,
        cookie: session?.login === hdrLogin ? session.cookie : "",
        existingId: session?.login === hdrLogin ? session.id : undefined,
      });
    }
  }
  return session;
}

async function forwardUpstream(
  upstream: string,
  pathAndQuery: string,
  init: {
    method: string;
    headers: Headers;
    body?: ArrayBuffer | null;
    cookie: string;
  },
): Promise<Response> {
  const base = upstream.replace(/\/+$/, "");
  const headers = new Headers(init.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("cookie");
  headers.delete("content-length");
  if (init.cookie) headers.set("Cookie", init.cookie);

  return fetch(`${base}${pathAndQuery}`, {
    method: init.method,
    headers,
    body:
      init.method === "GET" || init.method === "HEAD"
        ? undefined
        : init.body ?? undefined,
    redirect: "manual",
  });
}

function clientResponse(
  res: Response,
  body: ArrayBuffer,
  extraSetCookie?: string[],
): Response {
  const out = new Headers();
  res.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === "set-cookie" ||
      lower === "transfer-encoding" ||
      lower === "content-encoding" ||
      lower === "content-length"
    ) {
      return;
    }
    out.set(key, value);
  });
  for (const sc of extraSetCookie || []) {
    out.append("set-cookie", sc);
  }
  return new Response(body, { status: res.status, headers: out });
}

function looksLikeAuthFailure(bodyText: string, status: number): boolean {
  if (status === 401) return true;
  try {
    const j = JSON.parse(bodyText) as { code?: unknown };
    return j.code === 401;
  } catch {
    return false;
  }
}

async function proxyApijson(c: Context, upstream: string): Promise<Response> {
  const path = apijsonPath(c);
  const src = new URL(c.req.url);
  const pathAndQuery = `${path}${src.search}`;
  const method = c.req.method;

  // Logout — drop Node jar + clear sid
  if (path === "/logout" || path === "/logout/") {
    const cookies = parseCookieHeader(c.req.header("cookie"));
    clearApijsonSession(cookies[A2API_AJ_COOKIE]);
    return new Response(JSON.stringify({ ok: true, code: 200 }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": sidClearCookie(),
      },
    });
  }

  // Login — establish Node jar + sid cookie
  if (path === "/login" || path === "/login/") {
    let raw: unknown = null;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ ok: false, code: 400, msg: "invalid JSON body" }, 400);
    }
    const creds = credsFromLoginBody(raw);
    if (!creds) {
      return c.json(
        { ok: false, code: 400, msg: "phone/name and password required" },
        400,
      );
    }
    const cookies = parseCookieHeader(c.req.header("cookie"));
    const existingId = cookies[A2API_AJ_COOKIE];
    const result = await loginApijsonSession(
      upstream,
      creds.login,
      creds.password,
      existingId,
    );
    if (!result.ok) {
      return new Response(
        JSON.stringify(
          result.body && typeof result.body === "object"
            ? result.body
            : { ok: false, code: 401, msg: result.error },
        ),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Set-Cookie": sidClearCookie(),
          },
        },
      );
    }
    return new Response(JSON.stringify(result.body ?? { ok: true, code: 200 }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": sidSetCookie(result.session.id),
      },
    });
  }

  let session = resolveSession(c);
  let cookie = "";
  if (session) {
    const ensured = await ensureApijsonNodeCookie(upstream, session);
    if (ensured.ok) {
      cookie = ensured.cookie;
      session = getApijsonSessionById(session.id) || session;
    } else if (path !== "/get" && path !== "/head") {
      // Writes need a session; reads may be open
      return c.json(
        { ok: false, code: 401, msg: ensured.error || "Not logged in" },
        200,
      );
    }
  }

  const hdrs = new Headers();
  c.req.raw.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "cookie" ||
      lower.startsWith("x-a2api-")
    ) {
      return;
    }
    hdrs.set(key, value);
  });

  const body =
    method === "GET" || method === "HEAD"
      ? null
      : await c.req.arrayBuffer();

  let res = await forwardUpstream(upstream, pathAndQuery, {
    method,
    headers: hdrs,
    body,
    cookie,
  });
  let setCookies = readSetCookie(res);
  let textBuf = await res.arrayBuffer();
  let text = new TextDecoder().decode(textBuf);

  if (session && looksLikeAuthFailure(text, res.status) && session.password) {
    const again = await loginApijsonSession(
      upstream,
      session.login,
      session.password,
      session.id,
    );
    if (again.ok) {
      cookie = again.session.cookie;
      session = again.session;
      res = await forwardUpstream(upstream, pathAndQuery, {
        method,
        headers: hdrs,
        body,
        cookie,
      });
      setCookies = readSetCookie(res);
      textBuf = await res.arrayBuffer();
      text = new TextDecoder().decode(textBuf);
    }
  }

  if (session && setCookies.length) {
    const merged = mergeCookieJar(cookie || session.cookie, setCookies);
    touchApijsonCookie(session.login, merged);
  }

  const extra: string[] = [];
  if (session) extra.push(sidSetCookie(session.id));
  return clientResponse(res, textBuf, extra);
}

export function mountApijsonProxy(app: Hono, upstream: string): void {
  const handler = (c: Context) => proxyApijson(c, upstream);
  app.all("/apijson", handler);
  app.all("/apijson/*", handler);
}

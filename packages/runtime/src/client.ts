import {
  applyMethodRole,
  insertDefaultsFromStructure,
  isOpenApiJsonRequest,
  stripApiJsonRole,
  withLoginDefaults,
  type ApiJsonMethod,
} from "@a2api/protocol";
import { AccessRoleCache } from "./access-roles.js";
import { RequestStructureCache } from "./request-structures.js";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

export interface ApiJsonClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ApiJsonHttpResult {
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
}

export interface ApiJsonExecuteOptions {
  /** Override Cookie header for this call (and refresh jar from Set-Cookie). */
  cookie?: string;
  /**
   * When false, do not apply Access-based / write role policy
   * (e.g. information_schema, Access bootstrap).
   * @deprecated Prefer `injectRole`.
   */
  ownerRole?: boolean;
  /** When false, send body without role resolution (strip `@role`). Default true. */
  injectRole?: boolean;
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function mergeCookieJar(existing: string, setCookieHeaders: string[]): string {
  const map = new Map<string, string>();
  for (const part of existing.split(";")) {
    const t = part.trim();
    if (!t) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    map.set(t.slice(0, eq), t.slice(eq + 1));
  }
  for (const header of setCookieHeaders) {
    const first = header.split(";")[0]?.trim();
    if (!first) continue;
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    map.set(first.slice(0, eq), first.slice(eq + 1));
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

function looksLikePhoneOrId(s: string): boolean {
  return /^\d{5,}$/.test(s.trim());
}

function shouldInjectRole(options: ApiJsonExecuteOptions): boolean {
  if (options.injectRole === false) return false;
  if (options.ownerRole === false) return false;
  return true;
}

export class ApiJsonClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  /** Session Cookie jar for APIJSON HttpSession (JSESSIONID, etc.). */
  cookie = "";
  /** Cached Access table → min GET/HEAD roles. */
  readonly accessRoles = new AccessRoleCache();
  /** Cached Request table → structure rules for non-open methods. */
  readonly requestStructures = new RequestStructureCache();

  constructor(options: ApiJsonClientOptions = {}) {
    this.baseUrl = normalizeBase(options.baseUrl ?? "http://localhost:8080");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  urlFor(method: ApiJsonMethod | "login", overrideUrl?: string): string {
    if (overrideUrl) return overrideUrl;
    return `${this.baseUrl}/${method}`;
  }

  /**
   * Login to APIJSON Demo and store session cookie.
   * Body includes `defaults: { "@role": "LOGIN" }`.
   */
  async login(
    account: string,
    password: string,
  ): Promise<{ ok: boolean; error?: string; body?: unknown }> {
    const payloads: Record<string, unknown>[] = looksLikePhoneOrId(account)
      ? [
          withLoginDefaults({ phone: account, password }),
          withLoginDefaults({ phone: Number(account), password }),
          withLoginDefaults({ User: { phone: account, password } }),
        ]
      : [
          withLoginDefaults({ User: { name: account, password } }),
          withLoginDefaults({ phone: account, password }),
        ];

    let lastError = "login failed";
    for (const body of payloads) {
      try {
        const res = await this.fetchImpl(this.urlFor("login"), {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(body),
        });
        const setCookies = readSetCookie(res);
        if (setCookies.length) {
          this.cookie = mergeCookieJar(this.cookie, setCookies);
        }
        const text = await res.text();
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          /* keep text */
        }
        const data =
          parsed && typeof parsed === "object"
            ? (parsed as Record<string, unknown>)
            : null;
        const code = data?.code;
        if (
          code === 200 ||
          code === 0 ||
          code == null ||
          data?.User ||
          data?.user ||
          data?.userId != null
        ) {
          if (setCookies.length || this.cookie) {
            return { ok: true, body: parsed };
          }
          if (code === 200 || code === 0) return { ok: true, body: parsed };
        }
        if (data && typeof data.msg === "string") lastError = data.msg;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    return { ok: false, error: lastError };
  }

  /**
   * Resolve outermost `@role` for a body (GET/HEAD from Access; writes omit).
   */
  async resolveRoleBody(
    method: ApiJsonMethod,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (
      method === "post" ||
      method === "put" ||
      method === "delete"
    ) {
      return stripApiJsonRole(body);
    }
    if (
      method === "get" ||
      method === "head" ||
      method === "gets" ||
      method === "heads"
    ) {
      await this.accessRoles.ensureLoaded(this);
      return applyMethodRole(body, method, (tables, m) =>
        this.accessRoles.minRoleForTables(tables, m),
      );
    }
    return stripApiJsonRole(body);
  }

  /**
   * Apply Request.structure INSERT defaults (skip @role) for non-open bodies.
   */
  async applyRequestInsertDefaults(
    method: ApiJsonMethod,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (isOpenApiJsonRequest(method, body)) return body;
    const tag = typeof body.tag === "string" ? body.tag.trim() : "";
    if (!tag) return body;
    await this.requestStructures.ensureLoaded(this);
    const version =
      typeof body.version === "number" ? body.version : null;
    const row = this.requestStructures.lookup(method, tag, version);
    if (!row) return body;
    const next: Record<string, unknown> = { ...body };
    for (const [key, value] of Object.entries(next)) {
      if (!isPlainObject(value)) continue;
      if (
        key === "tag" ||
        key === "version" ||
        key === "format" ||
        key === "@role" ||
        key === "defaults"
      ) {
        continue;
      }
      const defaults = insertDefaultsFromStructure(row.structure, key);
      if (Object.keys(defaults).length) {
        next[key] = { ...defaults, ...value };
      }
    }
    return next;
  }

  async execute(
    method: ApiJsonMethod,
    body: Record<string, unknown>,
    overrideUrl?: string,
    options: ApiJsonExecuteOptions = {},
  ): Promise<ApiJsonHttpResult> {
    const url = this.urlFor(method, overrideUrl);
    let payload = shouldInjectRole(options)
      ? await this.resolveRoleBody(method, body)
      : stripApiJsonRole(body);
    if (shouldInjectRole(options)) {
      payload = await this.applyRequestInsertDefaults(method, payload);
    }
    const cookie =
      options.cookie !== undefined ? options.cookie : this.cookie;
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json; charset=utf-8",
      };
      if (cookie) headers.Cookie = cookie;

      const res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const setCookies = readSetCookie(res);
      if (setCookies.length) {
        this.cookie = mergeCookieJar(cookie || this.cookie, setCookies);
      }
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // keep text
      }
      const code =
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "code" in parsed
          ? Number((parsed as { code: unknown }).code)
          : res.status;
      const ok = res.ok && code === 200;
      return {
        ok,
        status: res.status,
        body: parsed,
        error: ok
          ? undefined
          : typeof parsed === "object" &&
              parsed &&
              "msg" in parsed &&
              typeof (parsed as { msg: unknown }).msg === "string"
            ? (parsed as { msg: string }).msg
            : `HTTP ${res.status}`,
      };
    } catch (e) {
      return {
        ok: false,
        status: 0,
        body: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

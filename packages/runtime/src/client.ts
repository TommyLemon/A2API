import type { ApiJsonMethod } from "@a2api/protocol";

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

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export class ApiJsonClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiJsonClientOptions = {}) {
    this.baseUrl = normalizeBase(options.baseUrl ?? "http://localhost:8080");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  urlFor(method: ApiJsonMethod, overrideUrl?: string): string {
    if (overrideUrl) return overrideUrl;
    return `${this.baseUrl}/${method}`;
  }

  async execute(
    method: ApiJsonMethod,
    body: Record<string, unknown>,
    overrideUrl?: string,
  ): Promise<ApiJsonHttpResult> {
    const url = this.urlFor(method, overrideUrl);
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      });
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

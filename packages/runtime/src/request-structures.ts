import {
  pickRequestRow,
  type ApiJsonMethod,
  type RequestStructureRow,
} from "@a2api/protocol";
import type { ApiJsonClient } from "./client.js";
import { APIJSON_MAX_PAGE_COUNT, extractArrayPage } from "./meta-page.js";

/**
 * Caches APIJSON `Request` rows (method/tag/version/structure) for non-open
 * request validation and form defaults.
 */
export class RequestStructureCache {
  private rows: RequestStructureRow[] = [];
  private loaded = false;
  private loading: Promise<void> | null = null;

  clear(): void {
    this.rows = [];
    this.loaded = false;
    this.loading = null;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  list(): RequestStructureRow[] {
    return this.rows;
  }

  ingestRows(items: unknown[]): void {
    const next: RequestStructureRow[] = [];
    for (const item of items) {
      if (item == null || typeof item !== "object") continue;
      const wrap = item as Record<string, unknown>;
      const raw =
        wrap.Request && typeof wrap.Request === "object"
          ? (wrap.Request as Record<string, unknown>)
          : wrap;
      const method = String(raw.method ?? "").trim();
      const tag = String(raw.tag ?? "").trim();
      if (!method || !tag) continue;
      let structure: Record<string, unknown> = {};
      const s = raw.structure;
      if (s != null && typeof s === "object" && !Array.isArray(s)) {
        structure = s as Record<string, unknown>;
      } else if (typeof s === "string" && s.trim()) {
        try {
          const parsed = JSON.parse(s) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            structure = parsed as Record<string, unknown>;
          }
        } catch {
          /* ignore */
        }
      }
      next.push({
        method: method.toUpperCase(),
        tag,
        version: Number(raw.version) || 0,
        structure,
        detail:
          typeof raw.detail === "string" ? raw.detail : undefined,
      });
    }
    this.rows = next;
    this.loaded = true;
  }

  async ensureLoaded(client: ApiJsonClient): Promise<void> {
    if (this.loaded) return;
    if (this.loading) {
      await this.loading;
      return;
    }
    this.loading = (async () => {
      const all: unknown[] = [];
      for (let page = 0; page < 50; page++) {
        const result = await client.execute(
          "get",
          {
            "[]": {
              count: APIJSON_MAX_PAGE_COUNT,
              page,
              Request: {
                "@column": "method,tag,version,structure,detail",
              },
            },
          },
          undefined,
          { injectRole: false },
        );
        if (!result.ok) {
          throw new Error(result.error || "Failed to load Request table");
        }
        const list = extractArrayPage(result.body);
        all.push(...list);
        if (list.length < APIJSON_MAX_PAGE_COUNT) break;
      }
      this.ingestRows(all);
    })().finally(() => {
      this.loading = null;
    });
    await this.loading;
  }

  /** Drop cache and re-fetch Request rows (e.g. after admin configured them). */
  async reload(client: ApiJsonClient): Promise<void> {
    this.clear();
    await this.ensureLoaded(client);
  }

  lookup(
    method: ApiJsonMethod | string,
    tag: string,
    version?: number | null,
  ): RequestStructureRow | null {
    return pickRequestRow(this.rows, String(method), tag, version);
  }
}

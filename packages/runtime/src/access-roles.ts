import {
  combineMinRoles,
  minRoleFromAllowed,
  parseRoleList,
  type ApiJsonMethod,
} from "@a2api/protocol";
import type { ApiJsonClient } from "./client.js";
import { APIJSON_MAX_PAGE_COUNT, extractArrayPage } from "./meta-page.js";

type AccessMethodKey = "get" | "head" | "gets" | "heads";

type AccessRow = {
  get: string[];
  head: string[];
  gets: string[];
  heads: string[];
};

function methodKey(method: ApiJsonMethod): AccessMethodKey | null {
  if (
    method === "get" ||
    method === "head" ||
    method === "gets" ||
    method === "heads"
  ) {
    return method;
  }
  return null;
}

/**
 * Caches APIJSON `Access` rows and resolves the minimum required `@role`
 * for GET/HEAD (and GETS/HEADS) requests.
 */
export class AccessRoleCache {
  private readonly byTable = new Map<string, AccessRow>();
  private loaded = false;
  private loading: Promise<void> | null = null;

  clear(): void {
    this.byTable.clear();
    this.loaded = false;
    this.loading = null;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  ingestAccessRows(rows: unknown[]): void {
    for (const item of rows) {
      if (item == null || typeof item !== "object") continue;
      const wrap = item as Record<string, unknown>;
      const access =
        wrap.Access && typeof wrap.Access === "object"
          ? (wrap.Access as Record<string, unknown>)
          : wrap;
      const name = String(access.name ?? "").trim();
      const alias = String(access.alias ?? "").trim();
      const row: AccessRow = {
        get: parseRoleList(access.get),
        head: parseRoleList(access.head),
        gets: parseRoleList(access.gets),
        heads: parseRoleList(access.heads),
      };
      if (name) this.byTable.set(name, row);
      if (alias) this.byTable.set(alias, row);
    }
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
              Access: {
                "@column": "name,alias,get,head,gets,heads",
              },
            },
          },
          undefined,
          { injectRole: false },
        );
        if (!result.ok) {
          throw new Error(result.error || "Failed to load Access table");
        }
        const list = extractArrayPage(result.body);
        all.push(...list);
        if (list.length < APIJSON_MAX_PAGE_COUNT) break;
      }
      this.ingestAccessRows(all);
    })().finally(() => {
      this.loading = null;
    });
    await this.loading;
  }

  /** Drop cache and re-fetch Access rows (e.g. after admin configured them). */
  async reload(client: ApiJsonClient): Promise<void> {
    this.clear();
    await this.ensureLoaded(client);
  }

  /**
   * Minimum role for one table + method. Missing Access → LOGIN.
   */
  minRoleForTable(table: string, method: ApiJsonMethod): string {
    const key = methodKey(method);
    if (!key) return "LOGIN";
    const row = this.byTable.get(table);
    if (!row) return "LOGIN";
    return minRoleFromAllowed(row[key]) ?? "LOGIN";
  }

  /**
   * Role for a multi-table request: max of per-table minimums.
   * (Caller floors to LOGIN via applyMethodRole — never sends UNKNOWN.)
   */
  minRoleForTables(tables: string[], method: ApiJsonMethod): string {
    if (!tables.length) return "LOGIN";
    return (
      combineMinRoles(
        tables.map((t) => this.minRoleForTable(t, method)),
      ) ?? "LOGIN"
    );
  }
}

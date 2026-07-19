import {
  applyMethodRole,
  combineMinRoles,
  minRoleFromAllowed,
  parseRoleList,
  stripApiJsonRole,
  type ApiJsonMethod,
} from "./schema-types.js";

type AccessMethodKey = "get" | "head" | "gets" | "heads";

type AccessRow = {
  get: string[];
  head: string[];
  gets: string[];
  heads: string[];
};

const byTable = new Map<string, AccessRow>();
let loaded = false;
let loading: Promise<void> | null = null;

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

function ingest(rows: unknown[]): void {
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
    if (name) byTable.set(name, row);
    if (alias) byTable.set(alias, row);
  }
  loaded = true;
}

const PAGE = 100;

export async function ensureAccessRoles(baseUrl: string): Promise<void> {
  if (loaded) return;
  if (loading) {
    await loading;
    return;
  }
  const base = baseUrl.replace(/\/+$/, "");
  loading = (async () => {
    const all: unknown[] = [];
    for (let page = 0; page < 50; page++) {
      const res = await fetch(`${base}/get`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        // No @role — bootstrap Access itself
        body: JSON.stringify({
          "[]": {
            count: PAGE,
            page,
            Access: { "@column": "name,alias,get,head,gets,heads" },
          },
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        code?: number;
        msg?: string;
        "[]"?: unknown[];
      } | null;
      if (!res.ok || (data?.code != null && data.code !== 200)) {
        throw new Error(data?.msg || `Access table load failed (${res.status})`);
      }
      const list = Array.isArray(data?.["[]"]) ? data!["[]"]! : [];
      all.push(...list);
      if (list.length < PAGE) break;
    }
    ingest(all);
  })()
    .catch(() => {
      loaded = false;
      byTable.clear();
    })
    .finally(() => {
      loading = null;
    });
  await loading;
}

export function minRoleForTables(
  tables: string[],
  method: ApiJsonMethod,
): string {
  const key = methodKey(method);
  if (!key || !tables.length) return "LOGIN";
  const mins = tables.map((table) => {
    const row = byTable.get(table);
    if (!row) return "LOGIN";
    return minRoleFromAllowed(row[key]) ?? "LOGIN";
  });
  return combineMinRoles(mins) ?? "LOGIN";
}

/** Sync apply using cached Access (floored to LOGIN). */
export function withRequestRoleSync(
  body: Record<string, unknown>,
  method: ApiJsonMethod,
): Record<string, unknown> {
  return applyMethodRole(body, method, (tables, m) =>
    minRoleForTables(tables, m),
  );
}

/** Prefer this for browser → APIJSON calls. */
export async function withRequestRole(
  body: Record<string, unknown>,
  method: ApiJsonMethod,
  baseUrl: string,
): Promise<Record<string, unknown>> {
  if (method === "post" || method === "put" || method === "delete") {
    return stripApiJsonRole(body);
  }
  await ensureAccessRoles(baseUrl);
  return withRequestRoleSync(body, method);
}

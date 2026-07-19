/**
 * Browser cache of APIJSON `Request` rows for non-open structure rules
 * (MUST / REFUSE / TYPE / VERIFY / INSERT).
 */

export type RequestStructureRow = {
  method: string;
  tag: string;
  version: number;
  structure: Record<string, unknown>;
  detail?: string;
};

export type TableStructureRules = {
  must: string[];
  refuse: string[];
  insert: Record<string, unknown>;
  types: Record<string, string>;
  verify: Record<string, string>;
};

let rows: RequestStructureRow[] = [];
let loaded = false;
let loading: Promise<void> | null = null;

function splitCsv(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function ingest(items: unknown[]): void {
  const next: RequestStructureRow[] = [];
  for (const item of items) {
    if (item == null || typeof item !== "object") continue;
    const wrap = item as Record<string, unknown>;
    const raw =
      wrap.Request && typeof wrap.Request === "object"
        ? (wrap.Request as Record<string, unknown>)
        : wrap;
    const method = String(raw.method ?? "").trim().toUpperCase();
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
      method,
      tag,
      version: Number(raw.version) || 0,
      structure,
      detail: typeof raw.detail === "string" ? raw.detail : undefined,
    });
  }
  rows = next;
  loaded = true;
}

const PAGE = 100;

export function clearRequestStructures(): void {
  rows = [];
  loaded = false;
  loading = null;
}

export async function ensureRequestStructures(baseUrl: string): Promise<void> {
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
        body: JSON.stringify({
          "[]": {
            count: PAGE,
            page,
            Request: { "@column": "method,tag,version,structure,detail" },
          },
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        code?: number;
        msg?: string;
        "[]"?: unknown[];
      } | null;
      if (!res.ok || (data?.code != null && data.code !== 200)) {
        throw new Error(data?.msg || `Request table load failed (${res.status})`);
      }
      const list = Array.isArray(data?.["[]"]) ? data!["[]"]! : [];
      all.push(...list);
      if (list.length < PAGE) break;
    }
    ingest(all);
  })()
    .catch(() => {
      // Keep unloaded so a later retry can succeed
      loaded = false;
      rows = [];
    })
    .finally(() => {
      loading = null;
    });
  await loading;
}

export async function reloadRequestStructures(baseUrl: string): Promise<void> {
  clearRequestStructures();
  await ensureRequestStructures(baseUrl);
}

export function lookupRequestStructure(
  method: string,
  tag: string,
  version?: number | null,
): RequestStructureRow | null {
  const m = method.toUpperCase();
  const matched = rows
    .filter((r) => r.method === m && r.tag === tag)
    .sort((a, b) => a.version - b.version);
  if (!matched.length) return null;
  if (version == null || version <= 0) return matched[matched.length - 1]!;
  let best: RequestStructureRow | null = null;
  for (const r of matched) {
    if (r.version <= version) best = r;
  }
  return best ?? matched[0]!;
}

export function resolveTableRules(
  structure: Record<string, unknown>,
  tableKey: string,
): TableStructureRules {
  const nested = structure[tableKey];
  const src = isPlainObject(nested) ? nested : structure;
  const insert = isPlainObject(src.INSERT)
    ? { ...(src.INSERT as Record<string, unknown>) }
    : {};
  delete insert["@role"];
  const types = isPlainObject(src.TYPE)
    ? Object.fromEntries(
        Object.entries(src.TYPE as Record<string, unknown>).map(([k, v]) => [
          k,
          String(v).toUpperCase(),
        ]),
      )
    : {};
  const verify = isPlainObject(src.VERIFY)
    ? Object.fromEntries(
        Object.entries(src.VERIFY as Record<string, unknown>).map(([k, v]) => [
          k,
          String(v),
        ]),
      )
    : {};
  return {
    must: splitCsv(src.MUST),
    refuse: splitCsv(src.REFUSE).filter((t) => t !== "!" && !t.startsWith("!")),
    insert,
    types,
    verify,
  };
}

/** Form helpers for Add {table} (POST tag = table). */
export function createRulesFromRequest(
  table: string,
): TableStructureRules | null {
  const row = lookupRequestStructure("POST", table);
  if (!row) return null;
  return resolveTableRules(row.structure, table);
}

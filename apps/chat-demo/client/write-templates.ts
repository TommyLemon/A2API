/**
 * User-saved Data API request shells bound to table + APIJSON operation.
 * Chat UI buttons pick the matching template (get→Search, post→Add, …).
 */

export type ReqMethod =
  | "get"
  | "gets"
  | "head"
  | "heads"
  | "post"
  | "put"
  | "delete";

/** @deprecated use ReqMethod — kept for call sites that only write */
export type WriteMethod = Extract<ReqMethod, "post" | "put" | "delete">;

export type SavedReqTemplate = {
  url?: string;
  method: ReqMethod;
  table: string;
  body: Record<string, unknown>;
  headers?: string;
  savedAt: string;
  /** Human label of Chat UI buttons this template feeds */
  buttons?: string;
};

/** Alias for older imports */
export type SavedWriteTemplate = SavedReqTemplate;

const KEY_PREFIX = "a2api.dataReqTemplate:";

const ALL_METHODS: ReqMethod[] = [
  "get",
  "gets",
  "head",
  "heads",
  "post",
  "put",
  "delete",
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

export function isReqMethod(v: string): v is ReqMethod {
  return (ALL_METHODS as string[]).includes(v);
}

export function templateStorageKey(table: string, method: ReqMethod): string {
  return `${KEY_PREFIX}${table}:${method}`;
}

/** Which Chat UI controls consume this operation. */
export function templateButtonLabels(method: ReqMethod): string {
  switch (method) {
    case "get":
    case "gets":
      return "Search · paging · filter/sort · refresh";
    case "post":
      return "Add / Create";
    case "put":
      return "Save (detail)";
    case "delete":
      return "Delete";
    case "head":
    case "heads":
      return "(no Chat UI button yet)";
  }
}

/** Infer primary table from APIJSON body (top-level or list `[]`). */
export function inferBodyTable(body: Record<string, unknown>): string | null {
  for (const key of Object.keys(body)) {
    if (/^[A-Z][A-Za-z0-9]*$/.test(key) && isPlainObject(body[key])) {
      return key;
    }
  }
  const list = body["[]"];
  if (isPlainObject(list)) {
    const tables = Object.keys(list).filter(
      (k) => /^[A-Z]/.test(k) && isPlainObject(list[k]),
    );
    for (const t of tables) {
      const obj = list[t] as Record<string, unknown>;
      if (obj["id@"] == null) return t;
    }
    if (tables[0]) return tables[0];
  }
  const tag = typeof body.tag === "string" ? body.tag.trim() : "";
  if (tag) {
    const base = tag.replace(/:\[\]$/, "").replace(/\[\]$/, "");
    if (/^[A-Z]/.test(base)) return base;
  }
  return null;
}

export function loadWriteTemplate(
  table: string,
  method: ReqMethod,
): SavedReqTemplate | null {
  try {
    const raw = localStorage.getItem(templateStorageKey(table, method));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedReqTemplate;
    if (!parsed?.body || typeof parsed.body !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveWriteTemplate(tpl: SavedReqTemplate): void {
  const buttons = tpl.buttons || templateButtonLabels(tpl.method);
  localStorage.setItem(
    templateStorageKey(tpl.table, tpl.method),
    JSON.stringify({ ...tpl, buttons }),
  );
}

/**
 * Merge form entity into saved write shell.
 * - Keep shell top-level extras (tag, format, nested helpers…)
 * - Entity fields from the UI overwrite body[table]
 * - Caller still strips userId / post id
 */
export function mergeWriteTemplate(
  savedBody: Record<string, unknown> | null | undefined,
  method: WriteMethod | ReqMethod,
  table: string,
  entity: Record<string, unknown>,
): Record<string, unknown> {
  const base = savedBody
    ? structuredClone(savedBody)
    : ({ [table]: {}, tag: table } as Record<string, unknown>);

  // Prefer matching table object; else first table-like key
  let tableKey = table;
  if (!isPlainObject(base[tableKey])) {
    const inferred = inferBodyTable(base);
    if (inferred && isPlainObject(base[inferred])) tableKey = inferred;
    else base[tableKey] = {};
  }

  const prev = isPlainObject(base[tableKey])
    ? (base[tableKey] as Record<string, unknown>)
    : {};
  const row: Record<string, unknown> = { ...prev, ...entity };

  if (method === "post") delete row.id;
  delete row.userId;

  base[tableKey] = row;
  if (typeof base.tag !== "string" || !String(base.tag).trim()) {
    base.tag = tableKey;
  }
  return base;
}

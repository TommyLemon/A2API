import { ApiJsonClient } from "@a2api/runtime";

export type SchemaComments = {
  /** tableName -> table comment */
  tables: Record<string, string>;
  /** "Table.column" -> column comment (+ optional type suffix) */
  columns: Record<string, string>;
  /** "Table.column" -> raw COLUMN_TYPE e.g. varchar(100), timestamp */
  types: Record<string, string>;
};

const cache = new Map<string, { at: number; data: SchemaComments }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/** APIJSON Demo: logical request name → physical MySQL table name. */
const LOGICAL_TO_PHYSICAL: Record<string, string> = {
  User: "apijson_user",
  Privacy: "apijson_privacy",
};

const PHYSICAL_TO_LOGICAL: Record<string, string> = Object.fromEntries(
  Object.entries(LOGICAL_TO_PHYSICAL).map(([logical, physical]) => [
    physical,
    logical,
  ]),
);

function empty(): SchemaComments {
  return { tables: {}, columns: {}, types: {} };
}

function merge(into: SchemaComments, from: SchemaComments): SchemaComments {
  return {
    tables: { ...into.tables, ...from.tables },
    columns: { ...into.columns, ...from.columns },
    types: { ...into.types, ...from.types },
  };
}

function toPhysical(logical: string): string {
  return LOGICAL_TO_PHYSICAL[logical] ?? logical;
}

function toLogical(name: string): string {
  return PHYSICAL_TO_LOGICAL[name] ?? name;
}

function listBodyOk(body: unknown): unknown[] {
  if (!body || typeof body !== "object") return [];
  const arr = (body as { "[]"?: unknown })["[]"];
  return Array.isArray(arr) ? arr : [];
}

/**
 * Load TABLE_COMMENT / COLUMN_COMMENT from information_schema via APIJSON.
 * Note: []/count must be ≤ 100 on this server; User maps to apijson_user.
 */
export async function loadSchemaComments(
  client: ApiJsonClient,
  tableNames: string[],
  schema = process.env.APIJSON_SCHEMA ?? "sys",
): Promise<SchemaComments> {
  const unique = [...new Set(tableNames.filter(Boolean))];
  if (unique.length === 0) return empty();

  const cacheKey = `${schema}:${unique.slice().sort().join(",")}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const physicalNames = [
    ...new Set(unique.flatMap((t) => [t, toPhysical(t)])),
  ];

  let result = empty();

  // Tables
  const tableRes = await client.execute(
    "get",
    {
      "[]": {
        count: Math.min(100, Math.max(physicalNames.length, 10)),
        Table: {
          TABLE_SCHEMA: schema,
          "TABLE_NAME{}": physicalNames,
          "@column": "TABLE_NAME,TABLE_COMMENT",
        },
      },
    },
    undefined,
    { injectRole: false },
  );
  if (tableRes.ok) {
    for (const item of listBodyOk(tableRes.body)) {
      const t = (item as { Table?: Record<string, unknown> }).Table;
      if (!t?.TABLE_NAME) continue;
      const logical = toLogical(String(t.TABLE_NAME));
      const comment = String(t.TABLE_COMMENT ?? "")
        .replace(/\n+/g, " ")
        .trim();
      result.tables[logical] = comment;
      // also keep physical key if different (defensive)
      if (logical !== String(t.TABLE_NAME)) {
        result.tables[String(t.TABLE_NAME)] = comment;
      }
    }
  }

  // Columns — page if needed (max count 100)
  const pageSize = 100;
  let page = 0;
  let fetched = 0;
  do {
    const colRes = await client.execute(
      "get",
      {
        "[]": {
          count: pageSize,
          page,
          Column: {
            TABLE_SCHEMA: schema,
            "TABLE_NAME{}": physicalNames,
            "@column": "TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,COLUMN_COMMENT",
          },
        },
      },
      undefined,
      { injectRole: false },
    );
    if (!colRes.ok) break;
    const rows = listBodyOk(colRes.body);
    fetched = rows.length;
    for (const item of rows) {
      const c = (item as { Column?: Record<string, unknown> }).Column;
      if (!c?.TABLE_NAME || !c?.COLUMN_NAME) continue;
      const table = toLogical(String(c.TABLE_NAME));
      const key = `${table}.${c.COLUMN_NAME}`;
      const comment = String(c.COLUMN_COMMENT ?? "")
        .replace(/\n+/g, " ")
        .trim();
      const type = c.COLUMN_TYPE ? String(c.COLUMN_TYPE) : "";
      if (type) result.types[key] = type;
      result.columns[key] = comment
        ? type
          ? `${comment} (${type})`
          : comment
        : type
          ? `(${type})`
          : "";
    }
    page += 1;
  } while (fetched >= pageSize && page < 5);

  // Demo fallback when information_schema misses a logical table
  result = merge(demoFallback(unique), result);

  cache.set(cacheKey, { at: Date.now(), data: result });
  return result;
}

/** Minimal built-in comments so DDL UI is never blank for Demo tables. */
function demoFallback(tables: string[]): SchemaComments {
  const all: SchemaComments = {
    tables: {
      User: "Public user profile (logical name: User)",
      Moment: "Moment / post",
      Comment: "Comment",
    },
    columns: {
      "User.id": "Primary key (bigint)",
      "User.name": "Display name (varchar(20))",
      "User.sex": "Gender: 0-male, 1-female (tinyint)",
      "User.tag": "Tag (varchar(45))",
      "User.head": "Avatar URL (varchar(300))",
      "User.contactIdList": "Contact User.id list (FK array)",
      "User.pictureList": "Picture list (json)",
      "User.date": "Created at (timestamp)",
      "Moment.id": "Primary key (bigint)",
      "Moment.userId": "Author user id (bigint)",
      "Moment.date": "Created at (timestamp)",
      "Moment.content": "Content (varchar(300))",
      "Moment.praiseUserIdList": "Liked-by User.id list (FK array)",
      "Moment.pictureList": "Picture list (json)",
      "Comment.id": "Primary key (bigint)",
      "Comment.toId": "Reply target id (bigint)",
      "Comment.userId": "Commenter User id (bigint)",
      "Comment.momentId": "Moment id (bigint)",
      "Comment.date": "Created at (timestamp)",
      "Comment.content": "Content (varchar(1000))",
    },
    types: {
      "User.id": "bigint",
      "User.name": "varchar(20)",
      "User.sex": "tinyint",
      "User.tag": "varchar(45)",
      "User.head": "varchar(300)",
      "User.contactIdList": "json",
      "User.pictureList": "json",
      "User.date": "timestamp",
      "Moment.id": "bigint",
      "Moment.userId": "bigint",
      "Moment.date": "timestamp",
      "Moment.content": "varchar(300)",
      "Moment.praiseUserIdList": "json",
      "Moment.pictureList": "json",
      "Comment.id": "bigint",
      "Comment.toId": "bigint",
      "Comment.userId": "bigint",
      "Comment.momentId": "bigint",
      "Comment.date": "timestamp",
      "Comment.content": "varchar(1000)",
    },
  };
  const out = empty();
  for (const t of tables) {
    if (all.tables[t]) out.tables[t] = all.tables[t]!;
    for (const [k, v] of Object.entries(all.columns)) {
      if (k.startsWith(`${t}.`)) out.columns[k] = v;
    }
    for (const [k, v] of Object.entries(all.types)) {
      if (k.startsWith(`${t}.`)) out.types[k] = v;
    }
  }
  return out;
}

/** Extract table names from an APIJSON request or response body. */
export function extractTableNames(doc: unknown): string[] {
  const names = new Set<string>();
  walk(doc, names);
  return [...names];
}

function walk(node: unknown, names: Set<string>): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, names);
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (/^[A-Z][A-Za-z0-9]*$/.test(k) && k !== "Table" && k !== "Column") {
      names.add(k);
    }
    if (typeof v === "object") walk(v, names);
  }
}

export async function commentsForPayload(
  client: ApiJsonClient,
  ...docs: unknown[]
): Promise<SchemaComments> {
  const tables = new Set<string>();
  for (const d of docs) {
    for (const t of extractTableNames(d)) tables.add(t);
  }
  // Always include Demo core tables as baseline
  for (const t of ["User", "Moment", "Comment"]) tables.add(t);
  return loadSchemaComments(client, [...tables]);
}

export { merge as mergeComments };

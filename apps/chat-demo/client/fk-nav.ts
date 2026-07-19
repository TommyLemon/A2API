/** Resolve logical/physical FK fields → target table + id. */

import type { SchemaComments } from "./schema-types.js";

const KNOWN: Record<string, string> = {
  user: "User",
  moment: "Moment",
  comment: "Comment",
  touser: "User",
  fromuser: "User",
  userid: "User",
  momentid: "Moment",
  commentid: "Comment",
};

function colName(path: string): string {
  return path.includes(".") ? path.split(".").pop()! : path;
}

/** Map stem → catalog table only (no invented names). */
function knownStemToTable(stem: string): string | null {
  const key = stem.replace(/_/g, "").toLowerCase();
  if (KNOWN[key]) return KNOWN[key]!;
  const parts = stem.replace(/([a-z])([A-Z])/g, "$1_$2").split(/[_\s]+/);
  const last = parts[parts.length - 1]?.toLowerCase() || "";
  if (KNOWN[last]) return KNOWN[last]!;
  const camel = stem.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g);
  if (camel?.length) {
    const lastSeg = camel[camel.length - 1]!;
    const hit = KNOWN[lastSeg.toLowerCase()];
    if (hit) return hit;
  }
  return null;
}

function stemToTable(stem: string): string | null {
  const known = knownStemToTable(stem);
  if (known) return known;
  // Heuristic fallback for pickers: invent PascalCase from last camel segment
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(stem) && stem.length > 1) {
    const camel = stem.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g);
    if (camel?.length) {
      const lastSeg = camel[camel.length - 1]!;
      return lastSeg.charAt(0).toUpperCase() + lastSeg.slice(1);
    }
  }
  return null;
}

function parseId(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/** Resolve FK column → target table (no value required; for create/edit pickers). */
export function resolveFkTable(
  path: string,
  comments?: SchemaComments | null,
): string | null {
  const col = colName(path);
  if (col === "id") return null;

  let table: string | null = null;

  const idMatch = col.match(/^(.+?)_?[Ii]d$/);
  if (idMatch?.[1]) {
    table = stemToTable(idMatch[1]);
  }

  const comment = comments?.columns?.[path] || "";
  const commentBare = comment.replace(/\s*\([^)]*\)\s*$/, "");
  if (!table) {
    const m =
      commentBare.match(
        /(?:外键|引用|关联|references?|fk)\s*[「"']?([A-Za-z_][A-Za-z0-9_]*)/i,
      ) || commentBare.match(/\b(User|Moment|Comment)\b/);
    if (m?.[1]) {
      const t = m[1]!;
      table = KNOWN[t.toLowerCase()] || t.charAt(0).toUpperCase() + t.slice(1);
    }
  }

  if (!table && /用户/.test(commentBare)) table = "User";
  if (!table && /动态|朋友圈/.test(commentBare)) table = "Moment";
  if (!table && /评论/.test(commentBare)) table = "Comment";

  return table;
}

/**
 * High-confidence FK only — for DDL ON defaults.
 * Fills when: *Id/*_id maps to a known catalog table, or comment
 * explicitly says 外键/引用/关联/references/fk + table, or names a
 * known table (User|Moment|Comment). Does not invent unknown stems.
 */
export function resolveHighConfidenceFkTable(
  path: string,
  comments?: SchemaComments | null,
): string | null {
  const col = colName(path);
  if (col === "id") return null;

  const idMatch = col.match(/^(.+?)_?[Ii]d$/);
  if (idMatch?.[1]) {
    const t = knownStemToTable(idMatch[1]);
    if (t) return t;
  }

  const comment = comments?.columns?.[path] || "";
  const commentBare = comment.replace(/\s*\([^)]*\)\s*$/, "");
  const explicit =
    commentBare.match(
      /(?:外键|引用|关联|references?|fk)\s*[「"']?([A-Za-z_][A-Za-z0-9_]*)/i,
    ) || commentBare.match(/\b(User|Moment|Comment)\b/);
  if (explicit?.[1]) {
    const t = explicit[1]!;
    return KNOWN[t.toLowerCase()] || t.charAt(0).toUpperCase() + t.slice(1);
  }

  // Chinese domain labels only when column looks like an id FK
  if (idMatch) {
    if (/用户/.test(commentBare)) return "User";
    if (/动态|朋友圈/.test(commentBare)) return "Moment";
    if (/评论/.test(commentBare)) return "Comment";
  }

  return null;
}

/**
 * Detect FK: *Id / *_id (not bare id), or DDL/comment hints like 外键/引用 User.
 */
export function resolveFkTarget(
  path: string,
  value: unknown,
  comments?: SchemaComments | null,
): { table: string; id: string | number } | null {
  const id = parseId(value);
  if (id == null) return null;
  const table = resolveFkTable(path, comments);
  if (!table) return null;
  return { table, id };
}

/** Preferred display columns per FK table (first hit wins). */
export const FK_DISPLAY_FIELDS: Record<string, string[]> = {
  User: ["name", "tag", "head"],
  Moment: ["content"],
  Comment: ["content"],
};

/**
 * Replace raw FK id with a mapped label from joined row cells,
 * e.g. Moment.userId → actual User.name string (never invent "User#id").
 * Returns null when no real display field is present in the row.
 */
export function fkDisplayLabel(
  path: string,
  value: unknown,
  cells: Record<string, unknown>,
  comments?: SchemaComments | null,
): { table: string; id: string | number; label: string } | null {
  const fk = resolveFkTarget(path, value, comments);
  if (!fk) return null;
  const fields = FK_DISPLAY_FIELDS[fk.table] ?? [
    "name",
    "content",
    "title",
    "tag",
  ];
  for (const f of fields) {
    const v = cells[`${fk.table}.${f}`];
    if (v == null || v === "") continue;
    const s = String(v).trim();
    if (!s) continue;
    // Skip if "label" is just the id echoed back
    if (s === String(fk.id)) continue;
    return { ...fk, label: s };
  }
  // Joined table present but preferred fields empty — still no fake User#id
  return null;
}

export type FkJumpMeta = {
  table: string;
  id: string | number;
  label: string | null;
};

/** FK meta for link/jump even when display name is missing. */
export function fkLinkMeta(
  path: string,
  value: unknown,
  cells: Record<string, unknown>,
  comments?: SchemaComments | null,
): FkJumpMeta | null {
  const fk = resolveFkTarget(path, value, comments);
  if (!fk) return null;
  const named = fkDisplayLabel(path, value, cells, comments);
  return { table: fk.table, id: fk.id, label: named?.label ?? null };
}

/**
 * Joined FK-table columns (e.g. User.name / Moment.content) → jump to that
 * table's detail via `Table.id` (or the primary row's FK id). Skips primary.
 */
export function joinedFkTableLinkMeta(
  path: string,
  value: unknown,
  cells: Record<string, unknown>,
  primaryTable?: string | null,
  comments?: SchemaComments | null,
): FkJumpMeta | null {
  if (!path.includes(".")) return null;
  const table = path.split(".")[0]!;
  if (!/^[A-Z][A-Za-z0-9]*$/.test(table)) return null;
  if (primaryTable && table === primaryTable) return null;

  let id = parseId(cells[`${table}.id`]);
  if (id == null) {
    // Fallback: any *Id cell in the row that references this table
    for (const [k, v] of Object.entries(cells)) {
      if (resolveFkTable(k, comments) !== table) continue;
      id = parseId(v);
      if (id != null) break;
    }
  }
  if (id == null) return null;

  const text = String(value ?? "").trim();
  let label: string | null =
    text && text !== String(id) ? text : null;
  if (!label) {
    for (const f of FK_DISPLAY_FIELDS[table] ?? [
      "name",
      "content",
      "title",
      "tag",
    ]) {
      const v = cells[`${table}.${f}`];
      if (v == null || v === "") continue;
      const s = String(v).trim();
      if (s && s !== String(id)) {
        label = s;
        break;
      }
    }
  }
  return { table, id, label };
}

/** Prefer FK-id column link; else joined FK-table field link. */
export function cellFkJumpMeta(
  path: string,
  value: unknown,
  cells: Record<string, unknown>,
  comments?: SchemaComments | null,
  primaryTable?: string | null,
): FkJumpMeta | null {
  return (
    fkLinkMeta(path, value, cells, comments) ||
    joinedFkTableLinkMeta(path, value, cells, primaryTable, comments)
  );
}

export function buildFkGetBody(
  table: string,
  id: string | number,
): Record<string, unknown> {
  // Multi-table reads must live under [] with an explicit join key
  if (table === "Moment") {
    return {
      "[]": {
        count: 1,
        join: "@/User",
        Moment: { id },
        User: { "id@": "/Moment/userId", "@column": "id,name" },
      },
    };
  }
  if (table === "Comment") {
    return {
      "[]": {
        count: 1,
        join: "@/User,@/Moment",
        Comment: { id },
        User: { "id@": "/Comment/userId", "@column": "id,name" },
        Moment: { "id@": "/Comment/momentId", "@column": "id,content" },
      },
    };
  }
  return { [table]: { id } };
}

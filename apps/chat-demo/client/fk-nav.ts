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
  /** contactIdList → friends = User ids */
  contact: "User",
  praiseuser: "User",
};

function colName(path: string): string {
  return path.includes(".") ? path.split(".").pop()! : path;
}

/** Parent table from `Table.col` paths (PascalCase only). */
function parentTableOf(path: string): string | null {
  if (!path.includes(".")) return null;
  const t = path.split(".")[0]!;
  return /^[A-Z][A-Za-z0-9]*$/.test(t) ? t : null;
}

/**
 * Self / reply FKs that stem heuristics cannot name (e.g. Comment.toId → Comment).
 */
function selfRefFkTable(path: string): string | null {
  const col = colName(path);
  const parent = parentTableOf(path);
  if (!parent) return null;
  // Reply-to parent row (same table PK)
  if (col === "toId" && parent === "Comment") return "Comment";
  if (col === "parentId" || col === "parent_id") return parent;
  return null;
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
  // Do not invent tables from short/ambiguous stems (toId → "To")
  if (stem.length < 3) return null;
  // Heuristic fallback for pickers: invent PascalCase from last camel segment
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(stem)) {
    const camel = stem.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g);
    if (camel?.length) {
      const lastSeg = camel[camel.length - 1]!;
      if (lastSeg.length < 3) return null;
      return lastSeg.charAt(0).toUpperCase() + lastSeg.slice(1);
    }
  }
  return null;
}

/** Optional ColumnMeta-style override for FK target. */
export type FkMetaOverride = {
  /** External / target table (外表) */
  onTable?: string;
  /** Target key on that table; omit → id (外键 key 可选) */
  onField?: string;
} | null;

export type FkRef = {
  table: string;
  /** Target key field; defaults to id when meta.onField empty */
  field: string;
};

/** True when onTable looks like a real table (not a short invented stem like "To"). */
function isPlausibleFkTable(table: string): boolean {
  if (KNOWN[table.toLowerCase()]) return true;
  // PascalCase, at least 3 chars — rejects old toId→"To" inventions
  return /^[A-Z][A-Za-z0-9]{2,}$/.test(table);
}

/**
 * Resolve FK target table + key.
 * Prefers manual meta (onTable / optional onField) so wrong auto-detect can be fixed.
 */
export function resolveFkRef(
  path: string,
  comments?: SchemaComments | null,
  meta?: FkMetaOverride,
): FkRef | null {
  const overrideTable = meta?.onTable?.trim() || "";
  const auto = resolveFkTable(path, comments);
  const table =
    (overrideTable && isPlausibleFkTable(overrideTable) ? overrideTable : "") ||
    auto;
  if (!table) return null;
  const field = meta?.onField?.trim() || "id";
  return { table, field };
}

function parseId(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/**
 * FK id-array columns: praiseUserIdList / contactIdList / userIds → target table.
 * These hold arrays of related primary keys (usually User.id), not JSON blobs.
 */
export function resolveFkIdListTable(
  path: string,
  comments?: SchemaComments | null,
): string | null {
  const col = colName(path);
  const listMatch = col.match(/^(.+?)_?[Ii]d[Ll]ist$/);
  const idsMatch = !listMatch ? col.match(/^(.+?)_?[Ii]ds$/) : null;
  const stem = listMatch?.[1] || idsMatch?.[1];
  if (!stem) return null;

  // praiseUser → last camel segment "User"
  const camel = stem.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g);
  if (camel?.length) {
    for (let i = camel.length - 1; i >= 0; i--) {
      const seg = camel[i]!;
      const known = knownStemToTable(seg);
      if (known) return known;
    }
  }

  const known = knownStemToTable(stem);
  if (known) return known;

  const comment = comments?.columns?.[path] || "";
  const commentBare = comment.replace(/\s*\([^)]*\)\s*$/, "");
  if (/\b(User|用户)\b/i.test(commentBare) || /用户/.test(commentBare)) {
    return "User";
  }
  if (/\b(Moment|动态|朋友圈)\b/i.test(commentBare)) return "Moment";
  if (/\b(Comment|评论)\b/i.test(commentBare)) return "Comment";

  // Default for *UserIdList / *userIds style already handled; contact → User
  if (/user$/i.test(stem) || /^contact$/i.test(stem)) return "User";

  return null;
}

/** Resolve FK column → target table (no value required; for create/edit pickers). */
export function resolveFkTable(
  path: string,
  comments?: SchemaComments | null,
): string | null {
  const col = colName(path);
  if (col === "id") return null;
  // Id-list columns are multi-FK, not scalar FK
  if (resolveFkIdListTable(path, comments)) return null;

  const self = selfRefFkTable(path);
  if (self) return self;

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

  const self = selfRefFkTable(path);
  if (self) return self;

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
 * `meta` overrides auto table / optional target key (default id).
 */
export function resolveFkTarget(
  path: string,
  value: unknown,
  comments?: SchemaComments | null,
  meta?: FkMetaOverride,
): { table: string; id: string | number; field: string } | null {
  const id = parseId(value);
  if (id == null) return null;
  const ref = resolveFkRef(path, comments, meta);
  if (!ref) return null;
  return { table: ref.table, id, field: ref.field };
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
  meta?: FkMetaOverride,
): { table: string; id: string | number; label: string } | null {
  const fk = resolveFkTarget(path, value, comments, meta);
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
    return { table: fk.table, id: fk.id, label: s };
  }
  // Joined table present but preferred fields empty — still no fake User#id
  return null;
}

export type FkJumpMeta = {
  table: string;
  id: string | number;
  /** Target key used when loading the row (default id) */
  field?: string;
  label: string | null;
};

/** FK meta for link/jump even when display name is missing. */
export function fkLinkMeta(
  path: string,
  value: unknown,
  cells: Record<string, unknown>,
  comments?: SchemaComments | null,
  meta?: FkMetaOverride,
): FkJumpMeta | null {
  const fk = resolveFkTarget(path, value, comments, meta);
  if (!fk) return null;
  const named = fkDisplayLabel(path, value, cells, comments, meta);
  return {
    table: fk.table,
    id: fk.id,
    field: fk.field,
    label: named?.label ?? null,
  };
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
  meta?: FkMetaOverride,
): FkJumpMeta | null {
  return (
    fkLinkMeta(path, value, cells, comments, meta) ||
    joinedFkTableLinkMeta(path, value, cells, primaryTable, comments)
  );
}

/**
 * Single-record detail by target key — omit `@column` so APIJSON returns all fields.
 * (List queries may use a narrow `@column`; detail must not inherit that.)
 * `field` defaults to id; pass meta.onField when the FK key is not id.
 */
export function buildFkGetBody(
  table: string,
  id: string | number,
  field = "id",
): Record<string, unknown> {
  const key = field.trim() || "id";
  return { [table]: { [key]: id } };
}

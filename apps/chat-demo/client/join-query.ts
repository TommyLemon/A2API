/** Multi-table SQL / APP JOIN for APIJSON `[]`.join */

export type JoinOp = "&" | "|" | "!" | "<" | ">" | ")" | "(" | "";

export const JOIN_OP_OPTIONS: Array<{ op: JoinOp; label: string }> = [
  { op: "", label: "APP @" },
  { op: "&", label: "INNER &" },
  { op: "<", label: "LEFT <" },
  { op: ">", label: "RIGHT >" },
  { op: "|", label: "FULL |" },
  { op: "!", label: "OUTER !" },
  { op: "(", label: "ANTI (" },
  { op: ")", label: "SIDE )" },
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Tables in list body that can participate in join (PascalCase objects). */
export function listTablesInBody(
  body: Record<string, unknown>,
): string[] {
  const list = body["[]"];
  if (!isPlainObject(list)) return [];
  return Object.keys(list).filter(
    (k) => /^[A-Z]/.test(k) && isPlainObject(list[k]),
  );
}

/** UI empty op / APP → `@` token for `[]`.join */
export function joinOpToken(op: JoinOp | undefined | null): string {
  return op || "@";
}

/**
 * Build `[]`.join value, e.g. `"@/User,&/Comment"`.
 * Every non-primary table must appear — APIJSON multi-table requires `join`.
 */
export function buildJoinValue(
  tables: string[],
  primaryTable: string | null,
  joins?: Record<string, JoinOp>,
): string {
  const parts: string[] = [];
  for (const table of tables) {
    if (primaryTable && table === primaryTable) continue;
    parts.push(`${joinOpToken(joins?.[table])}/${table}`);
  }
  return parts.join(",");
}

/**
 * Ensure `[]`.join lists every secondary table.
 * Empty / missing op → APP join `@/Table` (still written into `join`).
 */
export function applyTableJoins(
  body: Record<string, unknown>,
  primaryTable: string | null,
  joins: Record<string, JoinOp> = {},
): Record<string, unknown> {
  const next = structuredClone(body);
  const list = next["[]"];
  if (!isPlainObject(list)) return next;

  const tables = listTablesInBody(next);
  if (tables.length < 2) {
    delete list.join;
    return next;
  }

  const value = buildJoinValue(tables, primaryTable, joins);
  if (value) list.join = value;
  else delete list.join;
  return next;
}

/** Set join on a bare list object (mutates). */
export function setListJoin(
  list: Record<string, unknown>,
  primaryTable: string | null,
  joins: Record<string, JoinOp> = {},
): void {
  const tables = Object.keys(list).filter(
    (k) => /^[A-Z]/.test(k) && isPlainObject(list[k]),
  );
  if (tables.length < 2) {
    delete list.join;
    return;
  }
  const value = buildJoinValue(tables, primaryTable, joins);
  if (value) list.join = value;
  else delete list.join;
}

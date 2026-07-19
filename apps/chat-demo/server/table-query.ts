/** Column sort / filter state → APIJSON @order & field conditions. */

export type SortDir = "asc" | "desc";

export type ColumnSort = {
  path: string;
  dir: SortDir;
};

export type FilterOp =
  | "contains"
  | "prefix"
  | "suffix"
  | "eq"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

/** How a condition combines with the previous one on the same field. */
export type FilterJoin = "and" | "or";

export type FilterCondition = {
  id: string;
  op: FilterOp;
  value: string;
  /** Negate this condition */
  not?: boolean;
  /** Join with previous condition; ignored for the first. Default "and". */
  join?: FilterJoin;
};

export type ColumnFilter = {
  path: string;
  conditions: FilterCondition[];
};

export function newConditionId(): string {
  return `c_${Math.random().toString(36).slice(2, 9)}`;
}

export function emptyCondition(op: FilterOp = "contains"): FilterCondition {
  return { id: newConditionId(), op, value: "", join: "and", not: false };
}

export function filterHasValue(f: ColumnFilter): boolean {
  return f.conditions.some((c) => c.value.trim() !== "");
}

export function filtersForPath(
  filters: ColumnFilter[],
  path: string,
): ColumnFilter | undefined {
  return filters.find((f) => f.path === path);
}

/** Short token used in combine expr (column name; Table.col if ambiguous). */
export function filterFieldToken(
  path: string,
  allPaths?: string[],
): string {
  const col = path.includes(".") ? path.split(".").pop()! : path;
  if (!allPaths?.length || !path.includes(".")) return col;
  const tables = new Set(
    allPaths
      .filter((p) => p.endsWith(`.${col}`))
      .map((p) => p.split(".")[0]!),
  );
  if (tables.size > 1) return path; // Table.column
  return col;
}

/** Default cross-field combine: field1 & field2 & … */
export function buildDefaultFieldCombine(
  filters: ColumnFilter[],
): string {
  const active = filters.filter(filterHasValue);
  if (!active.length) return "";
  const paths = active.map((f) => f.path);
  const tokens = active.map((f) => filterFieldToken(f.path, paths));
  if (tokens.length === 1) return tokens[0]!;
  return tokens.join(" & ");
}

/** Tokens mentioned in a combine expression (identifiers). */
export function tokensInCombineExpr(expr: string): string[] {
  const out: string[] = [];
  const re = /!?([A-Za-z_][\w.]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) {
    const t = m[1]!;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** Primary-key `id` columns: no filter icon (userId / momentId still filterable). */
export function hideFilterIcon(path: string): boolean {
  const col = path.includes(".") ? path.split(".").pop()! : path;
  return col === "id";
}

export function cycleSort(sorts: ColumnSort[], path: string): ColumnSort[] {
  const idx = sorts.findIndex((s) => s.path === path);
  if (idx < 0) return [...sorts, { path, dir: "asc" }];
  const cur = sorts[idx]!;
  if (cur.dir === "asc") {
    const next = [...sorts];
    next[idx] = { path, dir: "desc" };
    return next;
  }
  return sorts.filter((s) => s.path !== path);
}

export function sortDirOf(
  sorts: ColumnSort[],
  path: string,
): SortDir | "none" {
  return sorts.find((s) => s.path === path)?.dir ?? "none";
}

function parsePath(path: string): { table: string; column: string } {
  if (path.includes(".")) {
    const [table, column] = path.split(".");
    return { table: table!, column: column! };
  }
  return { table: "", column: path };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function coerce(v: string): string | number {
  if (/^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return v;
}

function buildOrderByTable(sorts: ColumnSort[]): Record<string, string> {
  const byTable = new Map<string, string[]>();
  for (const s of sorts) {
    const { table, column } = parsePath(s.path);
    if (!table || !column) continue;
    const token = `${column}${s.dir === "asc" ? "+" : "-"}`;
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table)!.push(token);
  }
  const out: Record<string, string> = {};
  for (const [table, tokens] of byTable) out[table] = tokens.join(",");
  return out;
}

/** Map one condition to APIJSON column key + value (e.g. content$ / %x%). */
function conditionToApiJson(
  column: string,
  op: FilterOp,
  value: string,
): { key: string; value: unknown } {
  switch (op) {
    case "contains":
      return { key: `${column}$`, value: `%${value}%` };
    case "prefix":
      return { key: `${column}$`, value: `${value}%` };
    case "suffix":
      return { key: `${column}$`, value: `%${value}` };
    case "eq":
      return { key: column, value: coerce(value) };
    case "gt":
      return { key: `${column}{}`, value: `>${value}` };
    case "gte":
      return { key: `${column}{}`, value: `>=${value}` };
    case "lt":
      return { key: `${column}{}`, value: `<${value}` };
    case "lte":
      return { key: `${column}{}`, value: `<=${value}` };
  }
}

function clearOurFilterArtifacts(tableObj: Record<string, unknown>): void {
  for (const k of Object.keys(tableObj)) {
    if (/^__af\d+$/.test(k)) delete tableObj[k];
  }
  // Drop previous dynamic column predicates we may have written directly
  // (kept when template keys remain). Handled per-column in apply.
}

function clearColumnPredicates(
  tableObj: Record<string, unknown>,
  column: string,
): void {
  for (const k of Object.keys(tableObj)) {
    const base = k.replace(/[$%~]$/, "").replace(/[{}&|!]+$/, "").replace(/\{\}$/, "");
    // keys like content$, content{}, content&{}, content
    const bare = k
      .replace(/\$/, "")
      .replace(/~/, "")
      .replace(/%/, "")
      .replace(/&\{\}$/, "")
      .replace(/\|\{\}$/, "")
      .replace(/!\{\}$/, "")
      .replace(/\{\}$/, "");
    if (bare === column || base === column) delete tableObj[k];
  }
}

type AliasAtom = {
  alias: string;
  not: boolean;
  join: FilterJoin;
  path: string;
};

function buildCombineExpr(atoms: AliasAtom[]): string {
  if (!atoms.length) return "";
  const atom = (a: AliasAtom) => (a.not ? `!${a.alias}` : a.alias);
  let expr = atom(atoms[0]!);
  for (let i = 1; i < atoms.length; i++) {
    const a = atoms[i]!;
    const op = a.join === "or" ? "|" : "&";
    expr = `(${expr} ${op} ${atom(a)})`;
  }
  return expr;
}

/**
 * Apply multi-sort + column filters onto an APIJSON list body.
 * Multi-conditions / cross-field AND/OR/NOT use @key + @combine.
 * @param combineExpr optional human expr e.g. `date & (name | tag)`
 */
export function applyTableQuery(
  body: Record<string, unknown>,
  template: Record<string, unknown>,
  sorts: ColumnSort[],
  filters: ColumnFilter[],
  combineExpr?: string | null,
): Record<string, unknown> {
  const next = structuredClone(body);
  const list = next["[]"];
  const tmplList = template["[]"];
  if (!isPlainObject(list)) return next;

  const orders = buildOrderByTable(sorts);
  for (const k of Object.keys(list)) {
    if (!/^[A-Z]/.test(k) || !isPlainObject(list[k])) continue;
    const tableObj = list[k] as Record<string, unknown>;
    if (orders[k]) {
      tableObj["@order"] = orders[k];
    } else if (isPlainObject(tmplList) && isPlainObject(tmplList[k])) {
      const tmplOrder = (tmplList[k] as Record<string, unknown>)["@order"];
      if (tmplOrder !== undefined) tableObj["@order"] = tmplOrder;
      else delete tableObj["@order"];
    }
  }

  // Group active filters by table
  type Prepared = {
    path: string;
    column: string;
    token: string;
    conditions: Array<FilterCondition & { value: string }>;
  };
  const byTable = new Map<string, Prepared[]>();
  const allActivePaths = filters
    .filter(filterHasValue)
    .map((f) => f.path);

  for (const f of filters) {
    const active = f.conditions.filter((c) => c.value.trim() !== "");
    if (!active.length) continue;
    const { table, column } = parsePath(f.path);
    if (!table || !isPlainObject(list[table])) continue;
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table)!.push({
      path: f.path,
      column,
      token: filterFieldToken(f.path, allActivePaths),
      conditions: active.map((c) => ({ ...c, value: c.value.trim() })),
    });
  }

  const userCombine = (combineExpr || "").trim();

  for (const [table, prepared] of byTable) {
    const tableObj = list[table] as Record<string, unknown>;
    clearOurFilterArtifacts(tableObj);
    delete tableObj["@key"];
    if (typeof tableObj["@combine"] === "string") delete tableObj["@combine"];

    for (const p of prepared) clearColumnPredicates(tableObj, p.column);

    const needsCombine =
      Boolean(userCombine) ||
      prepared.length > 1 ||
      prepared.some(
        (p) =>
          p.conditions.length > 1 ||
          p.conditions.some((c) => c.not || c.join === "or"),
      );

    if (!needsCombine && prepared.every((p) => p.conditions.length === 1)) {
      for (const p of prepared) {
        const c = p.conditions[0]!;
        const { key, value } = conditionToApiJson(p.column, c.op, c.value);
        tableObj[key] = value;
      }
      continue;
    }

    // Alias + @combine — field tokens match combine expr (date, name, tag…)
    const keyMaps: string[] = [];
    const fieldExpansion = new Map<string, string>(); // token → sub-expr
    let n = 0;

    for (const p of prepared) {
      const atoms: AliasAtom[] = [];
      const simple =
        p.conditions.length === 1 && !p.conditions[0]!.not;
      for (let i = 0; i < p.conditions.length; i++) {
        const c = p.conditions[i]!;
        // Prefer field token as alias when single plain condition
        const alias =
          simple && i === 0 ? p.token : `${p.token.replace(/\./g, "_")}_${n++}`;
        const { key, value } = conditionToApiJson(p.column, c.op, c.value);
        keyMaps.push(`${alias}:(${key})`);
        tableObj[alias] = value;
        atoms.push({
          alias,
          not: Boolean(c.not),
          join: i === 0 ? "and" : c.join === "or" ? "or" : "and",
          path: p.path,
        });
      }
      fieldExpansion.set(p.token, buildCombineExpr(atoms));
    }

    tableObj["@key"] = keyMaps.join(";");

    let combine = "";
    if (userCombine) {
      // Expand multi-condition field tokens inside user expr
      combine = userCombine;
      for (const [token, expansion] of fieldExpansion) {
        if (expansion === token || expansion === `!${token}`) continue;
        // replace whole-word token with expansion when nested
        const re = new RegExp(
          `(^|[^\\w.])(${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![\\w.])`,
          "g",
        );
        combine = combine.replace(re, (_m, pre: string, _t: string) => {
          const needsParen = /[&|!]/.test(expansion) && !expansion.startsWith("(");
          return `${pre}${needsParen ? `(${expansion})` : expansion}`;
        });
      }
    } else {
      const parts = [...fieldExpansion.values()];
      combine = parts[0] || "";
      for (let i = 1; i < parts.length; i++) {
        combine = `(${combine} & ${parts[i]})`;
      }
    }
    if (combine) tableObj["@combine"] = combine;
  }

  for (const k of Object.keys(list)) {
    if (!/^[A-Z]/.test(k) || !isPlainObject(list[k])) continue;
    if (byTable.has(k)) continue;
    clearOurFilterArtifacts(list[k] as Record<string, unknown>);
  }

  return next;
}

/** Patch page/count onto list body. */
export function applyPaging(
  body: Record<string, unknown>,
  page?: number,
  count?: number,
): Record<string, unknown> {
  const next = structuredClone(body);
  const list = next["[]"];
  if (!isPlainObject(list)) return next;
  if (page !== undefined) list.page = page;
  if (count !== undefined) list.count = count;
  return next;
}

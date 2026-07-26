/** Shared list query helpers for Apply / Call admin lists. */

export type ListPage = {
  page: number;
  pageSize: number;
  order: string;
};

export function clampPage(raw: unknown, fallback = 0): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function clampPageSize(
  raw: unknown,
  fallback = 20,
  max = 100,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

/** Whitelist order → APIJSON `@order` (`field+` / `field-`). */
export function normalizeOrder(
  raw: string | undefined,
  allowed: readonly string[],
  fallback: string,
): string {
  const s = (raw || "").trim();
  if (!s) return fallback;
  const m = /^([A-Za-z_][\w]*)([+-]?)$/.exec(s);
  if (!m) return fallback;
  const field = m[1]!;
  if (!allowed.includes(field)) return fallback;
  const dir = m[2] === "+" ? "+" : "-";
  return `${field}${dir}`;
}

export function parseTotal(body: unknown, fallback: number): number {
  const root =
    body != null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  if (!root) return fallback;
  for (const key of ["total", "count", "sum"]) {
    const v = root[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
    if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  }
  const info = root.info;
  if (info != null && typeof info === "object" && !Array.isArray(info)) {
    const t = (info as Record<string, unknown>).total;
    if (typeof t === "number" && Number.isFinite(t) && t >= 0) return Math.floor(t);
  }
  return fallback;
}

export function compareByOrder<T>(
  a: T,
  b: T,
  order: string,
  get: (row: T, field: string) => unknown,
): number {
  const m = /^([A-Za-z_][\w]*)([+-]?)$/.exec(order);
  const field = m?.[1] || "id";
  const asc = m?.[2] === "+";
  const av = get(a, field);
  const bv = get(b, field);
  let cmp = 0;
  if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
  else {
    const as = av == null ? "" : String(av);
    const bs = bv == null ? "" : String(bv);
    const an = Number(as);
    const bn = Number(bs);
    if (as !== "" && bs !== "" && Number.isFinite(an) && Number.isFinite(bn)) {
      cmp = an - bn;
    } else {
      cmp = as.localeCompare(bs, undefined, { numeric: true });
    }
  }
  return asc ? cmp : -cmp;
}

export function paginateInMemory<T>(
  rows: T[],
  page: number,
  pageSize: number,
): { items: T[]; total: number; page: number; pageSize: number } {
  const total = rows.length;
  const maxPage = total === 0 ? 0 : Math.floor((total - 1) / pageSize);
  const safePage = Math.min(Math.max(page, 0), maxPage);
  const start = safePage * pageSize;
  return {
    items: rows.slice(start, start + pageSize),
    total,
    page: safePage,
    pageSize,
  };
}

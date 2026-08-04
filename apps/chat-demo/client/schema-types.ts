export type SchemaComments = {
  tables: Record<string, string>;
  columns: Record<string, string>;
  types?: Record<string, string>;
};

export type ApiJsonMethod =
  | "get"
  | "gets"
  | "head"
  | "heads"
  | "post"
  | "put"
  | "delete"
  | "crud";

const ROLE_LADDER = [
  "UNKNOWN",
  "LOGIN",
  "CONTACT",
  "CIRCLE",
  "OWNER",
  "ADMIN",
] as const;

function roleRank(role: string): number {
  return ROLE_LADDER.indexOf(role.toUpperCase() as (typeof ROLE_LADDER)[number]);
}

export function parseRoleList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((r) => String(r).toUpperCase()).filter(Boolean);
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return [];
    try {
      const parsed = JSON.parse(t) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((r) => String(r).toUpperCase()).filter(Boolean);
      }
    } catch {
      /* ignore */
    }
  }
  return [];
}

export function minRoleFromAllowed(allowed: string[]): string | null {
  let best: string | null = null;
  let bestRank = Infinity;
  for (const r of allowed) {
    const rank = roleRank(r);
    if (rank >= 0 && rank < bestRank) {
      bestRank = rank;
      best = r.toUpperCase();
    }
  }
  return best;
}

export function combineMinRoles(
  roles: Array<string | null | undefined>,
): string | null {
  let best: string | null = null;
  let bestRank = -1;
  for (const r of roles) {
    if (r == null || r === "") continue;
    const rank = roleRank(r);
    if (rank > bestRank) {
      bestRank = rank;
      best = r.toUpperCase();
    }
  }
  return best;
}

export function extractRequestTables(body: Record<string, unknown>): string[] {
  const tables = new Set<string>();
  const visit = (obj: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(obj)) {
      if (key === "@role" || key === "tag" || key === "defaults") continue;
      if (
        key === "[]" &&
        value != null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        visit(value as Record<string, unknown>);
        continue;
      }
      if (
        /^[A-Z]/.test(key) &&
        value != null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        tables.add(key);
      }
    }
  };
  visit(body);
  return [...tables];
}

export function stripApiJsonRole(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!("@role" in body)) return { ...body };
  const next = { ...body };
  delete next["@role"];
  return next;
}

export function withApiJsonRole(
  body: Record<string, unknown>,
  role: string | null | undefined,
): Record<string, unknown> {
  const next = stripApiJsonRole(body);
  if (role != null && role !== "") next["@role"] = role;
  return next;
}

/** Client-sent `@role` is never below LOGIN (UNKNOWN is not sent). */
export function floorRequestRole(role: string | null | undefined): string {
  if (role == null || role === "") return "LOGIN";
  const upper = role.toUpperCase();
  if (roleRank(upper) < roleRank("LOGIN")) return "LOGIN";
  return upper;
}

/**
 * GET/HEAD(/GETS/HEADS): set Access min `@role` (floored to LOGIN).
 * POST/PUT/DELETE: omit `@role` (server fills).
 */
export function applyMethodRole(
  body: Record<string, unknown>,
  method: ApiJsonMethod,
  resolveMinRole: (tables: string[], method: ApiJsonMethod) => string | null,
): Record<string, unknown> {
  const stripped = stripApiJsonRole(body);
  if (
    method === "post" ||
    method === "put" ||
    method === "delete" ||
    method === "crud"
  ) {
    return stripped;
  }
  if (
    method === "get" ||
    method === "head" ||
    method === "gets" ||
    method === "heads"
  ) {
    const tables = extractRequestTables(stripped);
    const role = floorRequestRole(resolveMinRole(tables, method));
    return withApiJsonRole(stripped, role);
  }
  return stripped;
}

/**
 * APIJSON /login: `defaults: { "@role": "LOGIN" }`.
 */
export function withLoginDefaults(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const prev =
    body.defaults &&
    typeof body.defaults === "object" &&
    !Array.isArray(body.defaults)
      ? (body.defaults as Record<string, unknown>)
      : {};
  return {
    ...body,
    defaults: { ...prev, "@role": "LOGIN" },
  };
}

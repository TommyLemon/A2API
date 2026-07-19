import type { ApiJsonMethod } from "./types.js";

/** APIJSON role ladder (low → high privilege). */
export const APIJSON_ROLES = [
  "UNKNOWN",
  "LOGIN",
  "CONTACT",
  "CIRCLE",
  "OWNER",
  "ADMIN",
] as const;

export type ApiJsonRole = (typeof APIJSON_ROLES)[number];

/** @deprecated Prefer Access-based min role for GET/HEAD; kept for callers that still name OWNER. */
export const APIJSON_OWNER_ROLE = "OWNER" as const;

export const APIJSON_LOGIN_ROLE = "LOGIN" as const;

export function roleRank(role: string): number {
  return APIJSON_ROLES.indexOf(role.toUpperCase() as ApiJsonRole);
}

/** Parse Access.get / Access.head JSON array (string or array). */
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

/** Lowest-privilege role among allowed (UNKNOWN < … < ADMIN). */
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

/**
 * Combine per-table minimum roles: take the highest (most restrictive)
 * so every table in the request is satisfied.
 */
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

/** Business tables referenced in an APIJSON body (top-level and inside `[]`). */
export function extractRequestTables(body: Record<string, unknown>): string[] {
  const tables = new Set<string>();
  const visit = (obj: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(obj)) {
      if (key === "@role" || key === "tag" || key === "defaults") continue;
      if (key === "[]" && value != null && typeof value === "object" && !Array.isArray(value)) {
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

export type MinRoleResolver = (
  tables: string[],
  method: ApiJsonMethod,
) => string | null;

/**
 * Client-sent `@role` is never below LOGIN (UNKNOWN is not sent).
 */
export function floorRequestRole(role: string | null | undefined): string {
  if (role == null || role === "") return APIJSON_LOGIN_ROLE;
  const upper = role.toUpperCase();
  if (roleRank(upper) < roleRank(APIJSON_LOGIN_ROLE)) return APIJSON_LOGIN_ROLE;
  return upper;
}

/**
 * Role policy:
 * - GET/HEAD/GETS/HEADS: outermost `@role` = Access min role for tables
 *   (floored to LOGIN — never UNKNOWN)
 * - POST/PUT/DELETE (and other writes): omit `@role` (server fills)
 */
export function applyMethodRole(
  body: Record<string, unknown>,
  method: ApiJsonMethod,
  resolveMinRole: MinRoleResolver,
): Record<string, unknown> {
  const stripped = stripApiJsonRole(body);
  if (
    method === "post" ||
    method === "put" ||
    method === "delete"
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
 * APIJSON /login: session defaults use LOGIN (not OWNER).
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
    defaults: { ...prev, "@role": APIJSON_LOGIN_ROLE },
  };
}

/**
 * @deprecated Do not force OWNER on all requests. Use {@link applyMethodRole}.
 * Kept temporarily for any external callers.
 */
export function withOwnerRole(
  body: Record<string, unknown>,
): Record<string, unknown> {
  return withApiJsonRole(body, APIJSON_OWNER_ROLE);
}

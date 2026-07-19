/**
 * OWNER-scoped writes: Moment/Comment.userId must be the visitor (or omitted
 * so APIJSON injects it). Demo templates must never hardcode foreign ids.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Walk table objects (top-level and inside []). */
function forEachTableObject(
  body: Record<string, unknown>,
  fn: (table: string, obj: Record<string, unknown>) => void,
): void {
  for (const [key, value] of Object.entries(body)) {
    if (key === "[]" && isPlainObject(value)) {
      for (const [t, row] of Object.entries(value)) {
        if (/^[A-Z]/.test(t) && isPlainObject(row)) fn(t, row);
      }
      continue;
    }
    if (/^[A-Z]/.test(key) && isPlainObject(value)) fn(key, value);
  }
}

/**
 * Never send userId on writes — APIJSON OWNER injects the session visitor.
 * (visitorId kept for call-site compatibility; unused.)
 */
export function applyOwnerUserId(
  body: Record<string, unknown>,
  _visitorId?: string | number | null,
): Record<string, unknown> {
  const next = structuredClone(body);
  forEachTableObject(next, (_table, value) => {
    delete value.userId;
  });
  return next;
}

/**
 * Strip identity fields from template/LLM bodies before OWNER execute.
 * - Always drop userId (re-applied from visitor when needed).
 * - Drop bare `id` on GET (list/detail templates); keep on put/delete when present
 *   only if caller passes keepIds (explicit user NL).
 */
export function stripTemplateIdentity(
  body: Record<string, unknown>,
  opts?: { stripIds?: boolean },
): Record<string, unknown> {
  const next = structuredClone(body);
  const stripIds = opts?.stripIds !== false;
  forEachTableObject(next, (_table, value) => {
    delete value.userId;
    if (stripIds && "id" in value) delete value.id;
  });
  return next;
}

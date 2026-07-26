/**
 * Write hygiene for APIJSON: never send userId on post/put/delete —
 * OWNER session injects the visitor. Same for accidental User.userId.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

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

/** Remove userId from every table object (post/put/delete must omit it). */
export function stripWriteUserIds(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const next = structuredClone(body);
  forEachTableObject(next, (_table, value) => {
    delete value.userId;
  });
  return next;
}

/**
 * @deprecated Prefer stripWriteUserIds — never inject visitor userId into writes.
 */
export function applyOwnerUserId(
  body: Record<string, unknown>,
  _visitorId?: string | number | null,
): Record<string, unknown> {
  return stripWriteUserIds(body);
}

/** Drop id on POST entity so APIJSON generates it. */
export function stripPostIds(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const next = structuredClone(body);
  // /crud: only strip ids on tables listed in @post
  const postRaw = next["@post"];
  if (typeof postRaw === "string" && postRaw.trim()) {
    const postTables = new Set(
      postRaw
        .split(",")
        .map((s) => s.trim().split(":")[0]!.replace(/\[\]$/, ""))
        .filter(Boolean),
    );
    forEachTableObject(next, (table, value) => {
      if (postTables.has(table)) delete value.id;
    });
    return next;
  }
  forEachTableObject(next, (_table, value) => {
    delete value.id;
  });
  return next;
}

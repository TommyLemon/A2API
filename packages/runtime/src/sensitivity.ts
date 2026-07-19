import type { ApiJsonMethod } from "@a2api/protocol";
import { isWriteMethod } from "@a2api/protocol";

/**
 * Sensitive ops wait for admin approval; other writes auto-execute
 * and still leave an auto_approved audit record.
 *
 * Default sensitive methods: delete (override via SENSITIVE_METHODS=delete,put).
 */
export function parseSensitiveMethods(
  raw?: string,
): ReadonlySet<ApiJsonMethod> {
  const fromEnv =
    typeof process !== "undefined"
      ? process.env.SENSITIVE_METHODS
      : undefined;
  const source = raw ?? fromEnv ?? "delete";
  const set = new Set<ApiJsonMethod>();
  for (const part of source.split(/[,;\s]+/)) {
    const m = part.trim().toLowerCase();
    if (
      m === "post" ||
      m === "put" ||
      m === "delete" ||
      m === "get" ||
      m === "gets" ||
      m === "head" ||
      m === "heads"
    ) {
      set.add(m);
    }
  }
  if (!set.size) set.add("delete");
  return set;
}

export function isSensitiveOperation(
  method: ApiJsonMethod,
  sensitiveMethods: ReadonlySet<ApiJsonMethod> = parseSensitiveMethods(),
): boolean {
  return sensitiveMethods.has(method);
}

/** Writes that are not sensitive may auto-execute under auto_nonsensitive policy. */
export function isAutoExecutableWrite(
  method: ApiJsonMethod,
  sensitiveMethods?: ReadonlySet<ApiJsonMethod>,
): boolean {
  return isWriteMethod(method) && !isSensitiveOperation(method, sensitiveMethods);
}

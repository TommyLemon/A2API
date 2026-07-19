/** APIJSON Demo rejects []/count > 100 — page in chunks. */
export const APIJSON_MAX_PAGE_COUNT = 100;

export function extractArrayPage(body: unknown): unknown[] {
  if (
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Array.isArray((body as { "[]"?: unknown })["[]"])
  ) {
    return (body as { "[]": unknown[] })["[]"];
  }
  return [];
}

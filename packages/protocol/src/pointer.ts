/** Minimal JSON Pointer (RFC 6901) get/set helpers. */

function unescape(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function escape(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new Error(`JSON Pointer must start with "/": ${pointer}`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map(unescape);
}

export function getByPointer(doc: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") {
    return pointer === "/" ? getByPointer(doc, "") : doc;
  }
  let cur: unknown = doc;
  for (const token of parsePointer(pointer)) {
    if (cur == null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(token);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else {
      cur = (cur as Record<string, unknown>)[token];
    }
  }
  return cur;
}

export function setByPointer(
  doc: unknown,
  pointer: string,
  value: unknown,
): unknown {
  if (pointer === "" || pointer === "/") {
    return value;
  }
  const tokens = parsePointer(pointer);
  const root =
    doc != null && typeof doc === "object"
      ? structuredClone(doc)
      : {};

  let cur: Record<string, unknown> | unknown[] = root as
    | Record<string, unknown>
    | unknown[];

  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i]!;
    const next = tokens[i + 1]!;
    const nextIsIndex = /^\d+$/.test(next);

    if (Array.isArray(cur)) {
      const idx = Number(token);
      if (!Number.isInteger(idx)) {
        throw new Error(`Invalid array index in pointer: ${token}`);
      }
      if (cur[idx] == null || typeof cur[idx] !== "object") {
        cur[idx] = nextIsIndex ? [] : {};
      }
      cur = cur[idx] as Record<string, unknown> | unknown[];
    } else {
      const obj = cur as Record<string, unknown>;
      if (obj[token] == null || typeof obj[token] !== "object") {
        obj[token] = nextIsIndex ? [] : {};
      }
      cur = obj[token] as Record<string, unknown> | unknown[];
    }
  }

  const last = tokens[tokens.length - 1]!;
  if (Array.isArray(cur)) {
    cur[Number(last)] = value;
  } else {
    (cur as Record<string, unknown>)[last] = value;
  }
  return root;
}

export function toPointer(parts: string[]): string {
  if (parts.length === 0) return "";
  return "/" + parts.map(escape).join("/");
}

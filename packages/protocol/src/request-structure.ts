import type { ApiJsonMethod } from "./types.js";
import type { ValidationIssue, ValidationResult } from "./validate.js";

export type RequestStructureRow = {
  method: string;
  tag: string;
  version: number;
  structure: Record<string, unknown>;
  detail?: string;
};

export type TableStructureRules = {
  must: string[];
  refuse: string[];
  /** REFUSE contains `!` — only MUST / TYPE / explicitly `!field` allowlist */
  refuseAll: boolean;
  allow: string[];
  insert: Record<string, unknown>;
  types: Record<string, string>;
  verify: Record<string, string>;
};

function issue(path: string, message: string): ValidationIssue {
  return { path, message };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function splitCsv(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** GET/HEAD without tag are open; everything else is structure-checked. */
export function isOpenApiJsonRequest(
  method: ApiJsonMethod,
  body: Record<string, unknown>,
): boolean {
  if (method === "get" || method === "head") {
    const tag = body.tag;
    return !(typeof tag === "string" && tag.trim().length > 0);
  }
  return false;
}

export function structureCacheKey(method: string, tag: string): string {
  return `${method.toUpperCase()}\0${tag}`;
}

/**
 * Pick Request row: version unset/≤0 → highest; else nearest version ≤ asked
 * (APIJSON: 最接近的最低版本).
 */
export function pickRequestRow(
  rows: RequestStructureRow[],
  method: string,
  tag: string,
  version?: number | null,
): RequestStructureRow | null {
  const m = method.toUpperCase();
  const matched = rows
    .filter((r) => r.method.toUpperCase() === m && r.tag === tag)
    .sort((a, b) => a.version - b.version);
  if (!matched.length) return null;
  if (version == null || version <= 0) {
    return matched[matched.length - 1]!;
  }
  let best: RequestStructureRow | null = null;
  for (const r of matched) {
    if (r.version <= version) best = r;
  }
  return best ?? matched[0]!;
}

const META_KEYS = new Set([
  "MUST",
  "REFUSE",
  "INSERT",
  "UPDATE",
  "REMOVE",
  "REPLACE",
  "UNIQUE",
  "VERIFY",
  "TYPE",
  "IS_ID_CONDITION_MUST",
]);

function parseRefuse(raw: unknown): {
  refuse: string[];
  refuseAll: boolean;
  allow: string[];
} {
  const tokens = splitCsv(raw);
  const refuse: string[] = [];
  const allow: string[] = [];
  let refuseAll = false;
  for (const t of tokens) {
    if (t === "!") {
      refuseAll = true;
      continue;
    }
    if (t.startsWith("!")) {
      allow.push(t.slice(1));
      refuseAll = true;
      continue;
    }
    refuse.push(t);
  }
  return { refuse, refuseAll, allow };
}

/** Resolve rules for one table object inside a Request.structure. */
export function resolveTableRules(
  structure: Record<string, unknown>,
  tableKey: string,
): TableStructureRules {
  // Nested table block (register → User/Privacy) or flat META-only (Moment POST)
  const nested = structure[tableKey];
  const rulesSrc: Record<string, unknown> = isPlainObject(nested)
    ? nested
    : structure;

  const { refuse, refuseAll, allow } = parseRefuse(rulesSrc.REFUSE);
  const insert = isPlainObject(rulesSrc.INSERT)
    ? { ...(rulesSrc.INSERT as Record<string, unknown>) }
    : {};
  const types = isPlainObject(rulesSrc.TYPE)
    ? Object.fromEntries(
        Object.entries(rulesSrc.TYPE as Record<string, unknown>).map(
          ([k, v]) => [k, String(v).toUpperCase()],
        ),
      )
    : {};
  const verify = isPlainObject(rulesSrc.VERIFY)
    ? Object.fromEntries(
        Object.entries(rulesSrc.VERIFY as Record<string, unknown>).map(
          ([k, v]) => [k, String(v)],
        ),
      )
    : {};

  return {
    must: splitCsv(rulesSrc.MUST),
    refuse,
    refuseAll,
    allow: [...new Set([...allow, ...Object.keys(types), ...splitCsv(rulesSrc.MUST)])],
    insert,
    types,
    verify,
  };
}

function primaryTableFromTag(tag: string): string {
  // Comment[] / Comment:[] / Moment-praise… → base table-ish key in body
  if (tag.endsWith(":[]")) return `${tag.slice(0, -3)}[]`;
  return tag;
}

function findEntityObjects(
  body: Record<string, unknown>,
): Array<{ key: string; value: Record<string, unknown> }> {
  const out: Array<{ key: string; value: Record<string, unknown> }> = [];
  for (const [key, value] of Object.entries(body)) {
    if (
      key === "tag" ||
      key === "version" ||
      key === "format" ||
      key === "@role" ||
      key === "defaults"
    ) {
      continue;
    }
    if (isPlainObject(value)) out.push({ key, value });
    if (Array.isArray(value) && key.endsWith("[]")) {
      // batch arrays validated element-wise elsewhere if needed
    }
  }
  return out;
}

function typeOk(value: unknown, typeName: string): boolean {
  const t = typeName.toUpperCase();
  if (t === "STRING" || t === "VARCHAR") return typeof value === "string";
  if (t === "NUMBER" || t === "INTEGER" || t === "DECIMAL")
    return typeof value === "number" && Number.isFinite(value);
  if (t === "BOOLEAN" || t === "BOOL") return typeof value === "boolean";
  if (t === "OBJECT") return isPlainObject(value);
  if (t === "OBJECT[]" || t === "ARRAY") return Array.isArray(value);
  return true;
}

/** Evaluate VERIFY RHS against a value (length / numeric range / PHONE). */
export function checkVerifyConstraint(
  field: string,
  opKey: string,
  rule: string,
  value: unknown,
): string | null {
  // opKey examples: phone~, phone[{}, balance+&{}, _password[{}
  const baseField = opKey.replace(/[~&|{}[\]+\-]+$/g, "").replace(/[{}]+$/g, "");
  const target = field || baseField;

  if (rule.toUpperCase() === "PHONE") {
    const s = String(value ?? "");
    if (!/^1\d{10}$/.test(s) && !/^\d{11}$/.test(s)) {
      return `${target} must be a phone number`;
    }
    return null;
  }

  if (typeof value === "string" || typeof value === "number") {
    const n =
      typeof value === "number" ? value : Number(String(value).length);
    // length ops use [{}; numeric range uses &{}
    const isLength = opKey.includes("[{}");
    const num = isLength
      ? String(value).length
      : typeof value === "number"
        ? value
        : Number(value);
    if (!Number.isFinite(num) && rule.includes("=")) {
      return `${target} invalid for VERIFY ${rule}`;
    }
    const parts = rule.split(",").map((p) => p.trim());
    for (const part of parts) {
      const m = part.match(/^(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)$/);
      if (!m) continue;
      const op = m[1]!;
      const bound = Number(m[2]);
      const ok =
        op === ">="
          ? num >= bound
          : op === "<="
            ? num <= bound
            : op === ">"
              ? num > bound
              : op === "<"
                ? num < bound
                : num === bound;
      if (!ok) {
        return isLength
          ? `${target} length must satisfy ${part}`
          : `${target} must satisfy ${part}`;
      }
    }
  }

  if (Array.isArray(value) && opKey.includes("{{}")) {
    const parts = rule.split(",").map((p) => p.trim());
    for (const part of parts) {
      const m = part.match(/^(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)$/);
      if (!m) continue;
      const op = m[1]!;
      const bound = Number(m[2]);
      const num = value.length;
      const ok =
        op === ">="
          ? num >= bound
          : op === "<="
            ? num <= bound
            : op === ">"
              ? num > bound
              : op === "<"
                ? num < bound
                : num === bound;
      if (!ok) return `${target} list size must satisfy ${part}`;
    }
  }

  return null;
}

function fieldFromVerifyKey(opKey: string): string {
  // strip operator suffixes used by APIJSON VERIFY keys
  return opKey
    .replace(/~\s*$/, "")
    .replace(/&\{\}\s*$/, "")
    .replace(/\|\{\}\s*$/, "")
    .replace(/\{\{\}\s*$/, "")
    .replace(/\[\{\}\s*$/, "")
    .replace(/\{\}\s*$/, "")
    .replace(/\+\s*$/, "")
    .replace(/-\s*$/, "");
}

export function validateEntityAgainstRules(
  tableKey: string,
  entity: Record<string, unknown>,
  rules: TableStructureRules,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const path = `body.${tableKey}`;

  for (const must of rules.must) {
    // MUST may be dotted (Moment[].page) — only check simple fields here
    if (must.includes(".") || must.includes("[]")) continue;
    if (
      !(must in entity) ||
      entity[must] === undefined ||
      entity[must] === null ||
      entity[must] === ""
    ) {
      issues.push(issue(`${path}.${must}`, `required by Request.structure MUST`));
    }
  }

  for (const key of Object.keys(entity)) {
    if (key.startsWith("@")) continue;
    if (rules.refuse.includes(key)) {
      issues.push(issue(`${path}.${key}`, `refused by Request.structure REFUSE`));
      continue;
    }
    if (rules.refuseAll) {
      const allowed = new Set([
        ...rules.allow,
        ...rules.must,
        ...Object.keys(rules.types),
      ]);
      if (!allowed.has(key) && !allowed.has(`!${key}`)) {
        // allowlist entries stored without leading !
        const ok = [...allowed].some((a) => a === key || a.endsWith(`.${key}`));
        if (!ok) {
          issues.push(
            issue(`${path}.${key}`, `not allowed (Request.structure REFUSE !)`),
          );
        }
      }
    }
  }

  for (const [field, typeName] of Object.entries(rules.types)) {
    if (field.includes(".") || field.includes("[]")) continue;
    if (!(field in entity)) continue;
    if (!typeOk(entity[field], typeName)) {
      issues.push(
        issue(`${path}.${field}`, `expected TYPE ${typeName} (Request.structure)`),
      );
    }
  }

  for (const [opKey, rule] of Object.entries(rules.verify)) {
    const field = fieldFromVerifyKey(opKey);
    if (!(field in entity) && !(opKey.replace(/[~&|{}[\]+\-]+$/g, "") in entity)) {
      // also try raw field before operators
      const alt = Object.keys(entity).find((k) => opKey.startsWith(k));
      if (!alt) continue;
      const msg = checkVerifyConstraint(alt, opKey, rule, entity[alt]);
      if (msg) issues.push(issue(`${path}.${alt}`, msg));
      continue;
    }
    if (field in entity) {
      const msg = checkVerifyConstraint(field, opKey, rule, entity[field]);
      if (msg) issues.push(issue(`${path}.${field}`, msg));
    }
  }

  return issues;
}

/**
 * Validate a non-open (or tagged) request body against Request.structure.
 */
export function validateRequestStructure(
  method: ApiJsonMethod,
  body: Record<string, unknown>,
  row: RequestStructureRow | null,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (isOpenApiJsonRequest(method, body)) {
    return { ok: true, issues: [] };
  }
  const tag = typeof body.tag === "string" ? body.tag.trim() : "";
  if (!tag) {
    return {
      ok: false,
      issues: [
        issue(
          "body.tag",
          `${method.toUpperCase()} requires tag matching Request table`,
        ),
      ],
    };
  }
  if (!row) {
    return {
      ok: false,
      issues: [
        issue(
          "body.tag",
          `no Request row for ${method.toUpperCase()} tag="${tag}"`,
        ),
      ],
    };
  }

  const structure = row.structure;
  const entities = findEntityObjects(body);
  if (!entities.length) {
    issues.push(issue("body", "missing table object for Request structure"));
    return { ok: false, issues };
  }

  // Multi-table structure (register): validate each nested table key
  const nestedTables = Object.keys(structure).filter(
    (k) =>
      !META_KEYS.has(k) &&
      (isPlainObject(structure[k]) || k.endsWith("[]")),
  );

  if (nestedTables.length) {
    for (const tableKey of nestedTables) {
      const entity = entities.find((e) => e.key === tableKey);
      if (!entity) {
        // optional nested tables skipped unless MUST at nested level requires presence
        const rules = resolveTableRules(structure, tableKey);
        if (rules.must.length) {
          issues.push(
            issue(`body.${tableKey}`, `required table for tag "${tag}"`),
          );
        }
        continue;
      }
      issues.push(
        ...validateEntityAgainstRules(
          tableKey,
          entity.value,
          resolveTableRules(structure, tableKey),
        ),
      );
    }
  } else {
    // Flat structure → primary entity (tag or first table)
    const primary = primaryTableFromTag(tag);
    const entity =
      entities.find((e) => e.key === primary || e.key === tag) ?? entities[0]!;
    issues.push(
      ...validateEntityAgainstRules(
        entity.key,
        entity.value,
        resolveTableRules(structure, entity.key),
      ),
    );
  }

  return { ok: issues.length === 0, issues };
}

/** Defaults from structure.INSERT except server-only @role. */
export function insertDefaultsFromStructure(
  structure: Record<string, unknown>,
  tableKey: string,
): Record<string, unknown> {
  const rules = resolveTableRules(structure, tableKey);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rules.insert)) {
    if (k === "@role") continue;
    out[k] = structuredClone(v);
  }
  return out;
}

export function mustFieldsFromStructure(
  structure: Record<string, unknown>,
  tableKey: string,
): string[] {
  return resolveTableRules(structure, tableKey).must.filter(
    (f) => !f.includes(".") && !f.includes("[]"),
  );
}

export function refuseFieldsFromStructure(
  structure: Record<string, unknown>,
  tableKey: string,
): string[] {
  return resolveTableRules(structure, tableKey).refuse;
}

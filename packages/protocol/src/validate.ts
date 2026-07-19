import {
  A2API_VERSION,
  type ApiJsonMethod,
  type A2ApiEnvelope,
  type BindRequestPayload,
  type ProposeRequestPayload,
  isWriteMethod,
  riskForMethod,
} from "./types.js";
import { parsePointer } from "./pointer.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

const METHODS: ReadonlySet<string> = new Set([
  "get",
  "gets",
  "head",
  "heads",
  "post",
  "put",
  "delete",
]);

function issue(path: string, message: string): ValidationIssue {
  return { path, message };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function findTableObjects(
  body: Record<string, unknown>,
): Array<{ key: string; value: Record<string, unknown> }> {
  const out: Array<{ key: string; value: Record<string, unknown> }> = [];
  for (const [key, value] of Object.entries(body)) {
    if (key === "tag" || key === "version" || key === "format" || key === "@role") {
      continue;
    }
    if (isPlainObject(value)) {
      out.push({ key, value });
    }
  }
  return out;
}

function hasIdConstraint(table: Record<string, unknown>): boolean {
  if ("id" in table) return true;
  if ("id{}" in table) return true;
  return false;
}

/** Validate an APIJSON request body for a given method. */
export function validateApiJsonBody(
  method: ApiJsonMethod,
  body: unknown,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(body)) {
    return { ok: false, issues: [issue("body", "body must be a JSON object")] };
  }

  if (isWriteMethod(method)) {
    if (typeof body.tag !== "string" || body.tag.length === 0) {
      issues.push(
        issue("body.tag", `${method.toUpperCase()} requires non-empty string "tag"`),
      );
    }
    const tables = findTableObjects(body);
    if (tables.length === 0) {
      issues.push(
        issue("body", `${method.toUpperCase()} requires at least one table object`),
      );
    }
    if (method === "put" || method === "delete") {
      for (const t of tables) {
        if (!hasIdConstraint(t.value)) {
          issues.push(
            issue(
              `body.${t.key}`,
              `${method.toUpperCase()} on "${t.key}" requires "id" or "id{}"`,
            ),
          );
        }
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

export function validateProposeRequest(
  payload: ProposeRequestPayload,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!payload.requestId || typeof payload.requestId !== "string") {
    issues.push(issue("requestId", "requestId is required"));
  }
  if (!METHODS.has(payload.method)) {
    issues.push(issue("method", `invalid method: ${String(payload.method)}`));
  } else {
    const bodyResult = validateApiJsonBody(payload.method, payload.body);
    issues.push(...bodyResult.issues);
    const expectedRisk = riskForMethod(payload.method);
    if (payload.risk && payload.risk !== expectedRisk) {
      issues.push(
        issue("risk", `risk should be "${expectedRisk}" for method ${payload.method}`),
      );
    }
  }
  return { ok: issues.length === 0, issues };
}

export function validateBindRequest(payload: BindRequestPayload): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!payload.bindingId) {
    issues.push(issue("bindingId", "bindingId is required"));
  }
  if (!METHODS.has(payload.method)) {
    issues.push(issue("method", `invalid method: ${String(payload.method)}`));
  }
  if (!payload.url || typeof payload.url !== "string") {
    issues.push(issue("url", "url is required"));
  }
  if (!isPlainObject(payload.bodyTemplate)) {
    issues.push(issue("bodyTemplate", "bodyTemplate must be an object"));
  } else if (METHODS.has(payload.method)) {
    issues.push(
      ...validateApiJsonBody(payload.method, payload.bodyTemplate).issues.map(
        (i) => ({ ...i, path: i.path.replace(/^body/, "bodyTemplate") }),
      ),
    );
  }
  if (!Array.isArray(payload.paramMap)) {
    issues.push(issue("paramMap", "paramMap must be an array"));
  } else {
    payload.paramMap.forEach((entry, idx) => {
      try {
        parsePointer(entry.from);
      } catch (e) {
        issues.push(
          issue(`paramMap[${idx}].from`, e instanceof Error ? e.message : String(e)),
        );
      }
      try {
        parsePointer(entry.to);
      } catch (e) {
        issues.push(
          issue(`paramMap[${idx}].to`, e instanceof Error ? e.message : String(e)),
        );
      }
    });
  }
  return { ok: issues.length === 0, issues };
}

export function parseEnvelope(raw: unknown): {
  envelope?: A2ApiEnvelope;
  issues: ValidationIssue[];
} {
  if (!isPlainObject(raw)) {
    return { issues: [issue("", "envelope must be an object")] };
  }
  if (raw.version !== A2API_VERSION) {
    return {
      issues: [
        issue("version", `expected version "${A2API_VERSION}", got ${String(raw.version)}`),
      ],
    };
  }
  const keys = [
    "proposeRequest",
    "reviseRequest",
    "decision",
    "bindRequest",
    "requestResult",
    "status",
  ].filter((k) => k in raw);
  if (keys.length !== 1) {
    return {
      issues: [
        issue(
          "",
          `envelope must contain exactly one of proposeRequest|reviseRequest|decision|bindRequest|requestResult|status`,
        ),
      ],
    };
  }
  const key = keys[0]!;
  if (key === "proposeRequest") {
    const payload = raw.proposeRequest as ProposeRequestPayload;
    const result = validateProposeRequest(payload);
    if (!result.ok) return { issues: result.issues };
    return {
      envelope: { version: A2API_VERSION, proposeRequest: payload },
      issues: [],
    };
  }
  if (key === "bindRequest") {
    const payload = raw.bindRequest as BindRequestPayload;
    const result = validateBindRequest(payload);
    if (!result.ok) return { issues: result.issues };
    return {
      envelope: { version: A2API_VERSION, bindRequest: payload },
      issues: [],
    };
  }
  return {
    envelope: raw as A2ApiEnvelope,
    issues: [],
  };
}

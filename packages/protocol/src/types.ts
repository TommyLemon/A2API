/** A2API protocol version for MVP envelopes. */
export const A2API_VERSION = "0.1" as const;

export type ApiJsonMethod =
  | "get"
  | "gets"
  | "head"
  | "heads"
  | "post"
  | "put"
  | "delete";

export type RiskLevel = "read" | "write";

export type RequestStatus =
  | "proposed"
  | "validated"
  | "awaiting_approval"
  | "executing"
  | "done"
  | "failed"
  | "rejected";

export interface ParamMapEntry {
  /** JSON Pointer into A2UI / host data model */
  from: string;
  /** JSON Pointer into APIJSON body template */
  to: string;
}

export interface BindRequestPayload {
  bindingId: string;
  method: ApiJsonMethod;
  url: string;
  bodyTemplate: Record<string, unknown>;
  paramMap: ParamMapEntry[];
  resultPath?: string;
  triggerActions?: string[];
}

export interface ProposeRequestPayload {
  requestId: string;
  method: ApiJsonMethod;
  body: Record<string, unknown>;
  url?: string;
  rationale?: string;
  risk?: RiskLevel;
}

export interface ReviseRequestPayload {
  requestId: string;
  method?: ApiJsonMethod;
  body?: Record<string, unknown>;
  url?: string;
}

export interface DecisionPayload {
  requestId: string;
  action: "approve" | "reject";
}

export interface RequestResultPayload {
  requestId: string;
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
}

export interface StatusPayload {
  requestId?: string;
  bindingId?: string;
  status: RequestStatus;
  message?: string;
}

export type A2ApiEnvelope =
  | { version: typeof A2API_VERSION; proposeRequest: ProposeRequestPayload }
  | { version: typeof A2API_VERSION; reviseRequest: ReviseRequestPayload }
  | { version: typeof A2API_VERSION; decision: DecisionPayload }
  | { version: typeof A2API_VERSION; bindRequest: BindRequestPayload }
  | { version: typeof A2API_VERSION; requestResult: RequestResultPayload }
  | { version: typeof A2API_VERSION; status: StatusPayload };

export const WRITE_METHODS: ReadonlySet<ApiJsonMethod> = new Set([
  "post",
  "put",
  "delete",
]);

export const READ_METHODS: ReadonlySet<ApiJsonMethod> = new Set([
  "get",
  "gets",
  "head",
  "heads",
]);

export function riskForMethod(method: ApiJsonMethod): RiskLevel {
  return WRITE_METHODS.has(method) ? "write" : "read";
}

export function isWriteMethod(method: ApiJsonMethod): boolean {
  return WRITE_METHODS.has(method);
}

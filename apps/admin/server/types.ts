/** Config application submitted by the user client for Access/Request setup. */

export type ApplicationStatus = "pending" | "approved" | "rejected";

export type HttpBodyType = "JSON" | "PARAM" | "FORM" | "DATA";

export type ApiJsonOp =
  | "get"
  | "head"
  | "gets"
  | "heads"
  | "post"
  | "put"
  | "delete";

export type WriteTargetResult = {
  ok: boolean;
  action?: "post" | "put" | "skip";
  id?: number | string;
  error?: string;
  body?: unknown;
};

export type ApplicationWriteResults = {
  Access?: WriteTargetResult;
  Request?: WriteTargetResult;
  Document?: WriteTargetResult;
  Chain?: WriteTargetResult;
};

/**
 * User-submitted permission / API config application.
 * Carries table+op+role+version and the HTTP APIJSON call to authorize.
 */
export type ConfigApplication = {
  id: string;
  status: ApplicationStatus;
  createdAt: string;
  updatedAt?: string;
  decidedAt?: string;
  decidedBy?: string;

  /** Business table alias (e.g. User) or physical name. */
  table: string;
  /** APIJSON method / Access column (get|post|put|delete|…). */
  operation: ApiJsonOp | string;
  /** Role to grant (LOGIN|OWNER|ADMIN|…). */
  role: string;
  /** Request.version */
  version: number;

  /** HTTP Method for Document (GET|POST|PUT|DELETE|…). */
  method: string;
  /** Document.type */
  type: HttpBodyType;
  /** Document.url — often http://host/put or /put */
  url: string;
  /** APIJSON request body */
  json: Record<string, unknown>;

  /** Request.tag — defaults to table */
  tag?: string;
  /** Request.structure — editable before approve */
  structure?: Record<string, unknown>;
  /** Access.alias when different from table */
  accessAlias?: string;
  /** Access.name (physical table) when known */
  accessName?: string;
  /** Document.name */
  name?: string;
  /** Free-form detail / rationale */
  detail?: string;
  /** Linked HITL / chat-demo request */
  requestId?: string;
  sessionId?: string;
  submitter?: string;
  issues?: string[];

  writeResults?: ApplicationWriteResults;
  error?: string;
};

export type ApplicationSubmitInput = {
  table: string;
  operation: string;
  role?: string;
  version?: number;
  method: string;
  type?: HttpBodyType;
  url: string;
  json: Record<string, unknown> | string;
  tag?: string;
  structure?: Record<string, unknown>;
  accessAlias?: string;
  accessName?: string;
  name?: string;
  detail?: string;
  requestId?: string;
  sessionId?: string;
  submitter?: string;
  issues?: string[];
};

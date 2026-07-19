import {
  type ApiJsonMethod,
  type ProposeRequestPayload,
  type ReviseRequestPayload,
  isWriteMethod,
  riskForMethod,
  validateProposeRequest,
} from "@a2api/protocol";
import type { ApiJsonClient, ApiJsonHttpResult } from "./client.js";
import {
  newApprovalId,
  type ApprovalLedger,
  type ApprovalRecord,
} from "./approval-ledger.js";
import {
  isSensitiveOperation,
  parseSensitiveMethods,
} from "./sensitivity.js";

/**
 * - auto_read_approve_write: legacy — all writes await approval
 * - approve_all: everything awaits
 * - auto_all: never await
 * - auto_nonsensitive: only sensitive methods await admin; other writes auto-run + audit
 */
export type HitlPolicy =
  | "auto_read_approve_write"
  | "approve_all"
  | "auto_all"
  | "auto_nonsensitive";

export interface PendingRequest {
  requestId: string;
  method: ApiJsonMethod;
  body: Record<string, unknown>;
  url?: string;
  risk: "read" | "write";
  rationale?: string;
  status:
    | "validated"
    | "awaiting_approval"
    | "executing"
    | "done"
    | "failed"
    | "rejected";
  result?: ApiJsonHttpResult;
  issues?: string[];
  /** True when this write needs admin approval under auto_nonsensitive. */
  sensitive?: boolean;
  /** Linked approval ledger id (if any). */
  approvalId?: string;
}

export interface HitlControllerOptions {
  client: ApiJsonClient;
  policy?: HitlPolicy;
  ledger?: ApprovalLedger;
  /** Override sensitive method set (default env SENSITIVE_METHODS / delete). */
  sensitiveMethods?: ReadonlySet<ApiJsonMethod>;
  /** Optional session id stamped onto new approval rows. */
  sessionIdFor?: (requestId: string) => string | undefined;
}

export class HitlController {
  private readonly client: ApiJsonClient;
  private policy: HitlPolicy;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly ledger?: ApprovalLedger;
  private readonly sensitiveMethods: ReadonlySet<ApiJsonMethod>;
  private readonly sessionIdFor?: (requestId: string) => string | undefined;

  constructor(options: HitlControllerOptions) {
    this.client = options.client;
    this.policy = options.policy ?? "auto_nonsensitive";
    this.ledger = options.ledger;
    this.sensitiveMethods =
      options.sensitiveMethods ?? parseSensitiveMethods();
    this.sessionIdFor = options.sessionIdFor;
  }

  setPolicy(policy: HitlPolicy): void {
    this.policy = policy;
  }

  getPending(requestId: string): PendingRequest | undefined {
    return this.pending.get(requestId);
  }

  listAwaiting(): PendingRequest[] {
    return [...this.pending.values()].filter(
      (p) => p.status === "awaiting_approval",
    );
  }

  propose(payload: ProposeRequestPayload): PendingRequest {
    const validation = validateProposeRequest(payload);
    const risk = payload.risk ?? riskForMethod(payload.method);
    const sensitive = isSensitiveOperation(
      payload.method,
      this.sensitiveMethods,
    );
    const record: PendingRequest = {
      requestId: payload.requestId,
      method: payload.method,
      body: payload.body,
      url: payload.url,
      risk,
      rationale: payload.rationale,
      status: validation.ok ? "validated" : "failed",
      issues: validation.issues.map((i) => `${i.path}: ${i.message}`),
      sensitive,
    };
    this.pending.set(record.requestId, record);
    return record;
  }

  revise(payload: ReviseRequestPayload): PendingRequest {
    const existing = this.pending.get(payload.requestId);
    if (!existing) {
      throw new Error(`Unknown requestId: ${payload.requestId}`);
    }
    if (payload.method) existing.method = payload.method;
    if (payload.body) existing.body = payload.body;
    if (payload.url !== undefined) existing.url = payload.url;
    existing.risk = riskForMethod(existing.method);
    existing.sensitive = isSensitiveOperation(
      existing.method,
      this.sensitiveMethods,
    );
    const validation = validateProposeRequest({
      requestId: existing.requestId,
      method: existing.method,
      body: existing.body,
      url: existing.url,
      risk: existing.risk,
    });
    existing.status = validation.ok ? "validated" : "failed";
    existing.issues = validation.issues.map((i) => `${i.path}: ${i.message}`);
    existing.result = undefined;
    return existing;
  }

  needsApproval(record: PendingRequest): boolean {
    if (this.policy === "auto_all") return false;
    if (this.policy === "approve_all") return true;
    if (this.policy === "auto_nonsensitive") {
      return isWriteMethod(record.method) && Boolean(record.sensitive);
    }
    // auto_read_approve_write
    return isWriteMethod(record.method);
  }

  /**
   * Advance a proposed request: validate → maybe await approval → execute.
   * Auto-executed writes still write an auto_approved ledger row.
   */
  async advance(requestId: string): Promise<PendingRequest> {
    const record = this.pending.get(requestId);
    if (!record) throw new Error(`Unknown requestId: ${requestId}`);

    if (record.status === "failed" || record.status === "rejected") {
      return record;
    }

    if (record.status === "validated") {
      if (this.needsApproval(record)) {
        record.status = "awaiting_approval";
        await this.queueApproval(record);
        return record;
      }
      return this.execute(requestId, { auto: isWriteMethod(record.method) });
    }

    return record;
  }

  async decide(
    requestId: string,
    action: "approve" | "reject",
    decidedBy = "admin",
  ): Promise<PendingRequest> {
    const record = this.pending.get(requestId);
    if (!record) throw new Error(`Unknown requestId: ${requestId}`);
    if (record.status !== "awaiting_approval") {
      throw new Error(`Request ${requestId} is not awaiting approval`);
    }
    if (action === "reject") {
      record.status = "rejected";
      await this.finalizeApproval(record, "rejected", decidedBy);
      return record;
    }
    const executed = await this.execute(requestId, { auto: false });
    await this.finalizeApproval(
      executed,
      "approved",
      decidedBy,
    );
    return executed;
  }

  private async execute(
    requestId: string,
    opts: { auto: boolean },
  ): Promise<PendingRequest> {
    const record = this.pending.get(requestId);
    if (!record) throw new Error(`Unknown requestId: ${requestId}`);

    const validation = validateProposeRequest({
      requestId: record.requestId,
      method: record.method,
      body: record.body,
      url: record.url,
      risk: record.risk,
    });
    if (!validation.ok) {
      record.status = "failed";
      record.issues = validation.issues.map((i) => `${i.path}: ${i.message}`);
      return record;
    }

    record.status = "executing";
    const result = await this.client.execute(
      record.method,
      record.body,
      record.url,
    );
    record.result = result;
    record.status = result.ok ? "done" : "failed";
    if (!result.ok) {
      record.issues = [result.error ?? "APIJSON request failed"];
    }

    if (opts.auto && isWriteMethod(record.method)) {
      await this.recordAutoApproved(record);
    }
    return record;
  }

  private baseApproval(record: PendingRequest): ApprovalRecord {
    return {
      id: record.approvalId || newApprovalId(),
      requestId: record.requestId,
      sessionId: this.sessionIdFor?.(record.requestId),
      method: record.method,
      body: structuredClone(record.body),
      rationale: record.rationale,
      sensitive: Boolean(record.sensitive),
      decision: "pending",
      createdAt: new Date().toISOString(),
    };
  }

  private async queueApproval(record: PendingRequest): Promise<void> {
    if (!this.ledger) return;
    const row = this.baseApproval(record);
    record.approvalId = row.id;
    await this.ledger.append(row);
  }

  private async recordAutoApproved(record: PendingRequest): Promise<void> {
    if (!this.ledger) return;
    const row: ApprovalRecord = {
      ...this.baseApproval(record),
      decision: "auto_approved",
      decidedAt: new Date().toISOString(),
      decidedBy: "system",
      resultOk: record.result?.ok,
      resultStatus: record.result?.status,
      error: record.result?.ok
        ? undefined
        : record.result?.error ?? record.issues?.join("; "),
    };
    record.approvalId = row.id;
    await this.ledger.append(row);
  }

  private async finalizeApproval(
    record: PendingRequest,
    decision: "approved" | "rejected",
    decidedBy: string,
  ): Promise<void> {
    if (!this.ledger) return;
    const existing = await this.ledger.getByRequestId(record.requestId);
    const patch: Partial<ApprovalRecord> = {
      decision,
      decidedAt: new Date().toISOString(),
      decidedBy,
      resultOk: record.result?.ok,
      resultStatus: record.result?.status,
      error:
        decision === "rejected"
          ? "rejected by admin"
          : record.result?.ok
            ? undefined
            : record.result?.error ?? record.issues?.join("; "),
    };
    if (existing) {
      await this.ledger.update(existing.id, patch);
      record.approvalId = existing.id;
      return;
    }
    await this.ledger.append({
      ...this.baseApproval(record),
      ...patch,
      decision,
    } as ApprovalRecord);
  }
}

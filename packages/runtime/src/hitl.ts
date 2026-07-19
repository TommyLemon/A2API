import {
  type ApiJsonMethod,
  type ProposeRequestPayload,
  type ReviseRequestPayload,
  isOpenApiJsonRequest,
  isWriteMethod,
  riskForMethod,
  stripApiJsonRole,
  validateProposeRequest,
  validateRequestStructure,
} from "@a2api/protocol";
import type { ApiJsonClient, ApiJsonHttpResult } from "./client.js";
import {
  newApprovalId,
  type ApprovalLedger,
  type ApprovalRecord,
} from "./approval-ledger.js";
import {
  isPermissionGateIssue,
  isSensitiveOperation,
  parseSensitiveMethods,
  partitionPermissionIssues,
} from "./sensitivity.js";

/**
 * - auto_read_approve_write: legacy — all writes await approval
 * - approve_all: everything awaits
 * - auto_all: never await (except permissionGate — always admin)
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
  /** Request/Access permission gate — always queued for admin. */
  permissionGate?: boolean;
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

  private structureIssues(
    method: ApiJsonMethod,
    body: Record<string, unknown>,
  ): string[] {
    if (
      !this.client.requestStructures.isLoaded() ||
      isOpenApiJsonRequest(method, body)
    ) {
      return [];
    }
    const tag = typeof body.tag === "string" ? body.tag.trim() : "";
    const version =
      typeof body.version === "number" ? body.version : null;
    const row = tag
      ? this.client.requestStructures.lookup(method, tag, version)
      : null;
    const struct = validateRequestStructure(method, body, row);
    return struct.issues.map((i) => `${i.path}: ${i.message}`);
  }

  propose(payload: ProposeRequestPayload): PendingRequest {
    // Role is applied at execute time (Access min for GET/HEAD; omit for writes).
    payload.body = stripApiJsonRole(payload.body);
    const validation = validateProposeRequest(payload);
    const basicIssues = validation.issues.map(
      (i) => `${i.path}: ${i.message}`,
    );
    const structIssues = this.structureIssues(payload.method, payload.body);
    const { permission, other } = partitionPermissionIssues(structIssues);
    const hardIssues = [...basicIssues, ...other];
    const risk = payload.risk ?? riskForMethod(payload.method);
    const methodSensitive = isSensitiveOperation(
      payload.method,
      this.sensitiveMethods,
    );
    const permissionGate = permission.length > 0 && hardIssues.length === 0;
    const issues = [...hardIssues, ...permission];
    const record: PendingRequest = {
      requestId: payload.requestId,
      method: payload.method,
      body: payload.body,
      url: payload.url,
      risk,
      rationale: payload.rationale,
      status: hardIssues.length === 0 ? "validated" : "failed",
      issues: issues.length ? issues : undefined,
      sensitive: methodSensitive || permissionGate,
      permissionGate,
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
    if (payload.body) existing.body = stripApiJsonRole(payload.body);
    if (payload.url !== undefined) existing.url = payload.url;
    existing.risk = riskForMethod(existing.method);
    const validation = validateProposeRequest({
      requestId: existing.requestId,
      method: existing.method,
      body: existing.body,
      url: existing.url,
      risk: existing.risk,
    });
    const basicIssues = validation.issues.map(
      (i) => `${i.path}: ${i.message}`,
    );
    const structIssues = this.structureIssues(
      existing.method,
      existing.body,
    );
    const { permission, other } = partitionPermissionIssues(structIssues);
    const hardIssues = [...basicIssues, ...other];
    const permissionGate = permission.length > 0 && hardIssues.length === 0;
    existing.permissionGate = permissionGate;
    existing.sensitive =
      isSensitiveOperation(existing.method, this.sensitiveMethods) ||
      permissionGate;
    existing.issues = [...hardIssues, ...permission];
    existing.status = hardIssues.length === 0 ? "validated" : "failed";
    existing.result = undefined;
    return existing;
  }

  needsApproval(record: PendingRequest): boolean {
    // Permission / Request-table gates always need an admin
    if (record.permissionGate) return true;
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
      return this.execute(requestId, { auto: true });
    }

    return record;
  }

  async decide(
    requestId: string,
    action: "approve" | "reject",
    decidedBy = "admin",
  ): Promise<PendingRequest> {
    let record = this.pending.get(requestId);
    if (!record) {
      // Rehydrate from ledger after server restart
      record = await this.rehydrateFromLedger(requestId);
    }
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
    if (executed.status === "done") {
      await this.finalizeApproval(executed, "approved", decidedBy);
      return executed;
    }
    // Config still missing or APIJSON error — stay pending so admin can fix Access/Request and approve again.
    executed.status = "awaiting_approval";
    if (this.ledger && executed.approvalId) {
      await this.ledger.update(executed.approvalId, {
        error: executed.issues?.join("; ") ?? "still failing after approve",
      });
    }
    return executed;
  }

  /** Restore an awaiting request from the durable approval ledger. */
  private async rehydrateFromLedger(
    requestId: string,
  ): Promise<PendingRequest | undefined> {
    if (!this.ledger) return undefined;
    const row = await this.ledger.getByRequestId(requestId);
    if (!row || row.decision !== "pending") return undefined;
    const record: PendingRequest = {
      requestId: row.requestId,
      method: row.method,
      body: structuredClone(row.body),
      risk: riskForMethod(row.method),
      rationale: row.rationale,
      status: "awaiting_approval",
      sensitive: row.sensitive,
      permissionGate: row.sensitive,
      approvalId: row.id,
      issues: row.error ? [row.error] : undefined,
    };
    this.pending.set(requestId, record);
    return record;
  }

  private async execute(
    requestId: string,
    opts: { auto: boolean },
  ): Promise<PendingRequest> {
    const record = this.pending.get(requestId);
    if (!record) throw new Error(`Unknown requestId: ${requestId}`);

    // Admin approve: re-fetch Access/Request so newly configured rows apply.
    // Never skip structure checks — approval means config should already be ready.
    if (!opts.auto) {
      try {
        await Promise.all([
          this.client.requestStructures.reload(this.client),
          this.client.accessRoles.reload(this.client),
        ]);
      } catch {
        await this.client.requestStructures.ensureLoaded(this.client);
      }
    } else {
      await this.client.requestStructures.ensureLoaded(this.client);
    }

    const validation = validateProposeRequest({
      requestId: record.requestId,
      method: record.method,
      body: record.body,
      url: record.url,
      risk: record.risk,
    });
    const basicIssues = validation.issues.map(
      (i) => `${i.path}: ${i.message}`,
    );
    const structIssues = this.structureIssues(record.method, record.body);
    const { permission, other } = partitionPermissionIssues(structIssues);
    if (basicIssues.length || other.length) {
      record.status = "failed";
      record.issues = [...basicIssues, ...other, ...permission];
      return record;
    }
    if (permission.length) {
      record.permissionGate = true;
      record.sensitive = true;
      record.issues = permission;
      if (opts.auto) {
        record.status = "awaiting_approval";
        await this.queueApproval(record);
        return record;
      }
      // Admin approved but Access/Request still missing after reload
      record.status = "failed";
      return record;
    }

    record.permissionGate = false;
    record.status = "executing";
    const result = await this.client.execute(
      record.method,
      record.body,
      record.url,
    );
    record.result = result;
    if (!result.ok) {
      const err = result.error ?? "APIJSON request failed";
      record.issues = [err];
      if (opts.auto && isPermissionGateIssue(err)) {
        record.permissionGate = true;
        record.sensitive = true;
        record.status = "awaiting_approval";
        await this.queueApproval(record);
        return record;
      }
      record.status = "failed";
      return record;
    }

    record.status = "done";
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
      rationale:
        record.rationale ||
        (record.permissionGate
          ? `Permission gate: ${record.issues?.join("; ") ?? "needs admin"}`
          : undefined),
      sensitive: Boolean(record.sensitive || record.permissionGate),
      decision: "pending",
      createdAt: new Date().toISOString(),
      error: record.permissionGate
        ? record.issues?.join("; ")
        : undefined,
    };
  }

  private async queueApproval(record: PendingRequest): Promise<void> {
    if (!this.ledger) return;
    const existing = await this.ledger.getByRequestId(record.requestId);
    if (existing && existing.decision === "pending") {
      record.approvalId = existing.id;
      return;
    }
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

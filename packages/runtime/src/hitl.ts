import {
  type ApiJsonMethod,
  type ProposeRequestPayload,
  type ReviseRequestPayload,
  isWriteMethod,
  riskForMethod,
  validateProposeRequest,
} from "@a2api/protocol";
import type { ApiJsonClient, ApiJsonHttpResult } from "./client.js";

export type HitlPolicy = "auto_read_approve_write" | "approve_all" | "auto_all";

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
}

export interface HitlControllerOptions {
  client: ApiJsonClient;
  policy?: HitlPolicy;
}

export class HitlController {
  private readonly client: ApiJsonClient;
  private policy: HitlPolicy;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(options: HitlControllerOptions) {
    this.client = options.client;
    this.policy = options.policy ?? "auto_read_approve_write";
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
    const record: PendingRequest = {
      requestId: payload.requestId,
      method: payload.method,
      body: payload.body,
      url: payload.url,
      risk,
      rationale: payload.rationale,
      status: validation.ok ? "validated" : "failed",
      issues: validation.issues.map((i) => `${i.path}: ${i.message}`),
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
    return isWriteMethod(record.method);
  }

  /**
   * Advance a proposed request: validate → maybe await approval → execute.
   * Returns the current pending record after the step.
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
        return record;
      }
      return this.execute(requestId);
    }

    return record;
  }

  async decide(
    requestId: string,
    action: "approve" | "reject",
  ): Promise<PendingRequest> {
    const record = this.pending.get(requestId);
    if (!record) throw new Error(`Unknown requestId: ${requestId}`);
    if (record.status !== "awaiting_approval") {
      throw new Error(`Request ${requestId} is not awaiting approval`);
    }
    if (action === "reject") {
      record.status = "rejected";
      return record;
    }
    return this.execute(requestId);
  }

  private async execute(requestId: string): Promise<PendingRequest> {
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
    return record;
  }
}

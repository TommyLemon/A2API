import type { ApiJsonMethod } from "@a2api/protocol";

export type ApprovalDecision =
  | "pending"
  | "auto_approved"
  | "approved"
  | "rejected";

export type ApprovalRecord = {
  id: string;
  requestId: string;
  sessionId?: string;
  method: ApiJsonMethod;
  body: Record<string, unknown>;
  rationale?: string;
  sensitive: boolean;
  decision: ApprovalDecision;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  /** Snapshot after execute (when available) */
  resultOk?: boolean;
  resultStatus?: number;
  error?: string;
};

export type ApprovalEvent =
  | {
      type: "queued";
      record: ApprovalRecord;
    }
  | {
      type: "auto_approved";
      record: ApprovalRecord;
    }
  | {
      type: "decided";
      record: ApprovalRecord;
    };

export interface ApprovalLedger {
  append(record: ApprovalRecord): Promise<ApprovalRecord> | ApprovalRecord;
  update(
    id: string,
    patch: Partial<ApprovalRecord>,
  ): Promise<ApprovalRecord | null> | ApprovalRecord | null;
  list(filter?: {
    decision?: ApprovalDecision | ApprovalDecision[];
  }): Promise<ApprovalRecord[]> | ApprovalRecord[];
  getByRequestId(
    requestId: string,
  ): Promise<ApprovalRecord | null> | ApprovalRecord | null;
}

export function newApprovalId(): string {
  return `ap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** In-memory ledger (tests / fallback). */
export class MemoryApprovalLedger implements ApprovalLedger {
  private readonly rows: ApprovalRecord[] = [];

  append(record: ApprovalRecord): ApprovalRecord {
    this.rows.unshift(record);
    return record;
  }

  update(id: string, patch: Partial<ApprovalRecord>): ApprovalRecord | null {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i < 0) return null;
    this.rows[i] = { ...this.rows[i]!, ...patch };
    return this.rows[i]!;
  }

  list(filter?: {
    decision?: ApprovalDecision | ApprovalDecision[];
  }): ApprovalRecord[] {
    if (!filter?.decision) return [...this.rows];
    const want = new Set(
      Array.isArray(filter.decision) ? filter.decision : [filter.decision],
    );
    return this.rows.filter((r) => want.has(r.decision));
  }

  getByRequestId(requestId: string): ApprovalRecord | null {
    return this.rows.find((r) => r.requestId === requestId) ?? null;
  }
}

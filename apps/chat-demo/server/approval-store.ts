/** Persist approval audit trail (pending + auto_approved + decided). */

import fs from "node:fs";
import path from "node:path";
import {
  type ApprovalDecision,
  type ApprovalLedger,
  type ApprovalRecord,
} from "@a2api/runtime";

export class FileApprovalLedger implements ApprovalLedger {
  private rows: ApprovalRecord[] = [];
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (!fs.existsSync(this.filePath)) {
        this.rows = [];
        return;
      }
      const chrono = fs
        .readFileSync(this.filePath, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l) as ApprovalRecord);
      this.rows = chrono.reverse();
    } catch {
      this.rows = [];
    }
  }

  private persistAppend(record: ApprovalRecord): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
  }

  private rewriteAll(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const chrono = [...this.rows].reverse();
    fs.writeFileSync(
      this.filePath,
      chrono.map((r) => JSON.stringify(r)).join("\n") + (chrono.length ? "\n" : ""),
      "utf8",
    );
  }

  append(record: ApprovalRecord): ApprovalRecord {
    this.rows.unshift(record);
    this.persistAppend(record);
    return record;
  }

  update(id: string, patch: Partial<ApprovalRecord>): ApprovalRecord | null {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i < 0) return null;
    this.rows[i] = { ...this.rows[i]!, ...patch };
    this.rewriteAll();
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

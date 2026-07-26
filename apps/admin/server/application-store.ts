/** Application store interface + JSONL fallback. */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ApplicationStatus,
  ApplicationSubmitInput,
  ConfigApplication,
  HttpBodyType,
} from "./types.js";

export interface ApplicationStore {
  list(filter?: {
    status?: ApplicationStatus | ApplicationStatus[];
  }): Promise<ConfigApplication[]>;
  get(id: string): Promise<ConfigApplication | null>;
  getByRequestId(requestId: string): Promise<ConfigApplication | null>;
  submit(input: ApplicationSubmitInput): Promise<ConfigApplication>;
  update(
    id: string,
    patch: Partial<ConfigApplication>,
  ): Promise<ConfigApplication | null>;
}

export function parseJsonBody(
  json: Record<string, unknown> | string,
): Record<string, unknown> {
  if (typeof json === "string") {
    const parsed = JSON.parse(json) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("json must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  }
  return json;
}

export function normalizeOp(op: string): string {
  return op.trim().toLowerCase();
}

export function buildNewApplication(
  input: ApplicationSubmitInput,
): ConfigApplication {
  if (!input.table?.trim()) throw new Error("table required");
  if (!input.operation?.trim()) throw new Error("operation required");
  if (!input.method?.trim()) throw new Error("method required");
  if (!input.url?.trim()) throw new Error("url required");
  return {
    id: randomUUID(),
    status: "pending",
    createdAt: new Date().toISOString(),
    table: input.table.trim(),
    operation: normalizeOp(input.operation),
    role: (input.role || "OWNER").toUpperCase(),
    version: input.version && input.version > 0 ? input.version : 1,
    method: input.method.toUpperCase(),
    type: (input.type || "JSON") as HttpBodyType,
    url: input.url.trim(),
    json: parseJsonBody(input.json),
    tag: input.tag?.trim() || input.table.trim(),
    structure: input.structure,
    accessAlias: input.accessAlias?.trim(),
    accessName: input.accessName?.trim(),
    name: input.name?.trim(),
    detail: input.detail,
    requestId: input.requestId,
    sessionId: input.sessionId,
    submitter: input.submitter,
    issues: input.issues,
  };
}

/** Local JSONL fallback when APPLICATION_STORE=file. */
export class FileApplicationStore implements ApplicationStore {
  private rows: ConfigApplication[] = [];
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
        .map((l) => JSON.parse(l) as ConfigApplication);
      this.rows = chrono.reverse();
    } catch {
      this.rows = [];
    }
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

  private persistAppend(row: ConfigApplication): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(row)}\n`, "utf8");
  }

  async list(filter?: {
    status?: ApplicationStatus | ApplicationStatus[];
  }): Promise<ConfigApplication[]> {
    if (!filter?.status) return [...this.rows];
    const statuses = Array.isArray(filter.status)
      ? filter.status
      : [filter.status];
    const want = new Set(statuses);
    return this.rows.filter((r) => want.has(r.status));
  }

  async get(id: string): Promise<ConfigApplication | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async getByRequestId(requestId: string): Promise<ConfigApplication | null> {
    return this.rows.find((r) => r.requestId === requestId) ?? null;
  }

  async submit(input: ApplicationSubmitInput): Promise<ConfigApplication> {
    if (input.requestId) {
      const existing = await this.getByRequestId(input.requestId);
      if (existing && existing.status === "pending") {
        return (await this.update(existing.id, {
          table: input.table.trim(),
          operation: normalizeOp(input.operation),
          role: (input.role || "OWNER").toUpperCase(),
          version: input.version && input.version > 0 ? input.version : 1,
          method: input.method.toUpperCase(),
          type: (input.type || "JSON") as HttpBodyType,
          url: input.url.trim(),
          json: parseJsonBody(input.json),
          tag: input.tag?.trim() || input.table.trim(),
          structure: input.structure,
          accessAlias: input.accessAlias?.trim(),
          accessName: input.accessName?.trim(),
          name: input.name?.trim(),
          detail: input.detail,
          sessionId: input.sessionId,
          submitter: input.submitter,
          issues: input.issues,
          updatedAt: new Date().toISOString(),
        }))!;
      }
    }

    const row = buildNewApplication(input);
    this.rows.unshift(row);
    this.persistAppend(row);
    return row;
  }

  async update(
    id: string,
    patch: Partial<ConfigApplication>,
  ): Promise<ConfigApplication | null> {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i < 0) return null;
    const { id: _id, createdAt: _c, ...rest } = patch;
    this.rows[i] = {
      ...this.rows[i]!,
      ...rest,
      updatedAt: new Date().toISOString(),
    };
    this.rewriteAll();
    return this.rows[i]!;
  }
}

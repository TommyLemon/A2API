/** Application store interface + JSONL fallback. */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  compareByOrder,
  normalizeOrder,
  paginateInMemory,
} from "./list-query.js";
import type {
  ApplicationStatus,
  ApplicationSubmitInput,
  ConfigApplication,
  HttpBodyType,
} from "./types.js";

export const APPLY_ORDER_FIELDS = [
  "id",
  "date",
  "updatedAt",
  "status",
  "bizTable",
  "operation",
] as const;

export type ApplicationListQuery = {
  status?: ApplicationStatus | ApplicationStatus[];
  operation?: string;
  /** Exact / prefix match on business table alias */
  table?: string;
  /** Free-text: table, tag, url, submitter, name */
  q?: string;
  page?: number;
  pageSize?: number;
  /** APIJSON-style order, e.g. `id-`, `date+` */
  order?: string;
};

export type ApplicationListResult = {
  items: ConfigApplication[];
  total: number;
  page: number;
  pageSize: number;
  order: string;
};

export interface ApplicationStore {
  list(query?: ApplicationListQuery): Promise<ApplicationListResult>;
  get(id: string): Promise<ConfigApplication | null>;
  getByRequestId(requestId: string): Promise<ConfigApplication | null>;
  submit(input: ApplicationSubmitInput): Promise<ConfigApplication>;
  update(
    id: string,
    patch: Partial<ConfigApplication>,
  ): Promise<ConfigApplication | null>;
}

function applyMatches(row: ConfigApplication, query?: ApplicationListQuery): boolean {
  if (!query) return true;
  if (query.status) {
    const statuses = Array.isArray(query.status) ? query.status : [query.status];
    if (statuses.length && !statuses.includes(row.status)) return false;
  }
  if (query.operation) {
    if (row.operation.toLowerCase() !== query.operation.toLowerCase()) return false;
  }
  if (query.table?.trim()) {
    const t = query.table.trim().toLowerCase();
    if (!row.table.toLowerCase().includes(t)) return false;
  }
  if (query.q?.trim()) {
    const q = query.q.trim().toLowerCase();
    const hay = [
      row.table,
      row.tag,
      row.url,
      row.submitter,
      row.name,
      row.operation,
      row.role,
      row.detail,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function applyField(row: ConfigApplication, field: string): unknown {
  switch (field) {
    case "id":
      return row.id;
    case "date":
      return row.createdAt;
    case "updatedAt":
      return row.updatedAt || row.createdAt;
    case "status":
      return row.status;
    case "bizTable":
      return row.table;
    case "operation":
      return row.operation;
    default:
      return row.id;
  }
}

export function normalizeApplyListQuery(
  query?: ApplicationListQuery,
): Required<Pick<ApplicationListQuery, "page" | "pageSize" | "order">> &
  ApplicationListQuery {
  const page = Math.max(0, Math.floor(Number(query?.page) || 0));
  const pageSize = Math.min(Math.max(Math.floor(Number(query?.pageSize) || 20), 1), 100);
  const order = normalizeOrder(query?.order, APPLY_ORDER_FIELDS, "id-");
  return { ...query, page, pageSize, order };
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

  async list(query?: ApplicationListQuery): Promise<ApplicationListResult> {
    const q = normalizeApplyListQuery(query);
    const filtered = this.rows.filter((r) => applyMatches(r, q));
    filtered.sort((a, b) => compareByOrder(a, b, q.order, applyField));
    const page = paginateInMemory(filtered, q.page, q.pageSize);
    return { ...page, order: q.order };
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

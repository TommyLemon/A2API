import {
  type BindRequestPayload,
  getByPointer,
  setByPointer,
  validateBindRequest,
  validateApiJsonBody,
  stripApiJsonRole,
} from "@a2api/protocol";
import type { ApiJsonClient, ApiJsonHttpResult } from "./client.js";

export interface BoundExecutorOptions {
  client: ApiJsonClient;
}

export interface BoundExecuteOptions {
  /** Host / A2UI data model used as paramMap source */
  dataModel: unknown;
  /** Optional override of trigger action name for logging */
  action?: string;
}

export class BoundExecutor {
  private readonly client: ApiJsonClient;
  private readonly bindings = new Map<string, BindRequestPayload>();

  constructor(options: BoundExecutorOptions) {
    this.client = options.client;
  }

  register(bind: BindRequestPayload): void {
    const v = validateBindRequest(bind);
    if (!v.ok) {
      throw new Error(
        `Invalid bindRequest: ${v.issues.map((i) => i.message).join("; ")}`,
      );
    }
    this.bindings.set(bind.bindingId, bind);
  }

  get(bindingId: string): BindRequestPayload | undefined {
    return this.bindings.get(bindingId);
  }

  list(): BindRequestPayload[] {
    return [...this.bindings.values()];
  }

  handlesAction(bindingId: string, actionName: string): boolean {
    const bind = this.bindings.get(bindingId);
    if (!bind?.triggerActions?.length) return false;
    return bind.triggerActions.includes(actionName);
  }

  mergeBody(
    bind: BindRequestPayload,
    dataModel: unknown,
  ): Record<string, unknown> {
    let body: unknown = structuredClone(bind.bodyTemplate);
    for (const entry of bind.paramMap) {
      const value = getByPointer(dataModel, entry.from);
      if (value === undefined) continue;
      // Skip empty keyword filters so APIJSON does not get content$: ""
      if (value === "" || value === null) continue;
      body = setByPointer(body, entry.to, value);
    }
    // `@role` applied in ApiJsonClient.execute from Access (GET/HEAD).
    return stripApiJsonRole(body as Record<string, unknown>);
  }

  async execute(
    bindingId: string,
    options: BoundExecuteOptions,
  ): Promise<{
    bind: BindRequestPayload;
    body: Record<string, unknown>;
    result: ApiJsonHttpResult;
  }> {
    const bind = this.bindings.get(bindingId);
    if (!bind) throw new Error(`Unknown bindingId: ${bindingId}`);

    const body = this.mergeBody(bind, options.dataModel);
    const validation = validateApiJsonBody(bind.method, body);
    if (!validation.ok) {
      return {
        bind,
        body,
        result: {
          ok: false,
          status: 0,
          body: null,
          error: validation.issues.map((i) => i.message).join("; "),
        },
      };
    }

    const result = await this.client.execute(bind.method, body, bind.url);
    return { bind, body, result };
  }
}

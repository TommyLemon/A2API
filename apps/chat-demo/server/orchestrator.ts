import {
  A2API_VERSION,
  type BindRequestPayload,
  validateProposeRequest,
} from "@a2api/protocol";
import {
  ApiJsonClient,
  BoundExecutor,
  HitlController,
  type PendingRequest,
} from "@a2api/runtime";
import { bootstrapFromMessage, repairBody } from "./llm.js";
import type { LlmConfig } from "./llm-config.js";
import { FileApprovalLedger } from "./approval-store.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  toBindEnvelope,
  toProposeEnvelope,
  type BootstrapPlan,
} from "./intent.js";
import { commentsForPayload, type SchemaComments } from "./schema-comments.js";
import {
  applyTableQuery,
  type ColumnFilter,
  type ColumnSort,
} from "./table-query.js";

export interface SessionState {
  id: string;
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  plan?: BootstrapPlan;
  pending?: PendingRequest;
  bind?: BindRequestPayload;
  lastResult?: unknown;
  a2uiMessages: unknown[];
  dataModel: {
    ui: {
      page: number;
      count: number;
      order: string;
      keyword: string;
    };
    rows: unknown;
    write?: Record<string, unknown>;
    schemaComments?: SchemaComments;
  };
}

function buildA2uiMessages(plan: BootstrapPlan): unknown[] {
  const surfaceId = plan.a2uiHint.surfaceId;
  return [
    {
      version: "v0.9",
      createSurface: {
        surfaceId,
        catalogId: "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
      },
    },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId,
        components: [
          { id: "root", component: "Column", children: ["title", "filters", "results"] },
          {
            id: "title",
            component: "Text",
            text: plan.title,
            variant: "h2",
          },
          {
            id: "filters",
            component: "Text",
            text: "Filters bound to APIJSON via A2API bindRequest (no LLM on change)",
            variant: "caption",
          },
          {
            id: "results",
            component: "Text",
            text: { path: "/rowsSummary" },
          },
        ],
      },
    },
  ];
}

export class Orchestrator {
  readonly client: ApiJsonClient;
  readonly hitl: HitlController;
  readonly bound: BoundExecutor;
  readonly approvals: FileApprovalLedger;
  private readonly sessions = new Map<string, SessionState>();
  /** requestId → sessionId for approval audit */
  private readonly requestSessions = new Map<string, string>();

  constructor(baseUrl = process.env.APIJSON_BASE_URL ?? "http://localhost:8080") {
    this.client = new ApiJsonClient({ baseUrl });
    const dataDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "data",
    );
    this.approvals = new FileApprovalLedger(
      path.join(dataDir, "approvals.jsonl"),
    );
    this.hitl = new HitlController({
      client: this.client,
      policy: "auto_nonsensitive",
      ledger: this.approvals,
      sessionIdFor: (requestId) => this.requestSessions.get(requestId),
    });
    this.bound = new BoundExecutor({ client: this.client });
  }

  getOrCreateSession(sessionId?: string): SessionState {
    const id = sessionId || `s_${Date.now().toString(36)}`;
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id,
        messages: [],
        a2uiMessages: [],
        dataModel: {
          ui: { page: 0, count: 20, order: "date-", keyword: "" },
          rows: null,
        },
      };
      this.sessions.set(id, s);
    }
    return s;
  }

  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  async chat(
    sessionId: string | undefined,
    message: string,
    llm?: LlmConfig | null,
  ) {
    const session = this.getOrCreateSession(sessionId);
    session.messages.push({ role: "user", content: message });

    const { plan, source } = await bootstrapFromMessage(message, llm);
    session.plan = plan;
    session.a2uiMessages = buildA2uiMessages(plan);

    // Seed write form / list defaults into data model
    if (plan.bind) {
      const count = Number(
        (plan.bind.bodyTemplate["[]"] as { count?: number } | undefined)?.count ??
          3,
      );
      session.dataModel.ui.count = count;
      const order =
        (
          (plan.bind.bodyTemplate["[]"] as Record<string, unknown> | undefined)?.[
            Object.keys(
              (plan.bind.bodyTemplate["[]"] as Record<string, unknown>) || {},
            ).find((k) => k !== "count" && k !== "page") || ""
          ] as { "@order"?: string } | undefined
        )?.["@order"] || "date-";
      session.dataModel.ui.order = order;
    }
    if (plan.writeForm) {
      session.dataModel.write = structuredClone(plan.propose.body);
    }

    let pending = this.hitl.propose(plan.propose);
    this.requestSessions.set(plan.propose.requestId, session.id);
    const envelopes: unknown[] = [toProposeEnvelope(plan.propose)];

    if (pending.status === "failed") {
      const repaired = await repairBody(
        plan.propose.method,
        plan.propose.body,
        pending.issues?.join("; ") ?? "validation failed",
        llm,
      );
      if (repaired) {
        pending = this.hitl.revise({
          requestId: plan.propose.requestId,
          body: repaired,
        });
        plan.propose.body = repaired;
        envelopes.push({
          version: A2API_VERSION,
          reviseRequest: {
            requestId: plan.propose.requestId,
            body: repaired,
          },
        });
      }
    }

    pending = await this.hitl.advance(plan.propose.requestId);
    session.pending = pending;

    const schemaComments = await commentsForPayload(
      this.client,
      plan.propose.body,
      pending.result?.body,
    );
    session.dataModel.schemaComments = schemaComments;

    const response: Record<string, unknown> = {
      sessionId: session.id,
      source,
      title: plan.title,
      kind: plan.kind,
      a2uiMessages: session.a2uiMessages,
      a2apiEnvelopes: envelopes,
      pending,
      schemaComments,
      plan: {
        filters: plan.a2uiHint.filters,
        writeForm: plan.writeForm,
        surfaceId: plan.a2uiHint.surfaceId,
        viewMode: plan.viewMode,
        title: plan.title,
      },
      dataModel: session.dataModel,
    };

    if (pending.status === "awaiting_approval") {
      const sensitive = pending.sensitive !== false;
      session.messages.push({
        role: "assistant",
        content: sensitive
          ? `Sensitive ${plan.propose.method.toUpperCase()} queued for admin approval (${pending.approvalId || pending.requestId}).`
          : `Write awaiting approval (${plan.propose.method.toUpperCase()}).`,
      });
      response.assistantMessage = sensitive
        ? `Sensitive operation queued for vendor admin approval. Source: ${source}`
        : `Write pending approval. Source: ${source}`;
      return response;
    }

    if (pending.status === "done" && pending.result?.ok) {
      session.lastResult = pending.result.body;
      session.dataModel.rows = pending.result.body;
      envelopes.push({
        version: A2API_VERSION,
        requestResult: {
          requestId: pending.requestId,
          ok: true,
          status: pending.result.status,
          body: pending.result.body,
        },
      });

      if (plan.bind) {
        // Only bind after successful HTTP
        const bind = {
          ...plan.bind,
          bodyTemplate: structuredClone(plan.propose.body),
        };
        this.bound.register(bind);
        session.bind = bind;
        envelopes.push(toBindEnvelope(bind));
        session.messages.push({
          role: "assistant",
          content: `Connected ${plan.title}. Filter/sort/pagination changes will call APIJSON directly without AI.`,
        });
        response.assistantMessage =
          `Connected "${plan.title}" and bound UI. Condition changes call APIJSON directly (source: ${source}).`;
        response.bind = bind;
      } else {
        const auto =
          pending.approvalId && !pending.sensitive
            ? ` Auto-approved (audit ${pending.approvalId}).`
            : pending.approvalId
              ? ` Approval record ${pending.approvalId}.`
              : "";
        session.messages.push({
          role: "assistant",
          content: `Write/single-record operation completed.${auto}`,
        });
        response.assistantMessage = `Operation succeeded (source: ${source}).${auto}`;
      }
      response.lastResult = pending.result.body;
      return response;
    }

    // Failed after execute — one repair retry
    if (pending.status === "failed" && pending.result) {
      const repaired = await repairBody(
        pending.method,
        pending.body,
        pending.result.error ?? "failed",
      );
      if (repaired) {
        pending = this.hitl.revise({
          requestId: pending.requestId,
          body: repaired,
        });
        pending = await this.hitl.advance(pending.requestId);
        session.pending = pending;
        if (pending.status === "done" && pending.result?.ok && plan.bind) {
          const bind = {
            ...plan.bind,
            bodyTemplate: structuredClone(repaired),
          };
          this.bound.register(bind);
          session.bind = bind;
          session.dataModel.rows = pending.result.body;
          response.bind = bind;
          response.assistantMessage = `Auto-repaired after first failure and connected "${plan.title}".`;
          response.lastResult = pending.result.body;
          response.pending = pending;
          return response;
        }
      }
    }

    response.assistantMessage = `Could not connect APIJSON: ${pending.issues?.join("; ") || pending.result?.error || "unknown"}. Edit the request manually and retry.`;
    session.messages.push({
      role: "assistant",
      content: String(response.assistantMessage),
    });
    return response;
  }

  async decide(
    sessionId: string,
    requestId: string,
    action: "approve" | "reject",
    revisedBody?: Record<string, unknown>,
  ) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("session not found");
    if (revisedBody) {
      this.hitl.revise({ requestId, body: revisedBody });
      // re-enter awaiting if write
      const p = this.hitl.getPending(requestId);
      if (p && p.status === "validated") {
        await this.hitl.advance(requestId);
      }
    }
    const pending = await this.hitl.decide(requestId, action, "operator");
    session.pending = pending;
    if (pending.status === "done" && pending.result?.ok) {
      session.lastResult = pending.result.body;
      session.dataModel.rows = pending.result.body;
    }
    const schemaComments = await commentsForPayload(
      this.client,
      pending.body,
      pending.result?.body,
    );
    session.dataModel.schemaComments = schemaComments;
    return {
      pending,
      dataModel: session.dataModel,
      lastResult: session.lastResult,
      schemaComments,
    };
  }

  /** Propose a write (e.g. detail form save) through HITL without going via chat NL. */
  async proposeWrite(
    sessionId: string | undefined,
    payload: {
      method: "put" | "post" | "delete";
      body: Record<string, unknown>;
      rationale?: string;
    },
  ) {
    const session = this.getOrCreateSession(sessionId);
    const requestId = `w_${Date.now().toString(36)}`;
    this.requestSessions.set(requestId, session.id);
    let pending = this.hitl.propose({
      requestId,
      method: payload.method,
      body: payload.body,
      risk: "write",
      rationale: payload.rationale ?? "Detail form save",
    });
    if (pending.status !== "failed") {
      pending = await this.hitl.advance(requestId);
    }
    session.pending = pending;
    return {
      sessionId: session.id,
      pending,
      requestBody: payload.body,
    };
  }

  async adminDecide(
    requestId: string,
    action: "approve" | "reject",
    decidedBy = "admin",
    revisedBody?: Record<string, unknown>,
  ) {
    if (revisedBody) {
      this.hitl.revise({ requestId, body: revisedBody });
      const p = this.hitl.getPending(requestId);
      if (p && p.status === "validated") {
        await this.hitl.advance(requestId);
      }
    }
    const pending = await this.hitl.decide(requestId, action, decidedBy);
    const sessionId = this.requestSessions.get(requestId);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (session) {
      session.pending = pending;
      if (pending.status === "done" && pending.result?.ok) {
        session.lastResult = pending.result.body;
        session.dataModel.rows = pending.result.body;
      }
    }
    return {
      pending,
      approval: await this.approvals.getByRequestId(requestId),
      sessionId,
    };
  }

  async boundAction(
    sessionId: string,
    action: string,
    uiPatch?: Partial<SessionState["dataModel"]["ui"]>,
    query?: {
      sorts?: ColumnSort[];
      filters?: ColumnFilter[];
      combineExpr?: string;
    },
  ) {
    const session = this.getSession(sessionId);
    if (!session?.bind) throw new Error("no active binding; bootstrap via chat first");

    if (uiPatch) {
      session.dataModel.ui = { ...session.dataModel.ui, ...uiPatch };
    }

    if (!this.bound.handlesAction(session.bind.bindingId, action)) {
      if (
        !["search", "page_change", "sort_change", "filter_change", "refresh"].includes(
          action,
        )
      ) {
        throw new Error(`action not bound: ${action}`);
      }
    }

    const bind = session.bind;
    const merged = this.bound.mergeBody(bind, session.dataModel);
    const body = applyTableQuery(
      merged,
      bind.bodyTemplate,
      query?.sorts ?? [],
      query?.filters ?? [],
      query?.combineExpr,
    );
    const result = await this.client.execute(bind.method, body, bind.url);

    if (result.ok) {
      session.lastResult = result.body;
      session.dataModel.rows = result.body;
    }

    const schemaComments = await commentsForPayload(
      this.client,
      body,
      result.body,
      bind.bodyTemplate,
    );
    session.dataModel.schemaComments = schemaComments;

    return {
      action,
      usedLlm: false,
      requestBody: body,
      url: bind.url,
      result,
      schemaComments,
      dataModel: session.dataModel,
      sorts: query?.sorts ?? [],
      filters: query?.filters ?? [],
    };
  }

  async retryPropose(sessionId: string, body: Record<string, unknown>) {
    const session = this.getSession(sessionId);
    if (!session?.plan) throw new Error("no plan");
    const requestId = session.plan.propose.requestId;
    let pending = this.hitl.revise({ requestId, body });
    pending = await this.hitl.advance(requestId);
    session.pending = pending;
    session.plan.propose.body = body;

    if (pending.status === "done" && pending.result?.ok && session.plan.bind) {
      const bind = {
        ...session.plan.bind,
        bodyTemplate: structuredClone(body),
      };
      // keep read validation happy
      const v = validateProposeRequest({
        requestId,
        method: bind.method,
        body,
      });
      if (v.ok) {
        this.bound.register(bind);
        session.bind = bind;
      }
      session.dataModel.rows = pending.result.body;
    }
    return { pending, bind: session.bind, dataModel: session.dataModel };
  }
}

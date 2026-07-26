import {
  A2API_VERSION,
  extractRequestTables,
  type BindRequestPayload,
  validateProposeRequest,
} from "@a2api/protocol";
import {
  ApiJsonClient,
  BoundExecutor,
  HitlController,
  isPermissionGateIssue,
  partitionPermissionIssues,
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
import { applyOwnerUserId, stripTemplateIdentity } from "./owner-body.js";
import { submitConfigApplication } from "./submit-config-application.js";
import { logApiCall } from "./call-logger.js";
import {
  getApijsonSessionByLogin,
  loginApijsonSession,
  touchApijsonCookie,
  upsertApijsonSession,
} from "./apijson-session-store.js";

export type ApijsonAuth = {
  login: string;
  password: string;
  userId?: string | number;
};

export interface SessionState {
  id: string;
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  plan?: BootstrapPlan;
  pending?: PendingRequest;
  bind?: BindRequestPayload;
  lastResult?: unknown;
  a2uiMessages: unknown[];
  /** APIJSON HttpSession cookie (JSESSIONID) after server-side login */
  apijsonCookie?: string;
  apijsonAuth?: ApijsonAuth;
  /** Logged-in APIJSON visitor id (for OWNER writes) */
  visitorUserId?: string | number;
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

function pickVisitorId(loginBody: unknown): string | number | null {
  if (!loginBody || typeof loginBody !== "object") return null;
  const data = loginBody as Record<string, unknown>;
  const user = (data.User || data.user) as
    | { id?: string | number }
    | undefined;
  if (user?.id != null && user.id !== "") return user.id;
  const top = data.userId ?? data.userid ?? data.id ?? data.visitorId;
  if (top != null && top !== "") return top as string | number;
  return null;
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
  private logExecute(opts: {
    session?: SessionState;
    source: string;
    operation: string;
    url?: string;
    body: Record<string, unknown>;
    result: { ok: boolean; status: number; body: unknown; error?: string };
    requestId?: string;
    usedLlm?: boolean;
    detail?: string;
    startedAt: number;
  }): void {
    const code =
      opts.result.body &&
      typeof opts.result.body === "object" &&
      !Array.isArray(opts.result.body) &&
      "code" in opts.result.body
        ? Number((opts.result.body as { code: unknown }).code)
        : opts.result.status;
    const tag =
      typeof opts.body.tag === "string" ? opts.body.tag : undefined;
    logApiCall(this.client, {
      userId: opts.session?.visitorUserId,
      submitter: opts.session?.apijsonAuth?.login,
      sessionId: opts.session?.id,
      requestId: opts.requestId,
      source: opts.source,
      operation: opts.operation,
      method: "POST",
      type: "JSON",
      url: opts.url || this.client.urlFor(opts.operation as never),
      tag,
      request: opts.body,
      response: opts.result.body,
      ok: opts.result.ok,
      code: Number.isFinite(code) ? code : opts.result.status,
      durationMs: Math.max(0, Date.now() - opts.startedAt),
      usedLlm: Boolean(opts.usedLlm),
      error: opts.result.error,
      detail: opts.detail,
    });
  }

  private logPendingCall(
    session: SessionState,
    pending: PendingRequest,
    source: string,
    usedLlm: boolean,
    startedAt: number,
  ): void {
    if (!pending.result) return;
    this.logExecute({
      session,
      source,
      operation: pending.method,
      url: pending.url,
      body: pending.body,
      result: pending.result,
      requestId: pending.requestId,
      usedLlm,
      detail: pending.status,
      startedAt,
    });
  }

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

  private bindClientCookie(session: SessionState): void {
    this.client.cookie = session.apijsonCookie || "";
  }

  private saveClientCookie(session: SessionState): void {
    if (!this.client.cookie) return;
    session.apijsonCookie = this.client.cookie;
    const auth = session.apijsonAuth;
    if (!auth?.login) return;
    touchApijsonCookie(auth.login, this.client.cookie);
    if (!getApijsonSessionByLogin(auth.login)) {
      upsertApijsonSession({
        login: auth.login,
        password: auth.password,
        cookie: this.client.cookie,
        userId: auth.userId,
      });
    }
  }

  /**
   * OWNER-scoped APIJSON calls need a logged-in HttpSession.
   * Jar is shared with the /apijson BFF so chat + UI use the same JSESSIONID.
   */
  async ensureApijsonLogin(
    session: SessionState,
    auth?: ApijsonAuth | null,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (auth?.login && auth.password) {
      const same =
        session.apijsonAuth?.login === auth.login &&
        session.apijsonAuth?.password === auth.password;
      if (!same) {
        session.apijsonAuth = {
          login: auth.login,
          password: auth.password,
          userId: auth.userId,
        };
        session.apijsonCookie = undefined;
      } else if (auth.userId != null && session.apijsonAuth) {
        session.apijsonAuth.userId = auth.userId;
        session.visitorUserId = auth.userId;
      }
    }
    if (auth?.userId != null) session.visitorUserId = auth.userId;

    const creds = session.apijsonAuth;
    if (!creds?.login || !creds.password) {
      return {
        ok: false,
        error:
          "Please Login (top-right) first. OWNER role requires an APIJSON session.",
      };
    }

    const shared = getApijsonSessionByLogin(creds.login);
    if (
      shared?.cookie &&
      shared.password === creds.password &&
      (session.apijsonCookie === shared.cookie || !session.apijsonCookie)
    ) {
      session.apijsonCookie = shared.cookie;
      this.bindClientCookie(session);
      await this.ensureMetaCaches();
      return { ok: true };
    }

    if (session.apijsonCookie) {
      this.bindClientCookie(session);
      upsertApijsonSession({
        login: creds.login,
        password: creds.password,
        cookie: session.apijsonCookie,
        userId: creds.userId,
      });
      await this.ensureMetaCaches();
      return { ok: true };
    }

    const result = await loginApijsonSession(
      this.client.baseUrl,
      creds.login,
      creds.password,
      shared?.id,
    );
    if (!result.ok) {
      return {
        ok: false,
        error: result.error || "APIJSON login failed",
      };
    }
    const fromLogin = pickVisitorId(result.body);
    if (fromLogin != null) session.visitorUserId = fromLogin;
    else if (creds.userId != null) session.visitorUserId = creds.userId;
    session.apijsonCookie = result.session.cookie;
    this.client.cookie = result.session.cookie;
    touchApijsonCookie(creds.login, result.session.cookie);
    await this.ensureMetaCaches();
    return { ok: true };
  }

  /** Prefetch Access + Request tables for role / structure checks. */
  private async ensureMetaCaches(): Promise<void> {
    try {
      await Promise.all([
        this.client.accessRoles.ensureLoaded(this.client),
        this.client.requestStructures.ensureLoaded(this.client),
      ]);
    } catch {
      /* best-effort — validation degrades until cache loads */
    }
  }

  /** Strip userId (and POST id); never re-inject userId — session OWNER fills it. */
  private ownerBody(
    session: SessionState,
    body: Record<string, unknown>,
    method?: string,
  ): Record<string, unknown> {
    const stripped = stripTemplateIdentity(body, {
      stripIds: method === "post",
    });
    // Always omit userId on every method's table objects for write safety
    const next = applyOwnerUserId(stripped, session.visitorUserId);
    // Single-record User detail with empty id → current visitor
    if (
      method === "get" &&
      session.visitorUserId != null &&
      session.visitorUserId !== "" &&
      !("[]" in next)
    ) {
      const user = next.User;
      if (
        user != null &&
        typeof user === "object" &&
        !Array.isArray(user) &&
        (user as Record<string, unknown>).id == null
      ) {
        const id = session.visitorUserId;
        (user as Record<string, unknown>).id =
          typeof id === "number"
            ? id
            : /^-?\d+$/.test(String(id).trim())
              ? Number(id)
              : id;
      }
    }
    return next;
  }

  async chat(
    sessionId: string | undefined,
    message: string,
    llm?: LlmConfig | null,
    auth?: ApijsonAuth | null,
  ) {
    const session = this.getOrCreateSession(sessionId);
    session.messages.push({ role: "user", content: message });

    const login = await this.ensureApijsonLogin(session, auth);
    if (!login.ok) {
      session.messages.push({ role: "assistant", content: login.error });
      return {
        sessionId: session.id,
        assistantMessage: login.error,
        pending: { status: "failed", issues: [login.error] },
        dataModel: session.dataModel,
      };
    }
    this.bindClientCookie(session);
    try {
      return await this.chatWithSession(session, message, llm);
    } finally {
      this.saveClientCookie(session);
    }
  }

  private async chatWithSession(
    session: SessionState,
    message: string,
    llm?: LlmConfig | null,
  ) {
    const { plan, source } = await bootstrapFromMessage(message, llm);
    if (
      plan.propose.method === "post" ||
      plan.propose.method === "put" ||
      plan.propose.method === "get" ||
      plan.propose.method === "gets"
    ) {
      plan.propose.body = this.ownerBody(
        session,
        plan.propose.body,
        plan.propose.method,
      );
    }
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
    /** Non-permission APIJSON errors: AI self-fix up to 2 times. */
    let repairAttempts = 0;
    const MAX_AI_REPAIRS = 2;

    const errorText = (p: PendingRequest) =>
      p.issues?.join("; ") ||
      p.result?.error ||
      "APIJSON request failed";

    const canAiRepair = (p: PendingRequest): boolean => {
      if (p.status !== "failed") return false;
      if (p.permissionGate) return false;
      const issues = p.issues?.length
        ? p.issues
        : p.result?.error
          ? [p.result.error]
          : [];
      if (!issues.length) return false;
      const { permission, other } = partitionPermissionIssues(issues);
      if (other.length) return true;
      // Pure permission → admin queue, not AI rewrite
      return permission.length === 0 && !issues.some(isPermissionGateIssue);
    };

    const tryAiRepair = async (p: PendingRequest): Promise<boolean> => {
      if (repairAttempts >= MAX_AI_REPAIRS || !canAiRepair(p)) return false;
      const repaired = await repairBody(
        p.method,
        p.body,
        errorText(p),
        llm,
      );
      if (!repaired) return false;
      repairAttempts += 1;
      const fixed = this.ownerBody(session, repaired, p.method);
      pending = this.hitl.revise({
        requestId: p.requestId,
        body: fixed,
      });
      plan.propose.body = fixed;
      envelopes.push({
        version: A2API_VERSION,
        reviseRequest: {
          requestId: p.requestId,
          body: fixed,
          repairAttempt: repairAttempts,
        },
      });
      return true;
    };

    while (pending.status === "failed" && (await tryAiRepair(pending))) {
      /* revise until validated or repairs exhausted */
    }

    const isEditDelete =
      plan.propose.method === "put" || plan.propose.method === "delete";

    // Edit/delete: Document + Access gate before execute (no Data API jump).
    if (isEditDelete && pending.status === "validated") {
      const tag =
        typeof plan.propose.body.tag === "string" &&
        plan.propose.body.tag.trim()
          ? plan.propose.body.tag.trim()
          : extractRequestTables(plan.propose.body)[0] || "";
      if (tag) {
        try {
          const adminBase =
            process.env.ADMIN_BASE_URL?.replace(/\/+$/, "") ||
            `http://127.0.0.1:${process.env.ADMIN_PORT || 3001}`;
          const qs = new URLSearchParams({
            operation: plan.propose.method,
            tag,
          });
          const gateRes = await fetch(`${adminBase}/api/write-gate?${qs}`);
          const gate = (await gateRes.json().catch(() => null)) as {
            decision?: string;
            reason?: string;
          } | null;
          if (gateRes.ok && gate?.decision === "apply") {
            pending = await this.hitl.awaitPermissionConfig(
              plan.propose.requestId,
              [
                gate.reason ||
                  "Document found but Access missing — submit Apply",
              ],
            );
          }
        } catch {
          /* no Document lookup — fall through to try */
        }
      }
    }

    const advanceStarted = Date.now();
    // Create flows open an empty detail form — no list GET / Table bind.
    const skipExecuteForCreate =
      plan.openCreate === true &&
      plan.viewMode === "detail" &&
      !plan.bind;
    if (skipExecuteForCreate && pending.status === "validated") {
      pending.status = "done";
      pending.result = { ok: true, status: 200, body: {} };
    } else if (pending.status !== "failed") {
      pending = await this.hitl.advance(plan.propose.requestId);
    }
    session.pending = pending;
    this.logPendingCall(
      session,
      pending,
      "chat-demo",
      source !== "rules",
      advanceStarted,
    );

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
        openCreate: plan.openCreate === true,
        surfaceId: plan.a2uiHint.surfaceId,
        viewMode: plan.viewMode,
        title: plan.title,
      },
      dataModel: session.dataModel,
    };

    if (pending.status === "awaiting_approval") {
      const sensitive = pending.sensitive !== false;
      if (pending.permissionGate) {
        const submitted = await submitConfigApplication({
          client: this.client,
          pending,
          sessionId: session.id,
          apijsonBaseUrl: this.client.baseUrl,
        });
        if (submitted.ok) {
          response.configApplicationId = submitted.id;
        } else if (submitted.error && submitted.error !== "skip non-permission-gate") {
          response.configApplicationError = submitted.error;
        }
      }
      session.messages.push({
        role: "assistant",
        content: sensitive
          ? `Sensitive ${plan.propose.method.toUpperCase()} queued for admin approval (${pending.approvalId || pending.requestId}).`
          : `Write awaiting approval (${plan.propose.method.toUpperCase()}).`,
      });
      response.assistantMessage = pending.permissionGate
        ? `Needs Access/Request configuration — submitted to Admin (http://localhost:5174). Approve there to write Access/Request/Document/Chain, then retry. Source: ${source}`
        : sensitive
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
          content: plan.openCreate
            ? `Connected ${plan.title}. Opening the create form — fill required fields (*) and submit.`
            : `Connected ${plan.title}. Filter/sort/pagination changes will call APIJSON directly without AI.`,
        });
        response.assistantMessage = plan.openCreate
          ? `Connected "${plan.title}". Fill the create form (required fields marked *) and click Create.`
          : `Connected "${plan.title}" and bound UI. Condition changes call APIJSON directly (source: ${source}).`;
        response.bind = bind;
      } else if (plan.openCreate) {
        session.messages.push({
          role: "assistant",
          content: `Opening ${plan.title}. Fill required fields (*) and click Save to create.`,
        });
        response.assistantMessage = `Opening "${plan.title}". Fields start empty — fill required ones (*) and click Save to create.`;
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

    // Failed after execute — AI repair (remaining of 2 attempts), then Data API
    while (pending.status === "failed" && (await tryAiRepair(pending))) {
      if (pending.status === "failed") continue;
      pending = await this.hitl.advance(pending.requestId);
      session.pending = pending;
      response.pending = pending;
      if (pending.status === "done" && pending.result?.ok) {
        session.lastResult = pending.result.body;
        session.dataModel.rows = pending.result.body;
        response.lastResult = pending.result.body;
        if (plan.bind) {
          const bind = {
            ...plan.bind,
            bodyTemplate: structuredClone(pending.body),
          };
          this.bound.register(bind);
          session.bind = bind;
          response.bind = bind;
          response.assistantMessage = `Auto-repaired (attempt ${repairAttempts}) and connected "${plan.title}".`;
        } else {
          response.assistantMessage = `Auto-repaired (attempt ${repairAttempts}) and operation succeeded.`;
        }
        session.messages.push({
          role: "assistant",
          content: String(response.assistantMessage),
        });
        return response;
      }
      if (pending.status === "awaiting_approval") {
        if (pending.permissionGate) {
          const submitted = await submitConfigApplication({
            client: this.client,
            pending,
            sessionId: session.id,
            apijsonBaseUrl: this.client.baseUrl,
          });
          if (submitted.ok) response.configApplicationId = submitted.id;
        }
        response.assistantMessage = pending.permissionGate
          ? `Needs Access/Request configuration — submitted to Admin (http://localhost:5174).`
          : `Write pending approval after repair.`;
        session.messages.push({
          role: "assistant",
          content: String(response.assistantMessage),
        });
        return response;
      }
    }

    const err =
      pending.issues?.join("; ") ||
      pending.result?.error ||
      "unknown";
    const permFail =
      pending.permissionGate ||
      isPermissionGateIssue(err) ||
      partitionPermissionIssues(pending.issues || [err]).permission.length > 0;

    // Edit/delete: never auto-jump Data API; permission → Apply instead.
    if (isEditDelete && permFail && !pending.permissionGate) {
      pending = await this.hitl.awaitPermissionConfig(
        pending.requestId,
        pending.issues?.length ? pending.issues : [err],
      );
      session.pending = pending;
      response.pending = pending;
      const submitted = await submitConfigApplication({
        pending,
        sessionId: session.id,
        apijsonBaseUrl: this.client.baseUrl,
      });
      if (submitted.ok) response.configApplicationId = submitted.id;
      response.guideToDataApi = false;
      response.assistantMessage =
        `Needs Access/Request configuration — submitted to Admin (http://localhost:5174). Approve there, then retry. (${err})`;
      session.messages.push({
        role: "assistant",
        content: String(response.assistantMessage),
      });
      return response;
    }

    response.guideToDataApi = !isEditDelete;
    response.assistantMessage = isEditDelete
      ? repairAttempts > 0
        ? `Tried AI repair ${repairAttempts} time(s) but still failing: ${err}. Fix the request and retry from Chat (not jumping to Data API).`
        : `Edit/delete failed: ${err}. Retry from Chat after fixing, or submit Apply if this is a permission issue.`
      : repairAttempts > 0
        ? `Tried AI repair ${repairAttempts} time(s) but still failing: ${err}. Open the Data API tab, edit the request JSON, then Retry.`
        : `Could not connect APIJSON: ${err}. Open the Data API tab, edit the request JSON, then Retry.`;
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
    auth?: ApijsonAuth | null,
  ) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("session not found");
    const login = await this.ensureApijsonLogin(session, auth);
    if (!login.ok) throw new Error(login.error);
    this.bindClientCookie(session);
    try {
      if (revisedBody) {
        this.hitl.revise({ requestId, body: revisedBody });
        // re-enter awaiting if write
        const p = this.hitl.getPending(requestId);
        if (p && p.status === "validated") {
          await this.hitl.advance(requestId);
        }
      }
      const startedAt = Date.now();
      const pending = await this.hitl.decide(requestId, action, "operator");
      session.pending = pending;
      this.logPendingCall(session, pending, "chat-demo", false, startedAt);
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
    } finally {
      this.saveClientCookie(session);
    }
  }

  /** Propose a write (e.g. detail form save) through HITL without going via chat NL. */
  async proposeWrite(
    sessionId: string | undefined,
    payload: {
      method: "put" | "post" | "delete";
      body: Record<string, unknown>;
      rationale?: string;
    },
    auth?: ApijsonAuth | null,
  ) {
    const session = this.getOrCreateSession(sessionId);
    const login = await this.ensureApijsonLogin(session, auth);
    if (!login.ok) {
      return {
        sessionId: session.id,
        pending: {
          requestId: "",
          method: payload.method,
          body: payload.body,
          status: "failed" as const,
          issues: [login.error],
          risk: "write" as const,
        },
        requestBody: payload.body,
      };
    }
    this.bindClientCookie(session);
    try {
      await this.ensureMetaCaches();
      const requestId = `w_${Date.now().toString(36)}`;
      this.requestSessions.set(requestId, session.id);
      const body = this.ownerBody(session, payload.body, payload.method);
      let pending = this.hitl.propose({
        requestId,
        method: payload.method,
        body,
        risk: "write",
        rationale: payload.rationale ?? "Detail form save",
      });
      const startedAt = Date.now();
      if (pending.status !== "failed") {
        pending = await this.hitl.advance(requestId);
      }
      session.pending = pending;
      this.logPendingCall(session, pending, "chat-demo", false, startedAt);
      let configApplicationId: string | undefined;
      let configApplicationError: string | undefined;
      if (
        pending.status === "awaiting_approval" &&
        pending.permissionGate
      ) {
        const submitted = await submitConfigApplication({
          client: this.client,
          pending,
          sessionId: session.id,
          apijsonBaseUrl: this.client.baseUrl,
        });
        if (submitted.ok) configApplicationId = submitted.id;
        else if (
          submitted.error &&
          submitted.error !== "skip non-permission-gate"
        ) {
          configApplicationError = submitted.error;
        }
      }
      return {
        sessionId: session.id,
        pending,
        requestBody: body,
        configApplicationId,
        configApplicationError,
      };
    } finally {
      this.saveClientCookie(session);
    }
  }

  async adminDecide(
    requestId: string,
    action: "approve" | "reject",
    decidedBy = "admin",
    revisedBody?: Record<string, unknown>,
  ) {
    const sessionId = this.requestSessions.get(requestId);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (session) {
      const login = await this.ensureApijsonLogin(session, session.apijsonAuth);
      if (!login.ok) throw new Error(login.error);
      this.bindClientCookie(session);
    }
    try {
      if (revisedBody) {
        this.hitl.revise({ requestId, body: revisedBody });
        const p = this.hitl.getPending(requestId);
        if (p && p.status === "validated") {
          await this.hitl.advance(requestId);
        }
      }
      const pending = await this.hitl.decide(requestId, action, decidedBy);
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
    } finally {
      if (session) this.saveClientCookie(session);
    }
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
    auth?: ApijsonAuth | null,
  ) {
    const session = this.getSession(sessionId);
    if (!session?.bind) throw new Error("no active binding; bootstrap via chat first");

    const login = await this.ensureApijsonLogin(session, auth);
    if (!login.ok) throw new Error(login.error);
    this.bindClientCookie(session);
    try {
      if (uiPatch) {
        session.dataModel.ui = { ...session.dataModel.ui, ...uiPatch };
      }

      if (!this.bound.handlesAction(session.bind.bindingId, action)) {
        if (
          ![
            "search",
            "page_change",
            "sort_change",
            "filter_change",
            "refresh",
          ].includes(action)
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
      const startedAt = Date.now();
      const result = await this.client.execute(bind.method, body, bind.url);
      this.logExecute({
        session,
        source: "bound",
        operation: bind.method,
        url: bind.url,
        body,
        result,
        usedLlm: false,
        detail: `bound action=${action}`,
        startedAt,
      });

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
    } finally {
      this.saveClientCookie(session);
    }
  }

  async retryPropose(
    sessionId: string,
    body: Record<string, unknown>,
    auth?: ApijsonAuth | null,
  ) {
    const session = this.getSession(sessionId);
    if (!session?.plan) throw new Error("no plan");
    const login = await this.ensureApijsonLogin(session, auth);
    if (!login.ok) throw new Error(login.error);
    this.bindClientCookie(session);
    try {
      const requestId = session.plan.propose.requestId;
      const fixed = this.ownerBody(
        session,
        body,
        session.plan.propose.method,
      );
      let pending = this.hitl.revise({ requestId, body: fixed });
      pending = await this.hitl.advance(requestId);
      session.pending = pending;
      session.plan.propose.body = fixed;

      if (pending.status === "done" && pending.result?.ok && session.plan.bind) {
        const bind = {
          ...session.plan.bind,
          bodyTemplate: structuredClone(fixed),
        };
        // keep read validation happy
        const v = validateProposeRequest({
          requestId,
          method: bind.method,
          body: fixed,
        });
        if (v.ok) {
          this.bound.register(bind);
          session.bind = bind;
        }
        session.dataModel.rows = pending.result.body;
      }
      return { pending, bind: session.bind, dataModel: session.dataModel };
    } finally {
      this.saveClientCookie(session);
    }
  }
}

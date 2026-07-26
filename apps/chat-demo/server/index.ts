import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { analyzeRows } from "./analyze.js";
import {
  APIJSON_BROWSER_BASE,
  mountApijsonProxy,
} from "./apijson-proxy.js";
import { loadEnv } from "./load-env.js";
import { repairBody } from "./llm.js";
import type { LlmConfig } from "./llm-config.js";
import { Orchestrator } from "./orchestrator.js";
import { loadSchemaComments } from "./schema-comments.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

loadEnv();

const apijsonUpstream =
  process.env.APIJSON_BASE_URL ?? "http://localhost:8080";

const orch = new Orchestrator();
const app = new Hono();

app.use("*", cors());

/** Browser same-origin base; Node still uses apijsonUpstream. */
app.get("/api/health", (c) =>
  c.json({
    ok: true,
    apijsonBaseUrl: APIJSON_BROWSER_BASE,
    apijsonUpstream,
  }),
);

mountApijsonProxy(app, apijsonUpstream);

type ApijsonAuthBody = {
  login?: string;
  password?: string;
  userId?: string | number;
};

function authFromBody(a?: ApijsonAuthBody) {
  if (!a?.login || !a.password) return null;
  return {
    login: a.login,
    password: a.password,
    ...(a.userId != null ? { userId: a.userId } : {}),
  };
}

app.post("/api/chat", async (c) => {
  const body = await c.req.json<{
    sessionId?: string;
    message: string;
    llm?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      language?: string;
    };
    apijsonAuth?: ApijsonAuthBody;
  }>();
  if (!body.message?.trim()) {
    return c.json({ error: "message required" }, 400);
  }
  try {
    const result = await orch.chat(
      body.sessionId,
      body.message.trim(),
      body.llm,
      authFromBody(body.apijsonAuth),
    );
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

app.post("/api/propose", async (c) => {
  const body = await c.req.json<{
    sessionId?: string;
    method: "put" | "post" | "delete";
    body: Record<string, unknown>;
    rationale?: string;
    apijsonAuth?: ApijsonAuthBody;
  }>();
  if (!body.body || !body.method) {
    return c.json({ error: "method and body required" }, 400);
  }
  try {
    const result = await orch.proposeWrite(
      body.sessionId,
      {
        method: body.method,
        body: body.body,
        rationale: body.rationale,
      },
      authFromBody(body.apijsonAuth),
    );
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      400,
    );
  }
});

app.post("/api/decide", async (c) => {
  const body = await c.req.json<{
    sessionId: string;
    requestId: string;
    action: "approve" | "reject";
    body?: Record<string, unknown>;
    apijsonAuth?: ApijsonAuthBody;
  }>();
  try {
    const result = await orch.decide(
      body.sessionId,
      body.requestId,
      body.action,
      body.body,
      authFromBody(body.apijsonAuth),
    );
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      400,
    );
  }
});

app.post("/api/bound", async (c) => {
  const body = await c.req.json<{
    sessionId: string;
    action: string;
    ui?: { page?: number; count?: number; order?: string; keyword?: string };
    sorts?: Array<{ path: string; dir: "asc" | "desc" }>;
    filters?: Array<{
      path: string;
      conditions: Array<{
        id: string;
        op:
          | "contains"
          | "prefix"
          | "suffix"
          | "eq"
          | "gt"
          | "gte"
          | "lt"
          | "lte";
        value: string;
        not?: boolean;
        join?: "and" | "or";
      }>;
    }>;
    combineExpr?: string;
    apijsonAuth?: ApijsonAuthBody;
  }>();
  try {
    const result = await orch.boundAction(
      body.sessionId,
      body.action,
      body.ui,
      {
        sorts: body.sorts,
        filters: body.filters,
        combineExpr: body.combineExpr,
      },
      authFromBody(body.apijsonAuth),
    );
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      400,
    );
  }
});

app.post("/api/retry", async (c) => {
  const body = await c.req.json<{
    sessionId: string;
    body: Record<string, unknown>;
    apijsonAuth?: ApijsonAuthBody;
  }>();
  try {
    const result = await orch.retryPropose(
      body.sessionId,
      body.body,
      authFromBody(body.apijsonAuth),
    );
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      400,
    );
  }
});

/** AI / heuristic repair of an APIJSON body (for generated-UI CRUD retries). */
app.post("/api/repair-body", async (c) => {
  const body = await c.req.json<{
    method: string;
    body: Record<string, unknown>;
    error: string;
    llm?: LlmConfig | null;
  }>();
  if (!body.method || !body.body || typeof body.body !== "object") {
    return c.json({ error: "method and body required" }, 400);
  }
  try {
    const repaired = await repairBody(
      body.method,
      body.body,
      body.error || "failed",
      body.llm,
    );
    return c.json({
      ok: Boolean(repaired),
      body: repaired,
    });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      400,
    );
  }
});

app.post("/api/analyze", async (c) => {
  const body = await c.req.json<{
    title?: string;
    primaryTable?: string | null;
    columns?: string[];
    rows?: Array<{ key: string; cells: Record<string, unknown> }>;
    llm?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      language?: string;
    };
  }>();
  if (!body.rows?.length) {
    return c.json({ error: "rows required" }, 400);
  }
  try {
    const result = await analyzeRows({
      title: body.title,
      primaryTable: body.primaryTable,
      columns: body.columns ?? [],
      rows: body.rows,
      llm: body.llm,
    });
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

app.get("/api/schema-comments", async (c) => {
  const tables = (c.req.query("tables") || "User,Moment,Comment")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  try {
    const data = await loadSchemaComments(orch.client, tables);
    return c.json(data);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

app.get("/api/session/:id", (c) => {
  const s = orch.getSession(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  return c.json({
    id: s.id,
    bind: s.bind,
    pending: s.pending,
    dataModel: s.dataModel,
    lastResult: s.lastResult,
    plan: s.plan
      ? {
          title: s.plan.title,
          kind: s.plan.kind,
          viewMode: s.plan.viewMode,
          filters: s.plan.a2uiHint.filters,
          writeForm: s.plan.writeForm,
        }
      : null,
  });
});

function adminBaseUrl(): string {
  return (
    process.env.ADMIN_BASE_URL?.replace(/\/+$/, "") ||
    `http://127.0.0.1:${process.env.ADMIN_PORT || 3001}`
  );
}

/** Admin sometimes returns plain-text 404 when routes are missing — surface that clearly. */
async function readAdminJson(
  res: Response,
  label: string,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string; status: number }> {
  const text = await res.text();
  try {
    return { ok: true, data: text ? JSON.parse(text) : null };
  } catch {
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 160);
    return {
      ok: false,
      status: res.status,
      error: preview
        ? `admin ${label} returned non-JSON (${res.status}): ${preview}`
        : `admin ${label} returned non-JSON (${res.status})`,
    };
  }
}

/** Poll HITL ledger + admin Apply status for tracked requestIds. */
app.get("/api/approvals/status", async (c) => {
  const raw = c.req.query("ids") || "";
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);

  const applyById = new Map<
    string,
    {
      status: string;
      decision: string | null;
      applyId: string | null;
      error: string | null;
      operation?: string;
    }
  >();
  if (ids.length) {
    try {
      const res = await fetch(
        `${adminBaseUrl()}/api/applications/status?requestIds=${encodeURIComponent(ids.join(","))}`,
      );
      const data = (await res.json().catch(() => null)) as {
        items?: Array<{
          requestId: string;
          status: string;
          decision: string | null;
          applyId: string | null;
          error: string | null;
          operation?: string;
        }>;
      } | null;
      for (const row of data?.items || []) {
        applyById.set(row.requestId, row);
      }
    } catch {
      /* admin may be down — fall back to local HITL */
    }
  }

  const items = ids.map((requestId) => {
    const pending = orch.hitl.getPending(requestId);
    const approval = orch.approvals.getByRequestId(requestId);
    const apply = applyById.get(requestId);
    const decision = approval?.decision;
    let status =
      pending?.status ??
      (decision === "pending"
        ? "awaiting_approval"
        : decision === "approved" || decision === "auto_approved"
          ? "done"
          : decision === "rejected"
            ? "rejected"
            : "unknown");
    if (pending?.status === "done") status = "done";

    // Permission-gate Apply (admin) overrides when local HITL has no terminal state
    if (apply && (status === "unknown" || status === "awaiting_approval")) {
      if (apply.status === "pending" || apply.decision === "pending") {
        status = "awaiting_approval";
      } else if (apply.status === "approved" || apply.decision === "approved") {
        status = "done";
      } else if (apply.status === "rejected" || apply.decision === "rejected") {
        status = "rejected";
      }
    }

    return {
      requestId,
      status,
      decision:
        apply?.decision ??
        decision ??
        (apply?.status === "pending" ? "pending" : null),
      method:
        pending?.method ??
        approval?.method ??
        apply?.operation ??
        null,
      permissionGate:
        Boolean(pending?.permissionGate) || Boolean(apply?.applyId),
      issues: pending?.issues ?? (approval?.error ? [approval.error] : []),
      resultOk: approval?.resultOk,
      error: apply?.error ?? approval?.error ?? null,
      approvalId: approval?.id ?? pending?.approvalId ?? null,
      applyId: apply?.applyId ?? null,
    };
  });
  return c.json({ items });
});

/** Proxy: Access + Request + Document catalog from admin. */
app.get("/api/available-requests", async (c) => {
  try {
    const res = await fetch(`${adminBaseUrl()}/api/available-requests`);
    const parsed = await readAdminJson(res, "available-requests");
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 502);
    }
    const data = parsed.data;
    if (!res.ok) {
      return c.json(
        typeof data === "object" && data
          ? data
          : { error: `admin status ${res.status}` },
        502,
      );
    }
    return c.json(data);
  } catch (e) {
    return c.json(
      {
        error:
          e instanceof Error
            ? e.message
            : "admin available-requests unreachable",
      },
      502,
    );
  }
});

/** Proxy: Document + Access gate for edit/delete. */
app.get("/api/write-gate", async (c) => {
  const operation = c.req.query("operation") || "";
  const tag = c.req.query("tag") || "";
  try {
    const qs = new URLSearchParams({ operation, tag });
    const res = await fetch(`${adminBaseUrl()}/api/write-gate?${qs}`);
    const parsed = await readAdminJson(res, "write-gate");
    if (!parsed.ok) {
      return c.json({ error: parsed.error, decision: "try" }, 502);
    }
    const data = parsed.data;
    if (!res.ok) {
      return c.json(
        typeof data === "object" && data
          ? data
          : { error: `admin status ${res.status}` },
        502,
      );
    }
    return c.json(data);
  } catch (e) {
    return c.json(
      {
        error:
          e instanceof Error ? e.message : "admin write-gate unreachable",
        decision: "try",
      },
      502,
    );
  }
});

/** Proxy: submit Apply to admin (UI edit/delete permission gate). */
app.post("/api/applications", async (c) => {
  try {
    const body = await c.req.json();
    const res = await fetch(`${adminBaseUrl()}/api/applications`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = await readAdminJson(res, "applications");
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 502);
    }
    const data = parsed.data;
    if (!res.ok) {
      const status =
        res.status === 400 || res.status === 401 || res.status === 404
          ? res.status
          : 502;
      return c.json(
        typeof data === "object" && data
          ? data
          : { error: `admin status ${res.status}` },
        status as 400,
      );
    }
    return c.json(data, 201);
  } catch (e) {
    return c.json(
      {
        error:
          e instanceof Error ? e.message : "admin applications unreachable",
      },
      502,
    );
  }
});

/** Admin approval queue + audit trail */
app.get("/api/admin/approvals", (c) => {
  const decision = c.req.query("decision");
  const live = orch.hitl.listAwaiting();
  const byId = new Map(live.map((p) => [p.requestId, p]));
  // After restart, in-memory HITL is empty — surface durable ledger pending rows.
  for (const row of orch.approvals.list({ decision: "pending" })) {
    if (byId.has(row.requestId)) continue;
    byId.set(row.requestId, {
      requestId: row.requestId,
      method: row.method,
      body: row.body,
      risk: "write",
      status: "awaiting_approval",
      sensitive: row.sensitive,
      permissionGate: row.sensitive,
      approvalId: row.id,
      rationale: row.rationale,
      issues: row.error ? [row.error] : undefined,
    });
  }
  const awaiting = [...byId.values()];
  const records = decision
    ? orch.approvals.list({
        decision: decision.split(",") as Array<
          "pending" | "auto_approved" | "approved" | "rejected"
        >,
      })
    : orch.approvals.list();
  return c.json({
    awaiting,
    records,
    sensitiveMethods: (process.env.SENSITIVE_METHODS ?? "delete")
      .split(/[,;\s]+/)
      .filter(Boolean),
  });
});

app.post("/api/admin/approvals/:requestId/decide", async (c) => {
  const requestId = c.req.param("requestId");
  const body = await c.req.json<{
    action: "approve" | "reject";
    decidedBy?: string;
    body?: Record<string, unknown>;
  }>();
  if (body.action !== "approve" && body.action !== "reject") {
    return c.json({ error: "action must be approve|reject" }, 400);
  }
  try {
    const result = await orch.adminDecide(
      requestId,
      body.action,
      body.decidedBy ?? "admin",
      body.body,
    );
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      400,
    );
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.join(__dirname, "..", "dist-client");

// In dev, Vite serves the client; in prod serve built assets
app.use("/assets/*", serveStatic({ root: clientDist }));
app.get("/", serveStatic({ root: clientDist, path: "index.html" }));

const port = Number(process.env.PORT ?? 3000);

async function main() {
  // Also start Vite in dev via concurrent hint in README; here we serve API.
  // For single-command DX, dynamically import vite when not production.
  if (process.env.NODE_ENV !== "production") {
    const { createServer } = await import("vite");
    const vite = await createServer({
      configFile: path.join(__dirname, "..", "vite.config.ts"),
      server: {
        middlewareMode: false,
        host: "127.0.0.1",
        port: 5173,
        strictPort: true,
      },
    });
    await vite.listen();
    const urls = vite.resolvedUrls;
    console.log(`[a2api] Vite client: ${urls?.local?.[0] ?? "http://localhost:5173"}`);
  } else {
    console.log(`[a2api] static client from ${clientDist}`);
  }

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[a2api] API http://localhost:${info.port}`);
    console.log(`[a2api] APIJSON upstream ${apijsonUpstream}`);
    console.log(`[a2api] APIJSON browser proxy ${APIJSON_BROWSER_BASE}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

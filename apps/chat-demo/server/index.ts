import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { analyzeRows } from "./analyze.js";
import { loadEnv } from "./load-env.js";
import { Orchestrator } from "./orchestrator.js";
import { loadSchemaComments } from "./schema-comments.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

loadEnv();

const orch = new Orchestrator();
const app = new Hono();

app.use("*", cors());

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    apijsonBaseUrl: process.env.APIJSON_BASE_URL ?? "http://localhost:8080",
  }),
);

app.post("/api/chat", async (c) => {
  const body = await c.req.json<{ sessionId?: string; message: string }>();
  if (!body.message?.trim()) {
    return c.json({ error: "message required" }, 400);
  }
  try {
    const result = await orch.chat(body.sessionId, body.message.trim());
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
  }>();
  if (!body.body || !body.method) {
    return c.json({ error: "method and body required" }, 400);
  }
  try {
    const result = await orch.proposeWrite(body.sessionId, {
      method: body.method,
      body: body.body,
      rationale: body.rationale,
    });
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
  }>();
  try {
    const result = await orch.decide(
      body.sessionId,
      body.requestId,
      body.action,
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
  }>();
  try {
    const result = await orch.retryPropose(body.sessionId, body.body);
    return c.json(result);
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
    console.log(
      `[a2api] APIJSON ${process.env.APIJSON_BASE_URL ?? "http://localhost:8080"}`,
    );
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

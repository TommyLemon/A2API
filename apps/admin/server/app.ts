/**
 * Admin Hono app factory — injectable store / approve writer for E2E.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ApiJsonClient } from "@a2api/runtime";
import type { ApplicationStore } from "./application-store.js";
import {
  applyApprovedApplication,
  ensureAdminSession,
} from "./approve-writer.js";
import {
  loadAvailableRequests,
  resolveWriteGate,
} from "./available-requests.js";
import { listCallLogs } from "./call-list.js";
import { enrichApplication } from "./infer.js";
import {
  clampPage,
  clampPageSize,
  normalizeOrder,
} from "./list-query.js";
import type {
  ApplicationStatus,
  ApplicationSubmitInput,
  ApplicationWriteResults,
  ConfigApplication,
} from "./types.js";
import { APPLY_ORDER_FIELDS } from "./application-store.js";
import { CALL_ORDER_FIELDS } from "./call-list.js";

export type ApproveWriteResult = {
  ok: boolean;
  application: ConfigApplication;
  results: ApplicationWriteResults;
};

export type AdminAppDeps = {
  store: ApplicationStore;
  apijsonBaseUrl: string;
  client?: ApiJsonClient;
  /** Override approve side-effects (Access/Request/Document/Chain). */
  approveWriter?: (
    app: ConfigApplication,
    opts: { client?: ApiJsonClient; login?: string; password?: string },
  ) => Promise<ApproveWriteResult>;
  /** Override admin session check before approve. */
  ensureSession?: (
    client: ApiJsonClient | undefined,
    login?: string,
    password?: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** When false, skip available-requests / write-gate (no APIJSON). */
  enableCatalog?: boolean;
};

export function createAdminApp(deps: AdminAppDeps): Hono {
  const {
    store,
    apijsonBaseUrl,
    client,
    approveWriter = async (app, opts) => {
      if (!opts.client) {
        throw new Error("APIJSON client required for approve");
      }
      return applyApprovedApplication(app, { client: opts.client });
    },
    ensureSession = async (c, login, password) => {
      if (!c) return { ok: false, error: "no APIJSON client" };
      return ensureAdminSession(c, login, password);
    },
    enableCatalog = true,
  } = deps;

  const app = new Hono();
  app.use("*", cors());

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      apijsonBaseUrl,
    }),
  );

  app.get("/api/config", (c) =>
    c.json({
      apijsonBaseUrl,
    }),
  );

  app.post("/api/applications", async (c) => {
    let body: ApplicationSubmitInput;
    try {
      body = await c.req.json<ApplicationSubmitInput>();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      const item = await store.submit(body);
      const enriched = enrichApplication(item);
      const updated = await store.update(item.id, {
        structure: enriched.structure,
        accessAlias: enriched.accessAlias,
        accessName: enriched.accessName,
        tag: enriched.tag,
        name: enriched.name ?? item.name,
        detail: enriched.detail ?? item.detail,
      });
      return c.json({ item: updated ?? enriched }, 201);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : String(e) },
        400,
      );
    }
  });

  app.get("/api/applications", async (c) => {
    const statusQ = c.req.query("status");
    const status = statusQ
      ? (statusQ
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean) as ApplicationStatus[])
      : undefined;
    const operation = c.req.query("operation") || undefined;
    const table = c.req.query("table") || undefined;
    const q = c.req.query("q") || undefined;
    const page = clampPage(c.req.query("page"), 0);
    const pageSize = clampPageSize(c.req.query("pageSize") || c.req.query("limit"), 20);
    const order = normalizeOrder(
      c.req.query("order") || undefined,
      APPLY_ORDER_FIELDS,
      "id-",
    );
    try {
      const result = await store.list({
        ...(status?.length ? { status } : {}),
        operation,
        table,
        q,
        page,
        pageSize,
        order,
      });
      return c.json(result);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  /** Call logs via admin APIJSON session (avoids browser LOGIN Access gaps). */
  app.get("/api/calls", async (c) => {
    if (!client) {
      return c.json({ error: "APIJSON client not configured" }, 503);
    }
    const operation = c.req.query("operation") || undefined;
    const okQ = c.req.query("ok");
    const ok =
      okQ === "true" || okQ === "1"
        ? true
        : okQ === "false" || okQ === "0"
          ? false
          : undefined;
    const source = c.req.query("source") || undefined;
    const table = c.req.query("table") || undefined;
    const q = c.req.query("q") || undefined;
    const page = clampPage(c.req.query("page"), 0);
    const pageSize = clampPageSize(
      c.req.query("pageSize") || c.req.query("limit"),
      20,
    );
    const order = normalizeOrder(
      c.req.query("order") || undefined,
      CALL_ORDER_FIELDS,
      "date-",
    );
    const login = c.req.query("login") || undefined;
    const password = c.req.query("password") || undefined;
    try {
      const result = await listCallLogs(client, {
        operation,
        ok,
        source,
        table,
        q,
        page,
        pageSize,
        order,
        login,
        password,
      });
      return c.json(result);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  app.get("/api/applications/status", async (c) => {
    const raw = c.req.query("requestIds") || c.req.query("ids") || "";
    const ids = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50);
    try {
      const items = await Promise.all(
        ids.map(async (requestId) => {
          const row = await store.getByRequestId(requestId);
          if (!row) {
            return {
              requestId,
              status: "unknown" as const,
              decision: null,
              applyId: null,
              error: null,
            };
          }
          const decision =
            row.status === "approved"
              ? "approved"
              : row.status === "rejected"
                ? "rejected"
                : "pending";
          return {
            requestId,
            status: row.status,
            decision,
            applyId: row.id,
            error: row.error ?? null,
            table: row.table,
            operation: row.operation,
          };
        }),
      );
      return c.json({ items });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  app.get("/api/applications/:id", async (c) => {
    try {
      const item = await store.get(c.req.param("id"));
      if (!item) return c.json({ error: "not found" }, 404);
      return c.json({ item });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  if (enableCatalog && client) {
    app.get("/api/available-requests", async (c) => {
      try {
        const items = await loadAvailableRequests(client);
        return c.json({ items, count: items.length });
      } catch (e) {
        return c.json(
          { error: e instanceof Error ? e.message : String(e) },
          500,
        );
      }
    });

    app.get("/api/write-gate", async (c) => {
      const operation = (c.req.query("operation") || "").trim();
      const tag = (c.req.query("tag") || "").trim();
      if (!operation || !tag) {
        return c.json({ error: "operation and tag required" }, 400);
      }
      try {
        const gate = await resolveWriteGate(client, operation, tag);
        return c.json(gate);
      } catch (e) {
        return c.json(
          { error: e instanceof Error ? e.message : String(e) },
          500,
        );
      }
    });
  }

  /**
   * approve → Access/Request/Document/Chain (or injected writer)
   * reject → status=rejected only
   */
  app.post("/api/applications/:id/decide", async (c) => {
    const id = c.req.param("id");
    let existing: ConfigApplication | null;
    try {
      existing = await store.get(id);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
    if (!existing) return c.json({ error: "not found" }, 404);
    if (existing.status !== "pending") {
      return c.json({ error: `application already ${existing.status}` }, 400);
    }

    const body = await c.req.json<{
      action: "approve" | "reject";
      decidedBy?: string;
      patch?: Partial<ConfigApplication>;
      login?: string;
      password?: string;
    }>();

    const decidedBy = body.decidedBy || "admin";

    if (body.action === "reject") {
      const updated = await store.update(id, {
        status: "rejected",
        decidedAt: new Date().toISOString(),
        decidedBy,
        error: undefined,
      });
      return c.json({ item: updated, ok: true });
    }

    if (body.action !== "approve") {
      return c.json({ error: "action must be approve or reject" }, 400);
    }

    let working = existing;
    if (body.patch && typeof body.patch === "object") {
      try {
        const patched = await store.update(id, body.patch);
        if (patched) working = patched;
      } catch (e) {
        return c.json(
          { error: e instanceof Error ? e.message : String(e) },
          400,
        );
      }
    }
    working = enrichApplication(working);

    const session = await ensureSession(client, body.login, body.password);
    if (!session.ok) {
      return c.json(
        {
          error: session.error || "admin login failed",
          hint: "Set APIJSON_ADMIN_LOGIN / APIJSON_ADMIN_PASSWORD or pass login/password",
        },
        401,
      );
    }

    try {
      const applied = await approveWriter(working, {
        client,
        login: body.login,
        password: body.password,
      });
      const status = applied.ok ? "approved" : "pending";
      const writeErrors = [
        applied.results.Access?.ok
          ? null
          : `Access: ${applied.results.Access?.error}`,
        applied.results.Request?.ok
          ? null
          : `Request: ${applied.results.Request?.error}`,
        applied.results.Document?.ok
          ? null
          : `Document: ${applied.results.Document?.error}`,
        applied.results.Chain?.ok
          ? null
          : `Chain: ${applied.results.Chain?.error}`,
        applied.results.Reload == null || applied.results.Reload.ok
          ? null
          : `Reload: ${applied.results.Reload.error}`,
      ].filter(Boolean);
      // Approve succeeds when Request+Document write; Reload failure is surfaced but non-blocking.
      const error = applied.ok
        ? writeErrors.length
          ? writeErrors.join("; ")
          : undefined
        : writeErrors.join("; ") || undefined;

      const updated = await store.update(id, {
        ...applied.application,
        status,
        decidedAt: applied.ok ? new Date().toISOString() : undefined,
        decidedBy: applied.ok ? decidedBy : undefined,
        writeResults: applied.results,
        error,
      });
      return c.json({
        item: updated,
        results: applied.results,
        ok: applied.ok,
      });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  return app;
}

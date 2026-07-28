/**
 * Admin API for chat-demo + approve workflow.
 * Admin SPA still does ordinary Apply/Call list/edit via APIJSON HTTP.
 */

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiJsonClient } from "@a2api/runtime";
import { createAdminApp } from "./app.js";
import { DbApplicationStore } from "./db-application-store.js";
import { loadEnv } from "./load-env.js";

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const apijsonBase =
  process.env.APIJSON_BASE_URL?.replace(/\/+$/, "") ||
  "http://localhost:8080";

function adminClient(): ApiJsonClient {
  return new ApiJsonClient({ baseUrl: apijsonBase });
}

const sharedClient = adminClient();
const store = new DbApplicationStore(sharedClient);

/** UI/API E2E: skip real Access/Request writes (ADMIN_DRY_APPROVE=1). */
const dryApprove = process.env.ADMIN_DRY_APPROVE === "1";

const app = createAdminApp({
  store,
  apijsonBaseUrl: apijsonBase,
  client: sharedClient,
  // Catalog (available-requests / write-gate) always on when APIJSON client exists.
  // dryApprove only stubs decide-side writes — must not hide write-gate from chat-demo.
  enableCatalog: true,
  ...(dryApprove
    ? {
        ensureSession: async () => ({ ok: true }),
        approveWriter: async (application) => ({
          ok: true,
          application,
          results: {
            Access: { ok: true, action: "skip" },
            Request: { ok: true, action: "skip" },
            Document: { ok: true, action: "skip" },
            Chain: { ok: true, action: "skip" },
            Reload: { ok: true, action: "skip" },
          },
        }),
      }
    : {}),
});

const clientDist = path.join(__dirname, "..", "dist-client");
// Dev serves the SPA via Vite (:5174). Only mount static build when present.
if (existsSync(clientDist)) {
  app.use("/assets/*", serveStatic({ root: clientDist }));
  app.get("/", serveStatic({ root: clientDist, path: "index.html" }));
}

const port = Number(process.env.ADMIN_PORT ?? 3001);
const vitePort = Number(process.env.ADMIN_VITE_PORT ?? 5174);

async function httpOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(800) });
    return res.status > 0 && res.status < 500;
  } catch {
    return false;
  }
}

function isAddrInUse(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    e?.code === "EADDRINUSE" ||
    /already in use|EADDRINUSE/i.test(String(e?.message || err))
  );
}

async function startVite(): Promise<"started" | "reused"> {
  const url = `http://127.0.0.1:${vitePort}/`;
  if (await httpOk(url)) {
    console.log(`[admin] Vite client already running: ${url}`);
    return "reused";
  }
  const { createServer } = await import("vite");
  const vite = await createServer({
    configFile: path.join(__dirname, "..", "vite.config.ts"),
    server: {
      middlewareMode: false,
      host: "127.0.0.1",
      port: vitePort,
      strictPort: true,
    },
  });
  try {
    await vite.listen();
  } catch (err) {
    if (isAddrInUse(err) && (await httpOk(url))) {
      console.log(`[admin] Vite client already running: ${url}`);
      await vite.close().catch(() => undefined);
      return "reused";
    }
    throw err;
  }
  const urls = vite.resolvedUrls;
  console.log(
    `[admin] Vite client: ${urls?.local?.[0] ?? `http://127.0.0.1:${vitePort}`}`,
  );
  return "started";
}

async function startApi(): Promise<"started" | "reused"> {
  const health = `http://127.0.0.1:${port}/api/health`;
  if (await httpOk(health)) {
    console.log(`[admin] API already running: http://localhost:${port}`);
    return "reused";
  }

  return new Promise<"started" | "reused">((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port }, (info) => {
      console.log(`[admin] API http://localhost:${info.port}`);
      console.log(`[admin] APIJSON ${apijsonBase}`);
      console.log(
        `[admin] POST/GET /api/applications · GET /api/applications/status · POST .../decide (approve|reject)`,
      );
      resolve("started");
    }) as Server;

    server.on("error", (err) => {
      void (async () => {
        if (isAddrInUse(err) && (await httpOk(health))) {
          console.log(`[admin] API already running: http://localhost:${port}`);
          resolve("reused");
          return;
        }
        reject(err);
      })();
    });
  });
}

async function main() {
  let viteState: "started" | "reused" | "skipped" = "skipped";
  if (process.env.NODE_ENV !== "production") {
    viteState = await startVite();
  } else if (existsSync(clientDist)) {
    console.log(`[admin] static client from ${clientDist}`);
  } else {
    console.warn(
      `[admin] missing ${clientDist} — run vite build before production start`,
    );
  }

  const apiState = await startApi();

  console.log(
    `[admin] ready — UI http://127.0.0.1:${vitePort} · API http://localhost:${port}`,
  );

  // When reusing an existing stack, keep this process attached (npm run stays up).
  if (viteState === "reused" && apiState === "reused") {
    await new Promise(() => {
      /* park */
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

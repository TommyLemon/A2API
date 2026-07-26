import type { ProxyOptions } from "vite";
import { defineConfig } from "vite";

/** Only API paths under /apijson/… — never Vite modules like /aj-*.ts */
function isApijsonApiPath(urlPath: string): boolean {
  const path = urlPath.split("?")[0] || "";
  if (/\.[a-zA-Z0-9]+$/.test(path)) return false; // .ts .js .css …
  return path === "/apijson" || path.startsWith("/apijson/");
}

/** Browser /apijson → Node BFF (cookie jar), never straight to Java :8080. */
function apijsonViaNode(): ProxyOptions {
  return {
    target: "http://localhost:3000",
    changeOrigin: true,
    bypass(req) {
      const url = req.url || "";
      if (!isApijsonApiPath(url)) return url;
    },
  };
}

export default defineConfig({
  root: "client",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:3000",
      // Use /apijson/ prefix (trailing slash) so /apijson-*.ts is never matched
      "/apijson/": apijsonViaNode(),
      "/apijson": {
        target: "http://localhost:3000",
        changeOrigin: true,
        bypass(req) {
          const path = (req.url || "").split("?")[0] || "";
          // Exact /apijson only — not /apijson-auth.ts
          if (path !== "/apijson") return req.url;
        },
      },
    },
  },
  build: {
    outDir: "../dist-client",
    emptyOutDir: true,
  },
});

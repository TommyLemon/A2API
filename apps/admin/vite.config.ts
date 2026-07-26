import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(root, "client"),
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:3001",
    },
    fs: {
      allow: [root],
    },
  },
  build: {
    outDir: path.join(root, "dist-client"),
    emptyOutDir: true,
  },
});

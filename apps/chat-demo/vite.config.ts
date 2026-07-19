import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  build: {
    outDir: "../dist-client",
    emptyOutDir: true,
  },
});

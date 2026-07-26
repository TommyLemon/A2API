import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@a2api/protocol": path.resolve(__dirname, "../../packages/protocol/src/index.ts"),
      "@a2api/runtime": path.resolve(__dirname, "../../packages/runtime/src/index.ts"),
    },
  },
  test: {
    include: ["server/**/*.e2e.test.ts", "server/**/*.test.ts"],
    environment: "node",
  },
});

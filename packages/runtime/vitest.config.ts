import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@a2api/protocol": path.resolve(__dirname, "../protocol/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});

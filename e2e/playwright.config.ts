import { defineConfig, devices } from "@playwright/test";

const headed = process.env.HEADED !== "0";
const slowMo = Number(process.env.SLOW_MO ?? (headed ? 450 : 0));

/**
 * Watchable UI E2E (default: headed + slowMo).
 * Servers are started by e2e/run-ui.sh (not webServer) to avoid Rosetta/arch issues.
 *
 *   npm run test:ui
 * Headless:
 *   HEADED=0 npm run test:ui
 */
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.ui.spec.ts",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    headless: !headed,
    launchOptions: { slowMo },
    viewport: { width: 1400, height: 900 },
    trace: "off",
    video: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      // System Chrome — Playwright bundled browsers need newer macOS than 13.
      name: "chrome",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
      },
    },
  ],
});

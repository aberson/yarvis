// Playwright smoke (D33): starts its OWN fresh fake server + web via `npm run dev:fake` on dedicated
// ports (server 8797, web 5183) with YARVIS_PRIVATE_DIR set to a fresh temp dir seeded from
// settings.example.json, so it never collides with a running dev:fake / reviewer server and every
// run starts from the same state.
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const E2E_SERVER_PORT = 8797;
export const E2E_WEB_PORT = 5183;

// The config is evaluated in the runner and again in each worker; workers inherit the runner's env,
// so the temp dir is created exactly once.
let privateDir = process.env.YARVIS_E2E_PRIVATE_DIR;
if (!privateDir) {
  privateDir = mkdtempSync(path.join(tmpdir(), "yarvis-e2e-"));
  copyFileSync(
    path.join(repoRoot, "settings.example.json"),
    path.join(privateDir, "settings.json"),
  );
  process.env.YARVIS_E2E_PRIVATE_DIR = privateDir;
}

const baseURL = `http://127.0.0.1:${E2E_WEB_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  outputDir: path.join(repoRoot, "test-results"),
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev:fake",
    cwd: repoRoot,
    // Health through the Vite proxy: ready only when BOTH web and server are up.
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PORT: String(E2E_SERVER_PORT),
      YARVIS_WEB_PORT: String(E2E_WEB_PORT),
      YARVIS_PRIVATE_DIR: privateDir,
    },
  },
});

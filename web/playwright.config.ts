// Playwright smoke (D33): starts its OWN fresh fake server + web via `npm run dev:fake` on dedicated
// ports (server 8797, web 5183) with YARVIS_PRIVATE_DIR set to a fresh temp dir seeded from
// settings.example.json, so it never collides with a running dev:fake / reviewer server and every
// run starts from the same state. A second "seeded" fake server (server 8798, web 5184, its own temp
// private dir) loads a synthetic sheet seed via YARVIS_FAKE_SHEET_SEED (fake mode only) so the
// Briefing's data-dependent UI (25-item cap + omitted count, pending/none extraction labels,
// quarantine exclusion) runs end to end without touching the fixtures `npm run smoke` counts.
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const E2E_SERVER_PORT = 8797;
export const E2E_WEB_PORT = 5183;
export const E2E_SEEDED_SERVER_PORT = 8798;
export const E2E_SEEDED_WEB_PORT = 5184;
/** The seeded sheet: 30 open visible to-dos (one pending, one none), 2 done, 1 quarantined. */
export const SEEDED_OPEN = 30;

function seededTodo(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `gmail:5eed${n.toString(16).padStart(12, "0")}#1`,
    source: "gmail",
    status: "open",
    action: `Seeded action ${n}`,
    extraction_status: "done",
    original_text: `Seeded synthetic body ${n}`,
    sender: `seed${n}@example.test`,
    context: `Seeded subject ${n}`,
    message_date: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
    link: "",
    jev_action: 0.9,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

function seededSheet(): string {
  const todos = Array.from({ length: SEEDED_OPEN }, (_, i) => seededTodo(i + 1));
  // The two newest open items carry the pending / none extraction states.
  todos.push(seededTodo(100, { extraction_status: "pending", action: "" }));
  todos.push(seededTodo(101, { extraction_status: "none", action: "" }));
  todos.splice(0, 2); // keep exactly SEEDED_OPEN open items
  todos.push(seededTodo(200, { status: "done" }), seededTodo(201, { status: "done" }));
  const held = seededTodo(300, { message_date: "2026-10-30T00:00:00.000Z" });
  todos.push(held);
  const quarantine = [
    {
      id: String(held.id).replace(/#1$/, ""),
      source: "gmail",
      sender: "held@example.test",
      context: "Held",
      message_date: held.message_date,
      link: "",
      jev_phishing: 0.9,
      jev_malicious: 0.1,
      jev_spam: 0.1,
      reason: "phishing≥0.50",
      created_at: "2026-10-01T00:00:00.000Z",
      released_at: "",
    },
  ];
  return JSON.stringify({ Todos: todos, Quarantine: quarantine });
}

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
let seededDir = process.env.YARVIS_E2E_SEEDED_DIR;
if (!seededDir) {
  seededDir = mkdtempSync(path.join(tmpdir(), "yarvis-e2e-"));
  copyFileSync(path.join(repoRoot, "settings.example.json"), path.join(seededDir, "settings.json"));
  writeFileSync(path.join(seededDir, "seed-sheet.json"), seededSheet());
  process.env.YARVIS_E2E_SEEDED_DIR = seededDir;
}
export const SEEDED_BASE_URL = `http://127.0.0.1:${E2E_SEEDED_WEB_PORT}`;

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
  webServer: [
    {
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
    {
      command: "npm run dev:fake",
      cwd: repoRoot,
      url: `${SEEDED_BASE_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
      env: {
        PORT: String(E2E_SEEDED_SERVER_PORT),
        YARVIS_WEB_PORT: String(E2E_SEEDED_WEB_PORT),
        YARVIS_PRIVATE_DIR: seededDir,
        YARVIS_FAKE_SHEET_SEED: path.join(seededDir, "seed-sheet.json"),
      },
    },
  ],
});

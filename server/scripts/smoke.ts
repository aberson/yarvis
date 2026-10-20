// `npm run smoke` (plan Step 8, §10): the fake-mode end-to-end refresh gate. Starts the REAL server
// entry (server/src/main.ts) with YARVIS_FAKE=1 on a free port (PORT=0, never 8787) and a fresh temp
// YARVIS_PRIVATE_DIR seeded by `npm run setup`'s runSetup, waits for /api/health, POSTs /api/refresh
// with X-Yarvis: 1 (the Host header fetch sends is 127.0.0.1:<bound port>, which the D22/D28 guard
// accepts), polls GET /api/refresh/status to `done` within 30 s, and asserts the Todos / Quarantine
// counts served by the API equal server/fixtures/manifest.ts EXPECTED. Prints one summary line; the
// server's whole process tree is killed and the temp dir removed on every exit path; any failure
// (including every timeout: startup, per request, refresh deadline) exits non-zero.
//
// The server is run from source through tsx with cwd = the repo root, so `@yarvis/shared` resolves
// via the root tsconfig paths and smoke does not need `npm run build` first.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { QuarantineItem, RefreshStatus, Todo } from "@yarvis/shared";
import { EXPECTED } from "../fixtures/manifest.js";
import { killProcessTree } from "../src/ai/extract.js";
import { REPO_ROOT, resolvePaths } from "../src/config/paths.js";
import { runSetup } from "../src/setup.js";
import { isMainModule } from "../src/util/is-main.js";

/** Bound on server startup (tsx compile + listen). */
const START_TIMEOUT_MS = 60_000;
/** Bound on every single HTTP request, so a hung server cannot hang smoke. */
const REQUEST_TIMEOUT_MS = 5_000;
/** Deadline for the refresh job to reach `done`, measured from just before the POST. */
const REFRESH_TIMEOUT_MS = 30_000;
const POLL_MS = 250;
/** main.ts logs `listening on <url> (fake mode); private dir ...`: require the delimiter after the port. */
const LISTEN_LINE = /listening on (http:\/\/127\.0\.0\.1:(\d+))(?=[\s;])/;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

class SmokeFailure extends Error {}

function fail(message: string): never {
  throw new SmokeFailure(message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Spawns `node --import tsx server/src/main.ts`; detached on POSIX so the tree kill can hit its group. */
function startServer(privateDir: string): ChildProcess {
  // Fake mode never reads credentials; drop the one secret env var the server would otherwise load.
  const { TYPESAFE_API_KEY: _secret, ...parentEnv } = process.env;
  return spawn(
    process.execPath,
    ["--import", "tsx", path.join(REPO_ROOT, "server", "src", "main.ts")],
    {
      cwd: REPO_ROOT,
      env: { ...parentEnv, YARVIS_FAKE: "1", YARVIS_PRIVATE_DIR: privateDir, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    },
  );
}

/** Resolves with the bound URL from the server's listen line; rejects on spawn error, early exit or timeout. */
function waitForListen(child: ChildProcess): Promise<{ url: string; port: number }> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const timer = setTimeout(
      () => reject(new SmokeFailure(`server printed no listen line within ${START_TIMEOUT_MS} ms`)),
      START_TIMEOUT_MS,
    );
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      err += chunk;
    });
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
      const m = LISTEN_LINE.exec(out);
      if (m?.[1] && m[2]) {
        clearTimeout(timer);
        resolve({ url: m[1], port: Number(m[2]) });
      }
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(new SmokeFailure(`server could not be started: ${e.message}`));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const tail = err.trim().split(/\r?\n/).slice(-5).join(" | ");
      reject(
        new SmokeFailure(
          `server exited before listening (code ${String(code)}, signal ${String(signal)})${tail ? `: ${tail}` : ""}`,
        ),
      );
    });
  });
}

/**
 * One HTTP request bounded by `timeoutMs` (default REQUEST_TIMEOUT_MS); any network error, timeout
 * or non-JSON body fails.
 */
async function getJson<T>(
  url: string,
  init?: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<{ status: number; body: T }> {
  const what = `${init?.method ?? "GET"} ${url}`;
  let status: number;
  let text: string;
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    status = res.status;
    text = await res.text();
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return fail(
      timedOut
        ? `${what} timed out after ${timeoutMs} ms`
        : `${what} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return { status, body: JSON.parse(text) as T };
  } catch {
    return fail(`${what} -> ${status} non-JSON body`);
  }
}

async function smoke(
  base: string,
): Promise<{ refreshMs: number; todos: number; quarantine: number }> {
  const health = await getJson<{ ok?: boolean; fake?: boolean }>(`${base}/api/health`);
  if (health.status !== 200 || health.body.ok !== true || health.body.fake !== true) {
    fail(
      `GET /api/health -> ${health.status} ${JSON.stringify(health.body)} (want ok + fake mode)`,
    );
  }

  const started = Date.now();
  const post = await getJson<unknown>(`${base}/api/refresh`, {
    method: "POST",
    headers: { "X-Yarvis": "1" },
  });
  if (post.status !== 202) {
    fail(`POST /api/refresh -> ${post.status} ${JSON.stringify(post.body)} (want 202)`);
  }

  let status: RefreshStatus | undefined;
  while (Date.now() - started < REFRESH_TIMEOUT_MS) {
    // Clamp each poll to the remaining budget so the 30 s deadline is never overrun.
    const left = REFRESH_TIMEOUT_MS - (Date.now() - started);
    const res = await getJson<RefreshStatus>(
      `${base}/api/refresh/status`,
      undefined,
      Math.max(1, Math.min(REQUEST_TIMEOUT_MS, left)),
    );
    if (res.status !== 200) fail(`GET /api/refresh/status -> ${res.status}`);
    status = res.body;
    if (status.state === "done") break;
    if (status.state === "partial" || status.state === "error") {
      const stageErrors = Object.entries(status.stages)
        .filter(([, s]) => s.error !== undefined)
        .map(([name, s]) => `${name}: ${String(s.error)}`);
      fail(
        `refresh ended ${status.state}${status.error ? ` (${status.error})` : ""}${stageErrors.length ? `; ${stageErrors.join("; ")}` : ""}`,
      );
    }
    await sleep(POLL_MS);
  }
  if (status?.state !== "done") {
    fail(
      `refresh not done within ${REFRESH_TIMEOUT_MS} ms (last state ${status?.state ?? "none"})`,
    );
  }
  const refreshMs = Date.now() - started;

  const todos = await getJson<Todo[]>(`${base}/api/todos?status=all`);
  const quarantine = await getJson<QuarantineItem[]>(`${base}/api/quarantine`);
  if (todos.status !== 200 || !Array.isArray(todos.body)) {
    fail(`GET /api/todos?status=all -> ${todos.status} (want 200 + array)`);
  }
  if (quarantine.status !== 200 || !Array.isArray(quarantine.body)) {
    fail(`GET /api/quarantine -> ${quarantine.status} (want 200 + array)`);
  }
  const counts = { todos: todos.body.length, quarantine: quarantine.body.length };
  if (counts.todos !== EXPECTED.todos || counts.quarantine !== EXPECTED.quarantine) {
    fail(
      `counts todos ${counts.todos}/${EXPECTED.todos}, quarantine ${counts.quarantine}/${EXPECTED.quarantine} (got/expected)`,
    );
  }
  return { refreshMs, ...counts };
}

async function main(): Promise<number> {
  const privateDir = await mkdtemp(path.join(tmpdir(), "yarvis-smoke-"));
  let child: ChildProcess | undefined;
  let cleaning: Promise<void> | undefined;
  // Idempotent: a signal arriving mid-cleanup awaits the same in-flight cleanup.
  const cleanup = () =>
    (cleaning ??= (async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        await killProcessTree(child);
      }
      await rm(privateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
        () => undefined,
      );
    })());
  // Kept registered until exit, so a repeated signal cannot fall back to the default (orphaning) action.
  const onSignal = (signal: NodeJS.Signals) => {
    console.error(`smoke FAILED: interrupted by ${signal}`);
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  for (const s of SIGNALS) process.on(s, onSignal);

  let port: number | undefined;
  try {
    await runSetup(resolvePaths({ YARVIS_PRIVATE_DIR: privateDir }, REPO_ROOT));
    child = startServer(privateDir);
    const listening = await waitForListen(child);
    port = listening.port;
    const r = await smoke(listening.url);
    console.log(
      `smoke OK: fake server on port ${port}, refresh done in ${r.refreshMs} ms, todos ${r.todos}/${EXPECTED.todos}, quarantine ${r.quarantine}/${EXPECTED.quarantine}`,
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`smoke FAILED${port === undefined ? "" : ` (port ${port})`}: ${message}`);
    return 1;
  } finally {
    await cleanup();
    for (const s of SIGNALS) process.off(s, onSignal);
  }
}

if (isMainModule(import.meta.url)) {
  void main().then((code) => {
    process.exitCode = code;
  });
}

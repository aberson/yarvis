// Express app factory (plan §5, §6). Localhost-only is the auth model, so createApp hardens it
// against DNS rebinding and cross-site simple POSTs (D22, D28):
//   - 403 bad_host unless Host is 127.0.0.1:<p> or localhost:<p>, where <p> is the port the request
//     actually arrived on (req.socket.localPort) or the configured web port (Vite proxy, D31);
//   - 403 missing_x_yarvis on any mutating method without header `X-Yarvis: 1`.
// No CORS middleware: the web app reaches the API through the Vite /api proxy (D31).
import path from "node:path";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { X_YARVIS_VALUE } from "@yarvis/shared";
import type { Env, Paths } from "./config/paths.js";
import { SettingsError } from "./config/settings.js";
import { accessLog, type AccessLogSink } from "./access-log.js";
import { sendError } from "./http.js";
import { healthRouter } from "./routes/health.js";
import { settingsRouter } from "./routes/settings.js";
import { TodosCache, todosRouter } from "./routes/todos.js";
import { quarantineRouter } from "./routes/quarantine.js";
import { refreshRouter } from "./routes/refresh.js";
import { statusRouter } from "./routes/status.js";
import { SheetsError, type SheetsStore } from "./connectors/sheets.js";
import { createFakeSheets, loadSheetSeed } from "./fakes/sheets.js";
import { RefreshRunner } from "./pipeline/job.js";
import { defaultSeams, realSheetsStore, type PipelineSeams } from "./pipeline/seams.js";
import { AssistantService, type SourceConfigured } from "./assistant/service.js";
import { assistantRouter } from "./routes/assistant.js";
import { loadSettings } from "./config/settings.js";
import { seamsConfigured } from "./pipeline/configured.js";

export interface AppDeps {
  paths: Paths;
  /** YARVIS_FAKE=1: every external seam is wired to an in-memory fake (Sheets: FakeSheets). */
  fake: boolean;
  /** The web port the Host guard also accepts (YARVIS_WEB_PORT, default 5173). */
  webPort: number;
  /**
   * Sink for the one-line-per-/api-request access log; `false` disables it. Defaults to stdout,
   * except under Vitest (VITEST set) where it is silent so test output stays clean.
   */
  accessLog?: AccessLogSink | false;
  /**
   * The Sheets store behind /api/todos and /api/quarantine. Defaults to FakeSheets seeded from
   * server/fixtures in fake mode, else the real service-account client (settings.sheetId).
   */
  sheets?: SheetsStore;
  /** Todos read cache TTL (default 10 s) and clock, injectable for tests. */
  todosCacheTtlMs?: number;
  now?: () => number;
  /**
   * The refresh job's external seams (plan §5). Default: all five fakes in fake mode (sharing the
   * app's Sheets store), else the real clients. Ignored when `refreshRunner` is given.
   */
  seams?: PipelineSeams;
  /** The refresh job runner; default one built over `seams`. */
  refreshRunner?: RefreshRunner;
  /** Environment GET /api/status reads (TYPESAFE_API_KEY, PATH); default process.env. */
  env?: Env;
  /**
   * The assistant service behind /api/assistant/* (plan S1). main.ts injects one and owns its
   * init/close lifecycle; otherwise a default one over this app's Sheets store is built whose
   * SQLite store opens lazily on the first assistant request (existing callers never touch it).
   */
  assistant?: AssistantService;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True when `host` names loopback on one of `ports` (case-insensitive host name). */
export function isAllowedHost(host: string | undefined, ports: readonly number[]): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  return ports.some((p) => h === `127.0.0.1:${p}` || h === `localhost:${p}`);
}

export function localhostGuard(opts: { webPort: number }): RequestHandler {
  return (req, res, next) => {
    const ports = [req.socket.localPort, opts.webPort].filter(
      (p): p is number => typeof p === "number",
    );
    if (!isAllowedHost(req.headers.host, ports)) {
      sendError(res, "bad_host", "Host header is not an allowed loopback origin");
      return;
    }
    if (!SAFE_METHODS.has(req.method) && req.get("x-yarvis") !== X_YARVIS_VALUE) {
      sendError(res, "missing_x_yarvis", "mutating requests require header X-Yarvis: 1");
      return;
    }
    next();
  };
}

const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const e = (err ?? {}) as { type?: string; status?: number };
  if (e.type === "entity.parse.failed") {
    sendError(res, "bad_request", "request body is not valid JSON");
    return;
  }
  if (e.type === "entity.too.large") {
    sendError(res, "bad_request", "request body too large");
    return;
  }
  if (typeof e.status === "number" && e.status >= 400 && e.status < 500) {
    // Other client errors raised by express/body-parser (malformed URL, unsupported charset, ...).
    sendError(res, "bad_request", "bad request");
    return;
  }
  if (err instanceof SettingsError) {
    sendError(res, "settings_invalid", err.message);
    return;
  }
  if (err instanceof SheetsError) {
    sendError(
      res,
      err.kind === "not_configured" ? "sheets_not_configured" : "sheets_error",
      err.message,
    );
    return;
  }
  console.error("[yarvis] unhandled error:", err instanceof Error ? err.message : String(err));
  sendError(res, "internal", "internal server error");
};

/**
 * Fake mode only: YARVIS_FAKE_SHEET_SEED names an alternate synthetic seed file (absolute path,
 * `{Todos, Quarantine}`) for the in-memory sheet. Used by the Playwright seeded server to exercise
 * data-dependent UI (25-item cap, extraction states); ignored outside fake mode.
 */
export const FAKE_SHEET_SEED_ENV = "YARVIS_FAKE_SHEET_SEED";

export function defaultSheetsStore(
  deps: Pick<AppDeps, "paths" | "fake">,
  env: Env = process.env,
): SheetsStore {
  if (!deps.fake) return realSheetsStore(deps.paths);
  const seedFile = env[FAKE_SHEET_SEED_ENV]?.trim();
  return createFakeSheets(
    seedFile && path.isAbsolute(seedFile) ? { seed: loadSheetSeed(seedFile) } : {},
  ).store;
}

/** Source coverage flags from files present only (pipeline/configured.ts); never secret values. */
export function sourceConfigured(
  deps: Pick<AppDeps, "paths" | "fake" | "env">,
): () => Promise<SourceConfigured> {
  return async () => {
    const settings = await loadSettings(deps.paths).catch(() => null);
    const flags = seamsConfigured({
      paths: deps.paths,
      env: deps.env ?? process.env,
      fake: deps.fake,
      settings,
    });
    return { gmail: flags.gmail, whatsapp: flags.whatsapp };
  };
}

/** The default assistant service for an app: same private dir and Sheets store. */
export function defaultAssistantService(
  deps: Pick<AppDeps, "paths" | "fake" | "env" | "now">,
  sheets: SheetsStore,
): AssistantService {
  return new AssistantService({
    paths: deps.paths,
    sheets,
    configured: sourceConfigured(deps),
    now: deps.now,
  });
}

export function createApp(deps: AppDeps): express.Express {
  const sheets = deps.sheets ?? defaultSheetsStore(deps);
  const now = deps.now ?? Date.now;
  const todosCache = new TodosCache(sheets, deps.todosCacheTtlMs, now);
  const refresh =
    deps.refreshRunner ??
    new RefreshRunner({
      paths: deps.paths,
      ...(deps.seams ?? defaultSeams({ paths: deps.paths, fake: deps.fake, sheets })),
    });
  // A finished job changed the sheet: the next GET /api/todos must re-read it (D22).
  refresh.onFinished(() => todosCache.invalidate());
  const app = express();
  app.disable("x-powered-by");
  const sink = deps.accessLog ?? (process.env.VITEST ? false : (line: string) => console.log(line));
  if (sink) app.use(accessLog(sink)); // first, so guard rejections are logged too
  app.use(localhostGuard({ webPort: deps.webPort }));
  app.use(express.json({ limit: "64kb" }));
  app.use(healthRouter({ fake: deps.fake }));
  app.use(settingsRouter({ paths: deps.paths }));
  app.use(
    todosRouter({ store: sheets, cache: todosCache, nowIso: () => new Date(now()).toISOString() }),
  );
  app.use(quarantineRouter({ store: sheets }));
  app.use(refreshRouter({ runner: refresh }));
  const assistant = deps.assistant ?? defaultAssistantService(deps, sheets);
  app.locals.assistant = assistant; // so a caller that did not inject one can close it
  app.use(assistantRouter({ service: assistant }));
  app.use(
    statusRouter({
      paths: deps.paths,
      env: deps.env ?? process.env,
      fake: deps.fake,
      runner: refresh,
    }),
  );
  app.use((_req, res) => {
    sendError(res, "not_found");
  });
  app.use(errorHandler);
  return app;
}

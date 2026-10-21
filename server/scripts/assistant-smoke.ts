// `npm run smoke:assistant` (plan Phase 2 / S1, Step 12): the reproducible end-to-end proof of the
// S1 journey "brief me, then help me handle one request", bounded by 60 s. Three parts:
//
//  1. Journey (real app/router/service/SQLite, deterministic external boundaries). In-process
//     startServer() from server/src/main.ts in fake mode on an ephemeral port (PORT=0, never 8787)
//     with a fresh temp YARVIS_PRIVATE_DIR (seeded by runSetup) and a synthetic sheet seed
//     (YARVIS_FAKE_SHEET_SEED) holding the standard fixtures plus two planted Todos. Externals are
//     the in-memory FakeSheets and a FakeComposer (the production envelope/Composition parser over a
//     canned answer); nothing spawns `claude` or reaches Google. Over HTTP (X-Yarvis: 1):
//     build a briefing -> prepare the planted eligible Todo -> PATCH an edit (draft + one checkbox)
//     -> PATCH "handled" -> close the server (graceful: the assistant closes its database) -> start
//     again on the same private dir -> the packet, the saved list and the latest briefing read back
//     deep-equal (same revision, content and handled state); preparing the same Todo again returns
//     the existing packet without a model call.
//
//  2. Log privacy. The planted Todos carry synthetic secret-like text in `original_text` (a fake
//     key-shaped token built at runtime, so this file never matches the CI key-shape scan, plus a
//     distinctive sentence). Everything the server writes to stdout/stderr (access log, warnings)
//     during both server lifetimes is captured. Asserted:
//       - the captured output is non-empty and contains the access-log lines (capture anchor), but
//         contains neither the token nor the sentence;
//       - every error response body exercised (a todoId equal to the token, a PATCH carrying the
//         token in an unknown field and in an over-long draft, a non-UUID id, a stale save, and a
//         failed composition whose fake CLI stderr echoes the source text) contains neither, with
//         ONE stated exception: the stale save's 409 carries `currentPacket` (the saved packet, for
//         review), whose `sourceRef.originalText` legitimately holds the stored source excerpt; that
//         body is checked with `currentPacket.sourceRef.originalText` removed;
//         (The access log records each request's method + PATH. Paths carry only ids the app
//         generates (UUIDs, Todo ids), never message text, so the non-UUID probe uses a plain
//         string: a client that deliberately puts text in a URL path will see it logged.)
//       - the failed run's record (GET /api/assistant/runs/:id) carries only the bounded error code;
//       - positive control: the stored packet's `sourceRef.originalText` returned by GET DOES hold the
//         planted text (so the absence checks above are not vacuous).
//
//  3. Real SQLite, no mocks: AssistantStore.open on its own fresh temp dir initializes schema v1
//     (PRAGMA user_version = 1, read back through a separate node:sqlite connection), writes a run +
//     packet, saves an edit, closes, reopens and reads back the identical packet.
//
// Prints one "assistant smoke OK: ..." line; any failure or the 60 s budget exits non-zero. The exit
// status is fail-closed (runFailClosed: 1 until main() resolves 0) and the budget timer stays ref'd,
// so a stalled await can never drain the loop into a silent exit 0. Servers are closed and temp
// dirs removed on every exit path.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type {
  AssistantRun,
  Briefing,
  LatestBriefingResponse,
  PacketListResponse,
  PacketResponse,
  PreparationPacket,
  RunResponse,
  Todo,
} from "@yarvis/shared";
import { FAKE_SHEET_SEED_ENV } from "../src/index.js";
import { startServer, type StartedServer } from "../src/main.js";
import { REPO_ROOT, resolvePaths } from "../src/config/paths.js";
import { runSetup } from "../src/setup.js";
import { isMainModule } from "../src/util/is-main.js";
import { FakeComposer, fakeComposition } from "../src/fakes/composer.js";
import { fakeEnvelope } from "../src/fakes/claude.js";
import { loadSheetSeed } from "../src/fakes/sheets.js";
import { AssistantStore, assistantDbFile, requestHash } from "../src/assistant/store.js";

/** The whole smoke's budget (plan Step 12 "within 60 seconds"). */
const BUDGET_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const RUN_TIMEOUT_MS = 15_000;
const POLL_MS = 100;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

class SmokeFailure extends Error {}

function fail(message: string): never {
  throw new SmokeFailure(message);
}

function check(cond: unknown, message: string): asserts cond {
  if (!cond) fail(message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// --- synthetic planted data --------------------------------------------------------------------

/** A fake key-shaped token, assembled at runtime so this source never matches the CI shape scan. */
const SECRET_HEX = randomBytes(24).toString("hex");
const SECRET_TOKEN = ["sk", "ant", "api03", SECRET_HEX].join("-");
/** A distinctive sentence that must never reach logs or error bodies. */
const SECRET_SENTENCE = "The heron counts nine lanterns beneath the quiet cobalt bridge";
const PLANTED: readonly string[] = [SECRET_TOKEN, SECRET_SENTENCE];
/**
 * What the absence checks look for: the full planted strings plus short distinctive fragments (the
 * token's random suffix, slices of it, and 2-3 word pieces of the sentence), so a truncated or
 * partially echoed copy is caught too.
 */
const LEAK_MARKERS: readonly string[] = [
  ...PLANTED,
  SECRET_HEX,
  SECRET_HEX.slice(0, 16),
  SECRET_HEX.slice(-16),
  "nine lanterns",
  "quiet cobalt bridge",
  "heron counts",
];

const JOURNEY_TODO = "gmail:0000a55157a0e001#1";
const FAILING_TODO = "gmail:0000a55157a0e002#1";

function plantedTodo(id: string, minute: number, context: string): Todo {
  return {
    id,
    source: "gmail",
    status: "open",
    action: `Reply about the ${context.toLowerCase()}`,
    extraction_status: "done",
    original_text: `${SECRET_SENTENCE}. Use token ${SECRET_TOKEN} to confirm.`,
    sender: "planted@example.test",
    context,
    // Newer than every fixture row, so both sort into the capped briefing.
    message_date: new Date(Date.UTC(2026, 9, 30, 12, minute)).toISOString(),
    link: "",
    jev_action: 0.9,
    created_at: "2026-10-30T12:00:00.000Z",
    updated_at: "2026-10-30T12:00:00.000Z",
  };
}

/** The composer boundary: deterministic success, except a CLI failure echoing source text on stderr. */
function smokeComposer(): FakeComposer {
  return new FakeComposer((input) =>
    input.sourceRef.todoId === FAILING_TODO
      ? {
          stdout: "",
          stderr: `fatal: could not handle ${input.sourceRef.originalText}`,
          exitCode: 1,
          timedOut: false,
        }
      : {
          stdout: fakeEnvelope(JSON.stringify(fakeComposition(input))),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        },
  );
}

// --- output capture ----------------------------------------------------------------------------

/** Captures (and silences) everything written to stdout/stderr until restore(). */
function captureOutput(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const sink = ((chunk: unknown, ...rest: unknown[]) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString());
    const cb = rest.find((r): r is () => void => typeof r === "function");
    cb?.();
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink;
  let restored = false;
  return {
    text: () => chunks.join(""),
    restore: () => {
      if (restored) return;
      restored = true;
      process.stdout.write = out;
      process.stderr.write = err;
    },
  };
}

// --- HTTP --------------------------------------------------------------------------------------

interface Reply<T> {
  status: number;
  text: string;
  body: T;
}

async function call<T>(
  base: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<Reply<T>> {
  const what = `${method} ${url}`;
  let status: number;
  let text: string;
  try {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        "X-Yarvis": "1",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    return fail(`${what} failed: ${err instanceof Error ? err.name : "error"}`);
  }
  try {
    return { status, text, body: JSON.parse(text) as T };
  } catch {
    return fail(`${what} -> ${status} non-JSON body`);
  }
}

function want<T>(r: Reply<T>, status: number, what: string): T {
  if (r.status !== status) fail(`${what} -> ${r.status} (want ${status})`);
  return r.body;
}

async function waitRun(base: string, id: string): Promise<AssistantRun> {
  const started = Date.now();
  while (Date.now() - started < RUN_TIMEOUT_MS) {
    const { run } = want(
      await call<RunResponse>(base, "GET", `/api/assistant/runs/${id}`),
      200,
      "GET run",
    );
    if (run.state !== "running") return run;
    await sleep(POLL_MS);
  }
  return fail(`run ${id} still running after ${RUN_TIMEOUT_MS} ms`);
}

/** Collected error bodies (raw text) for the privacy check, with their label. */
type ErrorBodies = Array<{ label: string; text: string }>;

function containsPlanted(text: string): boolean {
  return LEAK_MARKERS.some((p) => text.includes(p));
}

// --- the journey -------------------------------------------------------------------------------

interface JourneyResult {
  packet: PreparationPacket;
  list: PacketListResponse;
  briefing: Briefing;
  errors: ErrorBodies;
  failedRun: AssistantRun;
}

async function firstLife(base: string, composer: FakeComposer): Promise<JourneyResult> {
  const errors: ErrorBodies = [];
  const health = want(
    await call<{ ok?: boolean; fake?: boolean }>(base, "GET", "/api/health"),
    200,
    "GET /api/health",
  );
  check(health.ok === true && health.fake === true, "health: want ok + fake mode");

  // Build a briefing.
  const { run: bRun } = want(
    await call<RunResponse>(base, "POST", "/api/assistant/briefings", { requestId: randomUUID() }),
    202,
    "POST briefings",
  );
  const bDone = await waitRun(base, bRun.id);
  check(bDone.state === "succeeded", `briefing run ${bDone.state} (${String(bDone.errorCode)})`);
  const { briefing } = want(
    await call<LatestBriefingResponse>(base, "GET", "/api/assistant/briefings/latest"),
    200,
    "GET latest briefing",
  );
  check(briefing && briefing.id === bDone.targetId, "latest briefing is not the run's target");
  const item = briefing.items.find((i) => i.sourceRef.todoId === JOURNEY_TODO);
  check(item?.preparationEligible === true, "planted Todo is not an eligible briefing item");

  // Prepare it.
  const prep = await call<RunResponse>(base, "POST", "/api/assistant/preparations", {
    requestId: randomUUID(),
    briefingId: briefing.id,
    todoId: JOURNEY_TODO,
  });
  const pRun = await waitRun(base, want(prep, 202, "POST preparations").run.id);
  check(pRun.state === "succeeded" && pRun.targetId, `prepare run ${pRun.state}`);
  const created = want(
    await call<PacketResponse>(base, "GET", `/api/assistant/preparations/${pRun.targetId}`),
    200,
    "GET packet",
  ).packet;
  check(created.revision === 1 && created.state === "open", "new packet is not revision 1 / open");
  check(composer.calls.length === 1, `composer calls ${composer.calls.length} (want 1)`);

  // Edit: draft + tick the first checkbox (revision 2), then mark handled (revision 3).
  const editUrl = `/api/assistant/preparations/${created.id}`;
  const checklist = created.checklist.map((c, i) => ({ ...c, done: i === 0 }));
  const draft = `${created.draft}\n\nEdited by the assistant smoke.`;
  const edited = want(
    await call<PacketResponse>(base, "PATCH", editUrl, {
      expectedRevision: 1,
      draft,
      checklist,
      questions: created.questions,
      state: "open",
    }),
    200,
    "PATCH edit",
  ).packet;
  check(edited.revision === 2 && edited.draft === draft, "edit did not save as revision 2");
  check(edited.checklist[0]?.done === true, "edit did not tick the first checkbox");
  const handled = want(
    await call<PacketResponse>(base, "PATCH", editUrl, {
      expectedRevision: 2,
      draft,
      checklist,
      questions: created.questions,
      state: "handled",
    }),
    200,
    "PATCH handled",
  ).packet;
  check(handled.revision === 3 && handled.state === "handled", "handled did not save as rev 3");

  // Error responses that see planted text in their input (privacy probes).
  const stale = await call<{ error: string; currentPacket?: PreparationPacket }>(
    base,
    "PATCH",
    editUrl,
    { expectedRevision: 1, draft: SECRET_SENTENCE, checklist, questions: [], state: "open" },
  );
  check(
    stale.status === 409 && stale.body.error === "revision_conflict",
    `stale save -> ${stale.status}`,
  );
  check(stale.body.currentPacket?.revision === 3, "stale save's currentPacket is not revision 3");
  // Stated exception: the review copy of the saved packet holds the stored source excerpt.
  const reviewCopy = structuredClone(stale.body);
  if (reviewCopy.currentPacket) reviewCopy.currentPacket.sourceRef.originalText = "";
  errors.push({ label: "stale save (409, excerpt removed)", text: JSON.stringify(reviewCopy) });
  for (const [label, method, url, body, status] of [
    [
      "unknown todoId",
      "POST",
      "/api/assistant/preparations",
      { requestId: randomUUID(), briefingId: briefing.id, todoId: SECRET_TOKEN },
      409,
    ],
    [
      "unknown field",
      "PATCH",
      editUrl,
      { expectedRevision: 3, draft, checklist, questions: [], state: "open", note: SECRET_TOKEN },
      400,
    ],
    [
      "over-long draft",
      "PATCH",
      editUrl,
      {
        expectedRevision: 3,
        draft: `${SECRET_SENTENCE} `.repeat(200),
        checklist,
        questions: [],
        state: "open",
      },
      400,
    ],
    ["non-UUID id", "GET", "/api/assistant/preparations/not-a-uuid", undefined, 400],
  ] as const) {
    const r = await call<{ error?: string }>(base, method, url, body);
    check(r.status === status, `${label} -> ${r.status} (want ${status})`);
    errors.push({ label, text: r.text });
  }

  // A failed composition whose CLI stderr echoes the source text: a visible failed run, no leak.
  const failing = await call<RunResponse>(base, "POST", "/api/assistant/preparations", {
    requestId: randomUUID(),
    briefingId: briefing.id,
    todoId: FAILING_TODO,
  });
  const failedRun = await waitRun(base, want(failing, 202, "POST failing preparation").run.id);
  check(failedRun.state === "failed", `failing composition run ${failedRun.state} (want failed)`);
  const failedText = (await call<RunResponse>(base, "GET", `/api/assistant/runs/${failedRun.id}`))
    .text;
  errors.push({ label: "failed composition run", text: failedText });

  const packet = want(
    await call<PacketResponse>(base, "GET", editUrl),
    200,
    "GET packet after edits",
  ).packet;
  const list = want(
    await call<PacketListResponse>(base, "GET", "/api/assistant/preparations"),
    200,
    "GET preparations",
  );
  return { packet, list, briefing, errors, failedRun };
}

async function secondLife(
  base: string,
  composer: FakeComposer,
  before: JourneyResult,
): Promise<void> {
  const id = before.packet.id;
  const packet = want(
    await call<PacketResponse>(base, "GET", `/api/assistant/preparations/${id}`),
    200,
    "GET packet after restart",
  ).packet;
  if (!isDeepStrictEqual(packet, before.packet)) {
    fail("packet after restart differs from the packet before close");
  }
  check(
    packet.revision === 3 && packet.state === "handled" && packet.checklist[0]?.done === true,
    "packet after restart lost its revision / handled state / checkbox",
  );
  const list = want(
    await call<PacketListResponse>(base, "GET", "/api/assistant/preparations"),
    200,
    "GET preparations after restart",
  );
  if (!isDeepStrictEqual(list, before.list)) fail("saved list after restart differs");
  const { briefing } = want(
    await call<LatestBriefingResponse>(base, "GET", "/api/assistant/briefings/latest"),
    200,
    "GET latest briefing after restart",
  );
  if (!isDeepStrictEqual(briefing, before.briefing)) fail("latest briefing after restart differs");
  // Same Todo again: the existing packet, no model call.
  const again = want(
    await call<PacketResponse>(base, "POST", "/api/assistant/preparations", {
      requestId: randomUUID(),
      briefingId: before.briefing.id,
      todoId: JOURNEY_TODO,
    }),
    200,
    "POST preparations (existing packet)",
  ).packet;
  check(again.id === id && again.revision === 3, "re-prepare did not return the saved packet");
  check(composer.calls.length === 0, "re-prepare after restart called the composer");
}

// --- part 3: real SQLite, no mocks -------------------------------------------------------------

function sqliteCheck(dir: string): void {
  const paths = { privateDir: dir };
  const store = AssistantStore.open(paths);
  const probe = new DatabaseSync(assistantDbFile(paths), { readOnly: true });
  const version = Number(
    (probe.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
  );
  probe.close();
  check(version === 1, `fresh store user_version ${version} (want 1)`);
  const now = new Date().toISOString();
  const runId = randomUUID();
  store.insertRun({
    id: runId,
    requestId: randomUUID(),
    requestHash: requestHash(["prepare", "sqlite-smoke"]),
    kind: "prepare",
    createdAt: now,
    sourceTodoId: "sqlite-smoke#1",
  });
  const packet: PreparationPacket = {
    id: randomUUID(),
    todoId: "sqlite-smoke#1",
    sourceRef: {
      todoId: "sqlite-smoke#1",
      source: "gmail",
      sender: "sqlite@example.test",
      context: "SQLite smoke",
      messageDate: now,
      link: "",
      originalText: "Synthetic SQLite smoke body",
      action: "Check the store",
      extractionStatus: "done",
    },
    createdAt: now,
    updatedAt: now,
    revision: 1,
    state: "open",
    draft: "Draft",
    checklist: [{ id: randomUUID(), text: "Step one", done: false }],
    questions: [],
    model: "sqlite-smoke",
    promptVersion: "sqlite-smoke",
  };
  check(store.commitPacket(runId, packet) !== null, "commitPacket wrote nothing");
  const saved = store.savePacket(
    packet.id,
    {
      expectedRevision: 1,
      draft: "Draft, edited",
      checklist: packet.checklist.map((c) => ({ ...c, done: true })),
      questions: ["Q?"],
      state: "handled",
    },
    new Date().toISOString(),
  );
  check(saved?.revision === 2, "savePacket did not reach revision 2");
  store.close();
  const reopened = AssistantStore.open(paths);
  try {
    if (!isDeepStrictEqual(reopened.getPacket(packet.id), saved)) {
      fail("SQLite reopen did not read back the identical packet");
    }
    check(reopened.getRun(runId)?.state === "succeeded", "SQLite run is not succeeded");
  } finally {
    reopened.close();
  }
}

// --- main --------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const t0 = Date.now();
  const root = await mkdtemp(path.join(tmpdir(), "yarvis-assistant-smoke-"));
  const privateDir = path.join(root, "private");
  const sqliteDir = path.join(root, "sqlite-only");
  const seedFile = path.join(root, "sheet-seed.json");
  const capture = captureOutput();
  let server: StartedServer | undefined;
  let cleaning: Promise<void> | undefined;
  const cleanup = () =>
    (cleaning ??= (async () => {
      const s = server;
      server = undefined;
      await s?.close().catch(() => undefined);
      capture.restore();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
        () => undefined,
      );
    })());
  const onSignal = (signal: NodeJS.Signals) => {
    void cleanup().finally(() => {
      console.error(`assistant smoke FAILED: interrupted by ${signal}`);
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  for (const s of SIGNALS) process.on(s, onSignal);
  const budget = setTimeout(() => {
    void cleanup().finally(() => {
      console.error(`assistant smoke FAILED: over the ${BUDGET_MS} ms budget`);
      process.exit(1);
    });
  }, BUDGET_MS);
  // Deliberately NOT unref'd: it keeps the loop alive, so a stalled await fails at the budget
  // instead of the loop draining and the process exiting 0 (cleared in `finally`).

  try {
    await runSetup(resolvePaths({ YARVIS_PRIVATE_DIR: privateDir }, REPO_ROOT));
    const seed = loadSheetSeed();
    seed.Todos.push(
      plantedTodo(JOURNEY_TODO, 1, "Planted smoke request"),
      plantedTodo(FAILING_TODO, 0, "Planted failing request"),
    );
    await writeFile(seedFile, JSON.stringify(seed));
    const env = {
      YARVIS_FAKE: "1",
      YARVIS_PRIVATE_DIR: privateDir,
      PORT: "0",
      [FAKE_SHEET_SEED_ENV]: seedFile,
    };

    const composer1 = smokeComposer();
    server = await startServer(env, REPO_ROOT, { composer: composer1 });
    const port1 = server.port;
    const before = await firstLife(server.url, composer1);
    const s1 = server;
    server = undefined;
    await s1.close();

    const composer2 = smokeComposer();
    server = await startServer(env, REPO_ROOT, { composer: composer2 });
    const port2 = server.port;
    await secondLife(server.url, composer2, before);
    const s2 = server;
    server = undefined;
    await s2.close();

    // Privacy: captured server output and every error body.
    const logs = capture.text();
    check(
      logs.includes("/api/assistant/preparations"),
      "captured output has no access-log lines (capture is not working)",
    );
    check(!containsPlanted(logs), "planted secret-like text appeared in server output");
    const leaked = before.errors.filter((e) => containsPlanted(e.text)).map((e) => e.label);
    check(leaked.length === 0, `planted text in error responses: ${leaked.join(", ")}`);
    check(
      before.failedRun.errorCode === "compose_failed",
      `failed run errorCode ${String(before.failedRun.errorCode)}`,
    );
    check(
      PLANTED.every((p) => before.packet.sourceRef.originalText.includes(p)),
      "positive control: stored source excerpt does not hold the planted text",
    );

    sqliteCheck(sqliteDir);

    const ms = Date.now() - t0;
    check(ms < BUDGET_MS, `took ${ms} ms (budget ${BUDGET_MS} ms)`);
    capture.restore();
    console.log(
      `assistant smoke OK: briefing -> prepare -> edit -> handled -> restart (ports ${port1}, ${port2}) reopened packet revision ${before.packet.revision} identical; ` +
        `privacy: ${before.errors.length} error bodies + ${logs.length} chars of server output clean; real SQLite init/write/read OK; ${ms} ms`,
    );
    return 0;
  } catch (err) {
    capture.restore();
    const message =
      err instanceof SmokeFailure
        ? err.message
        : err instanceof Error
          ? `${err.name}: ${err.message}`
          : String(err);
    console.error(`assistant smoke FAILED: ${message}`);
    return 1;
  } finally {
    clearTimeout(budget);
    await cleanup();
    for (const s of SIGNALS) process.off(s, onSignal);
  }
}

/**
 * Fail-closed exit status: non-zero from the start, lowered only to the code `run` resolves with. A
 * run that never settles (the loop drains with nothing pending) or throws therefore exits 1, never 0.
 */
export function runFailClosed(
  run: () => Promise<number>,
  proc: { exitCode?: number | string | null } = process,
): Promise<void> {
  proc.exitCode = 1;
  return run().then(
    (code) => {
      proc.exitCode = code;
    },
    () => {
      proc.exitCode = 1;
    },
  );
}

if (isMainModule(import.meta.url)) {
  void runFailClosed(main);
}

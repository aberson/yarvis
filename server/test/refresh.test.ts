// The refresh pipeline (plan §4, D3, D16-D20) through its production entry point `runRefresh`, with
// the production fake wiring of all five seams (createFakeSeams: FakeWhatsApp, FakeGmail, FakeJev,
// FakeClaude, FakeSheets) over a temp private dir seeded with settings.example.json.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as realDelay } from "node:timers/promises";
import type { ChildProcess } from "node:child_process";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuarantineItem, RefreshStatus, Settings, Todo } from "@yarvis/shared";
import { EXPECTED } from "../fixtures/manifest.js";
import { ClaudeExtractor, killProcessTree, type Extractor } from "../src/ai/extract.js";
import type { Jev } from "../src/ai/jev.js";
import { loadSettings, writeSettings } from "../src/config/settings.js";
import { QUARANTINE, TODOS } from "../src/connectors/sheets.js";
import { DisconnectReason } from "../src/connectors/whatsapp.js";
import { FakeClaude, loadClaudeSeed } from "../src/fakes/claude.js";
import { FakeJev, loadJevSeed } from "../src/fakes/jev.js";
import { createFakeSheets, type FakeSheets } from "../src/fakes/sheets.js";
import { OPEN_STEP, type FakeWhatsAppOptions } from "../src/fakes/whatsapp.js";
import {
  ABANDON_GRACE_MS,
  acquireLock,
  isPidAlive,
  JOB_CEILING_MS,
  LockHeldError,
} from "../src/lock.js";
import { decisionsFile, messagesFile } from "../src/pipeline/cache.js";
import { STAGE_TIMEOUT_ERROR } from "../src/pipeline/errors.js";
import { runRefresh } from "../src/pipeline/refresh.js";
import { createFakeSeams, type PipelineSeams } from "../src/pipeline/seams.js";
import { readState } from "../src/pipeline/state.js";
import { DEFAULT_RETRY } from "../src/util/retry.js";
import { REPO_ROOT, type Paths } from "../src/config/paths.js";
import type { GmailConnector } from "../src/connectors/gmail.js";
import type { SheetsStore } from "../src/connectors/sheets.js";
import { createApp } from "../src/index.js";
import { tempPaths } from "./helpers.js";

/** Fixture ids (server/fixtures): a phishing and a spam Gmail message, actionable Gmail/WhatsApp. */
const PHISHING = "gmail:19a0c0ffee000004";
const SPAM = "gmail:19a0c0ffee000002";
const ACTIONABLE = "gmail:19a0c0ffee000001";
const WA_ACTIONABLE = "wa:15555550123@s.whatsapp.net:3EB0FAKE000000000001";
/** Latest allowlisted WhatsApp fixture messageTimestamp (whatsapp-events.json). */
const WA_LAST_TS = 1791000000;

const NOTHING_NEW: FakeWhatsAppOptions = { scripts: [[OPEN_STEP]] };
const FAST_WINDOW = { quietMs: 20, maxMs: 2_000 };

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  while (cleanups.length) cleanups.pop()?.();
});

function setup(): { paths: Paths; sheets: FakeSheets } {
  const t = tempPaths({ seedSettings: true });
  cleanups.push(t.cleanup);
  return { paths: t.paths, sheets: createFakeSheets() };
}

function seams(
  sheets: FakeSheets,
  over: Partial<PipelineSeams> & { whatsapp?: FakeWhatsAppOptions } = {},
): PipelineSeams {
  const { whatsapp, ...rest } = over;
  const fake = createFakeSeams({ sheets: sheets.store, whatsapp, waWindow: FAST_WINDOW });
  return { ...fake, ...rest };
}

const run = (paths: Paths, s: PipelineSeams) => runRefresh({ paths, ...s, log: () => undefined });

async function tabs(sheets: FakeSheets): Promise<{ todos: Todo[]; quarantine: QuarantineItem[] }> {
  return {
    todos: await sheets.store.readRows(TODOS),
    quarantine: await sheets.store.readRows(QUARANTINE),
  };
}

/** Drives fake setTimeout while real fs I/O runs, until `cond()` (bounded in REAL time). */
async function driveUntil(cond: () => boolean): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (!cond() && performance.now() < deadline) {
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(FAST_WINDOW.quietMs);
  }
  expect(cond()).toBe(true);
}

const readOrMissing = (file: string): string | null =>
  existsSync(file) ? readFileSync(file, "utf8") : null;

/** Resolves with `p` if it settles within 10 s of REAL time (fake timers are not advanced). */
async function settlesWithoutAdvancingTime<T>(p: Promise<T>): Promise<T> {
  const stuck = Symbol("stuck");
  const r = await Promise.race([p, realDelay(10_000).then(() => stuck)]);
  expect(r).not.toBe(stuck);
  return r as T;
}

/** Row counts, after asserting no id appears twice in the raw grid (readRows dedups). */
function counts(sheets: FakeSheets): { todos: number; quarantine: number } {
  const out = { todos: 0, quarantine: 0 };
  for (const [tab, key] of [
    [TODOS.name, "todos"],
    [QUARANTINE.name, "quarantine"],
  ] as const) {
    const ids = sheets.api
      .grid(tab)
      .slice(1)
      .map((r) => r[0]);
    expect(new Set(ids).size).toBe(ids.length);
    out[key] = ids.length;
  }
  return out;
}

describe("runRefresh with all fakes", () => {
  it("quarantines the phishing fixture before extraction, writes the actionable to-do, matches the manifest, advances the cursors, and a second run makes no Jev/Claude calls or writes", async () => {
    const { paths, sheets } = setup();
    const jev = new FakeJev();
    const claude = new FakeClaude();
    const status = await run(paths, seams(sheets, { jev, extractor: claude }));
    expect(status.state).toBe("done");

    expect(counts(sheets)).toEqual(EXPECTED);
    const { todos, quarantine } = await tabs(sheets);
    expect(jev.calls.map((m) => m.id)).toContain(PHISHING);
    expect(quarantine.find((q) => q.id === PHISHING)).toMatchObject({
      reason: "phishing≥0.50,malicious≥0.50",
      jev_phishing: 0.97,
      released_at: "",
    });
    expect(claude.calls.filter((c) => c.input.id === PHISHING)).toEqual([]);
    expect(todos.some((t) => t.id.startsWith(`${PHISHING}#`))).toBe(false);
    expect(todos.find((t) => t.id === `${ACTIONABLE}#1`)).toMatchObject({
      source: "gmail",
      status: "open",
      extraction_status: "done",
      action: (loadClaudeSeed()[ACTIONABLE] as string[])[0],
      jev_action: 0.91,
    });
    expect(await readState(paths)).toEqual({
      gmail: { lastRunAt: status.startedAt },
      whatsapp: { lastRunAt: status.startedAt, lastMessageTs: WA_LAST_TS },
    });

    const writes = sheets.api.writes().length;
    const jev2 = new FakeJev();
    const claude2 = new FakeClaude();
    const again = await run(paths, seams(sheets, { jev: jev2, extractor: claude2 }));
    expect(again.state).toBe("done");
    expect(jev2.calls).toEqual([]);
    expect(claude2.calls).toEqual([]);
    expect(sheets.api.writes()).toHaveLength(writes);
    expect(counts(sheets)).toEqual(EXPECTED);
  });

  it("a Jev outage fails closed with no sheet writes and no cursor move, reports only a fixed error phrase; the next healthy run screens and writes those messages exactly once", async () => {
    const { paths, sheets } = setup();
    const down = new FakeJev();
    // A service error whose library text echoes the request (message content).
    down.setOutage('upstream 503: {"state":{"body":"Hey! Can you pick up Maya from soccer"}}');
    const claude = new FakeClaude();
    const failed = await run(paths, seams(sheets, { jev: down, extractor: claude }));
    expect(failed.state).toBe("error");
    expect(failed.stages.jev).toMatchObject({
      state: "error",
      error: "jev unavailable (HTTP 503)",
    });
    expect(JSON.stringify(failed)).not.toMatch(/Maya|upstream|body/);
    expect([failed.stages.extract.state, failed.stages.sheets.state]).toEqual([
      "skipped",
      "skipped",
    ]);
    expect(sheets.api.writes()).toEqual([]);
    expect(claude.calls).toEqual([]);
    expect(existsSync(paths.stateFile)).toBe(false);

    const jev = new FakeJev();
    const ok = await run(paths, seams(sheets, { jev, extractor: claude, whatsapp: NOTHING_NEW }));
    expect(ok.state).toBe("done");
    const screened = jev.calls.map((m) => m.id);
    expect(new Set(screened).size).toBe(screened.length);
    expect(screened).toEqual(expect.arrayContaining([PHISHING, ACTIONABLE, WA_ACTIONABLE]));
    expect(counts(sheets)).toEqual(EXPECTED);
  });

  it("a Sheets failure past its retries ends error with no cursor move; the next run writes the same rows exactly once with no new Jev/Claude calls", async () => {
    const { paths, sheets } = setup();
    sheets.api.failNext("values.append", 503, DEFAULT_RETRY.attempts);
    const failed = await run(paths, seams(sheets));
    expect(failed.state).toBe("error");
    expect(failed.stages.sheets.state).toBe("error");
    expect(failed.stages.sheets.error).toBe("sheets error (HTTP 503)");
    expect(existsSync(paths.stateFile)).toBe(false);

    const jev = new FakeJev();
    const claude = new FakeClaude();
    const ok = await run(paths, seams(sheets, { jev, extractor: claude, whatsapp: NOTHING_NEW }));
    expect(ok.state).toBe("done");
    expect(jev.calls).toEqual([]);
    expect(claude.calls).toEqual([]);
    expect(counts(sheets)).toEqual(EXPECTED);
  });

  it("a per-message Jev rejection skips only that message, never extracts it, and quarantines it as jev_error after 3 attempts", async () => {
    const { paths, sheets } = setup();
    const jev = new FakeJev({ ...loadJevSeed(), [ACTIONABLE]: "reject" });
    const claude = new FakeClaude();
    const first = await run(paths, seams(sheets, { jev, extractor: claude }));
    expect(first.state).toBe("done");
    expect(first.stages.jev).toMatchObject({ state: "done", error: "jev rejected 1 message" });
    let { todos, quarantine } = await tabs(sheets);
    expect(todos.some((t) => t.id === `${WA_ACTIONABLE}#1`)).toBe(true);
    expect(todos.some((t) => t.id.startsWith(`${ACTIONABLE}#`))).toBe(false);
    expect(quarantine.some((q) => q.id === ACTIONABLE)).toBe(false);

    for (let i = 0; i < 2; i++) {
      await run(paths, seams(sheets, { jev, extractor: claude, whatsapp: NOTHING_NEW }));
    }
    expect(jev.calls.filter((m) => m.id === ACTIONABLE)).toHaveLength(3);
    expect(claude.calls.filter((c) => c.input.id === ACTIONABLE)).toEqual([]);
    ({ todos, quarantine } = await tabs(sheets));
    expect(quarantine.find((q) => q.id === ACTIONABLE)).toMatchObject({
      reason: "jev_error",
      jev_phishing: null,
      released_at: "",
    });
    expect(todos.some((t) => t.id.startsWith(`${ACTIONABLE}#`))).toBe(false);
  });

  it("a WhatsApp failure still lets Gmail reach the sheet and ends partial; only the Gmail cursor moves", async () => {
    const { paths, sheets } = setup();
    const status = await run(
      paths,
      seams(sheets, { whatsapp: { scripts: [[{ close: DisconnectReason.loggedOut }]] } }),
    );
    expect(status.state).toBe("partial");
    expect(status.stages.whatsapp.state).toBe("error");
    expect(status.stages.whatsapp.error).toBe("relink required (run yarvis wa:link --reset)");
    const { todos } = await tabs(sheets);
    expect(todos.some((t) => t.id === `${ACTIONABLE}#1`)).toBe(true);
    expect(todos.some((t) => t.id === `${WA_ACTIONABLE}#1`)).toBe(false);
    expect(await readState(paths)).toEqual({ gmail: { lastRunAt: status.startedAt } });
  });

  it("an extraction failure writes the row pending; the retry fills it while an operator 'done' and created_at survive", async () => {
    const { paths, sheets } = setup();
    const failing = new FakeClaude({ ...loadClaudeSeed(), [ACTIONABLE]: "fail" });
    const first = await run(paths, seams(sheets, { extractor: failing }));
    expect(first.stages.extract).toMatchObject({
      state: "done",
      error: "extraction pending for 1 message (retried next refresh)",
    });
    const pending = (await tabs(sheets)).todos.find((t) => t.id === `${ACTIONABLE}#1`) as Todo;
    expect(pending).toMatchObject({ extraction_status: "pending", status: "open" });
    expect(pending.action).toBe(pending.original_text);

    await sheets.store.updateRow(TODOS, pending.id, {
      status: "done",
      updated_at: "2026-10-19T12:00:00.000Z",
    });
    const claude = new FakeClaude();
    await run(paths, seams(sheets, { extractor: claude, whatsapp: NOTHING_NEW }));
    expect(claude.calls.map((c) => c.input.id)).toEqual([ACTIONABLE]);
    expect((await tabs(sheets)).todos.find((t) => t.id === pending.id)).toMatchObject({
      extraction_status: "done",
      action: (loadClaudeSeed()[ACTIONABLE] as string[])[0],
      status: "done",
      created_at: pending.created_at,
    });
  });

  it("a [] extraction is terminal: the row is extraction_status none and the next run makes no Claude call", async () => {
    const { paths, sheets } = setup();
    const seed = loadClaudeSeed();
    delete seed[WA_ACTIONABLE];
    await run(paths, seams(sheets, { extractor: new FakeClaude(seed) }));
    const row = (await tabs(sheets)).todos.find((t) => t.id === `${WA_ACTIONABLE}#1`);
    expect(row).toMatchObject({ extraction_status: "none" });
    expect(row?.action).toBe(row?.original_text);

    const claude = new FakeClaude();
    await run(paths, seams(sheets, { extractor: claude, whatsapp: NOTHING_NEW }));
    expect(claude.calls).toEqual([]);
  });

  it("raising thresholds.quarantine releases a quarantined fixture (released_at set, row kept) with no Jev call", async () => {
    const { paths, sheets } = setup();
    await run(paths, seams(sheets));
    const settings: Settings = await loadSettings(paths);
    await writeSettings(paths, {
      ...settings,
      jev: { ...settings.jev, thresholds: { ...settings.jev.thresholds, quarantine: 0.98 } },
    });
    const jev = new FakeJev();
    const status = await run(paths, seams(sheets, { jev, whatsapp: NOTHING_NEW }));
    expect(status.state).toBe("done");
    expect(jev.calls).toEqual([]);
    const { quarantine } = await tabs(sheets);
    expect(quarantine).toHaveLength(EXPECTED.quarantine);
    for (const id of [PHISHING, SPAM]) {
      const row = quarantine.find((q) => q.id === id);
      expect(row?.released_at).not.toBe("");
      expect(Date.parse(row?.released_at ?? "")).not.toBeNaN();
    }
  });

  it("refuses while private/refresh.lock is held, with no writes", async () => {
    const { paths, sheets } = setup();
    const lock = await acquireLock(paths.lockFile);
    try {
      const jev = new FakeJev();
      await expect(run(paths, seams(sheets, { jev }))).rejects.toBeInstanceOf(LockHeldError);
      expect(sheets.api.calls).toEqual([]);
      expect(jev.calls).toEqual([]);
      expect(existsSync(paths.cacheDir)).toBe(false);
      expect(existsSync(paths.stateFile)).toBe(false);
    } finally {
      await lock.release();
    }
  });

  it("the 15 min job ceiling reports stage timeout at once, refuses new jobs while the abandoned stage runs, and frees the lock after the abandon grace", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { paths, sheets } = setup();
    let jevEntered = false;
    const stuck: Jev = {
      classify: () => {
        jevEntered = true;
        return new Promise<never>(() => undefined);
      },
    };
    const seen: RefreshStatus[] = [];
    let settled = false;
    const job = runRefresh(
      { paths, ...seams(sheets, { jev: stuck, whatsapp: NOTHING_NEW }), log: () => undefined },
      { onStatus: (s) => seen.push(s) },
    );
    void job.then(() => (settled = true));
    await driveUntil(() => jevEntered);
    await vi.advanceTimersByTimeAsync(JOB_CEILING_MS);
    const messagesAtCeiling = readOrMissing(messagesFile(paths));

    const reported = seen.at(-1) as RefreshStatus;
    expect(reported.state).toBe("error");
    expect(reported.stages.jev).toMatchObject({ state: "error", error: STAGE_TIMEOUT_ERROR });
    expect([reported.stages.extract.state, reported.stages.sheets.state]).toEqual([
      "skipped",
      "skipped",
    ]);
    expect(settled).toBe(false);
    await expect(run(paths, seams(sheets))).rejects.toBeInstanceOf(LockHeldError);

    await vi.advanceTimersByTimeAsync(ABANDON_GRACE_MS);
    expect(await job).toEqual(reported);
    expect(sheets.api.writes()).toEqual([]);
    expect(readOrMissing(messagesFile(paths))).toBe(messagesAtCeiling);
    expect(existsSync(paths.stateFile)).toBe(false);
    await (await acquireLock(paths.lockFile)).release();
  });

  it("no messages-cache append lands from a Gmail fetch that returns after the ceiling", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { paths, sheets } = setup();
    const fake = createFakeSeams({ sheets: sheets.store });
    let entered = false;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    // An in-flight fetch that ignores cancellation and still delivers messages afterwards.
    const lateGmail: GmailConnector = {
      fetchSince: async (cursor, known) => {
        entered = true;
        await gate;
        return fake.gmail.fetchSince(cursor, known);
      },
    };
    const job = run(paths, seams(sheets, { gmail: lateGmail, whatsapp: NOTHING_NEW }));
    await driveUntil(() => entered);
    await vi.advanceTimersByTimeAsync(JOB_CEILING_MS);
    const messagesAtCeiling = readOrMissing(messagesFile(paths));

    open();
    const status = await job;
    expect(status.stages.gmail).toMatchObject({ state: "error", error: STAGE_TIMEOUT_ERROR });
    expect(readOrMissing(messagesFile(paths))).toBe(messagesAtCeiling);
    expect(existsSync(decisionsFile(paths))).toBe(false);
    expect(existsSync(paths.stateFile)).toBe(false);
  });

  it("no sheet upsert, sync marker or state.json write lands when the sheets stage resumes after the ceiling", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { paths, sheets } = setup();
    let entered = false;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let quarantineReads = 0;
    // The sheets stage's Quarantine read (the 2nd one; the extract stage made the 1st) stalls.
    const stalling: SheetsStore = {
      ...sheets.store,
      readRows: async (spec) => {
        if (spec.name === QUARANTINE.name && ++quarantineReads === 2) {
          entered = true;
          await gate;
        }
        return sheets.store.readRows(spec);
      },
    };
    const job = run(paths, seams(sheets, { sheets: stalling, whatsapp: NOTHING_NEW }));
    await driveUntil(() => entered);
    await vi.advanceTimersByTimeAsync(JOB_CEILING_MS);
    const decisionsAtCeiling = readFileSync(decisionsFile(paths), "utf8");

    open();
    const status = await job;
    expect(status.stages.sheets).toMatchObject({ state: "error", error: STAGE_TIMEOUT_ERROR });
    expect(sheets.api.writes()).toEqual([]);
    expect(readFileSync(decisionsFile(paths), "utf8")).toBe(decisionsAtCeiling);
    expect(decisionsAtCeiling).not.toContain("sheetSyncedAt");
    expect(existsSync(paths.stateFile)).toBe(false);
  });

  it("the ceiling tree-kills a running claude child, so the job settles without waiting out the grace", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { paths, sheets } = setup();
    const killed: Array<number | undefined> = [];
    // The hang-mode stub writes {pid, grandchildPid} once it is running.
    const capture = path.join(paths.privateDir, "claude-capture.json");
    const claude = new ClaudeExtractor({
      model: "claude-haiku-5-5",
      binary: process.execPath,
      binaryArgs: [path.join(REPO_ROOT, "server", "test", "stubs", "claude-stub.mjs")],
      env: { ...process.env, STUB_MODE: "hang", STUB_CAPTURE: capture },
      timeoutMs: 60 * 60_000, // never the reason the child dies here
      killTree: async (child: ChildProcess) => {
        killed.push(child.pid);
        await killProcessTree(child);
      },
    });
    const job = run(paths, seams(sheets, { extractor: claude, whatsapp: NOTHING_NEW }));
    await driveUntil(() => existsSync(capture) && readFileSync(capture, "utf8").includes("pid"));
    const { pid, grandchildPid } = JSON.parse(readFileSync(capture, "utf8")) as {
      pid: number;
      grandchildPid: number;
    };
    await vi.advanceTimersByTimeAsync(JOB_CEILING_MS);

    const status = await settlesWithoutAdvancingTime(job);
    expect(killed).toEqual([pid]);
    await expect
      .poll(() => isPidAlive(grandchildPid), { interval: 50, timeout: 5_000 })
      .toBe(false);
    expect(status.stages.extract).toMatchObject({ state: "error", error: STAGE_TIMEOUT_ERROR });
    expect(sheets.api.writes()).toEqual([]);
  });

  it("the ceiling ends the WhatsApp socket, so a long drain returns and the job settles without the grace", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { paths, sheets } = setup();
    // A drain that would otherwise wait 1 h for quiet.
    const fake = createFakeSeams({
      sheets: sheets.store,
      whatsapp: NOTHING_NEW,
      waWindow: { quietMs: 60 * 60_000, maxMs: 2 * 60 * 60_000 },
    });
    const sockets = fake.fakes.whatsapp.sockets;
    const job = run(paths, fake);
    await driveUntil(() => sockets.length === 1);
    await vi.advanceTimersByTimeAsync(JOB_CEILING_MS);

    const status = await settlesWithoutAdvancingTime(job);
    expect(sockets[0]?.endCalls).toBeGreaterThanOrEqual(1);
    expect(status.stages.whatsapp).toMatchObject({ state: "error", error: STAGE_TIMEOUT_ERROR });
    expect(existsSync(messagesFile(paths))).toBe(false);
  });
  it("an abandoned stage that settles after the ceiling writes nothing, and the lock is released once it settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { paths, sheets } = setup();
    let entered = false;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    // Only the actionable Gmail fixture hangs, so its result arrives after the ceiling and would
    // be appended to the decisions cache if the abandoned stage could still write.
    const fast = new FakeClaude();
    const slow: Extractor = {
      extract: async (input) => {
        if (input.id !== ACTIONABLE) return fast.extract(input);
        entered = true;
        await gate;
        return { status: "done", actions: ["a late action"] };
      },
    };
    const job = run(paths, seams(sheets, { extractor: slow, whatsapp: NOTHING_NEW }));
    await driveUntil(() => entered);
    await vi.advanceTimersByTimeAsync(JOB_CEILING_MS);
    await expect(run(paths, seams(sheets))).rejects.toBeInstanceOf(LockHeldError);
    const decisionsAtCeiling = readFileSync(decisionsFile(paths), "utf8");

    open();
    const status = await job;
    expect(status.stages.extract).toMatchObject({ state: "error", error: STAGE_TIMEOUT_ERROR });
    expect(readFileSync(decisionsFile(paths), "utf8")).toBe(decisionsAtCeiling);
    expect(decisionsAtCeiling).not.toContain("a late action");
    expect(sheets.api.writes()).toEqual([]);
    expect(existsSync(paths.stateFile)).toBe(false);
    await (await acquireLock(paths.lockFile)).release();
  });
});

describe("quarantine after sync (D16 threshold change)", () => {
  it("a synced to-do whose message is later quarantined is hidden from GET /api/todos (row kept), and shown again once released", async () => {
    const { paths, sheets } = setup();
    const app = createApp({
      paths,
      fake: true,
      webPort: 5173,
      sheets: sheets.store,
      todosCacheTtlMs: 0,
    });
    const listed = async () =>
      (
        (await request(app).get("/api/todos?status=all").set("Host", "127.0.0.1:5173"))
          .body as Todo[]
      ).map((t) => t.id);
    const setQuarantineThreshold = async (quarantine: number) => {
      const current = await loadSettings(paths);
      await writeSettings(paths, {
        ...current,
        jev: { ...current.jev, thresholds: { ...current.jev.thresholds, quarantine } },
      });
    };
    const id = `${ACTIONABLE}#1`;

    await run(paths, seams(sheets));
    expect(await listed()).toContain(id);

    await setQuarantineThreshold(0.04); // the fixture's spam score is 0.04
    await run(paths, seams(sheets, { whatsapp: NOTHING_NEW }));
    const { todos, quarantine } = await tabs(sheets);
    expect(todos.map((t) => t.id)).toContain(id); // never deleted from the sheet
    expect(quarantine.find((q) => q.id === ACTIONABLE)).toMatchObject({
      reason: "spam≥0.04",
      released_at: "",
    });
    expect(await listed()).not.toContain(id);

    await setQuarantineThreshold(0.5);
    await run(paths, seams(sheets, { whatsapp: NOTHING_NEW }));
    expect((await tabs(sheets)).quarantine.find((q) => q.id === ACTIONABLE)?.released_at).not.toBe(
      "",
    );
    expect(await listed()).toContain(id);
  });
});

describe("cache contents", () => {
  it("decision records hold raw scores and nothing else: no routing flags (D16)", async () => {
    const { paths, sheets } = setup();
    await run(paths, seams(sheets));
    const records = readFileSync(decisionsFile(paths), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      for (const key of Object.keys(record)) {
        expect(["id", "jev", "extraction", "sheetSyncedAt"]).toContain(key);
      }
      expect(Object.keys(record.jev as object).sort()).toEqual(
        ["action", "malicious", "phishing", "spam"].sort(),
      );
    }
  });
});

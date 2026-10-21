// Assistant SQLite store (plan S1.5 "Storage", D43): v1 initializer on a legacy private dir, fail
// closed on corrupt / newer / foreign stores (files preserved byte for byte), the 250 ms busy timeout
// as a retryable AssistantBusyError, request hashing and guarded terminal/result writes.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ASSISTANT_SCHEMA_VERSION, type Briefing, type PreparationPacket } from "@yarvis/shared";
import {
  AssistantBusyError,
  AssistantStore,
  AssistantUnavailableError,
  assistantDbFile,
  BRIEFING_RETENTION,
  RUN_RETENTION,
  requestHash,
} from "../src/assistant/store.js";
import { tempPaths } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function dir() {
  const t = tempPaths({ seedSettings: true });
  cleanups.push(t.cleanup);
  return t.paths;
}

function open(paths: ReturnType<typeof dir>): AssistantStore {
  const store = AssistantStore.open(paths);
  cleanups.push(() => store.close());
  return store;
}

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const REQ_ID = "22222222-2222-4222-8222-222222222222";

function briefing(id: string, previous: Briefing | null): Briefing {
  return {
    id,
    createdAt: "2026-10-20T10:00:00.000Z",
    sheetReadAt: "2026-10-20T10:00:00.000Z",
    previousBriefingId: previous?.id ?? null,
    openCount: 0,
    omittedCount: 0,
    items: [],
    sourceCoverage: [],
  };
}

function expectUnavailable(fn: () => unknown, reason: AssistantUnavailableError["reason"]): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AssistantUnavailableError);
  expect((caught as AssistantUnavailableError).reason).toBe(reason);
}

describe("AssistantStore.open", () => {
  it("initializes schema v1 in a legacy private dir without changing its existing files", () => {
    const paths = dir();
    writeFileSync(paths.stateFile, '{"cursor":"synthetic"}\n');
    const before = Object.fromEntries(
      readdirSync(paths.privateDir).map((f) => [f, readFileSync(`${paths.privateDir}/${f}`)]),
    );
    const store = open(paths);
    expect(existsSync(assistantDbFile(paths))).toBe(true);
    expect(store.counts()).toEqual({ runs: 0, briefings: 0, packets: 0 });
    for (const [f, bytes] of Object.entries(before)) {
      expect(readFileSync(`${paths.privateDir}/${f}`).equals(bytes)).toBe(true);
    }
    store.close();
    const raw = new DatabaseSync(assistantDbFile(paths));
    expect(
      (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(ASSISTANT_SCHEMA_VERSION);
    raw.close();
  });

  it("reopens an existing v1 store with its data", () => {
    const paths = dir();
    const a = AssistantStore.open(paths);
    a.insertRun({
      id: RUN_ID,
      requestId: REQ_ID,
      requestHash: requestHash(["briefing"]),
      kind: "briefing",
      createdAt: "2026-10-20T10:00:00.000Z",
    });
    a.close();
    const b = open(paths);
    expect(b.getRun(RUN_ID)).toMatchObject({ id: RUN_ID, requestId: REQ_ID, state: "running" });
  });

  it("fails closed on a corrupt file and leaves it byte-identical", () => {
    const paths = dir();
    const file = assistantDbFile(paths);
    const garbage = Buffer.from("not a sqlite database ".repeat(200));
    writeFileSync(file, garbage);
    expectUnavailable(() => AssistantStore.open(paths), "corrupt");
    expect(readFileSync(file).equals(garbage)).toBe(true);
    expect(readdirSync(paths.privateDir).filter((f) => f.startsWith("assistant"))).toEqual([
      "assistant.sqlite",
    ]);
  });

  it("fails closed on a newer schema version and never rewrites it", () => {
    const paths = dir();
    const file = assistantDbFile(paths);
    const raw = new DatabaseSync(file);
    raw.exec("CREATE TABLE future (x TEXT); PRAGMA user_version = 2;");
    raw.close();
    const bytes = readFileSync(file);
    const mtime = statSync(file).mtimeMs;
    expectUnavailable(() => AssistantStore.open(paths), "newer_schema");
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(statSync(file).mtimeMs).toBe(mtime);
  });

  it("refuses a version-0 database that already holds foreign tables", () => {
    const paths = dir();
    const raw = new DatabaseSync(assistantDbFile(paths));
    raw.exec("CREATE TABLE something_else (x TEXT);");
    raw.close();
    expectUnavailable(() => AssistantStore.open(paths), "unknown_schema");
  });

  it("refuses a v1 database whose tables are missing", () => {
    const paths = dir();
    const raw = new DatabaseSync(assistantDbFile(paths));
    raw.exec("PRAGMA user_version = 1;");
    raw.close();
    expectUnavailable(() => AssistantStore.open(paths), "unknown_schema");
  });
});

describe("contention", () => {
  it("a write blocked past the 250 ms busy timeout is a retryable AssistantBusyError", () => {
    const paths = dir();
    const store = open(paths);
    const other = new DatabaseSync(assistantDbFile(paths));
    cleanups.push(() => other.close());
    other.exec("BEGIN EXCLUSIVE");
    const started = Date.now();
    expect(() =>
      store.insertRun({
        id: RUN_ID,
        requestId: REQ_ID,
        requestHash: "h",
        kind: "briefing",
        createdAt: "2026-10-20T10:00:00.000Z",
      }),
    ).toThrow(AssistantBusyError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    other.exec("ROLLBACK");
    // Retry succeeds once the other writer is gone.
    expect(
      store.insertRun({
        id: RUN_ID,
        requestId: REQ_ID,
        requestHash: "h",
        kind: "briefing",
        createdAt: "2026-10-20T10:00:00.000Z",
      }).state,
    ).toBe("running");
  });
});

describe("runs and briefings", () => {
  it("requestHash is SHA-256 hex of the normalized JSON array", () => {
    expect(requestHash(["briefing"])).toMatch(/^[0-9a-f]{64}$/);
    expect(requestHash(["prepare", "a", "b"])).not.toBe(requestHash(["prepare", "b", "a"]));
  });

  it("request ids are unique", () => {
    const store = open(dir());
    const run = {
      id: RUN_ID,
      requestId: REQ_ID,
      requestHash: "h",
      kind: "briefing" as const,
      createdAt: "2026-10-20T10:00:00.000Z",
    };
    store.insertRun(run);
    expect(() => store.insertRun({ ...run, id: "33333333-3333-4333-8333-333333333333" })).toThrow();
    expect(store.findRunByRequestId(REQ_ID)?.requestHash).toBe("h");
    expect(store.findRunByRequestId("44444444-4444-4444-8444-444444444444")).toBeNull();
  });

  it("commits a briefing atomically with success, chaining the previous snapshot", () => {
    const store = open(dir());
    store.insertRun({
      id: RUN_ID,
      requestId: REQ_ID,
      requestHash: "h",
      kind: "briefing",
      createdAt: "2026-10-20T10:00:00.000Z",
    });
    const first = store.commitBriefing(RUN_ID, "2026-10-20T10:00:01.000Z", (prev) =>
      briefing("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", prev),
    );
    expect(first?.previousBriefingId).toBeNull();
    expect(store.getRun(RUN_ID)).toMatchObject({
      state: "succeeded",
      targetId: first?.id,
      finishedAt: "2026-10-20T10:00:01.000Z",
      errorCode: null,
    });
    const run2 = "55555555-5555-4555-8555-555555555555";
    store.insertRun({
      id: run2,
      requestId: "66666666-6666-4666-8666-666666666666",
      requestHash: "h",
      kind: "briefing",
      createdAt: "2026-10-20T10:01:00.000Z",
    });
    const second = store.commitBriefing(run2, "2026-10-20T10:01:01.000Z", (prev) =>
      briefing("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", prev),
    );
    expect(second?.previousBriefingId).toBe(first?.id);
    expect(store.latestBriefing()?.id).toBe(second?.id);
    expect(store.latestRun()?.id).toBe(run2);
  });

  it("a run that already ended cannot publish a late result or be overwritten", () => {
    const store = open(dir());
    store.insertRun({
      id: RUN_ID,
      requestId: REQ_ID,
      requestHash: "h",
      kind: "briefing",
      createdAt: "2026-10-20T10:00:00.000Z",
    });
    expect(store.finishRun(RUN_ID, "failed", "run_timeout", "2026-10-20T10:01:30.000Z")).toBe(true);
    expect(
      store.commitBriefing(RUN_ID, "2026-10-20T10:02:00.000Z", (prev) =>
        briefing("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", prev),
      ),
    ).toBeNull();
    expect(store.finishRun(RUN_ID, "interrupted", "shutdown", "2026-10-20T10:03:00.000Z")).toBe(
      false,
    );
    expect(store.getRun(RUN_ID)).toMatchObject({ state: "failed", errorCode: "run_timeout" });
    expect(store.counts().briefings).toBe(0);
  });

  it("interruptRunning marks every running row abandoned", () => {
    const store = open(dir());
    store.insertRun({
      id: RUN_ID,
      requestId: REQ_ID,
      requestHash: "h",
      kind: "briefing",
      createdAt: "2026-10-20T10:00:00.000Z",
    });
    expect(store.interruptRunning("2026-10-20T11:00:00.000Z")).toBe(1);
    expect(store.getRun(RUN_ID)).toMatchObject({
      state: "interrupted",
      errorCode: "abandoned",
      finishedAt: "2026-10-20T11:00:00.000Z",
    });
    expect(store.interruptRunning("2026-10-20T11:00:00.000Z")).toBe(0);
  });

  it("keeps only the newest BRIEFING_RETENTION snapshots", () => {
    const store = open(dir());
    const total = BRIEFING_RETENTION + 3;
    const ids: string[] = [];
    for (let i = 0; i < total; i++) {
      const hex = i.toString(16).padStart(12, "0");
      const runId = `aaaaaaaa-0000-4000-8000-${hex}`;
      store.insertRun({
        id: runId,
        requestId: `bbbbbbbb-0000-4000-8000-${hex}`,
        requestHash: "h",
        kind: "briefing",
        createdAt: "2026-10-20T10:00:00.000Z",
      });
      const id = `cccccccc-0000-4000-8000-${hex}`;
      ids.push(id);
      store.commitBriefing(runId, "2026-10-20T10:00:01.000Z", (prev) => briefing(id, prev));
    }
    expect(store.counts().briefings).toBe(BRIEFING_RETENTION);
    expect(store.latestBriefing()?.id).toBe(ids[total - 1]);
    // Runs: all are still within RUN_RETENTION, so none are dropped yet.
    expect(store.counts().runs).toBe(Math.min(total, RUN_RETENTION));
  });

  it("a closed store reports unavailable", () => {
    const store = open(dir());
    store.close();
    expectUnavailable(() => store.latestRun(), "closed");
  });
});

describe("run retention covers preparation runs (Step 10)", () => {
  it("finished prepare runs are bounded; a packet's run and the packet are kept", () => {
    const store = open(dir());
    const id = (n: number) => `33333333-3333-4333-8333-${n.toString(16).padStart(12, "0")}`;
    const at = "2026-10-21T10:00:00.000Z";
    store.insertRun({
      id: id(0),
      requestId: id(1),
      requestHash: "h",
      kind: "prepare",
      createdAt: at,
    });
    const packet: PreparationPacket = {
      id: id(2),
      todoId: "gmail:00000000000000aa#1",
      sourceRef: {
        todoId: "gmail:00000000000000aa#1",
        source: "gmail",
        sender: "s@example.test",
        context: "c",
        messageDate: at,
        link: "",
        originalText: "t",
        action: "a",
        extractionStatus: "done",
      },
      createdAt: at,
      updatedAt: at,
      revision: 1,
      state: "open",
      draft: "",
      checklist: [{ id: id(3), text: "x", done: false }],
      questions: [],
      model: "m",
      promptVersion: "compose-v1",
    };
    expect(store.commitPacket(id(0), packet)).toEqual(packet);
    for (let n = 0; n < RUN_RETENTION + 20; n++) {
      const runId = id(0x1000 + n);
      store.insertRun({
        id: runId,
        requestId: id(0x100000 + n),
        requestHash: "h",
        kind: "prepare",
        createdAt: at,
      });
      store.finishRun(runId, "failed", "compose_failed", at);
    }
    expect(store.counts().runs).toBeLessThanOrEqual(RUN_RETENTION + 1);
    expect(store.getRun(id(0))).toMatchObject({ state: "succeeded", targetId: id(2) });
    expect(store.getPacket(id(2))).toEqual(packet);
    expect(store.getRun(id(0x1000))).toBeNull(); // the oldest failed attempt was pruned
  });
});

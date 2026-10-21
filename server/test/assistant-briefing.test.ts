// Briefing composition and the assistant run service (plan S1.5 "Briefing behavior" + "Work and
// recovery"): visibleTodos reuse (quarantine excluded), open only, date-desc + id tie-break, 25 cap
// with full counts, "new to this briefing" vs the previous snapshot, pending/none not eligible,
// failed reads keep the old snapshot, request-id idempotency, one active run (in-process and via the
// cross-process assistant lock), the logical deadline with a late read discarded, startup
// reconciliation under the lock, and close().
import { afterEach, describe, expect, it } from "vitest";
import { BRIEFING_ITEM_CAP, type Briefing } from "@yarvis/shared";
import {
  AssistantBusyError,
  AssistantService,
  AssistantUnavailableError,
  composeBriefing,
  RequestConflictError,
} from "../src/assistant/service.js";
import { AssistantStore, assistantLockFile } from "../src/assistant/store.js";
import {
  gatedSheets,
  plantLiveAssistantLock,
  quarantined,
  todo,
  until,
} from "./assistant-helpers.js";
import { tempPaths } from "./helpers.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { unlink } from "node:fs/promises";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const BOTH = { gmail: true, whatsapp: false };

function compose(todos = [todo(1)], previous: Briefing | null = null, q = [quarantined("x")]) {
  return composeBriefing({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    createdAt: "2026-10-20T10:00:00.000Z",
    sheetReadAt: "2026-10-20T09:59:59.000Z",
    todos,
    quarantine: q,
    previous,
    configured: BOTH,
  });
}

describe("composeBriefing", () => {
  it("excludes quarantined and done rows, keeps released ones, sorts date desc with id tie-break", () => {
    const held = todo(1);
    const released = todo(2);
    const done = todo(3, { status: "done" });
    const sameTimeA = todo(10, { message_date: "2026-10-05T00:00:00.000Z" });
    const sameTimeB = todo(11, { message_date: "2026-10-05T00:00:00.000Z" });
    const older = todo(4, { message_date: "2026-09-01T00:00:00.000Z" });
    const b = compose([held, released, done, older, sameTimeB, sameTimeA], null, [
      quarantined(held.id.replace(/#1$/, "")),
      quarantined(released.id.replace(/#1$/, ""), "2026-10-02T00:00:00.000Z"),
    ]);
    expect(b.items.map((i) => i.sourceRef.todoId)).toEqual([
      sameTimeA.id,
      sameTimeB.id,
      released.id,
      older.id,
    ]);
    expect(b.openCount).toBe(4);
    expect(b.omittedCount).toBe(0);
  });

  it("copies the Todo fields into SourceRef verbatim", () => {
    const t = todo(7, { source: "whatsapp", link: "" });
    expect(compose([t]).items[0]?.sourceRef).toEqual({
      todoId: t.id,
      source: "whatsapp",
      sender: t.sender,
      context: t.context,
      messageDate: t.message_date,
      link: "",
      originalText: t.original_text,
      action: t.action,
      extractionStatus: "done",
    });
  });

  it("caps at 25 items and reports the full open count and the omitted count", () => {
    const rows = Array.from({ length: 30 }, (_, i) => todo(i + 1));
    const b = compose(rows);
    expect(b.items).toHaveLength(BRIEFING_ITEM_CAP);
    expect(b.openCount).toBe(30);
    expect(b.omittedCount).toBe(5);
    // Newest first: the five oldest are the omitted ones.
    expect(b.items.map((i) => i.sourceRef.todoId)).not.toContain(todo(1).id);
  });

  it("pending/none extractions are shown but not preparation-eligible", () => {
    const b = compose([
      todo(1, { extraction_status: "pending", action: "" }),
      todo(2, { extraction_status: "none" }),
      todo(3),
    ]);
    const eligible = Object.fromEntries(
      b.items.map((i) => [i.sourceRef.extractionStatus, i.preparationEligible]),
    );
    expect(eligible).toEqual({ pending: false, none: false, done: true });
  });

  it("the first snapshot is a baseline; later ones flag newly visible items only", () => {
    const first = compose([todo(1), todo(2)]);
    expect(first.previousBriefingId).toBeNull();
    expect(first.items.every((i) => !i.isNew)).toBe(true);
    const second = compose([todo(1), todo(2), todo(3)], first);
    expect(second.previousBriefingId).toBe(first.id);
    expect(second.items.filter((i) => i.isNew).map((i) => i.sourceRef.todoId)).toEqual([
      todo(3).id,
    ]);
  });

  it("reports per-source coverage from configured flags with unknown freshness", () => {
    expect(compose().sourceCoverage).toEqual([
      { source: "gmail", configured: true, freshness: "unknown" },
      { source: "whatsapp", configured: false, freshness: "unknown" },
    ]);
  });

  it("an empty open list is a valid (non-failed) snapshot with zero counts", () => {
    const b = compose([todo(1, { status: "done" })]);
    expect(b).toMatchObject({ openCount: 0, omittedCount: 0, items: [] });
  });
});

const R1 = "10000000-0000-4000-8000-000000000001";
const R2 = "10000000-0000-4000-8000-000000000002";
const R3 = "10000000-0000-4000-8000-000000000003";

function service(
  opts: {
    deadlineMs?: number;
    seed?: Parameters<typeof gatedSheets>[0];
    unlink?: (file: string) => Promise<void>;
  } = {},
) {
  const t = tempPaths();
  const sheets = gatedSheets(opts.seed);
  const warnings: string[] = [];
  const svc = new AssistantService({
    paths: t.paths,
    sheets: sheets.gated,
    configured: () => Promise.resolve(BOTH),
    deadlineMs: opts.deadlineMs,
    warn: (l) => warnings.push(l),
    lockOptions: opts.unlink ? { unlink: opts.unlink } : undefined,
  });
  cleanups.push(t.cleanup);
  cleanups.push(() => svc.close());
  return { svc, sheets, paths: t.paths, warnings };
}

describe("AssistantService briefing runs", () => {
  it("records a running run, then publishes a snapshot from fresh sheet reads", async () => {
    const { svc, sheets } = service();
    const run = await svc.startBriefing(R1);
    expect(run).toMatchObject({
      requestId: R1,
      kind: "briefing",
      state: "running",
      targetId: null,
    });
    await svc.idle();
    const done = svc.getRun(run.id);
    const latest = svc.latestBriefing();
    expect(done).toMatchObject({ state: "succeeded", targetId: latest?.id, errorCode: null });
    expect(latest?.openCount).toBe(4); // seed: 4 open visible to-dos
    expect(latest?.items.find((i) => i.sourceRef.extractionStatus === "pending")).toMatchObject({
      preparationEligible: false,
    });
    expect(sheets.api.writes()).toEqual([]);
  });

  it("a repeated request id returns the same run and never creates a second snapshot", async () => {
    const { svc, paths } = service();
    const a = await svc.startBriefing(R1);
    await svc.idle();
    const b = await svc.startBriefing(R1);
    expect(b.id).toBe(a.id);
    expect(b.state).toBe("succeeded");
    await svc.idle();
    await svc.close();
    const store = AssistantStore.open(paths);
    expect(store.counts()).toMatchObject({ runs: 1, briefings: 1 });
    store.close();
  });

  it("a request id reused with different input is a conflict", async () => {
    const { svc, paths } = service();
    await svc.startBriefing(R2);
    await svc.idle();
    const store = AssistantStore.open(paths);
    store.insertRun({
      id: "20000000-0000-4000-8000-000000000001",
      requestId: R1,
      requestHash: "different-input",
      kind: "prepare",
      createdAt: "2026-10-20T10:00:00.000Z",
    });
    store.interruptRunning("2026-10-20T10:00:01.000Z");
    store.close();
    await expect(svc.startBriefing(R1)).rejects.toBeInstanceOf(RequestConflictError);
  });

  it("one tab failing fast keeps the lock until the other read settles, then fails", async () => {
    const { svc, sheets, paths } = service();
    const gate = sheets.hold(); // the Quarantine read is held open...
    sheets.failNextRead(); // ...while the Todos read rejects at once
    const run = await svc.startBriefing(R1);
    await gate.started;
    await new Promise((r) => setTimeout(r, 30));
    expect(svc.getRun(run.id)?.state).toBe("running");
    expect(existsSync(assistantLockFile(paths))).toBe(true);
    await expect(svc.startBriefing(R2)).rejects.toBeInstanceOf(AssistantBusyError);
    gate.release();
    await svc.idle();
    expect(svc.getRun(run.id)).toMatchObject({ state: "failed", errorCode: "source_unavailable" });
    expect(svc.latestBriefing()).toBeNull();
    expect(existsSync(assistantLockFile(paths))).toBe(false);
  });

  it("the next successful snapshot flags items new since the previous one", async () => {
    const { svc, sheets } = service();
    await svc.startBriefing(R1);
    await svc.idle();
    const first = svc.latestBriefing();
    await sheets.store.upsertRows((await import("../src/connectors/sheets.js")).TODOS, [
      todo(99, { message_date: "2026-10-19T00:00:00.000Z" }),
    ]);
    await svc.startBriefing(R2);
    await svc.idle();
    const second = svc.latestBriefing();
    expect(second?.previousBriefingId).toBe(first?.id);
    expect(second?.items.filter((i) => i.isNew).map((i) => i.sourceRef.todoId)).toEqual([
      todo(99).id,
    ]);
  });

  it("one active run: a second request is busy (no queuing) until the first settles", async () => {
    const { svc, sheets } = service();
    const gate = sheets.hold();
    const first = await svc.startBriefing(R1);
    await gate.started;
    await expect(svc.startBriefing(R2)).rejects.toBeInstanceOf(AssistantBusyError);
    // The same request id is still answered while busy (looked up before admission).
    expect((await svc.startBriefing(R1)).id).toBe(first.id);
    gate.release();
    await svc.idle();
    expect((await svc.startBriefing(R3)).state).toBe("running");
  });

  it("past the deadline: failed/run_timeout, lock kept until the read settles, late result discarded", async () => {
    const { svc, sheets, paths } = service({ deadlineMs: 50 });
    const gate = sheets.hold();
    const run = await svc.startBriefing(R1);
    await until(() => svc.getRun(run.id)?.state !== "running");
    expect(svc.getRun(run.id)).toMatchObject({ state: "failed", errorCode: "run_timeout" });
    // The read is still outstanding: the lock is held and a new request stays busy.
    expect(existsSync(assistantLockFile(paths))).toBe(true);
    await expect(svc.startBriefing(R2)).rejects.toBeInstanceOf(AssistantBusyError);
    const readsBefore = sheets.reads;
    gate.release();
    await svc.idle();
    expect(svc.getRun(run.id)).toMatchObject({ state: "failed", errorCode: "run_timeout" });
    expect(svc.latestBriefing()).toBeNull();
    expect(sheets.reads).toBe(readsBefore); // the late result triggered no further work
    expect(existsSync(assistantLockFile(paths))).toBe(false);
  });
});

describe("AssistantService recovery and close", () => {
  function plantRunning(paths: ReturnType<typeof tempPaths>["paths"]): string {
    const store = AssistantStore.open(paths);
    const id = "30000000-0000-4000-8000-000000000001";
    store.insertRun({
      id,
      requestId: R3,
      requestHash: "h",
      kind: "briefing",
      createdAt: "2026-10-20T10:00:00.000Z",
    });
    store.close();
    return id;
  }

  it("init leaves a running row alone while a live owner holds the lock, then reconciles it", async () => {
    const { svc, paths } = service();
    const id = plantRunning(paths);
    const lock = plantLiveAssistantLock(paths);
    expect(await svc.init()).toBeNull();
    expect(svc.getRun(id)?.state).toBe("running");
    rmSync(lock);
    expect(await svc.init()).toBe(1);
    expect(svc.getRun(id)).toMatchObject({ state: "interrupted", errorCode: "abandoned" });
    // Never re-run automatically.
    expect(svc.latestBriefing()).toBeNull();
  });

  it("init on an unavailable store returns null and the store stays unavailable", async () => {
    const { svc, paths } = service();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${paths.privateDir}/assistant.sqlite`, "garbage ".repeat(100));
    expect(await svc.init()).toBeNull();
    expect(svc.available).toBe(false);
    expect(() => svc.latestRun()).toThrow(/unavailable/);
  });

  it("close marks the owned run interrupted, waits for its read, then closes the DB", async () => {
    const { svc, sheets, paths } = service();
    const gate = sheets.hold();
    const run = await svc.startBriefing(R1);
    await gate.started;
    let closed = false;
    const closing = svc.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(closed).toBe(false); // still waiting on the outstanding read
    gate.release();
    await closing;
    const store = AssistantStore.open(paths);
    expect(store.getRun(run.id)).toMatchObject({ state: "interrupted", errorCode: "shutdown" });
    expect(store.counts().briefings).toBe(0);
    store.close();
    expect(existsSync(assistantLockFile(paths))).toBe(false);
    await expect(svc.startBriefing(R2)).rejects.toThrow(/unavailable/);
  });

  it("init fails the assistant closed (never throws) when the lock path is unusable", async () => {
    const { svc, paths, warnings } = service();
    mkdirSync(assistantLockFile(paths)); // a directory where the lock file belongs
    await expect(svc.init()).resolves.toBeNull();
    expect(svc.available).toBe(false);
    await expect(svc.startBriefing(R1)).rejects.toBeInstanceOf(AssistantUnavailableError);
    expect(warnings.join(" ")).not.toContain(paths.privateDir);
  });

  it("a failed lock release is reclaimed as this process's leftover, not busy for 17 min", async () => {
    let failUnlink = true;
    const eperm = () =>
      Promise.reject(Object.assign(new Error("synthetic EPERM"), { code: "EPERM" }));
    const { svc, paths, warnings } = service({
      unlink: (file) => (failUnlink ? eperm() : unlink(file)),
    });
    await svc.startBriefing(R1);
    await svc.idle();
    expect(existsSync(assistantLockFile(paths))).toBe(true); // release failed: our record remains
    expect(warnings.some((w) => w.includes("could not release"))).toBe(true);
    failUnlink = false;
    const second = await svc.startBriefing(R2);
    await svc.idle();
    expect(svc.getRun(second.id)?.state).toBe("succeeded");
    expect(existsSync(assistantLockFile(paths))).toBe(false);
  });
});

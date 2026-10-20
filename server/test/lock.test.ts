// Cross-process refresh lock (plan §5, D19).
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  EMPTY_LOCK_GRACE_MS,
  LOCK_STALE_AFTER_MS,
  LockHeldError,
  type LockHandle,
} from "../src/lock.js";
import { tempPaths } from "./helpers.js";

/** A pid that existed and has exited (a finished child process). */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  expect(child.pid).toBeGreaterThan(0);
  return child.pid;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function lockFile(): string {
  const { paths, cleanup } = tempPaths();
  cleanups.push(cleanup);
  return paths.lockFile;
}

function writeRecord(file: string, pid: number, startedAt = new Date().toISOString()): string {
  const text = JSON.stringify({ pid, startedAt, token: "other-holder" });
  writeFileSync(file, text);
  return text;
}

/** Only the lock file itself remains: no temp, guard or tombstone files are left behind. */
function leftovers(file: string): string[] {
  return readdirSync(path.dirname(file)).filter((f) => f.startsWith(path.basename(file)));
}

async function race(file: string, n: number): Promise<PromiseSettledResult<LockHandle>[]> {
  return Promise.allSettled(Array.from({ length: n }, () => acquireLock(file)));
}

describe("acquireLock", () => {
  it("writes {pid, startedAt} and makes a second acquirer refuse while held", async () => {
    const file = lockFile();
    const held = await acquireLock(file);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      pid: process.pid,
      startedAt: held.record.startedAt,
      token: held.record.token,
    });

    const second = acquireLock(file);
    await expect(second).rejects.toBeInstanceOf(LockHeldError);
    await expect(second).rejects.toThrow("refresh already running");

    await held.release();
    expect(existsSync(file)).toBe(false);
    const again = await acquireLock(file);
    await again.release();
  });

  it("lets exactly one of many parallel acquirers win", async () => {
    const file = lockFile();
    const results = await race(file, 25);
    const winners = results.filter((r) => r.status === "fulfilled");
    expect(winners).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(LockHeldError);
    }
    expect(leftovers(file)).toEqual([path.basename(file)]);
  });

  it("reclaims a dead-pid lock, with exactly one winner among parallel reclaimers", async () => {
    const file = lockFile();
    writeRecord(file, deadPid());
    const results = await race(file, 25);
    const winners = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(winners).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(LockHeldError);
    }
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      pid: process.pid,
      token: winners[0]?.record.token,
    });
    expect(leftovers(file)).toEqual([path.basename(file)]);
  });

  it("refuses a live holder younger than 15 min and reclaims one past the job ceiling", async () => {
    const file = lockFile();
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

    const young = writeRecord(file, process.pid, ago(LOCK_STALE_AFTER_MS - 60_000));
    await expect(acquireLock(file)).rejects.toBeInstanceOf(LockHeldError);
    expect(readFileSync(file, "utf8")).toBe(young);

    writeRecord(file, process.pid, ago(LOCK_STALE_AFTER_MS + 60_000));
    const handle = await acquireLock(file);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ token: handle.record.token });
    await handle.release();
  });

  it("waits out another process's in-flight reclaim instead of refusing", async () => {
    const file = lockFile();
    writeRecord(file, deadPid());
    // Another process is mid-reclaim: it holds the live, fresh `.reclaim` guard...
    const guard = `${file}.reclaim`;
    writeRecord(guard, process.pid);
    const contender = acquireLock(file);
    // ...and finishes ~60 ms later: the stale lock is gone and the guard released.
    await new Promise((r) => setTimeout(r, 60));
    unlinkSync(file);
    unlinkSync(guard);

    const handle = await contender;
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ token: handle.record.token });
    await handle.release();
    expect(leftovers(file)).toEqual([]);
  });

  it("treats an empty lock as held during the grace period, then as stale", async () => {
    const file = lockFile();
    writeFileSync(file, "");
    await expect(acquireLock(file)).rejects.toBeInstanceOf(LockHeldError);
    expect(readFileSync(file, "utf8")).toBe("");

    const past = (Date.now() - EMPTY_LOCK_GRACE_MS - 1000) / 1000;
    utimesSync(file, past, past);
    const handle = await acquireLock(file);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ pid: process.pid });
    await handle.release();
  });

  it("release removes only a lock this acquisition owns", async () => {
    const file = lockFile();
    const handle = await acquireLock(file);
    const other = writeRecord(file, process.pid, handle.record.startedAt); // same pid + time
    await handle.release();
    expect(readFileSync(file, "utf8")).toBe(other);
  });
});

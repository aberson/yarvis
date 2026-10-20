// RefreshRunner (server/src/pipeline/job.ts): lock ownership across jobs (D19) and when finished
// listeners (the todos read-cache invalidation) run.
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeSheets } from "../src/fakes/sheets.js";
import { acquireLock } from "../src/lock.js";
import { RefreshRunner } from "../src/pipeline/job.js";
import type { RefreshDeps } from "../src/pipeline/refresh.js";
import { createFakeSeams } from "../src/pipeline/seams.js";
import { tempPaths } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function deps(over: Partial<RefreshDeps> = {}): RefreshDeps {
  const t = tempPaths({ seedSettings: true });
  cleanups.push(t.cleanup);
  const seams = createFakeSeams({
    sheets: createFakeSheets().store,
    waWindow: { quietMs: 20, maxMs: 2_000 },
  });
  return { paths: t.paths, ...seams, log: () => undefined, ...over };
}

const eperm = () =>
  Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" });

describe("RefreshRunner", () => {
  it("reclaims its own lock on the next start when the release failed past its retries", async () => {
    const d = deps();
    let failing = true;
    const runner = new RefreshRunner(d, {
      log: false,
      lock: {
        unlink: (f) => {
          if (failing) return Promise.reject(eperm());
          unlinkSync(f);
          return Promise.resolve();
        },
      },
    });
    expect(await runner.start()).toMatchObject({ started: true });
    expect((await runner.running)?.state).toBe("done");
    expect(existsSync(d.paths.lockFile)).toBe(true); // left behind by THIS live process
    await expect(acquireLock(d.paths.lockFile)).rejects.toThrow("refresh already running");

    failing = false;
    expect(await runner.start()).toMatchObject({ started: true });
    expect((await runner.running)?.state).toBe("done");
    expect(existsSync(d.paths.lockFile)).toBe(false);
  });

  it("releases the lock when starting the job throws after the lock was taken", async () => {
    const d = deps({
      now: () => {
        throw new Error("clock unavailable");
      },
    });
    const runner = new RefreshRunner(d, { log: false });
    await expect(runner.start()).rejects.toThrow("clock unavailable");
    await (await acquireLock(d.paths.lockFile)).release();
  });

  it("runs finished listeners when the terminal status is published (before the lock is released) and again after", async () => {
    const runner = new RefreshRunner(deps(), { log: false });
    const calls: Array<{ state: string; jobStillRunning: boolean }> = [];
    runner.onFinished((s) =>
      calls.push({ state: s.state, jobStillRunning: runner.running !== null }),
    );
    await runner.start();
    await runner.running;
    expect(calls).toEqual([
      { state: "done", jobStillRunning: true },
      { state: "done", jobStillRunning: false },
    ]);
  });
});

// POST /api/refresh + GET /api/refresh/status through the production entry point (createApp) with
// the fake seams (plan §4, §6, D13, D19, D22).
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { JevScores, Message, RefreshStatus, Todo } from "@yarvis/shared";
import { createApp } from "../src/index.js";
import type { Jev } from "../src/ai/jev.js";
import { FakeJev } from "../src/fakes/jev.js";
import { createFakeSheets } from "../src/fakes/sheets.js";
import { acquireLock } from "../src/lock.js";
import { RefreshRunner } from "../src/pipeline/job.js";
import { createFakeSeams } from "../src/pipeline/seams.js";
import { tempPaths } from "./helpers.js";

const HOST = "127.0.0.1:5173";
const NEW_TODO = "gmail:19a0c0ffee000001#1";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** A FakeJev whose calls wait until `open()`: holds the job in its jev stage. */
function gatedJev(): Jev & { open(): void } {
  const inner = new FakeJev();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return {
    open,
    classify: async (m: Message): Promise<JevScores> => {
      await gate;
      return inner.classify(m);
    },
  };
}

function setup(jev: Jev = new FakeJev()) {
  const t = tempPaths({ seedSettings: true });
  cleanups.push(t.cleanup);
  const sheets = createFakeSheets();
  const seams = createFakeSeams({
    sheets: sheets.store,
    waWindow: { quietMs: 20, maxMs: 2_000 },
  });
  const logged: string[] = [];
  const runner = new RefreshRunner(
    { paths: t.paths, ...seams, jev, log: () => undefined },
    { log: (line) => logged.push(line) },
  );
  const fixedClock = 1_000_000; // the todos read cache (10 s TTL) never expires on its own here
  const app = createApp({
    paths: t.paths,
    fake: true,
    webPort: 5173,
    sheets: sheets.store,
    refreshRunner: runner,
    now: () => fixedClock,
  });
  return { app, runner, logged, paths: t.paths };
}

const post = (app: ReturnType<typeof createApp>) =>
  request(app).post("/api/refresh").set("Host", HOST).set("X-Yarvis", "1");
const get = (app: ReturnType<typeof createApp>, path: string) =>
  request(app).get(path).set("Host", HOST);

describe("POST /api/refresh + GET /api/refresh/status", () => {
  it("202 with a job id, 409 while running, then the finished status and fresh todos", async () => {
    const jev = gatedJev();
    const { app, runner, logged } = setup(jev);

    const idle = await get(app, "/api/refresh/status");
    expect((idle.body as RefreshStatus).state).toBe("idle");
    // Prime the todos read cache before the refresh.
    const before = (await get(app, "/api/todos?status=all")).body as Todo[];
    expect(before.some((t) => t.id === NEW_TODO)).toBe(false);

    const started = await post(app);
    expect(started.status).toBe(202);
    expect(started.body).toEqual({
      jobId: expect.stringMatching(/^job-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/) as string,
    });
    expect(((await get(app, "/api/refresh/status")).body as RefreshStatus).state).toBe("running");

    const second = await post(app);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ running: true });

    jev.open();
    const final = await runner.running;
    expect(final?.state).toBe("done");
    const status = (await get(app, "/api/refresh/status")).body as RefreshStatus;
    expect(status).toEqual(final);
    expect(status.finishedAt).not.toBeNull();
    // One summary line per finished job: states and counts only.
    const jobId = (started.body as { jobId: string }).jobId;
    expect(logged).toHaveLength(1);
    const words = (logged[0] as string).split(" ");
    expect(words.slice(0, 3)).toEqual(["[refresh]", jobId, "done"]);
    expect(words.slice(3, 8).map((w) => w.replace(/\d+/, "n"))).toEqual([
      "whatsapp=done(n)",
      "gmail=done(n)",
      "jev=done(n)",
      "extract=done(n)",
      "sheets=done(n)",
    ]);
    expect(words[8]).toMatch(/^\d+\.\ds$/);

    // Job completion invalidated the todos read cache: the new row is visible at once.
    const after = (await get(app, "/api/todos?status=all")).body as Todo[];
    expect(after.some((t) => t.id === NEW_TODO)).toBe(true);
  });

  it("409 while another process holds private/refresh.lock", async () => {
    const { app, paths } = setup();
    const lock = await acquireLock(paths.lockFile);
    try {
      const res = await post(app);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ running: true });
      expect(((await get(app, "/api/refresh/status")).body as RefreshStatus).state).toBe("idle");
    } finally {
      await lock.release();
    }
  });
});

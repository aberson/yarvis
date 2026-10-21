// Production entry point: startServer's bind address (in-process) and the real
// `tsx server/src/main.ts` process reached end to end through HTTP. Guard and settings behaviour
// is covered by guard.test.ts and settings.test.ts.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT, resolvePaths } from "../src/config/paths.js";
import { decisionsFile, messagesFile } from "../src/pipeline/cache.js";
import { BIND_HOST, startServer, type StartedServer, type StartOverrides } from "../src/main.js";
import { tempPaths } from "./helpers.js";
import type { AssistantRun, Briefing, PreparationPacket } from "@yarvis/shared";
import { AssistantStore, assistantDbFile, assistantLockFile } from "../src/assistant/store.js";
import { gatedSheets, plantLiveAssistantLock } from "./assistant-helpers.js";
import { COMPOSE_PROMPT_VERSION, type Composer } from "../src/ai/compose.js";
import { FAKE_COMPOSER_MODEL } from "../src/fakes/composer.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("startServer", () => {
  it("binds 127.0.0.1 on PORT=0", async () => {
    const { paths, cleanup } = tempPaths();
    cleanups.push(cleanup);
    const started: StartedServer = await startServer({
      PORT: "0",
      YARVIS_FAKE: "1",
      YARVIS_PRIVATE_DIR: paths.privateDir,
    });
    cleanups.push(() => started.close());
    const address = started.server.address();
    expect(typeof address === "object" && address?.address).toBe(BIND_HOST);
    expect(started.url).toBe(`http://${BIND_HOST}:${started.port}`);
  });
});

describe("startServer in fake mode", () => {
  // Fake mode's sheet lives in memory, so the default fake private dir (D32) starts each server
  // from the fixture state; an explicit YARVIS_PRIVATE_DIR is never reset.
  it("clears the default fake dir's caches and cursors, and never touches an override dir", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "yarvis-root-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const plant = (dir: string) => {
      const p = resolvePaths({ YARVIS_PRIVATE_DIR: dir }, root);
      mkdirSync(p.cacheDir, { recursive: true });
      for (const f of [messagesFile(p), decisionsFile(p), p.stateFile]) writeFileSync(f, "{}\n");
      return [messagesFile(p), decisionsFile(p), p.stateFile];
    };
    const defaultFake = plant(path.join(root, "private", "fake"));
    const override = plant(path.join(root, "elsewhere"));

    const a = await startServer({ PORT: "0", YARVIS_FAKE: "1" }, root);
    cleanups.push(() => a.close());
    expect(defaultFake.filter((f) => existsSync(f))).toEqual([]);

    const b = await startServer(
      { PORT: "0", YARVIS_FAKE: "1", YARVIS_PRIVATE_DIR: path.join(root, "elsewhere") },
      root,
    );
    cleanups.push(() => b.close());
    expect(override.filter((f) => existsSync(f))).toEqual(override);
  });
});

describe("main.ts process", () => {
  it("starts from the real entry point and logs its bound URL", async () => {
    const { paths, cleanup } = tempPaths();
    cleanups.push(cleanup);
    // `node --import tsx` keeps it one process, so kill() leaves no orphaned listener on Windows.
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(REPO_ROOT, "server", "src", "main.ts")],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, PORT: "0", YARVIS_FAKE: "1", YARVIS_PRIVATE_DIR: paths.privateDir },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.once("exit", () => resolve());
          child.kill();
        }),
    );

    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error(`no listen line; got: ${out}`)), 30_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
        if (m?.[1]) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.once("exit", (code) => reject(new Error(`exited ${String(code)}: ${out}`)));
    });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const res = await fetch(`${url}/api/health`);
    expect(await res.json()).toEqual({ ok: true, fake: true });
  });
});

describe("startServer assistant lifecycle (plan S1, Step 9)", () => {
  const R1 = "50000000-0000-4000-8000-000000000001";
  const R2 = "50000000-0000-4000-8000-000000000002";

  async function start(privateDir: string, overrides: StartOverrides = {}): Promise<StartedServer> {
    return startServer(
      { PORT: "0", YARVIS_FAKE: "1", YARVIS_PRIVATE_DIR: privateDir },
      REPO_ROOT,
      overrides,
    );
  }

  async function json<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
    const res = await fetch(url, init);
    return { status: res.status, body: (await res.json()) as T };
  }

  async function waitRun(url: string, id: string): Promise<AssistantRun> {
    for (let i = 0; i < 300; i++) {
      const { body } = await json<{ run: AssistantRun }>(`${url}/api/assistant/runs/${id}`);
      if (body.run.state !== "running") return body.run;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("run did not finish");
  }

  function plantRunning(paths: ReturnType<typeof tempPaths>["paths"]): string {
    const store = AssistantStore.open(paths);
    const id = "50000000-0000-4000-8000-0000000000aa";
    store.insertRun({
      id,
      requestId: "50000000-0000-4000-8000-0000000000bb",
      requestHash: "h",
      kind: "briefing",
      createdAt: "2026-10-20T10:00:00.000Z",
    });
    store.close();
    return id;
  }

  it("creates a snapshot over HTTP, and close + restart reopens it from the same store", async () => {
    const { paths, cleanup } = tempPaths({ seedSettings: true });
    cleanups.push(cleanup);
    const a = await start(paths.privateDir);
    let aClosed = false;
    cleanups.push(() => (aClosed ? undefined : a.close()));
    const posted = await json<{ run: AssistantRun }>(`${a.url}/api/assistant/briefings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Yarvis": "1" },
      body: JSON.stringify({ requestId: R1 }),
    });
    expect(posted.status).toBe(202);
    const done = await waitRun(a.url, posted.body.run.id);
    expect(done.state).toBe("succeeded");
    const first = await json<{ briefing: Briefing }>(`${a.url}/api/assistant/briefings/latest`);
    await a.close();
    aClosed = true;

    const b = await start(paths.privateDir);
    cleanups.push(() => b.close());
    expect((await json(`${b.url}/api/assistant/briefings/latest`)).body).toEqual(first.body);
    expect((await json(`${b.url}/api/assistant/runs/latest`)).body).toEqual({ run: done });
  });

  it("restart turns an abandoned running row interrupted only after taking the lock", async () => {
    const { paths, cleanup } = tempPaths({ seedSettings: true });
    cleanups.push(cleanup);
    const id = plantRunning(paths);
    const lock = plantLiveAssistantLock(paths);

    const a = await start(paths.privateDir);
    let aClosed = false;
    cleanups.push(() => (aClosed ? undefined : a.close()));
    const live = await json<{ run: AssistantRun }>(`${a.url}/api/assistant/runs/latest`);
    expect(live.body.run).toMatchObject({ id, state: "running" }); // live owner left untouched
    await a.close();
    aClosed = true;

    rmSync(lock);
    const b = await start(paths.privateDir);
    cleanups.push(() => b.close());
    const recovered = await json<{ run: AssistantRun }>(`${b.url}/api/assistant/runs/latest`);
    expect(recovered.body.run).toMatchObject({
      id,
      state: "interrupted",
      errorCode: "abandoned",
    });
    // No automatic re-run: still no briefing.
    expect((await json(`${b.url}/api/assistant/briefings/latest`)).body).toEqual({
      briefing: null,
    });
  });

  it("a corrupt store keeps Todos usable and the assistant visibly unavailable", async () => {
    const { paths, cleanup } = tempPaths({ seedSettings: true });
    cleanups.push(cleanup);
    writeFileSync(assistantDbFile(paths), "corrupt ".repeat(200));
    const s = await start(paths.privateDir);
    cleanups.push(() => s.close());
    const todos = await fetch(`${s.url}/api/todos`);
    expect(todos.status).toBe(200);
    const assistant = await json<{ error: string }>(`${s.url}/api/assistant/runs/latest`);
    expect(assistant.status).toBe(503);
    expect(assistant.body.error).toBe("assistant_unavailable");
  });

  it("a startup recovery failure (unusable lock path) still serves Todos; assistant answers 503", async () => {
    const { paths, cleanup } = tempPaths({ seedSettings: true });
    cleanups.push(cleanup);
    plantRunning(paths);
    mkdirSync(assistantLockFile(paths)); // a directory where the lock file belongs
    const s = await start(paths.privateDir);
    cleanups.push(() => s.close());
    expect((await fetch(`${s.url}/api/todos`)).status).toBe(200);
    const assistant = await json<{ error: string }>(`${s.url}/api/assistant/runs/latest`);
    expect(assistant.status).toBe(503);
    expect(assistant.body.error).toBe("assistant_unavailable");
  });

  it("close() with a briefing read in flight interrupts it (shutdown), publishes nothing, releases lock + DB", async () => {
    const { paths, cleanup } = tempPaths({ seedSettings: true });
    cleanups.push(cleanup);
    // The source read is HELD until close() has run, so the outcome is deterministic on any OS.
    const sheets = gatedSheets();
    const s = await start(paths.privateDir, { sheets: sheets.gated });
    let closed = false;
    cleanups.push(() => (closed ? undefined : s.close()));
    const gate = sheets.hold();
    const posted = await json<{ run: AssistantRun }>(`${s.url}/api/assistant/briefings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Yarvis": "1" },
      body: JSON.stringify({ requestId: R1 }),
    });
    expect(posted.status).toBe(202);
    await gate.started;
    const closing = s.close();
    gate.release(); // the read settles only after shutdown began: its result must be discarded
    await closing;
    closed = true;
    expect(existsSync(assistantLockFile(paths))).toBe(false);
    const reopened = AssistantStore.open(paths);
    const run = reopened.getRun(posted.body.run.id);
    const counts = reopened.counts();
    reopened.close();
    expect(run).toMatchObject({ state: "interrupted", errorCode: "shutdown" });
    expect(counts.briefings).toBe(0);
    // The production close released the server's SQLite handle (an open file cannot be removed
    // on Windows).
    rmSync(assistantDbFile(paths));
  });

  it("fake mode wires the FakeComposer: briefing -> prepare -> packet through the real server", async () => {
    const { paths, cleanup } = tempPaths({ seedSettings: true });
    cleanups.push(cleanup);
    const s = await start(paths.privateDir);
    cleanups.push(() => s.close());
    const headers = { "Content-Type": "application/json", "X-Yarvis": "1" };
    const b = await json<{ run: AssistantRun }>(`${s.url}/api/assistant/briefings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requestId: R1 }),
    });
    expect((await waitRun(s.url, b.body.run.id)).state).toBe("succeeded");
    const briefing = (await json<{ briefing: Briefing }>(`${s.url}/api/assistant/briefings/latest`))
      .body.briefing;
    const item = briefing.items.find((i) => i.preparationEligible);
    expect(item).toBeDefined();
    const p = await json<{ run: AssistantRun }>(`${s.url}/api/assistant/preparations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: R2,
        briefingId: briefing.id,
        todoId: item?.sourceRef.todoId,
      }),
    });
    expect(p.status).toBe(202);
    const done = await waitRun(s.url, p.body.run.id);
    expect(done).toMatchObject({ state: "succeeded", model: FAKE_COMPOSER_MODEL });
    const packet = await json<{ packet: PreparationPacket }>(
      `${s.url}/api/assistant/preparations/${done.targetId}`,
    );
    expect(packet.status).toBe(200);
    expect(packet.body.packet).toMatchObject({
      todoId: item?.sourceRef.todoId,
      revision: 1,
      state: "open",
      model: FAKE_COMPOSER_MODEL,
    });
  });

  it("Step 11: a saved edit (draft, checkboxes, handled) survives close + restart unchanged", async () => {
    const { paths, cleanup } = tempPaths({ seedSettings: true });
    cleanups.push(cleanup);
    const a = await start(paths.privateDir);
    let aClosed = false;
    cleanups.push(() => (aClosed ? undefined : a.close()));
    const headers = { "Content-Type": "application/json", "X-Yarvis": "1" };
    const b = await json<{ run: AssistantRun }>(`${a.url}/api/assistant/briefings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requestId: R1 }),
    });
    expect((await waitRun(a.url, b.body.run.id)).state).toBe("succeeded");
    const briefing = (await json<{ briefing: Briefing }>(`${a.url}/api/assistant/briefings/latest`))
      .body.briefing;
    const item = briefing.items.find((i) => i.preparationEligible);
    const p = await json<{ run: AssistantRun }>(`${a.url}/api/assistant/preparations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: R2,
        briefingId: briefing.id,
        todoId: item?.sourceRef.todoId,
      }),
    });
    const done = await waitRun(a.url, p.body.run.id);
    expect(done.state).toBe("succeeded");
    const original = (
      await json<{ packet: PreparationPacket }>(
        `${a.url}/api/assistant/preparations/${done.targetId}`,
      )
    ).body.packet;
    const edit = {
      expectedRevision: original.revision,
      draft: "Operator-edited draft\nwith a second line.",
      checklist: original.checklist.map((c, i) => ({
        ...c,
        text: i === 0 ? "Edited first step" : c.text,
        done: i !== 1,
      })),
      questions: ["Edited question?"],
      state: "open",
    };
    const saved = await json<{ packet: PreparationPacket }>(
      `${a.url}/api/assistant/preparations/${original.id}`,
      { method: "PATCH", headers, body: JSON.stringify(edit) },
    );
    expect(saved.status).toBe(200);
    const handled = await json<{ packet: PreparationPacket }>(
      `${a.url}/api/assistant/preparations/${original.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          ...edit,
          expectedRevision: saved.body.packet.revision,
          state: "handled",
        }),
      },
    );
    expect(handled.status).toBe(200);
    expect(handled.body.packet).toMatchObject({ revision: 3, state: "handled" });
    await a.close();
    aClosed = true;

    const b2 = await start(paths.privateDir);
    cleanups.push(() => b2.close());
    const reopened = await json<{ packet: PreparationPacket }>(
      `${b2.url}/api/assistant/preparations/${original.id}`,
    );
    expect(reopened.status).toBe(200);
    expect(reopened.body.packet).toEqual(handled.body.packet);
    expect(reopened.body.packet.draft).toBe(edit.draft);
    expect(reopened.body.packet.checklist.map((c) => c.done)).toEqual(
      edit.checklist.map((c) => c.done),
    );
    const list = await json<{ packets: Array<{ id: string; state: string; revision: number }> }>(
      `${b2.url}/api/assistant/preparations`,
    );
    expect(list.body.packets.map((x) => [x.id, x.state, x.revision])).toEqual([
      [original.id, "handled", 3],
    ]);
    // A stale tab's save after the restart is still refused, with the saved packet for review.
    const stale = await json<{ error: string; currentPacket: PreparationPacket }>(
      `${b2.url}/api/assistant/preparations/${original.id}`,
      { method: "PATCH", headers, body: JSON.stringify({ ...edit, draft: "stale tab" }) },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("revision_conflict");
    expect(stale.body.currentPacket).toEqual(handled.body.packet);
  });

  it("close() with composition in flight aborts it, interrupts the run and commits no late packet", async () => {
    const { paths, cleanup } = tempPaths({ seedSettings: true });
    cleanups.push(cleanup);
    let signal: AbortSignal | undefined;
    let finishLate!: () => void;
    const composer: Composer = {
      compose: (_input, opts) => {
        signal = opts.signal;
        // Answers successfully only when the test says so: a late result after close().
        return new Promise((resolve) => {
          finishLate = () =>
            resolve({
              ok: true,
              composition: { draft: "late", checklist: ["late"], questions: [] },
              model: "late",
              promptVersion: COMPOSE_PROMPT_VERSION,
            });
        });
      },
    };
    const s = await start(paths.privateDir, { composer });
    let closed = false;
    cleanups.push(() => (closed ? undefined : s.close()));
    const headers = { "Content-Type": "application/json", "X-Yarvis": "1" };
    const b = await json<{ run: AssistantRun }>(`${s.url}/api/assistant/briefings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requestId: R1 }),
    });
    await waitRun(s.url, b.body.run.id);
    const briefing = (await json<{ briefing: Briefing }>(`${s.url}/api/assistant/briefings/latest`))
      .body.briefing;
    const item = briefing.items.find((i) => i.preparationEligible);
    const p = await json<{ run: AssistantRun }>(`${s.url}/api/assistant/preparations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: R2,
        briefingId: briefing.id,
        todoId: item?.sourceRef.todoId,
      }),
    });
    expect(p.status).toBe(202);
    const closing = s.close();
    expect(signal?.aborted).toBe(true);
    finishLate();
    await closing;
    closed = true;
    expect(existsSync(assistantLockFile(paths))).toBe(false);
    const reopened = AssistantStore.open(paths);
    const run = reopened.getRun(p.body.run.id);
    const counts = reopened.counts();
    reopened.close();
    expect(run).toMatchObject({ state: "interrupted", errorCode: "shutdown", targetId: null });
    expect(counts.packets).toBe(0);
  });
});

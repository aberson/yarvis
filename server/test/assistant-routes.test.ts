// /api/assistant/* through the production app factory (createApp) with the REAL SQLite store and
// the real Sheets store over FakeSheetsApi (plan S1.5 "HTTP additions"): POST 202 + polling to a
// saved snapshot, latest-run discovery, idempotent request ids, validation, the existing guards,
// busy/conflict/unavailable mappings, and a corrupt store leaving /api/todos usable.
import { writeFileSync } from "node:fs";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantRun, Briefing } from "@yarvis/shared";
import { createApp } from "../src/index.js";
import { AssistantService } from "../src/assistant/service.js";
import { AssistantStore, assistantDbFile } from "../src/assistant/store.js";
import { gatedSheets, plantLiveAssistantLock, todo } from "./assistant-helpers.js";
import { tempPaths } from "./helpers.js";

const HOST = "127.0.0.1:5173";
const R1 = "40000000-0000-4000-8000-000000000001";
const R2 = "40000000-0000-4000-8000-000000000002";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function setup(opts: { seed?: Parameters<typeof gatedSheets>[0]; inject?: boolean } = {}) {
  const t = tempPaths({ seedSettings: true });
  cleanups.push(t.cleanup);
  const sheets = gatedSheets(opts.seed);
  const service = new AssistantService({
    paths: t.paths,
    sheets: sheets.gated,
    configured: () => Promise.resolve({ gmail: true, whatsapp: true }),
    warn: () => undefined,
  });
  cleanups.push(() => service.close());
  const app = createApp({
    paths: t.paths,
    fake: true,
    webPort: 5173,
    sheets: sheets.gated,
    assistant: opts.inject === false ? undefined : service,
  });
  return { app, service, sheets, paths: t.paths };
}

type App = ReturnType<typeof createApp>;
const get = (app: App, path: string) => request(app).get(path).set("Host", HOST);
const post = (app: App, path: string, body: unknown) =>
  request(app)
    .post(path)
    .set("Host", HOST)
    .set("X-Yarvis", "1")
    .send(body as object);

async function pollUntilDone(app: App, id: string): Promise<AssistantRun> {
  let run: AssistantRun | undefined;
  for (let i = 0; i < 200; i++) {
    const res = await get(app, `/api/assistant/runs/${id}`);
    expect(res.status).toBe(200);
    run = (res.body as { run: AssistantRun }).run;
    if (run.state !== "running") return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("run never finished");
}

describe("POST /api/assistant/briefings", () => {
  it("202 {run}; polling reaches succeeded; latest briefing and latest run are served", async () => {
    const { app } = setup();
    expect((await get(app, "/api/assistant/briefings/latest")).body).toEqual({ briefing: null });
    expect((await get(app, "/api/assistant/runs/latest")).body).toEqual({ run: null });

    const res = await post(app, "/api/assistant/briefings", { requestId: R1 });
    expect(res.status).toBe(202);
    const run = (res.body as { run: AssistantRun }).run;
    expect(run).toMatchObject({ requestId: R1, kind: "briefing", state: "running" });
    expect(Object.keys(run).sort()).toEqual(
      [
        "createdAt",
        "errorCode",
        "finishedAt",
        "id",
        "kind",
        "model",
        "promptVersion",
        "requestId",
        "sourceTodoId",
        "state",
        "targetId",
      ].sort(),
    );

    const done = await pollUntilDone(app, run.id);
    expect(done.state).toBe("succeeded");
    const latest = await get(app, "/api/assistant/briefings/latest");
    expect(latest.status).toBe(200);
    expect(latest.headers["cache-control"]).toBe("no-store");
    const briefing = (latest.body as { briefing: Briefing }).briefing;
    expect(briefing.id).toBe(done.targetId);
    expect(briefing.previousBriefingId).toBeNull();
    expect(briefing.sourceCoverage.map((c) => c.freshness)).toEqual(["unknown", "unknown"]);
    expect((await get(app, "/api/assistant/runs/latest")).body).toEqual({ run: done });
  });

  it("repeating a request id returns the same run, never a second snapshot", async () => {
    const { app, service, paths } = setup();
    const a = await post(app, "/api/assistant/briefings", { requestId: R1 });
    await service.idle();
    const b = await post(app, "/api/assistant/briefings", { requestId: R1 });
    expect(b.status).toBe(202);
    const replayed = (b.body as { run: AssistantRun }).run;
    expect(replayed.id).toBe((a.body as { run: AssistantRun }).run.id);
    expect(replayed.state).toBe("succeeded");
    await service.idle();
    // Still exactly the one snapshot that run produced, with no newer one.
    const latest = (await get(app, "/api/assistant/briefings/latest")).body as {
      briefing: Briefing;
    };
    expect(latest.briefing.id).toBe(replayed.targetId);
    expect(latest.briefing.previousBriefingId).toBeNull();
    const store = AssistantStore.open(paths);
    expect(store.counts()).toMatchObject({ runs: 1, briefings: 1 });
    store.close();
  });

  it("quarantined rows are excluded, pending rows are not actionable, >25 rows report omitted", async () => {
    const rows = Array.from({ length: 28 }, (_, i) => todo(i + 1));
    rows[0] = todo(1, { extraction_status: "pending", message_date: "2026-10-30T00:00:00.000Z" });
    const held = todo(50, { message_date: "2026-10-31T00:00:00.000Z" });
    const { app, service } = setup({
      seed: {
        Todos: [...rows, held],
        Quarantine: [
          {
            id: held.id.replace(/#1$/, ""),
            source: "gmail",
            sender: "x@example.test",
            context: "x",
            message_date: held.message_date,
            link: "",
            jev_phishing: 0.9,
            jev_malicious: 0,
            jev_spam: 0,
            reason: "phishing≥0.50",
            created_at: held.created_at,
            released_at: "",
          },
        ],
      },
    });
    await post(app, "/api/assistant/briefings", { requestId: R1 });
    await service.idle();
    const { briefing } = (await get(app, "/api/assistant/briefings/latest")).body as {
      briefing: Briefing;
    };
    expect(briefing.openCount).toBe(28);
    expect(briefing.items).toHaveLength(25);
    expect(briefing.omittedCount).toBe(3);
    expect(briefing.items.map((i) => i.sourceRef.todoId)).not.toContain(held.id);
    expect(briefing.items[0]).toMatchObject({
      sourceRef: { todoId: todo(1).id, extractionStatus: "pending" },
      preparationEligible: false,
    });
  });

  it("a failed sheet read is a failed run; the previous snapshot stays latest", async () => {
    const { app, service, sheets } = setup();
    await post(app, "/api/assistant/briefings", { requestId: R1 });
    await service.idle();
    const before = (await get(app, "/api/assistant/briefings/latest")).body as unknown;
    sheets.failNextRead();
    const res = await post(app, "/api/assistant/briefings", { requestId: R2 });
    const failed = await pollUntilDone(app, (res.body as { run: AssistantRun }).run.id);
    expect(failed).toMatchObject({ state: "failed", errorCode: "source_unavailable" });
    expect((await get(app, "/api/assistant/briefings/latest")).body).toEqual(before);
    expect(JSON.stringify(failed)).not.toContain("synthetic read failure");
  });

  it("400 on a missing/invalid/extra body field; 403 without X-Yarvis or with a foreign Host", async () => {
    const { app } = setup();
    for (const body of [{}, { requestId: "nope" }, { requestId: R1, extra: 1 }]) {
      const res = await post(app, "/api/assistant/briefings", body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "bad_request", message: "body must be {requestId: UUID}" });
    }
    const noHeader = await request(app)
      .post("/api/assistant/briefings")
      .set("Host", HOST)
      .send({ requestId: R1 });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body).toMatchObject({ error: "missing_x_yarvis" });
    const badHost = await request(app)
      .get("/api/assistant/runs/latest")
      .set("Host", "evil.example:5173");
    expect(badHost.status).toBe(403);
    const big = await post(app, "/api/assistant/briefings", {
      requestId: R1,
      pad: "x".repeat(70_000),
    });
    expect(big.status).toBe(400);
    expect((await get(app, "/api/assistant/runs/latest")).body).toEqual({ run: null });
  });

  it("409 assistant_busy while another run holds the assistant lock (no queuing)", async () => {
    const { app, paths } = setup();
    plantLiveAssistantLock(paths);
    const res = await post(app, "/api/assistant/briefings", { requestId: R1 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "assistant_busy" });
    expect((await get(app, "/api/assistant/runs/latest")).body).toEqual({ run: null });
  });

  it("409 assistant_busy for a second request while one is running; latest run recovers its handle", async () => {
    const { app, service, sheets } = setup();
    const gate = sheets.hold();
    const first = (await post(app, "/api/assistant/briefings", { requestId: R1 })).body as {
      run: AssistantRun;
    };
    const busy = await post(app, "/api/assistant/briefings", { requestId: R2 });
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ error: "assistant_busy" });
    // A client that lost its POST response rediscovers the running run and correlates its id.
    const latest = (await get(app, "/api/assistant/runs/latest")).body as { run: AssistantRun };
    expect(latest.run).toMatchObject({ id: first.run.id, requestId: R1, state: "running" });
    gate.release();
    await service.idle();
  });
});

describe("GET /api/assistant/runs/:id", () => {
  it("400 bad_id for a non-UUID; 404 not_found for an unknown UUID", async () => {
    const { app } = setup();
    const bad = await get(app, "/api/assistant/runs/not-a-uuid");
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: "bad_id" });
    const unknown = await get(app, `/api/assistant/runs/${R2}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: "not_found" });
  });
});

describe("store unavailable", () => {
  it("a corrupt store answers 503 assistant_unavailable while /api/todos keeps working", async () => {
    const { app, paths } = setup();
    writeFileSync(assistantDbFile(paths), "corrupt ".repeat(200));
    for (const path of ["/api/assistant/runs/latest", "/api/assistant/briefings/latest"]) {
      const res = await get(app, path);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: "assistant_unavailable",
        message: "assistant storage is unavailable; Todos still work",
      });
      expect(JSON.stringify(res.body)).not.toContain(paths.privateDir);
    }
    const post503 = await post(app, "/api/assistant/briefings", { requestId: R1 });
    expect(post503.status).toBe(503);
    const todos = await get(app, "/api/todos");
    expect(todos.status).toBe(200);
    expect((todos.body as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("createApp default assistant", () => {
  it("existing callers that inject nothing get a lazily opened default service", async () => {
    const { app, paths } = setup({ inject: false });
    const fallback = app.locals.assistant as AssistantService;
    expect(fallback).toBeInstanceOf(AssistantService);
    cleanups.push(() => fallback.close());
    const { existsSync } = await import("node:fs");
    expect(existsSync(assistantDbFile(paths))).toBe(false);
    const res = await get(app, "/api/assistant/briefings/latest");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ briefing: null });
  });
});

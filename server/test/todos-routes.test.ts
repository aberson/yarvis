// GET /api/todos, PATCH /api/todos/:id, GET /api/quarantine through the production entry point
// (createApp) with the real store over FakeSheetsApi (plan §6, D22).
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { QuarantineItem, Todo } from "@yarvis/shared";
import { createApp } from "../src/index.js";
import { createFakeSheets, loadSheetSeed } from "../src/fakes/sheets.js";
import { tempPaths } from "./helpers.js";

const HOST = "127.0.0.1:5173";
const WA_TODO = "wa:15555550123@s.whatsapp.net:3EB0A1C2D3E4F5#1";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function setup(opts: { now?: () => number } = {}) {
  const t = tempPaths();
  cleanups.push(t.cleanup);
  const fake = createFakeSheets();
  const app = createApp({
    paths: t.paths,
    fake: true,
    webPort: 5173,
    sheets: fake.store,
    now: opts.now,
  });
  return { app, api: fake.api, paths: t.paths };
}

const patch = (app: ReturnType<typeof createApp>, rawPath: string, body: unknown) =>
  request(app)
    .patch(rawPath)
    .set("Host", HOST)
    .set("X-Yarvis", "1")
    .send(body as object);

const get = (app: ReturnType<typeof createApp>, path: string) =>
  request(app).get(path).set("Host", HOST);

describe("GET /api/todos", () => {
  it("defaults to open rows; ?status=done|all filter; bad status -> 400 bad_request", async () => {
    const seed = loadSheetSeed().Todos;
    const { app } = setup();
    const open = await get(app, "/api/todos");
    expect(open.status).toBe(200);
    expect(open.body).toEqual(seed.filter((t) => t.status === "open"));
    expect((await get(app, "/api/todos?status=all")).body).toEqual(seed);
    expect((await get(app, "/api/todos?status=done")).body).toEqual(
      seed.filter((t) => t.status === "done"),
    );
    const bad = await get(app, "/api/todos?status=nope");
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: "bad_request" });
  });

  it("reads the sheet at most once per 10 s, and a PATCH invalidates the cache", async () => {
    let clock = 1_000_000;
    const { app, api } = setup({ now: () => clock });
    const reads = () => api.calls.filter((c) => c.method === "values.get").length;

    await get(app, "/api/todos");
    const first = reads();
    await get(app, "/api/todos?status=all");
    expect(reads()).toBe(first);
    clock += 9_999;
    await get(app, "/api/todos");
    expect(reads()).toBe(first);
    clock += 2;
    await get(app, "/api/todos");
    expect(reads()).toBe(first + 1);

    const res = await patch(app, `/api/todos/${encodeURIComponent(WA_TODO)}`, { status: "done" });
    expect(res.status).toBe(200);
    const readsAfterPatch = reads();
    const open = await get(app, "/api/todos");
    expect(reads()).toBe(readsAfterPatch + 1);
    expect((open.body as Todo[]).map((t) => t.id)).not.toContain(WA_TODO);
  });
});

describe("PATCH /api/todos/:id", () => {
  it("round-trips a WhatsApp-format id containing @, : and # and writes only status + updated_at", async () => {
    const now = Date.parse("2026-10-19T12:34:56.000Z");
    const { app, api } = setup({ now: () => now });
    const before = loadSheetSeed().Todos.find((t) => t.id === WA_TODO)!;
    api.calls.length = 0;

    const res = await patch(app, `/api/todos/${encodeURIComponent(WA_TODO)}`, { status: "done" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ...before,
      status: "done",
      updated_at: "2026-10-19T12:34:56.000Z",
    });
    const writes = api.writes();
    expect(writes.map((w) => w.method)).toEqual(["values.batchUpdate"]);
    const data = (writes[0]?.params as { requestBody: { data: Array<{ range: string }> } })
      .requestBody.data;
    expect(data.map((d) => d.range)).toEqual(["'Todos'!C4", "'Todos'!M4"]);

    const all = await get(app, "/api/todos?status=all");
    expect((all.body as Todo[]).find((t) => t.id === WA_TODO)?.status).toBe("done");

    const back = await patch(app, `/api/todos/${encodeURIComponent(WA_TODO)}`, { status: "open" });
    expect((back.body as Todo).status).toBe("open");
  });

  it("returns 404 not_found for an unknown (valid) id with no sheet write", async () => {
    const { app, api } = setup();
    api.calls.length = 0;
    const res = await patch(app, `/api/todos/${encodeURIComponent("gmail:abcdef#7")}`, {
      status: "done",
    });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "not_found" });
    expect(api.writes()).toEqual([]);
  });

  it.each([
    ["no #n", "gmail:18f3c2a9b1e4d7f0"],
    ["non-hex gmail id", "gmail:zzz#1"],
    ["jid without @", "wa:15555550123:KEY#1"],
    ["unencoded # (fragment never reaches the server)", "gmail:18f3c2a9b1e4d7f0#1"],
  ])("returns 400 bad_id for %s with no sheet write", async (_label, raw) => {
    const { app, api } = setup();
    api.calls.length = 0;
    const res = await patch(app, `/api/todos/${raw}`, { status: "done" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "bad_id" });
    expect(api.writes()).toEqual([]);
  });

  it.each([
    ["unknown status", { status: "archived" }],
    ["extra key (update-only: no other fields)", { status: "done", action: "x" }],
    ["missing status", {}],
  ])("returns 400 bad_request for %s", async (_label, body) => {
    const { app, api } = setup();
    api.calls.length = 0;
    const res = await patch(app, `/api/todos/${encodeURIComponent(WA_TODO)}`, body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "bad_request" });
    expect(api.writes()).toEqual([]);
  });

  it("still requires X-Yarvis: 1 (guard runs before the route)", async () => {
    const { app } = setup();
    const res = await request(app)
      .patch(`/api/todos/${encodeURIComponent(WA_TODO)}`)
      .set("Host", HOST)
      .send({ status: "done" });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/quarantine", () => {
  it("returns the seeded fixture rows", async () => {
    const { app } = setup();
    const res = await get(app, "/api/quarantine");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(loadSheetSeed().Quarantine);
    expect((res.body as QuarantineItem[]).map((q) => q.reason)).toContain("spam≥0.50");
  });
});

describe("production wiring (no injected store)", () => {
  it("fake mode seeds both tabs from the fixtures", async () => {
    const t = tempPaths();
    cleanups.push(t.cleanup);
    const app = createApp({ paths: t.paths, fake: true, webPort: 5173 });
    const seed = loadSheetSeed();
    expect((await get(app, "/api/todos?status=all")).body).toEqual(seed.Todos);
    expect((await get(app, "/api/quarantine")).body).toEqual(seed.Quarantine);
  });

  it("real mode without a configured sheet returns 503 sheets_not_configured", async () => {
    const t = tempPaths({ seedSettings: true });
    cleanups.push(t.cleanup);
    const app = createApp({ paths: t.paths, fake: false, webPort: 5173 });
    for (const path of ["/api/todos", "/api/quarantine"]) {
      const res = await get(app, path);
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: "sheets_not_configured" });
    }
  });

  it("a header mismatch surfaces as 502 sheets_error", async () => {
    const t = tempPaths();
    cleanups.push(t.cleanup);
    const fake = createFakeSheets();
    fake.api.tabs.get("Quarantine")![0]![0] = "ID";
    const app = createApp({ paths: t.paths, fake: true, webPort: 5173, sheets: fake.store });
    const res = await get(app, "/api/quarantine");
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: "sheets_error" });
  });
});

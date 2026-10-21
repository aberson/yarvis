// Step 11 (plan Phase 2 / S1, S1.5 "Editing", D46): GET /api/assistant/preparations (list) and
// PATCH /api/assistant/preparations/:id (compare-and-swap save) through the production app factory
// (createApp) with the REAL SQLite store, the real Sheets store over FakeSheetsApi and the
// FakeComposer (never the real CLI). Covers: revision-checked saves (a stale second tab gets 409
// revision_conflict + currentPacket and changes nothing), explicit handled/reopen state that never
// writes the sheet, input bounds + checklist-id validation, the 100-item list cap with
// total/omittedCount, updatedAt ordering, and saves staying available while a run holds the lock.
// Synthetic data only.
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHECKLIST_ITEM_MAX_CHARS,
  DRAFT_MAX_CHARS,
  PACKET_LIST_CAP,
  QUESTIONS_MAX_ITEMS,
  type AssistantRun,
  type Briefing,
  type PacketEdit,
  type PacketListResponse,
  type PreparationPacket,
} from "@yarvis/shared";
import { createApp } from "../src/index.js";
import { AssistantService } from "../src/assistant/service.js";
import { AssistantStore } from "../src/assistant/store.js";
import { FakeComposer } from "../src/fakes/composer.js";
import { QUARANTINE, TODOS } from "../src/connectors/sheets.js";
import { gatedSheets, todo } from "./assistant-helpers.js";
import { tempPaths } from "./helpers.js";

const HOST = "127.0.0.1:5173";
const rid = (n: number) => `60000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const T0 = Date.parse("2026-10-21T10:00:00.000Z");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  vi.restoreAllMocks();
});

const SEED = { Todos: [todo(1), todo(2), todo(3)], Quarantine: [] };

function setup() {
  const t = tempPaths({ seedSettings: true });
  cleanups.push(t.cleanup);
  const sheets = gatedSheets(structuredClone(SEED));
  const clock = { now: T0 };
  const service = new AssistantService({
    paths: t.paths,
    sheets: sheets.gated,
    configured: () => Promise.resolve({ gmail: true, whatsapp: true }),
    warn: () => undefined,
    composer: new FakeComposer(),
    now: () => clock.now,
  });
  cleanups.push(() => service.close());
  const app = createApp({
    paths: t.paths,
    fake: true,
    webPort: 5173,
    sheets: sheets.gated,
    assistant: service,
  });
  return { app, service, sheets, clock, paths: t.paths };
}

type App = ReturnType<typeof createApp>;
const get = (app: App, path: string) => request(app).get(path).set("Host", HOST);
const post = (app: App, path: string, body: unknown) =>
  request(app)
    .post(path)
    .set("Host", HOST)
    .set("X-Yarvis", "1")
    .send(body as object);
const patch = (app: App, id: string, body: unknown) =>
  request(app)
    .patch(`/api/assistant/preparations/${id}`)
    .set("Host", HOST)
    .set("X-Yarvis", "1")
    .send(body as object);

async function pollUntilDone(app: App, id: string): Promise<AssistantRun> {
  for (let i = 0; i < 400; i++) {
    const run = ((await get(app, `/api/assistant/runs/${id}`)).body as { run: AssistantRun }).run;
    if (run.state !== "running") return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("run never finished");
}

/** Briefing -> prepare the Todo at `n` -> the stored packet (FakeComposer, 3 checklist items). */
async function prepared(
  ctx: ReturnType<typeof setup>,
  n = 1,
  briefingId?: string,
): Promise<{ packet: PreparationPacket; briefingId: string }> {
  const { app, service } = ctx;
  let bid = briefingId;
  if (!bid) {
    const b = await post(app, "/api/assistant/briefings", { requestId: rid(0xb000 + n) });
    expect((await pollUntilDone(app, (b.body as { run: AssistantRun }).run.id)).state).toBe(
      "succeeded",
    );
    await service.idle();
    bid = ((await get(app, "/api/assistant/briefings/latest")).body as { briefing: Briefing })
      .briefing.id;
  }
  const p = await post(app, "/api/assistant/preparations", {
    requestId: rid(0xa000 + n),
    briefingId: bid,
    todoId: todo(n).id,
  });
  expect(p.status).toBe(202);
  const done = await pollUntilDone(app, (p.body as { run: AssistantRun }).run.id);
  expect(done.state).toBe("succeeded");
  await service.idle();
  const packet = (
    (await get(app, `/api/assistant/preparations/${done.targetId}`)).body as {
      packet: PreparationPacket;
    }
  ).packet;
  return { packet, briefingId: bid };
}

function editOf(p: PreparationPacket, over: Partial<PacketEdit> = {}): PacketEdit {
  return {
    expectedRevision: p.revision,
    draft: p.draft,
    checklist: p.checklist.map((c) => ({ ...c })),
    questions: [...p.questions],
    state: p.state,
    ...over,
  };
}

const errorOf = (res: { body: unknown }) =>
  res.body as { error?: string; message?: string; currentPacket?: PreparationPacket };

describe("PATCH /api/assistant/preparations/:id: compare-and-swap save", () => {
  it("saves the full edit, increments revision and updatedAt; GET reopens it", async () => {
    const ctx = setup();
    const { packet } = await prepared(ctx);
    expect(packet).toMatchObject({ revision: 1, state: "open" });
    expect(packet.checklist).toHaveLength(3);
    ctx.clock.now = T0 + 60_000;
    const edit = editOf(packet, {
      draft: "My own words.\nSecond line.",
      checklist: packet.checklist.map((c, i) =>
        i === 0 ? { ...c, text: "Edited step", done: true } : c,
      ),
      questions: ["Edited question?", "Another?"],
    });
    const res = await patch(ctx.app, packet.id, edit);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const saved = (res.body as { packet: PreparationPacket }).packet;
    expect(saved).toEqual({
      ...packet,
      revision: 2,
      updatedAt: new Date(T0 + 60_000).toISOString(),
      draft: edit.draft,
      checklist: edit.checklist,
      questions: edit.questions,
    });
    // Stable checklist ids, untouched provenance and capture.
    expect(saved.checklist.map((c) => c.id)).toEqual(packet.checklist.map((c) => c.id));
    expect(saved.createdAt).toBe(packet.createdAt);
    expect(saved.sourceRef).toEqual(packet.sourceRef);
    const reopened = await get(ctx.app, `/api/assistant/preparations/${packet.id}`);
    expect((reopened.body as { packet: PreparationPacket }).packet).toEqual(saved);
  });

  it("a stale second tab gets 409 revision_conflict with the current packet and changes nothing", async () => {
    const ctx = setup();
    const { packet } = await prepared(ctx);
    // Tab A and tab B both opened revision 1.
    const tabA = editOf(packet, { draft: "Tab A wins" });
    const tabB = editOf(packet, { draft: "Tab B is stale" });
    ctx.clock.now = T0 + 1_000;
    const a = await patch(ctx.app, packet.id, tabA);
    expect(a.status).toBe(200);
    const savedA = (a.body as { packet: PreparationPacket }).packet;
    ctx.clock.now = T0 + 2_000;
    const b = await patch(ctx.app, packet.id, tabB);
    expect(b.status).toBe(409);
    expect(errorOf(b).error).toBe("revision_conflict");
    expect(errorOf(b).currentPacket).toEqual(savedA);
    expect(errorOf(b).message).not.toContain("Tab B");
    const now = (
      (await get(ctx.app, `/api/assistant/preparations/${packet.id}`)).body as {
        packet: PreparationPacket;
      }
    ).packet;
    expect(now).toEqual(savedA);
    // Tab B keeps its text locally and may re-base on the current revision explicitly.
    const rebased = await patch(ctx.app, packet.id, { ...tabB, expectedRevision: 2 });
    expect(rebased.status).toBe(200);
    expect((rebased.body as { packet: PreparationPacket }).packet).toMatchObject({
      revision: 3,
      draft: "Tab B is stale",
    });
  });

  it("concurrent saves of the same revision: exactly one wins", async () => {
    const ctx = setup();
    const { packet } = await prepared(ctx);
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => patch(ctx.app, packet.id, editOf(packet, { draft: `tab ${n}` }))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    const current = (
      (await get(ctx.app, `/api/assistant/preparations/${packet.id}`)).body as {
        packet: PreparationPacket;
      }
    ).packet;
    expect(current.revision).toBe(2);
  });

  it("handled / reopen is a revision-checked local status that never writes the sheet", async () => {
    const ctx = setup();
    const { packet } = await prepared(ctx);
    const todosBefore = await ctx.sheets.store.readRows(TODOS);
    const quarantineBefore = await ctx.sheets.store.readRows(QUARANTINE);
    const writes = [
      vi.spyOn(ctx.sheets.gated, "upsertRows"),
      vi.spyOn(ctx.sheets.gated, "updateRow"),
      vi.spyOn(ctx.sheets.gated, "ensureTab"),
      vi.spyOn(ctx.sheets.store, "upsertRows"),
      vi.spyOn(ctx.sheets.store, "updateRow"),
      vi.spyOn(ctx.sheets.store, "ensureTab"),
    ];
    const readsBefore = ctx.sheets.reads;

    const handled = await patch(ctx.app, packet.id, editOf(packet, { state: "handled" }));
    expect(handled.status).toBe(200);
    const h = (handled.body as { packet: PreparationPacket }).packet;
    expect(h).toMatchObject({ state: "handled", revision: 2 });
    const reopened = await patch(ctx.app, packet.id, editOf(h, { state: "open" }));
    expect(reopened.status).toBe(200);
    expect((reopened.body as { packet: PreparationPacket }).packet).toMatchObject({
      state: "open",
      revision: 3,
    });

    for (const w of writes) expect(w).not.toHaveBeenCalled();
    expect(ctx.sheets.reads).toBe(readsBefore); // a save never even reads the sheet
    expect(await ctx.sheets.store.readRows(TODOS)).toEqual(todosBefore);
    expect(await ctx.sheets.store.readRows(QUARANTINE)).toEqual(quarantineBefore);
    expect(todosBefore.find((t) => t.id === packet.todoId)?.status).toBe("open");
  });

  it("saves stay available while another run holds the assistant lock (no lock, no network)", async () => {
    const ctx = setup();
    const { packet } = await prepared(ctx);
    const gate = ctx.sheets.hold();
    const b = await post(ctx.app, "/api/assistant/briefings", { requestId: rid(0xc1) });
    expect(b.status).toBe(202);
    await gate.started;
    const res = await patch(ctx.app, packet.id, editOf(packet, { draft: "during a run" }));
    expect(res.status).toBe(200);
    gate.release();
    await ctx.service.idle();
  });
});

describe("PATCH validation", () => {
  it("400 bad_id for a non-UUID id; 404 for an unknown packet; X-Yarvis required", async () => {
    const ctx = setup();
    const { packet } = await prepared(ctx);
    const body = editOf(packet);
    expect(errorOf(await patch(ctx.app, "nope", body)).error).toBe("bad_id");
    const unknown = await patch(ctx.app, rid(0xdead), body);
    expect(unknown.status).toBe(404);
    expect(errorOf(unknown).error).toBe("not_found");
    const noHeader = await request(ctx.app)
      .patch(`/api/assistant/preparations/${packet.id}`)
      .set("Host", HOST)
      .send(body);
    expect(noHeader.status).toBe(403);
  });

  it("rejects out-of-bounds or malformed edits with 400 and leaves the packet unchanged", async () => {
    const ctx = setup();
    const { packet } = await prepared(ctx);
    const ids = packet.checklist.map((c) => c.id);
    const item = (i: number) => packet.checklist[i]!;
    const bad: Array<[string, unknown]> = [
      ["extra field", { ...editOf(packet), sourceRef: packet.sourceRef }],
      ["missing expectedRevision", { ...editOf(packet), expectedRevision: undefined }],
      ["string revision", { ...editOf(packet), expectedRevision: "1" }],
      ["zero revision", editOf(packet, { expectedRevision: 0 })],
      ["fractional revision", editOf(packet, { expectedRevision: 1.5 })],
      ["draft too long", editOf(packet, { draft: "x".repeat(DRAFT_MAX_CHARS + 1) })],
      ["bad state", { ...editOf(packet), state: "done" }],
      ["empty checklist", editOf(packet, { checklist: [] })],
      [
        "13 checklist items",
        editOf(packet, {
          checklist: Array.from({ length: 13 }, (_, i) => ({
            id: rid(0x100 + i),
            text: "x",
            done: false,
          })),
        }),
      ],
      [
        "blank item text",
        editOf(packet, { checklist: [{ ...item(0), text: "  " }, item(1), item(2)] }),
      ],
      [
        "item text too long",
        editOf(packet, {
          checklist: [
            { ...item(0), text: "x".repeat(CHECKLIST_ITEM_MAX_CHARS + 1) },
            item(1),
            item(2),
          ],
        }),
      ],
      [
        "non-boolean done",
        { ...editOf(packet), checklist: [{ ...item(0), done: "yes" }, item(1), item(2)] },
      ],
      [
        "extra item field",
        { ...editOf(packet), checklist: [{ ...item(0), html: "<b>" }, item(1), item(2)] },
      ],
      [
        "non-UUID item id",
        editOf(packet, { checklist: [{ ...item(0), id: "1" }, item(1), item(2)] }),
      ],
      ["duplicate item ids", editOf(packet, { checklist: [item(0), item(0), item(2)] })],
      ["blank question", editOf(packet, { questions: [" "] })],
      [
        "too many questions",
        editOf(packet, { questions: Array.from({ length: QUESTIONS_MAX_ITEMS + 1 }, () => "q?") }),
      ],
    ];
    for (const [name, body] of bad) {
      const res = await patch(ctx.app, packet.id, body);
      expect(res.status, name).toBe(400);
      expect(errorOf(res).error, name).toBe("bad_request");
    }
    // Checklist ids must be exactly the saved ones, in order (validated server-side).
    const idCases: Array<[string, PacketEdit]> = [
      [
        "foreign id",
        editOf(packet, { checklist: [{ ...item(0), id: rid(0x999) }, item(1), item(2)] }),
      ],
      ["reordered", editOf(packet, { checklist: [item(1), item(0), item(2)] })],
      ["removed", editOf(packet, { checklist: [item(0), item(1)] })],
      [
        "added",
        editOf(packet, {
          checklist: [...packet.checklist, { id: rid(0x998), text: "new", done: false }],
        }),
      ],
    ];
    for (const [name, body] of idCases) {
      const res = await patch(ctx.app, packet.id, body);
      expect(res.status, name).toBe(400);
      expect(errorOf(res).message, name).toContain("checklist item ids");
    }
    const after = (
      (await get(ctx.app, `/api/assistant/preparations/${packet.id}`)).body as {
        packet: PreparationPacket;
      }
    ).packet;
    expect(after).toEqual(packet);
    expect(after.checklist.map((c) => c.id)).toEqual(ids);
  });

  it("the 64 KiB body cap still applies", async () => {
    const ctx = setup();
    const { packet } = await prepared(ctx);
    const res = await patch(ctx.app, packet.id, {
      ...editOf(packet),
      draft: "x".repeat(70 * 1024),
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).error).toBe("bad_request");
  });

  it("edits at the exact bounds are accepted", async () => {
    const ctx = setup();
    const { packet } = await prepared(ctx);
    const res = await patch(
      ctx.app,
      packet.id,
      editOf(packet, {
        draft: "d".repeat(DRAFT_MAX_CHARS),
        checklist: packet.checklist.map((c) => ({
          ...c,
          text: "c".repeat(CHECKLIST_ITEM_MAX_CHARS),
        })),
        questions: Array.from({ length: QUESTIONS_MAX_ITEMS }, (_, i) => `q${i}?`),
      }),
    );
    expect(res.status).toBe(200);
    // An empty draft and no questions are valid too (the composer may produce them).
    const saved = (res.body as { packet: PreparationPacket }).packet;
    const empty = await patch(ctx.app, packet.id, editOf(saved, { draft: "", questions: [] }));
    expect(empty.status).toBe(200);
  });
});

describe("GET /api/assistant/preparations", () => {
  it("empty store: no packets, total 0", async () => {
    const ctx = setup();
    const res = await get(ctx.app, "/api/assistant/preparations");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ packets: [], total: 0, omittedCount: 0 });
  });

  it("summaries ordered by updatedAt descending; an edit moves a packet to the top", async () => {
    const ctx = setup();
    const first = await prepared(ctx, 1);
    ctx.clock.now = T0 + 10_000;
    const second = await prepared(ctx, 2, first.briefingId);
    let list = (await get(ctx.app, "/api/assistant/preparations")).body as PacketListResponse;
    expect(list.packets.map((p) => p.id)).toEqual([second.packet.id, first.packet.id]);
    expect(list).toMatchObject({ total: 2, omittedCount: 0 });
    expect(list.packets[1]).toEqual({
      id: first.packet.id,
      todoId: todo(1).id,
      context: todo(1).context,
      state: "open",
      updatedAt: first.packet.updatedAt,
      revision: 1,
    });
    ctx.clock.now = T0 + 20_000;
    expect(
      (await patch(ctx.app, first.packet.id, editOf(first.packet, { state: "handled" }))).status,
    ).toBe(200);
    list = (await get(ctx.app, "/api/assistant/preparations")).body as PacketListResponse;
    expect(list.packets.map((p) => [p.id, p.state, p.revision])).toEqual([
      [first.packet.id, "handled", 2],
      [second.packet.id, "open", 1],
    ]);
    // Summaries carry no draft, checklist or excerpt.
    expect(Object.keys(list.packets[0]!).sort()).toEqual(
      ["context", "id", "revision", "state", "todoId", "updatedAt"].sort(),
    );
  });

  it("caps at the 100 most recently updated with total + omittedCount; older ones still open by id", async () => {
    const ctx = setup();
    const store = AssistantStore.open(ctx.paths);
    const n = PACKET_LIST_CAP + 3;
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const at = new Date(T0 + i * 1_000).toISOString();
      const run = store.insertRun({
        id: rid(0x10000 + i),
        requestId: rid(0x20000 + i),
        requestHash: "h",
        kind: "prepare",
        createdAt: at,
      });
      const t = todo(1000 + i);
      store.commitPacket(run.id, {
        id: rid(0x30000 + i),
        todoId: t.id,
        sourceRef: {
          todoId: t.id,
          source: t.source,
          sender: t.sender,
          context: t.context,
          messageDate: t.message_date,
          link: t.link,
          originalText: t.original_text,
          action: t.action,
          extractionStatus: t.extraction_status,
        },
        createdAt: at,
        updatedAt: at,
        revision: 1,
        state: "open",
        draft: "d",
        checklist: [{ id: rid(0x40000 + i), text: "c", done: false }],
        questions: [],
        model: "m",
        promptVersion: "p",
      });
      ids.push(rid(0x30000 + i));
    }
    store.close();
    const list = (await get(ctx.app, "/api/assistant/preparations")).body as PacketListResponse;
    expect(list.total).toBe(n);
    expect(list.omittedCount).toBe(3);
    expect(list.packets).toHaveLength(PACKET_LIST_CAP);
    expect(list.packets[0]?.id).toBe(ids[n - 1]);
    expect(list.packets.map((p) => p.id)).not.toContain(ids[0]);
    const oldest = await get(ctx.app, `/api/assistant/preparations/${ids[0]}`);
    expect(oldest.status).toBe(200);
  });
});

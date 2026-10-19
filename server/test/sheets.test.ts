// connectors/sheets.ts against the in-memory FakeSheetsApi (no network): upsert planning, column
// ownership, ensureTab, header mismatch, retries and timeouts (plan §3.4, D18, D20, D29).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QUARANTINE_HEADER, TODO_HEADER, type QuarantineItem, type Todo } from "@yarvis/shared";
import {
  createSheetsStore,
  googleSheetsTarget,
  MAX_CELL_CHARS,
  planUpsert,
  QUARANTINE,
  SheetsError,
  TODOS,
  type SheetsApi,
} from "../src/connectors/sheets.js";
import {
  createFakeSheets,
  FakeSheetsApi,
  loadSheetSeed,
  type FakeMethod,
} from "../src/fakes/sheets.js";
import { REPO_ROOT, resolvePaths } from "../src/config/paths.js";

function todo(over: Partial<Todo> & Pick<Todo, "id">): Todo {
  return {
    source: "gmail",
    status: "open",
    action: "Do the thing",
    extraction_status: "done",
    original_text: "please do the thing",
    sender: "someone@example.com",
    context: "Subject",
    message_date: "2026-10-18T10:00:00.000Z",
    link: "",
    jev_action: 0.8,
    created_at: "2026-10-18T11:00:00.000Z",
    updated_at: "2026-10-18T11:00:00.000Z",
    ...over,
  };
}

const header = [...TODO_HEADER];
const row = (t: Todo) => TODO_HEADER.map((c) => TODOS.toCells(t)[c]);

function emptyFake() {
  return createFakeSheets({ seed: null });
}

function calls(api: FakeSheetsApi, method: FakeMethod) {
  return api.calls.filter((c) => c.method === method);
}

describe("shared header constants are imported, never redeclared", () => {
  it("TODO_HEADER / QUARANTINE_HEADER used by the server ARE the shared tuples", () => {
    // toBe = reference identity on arrays: a re-declared copy with equal contents fails here.
    expect(TODOS.header).toBe(TODO_HEADER);
    expect(QUARANTINE.header).toBe(QUARANTINE_HEADER);
    // Red anchor: an equal copy is NOT the same reference, so the check above can fail.
    expect([...TODO_HEADER]).not.toBe(TODO_HEADER);
  });
});

describe("planUpsert (pure)", () => {
  const a = todo({ id: "gmail:aa#1", action: "A" });
  const b = todo({ id: "gmail:bb#1", action: "B" });

  it("existing ids -> full-row batchUpdate ranges; new ids -> append; unchanged rows skipped", () => {
    const table = [header, row(a), row(b)];
    const plan = planUpsert(TODOS, table, [
      { ...a, action: "A2" },
      b, // identical -> no write
      todo({ id: "gmail:cc#1", action: "C" }),
    ]);
    expect(plan.updates.map((u) => u.range)).toEqual(["'Todos'!A2:M2"]);
    expect(plan.updates[0]?.values[0]?.[3]).toBe("A2");
    expect(plan.appends.map((r) => r[0])).toEqual(["gmail:cc#1"]);
    expect(plan.unchanged).toBe(1);
  });

  it("dedupes incoming rows by id (last wins) and maps duplicate sheet ids to the first row", () => {
    const table = [header, row(a), row({ ...a, action: "dup" })];
    const plan = planUpsert(TODOS, table, [
      { ...a, action: "x" },
      { ...a, action: "y" },
    ]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]?.range).toBe("'Todos'!A2:M2");
    expect(plan.updates[0]?.values[0]?.[3]).toBe("y");
  });
});

describe("SheetsStore against FakeSheetsApi", () => {
  it("ensureTab creates a missing tab with the pinned header", async () => {
    const { api, store } = emptyFake();
    await store.ensureTab(TODOS);
    expect(api.grid("Todos")).toEqual([header]);
    expect(calls(api, "spreadsheets.batchUpdate")).toHaveLength(1);
    // Cached: a second ensureTab makes no calls.
    const before = api.calls.length;
    await store.ensureTab(TODOS);
    expect(api.calls.length).toBe(before);
  });

  it("concurrent first ensures of a missing tab share one addSheet and all succeed", async () => {
    const { api, store } = emptyFake();
    await Promise.all([
      store.readRows(QUARANTINE),
      store.readRows(QUARANTINE),
      store.ensureTab(QUARANTINE),
    ]);
    expect(calls(api, "spreadsheets.batchUpdate")).toHaveLength(1);
    expect(api.grid("Quarantine")).toEqual([[...QUARANTINE_HEADER]]);
  });

  it("an addSheet 'already exists' (tab created by another writer) is success, then the header is verified", async () => {
    const { api, store } = emptyFake();
    const get = api.spreadsheets.get.bind(api.spreadsheets);
    // The tab appears between the metadata read and addSheet, header included.
    api.spreadsheets.get = async (params, opts) => {
      const res = await get(params, opts);
      api.tabs.set("Todos", [[...header]]);
      return res;
    };
    await store.ensureTab(TODOS);
    expect(calls(api, "spreadsheets.batchUpdate")).toHaveLength(1);
    expect(calls(api, "values.get")).toHaveLength(1); // the header read
    expect(calls(api, "values.update")).toHaveLength(0);

    // The same race against a tab with a different header is still a hard mismatch.
    const other = emptyFake();
    const get2 = other.api.spreadsheets.get.bind(other.api.spreadsheets);
    other.api.spreadsheets.get = async (params, opts) => {
      const res = await get2(params, opts);
      other.api.tabs.set("Todos", [["something", "else"]]);
      return res;
    };
    await expect(other.store.ensureTab(TODOS)).rejects.toMatchObject({ kind: "header_mismatch" });
  });

  it("a failed ensure is not cached: the next call retries", async () => {
    const { api, store } = emptyFake();
    api.failNext("spreadsheets.get", 403);
    await expect(store.ensureTab(TODOS)).rejects.toMatchObject({ kind: "upstream" });
    await store.ensureTab(TODOS);
    expect(api.grid("Todos")).toEqual([header]);
  });

  it("a tab deleted mid-session is re-created by the next read", async () => {
    const { api, store } = createFakeSheets();
    expect((await store.readRows(TODOS)).length).toBeGreaterThan(0);
    api.tabs.delete("Todos");
    expect(await store.readRows(TODOS)).toEqual([]);
    expect(api.grid("Todos")).toEqual([header]);
  });

  it("ensureTab writes the header into an existing empty tab", async () => {
    const { api, store } = emptyFake();
    api.tabs.set("Quarantine", []);
    await store.ensureTab(QUARANTINE);
    expect(api.grid("Quarantine")).toEqual([[...QUARANTINE_HEADER]]);
    expect(calls(api, "spreadsheets.batchUpdate")).toHaveLength(0);
  });

  it("a header mismatch is a hard error and never an overwrite", async () => {
    const { api, store } = emptyFake();
    const wrong = header.map((c) => (c === "status" ? "state" : c));
    api.tabs.set("Todos", [wrong]);
    await expect(store.readRows(TODOS)).rejects.toMatchObject({
      name: "SheetsError",
      kind: "header_mismatch",
    });
    await expect(store.upsertRows(TODOS, [todo({ id: "gmail:aa#1" })])).rejects.toBeInstanceOf(
      SheetsError,
    );
    expect(api.writes()).toEqual([]);
    expect(api.grid("Todos")).toEqual([wrong]);
  });

  it("an extra trailing header column is also a mismatch", async () => {
    const { api, store } = emptyFake();
    api.tabs.set("Todos", [[...header, "notes"]]);
    await expect(store.ensureTab(TODOS)).rejects.toMatchObject({ kind: "header_mismatch" });
  });

  it("upsertRows = ONE values.batchUpdate for existing ids + ONE values.append for new ids", async () => {
    const { api, store } = emptyFake();
    const existing = [todo({ id: "gmail:aa#1" }), todo({ id: "gmail:bb#1" })];
    await store.upsertRows(TODOS, existing);
    api.calls.length = 0;

    const result = await store.upsertRows(TODOS, [
      { ...existing[0]!, action: "changed A" },
      { ...existing[1]!, action: "changed B" },
      todo({ id: "gmail:cc#1" }),
      todo({ id: "gmail:dd#1" }),
    ]);
    expect(result).toEqual({ updated: 2, appended: 2, unchanged: 0 });
    const batch = calls(api, "values.batchUpdate");
    const append = calls(api, "values.append");
    expect(batch).toHaveLength(1);
    expect(append).toHaveLength(1);
    expect(
      (
        batch[0]?.params as { requestBody: { data: Array<{ range: string }> } }
      ).requestBody.data.map((d) => d.range),
    ).toEqual(["'Todos'!A2:M2", "'Todos'!A3:M3"]);
    expect(append[0]?.params).toMatchObject({
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
    });
    expect((await store.readRows(TODOS)).map((t) => [t.id, t.action])).toEqual([
      ["gmail:aa#1", "changed A"],
      ["gmail:bb#1", "changed B"],
      ["gmail:cc#1", "Do the thing"],
      ["gmail:dd#1", "Do the thing"],
    ]);
  });

  it("an upsert of an existing row keeps its status and created_at", async () => {
    const { store } = emptyFake();
    await store.upsertRows(TODOS, [todo({ id: "gmail:aa#1", created_at: "2026-10-02T00:00:00Z" })]);
    await store.updateRow(TODOS, "gmail:aa#1", { status: "done" });

    await store.upsertRows(TODOS, [
      todo({
        id: "gmail:aa#1",
        status: "open",
        created_at: "2026-10-19T00:00:00Z",
        action: "rewritten by a retry",
        updated_at: "2026-10-19T00:00:00Z",
      }),
    ]);
    const [got] = await store.readRows(TODOS);
    expect(got).toMatchObject({
      status: "done",
      created_at: "2026-10-02T00:00:00Z",
      action: "rewritten by a retry",
      updated_at: "2026-10-19T00:00:00Z",
    });
  });

  it("a row with extraction_status = pending round-trips through upsertRows/readRows", async () => {
    const { store } = emptyFake();
    const pending = todo({
      id: "wa:15555550123@s.whatsapp.net:3EB0A1#1",
      source: "whatsapp",
      extraction_status: "pending",
      action: "can you grab milk?",
      original_text: "can you grab milk?",
      jev_action: 0.73,
    });
    await store.upsertRows(TODOS, [pending]);
    expect(await store.readRows(TODOS)).toEqual([pending]);
  });

  it("quarantine rows round-trip, null scores included", async () => {
    const { store } = emptyFake();
    const rows: QuarantineItem[] = loadSheetSeed().Quarantine;
    await store.upsertRows(QUARANTINE, rows);
    expect(await store.readRows(QUARANTINE)).toEqual(rows);
  });

  it("retries a 429 then succeeds (no lost or duplicated write)", async () => {
    const { api, store } = emptyFake();
    await store.ensureTab(TODOS);
    api.failNext("values.append", 429);
    await store.upsertRows(TODOS, [todo({ id: "gmail:aa#1" })]);
    expect(calls(api, "values.append")).toHaveLength(2);
    expect((await store.readRows(TODOS)).map((t) => t.id)).toEqual(["gmail:aa#1"]);
  });

  it("surfaces a non-retryable failure as SheetsError upstream without retrying", async () => {
    const { api, store } = emptyFake();
    api.failNext("spreadsheets.get", 403);
    await expect(store.readRows(TODOS)).rejects.toMatchObject({
      kind: "upstream",
      message: "Sheets get spreadsheet failed (HTTP 403)",
    });
    expect(calls(api, "spreadsheets.get")).toHaveLength(1);
  });

  it("a hung call fails at the per-call timeout", async () => {
    const { api, store } = createFakeSheets({ seed: null, timeoutMs: 20 });
    api.hangNext("spreadsheets.get");
    await expect(store.ensureTab(TODOS)).rejects.toMatchObject({
      kind: "upstream",
      message: "Sheets get spreadsheet timed out after 20 ms",
    });
  });

  it("updateRow writes only the patched cells", async () => {
    const { api, store } = createFakeSheets();
    api.calls.length = 0;
    const id = "wa:15555550123@s.whatsapp.net:3EB0A1C2D3E4F5#1";
    const updated = await store.updateRow(TODOS, id, {
      status: "done",
      updated_at: "2026-10-19T12:00:00.000Z",
    });
    expect(updated).toMatchObject({ id, status: "done", updated_at: "2026-10-19T12:00:00.000Z" });
    const [write] = api.writes();
    expect(api.writes()).toHaveLength(1);
    expect(
      (write?.params as { requestBody: { data: Array<{ range: string }> } }).requestBody.data.map(
        (d) => d.range,
      ),
    ).toEqual(["'Todos'!C4", "'Todos'!M4"]);
  });

  it("updateRow does not write to a row readRows cannot represent", async () => {
    const { api, store } = emptyFake();
    const bad = TODO_HEADER.map((c) => (c === "id" ? "x:unknown#1" : ""));
    api.tabs.set("Todos", [header, bad]);
    expect(await store.updateRow(TODOS, "x:unknown#1", { status: "done" })).toBeNull();
    expect(api.writes()).toEqual([]);
  });

  it("caps cell text at the Sheets 50,000-character limit", async () => {
    const { store } = emptyFake();
    await store.upsertRows(TODOS, [todo({ id: "gmail:aa#1", original_text: "x".repeat(60_000) })]);
    const [got] = await store.readRows(TODOS);
    expect(got?.original_text).toHaveLength(MAX_CELL_CHARS);
  });

  it("serializes concurrent upserts so a new id is appended once", async () => {
    const { store } = emptyFake();
    const t = todo({ id: "gmail:aa#1" });
    await Promise.all([store.upsertRows(TODOS, [t]), store.upsertRows(TODOS, [t])]);
    expect((await store.readRows(TODOS)).length).toBe(1);
  });
});

describe("FakeSheets seeding", () => {
  it("seeds both tabs from server/fixtures/sheet-seed.json with synthetic data only", async () => {
    const seed = loadSheetSeed();
    const { store } = createFakeSheets();
    expect(await store.readRows(TODOS)).toEqual(seed.Todos);
    expect(await store.readRows(QUARANTINE)).toEqual(seed.Quarantine);
    for (const t of [...seed.Todos, ...seed.Quarantine]) {
      if (t.source === "gmail") expect(t.sender).toMatch(/@([a-z-]+\.)*example\.com$/);
      else expect(t.id).toMatch(/^wa:1555555\d{4}@/);
    }
  });
});

describe("googleSheetsTarget (real mode wiring, no network)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function privateDir(settings: { sheetId: string }, withKey: boolean) {
    const dir = mkdtempSync(path.join(tmpdir(), "yarvis-test-"));
    dirs.push(dir);
    const paths = resolvePaths({ YARVIS_PRIVATE_DIR: dir }, REPO_ROOT);
    writeFileSync(
      paths.settingsFile,
      JSON.stringify({
        sheetId: settings.sheetId,
        pirate: false,
        since: "2026-10-01",
        whatsapp: { allowlist: [] },
        jev: { model: "jev-latest", concurrency: 2, thresholds: { quarantine: 0.5, action: 0.6 } },
        extract: { model: "claude-haiku-5-5", timeoutMs: 60000 },
      }),
    );
    if (withKey) writeFileSync(paths.serviceAccountFile, "{}");
    return paths;
  }

  it("is not_configured with the placeholder sheetId or without service-account.json", async () => {
    const neverApi = () => Promise.reject(new Error("must not build a client"));
    await expect(
      googleSheetsTarget(privateDir({ sheetId: "<google sheet id>" }, true), neverApi)(),
    ).rejects.toMatchObject({ kind: "not_configured" });
    await expect(
      googleSheetsTarget(privateDir({ sheetId: "1AbCdEfGhIjKlMnOp" }, false), neverApi)(),
    ).rejects.toMatchObject({ kind: "not_configured" });
  });

  it("builds the client from the service-account key file and targets settings.sheetId", async () => {
    const paths = privateDir({ sheetId: "1AbCdEfGhIjKlMnOp" }, true);
    const api = new FakeSheetsApi();
    const keyFiles: string[] = [];
    const resolve = googleSheetsTarget(paths, (keyFile) => {
      keyFiles.push(keyFile);
      return Promise.resolve(api as SheetsApi);
    });
    const store = createSheetsStore({ target: resolve });
    await store.ensureTab(TODOS);
    await store.ensureTab(QUARANTINE);
    expect(keyFiles).toEqual([paths.serviceAccountFile]); // one client, reused
    expect(api.calls[0]?.params).toEqual({ spreadsheetId: "1AbCdEfGhIjKlMnOp" });
  });
});

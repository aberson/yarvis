// FakeSheets (plan §5, D11): an in-memory implementation of the `SheetsApi` surface, so fake mode and
// tests run the REAL store logic (ensureTab, upsert planning, column ownership, retries) against it.
// Seeded from server/fixtures/sheet-seed.json (`{Todos: Todo[], Quarantine: QuarantineItem[]}`).
// It records every call and can inject failures (an HTTP status, or a hang for timeout tests).
import { readFileSync } from "node:fs";
import path from "node:path";
import type { QuarantineItem, Todo } from "@yarvis/shared";
import { REPO_ROOT } from "../config/paths.js";
import {
  cellText,
  createSheetsStore,
  QUARANTINE,
  TODOS,
  type CallOpts,
  type CellValue,
  type SheetsApi,
  type SheetsStore,
  type SheetsStoreOptions,
} from "../connectors/sheets.js";

export const FIXTURES_DIR = path.join(REPO_ROOT, "server", "fixtures");
export const SHEET_SEED_FILE = path.join(FIXTURES_DIR, "sheet-seed.json");
export const FAKE_SPREADSHEET_ID = "fake-spreadsheet-0000000000";

export type FakeMethod =
  | "spreadsheets.get"
  | "spreadsheets.batchUpdate"
  | "values.get"
  | "values.update"
  | "values.batchUpdate"
  | "values.append";

export const WRITE_METHODS: ReadonlySet<FakeMethod> = new Set([
  "spreadsheets.batchUpdate",
  "values.update",
  "values.batchUpdate",
  "values.append",
]);

export interface FakeCall {
  method: FakeMethod;
  params: unknown;
}

type Fault = { kind: "status"; status: number } | { kind: "hang" };

interface A1 {
  tab: string;
  c1: number;
  r1: number | undefined;
  c2: number;
  r2: number | undefined;
}

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Parses the A1 ranges the store produces: 'Tab'!A1, 'Tab'!A1:M1, 'Tab'!A:Z. */
function parseA1(range: string): A1 {
  const m = /^'((?:[^']|'')+)'!([A-Z]+)([0-9]+)?(?::([A-Z]+)([0-9]+)?)?$/.exec(range);
  if (!m) throw Object.assign(new Error(`Unable to parse range: ${range}`), { status: 400 });
  const [, tabQ = "", a = "A", r1, b, r2] = m;
  const row1 = r1 === undefined ? undefined : Number(r1);
  return {
    tab: tabQ.replace(/''/g, "'"),
    c1: colIndex(a),
    r1: row1,
    // A single cell ('Tab'!C5) spans one row; an open range ('Tab'!A:Z) runs to the end.
    c2: colIndex(b ?? a),
    r2: b === undefined ? row1 : r2 === undefined ? undefined : Number(r2),
  };
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

export class FakeSheetsApi implements SheetsApi {
  /** Tab name -> grid of cells ("" = empty). */
  readonly tabs = new Map<string, CellValue[][]>();
  readonly calls: FakeCall[] = [];
  private readonly faults: Array<{ method: FakeMethod; fault: Fault }> = [];

  /** The next `times` calls of `method` reject with an HTTP `status` error. */
  failNext(method: FakeMethod, status: number, times = 1): void {
    for (let i = 0; i < times; i++) this.faults.push({ method, fault: { kind: "status", status } });
  }

  /** The next call of `method` never settles (timeout tests). */
  hangNext(method: FakeMethod): void {
    this.faults.push({ method, fault: { kind: "hang" } });
  }

  /** Calls that would write to the sheet. */
  writes(): FakeCall[] {
    return this.calls.filter((c) => WRITE_METHODS.has(c.method));
  }

  /** A copy of a tab's grid, trailing empties trimmed (what a values.get would show). */
  grid(tab: string): string[][] {
    return (this.tabs.get(tab) ?? []).map((row) => row.map(cellText));
  }

  private async enter(method: FakeMethod, params: unknown, _opts: CallOpts): Promise<void> {
    this.calls.push({ method, params: structuredClone(params) });
    const i = this.faults.findIndex((f) => f.method === method);
    if (i < 0) return;
    const fault = this.faults.splice(i, 1)[0]?.fault;
    if (fault?.kind === "hang") await new Promise<never>(() => undefined);
    else if (fault) throw httpError(fault.status, `fake ${method} HTTP ${fault.status}`);
  }

  private tab(name: string): CellValue[][] {
    const grid = this.tabs.get(name);
    if (!grid) throw httpError(400, `Unable to parse range: no tab named ${name}`);
    return grid;
  }

  private write(range: string, values: CellValue[][]): void {
    const a = parseA1(range);
    const grid = this.tab(a.tab);
    const startRow = (a.r1 ?? 1) - 1;
    values.forEach((rowValues, dr) => {
      const r = startRow + dr;
      while (grid.length <= r) grid.push([]);
      const row = grid[r] as CellValue[];
      rowValues.forEach((v, dc) => {
        const c = a.c1 + dc;
        while (row.length <= c) row.push("");
        row[c] = v;
      });
    });
  }

  private read(range: string): unknown[][] {
    const a = parseA1(range);
    const grid = this.tab(a.tab);
    const r1 = (a.r1 ?? 1) - 1;
    const r2 = (a.r2 ?? grid.length) - 1;
    const out: unknown[][] = [];
    for (let r = r1; r <= r2 && r < grid.length; r++) {
      const row = (grid[r] ?? []).slice(a.c1, a.c2 + 1);
      while (row.length > 0 && cellText(row[row.length - 1]) === "") row.pop();
      out.push(row);
    }
    while (out.length > 0 && (out[out.length - 1] ?? []).length === 0) out.pop();
    return out;
  }

  readonly spreadsheets: SheetsApi["spreadsheets"] = {
    get: async (params, opts) => {
      await this.enter("spreadsheets.get", params, opts);
      return {
        data: { sheets: [...this.tabs.keys()].map((title) => ({ properties: { title } })) },
      };
    },
    batchUpdate: async (params, opts) => {
      await this.enter("spreadsheets.batchUpdate", params, opts);
      for (const req of params.requestBody.requests) {
        const title = req.addSheet.properties.title;
        if (this.tabs.has(title)) throw httpError(400, `A sheet named ${title} already exists`);
        this.tabs.set(title, []);
      }
      return {};
    },
    values: {
      get: async (params, opts) => {
        await this.enter("values.get", params, opts);
        const values = this.read(params.range);
        return { data: values.length > 0 ? { values: structuredClone(values) } : {} };
      },
      update: async (params, opts) => {
        await this.enter("values.update", params, opts);
        this.write(params.range, params.requestBody.values);
        return {};
      },
      batchUpdate: async (params, opts) => {
        await this.enter("values.batchUpdate", params, opts);
        for (const d of params.requestBody.data) this.write(d.range, d.values);
        return {};
      },
      append: async (params, opts) => {
        await this.enter("values.append", params, opts);
        const a = parseA1(params.range);
        const grid = this.tab(a.tab);
        let last = grid.length;
        while (last > 0 && (grid[last - 1] ?? []).every((v) => cellText(v) === "")) last--;
        const quoted = `'${a.tab.replace(/'/g, "''")}'`;
        this.write(`${quoted}!A${last + 1}`, params.requestBody.values);
        return {};
      },
    },
  };
}

export interface SheetSeed {
  Todos: Todo[];
  Quarantine: QuarantineItem[];
}

export function loadSheetSeed(file: string = SHEET_SEED_FILE): SheetSeed {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<SheetSeed>;
  if (!Array.isArray(raw.Todos) || !Array.isArray(raw.Quarantine)) {
    throw new Error(`${file}: expected {Todos: Todo[], Quarantine: QuarantineItem[]}`);
  }
  return { Todos: raw.Todos, Quarantine: raw.Quarantine };
}

/** Puts both tabs (pinned header + seed rows) straight into the fake grid. */
export function seedFakeSheets(api: FakeSheetsApi, seed: SheetSeed): void {
  api.tabs.set(TODOS.name, [
    [...TODOS.header],
    ...seed.Todos.map((t) => {
      const cells = TODOS.toCells(t);
      return TODOS.header.map((c) => cells[c]);
    }),
  ]);
  api.tabs.set(QUARANTINE.name, [
    [...QUARANTINE.header],
    ...seed.Quarantine.map((q) => {
      const cells = QUARANTINE.toCells(q);
      return QUARANTINE.header.map((c) => cells[c]);
    }),
  ]);
}

export interface FakeSheets {
  api: FakeSheetsApi;
  store: SheetsStore;
}

/**
 * Fake-mode Sheets: a fresh in-memory spreadsheet seeded from the fixtures (pass `seed: null` for
 * an empty spreadsheet with no tabs). Retries use no real sleep.
 */
export function createFakeSheets(
  opts: { seed?: SheetSeed | null } & Partial<Omit<SheetsStoreOptions, "target">> = {},
): FakeSheets {
  const api = new FakeSheetsApi();
  const seed = opts.seed === undefined ? loadSheetSeed() : opts.seed;
  if (seed) seedFakeSheets(api, seed);
  const store = createSheetsStore({
    target: { api, spreadsheetId: FAKE_SPREADSHEET_ID },
    timeoutMs: opts.timeoutMs,
    retry: { sleep: () => Promise.resolve(), ...opts.retry },
  });
  return { api, store };
}

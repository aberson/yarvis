// Google Sheets store (plan §3.4, §5, D6, D7, D8, D18, D20, D29). The ONLY Sheets importer and the
// only module with a write scope. Writes are upserts keyed by `id`, never tab overwrites:
//   - the whole tab is read once (that read is the "column-A scan": it maps id -> row AND yields the
//     existing cells needed to merge under the column-ownership rule),
//   - ONE values.batchUpdate rewrites changed existing rows, ONE values.append adds new rows
//     (valueInputOption RAW), so a crash between the two leaves complete rows only and the next run
//     re-upserts idempotently;
//   - tabs and headers are created if missing (ensureTab); a header mismatch is a hard error, never
//     an overwrite;
//   - every call runs under util/retry.ts: 30 s per-call timeout, backoff on HTTP 429/500/503.
import { existsSync } from "node:fs";
import type { sheets_v4 } from "googleapis";
import {
  isSheetIdConfigured,
  QUARANTINE_HEADER,
  QUARANTINE_PRESERVED_ON_UPSERT,
  QUARANTINE_TAB,
  EXTRACTION_STATUSES,
  TODO_HEADER,
  TODO_PRESERVED_ON_UPSERT,
  TODO_STATUSES,
  TODOS_TAB,
  type ExtractionStatus,
  type QuarantineColumn,
  type QuarantineItem,
  type Source,
  type Todo,
  type TodoColumn,
  type TodoStatus,
} from "@yarvis/shared";
import type { Paths } from "../config/paths.js";
import { loadSettings } from "../config/settings.js";
import {
  callWithRetry,
  DEFAULT_CALL_TIMEOUT_MS,
  httpStatusOf,
  TimeoutError,
  type RetryOptions,
} from "../util/retry.js";

/** The only OAuth scope this module (and the app) ever requests with write access (§8). */
export const SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"] as const;

/** A cell as written (RAW) and as read back with UNFORMATTED_VALUE. */
export type CellValue = string | number;

export interface CallOpts {
  timeoutMs: number;
  signal: AbortSignal;
}

type ValueRows = CellValue[][];

/**
 * The subset of `sheets_v4.Sheets` the store uses. The real client is adapted to it in
 * `createGoogleSheetsApi`; tests and fake mode use `FakeSheetsApi` (server/src/fakes/sheets.ts).
 */
export interface SheetsApi {
  spreadsheets: {
    get(
      params: { spreadsheetId: string },
      opts: CallOpts,
    ): Promise<{
      data: { sheets?: Array<{ properties?: { title?: string | null } | null }> | null };
    }>;
    batchUpdate(
      params: {
        spreadsheetId: string;
        requestBody: { requests: Array<{ addSheet: { properties: { title: string } } }> };
      },
      opts: CallOpts,
    ): Promise<unknown>;
    values: {
      get(
        params: { spreadsheetId: string; range: string; valueRenderOption: "UNFORMATTED_VALUE" },
        opts: CallOpts,
      ): Promise<{ data: { values?: unknown[][] | null } }>;
      update(
        params: {
          spreadsheetId: string;
          range: string;
          valueInputOption: "RAW";
          requestBody: { values: ValueRows };
        },
        opts: CallOpts,
      ): Promise<unknown>;
      batchUpdate(
        params: {
          spreadsheetId: string;
          requestBody: {
            valueInputOption: "RAW";
            data: Array<{ range: string; values: ValueRows }>;
          };
        },
        opts: CallOpts,
      ): Promise<unknown>;
      append(
        params: {
          spreadsheetId: string;
          range: string;
          valueInputOption: "RAW";
          insertDataOption: "INSERT_ROWS";
          requestBody: { values: ValueRows };
        },
        opts: CallOpts,
      ): Promise<unknown>;
    };
  };
}

// ---------------------------------------------------------------------------------------------
// Tab specs: header + ownership + row codec. The headers are the shared tuples BY REFERENCE.

export interface TabSpec<C extends string, R extends { id: string }> {
  name: string;
  header: readonly C[];
  /** Columns an upsert of an existing row never overwrites once non-empty (§3.4, D18). */
  preserved: readonly C[];
  toCells(row: R): Record<C, CellValue>;
  /** Null when the row cannot be represented (it is skipped on read, never rewritten). */
  fromCells(cells: Record<C, string>): R | null;
}

/** The minimum ensureTab needs, so it accepts any spec. */
export interface TabShape {
  name: string;
  header: readonly string[];
}

/** Google Sheets rejects a whole write when any cell holds more than 50,000 characters. */
export const MAX_CELL_CHARS = 50_000;

function cellsOf<C extends string>(
  header: readonly C[],
  row: Record<C, unknown>,
): Record<C, CellValue> {
  const out = {} as Record<C, CellValue>;
  for (const c of header) {
    const v = row[c];
    out[c] =
      typeof v === "number"
        ? Number.isFinite(v)
          ? v
          : ""
        : v == null
          ? ""
          : String(v).slice(0, MAX_CELL_CHARS);
  }
  return out;
}

function pick<T extends string>(allowed: readonly T[], raw: string, fallback: T): T {
  const v = raw.trim().toLowerCase();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function sourceOf(raw: string, id: string): Source | null {
  const v = raw.trim().toLowerCase();
  if (v === "gmail" || v === "whatsapp") return v;
  if (id.startsWith("gmail:")) return "gmail";
  if (id.startsWith("wa:")) return "whatsapp";
  return null;
}

function score(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export const TODOS: TabSpec<TodoColumn, Todo> = {
  name: TODOS_TAB,
  header: TODO_HEADER,
  preserved: TODO_PRESERVED_ON_UPSERT,
  toCells: (row) => cellsOf(TODO_HEADER, row),
  fromCells(cells) {
    const id = cells.id.trim();
    const source = sourceOf(cells.source, id);
    if (!id || !source) return null;
    return {
      ...cells,
      id,
      source,
      status: pick<TodoStatus>(TODO_STATUSES, cells.status, "open"),
      extraction_status: pick<ExtractionStatus>(
        EXTRACTION_STATUSES,
        cells.extraction_status,
        "done",
      ),
      jev_action: score(cells.jev_action) ?? 0,
    };
  },
};

export const QUARANTINE: TabSpec<QuarantineColumn, QuarantineItem> = {
  name: QUARANTINE_TAB,
  header: QUARANTINE_HEADER,
  preserved: QUARANTINE_PRESERVED_ON_UPSERT,
  toCells: (row) => cellsOf(QUARANTINE_HEADER, row),
  fromCells(cells) {
    const id = cells.id.trim();
    const source = sourceOf(cells.source, id);
    if (!id || !source) return null;
    return {
      ...cells,
      id,
      source,
      jev_phishing: score(cells.jev_phishing),
      jev_malicious: score(cells.jev_malicious),
      jev_spam: score(cells.jev_spam),
    };
  },
};

// ---------------------------------------------------------------------------------------------
// A1 helpers + pure upsert planning.

export function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function quoteTab(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

/** Widest range read: the pinned headers are 12-13 columns; extra cells beyond are a mismatch. */
const READ_LAST_COLUMN = "Z";

function headerRange(tab: TabShape): string {
  return `${quoteTab(tab.name)}!A1:${READ_LAST_COLUMN}1`;
}

function tableRange(tab: TabShape): string {
  return `${quoteTab(tab.name)}!A:${READ_LAST_COLUMN}`;
}

function rowRange(tab: TabShape, rowNumber: number): string {
  const last = columnLetter(tab.header.length - 1);
  return `${quoteTab(tab.name)}!A${rowNumber}:${last}${rowNumber}`;
}

export function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function asCellValue(v: unknown): CellValue {
  return typeof v === "number" && Number.isFinite(v) ? v : cellText(v);
}

/** Trailing empty cells are omitted by the Sheets API; compare the trimmed rows. */
function trimTrailing(row: readonly unknown[]): string[] {
  const out = row.map(cellText);
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

export type SheetsErrorKind = "not_configured" | "header_mismatch" | "upstream";

/** Every failure the store surfaces. Messages never contain values read from private/. */
export class SheetsError extends Error {
  constructor(
    readonly kind: SheetsErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SheetsError";
  }
}

function assertHeader(tab: TabShape, firstRow: readonly unknown[] | undefined): void {
  const found = trimTrailing(firstRow ?? []);
  const expected = [...tab.header];
  if (found.length === expected.length && found.every((c, i) => c === expected[i])) return;
  throw new SheetsError(
    "header_mismatch",
    `tab "${tab.name}" header does not match the pinned header: expected [${expected.join(", ")}], found [${found.join(", ")}]`,
  );
}

/** addSheet rejected because the tab is already there (HTTP 400 "... already exists ..."). */
function isAlreadyExists(err: unknown): boolean {
  const cause = err instanceof SheetsError ? err.cause : err;
  return (
    httpStatusOf(cause) === 400 && cause instanceof Error && /already exists/i.test(cause.message)
  );
}

function isBlankRow(row: readonly unknown[] | undefined): boolean {
  return trimTrailing(row ?? []).length === 0;
}

/** Maps every non-empty id to its 1-based sheet row number (first occurrence wins). */
export function indexIds(table: readonly (readonly unknown[])[]): Map<string, number> {
  const ids = new Map<string, number>();
  for (let i = 1; i < table.length; i++) {
    const id = cellText(table[i]?.[0]).trim();
    if (id && !ids.has(id)) ids.set(id, i + 1);
  }
  return ids;
}

export interface UpsertPlan {
  /** values.batchUpdate data: one full-row range per changed existing row. */
  updates: Array<{ range: string; values: CellValue[][] }>;
  /** values.append rows for ids not yet in the tab. */
  appends: CellValue[][];
  /** Existing rows whose merged cells equal what is already there (no write). */
  unchanged: number;
}

/**
 * Pure planner: `table` is the tab as read (row 0 = header). Incoming rows are deduped by id (last
 * wins). Existing ids are merged under the column-ownership rule (preserved columns keep a
 * non-empty existing value); new ids are appended in input order.
 */
export function planUpsert<C extends string, R extends { id: string }>(
  spec: TabSpec<C, R>,
  table: readonly (readonly unknown[])[],
  rows: readonly R[],
): UpsertPlan {
  const ids = indexIds(table);
  const incoming = new Map<string, Record<C, CellValue>>();
  for (const row of rows) {
    const cells = spec.toCells(row);
    const id = cellText(cells[spec.header[0] as C]).trim();
    if (!id) throw new Error(`upsertRows(${spec.name}): a row has an empty id`);
    incoming.delete(id); // last wins, keeps the latest position
    incoming.set(id, cells);
  }
  const plan: UpsertPlan = { updates: [], appends: [], unchanged: 0 };
  for (const [id, cells] of incoming) {
    const rowNumber = ids.get(id);
    if (rowNumber === undefined) {
      plan.appends.push(spec.header.map((c) => cells[c]));
      continue;
    }
    const existing = table[rowNumber - 1] ?? [];
    const merged = spec.header.map((c, i): CellValue => {
      const old = existing[i];
      if (spec.preserved.includes(c) && cellText(old) !== "") return asCellValue(old);
      return cells[c];
    });
    const same = spec.header.every((_c, i) => cellText(merged[i]) === cellText(existing[i]));
    if (same) plan.unchanged++;
    else plan.updates.push({ range: rowRange(spec, rowNumber), values: [merged] });
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------
// The store.

export interface SheetsTarget {
  api: SheetsApi;
  spreadsheetId: string;
}

export interface UpsertResult {
  updated: number;
  appended: number;
  unchanged: number;
}

export interface SheetsStore {
  /** Creates the tab and/or its header row when missing; throws on a header mismatch. */
  ensureTab(tab: TabShape): Promise<void>;
  readRows<C extends string, R extends { id: string }>(spec: TabSpec<C, R>): Promise<R[]>;
  /** One values.batchUpdate (existing ids, merged) + one values.append (new ids). */
  upsertRows<C extends string, R extends { id: string }>(
    spec: TabSpec<C, R>,
    rows: readonly R[],
  ): Promise<UpsertResult>;
  /**
   * Update-only: writes just the patched cells of the row with `id`. Returns null (and writes
   * nothing) when the id is not in the tab.
   */
  updateRow<C extends string, R extends { id: string }>(
    spec: TabSpec<C, R>,
    id: string,
    patch: Partial<Record<C, CellValue>>,
  ): Promise<R | null>;
}

export interface SheetsStoreOptions {
  /** A fixed target, or a resolver called per operation (real mode re-reads settings.sheetId). */
  target: SheetsTarget | (() => Promise<SheetsTarget>);
  timeoutMs?: number;
  retry?: RetryOptions;
}

export function createSheetsStore(opts: SheetsStoreOptions): SheetsStore {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const resolveTarget =
    typeof opts.target === "function"
      ? opts.target
      : () => Promise.resolve(opts.target as SheetsTarget);
  /**
   * One ensure promise per (spreadsheet, tab): concurrent first calls share the in-flight promise
   * (single-flight, so only one addSheet is issued), a settled promise is the cache, and a failed
   * ensure is dropped so the next call retries.
   */
  const ensured = new Map<string, Promise<void>>();
  let writes: Promise<unknown> = Promise.resolve();

  /** Serializes read-modify-write cycles so two upserts never append the same new id twice. */
  function serialized<T>(run: () => Promise<T>): Promise<T> {
    const result = writes.then(run, run);
    writes = result.catch(() => undefined);
    return result;
  }

  async function call<T>(what: string, fn: (o: CallOpts) => Promise<T>): Promise<T> {
    try {
      return await callWithRetry((signal) => fn({ timeoutMs, signal }), {
        ...opts.retry,
        timeoutMs,
      });
    } catch (err) {
      if (err instanceof SheetsError) throw err;
      if (err instanceof TimeoutError) {
        throw new SheetsError("upstream", `Sheets ${what} timed out after ${timeoutMs} ms`, {
          cause: err,
        });
      }
      const status = httpStatusOf(err);
      throw new SheetsError(
        "upstream",
        `Sheets ${what} failed${status === undefined ? "" : ` (HTTP ${status})`}`,
        { cause: err },
      );
    }
  }

  function ensureKey(t: SheetsTarget, tab: TabShape): string {
    return `${t.spreadsheetId}\u0000${tab.name}`;
  }

  function ensureOn(t: SheetsTarget, tab: TabShape): Promise<void> {
    const key = ensureKey(t, tab);
    const existing = ensured.get(key);
    if (existing) return existing;
    const pending = runEnsure(t, tab);
    ensured.set(key, pending);
    pending.catch(() => {
      if (ensured.get(key) === pending) ensured.delete(key);
    });
    return pending;
  }

  async function runEnsure(t: SheetsTarget, tab: TabShape): Promise<void> {
    const meta = await call("get spreadsheet", (o) =>
      t.api.spreadsheets.get({ spreadsheetId: t.spreadsheetId }, o),
    );
    const titles = (meta.data.sheets ?? []).map((s) => s.properties?.title ?? "");
    if (titles.includes(tab.name)) return verifyHeader(t, tab);
    try {
      await call("add tab", (o) =>
        t.api.spreadsheets.batchUpdate(
          {
            spreadsheetId: t.spreadsheetId,
            requestBody: { requests: [{ addSheet: { properties: { title: tab.name } } }] },
          },
          o,
        ),
      );
    } catch (err) {
      // Another writer (another process, or the operator) created it between get and addSheet:
      // that is success, but its header is unknown, so verify it like any existing tab.
      if (isAlreadyExists(err)) return verifyHeader(t, tab);
      throw err;
    }
    await writeHeader(t, tab);
  }

  /** An existing tab: write the header into an empty first row, else require the pinned header. */
  async function verifyHeader(t: SheetsTarget, tab: TabShape): Promise<void> {
    const res = await call("read header", (o) =>
      t.api.spreadsheets.values.get(
        {
          spreadsheetId: t.spreadsheetId,
          range: headerRange(tab),
          valueRenderOption: "UNFORMATTED_VALUE",
        },
        o,
      ),
    );
    const first = res.data.values?.[0];
    if (isBlankRow(first)) await writeHeader(t, tab);
    else assertHeader(tab, first);
  }

  async function writeHeader(t: SheetsTarget, tab: TabShape): Promise<void> {
    await call("write header", (o) =>
      t.api.spreadsheets.values.update(
        {
          spreadsheetId: t.spreadsheetId,
          range: `${quoteTab(tab.name)}!A1:${columnLetter(tab.header.length - 1)}1`,
          valueInputOption: "RAW",
          requestBody: { values: [[...tab.header]] },
        },
        o,
      ),
    );
  }

  /**
   * Reads the whole tab and verifies its header (operator edits are caught on every read). A 400
   * on the read means the cached-ensured tab is gone (deleted or renamed mid-session): forget it
   * and ensure + read once more, which re-creates it.
   */
  async function readTable(t: SheetsTarget, tab: TabShape, again = false): Promise<unknown[][]> {
    await ensureOn(t, tab);
    let res: { data: { values?: unknown[][] | null } };
    try {
      res = await call("read rows", (o) =>
        t.api.spreadsheets.values.get(
          {
            spreadsheetId: t.spreadsheetId,
            range: tableRange(tab),
            valueRenderOption: "UNFORMATTED_VALUE",
          },
          o,
        ),
      );
    } catch (err) {
      if (again || !(err instanceof SheetsError) || httpStatusOf(err.cause) !== 400) throw err;
      ensured.delete(ensureKey(t, tab));
      return readTable(t, tab, true);
    }
    const table = res.data.values ?? [];
    assertHeader(tab, table[0]);
    return table;
  }

  function parseRow<C extends string, R extends { id: string }>(
    spec: TabSpec<C, R>,
    row: readonly unknown[],
  ): R | null {
    const cells = {} as Record<C, string>;
    spec.header.forEach((c, i) => {
      cells[c] = cellText(row[i]);
    });
    return spec.fromCells(cells);
  }

  return {
    async ensureTab(tab) {
      await ensureOn(await resolveTarget(), tab);
    },

    async readRows(spec) {
      const table = await readTable(await resolveTarget(), spec);
      const seen = new Set<string>();
      const out = [];
      for (const row of table.slice(1)) {
        const parsed = parseRow(spec, row);
        if (!parsed || seen.has(parsed.id)) continue;
        seen.add(parsed.id);
        out.push(parsed);
      }
      return out;
    },

    upsertRows(spec, rows) {
      return serialized(async () => {
        const t = await resolveTarget();
        const table = await readTable(t, spec);
        const plan = planUpsert(spec, table, rows);
        if (plan.updates.length > 0) {
          await call("batchUpdate", (o) =>
            t.api.spreadsheets.values.batchUpdate(
              {
                spreadsheetId: t.spreadsheetId,
                requestBody: { valueInputOption: "RAW", data: plan.updates },
              },
              o,
            ),
          );
        }
        if (plan.appends.length > 0) {
          await call("append", (o) =>
            t.api.spreadsheets.values.append(
              {
                spreadsheetId: t.spreadsheetId,
                range: `${quoteTab(spec.name)}!A1`,
                valueInputOption: "RAW",
                insertDataOption: "INSERT_ROWS",
                requestBody: { values: plan.appends },
              },
              o,
            ),
          );
        }
        return {
          updated: plan.updates.length,
          appended: plan.appends.length,
          unchanged: plan.unchanged,
        };
      });
    },

    updateRow(spec, id, patch) {
      return serialized(async () => {
        const t = await resolveTarget();
        const table = await readTable(t, spec);
        const rowNumber = indexIds(table).get(id);
        if (rowNumber === undefined) return null;
        const row = [...(table[rowNumber - 1] ?? [])];
        // A row readRows cannot represent (skipped there) is not patchable either: no write.
        if (parseRow(spec, row) === null) return null;
        const data: Array<{ range: string; values: CellValue[][] }> = [];
        spec.header.forEach((c, i) => {
          const v = patch[c];
          if (v === undefined) return;
          row[i] = v;
          data.push({
            range: `${quoteTab(spec.name)}!${columnLetter(i)}${rowNumber}`,
            values: [[v]],
          });
        });
        if (data.length > 0) {
          await call("batchUpdate", (o) =>
            t.api.spreadsheets.values.batchUpdate(
              { spreadsheetId: t.spreadsheetId, requestBody: { valueInputOption: "RAW", data } },
              o,
            ),
          );
        }
        return parseRow(spec, row);
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Real client: service account (D6) from <privateDir>/service-account.json, spreadsheet id from
// settings.sheetId. googleapis is imported lazily so fake mode and tests never load it.

export async function createGoogleSheetsApi(keyFile: string): Promise<SheetsApi> {
  const { google } = await import("googleapis");
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: [...SHEETS_SCOPES] });
  const sheets: sheets_v4.Sheets = google.sheets({ version: "v4", auth });
  // retry:false: util/retry.ts owns retries (no double backoff); timeout + signal per call.
  const o = (opts: CallOpts) => ({ timeout: opts.timeoutMs, signal: opts.signal, retry: false });
  return {
    spreadsheets: {
      get: async (p, opts) => {
        const r = await sheets.spreadsheets.get(
          { spreadsheetId: p.spreadsheetId, fields: "sheets.properties.title" },
          o(opts),
        );
        return { data: r.data };
      },
      batchUpdate: (p, opts) => sheets.spreadsheets.batchUpdate(p, o(opts)),
      values: {
        get: async (p, opts) => {
          const r = await sheets.spreadsheets.values.get(p, o(opts));
          return { data: { values: r.data.values as unknown[][] | null | undefined } };
        },
        update: (p, opts) => sheets.spreadsheets.values.update(p, o(opts)),
        batchUpdate: (p, opts) => sheets.spreadsheets.values.batchUpdate(p, o(opts)),
        append: (p, opts) => sheets.spreadsheets.values.append(p, o(opts)),
      },
    },
  };
}

/**
 * Resolves the real target per operation: re-reads settings.sheetId (so an operator edit needs no
 * restart) and requires private/service-account.json. Missing either -> SheetsError not_configured.
 */
export function googleSheetsTarget(
  paths: Paths,
  makeApi: (keyFile: string) => Promise<SheetsApi> = createGoogleSheetsApi,
): () => Promise<SheetsTarget> {
  let api: Promise<SheetsApi> | undefined;
  return async () => {
    const settings = await loadSettings(paths);
    if (!isSheetIdConfigured(settings.sheetId)) {
      throw new SheetsError(
        "not_configured",
        "Google Sheet not configured: set sheetId in settings",
      );
    }
    if (!existsSync(paths.serviceAccountFile)) {
      throw new SheetsError(
        "not_configured",
        "Google Sheet not configured: service-account.json is missing from the private folder",
      );
    }
    api ??= makeApi(paths.serviceAccountFile).catch((err: unknown) => {
      api = undefined;
      throw err;
    });
    return { api: await api, spreadsheetId: settings.sheetId };
  };
}

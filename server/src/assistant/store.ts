// Assistant store (plan Phase 2 / S1, S1.5 "Storage", D43): Node's built-in `node:sqlite` at
// `<privateDir>/assistant.sqlite` (its journal sidecar sits beside it). SQLite owns ONLY new
// assistant state (runs, briefing snapshots and preparation packets); the Google Sheet
// stays authoritative for Todos. No native npm package, no external database.
//
//   - Initializer: a fresh/empty file is created at schema `PRAGMA user_version = 1` inside ONE
//     transaction; foreign keys on; a bounded 250 ms busy timeout, after which a contended
//     statement surfaces as the retryable AssistantBusyError (HTTP 409 assistant_busy).
//   - Fail closed: a corrupt file, a newer `user_version`, a version-0 file that already holds
//     tables, or a v1 file missing its tables throws AssistantUnavailableError (HTTP 503
//     assistant_unavailable). The files are left exactly as found: never repaired, migrated,
//     deleted or silently recreated. The rest of the app (Todos) keeps working.
//   - Transactions are short and synchronous: no network or model work ever runs inside one.
//
// Backup/restore: stop the server, then copy `assistant.sqlite` (and any `assistant.sqlite-journal`
// sidecar) together; restore by copying them back while the server is stopped.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ASSISTANT_SCHEMA_VERSION,
  type AssistantRun,
  type Briefing,
  type PacketEdit,
  type PacketState,
  type PacketSummary,
  type PreparationPacket,
  type RunErrorCode,
  type RunKind,
  type RunState,
} from "@yarvis/shared";
import type { Paths } from "../config/paths.js";

export const ASSISTANT_DB_FILE = "assistant.sqlite";
export const ASSISTANT_LOCK_FILE = "assistant.lock";
export const BUSY_TIMEOUT_MS = 250;

/**
 * Bounded retention (fewer message excerpts at rest): each successful briefing keeps only the
 * newest BRIEFING_RETENTION snapshots; on every run insert/commit, finished runs (briefing or
 * prepare) beyond the newest RUN_RETENTION rows that no kept snapshot or packet references are
 * dropped. Running rows and packets are never pruned.
 */
export const BRIEFING_RETENTION = 50;
export const RUN_RETENTION = 200;

export function assistantDbFile(paths: Pick<Paths, "privateDir">): string {
  return path.join(paths.privateDir, ASSISTANT_DB_FILE);
}

export function assistantLockFile(paths: Pick<Paths, "privateDir">): string {
  return path.join(paths.privateDir, ASSISTANT_LOCK_FILE);
}

/** The store cannot be used (corrupt, newer schema, unopenable, closed). Message is content-free. */
export class AssistantUnavailableError extends Error {
  constructor(
    readonly reason: "corrupt" | "newer_schema" | "unknown_schema" | "open_failed" | "closed",
  ) {
    super(`assistant store unavailable (${reason})`);
    this.name = "AssistantUnavailableError";
  }
}

/** The database (or the one-run assistant lock) is held by someone else; retry later. */
export class AssistantBusyError extends Error {
  constructor() {
    super("another assistant run is in progress");
    this.name = "AssistantBusyError";
  }
}

/** A request id was reused with different input. */
export class RequestConflictError extends Error {
  constructor() {
    super("request id already used with different input");
    this.name = "RequestConflictError";
  }
}

/** A save based on a stale revision (HTTP 409 revision_conflict with the current packet). */
export class PacketRevisionConflictError extends Error {
  constructor(readonly currentPacket: PreparationPacket) {
    super("the preparation was saved elsewhere since this edit began");
    this.name = "PacketRevisionConflictError";
  }
}

/** An edit whose checklist item ids do not match the saved packet (HTTP 400 bad_request). */
export class PacketEditInvalidError extends Error {
  constructor() {
    super("checklist item ids must match the saved preparation");
    this.name = "PacketEditInvalidError";
  }
}

const TABLES = ["runs", "briefings", "packets"] as const;

// Version 1 schema. `runs.target_id` points at a briefing or a packet, so it carries no FK.
const SCHEMA_V1 = `
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('briefing', 'prepare')),
  state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'interrupted')),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  target_id TEXT,
  source_todo_id TEXT,
  error_code TEXT,
  model TEXT,
  prompt_version TEXT
);
CREATE INDEX runs_state ON runs (state);
CREATE TABLE briefings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs (id),
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  snapshot TEXT NOT NULL
);
CREATE TABLE packets (
  id TEXT PRIMARY KEY,
  todo_id TEXT NOT NULL UNIQUE,
  run_id TEXT REFERENCES runs (id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('open', 'handled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  body TEXT NOT NULL
);
`;

/** SHA-256 (hex) of the UTF-8 bytes of the normalized request: a fixed ordered JSON array. */
export function requestHash(normalized: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex");
}

interface RunRow {
  id: string;
  request_id: string;
  request_hash: string;
  kind: RunKind;
  state: RunState;
  created_at: string;
  finished_at: string | null;
  target_id: string | null;
  source_todo_id: string | null;
  error_code: RunErrorCode | null;
  model: string | null;
  prompt_version: string | null;
}

function toRun(row: RunRow): AssistantRun {
  return {
    id: row.id,
    requestId: row.request_id,
    kind: row.kind,
    state: row.state,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    targetId: row.target_id,
    sourceTodoId: row.source_todo_id,
    errorCode: row.error_code,
    model: row.model,
    promptVersion: row.prompt_version,
  };
}

/** SQLITE_BUSY (5) / SQLITE_LOCKED (6), including their extended codes. */
function isBusy(err: unknown): boolean {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && ((code & 0xff) === 5 || (code & 0xff) === 6);
}

/** SQLITE_CORRUPT (11) / SQLITE_NOTADB (26). */
function isCorrupt(err: unknown): boolean {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && ((code & 0xff) === 11 || (code & 0xff) === 26);
}

/** SQLITE_CONSTRAINT (19), including its extended codes (e.g. a UNIQUE request_id race). */
export function isConstraint(err: unknown): boolean {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && (code & 0xff) === 19;
}

interface PacketRow {
  id: string;
  todo_id: string;
  revision: number;
  state: PacketState;
  created_at: string;
  updated_at: string;
  body: string;
}

/** The stored body is the validated packet JSON; the columns own revision/state/timestamps. */
function toPacket(row: PacketRow): PreparationPacket {
  let body: PreparationPacket;
  try {
    body = JSON.parse(row.body) as PreparationPacket;
  } catch {
    throw new AssistantUnavailableError("corrupt");
  }
  return {
    ...body,
    id: row.id,
    todoId: row.todo_id,
    revision: Number(row.revision),
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Model/prompt provenance recorded on a prepare run. */
export interface RunMeta {
  model: string | null;
  promptVersion: string | null;
}

export interface NewRun {
  id: string;
  requestId: string;
  requestHash: string;
  kind: RunKind;
  createdAt: string;
  sourceTodoId?: string | null;
}

export class AssistantStore {
  private constructor(private db: DatabaseSync | null) {}

  /**
   * Opens (creating when absent) the store at `<privateDir>/assistant.sqlite`. Throws
   * AssistantUnavailableError when the file is corrupt or not a v1 assistant store, and
   * AssistantBusyError when the initializer could not get the database within the busy timeout.
   */
  static open(paths: Pick<Paths, "privateDir">): AssistantStore {
    const file = assistantDbFile(paths);
    mkdirSync(path.dirname(file), { recursive: true });
    const existed = existsSync(file);
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS, enableForeignKeyConstraints: true });
    } catch (err) {
      throw isCorrupt(err)
        ? new AssistantUnavailableError("corrupt")
        : new AssistantUnavailableError("open_failed");
    }
    try {
      initialize(db, existed);
    } catch (err) {
      db.close();
      if (err instanceof AssistantUnavailableError) throw err;
      if (isBusy(err)) throw new AssistantBusyError();
      if (isCorrupt(err)) throw new AssistantUnavailableError("corrupt");
      throw new AssistantUnavailableError("open_failed");
    }
    return new AssistantStore(db);
  }

  get isOpen(): boolean {
    return this.db !== null;
  }

  close(): void {
    const db = this.db;
    this.db = null;
    db?.close();
  }

  private conn(): DatabaseSync {
    if (!this.db) throw new AssistantUnavailableError("closed");
    return this.db;
  }

  /** Runs `fn` against the open connection, mapping SQLite contention/corruption to typed errors. */
  private use<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.conn();
    try {
      return fn(db);
    } catch (err) {
      if (isBusy(err)) throw new AssistantBusyError();
      if (isCorrupt(err)) throw new AssistantUnavailableError("corrupt");
      throw err;
    }
  }

  /** BEGIN IMMEDIATE .. COMMIT, rolled back on any throw. Never put network/model work in `fn`. */
  private tx<T>(fn: (db: DatabaseSync) => T): T {
    return this.use((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = fn(db);
        db.exec("COMMIT");
        return out;
      } catch (err) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  findRunByRequestId(requestId: string): { run: AssistantRun; requestHash: string } | null {
    return this.use((db) => {
      const row = db.prepare("SELECT * FROM runs WHERE request_id = ?").get(requestId) as
        RunRow | undefined;
      return row ? { run: toRun(row), requestHash: row.request_hash } : null;
    });
  }

  getRun(id: string): AssistantRun | null {
    return this.use((db) => {
      const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
      return row ? toRun(row) : null;
    });
  }

  /** The most recently created run (insertion order). */
  latestRun(): AssistantRun | null {
    return this.use((db) => {
      const row = db.prepare("SELECT * FROM runs ORDER BY rowid DESC LIMIT 1").get() as
        RunRow | undefined;
      return row ? toRun(row) : null;
    });
  }

  /** Inserts a `running` run. Throws RequestConflictError-free UNIQUE errors only on a race. */
  insertRun(run: NewRun): AssistantRun {
    return this.tx((db) => {
      db.prepare(
        `INSERT INTO runs (id, request_id, request_hash, kind, state, created_at, source_todo_id)
         VALUES (?, ?, ?, ?, 'running', ?, ?)`,
      ).run(
        run.id,
        run.requestId,
        run.requestHash,
        run.kind,
        run.createdAt,
        run.sourceTodoId ?? null,
      );
      pruneRuns(db);
      return toRun(db.prepare("SELECT * FROM runs WHERE id = ?").get(run.id) as unknown as RunRow);
    });
  }

  /**
   * Ends a run that is STILL running (guarded): returns false and changes nothing when the run
   * already reached a terminal state, so a late outcome never overwrites an earlier one.
   */
  finishRun(
    id: string,
    state: Exclude<RunState, "running" | "succeeded">,
    errorCode: RunErrorCode,
    finishedAt: string,
    meta?: RunMeta,
  ): boolean {
    return this.tx((db) => {
      const res = meta
        ? db
            .prepare(
              `UPDATE runs SET state = ?, error_code = ?, finished_at = ?, model = ?, prompt_version = ?
               WHERE id = ? AND state = 'running'`,
            )
            .run(state, errorCode, finishedAt, meta.model, meta.promptVersion, id)
        : db
            .prepare(
              `UPDATE runs SET state = ?, error_code = ?, finished_at = ? WHERE id = ? AND state = 'running'`,
            )
            .run(state, errorCode, finishedAt, id);
      return Number(res.changes) === 1;
    });
  }

  /** Every `running` row becomes interrupted/abandoned. Call ONLY while holding the assistant lock. */
  interruptRunning(finishedAt: string): number {
    return this.tx((db) => {
      const res = db
        .prepare(
          `UPDATE runs SET state = 'interrupted', error_code = 'abandoned', finished_at = ?
           WHERE state = 'running'`,
        )
        .run(finishedAt);
      return Number(res.changes);
    });
  }

  latestBriefing(): Briefing | null {
    return this.use((db) => latestBriefingIn(db));
  }

  /**
   * Atomically publishes a briefing for a run that is STILL running: `build` receives the
   * immediately preceding successful snapshot (read inside the same transaction) and returns the new
   * one. Returns null (writing nothing) when the run already ended, e.g. past its deadline.
   */
  commitBriefing(
    runId: string,
    finishedAt: string,
    build: (previous: Briefing | null) => Briefing,
  ): Briefing | null {
    return this.tx((db) => {
      const row = db.prepare("SELECT state FROM runs WHERE id = ?").get(runId) as
        { state: RunState } | undefined;
      if (row?.state !== "running") return null;
      const briefing = build(latestBriefingIn(db));
      db.prepare(
        `INSERT INTO briefings (id, run_id, schema_version, created_at, snapshot) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        briefing.id,
        runId,
        ASSISTANT_SCHEMA_VERSION,
        briefing.createdAt,
        JSON.stringify(briefing),
      );
      db.prepare(
        `UPDATE runs SET state = 'succeeded', target_id = ?, finished_at = ?, error_code = NULL
         WHERE id = ? AND state = 'running'`,
      ).run(briefing.id, finishedAt, runId);
      db.prepare(
        `DELETE FROM briefings WHERE rowid NOT IN
           (SELECT rowid FROM briefings ORDER BY rowid DESC LIMIT ?)`,
      ).run(BRIEFING_RETENTION);
      pruneRuns(db);
      return briefing;
    });
  }

  /** A stored briefing snapshot by id (null: unknown or pruned). */
  getBriefing(id: string): Briefing | null {
    return this.use((db) => {
      const row = db
        .prepare("SELECT snapshot, schema_version FROM briefings WHERE id = ?")
        .get(id) as { snapshot: string; schema_version: number } | undefined;
      return row ? parseSnapshot(row) : null;
    });
  }

  getPacket(id: string): PreparationPacket | null {
    return this.use((db) => {
      const row = db.prepare("SELECT * FROM packets WHERE id = ?").get(id) as PacketRow | undefined;
      return row ? toPacket(row) : null;
    });
  }

  packetForTodo(todoId: string): PreparationPacket | null {
    return this.use((db) => {
      const row = db.prepare("SELECT * FROM packets WHERE todo_id = ?").get(todoId) as
        PacketRow | undefined;
      return row ? toPacket(row) : null;
    });
  }

  /**
   * Existing-packet fast path (S1.5): when `todoId` already has a packet, atomically records a
   * SUCCEEDED prepare run (unique request id + normalized-request hash, target = that packet) and
   * returns the packet; no model work. Returns null (writing nothing) when there is no packet.
   * A concurrent insert of the same request id surfaces as a constraint error to the caller.
   */
  recordExistingPacketRun(run: NewRun, todoId: string): PreparationPacket | null {
    return this.tx((db) => {
      const row = db.prepare("SELECT * FROM packets WHERE todo_id = ?").get(todoId) as
        PacketRow | undefined;
      if (!row) return null;
      db.prepare(
        `INSERT INTO runs (id, request_id, request_hash, kind, state, created_at, finished_at,
                           target_id, source_todo_id)
         VALUES (?, ?, ?, ?, 'succeeded', ?, ?, ?, ?)`,
      ).run(
        run.id,
        run.requestId,
        run.requestHash,
        run.kind,
        run.createdAt,
        run.createdAt,
        row.id,
        todoId,
      );
      pruneRuns(db);
      return toPacket(row);
    });
  }

  /**
   * Atomically stores a validated packet for a run that is STILL running and marks the run
   * succeeded (target = the packet, with model/prompt provenance). Returns null (writing nothing)
   * when the run already ended, so a late result after a deadline or shutdown is discarded.
   */
  commitPacket(runId: string, packet: PreparationPacket): PreparationPacket | null {
    return this.tx((db) => {
      const row = db.prepare("SELECT state FROM runs WHERE id = ?").get(runId) as
        { state: RunState } | undefined;
      if (row?.state !== "running") return null;
      db.prepare(
        `INSERT INTO packets (id, todo_id, run_id, revision, state, created_at, updated_at, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        packet.id,
        packet.todoId,
        runId,
        packet.revision,
        packet.state,
        packet.createdAt,
        packet.updatedAt,
        JSON.stringify(packet),
      );
      db.prepare(
        `UPDATE runs SET state = 'succeeded', target_id = ?, finished_at = ?, error_code = NULL,
                         model = ?, prompt_version = ?
         WHERE id = ? AND state = 'running'`,
      ).run(packet.id, packet.createdAt, packet.model, packet.promptVersion, runId);
      pruneRuns(db);
      return packet;
    });
  }

  /**
   * The saved-preparations list: at most `limit` summaries, most recently updated first (ties by
   * newest insertion), plus the total count so the caller can report what was omitted.
   */
  listPackets(limit: number): { packets: PacketSummary[]; total: number } {
    return this.use((db) => {
      const rows = db
        .prepare(
          `SELECT id, todo_id, state, updated_at, revision,
                  json_extract(body, '$.sourceRef.context') AS context
           FROM packets ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
        )
        .all(limit) as Array<{
        id: string;
        todo_id: string;
        state: PacketState;
        updated_at: string;
        revision: number;
        context: unknown;
      }>;
      const total = Number(
        (db.prepare("SELECT COUNT(*) AS n FROM packets").get() as { n: number }).n,
      );
      return {
        total,
        packets: rows.map((r) => ({
          id: r.id,
          todoId: r.todo_id,
          context: typeof r.context === "string" ? r.context : "",
          state: r.state,
          updatedAt: r.updated_at,
          revision: Number(r.revision),
        })),
      };
    });
  }

  /**
   * Compare-and-swap save of an operator edit (S1.5 "Editing"), in ONE short transaction: the
   * packet's revision must equal `edit.expectedRevision`, else PacketRevisionConflictError carries
   * the current packet and nothing changes. The checklist ids must be exactly the saved ids in order
   * (else PacketEditInvalidError). On success revision increments, updatedAt = `updatedAt`, and the
   * edited draft/checklist/questions/state replace the stored ones. Returns null for an unknown id.
   */
  savePacket(id: string, edit: PacketEdit, updatedAt: string): PreparationPacket | null {
    return this.tx((db) => {
      const row = db.prepare("SELECT * FROM packets WHERE id = ?").get(id) as PacketRow | undefined;
      if (!row) return null;
      const current = toPacket(row);
      if (current.revision !== edit.expectedRevision) {
        throw new PacketRevisionConflictError(current);
      }
      const savedIds = current.checklist.map((c) => c.id);
      const editIds = edit.checklist.map((c) => c.id);
      if (savedIds.length !== editIds.length || savedIds.some((v, i) => v !== editIds[i])) {
        throw new PacketEditInvalidError();
      }
      const next: PreparationPacket = {
        ...current,
        revision: current.revision + 1,
        updatedAt,
        state: edit.state,
        draft: edit.draft,
        checklist: edit.checklist.map((c) => ({ id: c.id, text: c.text, done: c.done })),
        questions: [...edit.questions],
      };
      const res = db
        .prepare(
          `UPDATE packets SET revision = ?, state = ?, updated_at = ?, body = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(next.revision, next.state, updatedAt, JSON.stringify(next), id, current.revision);
      // Unreachable under BEGIN IMMEDIATE (the row was read in this transaction); kept as a guard.
      if (Number(res.changes) !== 1) throw new PacketRevisionConflictError(current);
      return next;
    });
  }

  /** Test/diagnostic helper: row counts per table. */
  counts(): Record<(typeof TABLES)[number], number> {
    return this.use((db) => {
      const out = {} as Record<(typeof TABLES)[number], number>;
      for (const t of TABLES) {
        out[t] = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
      }
      return out;
    });
  }
}

/**
 * Drops finished runs beyond the newest RUN_RETENTION rows unless a kept snapshot or packet points
 * at them (packets.run_id is a foreign key). Call inside a write transaction.
 */
function pruneRuns(db: DatabaseSync): void {
  db.prepare(
    `DELETE FROM runs WHERE state != 'running'
       AND id NOT IN (SELECT run_id FROM briefings)
       AND id NOT IN (SELECT run_id FROM packets WHERE run_id IS NOT NULL)
       AND rowid NOT IN (SELECT rowid FROM runs ORDER BY rowid DESC LIMIT ?)`,
  ).run(RUN_RETENTION);
}

function latestBriefingIn(db: DatabaseSync): Briefing | null {
  const row = db
    .prepare("SELECT snapshot, schema_version FROM briefings ORDER BY rowid DESC LIMIT 1")
    .get() as { snapshot: string; schema_version: number } | undefined;
  return row ? parseSnapshot(row) : null;
}

function parseSnapshot(row: { snapshot: string; schema_version: number }): Briefing {
  if (row.schema_version !== ASSISTANT_SCHEMA_VERSION) {
    throw new AssistantUnavailableError("unknown_schema");
  }
  try {
    return JSON.parse(row.snapshot) as Briefing;
  } catch {
    throw new AssistantUnavailableError("corrupt");
  }
}

function userVersion(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

function tableNames(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/** Validates an existing store, or creates schema v1 in one transaction on an empty one. */
function initialize(db: DatabaseSync, existed: boolean): void {
  const quick = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
  if (quick.length !== 1 || Object.values(quick[0] ?? {})[0] !== "ok") {
    throw new AssistantUnavailableError("corrupt");
  }
  const version = userVersion(db);
  if (version > ASSISTANT_SCHEMA_VERSION) throw new AssistantUnavailableError("newer_schema");
  if (version === ASSISTANT_SCHEMA_VERSION) {
    const names = tableNames(db);
    if (!TABLES.every((t) => names.has(t))) throw new AssistantUnavailableError("unknown_schema");
    return;
  }
  if (version !== 0) throw new AssistantUnavailableError("unknown_schema");
  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-checked under the write lock: another process may have initialized it meanwhile.
    const now = userVersion(db);
    if (now === ASSISTANT_SCHEMA_VERSION) {
      db.exec("COMMIT");
      return;
    }
    if (now !== 0 || tableNames(db).size > 0) {
      // A version-0 file with tables is not ours (or a half-initialized one): never touch it.
      throw new AssistantUnavailableError(existed ? "unknown_schema" : "open_failed");
    }
    db.exec(SCHEMA_V1);
    db.exec(`PRAGMA user_version = ${ASSISTANT_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

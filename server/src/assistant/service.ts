// Assistant service (plan Phase 2 / S1, S1.5 "Briefing behavior" + "Work and recovery", D44).
//
// Runs:
//   - At most ONE active assistant run per private dir, serialized by the existing cross-process
//     `acquireLock` at `<privateDir>/assistant.lock` (separate from refresh.lock; the lock module's
//     stale-age policy is reused unchanged). Another request gets AssistantBusyError (409) at once;
//     nothing is queued.
//   - Request-id idempotency is checked BEFORE busy admission, and again after the lock is taken:
//     the same id with the same normalized input returns the same run; a changed input is a
//     RequestConflictError (409).
//   - The run row is recorded (`running`) before any network work. Success and its result are
//     written in one transaction that only applies while that exact run is still running.
//   - 90 s logical deadline: the run is published failed/run_timeout. SheetsStore.readRows takes no
//     AbortSignal, so the outstanding read keeps the lock until it settles and its late result is
//     discarded (it can neither publish success nor trigger further work).
//   - Startup recovery: after acquiring the same lock, abandoned `running` rows become
//     interrupted/abandoned. A live competing owner (lock held) is left untouched. Nothing is re-run.
//   - close(): stops admissions, marks the owned run interrupted/shutdown (so no late success),
//     waits for its outstanding I/O to settle and the lock to be released, then closes the DB.
//
// Briefing composition reads FRESH Todos + Quarantine through the SheetsStore (not the 10 s
// TodosCache), applies the unchanged `visibleTodos` rule, keeps `status=open`, sorts by
// `message_date` descending with the Todo id as a lexical tie-break and caps at 25 items. Either
// tab failing fails the run; the previous snapshot stays as history. Never an empty success.
import { randomUUID } from "node:crypto";
import {
  ASSISTANT_RUN_DEADLINE_MS,
  ASSISTANT_SOURCES,
  BRIEFING_ITEM_CAP,
  type AssistantRun,
  type Briefing,
  type BriefingItem,
  type QuarantineItem,
  type RunErrorCode,
  type Source,
  type SourceRef,
  type Todo,
} from "@yarvis/shared";
import type { Paths } from "../config/paths.js";
import { QUARANTINE, SheetsError, TODOS, type SheetsStore } from "../connectors/sheets.js";
import {
  acquireLock,
  LockHeldError,
  type LockHandle,
  type LockOptions,
  type LockRecord,
} from "../lock.js";
import { visibleTodos } from "../routes/todos.js";
import {
  AssistantBusyError,
  AssistantStore,
  AssistantUnavailableError,
  assistantLockFile,
  RequestConflictError,
  requestHash,
} from "./store.js";

export type SourceConfigured = Record<Source, boolean>;

export interface AssistantServiceOptions {
  paths: Pick<Paths, "privateDir">;
  sheets: SheetsStore;
  /** Whether each message source is configured (files present only; never a secret value). */
  configured: () => Promise<SourceConfigured>;
  /** Clock for every stored timestamp (ms since epoch). */
  now?: () => number;
  /** Logical run deadline (default 90 s; injectable for tests). */
  deadlineMs?: number;
  /** Id generator (default crypto.randomUUID). */
  newId?: () => string;
  /** Diagnostics sink for content-free warnings (default console.error). */
  warn?: (line: string) => void;
  /** Lock options (tests inject a failing `unlink` to simulate a Windows release failure). */
  lockOptions?: Pick<LockOptions, "unlink">;
}

interface ActiveRun {
  runId: string | null;
  /** Settles when the run's I/O has settled and its lock is released. */
  done: Promise<void>;
}

/** `[kind, ...args]`: the normalized briefing request has no arguments. */
const BRIEFING_REQUEST = ["briefing"] as const;

function compareTodos(a: Todo, b: Todo): number {
  const ta = Date.parse(a.message_date);
  const tb = Date.parse(b.message_date);
  const va = Number.isNaN(ta) ? -Infinity : ta;
  const vb = Number.isNaN(tb) ? -Infinity : tb;
  if (va !== vb) return vb - va;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sourceRefOf(todo: Todo): SourceRef {
  return {
    todoId: todo.id,
    source: todo.source,
    sender: todo.sender,
    context: todo.context,
    messageDate: todo.message_date,
    link: todo.link,
    originalText: todo.original_text,
    action: todo.action,
    extractionStatus: todo.extraction_status,
  };
}

/**
 * Pure composition of one snapshot. `previous` is the immediately preceding successful snapshot
 * (null: this is the baseline, so nothing is labelled new).
 */
export function composeBriefing(input: {
  id: string;
  createdAt: string;
  sheetReadAt: string;
  todos: readonly Todo[];
  quarantine: readonly QuarantineItem[];
  previous: Briefing | null;
  configured: SourceConfigured;
}): Briefing {
  const seen = new Set<string>();
  const open = visibleTodos(input.todos, input.quarantine)
    .filter((t) => t.status === "open")
    .filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
    .sort(compareTodos);
  const shown = open.slice(0, BRIEFING_ITEM_CAP);
  const previousIds = input.previous
    ? new Set(input.previous.items.map((i) => i.sourceRef.todoId))
    : null;
  const items: BriefingItem[] = shown.map((todo) => ({
    sourceRef: sourceRefOf(todo),
    isNew: previousIds !== null && !previousIds.has(todo.id),
    preparationEligible: todo.extraction_status === "done",
  }));
  return {
    id: input.id,
    createdAt: input.createdAt,
    sheetReadAt: input.sheetReadAt,
    previousBriefingId: input.previous?.id ?? null,
    openCount: open.length,
    omittedCount: open.length - shown.length,
    items,
    sourceCoverage: ASSISTANT_SOURCES.map((source) => ({
      source,
      configured: input.configured[source],
      freshness: "unknown" as const,
    })),
  };
}

export class AssistantService {
  private store: AssistantStore | null = null;
  private unavailable: AssistantUnavailableError | null = null;
  private active: ActiveRun | null = null;
  private closing = false;
  private closed: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly deadlineMs: number;
  private readonly newId: () => string;
  private readonly warn: (line: string) => void;
  private readonly lockFile: string;
  /**
   * The record of a lock THIS process acquired but failed to release (a Windows unlink error):
   * passed as `ownLeftover` so the next acquisition reclaims it instead of reporting busy until
   * the ~17 min stale age (mirrors RefreshRunner in pipeline/job.ts).
   */
  private leftover: LockRecord | null = null;

  constructor(private readonly opts: AssistantServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.deadlineMs = opts.deadlineMs ?? ASSISTANT_RUN_DEADLINE_MS;
    this.newId = opts.newId ?? randomUUID;
    this.warn = opts.warn ?? ((line) => console.error(line));
    this.lockFile = assistantLockFile(opts.paths);
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /**
   * The open store, opened on first use. A store that failed closed stays unavailable for this
   * process (no retry loop that could race a repair); a busy initializer is retried next call.
   */
  private db(): AssistantStore {
    if (this.closing) throw new AssistantUnavailableError("closed");
    if (this.store) return this.store;
    if (this.unavailable) throw this.unavailable;
    try {
      this.store = AssistantStore.open(this.opts.paths);
      return this.store;
    } catch (err) {
      if (err instanceof AssistantUnavailableError) {
        this.unavailable = err;
        this.warn(`[yarvis] assistant store unavailable (${err.reason}); Todos remain usable`);
      }
      throw err;
    }
  }

  /** Whether the store opened (false: unavailable). Never throws. */
  get available(): boolean {
    try {
      this.db();
      return true;
    } catch {
      return false;
    }
  }

  /** Fails the assistant closed for this process (Todos are unaffected) and closes the store. */
  private markUnavailable(reason: AssistantUnavailableError["reason"], cause: unknown): void {
    this.unavailable ??= new AssistantUnavailableError(reason);
    this.warn(
      `[yarvis] assistant unavailable (${cause instanceof Error ? cause.name : "error"}); Todos remain usable`,
    );
    try {
      this.store?.close();
    } catch {
      // already failing closed
    }
    this.store = null;
  }

  private async acquire(): Promise<LockHandle> {
    const lock = await acquireLock(this.lockFile, {
      ...this.opts.lockOptions,
      ownLeftover: this.leftover,
    });
    this.leftover = null;
    return lock;
  }

  /**
   * Startup: opens the store and, ONLY after acquiring the assistant lock, turns abandoned
   * `running` rows into interrupted. A live lock owner is left alone. Never throws: a store or
   * lock failure other than a live owner / transient contention fails the assistant closed
   * (503 assistant_unavailable) so the server and Todos still start. Returns how many rows were
   * reconciled (null: skipped).
   */
  async init(): Promise<number | null> {
    let store: AssistantStore;
    try {
      store = this.db();
    } catch {
      return null;
    }
    let lock: LockHandle;
    try {
      lock = await this.acquire();
    } catch (err) {
      if (!(err instanceof LockHeldError)) this.markUnavailable("open_failed", err);
      return null;
    }
    try {
      return store.interruptRunning(this.iso());
    } catch (err) {
      if (err instanceof AssistantBusyError) {
        this.warn("[yarvis] assistant store busy at startup; recovery deferred to the next run");
      } else {
        this.markUnavailable(
          err instanceof AssistantUnavailableError ? err.reason : "open_failed",
          err,
        );
      }
      return null;
    } finally {
      await this.release(lock);
    }
  }

  latestRun(): AssistantRun | null {
    return this.db().latestRun();
  }

  getRun(id: string): AssistantRun | null {
    return this.db().getRun(id);
  }

  latestBriefing(): Briefing | null {
    return this.db().latestBriefing();
  }

  /**
   * POST /api/assistant/briefings. Returns the existing run for a repeated request id, else
   * admits a new run (or throws AssistantBusyError / RequestConflictError /
   * AssistantUnavailableError). The run's work continues after this resolves.
   */
  async startBriefing(requestId: string): Promise<AssistantRun> {
    const hash = requestHash(BRIEFING_REQUEST);
    const replay = this.replay(requestId, hash);
    if (replay) return replay;
    if (this.active) throw new AssistantBusyError();
    // Claimed synchronously, so a concurrent in-process request is busy without racing the lock.
    let settle!: () => void;
    const active: ActiveRun = { runId: null, done: new Promise<void>((r) => (settle = r)) };
    this.active = active;
    let lock: LockHandle;
    try {
      lock = await this.acquire();
    } catch (err) {
      this.active = null;
      settle();
      if (err instanceof LockHeldError) throw new AssistantBusyError();
      // The lock path itself is unusable (permissions, a directory in the way): 503, not 500.
      this.warn(
        `[yarvis] assistant lock unavailable: ${err instanceof Error ? err.name : "error"}`,
      );
      throw new AssistantUnavailableError("open_failed");
    }
    let run: AssistantRun;
    try {
      if (this.closing) throw new AssistantUnavailableError("closed");
      // Re-checked under the lock: another process may have admitted this request id meanwhile.
      const raced = this.replay(requestId, hash);
      if (raced) {
        await this.release(lock);
        this.active = null;
        settle();
        return raced;
      }
      const store = this.db();
      // We hold the lock, so any other `running` row was abandoned by a dead owner.
      store.interruptRunning(this.iso());
      run = store.insertRun({
        id: this.newId(),
        requestId,
        requestHash: hash,
        kind: "briefing",
        createdAt: this.iso(),
      });
    } catch (err) {
      await this.release(lock);
      this.active = null;
      settle();
      throw err;
    }
    active.runId = run.id;
    void this.executeBriefing(run, lock).finally(() => {
      if (this.active === active) this.active = null;
      settle();
    });
    return run;
  }

  private replay(requestId: string, hash: string): AssistantRun | null {
    const existing = this.db().findRunByRequestId(requestId);
    if (!existing) return null;
    if (existing.requestHash !== hash) throw new RequestConflictError();
    return existing.run;
  }

  private async executeBriefing(run: AssistantRun, lock: LockHandle): Promise<void> {
    const store = this.db();
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      this.finish(store, run.id, "failed", "run_timeout");
    }, this.deadlineMs);
    try {
      // Both tabs, fresh (never the TodosCache). No AbortSignal exists, so BOTH reads must settle
      // (allSettled: one failing fast never frees the lock while the other is still in flight);
      // past the deadline or on shutdown their result is discarded below.
      const [todosRead, quarantineRead] = await Promise.allSettled([
        this.opts.sheets.readRows(TODOS),
        this.opts.sheets.readRows(QUARANTINE),
      ]);
      if (expired || this.closing) return;
      if (todosRead.status === "rejected" || quarantineRead.status === "rejected") {
        const failure: unknown =
          todosRead.status === "rejected"
            ? todosRead.reason
            : (quarantineRead as PromiseRejectedResult).reason;
        const code: RunErrorCode =
          failure instanceof SheetsError && failure.kind === "not_configured"
            ? "sheets_not_configured"
            : "source_unavailable";
        this.finish(store, run.id, "failed", code);
        return;
      }
      const sheetReadAt = this.iso();
      const configured = await this.opts
        .configured()
        .catch((): SourceConfigured => ({ gmail: false, whatsapp: false }));
      if (expired || this.closing) return;
      const todos = todosRead.value;
      const quarantine = quarantineRead.value;
      const createdAt = this.iso();
      store.commitBriefing(run.id, createdAt, (previous) =>
        composeBriefing({
          id: this.newId(),
          createdAt,
          sheetReadAt,
          todos,
          quarantine,
          previous,
          configured,
        }),
      );
    } catch (err) {
      this.warn(
        `[yarvis] assistant briefing run failed: ${err instanceof Error ? err.name : "error"}`,
      );
      this.finish(store, run.id, "failed", "internal");
    } finally {
      clearTimeout(timer);
      await this.release(lock);
    }
  }

  /** Guarded terminal write; a closed or contended store is reported, never thrown. */
  private finish(
    store: AssistantStore,
    runId: string,
    state: "failed" | "interrupted",
    code: RunErrorCode,
  ): void {
    try {
      if (store.isOpen) store.finishRun(runId, state, code, this.iso());
    } catch (err) {
      this.warn(
        `[yarvis] could not record assistant run end: ${err instanceof Error ? err.name : "error"}`,
      );
    }
  }

  private async release(lock: LockHandle): Promise<void> {
    try {
      await lock.release();
    } catch (err) {
      // Still our record on disk: the next acquisition reclaims it via ownLeftover.
      this.leftover = lock.record;
      this.warn(
        `[yarvis] could not release the assistant lock: ${err instanceof Error ? err.name : "error"}`,
      );
    }
  }

  /** Settles once the current run (if any) has finished all of its I/O. */
  async idle(): Promise<void> {
    while (this.active) await this.active.done;
  }

  /**
   * Stops admissions, marks an owned in-flight run interrupted/shutdown (a late result can no
   * longer publish), waits for its I/O and lock release, then closes the database. Idempotent.
   */
  close(): Promise<void> {
    this.closed ??= (async () => {
      this.closing = true;
      const active = this.active;
      if (active?.runId && this.store)
        this.finish(this.store, active.runId, "interrupted", "shutdown");
      await this.idle();
      this.store?.close();
      this.store = null;
    })();
    return this.closed;
  }
}

export { AssistantBusyError, AssistantUnavailableError, RequestConflictError };

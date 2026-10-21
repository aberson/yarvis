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
// Preparation (Step 10, S1.5 "Preparation behavior"): POST resolves briefingId + todoId to a STORED
// briefing item (unknown / not eligible -> 409 revision_conflict). A Todo that already has a packet
// takes the fast path: one transaction records a succeeded prepare run (unique request id, hash,
// target) and the packet is returned with no model call, even while another run is active.
// Otherwise the run is admitted like a briefing (busy, lock, re-checks under the lock), recorded
// `running`, and the selected Todo + current Quarantine are re-read FRESH: any changed SourceRef
// field, a missing / no-longer-open / not-done / quarantined Todo fails the run `source_changed`
// and the POST answers 409 revision_conflict; a failed read fails it and answers 503
// source_unavailable. Only then is the POST answered 202 and the composer called (never after the
// deadline or shutdown) with timeout = min(60 s, remaining deadline) and an AbortSignal the deadline
// and close() fire. Only a validated Composition is stored, in one transaction that applies only
// while that exact run is still running. Retry is a new request id; nothing is replayed.
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
  type PreparationPacket,
  type QuarantineItem,
  type RunErrorCode,
  type Source,
  type SourceRef,
  type Todo,
} from "@yarvis/shared";
import type { Paths } from "../config/paths.js";
import {
  COMPOSE_PROMPT_VERSION,
  COMPOSE_TIMEOUT_CAP_MS,
  type ComposeOutcome,
  type Composer,
} from "../ai/compose.js";
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
  isConstraint,
  RequestConflictError,
  requestHash,
  type RunMeta,
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
  /**
   * The preparation composer: the CLI-backed ClaudeComposer in real mode, FakeComposer in fake
   * mode (index.ts). Without one, preparation answers 503 assistant_unavailable.
   */
  composer?: Composer;
  /** Upper bound of one model call (default 60 s; injectable for tests). */
  composeTimeoutCapMs?: number;
}

interface ActiveRun {
  runId: string | null;
  /** Settles when the run's I/O has settled and its lock is released. */
  done: Promise<void>;
  /** Aborts owned composition (deadline / close). */
  abort?: () => void;
}

/** `[kind, ...args]`: the normalized briefing request has no arguments. */
const BRIEFING_REQUEST = ["briefing"] as const;

/** The selected task changed or is not eligible: 409 revision_conflict, no model call. */
export class SourceConflictError extends Error {
  constructor() {
    super("the selected task changed or is not eligible; refresh and build a new briefing");
    this.name = "SourceConflictError";
  }
}

/** The selected task could not be verified against the sheet: 503 source_unavailable. */
export class SourceUnavailableError extends Error {
  constructor() {
    super("could not verify the selected task against the sheet");
    this.name = "SourceUnavailableError";
  }
}

export interface PrepareRequest {
  requestId: string;
  briefingId: string;
  todoId: string;
}

/** POST /api/assistant/preparations: follow `run` (202) or open the existing `packet` (200). */
export type PrepareOutcome =
  { kind: "run"; run: AssistantRun } | { kind: "packet"; packet: PreparationPacket };

/** `[kind, briefingId, todoId]`: the fixed ordered normalized prepare request. */
function prepareRequest(req: PrepareRequest): readonly string[] {
  return ["prepare", req.briefingId, req.todoId];
}

const SOURCE_REF_KEYS = [
  "todoId",
  "source",
  "sender",
  "context",
  "messageDate",
  "link",
  "originalText",
  "action",
  "extractionStatus",
] as const satisfies ReadonlyArray<keyof SourceRef>;

/**
 * Whether the stored briefing item's source still holds: the Todo exists once, is visible (not
 * quarantined), open, extracted (`done`), and every SourceRef field equals the saved capture.
 */
export function sourceStillCurrent(
  item: BriefingItem,
  todos: readonly Todo[],
  quarantine: readonly QuarantineItem[],
): boolean {
  if (!item.preparationEligible) return false;
  const matches = todos.filter((t) => t.id === item.sourceRef.todoId);
  if (matches.length !== 1) return false;
  const current = visibleTodos(matches, quarantine)[0];
  if (!current || current.status !== "open" || current.extraction_status !== "done") return false;
  const ref = sourceRefOf(current);
  return SOURCE_REF_KEYS.every((k) => ref[k] === item.sourceRef[k]);
}

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
  private readonly composeCapMs: number;
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
    this.composeCapMs = opts.composeTimeoutCapMs ?? COMPOSE_TIMEOUT_CAP_MS;
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
    const { active, settle, lock } = await this.admit();
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

  /**
   * Claims the one in-process run slot (synchronously, so a concurrent in-process request is busy
   * without racing the lock), then the cross-process assistant lock. Busy -> AssistantBusyError;
   * an unusable lock path -> 503 AssistantUnavailableError.
   */
  private async admit(): Promise<{ active: ActiveRun; settle: () => void; lock: LockHandle }> {
    if (this.active) throw new AssistantBusyError();
    let settle!: () => void;
    const active: ActiveRun = { runId: null, done: new Promise<void>((r) => (settle = r)) };
    this.active = active;
    try {
      return { active, settle, lock: await this.acquire() };
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
      this.ensureEnded(store, run.id);
      await this.release(lock);
    }
  }

  getPacket(id: string): PreparationPacket | null {
    return this.db().getPacket(id);
  }

  /**
   * POST /api/assistant/preparations. A repeated request id with the same input replays (its
   * packet once succeeded, else its run); a changed input is a RequestConflictError. Resolves once
   * the source is verified (202 run) or with the existing packet (200); throws SourceConflictError
   * (409), SourceUnavailableError (503), AssistantBusyError, AssistantUnavailableError.
   */
  async startPreparation(req: PrepareRequest): Promise<PrepareOutcome> {
    const composer = this.opts.composer;
    if (!composer) throw new AssistantUnavailableError("open_failed");
    const hash = requestHash(prepareRequest(req));
    const replay = this.replayPrepare(req.requestId, hash);
    if (replay) return replay;
    const item = this.resolveItem(req);
    const fast = this.existingPacket(req, hash);
    if (fast) return fast;
    const { active, settle, lock } = await this.admit();
    let run: AssistantRun;
    try {
      if (this.closing) throw new AssistantUnavailableError("closed");
      // Re-checked under the lock: another process may have admitted this request id, or
      // prepared this Todo, meanwhile.
      const raced = this.replayPrepare(req.requestId, hash) ?? this.existingPacket(req, hash);
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
        requestId: req.requestId,
        requestHash: hash,
        kind: "prepare",
        createdAt: this.iso(),
        sourceTodoId: req.todoId,
      });
    } catch (err) {
      await this.release(lock);
      this.active = null;
      settle();
      throw err;
    }
    active.runId = run.id;
    let verified!: (refusal: Error | null) => void;
    const verification = new Promise<Error | null>((r) => (verified = r));
    void this.executePreparation(run, lock, item, composer, active, verified).finally(() => {
      if (this.active === active) this.active = null;
      settle();
    });
    const refusal = await verification;
    if (refusal) throw refusal;
    if (this.closing) throw new AssistantUnavailableError("closed");
    return { kind: "run", run: this.db().getRun(run.id) ?? run };
  }

  /** A stored request id: same input replays (packet once succeeded), changed input conflicts. */
  private replayPrepare(requestId: string, hash: string): PrepareOutcome | null {
    const run = this.replay(requestId, hash);
    if (!run) return null;
    if (run.state === "succeeded" && run.targetId) {
      const packet = this.db().getPacket(run.targetId);
      if (packet) return { kind: "packet", packet };
    }
    return { kind: "run", run };
  }

  /** The stored briefing item for the request; unknown or never eligible -> SourceConflictError. */
  private resolveItem(req: PrepareRequest): BriefingItem {
    const briefing = this.db().getBriefing(req.briefingId);
    const item = briefing?.items.find((i) => i.sourceRef.todoId === req.todoId);
    if (!item?.preparationEligible) throw new SourceConflictError();
    return item;
  }

  /** The fast path: the Todo already has a packet -> record a succeeded run and return it. */
  private existingPacket(req: PrepareRequest, hash: string): PrepareOutcome | null {
    try {
      const packet = this.db().recordExistingPacketRun(
        {
          id: this.newId(),
          requestId: req.requestId,
          requestHash: hash,
          kind: "prepare",
          createdAt: this.iso(),
          sourceTodoId: req.todoId,
        },
        req.todoId,
      );
      return packet ? { kind: "packet", packet } : null;
    } catch (err) {
      // The same request id was recorded concurrently: answer exactly as a replay would.
      if (isConstraint(err)) {
        const replay = this.replayPrepare(req.requestId, hash);
        if (replay) return replay;
      }
      throw err;
    }
  }

  private async executePreparation(
    run: AssistantRun,
    lock: LockHandle,
    item: BriefingItem,
    composer: Composer,
    active: ActiveRun,
    verified: (refusal: Error | null) => void,
  ): Promise<void> {
    const store = this.db();
    const controller = new AbortController();
    active.abort = () => controller.abort();
    // The budget uses the injected clock, like every other time read in this service.
    const startedAt = this.now();
    let expired = false;
    let answered = false;
    /** Answered only after the lock is released, so an immediate retry is not busy. */
    let refusal: Error | null = null;
    const answer = (outcome: Error | null): void => {
      if (answered) return;
      answered = true;
      verified(outcome);
    };
    const timer = setTimeout(() => {
      expired = true;
      this.finish(store, run.id, "failed", "run_timeout");
      controller.abort();
    }, this.deadlineMs);
    try {
      // Fresh reads (never the TodosCache); both settle before the lock can be released.
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
        this.finish(
          store,
          run.id,
          "failed",
          failure instanceof SheetsError && failure.kind === "not_configured"
            ? "sheets_not_configured"
            : "source_unavailable",
        );
        refusal = new SourceUnavailableError();
        return;
      }
      if (!sourceStillCurrent(item, todosRead.value, quarantineRead.value)) {
        this.finish(store, run.id, "failed", "source_changed");
        refusal = new SourceConflictError();
        return;
      }
      answer(null); // verified: the POST answers 202 while composition continues
      const remaining = this.deadlineMs - (this.now() - startedAt);
      // Never start composition after the deadline or shutdown. (Those paths are already terminal:
      // the deadline timer / close() recorded the run's end.)
      if (expired || this.closing || controller.signal.aborted) return;
      if (remaining <= 0) {
        // The deadline passed but its timer has not fired yet (event-loop delay): end the run here.
        expired = true;
        this.finish(store, run.id, "failed", "run_timeout");
        controller.abort();
        return;
      }
      let outcome: ComposeOutcome;
      try {
        outcome = await composer.compose(
          { sourceRef: item.sourceRef },
          { timeoutMs: Math.min(this.composeCapMs, remaining), signal: controller.signal },
        );
      } catch {
        outcome = {
          ok: false,
          code: "compose_failed",
          model: null,
          promptVersion: COMPOSE_PROMPT_VERSION,
        };
      }
      // A late result (past the deadline, after close) is discarded; commitPacket re-checks too.
      if (expired || this.closing) return;
      if (!outcome.ok) {
        const meta: RunMeta = { model: outcome.model, promptVersion: outcome.promptVersion };
        this.finish(store, run.id, "failed", outcome.code, meta);
        return;
      }
      const createdAt = this.iso();
      store.commitPacket(run.id, {
        id: this.newId(),
        todoId: item.sourceRef.todoId,
        sourceRef: item.sourceRef,
        createdAt,
        updatedAt: createdAt,
        revision: 1,
        state: "open",
        draft: outcome.composition.draft,
        checklist: outcome.composition.checklist.map((text) => ({
          id: this.newId(),
          text,
          done: false,
        })),
        questions: outcome.composition.questions,
        model: outcome.model,
        promptVersion: outcome.promptVersion,
      });
    } catch (err) {
      this.warn(
        `[yarvis] assistant preparation run failed: ${err instanceof Error ? err.name : "error"}`,
      );
      this.finish(store, run.id, "failed", "internal");
    } finally {
      clearTimeout(timer);
      active.abort = undefined;
      this.ensureEnded(store, run.id);
      await this.release(lock);
      answer(refusal);
    }
  }

  /**
   * Guarded terminal write (applies only while the run is still `running`); returns whether it
   * changed the row. A closed or contended store is reported, never thrown.
   */
  private finish(
    store: AssistantStore,
    runId: string,
    state: "failed" | "interrupted",
    code: RunErrorCode,
    meta?: RunMeta,
  ): boolean {
    try {
      return store.isOpen && store.finishRun(runId, state, code, this.iso(), meta);
    } catch (err) {
      this.warn(
        `[yarvis] could not record assistant run end: ${err instanceof Error ? err.name : "error"}`,
      );
      return false;
    }
  }

  /**
   * Safety net run once all owned I/O has settled and before the lock is released: every exit
   * path after admission leaves the run terminal. A no-op when it already ended (the normal case).
   */
  private ensureEnded(store: AssistantStore, runId: string): void {
    if (this.finish(store, runId, "failed", "internal")) {
      this.warn("[yarvis] assistant run ended without a terminal state; recorded failed");
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
   * longer publish), aborts owned composition, waits for its I/O and lock release, then closes
   * the database. Idempotent.
   */
  close(): Promise<void> {
    this.closed ??= (async () => {
      this.closing = true;
      const active = this.active;
      if (active?.runId && this.store)
        this.finish(this.store, active.runId, "interrupted", "shutdown");
      active?.abort?.();
      await this.idle();
      this.store?.close();
      this.store = null;
    })();
    return this.closed;
  }
}

export { AssistantBusyError, AssistantUnavailableError, RequestConflictError };

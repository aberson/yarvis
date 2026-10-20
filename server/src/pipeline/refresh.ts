// One Refresh (plan §4, D3, D16-D20): `runRefresh(deps)` is THE production entry point; the job
// runner (job.ts), the `yarvis refresh` CLI verb and every integration test call it.
//
//   whatsapp -> gmail -> jev -> extract -> sheets, then private/state.json
//
// Work sets are defined by pipeline state, not fetch novelty (D17): every cached message without a
// decision (or with a per-message Jev error under 3 attempts) is screened; every decision that is
// actionable under the CURRENT thresholds and lacks a finished extraction is extracted (pending
// first); every decision without `sheetSyncedAt` is written. So messages cached by a failed run are
// screened, extracted and written by the next run exactly once.
//
// Security: decide() runs over raw scores before extraction and a message is only ever handed to
// the extractor when decide() says actionable (never quarantined). A Jev service failure fails
// CLOSED (D3): the job ends `error` at stage jev, nothing is extracted, nothing is written to the
// sheet, no cursor moves. Status/error text never carries message content or private/ values.
import {
  parseTodoId,
  REFRESH_STAGES,
  sinceEpochMs,
  todoId,
  type JevScores,
  type Message,
  type QuarantineItem,
  type RefreshStage,
  type RefreshStatus,
  type Settings,
  type StageStatus,
  type Todo,
} from "@yarvis/shared";
import { decide, thresholdsFrom, type Decision } from "../ai/decide.js";
import type { ExtractInput, ExtractionResult, Extractor } from "../ai/extract.js";
import {
  classifyBatch,
  JEV_MAX_ATTEMPTS,
  JevMessageRejected,
  jevErrorRecord,
  type Jev,
  type JevErrorRecord,
} from "../ai/jev.js";
import type { Paths } from "../config/paths.js";
import { loadSettings } from "../config/settings.js";
import { QUARANTINE, TODOS } from "../connectors/sheets.js";
import { drain, waAuthDir, type WaDeps, type WaSocket } from "../connectors/whatsapp.js";
import {
  ABANDON_GRACE_MS,
  acquireLock,
  JOB_CEILING_MS,
  type LockHandle,
  type LockRecord,
} from "../lock.js";
import {
  appendJsonl,
  decisionsFile,
  loadDecisions,
  loadMessages,
  messagesFile,
  type DecisionRecord,
  type ExtractionRecord,
} from "./cache.js";
import {
  extractionPendingText,
  jevRejectedText,
  STAGE_TIMEOUT_ERROR,
  stageErrorText,
} from "./errors.js";
import type { PipelineSeams } from "./seams.js";
import { readState, writeState, type PipelineState } from "./state.js";

export interface RefreshDeps extends PipelineSeams {
  paths: Paths;
  /** Settings for this job; default: loadSettings(paths) (current thresholds, D16). */
  settings?: () => Promise<Settings>;
  now?: () => Date;
  /** Operational log (counts / fixed phrases only, never content); default stderr, silent under Vitest. */
  log?: (line: string) => void;
}

export interface RefreshOptions {
  /** A lock the caller already acquired (the job runner); released when the job ends. */
  lock?: LockHandle;
  /** Called with a fresh snapshot after every status change. */
  onStatus?: (status: RefreshStatus) => void;
  /**
   * Called when the lock could not be removed even after release()'s retries: the caller (the job
   * runner) keeps the record and reclaims it on its next start (`acquireLock({ownLeftover})`).
   */
  onLockLeftover?: (record: LockRecord) => void;
}

/** `job-<ISO timestamp truncated to seconds>` (§3.1), e.g. `job-2026-10-19T18:02:11Z`. */
export function refreshJobId(at: Date): string {
  return `job-${at.toISOString().slice(0, 19)}Z`;
}

export function idleStatus(): RefreshStatus {
  return {
    state: "idle",
    stages: Object.fromEntries(
      REFRESH_STAGES.map((s) => [s, { state: "pending", count: 0 }]),
    ) as Record<RefreshStage, StageStatus>,
    startedAt: null,
    finishedAt: null,
  };
}

export function cloneStatus(status: RefreshStatus): RefreshStatus {
  return structuredClone(status);
}

/** The job ceiling fired: every later side effect of the abandoned stage is refused. */
class JobAborted extends Error {
  constructor() {
    super("refresh job ended by the job ceiling");
    this.name = "JobAborted";
  }
}

/**
 * Mutable job status with change notification, and the job's cancellation. When the ceiling fires:
 *   - `guard()` (called immediately before every cache append, sheet upsert, state write, Jev
 *     result and extractor call) throws, so the abandoned stage writes nothing more;
 *   - `signal` aborts, which actively stops the cancellable work: the running claude child is
 *     tree-killed (ai/extract.ts), every WhatsApp socket of the drain is ended (the drain returns),
 *     and Gmail / Jev launch no further calls.
 * Non-cancellable, each bounded by its own per-call timeout: a Gmail list/get or Jev call already in
 * flight (30 s per attempt, util/retry.ts), a cache append (local fs), and a Sheets upsert already in
 * flight (30 s per call attempt; with 429/5xx retries it can outlast the 2 min grace, but it is an
 * idempotent upsert by id and nothing is written after it).
 */
class JobTracker {
  readonly status: RefreshStatus;
  aborted = false;
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private current: RefreshStage | null = null;

  constructor(
    startedAt: string,
    private readonly onStatus: ((s: RefreshStatus) => void) | undefined,
  ) {
    this.status = { ...idleStatus(), state: "running", startedAt };
  }

  emit(): void {
    this.onStatus?.(cloneStatus(this.status));
  }

  /** Throws when the job ceiling ended the job: no write may follow. */
  guard(): void {
    if (this.aborted) throw new JobAborted();
  }

  begin(stage: RefreshStage): void {
    this.guard();
    this.current = stage;
    this.status.stages[stage] = { state: "running", count: 0 };
    this.emit();
  }

  /** `note` reports per-item failures on a stage that otherwise finished (fixed vocabulary). */
  done(stage: RefreshStage, count: number, note?: string): void {
    this.guard();
    this.status.stages[stage] = note
      ? { state: "done", count, error: note }
      : { state: "done", count };
    this.current = null;
    this.emit();
  }

  fail(stage: RefreshStage, error: string, count = 0): void {
    this.guard();
    this.status.stages[stage] = { state: "error", count, error };
    this.current = null;
    this.emit();
  }

  /** Marks every stage still pending as skipped. */
  skipRest(): void {
    for (const s of REFRESH_STAGES) {
      if (this.status.stages[s].state === "pending")
        this.status.stages[s] = { state: "skipped", count: 0 };
    }
  }

  /** The job ceiling: the running stage errors with `stage timeout`, the rest are skipped. */
  timeout(finishedAt: string): void {
    const stage =
      this.current ?? REFRESH_STAGES.find((s) => this.status.stages[s].state === "pending");
    if (stage) {
      const count = this.status.stages[stage].count;
      this.status.stages[stage] = { state: "error", count, error: STAGE_TIMEOUT_ERROR };
    } else {
      this.status.error = STAGE_TIMEOUT_ERROR;
    }
    this.aborted = true;
    this.controller.abort();
    this.skipRest();
    this.status.state = "error";
    this.status.finishedAt = finishedAt;
    this.onStatus?.(cloneStatus(this.status));
  }
}

const isJevError = (outcome: unknown): outcome is JevErrorRecord =>
  typeof (outcome as Partial<JevErrorRecord> | null)?.error === "string";

/** Epoch seconds of `settings.since` (§3.3, D38; validated at settings load). */
export function sinceEpochSeconds(since: string): number {
  const ms = sinceEpochMs(since);
  if (ms === null) throw new RangeError(`settings.since is not a valid day or instant: ${since}`);
  return Math.floor(ms / 1000);
}

function resolveSeam<T extends object>(seam: T | ((s: Settings) => T), settings: Settings): T {
  return typeof seam === "function" ? seam(settings) : seam;
}

function extractionRecord(result: ExtractionResult): ExtractionRecord {
  return { status: result.status, actions: [...result.actions] };
}

/** Todo rows for one synced decision (§3.4, D18): `#1..#n` when done, else one `#1` row. */
function todoRowsFor(message: Message, record: DecisionRecord, nowIso: string): Todo[] {
  const extraction = record.extraction as ExtractionRecord;
  const scores = record.jev as JevScores;
  const base = {
    source: message.source,
    status: "open" as const,
    original_text: message.text,
    sender: message.sender,
    context: message.context,
    message_date: message.date,
    link: message.link,
    jev_action: scores.action,
    created_at: nowIso,
    updated_at: nowIso,
  };
  if (extraction.status === "done" && extraction.actions.length > 0) {
    return extraction.actions.map((action, i) => ({
      ...base,
      id: todoId(message.id, i + 1),
      action,
      extraction_status: "done" as const,
    }));
  }
  // pending (retried next run) or none (terminal): the row shows the original text (§8).
  return [
    {
      ...base,
      id: todoId(message.id, 1),
      action: message.text,
      extraction_status: extraction.status === "pending" ? "pending" : "none",
    },
  ];
}

function quarantineRowFor(
  message: Message,
  record: DecisionRecord,
  decision: Decision,
  nowIso: string,
): QuarantineItem {
  const scores = isJevError(record.jev) ? null : (record.jev as Partial<JevScores>);
  const score = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    id: message.id,
    source: message.source,
    sender: message.sender,
    context: message.context,
    message_date: message.date,
    link: message.link,
    jev_phishing: score(scores?.phishing),
    jev_malicious: score(scores?.malicious),
    jev_spam: score(scores?.spam),
    reason: decision.reason,
    created_at: nowIso,
    released_at: "",
  };
}

/** A pending Todos row whose message is not in the cache (cache deleted, §3.4): retried from the sheet. */
interface SheetRetry {
  row: Todo;
  messageId: string;
  result?: ExtractionResult;
}

/** Rows written for a sheet-derived retry: `#1` overwritten, `#2`/`#3` appended (D18). */
function sheetRetryRows(retry: SheetRetry, nowIso: string): Todo[] {
  const { row, result } = retry;
  if (!result || result.status === "pending") return [];
  const base: Todo = { ...row, updated_at: nowIso };
  if (result.status === "none") return [{ ...base, extraction_status: "none" }];
  return result.actions.map((action, i) =>
    i === 0
      ? { ...base, action, extraction_status: "done" }
      : {
          ...base,
          id: todoId(retry.messageId, i + 1),
          action,
          extraction_status: "done",
          status: "open",
          created_at: nowIso,
        },
  );
}

/**
 * Runs one refresh under `private/refresh.lock` (D19). Without `opts.lock` it acquires the lock
 * first and throws `LockHeldError` ("refresh already running") with no other effect when it is held.
 * Resolves with the final status (`done | partial | error`); stage failures never reject.
 *
 * Job ceiling (D20): at JOB_CEILING_MS the running stage is reported `error` / "stage timeout" at
 * once (onStatus), the job is cancelled (every later write refused), and the lock stays held until
 * the abandoned stage has settled, at most ABANDON_GRACE_MS, so no new job can overlap it. The
 * promise resolves when the lock is released.
 */
export async function runRefresh(
  deps: RefreshDeps,
  opts: RefreshOptions = {},
): Promise<RefreshStatus> {
  const lock = opts.lock ?? (await acquireLock(deps.paths.lockFile));
  const now = deps.now ?? (() => new Date());
  const job = new JobTracker(now().toISOString(), opts.onStatus);
  job.emit();
  let timer: NodeJS.Timeout | undefined;
  try {
    const ceiling = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), JOB_CEILING_MS);
    });
    const work = runStages(deps, job, now).then(
      () => "finished" as const,
      (err: unknown) => {
        if (err instanceof JobAborted) return "finished" as const;
        // runStages handles every stage failure; this is a defect in the pipeline itself.
        if (!job.aborted) {
          job.status.error = stageErrorText(err);
          job.status.state = "error";
          job.skipRest();
        }
        return "finished" as const;
      },
    );
    const outcome = await Promise.race([work, ceiling]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      job.timeout(now().toISOString());
      const final = cloneStatus(job.status);
      let grace: NodeJS.Timeout | undefined;
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, ABANDON_GRACE_MS);
        }),
      ]);
      clearTimeout(grace);
      return final;
    }
    job.status.finishedAt = now().toISOString();
    job.emit();
    return cloneStatus(job.status);
  } finally {
    clearTimeout(timer);
    await releaseQuietly(lock, defaultLog(deps), opts.onLockLeftover);
  }
}

function defaultLog(deps: RefreshDeps): (line: string) => void {
  return deps.log ?? (process.env.VITEST ? () => undefined : (line) => console.warn(line));
}

/**
 * A failed unlink must not discard the job's result. release() already retried transient Windows
 * errors; the lock is held by this LIVE process, so it is handed to `onLeftover` for the runner to
 * reclaim on its next start (otherwise it would block every refresh until the age rule).
 */
async function releaseQuietly(
  lock: LockHandle,
  log: (line: string) => void,
  onLeftover?: (record: LockRecord) => void,
): Promise<void> {
  try {
    await lock.release();
  } catch (err) {
    log(`[refresh] could not remove the refresh lock: ${stageErrorText(err)}`);
    onLeftover?.(lock.record);
  }
}

/** The drain's socket seam, recording every socket so an abort can end them (the drain returns). */
function abortableWa(wa: WaDeps, signal: AbortSignal): WaDeps {
  const sockets: WaSocket[] = [];
  signal.addEventListener("abort", () => {
    for (const sock of sockets) void sock.end().catch(() => undefined);
  });
  return {
    loadAuth: (dir) => wa.loadAuth(dir),
    makeSocket: (config) => {
      const sock = wa.makeSocket(config);
      sockets.push(sock);
      if (signal.aborted) void sock.end().catch(() => undefined);
      return sock;
    },
  };
}

async function runStages(deps: RefreshDeps, job: JobTracker, now: () => Date): Promise<void> {
  const { paths } = deps;
  const log = defaultLog(deps);
  const startedAt = job.status.startedAt as string;
  const status = job.status;

  // ---- setup: settings (CURRENT thresholds), cursors, caches.
  let settings: Settings;
  let state: PipelineState;
  let messages: Map<string, Message>;
  let decisions: Map<string, DecisionRecord>;
  try {
    settings = await (deps.settings ?? (() => loadSettings(paths)))();
    state = await readState(paths);
    const m = await loadMessages(messagesFile(paths));
    const d = await loadDecisions(decisionsFile(paths));
    const torn = m.skippedTornLines + d.skippedTornLines;
    if (torn > 0) log(`[refresh] skipped ${torn} torn trailing cache line(s)`);
    messages = m.messages;
    decisions = d.decisions;
  } catch (err) {
    job.guard();
    status.error = stageErrorText(err);
    status.state = "error";
    job.skipRest();
    return;
  }
  const sinceEpoch = sinceEpochSeconds(settings.since);
  const cacheMessages = async (fresh: Message[]): Promise<number> => {
    const seen = new Set<string>();
    const novel = fresh.filter((m) => !messages.has(m.id) && !seen.has(m.id) && seen.add(m.id));
    job.guard();
    await appendJsonl(messagesFile(paths), novel);
    for (const m of novel) messages.set(m.id, m);
    return novel.length;
  };
  const appendDecisions = async (records: DecisionRecord[]): Promise<void> => {
    job.guard();
    await appendJsonl(decisionsFile(paths), records);
    for (const r of records) decisions.set(r.id, r);
  };
  let partial = false;
  const next: PipelineState = { ...state };

  // ---- whatsapp: independent source stage (§4); its cursor moves only on success.
  job.begin("whatsapp");
  try {
    const sinceTs = Math.max(sinceEpoch, state.whatsapp?.lastMessageTs ?? sinceEpoch);
    const result = await drain({
      authDir: waAuthDir(paths),
      allowlist: settings.whatsapp.allowlist,
      sinceTs,
      deps: abortableWa(deps.wa, job.signal),
      ...(deps.waWindow ?? {}),
      now: () => now().getTime(),
    });
    // settings.since floors both sources (D21); the drain's 24 h overlap must not cross it.
    const fresh = result.messages.filter((m) => Date.parse(m.date) >= sinceEpoch * 1000);
    const count = await cacheMessages(fresh);
    const prevTs = state.whatsapp?.lastMessageTs;
    const lastMessageTs =
      result.lastMessageTs === null
        ? prevTs
        : Math.max(result.lastMessageTs, prevTs ?? result.lastMessageTs);
    next.whatsapp = {
      lastRunAt: startedAt,
      ...(lastMessageTs === undefined ? {} : { lastMessageTs }),
    };
    job.done("whatsapp", count);
  } catch (err) {
    if (err instanceof JobAborted) throw err;
    job.fail("whatsapp", stageErrorText(err));
    partial = true;
  }

  // ---- gmail: independent source stage; messages.get only for uncached ids (D21). Fetched
  // messages are cached as they arrive (onMessages), so a fetch that fails part-way (e.g. a
  // rate limit that outlasts its waits) keeps them: the next run skips them via knownIds. The
  // cursor still moves only when the whole fetch succeeded.
  job.begin("gmail");
  let gmailCount = 0;
  try {
    const result = await deps.gmail.fetchSince(
      { since: settings.since, lastRunAt: state.gmail?.lastRunAt ?? null },
      new Set(messages.keys()),
      {
        signal: job.signal,
        onMessages: async (batch) => {
          gmailCount += await cacheMessages(batch);
        },
      },
    );
    // Anything the connector did not hand over incrementally (dedup makes this a no-op otherwise).
    gmailCount += await cacheMessages(result.messages);
    next.gmail = { lastRunAt: startedAt };
    job.done("gmail", gmailCount);
  } catch (err) {
    if (err instanceof JobAborted) throw err;
    job.fail("gmail", stageErrorText(err), gmailCount);
    partial = true;
  }

  // ---- jev: every cached message without scores (no decision, or a jev error under 3 attempts).
  job.begin("jev");
  const toScore = [...messages.values()].filter((m) => {
    const d = decisions.get(m.id);
    return !d || (isJevError(d.jev) && d.jev.attempts < JEV_MAX_ATTEMPTS);
  });
  const scored: DecisionRecord[] = [];
  let scoredCount = 0;
  let rejectedCount = 0;
  try {
    const jev: Jev = resolveSeam(deps.jev, settings);
    await classifyBatch(jev, toScore, {
      concurrency: settings.jev.concurrency,
      signal: job.signal,
      onResult: (id, outcome) => {
        // Cancelled by the ceiling: throwing here stops the batch launching further calls.
        job.guard();
        if (outcome instanceof JevMessageRejected) {
          rejectedCount++;
          const prev = decisions.get(id)?.jev;
          scored.push({ id, jev: jevErrorRecord(outcome, isJevError(prev) ? prev.attempts : 0) });
        } else {
          scored.push({ id, jev: outcome });
          scoredCount++;
        }
      },
    });
  } catch (err) {
    if (err instanceof JobAborted) throw err;
    // Fail closed (D3): keep the scores already obtained (they cost API calls), write nothing to
    // the sheet, move no cursor.
    await appendDecisions(scored).catch((e: unknown) => {
      if (e instanceof JobAborted) throw e;
    });
    job.fail("jev", stageErrorText(err), scoredCount);
    status.state = "error";
    job.skipRest();
    return;
  }
  try {
    await appendDecisions(scored);
  } catch (err) {
    if (err instanceof JobAborted) throw err;
    job.fail("jev", stageErrorText(err), scoredCount);
    status.state = "error";
    job.skipRest();
    return;
  }
  job.done("jev", scoredCount, rejectedCount > 0 ? jevRejectedText(rejectedCount) : undefined);

  // decide() over ALL decisions from the CURRENT thresholds (D16): never cached.
  const thresholds = thresholdsFrom(settings);
  const routes = new Map<string, Decision>();
  for (const [id, record] of decisions) routes.set(id, decide({ id }, record.jev, thresholds));
  const isActionable = (id: string): boolean => {
    const r = routes.get(id);
    return r !== undefined && r.actionable && !r.quarantined;
  };

  // ---- extract: actionable decisions whose extraction is missing or pending, pending first.
  job.begin("extract");
  let extracted = 0;
  let stillPending = 0;
  const sheetRetries: SheetRetry[] = [];
  try {
    const extractor: Extractor = resolveSeam(deps.extractor, settings);
    const work = [...decisions.values()].filter(
      (d) =>
        messages.has(d.id) &&
        isActionable(d.id) &&
        (d.extraction === undefined || d.extraction.status === "pending"),
    );
    const pending = work.filter((d) => d.extraction?.status === "pending");
    const missing = work.filter((d) => d.extraction === undefined);
    // Pending rows whose message is not cached (private/cache deleted, §3.4): their original_text
    // is the input. Never one with an active Quarantine row. A sheet read failure only skips this
    // part; the sheets stage reports the failure.
    try {
      const [todoRows, quarantineRows] = [
        await deps.sheets.readRows(TODOS),
        await deps.sheets.readRows(QUARANTINE),
      ];
      const held = new Set(quarantineRows.filter((q) => q.released_at === "").map((q) => q.id));
      for (const row of todoRows) {
        const parsed = parseTodoId(row.id);
        if (!parsed || parsed.n !== 1 || row.extraction_status !== "pending") continue;
        if (decisions.has(parsed.messageId) || held.has(parsed.messageId)) continue;
        sheetRetries.push({ row, messageId: parsed.messageId });
      }
    } catch (err) {
      if (err instanceof JobAborted) throw err;
      log(`[refresh] pending-row retry from the sheet skipped: ${stageErrorText(err)}`);
    }

    const run = async (input: ExtractInput): Promise<ExtractionResult> => {
      try {
        return await extractor.extract(input, { signal: job.signal });
      } catch (err) {
        return { status: "pending", actions: [], error: stageErrorText(err) };
      }
    };
    const extractCached = async (d: DecisionRecord): Promise<void> => {
      // Re-checked at the call site: only an actionable (never quarantined) message is extracted.
      if (!isActionable(d.id)) return;
      const message = messages.get(d.id) as Message;
      job.guard();
      const result = await run({
        id: message.id,
        source: message.source,
        sender: message.sender,
        context: message.context,
        text: message.text,
      });
      await appendDecisions([{ id: d.id, jev: d.jev, extraction: extractionRecord(result) }]);
      if (result.status === "pending") stillPending++;
      else extracted++;
    };
    for (const d of pending) await extractCached(d);
    for (const retry of sheetRetries) {
      const { row } = retry;
      job.guard();
      retry.result = await run({
        id: retry.messageId,
        source: row.source,
        sender: row.sender,
        context: row.context,
        text: row.original_text,
      });
      if (retry.result.status === "pending") stillPending++;
      else extracted++;
    }
    for (const d of missing) await extractCached(d);
  } catch (err) {
    if (err instanceof JobAborted) throw err;
    job.fail("extract", stageErrorText(err), extracted);
    status.state = "error";
    job.skipRest();
    return;
  }
  job.done(
    "extract",
    extracted,
    stillPending > 0 ? extractionPendingText(stillPending) : undefined,
  );

  // ---- sheets: upsert every decision without sheetSyncedAt; release rows no longer quarantined.
  job.begin("sheets");
  let upserted = 0;
  try {
    const nowIso = now().toISOString();
    const existingQuarantine = new Map(
      (await deps.sheets.readRows(QUARANTINE)).map((q) => [q.id, q]),
    );
    const todoRows: Todo[] = [];
    const quarantineRows: QuarantineItem[] = [];
    const synced: DecisionRecord[] = [];
    for (const record of decisions.values()) {
      const decision = routes.get(record.id) as Decision;
      const row = existingQuarantine.get(record.id);
      const held = row !== undefined && row.released_at === "";
      if (!decision.quarantined && held) {
        quarantineRows.push({ ...row, released_at: nowIso }); // released (D16): row kept
      }
      const message = messages.get(record.id);
      if (!message) continue; // rows need the message; the record stays unsynced
      if (decision.quarantined && (record.sheetSyncedAt === undefined || !held)) {
        quarantineRows.push(quarantineRowFor(message, record, decision, nowIso));
      }
      if (record.sheetSyncedAt !== undefined) continue;
      if (decision.actionable) {
        if (!record.extraction) continue; // not extracted yet: written by a later run
        todoRows.push(...todoRowsFor(message, record, nowIso));
      }
      synced.push(record);
    }
    for (const retry of sheetRetries) todoRows.push(...sheetRetryRows(retry, nowIso));

    job.guard();
    if (todoRows.length > 0) await deps.sheets.upsertRows(TODOS, todoRows);
    job.guard();
    if (quarantineRows.length > 0) await deps.sheets.upsertRows(QUARANTINE, quarantineRows);
    upserted = todoRows.length + quarantineRows.length;
    // sheetSyncedAt is recorded only after a successful upsert (§4).
    await appendDecisions(synced.map((r) => ({ ...r, sheetSyncedAt: nowIso })));
  } catch (err) {
    if (err instanceof JobAborted) throw err;
    job.fail("sheets", stageErrorText(err));
    status.state = "error";
    return;
  }
  job.done("sheets", upserted);

  // ---- cursors: only after the sheet write; a failed source keeps its previous cursor.
  try {
    job.guard();
    await writeState(paths, next);
  } catch (err) {
    if (err instanceof JobAborted) throw err;
    status.error = stageErrorText(err);
    status.state = "error";
    return;
  }
  job.guard();
  status.state = partial ? "partial" : "done";
}

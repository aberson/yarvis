// The in-process refresh job runner behind POST /api/refresh and GET /api/refresh/status (plan §4,
// §6, D13, D19). One job at a time ACROSS processes: start() takes private/refresh.lock before
// answering, so a job running here or in another process (e.g. `yarvis refresh`) is a 409. The
// job itself is `runRefresh` (the same entry point the CLI and the integration tests call). Each
// finished job logs one summary line: states and counts only, never message content or error text.
import { REFRESH_STAGES, type RefreshStatus } from "@yarvis/shared";
import {
  acquireLock,
  LockHeldError,
  type LockHandle,
  type LockOptions,
  type LockRecord,
} from "../lock.js";
import { stageErrorText } from "./errors.js";
import { cloneStatus, idleStatus, refreshJobId, runRefresh, type RefreshDeps } from "./refresh.js";

export type StartResult = { started: true; jobId: string } | { started: false };

/** e.g. `[refresh] job-2026-10-19T18:02:11Z partial whatsapp=error gmail=done(3) ... 1.2s`. */
export function formatJobSummary(jobId: string, status: RefreshStatus, durationMs: number): string {
  const stages = REFRESH_STAGES.map((name) => {
    const s = status.stages[name];
    return s.state === "done" ? `${name}=done(${s.count})` : `${name}=${s.state}`;
  });
  const seconds = (Math.max(0, durationMs) / 1000).toFixed(1);
  return `[refresh] ${jobId} ${status.state} ${stages.join(" ")} ${seconds}s`;
}

export interface RefreshRunnerOptions {
  /** Job summary sink; default stdout, silent under Vitest (like the access log). */
  log?: ((line: string) => void) | false;
  /** Lock options for every acquisition (tests inject a failing unlink). */
  lock?: Pick<LockOptions, "unlink">;
}

const isTerminal = (s: RefreshStatus): boolean =>
  s.state === "done" || s.state === "partial" || s.state === "error";

export class RefreshRunner {
  private current: RefreshStatus = idleStatus();
  private job: Promise<RefreshStatus> | null = null;
  private starting = false;
  /** Increments per job, so a late status callback can never overwrite a newer job's status. */
  private generation = 0;
  private readonly finishedListeners: Array<(status: RefreshStatus) => void> = [];
  private readonly log: ((line: string) => void) | false;
  private readonly lockOptions: Pick<LockOptions, "unlink">;
  /** A lock this process failed to release: reclaimed by the next start() (same pid + token). */
  private leftover: LockRecord | null = null;

  constructor(
    private readonly deps: RefreshDeps,
    opts: RefreshRunnerOptions = {},
  ) {
    this.log = opts.log ?? (process.env.VITEST ? false : (line: string) => console.log(line));
    this.lockOptions = opts.lock ?? {};
  }

  /** A snapshot of the latest job's status (`idle` before the first job). */
  status(): RefreshStatus {
    return cloneStatus(this.current);
  }

  /** The running job's completion (lock released), or null when no job is running. */
  get running(): Promise<RefreshStatus> | null {
    return this.job;
  }

  /**
   * Called when a job's terminal status (done, partial or error) is first published, and again when
   * the job has released the lock (e.g. to invalidate read caches before a poll sees the status).
   */
  onFinished(listener: (status: RefreshStatus) => void): void {
    this.finishedListeners.push(listener);
  }

  private notifyFinished(status: RefreshStatus): void {
    for (const listener of this.finishedListeners) {
      try {
        listener(cloneStatus(status));
      } catch {
        // a listener failure must not wedge the runner
      }
    }
  }

  /** Starts a job unless one is running in this or any other process (refresh.lock held). */
  async start(): Promise<StartResult> {
    if (this.job || this.starting) return { started: false };
    this.starting = true;
    let lock: LockHandle;
    try {
      lock = await acquireLock(this.deps.paths.lockFile, {
        ...this.lockOptions,
        ownLeftover: this.leftover,
      });
      this.leftover = null;
    } catch (err) {
      if (err instanceof LockHeldError) return { started: false };
      throw err;
    } finally {
      this.starting = false;
    }
    let job: Promise<RefreshStatus>;
    let jobId: string;
    let startedMs: number;
    try {
      const now = this.deps.now ?? (() => new Date());
      const startedAt = now();
      startedMs = startedAt.getTime();
      jobId = refreshJobId(startedAt);
      this.current = { ...idleStatus(), state: "running", startedAt: startedAt.toISOString() };
      const generation = ++this.generation;
      let published = false;
      job = runRefresh(this.deps, {
        lock,
        onStatus: (s) => {
          if (this.generation !== generation) return;
          if (isTerminal(s) && !published) {
            // Drop read caches BEFORE a poll can see the terminal status and re-read.
            published = true;
            this.notifyFinished(s);
          }
          this.current = s;
        },
        onLockLeftover: (record) => {
          this.leftover = record;
        },
      }).catch((err: unknown): RefreshStatus => {
        // runRefresh resolves for every stage failure; reaching here is a pipeline defect.
        return { ...this.current, state: "error", error: stageErrorText(err) };
      });
    } catch (err) {
      // Nothing started: never leave the lock behind.
      await lock.release().catch(() => undefined);
      throw err;
    }
    this.job = job;
    void job.then((final) => {
      this.current = final;
      this.job = null;
      if (this.log) {
        try {
          const endMs = final.finishedAt ? Date.parse(final.finishedAt) : startedMs;
          this.log(formatJobSummary(jobId, final, endMs - startedMs));
        } catch {
          // a failing log sink (e.g. EPIPE) must not skip the listeners below
        }
      }
      this.notifyFinished(final);
    });
    return { started: true, jobId };
  }
}

// Cross-process refresh lock (plan §5, D19): `private/refresh.lock` holds `{pid, startedAt, token}`.
// A live holder makes a second acquirer refuse with `LockHeldError` ("refresh already running"); a
// lock is stale (reclaimed) when its pid is dead OR it is older than LOCK_STALE_AFTER_MS: the 15 min
// job ceiling plus the 2 min abandon grace plus a small margin (§5, D19, D20; the age rule also frees
// a lock whose dead holder's pid was reused). `release()` removes the file only while it still
// holds THIS acquisition's record, retrying transient Windows unlink failures; a lock this process
// failed to release can be reclaimed by this same process (`ownLeftover`). `runRefresh` (Step 6),
// `wa:link` and `wa:chats` acquire it. Contended retries back off briefly (well under a second).
//
// Atomicity:
// - Claim: the record is written to a unique temp file in the same directory, then hard-linked onto
//   the lock path (`link` fails EEXIST when it exists), so the lock never exists empty or partial.
// - An empty/unparseable lock (written by something else) is HELD while younger than
//   EMPTY_LOCK_GRACE_MS, then stale.
// - Reclaim is serialized by a second exclusive guard file (`<lock>.reclaim`). Under the guard the
//   lock is re-read and re-judged, atomically renamed to a unique tombstone, and the tombstone is
//   verified to be the record judged stale before it is deleted; otherwise it is restored and the
//   acquirer refuses.
import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** The refresh job ceiling (§4, D20): a job running this long ends `error` with "stage timeout". */
export const JOB_CEILING_MS = 15 * 60_000;

/**
 * After the ceiling, a job keeps the lock up to this long while its abandoned stage settles (an
 * in-flight call finishes within its own timeout), so no new job overlaps it.
 */
export const ABANDON_GRACE_MS = 2 * 60_000;

/** Covers the few ms between taking the lock and arming the job ceiling timer. */
const STALE_MARGIN_MS = 5_000;

/**
 * A lock older than the job ceiling plus the abandon grace (plus a margin) is stale even if its pid
 * is alive (D19), so a lock is never reclaimed while its job may still hold it legitimately (just
 * over 17 min). Accepted risk: a wa:link waiting longer than that on a QR scan can be taken over.
 */
export const LOCK_STALE_AFTER_MS = JOB_CEILING_MS + ABANDON_GRACE_MS + STALE_MARGIN_MS;

/** release(): unlink attempts on a transient Windows error (EPERM/EBUSY/EACCES), backoff 25 ms x2. */
export const RELEASE_ATTEMPTS = 5;
const RELEASE_BACKOFF_MS = 25;
const TRANSIENT_UNLINK = new Set(["EPERM", "EBUSY", "EACCES"]);

/** An empty or unparseable lock younger than this is treated as held (a writer may be mid-way). */
export const EMPTY_LOCK_GRACE_MS = 5_000;

export interface LockRecord {
  pid: number;
  /** ISO 8601 UTC. */
  startedAt: string;
  /** Unique per acquisition, so release never matches another acquisition's identical pid/time. */
  token: string;
}

/** The lock is held by a live process. The message is the CLI's exit text (§5). */
export class LockHeldError extends Error {
  constructor(
    readonly file: string,
    readonly holder: LockRecord | null,
  ) {
    super("refresh already running");
    this.name = "LockHeldError";
  }
}

export interface LockHandle {
  readonly file: string;
  readonly record: LockRecord;
  /**
   * Removes the lock file if it still holds this acquisition's record; otherwise a no-op. A
   * transient unlink failure is retried RELEASE_ATTEMPTS times, then rethrown.
   */
  release(): Promise<void>;
}

export interface LockOptions {
  /** Defaults to `process.pid`. */
  pid?: number;
  now?: () => Date;
  /**
   * A record THIS process acquired but failed to release (its pid is alive, so it would otherwise
   * be held until the age rule frees it). A lock holding exactly this record (same pid, same token)
   * is reclaimed through the guarded tombstone path.
   */
  ownLeftover?: LockRecord | null;
  /** The unlink used by release() (injectable so tests can simulate a Windows EPERM). */
  unlink?: (file: string) => Promise<void>;
}

/** True when a process with this pid exists (EPERM means it exists but is not ours to signal). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

function ignoreEnoent(err: unknown): void {
  if (errCode(err) !== "ENOENT") throw err;
}

const noop = (): void => undefined;
const uniqueSuffix = (): string => randomBytes(8).toString("hex");

function parseRecord(text: string): LockRecord | null {
  try {
    const raw = JSON.parse(text) as Partial<LockRecord> | null;
    if (
      raw &&
      typeof raw.pid === "number" &&
      Number.isInteger(raw.pid) &&
      typeof raw.startedAt === "string" &&
      !Number.isNaN(Date.parse(raw.startedAt)) &&
      typeof raw.token === "string"
    ) {
      return { pid: raw.pid, startedAt: raw.startedAt, token: raw.token };
    }
  } catch {
    // fall through: an unparseable lock has no identifiable holder
  }
  return null;
}

interface Observed {
  text: string;
  record: LockRecord | null;
  mtimeMs: number;
}

async function observe(file: string): Promise<Observed | null> {
  try {
    const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    return { text, record: parseRecord(text), mtimeMs: info.mtimeMs };
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw err;
  }
}

/**
 * Stale when the holder pid is dead, the lock is past LOCK_STALE_AFTER_MS, or it is this process's
 * own unreleased leftover; unparseable past grace.
 */
function isStale(lock: Observed, nowMs: number, own?: LockRecord | null): boolean {
  if (lock.record) {
    if (own && lock.record.pid === own.pid && lock.record.token === own.token) return true;
    if (nowMs - Date.parse(lock.record.startedAt) > LOCK_STALE_AFTER_MS) return true;
    return !isPidAlive(lock.record.pid);
  }
  return nowMs - lock.mtimeMs > EMPTY_LOCK_GRACE_MS;
}

/** Atomically creates `target` with `body` (temp file + exclusive hard link). False on EEXIST. */
async function claimExclusive(target: string, body: string): Promise<boolean> {
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${uniqueSuffix()}.tmp`,
  );
  await writeFile(temp, body, { encoding: "utf8", flag: "wx" });
  try {
    await link(temp, target);
    return true;
  } catch (err) {
    if (errCode(err) === "EEXIST") return false;
    throw err;
  } finally {
    await unlink(temp).catch(ignoreEnoent);
  }
}

function newRecord(opts: LockOptions): LockRecord {
  const now = opts.now ?? (() => new Date());
  return { pid: opts.pid ?? process.pid, startedAt: now().toISOString(), token: uniqueSuffix() };
}

/**
 * Removes a stale lock under the `<lock>.reclaim` guard. Returns normally when the caller should
 * retry the claim; throws LockHeldError when the lock turns out to be live.
 */
async function reclaim(file: string, opts: LockOptions): Promise<void> {
  const guardFile = `${file}.reclaim`;
  const guardBody = JSON.stringify(newRecord(opts));
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  if (!(await claimExclusive(guardFile, guardBody))) {
    // Another reclaim is running, or one crashed: clear a dead or over-age guard, then retry.
    const guard = await observe(guardFile);
    const age = guard ? nowMs - guard.mtimeMs : 0;
    if (guard && (isStale(guard, nowMs) || age > EMPTY_LOCK_GRACE_MS)) {
      await unlink(guardFile).catch(ignoreEnoent);
    }
    return;
  }
  try {
    // Under the guard no other reclaimer can move the lock, and a dead holder cannot release it,
    // so a stale lock observed here is the one renamed below.
    const lock = await observe(file);
    if (!lock) return;
    if (!isStale(lock, nowMs, ownLeftover(opts))) throw new LockHeldError(file, lock.record);
    const tomb = `${file}.${uniqueSuffix()}.stale`;
    try {
      await rename(file, tomb);
    } catch (err) {
      if (["ENOENT", "EPERM", "EBUSY", "EACCES"].includes(errCode(err) ?? "")) return;
      throw err;
    }
    const moved = await readFile(tomb, "utf8");
    if (moved !== lock.text) {
      // Not the record judged stale: put it back (only if the path is still free) and refuse.
      await link(tomb, file).catch(noop);
      await unlink(tomb).catch(ignoreEnoent);
      throw new LockHeldError(file, parseRecord(moved));
    }
    await unlink(tomb).catch(ignoreEnoent);
  } finally {
    const current = await readFile(guardFile, "utf8").catch(() => null);
    if (current === guardBody) await unlink(guardFile).catch(ignoreEnoent);
  }
}

/** The leftover only counts when it was written by this very process. */
function ownLeftover(opts: LockOptions): LockRecord | null {
  const own = opts.ownLeftover;
  return own && own.pid === (opts.pid ?? process.pid) ? own : null;
}

/** Claim attempts; between them a 25-50 ms jittered pause (at most ~350 ms in total). */
const MAX_ATTEMPTS = 8;
const backoff = (): Promise<void> => sleep(25 + Math.floor(Math.random() * 26));

export async function acquireLock(file: string, opts: LockOptions = {}): Promise<LockHandle> {
  const record = newRecord(opts);
  const body = JSON.stringify(record);
  await mkdir(path.dirname(file), { recursive: true });

  for (let attempt = 1; ; attempt++) {
    if (await claimExclusive(file, body)) {
      return {
        file,
        record,
        release: async () => {
          const remove = opts.unlink ?? unlink;
          for (let attempt = 1; ; attempt++) {
            const current = await readFile(file, "utf8").catch(() => null);
            if (current !== body) return;
            try {
              await remove(file);
              return;
            } catch (err) {
              const code = errCode(err) ?? "";
              if (code === "ENOENT") return;
              if (!TRANSIENT_UNLINK.has(code) || attempt >= RELEASE_ATTEMPTS) throw err;
              await sleep(RELEASE_BACKOFF_MS * 2 ** (attempt - 1));
            }
          }
        },
      };
    }
    const holder = await observe(file);
    if (attempt >= MAX_ATTEMPTS) throw new LockHeldError(file, holder?.record ?? null);
    if (holder) {
      const nowMs = (opts.now ?? (() => new Date()))().getTime();
      if (!isStale(holder, nowMs, ownLeftover(opts))) {
        throw new LockHeldError(file, holder.record);
      }
      // Stale: reclaim it, or (another process holds the reclaim guard) let that reclaim finish.
      await reclaim(file, opts);
    }
    await backoff();
  }
}

/** Runs `fn` while holding the lock; always releases. */
export async function withLock<T>(
  file: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  const handle = await acquireLock(file, opts);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}

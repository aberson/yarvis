// Temp-file + rename writer for small JSON state files (settings.json now, state.json later; plan §3.3).
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** The fs subset used, injectable so tests can observe the temp-then-rename sequence. */
export interface AtomicFs {
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
  writeFile(file: string, data: string, encoding: "utf8"): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(file: string, opts: { force: true }): Promise<void>;
}

/**
 * On Windows, renaming over a file another handle has open (e.g. a concurrent GET reading
 * settings.json) fails transiently with EPERM/EBUSY/EACCES. Retry a few times with exponential
 * backoff (20, 40, 80, 160 ms; ~300 ms worst case) before giving up.
 */
export const RENAME_RETRY = { attempts: 5, baseDelayMs: 20 } as const;
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function isTransientRenameError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && TRANSIENT_RENAME_CODES.has(code);
}

async function renameWithRetry(fsImpl: AtomicFs, from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fsImpl.rename(from, to);
      return;
    } catch (err) {
      if (attempt >= RENAME_RETRY.attempts || !isTransientRenameError(err)) throw err;
      await delay(RENAME_RETRY.baseDelayMs * 2 ** (attempt - 1));
    }
  }
}

export async function writeFileAtomic(
  file: string,
  data: string,
  fsImpl: AtomicFs = fs,
): Promise<void> {
  const dir = path.dirname(file);
  await fsImpl.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    await fsImpl.writeFile(tmp, data, "utf8");
    await renameWithRetry(fsImpl, tmp, file);
  } catch (err) {
    // Best-effort cleanup; never let a cleanup failure mask the original error.
    await fsImpl.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function writeJsonAtomic(
  file: string,
  value: unknown,
  fsImpl: AtomicFs = fs,
): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, fsImpl);
}

// Observable behavior of the temp-file + rename writer: final content, no leftover temp files,
// previous content survives a failed write, and the bounded Windows rename retry.
import fs from "node:fs/promises";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { RENAME_RETRY, writeJsonAtomic, type AtomicFs } from "../src/util/atomic-write.js";
import { tempPaths } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const OLD = { old: true };

/** A temp private dir whose settings.json already holds OLD. */
function seeded() {
  const { paths, cleanup } = tempPaths();
  cleanups.push(cleanup);
  writeFileSync(paths.settingsFile, JSON.stringify(OLD));
  return paths;
}

const readTarget = (file: string): unknown => JSON.parse(readFileSync(file, "utf8")) as unknown;
const errno = (code: string) => Object.assign(new Error(code), { code });

/** Real fs, except rename throws the queued errors before delegating (a Windows reader holding the file). */
function failingRename(failures: Error[]): { fsImpl: AtomicFs; renameCalls: () => number } {
  let calls = 0;
  const fsImpl: AtomicFs = {
    mkdir: (d, o) => fs.mkdir(d, o),
    writeFile: (f, d, e) => fs.writeFile(f, d, e),
    rename: async (a, b) => {
      calls++;
      const err = failures.shift();
      if (err) throw err;
      await fs.rename(a, b);
    },
    rm: (f, o) => fs.rm(f, o),
  };
  return { fsImpl, renameCalls: () => calls };
}

describe("writeJsonAtomic", () => {
  it("replaces the target's content and leaves no temp files behind", async () => {
    const paths = seeded();
    await writeJsonAtomic(paths.settingsFile, { a: 1 });
    expect(readTarget(paths.settingsFile)).toEqual({ a: 1 });
    expect(readdirSync(paths.privateDir)).toEqual(["settings.json"]);
  });

  it("a failing write leaves the previous content intact and no temp files", async () => {
    const paths = seeded();
    const { fsImpl } = failingRename([errno("ENOENT")]);
    await expect(writeJsonAtomic(paths.settingsFile, { a: 2 }, fsImpl)).rejects.toThrow("ENOENT");
    expect(readTarget(paths.settingsFile)).toEqual(OLD);
    expect(readdirSync(paths.privateDir)).toEqual(["settings.json"]);
  });

  it("retries a transient EPERM/EBUSY rename and then succeeds", async () => {
    const paths = seeded();
    const { fsImpl } = failingRename([errno("EPERM"), errno("EBUSY")]);
    await writeJsonAtomic(paths.settingsFile, { a: 3 }, fsImpl);
    expect(readTarget(paths.settingsFile)).toEqual({ a: 3 });
    expect(readdirSync(paths.privateDir)).toEqual(["settings.json"]);
  });

  it("gives up after the bounded attempts with the original error, previous content intact", async () => {
    const paths = seeded();
    const errors = Array.from({ length: RENAME_RETRY.attempts + 5 }, () => errno("EPERM"));
    const { fsImpl, renameCalls } = failingRename([...errors]);
    const outcome = writeJsonAtomic(paths.settingsFile, { a: 4 }, fsImpl);
    await expect(outcome).rejects.toBe(errors[RENAME_RETRY.attempts - 1]);
    expect(renameCalls()).toBe(RENAME_RETRY.attempts);
    expect(readTarget(paths.settingsFile)).toEqual(OLD);
    expect(readdirSync(paths.privateDir)).toEqual(["settings.json"]);
  });

  it("does not retry a non-transient rename error", async () => {
    const paths = seeded();
    const { fsImpl, renameCalls } = failingRename([errno("ENOENT"), errno("ENOENT")]);
    await expect(writeJsonAtomic(paths.settingsFile, { a: 5 }, fsImpl)).rejects.toThrow("ENOENT");
    expect(renameCalls()).toBe(1);
  });
});

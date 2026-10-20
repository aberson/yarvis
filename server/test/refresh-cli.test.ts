// `yarvis refresh` through the production CLI entry (runCli, and the real `tsx server/src/cli.ts`
// process in fake mode), plan §5, D19.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli.js";
import { REPO_ROOT } from "../src/config/paths.js";
import { DisconnectReason } from "../src/connectors/whatsapp.js";
import { createFakeSheets } from "../src/fakes/sheets.js";
import { acquireLock } from "../src/lock.js";
import { createFakeSeams } from "../src/pipeline/seams.js";
import type { FakeWhatsAppOptions } from "../src/fakes/whatsapp.js";
import { tempPaths } from "./helpers.js";

function capture(): CliIo & { out_: string[]; err_: string[] } {
  const out_: string[] = [];
  const err_: string[] = [];
  return { out_, err_, out: (l) => out_.push(l), err: (l) => err_.push(l) };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function setup(whatsapp?: FakeWhatsAppOptions) {
  const t = tempPaths({ seedSettings: true });
  cleanups.push(t.cleanup);
  const sheets = createFakeSheets();
  const seams = createFakeSeams({
    sheets: sheets.store,
    whatsapp,
    waWindow: { quietMs: 20, maxMs: 2_000 },
  });
  return { paths: t.paths, sheets, seams, io: capture() };
}

describe("yarvis refresh (runCli)", () => {
  it("prints one line per stage and exits 1 on a partial job", async () => {
    const { paths, seams, io } = setup({ scripts: [[{ close: DisconnectReason.loggedOut }]] });
    expect(await runCli(["refresh"], io, { paths, seams })).toBe(1);
    expect(io.out_.map((l) => l.replace(/\(\d+\)/, "(n)"))).toEqual([
      "whatsapp: error (n) - relink required (run yarvis wa:link --reset)",
      "gmail: done (n)",
      "jev: done (n)",
      "extract: done (n)",
      "sheets: done (n)",
      "refresh partial",
    ]);
  });

  it("exits 1 with 'refresh already running' and writes nothing while the lock is held", async () => {
    const { paths, sheets, seams, io } = setup();
    const lock = await acquireLock(paths.lockFile);
    try {
      expect(await runCli(["refresh"], io, { paths, seams })).toBe(1);
      expect(io.err_).toEqual(["yarvis refresh: refresh already running"]);
      expect(sheets.api.calls).toEqual([]);
      expect(existsSync(paths.cacheDir)).toBe(false);
    } finally {
      await lock.release();
    }
  });
});

describe("yarvis refresh (real entry point, YARVIS_FAKE=1)", () => {
  it("wires all five fakes and exits 0 when every stage is done", () => {
    const { paths } = setup();
    const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
    const res = spawnSync(
      process.execPath,
      [tsxCli, path.join(REPO_ROOT, "server", "src", "cli.ts"), "refresh"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, YARVIS_FAKE: "1", YARVIS_PRIVATE_DIR: paths.privateDir },
        timeout: 60_000,
      },
    );
    expect(res.error).toBeUndefined();
    expect(res.stdout.trim().split(/\r?\n/).at(-1)).toBe("refresh done");
    expect(res.status).toBe(0);
    expect(existsSync(paths.stateFile)).toBe(true);
  });
});

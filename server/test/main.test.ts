// Production entry point: startServer's bind address (in-process) and the real
// `tsx server/src/main.ts` process reached end to end through HTTP. Guard and settings behaviour
// is covered by guard.test.ts and settings.test.ts.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT, resolvePaths } from "../src/config/paths.js";
import { decisionsFile, messagesFile } from "../src/pipeline/cache.js";
import { BIND_HOST, startServer, type StartedServer } from "../src/main.js";
import { tempPaths } from "./helpers.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("startServer", () => {
  it("binds 127.0.0.1 on PORT=0", async () => {
    const { paths, cleanup } = tempPaths();
    cleanups.push(cleanup);
    const started: StartedServer = await startServer({
      PORT: "0",
      YARVIS_FAKE: "1",
      YARVIS_PRIVATE_DIR: paths.privateDir,
    });
    cleanups.push(() => started.close());
    const address = started.server.address();
    expect(typeof address === "object" && address?.address).toBe(BIND_HOST);
    expect(started.url).toBe(`http://${BIND_HOST}:${started.port}`);
  });
});

describe("startServer in fake mode", () => {
  // Fake mode's sheet lives in memory, so the default fake private dir (D32) starts each server
  // from the fixture state; an explicit YARVIS_PRIVATE_DIR is never reset.
  it("clears the default fake dir's caches and cursors, and never touches an override dir", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "yarvis-root-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const plant = (dir: string) => {
      const p = resolvePaths({ YARVIS_PRIVATE_DIR: dir }, root);
      mkdirSync(p.cacheDir, { recursive: true });
      for (const f of [messagesFile(p), decisionsFile(p), p.stateFile]) writeFileSync(f, "{}\n");
      return [messagesFile(p), decisionsFile(p), p.stateFile];
    };
    const defaultFake = plant(path.join(root, "private", "fake"));
    const override = plant(path.join(root, "elsewhere"));

    const a = await startServer({ PORT: "0", YARVIS_FAKE: "1" }, root);
    cleanups.push(() => a.close());
    expect(defaultFake.filter((f) => existsSync(f))).toEqual([]);

    const b = await startServer(
      { PORT: "0", YARVIS_FAKE: "1", YARVIS_PRIVATE_DIR: path.join(root, "elsewhere") },
      root,
    );
    cleanups.push(() => b.close());
    expect(override.filter((f) => existsSync(f))).toEqual(override);
  });
});

describe("main.ts process", () => {
  it("starts from the real entry point and logs its bound URL", async () => {
    const { paths, cleanup } = tempPaths();
    cleanups.push(cleanup);
    // `node --import tsx` keeps it one process, so kill() leaves no orphaned listener on Windows.
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(REPO_ROOT, "server", "src", "main.ts")],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, PORT: "0", YARVIS_FAKE: "1", YARVIS_PRIVATE_DIR: paths.privateDir },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.once("exit", () => resolve());
          child.kill();
        }),
    );

    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error(`no listen line; got: ${out}`)), 30_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
        if (m?.[1]) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.once("exit", (code) => reject(new Error(`exited ${String(code)}: ${out}`)));
    });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const res = await fetch(`${url}/api/health`);
    expect(await res.json()).toEqual({ ok: true, fake: true });
  });
});

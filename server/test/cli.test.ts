// `yarvis` verb dispatcher (plan §5): in-process runCli plus the real entry point via tsx.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { helpText, runCli, VERBS, type CliIo } from "../src/cli.js";
import { REPO_ROOT } from "../src/config/paths.js";

const EXPECTED_VERBS = ["gmail:auth", "wa:link", "wa:chats", "doctor", "refresh"];

function capture(): CliIo & { out_: string[]; err_: string[] } {
  const out_: string[] = [];
  const err_: string[] = [];
  return { out_, err_, out: (l) => out_.push(l), err: (l) => err_.push(l) };
}

describe("runCli", () => {
  it("declares exactly the plan's verbs", () => {
    expect(VERBS.map((v) => v.name)).toEqual(EXPECTED_VERBS);
  });

  it("--help shows verb arguments and exits 0", async () => {
    const io = capture();
    expect(await runCli(["--help"], io)).toBe(0);
    expect(io.out_.join("\n")).toContain("wa:link [--reset]");
  });

  it("unknown verb exits 2 with usage", async () => {
    const io = capture();
    expect(await runCli(["send-everything"], io)).toBe(2);
    expect(io.err_.join("\n")).toContain('unknown verb "send-everything"');
    expect(io.err_.join("\n")).toContain(helpText().split("\n")[0]);
  });

  it("no verb prints usage to stderr and exits 2", async () => {
    const io = capture();
    expect(await runCli([], io)).toBe(2);
    expect(io.err_.join("\n")).toContain("Usage:");
  });
});

describe("cli entry point (tsx server/src/cli.ts, as `npm run yarvis` runs it)", () => {
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  const cliPath = path.join(REPO_ROOT, "server", "src", "cli.ts");
  const run = (args: string[]) =>
    spawnSync(process.execPath, [tsxCli, cliPath, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, YARVIS_PRIVATE_DIR: path.join(REPO_ROOT, "private", "fake") },
      timeout: 60_000,
    });

  it("--help lists gmail:auth, wa:link, wa:chats, doctor, refresh", () => {
    const res = run(["--help"]);
    expect(res.status).toBe(0);
    for (const verb of EXPECTED_VERBS) expect(res.stdout).toContain(verb);
  });
});

describe("cli entry point exits once the verb returns", () => {
  // A preloaded, never-cleared interval stands in for a library handle that outlives the verb
  // (Baileys' query timer after an unanswered wa:chats group-list query). The stdout variants model
  // a destroyed/wedged stream whose write never calls back, or throws.
  const LINGER = "setInterval(() => {}, 1 << 30);";
  const dir = mkdtempSync(path.join(tmpdir(), "yarvis-linger-"));
  const preload = (name: string, body: string): string => {
    const file = path.join(dir, `${name}.mjs`);
    writeFileSync(file, body);
    return pathToFileURL(file).href;
  };
  const lingering = preload("linger", LINGER);
  const wedged = preload("wedged", `${LINGER} process.stdout.write = () => true;`);
  const throwing = preload(
    "throwing",
    `${LINGER} process.stdout.write = () => { throw new Error("EPIPE (synthetic)"); };`,
  );
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args: string[], preloadUrl: string) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        preloadUrl,
        path.join(REPO_ROOT, "server", "src", "cli.ts"),
        ...args,
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, YARVIS_PRIVATE_DIR: path.join(REPO_ROOT, "private", "fake") },
        timeout: 20_000,
      },
    );

  it("with the returned code and fully flushed output, despite a lingering handle", () => {
    const help = run(["--help"], lingering);
    expect(help.error).toBeUndefined(); // not killed by the spawn timeout
    expect(help.status).toBe(0);
    expect(help.stdout).toBe(`${helpText()}${String.fromCharCode(10)}`);

    const usage = run(["wa:chats", "unexpected"], lingering);
    expect(usage.error).toBeUndefined();
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('unexpected argument "unexpected"');
  });

  it.each([
    ["never calls back", wedged],
    ["throws", throwing],
  ])("with the returned code when a stdout write %s", (_label, url) => {
    const res = run(["no-such-verb"], url); // its output goes to stderr only
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('unknown verb "no-such-verb"');
  });
});

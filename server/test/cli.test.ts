// `yarvis` verb dispatcher (plan §5): in-process runCli plus the real entry point via tsx.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

  it.each(EXPECTED_VERBS)("%s exits non-zero with 'not yet implemented'", async (verb) => {
    const io = capture();
    expect(await runCli([verb], io)).not.toBe(0);
    expect(io.err_.join("\n")).toContain("not yet implemented");
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

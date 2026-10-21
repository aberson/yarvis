// CI workflow (plan Step 8, §11): .github/workflows/ci.yml, parsed as YAML, runs the full declared
// gate on Ubuntu / Node 24, every `npm run <x>` it references is a real root script, and its
// private-folder leak-check step exists ahead of the build and actually fails on each leak shape
// (its script is run with bash against index-only temp repos).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REPO_ROOT } from "../src/config/paths.js";
import { npmScriptsReferenced, rootScripts } from "./helpers.js";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, { "runs-on": string; steps: Step[] }>;
}

const workflow = parse(
  readFileSync(path.join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8"),
) as Workflow;
const jobs = Object.values(workflow.jobs);
const steps = jobs.flatMap((j) => j.steps);
const runs = steps.flatMap((s) => (typeof s.run === "string" ? [s.run.trim()] : []));

/** The leak-check step: the one whose script requires exactly private/README.md under private/. */
const leakIndex = steps.findIndex((s) => s.run?.includes("private/README.md"));
const leakScript = steps[leakIndex]?.run;

/**
 * bash for running the step script. On Windows PATH `bash` is usually WSL's System32 shim, so use
 * Git for Windows' own bash (next to `git --exec-path`); undefined (tests skip) when not found.
 */
function resolveBash(): string | undefined {
  if (process.platform !== "win32") return "bash";
  try {
    const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
    const candidate = path.resolve(execPath, "..", "..", "..", "bin", "bash.exe");
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}
const bash = resolveBash();

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const git = (dir: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", input }).trim();

/**
 * A temp git repo whose INDEX holds `files` (path -> content), written with plumbing so path case
 * survives a case-insensitive filesystem; `gitignore` is written to disk for `ls-files -ci`.
 */
function repoWith(files: Record<string, string>, gitignore = ""): string {
  const dir = mkdtempSync(path.join(tmpdir(), "yarvis-leak-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", dir]);
  if (gitignore) writeFileSync(path.join(dir, ".gitignore"), gitignore);
  for (const [file, content] of Object.entries(files)) {
    const blob = git(dir, ["hash-object", "-w", "--stdin"], content);
    git(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`]);
  }
  return dir;
}

/** Runs the step script in `cwd` (with optional extra env); `out` is stdout + stderr. */
function runLeakCheck(
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): { status: number | null; out: string } {
  const r = spawnSync(bash!, ["-c", leakScript!], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/**
 * This repository's working tree as CI would commit it: tracked + untracked, minus ignored files,
 * staged into a TEMP index (the real index is untouched). `.build-step/` is the build harness's
 * scratch dir in a step worktree; it is never committed.
 */
function workingTreeIndex(): Record<string, string> {
  const dir = mkdtempSync(path.join(tmpdir(), "yarvis-leak-index-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const env = { GIT_INDEX_FILE: path.join(dir, "index") };
  execFileSync("git", ["-C", REPO_ROOT, "add", "-A", "--", ".", ":!.build-step"], {
    env: { ...process.env, ...env },
  });
  return env;
}

const README = { "private/README.md": "# private/\n\n| `.env` | `TYPESAFE_API_KEY=...` |\n" };
// Planted secrets are built by concatenation so this source file never holds one literally.
const KEY = "ts_live_" + "0123456789abcdefWXYZ";
const KEY_NAME = "TYPESAFE_" + "API_KEY";
const PEM_HEADER = "-----BEGIN " + "PRIVATE KEY-----";

const PRIVATE_PATH = "tracked under private/";
const IGNORED = "tracked files that .gitignore excludes";
const VALUE = "API key value in tracked files";
const FIELD = "secret field names in tracked non-code files";
const SHAPE = "key-shaped content in tracked files";

describe(".github/workflows/ci.yml", () => {
  it("runs on push and pull_request, on ubuntu-latest with pinned checkout / setup-node (Node 24, npm cache)", () => {
    expect(Object.keys(workflow.on)).toEqual(expect.arrayContaining(["push", "pull_request"]));
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) expect(job["runs-on"]).toBe("ubuntu-latest");
    const uses = steps.map((s) => s.uses).filter(Boolean);
    expect(uses).toEqual(expect.arrayContaining(["actions/checkout@v4", "actions/setup-node@v4"]));
    const setupNode = steps.find((s) => s.uses === "actions/setup-node@v4");
    expect(setupNode?.with).toMatchObject({ "node-version": 24, cache: "npm" });
  });

  it("every npm script it invokes exists in the root package.json", () => {
    const referenced = npmScriptsReferenced(runs.join("\n"));
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((name) => !(name in rootScripts()))).toEqual([]);
  });

  it("runs the full gate in order, including the Playwright browser install", () => {
    const gate = [
      "npm ci",
      "npx playwright install --with-deps chromium",
      "npm run setup",
      "npm run typecheck",
      "npm run lint",
      "npm run build",
      "npm test",
      "npm run e2e",
      "npm run smoke",
      "npm run smoke:assistant",
    ];
    expect(runs.filter((r) => gate.includes(r))).toEqual(gate);
  });

  it("has the private-folder leak-check step, ahead of npm ci", () => {
    expect(leakScript).toContain("ls-files");
    expect(leakScript).toContain("grep --cached");
    expect(leakIndex).toBeLessThan(steps.findIndex((s) => s.run?.trim() === "npm ci"));
  });

  describe.skipIf(bash === undefined)("private-folder leak-check script", () => {
    it("passes on this repository's working tree (tracked + untracked, staged into a temp index)", () => {
      expect(runLeakCheck(REPO_ROOT, workingTreeIndex())).toEqual({
        status: 0,
        out: "private/ leak check OK\n",
      });
    });

    it("passes on a clean tree whose code, fixtures, docs and placeholders name secret fields", () => {
      const dir = repoWith({
        ...README,
        "README.md": "`private/.env` with an empty `TYPESAFE_API_KEY=` line\n",
        ".github/workflows/x.yml": "env:\n  TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}\n",
        "scripts/run.sh":
          'TYPESAFE_API_KEY="$TYPESAFE_API_KEY" node x.js\nTYPESAFE_API_KEY=<your key>\n',
        "server/src/gmail.ts": "const t = { refresh_token: rec.refresh_token, private_key: k };\n",
        "server/test/h.ts": "return { TYPESAFE_API_KEY: PLANTED, PATH: bin };\n",
        "server/fixtures/gmail-token.json": '{ "refresh_token": "synthetic-refresh-token-0001" }\n',
        "docs/plan.md": 'git grep "typesafe_api_key=|refresh_token|private_key"\n',
        "settings.example.json": '{ "private_key": "<key>" }\n',
      });
      expect(runLeakCheck(dir)).toEqual({ status: 0, out: "private/ leak check OK\n" });
    });

    it.each<[label: string, finding: string, files: Record<string, string>, gitignore?: string]>([
      ["private/README.md not tracked", "private/README.md is not tracked", { "a.ts": "x\n" }],
      ["another file under private/", PRIVATE_PATH, { ...README, "private/settings.json": "{}" }],
      ["a Private/ case variant", PRIVATE_PATH, { ...README, "Private/token.json": "{}" }],
      ["a non-ASCII Private/ path", PRIVATE_PATH, { ...README, "Private/café.json": "{}" }],
      ["an ignored file tracked anyway", IGNORED, { ...README, ".env": "X=1\n" }, ".env\n"],
      ["a value in private/README.md", VALUE, { "private/README.md": `${KEY_NAME}=${KEY}\n` }],
      ["a quoted value", VALUE, { ...README, "deploy/app.env": `${KEY_NAME}="${KEY}"\n` }],
      ["a space-separated value", VALUE, { ...README, "deploy/app.env": `${KEY_NAME} = ${KEY}\n` }],
      ["a YAML key: value", VALUE, { ...README, "c.yml": `${KEY_NAME.toLowerCase()}: "${KEY}"\n` }],
      [
        "a value inside a .ts file",
        VALUE,
        { ...README, "server/src/x.ts": `"${KEY_NAME}=${KEY}"` },
      ],
      [
        "a value inside server/fixtures/",
        VALUE,
        { ...README, "server/fixtures/env.json": `{ "${KEY_NAME}": "${KEY}" }\n` },
      ],
      ["a token field in a JSON file", FIELD, { ...README, "t.json": '{"refresh_token":"r"}' }],
      ["a PEM private key in source", SHAPE, { ...README, "server/src/k.ts": PEM_HEADER }],
      [
        "a service-account JSON in fixtures",
        SHAPE,
        { ...README, "server/fixtures/sa.json": '{ "type": "service_' + 'account" }' },
      ],
      ["a Google API key", SHAPE, { ...README, "a.ts": "AI" + "za" + "A".repeat(35) }],
      ["a Google client secret", SHAPE, { ...README, "a.ts": "GOCSPX" + "-" + "a".repeat(28) }],
      ["a Google refresh token", SHAPE, { ...README, "a.ts": "1/" + "/0" + "a".repeat(40) }],
      ["an Anthropic key", SHAPE, { ...README, "a.ts": "sk-" + "ant-" + "a".repeat(40) }],
    ])("fails on %s with its own finding", (_label, finding, files, gitignore) => {
      const { status, out } = runLeakCheck(repoWith(files, gitignore));
      expect(status).toBe(1);
      expect(out).toContain(`leak check: ${finding}`);
    });
  });
});

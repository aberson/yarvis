// `yarvis doctor` through the production CLI entry (runCli with injected fake seams, and the real
// `tsx server/src/cli.ts doctor` process in fake mode), plan §5, D24.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SEAMS } from "@yarvis/shared";
import type { JevWithModel } from "../src/ai/jev.js";
import { runCli, type CliIo } from "../src/cli.js";
import { REPO_ROOT } from "../src/config/paths.js";
import { loadClaudeSeed } from "../src/fakes/claude.js";
import { FAKE_JEV_MODEL, loadFixtureMessages, loadJevSeed } from "../src/fakes/jev.js";
import {
  CLAUDE_PROBE_NO_ACTIONS,
  CLAUDE_PROBE_PENDING,
  JEV_PROBE_MISMATCH,
} from "../src/pipeline/errors.js";
import { createFakeSeams, type FakeSeamsOptions } from "../src/pipeline/seams.js";
import { writeState } from "../src/pipeline/state.js";
import { PLANTED, plantPrivate, tempPaths } from "./helpers.js";

const fixtures = loadFixtureMessages();
const ACTIONS = loadClaudeSeed()[fixtures.actionable.id];

function capture(): CliIo & { out_: string[]; err_: string[] } {
  const out_: string[] = [];
  const err_: string[] = [];
  return { out_, err_, out: (l) => out_.push(l), err: (l) => err_.push(l) };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const require_ = createRequire(import.meta.url);

function setup(opts: FakeSeamsOptions = {}) {
  const t = tempPaths();
  cleanups.push(t.cleanup);
  const seams = createFakeSeams(opts);
  return { paths: t.paths, seams, io: capture() };
}

describe("yarvis doctor (runCli)", () => {
  it("prints one ok line per seam plus the cursors line against all fakes, exit 0", async () => {
    const { paths, seams, io } = setup();
    const env = plantPrivate(paths);
    await writeState(paths, {
      gmail: { lastRunAt: "2026-10-18T09:00:00.000Z" },
      whatsapp: { lastRunAt: "2026-10-18T09:00:00.000Z", lastMessageTs: 1792314000 },
    });

    expect(await runCli(["doctor"], io, { paths, seams, env })).toBe(0);
    expect(io.out_).toEqual([
      "gmail: ok (readonly scope)",
      "whatsapp: ok (linked creds present)",
      "sheets: ok (tabs Todos, Quarantine)",
      `jev: ok (model ${FAKE_JEV_MODEL})`,
      `claude: ok (parsed ${ACTIONS?.length} actions)`,
      "cursors: gmail.lastRunAt=2026-10-18T09:00:00.000Z whatsapp.lastMessageTs=1792314000",
    ]);
    expect(io.err_).toEqual([]);

    // The probes are the §5 ones: one INBOX list (maxResults 1) and never a messages.get; one Jev
    // call each on the phishing and clean fixtures; one extract on the actionable fixture; no
    // WhatsApp socket; no sheet writes (the seeded tabs already exist).
    expect(seams.fakes.gmail.api.calls).toEqual([
      {
        method: "messages.list",
        params: { userId: "me", q: "", labelIds: ["INBOX"], maxResults: 1 },
      },
    ]);
    expect(seams.jev.calls.map((m) => m.id)).toEqual([fixtures.phishing.id, fixtures.clean.id]);
    expect(seams.extractor.calls.map((c) => c.input.id)).toEqual([fixtures.actionable.id]);
    expect(seams.fakes.whatsapp.sockets).toEqual([]);
    expect(seams.fakes.sheets?.api.writes()).toEqual([]);

    expect([...io.out_, ...io.err_].join("\n")).not.toContain(PLANTED);
  });

  it("prints not configured for every seam against an empty private dir, exit 0, no probes", async () => {
    const { paths, seams, io } = setup();
    expect(await runCli(["doctor"], io, { paths, seams, env: {} })).toBe(0);
    expect(io.out_).toEqual([
      "gmail: not configured",
      "whatsapp: not configured",
      "sheets: not configured",
      "jev: not configured",
      "claude: not configured",
      "cursors: gmail.lastRunAt=none whatsapp.lastMessageTs=none",
    ]);
    expect(seams.fakes.gmail.api.calls).toEqual([]);
    expect(seams.jev.calls).toEqual([]);
    expect(seams.extractor.calls).toEqual([]);
    expect(seams.fakes.sheets?.api.calls).toEqual([]);
  });

  it("a seam that throws prints `error <fixed reason>` and exits 1; the rest still probe", async () => {
    const { paths, seams, io } = setup();
    const env = plantPrivate(paths);
    seams.jev.setOutage(`outage while holding ${PLANTED}`);

    expect(await runCli(["doctor"], io, { paths, seams, env })).toBe(1);
    expect(io.out_).toContain("jev: error jev unavailable (HTTP 503)");
    expect(io.out_.filter((l) => l.includes(": ok ("))).toHaveLength(4);
    expect(io.out_.join("\n")).not.toContain(PLANTED);
  });

  it("refuses a token whose recorded scope is not read-only before any Gmail call", async () => {
    const { paths, seams, io } = setup();
    const env = plantPrivate(paths, "gmail-token-extra-scope.json");

    expect(await runCli(["doctor"], io, { paths, seams, env })).toBe(1);
    expect(io.out_[0]).toBe(
      "gmail: error gmail token refused: not read-only (run yarvis gmail:auth)",
    );
    expect(seams.fakes.gmail.api.calls).toEqual([]);
    expect(io.out_.join("\n")).not.toContain(PLANTED);
  });

  it.each([
    [
      "phishing fixture below thresholds.quarantine",
      "phishing",
      { phishing: 0.49, malicious: 0, spam: 0 },
    ],
    // decide() quarantines on ANY security score, so a clean fixture flagged malicious is a mismatch.
    ["clean fixture flagged malicious", "clean", { phishing: 0.01, malicious: 0.9, spam: 0 }],
  ] as const)("jev scores off (%s) is an error, not ok", async (_label, role, scores) => {
    const seed = { ...loadJevSeed(), [fixtures[role].id]: { ...scores, action: 0 } };
    const { paths, seams, io } = setup({ jevSeed: seed });
    const env = plantPrivate(paths);

    expect(await runCli(["doctor"], io, { paths, seams, env })).toBe(1);
    expect(io.out_).toContain(`jev: error ${JEV_PROBE_MISMATCH}`);
  });

  it.each([
    ["model id", "jev-2026-10-01", "jev-2026-10-01"],
    ["no echoed id", undefined, "unreported"],
    ["key-shaped id", `sk-ant-${PLANTED}`, "unrecognized id"],
    ["long unbroken token", "A1b2C3d4E5f6G7h8I9j0K1l2M3", "unrecognized id"],
    ["path-like id", String.raw`C:\keys\jev`, "unrecognized id"],
    ["id with a slash", "models/jev", "unrecognized id"],
    ["id with spaces", "jev latest", "unrecognized id"],
  ])(
    "prints the echoed jev model only when it is a plain id (%s)",
    async (_label, model, shown) => {
      const { paths, seams, io } = setup();
      const env = plantPrivate(paths);
      const echoing: JevWithModel = {
        classify: (m) => seams.jev.classify(m),
        classifyWithModel: async (m) => ({
          scores: await seams.jev.classify(m),
          ...(model === undefined ? {} : { model }),
        }),
      };

      expect(await runCli(["doctor"], io, { paths, seams: { ...seams, jev: echoing }, env })).toBe(
        0,
      );
      expect(io.out_).toContain(`jev: ok (model ${shown})`);
      expect(io.out_.join("\n")).not.toContain(PLANTED);
    },
  );

  it.each([
    ["a failed extraction (pending)", "fail" as const, CLAUDE_PROBE_PENDING],
    ["0 actions (none)", [] as string[], CLAUDE_PROBE_NO_ACTIONS],
  ])("claude with %s is an error, not ok", async (_label, answer, reason) => {
    const { paths, seams, io } = setup({ claudeSeed: { [fixtures.actionable.id]: answer } });
    const env = plantPrivate(paths);

    expect(await runCli(["doctor"], io, { paths, seams, env })).toBe(1);
    expect(io.out_).toContain(`claude: error ${reason}`);
  });

  it("invalid settings: doctor still probes, and jev/claude print the fixed settings error", async () => {
    const { paths, seams, io } = setup();
    const env = plantPrivate(paths);
    writeFileSync(paths.settingsFile, `{"sheetId": "${PLANTED}",`);

    expect(await runCli(["doctor"], io, { paths, seams, env })).toBe(1);
    expect(io.out_).toEqual([
      "gmail: ok (readonly scope)",
      "whatsapp: ok (linked creds present)",
      "sheets: ok (tabs Todos, Quarantine)",
      "jev: error settings invalid (check settings.json)",
      "claude: error settings invalid (check settings.json)",
      "cursors: gmail.lastRunAt=none whatsapp.lastMessageTs=none",
    ]);
    expect(seams.jev.calls).toEqual([]);
    expect(seams.extractor.calls).toEqual([]);
    const all = io.out_.join("\n");
    expect(all).not.toContain(PLANTED);
    expect(all).not.toContain(paths.privateDir);
  });

  it("a corrupt state.json makes the cursors line an error, never echoing the file", async () => {
    const { paths, seams, io } = setup();
    writeFileSync(paths.stateFile, `{"gmail": "${PLANTED}"}`);

    expect(await runCli(["doctor"], io, { paths, seams, env: {} })).toBe(1);
    expect(io.out_.at(-1)).toBe(
      "cursors: error cursor file corrupt (delete state.json to re-fetch)",
    );
    expect(io.out_.join("\n")).not.toContain(PLANTED);
  });
});

describe("doctor entry point (tsx server/src/cli.ts doctor, fake mode)", () => {
  it("wires all five fakes by default and exits 0", () => {
    const t = tempPaths();
    cleanups.push(t.cleanup);
    const tsxCli = require_.resolve("tsx/cli");
    const res = spawnSync(
      process.execPath,
      [tsxCli, path.join(REPO_ROOT, "server", "src", "cli.ts"), "doctor"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, YARVIS_FAKE: "1", YARVIS_PRIVATE_DIR: t.paths.privateDir },
        timeout: 60_000,
      },
    );
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    // The exact lines are asserted through runCli above; here: the default (fake) wiring probes
    // every seam ok and the cursors line closes the report.
    const lines = res.stdout.trim().split(/\r?\n/);
    expect(lines.slice(0, -1).map((l) => l.slice(0, l.indexOf(":")))).toEqual([...SEAMS]);
    expect(lines.slice(0, -1).every((l) => l.includes(": ok ("))).toBe(true);
    expect(lines.at(-1)).toMatch(/^cursors: /);
  });
});

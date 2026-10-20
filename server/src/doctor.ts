// `yarvis doctor` (plan §5, D24): one live probe per CONFIGURED seam, one line per seam
//   `<seam>: ok (<detail>)` | `<seam>: not configured` | `<seam>: error <reason>`
// then a final `cursors:` line (state.json's gmail.lastRunAt and whatsapp.lastMessageTs). Exit 1
// only when a line is `error`; `not configured` is not a failure.
//
// Status only, never a value from private/: details are constants, counts or the model id the Jev
// API echoed; every error reason is a fixed phrase from pipeline/errors.ts (raw library text can echo
// a request, a response or a credential). `configured` is the same files/env check GET /api/status
// uses (pipeline/configured.ts).
//
// Probes: gmail = token present + recorded-scope check + ONE messages.list (maxResults 1); sheets =
// ensureTab on both tabs; jev = one call each on the Step 3 phishing and clean fixtures; claude = one
// single-shot extract on the actionable fixture through the ai/extract.ts seam (never --bare);
// whatsapp = private/wa-auth/ creds present (no socket). Nothing is ever sent to Gmail or WhatsApp.
//
// Holds NO private/refresh.lock: no probe touches the caches or state.json (cursors are only read),
// and the one write-capable call, sheets ensureTab, is idempotent and is what every refresh runs
// first, so it is safe beside a running refresh.
import { SEAMS, type Seam, type Settings } from "@yarvis/shared";
import { decide, thresholdsFrom } from "./ai/decide.js";
import { JevMessageRejected, toJevError } from "./ai/jev.js";
import type { Extractor } from "./ai/extract.js";
import { isFakeMode, type Env, type Paths } from "./config/paths.js";
import { loadSettings } from "./config/settings.js";
import { loadCredentials } from "./connectors/gmail.js";
import { QUARANTINE, TODOS } from "./connectors/sheets.js";
import { loadFixtureMessages } from "./fakes/jev.js";
import { seamsConfigured } from "./pipeline/configured.js";
import {
  CLAUDE_PROBE_NO_ACTIONS,
  CLAUDE_PROBE_PENDING,
  JEV_PROBE_MISMATCH,
  jevRejectedText,
  stageErrorText,
} from "./pipeline/errors.js";
import {
  createFakeSeams,
  createRealSeams,
  realSheetsStore,
  type ProbeSeams,
} from "./pipeline/seams.js";
import { readState } from "./pipeline/state.js";
import type { CliDeps, CliIo } from "./cli.js";

/** What doctor probes: the refresh seams minus WhatsApp (whose probe is a file check). */
export type DoctorSeams = Pick<ProbeSeams, "gmail" | "sheets" | "jev" | "extractor">;

export interface DoctorDeps {
  paths: Paths;
  env: Env;
  seams: DoctorSeams;
}

export type ProbeOutcome =
  { kind: "ok"; detail: string } | { kind: "not_configured" } | { kind: "error"; reason: string };

export interface DoctorReport {
  lines: string[];
  failed: boolean;
}

export function seamLine(seam: Seam, outcome: ProbeOutcome): string {
  switch (outcome.kind) {
    case "ok":
      return `${seam}: ok (${outcome.detail})`;
    case "not_configured":
      return `${seam}: not configured`;
    case "error":
      return `${seam}: error ${outcome.reason}`;
  }
}

const ok = (detail: string): ProbeOutcome => ({ kind: "ok", detail });
const fail = (reason: string): ProbeOutcome => ({ kind: "error", reason });

/**
 * The echoed Jev model id as printed: it comes from a remote response, so it is shown only when it
 * looks like a plain model id (letters, digits, `.`, `_`, `-`; no path separators, `@` or `:`) and
 * not like a credential (a key prefix such as `sk-`, or a long unbroken alphanumeric run).
 */
export function printableModelId(model: string | undefined): string {
  if (model === undefined) return "unreported";
  const plain = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(model);
  const keyShaped = /^(sk|pk|rk|api|key|token)[-_]/i.test(model) || /[A-Za-z0-9]{24,}/.test(model);
  return plain && !keyShaped ? model : "unrecognized id";
}

type SettingsResult = { settings: Settings } | { error: unknown };

async function probeSeam(
  seam: Seam,
  deps: DoctorDeps,
  fake: boolean,
  settings: SettingsResult,
): Promise<ProbeOutcome> {
  const { paths, seams } = deps;
  switch (seam) {
    case "gmail":
      // Fake mode has no token file; the real wiring re-checks it again on every API resolve.
      if (!fake) await loadCredentials(paths);
      await seams.gmail.probe();
      return ok("readonly scope");
    case "whatsapp":
      // Configured means private/wa-auth/creds.json is present; no socket is ever opened here.
      return ok(fake ? "fake socket" : "linked creds present");
    case "sheets":
      await seams.sheets.ensureTab(TODOS);
      await seams.sheets.ensureTab(QUARANTINE);
      return ok(`tabs ${TODOS.name}, ${QUARANTINE.name}`);
    case "jev": {
      if ("error" in settings) throw settings.error;
      const jev = typeof seams.jev === "function" ? seams.jev(settings.settings) : seams.jev;
      const fixtures = loadFixtureMessages();
      const thresholds = thresholdsFrom(settings.settings);
      try {
        const phishing = await jev.classifyWithModel(fixtures.phishing);
        const clean = await jev.classifyWithModel(fixtures.clean);
        // The phishing fixture must score phishing >= thresholds.quarantine, and the clean one must
        // pass routing exactly as a refresh would (decide(): no security score at the threshold).
        if (
          phishing.scores.phishing < thresholds.quarantine ||
          decide(fixtures.clean, clean.scores, thresholds).quarantined
        ) {
          return fail(JEV_PROBE_MISMATCH);
        }
        return ok(`model ${printableModelId(phishing.model)}`);
      } catch (err) {
        const typed = toJevError(err);
        return fail(
          typed instanceof JevMessageRejected ? jevRejectedText(1) : stageErrorText(typed),
        );
      }
    }
    case "claude": {
      if ("error" in settings) throw settings.error;
      const extractor: Extractor =
        typeof seams.extractor === "function"
          ? seams.extractor(settings.settings)
          : seams.extractor;
      const result = await extractor.extract(loadFixtureMessages().actionable);
      if (result.status === "pending") return fail(CLAUDE_PROBE_PENDING);
      if (result.status === "none") return fail(CLAUDE_PROBE_NO_ACTIONS);
      return ok(`parsed ${result.actions.length} actions`);
    }
  }
}

async function cursorsLine(paths: Paths): Promise<{ line: string; failed: boolean }> {
  try {
    const state = await readState(paths);
    const lastRunAt = state.gmail?.lastRunAt ?? "none";
    const lastMessageTs = state.whatsapp?.lastMessageTs ?? "none";
    return {
      line: `cursors: gmail.lastRunAt=${lastRunAt} whatsapp.lastMessageTs=${String(lastMessageTs)}`,
      failed: false,
    };
  } catch (err) {
    return { line: `cursors: error ${stageErrorText(err)}`, failed: true };
  }
}

/** Runs every probe (in SEAMS order, one at a time) and the cursors read. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const fake = isFakeMode(deps.env);
  const settings: SettingsResult = await loadSettings(deps.paths).then(
    (s) => ({ settings: s }),
    (error: unknown) => ({ error }),
  );
  const configured = seamsConfigured({
    paths: deps.paths,
    env: deps.env,
    fake,
    settings: "settings" in settings ? settings.settings : null,
  });
  const lines: string[] = [];
  let failed = false;
  for (const seam of SEAMS) {
    let outcome: ProbeOutcome;
    if (!configured[seam]) {
      outcome = { kind: "not_configured" };
    } else {
      try {
        outcome = await probeSeam(seam, deps, fake, settings);
      } catch (err) {
        outcome = fail(stageErrorText(err));
      }
    }
    if (outcome.kind === "error") failed = true;
    lines.push(seamLine(seam, outcome));
  }
  const cursors = await cursorsLine(deps.paths);
  lines.push(cursors.line);
  return { lines, failed: failed || cursors.failed };
}

/** The `yarvis doctor` verb: the real seams (all fakes when YARVIS_FAKE=1) unless injected. */
export async function runDoctorVerb(args: string[], io: CliIo, deps: CliDeps): Promise<number> {
  if (args.length > 0) {
    io.err(`yarvis doctor: unexpected argument "${args[0]}" (usage: doctor)`);
    return 2;
  }
  const env = deps.env ?? process.env;
  const seams =
    deps.seams ??
    (isFakeMode(env)
      ? createFakeSeams()
      : createRealSeams(deps.paths, realSheetsStore(deps.paths)));
  const report = await runDoctor({ paths: deps.paths, env, seams });
  for (const line of report.lines) io.out(line);
  return report.failed ? 1 : 0;
}

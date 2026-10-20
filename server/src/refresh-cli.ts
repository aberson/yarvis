// `yarvis refresh` (plan §5): one refresh from the terminal through the production `runRefresh`,
// with the same seams the server uses (all fakes when YARVIS_FAKE=1). Prints one line per stage and
// the final job state; exit 0 on `done`, 1 on `partial`/`error` or when a refresh already holds
// private/refresh.lock (D19). Loaded lazily by cli.ts, so other verbs never load Baileys.
import { REFRESH_STAGES, type RefreshStatus } from "@yarvis/shared";
import { isFakeMode } from "./config/paths.js";
import { LockHeldError } from "./lock.js";
import { runRefresh } from "./pipeline/refresh.js";
import {
  createFakeSeams,
  createRealSeams,
  realSheetsStore,
  resetFakePipelineState,
} from "./pipeline/seams.js";
import type { CliDeps, CliIo } from "./cli.js";

/** One line per stage, e.g. `gmail: error (0) - gmail auth expired (run yarvis gmail:auth)`. */
export function formatStatus(status: RefreshStatus): string[] {
  const lines = REFRESH_STAGES.map((name) => {
    const s = status.stages[name];
    return `${name}: ${s.state} (${s.count})${s.error ? ` - ${s.error}` : ""}`;
  });
  if (status.error) lines.push(`error: ${status.error}`);
  lines.push(`refresh ${status.state}`);
  return lines;
}

export async function runRefreshVerb(args: string[], io: CliIo, deps: CliDeps): Promise<number> {
  if (args.length > 0) {
    io.err(`yarvis refresh: unexpected argument "${args[0]}" (usage: refresh)`);
    return 2;
  }
  const { paths } = deps;
  let seams = deps.seams;
  if (!seams && isFakeMode()) {
    // Each fake CLI run has a fresh in-memory sheet: start its caches from the fixture state too.
    await resetFakePipelineState(paths);
    seams = createFakeSeams();
  }
  seams ??= createRealSeams(paths, realSheetsStore(paths));
  let status: RefreshStatus;
  try {
    status = await runRefresh({ paths, ...seams });
  } catch (err) {
    if (err instanceof LockHeldError) {
      io.err(`yarvis refresh: ${err.message}`);
      return 1;
    }
    throw err;
  }
  for (const line of formatStatus(status)) io.out(line);
  return status.state === "done" ? 0 : 1;
}

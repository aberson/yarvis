// Which of the five seams are configured (plan §5, §6, D24): from files present / env set ONLY.
// Never a live probe (that is `yarvis doctor`), never a network call, and never a value: files are
// checked for existence, env vars for non-emptiness. Shared by GET /api/status and `yarvis doctor`.
import { existsSync } from "node:fs";
import path from "node:path";
import { isSheetIdConfigured, SEAMS, type Seam, type Settings } from "@yarvis/shared";
import { findClaudeBinary } from "../ai/extract.js";
import { isJevConfigured } from "../ai/jev.js";
import type { Env, Paths } from "../config/paths.js";
import { waAuthDir } from "../connectors/whatsapp.js";
import { WA_CREDS_FILE } from "./seams.js";

export type SeamFlags = Record<Seam, boolean>;

export interface ConfiguredOptions {
  paths: Paths;
  /** TYPESAFE_API_KEY (jev) and PATH (the claude binary). */
  env: Env;
  /** YARVIS_FAKE=1: every seam is wired to its in-memory fake, which needs no credentials. */
  fake: boolean;
  /** Current settings (sheets needs settings.sheetId); null when they cannot be read. */
  settings: Settings | null;
}

/** `private/wa-auth/creds.json`: written by `yarvis wa:link`, required by every drain. */
export function waCredsFile(paths: Paths): string {
  return path.join(waAuthDir(paths), WA_CREDS_FILE);
}

export function seamsConfigured(opts: ConfiguredOptions): SeamFlags {
  if (opts.fake) return Object.fromEntries(SEAMS.map((s) => [s, true])) as SeamFlags;
  const { paths, env, settings } = opts;
  return {
    gmail: existsSync(paths.gmailTokenFile),
    whatsapp: existsSync(waCredsFile(paths)),
    // Unreadable settings: report on the key file alone, so doctor's probe surfaces the settings error.
    sheets:
      existsSync(paths.serviceAccountFile) &&
      (settings === null || isSheetIdConfigured(settings.sheetId)),
    jev: isJevConfigured(env),
    claude: findClaudeBinary({ ...env }) !== null,
  };
}

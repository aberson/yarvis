// The five external seams a refresh runs against (plan §5, D11, D32), and their two wirings:
//   - real: Baileys (linked creds required), Gmail OAuth (readonly), TypeSafe Jev, `claude -p`,
//     Google Sheets via the service account;
//   - fake (YARVIS_FAKE=1): FakeWhatsApp, FakeGmail, FakeJev, FakeClaude, FakeSheets, all seeded
//     from server/fixtures. server/fixtures/manifest.ts pins what one fake refresh produces.
// Nothing here does I/O at construction: each real client resolves its credentials per call.
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { Settings } from "@yarvis/shared";
import { createExtractorFromSettings, type Extractor } from "../ai/extract.js";
import { createJevFromSettings, type Jev, type JevWithModel } from "../ai/jev.js";
import { resolvePaths, type Paths } from "../config/paths.js";
import { createGmailConnector, googleGmailApi, type GmailConnector } from "../connectors/gmail.js";
import { createSheetsStore, googleSheetsTarget, type SheetsStore } from "../connectors/sheets.js";
import { baileysDeps, WaLoggedOut, type WaDeps } from "../connectors/whatsapp.js";
import { FakeClaude, type ClaudeSeed } from "../fakes/claude.js";
import { createFakeGmail, type FakeGmail } from "../fakes/gmail.js";
import { FakeJev, type JevSeed } from "../fakes/jev.js";
import { createFakeSheets, type FakeSheets } from "../fakes/sheets.js";
import {
  createFakeWhatsApp,
  type FakeWhatsApp,
  type FakeWhatsAppOptions,
} from "../fakes/whatsapp.js";
import { acquireLock, LockHeldError } from "../lock.js";
import { decisionsFile, messagesFile } from "./cache.js";

/** The WhatsApp drain window override (default: the connector's 8 s quiet / 60 s max, D9). */
export interface WaWindow {
  quietMs: number;
  maxMs: number;
}

export interface PipelineSeams {
  /** WhatsApp socket seam for `drain` (connectors/whatsapp.ts). */
  wa: WaDeps;
  waWindow?: WaWindow;
  gmail: GmailConnector;
  /** A classifier, or a factory called once per job with that job's settings (jev.model). */
  jev: Jev | ((settings: Settings) => Jev);
  /** An extractor, or a factory called once per job with that job's settings (extract.*). */
  extractor: Extractor | ((settings: Settings) => Extractor);
  sheets: SheetsStore;
}

/**
 * The seams with a Jev that echoes its model id: what `yarvis doctor` probes (plan §5) and what both
 * wirings below provide. A refresh only needs the PipelineSeams part.
 */
export interface ProbeSeams extends PipelineSeams {
  jev: JevWithModel | ((settings: Settings) => JevWithModel);
}

/** Baileys keeps the link in `<authDir>/creds.json` (useMultiFileAuthState). */
export const WA_CREDS_FILE = "creds.json";

/**
 * The real seam, refusing to open a session without linked creds: a drain must never create
 * private/wa-auth/ or reach the pairing QR (that is `yarvis wa:link`'s job).
 */
export const linkedBaileysDeps: WaDeps = {
  loadAuth: (dir) => {
    if (!existsSync(path.join(dir, WA_CREDS_FILE))) {
      return Promise.reject(new WaLoggedOut("not_linked"));
    }
    return baileysDeps.loadAuth(dir);
  },
  makeSocket: (config) => baileysDeps.makeSocket(config),
};

export function realSheetsStore(paths: Paths): SheetsStore {
  return createSheetsStore({ target: googleSheetsTarget(paths) });
}

/** Production wiring. `sheets` is shared with the /api/todos routes. */
export function createRealSeams(paths: Paths, sheets: SheetsStore): ProbeSeams {
  return {
    wa: linkedBaileysDeps,
    gmail: createGmailConnector({ api: googleGmailApi(paths) }),
    jev: (settings) => createJevFromSettings(settings),
    extractor: (settings) => createExtractorFromSettings(settings),
    sheets,
  };
}

/** Fake mode drains its scripted socket in well under a second (the fake has no network). */
export const FAKE_WA_WINDOW: WaWindow = { quietMs: 300, maxMs: 5_000 };

export interface FakeSeamsOptions {
  /** Share an existing store (the app's); default a fresh FakeSheets seeded from fixtures. */
  sheets?: SheetsStore;
  whatsapp?: FakeWhatsAppOptions;
  jevSeed?: JevSeed;
  claudeSeed?: ClaudeSeed;
  waWindow?: WaWindow;
}

export interface FakeSeams extends ProbeSeams {
  jev: FakeJev;
  extractor: FakeClaude;
  fakes: {
    whatsapp: FakeWhatsApp;
    gmail: FakeGmail;
    /** Null when an external store was passed in. */
    sheets: FakeSheets | null;
  };
}

/** Fake-mode wiring of all five seams (D11), seeded from server/fixtures. */
export function createFakeSeams(opts: FakeSeamsOptions = {}): FakeSeams {
  const whatsapp = createFakeWhatsApp(opts.whatsapp);
  const gmail = createFakeGmail();
  const fakeSheets = opts.sheets ? null : createFakeSheets();
  return {
    wa: whatsapp.deps,
    waWindow: opts.waWindow ?? FAKE_WA_WINDOW,
    gmail: gmail.connector,
    jev: new FakeJev(opts.jevSeed),
    extractor: new FakeClaude(opts.claudeSeed),
    sheets: opts.sheets ?? (fakeSheets as FakeSheets).store,
    fakes: { whatsapp, gmail, sheets: fakeSheets },
  };
}

export function defaultSeams(opts: {
  paths: Paths;
  fake: boolean;
  sheets: SheetsStore;
}): PipelineSeams {
  return opts.fake
    ? createFakeSeams({ sheets: opts.sheets })
    : createRealSeams(opts.paths, opts.sheets);
}

/**
 * Fake mode keeps its sheet in memory, so a fresh fake process must not inherit the previous
 * process's caches and cursors (they would claim rows the new in-memory sheet never got). Only the
 * DEFAULT fake private dir (`<repo>/private/fake`, D32) is reset: a YARVIS_PRIVATE_DIR override is
 * never touched, and a reset is skipped while another process holds the refresh lock. Returns
 * whether it reset.
 */
export async function resetFakePipelineState(paths: Paths): Promise<boolean> {
  const defaultFakeDir = resolvePaths({ YARVIS_FAKE: "1" }, paths.repoRoot).privateDir;
  if (path.resolve(paths.privateDir) !== path.resolve(defaultFakeDir)) return false;
  // Under the refresh lock, so a fake job running in another process is never reset mid-append.
  let lock;
  try {
    lock = await acquireLock(paths.lockFile);
  } catch (err) {
    if (err instanceof LockHeldError) return false;
    throw err;
  }
  try {
    await Promise.all(
      [messagesFile(paths), decisionsFile(paths), paths.stateFile].map((f) =>
        rm(f, { force: true }),
      ),
    );
  } finally {
    await lock.release();
  }
  return true;
}

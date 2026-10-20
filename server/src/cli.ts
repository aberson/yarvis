// `yarvis` verb dispatcher (plan §5): `npm run yarvis -- <verb>`. Verbs are thin wrappers over the
// server modules; each lands with its own step, and until then it exits non-zero with
// "not yet implemented". Built so far: gmail:auth (Step 4), wa:link and wa:chats (Step 5).
import { loadPrivateEnv } from "./config/env.js";
import { resolvePaths, type Paths } from "./config/paths.js";
import {
  createGoogleOAuthClient,
  GmailError,
  openInBrowser,
  runGmailAuth,
  type GmailAuthDeps,
} from "./connectors/gmail.js";
import type { WaDeps } from "./connectors/whatsapp.js";
import { isMainModule } from "./util/is-main.js";

export interface Verb {
  name: string;
  usage: string;
  summary: string;
  /** Undefined until the owning step builds it. */
  run?: (args: string[], io: CliIo, deps: CliDeps) => Promise<number>;
}

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

/** What verbs run against; tests inject a temp private dir, fake OAuth pieces and a fake socket. */
export interface CliDeps {
  paths: Paths;
  /** `gmail:auth` OAuth seams (default: googleapis OAuth2 client + the system browser). */
  gmailAuth: Pick<GmailAuthDeps, "createOAuthClient" | "openBrowser" | "consentTimeoutMs">;
  /**
   * WhatsApp socket seam. Unset by default: wa-cli.ts picks Baileys (FakeWhatsApp when
   * YARVIS_FAKE=1) lazily, so verbs other than wa:* never load Baileys.
   */
  wa?: WaDeps;
}

export function defaultCliDeps(): CliDeps {
  return {
    paths: resolvePaths(),
    gmailAuth: { createOAuthClient: createGoogleOAuthClient, openBrowser: openInBrowser },
  };
}

/** `gmail:auth`: prints exactly "ok" on success; failures print a safe one-line reason. */
async function gmailAuthVerb(args: string[], io: CliIo, deps: CliDeps): Promise<number> {
  if (args.length > 0) {
    io.err("yarvis gmail:auth: takes no arguments");
    return 2;
  }
  try {
    await runGmailAuth({ paths: deps.paths, ...deps.gmailAuth });
  } catch (err) {
    // GmailError messages are built to never contain token or private values; anything else is
    // reported by class only, since a library error could echo a request or response body.
    const reason = err instanceof GmailError ? err.message : "unexpected failure";
    io.err(`yarvis gmail:auth: ${reason}`);
    return 1;
  }
  io.out("ok");
  return 0;
}

export const VERBS: readonly Verb[] = [
  {
    name: "gmail:auth",
    usage: "gmail:auth",
    summary: "Mint the read-only Gmail token (private/gmail-token.json)",
    run: gmailAuthVerb,
  },
  {
    name: "wa:link",
    usage: "wa:link [--reset]",
    summary: "Link WhatsApp as a read-only device via QR (--reset clears private/wa-auth/)",
    run: async (args, io, deps) => (await import("./wa-cli.js")).runWaLink(args, io, deps),
  },
  {
    name: "wa:chats",
    usage: "wa:chats",
    summary: "List WhatsApp chats (JID + name) to fill the allowlist",
    run: async (args, io, deps) => (await import("./wa-cli.js")).runWaChats(args, io, deps),
  },
  {
    name: "doctor",
    usage: "doctor",
    summary: "Probe each configured seam (status only, never private values)",
  },
  { name: "refresh", usage: "refresh", summary: "Run one refresh from the terminal" },
];

export function helpText(): string {
  const width = Math.max(...VERBS.map((v) => v.usage.length)) + 2;
  return [
    "Usage: npm run yarvis -- <verb> [options]",
    "",
    "Verbs:",
    ...VERBS.map((v) => `  ${v.usage.padEnd(width)}${v.summary}`),
    "",
    "Options:",
    `  ${"-h, --help".padEnd(width)}Show this help`,
  ].join("\n");
}

const defaultIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/** Runs one verb; `deps` overrides are merged over the production defaults (defaultCliDeps). */
export async function runCli(
  argv: readonly string[],
  io: CliIo = defaultIo,
  deps: Partial<CliDeps> = {},
): Promise<number> {
  const [first, ...rest] = argv;
  if (first === undefined) {
    io.err(helpText());
    return 2;
  }
  if (first === "-h" || first === "--help" || first === "help") {
    io.out(helpText());
    return 0;
  }
  const verb = VERBS.find((v) => v.name === first);
  if (!verb) {
    io.err(`yarvis: unknown verb "${first}"`);
    io.err(helpText());
    return 2;
  }
  if (!verb.run) {
    io.err(`yarvis ${verb.name}: not yet implemented`);
    return 1;
  }
  return verb.run(rest, io, { ...defaultCliDeps(), ...deps });
}

/** How long exitAfterFlush waits for stdout/stderr write callbacks before exiting anyway. */
const EXIT_FLUSH_FALLBACK_MS = 500;

/**
 * Exits with `code` once stdout and stderr have flushed. A finished verb never waits for the event
 * loop to drain: a library handle (e.g. Baileys' 60 s query timer behind an unanswered group-list
 * query after wa:chats) would otherwise keep the process alive after the output is printed.
 */
function exitAfterFlush(code: number): void {
  process.exitCode = code;
  const exit = (): void => process.exit(code);
  // Fallback: a destroyed or wedged stream may never call back; never outlive the flush by long.
  setTimeout(exit, EXIT_FLUSH_FALLBACK_MS).unref();
  let pending = 2;
  const flushed = (): void => {
    if (--pending === 0) exit();
  };
  for (const stream of [process.stdout, process.stderr]) {
    stream.once("error", flushed); // a write error must not become an uncaught exception
    try {
      stream.write("", flushed);
    } catch {
      flushed();
    }
  }
}

if (isMainModule(import.meta.url)) {
  loadPrivateEnv(resolvePaths());
  void runCli(process.argv.slice(2))
    .catch((err: unknown) => {
      process.stderr.write(`yarvis: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    })
    .then(exitAfterFlush);
}

// `yarvis wa:link [--reset]` and `yarvis wa:chats` (plan §5, Step M3). Thin wrappers over
// connectors/whatsapp.ts; both hold private/refresh.lock for their whole session (D19), so they
// never run alongside a refresh. Loaded lazily by cli.ts, so other verbs never load Baileys.
import { rm } from "node:fs/promises";
import { isFakeMode, resolvePaths } from "./config/paths.js";
import {
  baileysDeps,
  linkDevice,
  listChats,
  waAuthDir,
  WaLinkError,
  WaLoggedOut,
  type WaDeps,
} from "./connectors/whatsapp.js";
import { createFakeWhatsApp } from "./fakes/whatsapp.js";
import { LockHeldError, withLock } from "./lock.js";
import type { CliDeps, CliIo } from "./cli.js";

function waDeps(deps: CliDeps): WaDeps {
  return deps.wa ?? (isFakeMode() ? createFakeWhatsApp().deps : baileysDeps);
}

// ESC-introduced sequences (CSI, OSC/DCS/APC/PM/SOS strings, two-byte escapes), then any remaining
// C0/C1 control or Unicode bidi formatting character.
const ESCAPE_SEQUENCE =
  // eslint-disable-next-line no-control-regex
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|[\]PX^_][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
const UNSAFE_CHARS = /[\p{Cc}\p{Bidi_Control}]/gu;

/** Strips terminal escape sequences, control characters and bidi overrides from untrusted text. */
export function terminalSafe(text: string): string {
  return text.replace(ESCAPE_SEQUENCE, "").replace(UNSAFE_CHARS, "");
}

/** Known failures become one stderr line + exit 1; anything else propagates. */
function reportKnown(verb: string, err: unknown, io: CliIo): number {
  if (err instanceof LockHeldError || err instanceof WaLoggedOut || err instanceof WaLinkError) {
    io.err(`yarvis ${verb}: ${err.message}`);
    return 1;
  }
  throw err;
}

export async function runWaLink(args: string[], io: CliIo, deps: CliDeps): Promise<number> {
  const unknown = args.filter((a) => a !== "--reset");
  if (unknown.length > 0) {
    io.err(`yarvis wa:link: unknown option "${unknown[0]}" (usage: wa:link [--reset])`);
    return 2;
  }
  const paths = deps.paths ?? resolvePaths();
  const authDir = waAuthDir(paths);
  try {
    await withLock(paths.lockFile, async () => {
      if (args.includes("--reset")) {
        await rm(authDir, { recursive: true, force: true });
        io.out("cleared wa-auth/ (previous WhatsApp link removed)");
      }
      await linkDevice({ authDir, out: (line) => io.out(line), deps: waDeps(deps) });
    });
    return 0;
  } catch (err) {
    return reportKnown("wa:link", err, io);
  }
}

export async function runWaChats(args: string[], io: CliIo, deps: CliDeps): Promise<number> {
  if (args.length > 0) {
    io.err(`yarvis wa:chats: unexpected argument "${args[0]}" (usage: wa:chats)`);
    return 2;
  }
  const paths = deps.paths ?? resolvePaths();
  try {
    const chats = await withLock(paths.lockFile, () =>
      listChats({ authDir: waAuthDir(paths), deps: waDeps(deps) }),
    );
    if (chats.length === 0) {
      io.out("no chats received (WhatsApp sends chat history mostly right after linking)");
      return 0;
    }
    // Names (and chat ids) are set by third parties: never let them drive the terminal.
    const rows = chats.map((c) => ({
      name: terminalSafe(c.name) || "-",
      jid: terminalSafe(c.jid),
    }));
    const width = Math.max(...rows.map((r) => r.name.length), "NAME".length) + 2;
    io.out(`${"NAME".padEnd(width)}JID`);
    for (const row of rows) io.out(`${row.name.padEnd(width)}${row.jid}`);
    io.out("");
    io.out('Copy the JIDs to keep into private/settings.json "whatsapp.allowlist" ({jid, name}).');
    return 0;
  } catch (err) {
    return reportKnown("wa:chats", err, io);
  }
}

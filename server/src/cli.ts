// `yarvis` verb dispatcher (plan §5): `npm run yarvis -- <verb>`. Verbs are thin wrappers over the
// server modules; each lands with its own step, and until then it exits non-zero with
// "not yet implemented".
import { loadPrivateEnv } from "./config/env.js";
import { resolvePaths } from "./config/paths.js";
import { isMainModule } from "./util/is-main.js";

export interface Verb {
  name: string;
  usage: string;
  summary: string;
  /** Undefined until the owning step builds it. */
  run?: (args: string[], io: CliIo) => Promise<number>;
}

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export const VERBS: readonly Verb[] = [
  {
    name: "gmail:auth",
    usage: "gmail:auth",
    summary: "Mint the read-only Gmail token (private/gmail-token.json)",
  },
  {
    name: "wa:link",
    usage: "wa:link [--reset]",
    summary: "Link WhatsApp as a read-only device via QR (--reset clears private/wa-auth/)",
  },
  {
    name: "wa:chats",
    usage: "wa:chats",
    summary: "List WhatsApp chats (JID + name) to fill the allowlist",
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

export async function runCli(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
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
  return verb.run(rest, io);
}

if (isMainModule(import.meta.url)) {
  loadPrivateEnv(resolvePaths());
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`yarvis: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}

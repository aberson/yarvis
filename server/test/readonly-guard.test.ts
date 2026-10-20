// READ-ONLY WhatsApp guard (plan §1.2, §5, §8): no file under server/src may reference a Baileys
// send / presence / read-receipt / chat- or group-mutation API, and connectors/whatsapp.ts is the
// only module that imports Baileys. The planted cases run the SAME collector + scanner over a temp
// copy of server/src, so the guard is proven able to fail.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config/paths.js";

const SERVER_SRC = path.join(REPO_ROOT, "server", "src");

/** Write-capable or receipt-sending Baileys socket members. Matched as whole identifiers. */
const FORBIDDEN_IDENTIFIERS = [
  "sendMessage",
  "sendPresenceUpdate",
  "readMessages",
  "chatModify",
  "groupParticipantsUpdate",
  "sendReceipt",
  "sendReceipts",
  "relayMessage",
  "presenceSubscribe",
  "sendMessageAck",
  "sendRetryRequest",
  "sendPeerDataOperationMessage",
  "appPatch",
  "updateBlockStatus",
  "rejectCall",
  "groupCreate",
  "groupLeave",
  "groupUpdateSubject",
  "groupUpdateDescription",
  "groupSettingUpdate",
  "updateProfileStatus",
  "updateProfileName",
  "updateProfilePicture",
] as const;

const BAILEYS_IMPORTER = "connectors/whatsapp.ts";
const BAILEYS_SPECIFIER = /["']@whiskeysockets\/baileys(?:\/[^"']*)?["']/;

interface Source {
  /** POSIX path relative to the scanned root. */
  rel: string;
  text: string;
}

interface Violation {
  rel: string;
  line: number;
  rule: string;
}

function collectSources(root: string): Source[] {
  const out: Source[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|mjs|cjs|json)$/.test(entry.name)) {
        out.push({
          rel: path.relative(root, full).split(path.sep).join("/"),
          text: readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(root);
  return out;
}

function scan(sources: readonly Source[]): Violation[] {
  const patterns = FORBIDDEN_IDENTIFIERS.map(
    (id) => [id, new RegExp(`(?<![A-Za-z0-9_$])${id}(?![A-Za-z0-9_$])`)] as const,
  );
  const violations: Violation[] = [];
  for (const { rel, text } of sources) {
    text.split(/\r?\n/).forEach((line, i) => {
      for (const [id, re] of patterns) {
        if (re.test(line)) violations.push({ rel, line: i + 1, rule: id });
      }
      if (rel !== BAILEYS_IMPORTER && BAILEYS_SPECIFIER.test(line)) {
        violations.push({ rel, line: i + 1, rule: "baileys-import" });
      }
    });
  }
  return violations;
}

/** A temp copy of server/src with `line` appended to `rel`; returns the violations found. */
const temps: string[] = [];
function scanPlanted(rel: string, line: string): Violation[] {
  const dir = mkdtempSync(path.join(tmpdir(), "yarvis-guard-"));
  temps.push(dir);
  cpSync(SERVER_SRC, dir, { recursive: true });
  const file = path.join(dir, ...rel.split("/"));
  writeFileSync(file, `${readFileSync(file, "utf8")}\n${line}\n`);
  return scan(collectSources(dir));
}

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("read-only WhatsApp guard over server/src", () => {
  it("passes on the tree, and actually scanned the connector", () => {
    const sources = collectSources(SERVER_SRC);
    expect(sources.map((s) => s.rel)).toContain(BAILEYS_IMPORTER);
    expect(scan(sources)).toEqual([]);
  });

  it.each(FORBIDDEN_IDENTIFIERS)("fails on a planted %s in any server/src file", (id) => {
    const found = scanPlanted("lock.ts", `// sock["${id}"]`);
    expect(found.map((v) => [v.rel, v.rule])).toEqual([["lock.ts", id]]);
  });

  it("fails when a module other than connectors/whatsapp.ts imports Baileys", () => {
    const found = scanPlanted(
      "fakes/whatsapp.ts",
      'export { makeWASocket } from "@whiskeysockets/baileys";',
    );
    expect(found.map((v) => [v.rel, v.rule])).toEqual([["fakes/whatsapp.ts", "baileys-import"]]);
  });
});

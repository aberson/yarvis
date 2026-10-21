// README (plan Step 8): carries every §10 "How to Run" command verbatim and the §8 recovery
// commands. The commands are extracted from docs/plans/master_plan.md at test time (the plan is
// their one source), and every npm script the README names must exist in the root package.json.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config/paths.js";
import { npmScriptsReferenced, rootScripts } from "./helpers.js";

// Normalized so the `$`-anchored heading regexes also hold on a CRLF checkout.
const plan = readFileSync(path.join(REPO_ROOT, "docs", "plans", "master_plan.md"), "utf8").replace(
  /\r\n/g,
  "\n",
);
const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");

function section(heading: RegExp, end: RegExp): string {
  const start = plan.search(heading);
  if (start < 0) throw new Error(`plan section ${String(heading)} not found`);
  const rest = plan.slice(start);
  const stop = rest.slice(1).search(end);
  return stop < 0 ? rest : rest.slice(0, stop + 1);
}

const COMMAND = /^(npm|npx|git) /;
const BLANK_LINE = /\r?\n[ \t]*\r?\n/;
const codeSpans = (text: string) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);

/** §10: every line of its fenced block (trailing `# comment` stripped) plus inline command spans. */
function howToRunCommands(): string[] {
  const s10 = section(/^## 10\. How to Run$/m, /^## /m);
  const fenced = [...s10.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].flatMap((m) =>
    m[1]!
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+#.*$/, "").trim())
      .filter(Boolean),
  );
  const inline = codeSpans(s10.replace(/^```[\s\S]*?^```/gm, "")).filter((c) => COMMAND.test(c));
  return [...new Set([...fenced, ...inline])];
}

/** §8 "Recovery." paragraph: its code spans (commands and the cache path to delete). */
function recoveryItems(): string[] {
  const s8 = section(/^## 8\. Key Design Decisions$/m, /^## /m);
  const para = s8.split(BLANK_LINE).find((p) => p.startsWith("**Recovery.**")) ?? "";
  return codeSpans(para);
}

describe("README.md", () => {
  it("contains every §10 How to Run command verbatim", () => {
    const commands = howToRunCommands();
    // Anchor against a vacuous extraction: the §10 quickstart and test commands are present.
    expect(commands).toEqual(
      expect.arrayContaining(["npm install", "npx playwright install chromium", "npm run smoke"]),
    );
    expect(commands.filter((c) => !readme.includes(c))).toEqual([]);
  });

  it("contains the §8 recovery commands", () => {
    const items = recoveryItems();
    expect(items).toEqual(
      expect.arrayContaining(["npm run yarvis -- wa:link --reset", "npm run yarvis -- gmail:auth"]),
    );
    expect(items.filter((c) => !readme.includes(c))).toEqual([]);
  });

  it("names only npm scripts that exist in the root package.json", () => {
    const referenced = npmScriptsReferenced(readme);
    expect(referenced).toContain("smoke");
    expect(referenced.filter((name) => !(name in rootScripts()))).toEqual([]);
  });

  it("states the Node runtime requirement pinned in the root package.json engines (S1, D43)", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    expect(pkg.engines?.node).toBe(">=24.14.0 <25");
    expect(readme).toContain(pkg.engines?.node ?? "<missing>");
    expect(readme).toContain("Node 24.14.0");
  });

  it("documents the Briefing landing route and its stopped-server backup", () => {
    expect(readme).toContain("`/` redirects to `/briefing`");
    expect(readme).toContain("private/assistant.sqlite");
  });
});

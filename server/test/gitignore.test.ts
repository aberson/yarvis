// Public code, private data (plan §1.2): the tracked + would-be-tracked set under private/ is exactly
// private/README.md, and a planted private/settings.json is excluded by .gitignore.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config/paths.js";

function git(args: string[]): string {
  return execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" });
}

function listPrivate(): string[] {
  return git(["ls-files", "--cached", "--others", "--exclude-standard", "private"])
    .split(/\r?\n/)
    .filter(Boolean);
}

function isIgnored(rel: string): boolean {
  try {
    execFileSync("git", ["-C", REPO_ROOT, "check-ignore", "-q", "--no-index", rel]);
    return true;
  } catch (err) {
    if ((err as { status?: number }).status === 1) return false;
    throw err;
  }
}

describe("private/ gitignore split", () => {
  it("runs against this repo's own work tree", () => {
    const top = path.resolve(git(["rev-parse", "--show-toplevel"]).trim());
    expect(top.toLowerCase()).toBe(path.resolve(REPO_ROOT).toLowerCase());
  });

  it("tracked + would-be-tracked files under private/ are exactly private/README.md, with a planted settings.json excluded", () => {
    const planted = path.join(REPO_ROOT, "private", "settings.json");
    const plantedHere = !existsSync(planted);
    try {
      if (plantedHere) writeFileSync(planted, "{}\n");
      expect(existsSync(planted)).toBe(true);
      expect(listPrivate()).toEqual(["private/README.md"]);
      expect(isIgnored("private/settings.json")).toBe(true);
      expect(isIgnored("private/fake/settings.json")).toBe(true);
      expect(isIgnored("private/README.md")).toBe(false);
    } finally {
      if (plantedHere) rmSync(planted, { force: true });
    }
  });
});

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT, resolvePaths, type Paths } from "../src/config/paths.js";

/** A fresh private dir under the OS temp dir (never the real private/). */
export function tempPaths(opts: { seedSettings?: boolean } = {}): {
  paths: Paths;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "yarvis-test-"));
  const paths = resolvePaths({ YARVIS_PRIVATE_DIR: dir }, REPO_ROOT);
  if (opts.seedSettings) copyFileSync(paths.settingsExample, paths.settingsFile);
  return { paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

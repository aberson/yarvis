import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT, resolvePaths, type Paths } from "../src/config/paths.js";
import { waCredsFile } from "../src/pipeline/configured.js";

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

/** A fake secret planted in every private file and env var doctor / GET /api/status could read. */
export const PLANTED = "PLANTED-SECRET-7f3a9c";

const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

/**
 * Plants every file a real seam needs (Gmail token from a server/fixtures token file, service
 * account, settings with a sheetId, WhatsApp creds, a `claude` binary on PATH), each carrying
 * PLANTED, and returns the env that configures jev + claude.
 */
export function plantPrivate(
  paths: Paths,
  token = "gmail-token-readonly.json",
): Record<string, string> {
  const tokenFixture = readJson(path.join(REPO_ROOT, "server", "fixtures", token));
  writeFileSync(
    paths.gmailTokenFile,
    JSON.stringify({ ...tokenFixture, access_token: PLANTED, refresh_token: PLANTED }),
  );
  writeFileSync(paths.serviceAccountFile, JSON.stringify({ private_key: PLANTED }));
  writeFileSync(
    paths.settingsFile,
    JSON.stringify({ ...readJson(paths.settingsExample), sheetId: `${PLANTED}-sheet` }),
  );
  mkdirSync(path.dirname(waCredsFile(paths)), { recursive: true });
  writeFileSync(waCredsFile(paths), JSON.stringify({ noiseKey: PLANTED }));
  // An (empty, never executed) claude binary on PATH.
  const bin = path.join(paths.privateDir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, process.platform === "win32" ? "claude.exe" : "claude"), "");
  return { TYPESAFE_API_KEY: PLANTED, PATH: bin };
}

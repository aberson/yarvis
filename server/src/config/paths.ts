// Resolves the private/ directory and the files the server keeps there (plan §3.3, §5, D32).
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root: this file lives at <repo>/server/{src,dist}/config/paths.{ts,js}. */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

export const DEFAULT_SERVER_PORT = 8787;
export const DEFAULT_WEB_PORT = 5173;

export interface Paths {
  repoRoot: string;
  /** Resolved private dir: YARVIS_PRIVATE_DIR, else <repo>/private/fake in fake mode, else <repo>/private. */
  privateDir: string;
  settingsFile: string;
  /** Tracked repo-root template; the read-only fallback when settings.json is absent. */
  settingsExample: string;
  envFile: string;
  /** Google service-account key for the Sheets writer (D6). Never read by any log/print path. */
  serviceAccountFile: string;
  /** Desktop OAuth client JSON (operator download) read by `yarvis gmail:auth`. Never printed. */
  oauthClientFile: string;
  /** Read-only Gmail token minted by `yarvis gmail:auth` (plan §5). Never printed. */
  gmailTokenFile: string;
  stateFile: string;
  cacheDir: string;
  lockFile: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

export function isFakeMode(env: Env = process.env): boolean {
  return env.YARVIS_FAKE === "1";
}

export function resolvePaths(env: Env = process.env, repoRoot: string = REPO_ROOT): Paths {
  const override = env.YARVIS_PRIVATE_DIR?.trim();
  const privateDir = override
    ? path.resolve(repoRoot, override)
    : isFakeMode(env)
      ? path.join(repoRoot, "private", "fake")
      : path.join(repoRoot, "private");
  return {
    repoRoot,
    privateDir,
    settingsFile: path.join(privateDir, "settings.json"),
    settingsExample: path.join(repoRoot, "settings.example.json"),
    envFile: path.join(privateDir, ".env"),
    serviceAccountFile: path.join(privateDir, "service-account.json"),
    oauthClientFile: path.join(privateDir, "google-oauth-client.json"),
    gmailTokenFile: path.join(privateDir, "gmail-token.json"),
    stateFile: path.join(privateDir, "state.json"),
    cacheDir: path.join(privateDir, "cache"),
    lockFile: path.join(privateDir, "refresh.lock"),
  };
}

/** Parses a TCP port env var; throws on anything but an integer in [0, 65535]. */
export function parsePort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`${name} must be an integer port in [0, 65535], got "${value}"`);
  }
  return n;
}

/** Server port (PORT, default 8787) and the web port the Host guard also accepts (YARVIS_WEB_PORT, default 5173). */
export function resolvePorts(env: Env = process.env): { serverPort: number; webPort: number } {
  return {
    serverPort: parsePort(env.PORT, DEFAULT_SERVER_PORT, "PORT"),
    webPort: parsePort(env.YARVIS_WEB_PORT, DEFAULT_WEB_PORT, "YARVIS_WEB_PORT"),
  };
}

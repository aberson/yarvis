// Loads <privateDir>/.env (plan §5): called by main.ts and cli.ts at startup, before any client is
// constructed. An absent file is not an error (the seam is then "not configured"). Never logs values.
import { existsSync } from "node:fs";
import dotenv from "dotenv";
import type { Paths } from "./paths.js";

export function loadPrivateEnv(paths: Paths): boolean {
  if (!existsSync(paths.envFile)) return false;
  dotenv.config({ path: paths.envFile, quiet: true });
  return true;
}

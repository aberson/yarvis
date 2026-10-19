// True when the module at `importMetaUrl` is the process entry script (node or tsx).
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function canonical(p: string): string {
  let resolved = path.resolve(p);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // keep the resolved path
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isMainModule(
  importMetaUrl: string,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) return false;
  const self = canonical(fileURLToPath(importMetaUrl));
  const entry = canonical(argv1);
  if (entry === self) return true;
  // `node server/dist/main` (no extension) resolves to main.js
  return path.extname(entry) === "" && canonical(`${argv1}${path.extname(self)}`) === self;
}

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export default function globalTeardown(): void {
  const dir = process.env.YARVIS_E2E_PRIVATE_DIR;
  // Only ever remove the temp dir this run created.
  if (!dir || !path.basename(dir).startsWith("yarvis-e2e-")) return;
  if (path.dirname(path.resolve(dir)) !== path.resolve(tmpdir())) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort: the server may still hold a handle on Windows
  }
}

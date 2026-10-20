// Stub `claude` executable for extract.test.ts (run as `node claude-stub.mjs <claude args...>` via
// the extractor's injected binary path + binaryArgs). Never contacts any service.
//   STUB_CAPTURE      file to write {argv, stdin, cwd} (hang mode: {pid, grandchildPid, argv})
//   STUB_STDOUT_FILE  file whose bytes are written to stdout
//   STUB_STDOUT       literal stdout (used when STUB_STDOUT_FILE is unset)
//   STUB_EXIT         exit code (default 0)
//   STUB_MODE=hang    spawn a long-lived grandchild, then never exit (timeout/tree-kill test)
//   STUB_MODE=hold-pipes  like hang, but the grandchild inherits this stub's stdout/stderr (so it
//                     keeps the pipes open after the stub itself is killed) and runs from the OS
//                     temp dir (so it does not pin the seam's neutral cwd)
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const argv = process.argv.slice(2);
const capture = process.env.STUB_CAPTURE;

const mode = process.env.STUB_MODE;
if (mode === "hang" || mode === "hold-pipes") {
  const holdPipes = mode === "hold-pipes";
  // On Windows, libuv puts non-detached children in a kill-on-close job, so they would die with
  // this stub anyway and a parent-only kill would pass vacuously. A detached grandchild escapes the
  // job (like a real descendant that outlives its parent) but is still in the PID tree taskkill /T
  // walks. On POSIX it stays in this stub's process group, which is what process.kill(-pid) hits.
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: holdPipes ? ["ignore", "inherit", "inherit"] : "ignore",
    cwd: holdPipes ? tmpdir() : undefined,
    windowsHide: true,
    detached: process.platform === "win32",
  });
  if (capture) {
    writeFileSync(
      capture,
      JSON.stringify({ pid: process.pid, grandchildPid: grandchild.pid, argv }),
    );
  }
  setInterval(() => {}, 1000);
} else {
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    const stdin = Buffer.concat(chunks).toString("utf8");
    if (capture) writeFileSync(capture, JSON.stringify({ argv, stdin, cwd: process.cwd() }));
    const file = process.env.STUB_STDOUT_FILE;
    const out = file ? readFileSync(file) : Buffer.from(process.env.STUB_STDOUT ?? "", "utf8");
    process.stdout.write(out, () => process.exit(Number(process.env.STUB_EXIT ?? "0")));
  });
}

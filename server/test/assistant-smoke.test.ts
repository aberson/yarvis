// `npm run smoke:assistant` exit-status guard (plan Step 12): the script's status is fail-closed, so a
// run that never settles, rejects or reports failure can never leave the process at exit code 0.
import { describe, expect, it } from "vitest";
import { runFailClosed } from "../scripts/assistant-smoke.js";

describe("runFailClosed", () => {
  it("is non-zero while the run is pending (a never-settling run exits 1)", () => {
    const proc: { exitCode?: number | string | null } = {};
    void runFailClosed(() => new Promise<number>(() => undefined), proc);
    expect(proc.exitCode).toBe(1);
  });

  it("lowers to 0 only when the run resolves 0", async () => {
    const proc: { exitCode?: number | string | null } = {};
    await runFailClosed(() => Promise.resolve(0), proc);
    expect(proc.exitCode).toBe(0);
  });

  it("keeps a reported failure and maps a rejection to 1", async () => {
    const failed: { exitCode?: number | string | null } = {};
    await runFailClosed(() => Promise.resolve(1), failed);
    expect(failed.exitCode).toBe(1);
    const threw: { exitCode?: number | string | null } = {};
    await runFailClosed(() => Promise.reject(new Error("boom")), threw);
    expect(threw.exitCode).toBe(1);
  });
});

// ai/decide.ts (plan §4, §3.4 reason format, D1, D2, D16, D20): quarantine at >= threshold on ANY
// security score, a quarantined message is never actionable, thresholds come from settings.
import { describe, expect, it } from "vitest";
import type { JevScores, JevThresholds } from "@yarvis/shared";
import { decide, JEV_ERROR_REASON, thresholdsFrom, type JevOutcome } from "../src/ai/decide.js";
import { loadSettings } from "../src/config/settings.js";
import { FakeJev, loadFixtureMessages } from "../src/fakes/jev.js";
import { tempPaths } from "./helpers.js";

const msg = { id: "gmail:abc" };
const T: JevThresholds = { quarantine: 0.5, action: 0.6 };
const clean: JevScores = { phishing: 0.1, malicious: 0.1, spam: 0.1, action: 0.1 };

describe("decide", () => {
  it("uses the thresholds from settings (D1 defaults 0.5 / 0.6)", async () => {
    const { paths, cleanup } = tempPaths();
    try {
      const settings = await loadSettings(paths);
      expect(thresholdsFrom(settings)).toEqual({ quarantine: 0.5, action: 0.6 });
      expect(thresholdsFrom(settings)).toBe(settings.jev.thresholds);
    } finally {
      cleanup();
    }
  });

  it("quarantines at exactly >= 0.5 and never marks a quarantined message actionable (grid)", () => {
    // 0.4999 / 0.5 pin the inclusive quarantine boundary on every security score.
    const grid = [0, 0.25, 0.4999, 0.5, 0.6, 0.99, 1];
    for (const p of grid)
      for (const m of grid)
        for (const s of grid)
          for (const a of grid) {
            const d = decide(msg, { phishing: p, malicious: m, spam: s, action: a }, T);
            expect(d.quarantined).toBe(Math.max(p, m, s) >= 0.5);
            if (d.quarantined) expect(d.actionable).toBe(false);
            else expect(d.actionable).toBe(a >= 0.6);
          }
  });

  it("formats the reason in fixed order phishing, malicious, spam with two decimals", () => {
    const d = decide(msg, { phishing: 0.9, malicious: 0.1, spam: 0.7, action: 0.9 }, T);
    expect(d.reason).toBe("phishing≥0.50,spam≥0.50");
    const all = decide(
      msg,
      { phishing: 1, malicious: 1, spam: 1, action: 1 },
      {
        quarantine: 0.35,
        action: 0.6,
      },
    );
    expect(all.reason).toBe("phishing≥0.35,malicious≥0.35,spam≥0.35");
    expect(decide(msg, clean, T).reason).toBe("");
  });

  it("actionable at action >= threshold when not quarantined", () => {
    expect(decide(msg, { ...clean, action: 0.6 }, T)).toEqual({
      quarantined: false,
      actionable: true,
      reason: "",
    });
    expect(decide(msg, { ...clean, action: 0.59 }, T).actionable).toBe(false);
  });

  it("re-applies new thresholds to the same raw scores (D16)", () => {
    const scores: JevScores = { phishing: 0.55, malicious: 0, spam: 0, action: 0.8 };
    expect(decide(msg, scores, T)).toMatchObject({ quarantined: true, actionable: false });
    expect(decide(msg, scores, { quarantine: 0.7, action: 0.6 })).toMatchObject({
      quarantined: false,
      actionable: true,
    });
  });

  it("a per-message Jev error is never actionable; quarantined as jev_error after 3 attempts", () => {
    expect(decide(msg, { error: "HTTP 400", attempts: 1 }, T)).toEqual({
      quarantined: false,
      actionable: false,
      reason: "",
    });
    expect(decide(msg, { error: "HTTP 400", attempts: 2 }, T).actionable).toBe(false);
    expect(decide(msg, { error: "HTTP 400", attempts: 3 }, T)).toEqual({
      quarantined: true,
      actionable: false,
      reason: JEV_ERROR_REASON,
    });
  });

  it("fails closed on invalid scores (NaN, out of range, missing)", () => {
    for (const bad of [
      { ...clean, phishing: Number.NaN },
      { ...clean, spam: 2 },
      { phishing: 0, malicious: 0, spam: 0 } as unknown as JevScores,
    ]) {
      expect(decide(msg, bad, T)).toEqual({
        quarantined: true,
        actionable: false,
        reason: JEV_ERROR_REASON,
      });
    }
  });

  it("fails closed on a missing or corrupt cached outcome instead of throwing", () => {
    const failClosed = { quarantined: true, actionable: false, reason: JEV_ERROR_REASON };
    for (const bad of [
      null,
      undefined,
      "garbage",
      42,
      [],
      [0.1, 0.1, 0.1, 0.1],
      { error: "HTTP 400" },
      { error: "HTTP 400", attempts: "3" },
      { error: "HTTP 400", attempts: Number.NaN },
      { error: "HTTP 400", attempts: -1 },
    ]) {
      expect(decide(msg, bad as unknown as JevOutcome, T)).toEqual(failClosed);
    }
  });

  it("routes the synthetic fixtures: clean -> neither, phishing -> quarantined, actionable -> actionable", async () => {
    const fixtures = loadFixtureMessages();
    const jev = new FakeJev();
    const route = async (k: keyof typeof fixtures) =>
      decide(fixtures[k], await jev.classify(fixtures[k]), T);
    expect(await route("clean")).toEqual({ quarantined: false, actionable: false, reason: "" });
    const phishing = await route("phishing");
    expect(phishing.quarantined).toBe(true);
    expect(phishing.actionable).toBe(false); // its has_action_item (0.88) is discarded
    expect(phishing.reason).toMatch(/^phishing≥0\.50/);
    expect(await route("actionable")).toEqual({ quarantined: false, actionable: true, reason: "" });
  });
});

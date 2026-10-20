// FakeJev / FakeClaude (plan §5, D11) and the Step 3 synthetic fixtures (§1.2).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JEV_SCORE_KEYS } from "@yarvis/shared";
import { JevMessageRejected, JevServiceError } from "../src/ai/jev.js";
import { buildExtractPrompt } from "../src/ai/extract.js";
import { CLAUDE_RESPONSES_FILE, FakeClaude, loadClaudeSeed } from "../src/fakes/claude.js";
import {
  FAKE_DEFAULT_SCORES,
  FakeJev,
  FIXTURE_MESSAGES_FILE,
  FIXTURE_ROLES,
  JEV_SCORES_FILE,
  loadFixtureMessages,
  loadJevSeed,
} from "../src/fakes/jev.js";

const fixtures = loadFixtureMessages();

describe("synthetic fixtures (§1.2)", () => {
  it("has one clean, one phishing and one actionable message", () => {
    expect(Object.keys(fixtures).sort()).toEqual([...FIXTURE_ROLES].sort());
    expect(fixtures.clean.source).toBe("gmail");
    expect(fixtures.phishing.source).toBe("gmail");
  });

  it("uses only example.com addresses/links and 1555555xxxx JIDs", () => {
    for (const file of [FIXTURE_MESSAGES_FILE, JEV_SCORES_FILE, CLAUDE_RESPONSES_FILE]) {
      const text = readFileSync(file, "utf8");
      for (const email of text.match(/[\w.+-]+@[\w.-]+/g) ?? []) {
        expect(email).toMatch(/@(?:[\w-]+\.)*example\.com$|^1555555\d{4}@s\.whatsapp\.net$/);
      }
      for (const url of text.match(/https?:\/\/[^\s"]+/g) ?? []) {
        expect(url).toMatch(/^https?:\/\/(?:[\w-]+\.)*(?:example\.com|mail\.google\.com)\//);
      }
    }
  });

  it("every fixture message has seeded Jev scores", () => {
    const seed = loadJevSeed();
    for (const m of Object.values(fixtures)) expect(seed[m.id]).toBeDefined();
  });
});

describe("FakeJev", () => {
  it("returns the seeded scores in the shared shape and records calls", async () => {
    const jev = new FakeJev();
    const s = await jev.classify(fixtures.phishing);
    expect(Object.keys(s).sort()).toEqual([...JEV_SCORE_KEYS].sort());
    expect(s).toEqual(loadJevSeed()[fixtures.phishing.id]);
    expect(jev.calls.map((m) => m.id)).toEqual([fixtures.phishing.id]);
  });

  it("an unseeded id scores clean; 'reject' is a per-message rejection; outage fails closed", async () => {
    const jev = new FakeJev({ "gmail:bad": "reject" });
    await expect(jev.classify({ ...fixtures.clean, id: "gmail:new" })).resolves.toEqual(
      FAKE_DEFAULT_SCORES,
    );
    await expect(jev.classify({ ...fixtures.clean, id: "gmail:bad" })).rejects.toBeInstanceOf(
      JevMessageRejected,
    );
    jev.setOutage();
    await expect(jev.classify(fixtures.clean)).rejects.toBeInstanceOf(JevServiceError);
    jev.clearOutage();
    await expect(jev.classify({ ...fixtures.clean, id: "gmail:new" })).resolves.toBeDefined();
  });
});

describe("FakeClaude", () => {
  it("returns seeded actions through the production envelope parser and logs the prompt", async () => {
    const claude = new FakeClaude();
    const r = await claude.extract(fixtures.actionable);
    expect(r).toEqual({ status: "done", actions: loadClaudeSeed()[fixtures.actionable.id] });
    expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0]?.prompt).toBe(buildExtractPrompt(fixtures.actionable));
  });

  it("a missing id -> none; 'fail' -> pending", async () => {
    const claude = new FakeClaude({ "gmail:f": "fail" });
    await expect(claude.extract(fixtures.clean)).resolves.toEqual({ status: "none", actions: [] });
    const failed = await claude.extract({ ...fixtures.clean, id: "gmail:f" });
    expect(failed.status).toBe("pending");
  });
});

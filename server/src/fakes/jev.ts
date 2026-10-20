// FakeJev (plan §5, D11): the in-memory Jev used by fake mode and tests. Seeded from
// server/fixtures/jev-scores.json `{[messageId]: {phishing, malicious, spam, action} | "reject"}`
// ("reject" = a per-message 4xx). A message id missing from the seed scores as clean and
// non-actionable. It records every classified message and can be switched to a service-level
// outage to exercise the fail-closed path (D3). Also loads the Step 3 synthetic message fixtures.
import { readFileSync } from "node:fs";
import path from "node:path";
import { JEV_SCORE_KEYS, type JevScores, type Message } from "@yarvis/shared";
import { JevMessageRejected, JevServiceError, type Jev } from "../ai/jev.js";
import { FIXTURES_DIR } from "./sheets.js";

export const JEV_SCORES_FILE = path.join(FIXTURES_DIR, "jev-scores.json");
export const FIXTURE_MESSAGES_FILE = path.join(FIXTURES_DIR, "messages.json");

/** The three synthetic messages (§1.2): example.com addresses, 1555555xxxx JIDs, invented text. */
export const FIXTURE_ROLES = ["clean", "phishing", "actionable"] as const;
export type FixtureRole = (typeof FIXTURE_ROLES)[number];

export type JevSeed = Record<string, JevScores | "reject">;

/** Scores for a message id absent from the seed: clean, not actionable. */
export const FAKE_DEFAULT_SCORES: Readonly<JevScores> = Object.freeze({
  phishing: 0,
  malicious: 0,
  spam: 0,
  action: 0,
});

function isScores(v: unknown): v is JevScores {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    Object.keys(r).length === JEV_SCORE_KEYS.length &&
    JEV_SCORE_KEYS.every((k) => typeof r[k] === "number" && r[k] >= 0 && r[k] <= 1)
  );
}

export function loadJevSeed(file: string = JEV_SCORES_FILE): JevSeed {
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${file}: expected {[messageId]: scores | "reject"}`);
  }
  const seed: JevSeed = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === "reject") seed[id] = "reject";
    else if (isScores(v)) seed[id] = { ...v };
    else throw new Error(`${file}: bad entry for ${id}`);
  }
  return seed;
}

export function loadFixtureMessages(
  file: string = FIXTURE_MESSAGES_FILE,
): Record<FixtureRole, Message> {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Record<FixtureRole, Message>>;
  for (const role of FIXTURE_ROLES) {
    if (typeof raw[role]?.id !== "string") throw new Error(`${file}: missing "${role}" message`);
  }
  return raw as Record<FixtureRole, Message>;
}

export class FakeJev implements Jev {
  /** Every message passed to `classify`, in call order. */
  readonly calls: Message[] = [];
  private outage: string | undefined;

  constructor(private readonly seed: JevSeed = loadJevSeed()) {}

  /** Every later call fails with a service-level JevServiceError until `clearOutage()`. */
  setOutage(reason = "fake jev outage"): void {
    this.outage = reason;
  }

  clearOutage(): void {
    this.outage = undefined;
  }

  classify(message: Message): Promise<JevScores> {
    this.calls.push(structuredClone(message));
    if (this.outage !== undefined) return Promise.reject(new JevServiceError(this.outage, 503));
    const entry = this.seed[message.id];
    if (entry === "reject") {
      return Promise.reject(
        new JevMessageRejected("jev rejected the message (HTTP 400): fake reject", 400),
      );
    }
    return Promise.resolve({ ...(entry ?? FAKE_DEFAULT_SCORES) });
  }
}

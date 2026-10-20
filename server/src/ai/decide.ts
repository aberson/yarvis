// Routing (plan §4, §3.4 reason format, D1, D2, D16, D20). Pure: re-run over EVERY cached decision
// each refresh from the CURRENT thresholds, so a threshold change re-applies at no API cost.
//   quarantined = max(phishing, malicious, spam) >= thresholds.quarantine
//   actionable  = !quarantined && action >= thresholds.action
// A quarantined message is NEVER actionable (its has_action_item score is discarded), so quarantined
// content never reaches the generating model. Anything that is not a valid score set or a valid
// error record (null, a non-object, a corrupt cache entry, bad `attempts`) fails closed: jev_error.
import {
  JEV_SCORE_KEYS,
  SECURITY_SCORE_KEYS,
  type JevScores,
  type JevThresholds,
  type Message,
  type Settings,
} from "@yarvis/shared";
import { JEV_MAX_ATTEMPTS, type JevErrorRecord } from "./jev.js";

export interface Decision {
  quarantined: boolean;
  actionable: boolean;
  /** `phishing≥0.50,spam≥0.50` (fixed order, two decimals), `jev_error`, or "" (§3.4). */
  reason: string;
}

/** What the decisions cache holds for a message's Jev step: raw scores or a per-message error. */
export type JevOutcome = JevScores | JevErrorRecord;

export const JEV_ERROR_REASON = "jev_error";

/** The routing thresholds come from settings (D1), never from constants here. */
export function thresholdsFrom(settings: Settings): JevThresholds {
  return settings.jev.thresholds;
}

const FAIL_CLOSED: Decision = { quarantined: true, actionable: false, reason: JEV_ERROR_REASON };

function isObject<T>(v: T): v is T & object {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isErrorRecord(outcome: JevOutcome): outcome is JevErrorRecord {
  return typeof (outcome as Partial<JevErrorRecord>).error === "string";
}

function isValidScore(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

/**
 * Routes one message. `message` is accepted for the pipeline's call shape; v0 applies the same
 * rules to both sources (D5), so routing reads only the scores and thresholds.
 */
export function decide(
  _message: Pick<Message, "id">,
  outcome: JevOutcome | null | undefined,
  thresholds: JevThresholds,
): Decision {
  // Unscreenable (missing or corrupt cache record): fail closed.
  if (!isObject(outcome)) return { ...FAIL_CLOSED };
  if (isErrorRecord(outcome)) {
    const attempts: unknown = outcome.attempts; // runtime value of a cache record: may be garbage
    if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 0) {
      return { ...FAIL_CLOSED };
    }
    // A per-message Jev failure is never extracted; after 3 attempts it is quarantined (D20).
    const quarantined = attempts >= JEV_MAX_ATTEMPTS;
    return { quarantined, actionable: false, reason: quarantined ? JEV_ERROR_REASON : "" };
  }
  if (!JEV_SCORE_KEYS.every((k) => isValidScore(outcome[k]))) return { ...FAIL_CLOSED };
  const crossed = SECURITY_SCORE_KEYS.filter((k) => outcome[k] >= thresholds.quarantine);
  if (crossed.length > 0) {
    const t = thresholds.quarantine.toFixed(2);
    return {
      quarantined: true,
      actionable: false,
      reason: crossed.map((k) => `${k}≥${t}`).join(","),
    };
  }
  return { quarantined: false, actionable: outcome.action >= thresholds.action, reason: "" };
}

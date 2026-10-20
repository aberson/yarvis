// The refresh error vocabulary (server/src/pipeline/errors.ts): every error class maps to a FIXED,
// content-free phrase through the production stageErrorText; raw library / request text planted in
// the message or the cause never appears.
import { describe, expect, it } from "vitest";
import { JevServiceError } from "../src/ai/jev.js";
import { SettingsError } from "../src/config/settings.js";
import { GmailError } from "../src/connectors/gmail.js";
import { SheetsError } from "../src/connectors/sheets.js";
import { WaLoggedOut } from "../src/connectors/whatsapp.js";
import { JsonlError } from "../src/pipeline/cache.js";
import { stageErrorText } from "../src/pipeline/errors.js";
import { StateError } from "../src/pipeline/state.js";
import { TimeoutError } from "../src/util/retry.js";

/** Stands in for message content / tokens a library error could echo. */
const RAW = "PLANTED Maya soccer ya29.secret-token body";
const httpCause = (status: number) => Object.assign(new Error(`${RAW} (${status})`), { status });

const CASES: Array<[string, unknown, string]> = [
  [
    "whatsapp logged out",
    new WaLoggedOut("logged_out"),
    "relink required (run yarvis wa:link --reset)",
  ],
  [
    "whatsapp not linked",
    new WaLoggedOut("not_linked"),
    "whatsapp not linked (run yarvis wa:link)",
  ],
  [
    "gmail auth (invalid_grant)",
    new GmailError("auth", RAW, { cause: httpCause(401) }),
    "gmail auth expired (run yarvis gmail:auth)",
  ],
  [
    "gmail not connected",
    new GmailError("not_configured", RAW),
    "gmail not connected (run yarvis gmail:auth)",
  ],
  [
    "gmail token scope refused",
    new GmailError("scope_refused", RAW),
    "gmail token refused: not read-only (run yarvis gmail:auth)",
  ],
  [
    "gmail token unreadable",
    new GmailError("token_invalid", RAW),
    "gmail token unreadable (run yarvis gmail:auth)",
  ],
  [
    "gmail HTTP failure",
    new GmailError("upstream", RAW, { cause: httpCause(500) }),
    "gmail unavailable (HTTP 500)",
  ],
  [
    "gmail rate limit outlasting its waits",
    new GmailError("rate_limited", RAW, { cause: httpCause(429) }),
    "gmail rate limited (HTTP 429)",
  ],
  [
    "gmail timeout",
    new GmailError("upstream", RAW, { cause: new TimeoutError(30_000) }),
    "gmail timed out",
  ],
  ["jev HTTP failure", new JevServiceError(RAW, 503), "jev unavailable (HTTP 503)"],
  ["jev without status", new JevServiceError(RAW), "jev unavailable"],
  [
    "jev not configured",
    new JevServiceError(`jev not configured: ${RAW}`),
    "jev not configured (TYPESAFE_API_KEY)",
  ],
  ["jev timeout", new JevServiceError("jev call timed out after 30000 ms"), "jev timed out"],
  [
    "sheets HTTP failure",
    new SheetsError("upstream", RAW, { cause: httpCause(429) }),
    "sheets error (HTTP 429)",
  ],
  [
    "sheets timeout",
    new SheetsError("upstream", RAW, { cause: new TimeoutError(30_000) }),
    "sheets timed out",
  ],
  [
    "sheets not configured",
    new SheetsError("not_configured", RAW),
    "sheets not configured (set sheetId and service-account.json)",
  ],
  [
    "sheets header mismatch",
    new SheetsError("header_mismatch", RAW),
    "sheets header mismatch (fix the tab's header row)",
  ],
  [
    "settings invalid",
    new SettingsError(`C:\\Users\\someone\\private\\settings.json`, RAW),
    "settings invalid (check settings.json)",
  ],
  [
    "jsonl corrupt",
    new JsonlError(`/home/someone/private/cache/messages.jsonl`, 7),
    "cache file corrupt (messages.jsonl line 7; delete private/cache to rebuild)",
  ],
  [
    "state corrupt",
    new StateError(`/home/someone/private/state.json`),
    "cursor file corrupt (delete state.json to re-fetch)",
  ],
  [
    "unexpected error with an errno code",
    Object.assign(new Error(RAW), { code: "ENOSPC" }),
    "unexpected error (ENOSPC)",
  ],
  [
    "unexpected error with a non-errno code",
    Object.assign(new TypeError(RAW), { code: RAW }),
    "unexpected error",
  ],
  ["thrown non-Error value", RAW, "unexpected error"],
];

describe("stageErrorText", () => {
  it.each(CASES)("%s -> a fixed phrase", (_label, err, phrase) => {
    const text = stageErrorText(err);
    expect(text).toBe(phrase);
    expect(text).not.toMatch(/PLANTED|Maya|ya29|someone/);
  });
});

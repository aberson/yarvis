// The refresh error vocabulary (plan §4 "actionable message", D20, D23). Every error text that leaves
// the process (GET /api/refresh/status, `yarvis refresh` output, server logs) is one of these FIXED
// phrases, parameterised only by an HTTP status, a count, a cache file name or a line number. Raw
// library / HTTP error text is never used: it can echo a request (message sender, subject, body) or
// a response body. GmailError.cause is only inspected for its numeric status, never printed.
import path from "node:path";
import { JevServiceError } from "../ai/jev.js";
import { SettingsError } from "../config/settings.js";
import { GmailError } from "../connectors/gmail.js";
import { SheetsError } from "../connectors/sheets.js";
import { WaLoggedOut } from "../connectors/whatsapp.js";
import { httpStatusOf, TimeoutError } from "../util/retry.js";
import { JsonlError } from "./cache.js";
import { StateError } from "./state.js";

const withStatus = (base: string, status: number | undefined): string =>
  status === undefined ? base : `${base} (HTTP ${status})`;

function gmailText(err: GmailError): string {
  switch (err.kind) {
    case "not_configured":
      return "gmail not connected (run yarvis gmail:auth)";
    case "auth":
      return "gmail auth expired (run yarvis gmail:auth)";
    case "scope_refused":
      return "gmail token refused: not read-only (run yarvis gmail:auth)";
    case "token_invalid":
      return "gmail token unreadable (run yarvis gmail:auth)";
    case "upstream":
      return err.cause instanceof TimeoutError
        ? "gmail timed out"
        : withStatus("gmail unavailable", httpStatusOf(err.cause));
  }
}

function sheetsText(err: SheetsError): string {
  switch (err.kind) {
    case "not_configured":
      return "sheets not configured (set sheetId and service-account.json)";
    case "header_mismatch":
      return "sheets header mismatch (fix the tab's header row)";
    case "upstream":
      return err.cause instanceof TimeoutError
        ? "sheets timed out"
        : withStatus("sheets error", httpStatusOf(err.cause));
  }
}

function jevText(err: JevServiceError): string {
  // Prefixes of JevServiceError messages built by ai/jev.ts itself (constant text, never data).
  if (err.message.startsWith("jev not configured")) return "jev not configured (TYPESAFE_API_KEY)";
  if (err.message.startsWith("jev call timed out")) return "jev timed out";
  return withStatus("jev unavailable", err.status);
}

/** The fixed, content-free one-line text for a stage or job failure. */
export function stageErrorText(err: unknown): string {
  if (err instanceof WaLoggedOut) {
    return err.reason === "not_linked"
      ? "whatsapp not linked (run yarvis wa:link)"
      : "relink required (run yarvis wa:link --reset)";
  }
  if (err instanceof GmailError) return gmailText(err);
  if (err instanceof JevServiceError) return jevText(err);
  if (err instanceof SheetsError) return sheetsText(err);
  if (err instanceof SettingsError) return "settings invalid (check settings.json)";
  if (err instanceof JsonlError) {
    return `cache file corrupt (${path.basename(err.file)} line ${err.line}; delete private/cache to rebuild)`;
  }
  if (err instanceof StateError) return "cursor file corrupt (delete state.json to re-fetch)";
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const errno = typeof code === "string" && /^E[A-Z]+$/.test(code) ? ` (${code})` : "";
  return `unexpected error${errno}`;
}

/** The error of the stage running when the job ceiling (D20) ended the job. */
export const STAGE_TIMEOUT_ERROR = "stage timeout";

/** Per-item failures on a stage that otherwise finished (the stage stays `done`). */
export const jevRejectedText = (n: number): string =>
  `jev rejected ${n} message${n === 1 ? "" : "s"}`;
export const extractionPendingText = (n: number): string =>
  `extraction pending for ${n} message${n === 1 ? "" : "s"} (retried next refresh)`;

/** `yarvis doctor` probe outcomes that are not thrown errors (plan §5, D24). */
export const JEV_PROBE_MISMATCH =
  "jev scores off (phishing fixture below thresholds.quarantine, or clean fixture quarantined)";
export const CLAUDE_PROBE_PENDING = "claude extraction failed (check claude -p login)";
export const CLAUDE_PROBE_NO_ACTIONS = "claude parsed 0 actions";

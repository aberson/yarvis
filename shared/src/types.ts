// Shared types between server and web (plan §3.2, §3.4, §5, §6, §12.1).
// Todo / QuarantineItem are DERIVED from the pinned header tuples in ./sheet.ts (never declared
// separately), so a header column without a field cannot exist. RefreshStatus lands with the
// pipeline (Step 6).
import type { ExtractionStatus, QuarantineColumn, TodoColumn, TodoStatus } from "./sheet.js";

export type Source = "whatsapp" | "gmail";

/**
 * One string field per header column `C`, with typed overrides `O` (whose keys must be columns).
 * Every column of the header is a key of the result, and nothing else is.
 */
export type RowOf<
  C extends string,
  O extends { [K in keyof O]: K extends C ? unknown : never } = Record<never, never>,
> = { [K in C]: K extends keyof O ? O[K] : string };

/** One row of the Todos tab (§3.4): `<message id>#<n>` keyed. */
export type Todo = RowOf<
  TodoColumn,
  {
    source: Source;
    status: TodoStatus;
    extraction_status: ExtractionStatus;
    /** Jev `has_action_item` noul in [0, 1]. */
    jev_action: number;
  }
>;

/** One row of the Quarantine tab (§3.4): message-id keyed. Scores are null for `jev_error` rows. */
export type QuarantineItem = RowOf<
  QuarantineColumn,
  {
    source: Source;
    jev_phishing: number | null;
    jev_malicious: number | null;
    jev_spam: number | null;
  }
>;

/** `PATCH /api/todos/:id` body (update-only; writes `status` + `updated_at`). */
export interface TodoPatch {
  status: TodoStatus;
}

/** `GET /api/todos?status=` filter (default open). */
export const TODO_FILTERS = ["open", "done", "all"] as const;
export type TodoFilter = (typeof TODO_FILTERS)[number];

/** Normalized message (plan §3.2). */
export interface Message {
  /** `gmail:<hex id>` or `wa:<remoteJid>:<key.id>` (plan §3.1). */
  id: string;
  source: Source;
  /** Gmail: From address; WhatsApp: pushName, else participant JID, else remoteJid (D30). */
  sender: string;
  /** Gmail subject | WhatsApp chat display name. */
  context: string;
  /** WhatsApp remoteJid (absent for Gmail). */
  chatId?: string;
  /** ISO 8601 UTC. */
  date: string;
  /** Plain-text body, trimmed to 4000 chars for storage. */
  text: string;
  /** Extracted http(s) URLs. */
  links: string[];
  /** Deep link (Gmail web URL; WhatsApp "" in v0). */
  link: string;
}

export interface AllowlistEntry {
  jid: string;
  name: string;
}

/** `private/settings.json` and repo-root `settings.example.json` (plan §12.1). */
export interface Settings {
  sheetId: string;
  pirate: boolean;
  /** `YYYY-MM-DD`, read as 00:00:00Z that day; first-run floor for Gmail and WhatsApp. */
  since: string;
  whatsapp: {
    allowlist: AllowlistEntry[];
  };
  jev: {
    model: string;
    concurrency: number;
    thresholds: {
      quarantine: number;
      action: number;
    };
  };
  extract: {
    model: string;
    timeoutMs: number;
  };
}

/** `GET /api/settings` response: the full settings object plus the resolved private dir. */
export type SettingsResponse = Settings & { privateDir: string };

/** `PATCH /api/settings` body: only `pirate` is writable from the UI in v0. */
export interface SettingsPatch {
  pirate?: boolean;
}

/** `GET /api/health` response. */
export interface HealthResponse {
  ok: true;
  fake: boolean;
}

/**
 * Every error code the API returns: the plan §6 4xx codes, plus the 5xx codes that reuse the same
 * body shape: `settings_invalid` (500, private settings.json fails validation),
 * `sheets_not_configured` (503, no sheetId / service-account.json), `sheets_error` (502, the
 * Sheets API failed after retries, timed out, or a tab header does not match) and `internal` (500).
 */
export const API_ERROR_CODES = [
  "bad_host",
  "missing_x_yarvis",
  "bad_id",
  "not_found",
  "bad_request",
  "settings_invalid",
  "sheets_not_configured",
  "sheets_error",
  "internal",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Every 4xx/5xx error body: `{error, message?}`. */
export interface ApiErrorBody {
  error: ApiErrorCode;
  message?: string;
}

/** Header every mutating request must carry (D22). */
export const X_YARVIS_HEADER = "X-Yarvis";
export const X_YARVIS_VALUE = "1";

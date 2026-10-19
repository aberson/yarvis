// Shared types between server and web (plan §3.2, §5, §6, §12.1).
// Step 1 owns Source, Message, Settings and the API envelope types. Todo / QuarantineItem are
// derived from the pinned sheet headers in shared/src/sheet.ts (Step 2) and RefreshStatus lands
// with the pipeline (Step 6); they are intentionally not declared here yet.

export type Source = "whatsapp" | "gmail";

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
 * Every error code the API returns: the plan §6 4xx codes, plus the two 500 codes
 * (`settings_invalid` = private settings.json fails validation, `internal` = anything unexpected)
 * that reuse the same body shape.
 */
export const API_ERROR_CODES = [
  "bad_host",
  "missing_x_yarvis",
  "bad_id",
  "not_found",
  "bad_request",
  "settings_invalid",
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

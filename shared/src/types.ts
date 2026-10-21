// Shared types between server and web (plan §3.2, §3.4, §5, §6, §12.1).
// Todo / QuarantineItem are DERIVED from the pinned header tuples in ./sheet.ts (never declared
// separately), so a header column without a field cannot exist. RefreshStatus is the §4 job
// status shape served by GET /api/refresh/status.
import type { LogoId } from "./logos.js";
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
  /** Header logo (D39); absent in older files, read as DEFAULT_LOGO. */
  logo: LogoId;
  /**
   * Fetch floor for Gmail and WhatsApp: `YYYY-MM-DD` (read as 00:00:00Z that day) or an exact UTC
   * instant `YYYY-MM-DDTHH:MM[:SS]Z` (D38). Parsed only by `sinceEpochMs` (since.ts).
   */
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

/**
 * Jev security score keys, in the FIXED order used by `decide().reason` and the Quarantine
 * `reason` column (§3.4): phishing, malicious, spam.
 */
export const SECURITY_SCORE_KEYS = ["phishing", "malicious", "spam"] as const;
export type SecurityScoreKey = (typeof SECURITY_SCORE_KEYS)[number];

/** Every Jev score key: the three security questions plus `action` (has_action_item). */
export const JEV_SCORE_KEYS = [...SECURITY_SCORE_KEYS, "action"] as const;
export type JevScoreKey = (typeof JEV_SCORE_KEYS)[number];

/**
 * Raw Jev scores for one message (§4, §12.2): each is a noul probability in [0, 1]. THE one shape
 * for scores: the classifier, `decide()`, the fakes and the decisions cache all use it.
 */
export type JevScores = Record<JevScoreKey, number>;

/** Routing thresholds (settings `jev.thresholds`, D1). */
export type JevThresholds = Settings["jev"]["thresholds"];

/** `GET /api/settings` response: the full settings object plus the resolved private dir. */
export type SettingsResponse = Settings & { privateDir: string };

/** `PATCH /api/settings` body: only `pirate` and `logo` are writable from the UI. */
export interface SettingsPatch {
  pirate?: boolean;
  logo?: LogoId;
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
 * Assistant (S1): `assistant_busy` (409, another assistant run holds the lock or the store is
 * contended; retryable), `revision_conflict` (409, a request id reused with different input),
 * `assistant_unavailable` (503, the assistant store is corrupt/newer/unopenable or the server is
 * closing; Todos stay usable) and `source_unavailable` (503, a source could not be verified).
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
  "assistant_busy",
  "revision_conflict",
  "assistant_unavailable",
  "source_unavailable",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Every 4xx/5xx error body: `{error, message?}`. */
export interface ApiErrorBody {
  error: ApiErrorCode;
  message?: string;
}

/** The refresh stages, in run order (plan §4): whatsapp -> gmail -> jev -> extract -> sheets. */
export const REFRESH_STAGES = ["whatsapp", "gmail", "jev", "extract", "sheets"] as const;
export type RefreshStage = (typeof REFRESH_STAGES)[number];

export const STAGE_STATES = ["pending", "running", "done", "error", "skipped"] as const;
export type StageState = (typeof STAGE_STATES)[number];

export const REFRESH_STATES = ["idle", "running", "done", "partial", "error"] as const;
export type RefreshState = (typeof REFRESH_STATES)[number];

/**
 * One stage of a refresh job. `count` = items the stage processed (whatsapp/gmail: messages
 * fetched; jev: messages scored; extract: extractions completed; sheets: rows upserted).
 */
export interface StageStatus {
  state: StageState;
  count: number;
  /**
   * A fixed, content-free phrase (server/src/pipeline/errors.ts): why an `error` stage failed, or
   * the per-item failures of a `done` stage (e.g. "jev rejected 1 message"). Never message content,
   * library error text or private/ values.
   */
  error?: string;
}

/** `GET /api/refresh/status` (plan §4, §6). */
export interface RefreshStatus {
  state: RefreshState;
  stages: Record<RefreshStage, StageStatus>;
  /** ISO 8601 UTC; null when idle. */
  startedAt: string | null;
  /** ISO 8601 UTC; null when idle or not yet finished. */
  finishedAt: string | null;
  /** A job-level failure outside any stage (e.g. invalid settings); absent otherwise. */
  error?: string;
}

/** `POST /api/refresh` 202 body. */
export interface RefreshStarted {
  jobId: string;
}

/** `POST /api/refresh` 409 body (a job is running in this or another process, D19). */
export interface RefreshConflict {
  running: true;
}

/** Header every mutating request must carry (D22). */
export const X_YARVIS_HEADER = "X-Yarvis";
export const X_YARVIS_VALUE = "1";

/** The five external seams (plan §5), in Connected apps / `yarvis doctor` order. */
export const SEAMS = ["gmail", "whatsapp", "sheets", "jev", "claude"] as const;
export type Seam = (typeof SEAMS)[number];

/**
 * One seam in `GET /api/status` (plan §6). `configured` comes from files present / env set only
 * (no live probe; that is `yarvis doctor`). `lastSuccessAt` (ISO 8601 UTC) and `lastError` (a fixed
 * content-free phrase from server/src/pipeline/errors.ts) come from the refresh jobs' stages.
 */
export interface SeamStatus {
  configured: boolean;
  lastSuccessAt?: string;
  lastError?: string;
}

/** `GET /api/status` response. */
export type StatusResponse = Record<Seam, SeamStatus>;

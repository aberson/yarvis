// The Google Sheet layout (plan §3.4, D7, D18): tab names, the pinned header rows and the column
// ownership rule. THE one source of truth for these data-shape constants: the server connector, the
// fakes, the derived `Todo` / `QuarantineItem` types (types.ts) and the tests all import them from
// here, never redeclare them.

export const TODOS_TAB = "Todos";
export const QUARANTINE_TAB = "Quarantine";

/** Header row of the Todos tab, in column order (A..M). */
export const TODO_HEADER = [
  "id",
  "source",
  "status",
  "action",
  "extraction_status",
  "original_text",
  "sender",
  "context",
  "message_date",
  "link",
  "jev_action",
  "created_at",
  "updated_at",
] as const;

/** Header row of the Quarantine tab, in column order (A..L). */
export const QUARANTINE_HEADER = [
  "id",
  "source",
  "sender",
  "context",
  "message_date",
  "link",
  "jev_phishing",
  "jev_malicious",
  "jev_spam",
  "reason",
  "created_at",
  "released_at",
] as const;

export type TodoColumn = (typeof TODO_HEADER)[number];
export type QuarantineColumn = (typeof QUARANTINE_HEADER)[number];

export const TODO_STATUSES = ["open", "done"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export const EXTRACTION_STATUSES = ["done", "pending", "none"] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

/**
 * Column ownership (§3.4, D18): cells an upsert of an EXISTING row never overwrites once they hold a
 * value. In Todos the operator/UI owns `status` and `created_at` is write-once; the pipeline owns
 * every other column. In Quarantine `created_at` is write-once.
 */
export const TODO_PRESERVED_ON_UPSERT = [
  "status",
  "created_at",
] as const satisfies readonly TodoColumn[];
export const QUARANTINE_PRESERVED_ON_UPSERT = [
  "created_at",
] as const satisfies readonly QuarantineColumn[];

/** "Open sheet" URL for a spreadsheet id (§12.1). */
export function sheetUrl(sheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/edit`;
}

/** True when `sheetId` looks like a real spreadsheet id (not empty, not the `<...>` placeholder). */
export function isSheetIdConfigured(sheetId: string): boolean {
  return /^[A-Za-z0-9_-]{10,}$/.test(sheetId.trim());
}

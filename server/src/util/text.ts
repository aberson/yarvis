// Message-text helpers shared by the source connectors (plan §3.2, D14): the 4000-char storage cap
// and http(s) link extraction, plus the one-line bounded error text the AI seams record (Step 3).
// One definition so Gmail (Step 4), WhatsApp (Step 5) and the AI seams cannot drift.

/** `Message.text` is trimmed to this many characters (UTF-16 code units) for storage (D14). */
export const MESSAGE_TEXT_MAX_CHARS = 4000;

/**
 * Caps `text` at `max` UTF-16 code units without splitting a surrogate pair: when the cut would
 * land between the two halves of an astral code point, that whole code point is dropped. The
 * result is always at most `max` long (empty when `max <= 0`) and never ends in a lone high
 * surrogate.
 */
export function truncateText(text: string, max: number = MESSAGE_TEXT_MAX_CHARS): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max);
  if (end > 0) {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
  }
  return text.slice(0, end);
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`{}|\\^[\]]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"*_~]+$/;

/** Every distinct http(s) URL in `text`, in first-seen order, with trailing punctuation removed. */
export function extractLinks(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, "");
    if (/^https?:\/\/./i.test(url) && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/** Normalizes line endings, trims trailing spaces per line and collapses runs of blank lines. */
export function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\xa0]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Max characters of error text kept in a pending/jev error string. */
export const MAX_ERROR_CHARS = 200;

/** Any thrown value as one bounded line (whitespace collapsed, ellipsis when cut). */
export function oneLineError(err: unknown, max: number = MAX_ERROR_CHARS): string {
  const text = err instanceof Error ? err.message : String(err);
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${truncateText(oneLine, max)}…` : oneLine;
}

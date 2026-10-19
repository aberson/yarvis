// Display helpers shared by the Todos and Quarantine pages. Formatting only; data is never altered.

/** Only http(s) links become anchors (sheet cells are operator-editable). */
export function safeHref(link: string): string | null {
  return /^https?:\/\//i.test(link.trim()) ? link.trim() : null;
}

/** Local date-time for an ISO timestamp; the raw value when it does not parse. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return iso && !Number.isNaN(d.getTime()) ? d.toLocaleString() : iso;
}

export function formatScore(score: number | null, none: string): string {
  return score === null ? none : score.toFixed(2);
}

/** Quarantine reasons are comma-joined rules ("phishing≥0.50,spam≥0.50"); space them so they wrap. */
export function formatReason(reason: string): string {
  return reason
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(", ");
}

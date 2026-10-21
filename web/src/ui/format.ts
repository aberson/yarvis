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

/** Fills `{name}` placeholders of a string-table template. */
export function fill(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** Relative age of an ISO timestamp at `nowMs`, with the string table's templates. */
export function formatAge(
  iso: string,
  nowMs: number,
  t: { ageJustNow: string; ageMinutes: string; ageHours: string; ageDays: string },
): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const minutes = Math.floor(Math.max(0, nowMs - then) / 60_000);
  if (minutes < 1) return t.ageJustNow;
  if (minutes < 60) return fill(t.ageMinutes, { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return fill(t.ageHours, { n: hours });
  return fill(t.ageDays, { n: Math.floor(hours / 24) });
}

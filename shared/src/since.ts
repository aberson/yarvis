// `settings.since` (plan §3.3, D21, D38): the fetch floor for both sources. Either a calendar day
// `YYYY-MM-DD` (read as 00:00:00Z) or an exact UTC instant `YYYY-MM-DDTHH:MM[:SS[.sss]]Z` (a clean
// slate "from now on"). THE one parser: settings validation, the Gmail cursor and the refresh
// pipeline's WhatsApp floor all call it, never re-derive it.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;

/** Whether `since` has one of the two accepted shapes (it may still name an impossible date). */
export function isSinceShape(since: string): boolean {
  return DAY.test(since) || INSTANT.test(since);
}

/**
 * Epoch milliseconds of `since`, or null when it is malformed or names an impossible date or time.
 * Round-trip guard: Date.parse rolls impossible days over (2026-02-30 -> 2026-03-02), which would
 * silently move the floor; the parsed UTC date must give back the same Y-M-D.
 */
export function sinceEpochMs(since: string): number | null {
  const day = DAY.test(since) ? since : INSTANT.exec(since)?.[1];
  if (day === undefined) return null;
  const ms = Date.parse(day === since ? `${since}T00:00:00Z` : since);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day) return null;
  return ms;
}

// settings.since (D38): one parser for a calendar day or an exact UTC instant.
import { describe, expect, it } from "vitest";
import { isSinceShape, sinceEpochMs } from "../src/since.js";
import { DEFAULT_LOGO, LOGO_IDS } from "../src/logos.js";

describe("sinceEpochMs", () => {
  it("reads a day as 00:00:00Z", () => {
    expect(sinceEpochMs("2026-10-01")).toBe(Date.UTC(2026, 9, 1));
  });

  it.each([
    ["2026-10-20T22:40Z", Date.UTC(2026, 9, 20, 22, 40)],
    ["2026-10-20T22:40:15Z", Date.UTC(2026, 9, 20, 22, 40, 15)],
    ["2026-10-20T22:40:15.250Z", Date.UTC(2026, 9, 20, 22, 40, 15, 250)],
  ])("reads the instant %s exactly", (since, ms) => {
    expect(isSinceShape(since)).toBe(true);
    expect(sinceEpochMs(since)).toBe(ms);
  });

  it.each(["2026-02-30", "2026-13-01", "2026-02-30T10:00Z", "2026-10-20T25:00Z"])(
    "rejects the impossible %s (no silent roll-over)",
    (since) => {
      expect(isSinceShape(since)).toBe(true);
      expect(sinceEpochMs(since)).toBeNull();
    },
  );

  it.each(["Oct 1", "2026-10-20T22:40", "2026-10-20T22:40+02:00", "2026-10-20 22:40Z", ""])(
    "rejects the malformed %j",
    (since) => {
      expect(isSinceShape(since)).toBe(false);
      expect(sinceEpochMs(since)).toBeNull();
    },
  );
});

describe("LOGO_IDS", () => {
  it("are unique and include the default", () => {
    expect(new Set(LOGO_IDS).size).toBe(LOGO_IDS.length);
    expect(LOGO_IDS.length).toBe(10);
    expect(LOGO_IDS).toContain(DEFAULT_LOGO);
  });
});

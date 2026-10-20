// util/text.ts: caps that never split a surrogate pair, and the one-line bounded error text.
import { describe, expect, it } from "vitest";
import { MAX_ERROR_CHARS, oneLineError, truncateText } from "../src/util/text.js";

const EMOJI = "\u{1F600}"; // two UTF-16 units

describe("truncateText", () => {
  it("keeps short text and cuts long text to the cap", () => {
    expect(truncateText("abc", 5)).toBe("abc");
    expect(truncateText("abcdef", 3)).toBe("abc");
  });

  it("drops a pair that would be cut in half, keeps one that fits", () => {
    expect(truncateText(`ab${EMOJI}c`, 3)).toBe("ab");
    expect(truncateText(`ab${EMOJI}c`, 4)).toBe(`ab${EMOJI}`);
    expect(truncateText(EMOJI, 1)).toBe("");
  });
});

describe("oneLineError", () => {
  it("collapses whitespace, bounds the length, never leaves a lone surrogate", () => {
    expect(oneLineError(new Error("a\n  b"))).toBe("a b");
    const long = `${"x".repeat(MAX_ERROR_CHARS - 1)}${EMOJI}tail`;
    expect(oneLineError(long)).toBe(`${"x".repeat(MAX_ERROR_CHARS - 1)}…`);
  });
});

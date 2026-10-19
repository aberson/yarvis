import path from "node:path";
import { describe, expect, it } from "vitest";
import { isFakeMode, parsePort, resolvePaths, resolvePorts } from "../src/config/paths.js";

const ROOT = path.resolve("/repo");

describe("resolvePaths", () => {
  it("fake mode isolates to <repo>/private/fake (D32)", () => {
    const p = resolvePaths({ YARVIS_FAKE: "1" }, ROOT);
    expect(p.privateDir).toBe(path.join(ROOT, "private", "fake"));
    expect(p.settingsFile).toBe(path.join(ROOT, "private", "fake", "settings.json"));
  });

  it("YARVIS_PRIVATE_DIR overrides both modes (relative paths resolve against the repo)", () => {
    const abs = path.resolve("/elsewhere/p");
    expect(resolvePaths({ YARVIS_PRIVATE_DIR: abs }, ROOT).privateDir).toBe(abs);
    expect(resolvePaths({ YARVIS_PRIVATE_DIR: abs, YARVIS_FAKE: "1" }, ROOT).privateDir).toBe(abs);
    expect(resolvePaths({ YARVIS_PRIVATE_DIR: "tmp/p" }, ROOT).privateDir).toBe(
      path.join(ROOT, "tmp", "p"),
    );
  });

  it("only YARVIS_FAKE=1 turns fake mode on", () => {
    expect(isFakeMode({ YARVIS_FAKE: "1" })).toBe(true);
    expect(isFakeMode({ YARVIS_FAKE: "true" })).toBe(false);
    expect(isFakeMode({})).toBe(false);
  });
});

describe("ports", () => {
  it("honours PORT and YARVIS_WEB_PORT", () => {
    expect(resolvePorts({ PORT: "8797", YARVIS_WEB_PORT: "5183" })).toEqual({
      serverPort: 8797,
      webPort: 5183,
    });
  });
  it("rejects garbage ports", () => {
    expect(() => parsePort("abc", 1, "PORT")).toThrow(/PORT/);
    expect(() => parsePort("70000", 1, "PORT")).toThrow(/PORT/);
    expect(parsePort("", 42, "PORT")).toBe(42);
  });
});

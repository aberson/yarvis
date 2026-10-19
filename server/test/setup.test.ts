import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { runSetup } from "../src/setup.js";
import { tempPaths } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("npm run setup (runSetup)", () => {
  it("creates cache/, settings.json from the example and .env with an empty TYPESAFE_API_KEY", async () => {
    const { paths, cleanup } = tempPaths();
    cleanups.push(cleanup);
    const result = await runSetup(paths);
    expect(result.created.sort()).toEqual(
      [paths.cacheDir, paths.envFile, paths.settingsFile].sort(),
    );
    expect(statSync(paths.cacheDir).isDirectory()).toBe(true);
    expect(readFileSync(paths.settingsFile, "utf8")).toBe(
      readFileSync(paths.settingsExample, "utf8"),
    );
    expect(readFileSync(paths.envFile, "utf8")).toBe("TYPESAFE_API_KEY=\n");
  });

  it("is idempotent and never overwrites an existing file", async () => {
    const { paths, cleanup } = tempPaths();
    cleanups.push(cleanup);
    await runSetup(paths);
    writeFileSync(paths.settingsFile, '{"edited":true}');
    writeFileSync(paths.envFile, "TYPESAFE_API_KEY=operator-value\n");
    const again = await runSetup(paths);
    expect(again.created).toEqual([]);
    expect(again.kept.length).toBe(3);
    expect(readFileSync(paths.settingsFile, "utf8")).toBe('{"edited":true}');
    expect(readFileSync(paths.envFile, "utf8")).toBe("TYPESAFE_API_KEY=operator-value\n");
    expect(existsSync(paths.cacheDir)).toBe(true);
  });
});

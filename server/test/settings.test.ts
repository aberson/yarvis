// Settings loader / validator / writer (plan §5, §12.1) and GET/PATCH /api/settings (plan §6).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";
import {
  loadSettingsWithSource,
  parseSettings,
  parseSettingsPatch,
  patchSettings,
  SettingsError,
} from "../src/config/settings.js";
import { DEFAULT_LOGO } from "@yarvis/shared";
import { tempPaths } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function fresh(opts: { seedSettings?: boolean } = {}) {
  const t = tempPaths(opts);
  cleanups.push(t.cleanup);
  return t.paths;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

const BOM = String.fromCharCode(0xfeff);

describe("settings.example.json", () => {
  it("parses under the §12.1 schema with pirate off", () => {
    const paths = fresh();
    const s = parseSettings(readJson(paths.settingsExample), paths.settingsExample);
    expect(s.pirate).toBe(false);
    expect(s.logo).toBe(DEFAULT_LOGO);
    expect(s.jev.thresholds.quarantine).toBeLessThanOrEqual(s.jev.thresholds.action);
  });
});

describe("parseSettings", () => {
  const example = () => {
    const paths = fresh();
    return readJson(paths.settingsExample) as Record<string, unknown>;
  };
  const jev = (concurrency: number, quarantine: number) => ({
    model: "jev-latest",
    concurrency,
    thresholds: { quarantine, action: 0.6 },
  });

  it.each<[string, (base: Record<string, unknown>) => unknown]>([
    ["unknown key", (b) => ({ ...b, extra: 1 })],
    ["missing key", (b) => ({ ...b, pirate: undefined })],
    ["impossible since date", (b) => ({ ...b, since: "2026-13-40" })],
    ["since not a day", (b) => ({ ...b, since: "Oct 1" })],
    ["since instant without Z", (b) => ({ ...b, since: "2026-10-20T22:40" })],
    ["impossible since instant", (b) => ({ ...b, since: "2026-10-20T25:00Z" })],
    ["unknown logo", (b) => ({ ...b, logo: "parrot" })],
    ["threshold out of range", (b) => ({ ...b, jev: jev(2, 2) })],
    ["non-integer concurrency", (b) => ({ ...b, jev: jev(1.5, 0.5) })],
  ])("rejects %s with a SettingsError naming the file", (_label, mutate) => {
    const raw = mutate(example());
    expect(() => parseSettings(raw, "x/settings.json")).toThrow(SettingsError);
    expect(() => parseSettings(raw, "x/settings.json")).toThrow(/x\/settings\.json/);
  });

  it("accepts an exact UTC instant for since (D38)", () => {
    const s = parseSettings({ ...example(), since: "2026-10-20T22:40:00Z" }, "x/settings.json");
    expect(s.since).toBe("2026-10-20T22:40:00Z");
  });

  it("reads a file without logo as DEFAULT_LOGO (D39)", () => {
    const { logo: _omit, ...rest } = example();
    expect(parseSettings(rest, "x/settings.json").logo).toBe(DEFAULT_LOGO);
  });
});

describe("parseSettingsPatch", () => {
  it("accepts {pirate:boolean}, {logo} and {}", () => {
    expect(parseSettingsPatch({ pirate: true })).toEqual({ pirate: true });
    expect(parseSettingsPatch({ logo: "kraken-ring" })).toEqual({ logo: "kraken-ring" });
    expect(parseSettingsPatch({})).toEqual({});
  });
  // Rejections are covered once, through the production route: see the PATCH 400 it.each below.
});

describe("loadSettings", () => {
  it("falls back to settings.example.json when private settings.json is absent, without creating it", async () => {
    const paths = fresh();
    const { settings, source } = await loadSettingsWithSource(paths);
    expect(source).toBe("example");
    expect(settings.pirate).toBe(false);
    expect(existsSync(paths.settingsFile)).toBe(false);
  });

  it("prefers private settings.json and validates it", async () => {
    const paths = fresh({ seedSettings: true });
    const raw = readJson(paths.settingsFile) as Record<string, unknown>;
    writeFileSync(paths.settingsFile, JSON.stringify({ ...raw, pirate: true }));
    const { settings, source } = await loadSettingsWithSource(paths);
    expect(source).toBe("private");
    expect(settings.pirate).toBe(true);
  });

  it("tolerates a UTF-8 BOM (PowerShell-edited file)", async () => {
    const paths = fresh({ seedSettings: true });
    writeFileSync(paths.settingsFile, BOM + readFileSync(paths.settingsFile, "utf8"));
    await expect(loadSettingsWithSource(paths)).resolves.toMatchObject({ source: "private" });
  });

  it("rejects malformed private settings.json", async () => {
    const paths = fresh({ seedSettings: true });
    writeFileSync(paths.settingsFile, "{not json");
    await expect(loadSettingsWithSource(paths)).rejects.toThrow(SettingsError);
  });
});

describe("patchSettings", () => {
  it("creates settings.json from the example on first PATCH and leaves no temp files", async () => {
    const paths = fresh();
    const s = await patchSettings(paths, { pirate: true });
    expect(s.pirate).toBe(true);
    expect(readJson(paths.settingsFile)).toEqual(s);
    expect(readdirSync(paths.privateDir)).toEqual(["settings.json"]);
  });

  it("serializes concurrent patches (last one wins, file stays valid)", async () => {
    const paths = fresh({ seedSettings: true });
    await Promise.all([
      patchSettings(paths, { pirate: true }),
      patchSettings(paths, { pirate: false }),
      patchSettings(paths, { pirate: true }),
    ]);
    expect((readJson(paths.settingsFile) as { pirate: boolean }).pirate).toBe(true);
    expect(readdirSync(paths.privateDir)).toEqual(["settings.json"]);
  });
});

describe("GET/PATCH /api/settings", () => {
  const HOST = "127.0.0.1:5173"; // the configured web port is always an allowed Host

  it("GET returns the settings plus the resolved private dir", async () => {
    const paths = fresh({ seedSettings: true });
    const app = createApp({ paths, fake: false, webPort: 5173 });
    const res = await request(app).get("/api/settings").set("Host", HOST);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      pirate: false,
      since: "2026-10-01",
      privateDir: paths.privateDir,
    });
  });

  it("PATCH {pirate:true} persists to private settings.json and round-trips through GET", async () => {
    const paths = fresh({ seedSettings: true });
    const before = readJson(paths.settingsFile) as Record<string, unknown>;
    const app = createApp({ paths, fake: false, webPort: 5173 });

    const res = await request(app)
      .patch("/api/settings")
      .set("Host", HOST)
      .set("X-Yarvis", "1")
      .send({ pirate: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...before, pirate: true });
    expect(res.body).not.toHaveProperty("privateDir");
    expect(readJson(paths.settingsFile)).toEqual({ ...before, pirate: true });
    expect(readdirSync(paths.privateDir)).toEqual(["settings.json"]);

    const get = await request(app).get("/api/settings").set("Host", HOST);
    expect((get.body as { pirate: boolean }).pirate).toBe(true);

    const back = await request(app)
      .patch("/api/settings")
      .set("Host", HOST)
      .set("X-Yarvis", "1")
      .send({ pirate: false });
    expect((back.body as { pirate: boolean }).pirate).toBe(false);
    expect(readJson(paths.settingsFile)).toEqual(before);
  });

  it("PATCH {logo} persists to private settings.json and round-trips through GET", async () => {
    const paths = fresh({ seedSettings: true });
    const before = readJson(paths.settingsFile) as Record<string, unknown>;
    const app = createApp({ paths, fake: false, webPort: 5173 });
    const res = await request(app)
      .patch("/api/settings")
      .set("Host", HOST)
      .set("X-Yarvis", "1")
      .send({ logo: "helm-wheel" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...before, logo: "helm-wheel" });
    expect(readJson(paths.settingsFile)).toEqual({ ...before, logo: "helm-wheel" });
    const get = await request(app).get("/api/settings").set("Host", HOST);
    expect((get.body as { logo: string }).logo).toBe("helm-wheel");
  });

  it.each([
    ["non-boolean pirate", { pirate: "yes" }],
    ["unknown logo", { logo: "parrot" }],
    ["non-writable key", { sheetId: "abc" }],
    ["array body", []],
  ])("PATCH with %s returns 400 bad_request and does not write", async (_label, body) => {
    const paths = fresh();
    const app = createApp({ paths, fake: false, webPort: 5173 });
    const res = await request(app)
      .patch("/api/settings")
      .set("Host", HOST)
      .set("X-Yarvis", "1")
      .send(body);
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("bad_request");
    expect(existsSync(paths.settingsFile)).toBe(false);
  });

  it("PATCH with malformed JSON returns 400 bad_request", async () => {
    const paths = fresh();
    const app = createApp({ paths, fake: false, webPort: 5173 });
    const res = await request(app)
      .patch("/api/settings")
      .set("Host", HOST)
      .set("X-Yarvis", "1")
      .set("Content-Type", "application/json")
      .send("{oops");
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("bad_request");
  });

  it("GET reports an invalid private settings.json as a 500 naming the problem", async () => {
    const paths = fresh({ seedSettings: true });
    writeFileSync(paths.settingsFile, JSON.stringify({ pirate: true }));
    const app = createApp({ paths, fake: false, webPort: 5173 });
    const res = await request(app).get("/api/settings").set("Host", HOST);
    expect(res.status).toBe(500);
    expect((res.body as { error: string }).error).toBe("settings_invalid");
  });
});

// GET /api/status through the production entry point (createApp), plan §6, D24: configured flags
// from files/env only (no probe), lastSuccessAt/lastError from the refresh jobs' stages.
import { writeFileSync } from "node:fs";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { SEAMS, type RefreshStatus, type StatusResponse } from "@yarvis/shared";
import type { Paths } from "../src/config/paths.js";
import { createApp } from "../src/index.js";
import { DisconnectReason } from "../src/connectors/whatsapp.js";
import { OPEN_STEP, type FakeWhatsAppOptions } from "../src/fakes/whatsapp.js";
import { RefreshRunner } from "../src/pipeline/job.js";
import { createFakeSeams } from "../src/pipeline/seams.js";
import { PLANTED, plantPrivate, tempPaths } from "./helpers.js";

const HOST = "127.0.0.1:5173";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** The app over a refresh runner it is handed (so tests can await the job). */
function makeApp(
  paths: Paths,
  opts: { fake: boolean; env: Record<string, string>; whatsapp?: FakeWhatsAppOptions },
) {
  const seams = createFakeSeams({
    whatsapp: opts.whatsapp,
    waWindow: { quietMs: 20, maxMs: 2_000 },
  });
  const runner = new RefreshRunner({ paths, ...seams }, { log: false });
  const app = createApp({
    paths,
    fake: opts.fake,
    webPort: 5173,
    sheets: seams.sheets,
    refreshRunner: runner,
    env: opts.env,
  });
  return { app, runner, seams };
}

function temp(): Paths {
  const t = tempPaths({ seedSettings: true });
  cleanups.push(t.cleanup);
  return t.paths;
}

const getStatus = async (app: ReturnType<typeof createApp>) => {
  const res = await request(app).get("/api/status").set("Host", HOST);
  expect(res.status).toBe(200);
  return res;
};

async function refresh(app: ReturnType<typeof createApp>, runner: RefreshRunner) {
  const res = await request(app).post("/api/refresh").set("Host", HOST).set("X-Yarvis", "1");
  expect(res.status).toBe(202);
  return (await runner.running) as RefreshStatus;
}

describe("GET /api/status", () => {
  it("reports configured from files and env only: no probe of any seam, no private value", async () => {
    const paths = temp();
    // The app is handed the FULL seam set (as production wires it): any probe would hit a fake.
    const withSeams = (env: Record<string, string>) => {
      const seams = createFakeSeams();
      return { seams, app: createApp({ paths, fake: false, webPort: 5173, seams, env }) };
    };
    const bare = withSeams({});
    const empty = (await getStatus(bare.app)).body as StatusResponse;
    expect(Object.keys(empty)).toEqual([...SEAMS]);
    for (const seam of SEAMS) expect(empty[seam]).toEqual({ configured: false });

    const planted = withSeams(plantPrivate(paths));
    const res = await getStatus(planted.app);
    for (const seam of SEAMS) {
      expect((res.body as StatusResponse)[seam]).toEqual({ configured: true });
    }
    expect(res.text).not.toContain(PLANTED);

    for (const { seams } of [bare, planted]) {
      expect(seams.fakes.gmail.api.calls).toEqual([]);
      expect(seams.jev.calls).toEqual([]);
      expect(seams.extractor.calls).toEqual([]);
      expect(seams.fakes.sheets?.api.calls).toEqual([]);
      expect(seams.fakes.whatsapp.sockets).toEqual([]);
    }
  });

  it("whatsapp.lastError reflects a WaLoggedOut stage, keeps the earlier success, clears on success", async () => {
    const paths = temp();
    plantPrivate(paths); // fake mode ignores them; the body must still never carry one
    const { app, runner } = makeApp(paths, {
      fake: true,
      env: {},
      whatsapp: { scripts: [[OPEN_STEP], [{ close: DisconnectReason.loggedOut }], [OPEN_STEP]] },
    });

    const first = await refresh(app, runner);
    expect(first.state).toBe("done");
    const second = await refresh(app, runner);
    expect(second.state).toBe("partial");
    const res = await getStatus(app);
    const afterSecond = res.body as StatusResponse;
    expect(afterSecond.whatsapp).toEqual({
      configured: true,
      lastSuccessAt: first.finishedAt,
      lastError: "relink required (run yarvis wa:link --reset)",
    });
    for (const seam of ["gmail", "sheets", "jev", "claude"] as const) {
      expect(afterSecond[seam]).toEqual({ configured: true, lastSuccessAt: second.finishedAt });
    }
    expect(res.text).not.toContain(PLANTED);

    const third = await refresh(app, runner);
    expect(third.state).toBe("done");
    expect(((await getStatus(app)).body as StatusResponse).whatsapp).toEqual({
      configured: true,
      lastSuccessAt: third.finishedAt,
    });
  });

  it("invalid settings answer 500 settings_invalid with the fixed phrase, never the file path", async () => {
    const paths = temp();
    writeFileSync(paths.settingsFile, `{"sheetId": "${PLANTED}",`);
    const { app } = makeApp(paths, { fake: false, env: {} });

    const res = await request(app).get("/api/status").set("Host", HOST);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "settings_invalid",
      message: "settings invalid (check settings.json)",
    });
    expect(res.text).not.toContain(PLANTED);
  });
});

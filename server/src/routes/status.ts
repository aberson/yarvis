// GET /api/status (plan §6, D24): per seam `{configured, lastSuccessAt?, lastError?}`.
//   - configured: files present / env set only (pipeline/configured.ts). No live probe and no
//     network call here; live probes are `yarvis doctor`.
//   - lastSuccessAt / lastError: from the refresh jobs' stages (pipeline/activity.ts).
//   - invalid settings: 500 settings_invalid with the fixed phrase (never the settings file path).
import { Router } from "express";
import { SEAMS, type StatusResponse } from "@yarvis/shared";
import type { Env, Paths } from "../config/paths.js";
import { loadSettings, SettingsError } from "../config/settings.js";
import { sendError } from "../http.js";
import { SeamActivity } from "../pipeline/activity.js";
import { seamsConfigured } from "../pipeline/configured.js";
import { stageErrorText } from "../pipeline/errors.js";
import type { RefreshRunner } from "../pipeline/job.js";

export function statusRouter(opts: {
  paths: Paths;
  env: Env;
  fake: boolean;
  runner: RefreshRunner;
}): Router {
  const { paths, env, fake, runner } = opts;
  const activity = new SeamActivity();
  activity.record(runner.status());
  runner.onFinished((status) => activity.record(status));
  const router = Router();

  router.get("/api/status", async (_req, res) => {
    let settings;
    try {
      settings = await loadSettings(paths);
    } catch (err) {
      if (!(err instanceof SettingsError)) throw err;
      sendError(res, "settings_invalid", stageErrorText(err));
      return;
    }
    const configured = seamsConfigured({ paths, env, fake, settings });
    const body = Object.fromEntries(
      SEAMS.map((seam) => [seam, { configured: configured[seam], ...activity.get(seam) }]),
    ) as StatusResponse;
    res.set("Cache-Control", "no-store").json(body);
  });

  return router;
}

// GET/PATCH /api/settings (plan §6). Only `pirate` and `logo` are writable from the UI.
import { Router } from "express";
import type { Settings, SettingsResponse } from "@yarvis/shared";
import type { Paths } from "../config/paths.js";
import {
  loadSettings,
  parseSettingsPatch,
  patchSettings,
  SettingsPatchError,
} from "../config/settings.js";
import { sendError } from "../http.js";

export function settingsRouter(opts: { paths: Paths }): Router {
  const { paths } = opts;
  const router = Router();

  router.get("/api/settings", async (_req, res) => {
    const settings = await loadSettings(paths);
    const body: SettingsResponse = { ...settings, privateDir: paths.privateDir };
    res.json(body);
  });

  router.patch("/api/settings", async (req, res) => {
    let patch;
    try {
      patch = parseSettingsPatch(req.body as unknown);
    } catch (err) {
      if (err instanceof SettingsPatchError) {
        sendError(res, "bad_request", err.message);
        return;
      }
      throw err;
    }
    const body: Settings = await patchSettings(paths, patch);
    res.json(body);
  });

  return router;
}

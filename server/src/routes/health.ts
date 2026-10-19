import { Router } from "express";
import type { HealthResponse } from "@yarvis/shared";

export function healthRouter(opts: { fake: boolean }): Router {
  const router = Router();
  router.get("/api/health", (_req, res) => {
    const body: HealthResponse = { ok: true, fake: opts.fake };
    res.json(body);
  });
  return router;
}

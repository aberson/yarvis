// POST /api/refresh and GET /api/refresh/status (plan §4, §6, D13, D19).
//   - POST starts an in-process job: 202 {jobId}, or 409 {running:true} when a job holds
//     private/refresh.lock in this or any other process. (X-Yarvis: 1 is enforced by the guard.)
//   - GET returns the latest job's RefreshStatus (`idle` before the first job).
import { Router } from "express";
import type { RefreshConflict, RefreshStarted, RefreshStatus } from "@yarvis/shared";
import type { RefreshRunner } from "../pipeline/job.js";

export function refreshRouter(opts: { runner: RefreshRunner }): Router {
  const { runner } = opts;
  const router = Router();

  router.post("/api/refresh", async (_req, res) => {
    const result = await runner.start();
    if (result.started) {
      const body: RefreshStarted = { jobId: result.jobId };
      res.status(202).json(body);
    } else {
      const body: RefreshConflict = { running: true };
      res.status(409).json(body);
    }
  });

  router.get("/api/refresh/status", (_req, res) => {
    const body: RefreshStatus = runner.status();
    // Polled every 2 s: never answer from an HTTP cache.
    res.set("Cache-Control", "no-store").json(body);
  });

  return router;
}

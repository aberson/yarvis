// Assistant HTTP routes (plan Phase 2 / S1, S1.5 "HTTP additions"). Mounted by createApp behind the
// existing Host + X-Yarvis guards and the 64 KiB JSON body cap; errors use the `{error, message?}`
// shape with fixed, content-free messages (never stderr, credentials or filesystem paths).
//   POST /api/assistant/briefings     {requestId: UUID} -> 202 {run}; a repeated id -> its run
//   GET  /api/assistant/briefings/latest              -> 200 {briefing: Briefing | null}
//   GET  /api/assistant/runs/latest                   -> 200 {run: AssistantRun | null}
//   GET  /api/assistant/runs/:id      (UUID)          -> 200 {run}; 400 bad_id; 404 not_found
// 409 assistant_busy (another run / store contended), 409 revision_conflict (request id reused
// with different input), 503 assistant_unavailable (store corrupt/newer/closing).
import { type ErrorRequestHandler, type Response, Router } from "express";
import { z } from "zod";
import {
  isUuid,
  type LatestBriefingResponse,
  type LatestRunResponse,
  type RunResponse,
} from "@yarvis/shared";
import {
  AssistantBusyError,
  AssistantUnavailableError,
  RequestConflictError,
  type AssistantService,
} from "../assistant/service.js";
import { sendError } from "../http.js";

const StartBriefingSchema = z.strictObject({ requestId: z.string().refine(isUuid) });

function noStore(res: Response): Response {
  return res.set("Cache-Control", "no-store");
}

const assistantErrors: ErrorRequestHandler = (err: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof AssistantBusyError) {
    sendError(res, "assistant_busy", "another assistant run is in progress; try again shortly");
  } else if (err instanceof RequestConflictError) {
    sendError(res, "revision_conflict", "request id already used with different input");
  } else if (err instanceof AssistantUnavailableError) {
    sendError(res, "assistant_unavailable", "assistant storage is unavailable; Todos still work");
  } else {
    next(err);
  }
};

export function assistantRouter(opts: { service: AssistantService }): Router {
  const { service } = opts;
  const router = Router();

  router.post("/api/assistant/briefings", async (req, res) => {
    const parsed = StartBriefingSchema.safeParse(req.body as unknown);
    if (!parsed.success) {
      sendError(res, "bad_request", "body must be {requestId: UUID}");
      return;
    }
    const run = await service.startBriefing(parsed.data.requestId);
    const body: RunResponse = { run };
    noStore(res).status(202).json(body);
  });

  router.get("/api/assistant/briefings/latest", (_req, res) => {
    const body: LatestBriefingResponse = { briefing: service.latestBriefing() };
    noStore(res).json(body);
  });

  // Registered before /runs/:id so "latest" is never parsed as an id.
  router.get("/api/assistant/runs/latest", (_req, res) => {
    const body: LatestRunResponse = { run: service.latestRun() };
    noStore(res).json(body);
  });

  router.get("/api/assistant/runs/:id", (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      sendError(res, "bad_id", "not a run id (UUID)");
      return;
    }
    const run = service.getRun(id);
    if (!run) {
      sendError(res, "not_found", "no assistant run with that id");
      return;
    }
    const body: RunResponse = { run };
    noStore(res).json(body);
  });

  router.use(assistantErrors);
  return router;
}

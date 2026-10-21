// Assistant HTTP routes (plan Phase 2 / S1, S1.5 "HTTP additions"). Mounted by createApp behind the
// existing Host + X-Yarvis guards and the 64 KiB JSON body cap; errors use the `{error, message?}`
// shape with fixed, content-free messages (never stderr, credentials or filesystem paths).
//   POST /api/assistant/briefings     {requestId: UUID} -> 202 {run}; a repeated id -> its run
//   GET  /api/assistant/briefings/latest              -> 200 {briefing: Briefing | null}
//   GET  /api/assistant/runs/latest                   -> 200 {run: AssistantRun | null}
//   GET  /api/assistant/runs/:id      (UUID)          -> 200 {run}; 400 bad_id; 404 not_found
//   POST /api/assistant/preparations  {requestId, briefingId, todoId}
//                                     -> 202 {run} (source verified, composing), 200 {packet} for
//                                        a Todo that already has one (no model call)
//   GET  /api/assistant/preparations/:id (UUID)       -> 200 {packet}; 400 bad_id; 404 not_found
// 409 assistant_busy (another run / store contended), 409 revision_conflict (request id reused
// with different input; or the selected task changed / is unknown / not open / not extracted /
// quarantined: refresh and build a new briefing), 503 source_unavailable (the task could not be
// verified against the sheet), 503 assistant_unavailable (store corrupt/newer/closing).
import { type ErrorRequestHandler, type Response, Router } from "express";
import { z } from "zod";
import {
  isUuid,
  TODO_ID_MAX_CHARS,
  type LatestBriefingResponse,
  type LatestRunResponse,
  type PacketResponse,
  type RunResponse,
} from "@yarvis/shared";
import {
  AssistantBusyError,
  AssistantUnavailableError,
  RequestConflictError,
  SourceConflictError,
  SourceUnavailableError,
  type AssistantService,
} from "../assistant/service.js";
import { sendError } from "../http.js";

const StartBriefingSchema = z.strictObject({ requestId: z.string().refine(isUuid) });
const StartPreparationSchema = z.strictObject({
  requestId: z.string().refine(isUuid),
  briefingId: z.string().refine(isUuid),
  todoId: z.string().min(1).max(TODO_ID_MAX_CHARS),
});

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
  } else if (err instanceof SourceConflictError) {
    sendError(
      res,
      "revision_conflict",
      "the task changed or is not ready to prepare; refresh, then build a new briefing",
    );
  } else if (err instanceof SourceUnavailableError) {
    sendError(res, "source_unavailable", "could not check the task against the sheet; try again");
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

  router.post("/api/assistant/preparations", async (req, res) => {
    const parsed = StartPreparationSchema.safeParse(req.body as unknown);
    if (!parsed.success) {
      sendError(res, "bad_request", "body must be {requestId: UUID, briefingId: UUID, todoId}");
      return;
    }
    // Deliberately NOT aborted when the HTTP client disconnects (S1.5): the run is durable and owned
    // by the service, bounded by its 90 s deadline, and aborted only by service close (shutdown).
    // A browser that lost this response rediscovers the run via GET /api/assistant/runs/latest and
    // correlates it by requestId.
    const outcome = await service.startPreparation(parsed.data);
    if (outcome.kind === "packet") {
      const body: PacketResponse = { packet: outcome.packet };
      noStore(res).status(200).json(body);
      return;
    }
    const body: RunResponse = { run: outcome.run };
    noStore(res).status(202).json(body);
  });

  router.get("/api/assistant/preparations/:id", (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      sendError(res, "bad_id", "not a preparation id (UUID)");
      return;
    }
    const packet = service.getPacket(id);
    if (!packet) {
      sendError(res, "not_found", "no preparation with that id");
      return;
    }
    const body: PacketResponse = { packet };
    noStore(res).json(body);
  });

  router.use(assistantErrors);
  return router;
}

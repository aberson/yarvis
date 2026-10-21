// Assistant run client logic for the Briefing page (plan S1.5 "HTTP additions"), kept free of React
// so it is unit-tested directly. An additive typed wrapper: the legacy refresh poller is unchanged.
//   - pollAssistantRun: GET /api/assistant/runs/:id now, then every 2 s while `running`; reports the
//     first terminal run once. A failed poll is reported and polling continues.
//   - startOrRecover: POSTs with a request id the caller generated ONCE for the intentional action
//     (and reuses on an HTTP retry). A lost response is answered by latest-run discovery: a run
//     carrying the same request id is adopted; otherwise the caller offers an explicit Retry with
//     the same id (never a silent re-POST).
import { ASSISTANT_POLL_MS, type AssistantRun } from "@yarvis/shared";
import { ApiError, isLostResponse } from "./api.js";

export interface RunPollOptions {
  runId: string;
  fetchRun: (id: string) => Promise<AssistantRun>;
  onRun: (run: AssistantRun) => void;
  /** Called once when the run leaves `running` (after onRun). */
  onFinished: (run: AssistantRun) => void;
  onError: (err: unknown) => void;
  intervalMs?: number;
}

/** Polls at once, then every `intervalMs` while running. Returns a stop function. */
export function pollAssistantRun(opts: RunPollOptions): () => void {
  const intervalMs = opts.intervalMs ?? ASSISTANT_POLL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    try {
      const run = await opts.fetchRun(opts.runId);
      if (stopped) return;
      opts.onRun(run);
      if (run.state !== "running") {
        stopped = true;
        opts.onFinished(run);
        return;
      }
    } catch (err) {
      if (stopped) return;
      opts.onError(err);
    }
    timer = setTimeout(() => void tick(), intervalMs);
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export type StartOutcome =
  /** The server admitted (or already had) this request: follow `run`. */
  | { kind: "started"; run: AssistantRun }
  /** Another run holds the assistant; `run` is the latest one (follow it when running). */
  | { kind: "busy"; run: AssistantRun | null }
  /** No answer and no run with this request id was found: offer Retry with the SAME id. */
  | { kind: "lost" }
  /** A definitive refusal (4xx/503 with an API code). */
  | { kind: "error"; error: ApiError };

export interface StartDeps {
  start: (requestId: string) => Promise<AssistantRun>;
  latestRun: () => Promise<AssistantRun | null>;
}

export async function startOrRecover(requestId: string, deps: StartDeps): Promise<StartOutcome> {
  try {
    return { kind: "started", run: await deps.start(requestId) };
  } catch (err) {
    if (err instanceof ApiError && err.apiCode === "assistant_busy") {
      const run = await deps.latestRun().catch(() => null);
      return { kind: "busy", run };
    }
    if (isLostResponse(err)) {
      const run = await deps.latestRun().catch(() => null);
      return run && run.requestId === requestId ? { kind: "started", run } : { kind: "lost" };
    }
    return { kind: "error", error: err as ApiError };
  }
}

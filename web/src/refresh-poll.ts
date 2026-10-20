// Refresh status polling for the Todos page (plan §5, D13): GET /api/refresh/status every 2 s while
// the job is running; stops on the first state that is not running. A terminal state (done |
// partial | error) is reported via onFinished, which the page answers by re-reading the to-dos.
// A failed poll is reported and polling continues.
import type { RefreshState, RefreshStatus } from "@yarvis/shared";

export const REFRESH_POLL_MS = 2_000;

export function isTerminal(state: RefreshState): boolean {
  return state === "done" || state === "partial" || state === "error";
}

export interface PollOptions {
  fetchStatus: () => Promise<RefreshStatus>;
  onStatus: (status: RefreshStatus) => void;
  /** Called once when a terminal status arrives (after onStatus). */
  onFinished: (status: RefreshStatus) => void;
  onError: (err: unknown) => void;
  intervalMs?: number;
}

/** Polls at once, then every `intervalMs` while running. Returns a stop function. */
export function pollRefreshStatus(opts: PollOptions): () => void {
  const intervalMs = opts.intervalMs ?? REFRESH_POLL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    try {
      const status = await opts.fetchStatus();
      if (stopped) return;
      opts.onStatus(status);
      if (status.state !== "running") {
        // idle: no job in this server (e.g. one running in another process); nothing to wait for.
        stopped = true;
        if (isTerminal(status.state)) opts.onFinished(status);
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

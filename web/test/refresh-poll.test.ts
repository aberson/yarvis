// Todos page refresh polling (web/src/refresh-poll.ts, plan §5, D13): every 2 s while running,
// stop on the first non-running state, onFinished only for a terminal one. Fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefreshState, RefreshStatus } from "@yarvis/shared";
import { pollRefreshStatus, REFRESH_POLL_MS } from "../src/refresh-poll.js";

const status = (state: RefreshState): RefreshStatus =>
  ({ state, stages: {}, startedAt: null, finishedAt: null }) as unknown as RefreshStatus;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function poller(states: Array<RefreshState | Error>) {
  const queue = [...states];
  const fetchStatus = vi.fn(() => {
    const next = queue.shift() ?? "running";
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(status(next));
  });
  const seen: RefreshState[] = [];
  const onFinished = vi.fn();
  const onError = vi.fn();
  const stop = pollRefreshStatus({
    fetchStatus,
    onStatus: (s) => seen.push(s.state),
    onFinished,
    onError,
  });
  return { fetchStatus, seen, onFinished, onError, stop };
}

describe("pollRefreshStatus", () => {
  it("polls at once and every 2 s while running, then stops and reports the terminal status once", async () => {
    const p = poller(["running", "running", "partial"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(p.fetchStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFRESH_POLL_MS - 1);
    expect(p.fetchStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.fetchStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(REFRESH_POLL_MS);
    expect(p.seen).toEqual(["running", "running", "partial"]);
    expect(p.onFinished).toHaveBeenCalledTimes(1);
    expect(p.onFinished.mock.calls[0]?.[0]).toMatchObject({ state: "partial" });
    await vi.advanceTimersByTimeAsync(REFRESH_POLL_MS * 5);
    expect(p.fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("keeps polling through a failed poll, and stops without onFinished on idle", async () => {
    const p = poller([new Error("proxy down"), "idle"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(p.onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFRESH_POLL_MS);
    expect(p.seen).toEqual(["idle"]);
    await vi.advanceTimersByTimeAsync(REFRESH_POLL_MS * 5);
    expect(p.fetchStatus).toHaveBeenCalledTimes(2);
    expect(p.onFinished).not.toHaveBeenCalled();
  });

  it("an error job is terminal too: reported once, then no more polls", async () => {
    const p = poller(["running", "error"]);
    await vi.advanceTimersByTimeAsync(REFRESH_POLL_MS * 4);
    expect(p.seen).toEqual(["running", "error"]);
    expect(p.onFinished).toHaveBeenCalledTimes(1);
    expect(p.fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("stop() cancels the next poll", async () => {
    const p = poller(["running", "running"]);
    await vi.advanceTimersByTimeAsync(0);
    p.stop();
    await vi.advanceTimersByTimeAsync(REFRESH_POLL_MS * 3);
    expect(p.fetchStatus).toHaveBeenCalledTimes(1);
  });
});

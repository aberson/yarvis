// web/src/assistant-poll.ts: run polling stops on the first terminal state; startOrRecover adopts a
// lost POST's run only when its request id matches, reports busy with the latest run, and otherwise
// asks for an explicit Retry (same id) instead of re-POSTing. Plus the age/template helpers.
import { describe, expect, it, vi } from "vitest";
import type { AssistantRun, PreparationPacket } from "@yarvis/shared";
import { ApiError } from "../src/api.js";
import { pollAssistantRun, prepareOrRecover, startOrRecover } from "../src/assistant-poll.js";
import { en } from "../src/i18n/strings.js";
import { fill, formatAge } from "../src/ui/format.js";

const REQ = "60000000-0000-4000-8000-000000000001";

function run(over: Partial<AssistantRun> = {}): AssistantRun {
  return {
    id: "60000000-0000-4000-8000-0000000000aa",
    requestId: REQ,
    kind: "briefing",
    state: "running",
    createdAt: "2026-10-20T10:00:00.000Z",
    finishedAt: null,
    targetId: null,
    sourceTodoId: null,
    errorCode: null,
    model: null,
    promptVersion: null,
    ...over,
  };
}

describe("pollAssistantRun", () => {
  it("polls while running and reports the terminal run once", async () => {
    const states = [run(), run({ state: "succeeded", targetId: "t" })];
    const fetchRun = vi.fn(() => Promise.resolve(states.shift() ?? run({ state: "succeeded" })));
    const finished = vi.fn();
    pollAssistantRun({
      runId: "x",
      fetchRun,
      onRun: () => undefined,
      onFinished: finished,
      onError: () => undefined,
      intervalMs: 1,
    });
    await vi.waitFor(() => expect(finished).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchRun).toHaveBeenCalledTimes(2);
    expect(finished.mock.calls[0]?.[0]).toMatchObject({ state: "succeeded" });
  });

  it("a failed poll is reported and polling continues", async () => {
    let n = 0;
    const onError = vi.fn();
    const finished = vi.fn();
    pollAssistantRun({
      runId: "x",
      fetchRun: () =>
        n++ === 0 ? Promise.reject(new Error("net")) : Promise.resolve(run({ state: "failed" })),
      onRun: () => undefined,
      onFinished: finished,
      onError,
      intervalMs: 1,
    });
    await vi.waitFor(() => expect(finished).toHaveBeenCalled());
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("pollAssistantRun stop from onError", () => {
  it("a permanent error that stops polling inside onError schedules no further request", async () => {
    const fetchRun = vi.fn(() => Promise.reject(new ApiError(404, "not_found", "gone")));
    let stop: () => void = () => undefined;
    const onError = vi.fn(() => stop());
    stop = pollAssistantRun({
      runId: "x",
      fetchRun,
      onRun: () => undefined,
      onFinished: () => undefined,
      onError,
      intervalMs: 5,
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 40));
    expect(fetchRun).toHaveBeenCalledTimes(1);
  });
});

describe("prepareOrRecover", () => {
  const packet = { id: "p1" } as unknown as PreparationPacket;

  it("an existing packet (200) opens directly; a 202 run is followed", async () => {
    expect(
      await prepareOrRecover(REQ, {
        start: () => Promise.resolve({ packet }),
        latestRun: vi.fn(),
      }),
    ).toEqual({ kind: "packet", packet });
    const r = run({ kind: "prepare" });
    expect(
      await prepareOrRecover(REQ, { start: () => Promise.resolve({ run: r }), latestRun: vi.fn() }),
    ).toEqual({ kind: "started", run: r });
  });

  it("a lost response adopts only our own request id; refusals are definitive errors", async () => {
    const lost = () => Promise.reject(new TypeError("Failed to fetch"));
    const mine = run({ kind: "prepare" });
    expect(
      await prepareOrRecover(REQ, { start: lost, latestRun: () => Promise.resolve(mine) }),
    ).toEqual({ kind: "started", run: mine });
    expect(
      await prepareOrRecover(REQ, { start: lost, latestRun: () => Promise.resolve(null) }),
    ).toEqual({ kind: "lost" });
    const conflict = new ApiError(409, "revision_conflict", "changed");
    expect(
      await prepareOrRecover(REQ, { start: () => Promise.reject(conflict), latestRun: vi.fn() }),
    ).toEqual({ kind: "error", error: conflict });
    const source = new ApiError(503, "source_unavailable", "x");
    expect(
      await prepareOrRecover(REQ, { start: () => Promise.reject(source), latestRun: vi.fn() }),
    ).toEqual({ kind: "error", error: source });
  });
});

describe("startOrRecover", () => {
  it("started on 202", async () => {
    const r = run();
    expect(
      await startOrRecover(REQ, { start: () => Promise.resolve(r), latestRun: vi.fn() }),
    ).toEqual({ kind: "started", run: r });
  });

  it("a lost response adopts the latest run only when the request id matches", async () => {
    const lost = () => Promise.reject(new TypeError("Failed to fetch"));
    const mine = run();
    expect(
      await startOrRecover(REQ, { start: lost, latestRun: () => Promise.resolve(mine) }),
    ).toEqual({ kind: "started", run: mine });
    const other = run({ requestId: "60000000-0000-4000-8000-000000000002" });
    expect(
      await startOrRecover(REQ, { start: lost, latestRun: () => Promise.resolve(other) }),
    ).toEqual({ kind: "lost" });
    expect(
      await startOrRecover(REQ, { start: lost, latestRun: () => Promise.reject(new Error("x")) }),
    ).toEqual({ kind: "lost" });
    // A proxy 502 without an API error code is also a lost response.
    const proxy = () => Promise.reject(new ApiError(502, "http_error", "bad gateway"));
    expect(
      await startOrRecover(REQ, { start: proxy, latestRun: () => Promise.resolve(null) }),
    ).toEqual({ kind: "lost" });
  });

  it("busy reports the latest run; an API refusal is a definitive error", async () => {
    const other = run({ requestId: "60000000-0000-4000-8000-000000000002" });
    const busy = () => Promise.reject(new ApiError(409, "assistant_busy", "busy"));
    expect(
      await startOrRecover(REQ, { start: busy, latestRun: () => Promise.resolve(other) }),
    ).toEqual({ kind: "busy", run: other });
    const unavailable = new ApiError(503, "assistant_unavailable", "x");
    const latestRun = vi.fn();
    expect(
      await startOrRecover(REQ, { start: () => Promise.reject(unavailable), latestRun }),
    ).toEqual({ kind: "error", error: unavailable });
    expect(latestRun).not.toHaveBeenCalled();
  });
});

describe("format helpers", () => {
  it("fill replaces known placeholders only", () => {
    expect(fill("{n} open {x}", { n: 3 })).toBe("3 open {x}");
  });

  it("formatAge buckets minutes, hours and days", () => {
    const now = Date.parse("2026-10-20T12:00:00.000Z");
    expect(formatAge("2026-10-20T11:59:30.000Z", now, en)).toBe(en.ageJustNow);
    expect(formatAge("2026-10-20T11:15:00.000Z", now, en)).toBe("45 min ago");
    expect(formatAge("2026-10-20T07:00:00.000Z", now, en)).toBe("5 h ago");
    expect(formatAge("2026-10-15T12:00:00.000Z", now, en)).toBe("5 d ago");
  });
});

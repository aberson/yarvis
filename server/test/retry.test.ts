// util/retry.ts (D29): the ONE retry/backoff helper (429/500/503) + the 30 s per-call timeout.
import { describe, expect, it, vi } from "vitest";
import {
  backoffDelayMs,
  callWithRetry,
  httpStatusOf,
  isRetryableHttpError,
  retryAfterMs,
  TimeoutError,
  withRetry,
  withTimeout,
} from "../src/util/retry.js";

const http = (status: number, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`HTTP ${status}`), { status }, extra);

describe("httpStatusOf / isRetryableHttpError", () => {
  it("reads status, response.status and numeric code; retries only 429/500/503", () => {
    expect(httpStatusOf(http(429))).toBe(429);
    expect(httpStatusOf({ response: { status: 503 } })).toBe(503);
    expect(httpStatusOf({ code: 500 })).toBe(500);
    expect(httpStatusOf({ code: "ECONNRESET" })).toBeUndefined();
    expect([429, 500, 503].every((s) => isRetryableHttpError(http(s)))).toBe(true);
    expect([400, 401, 403, 404, 502].some((s) => isRetryableHttpError(http(s)))).toBe(false);
    expect(isRetryableHttpError(new TimeoutError(1))).toBe(false);
  });
});

describe("withRetry", () => {
  it("retries a 429 then succeeds, with exponential backoff", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const fn = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(http(429))
      .mockRejectedValueOnce(http(503))
      .mockResolvedValueOnce("ok");
    await expect(withRetry(fn, { sleep, baseDelayMs: 100 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[100], [200]]);
  });

  it("does not retry a non-retryable error", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const fn = vi.fn(() => Promise.reject(http(403)));
    await expect(withRetry(fn, { sleep })).rejects.toMatchObject({ status: 403 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after `attempts` and rethrows the last error", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const fn = vi.fn(() => Promise.reject(http(500)));
    await expect(withRetry(fn, { sleep, attempts: 3 })).rejects.toMatchObject({ status: 500 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("honours Retry-After when longer than the backoff (capped at maxDelayMs)", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const err = http(429, { response: { status: 429, headers: { "retry-after": "3" } } });
    const fn = vi.fn<() => Promise<number>>().mockRejectedValueOnce(err).mockResolvedValueOnce(1);
    await withRetry(fn, { sleep, baseDelayMs: 100, maxDelayMs: 10_000 });
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(backoffDelayMs(10, 500, 16_000)).toBe(16_000);
  });
});

describe("withTimeout", () => {
  it("rejects with TimeoutError and aborts the signal when the call ignores it", async () => {
    let signal: AbortSignal | undefined;
    const hang = (s: AbortSignal) => {
      signal = s;
      return new Promise<never>(() => undefined);
    };
    await expect(withTimeout(hang, 20)).rejects.toBeInstanceOf(TimeoutError);
    expect(signal?.aborted).toBe(true);
  });

  it("a timeout is not retried by callWithRetry", async () => {
    const fn = vi.fn(() => new Promise<never>(() => undefined));
    await expect(
      callWithRetry(fn, { timeoutMs: 10, sleep: () => Promise.resolve() }),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("retryAfterMs", () => {
  it("reads gaxios response headers, TypeSafe APIError headers and RateLimitError.retryAfterMs", () => {
    expect(retryAfterMs({ response: { headers: { "retry-after": "2" } } })).toBe(2000);
    expect(retryAfterMs({ headers: new Headers({ "retry-after": "3" }) })).toBe(3000);
    expect(retryAfterMs({ retryAfterMs: 1500, headers: new Headers() })).toBe(1500);
    expect(retryAfterMs({ retryAfterMs: -1 })).toBeUndefined();
    expect(retryAfterMs(new Error("x"))).toBeUndefined();
  });

  it("reads the HTTP-date form as its distance from now (floored at 0); garbage stays undefined", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    const at = (value: string) =>
      retryAfterMs({ headers: new Headers({ "retry-after": value }) }, now);
    expect(at("Tue, 20 Oct 2026 12:00:07 GMT")).toBe(7_000);
    expect(at("Tue, 20 Oct 2026 11:59:00 GMT")).toBe(0);
    for (const bad of ["soon", "-1", ""]) expect(at(bad)).toBeUndefined();
  });
});

// THE one retry/backoff helper (D29): exponential backoff on HTTP 429/500/503, plus the 30 s
// per-call timeout (D20). Used by the Sheets connector (Step 2) and reused by Gmail (Step 4); do not
// add a second copy elsewhere.
import { setTimeout as delay } from "node:timers/promises";

/** HTTP statuses retried with backoff (§3.4: per-user quota 429, transient 500/503). */
export const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([429, 500, 503]);

/** Each Sheets, Gmail and Jev call has a 30 s timeout (D20). */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

export const DEFAULT_RETRY = {
  /** Total attempts, including the first. */
  attempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 16_000,
} as const;

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for tests (default: real timers). */
  sleep?: (ms: number) => Promise<void>;
  /** Default: `isRetryableHttpError`. */
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; status: number | undefined }) => void;
}

/** A call did not settle within its per-call timeout. Never retried. */
export class TimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`call timed out after ${timeoutMs} ms`);
    this.name = "TimeoutError";
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

/**
 * The HTTP status carried by an error: `err.status` (GaxiosError), `err.response.status`, or a
 * numeric `err.code` (AIP-193 API errors). Undefined for network/system errors.
 */
export function httpStatusOf(err: unknown): number | undefined {
  const e = asRecord(err);
  if (!e) return undefined;
  if (typeof e.status === "number") return e.status;
  const response = asRecord(e.response);
  if (response && typeof response.status === "number") return response.status;
  if (typeof e.code === "number") return e.code;
  if (typeof e.code === "string" && /^[1-5][0-9]{2}$/.test(e.code)) return Number(e.code);
  return undefined;
}

export function isRetryableHttpError(err: unknown): boolean {
  if (err instanceof TimeoutError) return false;
  const status = httpStatusOf(err);
  return status !== undefined && RETRYABLE_HTTP_STATUSES.has(status);
}

/**
 * The server-requested retry delay in ms; undefined when absent. Reads a numeric `err.retryAfterMs`
 * (the TypeSafe SDK's `RateLimitError`), else `Retry-After` (seconds) from `err.response.headers`
 * (gaxios) or `err.headers` (TypeSafe `APIError`).
 */
export function retryAfterMs(err: unknown): number | undefined {
  const e = asRecord(err);
  if (
    typeof e?.retryAfterMs === "number" &&
    Number.isFinite(e.retryAfterMs) &&
    e.retryAfterMs >= 0
  ) {
    return e.retryAfterMs;
  }
  const headers = asRecord(asRecord(e?.response)?.headers) ?? asRecord(e?.headers);
  if (!headers) return undefined;
  const raw =
    typeof headers.get === "function"
      ? (headers.get as (name: string) => unknown).call(headers, "retry-after")
      : (headers["retry-after"] ?? headers["Retry-After"]);
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/** Backoff before retry number `attempt` (1-based): base * 2^(attempt-1), capped. */
export function backoffDelayMs(
  attempt: number,
  baseDelayMs: number = DEFAULT_RETRY.baseDelayMs,
  maxDelayMs: number = DEFAULT_RETRY.maxDelayMs,
): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
}

/** Runs `fn`, retrying retryable failures with exponential backoff; rethrows the last error. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_RETRY.attempts);
  const base = opts.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs;
  const max = opts.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs;
  const sleep = opts.sleep ?? ((ms: number) => delay(ms).then(() => undefined));
  const isRetryable = opts.isRetryable ?? isRetryableHttpError;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= attempts || !isRetryable(err)) throw err;
      const delayMs = Math.min(
        max,
        Math.max(backoffDelayMs(attempt, base, max), retryAfterMs(err) ?? 0),
      );
      opts.onRetry?.({ attempt, delayMs, status: httpStatusOf(err) });
      await sleep(delayMs);
    }
  }
}

/**
 * Runs `fn` with an AbortSignal and rejects with TimeoutError after `timeoutMs` even if `fn`
 * ignores the signal (the per-call ceiling holds regardless of the client library).
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** One external call: per-attempt timeout inside retry/backoff. */
export function callWithRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: RetryOptions & { timeoutMs?: number } = {},
): Promise<T> {
  return withRetry(() => withTimeout(fn, opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS), opts);
}

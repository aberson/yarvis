// Jev classifier (plan §4, §5, §8 "Jev before anything", §12.2, D2, D3, D14, D20). ONE TypeSafe
// `systemOne` call per message with four noul questions; the result is the raw scores
// `{phishing, malicious, spam, action}` (routing lives in ai/decide.ts, from CURRENT thresholds).
//
// Security: the message is sent as a JSON STATE OBJECT of data fields only (sender, context, date,
// links, trimmed body). It is never concatenated into question instructions, and the instructions
// below are constants that never contain message data.
//
// Errors are typed so the pipeline can apply the §4 failure policy:
//   - JevServiceError    : auth, network, timeout, 5xx, RateLimitError after retries, malformed
//                          response, missing key -> the jev stage fails CLOSED (D3).
//   - JevMessageRejected : a non-retryable per-message 4xx -> `jev: {error, attempts}` for that
//                          message only; the rest of the batch proceeds (D20).
// Retries/backoff and the 30 s per-call timeout come from the ONE helper, util/retry.ts (D29); the
// SDK's own retries are disabled so backoff is not compounded.
import {
  TypeSafeClient,
  type Fetch,
  type NoulQuestion,
  type RequestOptions,
  type SystemOneRequest,
} from "@typesafe-ai/sdk";
import { JEV_SCORE_KEYS, type JevScores, type Message, type Settings } from "@yarvis/shared";
import {
  callWithRetry,
  DEFAULT_CALL_TIMEOUT_MS,
  httpStatusOf,
  TimeoutError,
  type RetryOptions,
} from "../util/retry.js";
import { oneLineError, truncateText } from "../util/text.js";

/** Max body characters sent to Jev (D14). */
export const JEV_BODY_CHARS = 2000;

/** Per-call timeout for one systemOne call (D20). */
export const JEV_CALL_TIMEOUT_MS = DEFAULT_CALL_TIMEOUT_MS;

/** The four noul questions (§12.2). Constants: message data never appears in them. */
export const JEV_QUESTIONS = {
  is_phishing: {
    type: "noul",
    instructions: "Is this message a phishing attempt?",
    criteria: {
      true: "Asks the reader to log in, verify, pay, or open a link/attachment under pressure, or impersonates a known sender",
      false: "No credential, payment, or urgency lure",
    },
  },
  is_malicious: {
    type: "noul",
    instructions: "Does this message carry malware, a scam, or an attempt to extract secrets?",
  },
  is_spam: {
    type: "noul",
    instructions: "Is this unsolicited bulk or promotional mail the reader did not ask for?",
  },
  has_action_item: {
    type: "noul",
    instructions: "Does this message ask the reader to do something specific?",
    criteria: {
      true: "A concrete task, reply, payment, RSVP, pickup, or deadline for the reader",
      false: "Purely informational, social chatter, or automated notification",
    },
  },
} as const satisfies Record<string, NoulQuestion>;

export type JevQuestionId = keyof typeof JEV_QUESTIONS;

/** Question id -> score key. Exhaustive both ways (compile-time checks below). */
export const QUESTION_SCORE_KEY = {
  is_phishing: "phishing",
  is_malicious: "malicious",
  is_spam: "spam",
  has_action_item: "action",
} as const satisfies Record<JevQuestionId, keyof JevScores>;

type AssertTrue<T extends true> = T;
/** Every score key is produced by some question (no score without a question). */
export type JevQuestionsCoverScores = AssertTrue<
  [keyof JevScores] extends [(typeof QUESTION_SCORE_KEY)[JevQuestionId]] ? true : false
>;

/** The state object: data fields only (§12.2). A type alias so it is a JSON-object `EntryType`. */
export type JevState = {
  sender: string;
  context: string;
  date: string;
  links: string[];
  body: string;
};

export interface JevRequest {
  model: string;
  state: JevState;
  questions: typeof JEV_QUESTIONS;
}

/** What a systemOne response must carry; validated before use (fail closed on drift). */
export interface JevResponse {
  model?: string;
  answers: Record<string, unknown>;
}

/**
 * The subset of `TypeSafeClient` this module uses. The real client is adapted in
 * `createTypeSafeApi`; tests inject a recording fake (no network in tests).
 */
export interface JevApi {
  systemOne(
    request: JevRequest,
    options: { signal: AbortSignal; timeout: number },
  ): PromiseLike<JevResponse>;
}

/** Jev is unavailable at the service level: the jev stage fails closed (D3). */
export class JevServiceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JevServiceError";
  }
}

/** Jev rejected THIS message with a non-retryable 4xx: skip it, keep the batch going (D20). */
export class JevMessageRejected extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "JevMessageRejected";
  }
}

/** A per-message Jev failure as stored in the decisions cache (§3.3). */
export interface JevErrorRecord {
  error: string;
  attempts: number;
}

/** After this many per-message failures the message gets a `jev_error` Quarantine row (D20). */
export const JEV_MAX_ATTEMPTS = 3;

/**
 * 4xx statuses that mean "the service/account is unusable", not "this message is bad": auth,
 * permission, wrong endpoint, request timeout, rate limit. Every OTHER 4xx is per-message.
 */
export const JEV_SERVICE_4XX: ReadonlySet<number> = new Set([401, 403, 404, 407, 408, 429]);

/** Maps any failure of one classify call to the typed error the pipeline acts on. */
export function toJevError(err: unknown): JevServiceError | JevMessageRejected {
  if (err instanceof JevServiceError || err instanceof JevMessageRejected) return err;
  if (err instanceof TimeoutError) {
    return new JevServiceError(`jev call timed out after ${err.timeoutMs} ms`);
  }
  const status = httpStatusOf(err);
  if (status !== undefined && status >= 400 && status < 500 && !JEV_SERVICE_4XX.has(status)) {
    return new JevMessageRejected(
      `jev rejected the message (HTTP ${status}): ${oneLineError(err)}`,
      status,
    );
  }
  const prefix = status === undefined ? "jev unavailable" : `jev unavailable (HTTP ${status})`;
  return new JevServiceError(`${prefix}: ${oneLineError(err)}`, status);
}

/** The data-only state object for one message (§12.2, D14). */
export function buildJevState(message: Message): JevState {
  return {
    sender: message.sender,
    context: message.context,
    date: message.date,
    links: [...message.links],
    body: truncateText(message.text, JEV_BODY_CHARS),
  };
}

/** The exact systemOne request body for one message. */
export function buildJevRequest(message: Message, model: string): JevRequest {
  return { model, state: buildJevState(message), questions: JEV_QUESTIONS };
}

/** Validates the answers and maps them to scores; any drift is a service error (fail closed). */
export function parseJevAnswers(response: JevResponse): JevScores {
  const answers =
    typeof response === "object" && response !== null && typeof response.answers === "object"
      ? response.answers
      : undefined;
  if (!answers) throw new JevServiceError("jev response has no answers");
  const scores: Partial<JevScores> = {};
  for (const [questionId, key] of Object.entries(QUESTION_SCORE_KEY)) {
    const answer = answers[questionId] as { noul?: unknown } | null | undefined;
    const noul = typeof answer === "object" && answer !== null ? answer.noul : undefined;
    if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
      throw new JevServiceError(`jev response has no valid noul for ${questionId}`);
    }
    scores[key] = noul;
  }
  return Object.fromEntries(JEV_SCORE_KEYS.map((k) => [k, scores[k]])) as JevScores;
}

/** Anything that scores one message: the real classifier or `FakeJev`. */
export interface Jev {
  classify(message: Message): Promise<JevScores>;
}

export interface JevClassifierOptions {
  /** settings.jev.model (e.g. "jev-latest"). */
  model: string;
  /** Injected API; default `createTypeSafeApi()` (built lazily, on the first call). */
  api?: JevApi | (() => JevApi);
  timeoutMs?: number;
  retry?: Omit<RetryOptions, "isRetryable">;
}

/** The real classifier: one systemOne call per message under retry/backoff + timeout. */
export class JevClassifier implements Jev {
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly retry: Omit<RetryOptions, "isRetryable">;
  private readonly apiSource: JevApi | (() => JevApi);
  private api: JevApi | undefined;

  constructor(opts: JevClassifierOptions) {
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? JEV_CALL_TIMEOUT_MS;
    this.retry = opts.retry ?? {};
    this.apiSource = opts.api ?? (() => createTypeSafeApi());
  }

  private getApi(): JevApi {
    if (this.api) return this.api;
    try {
      this.api = typeof this.apiSource === "function" ? this.apiSource() : this.apiSource;
    } catch (err) {
      throw new JevServiceError(`jev not configured: ${oneLineError(err)}`);
    }
    return this.api;
  }

  /** Scores plus the model id the API echoed (doctor's detail, §5). */
  async classifyWithModel(message: Message): Promise<{ scores: JevScores; model: string }> {
    try {
      const api = this.getApi();
      const request = buildJevRequest(message, this.model);
      const response = await callWithRetry(
        (signal) => Promise.resolve(api.systemOne(request, { signal, timeout: this.timeoutMs })),
        { ...this.retry, timeoutMs: this.timeoutMs },
      );
      const scores = parseJevAnswers(response);
      return { scores, model: typeof response.model === "string" ? response.model : this.model };
    } catch (err) {
      throw toJevError(err);
    }
  }

  async classify(message: Message): Promise<JevScores> {
    return (await this.classifyWithModel(message)).scores;
  }
}

/** True when a TypeSafe key is present (otherwise the jev seam is "not configured", §5). */
export function isJevConfigured(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (env.TYPESAFE_API_KEY ?? "").trim() !== "";
}

/**
 * Adapts the real `@typesafe-ai/sdk` client. SDK retries are off (util/retry.ts owns backoff),
 * logging is off (debug logs would print message bodies), the per-attempt timeout matches ours.
 * Bodies are sent uncompressed (they are a few KB). `apiKey` defaults to TYPESAFE_API_KEY; the
 * SDK throws its TypeSafeError when neither is set. `fetch` is injectable for tests (no network).
 */
export function createTypeSafeApi(opts: { apiKey?: string; fetch?: Fetch } = {}): JevApi {
  const client = new TypeSafeClient({
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    retry: { maxRetries: 0 },
    timeout: JEV_CALL_TIMEOUT_MS,
    logLevel: "off",
    compression: false,
  });
  return {
    systemOne: (request, options) => {
      const sdkRequest: SystemOneRequest<typeof JEV_QUESTIONS> = request;
      const sdkOptions: RequestOptions = { signal: options.signal, timeout: options.timeout };
      return client.systemOne(sdkRequest, sdkOptions);
    },
  };
}

/** The classifier configured from settings (`jev.model`). */
export function createJevFromSettings(
  settings: Settings,
  opts: Omit<JevClassifierOptions, "model"> = {},
): JevClassifier {
  return new JevClassifier({ ...opts, model: settings.jev.model });
}

/** Per-message outcome of a batch: scores, or the per-message rejection. */
export type JevBatchResult = Map<string, JevScores | JevMessageRejected>;

/**
 * Classifies `messages` with at most `concurrency` calls in flight (settings.jev.concurrency).
 * A per-message rejection is recorded and the batch continues; the FIRST service-level error stops
 * launching new calls, waits for in-flight ones, and is thrown (the stage fails closed, D3).
 * `onResult` runs OUTSIDE the classification error handling: if it throws, the batch stops the
 * same way and rethrows that error unchanged (a caller failure is never reported as a Jev outage).
 */
export async function classifyBatch(
  jev: Jev,
  messages: readonly Message[],
  opts: { concurrency: number; onResult?: (id: string, r: JevScores | JevMessageRejected) => void },
): Promise<JevBatchResult> {
  const results: JevBatchResult = new Map();
  const concurrency = Math.max(1, Math.floor(opts.concurrency));
  let next = 0;
  let failure: JevServiceError | undefined;
  let callbackFailure: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (failure === undefined && callbackFailure === undefined && next < messages.length) {
      const message = messages[next++] as Message;
      let outcome: JevScores | JevMessageRejected;
      try {
        outcome = await jev.classify(message);
      } catch (err) {
        const typed = toJevError(err);
        if (!(typed instanceof JevMessageRejected)) {
          failure ??= typed;
          continue;
        }
        outcome = typed;
      }
      results.set(message.id, outcome);
      try {
        opts.onResult?.(message.id, outcome);
      } catch (err) {
        callbackFailure ??= { error: err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, messages.length) }, worker));
  if (callbackFailure) throw callbackFailure.error;
  if (failure) throw failure;
  return results;
}

/** The decisions-cache record for a per-message rejection (`attempts` counts this one). */
export function jevErrorRecord(err: JevMessageRejected, previousAttempts = 0): JevErrorRecord {
  return { error: err.message, attempts: previousAttempts + 1 };
}

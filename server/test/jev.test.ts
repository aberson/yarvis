// ai/jev.ts (plan §4, §5, §12.2, D2, D3, D14, D20): exact systemOne request body, data-only state,
// result shape, retry/backoff on RateLimitError, per-call timeout, typed service vs per-message
// errors, and bounded batch concurrency. No network: the API (or the SDK's fetch) is injected.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APIConnectionError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  RateLimitError,
  TypeSafeError,
} from "@typesafe-ai/sdk";
import type { JevScores, Message } from "@yarvis/shared";
import {
  buildJevRequest,
  classifyBatch,
  createJevFromSettings,
  createTypeSafeApi,
  isJevConfigured,
  JEV_BODY_CHARS,
  JEV_QUESTIONS,
  JevClassifier,
  jevErrorRecord,
  JevMessageRejected,
  JevServiceError,
  toJevError,
  type Jev,
  type JevApi,
  type JevRequest,
  type JevResponse,
} from "../src/ai/jev.js";
import { loadSettings } from "../src/config/settings.js";
import { loadFixtureMessages } from "../src/fakes/jev.js";
import { TimeoutError } from "../src/util/retry.js";
import { tempPaths } from "./helpers.js";

const fixtures = loadFixtureMessages();
const noSleep = { sleep: () => Promise.resolve() };

/** The §12.2 question set, written out literally (NOT imported) so drift in jev.ts fails here. */
const EXPECTED_QUESTIONS = {
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
};

function answers(s: JevScores): JevResponse {
  return {
    model: "jev-2026-10-01",
    answers: {
      is_phishing: { type: "noul", noul: s.phishing },
      is_malicious: { type: "noul", noul: s.malicious },
      is_spam: { type: "noul", noul: s.spam },
      has_action_item: { type: "noul", noul: s.action },
    },
  };
}

class RecordingApi implements JevApi {
  readonly requests: JevRequest[] = [];
  readonly signals: AbortSignal[] = [];
  readonly timeouts: number[] = [];
  private readonly queue: Array<() => Promise<JevResponse>> = [];

  push(...steps: Array<JevResponse | Error | "hang">): this {
    for (const s of steps) {
      this.queue.push(() =>
        s === "hang"
          ? new Promise<never>(() => undefined)
          : s instanceof Error
            ? Promise.reject(s)
            : Promise.resolve(s),
      );
    }
    return this;
  }

  systemOne(request: JevRequest, options: { signal: AbortSignal; timeout: number }) {
    this.requests.push(structuredClone(request));
    this.signals.push(options.signal);
    this.timeouts.push(options.timeout);
    const next = this.queue.shift();
    if (!next) throw new Error("RecordingApi: no response queued");
    return next();
  }
}

/** All instruction/criteria strings from the question set. */
function instructionTexts(): string[] {
  const out: string[] = [];
  for (const q of Object.values(EXPECTED_QUESTIONS)) {
    out.push(q.instructions);
    if ("criteria" in q) out.push(q.criteria.true, q.criteria.false);
  }
  return out;
}

const SCORES: JevScores = { phishing: 0.1, malicious: 0.2, spam: 0.3, action: 0.9 };

async function exampleSettings() {
  const { paths, cleanup } = tempPaths();
  try {
    return await loadSettings(paths);
  } finally {
    cleanup();
  }
}

describe("systemOne request body", () => {
  it("sends model jev-latest, a data-only state object and exactly the four noul questions", async () => {
    const settings = await exampleSettings();
    const api = new RecordingApi().push(answers(SCORES));
    const jev = createJevFromSettings(settings, { api, retry: noSleep });
    const msg = fixtures.actionable;

    await expect(jev.classify(msg)).resolves.toEqual(SCORES);

    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toEqual({
      model: "jev-latest",
      state: {
        sender: msg.sender,
        context: msg.context,
        date: msg.date,
        links: msg.links,
        body: msg.text,
      },
      questions: EXPECTED_QUESTIONS,
    });
    expect(Object.keys(api.requests[0]?.questions ?? {})).toHaveLength(4);
    expect(Object.values(api.requests[0]?.questions ?? {}).every((q) => q.type === "noul")).toBe(
      true,
    );
    expect(api.timeouts).toEqual([30_000]);
  });

  it("the state object never contains instruction text, and questions never contain message data", () => {
    for (const msg of Object.values(fixtures)) {
      const req = buildJevRequest(msg, "jev-latest");
      expect(Object.keys(req.state).sort()).toEqual(["body", "context", "date", "links", "sender"]);
      const stateJson = JSON.stringify(req.state);
      for (const text of instructionTexts()) expect(stateJson).not.toContain(text);
      const questionsJson = JSON.stringify(req.questions);
      expect(questionsJson).not.toContain(msg.text.slice(0, 40));
      expect(questionsJson).not.toContain(msg.sender);
      // Questions are the shared constant, never rebuilt per message.
      expect(req.questions).toBe(JEV_QUESTIONS);
    }
  });

  it("trims the body to 2000 characters (D14)", () => {
    const long: Message = { ...fixtures.clean, text: "x".repeat(4000) };
    expect(buildJevRequest(long, "jev-latest").state.body).toHaveLength(JEV_BODY_CHARS);
  });

  it("the real SDK adapter POSTs that exact JSON body to /v1/systemone with a Bearer key", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch = (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ ...answers(SCORES), usage: { input_tokens: 10 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const api = createTypeSafeApi({ apiKey: "test-key-not-real", fetch });
    const jev = new JevClassifier({ model: "jev-latest", api, retry: noSleep });

    await expect(jev.classifyWithModel(fixtures.phishing)).resolves.toEqual({
      scores: SCORES,
      model: "jev-2026-10-01",
    });

    expect(seen).toHaveLength(1);
    const { url, init } = seen[0] ?? { url: "", init: undefined };
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key-not-real");
    const raw = init?.body;
    const text =
      typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer | Uint8Array);
    expect(JSON.parse(text)).toEqual({
      model: "jev-latest",
      state: {
        sender: fixtures.phishing.sender,
        context: fixtures.phishing.context,
        date: fixtures.phishing.date,
        links: fixtures.phishing.links,
        body: fixtures.phishing.text,
      },
      questions: EXPECTED_QUESTIONS,
    });
  });
});

describe("configuration", () => {
  const saved = process.env.TYPESAFE_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved;
  });

  it("a missing key is a service-level error (fail closed), raised at call time not construction", async () => {
    delete process.env.TYPESAFE_API_KEY;
    expect(isJevConfigured()).toBe(false);
    expect(() => createTypeSafeApi()).toThrow(TypeSafeError);
    const jev = new JevClassifier({ model: "jev-latest" });
    const err = await jev.classify(fixtures.clean).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JevServiceError);
    expect((err as Error).message).toMatch(/not configured/);
    expect(isJevConfigured({ TYPESAFE_API_KEY: "  " })).toBe(false);
    expect(isJevConfigured({ TYPESAFE_API_KEY: "k" })).toBe(true);
  });
});

describe("retries and typed errors", () => {
  it("backs off on RateLimitError (honouring Retry-After) and then succeeds", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const limited = new RateLimitError(429, { error: "rate" }, new Headers({ "retry-after": "2" }));
    const api = new RecordingApi().push(limited, answers(SCORES));
    const jev = new JevClassifier({ model: "jev-latest", api, retry: { sleep, baseDelayMs: 100 } });
    await expect(jev.classify(fixtures.clean)).resolves.toEqual(SCORES);
    expect(api.requests).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("RateLimitError after all retries is a JevServiceError (service level)", async () => {
    const api = new RecordingApi();
    for (let i = 0; i < 3; i++) api.push(new RateLimitError(429, {}, new Headers()));
    const jev = new JevClassifier({ model: "jev-latest", api, retry: { ...noSleep, attempts: 3 } });
    const err = await jev.classify(fixtures.clean).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JevServiceError);
    expect(err).toMatchObject({ status: 429 });
    expect(api.requests).toHaveLength(3);
  });

  it("a 5xx is retried, then fails closed as JevServiceError", async () => {
    const api = new RecordingApi();
    for (let i = 0; i < 2; i++) api.push(new InternalServerError(500, {}, new Headers()));
    const jev = new JevClassifier({ model: "jev-latest", api, retry: { ...noSleep, attempts: 2 } });
    await expect(jev.classify(fixtures.clean)).rejects.toMatchObject({
      name: "JevServiceError",
      status: 500,
    });
    expect(api.requests).toHaveLength(2);
  });

  it("auth failure and network failure are service-level, not retried", async () => {
    for (const e of [
      new AuthenticationError(401, {}, new Headers()),
      new APIConnectionError("ECONNRESET"),
    ]) {
      const api = new RecordingApi().push(e);
      const jev = new JevClassifier({ model: "jev-latest", api, retry: noSleep });
      await expect(jev.classify(fixtures.clean)).rejects.toBeInstanceOf(JevServiceError);
      expect(api.requests).toHaveLength(1);
    }
  });

  it("a non-retryable per-message 4xx is JevMessageRejected with its status, not retried", async () => {
    const api = new RecordingApi().push(new BadRequestError(400, { error: "bad" }, new Headers()));
    const jev = new JevClassifier({ model: "jev-latest", api, retry: noSleep });
    const err = await jev.classify(fixtures.clean).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JevMessageRejected);
    expect(err).toMatchObject({ status: 400 });
    expect(api.requests).toHaveLength(1);
    expect(jevErrorRecord(err as JevMessageRejected, 1)).toEqual({
      error: "jev rejected the message (HTTP 400)",
      attempts: 2,
    });
  });

  it("classifies status codes: 4xx service set vs per-message", () => {
    const http = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
    for (const s of [401, 403, 404, 408, 429, 500, 502, 503]) {
      expect(toJevError(http(s))).toBeInstanceOf(JevServiceError);
    }
    for (const s of [400, 413, 422]) expect(toJevError(http(s))).toBeInstanceOf(JevMessageRejected);
    expect(toJevError(new TimeoutError(30_000))).toBeInstanceOf(JevServiceError);
    expect(toJevError(new Error("boom"))).toBeInstanceOf(JevServiceError);
  });

  it("enforces the per-call timeout and aborts the request signal", async () => {
    const api = new RecordingApi().push("hang");
    const jev = new JevClassifier({ model: "jev-latest", api, timeoutMs: 20, retry: noSleep });
    const err = await jev.classify(fixtures.clean).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JevServiceError);
    expect((err as Error).message).toMatch(/timed out after 20 ms/);
    expect(api.signals[0]?.aborted).toBe(true);
  });

  it("a malformed response (missing or out-of-range noul) fails closed", async () => {
    const missing: JevResponse = { answers: { is_phishing: { noul: 0.1 } } };
    const outOfRange = answers({ ...SCORES, spam: 1.5 });
    for (const bad of [missing, outOfRange, { answers: null } as unknown as JevResponse]) {
      const api = new RecordingApi().push(bad);
      const jev = new JevClassifier({ model: "jev-latest", api, retry: noSleep });
      await expect(jev.classify(fixtures.clean)).rejects.toBeInstanceOf(JevServiceError);
    }
  });
});

describe("classifyBatch (settings.jev.concurrency)", () => {
  function msgs(n: number): Message[] {
    return Array.from({ length: n }, (_, i) => ({
      ...fixtures.clean,
      id: `gmail:${i.toString(16)}`,
    }));
  }

  it("never runs more than `concurrency` calls at once and scores every message", async () => {
    let inFlight = 0;
    let peak = 0;
    const jev: Jev = {
      classify: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return SCORES;
      },
    };
    const results = await classifyBatch(jev, msgs(7), { concurrency: 2 });
    expect(peak).toBe(2);
    expect(results.size).toBe(7);
  });

  it("a per-message rejection is recorded and the rest of the batch proceeds", async () => {
    const jev: Jev = {
      classify: (m) =>
        m.id === "gmail:1"
          ? Promise.reject(new JevMessageRejected("bad", 400))
          : Promise.resolve(SCORES),
    };
    const results = await classifyBatch(jev, msgs(4), { concurrency: 2 });
    expect(results.get("gmail:1")).toBeInstanceOf(JevMessageRejected);
    expect([...results.values()].filter((r) => !(r instanceof JevMessageRejected))).toHaveLength(3);
  });

  it("a service-level error stops new calls and is thrown (fail closed)", async () => {
    const seen: string[] = [];
    const jev: Jev = {
      classify: (m) => {
        seen.push(m.id);
        return m.id === "gmail:1"
          ? Promise.reject(new JevServiceError("down", 503))
          : Promise.resolve(SCORES);
      },
    };
    await expect(classifyBatch(jev, msgs(10), { concurrency: 1 })).rejects.toBeInstanceOf(
      JevServiceError,
    );
    expect(seen).toEqual(["gmail:0", "gmail:1"]);
  });

  it("an onResult failure is rethrown unchanged, not reported as a Jev outage", async () => {
    const seen: string[] = [];
    const jev: Jev = {
      classify: (m) => {
        seen.push(m.id);
        return Promise.resolve(SCORES);
      },
    };
    const persistError = new Error("disk full");
    const onResult = (id: string): void => {
      if (id === "gmail:1") throw persistError;
    };
    const err: unknown = await classifyBatch(jev, msgs(10), { concurrency: 1, onResult }).catch(
      (e: unknown) => e,
    );
    expect(err).toBe(persistError);
    expect(err).not.toBeInstanceOf(JevServiceError);
    // It stops launching new calls, like a service failure.
    expect(seen).toEqual(["gmail:0", "gmail:1"]);
  });
});

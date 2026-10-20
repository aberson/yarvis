// connectors/gmail.ts against FakeGmailApi (no network): the read-only scope pin, recorded-scope
// refusal, the INBOX query, pagination, cached-id skip, bounded concurrency, retries, timeouts and
// MIME -> Message normalization (plan §1.2, §3.2, §3.3, §5, §8, D20, D21, D29).
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as realDelay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { gmailId, parseMessageId } from "@yarvis/shared";
import {
  afterEpoch,
  createGmailConnector,
  decodeHeaderValue,
  fromAddress,
  GET_CONCURRENCY,
  GMAIL_QUOTA,
  GMAIL_READONLY_SCOPE,
  GmailError,
  gmailQuery,
  googleGmailApi,
  isGmailRateLimit,
  isReadonlyScope,
  loadCredentials,
  normalizeGmailMessage,
  SCOPES,
  type GmailApi,
  type RawMessage,
} from "../src/connectors/gmail.js";
import { REPO_ROOT } from "../src/config/paths.js";
import {
  createFakeGmail,
  FAKE_GOOGLE_ERROR_TEXT,
  FakeGmailApi,
  loadGmailSeed,
  matchesQuery,
} from "../src/fakes/gmail.js";
import { TimeoutError } from "../src/util/retry.js";
import { truncateText, extractLinks, MESSAGE_TEXT_MAX_CHARS } from "../src/util/text.js";
import { tempPaths } from "./helpers.js";

const FIXTURES = path.join(REPO_ROOT, "server", "fixtures");
const GMAIL_SRC = path.join(REPO_ROOT, "server", "src", "connectors", "gmail.ts");

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function temp() {
  const t = tempPaths();
  cleanups.push(t.cleanup);
  return t.paths;
}

const b64 = (s: string, enc: BufferEncoding = "utf8") => Buffer.from(s, enc).toString("base64url");

function plainMessage(id: string, text: string, over: Partial<RawMessage> = {}): RawMessage {
  return {
    id,
    labelIds: ["INBOX"],
    internalDate: String(Date.parse("2026-10-10T00:00:00Z")),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "a@example.com" },
        { name: "Subject", value: "s" },
      ],
      body: { data: b64(text) },
    },
    ...over,
  };
}

const seed = loadGmailSeed();
const byId = (id: string) => {
  const m = seed.find((x) => x.id === id);
  if (!m) throw new Error(`fixture ${id} missing`);
  return m;
};

describe("SCOPES: the read-only pin (§1.2, §8)", () => {
  it("deep-equals exactly [gmail.readonly]", () => {
    expect(SCOPES).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(SCOPES).toHaveLength(1);
    expect(Object.isFrozen(SCOPES)).toBe(true);
  });

  it("isReadonlyScope accepts only the exact recorded string", () => {
    expect(isReadonlyScope(GMAIL_READONLY_SCOPE)).toBe(true);
    for (const bad of [
      `${GMAIL_READONLY_SCOPE} https://www.googleapis.com/auth/gmail.modify`,
      `https://mail.google.com/`,
      `${GMAIL_READONLY_SCOPE} `,
      "",
      undefined,
      42,
    ]) {
      expect(isReadonlyScope(bad)).toBe(false);
    }
  });
});

describe("loadCredentials: recorded-scope provenance check", () => {
  it("loads a read-only token", async () => {
    const paths = temp();
    copyFileSync(path.join(FIXTURES, "gmail-token-readonly.json"), paths.gmailTokenFile);
    const token = await loadCredentials(paths);
    expect(token.scope).toBe(GMAIL_READONLY_SCOPE);
    expect(token.refresh_token).toBe("synthetic-refresh-token-0001");
  });

  it("refuses a token fixture with an extra scope, with a clear error that leaks no value", async () => {
    const paths = temp();
    copyFileSync(path.join(FIXTURES, "gmail-token-extra-scope.json"), paths.gmailTokenFile);
    const err = await loadCredentials(paths).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GmailError);
    expect((err as GmailError).kind).toBe("scope_refused");
    expect((err as GmailError).message).toMatch(
      /gmail-token\.json is refused: its recorded scope is not exactly https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly/,
    );
    expect((err as GmailError).message).toContain("gmail:auth");
    expect((err as GmailError).message).not.toContain("synthetic-");
    expect((err as GmailError).message).not.toContain("gmail.modify");
  });

  it.each([
    ["no scope field", { refresh_token: "r" }, "scope_refused"],
    ["a non-string scope", { refresh_token: "r", scope: [GMAIL_READONLY_SCOPE] }, "scope_refused"],
    ["no refresh token", { scope: GMAIL_READONLY_SCOPE }, "token_invalid"],
    ["not an object", "just a string", "token_invalid"],
  ])("refuses a token with %s", async (_label, body, kind) => {
    const paths = temp();
    writeFileSync(paths.gmailTokenFile, JSON.stringify(body));
    await expect(loadCredentials(paths)).rejects.toMatchObject({ kind });
  });

  it("missing token -> not_configured; garbage -> token_invalid", async () => {
    const paths = temp();
    await expect(loadCredentials(paths)).rejects.toMatchObject({ kind: "not_configured" });
    writeFileSync(paths.gmailTokenFile, "{not json");
    await expect(loadCredentials(paths)).rejects.toMatchObject({ kind: "token_invalid" });
  });

  it("googleGmailApi re-checks the recorded scope on every resolve (never builds a client for a wide token)", async () => {
    const paths = temp();
    writeFileSync(
      paths.oauthClientFile,
      JSON.stringify({ installed: { client_id: "cid", client_secret: "cs" } }),
    );
    const built: string[] = [];
    const resolve = googleGmailApi(paths, (_client, token) => {
      built.push(token.scope);
      return Promise.resolve(new FakeGmailApi());
    });
    await expect(resolve()).rejects.toMatchObject({ kind: "not_configured" });
    copyFileSync(path.join(FIXTURES, "gmail-token-readonly.json"), paths.gmailTokenFile);
    await resolve();
    copyFileSync(path.join(FIXTURES, "gmail-token-extra-scope.json"), paths.gmailTokenFile);
    await expect(resolve()).rejects.toMatchObject({ kind: "scope_refused" });
    expect(built).toEqual([GMAIL_READONLY_SCOPE]);
  });
});

describe("read-only source pins", () => {
  const src = readFileSync(GMAIL_SRC, "utf8");
  const MUTATING = [
    /\bmessages\s*\.\s*(modify|batchModify|batchDelete|send|trash|untrash|insert|import|delete)\b/,
    /\bthreads\s*\.\s*(modify|trash|untrash|delete)\b/,
    /\b(users|gmail)\s*\.\s*(labels|drafts|settings|threads)\b/,
    /\.\s*(modify|batchModify|batchDelete|trash|untrash)\s*\(/,
    /\bsend\s*\(/,
    /\bimport\s*\(\s*\{/,
    /\b(insert|watch|stop)\s*\(/,
    /removeLabelIds|addLabelIds/,
  ];

  it("connectors/gmail.ts names no mutating Gmail call (modify/batchModify/send/trash/insert/import/labels)", () => {
    for (const pattern of MUTATING) expect(src).not.toMatch(pattern);
    // Red anchors: each pattern does fire on the call shape it forbids.
    const forbidden = [
      "gmail.users.messages.modify({",
      "gmail.users.messages.batchModify({",
      "gmail.users.messages.send({",
      "gmail.users.messages.trash({",
      "gmail.users.messages.insert({",
      "gmail.users.messages.import({",
      "gmail.users.labels.create({",
      "gmail.users.threads.trash({",
      "{ removeLabelIds: ['UNREAD'] }",
    ];
    for (const bad of forbidden) expect(MUTATING.some((p) => p.test(bad))).toBe(true);
  });

  it("names no OAuth scope other than gmail.readonly and never logs", () => {
    const scopes = src.match(
      /https:\/\/(www\.googleapis\.com\/auth\/[\w.]+|mail\.google\.com\/(?!mail\/u\/0))/g,
    );
    expect(new Set(scopes)).toEqual(new Set([GMAIL_READONLY_SCOPE]));
    expect(src).not.toMatch(/\bconsole\s*\./);
  });

  it("connectors/gmail.ts is the only module under server/src that builds a Gmail client", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name)) files.push(p);
      }
    };
    walk(path.join(REPO_ROOT, "server", "src"));
    const builders = files.filter((f) => /google\.gmail\s*\(/.test(readFileSync(f, "utf8")));
    expect(builders.map((f) => path.relative(REPO_ROOT, f).replace(/\\/g, "/"))).toEqual([
      "server/src/connectors/gmail.ts",
    ]);
  });
});

describe("query (§3.3: since read as 00:00:00Z; cursor overlaps 24 h)", () => {
  it("since 2026-10-01 with no cursor -> after:1790812800 (verbatim)", () => {
    expect(gmailQuery({ since: "2026-10-01" })).toBe("after:1790812800 -in:spam -in:trash");
    expect(gmailQuery({ since: "2026-10-01", lastRunAt: null })).toBe(
      "after:1790812800 -in:spam -in:trash",
    );
  });

  it("a lastRunAt cursor overlaps by 24 h (verbatim)", () => {
    // 2026-10-18T12:00:00Z - 24 h = 2026-10-17T12:00:00Z = 1792238400
    expect(gmailQuery({ since: "2026-10-01", lastRunAt: "2026-10-18T12:00:00.000Z" })).toBe(
      "after:1792238400 -in:spam -in:trash",
    );
  });

  it("since floors a cursor whose overlap reaches before it", () => {
    expect(afterEpoch({ since: "2026-10-01", lastRunAt: "2026-10-01T06:00:00Z" })).toBe(1790812800);
  });

  it("rejects malformed cursors instead of guessing", () => {
    expect(() => afterEpoch({ since: "10/01/2026" })).toThrow(RangeError);
    expect(() => afterEpoch({ since: "2026-10-01", lastRunAt: "yesterday" })).toThrow(RangeError);
  });

  it.each(["2026-02-30", "2026-13-01"])(
    "rejects impossible calendar date %s (no silent roll-over of the after: floor)",
    (since) => {
      // Red anchor: Date.parse alone accepts 2026-02-30 (rolls to Mar 2), so the guard is needed.
      if (since === "2026-02-30") {
        expect(Number.isNaN(Date.parse(`${since}T00:00:00Z`))).toBe(false);
      }
      expect(() => afterEpoch({ since })).toThrow(
        new RangeError("gmail cursor: since is not a real date"),
      );
      expect(() => gmailQuery({ since })).toThrow(RangeError);
    },
  );

  it("floors at an exact UTC instant since (D38)", () => {
    expect(afterEpoch({ since: "2026-10-20T22:40:00Z" })).toBe(
      Date.UTC(2026, 9, 20, 22, 40) / 1000,
    );
    // The 24 h overlap never reaches below the instant.
    expect(
      afterEpoch({ since: "2026-10-20T22:40:00Z", lastRunAt: "2026-10-20T23:00:00.000Z" }),
    ).toBe(Date.UTC(2026, 9, 20, 22, 40) / 1000);
  });

  it("accepts a real leap day 2028-02-29", () => {
    expect(afterEpoch({ since: "2028-02-29" })).toBe(Date.parse("2028-02-29T00:00:00Z") / 1000);
    expect(gmailQuery({ since: "2028-02-29" })).toBe("after:1835395200 -in:spam -in:trash");
  });
});

describe("fetchSince against FakeGmail", () => {
  it("lists INBOX with the query and fetches every new message (fixture mailbox)", async () => {
    const { api, connector } = createFakeGmail();
    const res = await connector.fetchSince({ since: "2026-10-01" }, new Set());
    const list = api.callsOf("messages.list");
    expect(list).toHaveLength(1);
    expect(list[0]?.params).toEqual({
      userId: "me",
      q: "after:1790812800 -in:spam -in:trash",
      labelIds: ["INBOX"],
      maxResults: 500,
    });
    // SPAM-labelled and pre-since fixtures are excluded by the query.
    expect(res.messages.map((m) => m.id)).toEqual([
      "gmail:19a0c0ffee000004",
      "gmail:19a0c0ffee000003",
      "gmail:19a0c0ffee000002",
      "gmail:19a0c0ffee000001",
    ]);
    expect(res).toMatchObject({ listed: 4, skippedCached: 0 });
    for (const call of api.callsOf("messages.get")) {
      expect(call.params).toMatchObject({ userId: "me", format: "full" });
    }
  });

  it("paginates through every page", async () => {
    const { api, connector } = createFakeGmail({ pageSize: 1 });
    const res = await connector.fetchSince({ since: "2026-10-01" }, new Set());
    const list = api.callsOf("messages.list");
    expect(list).toHaveLength(4);
    expect(list.map((c) => (c.params as { pageToken?: string }).pageToken)).toEqual([
      undefined,
      "1",
      "2",
      "3",
    ]);
    expect(res.messages).toHaveLength(4);
  });

  it("a cached id causes no messages.get call", async () => {
    const { api, connector } = createFakeGmail();
    const known = new Set(["gmail:19a0c0ffee000001", "gmail:19a0c0ffee000003"]);
    const res = await connector.fetchSince({ since: "2026-10-01" }, known);
    const got = api.callsOf("messages.get").map((c) => (c.params as { id: string }).id);
    expect(got.sort()).toEqual(["19a0c0ffee000002", "19a0c0ffee000004"]);
    expect(res.messages.map((m) => m.id)).toEqual([
      "gmail:19a0c0ffee000004",
      "gmail:19a0c0ffee000002",
    ]);
    expect(res).toMatchObject({ listed: 4, skippedCached: 2 });
  });

  it("all ids cached -> zero messages.get calls", async () => {
    const { api, connector } = createFakeGmail();
    const all = new Set(seed.map((m) => gmailId(m.id ?? "")));
    const res = await connector.fetchSince({ since: "2026-10-01" }, all);
    expect(api.callsOf("messages.get")).toHaveLength(0);
    expect(res.messages).toEqual([]);
  });

  it("a 429-then-success messages.get waits out the quota window (not per-call backoff) and succeeds", async () => {
    const delays: number[] = [];
    const waits: number[] = [];
    const { api, connector } = createFakeGmail({
      retry: { sleep: (ms) => (delays.push(ms), Promise.resolve()) },
      quota: { sleep: (ms) => (waits.push(ms), Promise.resolve()), random: () => 0.5 },
    });
    api.failNext("messages.get", 429);
    const res = await connector.fetchSince({ since: "2026-10-01" }, new Set());
    expect(res.messages).toHaveLength(4);
    expect(api.callsOf("messages.get")).toHaveLength(5); // 4 messages + 1 retry
    expect(delays).toEqual([]);
    expect(waits).toEqual([GMAIL_QUOTA.windowMs + GMAIL_QUOTA.jitterMs / 2]);
  });

  it.each([500, 503])("retries a %i on messages.list", async (status) => {
    const { api, connector } = createFakeGmail();
    api.failNext("messages.list", status, 2);
    const res = await connector.fetchSince({ since: "2026-10-01" }, new Set());
    expect(api.callsOf("messages.list")).toHaveLength(3);
    expect(res.messages).toHaveLength(4);
  });

  it("gives up after the retry budget with a typed upstream error", async () => {
    const { api, connector } = createFakeGmail();
    api.failNext("messages.get", 503, 50);
    await expect(connector.fetchSince({ since: "2026-10-01" }, new Set())).rejects.toMatchObject({
      kind: "upstream",
      message: "Gmail messages.get failed (HTTP 503)",
    });
  });

  it("a non-retryable 4xx is not retried", async () => {
    const { api, connector } = createFakeGmail();
    api.failNext("messages.list", 400);
    await expect(connector.fetchSince({ since: "2026-10-01" }, new Set())).rejects.toMatchObject({
      kind: "upstream",
    });
    expect(api.callsOf("messages.list")).toHaveLength(1);
  });

  it("an expired/revoked token surfaces as kind auth naming gmail:auth", async () => {
    const api = new FakeGmailApi(seed);
    const bad: GmailApi = {
      users: {
        messages: {
          list: () =>
            Promise.reject(
              Object.assign(new Error("invalid_grant"), {
                status: 400,
                response: { status: 400, data: { error: "invalid_grant" } },
              }),
            ),
          get: (params, o) => api.users.messages.get(params, o),
        },
      },
    };
    const connector = createGmailConnector({ api: bad, retry: { sleep: () => Promise.resolve() } });
    await expect(connector.fetchSince({ since: "2026-10-01" }, new Set())).rejects.toMatchObject({
      kind: "auth",
      message: expect.stringContaining("gmail:auth") as unknown,
    });
  });

  it("enforces the per-call timeout (30 s by default; shortened here)", async () => {
    const { api, connector } = createFakeGmail({ timeoutMs: 50 });
    api.hangNext("messages.get");
    await expect(connector.fetchSince({ since: "2026-10-01" }, new Set())).rejects.toMatchObject({
      kind: "upstream",
      message: "Gmail messages.get timed out after 50 ms",
    });
  });

  it("keeps at most 4 messages.get calls in flight", async () => {
    const many: RawMessage[] = Array.from({ length: 12 }, (_v, i) =>
      plainMessage(`1a${i.toString(16).padStart(4, "0")}`, `body ${i}`),
    );
    const { api, connector } = createFakeGmail({ seed: many });
    api.latencyMs = 15;
    const res = await connector.fetchSince({ since: "2026-10-01" }, new Set());
    expect(GET_CONCURRENCY).toBe(4);
    expect(res.messages).toHaveLength(12);
    expect(api.maxInFlight).toBe(4);
  });
});

describe("Gmail per-user rate limiting (quota gate)", () => {
  const SINCE = { since: "2026-10-01" };
  const RATE_LIMIT = { reason: "rateLimitExceeded" };
  const many = (n: number): RawMessage[] =>
    Array.from({ length: n }, (_v, i) =>
      plainMessage(`1a${i.toString(16).padStart(4, "0")}`, `body ${i}`, {
        internalDate: String(Date.parse("2026-10-10T00:00:00Z") - i * 1000),
      }),
    );
  /** Lets every queued callback and fake call run (no timers involved). */
  const ticks = async (n = 20) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
  };
  const gaxios403 = (data: unknown) => ({ status: 403, response: { status: 403, data } });

  it("classifies 429 and 403 rateLimitExceeded/userRateLimitExceeded as rate limits, never other 403s", () => {
    const reasons = (reason: string) => ({
      error: { errors: [{ domain: "usageLimits", reason }] },
    });
    expect(isGmailRateLimit({ status: 429 })).toBe(true);
    expect(isGmailRateLimit(gaxios403(reasons("rateLimitExceeded")))).toBe(true);
    expect(isGmailRateLimit(gaxios403(reasons("userRateLimitExceeded")))).toBe(true);
    // The AIP-193 info gaxios attaches as `cause`, and a JSON string body.
    expect(
      isGmailRateLimit({ status: 403, cause: { errors: [{ reason: "rateLimitExceeded" }] } }),
    ).toBe(true);
    expect(isGmailRateLimit(gaxios403(JSON.stringify(reasons("userRateLimitExceeded"))))).toBe(
      true,
    );
    for (const other of ["insufficientPermissions", "dailyLimitExceeded", "accessNotConfigured"]) {
      expect(isGmailRateLimit(gaxios403(reasons(other)))).toBe(false);
    }
    expect(isGmailRateLimit({ status: 403 })).toBe(false);
    // The reason alone is not enough: it must come with a 403.
    const rateReason = reasons("rateLimitExceeded");
    expect(isGmailRateLimit({ status: 500, response: { status: 500, data: rateReason } })).toBe(
      false,
    );
    expect(isGmailRateLimit(new TimeoutError(1))).toBe(false);
  });

  it("a 403 rateLimitExceeded mid-fetch holds EVERY worker until the window resets, then completes with every message at half the concurrency", async () => {
    const seedMany = many(16);
    const waits: number[] = [];
    let release!: () => void;
    const { api, connector } = createFakeGmail({
      seed: seedMany,
      quota: {
        sleep: (ms) => {
          waits.push(ms);
          return new Promise<void>((r) => (release = r));
        },
        random: () => 0.5,
      },
    });
    api.latencyMs = 5;
    const limitedId = seedMany[5]?.id as string;
    api.failNext("messages.get", 403, 1, { ...RATE_LIMIT, id: limitedId });
    let settled = false;
    const fetch = connector.fetchSince(SINCE, new Set()).finally(() => (settled = true));

    while (waits.length === 0) await ticks(1);
    await realDelay(50); // calls already in flight when the pause began finish
    const callsAtPause = api.callsOf("messages.get").length;
    await realDelay(50);
    await ticks();
    expect(api.callsOf("messages.get")).toHaveLength(callsAtPause); // nobody kept hammering
    expect(callsAtPause).toBeLessThan(seedMany.length);
    expect(settled).toBe(false);
    expect(waits).toEqual([GMAIL_QUOTA.windowMs + GMAIL_QUOTA.jitterMs / 2]);

    api.maxInFlight = 0;
    release();
    const res = await fetch;
    expect(res.messages.map((m) => m.id)).toEqual(seedMany.map((m) => gmailId(m.id as string)));
    const gets = api.callsOf("messages.get").map((c) => (c.params as { id: string }).id);
    expect(gets.filter((id) => id === limitedId)).toHaveLength(2);
    expect(gets).toHaveLength(seedMany.length + 1);
    expect(api.maxInFlight).toBe(GET_CONCURRENCY / 2);
  });

  it("honours a Retry-After header instead of the default window", async () => {
    const waits: number[] = [];
    const { api, connector } = createFakeGmail({
      quota: { sleep: (ms) => (waits.push(ms), Promise.resolve()) },
    });
    api.failNext("messages.get", 403, 1, { ...RATE_LIMIT, retryAfterSeconds: 7 });
    const res = await connector.fetchSince(SINCE, new Set());
    expect(waits).toEqual([7_000]);
    expect(res.messages).toHaveLength(4);
  });

  it("clamps a Retry-After beyond the window to GMAIL_QUOTA.maxWaitMs", async () => {
    const waits: number[] = [];
    const { api, connector } = createFakeGmail({
      quota: { sleep: (ms) => (waits.push(ms), Promise.resolve()) },
    });
    api.failNext("messages.get", 403, 1, { ...RATE_LIMIT, retryAfterSeconds: 3_600 });
    await connector.fetchSince(SINCE, new Set());
    expect(waits).toEqual([GMAIL_QUOTA.maxWaitMs]);
    expect(GMAIL_QUOTA.maxWaitMs).toBe(GMAIL_QUOTA.windowMs + GMAIL_QUOTA.jitterMs);
  });

  it("a 429 on messages.list goes through the same gate (window wait, no per-call backoff)", async () => {
    const waits: number[] = [];
    const delays: number[] = [];
    const { api, connector } = createFakeGmail({
      retry: { sleep: (ms) => (delays.push(ms), Promise.resolve()) },
      quota: { sleep: (ms) => (waits.push(ms), Promise.resolve()), random: () => 0 },
    });
    api.failNext("messages.list", 429);
    const res = await connector.fetchSince(SINCE, new Set());
    expect(api.callsOf("messages.list")).toHaveLength(2);
    expect([waits, delays]).toEqual([[GMAIL_QUOTA.windowMs], []]);
    expect(res.messages).toHaveLength(4);
  });

  it("a non-rate-limit 403 (insufficientPermissions) is neither waited out nor retried", async () => {
    const waits: number[] = [];
    const delays: number[] = [];
    const { api, connector } = createFakeGmail({
      seed: many(1),
      retry: { sleep: (ms) => (delays.push(ms), Promise.resolve()) },
      quota: { sleep: (ms) => (waits.push(ms), Promise.resolve()) },
    });
    api.failNext("messages.get", 403, 1, { reason: "insufficientPermissions" });
    await expect(connector.fetchSince(SINCE, new Set())).rejects.toMatchObject({
      kind: "upstream",
      message: "Gmail messages.get failed (HTTP 403)",
    });
    expect(api.callsOf("messages.get")).toHaveLength(1);
    expect([waits, delays]).toEqual([[], []]);
  });

  it("fails with a typed rate_limited error (fixed text, no Google message) once the consecutive-wait cap is spent", async () => {
    const waits: number[] = [];
    const { api, connector } = createFakeGmail({
      seed: many(1),
      // A budget that cannot bind, so the consecutive cap is what ends it.
      quota: { sleep: (ms) => (waits.push(ms), Promise.resolve()), waitBudgetMs: 60 * 60_000 },
    });
    api.failNext("messages.get", 403, 100, RATE_LIMIT);
    const err = (await connector.fetchSince(SINCE, new Set()).catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({
      kind: "rate_limited",
      message: "Gmail messages.get rate limited (HTTP 403)",
    });
    expect(err.message).not.toContain(FAKE_GOOGLE_ERROR_TEXT);
    expect(waits).toHaveLength(GMAIL_QUOTA.maxConsecutiveWaits);
    expect(api.callsOf("messages.get")).toHaveLength(GMAIL_QUOTA.maxConsecutiveWaits + 1);
  });

  it("the fetch's total wait budget ends it rate_limited even when no streak hits the cap, handing over what it fetched", async () => {
    const seedMany = many(10);
    const waits: number[] = [];
    const delivered: string[] = [];
    const { api, connector } = createFakeGmail({
      seed: seedMany,
      concurrency: 1,
      quota: { sleep: (ms) => (waits.push(ms), Promise.resolve()), random: () => 0.5 },
    });
    // Every message is rate limited once, then succeeds: the streak never passes 1.
    for (const m of seedMany)
      api.failNext("messages.get", 403, 1, { ...RATE_LIMIT, id: m.id as string });
    const wait = GMAIL_QUOTA.windowMs + GMAIL_QUOTA.jitterMs / 2;
    const fits = Math.floor(GMAIL_QUOTA.waitBudgetMs / wait);
    await expect(
      connector.fetchSince(SINCE, new Set(), {
        onMessages: (batch) => {
          delivered.push(...batch.map((m) => m.id));
          return Promise.resolve();
        },
      }),
    ).rejects.toMatchObject({ kind: "rate_limited" });
    expect(waits).toEqual(Array.from({ length: fits }, () => wait));
    expect(delivered).toEqual(seedMany.slice(0, fits).map((m) => gmailId(m.id as string)));
  });

  it("on a caller abort the messages fetched but not yet handed over still reach onMessages", async () => {
    const seedMany = many(3);
    const inner = new FakeGmailApi(seedMany);
    const controller = new AbortController();
    const abortAfter = seedMany[1]?.id as string;
    const api: GmailApi = {
      users: {
        messages: {
          list: (p, o) => inner.users.messages.list(p, o),
          get: async (p, o) => {
            const res = await inner.users.messages.get(p, o);
            if (p.id === abortAfter) controller.abort(); // aborted with a fetched, undelivered batch
            return res;
          },
        },
      },
    };
    const connector = createGmailConnector({ api, concurrency: 1, quota: { pace: false } });
    const delivered: string[] = [];
    await expect(
      connector.fetchSince(SINCE, new Set(), {
        signal: controller.signal,
        onMessages: (batch) => {
          delivered.push(...batch.map((m) => m.id));
          return Promise.resolve();
        },
      }),
    ).rejects.toMatchObject({ message: "Gmail fetch cancelled" });
    expect(delivered).toEqual(seedMany.slice(0, 2).map((m) => gmailId(m.id as string)));
    expect(inner.callsOf("messages.get")).toHaveLength(2);
  });

  it("an abort during a quota wait ends the fetch at once (the real abortable wait, default window)", async () => {
    const api = new FakeGmailApi(many(3));
    const connector = createGmailConnector({ api, quota: { pace: false } });
    api.failNext("messages.get", 403, 1, RATE_LIMIT);
    const controller = new AbortController();
    const fetch = connector.fetchSince(SINCE, new Set(), { signal: controller.signal });
    while (api.callsOf("messages.get").length === 0) await ticks(1);
    await ticks();
    const calls = api.calls.length;
    const started = performance.now();
    controller.abort();
    await expect(fetch).rejects.toMatchObject({
      kind: "upstream",
      message: "Gmail fetch cancelled",
    });
    expect(performance.now() - started).toBeLessThan(1_000); // not the ~60 s window
    expect(api.calls).toHaveLength(calls);
  });

  it("paces calls proactively with the GMAIL_QUOTA token bucket (default constants)", async () => {
    const seedMany = many(12);
    let clock = 0;
    const sleeps: number[] = [];
    const connector = createGmailConnector({
      api: new FakeGmailApi(seedMany),
      concurrency: 1,
      quota: {
        now: () => clock,
        sleep: (ms) => {
          sleeps.push(ms);
          clock += ms;
          return Promise.resolve();
        },
      },
    });
    const res = await connector.fetchSince(SINCE, new Set());
    expect(res.messages).toHaveLength(12);
    const units = (seedMany.length + 1) * GMAIL_QUOTA.unitsPerCall; // 12 gets + 1 list
    expect(clock).toBe(
      ((units - GMAIL_QUOTA.paceBurstUnits) * 1000) / GMAIL_QUOTA.paceUnitsPerSecond,
    );
    expect(sleeps.every((ms) => ms > 0)).toBe(true);
  });

  it("after a rate-limit hit the pace halves and the bucket refills when the window resets", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const api = new FakeGmailApi(seed);
    const connector = createGmailConnector({
      api,
      concurrency: 1,
      quota: {
        pace: { unitsPerSecond: 10, burstUnits: 5 },
        now: () => clock,
        random: () => 0.5,
        sleep: (ms) => {
          sleeps.push(ms);
          clock += ms;
          return Promise.resolve();
        },
      },
    });
    // Newest first: ...04, ...03 (rate limited once), ...02, ...01.
    api.failNext("messages.get", 403, 1, { ...RATE_LIMIT, id: "19a0c0ffee000003" });
    const res = await connector.fetchSince(SINCE, new Set());
    expect(res.messages).toHaveLength(4);
    // list from the burst; 04 and 03 at 10 u/s; the window; 03 again from the refilled bucket;
    // 02 and 01 at the halved 5 u/s.
    expect(sleeps).toEqual([500, 500, GMAIL_QUOTA.windowMs + GMAIL_QUOTA.jitterMs / 2, 1000, 1000]);
  });
});

describe("FakeGmail query semantics", () => {
  it("honours after:, -in:spam, -in:trash and label ids", () => {
    const m = plainMessage("ab", "x", { labelIds: ["INBOX", "TRASH"] });
    expect(matchesQuery(m, "after:0 -in:trash", ["INBOX"])).toBe(false);
    expect(matchesQuery(m, "after:0", ["INBOX"])).toBe(true);
    expect(matchesQuery(m, "after:0", ["SENT"])).toBe(false);
    expect(matchesQuery(m, `after:${Date.parse("2026-10-11T00:00:00Z") / 1000}`, [])).toBe(false);
    expect(() => matchesQuery(m, "from:me", [])).toThrow(/unsupported/);
  });
});

describe("normalizeGmailMessage (MIME -> Message)", () => {
  it("multipart/alternative: text/plain preferred over text/html", () => {
    const m = normalizeGmailMessage(byId("19a0c0ffee000001"));
    expect(m).toEqual({
      id: "gmail:19a0c0ffee000001",
      source: "gmail",
      sender: "teacher@example.com",
      context: "Field trip permission slip due Friday",
      date: "2026-10-15T14:05:00.000Z",
      text: "Hi!\n\nPlease sign and return the field trip permission slip by Friday.\nDetails: https://school.example.com/trips/42.\n\nThanks,\nMs. Rivera",
      links: ["https://school.example.com/trips/42"],
      link: "https://mail.google.com/mail/u/0/#all/19a0c0ffee000001",
    });
    expect(m.text).not.toMatch(/<[a-z]/i);
    expect(parseMessageId(m.id)).toMatchObject({ gmailId: "19a0c0ffee000001" });
  });

  it("HTML-only: stripped with html-to-text (no tags, styles, scripts or images); href extracted", () => {
    const m = normalizeGmailMessage(byId("19a0c0ffee000002"));
    expect(m.text).toContain("AUTUMN SALE");
    expect(m.text).toContain("20% off all garden tools this weekend only.");
    expect(m.text).toContain("Shop now");
    expect(m.text).not.toMatch(/<|>|color:red|tracker|pixel/);
    expect(m.links).toEqual(["https://shop.example.com/sale?utm=mail&id=7"]);
    expect(m.sender).toBe("deals@shop.example.com");
  });

  it("non-UTF-8 (ISO-8859-1) body and RFC 2047 encoded headers decode correctly", () => {
    const raw = byId("19a0c0ffee000003");
    // The fixture really is Latin-1 bytes: decoding them as UTF-8 would garble them.
    const bytes = Buffer.from(raw.payload?.body?.data ?? "", "base64url");
    expect(bytes.includes(0xe9)).toBe(true);
    expect(bytes.toString("utf8")).not.toContain("café");
    const m = normalizeGmailMessage(raw);
    expect(m.text).toContain("The café on Rue Lafayette");
    expect(m.text).toContain("crème brûlée");
    expect(m.text).toContain("À bientôt,\nRenée");
    expect(m.text).not.toContain("�");
    expect(m.context).toBe("Réunion au café samedi");
    expect(m.sender).toBe("renee@example.com");
  });

  it("multipart/mixed: nested alternative read, attachment skipped, plain AND html links collected", () => {
    const m = normalizeGmailMessage(byId("19a0c0ffee000004"));
    expect(m.text).toBe(
      "Your account will be suspended. Verify your password within 24 hours at https://example.com/secure-login",
    );
    expect(m.links).toEqual([
      "https://example.com/secure-login",
      "http://login.verify.example.com/verify?u=me",
    ]);
  });

  it("other charsets (windows-1252, Shift_JIS) and an unknown label fall back sanely", () => {
    const mk = (data: string, charset: string): RawMessage => ({
      id: "abc1",
      internalDate: "0",
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "Content-Type", value: `text/plain; charset=${charset}` }],
        body: { data },
      },
    });
    const cp1252 = Buffer.from([0x93, 0x51, 0x94, 0x20, 0x80, 0x35]).toString("base64url");
    expect(normalizeGmailMessage(mk(cp1252, "windows-1252")).text).toBe("“Q” €5");
    const sjis = Buffer.from([0x82, 0xa0, 0x82, 0xa2]).toString("base64url"); // あい
    expect(normalizeGmailMessage(mk(sjis, "Shift_JIS")).text).toBe("あい");
    expect(normalizeGmailMessage(mk(b64("plain"), "x-no-such-charset")).text).toBe("plain");
  });

  it("caps text at 4000 chars on a code-point boundary", () => {
    const astral = "\u{1F600}"; // 2 UTF-16 code units
    const body = "a".repeat(MESSAGE_TEXT_MAX_CHARS - 1) + astral + "tail";
    const m = normalizeGmailMessage(plainMessage("ab12", body));
    expect(m.text).toHaveLength(MESSAGE_TEXT_MAX_CHARS - 1);
    expect(m.text.endsWith("a")).toBe(true);
    const even = normalizeGmailMessage(plainMessage("ab13", "b".repeat(5000)));
    expect(even.text).toHaveLength(MESSAGE_TEXT_MAX_CHARS);
    expect(truncateText("x".repeat(10), 10)).toBe("x".repeat(10));
    expect(truncateText(`xx${astral}`, 3)).toBe("xx");
    expect(truncateText(`xx${astral}`, 4)).toBe(`xx${astral}`);
  });

  it("truncateText guards max <= 0 (empty result, never a negative slice)", () => {
    expect(truncateText("abc", 0)).toBe("");
    expect(truncateText("abc", -5)).toBe("");
    expect(truncateText("\u{1F600}", 0)).toBe("");
    expect(truncateText("", 0)).toBe("");
    // Red anchor: unguarded, max -1 would be slice(0, -1) and keep "abc" (a negative slice end).
    expect(truncateText("abcd", -1)).toBe("");
    // Max 1 on an astral char steps back over the high surrogate to "".
    expect(truncateText("\u{1F600}", 1)).toBe("");
  });

  it("falls back to the snippet when there is no text part; empty headers stay empty", () => {
    const m = normalizeGmailMessage({
      id: "abcd",
      internalDate: "0",
      snippet: "Tom &amp; Jerry see https://example.com/x",
      payload: { mimeType: "multipart/mixed", parts: [] },
    });
    expect(m.text).toBe("Tom & Jerry see https://example.com/x");
    expect(m.links).toEqual(["https://example.com/x"]);
    expect(m.sender).toBe("");
    expect(m.context).toBe("");
    expect(m.date).toBe("1970-01-01T00:00:00.000Z");
  });

  it("rejects a non-hex id (ids come from Gmail; §3.1)", () => {
    expect(() => normalizeGmailMessage(plainMessage("not-hex!", "x"))).toThrow(/hex/);
  });

  it("every fixture is synthetic: example.com senders and links only", () => {
    for (const raw of seed) {
      const m = normalizeGmailMessage(raw);
      expect(m.sender).toMatch(/@([a-z0-9-]+\.)*example\.com$/);
      for (const link of m.links) expect(new URL(link).hostname).toMatch(/(^|\.)example\.com$/);
    }
  });
});

describe("header + link helpers", () => {
  it("decodes B and Q encoded-words, joining adjacent ones", () => {
    expect(decodeHeaderValue("=?UTF-8?B?w6l0w6k=?=")).toBe("été");
    expect(decodeHeaderValue("=?utf-8?q?a_b?= =?utf-8?q?_c?=")).toBe("a b c");
    expect(decodeHeaderValue("plain subject")).toBe("plain subject");
  });

  it("fromAddress extracts the address", () => {
    expect(fromAddress('"A, B" <ab@example.com>')).toBe("ab@example.com");
    expect(fromAddress("solo@example.com")).toBe("solo@example.com");
  });

  it("extractLinks strips trailing punctuation and dedups", () => {
    expect(
      extractLinks("see https://example.com/a. and (https://example.com/b) https://example.com/a"),
    ).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(extractLinks("ftp://example.com nothing")).toEqual([]);
  });
});

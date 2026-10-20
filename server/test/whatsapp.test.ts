// WhatsApp connector drain + read-only surface (plan §4, §5, §8; D9, D21, D23, D30), driven through
// FakeWhatsApp's scripted event emitter with fake timers for the 8 s quiet / 60 s max windows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@yarvis/shared";
import * as wa from "../src/connectors/whatsapp.js";
import {
  DisconnectReason,
  drain,
  MAX_WINDOW_MS,
  QUIET_WINDOW_MS,
  WaLoggedOut,
  type DrainResult,
  type WaMessage,
} from "../src/connectors/whatsapp.js";
import {
  createFakeWhatsApp,
  OPEN_STEP,
  type FakeWaScript,
  type FakeWaStep,
} from "../src/fakes/whatsapp.js";

const ME = "15555550123@s.whatsapp.net";
const FAMILY = "15555550100-1790000000@g.us";
const STRANGER = "15555550199@s.whatsapp.net";
const ALLOWLIST = [
  { jid: ME, name: "Me" },
  { jid: FAMILY, name: "" },
];
const SINCE = 1_791_000_000; // lastMessageTs cursor, epoch seconds
const DAY = 24 * 60 * 60;
const AUTH_DIR = "unused-by-fake";

function msg(
  jid: string,
  id: string,
  ts: WaMessage["messageTimestamp"],
  message: WaMessage["message"],
  extra: Partial<WaMessage> = {},
): WaMessage {
  return { key: { remoteJid: jid, id, fromMe: false }, messageTimestamp: ts, message, ...extra };
}

const history = (messages: WaMessage[]): FakeWaStep => ({
  event: "messaging-history.set",
  payload: {
    chats: [{ id: FAMILY, name: "Family" }],
    contacts: [],
    messages,
  },
});
const upsert = (messages: WaMessage[]): FakeWaStep => ({
  event: "messages.upsert",
  payload: { messages, type: "notify" },
});

function track(p: Promise<DrainResult>): { settled: () => boolean; result: Promise<DrainResult> } {
  let settled = false;
  const result = p.finally(() => {
    settled = true;
  });
  result.catch(() => undefined);
  return { settled: () => settled, result };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("drain", () => {
  it("keeps allowlisted text messages within sinceTs - 24 h and closes after 8 s of quiet", async () => {
    const script: FakeWaScript = [
      OPEN_STEP,
      history([
        msg(ME, "A1", SINCE + 100, { conversation: "Pay the water bill" }, { pushName: "Abe" }),
        // backlog: older than the cursor but inside the 24 h overlap, new id → kept
        msg(ME, "B2", SINCE - 3600, { conversation: "Call the plumber" }),
        // older than the overlap → dropped
        msg(ME, "C3", SINCE - DAY - 1, { conversation: "too old" }),
        msg(STRANGER, "D4", SINCE + 50, { conversation: "not allowlisted" }),
      ]),
      { wait: 5_000 },
      upsert([
        msg(
          FAMILY,
          "E5",
          { toNumber: () => SINCE + 200 } as unknown as WaMessage["messageTimestamp"],
          { extendedTextMessage: { text: "RSVP at https://example.com/party, please" } },
          { key: { remoteJid: FAMILY, id: "E5", participant: "15555550142@s.whatsapp.net" } },
        ),
        msg(ME, "F6", SINCE + 300, { imageMessage: { mimetype: "image/jpeg" } }),
        msg(ME, "A1", SINCE + 100, { conversation: "Pay the water bill" }), // redelivered
      ]),
    ];
    const fake = createFakeWhatsApp({ scripts: [script] });
    const run = track(
      drain({ authDir: AUTH_DIR, allowlist: ALLOWLIST, sinceTs: SINCE, deps: fake.deps }),
    );

    await vi.advanceTimersByTimeAsync(5_000 + QUIET_WINDOW_MS - 1);
    expect(run.settled()).toBe(false);
    expect(fake.sockets[0]!.endCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    const result = await run.result;
    expect(result.endedBy).toBe("quiet");
    expect(fake.sockets).toHaveLength(1);
    expect(fake.sockets[0]!.endCalls).toBe(1);
    const expected: Message[] = [
      {
        id: `wa:${ME}:B2`,
        source: "whatsapp",
        sender: ME,
        context: "Me",
        chatId: ME,
        date: new Date((SINCE - 3600) * 1000).toISOString(),
        text: "Call the plumber",
        links: [],
        link: "",
      },
      {
        id: `wa:${ME}:A1`,
        source: "whatsapp",
        sender: "Abe",
        context: "Me",
        chatId: ME,
        date: new Date((SINCE + 100) * 1000).toISOString(),
        text: "Pay the water bill",
        links: [],
        link: "",
      },
      {
        id: `wa:${FAMILY}:E5`,
        source: "whatsapp",
        sender: "15555550142@s.whatsapp.net",
        context: "Family",
        chatId: FAMILY,
        date: new Date((SINCE + 200) * 1000).toISOString(),
        text: "RSVP at https://example.com/party, please",
        links: ["https://example.com/party"],
        link: "",
      },
    ];
    expect(result.messages).toEqual(expected);
    expect(result.lastMessageTs).toBe(SINCE + 200);
  });

  it("skips out-of-range and far-future timestamps without aborting or moving the cursor", async () => {
    const nowMs = (SINCE + 1000) * 1000; // the drain's injected clock
    const fake = createFakeWhatsApp({
      scripts: [
        [
          OPEN_STEP,
          upsert([
            msg(ME, "V1", SINCE + 10, { conversation: "valid before" }),
            msg(ME, "X2", 1e15, { conversation: "beyond Date range" }),
            msg(ME, "X3", SINCE + 1000 + 2 * DAY, { conversation: "far future" }),
            msg(ME, "X4", Number.NaN, { conversation: "not a number" }),
            msg(ME, "V5", SINCE + 20, { conversation: "valid after" }),
          ]),
        ],
      ],
    });
    const run = drain({
      authDir: AUTH_DIR,
      allowlist: ALLOWLIST,
      sinceTs: SINCE,
      deps: fake.deps,
      now: () => nowMs,
    });
    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS);
    const result = await run;

    expect(result.messages.map((m) => m.id)).toEqual([`wa:${ME}:V1`, `wa:${ME}:V5`]);
    expect(result.lastMessageTs).toBe(SINCE + 20);
    expect(result.endedBy).toBe("quiet");
  });

  it("matches a LID-addressed message by key.remoteJidAlt and caps text at 4000 chars", async () => {
    const emoji = String.fromCodePoint(0x1f600); // two UTF-16 units
    const long = "x".repeat(5000);
    const straddling = "y".repeat(3999) + emoji + "z".repeat(10); // pair spans units 4000-4001
    const lid = "123456789012345@lid";
    const fake = createFakeWhatsApp({
      scripts: [
        [
          OPEN_STEP,
          upsert([
            msg(
              lid,
              "L1",
              SINCE,
              { conversation: long },
              {
                key: { remoteJid: lid, remoteJidAlt: ME, id: "L1" },
              },
            ),
            msg(ME, "S2", SINCE + 1, { conversation: straddling }),
            msg(lid, "N3", SINCE + 2, { conversation: "LID chat that is not allowlisted" }),
          ]),
        ],
      ],
    });
    const run = drain({ authDir: AUTH_DIR, allowlist: ALLOWLIST, sinceTs: SINCE, deps: fake.deps });
    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS);
    const { messages } = await run;

    expect(messages.map((m) => [m.id, m.chatId, m.context])).toEqual([
      [`wa:${ME}:L1`, ME, "Me"],
      [`wa:${ME}:S2`, ME, "Me"],
    ]);
    expect(messages[0]?.text).toBe("x".repeat(4000));
    expect(messages[1]?.text).toBe("y".repeat(3999)); // no lone high surrogate at the end
  });

  it("awaits a creds save emitted during end() before the drain resolves", async () => {
    const fake = createFakeWhatsApp({ scripts: [[OPEN_STEP]], credsOnEnd: true });
    const run = drain({ authDir: AUTH_DIR, allowlist: ALLOWLIST, sinceTs: SINCE, deps: fake.deps });
    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS);
    await run;
    expect(fake.sockets[0]!.endCalls).toBe(1);
    expect(fake.savedCreds).toBe(1); // the late save had completed when drain resolved
  });

  it("pins the read-only socket options on every session (§8)", async () => {
    const fake = createFakeWhatsApp({ scripts: [[OPEN_STEP]] });
    const run = drain({ authDir: AUTH_DIR, allowlist: ALLOWLIST, sinceTs: SINCE, deps: fake.deps });
    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS);
    await run;
    expect(fake.sockets[0]!.config).toMatchObject({
      markOnlineOnConnect: false,
      syncFullHistory: false,
      browser: ["Windows", "Yarvis", expect.any(String)],
    });
  });

  it("stops at the 60 s ceiling while events keep arriving", async () => {
    const steps: FakeWaStep[] = [OPEN_STEP];
    for (let i = 1; i <= 15; i++) {
      steps.push({ wait: 5_000 }, upsert([msg(ME, `M${i}`, SINCE + i, { conversation: `n${i}` })]));
    }
    const fake = createFakeWhatsApp({ scripts: [steps] });
    const run = track(
      drain({ authDir: AUTH_DIR, allowlist: ALLOWLIST, sinceTs: SINCE, deps: fake.deps }),
    );
    await vi.advanceTimersByTimeAsync(MAX_WINDOW_MS);
    const result = await run.result;
    expect(result.endedBy).toBe("max");
    expect(fake.sockets[0]!.endCalls).toBe(1);
    // events at 5 s … 55 s are in; the ceiling (armed first) wins the tie at 60 s
    expect(result.messages).toHaveLength(11);
  });

  it("raises WaLoggedOut on a loggedOut close", async () => {
    const fake = createFakeWhatsApp({
      scripts: [[{ close: DisconnectReason.loggedOut }]],
    });
    const run = track(
      drain({ authDir: AUTH_DIR, allowlist: ALLOWLIST, sinceTs: SINCE, deps: fake.deps }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const err = await run.result.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WaLoggedOut);
    expect((err as WaLoggedOut).reason).toBe("logged_out");
    expect((err as Error).message).toContain("re-run yarvis wa:link");
  });

  it("refuses to pair from a drain: a QR (no creds) raises WaLoggedOut not_linked and ends the socket", async () => {
    const fake = createFakeWhatsApp({
      scripts: [[{ event: "connection.update", payload: { qr: "2@synthetic-ref" } }]],
    });
    const run = track(
      drain({ authDir: AUTH_DIR, allowlist: ALLOWLIST, sinceTs: SINCE, deps: fake.deps }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await expect(run.result).rejects.toMatchObject({ name: "WaLoggedOut", reason: "not_linked" });
    expect(fake.sockets[0]!.endCalls).toBe(1);
  });

  it("ends with what was collected on any other close", async () => {
    const fake = createFakeWhatsApp({
      scripts: [
        [
          OPEN_STEP,
          upsert([msg(ME, "K1", SINCE, { conversation: "kept" })]),
          { wait: 1_000 },
          { close: DisconnectReason.connectionLost },
          upsert([msg(ME, "K2", SINCE, { conversation: "after close" })]),
        ],
      ],
    });
    const run = track(
      drain({ authDir: AUTH_DIR, allowlist: ALLOWLIST, sinceTs: SINCE, deps: fake.deps }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await run.result;
    expect(result.endedBy).toBe("closed");
    expect(result.messages.map((m) => m.id)).toEqual([`wa:${ME}:K1`]);
  });

  it("opens no session for an empty allowlist", async () => {
    const fake = createFakeWhatsApp();
    const result = await drain({
      authDir: AUTH_DIR,
      allowlist: [],
      sinceTs: SINCE,
      deps: fake.deps,
    });
    expect(result.messages).toEqual([]);
    expect(fake.sockets).toHaveLength(0);
  });

  it("drains the synthetic fixture (fake-mode default) for the example allowlist", async () => {
    const fake = createFakeWhatsApp();
    const run = drain({
      authDir: AUTH_DIR,
      allowlist: [{ jid: ME, name: "Me" }],
      sinceTs: 1_790_812_800, // settings.example since 2026-10-01
      deps: fake.deps,
    });
    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS);
    const { messages } = await run;
    expect(messages.map((m) => m.id)).toEqual([
      `wa:${ME}:3EB0FAKE000000000001`,
      `wa:${ME}:3EB0FAKE000000000003`,
    ]);
  });
});

// Compile-time (enforced by tsc via `npm run typecheck`, not by vitest): neither the module namespace
// nor the socket seam has a send* member.
type NoSend<K> = [Extract<K, `send${string}` | `Send${string}`>] extends [never] ? true : false;
const _moduleHasNoSend: NoSend<keyof typeof wa> = true;
const _socketHasNoSend: NoSend<keyof wa.WaSocket> = true;

describe("read-only exported surface", () => {
  it("exports no member whose name starts with send", () => {
    expect(Object.keys(wa).filter((k) => /^send/i.test(k))).toEqual([]);
  });
});

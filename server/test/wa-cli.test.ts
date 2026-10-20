// `yarvis wa:link [--reset]` / `yarvis wa:chats` through the production CLI entry (runCli) with the
// FakeWhatsApp socket seam injected (plan §5, Step M3; D19, D23).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as realSleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli, type CliIo } from "../src/cli.js";
import {
  DisconnectReason,
  GROUP_QUERY_GRACE_MS,
  QUIET_WINDOW_MS,
  waAuthDir,
} from "../src/connectors/whatsapp.js";
import { createFakeWhatsApp, OPEN_STEP, type FakeWaScript } from "../src/fakes/whatsapp.js";
import { acquireLock } from "../src/lock.js";
import { tempPaths } from "./helpers.js";

function capture(): CliIo & { out_: string[]; err_: string[] } {
  const out_: string[] = [];
  const err_: string[] = [];
  return { out_, err_, out: (l) => out_.push(l), err: (l) => err_.push(l) };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  while (cleanups.length) cleanups.pop()!();
});

function setup(scripts?: readonly FakeWaScript[]) {
  const { paths, cleanup } = tempPaths();
  cleanups.push(cleanup);
  const fake = createFakeWhatsApp({
    ...(scripts ? { scripts } : {}),
    groups: {
      "15555550100-1790000000@g.us": { id: "15555550100-1790000000@g.us", subject: "Family" },
    },
  });
  return { paths, fake, io: capture() };
}

/**
 * Waits for real I/O (lazy import, lock file, cache writes) WITHOUT moving fake time, bounded in REAL
 * time: a fixed number of event-loop turns can elapse before a slow fs completion arrives under load.
 * node:timers/promises is not faked (toFake covers the global setTimeout/clearTimeout only).
 */
async function untilRealIo(done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!done() && performance.now() < deadline) await realSleep(2);
}

const QR_STEP = { event: "connection.update", payload: { qr: "2@synthetic-pairing-ref" } } as const;
const CREDS_STEP = { event: "creds.update", payload: {} } as const;

/**
 * Drives the drain window under fake setTimeout while letting real fs I/O (the lock file) run:
 * yields a short real sleep, then advances fake time, until the command settles.
 */
async function settleWithFakeTime<T>(p: Promise<T>): Promise<T> {
  let done = false;
  void p.finally(() => (done = true)).catch(() => undefined);
  // Bounded in REAL time, not event-loop turns (see untilRealIo).
  const deadline = performance.now() + 15_000;
  while (!done && performance.now() < deadline) {
    await realSleep(1);
    await vi.advanceTimersByTimeAsync(500);
  }
  return p;
}

describe("yarvis wa:link", () => {
  it("prints the QR, re-creates the socket once on restartRequired, and reports linked as Yarvis", async () => {
    const { paths, fake, io } = setup([
      [QR_STEP, CREDS_STEP, { close: DisconnectReason.restartRequired }],
      [CREDS_STEP, OPEN_STEP],
    ]);
    const code = await runCli(["wa:link"], io, { paths, wa: fake.deps });

    expect(io.err_).toEqual([]);
    expect(code).toBe(0);
    expect(fake.sockets).toHaveLength(2);
    expect(fake.authDirs).toEqual([waAuthDir(paths)]);
    expect(fake.savedCreds).toBe(2);
    const qrRow = io.out_.findIndex((l) => l.includes("▄"));
    expect(qrRow).toBeGreaterThanOrEqual(0);
    expect(io.out_.indexOf("linked as Yarvis")).toBeGreaterThan(qrRow);
    expect(fake.sockets[1]!.endCalls).toBe(1);
    expect(existsSync(paths.lockFile)).toBe(false);
  });

  it.each([
    {
      name: "a second restartRequired",
      scripts: [[{ close: DisconnectReason.restartRequired }]],
      sockets: 2,
      message: "WhatsApp link failed: connection closed (515)",
    },
    {
      name: "loggedOut",
      scripts: [[{ close: DisconnectReason.loggedOut }]],
      sockets: 1,
      message: "WhatsApp logged out: re-run yarvis wa:link --reset",
    },
  ])("exits 1 on $name without printing linked", async ({ scripts, sockets, message }) => {
    const { paths, fake, io } = setup(scripts);
    expect(await runCli(["wa:link"], io, { paths, wa: fake.deps })).toBe(1);
    expect(io.err_).toEqual([`yarvis wa:link: ${message}`]);
    expect(io.out_).not.toContain("linked as Yarvis");
    expect(fake.sockets).toHaveLength(sockets);
    expect(existsSync(paths.lockFile)).toBe(false);
  });

  it("awaits a creds save emitted during end() before wa:link (and wa:chats) return", async () => {
    const link = setup([[OPEN_STEP]]);
    const linkFake = createFakeWhatsApp({ scripts: [[OPEN_STEP]], credsOnEnd: true });
    expect(await runCli(["wa:link"], link.io, { paths: link.paths, wa: linkFake.deps })).toBe(0);
    expect(linkFake.savedCreds).toBe(1);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const chats = setup();
    const chatsFake = createFakeWhatsApp({ scripts: [[OPEN_STEP]], credsOnEnd: true });
    const code = await settleWithFakeTime(
      runCli(["wa:chats"], chats.io, { paths: chats.paths, wa: chatsFake.deps }),
    );
    expect(code).toBe(0);
    expect(chatsFake.savedCreds).toBe(1);
  });

  it("--reset clears private/wa-auth before linking; without it the creds stay", async () => {
    const { paths, fake, io } = setup([[OPEN_STEP]]);
    const marker = path.join(waAuthDir(paths), "creds.json");
    mkdirSync(waAuthDir(paths), { recursive: true });
    writeFileSync(marker, "{}");

    expect(await runCli(["wa:link"], io, { paths, wa: fake.deps })).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(await runCli(["wa:link", "--reset"], io, { paths, wa: fake.deps })).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("yarvis wa:chats", () => {
  it("prints name + JID for history chats, named contacts and groups, then closes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { paths, fake, io } = setup(); // default script: open + synthetic fixture events
    const code = await settleWithFakeTime(runCli(["wa:chats"], io, { paths, wa: fake.deps }));

    expect(io.err_).toEqual([]);
    expect(code).toBe(0);
    const rows = io.out_.map((l) => l.trim().split(/\s{2,}/));
    expect(rows[0]).toEqual(["NAME", "JID"]);
    expect(rows.slice(1, 5)).toEqual([
      ["Family (synthetic)", "15555550100-1790000000@g.us"],
      ["Me", "15555550123@s.whatsapp.net"],
      ["Not allowlisted (synthetic)", "15555550199@s.whatsapp.net"],
      ["Sam (synthetic)", "15555550142@s.whatsapp.net"],
    ]);
    expect(io.out_.join("\n")).not.toContain("15555550177"); // unnamed, chat-less contact
    expect(io.out_.join("\n")).toContain("whatsapp.allowlist");
    expect(fake.sockets).toHaveLength(1);
    expect(fake.sockets[0]!.endCalls).toBe(1);
    expect(existsSync(paths.lockFile)).toBe(false);
  });

  it("resolves promptly after the window even when the group-list query never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { paths, cleanup } = tempPaths();
    cleanups.push(cleanup);
    const fake = createFakeWhatsApp({ groups: null }); // default fixture script
    const io = capture();
    let code: number | undefined;
    const run = runCli(["wa:chats"], io, { paths, wa: fake.deps }).then((c) => (code = c));

    // Let the real I/O before the session (lazy import, lock file) finish without moving fake time.
    await untilRealIo(() => fake.sockets.length > 0);
    expect(fake.sockets).toHaveLength(1);
    // From socket creation, step fake time in 100 ms slices and record when the runner resolves.
    // The budget is the 8 s quiet window plus the 2 s group-query grace.
    const budgetMs = QUIET_WINDOW_MS + GROUP_QUERY_GRACE_MS + 500;
    let elapsedMs = 0;
    while (code === undefined && elapsedMs < budgetMs) {
      await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(100);
      elapsedMs += 100;
    }
    // Fake time is now frozen at the budget: only real I/O (lock release) may still complete.
    await untilRealIo(() => code !== undefined);
    expect(code).toBe(0);
    expect(elapsedMs).toBeGreaterThanOrEqual(QUIET_WINDOW_MS);
    expect(fake.sockets[0]?.endCalls).toBe(1);
    expect(existsSync(paths.lockFile)).toBe(false);
    await run;
    expect(io.out_.join("\n")).toContain("15555550123@s.whatsapp.net");
  });

  it("strips terminal escapes, control and bidi characters from remote-set names", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ESC = String.fromCharCode(0x1b);
    const BEL = String.fromCharCode(0x07);
    const RLO = String.fromCharCode(0x202e);
    const NEL = String.fromCharCode(0x85);
    const { paths, fake, io } = setup([
      [
        OPEN_STEP,
        {
          event: "messaging-history.set",
          payload: {
            chats: [{ id: "15555550101@s.whatsapp.net", name: `Evil${ESC}[2J${RLO}Name${NEL}` }],
            contacts: [{ id: "15555550102@s.whatsapp.net", notify: `${ESC}]0;pwned${BEL}Bob` }],
            messages: [],
          },
        },
      ],
    ]);
    expect(await settleWithFakeTime(runCli(["wa:chats"], io, { paths, wa: fake.deps }))).toBe(0);

    const out = io.out_.join("\n");
    for (const ch of [ESC, BEL, RLO, NEL]) expect(out).not.toContain(ch);
    const rows = io.out_.map((l) => l.trim().split(/\s{2,}/));
    expect(rows).toContainEqual(["Bob", "15555550102@s.whatsapp.net"]);
    expect(rows).toContainEqual(["EvilName", "15555550101@s.whatsapp.net"]);
  });
});

describe("wa verbs take private/refresh.lock (D19)", () => {
  it.each(["wa:link", "wa:chats"])("%s refuses while the lock is held", async (verb) => {
    const { paths, fake, io } = setup();
    const held = await acquireLock(paths.lockFile);
    try {
      expect(await runCli([verb], io, { paths, wa: fake.deps })).toBe(1);
      expect(io.err_).toEqual([`yarvis ${verb}: refresh already running`]);
      expect(fake.sockets).toHaveLength(0);
    } finally {
      await held.release();
    }
  });
});

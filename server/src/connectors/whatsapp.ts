// WhatsApp connector (plan §1.2, §5, §8, §12.3; D9, D19, D21, D23, D30). The ONLY importer of
// @whiskeysockets/baileys (pinned 7.0.0-rc14). On-demand, never a daemon: each call opens one
// linked-device session, collects, and closes.
//
// READ-ONLY: this module's exported surface has no send-capable member. The real Baileys socket is
// adapted to the narrow `WaSocket` below (event subscription, close, and the read-only group list
// query) and never escapes this file; no outgoing message, presence, read-receipt or chat/group
// mutation API is referenced anywhere under server/src (server/test/readonly-guard.test.ts).
// Socket options are pinned: markOnlineOnConnect false (no "online" presence, the phone keeps
// notifying), syncFullHistory false, browser Browsers.windows("Yarvis") (the linked-device name),
// and a silent logger so no Baileys log line can echo message content. Message bodies are never
// printed; the pairing QR goes only to the terminal.
//
// Installed surface relied on (node_modules/@whiskeysockets/baileys/lib/Types/Events.d.ts,
// BaileysEventMap, read before coding):
//   'connection.update': Partial<ConnectionState>
//       ConnectionState: { connection: 'open' | 'connecting' | 'close';
//                          lastDisconnect?: { error: Boom | Error | undefined; date: Date };
//                          qr?: string; ... }                                  (Types/State.d.ts)
//   'creds.update': Partial<AuthenticationCreds>
//   'messaging-history.set': { chats: Chat[]; contacts: Contact[]; messages: WAMessage[];
//                              isLatest?: boolean; progress?: number | null; syncType?: ... }
//   'messages.upsert': { messages: WAMessage[]; type: MessageUpsertType; requestId?: string }
//       ("if requestId is provided, then the messages was received from the phone due to it
//        being unavailable")
//   WAMessage = proto.IWebMessageInfo & { key: WAMessageKey }:
//       key.{remoteJid, fromMe, id, participant} + WAMessageKey.remoteJidAlt,
//       messageTimestamp?: number | Long | null (epoch seconds), participant?, pushName?,
//       message?.conversation, message?.extendedTextMessage?.text
//   Chat = proto.IConversation & ...: id?, name?        Contact: id, name?, notify?, verifiedName?
//   GroupMetadata (groupFetchAllParticipating(), a read-only query): id, subject
// DisconnectReason (Types/index.d.ts): connectionClosed 428, connectionLost 408,
//   connectionReplaced 440, timedOut 408, loggedOut 401, badSession 500, restartRequired 515,
//   multideviceMismatch 411, forbidden 403, unavailableService 503. The close code is the Boom
//   `lastDisconnect.error.output.statusCode`.
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  type AuthenticationState,
  type BaileysEventMap,
  type Chat,
  type Contact,
  type UserFacingSocketConfig,
  type WAMessage,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { waId, type AllowlistEntry, type Message } from "@yarvis/shared";
import type { Paths } from "../config/paths.js";

/** Re-exported for close-code handling in the fake and the CLI (an enum of numbers only). */
export { DisconnectReason };

/** D9: a drain ends after this long without a new history/message event... */
export const QUIET_WINDOW_MS = 8_000;
/** ...or after this long in total, whichever comes first. */
export const MAX_WINDOW_MS = 60_000;
/** D21: a drain keeps messages up to 24 h older than `sinceTs`; id dedup absorbs the overlap. */
export const OVERLAP_SECONDS = 24 * 60 * 60;
/** D14: stored body cap. */
export const MAX_TEXT_CHARS = 4000;
/** The linked-device name shown on the phone under Linked Devices. */
export const DEVICE_NAME = "Yarvis";

/** `private/wa-auth/`: the Baileys `useMultiFileAuthState` directory (§3.3). */
export function waAuthDir(paths: Paths): string {
  return path.join(paths.privateDir, "wa-auth");
}

// ---------------------------------------------------------------------------------------------
// The narrow socket seam. Production adapts the real Baileys socket to it; FakeWhatsApp
// (server/src/fakes/whatsapp.ts) implements it for tests and fake mode.

export type WaAuthState = AuthenticationState;
export type WaMessage = WAMessage;
export type WaChat = Chat;
export type WaContact = Contact;

/** The only Baileys events this module listens to (payload types are Baileys' own). */
export interface WaEventMap {
  "connection.update": BaileysEventMap["connection.update"];
  "creds.update": BaileysEventMap["creds.update"];
  "messaging-history.set": BaileysEventMap["messaging-history.set"];
  "messages.upsert": BaileysEventMap["messages.upsert"];
}
export type WaEvent = keyof WaEventMap;

export interface WaSocket {
  ev: { on<E extends WaEvent>(event: E, listener: (arg: WaEventMap[E]) => void): void };
  /**
   * Closes the session; Baileys then emits `connection.update` `close`. Resolves once Baileys'
   * own end() has finished (its socket-end handlers and final events included).
   */
  end(error?: Error): Promise<void>;
  /** Read-only group list query (§12.3): jid → {id, subject}. */
  groupFetchAllParticipating(): Promise<Record<string, { id: string; subject?: string | null }>>;
}

type WaLogger = NonNullable<UserFacingSocketConfig["logger"]>;

/** The pinned socket options (§5, §8). The literal `false` types make the pins compile-time too. */
export interface WaSocketConfig {
  auth: WaAuthState;
  markOnlineOnConnect: false;
  syncFullHistory: false;
  browser: [string, string, string];
  logger: WaLogger;
}

export interface WaDeps {
  loadAuth(dir: string): Promise<{ state: WaAuthState; saveCreds: () => Promise<void> }>;
  makeSocket(config: WaSocketConfig): WaSocket;
}

const noop = (): void => undefined;
const SILENT_LOGGER: WaLogger = {
  level: "silent",
  child: () => SILENT_LOGGER,
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

export function socketConfig(auth: WaAuthState): WaSocketConfig {
  return {
    auth,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    browser: Browsers.windows(DEVICE_NAME),
    logger: SILENT_LOGGER,
  };
}

/** The real seam: `useMultiFileAuthState` + `makeWASocket`, narrowed to `WaSocket`. */
export const baileysDeps: WaDeps = {
  loadAuth: (dir) => useMultiFileAuthState(dir),
  makeSocket: (config) => {
    const sock = makeWASocket(config);
    return {
      ev: { on: (event, listener) => sock.ev.on(event, listener) },
      end: (error) => sock.end(error).catch(noop),
      groupFetchAllParticipating: () => sock.groupFetchAllParticipating(),
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Typed errors.

export type WaLoggedOutReason = "logged_out" | "not_linked";

/** The session is logged out (DisconnectReason.loggedOut) or was never linked (a QR was offered). */
export class WaLoggedOut extends Error {
  constructor(readonly reason: WaLoggedOutReason) {
    super(
      `WhatsApp ${reason === "not_linked" ? "is not linked" : "logged out"}: re-run yarvis wa:link --reset`,
    );
    this.name = "WaLoggedOut";
  }
}

/** Linking failed with a close other than loggedOut (or a second restartRequired). */
export class WaLinkError extends Error {
  constructor(readonly statusCode: number | undefined) {
    super(`WhatsApp link failed: connection closed (${statusCode ?? "unknown"})`);
    this.name = "WaLinkError";
  }
}

function disconnectCode(update: WaEventMap["connection.update"]): number | undefined {
  const err = update.lastDisconnect?.error as { output?: { statusCode?: unknown } } | undefined;
  const code = err?.output?.statusCode;
  return typeof code === "number" ? code : undefined;
}

// ---------------------------------------------------------------------------------------------
// Session teardown: end the socket, then await every creds save it started.

/** Upper bound on awaiting Baileys' end() (its websocket close waits for the peer's close frame). */
export const END_GRACE_MS = 2_000;

async function endWithin(sock: WaSocket): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    sock.end(undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, END_GRACE_MS);
    }),
  ]);
  clearTimeout(timer);
}

interface CredsTracker {
  /** The `creds.update` listener: starts a save while the tracker is attached. */
  onUpdate: () => void;
  /**
   * One settle pass (events queued by end() land first), then detach (no later save can start),
   * then await every started save, looping until no new save was added. Returns the failures.
   */
  flush: () => Promise<unknown[]>;
}

function trackCreds(saveCreds: () => Promise<void>): CredsTracker {
  const saves: Promise<void>[] = [];
  let attached = true;
  return {
    onUpdate: () => {
      if (attached) saves.push(Promise.resolve().then(saveCreds));
    },
    flush: async () => {
      await nextTurn();
      attached = false;
      let results: PromiseSettledResult<void>[] = [];
      for (let awaited = -1; awaited !== saves.length;) {
        awaited = saves.length;
        results = await Promise.allSettled(saves);
      }
      return results.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// linkDevice: QR pairing (D23).

export interface LinkOptions {
  authDir: string;
  /** Terminal output: QR rows and the final `linked as Yarvis`. */
  out: (line: string) => void;
  deps?: WaDeps;
}

/**
 * Prints the pairing QR from `connection.update.qr`, saves creds on every `creds.update`, re-creates
 * the socket ONCE on a `restartRequired` close (WhatsApp's normal post-pairing restart), and reports
 * `linked as Yarvis` on `connection: "open"`. A `loggedOut` close throws `WaLoggedOut`; any other
 * close (or a second restartRequired) throws `WaLinkError`.
 */
export async function linkDevice(opts: LinkOptions): Promise<void> {
  const deps = opts.deps ?? baileysDeps;
  const { state, saveCreds } = await deps.loadAuth(opts.authDir);
  const creds = trackCreds(saveCreds);

  const connect = (restarted: boolean): Promise<WaSocket> =>
    new Promise<WaSocket>((resolve, reject) => {
      const sock = deps.makeSocket(socketConfig(state));
      let settled = false;
      sock.ev.on("creds.update", creds.onUpdate);
      sock.ev.on("connection.update", (update) => {
        if (settled) return;
        if (update.qr) {
          opts.out("Scan with WhatsApp > Settings > Linked Devices > Link a device:");
          qrcode.generate(update.qr, { small: true }, (rendered) => opts.out(rendered));
        }
        if (update.connection === "open") {
          settled = true;
          resolve(sock);
        } else if (update.connection === "close") {
          settled = true;
          const code = disconnectCode(update);
          if (code === DisconnectReason.restartRequired && !restarted) {
            connect(true).then(resolve, reject);
          } else if (code === DisconnectReason.loggedOut) {
            reject(new WaLoggedOut("logged_out"));
          } else {
            reject(new WaLinkError(code));
          }
        }
      });
    });

  let saveErrors: unknown[] = [];
  try {
    const sock = await connect(false);
    await endWithin(sock);
  } finally {
    // Every creds save started by this session (including one emitted during end()) completes
    // before linkDevice settles, so the CLI's exit cannot cut a save short.
    saveErrors = await creds.flush();
  }
  if (saveErrors.length > 0) {
    throw new Error("saving WhatsApp credentials failed", { cause: saveErrors[0] });
  }
  opts.out(`linked as ${DEVICE_NAME}`);
}

// ---------------------------------------------------------------------------------------------
// The collect window shared by drain and listChats: quiet 8 s / max 60 s (D9).

export type WindowEnd = "quiet" | "max" | "closed";

interface WindowOptions {
  authDir: string;
  deps: WaDeps;
  quietMs: number;
  maxMs: number;
  onOpen?: (sock: WaSocket) => void;
  onHistory?: (payload: WaEventMap["messaging-history.set"]) => void;
  onUpsert?: (payload: WaEventMap["messages.upsert"]) => void;
}

async function collectWindow(opts: WindowOptions): Promise<WindowEnd> {
  const { state, saveCreds } = await opts.deps.loadAuth(opts.authDir);
  const creds = trackCreds(saveCreds);
  const sock = opts.deps.makeSocket(socketConfig(state));
  let mustEnd = false;

  try {
    return await new Promise<WindowEnd>((resolve, reject) => {
      let done = false;
      let quiet: NodeJS.Timeout | undefined;

      const finish = (how: WindowEnd, error?: Error): void => {
        if (done) return;
        done = true;
        clearTimeout(quiet);
        clearTimeout(max);
        mustEnd = how !== "closed" || error !== undefined;
        if (error) reject(error);
        else resolve(how);
      };
      const max = setTimeout(() => finish("max"), opts.maxMs);
      const bump = (): void => {
        if (done) return;
        clearTimeout(quiet);
        quiet = setTimeout(() => finish("quiet"), opts.quietMs);
      };

      sock.ev.on("creds.update", creds.onUpdate);
      sock.ev.on("connection.update", (update) => {
        if (done) return;
        // A QR means there are no usable creds: never pair from a drain (the QR is not printed).
        if (update.qr) return finish("closed", new WaLoggedOut("not_linked"));
        if (update.connection === "open") {
          bump();
          opts.onOpen?.(sock);
        } else if (update.connection === "close") {
          if (disconnectCode(update) === DisconnectReason.loggedOut) {
            finish("closed", new WaLoggedOut("logged_out"));
          } else {
            finish("closed");
          }
        }
      });
      sock.ev.on("messaging-history.set", (payload) => {
        if (done) return;
        opts.onHistory?.(payload);
        bump();
      });
      sock.ev.on("messages.upsert", (payload) => {
        if (done) return;
        opts.onUpsert?.(payload);
        bump();
      });
    });
  } finally {
    // End first (a remote close needs none), then await every creds save the session started.
    if (mustEnd) await endWithin(sock);
    await creds.flush();
  }
}

// ---------------------------------------------------------------------------------------------
// drain: allowlisted messages since a cursor (§4 whatsapp stage).

export interface DrainOptions {
  authDir: string;
  allowlist: readonly AllowlistEntry[];
  /** Epoch seconds: `whatsapp.lastMessageTs`, or `settings.since` 00:00Z on the first run. */
  sinceTs: number;
  deps?: WaDeps;
  quietMs?: number;
  maxMs?: number;
  /** Clock (epoch ms) for the future-timestamp bound; default `Date.now`. */
  now?: () => number;
}

/** A messageTimestamp more than this far past the drain's clock is rejected (clock skew allowance). */
export const MAX_FUTURE_SKEW_SECONDS = 24 * 60 * 60;

export interface DrainResult {
  /** Allowlisted text messages with `messageTimestamp >= sinceTs - 24 h`, deduped by id. */
  messages: Message[];
  /** Max `messageTimestamp` (epoch seconds) among `messages`; null when none. */
  lastMessageTs: number | null;
  endedBy: WindowEnd;
}

/** `messageTimestamp` is `number | Long | null` (protobufjs); Long exposes `toNumber()`. */
function epochSeconds(ts: WaMessage["messageTimestamp"]): number | null {
  if (typeof ts === "number") return ts;
  if (ts && typeof ts === "object" && typeof ts.toNumber === "function") return ts.toNumber();
  return null;
}

/**
 * A usable timestamp is finite, positive and at most MAX_FUTURE_SKEW_SECONDS past `nowSeconds`.
 * Anything else (e.g. 1e15, which `new Date(ts * 1000)` rejects with RangeError) is skipped, so it
 * can neither abort the drain nor advance the lastMessageTs cursor.
 */
function isUsableTimestamp(ts: number, nowSeconds: number): boolean {
  return Number.isFinite(ts) && ts > 0 && ts <= nowSeconds + MAX_FUTURE_SKEW_SECONDS;
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCT = /[),.;:!?\]]+$/;

function extractLinks(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(TRAILING_PUNCT, "");
    if (url.length > "https://".length) out.add(url);
  }
  return [...out];
}

/** D14 cap at MAX_TEXT_CHARS UTF-16 units, never leaving half of a surrogate pair at the end. */
function capText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  const cut = text.slice(0, MAX_TEXT_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}

/**
 * Collects `messaging-history.set` and `messages.upsert` messages until 8 s of quiet or 60 s, then
 * closes. Keeps a message when its chat is allowlisted (`key.remoteJid`, or `key.remoteJidAlt` for a
 * LID-addressed copy of an allowlisted phone-number chat) and `messageTimestamp >= sinceTs - 24 h`.
 * Text = `conversation ?? extendedTextMessage.text`; messages without text, or with an
 * unusable timestamp (non-finite, <= 0, > 24 h past the drain clock), are skipped. A
 * `loggedOut` close throws `WaLoggedOut`; any other close ends the drain with what was collected.
 * An empty allowlist returns immediately without opening a session.
 */
export async function drain(opts: DrainOptions): Promise<DrainResult> {
  const allow = new Map(opts.allowlist.map((e) => [e.jid, e.name]));
  if (allow.size === 0) return { messages: [], lastMessageTs: null, endedBy: "closed" };
  const cutoff = opts.sinceTs - OVERLAP_SECONDS;
  const clock = opts.now ?? Date.now;
  const chatNames = new Map<string, string>();
  const raw: Array<{ jid: string; keyId: string; msg: WaMessage; ts: number; text: string }> = [];
  const seen = new Set<string>();

  const take = (messages: readonly WaMessage[]): void => {
    for (const msg of messages) {
      const key = msg.key;
      const jid = [key.remoteJid, key.remoteJidAlt].find((j) => j != null && allow.has(j));
      const keyId = key.id;
      if (!jid || !keyId) continue;
      const ts = epochSeconds(msg.messageTimestamp);
      if (ts === null || !isUsableTimestamp(ts, clock() / 1000) || ts < cutoff) continue;
      const text = nonEmpty(msg.message?.conversation ?? msg.message?.extendedTextMessage?.text);
      if (!text) continue;
      const dedupKey = `${jid}\u0000${keyId}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      raw.push({ jid, keyId, msg, ts, text });
    }
  };

  const endedBy = await collectWindow({
    authDir: opts.authDir,
    deps: opts.deps ?? baileysDeps,
    quietMs: opts.quietMs ?? QUIET_WINDOW_MS,
    maxMs: opts.maxMs ?? MAX_WINDOW_MS,
    onHistory: (payload) => {
      for (const chat of payload.chats) {
        const name = nonEmpty(chat.name);
        if (chat.id && name) chatNames.set(chat.id, name);
      }
      take(payload.messages);
    },
    onUpsert: (payload) => take(payload.messages),
  });

  const messages: Message[] = [];
  let lastMessageTs: number | null = null;
  for (const { jid, keyId, msg, ts, text } of raw) {
    let id: string;
    try {
      id = waId(jid, keyId);
    } catch {
      continue; // a key.id containing ":" cannot form a parseable id (§3.1)
    }
    messages.push({
      id,
      source: "whatsapp",
      // D30: pushName, else participant JID, else remoteJid.
      sender:
        nonEmpty(msg.pushName) ?? nonEmpty(msg.key.participant) ?? nonEmpty(msg.participant) ?? jid,
      context: nonEmpty(allow.get(jid)) ?? chatNames.get(jid) ?? jid,
      chatId: jid,
      date: new Date(ts * 1000).toISOString(),
      text: capText(text),
      links: extractLinks(text),
      link: "",
    });
    lastMessageTs = lastMessageTs === null ? ts : Math.max(lastMessageTs, ts);
  }
  messages.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return { messages, lastMessageTs, endedBy };
}

// ---------------------------------------------------------------------------------------------
// listChats: names + JIDs for the allowlist (Step M3).

export interface ChatEntry {
  jid: string;
  name: string;
}

export interface ListChatsOptions {
  authDir: string;
  deps?: WaDeps;
  quietMs?: number;
  maxMs?: number;
}

const HIDDEN_JIDS = new Set(["status@broadcast"]);
/** How long listChats waits for an unfinished group-list query once the window has ended. */
export const GROUP_QUERY_GRACE_MS = 2_000;

/**
 * Opens one session and collects chats and contacts from `messaging-history.set` plus the
 * participating groups (read-only query), until the quiet/max window ends. Name precedence: chat
 * name, group subject, contact name, contact notify name, verified name, else "". Contacts appear
 * only when they carry a name. Sorted by name, then JID.
 */
export async function listChats(opts: ListChatsOptions): Promise<ChatEntry[]> {
  const chatIds = new Set<string>();
  const names = new Map<string, string>();
  const contactNames = new Map<string, string>();
  let groups: Promise<void> = Promise.resolve();

  await collectWindow({
    authDir: opts.authDir,
    deps: opts.deps ?? baileysDeps,
    quietMs: opts.quietMs ?? QUIET_WINDOW_MS,
    maxMs: opts.maxMs ?? MAX_WINDOW_MS,
    onOpen: (sock) => {
      groups = sock.groupFetchAllParticipating().then(
        (all) => {
          for (const group of Object.values(all)) {
            chatIds.add(group.id);
            const subject = nonEmpty(group.subject);
            if (subject && !names.has(group.id)) names.set(group.id, subject);
          }
        },
        noop, // optional enrichment: a failed or interrupted query lists history chats only
      );
    },
    onHistory: (payload) => {
      for (const chat of payload.chats) {
        if (!chat.id) continue;
        chatIds.add(chat.id);
        const name = nonEmpty(chat.name);
        if (name) names.set(chat.id, name);
      }
      for (const contact of payload.contacts) {
        const name =
          nonEmpty(contact.name) ?? nonEmpty(contact.notify) ?? nonEmpty(contact.verifiedName);
        if (contact.id && name) contactNames.set(contact.id, name);
      }
    },
  });
  // Baileys' end() does not reject an in-flight query (it would wait for its 60 s query timeout),
  // so give the group list a short grace after the window and then list without it.
  let grace: NodeJS.Timeout | undefined;
  await Promise.race([
    groups,
    new Promise<void>((resolve) => {
      grace = setTimeout(resolve, GROUP_QUERY_GRACE_MS);
    }),
  ]);
  clearTimeout(grace);

  const jids = new Set([...chatIds, ...contactNames.keys()]);
  return [...jids]
    .filter((jid) => !HIDDEN_JIDS.has(jid))
    .map((jid) => ({ jid, name: names.get(jid) ?? contactNames.get(jid) ?? "" }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.jid.localeCompare(b.jid));
}

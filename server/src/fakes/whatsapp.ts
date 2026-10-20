// FakeWhatsApp (plan §5, D11): an in-memory `WaDeps` seam, so tests and fake mode run the REAL
// connector logic (linkDevice, drain, listChats) against scripted socket sessions. Each created
// socket replays one script: Baileys events (`{event, payload}` with §12.3 payload shapes), `{wait}`
// pauses (setTimeout, so fake timers drive them) and `{close: <DisconnectReason code>}`. A socket
// stops replaying once it is closed, and `end()` emits `connection.update` close like Baileys does.
// The default script is `connection: "open"` followed by server/fixtures/whatsapp-events.json.
import { readFileSync } from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { DisconnectReason } from "../connectors/whatsapp.js";
import type {
  WaAuthState,
  WaDeps,
  WaEvent,
  WaEventMap,
  WaSocket,
  WaSocketConfig,
} from "../connectors/whatsapp.js";
import { FIXTURES_DIR } from "./sheets.js";

export const WHATSAPP_EVENTS_FILE = path.join(FIXTURES_DIR, "whatsapp-events.json");

export type FakeWaEventStep = { [E in WaEvent]: { event: E; payload: WaEventMap[E] } }[WaEvent];
export type FakeWaStep = FakeWaEventStep | { wait: number } | { close: number };
export type FakeWaScript = readonly FakeWaStep[];

/** Real-time latency of a fake saveCreds, so a save that is not awaited is observably unfinished. */
export const SAVE_LATENCY_MS = 20;

export const OPEN_STEP: FakeWaEventStep = {
  event: "connection.update",
  payload: { connection: "open" },
};

/** The synthetic fixture events (1555555xxxx JIDs, invented text). */
export function loadWhatsAppFixture(file: string = WHATSAPP_EVENTS_FILE): FakeWaEventStep[] {
  return JSON.parse(readFileSync(file, "utf8")) as FakeWaEventStep[];
}

/** A Boom-shaped close error, as Baileys puts in `lastDisconnect.error`. */
export function disconnectError(statusCode: number): Error {
  return Object.assign(new Error(`connection closed (${statusCode})`), {
    output: { statusCode },
  });
}

type Listener = (arg: unknown) => void;

export class FakeWaSocket implements WaSocket {
  closed = false;
  endCalls = 0;
  private readonly listeners = new Map<WaEvent, Listener[]>();

  constructor(
    readonly config: WaSocketConfig,
    private readonly groups: Record<string, { id: string; subject?: string | null }> | null,
    private readonly credsOnEnd = false,
  ) {}

  readonly ev = {
    on: <E extends WaEvent>(event: E, listener: (arg: WaEventMap[E]) => void): void => {
      const list = this.listeners.get(event) ?? [];
      list.push(listener as Listener);
      this.listeners.set(event, list);
    },
  };

  emit<E extends WaEvent>(event: E, payload: WaEventMap[E]): void {
    if (this.closed) return;
    if (event === "connection.update") {
      if ((payload as WaEventMap["connection.update"]).connection === "close") this.closed = true;
    }
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  close(statusCode: number): void {
    this.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: disconnectError(statusCode), date: new Date() },
    });
  }

  async end(error?: Error): Promise<void> {
    this.endCalls++;
    if (this.closed) return;
    this.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: error ?? disconnectError(DisconnectReason.connectionClosed),
        date: new Date(),
      },
    });
    if (this.credsOnEnd) {
      // Like a Baileys socket-end handler: a final creds.update on a later turn, after the close.
      await nextTurn();
      for (const listener of this.listeners.get("creds.update") ?? []) listener({});
    }
  }

  groupFetchAllParticipating(): Promise<Record<string, { id: string; subject?: string | null }>> {
    // null: the query never answers (Baileys end() leaves an in-flight query pending).
    return this.groups ? Promise.resolve(this.groups) : new Promise(() => undefined);
  }

  async play(script: FakeWaScript): Promise<void> {
    for (const step of script) {
      if (this.closed) return;
      if ("wait" in step) await new Promise((r) => setTimeout(r, step.wait));
      else if ("close" in step) this.close(step.close);
      else this.emit(step.event, step.payload);
    }
  }
}

export interface FakeWhatsAppOptions {
  /** One script per created socket (index i → socket i); the last script repeats. */
  scripts?: readonly FakeWaScript[];
  /** Group list query result; null = the query never answers. Default {}. */
  groups?: Record<string, { id: string; subject?: string | null }> | null;
  /** end() emits one more creds.update on a later turn (a late save the caller must await). */
  credsOnEnd?: boolean;
}

export interface FakeWhatsApp {
  deps: WaDeps;
  sockets: FakeWaSocket[];
  /** Auth dirs passed to loadAuth, in order. */
  authDirs: string[];
  /** Number of COMPLETED saveCreds calls (each takes SAVE_LATENCY_MS of real time). */
  savedCreds: number;
}

export function createFakeWhatsApp(opts: FakeWhatsAppOptions = {}): FakeWhatsApp {
  const scripts = opts.scripts ?? [[OPEN_STEP, ...loadWhatsAppFixture()]];
  const fake: FakeWhatsApp = {
    sockets: [],
    authDirs: [],
    savedCreds: 0,
    deps: {
      loadAuth: (dir) => {
        fake.authDirs.push(dir);
        return Promise.resolve({
          state: {} as WaAuthState,
          saveCreds: async () => {
            await sleep(SAVE_LATENCY_MS); // real time, like a file write: not driven by fake timers
            fake.savedCreds++;
          },
        });
      },
      makeSocket: (config) => {
        const socket = new FakeWaSocket(
          config,
          opts.groups === undefined ? {} : opts.groups,
          opts.credsOnEnd ?? false,
        );
        const script = scripts[Math.min(fake.sockets.length, scripts.length - 1)] ?? [];
        fake.sockets.push(socket);
        // Replay after the caller has attached its listeners (same tick as Baileys' async connect).
        void Promise.resolve().then(() => socket.play(script));
        return socket;
      },
    },
  };
  return fake;
}

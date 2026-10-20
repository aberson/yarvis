// FakeGmail (plan §5, D11): an in-memory implementation of the read-only `GmailApi` surface, so fake
// mode and tests run the REAL connector logic (query, pagination, cached-id skip, bounded
// concurrency, retries, normalization) against it. Seeded from server/fixtures/gmail-messages.json
// (an array of synthetic `users.messages.get` format-full responses). `messages.list` honours the
// connector's query the way Gmail would for these fixtures: `after:<epoch>` against internalDate,
// `-in:spam` / `-in:trash`, and every requested label id. It records every call and can inject
// failures (an HTTP status, or a hang for timeout tests).
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config/paths.js";
import {
  createGmailConnector,
  type CallOpts,
  type GmailApi,
  type GmailConnector,
  type GmailConnectorOptions,
  type ListParams,
  type RawMessage,
} from "../connectors/gmail.js";

export const GMAIL_SEED_FILE = path.join(REPO_ROOT, "server", "fixtures", "gmail-messages.json");

export type FakeGmailMethod = "messages.list" | "messages.get";

export interface FakeGmailCall {
  method: FakeGmailMethod;
  params: unknown;
}

type Fault = { kind: "status"; status: number } | { kind: "hang" };

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

export function loadGmailSeed(file: string = GMAIL_SEED_FILE): RawMessage[] {
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(raw) || raw.some((m) => typeof (m as RawMessage)?.id !== "string")) {
    throw new Error(`${file}: expected an array of users.messages.get responses with ids`);
  }
  return raw as RawMessage[];
}

/** Applies the subset of Gmail search the connector issues: after:<epoch>, -in:spam, -in:trash. */
export function matchesQuery(msg: RawMessage, q: string, labelIds: readonly string[]): boolean {
  const labels = msg.labelIds ?? [];
  if (!labelIds.every((l) => labels.includes(l))) return false;
  for (const term of q.split(/\s+/).filter(Boolean)) {
    const after = /^after:(\d+)$/.exec(term);
    if (after) {
      if (Number(msg.internalDate ?? 0) < Number(after[1]) * 1000) return false;
    } else if (term === "-in:spam") {
      if (labels.includes("SPAM")) return false;
    } else if (term === "-in:trash") {
      if (labels.includes("TRASH")) return false;
    } else {
      throw new Error(`FakeGmail: unsupported query term "${term}"`);
    }
  }
  return true;
}

export class FakeGmailApi implements GmailApi {
  readonly messages = new Map<string, RawMessage>();
  readonly calls: FakeGmailCall[] = [];
  /** Highest number of calls in flight at once (concurrency tests). */
  maxInFlight = 0;
  /** Artificial latency per call, ms (concurrency tests). */
  latencyMs = 0;
  private inFlight = 0;
  private readonly faults: Array<{ method: FakeGmailMethod; fault: Fault }> = [];

  constructor(
    seed: readonly RawMessage[] = [],
    /** Ids per messages.list page (Gmail's maxResults is also honoured, smaller wins). */
    readonly pageSize = 100,
  ) {
    for (const m of seed) this.messages.set(m.id as string, structuredClone(m));
  }

  /** The next `times` calls of `method` reject with an HTTP `status` error. */
  failNext(method: FakeGmailMethod, status: number, times = 1): void {
    for (let i = 0; i < times; i++) this.faults.push({ method, fault: { kind: "status", status } });
  }

  /** The next call of `method` never settles (timeout tests). */
  hangNext(method: FakeGmailMethod): void {
    this.faults.push({ method, fault: { kind: "hang" } });
  }

  callsOf(method: FakeGmailMethod): FakeGmailCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  private async enter<T>(method: FakeGmailMethod, params: unknown, run: () => T): Promise<T> {
    this.calls.push({ method, params: structuredClone(params) });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
      const i = this.faults.findIndex((f) => f.method === method);
      const fault = i < 0 ? undefined : this.faults.splice(i, 1)[0]?.fault;
      if (fault?.kind === "hang") await new Promise<never>(() => undefined);
      else if (fault) throw httpError(fault.status, `fake ${method} HTTP ${fault.status}`);
      return run();
    } finally {
      this.inFlight--;
    }
  }

  readonly users: GmailApi["users"] = {
    messages: {
      list: (params: ListParams, _opts: CallOpts) =>
        this.enter("messages.list", params, () => {
          // Gmail lists newest first.
          const ids = [...this.messages.values()]
            .filter((m) => matchesQuery(m, params.q, params.labelIds))
            .sort((a, b) => Number(b.internalDate ?? 0) - Number(a.internalDate ?? 0))
            .map((m) => m.id as string);
          const start = params.pageToken ? Number(params.pageToken) : 0;
          const size = Math.max(1, Math.min(this.pageSize, params.maxResults));
          const page = ids.slice(start, start + size);
          const next = start + size < ids.length ? String(start + size) : undefined;
          return {
            data: {
              messages: page.map((id) => ({ id, threadId: id })),
              ...(next ? { nextPageToken: next } : {}),
            },
          };
        }),
      get: (params, _opts) =>
        this.enter("messages.get", params, () => {
          const msg = this.messages.get(params.id);
          if (!msg) throw httpError(404, "Requested entity was not found.");
          return { data: structuredClone(msg) };
        }),
    },
  };
}

export interface FakeGmail {
  api: FakeGmailApi;
  connector: GmailConnector;
}

/**
 * Fake-mode Gmail: a fresh in-memory mailbox seeded from the fixtures (pass `seed: []` for an
 * empty one). Retries use no real sleep.
 */
export function createFakeGmail(
  opts: { seed?: readonly RawMessage[]; pageSize?: number } & Partial<
    Omit<GmailConnectorOptions, "api">
  > = {},
): FakeGmail {
  const api = new FakeGmailApi(opts.seed ?? loadGmailSeed(), opts.pageSize);
  const connector = createGmailConnector({
    api,
    timeoutMs: opts.timeoutMs,
    concurrency: opts.concurrency,
    retry: { sleep: () => Promise.resolve(), ...opts.retry },
  });
  return { api, connector };
}

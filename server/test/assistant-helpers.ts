// Shared fixtures for the assistant tests: synthetic Todo/Quarantine rows, a Sheets store whose reads
// can be held open or failed, and a lock planted by a live competing owner. Synthetic data only.
import { writeFileSync } from "node:fs";
import type { QuarantineItem, Todo } from "@yarvis/shared";
import type { SheetsStore, TabSpec } from "../src/connectors/sheets.js";
import { createFakeSheets, type FakeSheets } from "../src/fakes/sheets.js";
import { assistantLockFile } from "../src/assistant/store.js";
import type { Paths } from "../src/config/paths.js";

export function todo(n: number, over: Partial<Todo> = {}): Todo {
  const id = `gmail:${n.toString(16).padStart(16, "0")}#1`;
  return {
    id,
    source: "gmail",
    status: "open",
    action: `Synthetic action ${n}`,
    extraction_status: "done",
    original_text: `Synthetic body ${n}`,
    sender: `sender${n}@example.test`,
    context: `Subject ${n}`,
    message_date: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
    link: `https://mail.example.test/${n}`,
    jev_action: 0.9,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

export function quarantined(messageId: string, released = ""): QuarantineItem {
  return {
    id: messageId,
    source: "gmail",
    sender: "bad@example.test",
    context: "Bad",
    message_date: "2026-10-01T00:00:00.000Z",
    link: "",
    jev_phishing: 0.9,
    jev_malicious: 0.1,
    jev_spam: 0.1,
    reason: "phishing≥0.50",
    created_at: "2026-10-01T00:00:00.000Z",
    released_at: released,
  };
}

export interface GatedSheets extends FakeSheets {
  /** The store whose readRows can be gated/failed (wraps the real store over FakeSheetsApi). */
  gated: SheetsStore;
  /** Holds every following read open until the returned release() is called. */
  hold(): { release: () => void; started: Promise<void> };
  /** The next read rejects. */
  failNextRead(): void;
  reads: number;
}

export function gatedSheets(seed?: { Todos: Todo[]; Quarantine: QuarantineItem[] }): GatedSheets {
  const fake = createFakeSheets(seed === undefined ? {} : { seed });
  let gate: Promise<void> | null = null;
  let onStart: (() => void) | null = null;
  let fail = false;
  const out: GatedSheets = {
    ...fake,
    reads: 0,
    gated: {
      ...fake.store,
      readRows: async <C extends string, R extends { id: string }>(
        spec: TabSpec<C, R>,
      ): Promise<R[]> => {
        out.reads++;
        onStart?.();
        if (fail) {
          fail = false;
          throw new Error("synthetic read failure");
        }
        if (gate) await gate;
        return fake.store.readRows(spec);
      },
    },
    hold() {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      const started = new Promise<void>((r) => (onStart = r));
      return {
        started,
        release: () => {
          gate = null;
          onStart = null;
          release();
        },
      };
    },
    failNextRead() {
      fail = true;
    },
  };
  return out;
}

/** A lock record of a LIVE process (this test process, with a foreign token): never stale. */
export function plantLiveAssistantLock(paths: Pick<Paths, "privateDir">): string {
  const file = assistantLockFile(paths);
  writeFileSync(
    file,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: "competitor" }),
  );
  return file;
}

export async function until(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// JSONL cache rules (plan §3.3, D17): a torn final line (not valid JSON) is skipped and truncated by
// the loader and truncated by the writer; a failed append leaves no residue; any other malformed line
// is a hard error naming file + line; messages first-wins, decisions last-record-wins.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "@yarvis/shared";
import {
  appendJsonl,
  decisionsFile,
  JsonlError,
  loadDecisions,
  loadMessages,
  messagesFile,
  type DecisionRecord,
  type JsonlWrite,
} from "../src/pipeline/cache.js";
import { loadFixtureMessages } from "../src/fakes/jev.js";
import { tempPaths } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function cacheFiles() {
  const { paths, cleanup } = tempPaths();
  cleanups.push(cleanup);
  mkdirSync(paths.cacheDir, { recursive: true });
  return { messages: messagesFile(paths), decisions: decisionsFile(paths) };
}

const fixtures = loadFixtureMessages();
const line = (v: unknown) => `${JSON.stringify(v)}\n`;
const SCORES = { phishing: 0.01, malicious: 0.01, spam: 0.02, action: 0.93 };

describe("messages.jsonl", () => {
  it("skips and truncates a torn trailing line, so the next append is clean", async () => {
    const { messages: file } = cacheFiles();
    const torn = JSON.stringify(fixtures.phishing).slice(0, 40);
    writeFileSync(file, line(fixtures.clean) + line(fixtures.actionable) + torn);

    const loaded = await loadMessages(file);
    expect([...loaded.messages.keys()]).toEqual([fixtures.clean.id, fixtures.actionable.id]);
    expect(loaded.skippedTornLines).toBe(1);

    await appendJsonl(file, [fixtures.phishing]);
    const reloaded = await loadMessages(file);
    expect(reloaded.skippedTornLines).toBe(0);
    expect([...reloaded.messages.keys()]).toEqual([
      fixtures.clean.id,
      fixtures.actionable.id,
      fixtures.phishing.id,
    ]);
  });

  it("a malformed line that is not the last is a hard error naming the file and line, not its content", async () => {
    const { messages: file } = cacheFiles();
    writeFileSync(file, line(fixtures.clean) + "{not json\n" + line(fixtures.actionable));
    const err = await loadMessages(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JsonlError);
    expect((err as JsonlError).line).toBe(2);
    expect((err as Error).message).toContain("messages.jsonl line 2");
    expect((err as Error).message).not.toContain("not json");
  });

  it("a final line that is valid JSON but not a Message is a hard error, never silently dropped", async () => {
    const { messages: file } = cacheFiles();
    writeFileSync(file, line(fixtures.clean) + line({ id: "not-a-message" }));
    const err = await loadMessages(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JsonlError);
    expect((err as JsonlError).line).toBe(2);
    expect(readFileSync(file, "utf8")).toContain("not-a-message");
  });

  it("a failed append leaves no partial line, so the next append and load are clean", async () => {
    const { messages: file } = cacheFiles();
    await appendJsonl(file, [fixtures.clean]);
    // Writes half the bytes, then fails (disk full mid-write).
    const failing: JsonlWrite = async (handle, data, position) => {
      await handle.write(data, 0, Math.floor(data.length / 2), position);
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };
    await expect(appendJsonl(file, [fixtures.phishing], failing)).rejects.toThrow(/ENOSPC/);
    expect(readFileSync(file, "utf8")).toBe(line(fixtures.clean));

    await appendJsonl(file, [fixtures.actionable]);
    const loaded = await loadMessages(file);
    expect(loaded.skippedTornLines).toBe(0);
    expect([...loaded.messages.keys()]).toEqual([fixtures.clean.id, fixtures.actionable.id]);
  });

  it("the writer drops a torn tail left by a crash, and completes a valid unterminated one", async () => {
    const { messages: file } = cacheFiles();
    writeFileSync(file, line(fixtures.clean) + JSON.stringify(fixtures.phishing).slice(0, 30));
    await appendJsonl(file, [fixtures.actionable]);
    expect(readFileSync(file, "utf8")).toBe(line(fixtures.clean) + line(fixtures.actionable));

    writeFileSync(file, line(fixtures.clean) + JSON.stringify(fixtures.phishing));
    await appendJsonl(file, [fixtures.actionable]);
    const loaded = await loadMessages(file);
    expect(loaded.skippedTornLines).toBe(0);
    expect([...loaded.messages.keys()]).toEqual([
      fixtures.clean.id,
      fixtures.phishing.id,
      fixtures.actionable.id,
    ]);
  });

  it("is first-wins per id", async () => {
    const { messages: file } = cacheFiles();
    const later: Message = { ...fixtures.clean, text: "a re-fetched copy" };
    writeFileSync(file, line(fixtures.clean) + line(later));
    expect((await loadMessages(file)).messages.get(fixtures.clean.id)).toEqual(fixtures.clean);
  });
});

describe("decisions.jsonl", () => {
  it("is last-record-wins: a pending extraction superseded by a done record loads as done", async () => {
    const { decisions: file } = cacheFiles();
    const id = fixtures.actionable.id;
    const pending: DecisionRecord = {
      id,
      jev: SCORES,
      extraction: { status: "pending", actions: [] },
      sheetSyncedAt: "2026-10-19T10:00:00.000Z",
    };
    const done: DecisionRecord = {
      id,
      jev: SCORES,
      extraction: { status: "done", actions: ["Pick up Maya at 5:30"] },
    };
    await appendJsonl(file, [pending]);
    await appendJsonl(file, [done]);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    expect((await loadDecisions(file)).decisions.get(id)).toEqual(done);
  });

  it("an absent file loads empty", async () => {
    const { decisions: file } = cacheFiles();
    expect((await loadDecisions(file)).decisions.size).toBe(0);
  });
});

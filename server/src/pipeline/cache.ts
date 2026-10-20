// The local JSONL caches (plan §3.3, D8, D16, D17): `private/cache/messages.jsonl` (one Message
// per line) and `private/cache/decisions.jsonl` (one DecisionRecord per line). Both are cursors, not
// data: deleting private/cache costs API calls, never sheet rows.
//
// One rule for torn lines, shared by the loader and the writer (§3.3 "torn append", D17): a TORN
// line is an UNTERMINATED final line (no trailing newline) that is not valid JSON: an append
// interrupted mid-write (every append ends its records with a newline). It is never a record: the
// loader skips it, counts it and truncates it away; the writer truncates it away before appending.
// An unterminated final line that IS valid JSON is completed, not dropped; a newline-terminated
// unparseable line is corruption, not a torn append.
//
// Load rules (D17):
//   - a torn final line is skipped, counted and truncated (see above);
//   - any other malformed line (unparseable and newline-terminated, or valid JSON without the
//     record's shape, anywhere) is a hard error naming the file and line (never its content);
//   - messages.jsonl is first-wins per id; decisions.jsonl is last-record-wins per id (a retry or a
//     sheetSyncedAt marker appends a superseding record).
// Writes are append + fsync, one JSON object per line; a write that fails is truncated back to the
// file's size before it, so a failed append leaves no partial line for a later append to bury.
import { mkdir, open, readFile, truncate, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  EXTRACTION_STATUSES,
  parseMessageId,
  type ExtractionStatus,
  type Message,
} from "@yarvis/shared";
import type { Paths } from "../config/paths.js";
import type { JevOutcome } from "../ai/decide.js";

export const MESSAGES_FILE_NAME = "messages.jsonl";
export const DECISIONS_FILE_NAME = "decisions.jsonl";

export function messagesFile(paths: Pick<Paths, "cacheDir">): string {
  return path.join(paths.cacheDir, MESSAGES_FILE_NAME);
}

export function decisionsFile(paths: Pick<Paths, "cacheDir">): string {
  return path.join(paths.cacheDir, DECISIONS_FILE_NAME);
}

/** The extraction outcome stored per message (status + 0..3 actions; §3.3). */
export interface ExtractionRecord {
  status: ExtractionStatus;
  actions: string[];
}

/**
 * One decisions.jsonl record: RAW Jev scores (or a per-message Jev error), the extraction outcome
 * once extracted, and `sheetSyncedAt` once a sheets stage wrote it. `quarantined`/`actionable` are
 * never stored: decide() recomputes them from the CURRENT thresholds every run (D16).
 */
export interface DecisionRecord {
  id: string;
  jev: JevOutcome;
  extraction?: ExtractionRecord;
  /** ISO 8601 UTC of the successful upsert that wrote this record's rows. */
  sheetSyncedAt?: string;
}

/** A malformed line that is not the final line: the cache needs operator attention. */
export class JsonlError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
  ) {
    super(
      `${path.basename(file)} line ${line} is malformed; fix or delete the cache file (re-fetch rebuilds it)`,
    );
    this.name = "JsonlError";
  }
}

export interface JsonlLoad<T> {
  records: T[];
  /** 1 when a torn final line was skipped (and truncated away), else 0. */
  skippedTornLines: number;
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/**
 * Reads a JSONL file under the D17 load rules. `parse` maps one decoded JSON value to a record, or
 * null when it does not have the record's shape (a hard error). An absent file is empty. A torn
 * final line is truncated off the file so later appends stay line-aligned.
 */
export async function readJsonl<T>(
  file: string,
  parse: (raw: unknown) => T | null,
): Promise<JsonlLoad<T>> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (err) {
    if (errCode(err) === "ENOENT") return { records: [], skippedTornLines: 0 };
    throw err;
  }
  const lines: Array<{ start: number; text: string; terminated: boolean }> = [];
  let start = 0;
  while (start < bytes.length) {
    const nl = bytes.indexOf(0x0a, start);
    const end = nl < 0 ? bytes.length : nl;
    lines.push({ start, text: bytes.subarray(start, end).toString("utf8"), terminated: nl >= 0 });
    start = end + 1;
  }
  const lastContent = lines.findLastIndex((l) => l.text.trim() !== "");
  const records: T[] = [];
  for (let i = 0; i <= lastContent; i++) {
    const { start: lineStart, text, terminated } = lines[i] as (typeof lines)[number];
    if (text.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      if (i === lastContent && !terminated) {
        await truncate(file, lineStart);
        return { records, skippedTornLines: 1 };
      }
      throw new JsonlError(file, i + 1);
    }
    const record = parse(value);
    if (record === null) throw new JsonlError(file, i + 1);
    records.push(record);
  }
  return { records, skippedTornLines: 0 };
}

/** Byte offset where the file's last line starts (just past the last newline, or 0). */
async function lastLineStart(handle: FileHandle, size: number): Promise<number> {
  const chunk = Buffer.alloc(64 * 1024);
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - chunk.length);
    const { bytesRead } = await handle.read(chunk, 0, end - start, start);
    const nl = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (nl >= 0) return start + nl + 1;
    end = start;
  }
  return 0;
}

/** How appendJsonl writes its bytes; injectable so tests can simulate a write that fails midway. */
export type JsonlWrite = (handle: FileHandle, data: Buffer, position: number) => Promise<void>;

const writeAt: JsonlWrite = async (handle, data, position) => {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(
      data,
      offset,
      data.length - offset,
      position + offset,
    );
    offset += bytesWritten;
  }
};

/**
 * Appends one JSON object per line and fsyncs. An unterminated tail is first completed (valid JSON)
 * or truncated away (a torn line). If the write fails, the file is truncated back to its size before
 * the write and the error is rethrown.
 */
export async function appendJsonl(
  file: string,
  records: readonly unknown[],
  write: JsonlWrite = writeAt,
): Promise<void> {
  if (records.length === 0) return;
  const body = records.map((r) => JSON.stringify(r)).join("\n");
  await mkdir(path.dirname(file), { recursive: true });
  // Create if absent, then open read/write: an append-mode handle cannot be truncated on Windows.
  await (await open(file, "a")).close();
  const handle = await open(file, "r+");
  try {
    let { size } = await handle.stat();
    let prefix = "";
    if (size > 0) {
      const tailStart = await lastLineStart(handle, size);
      if (tailStart < size) {
        const tail = Buffer.alloc(size - tailStart);
        await handle.read(tail, 0, tail.length, tailStart);
        let complete = true;
        try {
          JSON.parse(tail.toString("utf8"));
        } catch {
          complete = false;
        }
        if (complete) {
          prefix = "\n";
        } else {
          await handle.truncate(tailStart);
          size = tailStart;
        }
      }
    }
    try {
      await write(handle, Buffer.from(`${prefix}${body}\n`, "utf8"), size);
      await handle.sync();
    } catch (err) {
      await handle.truncate(size).catch(() => undefined);
      throw err;
    }
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Record shapes.

/** A JSON object (not null, not an array): the one guard the cache and state parsers share. */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isString = (v: unknown): v is string => typeof v === "string";

/** A cached Message (§3.2), or null when the value is not one. */
export function parseMessageRecord(raw: unknown): Message | null {
  if (!isObject(raw)) return null;
  const { id, source, sender, context, chatId, date, text, links, link } = raw;
  if (!isString(id) || !parseMessageId(id)) return null;
  if (source !== "gmail" && source !== "whatsapp") return null;
  if (![sender, context, date, text, link].every(isString)) return null;
  if (!Array.isArray(links) || !links.every(isString)) return null;
  if (chatId !== undefined && !isString(chatId)) return null;
  return raw as unknown as Message;
}

function parseExtraction(raw: unknown): ExtractionRecord | null {
  if (!isObject(raw)) return null;
  const { status, actions } = raw;
  if (!(EXTRACTION_STATUSES as readonly unknown[]).includes(status)) return null;
  if (!Array.isArray(actions) || !actions.every(isString)) return null;
  return { status: status as ExtractionStatus, actions: [...actions] };
}

/**
 * A decisions record, or null when the value is not one. The `jev` payload only has to be an
 * object: decide() validates it and fails CLOSED (quarantined, jev_error) on anything else.
 */
export function parseDecisionRecord(raw: unknown): DecisionRecord | null {
  if (!isObject(raw)) return null;
  const { id, jev, extraction, sheetSyncedAt } = raw;
  if (!isString(id) || !parseMessageId(id) || !isObject(jev)) return null;
  const record: DecisionRecord = { id, jev: jev as unknown as JevOutcome };
  if (extraction !== undefined) {
    const parsed = parseExtraction(extraction);
    if (!parsed) return null;
    record.extraction = parsed;
  }
  if (sheetSyncedAt !== undefined) {
    if (!isString(sheetSyncedAt)) return null;
    record.sheetSyncedAt = sheetSyncedAt;
  }
  return record;
}

export interface MessagesLoad {
  /** id -> Message, first record wins, in file order. */
  messages: Map<string, Message>;
  skippedTornLines: number;
}

export async function loadMessages(file: string): Promise<MessagesLoad> {
  const { records, skippedTornLines } = await readJsonl(file, parseMessageRecord);
  const messages = new Map<string, Message>();
  for (const m of records) if (!messages.has(m.id)) messages.set(m.id, m);
  return { messages, skippedTornLines };
}

export interface DecisionsLoad {
  /** id -> the LAST record for that id. */
  decisions: Map<string, DecisionRecord>;
  skippedTornLines: number;
}

export async function loadDecisions(file: string): Promise<DecisionsLoad> {
  const { records, skippedTornLines } = await readJsonl(file, parseDecisionRecord);
  const decisions = new Map<string, DecisionRecord>();
  for (const d of records) decisions.set(d.id, d);
  return { decisions, skippedTornLines };
}

// `private/state.json`: the incremental fetch cursors (plan §3.3, D21). Not cache: absent means a
// full fetch from settings.since. `lastRunAt` is ISO 8601 UTC; `lastMessageTs` is Unix epoch
// seconds (the unit of Baileys `messageTimestamp`). Written via temp file + rename, and only by a
// refresh that did not end `error`, per source (§4 failure policy).
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Paths } from "../config/paths.js";
import { writeJsonAtomic } from "../util/atomic-write.js";
import { isObject } from "./cache.js";

export interface PipelineState {
  gmail?: { lastRunAt?: string };
  whatsapp?: { lastRunAt?: string; lastMessageTs?: number };
}

/** state.json exists but is not a valid cursor file. Names the file, never its contents. */
export class StateError extends Error {
  constructor(file: string) {
    super(
      `${path.basename(file)} is not a valid cursor file; delete it to re-fetch from settings.since`,
    );
    this.name = "StateError";
  }
}

const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** Validates a parsed state.json value; null when it is not one. */
export function parseState(raw: unknown): PipelineState | null {
  if (!isObject(raw)) return null;
  const out: PipelineState = {};
  if (raw.gmail !== undefined) {
    if (!isObject(raw.gmail)) return null;
    const { lastRunAt } = raw.gmail;
    if (lastRunAt !== undefined && !isIso(lastRunAt)) return null;
    out.gmail = lastRunAt === undefined ? {} : { lastRunAt };
  }
  if (raw.whatsapp !== undefined) {
    if (!isObject(raw.whatsapp)) return null;
    const { lastRunAt, lastMessageTs } = raw.whatsapp;
    if (lastRunAt !== undefined && !isIso(lastRunAt)) return null;
    if (
      lastMessageTs !== undefined &&
      (typeof lastMessageTs !== "number" || !Number.isFinite(lastMessageTs) || lastMessageTs < 0)
    ) {
      return null;
    }
    out.whatsapp = {
      ...(lastRunAt === undefined ? {} : { lastRunAt }),
      ...(lastMessageTs === undefined ? {} : { lastMessageTs }),
    };
  }
  return out;
}

export async function readState(paths: Pick<Paths, "stateFile">): Promise<PipelineState> {
  let text: string;
  try {
    text = await readFile(paths.stateFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    throw new StateError(paths.stateFile);
  }
  const state = parseState(raw);
  if (!state) throw new StateError(paths.stateFile);
  return state;
}

export async function writeState(
  paths: Pick<Paths, "stateFile">,
  state: PipelineState,
): Promise<void> {
  await writeJsonAtomic(paths.stateFile, state);
}

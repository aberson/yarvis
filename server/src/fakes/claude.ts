// FakeClaude (plan §5, D11): the in-memory extractor used by fake mode and tests. Seeded from
// server/fixtures/claude-responses.json `{[messageId]: string[] | "fail"}` (a missing id -> `[]`).
// It wraps each canned answer in a `claude -p --output-format json` envelope and runs it through the
// PRODUCTION parser, so fake mode exercises the same envelope/array handling as the real seam.
// `calls` is the call log the pipeline test asserts is empty for quarantined messages (§1.2).
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildExtractPrompt,
  parseClaudeOutput,
  type ExtractInput,
  type ExtractionResult,
  type Extractor,
} from "../ai/extract.js";
import { FIXTURES_DIR } from "./sheets.js";

export const CLAUDE_RESPONSES_FILE = path.join(FIXTURES_DIR, "claude-responses.json");
export const CLAUDE_ENVELOPE_FILE = path.join(FIXTURES_DIR, "claude-json-envelope.json");

export type ClaudeSeed = Record<string, string[] | "fail">;

export function loadClaudeSeed(file: string = CLAUDE_RESPONSES_FILE): ClaudeSeed {
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${file}: expected {[messageId]: string[] | "fail"}`);
  }
  const seed: ClaudeSeed = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === "fail") seed[id] = "fail";
    else if (Array.isArray(v) && v.every((s) => typeof s === "string")) seed[id] = [...v];
    else throw new Error(`${file}: bad entry for ${id}`);
  }
  return seed;
}

/** A synthetic envelope with the documented fields (type, subtype, is_error, result). */
export function fakeEnvelope(result: string, isError = false): string {
  return JSON.stringify({
    type: "result",
    subtype: isError ? "error_during_execution" : "success",
    is_error: isError,
    result,
  });
}

export interface FakeClaudeCall {
  input: ExtractInput;
  /** The prompt the real seam would have sent on stdin. */
  prompt: string;
}

export class FakeClaude implements Extractor {
  readonly calls: FakeClaudeCall[] = [];

  constructor(private readonly seed: ClaudeSeed = loadClaudeSeed()) {}

  extract(input: ExtractInput): Promise<ExtractionResult> {
    this.calls.push({ input: structuredClone(input), prompt: buildExtractPrompt(input) });
    const entry = this.seed[input.id] ?? [];
    const stdout =
      entry === "fail"
        ? fakeEnvelope("fake claude failure", true)
        : fakeEnvelope(JSON.stringify(entry));
    return Promise.resolve(parseClaudeOutput(stdout));
  }
}

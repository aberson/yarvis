// FakeComposer (plan S1.5, D11 pattern): the deterministic synthetic composer fake mode
// (YARVIS_FAKE=1) wires in place of the real CLI composer, the same way the other five fakes stand
// in for their seams. It never spawns anything. Like FakeClaude it wraps its canned answer in a
// `claude -p --output-format json` envelope and runs it through the PRODUCTION parser
// (interpretComposeRun), so fake mode exercises the same strict envelope/Composition handling.
// `calls` records each input and the prompt the real seam would have sent on stdin.
import type { Composition } from "@yarvis/shared";
import {
  buildComposePrompt,
  COMPOSE_PROMPT_VERSION,
  interpretComposeRun,
  type ComposeInput,
  type ComposeOptions,
  type ComposeOutcome,
  type Composer,
} from "../ai/compose.js";
import type { ClaudeRunResult } from "../ai/extract.js";
import { fakeEnvelope } from "./claude.js";

/** The model id fake-mode packets and runs record. */
export const FAKE_COMPOSER_MODEL = "fake-composer";

/** The deterministic synthetic composition for one source: no invented facts, only questions. */
export function fakeComposition(input: ComposeInput): Composition {
  const ref = input.sourceRef;
  return {
    draft: `Hi ${ref.sender},\n\nThanks for your message about "${ref.context}". I am looking into it and will reply properly once I have checked the details.\n\n(Synthetic fake-mode draft.)`,
    checklist: [
      `Re-read the original message about "${ref.context}"`,
      `Decide how to handle: ${ref.action || "the request"}`,
      "Edit this draft before replying yourself",
    ],
    questions: ["Is anything in the message time-sensitive that is not stated explicitly?"],
  };
}

/** A scripted CLI result (tests); default: a success envelope around fakeComposition(input). */
export type FakeComposerScript = (input: ComposeInput) => ClaudeRunResult;

export interface FakeComposerCall {
  input: ComposeInput;
  prompt: string;
  timeoutMs: number;
}

export class FakeComposer implements Composer {
  readonly calls: FakeComposerCall[] = [];

  constructor(private readonly script?: FakeComposerScript) {}

  compose(input: ComposeInput, opts: ComposeOptions): Promise<ComposeOutcome> {
    this.calls.push({
      input: structuredClone(input),
      prompt: buildComposePrompt(input.sourceRef),
      timeoutMs: opts.timeoutMs,
    });
    const promptVersion = COMPOSE_PROMPT_VERSION;
    const model = FAKE_COMPOSER_MODEL;
    if (opts.signal?.aborted) {
      return Promise.resolve({ ok: false, code: "compose_failed", model, promptVersion });
    }
    const run: ClaudeRunResult = this.script?.(input) ?? {
      stdout: fakeEnvelope(JSON.stringify(fakeComposition(input))),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    };
    const out = interpretComposeRun(run);
    return Promise.resolve(
      out.ok
        ? { ok: true, composition: out.composition, model, promptVersion }
        : { ok: false, code: out.code, model, promptVersion },
    );
  }
}

// Todo / QuarantineItem are DERIVED from the header tuples (plan §3.4). The type-level assertions
// below are checked by `npm run typecheck` (shared/tsconfig.json includes test/): if a header column
// had no field, or a field had no column, typecheck fails.
import { describe, expect, it } from "vitest";
import {
  QUARANTINE_HEADER,
  QUARANTINE_PRESERVED_ON_UPSERT,
  TODO_HEADER,
  TODO_PRESERVED_ON_UPSERT,
  type QuarantineColumn,
  type TodoColumn,
} from "../src/sheet.js";
import type { QuarantineItem, Todo } from "../src/types.js";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type AssertTrue<T extends true> = T;
/** True when every header column `C` is a field of `T`. */
type HasEveryColumn<T, C extends string> = [C] extends [keyof T] ? true : false;

// Positive pins: field set == header column set, exactly.
export type TodoFieldsAreTheHeader = AssertTrue<Equals<keyof Todo, TodoColumn>>;
export type QuarantineFieldsAreTheHeader = AssertTrue<
  Equals<keyof QuarantineItem, QuarantineColumn>
>;
export type TodoHasEveryColumn = AssertTrue<HasEveryColumn<Todo, TodoColumn>>;

// Red anchors: the same check FAILS typecheck when a header column has no field (a hand-declared
// Todo missing `jev_action`, or a new header column with no field). If these ever stop erroring,
// the expect-error directives themselves fail typecheck (unused directive).
// @ts-expect-error a header column without a Todo field must not typecheck
export type MissingField = AssertTrue<HasEveryColumn<Omit<Todo, "jev_action">, TodoColumn>>;
// @ts-expect-error a new header column without a Todo field must not typecheck
export type NewColumn = AssertTrue<HasEveryColumn<Todo, TodoColumn | "new_column">>;

describe("sheet headers (§3.4)", () => {
  it("pin the plan's column order, incl. extraction_status and released_at", () => {
    expect(TODO_HEADER).toEqual([
      "id",
      "source",
      "status",
      "action",
      "extraction_status",
      "original_text",
      "sender",
      "context",
      "message_date",
      "link",
      "jev_action",
      "created_at",
      "updated_at",
    ]);
    expect(QUARANTINE_HEADER).toEqual([
      "id",
      "source",
      "sender",
      "context",
      "message_date",
      "link",
      "jev_phishing",
      "jev_malicious",
      "jev_spam",
      "reason",
      "created_at",
      "released_at",
    ]);
  });

  it("column ownership: operator owns Todos.status, created_at is write-once (D18)", () => {
    expect([...TODO_PRESERVED_ON_UPSERT].sort()).toEqual(["created_at", "status"]);
    expect([...QUARANTINE_PRESERVED_ON_UPSERT]).toEqual(["created_at"]);
  });
});

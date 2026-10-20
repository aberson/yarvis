// Pirate mode is strings only (P7): two tables with identical keys; the nav labels differ.
import { describe, expect, it } from "vitest";
import { en, pirate, tables } from "../src/i18n/strings.js";

describe("string tables", () => {
  it("en and pirate have exactly the same keys and no empty strings", () => {
    expect(Object.keys(pirate).sort()).toEqual(Object.keys(en).sort());
    for (const table of Object.values(tables)) {
      for (const value of Object.values(table)) expect(value.trim()).not.toBe("");
    }
  });

  it("the three nav labels are the plan's in en and swapped in pirate (D40)", () => {
    expect([en.navTodos, en.navQuarantine, en.navControls]).toEqual([
      "Todos",
      "Quarantine",
      "Controls",
    ]);
    expect([en.brand, pirate.brand]).toEqual(["Y.A.R.V.I.S.", "Y.A.R.V.I.S."]);
    for (const key of ["navTodos", "navQuarantine", "navControls"] as const) {
      expect(pirate[key]).not.toBe(en[key]);
    }
  });
});

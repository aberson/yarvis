// Step 1 smoke (fake mode): the shell renders, and the Settings pirate toggle swaps the nav labels
// to the pirate table, persists across a reload (PATCH /api/settings -> private settings.json),
// and swaps back. Step 6: clicking Refresh runs the fake-mode pipeline (all five fakes) and the new
// to-do appears with its source chip; the Todos tab then holds the manifest total. A stubbed
// status sequence (running -> partial) shows a failed stage's error text and polling stopping.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { EXPECTED } from "../../server/fixtures/manifest.js";
import { en, pirate, type Strings } from "../src/i18n/strings.js";
import { REFRESH_POLL_MS } from "../src/refresh-poll.js";

/** The fixture message FakeJev scores actionable and FakeClaude turns into one Gmail to-do. */
const NEW_MESSAGE = "gmail:19a0c0ffee000001";
const claudeResponses = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../server/fixtures/claude-responses.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, string[]>;

const NAV = [
  ["nav-todos", "navTodos"],
  ["nav-quarantine", "navQuarantine"],
  ["nav-apps", "navApps"],
  ["nav-settings", "navSettings"],
] as const;

async function expectNav(page: Page, table: Strings): Promise<void> {
  for (const [testId, key] of NAV) {
    await expect(page.getByTestId(testId)).toHaveText(table[key]);
  }
}

test("pirate toggle swaps nav labels to the pirate table and back", async ({ page }) => {
  await page.goto("/settings");
  const toggle = page.getByTestId("pirate-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expectNav(page, en);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expectNav(page, pirate);

  // Persisted server-side, not just client state.
  await page.reload();
  await expect(page.getByTestId("pirate-toggle")).toHaveAttribute("aria-pressed", "true");
  await expectNav(page, pirate);

  await page.getByTestId("pirate-toggle").click();
  await expect(page.getByTestId("pirate-toggle")).toHaveAttribute("aria-pressed", "false");
  await expectNav(page, en);

  await page.getByTestId("nav-todos").click();
  await expect(page).toHaveURL(/\/todos$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(en.navTodos);
});

test("a partial job shows the failed stage's error text, re-enables Refresh and stops polling", async ({
  page,
}) => {
  const WA_ERROR = "relink required (run yarvis wa:link --reset)";
  const stage = (state: string, count = 0, error?: string) =>
    error === undefined ? { state, count } : { state, count, error };
  const all = (state: string) => ({
    whatsapp: stage(state),
    gmail: stage(state),
    jev: stage(state),
    extract: stage(state),
    sheets: stage(state),
  });
  const idle = { state: "idle", stages: all("pending"), startedAt: null, finishedAt: null };
  const running = {
    state: "running",
    stages: { ...all("pending"), whatsapp: stage("running") },
    startedAt: "2026-10-19T18:02:11.000Z",
    finishedAt: null,
  };
  const partial = {
    state: "partial",
    stages: {
      whatsapp: stage("error", 0, WA_ERROR),
      gmail: stage("done", 4),
      jev: stage("done", 4),
      extract: stage("done", 2),
      sheets: stage("done", 4),
    },
    startedAt: "2026-10-19T18:02:11.000Z",
    finishedAt: "2026-10-19T18:02:14.000Z",
  };
  let clicked = false;
  let polls = 0;
  await page.route("**/api/refresh/status", (route) => {
    if (!clicked) return route.fulfill({ json: idle });
    polls++;
    return route.fulfill({ json: polls === 1 ? running : partial });
  });
  await page.route("**/api/refresh", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 202, json: { jobId: "job-2026-10-19T18:02:11Z" } })
      : route.fallback(),
  );

  await page.goto("/todos");
  await expect(page.getByTestId("todo-row").first()).toBeVisible();
  clicked = true;
  await page.getByTestId("refresh-button").click();

  await expect(page.getByTestId("refresh-state")).toHaveAttribute("data-state", "partial", {
    timeout: 10_000,
  });
  await expect(page.getByTestId("refresh-state")).toHaveText(en.jobPartial);
  const whatsapp = page.locator('[data-testid="refresh-stage"][data-stage="whatsapp"]');
  await expect(whatsapp).toHaveAttribute("data-state", "error");
  await expect(whatsapp.getByTestId("stage-error")).toHaveText(WA_ERROR);
  await expect(page.getByTestId("stage-error")).toHaveCount(1);
  await expect(page.getByTestId("refresh-button")).toBeEnabled();
  await expect(page.getByTestId("refresh-button")).toHaveText(en.refresh);

  // Terminal: no further status requests over two more poll intervals.
  const pollsAtTerminal = polls;
  expect(pollsAtTerminal).toBe(2);
  await page.waitForTimeout(REFRESH_POLL_MS * 2 + 500);
  expect(polls).toBe(pollsAtTerminal);
});

test("Refresh runs the fake pipeline and the new to-do appears with its source chip", async ({
  page,
}) => {
  await page.goto("/todos");
  await expect(page.getByTestId("todo-row").first()).toBeVisible();
  const row = page.locator(`[data-testid="todo-row"][data-todo-id="${NEW_MESSAGE}#1"]`);
  await expect(row).toHaveCount(0);

  await page.getByTestId("refresh-button").click();
  // Polled every 2 s; the fake job (short WhatsApp drain window) finishes well within this.
  await expect(page.getByTestId("refresh-state")).toHaveAttribute("data-state", "done", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("refresh-state")).toHaveText(en.jobDone);
  const stages = page.getByTestId("refresh-stage");
  await expect(stages).toHaveCount(5);
  await expect(page.locator('[data-testid="refresh-stage"]:not([data-state="done"])')).toHaveCount(
    0,
  );
  await expect(page.getByTestId("stage-error")).toHaveCount(0);

  await expect(row).toBeVisible();
  await expect(row.getByTestId("source-chip")).toHaveText(en.sourceGmail);
  await expect(row.getByTestId("todo-action")).toHaveText(claudeResponses[NEW_MESSAGE]![0]!);

  await page.getByTestId("hide-done-toggle").click();
  await expect(page.getByTestId("todo-row")).toHaveCount(EXPECTED.todos);
});

// Step 2 smoke (fake mode, FakeSheets seeded from server/fixtures/sheet-seed.json): mark a fixture
// to-do done -> it disappears under hide-done and reappears (checked) under show-all; the
// Quarantine page shows a seeded row with its reason and scores.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { QuarantineItem, Todo } from "@yarvis/shared";
import { en } from "../src/i18n/strings.js";

const seed = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../server/fixtures/sheet-seed.json", import.meta.url)),
    "utf8",
  ),
) as { Todos: Todo[]; Quarantine: QuarantineItem[] };

const WA_TODO = seed.Todos.find((t) => t.source === "whatsapp" && t.status === "open")!;
const PHISH = seed.Quarantine.find((q) => q.reason.startsWith("phishing"))!;

test("a fixture to-do marked done hides under hide-done and returns under show-all", async ({
  page,
}) => {
  await page.goto("/todos");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(en.navTodos);
  const row = page.locator(`[data-testid="todo-row"][data-todo-id="${WA_TODO.id}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("source-chip")).toHaveText(en.sourceWhatsapp);
  await expect(row.getByTestId("todo-action")).toHaveText(WA_TODO.action);
  await expect(page.locator('[data-testid="source-chip"][data-source="gmail"]').first()).toHaveText(
    en.sourceGmail,
  );

  // Fake mode has no real sheet id: the note replaces the Open-sheet link.
  await expect(page.getByTestId("open-sheet-missing")).toHaveText(en.sheetNotConfigured);

  // Hide-done is on by default; the visible label names the action it would take.
  const hideDone = page.getByTestId("hide-done-toggle");
  await expect(hideDone).toHaveAttribute("aria-pressed", "true");
  await expect(hideDone).toHaveText(en.showDone);

  // Mark done (PATCH /api/todos/<encoded id>): gone under hide-done, also after a reload.
  await row.getByTestId("todo-done").click();
  await expect(row).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("todo-row").first()).toBeVisible();
  await expect(row).toHaveCount(0);

  // Show all: back, checked.
  await page.getByTestId("hide-done-toggle").click();
  await expect(page.getByTestId("hide-done-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("hide-done-toggle")).toHaveText(en.hideDone);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("todo-done")).toBeChecked();

  // Restore the fixture state (uncheck -> open) so the smoke is repeatable within one server run.
  await row.getByTestId("todo-done").click();
  await expect(row.getByTestId("todo-done")).not.toBeChecked();
  await page.getByTestId("hide-done-toggle").click();
  await expect(row).toBeVisible();
});

test("the Quarantine page shows a seeded row with its reason and scores", async ({ page }) => {
  await page.goto("/todos");
  await page.getByTestId("nav-quarantine").click();
  await expect(page).toHaveURL(/\/quarantine$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(en.navQuarantine);
  const row = page.locator(`[data-testid="quarantine-row"][data-quarantine-id="${PHISH.id}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(PHISH.context);
  await expect(row.getByTestId("quarantine-reason")).toHaveText(PHISH.reason.split(",").join(", "));
  await expect(row.getByTestId("score-phishing")).toHaveText(PHISH.jev_phishing!.toFixed(2));
  await expect(row.getByTestId("score-malicious")).toHaveText(PHISH.jev_malicious!.toFixed(2));
  await expect(row.getByTestId("score-spam")).toHaveText(PHISH.jev_spam!.toFixed(2));
  await expect(page.getByTestId("quarantine-row")).toHaveCount(seed.Quarantine.length);
});

test("the Quarantine table fits a 1280px viewport with every link readable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/quarantine");
  const table = page.getByTestId("quarantine-table");
  await expect(table).toBeVisible();
  const wrap = table.locator("xpath=..");
  // No horizontal scrolling inside the wrapper: nothing is clipped.
  const overflow = await wrap.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const wrapBox = await wrap.boundingBox();
  const link = page
    .locator('[data-testid="quarantine-row"]')
    .first()
    .getByRole("link", { name: en.openOriginal });
  await expect(link).toBeVisible();
  const linkBox = await link.boundingBox();
  expect(linkBox!.x + linkBox!.width).toBeLessThanOrEqual(wrapBox!.x + wrapBox!.width);
});

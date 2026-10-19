// Step 1 smoke (fake mode): the shell renders, and the Settings pirate toggle swaps the nav labels
// to the pirate table, persists across a reload (PATCH /api/settings -> private settings.json),
// and swaps back.
import { expect, test, type Page } from "@playwright/test";
import { en, pirate, type Strings } from "../src/i18n/strings.js";

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

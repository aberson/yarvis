// Step 9 (plan Phase 2 / S1): the Briefing landing page in fake mode, end to end through the real
// server, assistant service and SQLite store (own temp private dir, ports 8797/5183). `/` lands on
// /briefing; Build creates a saved snapshot that a reload reopens WITHOUT re-POSTing; pending items
// are not actionable; stubbed responses cover the >25 omitted count, a failed run over a historical
// snapshot, reconnecting to a running run, a lost POST retried with the same request id, and an
// unavailable store leaving Todos usable.
import { expect, test, type Page, type Request } from "@playwright/test";
import type { AssistantRun, Briefing, BriefingItem } from "@yarvis/shared";
import { en } from "../src/i18n/strings.js";

/** The seeded fake server's web origin (E2E_SEEDED_WEB_PORT in playwright.config.ts). */
const SEEDED = "http://127.0.0.1:5184";
const seededId = (n: number) => `gmail:5eed${n.toString(16).padStart(12, "0")}#1`;

const RUN_ID = "70000000-0000-4000-8000-0000000000aa";
const BRIEFING_ID = "70000000-0000-4000-8000-0000000000bb";

function run(over: Partial<AssistantRun> = {}): AssistantRun {
  return {
    id: RUN_ID,
    requestId: "70000000-0000-4000-8000-000000000001",
    kind: "briefing",
    state: "running",
    createdAt: new Date().toISOString(),
    finishedAt: null,
    targetId: null,
    sourceTodoId: null,
    errorCode: null,
    model: null,
    promptVersion: null,
    ...over,
  };
}

function item(n: number): BriefingItem {
  return {
    sourceRef: {
      todoId: `gmail:${n.toString(16).padStart(16, "0")}#1`,
      source: "gmail",
      sender: `sender${n}@example.test`,
      context: `Subject ${n}`,
      messageDate: "2026-10-01T00:00:00.000Z",
      link: "",
      originalText: `Synthetic body ${n}`,
      action: `Synthetic action ${n}`,
      extractionStatus: "done",
    },
    isNew: false,
    preparationEligible: true,
  };
}

function briefing(over: Partial<Briefing> = {}): Briefing {
  return {
    id: BRIEFING_ID,
    createdAt: new Date(Date.now() - 2.5 * 3_600_000).toISOString(),
    sheetReadAt: new Date(Date.now() - 2.5 * 3_600_000).toISOString(),
    previousBriefingId: null,
    openCount: 1,
    omittedCount: 0,
    items: [item(1)],
    sourceCoverage: [
      { source: "gmail", configured: true, freshness: "unknown" },
      { source: "whatsapp", configured: true, freshness: "unknown" },
    ],
    ...over,
  };
}

function briefingPosts(page: Page): Request[] {
  const posts: Request[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/api/assistant/briefings")) posts.push(req);
  });
  return posts;
}

test("/ lands on the Briefing; Build saves a snapshot that a reload reopens without re-POSTing", async ({
  page,
}) => {
  const posts = briefingPosts(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/briefing$/);
  await expect(page.getByTestId("nav-briefing")).toHaveText(en.navBriefing);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(en.navBriefing);
  await expect(page.getByTestId("briefing-stored-note")).toContainText(en.briefingStoredNote);

  await page.getByTestId("briefing-generate").click();
  const items = page.getByTestId("briefing-item");
  await expect(items.first()).toBeVisible({ timeout: 10_000 });
  expect(posts).toHaveLength(1);
  // Fixture: 4 open, unquarantined to-dos; one pending extraction is listed but not actionable.
  await expect(page.getByTestId("briefing-open-count")).toHaveText("4 open tasks");
  await expect(items).toHaveCount(4);
  const pending = page.locator('[data-testid="briefing-item"][data-eligible="false"]');
  await expect(pending).toHaveCount(1);
  await expect(pending.getByTestId("briefing-not-ready")).toHaveText(en.briefingNotReady);
  await expect(page.getByTestId("briefing-baseline")).toHaveText(en.briefingBaseline);
  await expect(page.getByTestId("briefing-new")).toHaveCount(0);
  await expect(page.getByTestId("briefing-age")).toContainText("Saved just now");
  await expect(page.getByTestId("briefing-coverage").locator("li")).toHaveCount(2);
  await expect(page.getByTestId("briefing-coverage")).toContainText(en.freshnessUnknown);
  await expect(page.getByTestId("briefing-omitted")).toHaveCount(0);
  const id = await page.getByTestId("briefing").getAttribute("data-briefing-id");
  const postedBody = posts[0]?.postDataJSON() as { requestId: string };
  expect(postedBody.requestId).toMatch(/^[0-9a-f-]{36}$/);

  await page.reload();
  await expect(page.getByTestId("briefing")).toHaveAttribute("data-briefing-id", id ?? "");
  await expect(page.getByTestId("briefing-historical")).toHaveCount(0);
  expect(posts).toHaveLength(1);

  // A second intentional Build gets a new request id and a new snapshot chained to the first.
  await page.getByTestId("briefing-generate").click();
  await expect(page.getByTestId("briefing")).not.toHaveAttribute("data-briefing-id", id ?? "", {
    timeout: 10_000,
  });
  expect(posts).toHaveLength(2);
  expect((posts[1]?.postDataJSON() as { requestId: string }).requestId).not.toBe(
    postedBody.requestId,
  );
  await expect(page.getByTestId("briefing-baseline")).toHaveCount(0);

  // Existing navigation still works.
  await page.getByTestId("nav-todos").click();
  await expect(page).toHaveURL(/\/todos$/);
  await expect(page.getByTestId("todo-row").first()).toBeVisible();
});

test("seeded sheet: 25 shown of 30 open, omitted count links to Todos, pending/none not ready", async ({
  page,
}) => {
  // The seeded fake server (playwright.config.ts): 30 open visible to-dos, the newest two with
  // extraction none / pending, plus done rows and one quarantined to-do that must not appear.
  await page.goto(`${SEEDED}/`);
  await expect(page).toHaveURL(/\/briefing$/);
  await page.getByTestId("briefing-generate").click();
  const items = page.getByTestId("briefing-item");
  await expect(items).toHaveCount(25, { timeout: 10_000 });
  await expect(page.getByTestId("briefing-open-count")).toHaveText("30 open tasks");
  await expect(page.getByTestId("briefing-omitted")).toContainText("5 more not shown.");
  await expect(page.locator(`[data-todo-id="${seededId(300)}"]`)).toHaveCount(0); // quarantined

  const none = page.locator(`[data-testid="briefing-item"][data-todo-id="${seededId(101)}"]`);
  const pending = page.locator(`[data-testid="briefing-item"][data-todo-id="${seededId(100)}"]`);
  await expect(none).toContainText(en.extractionNone);
  await expect(none.getByTestId("briefing-not-ready")).toHaveText(en.briefingNotReady);
  await expect(pending).toContainText(en.extractionPending);
  await expect(pending.getByTestId("briefing-not-ready")).toHaveText(en.briefingNotReady);
  await expect(page.getByTestId("briefing-not-ready")).toHaveCount(2);
  await expect(items.first()).toHaveAttribute("data-todo-id", seededId(101)); // newest first

  // A second build over unchanged data says so explicitly.
  await page.getByTestId("briefing-generate").click();
  await expect(page.getByTestId("briefing-nothing-new")).toHaveText(en.briefingNothingNew, {
    timeout: 10_000,
  });
  await expect(page.getByTestId("briefing-new")).toHaveCount(0);

  await page.getByTestId("briefing-see-all").click();
  await expect(page).toHaveURL(/\/todos$/);
  await expect(page.getByTestId("todo-row")).toHaveCount(30);
});

test("a failed run is shown honestly and the older snapshot is labelled historical", async ({
  page,
}) => {
  await page.route("**/api/assistant/runs/latest", (route) =>
    route.fulfill({
      json: {
        run: run({ state: "failed", errorCode: "source_unavailable", finishedAt: run().createdAt }),
      },
    }),
  );
  await page.route("**/api/assistant/briefings/latest", (route) =>
    route.fulfill({ json: { briefing: briefing() } }),
  );
  await page.goto("/briefing");
  await expect(page.getByTestId("briefing-run")).toHaveAttribute("data-state", "failed");
  await expect(page.getByTestId("briefing-run")).toHaveText(
    `${en.runFailed}: ${en.errSourceUnavailable}`,
  );
  await expect(page.getByTestId("briefing-historical")).toHaveText(en.briefingHistorical);
  await expect(page.getByTestId("briefing-age")).toContainText("Saved 2 h ago");
  await expect(page.getByTestId("briefing-item")).toHaveCount(1);
});

test("reopening during a run reconnects to it and shows the result when it finishes", async ({
  page,
}) => {
  // The run stays running until the test lets it finish (independent of StrictMode re-mounts).
  let finished = false;
  let polls = 0;
  await page.route("**/api/assistant/runs/*", (route) => {
    if (route.request().url().endsWith("/runs/latest")) {
      return route.fulfill({ json: { run: run() } });
    }
    polls++;
    return route.fulfill({
      json: { run: finished ? run({ state: "succeeded", targetId: BRIEFING_ID }) : run() },
    });
  });
  await page.route("**/api/assistant/briefings/latest", (route) =>
    route.fulfill({ json: { briefing: finished ? briefing() : null } }),
  );
  const posts = briefingPosts(page);
  await page.goto("/briefing");
  await expect(page.getByTestId("briefing-run")).toHaveAttribute("data-state", "running");
  await expect(page.getByTestId("briefing-generate")).toBeDisabled();
  await expect.poll(() => polls).toBeGreaterThanOrEqual(1);
  finished = true;
  await expect(page.getByTestId("briefing")).toHaveAttribute("data-briefing-id", BRIEFING_ID, {
    timeout: 10_000,
  });
  await expect(page.getByTestId("briefing-run")).toHaveCount(0);
  await expect(page.getByTestId("briefing-generate")).toBeEnabled();
  expect(posts).toHaveLength(0);
});

test("a lost POST response offers Retry, which reuses the same request id", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/assistant/briefings", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    attempts++;
    return attempts === 1 ? route.abort("connectionreset") : route.fallback();
  });
  const posts = briefingPosts(page);
  await page.goto("/briefing");
  await expect(page.getByTestId("briefing-generate")).toBeEnabled();
  await page.getByTestId("briefing-generate").click();
  await expect(page.getByTestId("briefing-lost")).toHaveText(en.runLost);
  await expect(page.getByTestId("briefing-generate")).toHaveText(en.briefingRetry);
  await page.getByTestId("briefing-generate").click();
  await expect(page.getByTestId("briefing-run")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId("briefing-item").first()).toBeVisible({ timeout: 10_000 });
  expect(posts).toHaveLength(2);
  const ids = posts.map((p) => (p.postDataJSON() as { requestId: string }).requestId);
  expect(ids[1]).toBe(ids[0]);
});

test("an unavailable assistant store is visible and Todos stay usable", async ({ page }) => {
  const unavailable = {
    status: 503,
    json: {
      error: "assistant_unavailable",
      message: "assistant storage is unavailable; Todos still work",
    },
  };
  await page.route("**/api/assistant/runs/latest", (route) => route.fulfill(unavailable));
  await page.route("**/api/assistant/briefings/latest", (route) => route.fulfill(unavailable));
  await page.goto("/");
  await expect(page.getByTestId("assistant-unavailable")).toContainText(en.assistantUnavailable);
  await expect(page.getByTestId("briefing-generate")).toHaveCount(0);
  await page.getByTestId("nav-todos").click();
  await expect(page.getByTestId("todo-row").first()).toBeVisible();
});

test("the Briefing fits a 390 px wide viewport without horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/assistant/runs/latest", (route) =>
    route.fulfill({ json: { run: run({ state: "succeeded", targetId: BRIEFING_ID }) } }),
  );
  await page.route("**/api/assistant/briefings/latest", (route) =>
    route.fulfill({ json: { briefing: briefing({ items: [item(1), item(2)], openCount: 2 }) } }),
  );
  await page.goto("/briefing");
  await expect(page.getByTestId("briefing-item")).toHaveCount(2);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

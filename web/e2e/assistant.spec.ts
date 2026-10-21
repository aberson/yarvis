// Step 9 (plan Phase 2 / S1): the Briefing landing page in fake mode, end to end through the real
// server, assistant service and SQLite store (own temp private dir, ports 8797/5183). `/` lands on
// /briefing; Build creates a saved snapshot that a reload reopens WITHOUT re-POSTing; pending items
// are not actionable; stubbed responses cover the >25 omitted count, a failed run over a historical
// snapshot, reconnecting to a running run, a lost POST retried with the same request id, and an
// unavailable store leaving Todos usable. Step 10 adds Prepare -> saved packet -> /preparations/:id
// (and reopening it without a new run), failed / refused / lost preparations, and plain-text
// rendering of the packet page.
import { expect, test, type Page, type Request } from "@playwright/test";
import type { AssistantRun, Briefing, BriefingItem, PreparationPacket } from "@yarvis/shared";
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

// ---------------------------------------------------------------------------------------------
// Step 10: prepare one source-grounded response packet.

const PACKET_ID = "70000000-0000-4000-8000-0000000000cc";

function packet(over: Partial<PreparationPacket> = {}): PreparationPacket {
  return {
    id: PACKET_ID,
    todoId: item(1).sourceRef.todoId,
    sourceRef: item(1).sourceRef,
    createdAt: "2026-10-21T09:00:00.000Z",
    updatedAt: "2026-10-21T09:00:00.000Z",
    revision: 1,
    state: "open",
    draft: "Hello,\nthanks for the note.",
    checklist: [{ id: "70000000-0000-4000-8000-0000000000d1", text: "Check it", done: false }],
    questions: ["Which day?"],
    model: "fake-composer",
    promptVersion: "compose-v1",
    ...over,
  };
}

function preparationPosts(page: Page): Request[] {
  const posts: Request[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/api/assistant/preparations")) {
      posts.push(req);
    }
  });
  return posts;
}

/** Stubs the Briefing's mount reads: a succeeded briefing run and one eligible item. */
async function stubBriefing(page: Page): Promise<void> {
  await page.route("**/api/assistant/runs/latest", (route) =>
    route.fulfill({ json: { run: run({ state: "succeeded", targetId: BRIEFING_ID }) } }),
  );
  await page.route("**/api/assistant/briefings/latest", (route) =>
    route.fulfill({ json: { briefing: briefing() } }),
  );
}

const isPreparationPost = (r: { url(): string; request(): Request }) =>
  r.url().endsWith("/api/assistant/preparations") && r.request().method() === "POST";

test("Prepare: an eligible task opens a saved packet; the same task reopens it without a new run", async ({
  page,
}) => {
  const posts = preparationPosts(page);
  await page.goto("/briefing");
  await page.getByTestId("briefing-generate").click();
  await expect(page.getByTestId("briefing-run")).toHaveCount(0, { timeout: 10_000 });
  const eligible = page.locator('[data-testid="briefing-item"][data-eligible="true"]').first();
  await expect(eligible).toBeVisible({ timeout: 10_000 });
  const todoId = (await eligible.getAttribute("data-todo-id")) ?? "";
  // Pending/none items have no Prepare action.
  await expect(
    page.locator(
      '[data-testid="briefing-item"][data-eligible="false"] [data-testid="briefing-prepare"]',
    ),
  ).toHaveCount(0);
  await expect(eligible.getByTestId("briefing-prepare")).toHaveText(en.prepare);

  const firstResponse = page.waitForResponse(isPreparationPost);
  await eligible.getByTestId("briefing-prepare").click();
  expect((await firstResponse).status()).toBe(202);
  await expect(page).toHaveURL(/\/preparations\/[0-9a-f-]{36}$/, { timeout: 10_000 });
  const url = page.url();
  const view = page.getByTestId("preparation");
  await expect(view).toHaveAttribute("data-todo-id", todoId);
  await expect(view).toHaveAttribute("data-revision", "1");
  await expect(view).toHaveAttribute("data-state", "open");
  await expect(page.getByTestId("preparation-not-sent")).toHaveText(en.prepNotSent);
  await expect(page.getByTestId("preparation-draft")).toContainText("Synthetic fake-mode draft");
  await expect(page.getByTestId("preparation-check")).toHaveCount(3);
  await expect(page.getByTestId("preparation-question")).toHaveCount(1);
  await expect(page.getByTestId("preparation-excerpt")).not.toBeEmpty();
  await expect(page.getByTestId("preparation-meta")).toContainText("fake-composer");

  // Back on the Briefing, the same task opens the SAME packet (200, no new run).
  await page.getByTestId("preparation-back").click();
  await expect(page).toHaveURL(/\/briefing$/);
  const again = page.locator(`[data-testid="briefing-item"][data-todo-id="${todoId}"]`);
  const secondResponse = page.waitForResponse(isPreparationPost);
  await again.getByTestId("briefing-prepare").click();
  expect((await secondResponse).status()).toBe(200);
  await expect(page).toHaveURL(url);
  expect(posts).toHaveLength(2);
  const ids = posts.map((p) => (p.postDataJSON() as { requestId: string }).requestId);
  expect(ids[1]).not.toBe(ids[0]);
  // A reload of the packet never re-POSTs.
  await page.reload();
  await expect(page.getByTestId("preparation")).toBeVisible();
  expect(posts).toHaveLength(2);
});

test("a failed preparation is visible on its card; Retry sends a NEW request id", async ({
  page,
}) => {
  await stubBriefing(page);
  const PREP_RUN = "70000000-0000-4000-8000-0000000000ee";
  const todoId = item(1).sourceRef.todoId;
  await page.route("**/api/assistant/preparations", (route) =>
    route.fulfill({
      status: 202,
      json: {
        run: run({
          id: PREP_RUN,
          kind: "prepare",
          sourceTodoId: todoId,
          requestId: (route.request().postDataJSON() as { requestId: string }).requestId,
        }),
      },
    }),
  );
  await page.route(`**/api/assistant/runs/${PREP_RUN}`, (route) =>
    route.fulfill({
      json: {
        run: run({
          id: PREP_RUN,
          kind: "prepare",
          state: "failed",
          errorCode: "compose_timeout",
          finishedAt: new Date().toISOString(),
          sourceTodoId: todoId,
        }),
      },
    }),
  );
  const posts = preparationPosts(page);
  await page.goto("/briefing");
  const card = page.getByTestId("briefing-item").first();
  await card.getByTestId("briefing-prepare").click();
  await expect(card.getByTestId("briefing-prep")).toHaveAttribute("data-state", "failed");
  await expect(card.getByTestId("briefing-preparation-failed")).toHaveText(
    `${en.prepFailed}: ${en.errComposeTimeout}`,
  );
  await expect(card.getByTestId("briefing-prepare")).toHaveText(en.briefingRetry);
  await card.getByTestId("briefing-prepare").click();
  await expect.poll(() => posts.length).toBe(2);
  const ids = posts.map((p) => (p.postDataJSON() as { requestId: string }).requestId);
  expect(ids[1]).not.toBe(ids[0]);
  await expect(page).toHaveURL(/\/briefing$/);
});

test("a changed source is refused with a refresh instruction and nothing opens", async ({
  page,
}) => {
  await stubBriefing(page);
  await page.route("**/api/assistant/preparations", (route) =>
    route.fulfill({
      status: 409,
      json: { error: "revision_conflict", message: "the task changed" },
    }),
  );
  await page.goto("/briefing");
  const card = page.getByTestId("briefing-item").first();
  await card.getByTestId("briefing-prepare").click();
  await expect(card.getByTestId("briefing-prep")).toHaveAttribute("data-state", "conflict");
  await expect(card.getByTestId("briefing-prep")).toContainText(en.prepConflict);
  await expect(page).toHaveURL(/\/briefing$/);
});

test("a lost Prepare response offers Retry, which reuses the same request id", async ({ page }) => {
  await stubBriefing(page);
  let attempts = 0;
  await page.route("**/api/assistant/preparations", (route) => {
    attempts++;
    return attempts === 1
      ? route.abort("connectionreset")
      : route.fulfill({ status: 200, json: { packet: packet() } });
  });
  await page.route(`**/api/assistant/preparations/${PACKET_ID}`, (route) =>
    route.fulfill({ json: { packet: packet() } }),
  );
  const posts = preparationPosts(page);
  await page.goto("/briefing");
  const card = page.getByTestId("briefing-item").first();
  await card.getByTestId("briefing-prepare").click();
  await expect(card.getByTestId("briefing-prep")).toHaveAttribute("data-state", "lost");
  await card.getByTestId("briefing-prepare").click();
  await expect(page).toHaveURL(new RegExp(`/preparations/${PACKET_ID}$`));
  const ids = posts.map((p) => (p.postDataJSON() as { requestId: string }).requestId);
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
});

test("the Preparation page renders model and source text as plain text and fits 390 px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const hostile = '<img src=x onerror="window.__pwned=1"> **bold** ' + "x".repeat(300);
  await page.route(`**/api/assistant/preparations/${PACKET_ID}`, (route) =>
    route.fulfill({
      json: {
        packet: packet({
          draft: hostile,
          checklist: [{ id: "70000000-0000-4000-8000-0000000000d2", text: hostile, done: false }],
          questions: [hostile],
          sourceRef: { ...item(1).sourceRef, link: "javascript:alert(1)", originalText: hostile },
        }),
      },
    }),
  );
  await page.goto(`/preparations/${PACKET_ID}`);
  await expect(page.getByTestId("preparation-draft")).toContainText('<img src=x onerror="');
  await expect(page.getByTestId("preparation-excerpt")).toContainText("<img");
  await expect(page.locator('[data-testid="preparation"] img')).toHaveCount(0);
  await expect(page.getByTestId("preparation-link")).toHaveCount(0); // not an http(s) link
  expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("an unknown preparation id says so", async ({ page }) => {
  await page.goto("/preparations/70000000-0000-4000-8000-0000000000ff");
  await expect(page.getByTestId("preparation-not-found")).toHaveText(en.prepNotFound);
});

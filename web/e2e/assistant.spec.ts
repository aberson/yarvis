// Step 9 (plan Phase 2 / S1): the Briefing landing page in fake mode, end to end through the real
// server, assistant service and SQLite store (own temp private dir, ports 8797/5183). `/` lands on
// /briefing; Build creates a saved snapshot that a reload reopens WITHOUT re-POSTing; pending items
// are not actionable; stubbed responses cover the >25 omitted count, a failed run over a historical
// snapshot, reconnecting to a running run, a lost POST retried with the same request id, and an
// unavailable store leaving Todos usable. Step 10 adds Prepare -> saved packet -> /preparations/:id
// (and reopening it without a new run), failed / refused / lost preparations, and plain-text
// rendering of the packet page. Step 11 adds editing: the whole flow at 390 px (briefing -> prepare
// -> edit -> leave prompt -> save -> handled -> list -> reopen), a stale second tab's 409 with local
// edits kept, failed saves keeping local text, the reload warning and the list's limit notice.
// Step 12 adds the lost-save guards: a genuine second-tab save still conflicts while this tab has a
// pending lost save, and a lost "Mark handled" is not silently reopened by the next plain Save.
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
  await expect(page.getByTestId("preparation-draft")).toHaveValue(/Synthetic fake-mode draft/);
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
  await expect(page.getByTestId("preparation-draft")).toHaveValue(hostile);
  await expect(page.getByTestId("preparation-check-text")).toHaveValue(hostile);
  await expect(page.getByTestId("preparation-question-text")).toHaveValue(hostile);
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

// ---------------------------------------------------------------------------------------------
// Step 11: resume edited preparations safely.

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** On the seeded server: build a briefing, Prepare the given Todo, land on its packet page. */
async function prepareSeeded(page: Page, n: number): Promise<string> {
  await page.goto(`${SEEDED}/briefing`);
  await page.getByTestId("briefing-generate").click();
  await expect(page.getByTestId("briefing-run")).toHaveCount(0, { timeout: 10_000 });
  const card = page.locator(`[data-testid="briefing-item"][data-todo-id="${seededId(n)}"]`);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.getByTestId("briefing-prepare").click();
  await expect(page).toHaveURL(/\/preparations\/[0-9a-f-]{36}$/, { timeout: 10_000 });
  await expect(page.getByTestId("preparation")).toBeVisible();
  return page.url();
}

const isPatch = (r: { url(): string; request(): Request }) =>
  r.url().includes("/api/assistant/preparations/") && r.request().method() === "PATCH";

test("390 px: briefing -> prepare -> edit -> save -> handled -> list -> reopen keeps every edit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const url = await prepareSeeded(page, 20);
  const packetId = url.split("/").pop() ?? "";
  await noHorizontalScroll(page);
  const view = page.getByTestId("preparation");
  await expect(view).toHaveAttribute("data-revision", "1");
  await expect(page.getByTestId("preparation-status")).toHaveText(en.prepSaved);
  await expect(page.getByTestId("preparation-save")).toBeDisabled();
  await expect(page.getByTestId("preparation-captured")).toContainText("Source captured");

  // Edit the draft, one checklist item's text, tick another, add a question.
  await page.getByTestId("preparation-draft").fill("My edited reply.\nSecond line.");
  await page.getByTestId("preparation-check-text").first().fill("Edited first step");
  await page.getByTestId("preparation-check-done").nth(1).check();
  await page.getByTestId("preparation-question-add").click();
  await page.getByTestId("preparation-question-text").last().fill("A question I added?");
  await expect(page.getByTestId("preparation-status")).toHaveText(en.prepUnsaved);
  await expect(view).toHaveAttribute("data-dirty", "true");
  await noHorizontalScroll(page);

  // An in-app navigation asks first; Stay keeps everything.
  await page.getByTestId("nav-preparations").click();
  await expect(page.getByTestId("preparation-leave")).toBeVisible();
  await expect(page).toHaveURL(url);
  await page.getByTestId("preparation-stay").click();
  await expect(page.getByTestId("preparation-leave")).toHaveCount(0);
  await expect(page.getByTestId("preparation-draft")).toHaveValue("My edited reply.\nSecond line.");

  const saved = page.waitForResponse(isPatch);
  await page.getByTestId("preparation-save").click();
  expect((await saved).status()).toBe(200);
  await expect(view).toHaveAttribute("data-revision", "2");
  await expect(page.getByTestId("preparation-status")).toHaveText(en.prepSaved);

  // Handled is a local status saved the same way; the Todos link is the separate action.
  await page.getByTestId("preparation-toggle-state").click();
  await expect(view).toHaveAttribute("data-state", "handled");
  await expect(view).toHaveAttribute("data-revision", "3");
  await expect(page.getByTestId("preparation-state")).toHaveText(en.prepStateHandled);
  await expect(page.getByTestId("preparation-toggle-state")).toHaveText(en.prepReopen);
  await expect(page.getByTestId("preparation-handled-note")).toContainText(en.prepHandledNote);
  await expect(page.getByTestId("preparation-todos-link")).toHaveAttribute("href", "/todos");
  await noHorizontalScroll(page);

  // Saved: navigation is no longer blocked. The list shows it as handled.
  await page.getByTestId("nav-preparations").click();
  await expect(page).toHaveURL(/\/preparations$/);
  const row = page.locator(`[data-testid="preparations-item"][data-packet-id="${packetId}"]`);
  await expect(row).toHaveAttribute("data-state", "handled");
  await expect(row.getByTestId("preparations-state")).toHaveText(en.prepStateHandled);
  await expect(row.getByTestId("preparations-updated")).toContainText("revision 3");
  await expect(page.getByTestId("preparations-omitted")).toHaveCount(0);
  await noHorizontalScroll(page);

  await row.getByTestId("preparations-open").click();
  await expect(page).toHaveURL(url);
  await expect(page.getByTestId("preparation-draft")).toHaveValue("My edited reply.\nSecond line.");
  await expect(page.getByTestId("preparation-check-text").first()).toHaveValue("Edited first step");
  await expect(page.getByTestId("preparation-check-done").nth(1)).toBeChecked();
  await expect(page.getByTestId("preparation-check-done").first()).not.toBeChecked();
  await expect(page.getByTestId("preparation-question-text").last()).toHaveValue(
    "A question I added?",
  );
  await expect(page.getByTestId("preparation")).toHaveAttribute("data-state", "handled");

  // "Handled" did not touch the Todo: it is still listed as open on the Todos page.
  await page.getByTestId("preparation-todos-link").click();
  await expect(page).toHaveURL(/\/todos$/);
  await expect(page.getByTestId("todo-row").filter({ hasText: "Seeded action 20" })).toHaveCount(1);
});

test("a stale second tab gets the conflict with its edits kept; keep mine or load saved, never silent", async ({
  page,
  context,
}) => {
  const url = await prepareSeeded(page, 21);
  const tabB = await context.newPage();
  await tabB.goto(url);
  await expect(tabB.getByTestId("preparation")).toHaveAttribute("data-revision", "1");

  // Tab A saves first.
  await page.getByTestId("preparation-draft").fill("Tab A text");
  await page.getByTestId("preparation-save").click();
  await expect(page.getByTestId("preparation")).toHaveAttribute("data-revision", "2");

  // Tab B, still on revision 1, is refused and keeps its own text next to the saved version.
  await tabB.getByTestId("preparation-draft").fill("Tab B text");
  await tabB.getByTestId("preparation-check-done").first().check();
  const refused = tabB.waitForResponse(isPatch);
  await tabB.getByTestId("preparation-save").click();
  expect((await refused).status()).toBe(409);
  await expect(tabB.getByTestId("preparation-conflict")).toBeVisible();
  await expect(tabB.getByTestId("preparation-draft")).toHaveValue("Tab B text");
  await expect(tabB.getByTestId("preparation-check-done").first()).toBeChecked();
  await expect(tabB.getByTestId("preparation-theirs-draft")).toHaveText("Tab A text");
  await expect(tabB.getByTestId("preparation-save")).toBeDisabled();
  await expect(tabB.getByTestId("preparation-status")).toHaveText(en.prepUnsaved);

  // Keep mine: re-based on revision 2, then an explicit save writes revision 3.
  await tabB.getByTestId("preparation-keep-mine").click();
  await expect(tabB.getByTestId("preparation-conflict")).toHaveCount(0);
  await expect(tabB.getByTestId("preparation")).toHaveAttribute("data-revision", "2");
  await expect(tabB.getByTestId("preparation-draft")).toHaveValue("Tab B text");
  await tabB.getByTestId("preparation-save").click();
  await expect(tabB.getByTestId("preparation")).toHaveAttribute("data-revision", "3");

  // Tab A is now the stale one: Load saved version replaces its local text only on request.
  await page.getByTestId("preparation-draft").fill("Tab A second edit");
  await page.getByTestId("preparation-save").click();
  await expect(page.getByTestId("preparation-conflict")).toBeVisible();
  await expect(page.getByTestId("preparation-draft")).toHaveValue("Tab A second edit");
  await page.getByTestId("preparation-load-theirs").click();
  await expect(page.getByTestId("preparation-draft")).toHaveValue("Tab B text");
  await expect(page.getByTestId("preparation")).toHaveAttribute("data-revision", "3");
  await expect(page.getByTestId("preparation")).toHaveAttribute("data-dirty", "false");
  await tabB.close();
});

test("a failed save keeps local text and shows the error; closing warns about unsaved edits", async ({
  page,
}) => {
  const target = `**/api/assistant/preparations/${PACKET_ID}`;
  await page.route(target, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 503, json: { error: "assistant_unavailable", message: "down" } })
      : route.fulfill({ json: { packet: packet() } }),
  );
  await page.goto(`/preparations/${PACKET_ID}`);
  await page.getByTestId("preparation-draft").fill("Precious local text");
  await page.getByTestId("preparation-save").click();
  await expect(page.getByTestId("preparation-save-error")).toContainText(en.prepSaveError);
  await expect(page.getByTestId("preparation-draft")).toHaveValue("Precious local text");
  await expect(page.getByTestId("preparation-status")).toHaveText(en.prepUnsaved);

  // A lost response (network failure) also keeps the text.
  await page.unroute(target);
  await page.route(target, (route) =>
    route.request().method() === "PATCH"
      ? route.abort("connectionreset")
      : route.fulfill({ json: { packet: packet() } }),
  );
  await page.getByTestId("preparation-save").click();
  await expect(page.getByTestId("preparation-save-error")).toBeVisible();
  await expect(page.getByTestId("preparation-draft")).toHaveValue("Precious local text");

  // A blank checklist item is caught before any request.
  let patches = 0;
  page.on("request", (r) => {
    if (r.method() === "PATCH") patches++;
  });
  await page.getByTestId("preparation-check-text").first().fill("   ");
  await page.getByTestId("preparation-save").click();
  await expect(page.getByTestId("preparation-save-error")).toContainText(en.prepSaveInvalid);
  expect(patches).toBe(0);

  // Closing the tab with unsaved edits raises the browser's leave prompt.
  const dialog = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const d = await dialog;
  expect(d.type()).toBe("beforeunload");
  await d.dismiss();
});

test("the saved list shows the total and a limit notice past 100, never a silent cut", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const summaries = Array.from({ length: 100 }, (_, i) => ({
    id: `70000000-0000-4000-8000-${(0x1000 + i).toString(16).padStart(12, "0")}`,
    todoId: item(i + 1).sourceRef.todoId,
    context: `Subject ${i + 1} ${"long".repeat(20)}`,
    state: i % 2 === 0 ? "open" : "handled",
    updatedAt: "2026-10-21T09:00:00.000Z",
    revision: 1,
  }));
  await page.route("**/api/assistant/preparations", (route) =>
    route.fulfill({ json: { packets: summaries, total: 130, omittedCount: 30 } }),
  );
  await page.goto("/preparations");
  await expect(page.getByTestId("preparations-item")).toHaveCount(100);
  await expect(page.getByTestId("preparations-total")).toHaveText("130 saved");
  await expect(page.getByTestId("preparations-omitted")).toContainText(
    "100 most recently updated of 130",
  );
  await expect(page.getByTestId("preparations-open").first()).toHaveAttribute(
    "href",
    `/preparations/${summaries[0]?.id}`,
  );
  await noHorizontalScroll(page);
});

test("an empty saved list points back to the Briefing", async ({ page }) => {
  await page.route("**/api/assistant/preparations", (route) =>
    route.fulfill({ json: { packets: [], total: 0, omittedCount: 0 } }),
  );
  await page.goto("/preparations");
  await expect(page.getByTestId("preparations-empty")).toContainText(en.prepListEmpty);
});

test("Leave without saving proceeds and discards edits; a lost save that committed is not a false conflict", async ({
  page,
}) => {
  const url = await prepareSeeded(page, 22);
  const original = await page.getByTestId("preparation-draft").inputValue();

  // Leave path of the in-app prompt: navigation proceeds, the unsaved edit is gone on return.
  await page.getByTestId("preparation-draft").fill("Throwaway edit");
  await page.getByTestId("nav-briefing").click();
  await expect(page.getByTestId("preparation-leave")).toBeVisible();
  await page.getByTestId("preparation-leave-go").click();
  await expect(page).toHaveURL(/\/briefing$/);
  await page.goto(url);
  await expect(page.getByTestId("preparation-draft")).toHaveValue(original);

  // The server commits the save but the browser never sees the answer.
  await page.route("**/api/assistant/preparations/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await route.fetch();
    return route.abort("connectionreset");
  });
  await page.getByTestId("preparation-draft").fill("First edit");
  await page.getByTestId("preparation-save").click();
  await expect(page.getByTestId("preparation-save-error")).toBeVisible();
  await expect(page.getByTestId("preparation")).toHaveAttribute("data-revision", "1");
  await page.unroute("**/api/assistant/preparations/*");

  // More typing, then Save: the 409 is our own committed write, so it re-bases and saves.
  await page.getByTestId("preparation-draft").fill("First edit, then more");
  await page.getByTestId("preparation-save").click();
  await expect(page.getByTestId("preparation")).toHaveAttribute("data-revision", "3");
  await expect(page.getByTestId("preparation-conflict")).toHaveCount(0);
  await expect(page.getByTestId("preparation-status")).toHaveText(en.prepSaved);
  await page.reload();
  await expect(page.getByTestId("preparation-draft")).toHaveValue("First edit, then more");
});

// ---------------------------------------------------------------------------------------------
// Step 12 carry-forward (Step 11 review): the lost-save re-base must never swallow a genuine second
// tab's save, and a lost "Mark handled" must not be silently reopened by the next plain Save.

/** Counts the PATCH requests `page` sends from now on. */
function countPatches(page: Page): () => number {
  let n = 0;
  page.on("request", (r) => {
    if (r.method() === "PATCH") n++;
  });
  return () => n;
}

/** PATCHes on `page` reach the server (`commit`) or not, and the browser never sees the answer. */
async function loseNextPatch(page: Page, commit: boolean): Promise<void> {
  await page.route("**/api/assistant/preparations/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    if (commit) await route.fetch();
    return route.abort("connectionreset");
  });
}

test("a pending lost save never hides a second tab's save at the next revision (content guard)", async ({
  page,
  context,
}) => {
  const url = await prepareSeeded(page, 23);
  const tabB = await context.newPage();
  await tabB.goto(url);
  await expect(tabB.getByTestId("preparation")).toHaveAttribute("data-revision", "1");

  // Tab A's save never reaches the server: it stays pending (unacknowledged) at base revision 1.
  await loseNextPatch(page, false);
  await page.getByTestId("preparation-draft").fill("Tab A lost text");
  await page.getByTestId("preparation-save").click();
  await expect(page.getByTestId("preparation-save-error")).toBeVisible();
  await page.unroute("**/api/assistant/preparations/*");

  // Tab B genuinely saves revision 2 (exactly base + 1, same open state, different content).
  await tabB.getByTestId("preparation-draft").fill("Tab B real save");
  await tabB.getByTestId("preparation-save").click();
  await expect(tabB.getByTestId("preparation")).toHaveAttribute("data-revision", "2");

  // Tab A's next Save must surface the conflict, not re-base over tab B's work: exactly ONE PATCH
  // (the refused one). A broken guard would send a second, re-based PATCH that overwrites tab B.
  await page.getByTestId("preparation-draft").fill("Tab A lost text, more");
  const patches = countPatches(page);
  await page.getByTestId("preparation-save").click();
  await expect(page.getByTestId("preparation-conflict")).toBeVisible();
  await expect(page.getByTestId("preparation")).toHaveAttribute("data-revision", "1");
  expect(patches()).toBe(1);
  await expect(page.getByTestId("preparation-theirs-draft")).toHaveText("Tab B real save");
  await expect(page.getByTestId("preparation-draft")).toHaveValue("Tab A lost text, more");
  await tabB.reload();
  await expect(tabB.getByTestId("preparation")).toHaveAttribute("data-revision", "2");
  await expect(tabB.getByTestId("preparation-draft")).toHaveValue("Tab B real save");
  await tabB.close();
});

test("a committed lost save never hides a second tab's later saves with the same text (revision guard)", async ({
  page,
  context,
}) => {
  const url = await prepareSeeded(page, 24);

  // Tab A's save commits revision 2, but its response is lost.
  await loseNextPatch(page, true);
  await page.getByTestId("preparation-draft").fill("Shared words");
  await page.getByTestId("preparation-save").click();
  await expect(page.getByTestId("preparation-save-error")).toBeVisible();
  await page.unroute("**/api/assistant/preparations/*");

  // Tab B (opened on revision 2) saves twice, ending on the same text: revision 4.
  const tabB = await context.newPage();
  await tabB.goto(url);
  await expect(tabB.getByTestId("preparation")).toHaveAttribute("data-revision", "2");
  await tabB.getByTestId("preparation-draft").fill("Tab B interim");
  await tabB.getByTestId("preparation-save").click();
  await expect(tabB.getByTestId("preparation")).toHaveAttribute("data-revision", "3");
  await tabB.getByTestId("preparation-draft").fill("Shared words");
  await tabB.getByTestId("preparation-save").click();
  await expect(tabB.getByTestId("preparation")).toHaveAttribute("data-revision", "4");

  // Same content as tab A's lost save, but not one revision on: a genuine conflict, exactly ONE
  // PATCH (a broken guard would re-base onto revision 4 and send a second PATCH writing revision 5).
  await page.getByTestId("preparation-draft").fill("Shared words, plus tab A");
  const patches = countPatches(page);
  await page.getByTestId("preparation-save").click();
  await expect(page.getByTestId("preparation-conflict")).toBeVisible();
  await expect(page.getByTestId("preparation")).toHaveAttribute("data-revision", "1");
  expect(patches()).toBe(1);
  await expect(page.getByTestId("preparation-draft")).toHaveValue("Shared words, plus tab A");
  await tabB.reload();
  await expect(tabB.getByTestId("preparation")).toHaveAttribute("data-revision", "4");
  await tabB.close();
});

test("a lost 'Mark handled' that committed stays handled through the next plain Save", async ({
  page,
}) => {
  const url = await prepareSeeded(page, 25);
  const view = page.getByTestId("preparation");

  // Mark handled commits revision 2 (handled), but the browser never sees the answer.
  await loseNextPatch(page, true);
  await page.getByTestId("preparation-toggle-state").click();
  await expect(page.getByTestId("preparation-save-error")).toBeVisible();
  await expect(view).toHaveAttribute("data-state", "open");
  await page.unroute("**/api/assistant/preparations/*");

  // A plain Save of newer edits re-bases onto the committed save and keeps it handled.
  await page.getByTestId("preparation-draft").fill("Edited after the lost handled save");
  const saved = page.waitForResponse((r) => isPatch(r) && r.status() === 200);
  await page.getByTestId("preparation-save").click();
  const body = (await (await saved).json()) as { packet: PreparationPacket };
  expect(body.packet.state).toBe("handled");
  await expect(view).toHaveAttribute("data-revision", "3");
  await expect(view).toHaveAttribute("data-state", "handled");
  await expect(page.getByTestId("preparation-conflict")).toHaveCount(0);
  await page.goto(url);
  await expect(page.getByTestId("preparation")).toHaveAttribute("data-state", "handled");
  await expect(page.getByTestId("preparation-draft")).toHaveValue(
    "Edited after the lost handled save",
  );
});

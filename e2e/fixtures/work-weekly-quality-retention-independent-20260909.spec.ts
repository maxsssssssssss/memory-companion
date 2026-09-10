import { writeFile } from "node:fs/promises";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { WorkWeeklyDisplayedGeneration, WorkWeeklyLatestGeneration, WorkWeeklyRun } from "../../src/lib/domain/work-weekly";
import { ACCOUNT_ID, createFixture, DIGEST, installFixture, NOW, PERSONAL_TEXT, REVIEW_ID, type Fixture } from "./work-review-ui-acceptance-20260909.fixture";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 }, actionTimeout: 20_000, navigationTimeout: 30_000 });
const OLD = "之前的系统回顾：权限范围尚未确认。";
const NOTE = "个人补充：保留人工核对安排。";
const INVALID = "INVALIDATED_CONTENT_MUST_NOT_REAPPEAR";
const HIDDEN = "HIDDEN_CONTENT_MUST_NOT_BE_COPIED";
const states: Fixture[] = [];

function data() {
  const state = createFixture();
  const base = state.items[0]!;
  state.items = [
    { ...base, id: "retained_system", section: "overview", systemText: OLD },
    { ...base, id: "retained_overlay", section: "open_questions", systemText: "被用户修改的旧系统文字",
      userText: PERSONAL_TEXT, userEditedAt: NOW, systemVersion: 1 },
    { ...base, id: "personal_note", section: "overview", origin: "user_note", systemText: null,
      userText: NOTE, verificationState: "user_authored", sourceRefs: [], systemVersion: null },
    { ...base, id: "invalidated", section: "overview", systemText: INVALID,
      verificationState: "invalidated", invalidatedAt: NOW, sourceRefs: [] },
    { ...base, id: "hidden", section: "overview", systemText: HIDDEN, hiddenAt: NOW }
  ];
  states.push(state);
  return state;
}

async function scenario(context: BrowserContext, page: Page, state: Fixture, baseURL: string) {
  await installFixture(context, page, state, baseURL);
  let latest: WorkWeeklyLatestGeneration | null = {
    runId: "previous_run", runVersion: state.review.currentRunVersion, executionStatus: "completed",
    sourceCheckStatus: "completed", qualityStatus: "not_assessed", reviewIssues: [], displayingPreviousVersion: false, errorCode: null
  };
  let regenerationCount = 0;
  let displayedGeneration: WorkWeeklyDisplayedGeneration | null = null;
  const origin = new URL(baseURL).origin;
  await page.route("**/api/work-reviews/weekly**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (url.origin !== origin) return route.fallback();
    if (request.method() === "GET" && (path === "/api/work-reviews/weekly" || path === `/api/work-reviews/weekly/${REVIEW_ID}`)) {
      state.apiRequests.push({ method: "GET", path });
      return route.fulfill({ json: { review: state.review, items: state.items, sourceSummary: state.sourceSummary,
        latestGeneration: latest, displayedGeneration } });
    }
    if (request.method() === "POST" && path === `/api/work-reviews/weekly/${REVIEW_ID}/regenerate`) {
      try {
        const input = request.postDataJSON() as { expectedVersion: number; operationKey: string };
        expect(input.expectedVersion).toBe(state.review.version);
        expect(input.operationKey).toBeTruthy();
        state.apiRequests.push({ method: "POST", path });
        state.mutations.push({ method: "POST", path, input });
        regenerationCount++;
        state.review.status = "queued";
        state.review.version++;
        state.review.currentRunVersion++;
        const runId = `quality_run_${state.review.currentRunVersion}`;
        latest = { runId, runVersion: state.review.currentRunVersion, executionStatus: "pending",
          sourceCheckStatus: "not_established", qualityStatus: "not_assessed", reviewIssues: [],
          displayingPreviousVersion: state.review.currentSystemVersion > 0, errorCode: null };
        const run: WorkWeeklyRun = { id: runId, accountId: ACCOUNT_ID, weeklyReviewId: REVIEW_ID,
          runVersion: state.review.currentRunVersion, sourceSnapshotDigest: DIGEST, state: "queued",
          leaseOwner: null, leaseExpiresAt: null, pipelineVersion: "work_weekly_v2",
          synthesizerProfile: null, verifierProfile: null, createdAt: NOW, completedAt: null, errorCode: null };
        return route.fulfill({ status: 202, json: { review: state.review, run, reused: false } });
      } catch (error) {
        state.fixtureErrors.push(error instanceof Error ? error.message : "invalid regeneration fixture request");
        return route.fulfill({ status: 500, json: { error: "fixture_request_failed" } });
      }
    }
    return route.fallback();
  });
  return {
    get regenerationCount() { return regenerationCount; },
    setLatest(value: WorkWeeklyLatestGeneration | null) { latest = value; },
    setDisplayed(value: WorkWeeklyDisplayedGeneration) { displayedGeneration = value; },
    finish(outcome: "failed" | "insufficient") {
      state.review.status = "failed";
      state.review.version++;
      latest = { runId: `quality_run_${state.review.currentRunVersion}`, runVersion: state.review.currentRunVersion,
        executionStatus: outcome === "insufficient" ? "completed" : "failed",
        sourceCheckStatus: outcome === "insufficient" ? "completed" : "not_established",
        qualityStatus: outcome === "insufficient" ? "insufficient" : "not_assessed", reviewIssues: [],
        displayingPreviousVersion: state.review.currentSystemVersion > 0,
        errorCode: outcome === "insufficient" ? "weekly_generation_quality_insufficient" : "weekly_generation_failed" };
    }
  };
}

async function visiblePreservedContent(page: Page) {
  await expect(page.getByText(OLD, { exact: true })).toBeVisible();
  await expect(page.getByText(PERSONAL_TEXT, { exact: true })).toBeVisible();
  await expect(page.getByText(NOTE, { exact: true })).toBeVisible();
  await expect(page.getByText(INVALID, { exact: true })).toHaveCount(0);
}

async function copiedText(page: Page) {
  await page.getByRole("button", { name: "复制全文", exact: true }).click();
  return page.evaluate(() => (window as unknown as { __uiCopied: string }).__uiCopied);
}

test.afterEach(async ({}, info) => {
  const current = states.splice(0);
  await writeFile(info.outputPath("transport-audit.json"), JSON.stringify(current.map((state) => ({
    apiRequests: state.apiRequests, fixtureMutations: state.mutations.map(({ method, path }) => ({ method, path })),
    unknownRequests: state.unknownRequests, externalRequests: state.externalRequests,
    consoleErrors: state.consoleErrors, pageErrors: state.pageErrors, fixtureErrors: state.fixtureErrors
  })), null, 2));
  for (const state of current) {
    expect(state.unknownRequests).toEqual([]);
    expect(state.externalRequests).toEqual([]);
    expect(state.consoleErrors).toEqual([]);
    expect(state.pageErrors).toEqual([]);
    expect(state.fixtureErrors).toEqual([]);
  }
});

test("1/4 queued, execution failure and quality refusal keep actual previous content and overlays", async ({ context, page, baseURL }, info) => {
  const state = data();
  const original = JSON.stringify(state.items);
  const fixture = await scenario(context, page, state, baseURL!);
  await page.goto("/work-review/weekly?weekStart=2026-09-07&scope=all");
  await visiblePreservedContent(page);
  await expect(page.getByText(/这份回顾尚未评估完整性/)).toBeVisible();
  expect(fixture.regenerationCount).toBe(0);
  for (const outcome of ["failed", "insufficient"] as const) {
    await page.getByRole("button", { name: "重新生成", exact: true }).click();
    await page.getByRole("button", { name: "确认重新生成", exact: true }).click();
    await expect(page.getByText("等待生成本周回顾", { exact: true })).toBeVisible();
    await visiblePreservedContent(page);
    await expect(page.getByRole("button", { name: "重新生成", exact: true })).toBeDisabled();
    fixture.finish(outcome);
    await expect(page.getByText(outcome === "failed" ? "本次生成未完成" : "本次回顾内容不完整", { exact: true })).toBeVisible();
    await expect(page.getByText(/之前的回顾已保留，仅显示当前可用内容/)).toBeVisible();
    await visiblePreservedContent(page);
    const copy = await copiedText(page);
    expect(copy).toContain(OLD);
    expect(copy).toContain(PERSONAL_TEXT);
    expect(copy).toContain(NOTE);
    expect(copy).not.toContain(INVALID);
    expect(copy).not.toContain(HIDDEN);
  }
  expect(fixture.regenerationCount).toBe(2);
  expect(JSON.stringify(state.items)).toBe(original);
  await page.getByRole("tab", { name: "问问本周", exact: true }).click();
  await expect(page.getByText("周回顾尚未处于可问答状态。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /发送|提问/ })).toBeDisabled();
  await page.getByRole("tab", { name: "本周回顾", exact: true }).click();
  await page.screenshot({ path: info.outputPath("previous-content-quality-refused.png"), fullPage: true });
});

test("2/4 fresh insufficient result shows the user's note without pretending a system review exists", async ({ context, page, baseURL }, info) => {
  const state = data();
  state.review.currentSystemVersion = 0;
  state.review.generatedAt = null;
  state.review.status = "failed";
  state.items = state.items.filter((item) => item.origin === "user_note");
  const fixture = await scenario(context, page, state, baseURL!);
  fixture.finish("insufficient");
  await page.goto("/work-review/weekly?weekStart=2026-09-07&scope=all");
  await expect(page.getByText("本次回顾内容不完整", { exact: true })).toBeVisible();
  await expect(page.getByText("当前没有可展示的系统回顾", { exact: true })).toBeVisible();
  await expect(page.getByText(NOTE, { exact: true })).toBeVisible();
  await expect(page.getByText(/之前的回顾已保留/)).toHaveCount(0);
  expect(await copiedText(page)).toContain(NOTE);
  await page.reload();
  await expect(page.getByText(NOTE, { exact: true })).toBeVisible();
  expect(fixture.regenerationCount).toBe(0);
  expect(state.mutations).toEqual([]);
  await page.screenshot({ path: info.outputPath("fresh-quality-refused-note.png"), fullPage: true });
});

test("3/4 mobile retained/stale state and verifier gating do not resurrect invalid content or leak error codes", async ({ context, page, baseURL }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = data();
  const fixture = await scenario(context, page, state, baseURL!);
  state.review.status = "stale";
  state.review.currentRunVersion = 3;
  fixture.setLatest({ runId: "quality_unknown", runVersion: 3, executionStatus: "unknown",
    sourceCheckStatus: "not_established", qualityStatus: "not_assessed", reviewIssues: [], displayingPreviousVersion: true,
    errorCode: "weekly_private_internal_error_marker" });
  await page.goto("/work-review/weekly?weekStart=2026-09-07&scope=all");
  await expect(page.getByText("本次生成结果尚未确认", { exact: true })).toBeVisible();
  await visiblePreservedContent(page);
  await expect(page.getByText("weekly_private_internal_error_marker", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  state.capabilities.weeklyVerifier = false;
  await page.reload();
  await expect(page.getByText(NOTE, { exact: true })).toBeVisible();
  for (const text of [OLD, PERSONAL_TEXT, INVALID, HIDDEN]) await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  const copy = await copiedText(page);
  expect(copy).toContain(NOTE);
  expect(copy).not.toContain(OLD);
  expect(copy).not.toContain(INVALID);
  expect(fixture.regenerationCount).toBe(0);
  expect(state.mutations).toEqual([]);
  await page.screenshot({ path: info.outputPath("mobile-verifier-unavailable-note.png"), fullPage: true });
});

test("4/4 displayed partial review keeps issues, source boundaries and all copy notices after a newer failure", async ({ context, page, baseURL }, info) => {
  const state = data();
  state.items[0]!.section = "decisions";
  state.items[1]!.section = "waiting_for_others";
  const original = JSON.stringify(state.items);
  const fixture = await scenario(context, page, state, baseURL!);
  fixture.setDisplayed({ runId: "displayed_partial", runVersion: state.review.currentRunVersion,
    systemVersion: state.review.currentSystemVersion, qualityStatus: "needs_review", reviewIssues: [
      { sourceRef: state.items[0]!.sourceRefs[0]!, reasonCode: "missing_key_content" },
      { sourceRef: null, reasonCode: "source_unavailable" }
    ] });
  fixture.setLatest({ runId: "displayed_partial", runVersion: state.review.currentRunVersion,
    executionStatus: "completed", sourceCheckStatus: "completed", qualityStatus: "needs_review",
    reviewIssues: [
      { sourceRef: state.items[0]!.sourceRefs[0]!, reasonCode: "missing_key_content" },
      { sourceRef: null, reasonCode: "source_unavailable" }
    ], displayingPreviousVersion: false, errorCode: null });
  await page.goto("/work-review/weekly?weekStart=2026-09-07&scope=all");
  await expect(page.getByRole("heading", { name: "已生成，部分内容待核对" })).toBeVisible();
  await visiblePreservedContent(page);
  await page.getByRole("button", { name: "查看待核对事项（2）" }).click();
  await expect(page.getByText("这条来源的重要内容尚未完整纳入回顾。", { exact: true })).toBeVisible();
  await expect(page.getByText("原来源已不可用，相关事项仍待核对。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看事项 1 的原始记录" })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看事项 2 的原始记录" })).toHaveCount(0);
  await page.getByRole("button", { name: "重新生成", exact: true }).click();
  await page.getByRole("button", { name: "确认重新生成", exact: true }).click();
  await expect(page.getByText("等待生成本周回顾", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "已生成，部分内容待核对" })).toBeVisible();
  fixture.finish("failed");
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(page.getByText("本次生成未完成", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "已生成，部分内容待核对" })).toBeVisible();
  await visiblePreservedContent(page);
  for (const name of ["复制全文", "只复制决定", "复制待办与等待他人"]) {
    await page.getByRole("button", { name, exact: true }).click();
    const copy = await page.evaluate(() => (window as unknown as { __uiCopied: string }).__uiCopied);
    expect(copy).toContain("已生成，部分内容待核对");
    expect(copy).toContain("以下是当前可用内容，仍有缺失或待核对事项。");
    if (name !== "复制待办与等待他人") expect(copy).toContain(OLD);
    if (name !== "只复制决定") expect(copy).toContain(PERSONAL_TEXT);
    expect(copy).not.toContain(INVALID);
    expect(copy).not.toContain(HIDDEN);
  }
  expect(fixture.regenerationCount).toBe(1);
  expect(JSON.stringify(state.items)).toBe(original);
  await page.screenshot({ path: info.outputPath("displayed-partial-after-failure.png"), fullPage: true });
});

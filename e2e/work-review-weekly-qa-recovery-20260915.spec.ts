import { expect, test as base, type Route } from "@playwright/test";
import type { WorkWeeklyQaRun } from "../src/lib/domain/work-weekly";
import { ACCOUNT_ID, createFixture, installFixture, NOW, REVIEW_ID, DIGEST, SOURCE_REF, ORIGINAL }
  from "./fixtures/work-review-ui-acceptance-20260909.fixture";

// Browser API transport evidence only. Virtual time is explicit: one real browser
// exercises timers/rendering; no backend, queue or model behavior is simulated as proof.
const ANSWER = "匿名验收回答：系统中的待办先标记完成，再重新打开；实际交付需要另行确认。";
function makeState() {
  return { core: createFixture(), gets: 0, posts: 0, clears: 0, ready: false,
    hold: null as Promise<void> | null, release: () => {}, entered: false, failed: false, alternateScope: false };
}
type State = ReturnType<typeof makeState>;
async function json(route: Route, value: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value),
    headers: { "cache-control": "no-store" } }).catch(() => {});
}
function result(state: State) {
  const core = state.core;
  if (!core.qaThread) return null;
  const messages = [...core.qaMessages];
  if (state.ready && messages.at(-1)?.role === "user") messages.push({
    id: "independent_answer", accountId: ACCOUNT_ID, weeklyReviewId: REVIEW_ID,
    threadId: core.qaThread.id, role: "assistant", text: state.failed ? "回答生成失败，请重试。" : ANSWER,
    answerStatus: state.failed ? "failed" : "answered", sourceRefs: state.failed ? [] : [SOURCE_REF],
    sourceSnapshotDigest: DIGEST, providerProfile: "offline-transport", promptVersion: "fixture",
    verifierProfile: "offline-transport", version: 2, createdAt: NOW, invalidatedAt: null
  });
  return { thread: { ...core.qaThread }, messages };
}
const test = base.extend<{ fixture: State }>({
  fixture: async ({ context, page, baseURL }, use) => {
    const state = makeState();
    await installFixture(context, page, state.core, baseURL!);
    await context.route("**/api/work-reviews/weekly**", async route => {
      const req = route.request(); const url = new URL(req.url());
      if (!url.pathname.endsWith("/qa")) {
        if (req.method() === "GET" && url.pathname === "/api/work-reviews/weekly" && state.alternateScope) {
          return json(route, { review: { ...state.core.review, id: "alternate_review", scope: {
            ...state.core.review.scope, scopeKind: "project", projectId: "ui_project_a" } },
            items: [], sourceSummary: state.core.sourceSummary });
        }
        return route.fallback();
      }
      if (url.pathname.includes("alternate_review")) return json(route, null);
      if (req.method() === "GET") {
        state.gets++;
        const value = result(state);
        if (state.hold) { state.entered = true; await state.hold; }
        return json(route, value);
      }
      if (req.method() === "DELETE") {
        state.clears++; state.core.qaThread = null; state.core.qaMessages = []; state.ready = false;
        return json(route, { cleared: true, reused: false });
      }
      if (req.method() !== "POST") throw new Error("unexpected_qa_fixture_method");
      state.posts++;
      const input = req.postDataJSON();
      expect(input.expectedVersion).toBeNull(); expect(input.operationKey).toEqual(expect.any(String));
      state.core.qaThread = { id: "independent_thread", accountId: ACCOUNT_ID, weeklyReviewId: REVIEW_ID,
        sourceSnapshotDigest: DIGEST, version: 1, createdAt: NOW, updatedAt: NOW, clearedAt: null };
      state.core.qaMessages = [{ id: "independent_question", accountId: ACCOUNT_ID, weeklyReviewId: REVIEW_ID,
        threadId: "independent_thread", role: "user", text: input.question, answerStatus: null, sourceRefs: [],
        sourceSnapshotDigest: DIGEST, providerProfile: null, promptVersion: null, verifierProfile: null,
        version: 1, createdAt: NOW, invalidatedAt: null }];
      const run: WorkWeeklyQaRun = { id: "independent_run", accountId: ACCOUNT_ID, weeklyReviewId: REVIEW_ID,
        threadId: "independent_thread", questionMessageId: "independent_question", runVersion: 1,
        sourceSnapshotDigest: DIGEST, state: "queued", leaseOwner: null, leaseExpiresAt: null,
        providerProfile: null, promptVersion: null, verifierProfile: null, createdAt: NOW, completedAt: null, errorCode: null };
      return json(route, { ...result(state), run, reused: false }, 202);
    });
    await page.clock.install({ time: new Date(NOW) });
    await page.clock.pauseAt(new Date(new Date(NOW).getTime() + 1_000));
    await page.goto("/work-review/weekly");
    await page.getByRole("tab", { name: "问问本周", exact: true }).click();
    await expect(page.getByLabel("继续问这一周")).toBeEnabled();
    await use(state);
    expect(state.core.externalRequests).toEqual([]); expect(state.core.unknownRequests).toEqual([]);
    expect(state.core.pageErrors).toEqual([]); expect(state.core.fixtureErrors).toEqual([]);
    expect(state.posts).toBeLessThanOrEqual(1);
  }
});
async function submit(page: import("@playwright/test").Page) {
  await page.getByLabel("继续问这一周").fill("本周匿名待办在系统中是什么状态？");
  await page.getByRole("button", { name: "发送问题", exact: true }).click();
  await expect(page.getByText("正在等待问答结果，每5秒查询一次，本轮最多90秒。", { exact: true })).toBeVisible();
}

test("40 seconds of pending reads automatically yields useful answer and live citation", async ({ page, fixture }) => {
  await submit(page); const before = fixture.gets;
  for (let tick = 1; tick <= 7; tick++) {
    await page.clock.runFor(5_000); await expect.poll(() => fixture.gets).toBe(before + tick);
    await expect(page.getByText(ANSWER, { exact: true })).toHaveCount(0);
  }
  fixture.ready = true;
  await page.clock.runFor(5_000);
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
  expect(fixture.gets).toBe(before + 8); expect(fixture.posts).toBe(1);
  await page.getByRole("button", { name: "来源 1", exact: true }).last().click();
  await expect(page.getByText(ORIGINAL, { exact: true })).toBeVisible();
  const done = fixture.gets; await page.clock.runFor(15_000); expect(fixture.gets).toBe(done);
});

test("90-second bound stops reads; update is immediate GET and starts another window", async ({ page, fixture }) => {
  await submit(page); const before = fixture.gets;
  for (let tick = 1; tick <= 17; tick++) {
    await page.clock.runFor(5_000); await expect.poll(() => fixture.gets).toBe(before + tick);
  }
  await page.clock.runFor(5_000);
  await expect(page.getByText(/本轮查询已满90秒/)).toBeVisible();
  const stopped = fixture.gets; await page.clock.runFor(20_000); expect(fixture.gets).toBe(stopped);
  await page.getByRole("button", { name: "更新结果", exact: true }).click();
  await expect.poll(() => fixture.gets).toBe(stopped + 1);
  fixture.ready = true; await page.clock.runFor(5_000);
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible(); expect(fixture.posts).toBe(1);
});

test("leaving QA pauses reads; returning fetches the already-completed answer", async ({ page, fixture }) => {
  await submit(page);
  await page.getByRole("tab", { name: "本周回顾", exact: true }).click();
  const paused = fixture.gets; await page.clock.runFor(45_000); expect(fixture.gets).toBe(paused);
  fixture.ready = true;
  await page.getByRole("tab", { name: "问问本周", exact: true }).click();
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
  expect(fixture.gets).toBe(paused + 1); expect(fixture.posts).toBe(1);
});

test("technical failure automatically appears as failed without a no-evidence message", async ({ page, fixture }) => {
  await submit(page); fixture.failed = true; fixture.ready = true;
  await page.clock.runFor(5_000);
  await expect(page.getByText("这轮回答没有完成。当前记录中没有可展示的回答正文。", { exact: true })).toBeVisible();
  await expect(page.getByText("在本周已确认的工作记录中，没有找到足够依据回答这个问题。", { exact: true })).toHaveCount(0);
  const count = fixture.gets; await page.clock.runFor(15_000); expect(fixture.gets).toBe(count);
  expect(fixture.posts).toBe(1);
});

test("clear prevents an in-flight old answer from reappearing", async ({ page, fixture }) => {
  await submit(page); fixture.ready = true;
  fixture.hold = new Promise<void>(resolve => { fixture.release = resolve; });
  await page.clock.runFor(5_000); await expect.poll(() => fixture.entered).toBe(true);
  await page.getByRole("button", { name: "清空记录", exact: true }).click();
  await page.getByRole("button", { name: "清空问答", exact: true }).click();
  await expect.poll(() => fixture.clears).toBe(1);
  fixture.hold = null; fixture.release();
  await expect(page.getByText("还没有问答记录", { exact: true })).toBeVisible();
  await page.clock.runFor(10_000); await expect(page.getByText(ANSWER, { exact: true })).toHaveCount(0);
  expect(fixture.posts).toBe(1);
});

test("a slow read cannot exceed the window or block manual update", async ({ page, fixture }) => {
  await submit(page);
  fixture.hold = new Promise<void>(resolve => { fixture.release = resolve; });
  await page.clock.runFor(5_000); await expect.poll(() => fixture.entered).toBe(true);
  const count = fixture.gets;
  await page.clock.runFor(85_000); expect(fixture.gets).toBe(count);
  await expect(page.getByText(/本轮查询已满90秒/)).toBeVisible();
  fixture.ready = true; fixture.hold = null;
  await page.getByRole("button", { name: "更新结果", exact: true }).click();
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
  fixture.release(); await page.clock.runFor(5_000);
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible(); expect(fixture.posts).toBe(1);
});

test("switching project excludes an in-flight answer from the old scope", async ({ page, fixture }) => {
  await submit(page); fixture.ready = true;
  fixture.hold = new Promise<void>(resolve => { fixture.release = resolve; });
  await page.clock.runFor(5_000); await expect.poll(() => fixture.entered).toBe(true);
  fixture.alternateScope = true;
  await page.getByLabel("项目范围").selectOption("project:ui_project_a");
  await expect(page.getByLabel("项目范围")).toHaveValue("project:ui_project_a");
  fixture.hold = null; fixture.release();
  await page.clock.runFor(10_000);
  await expect(page.getByText(ANSWER, { exact: true })).toHaveCount(0);
  expect(fixture.posts).toBe(1);
});

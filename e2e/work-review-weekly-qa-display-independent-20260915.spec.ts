import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import type { WorkWeeklyLiveSourceResponse } from "../src/lib/client/work-review-api";
import type { WorkWeeklyQaMessage, WorkWeeklyReview } from "../src/lib/domain/work-weekly";
import { ACCOUNT_ID, createFixture, DIGEST, installFixture, ORIGINAL, REVIEW_ID, SOURCE_REF }
  from "./fixtures/work-review-ui-acceptance-20260909.fixture";
import syntheticSample from "./fixtures/work-weekly-qa-display-synthetic-v3.fixture.json" with { type: "json" };

// Read only the explicitly extracted, anonymous v3 artifact. This test has no DB or Provider seam.
// Run through output/work-weekly-qa-display-independent-20260915/run-local.mjs.
const sample = syntheticSample as {
  text: string; question: string; sourceRefs: string[]; sources: WorkWeeklyLiveSourceResponse[];
  scope: WorkWeeklyReview["scope"]; createdAt: string;
};
const DISPLAY = sample.text.replace("状态为 open", "状态为未完成")
  .replace("被标记为 completed", "被标记为已完成")
  .replace("标记 completed 后被重新打开为 open", "标记完成后被重新打开为未完成");
const NORMAL = "本周只核对了匿名清单的系统记录，实际交付仍需另行确认。";
const assistant = (page: Page) => page.locator('li[data-role="assistant"]');

async function json(route: Route, value: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value),
    headers: { "cache-control": "no-store" } }).catch(() => {});
}

async function setup(context: BrowserContext, page: Page, baseURL: string, mode = "ready") {
  const core = createFixture();
  core.review.scope = structuredClone(sample.scope);
  const now = sample.createdAt;
  const sources = structuredClone(sample.sources);
  const text = mode === "ordinary" ? NORMAL : sample.text;
  const refs = mode === "ordinary" ? [SOURCE_REF] : [...sample.sourceRefs];
  core.qaThread = { id: "display_thread", accountId: ACCOUNT_ID, weeklyReviewId: REVIEW_ID,
    sourceSnapshotDigest: DIGEST, version: 2, createdAt: now, updatedAt: now, clearedAt: null };
  const message = (role: "user" | "assistant", body: string, id: string): WorkWeeklyQaMessage => ({
    id, accountId: ACCOUNT_ID, weeklyReviewId: REVIEW_ID, threadId: core.qaThread!.id, role, text: body,
    answerStatus: role === "user" ? null : "answered", sourceRefs: role === "user" ? [] : refs,
    sourceSnapshotDigest: DIGEST, providerProfile: role === "user" ? null : "saved-synthetic-fixture",
    promptVersion: role === "user" ? null : "v3-saved-fixture", verifierProfile: role === "user" ? null : "fixture",
    version: role === "user" ? 1 : 2, createdAt: now, invalidatedAt: null
  });
  core.qaMessages = [message("user", mode === "ordinary" ? sample.text : sample.question, "display_question"),
    message("assistant", text, "display_answer")];
  const original = JSON.stringify({ messages: core.qaMessages, sources });
  const state = { core, sources, gets: 0, sourceGets: [] as string[], mutations: [] as string[],
    mode, releases: [] as (() => Promise<void>)[], alternateScope: false };
  await installFixture(context, page, core, baseURL);
  await context.route("**/api/work-reviews/weekly**", async route => {
    const req = route.request(), url = new URL(req.url());
    if (req.method() !== "GET") { state.mutations.push(req.method()); return json(route, { error: "fixture_read_only" }, 405); }
    if (url.pathname.endsWith("/qa")) {
      state.gets++;
      return json(route, state.alternateScope ? null : { thread: core.qaThread, messages: core.qaMessages });
    }
    if (url.pathname === "/api/work-reviews/weekly" && state.alternateScope) {
      return json(route, { review: { ...core.review, id: "display_alternate", scope: {
        ...core.review.scope, scopeKind: "project", projectId: "ui_project_a" } }, items: [], sourceSummary: core.sourceSummary });
    }
    const ref = url.pathname.split("/sources/")[1];
    if (!ref) return route.fallback();
    const decoded = decodeURIComponent(ref); state.sourceGets.push(decoded);
    const response = sources.find(source => source.identity.sourceRef === decoded);
    if (!response) return route.fallback(); // Ordinary answer uses the existing canonical Evidence fixture.
    if (state.mode === "pending") { state.releases.push(() => json(route, response)); return; }
    if (state.mode === "failure") return json(route, { error: "source_unavailable" }, 410);
    if (state.mode === "excluded") return json(route, { ...response, identity: { ...response.identity, included: false } });
    if (state.mode === "mismatch") return json(route, { ...response, identity: { ...response.identity, sourceRef: "wrs_wrong" } });
    return json(route, response);
  });
  await page.clock.install({ time: new Date(now) });
  await page.clock.pauseAt(new Date(new Date(now).getTime() + 1_000));
  await page.goto("/work-review/weekly");
  await page.getByRole("tab", { name: "问问本周", exact: true }).click();
  await expect(assistant(page)).toBeVisible();
  await expect(page.getByText(`${sample.scope.weekStart} 至 ${sample.scope.weekEnd}`, { exact: true })).toBeVisible();
  return { ...state, state, check: () => {
    expect(core.externalRequests).toEqual([]); expect(core.unknownRequests).toEqual([]);
    expect(core.pageErrors).toEqual([]); expect(core.fixtureErrors).toEqual([]);
    expect(state.mutations).toEqual([]); expect(core.mutations).toEqual([]);
    expect(JSON.stringify({ messages: core.qaMessages, sources })).toBe(original);
  } };
}

test("saved v3 answer renders four Chinese states, deduplicates reads and opens all original citations", async ({ context, page, baseURL }, info) => {
  expect(sample.text.match(/\b(?:open|completed)\b/gu)).toHaveLength(4);
  expect(sample.sourceRefs).toHaveLength(3);
  const fixture = await setup(context, page, baseURL!, "pending");
  await expect(assistant(page).locator("p").first()).toHaveText(sample.text);
  await expect.poll(() => fixture.state.sourceGets.length).toBe(3);
  fixture.state.mode = "ready";
  await Promise.all(fixture.state.releases.map(release => release()));
  await expect(assistant(page).locator("p").first()).toHaveText(DISPLAY);
  expect(DISPLAY).not.toMatch(/\b(?:open|completed)\b/u);
  await page.screenshot({ path: info.outputPath("saved-v3-chinese-answer.png"), fullPage: true });
  await page.getByRole("button", { name: "更新结果", exact: true }).click();
  await expect.poll(() => fixture.state.gets).toBe(2);
  expect(fixture.state.sourceGets).toEqual(sample.sourceRefs);
  for (let index = 0; index < 3; index++) {
    await assistant(page).getByRole("button", { name: `来源 ${index + 1}`, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("link", { name: "打开待办", exact: true })).toHaveAttribute("href", "/work-review/todos");
    expect(fixture.state.sourceGets.at(-1)).toBe(sample.sourceRefs[index]);
    const source = sample.sources[index].source;
    if ("current" in source) {
      await expect(dialog.getByText(source.current.title, { exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath("saved-v3-todo-source.png"), fullPage: true });
    } else if ("eventType" in source) await expect(dialog.getByText(source.eventType, { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "返回周回顾", exact: true }).click();
  }
  expect(fixture.state.sourceGets).toEqual([...sample.sourceRefs, ...sample.sourceRefs]);
  fixture.check();
});

test("ordinary answer and status-looking user question add no metadata reads and preserve Evidence", async ({ context, page, baseURL }) => {
  const fixture = await setup(context, page, baseURL!, "ordinary");
  await expect(assistant(page).locator("p").first()).toHaveText(NORMAL);
  await expect(page.locator('li[data-role="user"] p')).toHaveText(sample.text);
  await page.clock.runFor(15_000);
  await page.getByRole("button", { name: "更新结果", exact: true }).click();
  await expect.poll(() => fixture.state.gets).toBe(2);
  expect(fixture.state.sourceGets).toEqual([]);
  await assistant(page).getByRole("button", { name: "来源 1", exact: true }).click();
  await expect(page.getByRole("dialog").getByText(ORIGINAL, { exact: true })).toBeVisible();
  expect(fixture.state.sourceGets).toEqual([SOURCE_REF]); fixture.check();
});

for (const mode of ["failure", "excluded", "mismatch"]) {
  test(`metadata ${mode} retains original answer without retry or POST`, async ({ context, page, baseURL }) => {
    const fixture = await setup(context, page, baseURL!, mode);
    await expect.poll(() => fixture.state.sourceGets.length).toBe(3);
    await expect(assistant(page).locator("p").first()).toHaveText(sample.text);
    await page.clock.runFor(30_000);
    await page.getByRole("button", { name: "更新结果", exact: true }).click();
    await expect.poll(() => fixture.state.gets).toBe(2);
    expect(fixture.state.sourceGets).toHaveLength(3);
    await expect(assistant(page).getByRole("button", { name: "来源 1", exact: true })).toBeEnabled();
    await expect(assistant(page).locator("p").first()).toHaveText(sample.text); fixture.check();
  });
}

test("ten-second metadata deadline ignores late results while update and fresh source dialog work", async ({ context, page, baseURL }) => {
  const fixture = await setup(context, page, baseURL!, "pending");
  await expect.poll(() => fixture.state.sourceGets.length).toBe(3);
  await page.clock.runFor(10_000);
  await expect(assistant(page).locator("p").first()).toHaveText(sample.text);
  fixture.state.mode = "ready";
  await Promise.all(fixture.state.releases.map(release => release()));
  await page.getByRole("button", { name: "更新结果", exact: true }).click();
  await expect.poll(() => fixture.state.gets).toBe(2);
  await page.clock.runFor(90_000);
  await expect(assistant(page).locator("p").first()).toHaveText(sample.text);
  expect(fixture.state.sourceGets).toHaveLength(3);
  await assistant(page).getByRole("button", { name: "来源 1", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("link", { name: "打开待办", exact: true })).toBeVisible();
  expect(fixture.state.sourceGets).toHaveLength(4); fixture.check();
});

test("scope switch discards pending metadata and the previous answer", async ({ context, page, baseURL }) => {
  const fixture = await setup(context, page, baseURL!, "pending");
  await expect.poll(() => fixture.state.sourceGets.length).toBe(3);
  fixture.state.alternateScope = true;
  await page.getByLabel("项目范围").selectOption("project:ui_project_a");
  await expect(page.getByText("还没有问答记录", { exact: true })).toBeVisible();
  await Promise.all(fixture.state.releases.map(release => release()));
  await page.clock.runFor(15_000);
  await expect(assistant(page)).toHaveCount(0); fixture.check();
});

import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openDailyReflectionDatabase } from "../src/lib/server/daily-reflection/db";
import { DailyReflectionRepository } from "../src/lib/server/daily-reflection/repository";
import type { ThinkingMatterView } from "../src/lib/domain/reflection-thinking-matter";

test.describe.configure({ mode: "serial", timeout: 120_000 });
const baseURL = process.env.THINKING_P1_E2E_BASE_URL!;
const artifacts = process.env.THINKING_P1_E2E_ARTIFACT_DIR!;
const data = process.env.APP_DATA_DIR!;
const results: Array<{ scenario: string; result: string }> = [];
const cardId = "p2_synthetic_card", reflectionId = "p2_synthetic_reflection";
let api: APIRequestContext, firstUrl: string, secondUrl: string;

// Synthetic source preparation uses the existing fenced business repository.
// No SQL injects cards, decisions, arrangements or model results.
function prepareSource(accountId: string) {
  if (process.env.THINKING_P2_E2E !== "1" || resolve(data) !== join(resolve(artifacts), "data")) throw new Error("P2 isolated data required");
  const database = openDailyReflectionDatabase({ filePath: join(data, "daily-reflection.sqlite") });
  try {
    const repository = new DailyReflectionRepository(database);
    const created = repository.createReflectionV2({ id: reflectionId, accountId, uploadId: null,
      operationKey: "p2-source-create", inputAdapter: "file_picker", sourceOrigin: "user_reflection",
      capturePurpose: "inspiration_capture", recordingDate: "2026-11-03", contentHash: "e".repeat(64) });
    repository.transitionStatus({ accountId, reflectionId, expectedVersion: created.reflection.version, status: "uploading" });
    const fence = repository.claimExecutionLease({ accountId, reflectionId, leaseOwner: "p2-synthetic-source", leaseDurationMs: 60_000, allowedStatuses: ["uploading"] });
    if (!fence) throw new Error("Synthetic source lease unavailable");
    const uploadId = created.receipt!.uploadId;
    const bound = repository.bindUploadAndPlanV2({ accountId, reflectionId, expectedVersion: repository.getReflection(accountId, reflectionId).version, uploadId,
      inputAdapter: "file_picker", processingProfile: "full_recording", effectiveDurationMs: 300_000,
      durationSource: "server_ffprobe", candidateLimit: 5, leaseOwner: fence.leaseOwner, attemptVersion: fence.attemptVersion });
    let reflection = repository.transitionStatus({ accountId, reflectionId, expectedVersion: bound.reflection.version, status: "transcribing", leaseOwner: fence.leaseOwner, attemptVersion: fence.attemptVersion });
    reflection = repository.transitionStatus({ accountId, reflectionId, expectedVersion: reflection.version, status: "extracting", leaseOwner: fence.leaseOwner, attemptVersion: fence.attemptVersion });
    repository.publishAssetUnderExecutionFence({ accountId, reflectionId, leaseOwner: fence.leaseOwner, attemptVersion: fence.attemptVersion,
      assetKind: "segments", payload: [{ id: "p2_segment", uploadId, startSeconds: 0, endSeconds: 8,
        text: "合成记录：我在快速发布概览与完整讲述作品过程之间犹豫，只想讨论这两个方向。", confidence: 1, sceneLabels: [], valueLabels: [] }] });
    const saved = repository.saveCardPipelineV2({ accountId, reflectionId, expectedVersion: reflection.version, leaseOwner: fence.leaseOwner, attemptVersion: fence.attemptVersion,
      candidates: [{ id: "p2_candidate", ordinal: 0, candidateKind: "open_question", proposedText: "合成的作品方向取舍", evidenceIds: ["p2_segment"], confidence: 1, caution: "synthetic fixture", actionClaimed: false }],
      cards: [{ id: cardId, cardKind: "open_question", proposedTitle: "合成卡片：作品方向取舍", proposedText: "快速发布概览，还是完整讲述作品过程？",
        sourceCandidateIds: ["p2_candidate"], evidenceIds: ["p2_segment"], clusterId: "p2_cluster", clusterTitle: "作品方向", displayTier: "primary", rank: 0,
        confidence: 1, importance: 0.7, durability: 0.5, novelty: 0.5, epistemicStatus: "explicit_user_statement", riskFlags: [], actionClaimed: false, reviewStatus: "pending" }],
      // Existing pipeline audit counts one synthetic extraction invocation; it is
      // explicitly labelled and is not a real Provider request or real usage.
      audit: { modelName: "synthetic_no_provider", promptVersion: "p2-source-fixture", policy: {}, windowCount: 1, providerCallCount: 1, hiddenCandidateCount: 1, clusterCount: 1, cardCount: 1, inputTokenEstimate: 0, outputTokenBudget: 100 } });
    repository.transitionStatus({ accountId, reflectionId, expectedVersion: saved.reflection.version, status: "review_pending", leaseOwner: fence.leaseOwner, attemptVersion: fence.attemptVersion });
    repository.releaseExecutionLease({ accountId, reflectionId, leaseOwner: fence.leaseOwner, attemptVersion: fence.attemptVersion });
  } finally { database.close(); }
}

test.beforeAll(async () => {
  api = await request.newContext({ baseURL });
  const email = `thinking-p2-${Date.now()}@example.test`, password = "ThinkingFixture!2026";
  const registered = await api.post("/api/auth/register", { data: { email, password, name: "P2离线合成验收", inviteCode: "thinking-p1-fixture" } });
  expect(registered.status()).toBe(201);
  prepareSource((await registered.json()).user.id);
  expect((await api.post("/api/auth/login", { data: { email, password } })).status()).toBe(200);
});
test.beforeEach(async ({ context, page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await context.addCookies((await api.storageState()).cookies);
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !["127.0.0.1", "localhost"].includes(url.hostname)) {
      await route.abort("blockedbyclient"); throw new Error("External browser network is forbidden");
    }
    await route.continue();
  });
});
test.afterAll(async () => { await writeFile(join(artifacts, "scenarios.json"), JSON.stringify(results, null, 2)); await api?.dispose(); });
async function readMatter(page: Page) {
  const id = new URL(page.url()).searchParams.get("matter")!;
  const result = await page.evaluate(async path => { const r = await fetch(path, { cache: "no-store" }); return { status: r.status, body: await r.json() }; }, `/api/daily-reflections/thinking/matters/${id}`);
  expect(result.status).toBe(200); return result.body as ThinkingMatterView;
}
async function send(page: Page, text: string) {
  await page.getByLabel("继续一起想", { exact: true }).fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
}
async function progress(page: Page, open: boolean) {
  const dialog = page.getByRole("dialog", { name: "进展与资料", exact: true });
  if (open && !await dialog.isVisible()) await page.getByRole("button", { name: "进展与资料", exact: true }).click();
  if (!open && await dialog.isVisible()) await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog)[open ? "toBeVisible" : "toBeHidden"]();
}
async function more(page: Page) {
  const summary = page.getByText("更多", { exact: true });
  if (!await summary.evaluate(element => (element.parentElement as HTMLDetailsElement).open)) await summary.click();
}
async function measureChat(page: Page, filename: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 2)).toBe(true);
  const dimensions = await page.getByRole("log", { name: "这件事的对话" }).evaluate(element => {
    const log = element as HTMLElement;
    const composer = document.querySelector<HTMLTextAreaElement>("#thinking-matter-draft")!;
    const submit = composer.form!.querySelector<HTMLButtonElement>("button[type=submit]")!;
    const mobileNav = document.querySelector<HTMLElement>("nav[aria-label='日常复盘移动导航']");
    const bottom = mobileNav && getComputedStyle(mobileNav).display !== "none" ? mobileNav.getBoundingClientRect().top : window.innerHeight;
    return { width: innerWidth, height: innerHeight, documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth, logHeight: log.clientHeight, contentHeight: log.scrollHeight,
      inputTop: composer.getBoundingClientRect().top, inputBottom: composer.getBoundingClientRect().bottom,
      submitBottom: submit.getBoundingClientRect().bottom, availableBottom: bottom };
  });
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.width);
  expect(dimensions.documentHeight).toBeLessThanOrEqual(dimensions.height + 2);
  expect(dimensions.inputTop).toBeGreaterThan(0);
  expect(dimensions.inputBottom).toBeLessThanOrEqual(dimensions.availableBottom);
  expect(dimensions.submitBottom).toBeLessThanOrEqual(dimensions.availableBottom);
  expect(dimensions.logHeight).toBeGreaterThan(dimensions.height >= 800 ? 180 : 70);
  await writeFile(join(artifacts, `${filename}.json`), JSON.stringify(dimensions, null, 2));
  await page.screenshot({ path: join(artifacts, `${filename}.png`), fullPage: true });
}
function mark(scenario: string) { results.push({ scenario, result: "PASS_OFFLINE_BROWSER" }); console.log(`[thinking-p2] ${results.length}/4 ${scenario} passed`); }

test("1 compare, choose A, change to B, keep earlier arrangement and reasons", async ({ page }) => {
  await page.goto(`${baseURL}/reflection/think`);
  await page.getByLabel("一起想的方式", { exact: true }).selectOption("compare_directions");
  await page.getByLabel("你正在想什么", { exact: true }).fill("比较作品展示的方案A和方案B，也给一个可选的小尝试。");
  await page.getByRole("button", { name: "开始一起想", exact: true }).click();
  await expect(page.getByRole("log", { name: "这件事的对话" })).toContainText("方案A更快获得反馈");
  await progress(page, true);
  await expect(page.getByRole("region", { name: "方案比较", exact: true })).toContainText("表达深度");
  const proposal = await readMatter(page);
  expect(proposal.matter.arrangements).toHaveLength(0);
  expect(proposal.matter.userChoice.status).toBe("undecided");
  const optionA = proposal.matter.comparison!.options.find(option => option.name === "方案A")!;
  const optionB = proposal.matter.comparison!.options.find(option => option.name === "方案B")!;
  await progress(page, false);
  await page.getByRole("button", { name: "采纳这一步", exact: true }).click();
  await progress(page, true);
  await page.getByLabel("取舍原因（可不填）", { exact: true }).fill("先快速得到反馈");
  await page.getByRole("button", { name: "选择：方案A", exact: true }).click();
  await expect.poll(async () => (await readMatter(page)).matter.userChoice.optionId).toBe(optionA.id);
  await progress(page, false);
  await send(page, "新约束：展示要求说明作品过程。我决定改选方案B，因为需要让观众看见判断过程。");
  await expect(page.getByRole("log", { name: "这件事的对话" })).toContainText("新的展示约束");
  await page.reload();
  const changed = await readMatter(page);
  expect(changed.matter.userChoice).toMatchObject({ status: "selected", optionId: optionB.id });
  expect(changed.matter.userChoice.reason).toContain("判断过程");
  expect(changed.matter.comparison!.options.map(option => option.id)).toEqual(proposal.matter.comparison!.options.map(option => option.id));
  expect(changed.events.filter(event => event.kind === "choice_changed")).toHaveLength(2);
  expect(changed.events.some(event => event.kind === "choice_changed" && JSON.stringify(event).includes(optionA.id))).toBe(true);
  expect(changed.matter.arrangements).toHaveLength(1);
  expect(changed.matter.arrangements[0].status).toBe("adopted");
  expect(changed.matter.suggestions.some(s => s.status === "proposed" && s.text.includes("方案B"))).toBe(true);
  // Long history is saved through the same formal business API, without model calls.
  for (let index = 0; index < 12; index++) {
    const current = await readMatter(page);
    const status = await page.evaluate(async ({ id, version, index }) => {
      const response = await fetch(`/api/daily-reflections/thinking/matters/${id}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mutate", kind: "feedback", expectedVersion: version, operationKey: `layout-feedback-${crypto.randomUUID()}`,
          text: `合成阶段记录${index}：${"我在讨论展示内容和准备时间，今天没有执行新的安排。".repeat(5)}` }) });
      return response.status;
    }, { id: current.matter.id, version: current.matter.version, index });
    expect(status).toBe(200);
  }
  await page.reload();
  const log = page.getByRole("log", { name: "这件事的对话", exact: true });
  await expect(log).toContainText("合成阶段记录11");
  await measureChat(page, "layout-desktop");
  expect(await log.evaluate(element => element.scrollHeight > element.clientHeight + 100)).toBe(true);
  // A real fixture reply is held at transport completion while the reader scrolls up.
  let responseReady!: () => void, releaseResponse!: () => void;
  const responsePrepared = new Promise<void>(resolveReady => { responseReady = resolveReady; });
  const responseReleased = new Promise<void>(resolveRelease => { releaseResponse = resolveRelease; });
  await page.route(`**/api/daily-reflections/thinking/matters/${changed.matter.id}`, async route => {
    if (route.request().method() !== "POST" || route.request().postDataJSON()?.action !== "turn") return route.fallback();
    const response = await route.fetch();
    responseReady(); await responseReleased; await route.fulfill({ response });
  });
  await send(page, "比较方案A和方案B，今天只比较，不安排计划。");
  await responsePrepared;
  await log.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  releaseResponse();
  await expect(page.getByRole("button", { name: "有新回复，回到最新", exact: true })).toBeVisible();
  expect(await log.evaluate(element => element.scrollTop)).toBeLessThan(10);
  await page.getByRole("button", { name: "有新回复，回到最新", exact: true }).click();
  await expect.poll(() => log.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(96);
  await page.unroute(`**/api/daily-reflections/thinking/matters/${changed.matter.id}`);
  await page.getByLabel("继续一起想", { exact: true }).fill("还没有发送的草稿");
  await progress(page, true); await progress(page, false);
  await expect(page.getByLabel("继续一起想", { exact: true })).toHaveValue("还没有发送的草稿");
  await page.getByLabel("继续一起想", { exact: true }).fill("");
  await page.setViewportSize({ width: 390, height: 844 });
  await measureChat(page, "layout-mobile");
  await progress(page, true);
  await expect(page.getByRole("dialog", { name: "进展与资料" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "进展与资料" })).toBeHidden();
  await page.setViewportSize({ width: 390, height: 560 });
  await measureChat(page, "layout-mobile-short");
  await page.setViewportSize({ width: 1280, height: 900 });
  firstUrl = page.url();
  await writeFile(join(artifacts, "1-choice-change.json"), JSON.stringify(changed, null, 2));
  await page.screenshot({ path: join(artifacts, "1-choice-change.png"), fullPage: true });
  mark("comparison and choice evolution");
});

test("2 separate matters, explicit selection, archive and reopen", async ({ page }) => {
  await page.goto(`${baseURL}/reflection/think`);
  await page.getByRole("button", { name: "新建一件事", exact: true }).click();
  await page.getByLabel("你正在想什么", { exact: true }).fill("第二件事：周末如何休息，今天只讨论。");
  await page.getByRole("button", { name: "开始一起想", exact: true }).click();
  await expect(page.getByRole("log", { name: "这件事的对话" })).toContainText("这件事独立保留");
  secondUrl = page.url(); const second = await readMatter(page);
  expect(second.matter.comparison).toBeNull();
  await page.goto(`${baseURL}/reflection/think`);
  await expect(page.getByText("选择要继续的事，或新建一件事", { exact: true })).toBeVisible();
  await progress(page, true);
  await page.getByRole("region", { name: "最近在想的事", exact: true }).getByRole("button", { name: /比较作品展示/ }).click();
  await expect(page.getByRole("dialog", { name: "进展与资料", exact: true })).toBeHidden();
  await progress(page, true);
  await expect(page.getByRole("region", { name: "方案比较", exact: true })).toBeVisible();
  expect((await readMatter(page)).matter.userChoice.status).toBe("selected");
  await page.goto(secondUrl);
  await more(page);
  await page.getByRole("button", { name: "归档这件事", exact: true }).click();
  await expect(page.getByRole("button", { name: "重新打开这件事", exact: true })).toBeVisible();
  await page.reload();
  await more(page);
  await page.getByRole("button", { name: "重新打开这件事", exact: true }).click();
  await expect(page.getByLabel("继续一起想", { exact: true })).toBeVisible();
  const reopened = await readMatter(page);
  expect(reopened.matter.status).toBe("active");
  expect(reopened.events.some(event => event.kind === "status_changed" && event.data.status === "archived")).toBe(true);
  expect(reopened.events.filter(e => e.kind === "assistant_message").map(e => e.text)).toEqual(second.events.filter(e => e.kind === "assistant_message").map(e => e.text));
  await page.goto(firstUrl); const first = await readMatter(page);
  expect(first.matter.question).toContain("比较作品展示");
  expect(JSON.stringify(first.events)).not.toContain("周末如何休息");
  await page.screenshot({ path: join(artifacts, "2-matters.png"), fullPage: true });
  mark("multiple matters and archive recovery");
});

test("3 enter from a real saved card, compare only, no action or memory", async ({ page }) => {
  await page.goto(`${baseURL}/reflection/cards`);
  const saved = await page.evaluate(async path => { const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: 0 }) }); return { status: r.status, body: await r.json() }; }, `/api/daily-reflections/${reflectionId}/cards/${cardId}/save`);
  expect(saved.status).toBe(200);
  await page.reload();
  await page.getByRole("button", { name: "打开卡片：合成卡片：作品方向取舍", exact: true }).click();
  await page.getByRole("link", { name: "拿这张卡片一起想", exact: true }).click();
  await expect(page.getByLabel("允许这件事使用这张卡片", { exact: true })).not.toBeChecked();
  await page.getByLabel("允许这件事使用这张卡片", { exact: true }).check();
  await page.getByRole("button", { name: "在新事项中一起想", exact: true }).click();
  await page.getByLabel("你正在想什么", { exact: true }).fill("比较这张卡片的方案A和方案B，今天只比较，不要安排计划。");
  await page.getByRole("button", { name: "开始一起想", exact: true }).click();
  await progress(page, true);
  await expect(page.getByRole("region", { name: "方案比较", exact: true })).toBeVisible();
  await page.reload(); const view = await readMatter(page);
  expect(view.matter.contextMode).toBe("none");
  expect(view.matter.linkedSources).toHaveLength(1);
  expect(view.matter.linkedSources[0].sourceId).toContain(cardId);
  const observations = (await readFile(join(artifacts, "p2-observations.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const observed = [...observations].reverse().find(entry => entry.matterId === view.matter.id);
  expect(observed.linkedRecords).toEqual([{ ref: { sourceId: cardId, kind: "card", version: view.matter.linkedSources[0].version },
    textSha256: createHash("sha256").update(`${saved.body.card.title}\n${saved.body.card.content}`.slice(0, 2_000)).digest("hex") }]);
  expect(view.events.find(event => event.kind === "assistant_message")?.sources).toContainEqual({ sourceId: cardId, kind: "card", version: view.matter.linkedSources[0].version });
  expect(view.matter.comparison!.options).toHaveLength(2);
  expect(view.matter.userChoice.status).toBe("undecided");
  expect(view.matter.suggestions).toHaveLength(0);
  expect(view.matter.arrangements).toHaveLength(0);
  const database = new Database(join(data, "daily-reflection.sqlite"), { readonly: true, fileMustExist: true });
  try {
    for (const table of ["dr_memory_proposals", "dr_admission_operations"])
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toMatchObject({ count: 0 });
  }
  finally { database.close(); }
  for (const name of ["memory.sqlite", "work-review.sqlite"]) {
    if (!existsSync(join(data, name))) continue;
    const protectedDatabase = new Database(join(data, name), { readonly: true, fileMustExist: true });
    try {
      const tables = protectedDatabase.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      for (const { name: table } of tables.filter(row => /^(?:memory_items|memory_evidence|person_entities|person_evidence|.*todos?)$/u.test(row.name)))
        expect(protectedDatabase.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get()).toMatchObject({ count: 0 });
    } finally { protectedDatabase.close(); }
  }
  await writeFile(join(artifacts, "3-card-discussion.json"), JSON.stringify(view, null, 2));
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: join(artifacts, "3-card-discussion.png"), fullPage: true });
  mark("authorized card and discussion without plans");
});

test("4 weekend comparison keeps its heading and choice after a wrong model title and a new lunch constraint", async ({ page }) => {
  const subject = "周末去图书馆读书，还是在家做饭？";
  const constraint = "周六下午有家庭聚会，需要提前准备午饭。请重新比较 A、B，今天只讨论。";
  await page.goto(`${baseURL}/reflection/think`);
  await page.getByRole("button", { name: "新建一件事", exact: true }).click();
  await page.getByLabel("一起想的方式", { exact: true }).selectOption("compare_directions");
  await page.getByLabel("你正在想什么", { exact: true }).fill(subject + "请比较 A 和 B。");
  await page.getByRole("button", { name: "开始一起想", exact: true }).click();
  const log = page.getByRole("log", { name: "这件事的对话" });
  await expect(log).toContainText("图书馆适合安静阅读");
  await progress(page, true);
  const comparison = page.getByRole("region", { name: "方案比较", exact: true });
  await expect(comparison.getByRole("heading", { name: subject, exact: true })).toBeVisible();
  const first = await readMatter(page);
  const [a, b] = first.matter.comparison!.options;
  await comparison.getByRole("textbox", { name: "取舍原因（可不填）" }).fill("我想先去图书馆读书");
  await comparison.getByRole("button", { name: "选择：去图书馆读书", exact: true }).click();
  await expect(comparison).toContainText("已选择去图书馆读书");
  const chosen = (await readMatter(page)).matter.userChoice;
  expect(chosen).toMatchObject({ status: "selected", optionId: a.id, reason: "我想先去图书馆读书" });
  await progress(page, false);
  await send(page, constraint);
  await expect(log).toContainText("根据这个条件更推荐在家做饭");
  await page.reload();
  await progress(page, true);
  await expect(comparison.getByRole("heading", { name: subject, exact: true })).toBeVisible();
  await expect(comparison).toContainText("助手的建议：在家做饭");
  await expect(comparison).toContainText("在家可以提前准备家庭聚会的午饭");
  await expect(comparison).toContainText("已选择去图书馆读书");
  const final = await readMatter(page);
  expect(final.matter.comparison!.options.map(option => option.id)).toEqual([a.id, b.id]);
  expect(final.matter.comparison!.recommendation?.optionId).toBe(b.id);
  expect(final.matter.userChoice).toEqual(chosen);
  expect(final.matter.arrangements).toHaveLength(0);
  expect(final.events.filter(event => event.kind === "choice_changed")).toHaveLength(1);
  expect(final.events.filter(event => event.text === constraint)).toHaveLength(1);
  const database = new Database(join(data, "daily-reflection.sqlite"), { readonly: true, fileMustExist: true });
  try {
    const actions = database.prepare("SELECT json_extract(args_json,'$.comparison.question') AS heading FROM agent_actions a JOIN agent_tasks t ON a.task_id=t.id WHERE t.account_id=? AND t.resource_id=? AND a.tool='respond' ORDER BY a.rowid")
      .all(final.matter.accountId, final.matter.id);
    expect(actions).toEqual([{ heading: null }, { heading: "周日下午的上午安排" }]);
    const row = database.prepare("SELECT state_json FROM dr_thinking_matters WHERE id=? AND account_id=?").get(final.matter.id, final.matter.accountId) as { state_json: string };
    expect(JSON.parse(row.state_json)).toEqual(final.matter);
    await writeFile(join(artifacts, "weekend-comparison.json"), JSON.stringify({ syntheticActionHeadings: actions,
      subject: final.matter.comparison!.question, constraint, recommendation: final.matter.comparison!.recommendation, chosen, options: final.matter.comparison!.options }, null, 2));
  } finally { database.close(); }
  await comparison.getByRole("heading", { name: subject, exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts, "weekend-comparison.png") });
  await progress(page, false);
  await send(page, "把比较题目改为「聚会前怎么准备午饭？」");
  await expect(log).toContainText("比较题目已改为「聚会前怎么准备午饭？」");
  await page.reload();
  await progress(page, true);
  await expect(comparison.getByRole("heading", { name: "聚会前怎么准备午饭？", exact: true })).toBeVisible();
  const retitled = await readMatter(page);
  expect(retitled.matter.comparison).toEqual({ ...final.matter.comparison, question: "聚会前怎么准备午饭？" });
  expect(retitled.matter.userChoice).toEqual(chosen);
  expect(retitled.events.filter(event => event.kind === "assistant_message")).toHaveLength(2);
  await page.getByRole("button", { name: "纠正当前理解", exact: true }).click();
  await page.getByLabel("同时更正比较题目（可不填）").fill("周六午饭要预留多少时间？");
  await page.getByRole("button", { name: "保存更正", exact: true }).click();
  await expect(comparison.getByRole("heading", { name: "周六午饭要预留多少时间？", exact: true })).toBeVisible();
  await page.reload();
  const corrected = await readMatter(page);
  expect(corrected.matter.comparison).toEqual({ ...final.matter.comparison, question: "周六午饭要预留多少时间？" });
  expect(corrected.matter.userChoice).toEqual(chosen);
  expect(corrected.matter.understandingSourceEventId).toBe(final.matter.understandingSourceEventId);
  expect(corrected.events.filter(event => event.kind === "corrected")).toHaveLength(0);
  const check = new Database(join(data, "daily-reflection.sqlite"), { readonly: true, fileMustExist: true });
  try {
    expect(check.prepare("SELECT c.status FROM agent_calls c JOIN agent_tasks t ON c.task_id=t.id WHERE t.account_id=? AND t.resource_id=?").all(final.matter.accountId, final.matter.id))
      .toEqual([{ status: "succeeded" }, { status: "succeeded" }]);
  } finally { check.close(); }
  mark("weekend constraint, stable heading and user choice after refresh");
});

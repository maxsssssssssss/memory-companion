import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openDailyReflectionDatabase } from "../src/lib/server/daily-reflection/db";
import { DailyReflectionRepository } from "../src/lib/server/daily-reflection/repository";
import type { ThinkingMatterView } from "../src/lib/domain/reflection-thinking-matter";

test.describe.configure({ mode: "serial", timeout: 120_000 });
const baseURL = process.env.THINKING_P1_E2E_BASE_URL!;
const artifacts = process.env.THINKING_P1_E2E_ARTIFACT_DIR!;
const data = process.env.APP_DATA_DIR!;
const cardId = "p3_synthetic_card", reflectionId = "p3_synthetic_reflection";
let api: APIRequestContext, matterUrl: string, beforeRestart: ThinkingMatterView;
const results: Array<{scenario: string; result: string}> = [];
function prepareSource(accountId: string) {
  if (process.env.THINKING_P3_E2E !== "1" || resolve(data) !== join(resolve(artifacts), "data")) throw new Error("P3 isolated data required");
  const database = openDailyReflectionDatabase({ filePath: join(data, "daily-reflection.sqlite") });
  try {
    const repository = new DailyReflectionRepository(database);
    const created = repository.createReflectionV2({ id: reflectionId, accountId, uploadId: null,
      operationKey: "p3-source-create", inputAdapter: "file_picker", sourceOrigin: "user_reflection",
      capturePurpose: "inspiration_capture", recordingDate: "2026-11-03", contentHash: "e".repeat(64) });
    repository.transitionStatus({ accountId, reflectionId, expectedVersion: created.reflection.version, status: "uploading" });
    const fence = repository.claimExecutionLease({ accountId, reflectionId, leaseOwner: "p3-synthetic-source", leaseDurationMs: 60_000, allowedStatuses: ["uploading"] });
    if (!fence) throw new Error("Synthetic source lease unavailable");
    const uploadId = created.receipt!.uploadId;
    const bound = repository.bindUploadAndPlanV2({ accountId, reflectionId, expectedVersion: repository.getReflection(accountId, reflectionId).version, uploadId,
      inputAdapter: "file_picker", processingProfile: "full_recording", effectiveDurationMs: 300_000,
      durationSource: "server_ffprobe", candidateLimit: 5, leaseOwner: fence.leaseOwner, attemptVersion: fence.attemptVersion });
    let reflection = repository.transitionStatus({ accountId, reflectionId, expectedVersion: bound.reflection.version, status: "transcribing", leaseOwner: fence.leaseOwner, attemptVersion: fence.attemptVersion });
    reflection = repository.transitionStatus({ accountId, reflectionId, expectedVersion: reflection.version, status: "extracting", leaseOwner: fence.leaseOwner, attemptVersion: fence.attemptVersion });
    repository.publishAssetUnderExecutionFence({ accountId, reflectionId, leaseOwner: fence.leaseOwner, attemptVersion: fence.attemptVersion,
      assetKind: "segments", payload: [{ id: "p3_segment", uploadId, startSeconds: 0, endSeconds: 8,
        text: "合成记录：松木回声47。观众想知道我为什么删掉某些内容，过程比功能数量重要。", confidence: 1, sceneLabels: [], valueLabels: [] }] });
    const saved = repository.saveCardPipelineV2({ accountId, reflectionId, expectedVersion: reflection.version, leaseOwner: fence.leaseOwner, attemptVersion: fence.attemptVersion,
      candidates: [{ id: "p3_candidate", ordinal: 0, candidateKind: "open_question", proposedText: "合成的作品方向取舍", evidenceIds: ["p3_segment"], confidence: 1, caution: "synthetic fixture", actionClaimed: false }],
      cards: [{ id: cardId, cardKind: "open_question", proposedTitle: "合成卡片：作品方向取舍", proposedText: "松木回声47：观众想知道我为什么删掉某些内容，过程比功能数量重要。",
        sourceCandidateIds: ["p3_candidate"], evidenceIds: ["p3_segment"], clusterId: "p3_cluster", clusterTitle: "作品方向", displayTier: "primary", rank: 0,
        confidence: 1, importance: 0.7, durability: 0.5, novelty: 0.5, epistemicStatus: "explicit_user_statement", riskFlags: [], actionClaimed: false, reviewStatus: "pending" }],
      // Existing pipeline audit counts one synthetic extraction invocation; it is
      // explicitly labelled and is not a real Provider request or real usage.
      audit: { modelName: "synthetic_no_provider", promptVersion: "p3-source-fixture", policy: {}, windowCount: 1, providerCallCount: 1, hiddenCandidateCount: 1, clusterCount: 1, cardCount: 1, inputTokenEstimate: 0, outputTokenBudget: 100 } });
    repository.transitionStatus({ accountId, reflectionId, expectedVersion: saved.reflection.version, status: "review_pending", leaseOwner: fence.leaseOwner, attemptVersion: fence.attemptVersion });
    repository.releaseExecutionLease({ accountId, reflectionId, leaseOwner: fence.leaseOwner, attemptVersion: fence.attemptVersion });
  } finally { database.close(); }
}


test.beforeAll(async () => {
  api = await request.newContext({ baseURL });
  const email = `thinking-p3-${Date.now()}@example.test`, password = "ThinkingFixture!2026";
  const r = await api.post("/api/auth/register", { data: { email, password, name: "P3离线合成验收", inviteCode: "thinking-p1-fixture" } });
  expect(r.status()).toBe(201); prepareSource((await r.json()).user.id);
  expect((await api.post("/api/auth/login", { data: { email, password } })).status()).toBe(200);
});
test.beforeEach(async ({ context }) => {
  await context.addCookies((await api.storageState()).cookies);
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !["127.0.0.1", "localhost"].includes(url.hostname)) { await route.abort(); throw new Error("External browser network denied"); }
    await route.continue();
  });
});
test.afterAll(async () => { await writeFile(join(artifacts, "scenarios.json"), JSON.stringify(results, null, 2)); await api?.dispose(); });
async function readMatter(page: Page) {
  const id = new URL(page.url()).searchParams.get("matter")!;
  const r = await page.evaluate(async path => { const response = await fetch(path, { cache: "no-store" }); return { status: response.status, body: await response.json() }; }, `/api/daily-reflections/thinking/matters/${id}`);
  expect(r.status).toBe(200); return r.body as ThinkingMatterView;
}
async function mutation(page: Page, fields: Record<string, unknown>) {
  const view = await readMatter(page);
  const r = await page.evaluate(async ({id, body}) => { const response = await fetch(`/api/daily-reflections/thinking/matters/${id}`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}); return {status:response.status,body:await response.json()}; }, {id:view.matter.id,body:{action:"mutate",expectedVersion:view.matter.version,operationKey:`p3-${crypto.randomUUID()}`,...fields}});
  expect(r.status).toBe(200); return r.body as ThinkingMatterView;
}
async function openProgress(page: Page) {
  const dialog = page.getByRole("dialog", { name: "进展与资料", exact: true });
  if (!await dialog.isVisible()) await page.getByRole("button", { name: "进展与资料", exact: true }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}
async function closeProgress(page: Page) {
  const dialog = page.getByRole("dialog", { name: "进展与资料", exact: true });
  if (await dialog.isVisible()) await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

function mark(scenario: string) { results.push({scenario,result:"PASS_OFFLINE_BROWSER"}); console.log(`[thinking-p3] ${results.length}/3 ${scenario}`); }

test("1 legacy entry and conversation continue without promoting to matter", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${baseURL}/reflection/think`);
  const modes = page.getByRole("combobox", { name: "一起想的方式", exact: true });
  await expect(modes.getByRole("option")).toHaveText(["头脑风暴", "想清一个决定", "比较几个方向", "延伸一个想法", "从过去找线索"]);
  await page.getByRole("combobox", { name: "选择讨论记录", exact: true }).selectOption("legacy");
  await page.getByLabel("想一起推演什么", {exact:true}).fill(`今天只比较两个方向，不安排计划。${"合成的长对话记录：保留不同方向的理由和未知信息。".repeat(70)}`);
  await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/daily-reflections/thinking"),
    page.getByRole("button", {name:"一起想",exact:true}).click()
  ]);
  await expect(page.getByLabel("本次一起想的内容", {exact:true})).toContainText("旧对话可以继续");
  const url = page.url(); await page.reload();
  await expect(page.getByLabel("本次一起想的内容", {exact:true})).toContainText("今天只比较两个方向");
  const viewport = page.getByRole("log", { name: "一起想的消息", exact: true });
  expect(await viewport.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.getByLabel("想一起推演什么", {exact:true}).fill("继续旧讨论，仍然不安排计划。");
  await page.getByRole("button", {name:"一起想",exact:true}).click();
  await expect(page.getByLabel("本次一起想的内容", {exact:true})).toContainText("继续旧讨论");
  await expect(page.getByTestId("thinking-answer")).toHaveCount(2);
  expect(page.url()).toBe(url);
  for (const size of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 2)).toBe(true);
    const bounds = await page.getByLabel("想一起推演什么", { exact: true }).evaluate(element => {
      const input = element as HTMLTextAreaElement;
      const button = input.form!.querySelector<HTMLButtonElement>("button[type=submit]")!;
      const nav = document.querySelector<HTMLElement>("nav[aria-label='日常复盘移动导航']");
      return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight,
        inputBottom: input.getBoundingClientRect().bottom, submitBottom: button.getBoundingClientRect().bottom,
        availableBottom: nav && getComputedStyle(nav).display !== "none" ? nav.getBoundingClientRect().top : innerHeight };
    });
    expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.width);
    expect(bounds.documentHeight).toBeLessThanOrEqual(bounds.height + 2);
    expect(bounds.inputBottom).toBeLessThanOrEqual(bounds.availableBottom);
    expect(bounds.submitBottom).toBeLessThanOrEqual(bounds.availableBottom);
    await writeFile(join(artifacts, `legacy-layout-${size.width}.json`), JSON.stringify(bounds, null, 2));
    await page.screenshot({ path: join(artifacts, `legacy-layout-${size.width}.png`), fullPage: true });
  }
  const list = await page.evaluate(async () => { const r = await fetch("/api/daily-reflections/thinking/matters", {cache:"no-store"}); return {status:r.status,body:await r.json()}; });
  expect(list.status).toBe(200); expect(list.body.matters).toHaveLength(0);
  await page.screenshot({path:join(artifacts,"1-legacy.png"),fullPage:true}); mark("legacy compatibility");
});

test("2 long progress, withdrawal and two-tab conflict preserve latest choice and draft", async ({ page, context }) => {
  await page.goto(`${baseURL}/reflection/cards`);
  const saved = await page.evaluate(async path => { const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({expectedVersion:0})}); return {status:r.status,body:await r.json()}; }, `/api/daily-reflections/${reflectionId}/cards/${cardId}/save`);
  expect(saved.status).toBe(200); await page.reload();
  await page.getByRole("button",{name:"打开卡片：合成卡片：作品方向取舍",exact:true}).click();
  await page.getByRole("link",{name:"拿这张卡片一起想",exact:true}).click();
  await expect(page.getByLabel("允许这件事使用这张卡片",{exact:true})).not.toBeChecked();
  await page.getByLabel("允许这件事使用这张卡片",{exact:true}).check();
  await page.getByRole("button",{name:"在新事项中一起想",exact:true}).click();
  await expect(page.getByRole("dialog", { name: "进展与资料", exact: true })).not.toBeVisible();
  await page.getByLabel("你正在想什么",{exact:true}).fill("比较方案A快速概览和方案B完整过程，只讨论不安排计划。");
  await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.startsWith("/api/daily-reflections/thinking/matters/")),
    page.getByRole("button",{name:"开始一起想",exact:true}).click()
  ]);
  await expect(page.getByRole("log", { name: "这件事的对话", exact: true })).toContainText("比较这两种表达方式");
  await openProgress(page);
  await expect(page.getByRole("region",{name:"方案比较",exact:true})).toBeVisible();
  matterUrl=page.url();
  await page.getByLabel(/^取舍原因（可不填）/u).fill("先快速反馈");
  await page.getByRole("button",{name:"选择：方案A",exact:true}).click();
  await expect.poll(async()=>(await readMatter(page)).matter.userChoice.status).toBe("selected");
  for(let i=0;i<16;i++) await mutation(page,{kind:"feedback",text:`阶段记录${i}：我仍在思考表达方式，没有执行安排。`});
  await page.reload();
  await openProgress(page);
  await expect(page.getByRole("region",{name:"最近反馈",exact:true})).toContainText("阶段记录15");
  const stale=await context.newPage(); await stale.goto(matterUrl);
  await stale.getByLabel("继续一起想",{exact:true}).fill("保留的未发送草稿");
  await openProgress(stale);
  await page.getByLabel(/^取舍原因（可不填）/u).fill("新约束：展示需要解释判断过程");
  await page.getByRole("button",{name:"选择：方案B",exact:true}).click();
  await expect.poll(async()=>(await readMatter(page)).matter.userChoice.reason).toContain("新约束");
  await Promise.all([
    stale.waitForResponse(response => response.request().method() === "POST" && response.status() === 409 && new URL(response.url()).pathname.includes("/thinking/matters/")),
    stale.getByRole("button",{name:"选择：方案A",exact:true}).click()
  ]);
  await expect(stale.getByRole("dialog", { name: "进展与资料", exact: true })).toBeHidden();
  await expect(stale.getByRole("button",{name:"重新读取进展",exact:true})).toBeVisible();
  await stale.getByRole("button",{name:"重新读取进展",exact:true}).click();
  await expect(stale.getByLabel("继续一起想",{exact:true})).toHaveValue("保留的未发送草稿");
  await stale.close();
  await mutation(page,{kind:"correct",understanding:"最新纠正：关心的是表达内容，不是技术能力。",reason:"用户核对"});
  await page.reload();
  await openProgress(page);
  await page.getByRole("button",{name:"取消关联卡片 1",exact:true}).click();
  await expect(page.getByRole("region",{name:"明确关联的卡片",exact:true})).toHaveCount(0);
  await closeProgress(page);
  await page.getByLabel("继续一起想",{exact:true}).fill("已撤回卡片授权。仅根据当前对话继续，今天不安排下一步。");
  await page.getByRole("button",{name:"发送",exact:true}).click();
  await expect(page.getByRole("log",{name:"这件事的对话"})).toContainText("已仅根据当前对话继续");
  const view=await readMatter(page);
  expect(view.events.length).toBeGreaterThan(20); expect(view.matter.userChoice.status).toBe("selected");
  expect(view.matter.userChoice.reason).toContain("新约束"); expect(view.events.filter(e=>e.kind==="choice_changed")).toHaveLength(2);
  expect(view.matter.linkedSources).toHaveLength(0); expect(view.matter.suggestions).toHaveLength(0); expect(view.matter.arrangements).toHaveLength(0);
  const inputs=(await readFile(join(artifacts,"p3-inputs.jsonl"),"utf8")).trim().split("\n").map(v=>JSON.parse(v));
  const own=inputs.filter(v=>v.payload?.observation?.matter.id===view.matter.id);
  expect(JSON.stringify(own[0])).toContain("松木回声47");
  const last=own.at(-1)!; expect(JSON.stringify(last)).not.toContain("松木回声47");
  expect(last.payload.observation.matter.understanding).toContain("最新纠正");
  expect(last.payload.observation.matter.userChoice.reason).toContain("新约束");
  expect(last.payload.observation.historyCount).toBeGreaterThan(12);
  beforeRestart=view; await writeFile(join(artifacts,"2-progress.json"),JSON.stringify(view,null,2));
  await page.screenshot({path:join(artifacts,"2-withdrawal-conflict.png"),fullPage:true}); mark("long history, withdrawal and conflict");
});

test("3 owned local service restart, close/reopen and mobile recovery",async({page,context})=>{
  await writeFile(join(artifacts,"RESTART_REQUEST"),"local isolated server only");
  await expect.poll(async()=>{ try{return JSON.parse(await readFile(join(artifacts,"RESTART_READY.json"),"utf8")).ready;}catch{return false;} },{timeout:30_000}).toBe(true);
  await page.goto(matterUrl); const first=await readMatter(page); expect(first).toEqual(beforeRestart);
  await page.close(); const reopened=await context.newPage(); await reopened.goto(matterUrl); await reopened.reload();
  expect(await readMatter(reopened)).toEqual(beforeRestart);
  await reopened.setViewportSize({width:390,height:844});
  expect(await reopened.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await expect(reopened.getByLabel("继续一起想",{exact:true})).toBeEnabled();
  await reopened.screenshot({path:join(artifacts,"3-restored-mobile.png"),fullPage:true}); mark("restart and mobile recovery");
});

import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingMatterView } from "../src/lib/domain/reflection-thinking-matter";

test.describe.configure({ mode: "serial", timeout: 120_000 });
const baseURL = process.env.THINKING_P1_E2E_BASE_URL!;
const artifacts = process.env.THINKING_P1_E2E_ARTIFACT_DIR!;
const results: Array<{ scenario: string; result: string; detail: string }> = [];
let api: APIRequestContext, matterUrl: string;
test.beforeAll(async () => {
  api = await request.newContext({ baseURL });
  const email = `thinking-p1-${Date.now()}@example.test`, password = "ThinkingFixture!2026";
  const registered = await api.post("/api/auth/register", { data: { email, password, name: "一起想离线合成验收", inviteCode: "thinking-p1-fixture" } });
  expect(registered.status()).toBe(201);
  expect((await api.post("/api/auth/login", { data: { email, password } })).status()).toBe(200);
});
test.beforeEach(async ({ context }) => {
  await context.addCookies((await api.storageState()).cookies);
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !["127.0.0.1", "localhost"].includes(url.hostname)) {
      throw new Error("Browser attempted external network request");
    }
    await route.continue();
  });
});
test.afterAll(async () => { await writeFile(join(artifacts, "scenarios.json"), JSON.stringify(results, null, 2)); await api?.dispose(); });
const mark = (scenario: string, detail: string) => { results.push({ scenario, result: "PASS_OFFLINE_SYNTHETIC", detail }); console.log(`[thinking-p1] ${results.length}/5 scenario ${scenario} passed`); };
async function readMatter(page: Page, id: string) {
  // Use the authenticated browser, including its production Secure-cookie rules,
  // rather than a separate HTTP-only API jar on the loopback test origin.
  const result = await page.evaluate(async path => {
    const response = await fetch(path, { cache: "no-store", credentials: "same-origin" });
    return { status: response.status, body: await response.json() };
  }, `/api/daily-reflections/thinking/matters/${id}`);
  expect(result.status).toBe(200);
  return result.body as ThinkingMatterView;
}

async function submitTurn(page: Page, buttonName: string) {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST"
      && new URL(response.url()).pathname.startsWith("/api/daily-reflections/thinking/matters/")
      && response.request().postDataJSON()?.action === "turn"),
    page.getByRole("button", { name: buttonName, exact: true }).click(),
  ]);
  expect(response.status()).toBe(200);
  const view = await response.json() as ThinkingMatterView;
  expect(view.matter.activeGeneration).toBeNull();
  return view;
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

test("A first problem, clarification, proposal, explicit adoption", async ({ page }) => {
  await page.goto(`${baseURL}/reflection/think`);
  const log = page.getByRole("log", { name: "这件事的对话" });
  await page.getByLabel("你正在想什么", { exact: true }).fill("我总是修改作品计划，一直没有开始。");
  await submitTurn(page, "开始一起想");
  await expect(log).toContainText("你最难开始的是功能范围太大");
  await page.getByLabel("继续一起想", { exact: true }).fill("主要是功能范围太大，不知道删什么。");
  await submitTurn(page, "发送");
  await expect(page.getByRole("region", { name: "建议的下一步", exact: true })).toContainText("先做一个最小页面");
  matterUrl = page.url();
  const id = new URL(matterUrl).searchParams.get("matter")!;
  let view = await readMatter(page, id);
  expect(view.matter.arrangements).toHaveLength(0);
  await page.getByLabel("继续一起想", { exact: true }).fill("就按这个做");
  const adopted = await submitTurn(page, "发送");
  expect(adopted.matter.arrangements).toHaveLength(1);
  expect(adopted.matter.arrangements[0].status).toBe("adopted");
  expect(adopted.events.filter(event => event.kind === "adopted")).toHaveLength(1);
  await expect(page.getByLabel("继续一起想", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  const progress = await openProgress(page);
  await expect(progress.getByRole("region", { name: "已采纳的安排", exact: true })).toContainText("已采纳 · 尚未执行");
  view = await readMatter(page, id);
  expect(view.matter.arrangements).toHaveLength(1); expect(view.matter.arrangements[0].status).toBe("adopted");
  await page.screenshot({ path: join(artifacts, "A-adopted.png"), fullPage: true });
  mark("A", "Browser created the matter, clarified scope, kept proposal separate, and saved natural-language adoption as not yet executed.");
});

test("B close and reopen, actual feedback changes next help", async ({ page }) => {
  await page.goto(matterUrl);
  const progress = await openProgress(page);
  await expect(progress.getByRole("region", { name: "已采纳的安排", exact: true })).toContainText("先做一个最小页面");
  await progress.getByRole("button", { name: "反馈这项安排", exact: true }).click();
  await expect(progress).not.toBeVisible();
  await page.getByLabel("反馈实际情况", { exact: true }).fill("我试过了，技术其实没问题，主要是不知道展示什么内容。");
  const feedback = await submitTurn(page, "提交反馈并继续想");
  expect(feedback.matter.arrangements).toHaveLength(1);
  expect(feedback.matter.arrangements[0].status).toBe("tried");
  expect(feedback.events.filter(event => event.kind === "feedback")).toHaveLength(1);
  await expect(page.getByRole("log", { name: "这件事的对话" })).toContainText("现在改为讨论展示内容");
  await expect(page.getByRole("region", { name: "建议的下一步", exact: true })).toContainText("最想展示的过程和结果");
  await openProgress(page);
  await expect(progress.getByRole("region", { name: "已采纳的安排", exact: true })).toContainText("已尝试");
  await closeProgress(page);
  await page.reload();
  await expect(page.getByRole("log", { name: "这件事的对话" })).toContainText("技术其实没问题");
  const id = new URL(matterUrl).searchParams.get("matter")!;
  const view = await readMatter(page, id);
  expect(view.matter.status).toBe("active"); expect(view.matter.arrangements[0].status).toBe("tried");
  expect(view.events.some(event => event.kind === "feedback" && event.text.includes("技术其实没问题"))).toBe(true);
  expect(view.events.some(event => event.kind === "adopted")).toBe(true);
  await page.screenshot({ path: join(artifacts, "B-reopened-feedback.png"), fullPage: true });
  mark("B", "New browser page reopened the same SQLite matter, read the prior adoption, saved real fixture feedback, changed to content selection, and stayed consistent after reload.");
});

test("C compare only without plans or arrangements", async ({ page }) => {
  await page.goto(`${baseURL}/reflection/think`);
  await expect(page.getByRole("button", { name: "新建一件事", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "新建一件事", exact: true }).click();
  await page.getByRole("combobox", { name: "一起想的方式", exact: true }).selectOption("compare_directions");
  await page.getByLabel("你正在想什么", { exact: true }).fill("帮我比较两个方向，但今天不要安排计划。");
  await submitTurn(page, "开始一起想");
  await expect(page.getByRole("log", { name: "这件事的对话" })).toContainText("今天只比较，不安排计划");
  await expect(page.getByRole("region", { name: "建议的下一步", exact: true })).toHaveCount(0);
  const progress = await openProgress(page);
  await expect(progress.getByRole("region", { name: "已采纳的安排", exact: true })).toHaveCount(0);
  const view = await readMatter(page, new URL(page.url()).searchParams.get("matter")!);
  expect(view.matter.arrangements).toHaveLength(0);
  expect(view.matter.suggestions).toHaveLength(0);
  await closeProgress(page);
  mark("C", "Comparison delivered tradeoffs and unknowns; no proposed action or adopted arrangement was created.");
});

test("D absent/unapproved history still allows natural discussion", async ({ page }) => {
  await page.goto(`${baseURL}/reflection/think`);
  await expect(page.getByRole("button", { name: "新建一件事", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "新建一件事", exact: true }).click();
  const progress = await openProgress(page);
  await expect(progress.getByRole("checkbox", { name: "允许按需参考我的日常卡片和记忆" })).not.toBeChecked();
  await closeProgress(page);
  await page.getByLabel("你正在想什么", { exact: true }).fill("我没有历史资料，也没有授权读取历史，可以聊聊吗？");
  const view = await submitTurn(page, "开始一起想");
  expect(view.matter.contextMode).toBe("none");
  expect(view.events.every(event => event.sources.length === 0)).toBe(true);
  expect(view.matter.arrangements).toHaveLength(0);
  await expect(page.getByRole("log", { name: "这件事的对话" })).toContainText("不会假定你过去的选择");
  mark("D", "Empty, unapproved daily history remained empty while the browser completed a normal discussion turn.");
});

test("E correct understanding and pause without completing", async ({ page }) => {
  await page.goto(matterUrl);
  await page.getByLabel("继续一起想", { exact: true }).fill("纠正一下，我想先讨论展示内容，不是技术问题。");
  await submitTurn(page, "发送");
  await expect(page.getByRole("log", { name: "这件事的对话" })).toContainText("已按你的纠正转向展示内容");
  await page.getByLabel("继续一起想", { exact: true }).fill("先暂停这件事");
  const paused = await submitTurn(page, "发送");
  expect(paused.matter.status).toBe("paused");
  await page.getByText("更多", { exact: true }).click();
  await expect(page.getByRole("button", { name: "继续这件事", exact: true })).toBeVisible();
  await page.reload();
  await page.getByText("更多", { exact: true }).click();
  await expect(page.getByRole("button", { name: "继续这件事", exact: true })).toBeVisible();
  const id = new URL(matterUrl).searchParams.get("matter")!;
  const view = await readMatter(page, id);
  expect(view.matter.status).toBe("paused"); expect(view.matter.arrangements[0].status).toBe("tried");
  expect(view.events.at(-1)?.text).toBe("先暂停这件事");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: join(artifacts, "E-paused-mobile.png"), fullPage: true });
  mark("E", "Browser saved a correction and natural-language pause, retained history, did not mark the matter or action complete, and fit the mobile viewport.");
});

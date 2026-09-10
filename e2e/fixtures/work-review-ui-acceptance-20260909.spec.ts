import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test as base, type Locator, type Page, type TestInfo } from "@playwright/test";

import {
  createFixture, installFixture, LONG_TEXT, MEETING_ID, NOW, ORIGINAL, PERSONAL_TEXT,
  REVIEW_ID, SOURCE_REF, type Fixture
} from "./work-review-ui-acceptance-20260909.fixture";

const ARTIFACTS = process.env.DATE_COMPANION_E2E_ARTIFACT_DIR
  ?? "output/playwright/work-review-ui-acceptance-20260909";
mkdirSync(ARTIFACTS, { recursive: true });

const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({ context, page, baseURL }, use, testInfo) => {
    const fixture = createFixture();
    await installFixture(context, page, fixture, baseURL!);
    await page.clock.setFixedTime(new Date(NOW));
    await use(fixture);
    const expectedConsole = fixture.consoleErrors.filter((error) => fixture.conflictCount > 0
      && /Failed to load resource.*409/u.test(error));
    const unexpectedConsole = fixture.consoleErrors.filter((error) => !expectedConsole.includes(error));
    const audit = { evidenceTier: "local page + browser API transport fixture", test: testInfo.title,
      status: testInfo.status, apiRequests: fixture.apiRequests, mutations: fixture.mutations,
      expectedConsole, unexpectedConsole, unknownRequests: fixture.unknownRequests,
      externalRequests: fixture.externalRequests, fixtureErrors: fixture.fixtureErrors,
      pageErrors: fixture.pageErrors, realBusinessRequests: 0, realProviderRequests: 0 };
    const auditPath = join(ARTIFACTS, `${testInfo.title.slice(0, 1)}-transport-audit.json`);
    writeFileSync(auditPath, JSON.stringify(audit, null, 2));
    await testInfo.attach("transport-audit", { path: auditPath, contentType: "application/json" });
    expect(fixture.unknownRequests, "unknown requests fail closed").toEqual([]);
    expect(fixture.externalRequests, "external requests fail closed").toEqual([]);
    expect(fixture.fixtureErrors, "fixture enforces resource CAS").toEqual([]);
    expect(fixture.pageErrors).toEqual([]);
    expect(unexpectedConsole).toEqual([]);
  }
});

test.use({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", actionTimeout: 20_000, navigationTimeout: 30_000 });
test.setTimeout(120_000);

function section(page: Page, name: string) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) }).last();
}

async function shot(page: Page, name: string, info: TestInfo, target?: Locator) {
  // Hide only the development indicator; product UI and all content stay unchanged.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  const path = join(ARTIFACTS, `${name}.png`);
  if (target) await target.screenshot({ path, animations: "disabled" });
  else await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

async function noOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    viewport: window.innerWidth, documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth
  }));
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewport + 1);
  expect(metrics.bodyWidth).toBeLessThanOrEqual(metrics.viewport + 1);
  return metrics;
}

async function weekly(page: Page) {
  await page.goto("/work-review/weekly?weekStart=2026-09-07");
  await expect(page.getByRole("heading", { name: "本周概览", exact: true })).toBeVisible();
}

test("1/6 navigation, project management entry and capability visibility", async ({ page, fixture }, info) => {
  await page.goto("/work-review/meetings");
  const nav = page.getByRole("navigation", { name: "工作复盘", exact: true });
  await expect(nav.getByRole("link")).toHaveText(["会议", "待办", "项目", "周回顾"]);
  await expect(nav.getByRole("link", { name: "会议", exact: true })).toHaveAttribute("aria-current", "page");
  await nav.getByRole("link", { name: "项目", exact: true }).click();
  await expect(page).toHaveURL(/\/work-review\/projects/u);
  await expect(nav.getByRole("link", { name: "项目", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("匿名项目甲", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /新建项目|创建项目/u }).first()).toBeVisible();
  await shot(page, "01-project-management-1440", info);
  await nav.getByRole("link", { name: "待办", exact: true }).click();
  await expect(page).toHaveURL(/\/work-review\/todos/u);
  await expect(nav.getByRole("link", { name: "待办", exact: true })).toHaveAttribute("aria-current", "page");
  await nav.getByRole("link", { name: "会议", exact: true }).click();
  await expect(page.getByRole("link", { name: /匿名项目范围会/u })).toBeVisible();
  fixture.capabilities.projects = false;
  fixture.capabilities.weekly = false;
  await page.reload();
  await expect(nav.getByRole("link")).toHaveText(["会议", "待办"]);
  expect(fixture.mutations).toEqual([]);
  await noOverflow(page);
});

test("2/6 compact optional project picker, limit, archive and keyboard focus", async ({ page, fixture }, info) => {
  await page.goto("/work-review/meetings");
  const trigger = page.getByRole("button", { name: /^所属项目（可选）：/u });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  const panelId = await trigger.getAttribute("aria-controls");
  const panel = page.locator(`[id="${panelId}"]`);
  await expect(panel).toBeHidden();
  await shot(page, "02-picker-collapsed-1440", info);
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(panel.getByRole("checkbox")).toHaveCount(4);
  for (const name of ["匿名项目甲", "匿名项目乙", "匿名项目丙"]) await panel.getByRole("checkbox", { name, exact: true }).check();
  await expect(panel.getByRole("checkbox", { name: "匿名项目丁", exact: true })).toBeDisabled();
  await expect(panel.getByText("已选 3/3", { exact: true })).toBeVisible();
  await panel.getByRole("checkbox", { name: "匿名项目乙", exact: true }).uncheck();
  await expect(panel.getByRole("checkbox", { name: "匿名项目丁", exact: true })).toBeEnabled();
  await panel.getByRole("checkbox", { name: "匿名项目丁", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(panel).toBeHidden();
  await trigger.press("Space");
  await expect(panel.getByRole("checkbox", { checked: true })).toHaveCount(3);
  await shot(page, "02-picker-expanded-1440", info);
  for (const name of ["匿名项目甲", "匿名项目丙", "匿名项目丁"]) await panel.getByRole("checkbox", { name, exact: true }).uncheck();
  await expect(panel.getByText("已选 0/3", { exact: true })).toBeVisible();
  expect(fixture.mutations).toEqual([]);

  await page.goto(`/work-review/meetings/${MEETING_ID}`);
  const meetingPicker = page.getByRole("button", { name: /^选择项目：/u });
  await meetingPicker.click();
  const archived = page.getByRole("checkbox", { name: /匿名归档项目/u });
  await expect(archived).toBeChecked();
  // The archived choice disappears immediately after removal; no post-click checkbox lookup.
  await archived.click();
  await expect(archived).toHaveCount(0);
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect.poll(() => fixture.meeting.meeting.version).toBe(5);
  expect(fixture.meeting.meeting.projects?.map((p) => p.id)).toEqual(["ui_project_a"]);
  expect(fixture.mutations[0]?.input).toMatchObject({ expectedVersion: 4, projectIds: ["ui_project_a"] });
  await page.reload();
  await expect(page.getByRole("button", { name: "选择项目：匿名项目甲", exact: true })).toBeVisible();
});

test("3/6 canonical original, saved alias only and source locating", async ({ page, fixture }, info) => {
  await page.goto(`/work-review/meetings/${MEETING_ID}`);
  const decisions = page.locator("#work-section-decision-items");
  await expect(decisions).toBeVisible();
  await decisions.getByRole("button", { name: /查看原文|来源/u }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(ORIGINAL, { exact: true })).toBeVisible();
  await expect(dialog.getByText("已保存称呼甲", { exact: true })).toBeVisible();
  await expect(dialog).not.toContainText(/Speaker 1|speaker2|speaker3/u);
  await dialog.getByRole("button", { name: /定位|原文位置/u }).click();
  const transcript = page.getByRole("region", { name: "完整会议原文", exact: true });
  await expect(transcript).toBeVisible();
  await expect(transcript.locator("li")).toHaveCount(4);
  await expect(transcript.locator("li").first()).toBeFocused();
  await expect(transcript).not.toContainText(/Speaker 1|speaker2|speaker3|未确认姓名样例/u);
  for (const segment of fixture.meeting.transcriptSegments) {
    const row = transcript.locator(`[data-segment-id="${segment.id}"]`);
    await expect(row.locator("p")).toHaveText(segment.text);
    await expect(row.locator("time")).not.toBeEmpty();
  }
  await shot(page, "03-original-alias-1440", info);
  await page.getByRole("button", { name: /发言人显示名称.*设置/u }).click();
  await expect(page.getByRole("textbox", { name: "Speaker 1 的显示名称", exact: true })).toHaveValue("已保存称呼甲");
  await page.getByRole("button", { name: /发言人显示名称.*收起/u }).click();
  await expect(page.getByRole("textbox", { name: "Speaker 1 的显示名称", exact: true })).toBeHidden();
  await weekly(page);
  await section(page, "本周概览").getByRole("button", { name: "来源 1", exact: true }).first().click();
  await expect(dialog.getByText(ORIGINAL, { exact: true })).toBeVisible();
  await expect(dialog).not.toContainText(/Speaker 1|已保存称呼甲/u);
  await expect(dialog.getByRole("link", { name: "打开会议", exact: true })).toHaveAttribute("href", `/work-review/meetings/${MEETING_ID}`);
  await shot(page, "03-weekly-source-1440", info);
  expect(fixture.mutations).toEqual([]);
});

test("4/6 independent meeting groups, counts, draft and confirmed state", async ({ page, fixture }, info) => {
  await page.goto(`/work-review/meetings/${MEETING_ID}`);
  const kinds = ["decision", "action_item", "commitment", "open_question", "plan_change", "proposal", "discussion_topic"];
  for (const kind of kinds) {
    const toggle = page.locator(`button[aria-controls="work-section-${kind}-items"]`);
    await expect(toggle).toContainText(kind === "decision" ? "2 条" : "1 条");
    await expect(toggle).toHaveAttribute("aria-expanded", kind === "decision" ? "true" : "false");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", kind === "decision" ? "false" : "true");
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", kind === "decision" ? "true" : "false");
  }
  await expect(page.getByRole("button", { name: "完成本次会议整理", exact: true })).toBeDisabled();
  expect(fixture.mutations).toEqual([]);
  const actionToggle = page.locator('button[aria-controls="work-section-action_item-items"]');
  await actionToggle.click();
  await page.locator("#work-section-action_item-items").getByRole("button", { name: "编辑或改类型", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑会议结果", exact: true });
  await dialog.getByRole("textbox", { name: "标题", exact: true }).fill("验收保留的编辑标题");
  await dialog.getByRole("textbox", { name: "内容", exact: true }).fill("验收保留的编辑草稿。");
  // The modal makes background controls inert. Dispatch a state-change event to check
  // preservation across group hiding; native keyboard operation is covered above.
  await actionToggle.dispatchEvent("click");
  await expect(actionToggle).toHaveAttribute("aria-expanded", "false");
  await expect(dialog.getByRole("textbox", { name: "内容", exact: true })).toHaveValue("验收保留的编辑草稿。");
  await actionToggle.dispatchEvent("click");
  await expect(dialog.getByRole("textbox", { name: "标题", exact: true })).toHaveValue("验收保留的编辑标题");
  expect(fixture.mutations).toEqual([]);
  await dialog.getByRole("button", { name: "保存并确认", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "验收保留的编辑标题", exact: true })).toBeVisible();
  await actionToggle.click();
  await actionToggle.click();
  await expect(page.getByRole("heading", { name: "验收保留的编辑标题", exact: true })).toBeVisible();
  expect(fixture.meeting.findings).toHaveLength(2);
  expect(fixture.meeting.meeting.pendingCandidateCount).toBe(6);
  expect(fixture.mutations).toHaveLength(1);
  expect(fixture.mutations[0]?.input).toMatchObject({ expectedVersion: 0, action: "edit_and_accept" });
  await expect(page.getByRole("button", { name: "完成本次会议整理", exact: true })).toBeDisabled();
  await shot(page, "04-meeting-groups-1440", info);
});

test("5/6 weekly version presentation, user edit CAS and stale notice", async ({ page, fixture }, info) => {
  await weekly(page);
  await expect(page.getByText(/版本\s*0/u)).toHaveCount(0);
  const progress = section(page, "重要进展");
  await expect(progress.getByText(PERSONAL_TEXT, { exact: true })).toBeVisible();
  await expect(progress.getByText("保留的旧版内容", { exact: true })).toBeVisible();
  await expect(progress.getByText("用户编辑", { exact: true })).toBeVisible();
  fixture.forceItemConflict = true;
  await progress.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = progress.getByRole("textbox", { name: "编辑回顾内容", exact: true });
  await expect(editor).toHaveValue(PERSONAL_TEXT);
  await editor.fill("冲突后仍保留在编辑器的匿名修改。");
  await progress.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByText("内容已在其他页面更新。请载入最新状态后再继续。", { exact: true })).toBeVisible();
  await expect(editor).toHaveValue("冲突后仍保留在编辑器的匿名修改。");
  expect(fixture.items.find((i) => i.id === "ui_old_edit")?.userText).toBe(PERSONAL_TEXT);
  expect(fixture.mutations[0]?.input).toMatchObject({ expectedVersion: 3 });
  await progress.getByRole("button", { name: "取消", exact: true }).click();
  fixture.review.status = "stale";
  await page.reload();
  await expect(page.getByRole("heading", { name: "本周来源后来发生变化", exact: true })).toBeVisible();
  await expect(page.getByText(PERSONAL_TEXT, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "恢复系统版本", exact: true }).click();
  const reset = page.getByRole("dialog", { name: "恢复最近的系统版本？", exact: true });
  await expect(reset).toContainText("用户编辑与隐藏状态会恢复；个人补充会保留");
  await reset.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("tab", { name: "问问本周", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "继续问这一周", exact: true })).toBeDisabled();
  await expect(page.getByText("来源已经变化。重新生成并完成核对后，才能继续提问。", { exact: true })).toBeVisible();
  expect(fixture.mutations).toHaveLength(1);
  await shot(page, "05-stale-qa-1440", info);
});

test("6/6 weekly desktop and mobile width, edit hide reorder copy source and QA", async ({ page, fixture }, info) => {
  await weekly(page);
  const layoutMetrics = [];
  for (const width of [1440, 2560, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const overview = section(page, "本周概览");
    await overview.scrollIntoViewIfNeeded();
    const paragraph = overview.locator("li[data-origin] > p").first();
    await expect(paragraph).toHaveText(LONG_TEXT);
    const measure = await paragraph.evaluate((node) => {
      const item = node.parentElement!;
      const section = item.closest("section")!;
      const p = node.getBoundingClientRect();
      const i = item.getBoundingClientRect();
      const s = section.getBoundingClientRect();
      const itemStyle = getComputedStyle(item);
      const range = document.createRange();
      range.selectNodeContents(node);
      const lines = [...range.getClientRects()];
      const itemContentWidth = i.width - parseFloat(itemStyle.paddingLeft) - parseFloat(itemStyle.paddingRight);
      const controls = [...item.querySelectorAll("button")].map((button) => {
        const rect = button.getBoundingClientRect();
        return { label: button.textContent, x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom, width: rect.width };
      });
      return { viewport: innerWidth, paragraphWidth: p.width, itemContentWidth, sectionWidth: s.width,
        paragraphToItem: p.width / itemContentWidth, paragraphToSection: p.width / s.width,
        longestTextLine: Math.max(...lines.map((line) => line.width)), lineCount: lines.length,
        fontSize: getComputedStyle(node).fontSize, lineHeight: getComputedStyle(node).lineHeight,
        paragraphBottom: p.bottom, controls };
    });
    expect(measure.paragraphToItem).toBeGreaterThanOrEqual(0.97);
    expect(measure.paragraphToSection).toBeGreaterThanOrEqual(0.94);
    expect(measure.longestTextLine / measure.paragraphWidth).toBeGreaterThan(0.9);
    for (const control of measure.controls) {
      expect(control.x).toBeGreaterThanOrEqual(-1);
      expect(control.right).toBeLessThanOrEqual(width + 1);
      expect(control.y).toBeGreaterThanOrEqual(measure.paragraphBottom - 1);
    }
    const overflow = await noOverflow(page);
    layoutMetrics.push({ ...measure, ...overflow });
    await shot(page, `06-weekly-${width}`, info);
    await shot(page, `06-weekly-overview-${width}`, info, overview);
  }
  const metricsPath = join(ARTIFACTS, "06-layout-metrics.json");
  writeFileSync(metricsPath, JSON.stringify(layoutMetrics, null, 2));
  await info.attach("layout-metrics", { path: metricsPath, contentType: "application/json" });

  const overview = section(page, "本周概览");
  await overview.locator("li[data-origin]").first().getByRole("button", { name: "下移", exact: true }).click();
  await expect(overview.locator("li[data-origin] > p").first()).toHaveText("可重排的第二条匿名概览。");
  expect(fixture.mutations.slice(0, 2).map((m) => m.input.expectedVersion)).toEqual([0, 0]);
  const moved = overview.locator("li[data-origin]").nth(1);
  await moved.getByRole("button", { name: "编辑", exact: true }).click();
  await moved.getByRole("textbox", { name: "编辑回顾内容", exact: true }).fill("手机端保存的匿名用户修改。");
  await moved.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(overview.getByText("手机端保存的匿名用户修改。", { exact: true })).toBeVisible();
  expect(fixture.mutations[2]?.input).toMatchObject({ expectedVersion: 1 });
  const decisions = section(page, "关键决定与变化");
  await decisions.getByRole("button", { name: "隐藏", exact: true }).click();
  await expect(page.getByRole("heading", { name: "关键决定与变化", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "已隐藏内容", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "复制全文", exact: true }).click();
  const copied = await page.evaluate(() => (window as unknown as { __uiCopied: string }).__uiCopied);
  expect(copied).toContain("手机端保存的匿名用户修改。");
  expect(copied).toContain(PERSONAL_TEXT);
  expect(copied).not.toContain("匿名决定：先核对样例范围。");
  await overview.getByRole("button", { name: "来源 1", exact: true }).first().click();
  await expect(page.getByRole("dialog").getByText(ORIGINAL, { exact: true })).toBeVisible();
  await noOverflow(page);
  await shot(page, "06-source-mobile-390", info, page.getByRole("dialog"));
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "问问本周", exact: true }).click();
  await page.getByRole("textbox", { name: "继续问这一周", exact: true }).fill("本周确认了哪些范围？");
  await page.getByRole("button", { name: "发送问题", exact: true }).click();
  await expect(page.locator('li[data-role="assistant"]')).toHaveCount(1);
  await expect(page.locator('li[data-role="assistant"]')).toContainText("匿名 fixture 回答");
  await page.getByRole("textbox", { name: "继续问这一周", exact: true }).fill("还有哪些事项需要继续核对？");
  await page.getByRole("button", { name: "发送问题", exact: true }).click();
  await expect(page.locator('li[data-role="assistant"]')).toHaveCount(2);
  expect(fixture.mutations.filter((m) => m.path.endsWith("/qa")).map((m) => m.input.expectedVersion)).toEqual([null, 2]);
  await page.locator('li[data-role="assistant"]').last().getByRole("button", { name: "来源 1", exact: true }).click();
  await expect(page.getByRole("dialog").getByText(ORIGINAL, { exact: true })).toBeVisible();
  expect(fixture.apiRequests.some((r) => r.path.endsWith(`/sources/${encodeURIComponent(SOURCE_REF)}`))).toBe(true);
  await page.keyboard.press("Escape");
  await noOverflow(page);
  await shot(page, "06-qa-mobile-390", info);
  expect(fixture.mutations.every((m) => !/generate|reset|upload|retry/u.test(m.path))).toBe(true);
  expect(fixture.review.id).toBe(REVIEW_ID);
});

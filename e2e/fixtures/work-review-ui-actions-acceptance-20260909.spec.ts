import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test as base, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { WorkTodo } from "../../src/lib/client/work-review-api";
import {
  ACCOUNT_ID, createFixture, installFixture, MEETING_ID, NOW
} from "./work-review-ui-acceptance-20260909.fixture";

const OUTPUT = process.env.DATE_COMPANION_E2E_ARTIFACT_DIR
  ?? "output/playwright/work-review-ui-actions-acceptance-20260909";
const FINDING_ID = "ui_actions_finding";
const SOURCE_TITLE = "匿名协作事项：核对样例参与清单、试点说明与反馈入口；出现变化时先记录依据，再确认后续范围。".repeat(3);
const SOURCE_NOTES = "匿名备注：逐项核对样例，保留需要确认的问题和来源，不自动扩展范围。".repeat(12);
const DRAFT_TITLE = "本轮保留的匿名待办草稿";
const DRAFT_NOTES = "本轮保留的匿名备注。" + SOURCE_NOTES;
mkdirSync(OUTPUT, { recursive: true });

function todo(id: string): WorkTodo {
  return { contractVersion: 1, id, accountId: ACCOUNT_ID, kind: "self", status: "open", origin: "manual",
    title: "匿名待安排事项", notes: null, ownerLabel: null, currentDueDate: "2026-09-09", isImportant: false,
    myDayDate: null, sourceMeetingId: null, sourceFindingId: null, sourceFindingVersion: null,
    sourceFindingKind: null, sourceOwnerLabel: null, sourceOriginalDueAt: null, sourceOriginalDueExpression: null,
    sourceActionBasis: null, sourceDetachedAt: null, version: 0, createdAt: NOW, updatedAt: NOW,
    completedAt: null, reopenedAt: null, deletedAt: null, projects: [] };
}

function makeState() {
  const core = createFixture();
  core.meeting.candidates = [];
  core.meeting.meeting.pendingCandidateCount = 0;
  core.meeting.meeting.reviewStatus = "completed";
  core.meeting.findings = [{ ...core.meeting.findings[0]!, id: FINDING_ID, kind: "action_item",
    title: SOURCE_TITLE, body: SOURCE_NOTES, version: 2, candidateOwner: "匿名协作方",
    dueAt: "2026-09-11T00:00:00.000Z", originalDueExpression: "本周五", actionBasis: "explicit_commitment" }];
  delete core.meeting.findings[0]!.decisionFinality;
  return { core, failNextCreate: false, mockErrorCount: 0, inputs: [] as Record<string, unknown>[],
    created: [] as WorkTodo[], hold: null as Promise<void> | null, release: () => {} };
}
type State = ReturnType<typeof makeState>;

const test = base.extend<{ state: State }>({
  state: async ({ context, page, baseURL }, use, info) => {
    const state = makeState();
    await installFixture(context, page, state.core, baseURL!);
    await page.clock.setFixedTime(new Date(NOW));
    // Extend the already verified DTO fixture only for this task's Todo reads/creation.
    // Every nonmatching request falls back to its fail-closed guard, never the network.
    await context.route("**/api/work-reviews/todos**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== new URL(baseURL!).origin || url.pathname !== "/api/work-reviews/todos" || request.method() !== "GET") return route.fallback();
      state.core.apiRequests.push({ method: "GET", path: url.pathname });
      return route.fulfill({ json: { todos: url.searchParams.get("view") === "today" ? [] : [todo("ui_actions_suggestion")] } });
    });
    await context.route("**/api/work-reviews/meetings/*/findings/*/todo", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== new URL(baseURL!).origin || url.pathname !== `/api/work-reviews/meetings/${MEETING_ID}/findings/${FINDING_ID}/todo` || request.method() !== "POST") return route.fallback();
      const input = request.postDataJSON() as Record<string, unknown>;
      state.core.apiRequests.push({ method: "POST", path: url.pathname });
      state.core.mutations.push({ method: "POST", path: url.pathname, input });
      state.inputs.push(input);
      if (state.failNextCreate) {
        state.failNextCreate = false; state.mockErrorCount += 1;
        return route.fulfill({ status: 503, json: { error: "temporarily_unavailable" } });
      }
      await state.hold;
      const created: WorkTodo = { ...todo("ui_actions_created"), origin: "meeting_finding",
        title: input.title as string, kind: input.kind as WorkTodo["kind"], ownerLabel: input.ownerLabel as string,
        notes: input.notes as string, currentDueDate: input.currentDueDate as string,
        isImportant: input.isImportant as boolean, myDayDate: input.myDayDate as string | null,
        sourceMeetingId: MEETING_ID, sourceFindingId: FINDING_ID, sourceFindingVersion: 2,
        sourceFindingKind: "action_item", sourceOwnerLabel: "匿名协作方", sourceOriginalDueAt: "2026-09-11T00:00:00.000Z",
        sourceOriginalDueExpression: "本周五", sourceActionBasis: "explicit_commitment",
        projects: state.core.projects.filter((p) => (input.projectIds as string[]).includes(p.id))
          .map(({ id, name, status, version }) => ({ id, name, status, version })) };
      state.created.push(created);
      state.core.meeting.todoProjections = [{ id: created.id, sourceFindingId: FINDING_ID, status: created.status,
        title: created.title, version: 0, kind: created.kind, currentDueDate: created.currentDueDate,
        sourceOriginalDueAt: created.sourceOriginalDueAt, sourceOriginalDueExpression: created.sourceOriginalDueExpression }];
      state.core.meeting.linkedTodoCount = 1;
      return route.fulfill({ json: { todo: created, reused: false } });
    });
    try { await use(state); }
    finally {
      state.release();
      const expectedConsole = state.core.consoleErrors.filter((value) => state.mockErrorCount > 0 && /Failed to load resource.*503/u.test(value));
      const unexpectedConsole = state.core.consoleErrors.filter((value) => !expectedConsole.includes(value));
      const audit = { title: info.title, status: info.status,
        evidenceTier: "local page + browser API transport fixture", apiRequests: state.core.apiRequests,
        inputs: state.inputs, successfulFixtureCreates: state.created.length, expectedConsole, unexpectedConsole,
        unknownRequests: state.core.unknownRequests, externalRequests: state.core.externalRequests,
        pageErrors: state.core.pageErrors, fixtureErrors: state.core.fixtureErrors };
      const path = join(OUTPUT, `${info.title.slice(0, 1)}-audit.json`);
      writeFileSync(path, JSON.stringify(audit, null, 2));
      await info.attach("transport audit", { path, contentType: "application/json" });
      expect(state.core.unknownRequests).toEqual([]);
      expect(state.core.externalRequests).toEqual([]);
      expect(state.core.pageErrors).toEqual([]);
      expect(state.core.fixtureErrors).toEqual([]);
      expect(unexpectedConsole).toEqual([]);
    }
  }
});

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block", actionTimeout: 20_000, navigationTimeout: 30_000 });
test.setTimeout(120_000);

async function screenshot(page: Page, name: string, info: TestInfo) {
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  const path = join(OUTPUT, `${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

async function buttonStyle(locator: Locator) {
  return locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const range = document.createRange();
    range.selectNodeContents(node);
    const text = range.getBoundingClientRect();
    return { width: rect.width, height: rect.height, fontFamily: style.fontFamily, fontSize: style.fontSize,
      fontWeight: style.fontWeight, lineHeight: style.lineHeight, padding: style.padding,
      borderRadius: style.borderRadius, borderWidth: style.borderWidth, borderStyle: style.borderStyle,
      borderColor: style.borderColor, color: style.color, background: style.backgroundColor,
      decoration: style.textDecorationLine, textVerticalOffset: (text.top + text.bottom - rect.top - rect.bottom) / 2,
      outline: style.outlineStyle, outlineWidth: style.outlineWidth, outlineOffset: style.outlineOffset };
  });
}

test("1/2 entry buttons match peers and navigate without upload", async ({ page, state }, info) => {
  await page.goto("/work-review");
  const primary = page.getByRole("button", { name: "新建待办", exact: true });
  const peer = page.getByRole("button", { name: "加入今天", exact: true });
  const upload = page.getByRole("link", { name: "上传会议录音", exact: true });
  const all = page.getByRole("link", { name: "查看全部待办", exact: true });
  await expect(peer).toBeVisible();
  const metrics = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.mouse.move(0, 0);
    const reference = await buttonStyle(peer);
    const primaryStyle = await buttonStyle(primary);
    for (const link of [upload, all]) {
      const actual = await buttonStyle(link);
      for (const key of ["height", "fontFamily", "fontSize", "fontWeight", "lineHeight", "padding", "borderRadius", "borderWidth", "borderStyle", "borderColor", "color", "background"] as const) {
        expect(actual[key], `${await link.textContent()} ${width}px ${key}`).toBe(reference[key]);
      }
      expect(actual.height).toBe(primaryStyle.height);
      expect(actual.decoration).toBe("none");
      expect(Math.abs(actual.textVerticalOffset - reference.textVerticalOffset)).toBeLessThanOrEqual(1);
      metrics.push({ width, label: await link.textContent(), actual, secondaryReference: reference, primaryReference: primaryStyle });
    }
    if (width === 1440) await screenshot(page, "01-entry-buttons-1440", info);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await peer.hover();
  const normalBorder = metrics[0]!.secondaryReference.borderColor;
  await expect.poll(async () => (await buttonStyle(peer)).borderColor).not.toBe(normalBorder);
  const hoverReference = await buttonStyle(peer);
  for (const link of [upload, all]) {
    await link.hover();
    await expect(link).toHaveCSS("border-color", hoverReference.borderColor);
    await expect(link).toHaveCSS("color", hoverReference.color);
  }
  await page.mouse.move(0, 0);
  await primary.focus();
  await page.keyboard.press("Tab");
  await expect(upload).toBeFocused();
  await expect(upload).toHaveCSS("outline-style", "solid");
  await expect(upload).toHaveCSS("outline-width", "3px");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/work-review\/meetings$/u);
  await expect(page.getByRole("heading", { name: "上传会议录音", exact: true })).toBeVisible();
  await expect(page.getByLabel("会议录音", { exact: true })).toBeVisible();
  await page.goto("/work-review");
  await all.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/work-review\/todos$/u);
  expect(state.core.mutations).toEqual([]);
  writeFileSync(join(OUTPUT, "01-button-metrics.json"), JSON.stringify({ metrics, hoverReference }, null, 2));
});

async function ctaMetrics(dialog: Locator, phase: string) {
  const metrics = await dialog.evaluate((node, phase) => {
    const buttons = [...node.querySelectorAll<HTMLButtonElement>("footer button")].map((button) => {
      const rect = button.getBoundingClientRect();
      const points = [[rect.x + rect.width / 2, rect.y + rect.height / 2], [rect.x + 8, rect.y + 8], [rect.right - 8, rect.bottom - 8]];
      return { label: button.textContent, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom,
        width: rect.width, height: rect.height, hits: points.map(([x, y]) => button.contains(document.elementFromPoint(x!, y!))) };
    });
    const body = node.querySelector<HTMLElement>(":scope > div")!;
    const rect = node.getBoundingClientRect();
    return { phase, viewport: { width: innerWidth, height: innerHeight }, dialog: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      buttons, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight, scrollTop: body.scrollTop,
      pageScroll: scrollY, documentWidth: document.documentElement.scrollWidth,
      bodyOverflow: getComputedStyle(body).overflowY, pageOverflow: document.body.style.overflow };
  }, phase);
  appendFileSync(join(OUTPUT, "02-cta-checkpoints.jsonl"), JSON.stringify(metrics) + "\n");
  expect(metrics.buttons).toHaveLength(2);
  for (const button of metrics.buttons) {
    expect(button.x).toBeGreaterThanOrEqual(0);
    expect(button.y).toBeGreaterThanOrEqual(0);
    expect(button.right).toBeLessThanOrEqual(metrics.viewport.width);
    expect(button.bottom).toBeLessThanOrEqual(metrics.viewport.height);
    expect(button.height).toBeGreaterThanOrEqual(44);
    expect(button.hits).toEqual([true, true, true]);
  }
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewport.width);
  expect(metrics.pageOverflow).toBe("hidden");
  return metrics;
}

test("2/2 Todo dialog CTA visible clickable and stable in four viewports", async ({ page, state }, info) => {
  const records = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 565, height: 791 }, { width: 390, height: 844 }, { width: 390, height: 568 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/work-review/meetings/${MEETING_ID}`);
    await page.locator('button[aria-controls="work-section-action_item-items"]').click();
    const trigger = page.getByRole("button", { name: "设为等待他人", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "从会议结果创建待办", exact: true });
    await expect(dialog).toBeVisible();
    records.push(await ctaMetrics(dialog, "opened"));
    const create = dialog.locator('button[form="work-todo-editor"]');
    const close = dialog.getByRole("button", { name: "关闭", exact: true });
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(create).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await expect(dialog.getByRole("textbox", { name: "标题", exact: true })).toHaveValue(SOURCE_TITLE);
    await expect(dialog.getByRole("textbox", { name: "负责人或等待对象", exact: true })).toHaveValue("匿名协作方");
    await expect(dialog.getByLabel("当前计划日期", { exact: true })).toHaveValue("2026-09-11");
    await expect(dialog.getByRole("textbox", { name: "备注", exact: true })).toHaveValue(SOURCE_NOTES);
    await dialog.getByRole("textbox", { name: "标题", exact: true }).fill(DRAFT_TITLE);
    await dialog.getByRole("textbox", { name: "备注", exact: true }).fill(DRAFT_NOTES);
    const picker = dialog.getByRole("button", { name: /^关联项目：/u });
    await picker.click();
    await dialog.getByRole("checkbox", { name: "匿名项目乙", exact: true }).check();
    records.push(await ctaMetrics(dialog, "project-expanded"));
    const body = dialog.locator(":scope > div");
    const before = await ctaMetrics(dialog, "before-content-scroll");
    const bodyRect = await body.boundingBox();
    expect(bodyRect).not.toBeNull();
    expect(before.bodyOverflow).toBe("auto");
    expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
    await body.evaluate((element) => { element.scrollTop = 0; });
    await page.mouse.move(bodyRect!.x + 5, bodyRect!.y + bodyRect!.height / 2);
    await page.mouse.wheel(0, 1600);
    await expect.poll(async () => await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const after = await ctaMetrics(dialog, "after-content-scroll");
    expect(after.pageScroll).toBe(before.pageScroll);
    expect(after.buttons.map((button) => button.y)).toEqual(before.buttons.map((button) => button.y));
    records.push(after);
    // Escape in the open project picker closes only that panel, keeping the modal.
    await dialog.getByRole("checkbox", { name: "匿名项目乙", exact: true }).focus();
    await expect(dialog.getByRole("checkbox", { name: "匿名项目乙", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(picker).toHaveAttribute("aria-expanded", "false");
    await expect(picker).toBeFocused();
    records.push(await ctaMetrics(dialog, "project-closed"));
    await create.click({ trial: true });
    if (viewport.width === 1440 || viewport.height === 568) {
      await body.evaluate((element) => { element.scrollTop = 0; });
      await screenshot(page, `02-dialog-${viewport.width}x${viewport.height}`, info);
    }
    if (viewport.width === 1440) {
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
    } else if (viewport.width === 565) {
      state.failNextCreate = true;
      await create.click();
      await expect(dialog.getByRole("alert")).toBeVisible();
      await expect(dialog.getByRole("textbox", { name: "标题", exact: true })).toHaveValue(DRAFT_TITLE);
      await expect(dialog.getByRole("textbox", { name: "备注", exact: true })).toHaveValue(DRAFT_NOTES);
      expect(state.inputs).toHaveLength(1);
      expect(state.created).toHaveLength(0);
      records.push(await ctaMetrics(dialog, "mock-error"));
      await page.keyboard.press("Escape");
    } else if (viewport.height === 844) {
      const owner = dialog.getByRole("textbox", { name: "负责人或等待对象", exact: true });
      await owner.fill("");
      await create.click();
      expect(await owner.evaluate((node) => (node as HTMLInputElement).validity.valueMissing)).toBe(true);
      expect(state.inputs).toHaveLength(1);
      await expect(dialog.getByRole("textbox", { name: "备注", exact: true })).toHaveValue(DRAFT_NOTES);
      records.push(await ctaMetrics(dialog, "validation-error"));
      await close.click();
    } else {
      state.hold = new Promise<void>((resolve) => { state.release = resolve; });
      await create.dblclick();
      await expect(create).toBeDisabled();
      await expect.poll(() => state.inputs.length).toBe(2);
      expect(state.inputs[1]).toMatchObject({ title: DRAFT_TITLE, kind: "waiting_for_other",
        ownerLabel: "匿名协作方", currentDueDate: "2026-09-11", notes: DRAFT_NOTES,
        projectIds: ["ui_project_a", "ui_project_old", "ui_project_b"], isImportant: false,
        myDayDate: null, ownershipOverrideConfirmed: false });
      expect(state.inputs[1]?.operationKey).toEqual(expect.any(String));
      state.release();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("button", { name: "查看待办", exact: true })).toBeVisible();
      expect(state.created).toHaveLength(1);
      expect(state.inputs).toHaveLength(2);
    }
    await expect(dialog).toBeHidden();
    if (viewport.height !== 568) await expect(trigger).toBeFocused();
  }
  writeFileSync(join(OUTPUT, "02-cta-metrics.json"), JSON.stringify(records, null, 2));
});

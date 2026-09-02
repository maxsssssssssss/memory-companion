import { mkdirSync } from "node:fs";

import { expect, test, type Page, type Route } from "@playwright/test";

import type {
  WorkMeetingDetail,
  WorkMeetingFollowUpDraft,
  WorkMeetingFollowUpGetResponse
} from "../../src/lib/client/work-review-api";

const NOW = "2026-09-02T06:00:00.000Z";
const MEETING_ID = "meeting_follow_up";
const OUTPUT_DIR = "output/playwright/work-review-v1-phase-4";
const REVIEW_DIR = ".impeccable/review";

mkdirSync(OUTPUT_DIR, { recursive: true });
mkdirSync(REVIEW_DIR, { recursive: true });

const sourceStats: WorkMeetingFollowUpGetResponse["sourceStats"] = {
  findingCount: 4,
  todoCount: 2,
  confirmedResultCount: 4,
  myTodoCount: 1,
  waitingForOtherTodoCount: 1,
  unresolvedQuestionCount: 1
};

function evidence(id: string, text: string, startSeconds: number) {
  return {
    publicationId: "wrp_follow_up_fixture",
    segmentId: id,
    startSeconds,
    endSeconds: startSeconds + 5,
    rawSpeakerLabel: "Speaker 1",
    timestampQuality: "provider_exact",
    text,
    contextBefore: "团队先对发布范围做了核对。",
    contextAfter: "随后明确了负责人和下一步。"
  };
}

function meetingDetail(): WorkMeetingDetail {
  return {
    meeting: {
      id: MEETING_ID,
      title: "秋季发布准备会",
      meetingDate: "2026-09-01",
      ingestionStatus: "transcript_ready",
      analysisStatus: "review_ready",
      reviewStatus: "completed",
      durationSeconds: 3_285,
      pendingCandidateCount: 0,
      canonicalSegmentCount: 4,
      createdAt: NOW,
      updatedAt: NOW,
      sourceUploadId: "upload_follow_up_fixture",
      version: 8,
      canonicalPublicationId: "wrp_follow_up_fixture",
      canonicalContentDigest: "fixture-canonical-digest",
      verifierMode: "enabled"
    },
    transcriptSegments: [
      { id: "segment_scope", uploadId: "upload_follow_up_fixture", startSeconds: 0, endSeconds: 8, speaker: "Speaker 1", text: "本周先发布邀请和提醒两个核心流程。" },
      { id: "segment_decision", uploadId: "upload_follow_up_fixture", startSeconds: 8, endSeconds: 15, speaker: "Speaker 2", text: "决定将公开发布窗口调整到九月十二日。" },
      { id: "segment_action", uploadId: "upload_follow_up_fixture", startSeconds: 15, endSeconds: 24, speaker: "Speaker 1", text: "我会在周五前整理发布检查表。" },
      { id: "segment_question", uploadId: "upload_follow_up_fixture", startSeconds: 24, endSeconds: 31, speaker: "Speaker 2", text: "法务说明什么时候能最终确认仍待跟进。" }
    ],
    candidates: [],
    findings: [
      {
        id: "finding_decision",
        sourceCandidateId: "candidate_decision",
        kind: "decision",
        title: "公开发布窗口调整到 9 月 12 日",
        body: "团队明确将公开发布窗口调整到 9 月 12 日。",
        version: 1,
        decisionFinality: "final",
        evidence: [evidence("segment_decision", "决定将公开发布窗口调整到九月十二日。", 8)],
        createdAt: NOW,
        updatedAt: NOW
      },
      {
        id: "finding_action",
        sourceCandidateId: "candidate_action",
        kind: "action_item",
        title: "整理发布检查表",
        body: "Alex 会整理并核对发布检查表。",
        version: 1,
        candidateOwner: "Alex",
        dueAt: "2026-09-04T09:00:00.000Z",
        originalDueExpression: "周五前",
        actionBasis: "explicit_commitment",
        evidence: [evidence("segment_action", "我会在周五前整理发布检查表。", 15)],
        createdAt: NOW,
        updatedAt: NOW
      },
      {
        id: "finding_question",
        sourceCandidateId: "candidate_question",
        kind: "open_question",
        title: "法务说明何时最终确认",
        body: "法务说明的最终确认时间仍未明确。",
        version: 1,
        evidence: [evidence("segment_question", "法务说明什么时候能最终确认仍待跟进。", 24)],
        createdAt: NOW,
        updatedAt: NOW
      },
      {
        id: "finding_plan",
        sourceCandidateId: "candidate_plan",
        kind: "plan_change",
        title: "先聚焦邀请与提醒流程",
        body: "首发范围收敛为邀请与提醒两个核心流程。",
        version: 1,
        evidence: [evidence("segment_scope", "本周先发布邀请和提醒两个核心流程。", 0)],
        createdAt: NOW,
        updatedAt: NOW
      }
    ],
    todoProjections: [
      {
        id: "todo_self",
        sourceFindingId: "finding_action",
        status: "open",
        title: "整理发布检查表",
        version: 2,
        kind: "self",
        currentDueDate: "2026-09-05",
        sourceOriginalDueAt: "2026-09-04T09:00:00.000Z",
        sourceOriginalDueExpression: "周五前"
      },
      {
        id: "todo_waiting",
        sourceFindingId: "finding_question",
        status: "completed",
        title: "等待法务确认说明",
        version: 3,
        kind: "waiting_for_other",
        currentDueDate: "2026-09-08",
        sourceOriginalDueAt: null,
        sourceOriginalDueExpression: "下周一前"
      }
    ],
    linkedTodoCount: 2,
    speakerAliases: [
      { rawLabel: "Speaker 1", displayLabel: "Alex", version: 0, createdAt: NOW, updatedAt: NOW },
      { rawLabel: "Speaker 2", displayLabel: "Lin", version: 0, createdAt: NOW, updatedAt: NOW }
    ]
  };
}

function draft(input: Partial<WorkMeetingFollowUpDraft> = {}): WorkMeetingFollowUpDraft {
  const bodyMarkdown = input.bodyMarkdown ?? [
    "# 秋季发布准备会 · 会后纪要",
    "",
    "## 决定",
    "- 公开发布窗口调整到 9 月 12 日。",
    "",
    "## 行动事项",
    "- Alex 整理发布检查表，当前计划 9 月 5 日完成。",
    "- 等待法务确认说明。",
    "",
    "## 未解决问题",
    "- 法务说明何时最终确认？"
  ].join("\n");
  return {
    contractVersion: 1,
    meetingId: MEETING_ID,
    accountId: "account_fixture",
    bodyMarkdown,
    systemSnapshotDigest: "a".repeat(64),
    currentSnapshotDigest: "b".repeat(64),
    stale: true,
    version: 2,
    generatedAt: NOW,
    userEditedAt: null,
    updatedAt: NOW,
    copySlices: {
      full: bodyMarkdown,
      decisions: "## 决定\n- 公开发布窗口调整到 9 月 12 日。",
      actions: "## 行动事项\n- Alex 整理发布检查表。\n- 等待法务确认说明。",
      selectiveSlicesSource: "system_snapshot"
    },
    sourceStats,
    ...input
  };
}

type MutationCall = Readonly<{
  method: string;
  path: string;
  body: Readonly<Record<string, unknown>>;
}>;

type FixtureState = {
  currentDraft: WorkMeetingFollowUpDraft;
  calls: MutationCall[];
  uploadAttempts: number;
};

function response(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "private, no-store" },
    body: JSON.stringify(body)
  });
}

function nextDraft(
  current: WorkMeetingFollowUpDraft,
  input: Partial<WorkMeetingFollowUpDraft>
): WorkMeetingFollowUpDraft {
  return draft({
    ...current,
    ...input,
    version: current.version + 1,
    updatedAt: NOW
  });
}

async function installFixture(page: Page, state: FixtureState) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as typeof window & { __workReviewCopied?: string }).__workReviewCopied = value;
        }
      }
    });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    if (method === "GET" && path === "/api/auth/me") {
      return response(route, {
        user: { id: "account_fixture", email: "fixture@example.com", name: "测试用户" }
      });
    }
    if (method === "GET" && path === "/api/work-reviews/config") {
      return response(route, {
        limits: { maxUploadBytes: 10, maxAudioDurationSeconds: 65 }
      });
    }
    if (method === "GET" && path === "/api/work-reviews/meetings") {
      return response(route, { meetings: [] });
    }
    if (method === "POST" && path === "/api/work-reviews/meetings") {
      state.uploadAttempts += 1;
      return response(route, {
        meetingId: "unexpected_upload",
        receiptId: "unexpected_receipt",
        ingestionStatus: "queued",
        analysisStatus: "not_started",
        reused: false
      });
    }
    if (method === "GET" && path === `/api/work-reviews/meetings/${MEETING_ID}`) {
      return response(route, meetingDetail());
    }
    if (method === "GET" && path === `/api/work-reviews/meetings/${MEETING_ID}/follow-up`) {
      return response(route, { draft: state.currentDraft, sourceStats });
    }
    if (
      (method === "PATCH" && path === `/api/work-reviews/meetings/${MEETING_ID}/follow-up`)
      || (method === "POST" && path === `/api/work-reviews/meetings/${MEETING_ID}/follow-up/reset`)
      || (method === "POST" && path === `/api/work-reviews/meetings/${MEETING_ID}/follow-up/generate`)
    ) {
      const body = request.postDataJSON() as Readonly<Record<string, unknown>>;
      state.calls.push({ method, path, body });
      if (body.expectedVersion !== state.currentDraft.version) {
        return response(route, { error: "version_conflict" }, 409);
      }
      if (method === "PATCH") {
        const bodyMarkdown = String(body.bodyMarkdown ?? "");
        state.currentDraft = nextDraft(state.currentDraft, {
          bodyMarkdown,
          userEditedAt: NOW,
          copySlices: { ...state.currentDraft.copySlices, full: bodyMarkdown }
        });
      } else if (path.endsWith("/reset")) {
        state.currentDraft = nextDraft(state.currentDraft, {
          bodyMarkdown: draft().bodyMarkdown,
          stale: false,
          userEditedAt: null,
          currentSnapshotDigest: "a".repeat(64)
        });
      } else {
        state.currentDraft = nextDraft(state.currentDraft, {
          bodyMarkdown: `${draft().bodyMarkdown}\n\n已按最新会议内容重新生成。`,
          stale: false,
          userEditedAt: null,
          systemSnapshotDigest: "c".repeat(64),
          currentSnapshotDigest: "c".repeat(64)
        });
      }
      return response(route, { draft: state.currentDraft, reused: false });
    }
    return response(route, { error: `unhandled_fixture_route:${method}:${path}` }, 500);
  });
}

async function pageMetrics(page: Page) {
  return await page.evaluate(() => {
    const visible = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const targets = Array.from(document.querySelectorAll<HTMLElement>(
      "button, a[href], input, textarea, select, [role='tab']"
    )).filter(visible);
    return {
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      under44: targets.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width < 44 || rect.height < 44;
      }).map((element) => ({
        label: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 40) ?? element.tagName,
        width: Math.round(element.getBoundingClientRect().width),
        height: Math.round(element.getBoundingClientRect().height)
      }))
    };
  });
}

async function hideNextDevIndicator(page: Page) {
  await page.evaluate(() => {
    document.querySelectorAll("nextjs-portal").forEach((element) => element.remove());
  });
}

test.describe("Work Review V1-4 follow-up deterministic browser fixture", () => {
  test("keeps result facts, Todo facts, draft editing, copying, reset, and regeneration separate", async ({ page }) => {
    const state: FixtureState = { currentDraft: draft(), calls: [], uploadAttempts: 0 };
    const consoleProblems: string[] = [];
    const externalRequests: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleProblems.push(message.text());
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!(["127.0.0.1", "localhost"].includes(url.hostname))) externalRequests.push(request.url());
    });
    await installFixture(page, state);

    await page.goto(`/work-review/meetings/${MEETING_ID}`);
    await expect(page.getByRole("heading", { name: "秋季发布准备会" })).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(4);
    await expect(page.getByText("4项会议结果已确认")).toBeVisible();
    await expect(page.getByText("1项我的待办已创建")).toBeVisible();
    await expect(page.getByText("1项等待他人已创建")).toBeVisible();
    await expect(page.getByText("1个未解决问题已保留")).toBeVisible();

    await page.getByRole("tab", { name: "待办" }).click();
    await expect(page.getByText("周五前")).toBeVisible();
    await expect(page.getByText("2026-09-05")).toBeVisible();
    await expect(page.getByText("当前待办状态：待处理")).toBeVisible();
    await expect(page.getByText("当前待办状态：已完成")).toBeVisible();
    await expect(page.getByText("完成待办不会改写会议承诺。", { exact: false })).toBeVisible();

    await page.getByRole("tab", { name: "会后纪要" }).click();
    await expect(page.getByRole("heading", { name: "会后纪要", exact: true })).toBeVisible();
    await expect(page.getByText("草稿", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "会议结果或待办后来发生变化" })).toBeVisible();
    await page.getByRole("button", { name: "编辑纪要" }).click();
    const editor = page.getByLabel("纪要正文");
    await expect(editor).toBeFocused();
    await editor.fill("# 用户整理的纪要\n\n## 决定\n- 保持发布窗口不变。\n\n## 行动事项\n- Alex 核对清单。");

    await page.getByRole("tab", { name: "完整原文" }).click();
    await expect(page.getByText("决定将公开发布窗口调整到九月十二日。")).toBeVisible();
    await page.getByRole("tab", { name: "会后纪要" }).click();
    await expect(page.getByLabel("纪要正文")).toHaveValue(/用户整理的纪要/u);
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(page.getByText("纪要修改已保存。", { exact: true })).toBeVisible();
    expect(state.calls.at(-1)?.body.expectedVersion).toBe(2);

    await page.getByRole("button", { name: "只复制决定" }).click();
    await expect(page.getByText("已复制决定部分。", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (
      window as typeof window & { __workReviewCopied?: string }
    ).__workReviewCopied)).toContain("公开发布窗口调整到 9 月 12 日");

    await page.getByRole("button", { name: "恢复系统版本" }).click();
    const resetDialog = page.getByRole("dialog", { name: "恢复最近的系统版本？" });
    await expect(resetDialog).toBeVisible();
    await resetDialog.getByRole("button", { name: "确认恢复" }).click();
    await expect(page.getByText("已恢复为最近一次系统生成的版本。", { exact: true })).toBeVisible();
    expect(state.calls.at(-1)?.body.expectedVersion).toBe(3);

    await page.getByRole("button", { name: "重新生成" }).click();
    const regenerateDialog = page.getByRole("dialog", { name: "按最新内容重新生成？" });
    await expect(regenerateDialog).toBeVisible();
    await regenerateDialog.getByRole("button", { name: "确认重新生成" }).click();
    await expect(page.getByText("已按最新会议结果与待办重新生成纪要。", { exact: true })).toBeVisible();
    expect(state.calls.at(-1)?.body.expectedVersion).toBe(4);

    const metrics = await pageMetrics(page);
    expect(metrics.horizontalOverflow).toBe(0);
    expect(metrics.under44).toEqual([]);
    expect(consoleProblems).toEqual([]);
    expect(externalRequests).toEqual([]);
    await hideNextDevIndicator(page);
    await page.screenshot({ path: `${OUTPUT_DIR}/work-review-follow-up-desktop.png`, fullPage: true });
    await page.screenshot({ path: `${REVIEW_DIR}/work-review-follow-up-desktop.png`, fullPage: true });
  });

  test("keeps all four views and follow-up actions usable at 390px", async ({ page }) => {
    const state: FixtureState = { currentDraft: draft(), calls: [], uploadAttempts: 0 };
    const consoleProblems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleProblems.push(message.text());
    });
    await installFixture(page, state);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/work-review/meetings/${MEETING_ID}`);

    const resultsTab = page.getByRole("tab", { name: "会议结果" });
    await resultsTab.focus();
    await resultsTab.press("End");
    await expect(page.getByRole("tab", { name: "会后纪要" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: "编辑纪要" })).toBeVisible();
    await expect(page.getByRole("button", { name: "只复制行动事项" })).toBeVisible();

    const metrics = await pageMetrics(page);
    expect(metrics.horizontalOverflow).toBe(0);
    expect(metrics.under44).toEqual([]);
    expect(consoleProblems).toEqual([]);
    await hideNextDevIndicator(page);
    await page.screenshot({ path: `${OUTPUT_DIR}/work-review-follow-up-mobile-390.png`, fullPage: true });
    await page.screenshot({ path: `${REVIEW_DIR}/work-review-follow-up-mobile-390.png`, fullPage: true });
  });

  test("shows server capacity limits and rejects an oversized file before upload", async ({ page }) => {
    const state: FixtureState = { currentDraft: draft(), calls: [], uploadAttempts: 0 };
    await installFixture(page, state);
    await page.goto("/work-review/meetings");

    await expect(page.getByText(/文件不超过/u)).toContainText("10 字节");
    await expect(page.getByText(/文件不超过/u)).toContainText("65 秒");
    await page.locator('input[type="file"][aria-label="会议录音"]').setInputFiles({
      name: "too-large.mp3",
      mimeType: "audio/mpeg",
      buffer: Buffer.from("12345678901")
    });

    const uploadError = page.locator('p[role="alert"]');
    await expect(uploadError).toContainText("10 字节");
    await page.getByRole("button", { name: "上传并开始整理" }).click();
    await expect(uploadError).toContainText("请选择更小的文件");
    expect(state.uploadAttempts).toBe(0);
  });
});

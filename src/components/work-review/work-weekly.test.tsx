import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WorkReviewApiError,
  type WorkReviewApi,
  type WorkReviewCapabilities,
  type WorkReviewV2CoreApi,
  type WorkWeeklyLiveSourceResponse
} from "@/lib/client/work-review-api";
import type { WorkProject } from "@/lib/domain/work-project";
import type {
  WorkWeeklyQaMessage,
  WorkWeeklyQaThread,
  WorkWeeklyReview,
  WorkWeeklyReviewItem,
  WorkWeeklyLatestGeneration,
  WorkWeeklyDisplayedGeneration,
  WorkWeeklySourceSummary
} from "@/lib/domain/work-weekly";

import { WorkReviewContext } from "./work-review-shell";
import {
  WorkWeeklyPage,
  workWeeklyShiftWeek
} from "./work-weekly-page";

const navigation = vi.hoisted(() => ({
  pathname: "/work-review/weekly",
  router: { push: vi.fn(), replace: vi.fn() },
  search: new URLSearchParams("weekStart=2026-08-31&scope=all")
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => navigation.router,
  useSearchParams: () => navigation.search
}));

const capabilities: WorkReviewCapabilities = {
  projects: true,
  weekly: true,
  weeklyAi: true,
  weeklyVerifier: true,
  weeklyQa: true,
  weeklyQaVerifier: true
};

const featureFlags = {
  analysisEnabled: true,
  followUpEnabled: true,
  todoEnabled: true,
  todoMeetingProjectionEnabled: true,
  uploadEnabled: true,
  verifierEnabled: true
} as const;

const summary: WorkWeeklySourceSummary = {
  meetingCount: 2,
  findingCount: 3,
  todoCount: 4,
  todoEventCount: 5,
  evidenceCount: 6,
  projectCount: 1,
  pendingCandidateCount: 7,
  includedFindingCount: 3,
  includedTodoCount: 4,
  includedTodoEventCount: 5,
  includedEvidenceCount: 6,
  omittedFindingCount: 0,
  omittedTodoCount: 0,
  omittedTodoEventCount: 0,
  omittedEvidenceCount: 0,
  truncated: false,
  historyCompleteness: "exact"
};

function project(): WorkProject {
  return {
    contractVersion: 1,
    id: "wrp_alpha",
    accountId: "account_1",
    name: "Alpha 发布",
    description: null,
    status: "active",
    version: 1,
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-01T08:00:00.000Z",
    archivedAt: null
  };
}

function review(overrides: Partial<WorkWeeklyReview> = {}): WorkWeeklyReview {
  return {
    contractVersion: 1,
    id: "wrw_1",
    accountId: "account_1",
    scope: {
      weekStart: "2026-08-31",
      weekEnd: "2026-09-06",
      observedThrough: "2026-09-03",
      windowComplete: false,
      timeZone: "Asia/Shanghai",
      scopeKind: "all",
      projectId: null
    },
    status: "ready",
    sourceSnapshotDigest: "a".repeat(64),
    sourceSummary: summary,
    currentSystemVersion: 1,
    currentRunVersion: 1,
    version: 1,
    generatedAt: "2026-09-03T08:00:00.000Z",
    updatedAt: "2026-09-03T08:00:00.000Z",
    deletedAt: null,
    ...overrides
  };
}

function item(overrides: Partial<WorkWeeklyReviewItem> = {}): WorkWeeklyReviewItem {
  return {
    contractVersion: 1,
    id: "wrwi_1",
    accountId: "account_1",
    weeklyReviewId: "wrw_1",
    section: "overview",
    origin: "gpt",
    systemText: "有效概览",
    userText: null,
    sourceRefs: ["evidence:publication_1:segment_1"],
    verificationState: "verified",
    sortOrder: 0,
    systemVersion: 1,
    version: 1,
    userEditedAt: null,
    hiddenAt: null,
    invalidatedAt: null,
    createdAt: "2026-09-03T08:00:00.000Z",
    updatedAt: "2026-09-03T08:00:00.000Z",
    ...overrides
  };
}

function thread(): WorkWeeklyQaThread {
  return {
    id: "wrqt_1",
    accountId: "account_1",
    weeklyReviewId: "wrw_1",
    sourceSnapshotDigest: "a".repeat(64),
    version: 4,
    createdAt: "2026-09-03T08:00:00.000Z",
    updatedAt: "2026-09-03T08:00:00.000Z",
    clearedAt: null
  };
}

function qaMessage(overrides: Partial<WorkWeeklyQaMessage> = {}): WorkWeeklyQaMessage {
  return {
    id: "wrqm_1",
    accountId: "account_1",
    weeklyReviewId: "wrw_1",
    threadId: "wrqt_1",
    role: "assistant",
    text: "有来源的回答",
    answerStatus: "answered",
    sourceRefs: ["evidence:publication_1:segment_1"],
    sourceSnapshotDigest: "a".repeat(64),
    providerProfile: "weekly-provider-v1",
    promptVersion: "weekly-qa-v1",
    verifierProfile: "weekly-verifier-v1",
    version: 1,
    createdAt: "2026-09-03T08:00:00.000Z",
    invalidatedAt: null,
    ...overrides
  };
}

function api(overrides: Partial<WorkReviewV2CoreApi> = {}): WorkReviewV2CoreApi {
  const currentReview = review();
  const currentItems = [item()];
  return {
    getCurrentUser: vi.fn(),
    logout: vi.fn(),
    getRuntimeConfig: vi.fn(),
    getCapabilities: vi.fn().mockResolvedValue(capabilities),
    listMeetings: vi.fn(),
    listMeetingsByProject: vi.fn(),
    uploadMeeting: vi.fn(),
    getMeeting: vi.fn(),
    retryMeeting: vi.fn(),
    reviewCandidate: vi.fn(),
    updateSpeakerAlias: vi.fn(),
    completeMeeting: vi.fn(),
    deleteMeeting: vi.fn(),
    setMeetingProjects: vi.fn(),
    getMeetingFollowUp: vi.fn(),
    generateMeetingFollowUp: vi.fn(),
    updateMeetingFollowUp: vi.fn(),
    resetMeetingFollowUp: vi.fn(),
    listTodos: vi.fn(),
    listTodosByProject: vi.fn(),
    createTodo: vi.fn(),
    createTodoFromFinding: vi.fn(),
    getTodo: vi.fn(),
    updateTodo: vi.fn(),
    completeTodo: vi.fn(),
    reopenTodo: vi.fn(),
    setTodoMyDay: vi.fn(),
    removeTodoMyDay: vi.fn(),
    deleteTodo: vi.fn(),
    getTodoSource: vi.fn(),
    setTodoProjects: vi.fn(),
    listProjects: vi.fn().mockResolvedValue([project()]),
    getProject: vi.fn(),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    getWeeklyReview: vi.fn().mockResolvedValue({ review: currentReview, items: currentItems, sourceSummary: summary }),
    generateWeeklyReview: vi.fn(),
    getWeeklyReviewDetail: vi.fn().mockResolvedValue({ review: currentReview, items: currentItems, sourceSummary: summary }),
    regenerateWeeklyReview: vi.fn(),
    updateWeeklyItem: vi.fn(),
    createWeeklyUserNote: vi.fn(),
    deleteWeeklyUserNote: vi.fn(),
    resetWeeklyReview: vi.fn(),
    deleteWeeklyReview: vi.fn(),
    getWeeklyQa: vi.fn().mockResolvedValue(null),
    askWeeklyQa: vi.fn(),
    clearWeeklyQa: vi.fn(),
    getWeeklySource: vi.fn(),
    ...overrides
  } as WorkReviewV2CoreApi;
}

function weeklyElement(client: WorkReviewApi, nextCapabilities: WorkReviewCapabilities = capabilities) {
  return (
    <WorkReviewContext.Provider value={{
      api: client,
      capabilities: nextCapabilities,
      capabilitiesStatus: "ready",
      featureFlags,
      refreshCapabilities: vi.fn(),
      user: { id: "account_1", email: "person@example.com", name: "Person" }
    }}>
      <WorkWeeklyPage />
    </WorkReviewContext.Provider>
  );
}

function renderWeekly(client: WorkReviewApi, nextCapabilities: WorkReviewCapabilities = capabilities) {
  return render(weeklyElement(client, nextCapabilities));
}

beforeEach(() => {
  navigation.search = new URLSearchParams("weekStart=2026-08-31&scope=all");
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) }
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Work Review Weekly UI", () => {
  it.each(["ready", "failed", "queued"] as const)("preserves displayed partial quality and copy when the latest status is %s", async (status) => {
    const displayedGeneration: WorkWeeklyDisplayedGeneration = {
      runId: "published_run", runVersion: 2, systemVersion: 1, qualityStatus: "needs_review",
      reviewIssues: [
        { sourceRef: "evidence:publication_1:segment_1", reasonCode: "missing_key_content" },
        { sourceRef: null, reasonCode: "source_unavailable" }
      ]
    };
    const partial = {
      review: review({ status }), sourceSummary: summary, displayedGeneration,
      latestGeneration: { runId: status === "ready" ? "published_run" : "later_run", runVersion: status === "ready" ? 2 : 3, executionStatus: status === "ready" ? "completed" : status === "failed" ? "failed" : "pending", qualityStatus: status === "ready" ? "needs_review" : "not_assessed", sourceCheckStatus: status === "ready" ? "completed" : "not_established", reviewIssues: status === "ready" ? displayedGeneration.reviewIssues : [], displayingPreviousVersion: status !== "ready", errorCode: null },
      items: [item({ userText: "我的可用改文", userEditedAt: "2026-09-10T08:00:00.000Z" }), item({ id: "invalid", verificationState: "invalidated", invalidatedAt: "2026-09-10T08:00:00.000Z", systemText: "不确定的正文不能恢复" })]
    };
    const getWeeklySource = vi.fn().mockRejectedValue(new WorkReviewApiError(410, "source_unavailable"));
    const client = api({ getWeeklyReview: vi.fn().mockResolvedValue(partial), getWeeklyReviewDetail: vi.fn().mockResolvedValue(partial), getWeeklySource });
    renderWeekly(client);
    const notice = (await screen.findByRole("heading", { name: "已生成，部分内容待核对" })).closest("section")!;
    expect(screen.getByText("我的可用改文")).toBeVisible();
    expect(screen.queryByText("不确定的正文不能恢复")).not.toBeInTheDocument();
    expect(screen.queryByText(/这份回顾尚未评估完整性/u)).not.toBeInTheDocument();
    if (status === "ready") expect(screen.queryByText("本次生成未完成")).not.toBeInTheDocument();
    else expect(screen.getByText(status === "failed" ? "本次生成未完成" : "等待生成本周回顾")).toBeVisible();
    const toggle = within(notice).getByRole("button", { name: "查看待核对事项（2）" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(within(notice).getByText("这条来源的重要内容尚未完整纳入回顾。")).toBeVisible();
    expect(within(notice).getByText("原来源已不可用，相关事项仍待核对。")).toBeVisible();
    expect(within(notice).getAllByRole("button", { name: /查看事项.*的原始记录/u })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0]).toMatch(/^已生成，部分内容待核对\n/u);
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0]).toContain("我的可用改文");
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0]).not.toContain("不确定的正文不能恢复");
    if (status !== "ready") {
      fireEvent.click(screen.getByRole("button", { name: status === "failed" ? "载入最新状态" : "刷新状态" }));
      await waitFor(() => expect(client.getWeeklyReviewDetail).toHaveBeenCalled());
      expect(within(notice).getByRole("button", { name: "收起待核对事项（2）" })).toHaveAttribute("aria-expanded", "true");
    }
    fireEvent.click(within(notice).getByRole("button", { name: "查看事项 1 的原始记录" }));
    await waitFor(() => expect(getWeeklySource).toHaveBeenCalledWith("wrw_1", "evidence:publication_1:segment_1", expect.any(AbortSignal)));
    expect(client.generateWeeklyReview).not.toHaveBeenCalled();
    expect(client.regenerateWeeklyReview).not.toHaveBeenCalled();
  });

  it("uses displayed passed quality independently of a later unassessed attempt", async () => {
    renderWeekly(api({ getWeeklyReview: vi.fn().mockResolvedValue({ review: review(), items: [item()], sourceSummary: summary,
      displayedGeneration: { runId: "published", runVersion: 1, systemVersion: 1, qualityStatus: "passed", reviewIssues: [] },
      latestGeneration: { runId: "later", runVersion: 2, executionStatus: "completed", sourceCheckStatus: "completed", qualityStatus: "not_assessed", reviewIssues: [], displayingPreviousVersion: true, errorCode: null }
    }) }));
    expect(await screen.findByText("有效概览")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "已生成，部分内容待核对" })).not.toBeInTheDocument();
    expect(screen.queryByText(/这份回顾尚未评估完整性/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("本周概览\n- 有效概览"));
  });

  it.each([
    { status: "failed", executionStatus: "failed", qualityStatus: "not_assessed", title: "本次生成未完成" },
    { status: "failed", executionStatus: "completed", qualityStatus: "insufficient", title: "本次回顾内容不完整" },
    { status: "generating", executionStatus: "running", qualityStatus: "not_assessed", title: "正在生成本周回顾" },
    { status: "failed", executionStatus: "unknown", qualityStatus: "not_assessed", title: "本次生成结果尚未确认" }
  ] as const)("keeps usable previous content during $executionStatus / $qualityStatus", async ({ status, executionStatus, qualityStatus, title }) => {
    const latestGeneration: WorkWeeklyLatestGeneration = { runId: "run_latest", runVersion: 3, executionStatus, sourceCheckStatus: qualityStatus === "insufficient" ? "completed" : "not_established", qualityStatus, reviewIssues: [], displayingPreviousVersion: true, errorCode: "weekly_untrusted_error_detail" };
    const response = {
      review: review({ status }), latestGeneration, sourceSummary: summary,
      items: [
        item({ userText: "保留我修改的内容", userEditedAt: "2026-09-09T08:00:00.000Z" }),
        item({ id: "note", origin: "user_note", systemText: null, userText: "个人补充独立保留", verificationState: "user_authored", systemVersion: null, sourceRefs: [] }),
        item({ id: "hidden", systemText: "已隐藏旧文", hiddenAt: "2026-09-09T08:00:00.000Z" }),
        item({ id: "invalid", systemText: "失效旧文不恢复", verificationState: "invalidated", invalidatedAt: "2026-09-09T08:00:00.000Z" })
      ]
    };
    const client = api({ getWeeklyReview: vi.fn().mockResolvedValue(response), getWeeklyReviewDetail: vi.fn().mockResolvedValue(response) });
    renderWeekly(client);
    expect(await screen.findByText(title)).toBeVisible();
    expect(screen.getByText(/之前的回顾已保留，仅显示当前可用内容/u)).toBeVisible();
    expect(screen.getByText("保留我修改的内容")).toBeVisible();
    expect(screen.getByText("个人补充独立保留")).toBeVisible();
    expect(screen.queryByText("失效旧文不恢复")).not.toBeInTheDocument();
    expect(screen.queryByText("weekly_untrusted_error_detail")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0];
    expect(copied).toContain("保留我修改的内容");
    expect(copied).toContain("个人补充独立保留");
    expect(copied).not.toMatch(/已隐藏旧文|失效旧文/u);
    if (status === "generating") expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
    const row = screen.getByText("保留我修改的内容").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("编辑回顾内容"), { target: { value: "尚未保存的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: status === "generating" ? "刷新状态" : "载入最新状态" }));
    await waitFor(() => expect(client.getWeeklyReviewDetail).toHaveBeenCalled());
    expect(screen.getByLabelText("编辑回顾内容")).toHaveValue("尚未保存的草稿");
    expect(client.generateWeeklyReview).not.toHaveBeenCalled();
    expect(client.regenerateWeeklyReview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "问问本周" }));
    expect(await screen.findByLabelText("继续问这一周")).toBeDisabled();
  });

  it("shows an honest fresh quality failure while preserving personal notes and verifier isolation", async () => {
    renderWeekly(api({ getWeeklyReview: vi.fn().mockResolvedValue({
      review: review({ status: "failed", currentSystemVersion: 0 }), sourceSummary: summary,
      latestGeneration: { runId: "fresh_run", runVersion: 1, executionStatus: "completed", sourceCheckStatus: "completed", qualityStatus: "insufficient", displayingPreviousVersion: false, errorCode: "weekly_generation_quality_insufficient" },
      items: [item({ systemText: "未核验正文不能泄露" }), item({ id: "note", origin: "user_note", userText: "只有我的补充", systemText: null, verificationState: "user_authored", systemVersion: null, sourceRefs: [] })]
    }) }), { ...capabilities, weeklyVerifier: false });
    expect(await screen.findByText("本次回顾内容不完整")).toBeVisible();
    expect(screen.getByText("当前没有可展示的系统回顾")).toBeVisible();
    expect(screen.getByText("只有我的补充")).toBeVisible();
    expect(screen.queryByText("未核验正文不能泄露")).not.toBeInTheDocument();
    expect(screen.queryByText(/之前的回顾已保留/u)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "增加个人补充" })).toBeEnabled();
  });

  it("does not present historical completed generation as completeness approval", async () => {
    renderWeekly(api({ getWeeklyReview: vi.fn().mockResolvedValue({ review: review(), items: [item()], sourceSummary: summary,
      latestGeneration: { runId: "old_run", runVersion: 1, executionStatus: "completed", sourceCheckStatus: "completed", qualityStatus: "not_assessed", displayingPreviousVersion: false, errorCode: null }
    }) }));
    expect(await screen.findByText(/这份回顾尚未评估完整性/u)).toBeVisible();
    expect(screen.getByText("有效概览")).toBeVisible();
    expect(screen.getByText("来源已核对")).toBeVisible();
    expect(screen.queryByText(/质量通过|完整性已通过/u)).not.toBeInTheDocument();
  });

  it("uses precise AI section and source-status copy while preserving user text", async () => {
    const records = [
      item({ id: "legacy", section: "next_week", systemText: "GPT 建议关注：核对范围；正文中的 GPT 保持不变。" }),
      item({ id: "edited", section: "next_week", systemText: "GPT 建议关注：旧系统", userText: "GPT 建议关注：我的改文", userEditedAt: "2026-09-09T08:00:00.000Z" }),
      item({ id: "note", section: "next_week", origin: "user_note", systemText: null, userText: "GPT 建议关注：个人笔记", verificationState: "user_authored", systemVersion: null }),
      item({ id: "qualified", verificationState: "qualified", systemText: "限定来源支持" }),
      item({ id: "other_section", section: "decisions", systemText: "GPT 建议关注：其他区块原样" }),
      item({ id: "not_prefix", section: "next_week", systemText: "说明：GPT 建议关注：不是开头" }),
      item({ id: "hidden_legacy", section: "next_week", systemText: "GPT 建议关注：隐藏旧条目", hiddenAt: "2026-09-09T08:00:00.000Z" }),
      item({ id: "empty_edit", section: "next_week", systemText: "GPT 建议关注：不应覆盖空改文", userText: "" })
    ];
    renderWeekly(api({ getWeeklyReview: vi.fn().mockResolvedValue({ review: review(), items: records, sourceSummary: summary }) }));
    expect(await screen.findByRole("heading", { name: "AI建议关注" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "下周关注" })).not.toBeInTheDocument();
    expect(screen.getByText("AI 建议，不是承诺")).toBeVisible();
    expect(screen.getAllByText("来源已核对").length).toBeGreaterThan(0);
    expect(screen.queryByText("已核对", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText("经限定核对")).toBeVisible();
    expect(screen.getByText("用户编辑")).toBeVisible();
    expect(screen.getByText(/来源核对仅检查原始记录/u)).toBeVisible();
    const legacyText = "AI建议关注：核对范围；正文中的 GPT 保持不变。";
    const legacy = screen.getByText(legacyText).closest("li")!;
    expect(screen.getByText("AI建议关注：隐藏旧条目")).toBeVisible();
    expect(screen.queryByText(/不应覆盖空改文/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0];
    expect(copied).toContain(`AI建议关注\n- ${legacyText}`);
    expect(copied).toContain("GPT 建议关注：我的改文");
    expect(copied).toContain("GPT 建议关注：个人笔记");
    expect(copied).toContain("GPT 建议关注：其他区块原样");
    expect(copied).toContain("说明：GPT 建议关注：不是开头");
    expect(copied).not.toContain("隐藏旧条目");
    expect(records[0]!.systemText).toBe("GPT 建议关注：核对范围；正文中的 GPT 保持不变。");
    fireEvent.click(within(legacy).getByRole("button", { name: "编辑" }));
    expect(screen.getByLabelText("编辑回顾内容")).toHaveValue(legacyText);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "增加个人补充" }));
    expect(screen.getByRole("option", { name: "AI建议关注" })).toBeInTheDocument();
  });

  it("replaces internal item version labels with a retained-content notice", async () => {
    const old = item({ systemVersion: 0, version: 0, userText: "保留我的旧版改文", userEditedAt: "2026-09-03T08:00:00.000Z" });
    renderWeekly(api({ getWeeklyReview: vi.fn().mockResolvedValue({ review: review({ currentSystemVersion: 2 }), items: [old], sourceSummary: summary }) }));
    expect(await screen.findByText("保留我的旧版改文")).toBeVisible();
    expect(screen.getByText("用户编辑")).toBeVisible();
    expect(screen.getByText("保留的旧版内容")).toBeVisible();
    expect(screen.queryByText(/^版本\s*\d+/u)).not.toBeInTheDocument();
  });
  it("uses URL scope as authority and renders exact source coverage without invalidated copy", async () => {
    navigation.search = new URLSearchParams("weekStart=2026-08-31&scope=project&projectId=wrp_alpha");
    const projectReview = review({
      scope: { ...review().scope, scopeKind: "project", projectId: "wrp_alpha" }
    });
    const getWeeklyReview = vi.fn<WorkReviewV2CoreApi["getWeeklyReview"]>().mockResolvedValue({
      review: projectReview,
      items: [
        item(),
        item({ id: "wrwi_completed", section: "completed", systemText: "已在系统标记完成" }),
        item({
          id: "wrwi_invalidated",
          section: "decisions",
          systemText: "不得泄露的失效正文",
          verificationState: "invalidated",
          invalidatedAt: "2026-09-03T09:00:00.000Z"
        })
      ],
      sourceSummary: summary
    });

    renderWeekly(api({ getWeeklyReview }));

    expect(await screen.findByText("有效概览")).toBeVisible();
    expect(getWeeklyReview).toHaveBeenCalledWith(expect.objectContaining({
      weekStart: "2026-08-31",
      scopeKind: "project",
      projectId: "wrp_alpha",
      timeZone: expect.any(String)
    }), expect.any(AbortSignal));
    expect(screen.getByRole("heading", { name: "本周标记完成的待办" })).toBeVisible();
    expect(screen.getByText("待确认结果")).toBeVisible();
    expect(screen.getByText("7")).toBeVisible();
    expect(screen.getByText("当前周数据截至 2026-09-03；本周尚未结束。")).toBeVisible();
    expect(screen.queryByText("不得泄露的失效正文")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "关键决定与变化" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "项目范围" })).toHaveValue("project:wrp_alpha");
  });

  it("never leaks unverified GPT text through visible, hidden, or clipboard surfaces", async () => {
    const verifierOff = { ...capabilities, weeklyVerifier: false };
    const getWeeklyReview = vi.fn<WorkReviewV2CoreApi["getWeeklyReview"]>().mockResolvedValue({
      review: review(),
      items: [
        item({ id: "wrwi_visible_gpt", systemText: "未核验可见泄露" }),
        item({ id: "wrwi_hidden_gpt", systemText: "未核验隐藏泄露", hiddenAt: "2026-09-03T09:00:00.000Z" }),
        item({
          id: "wrwi_note",
          origin: "user_note",
          systemText: null,
          userText: "用户明确补充",
          sourceRefs: [],
          verificationState: "user_authored",
          systemVersion: null
        })
      ],
      sourceSummary: summary
    });
    renderWeekly(api({ getWeeklyReview }), verifierOff);

    expect(await screen.findByText("用户明确补充")).toBeVisible();
    expect(screen.queryByText("未核验可见泄露")).not.toBeInTheDocument();
    expect(screen.queryByText("未核验隐藏泄露")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "已隐藏内容" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("用户明确补充")));
    expect(navigator.clipboard.writeText).not.toHaveBeenCalledWith(expect.stringContaining("未核验"));
  });

  it("refetches detail after an item mutation before using the review version for a note", async () => {
    const initialItem = item({ systemText: "修改前内容" });
    const editedItem = item({ userText: "修改后内容", version: 2, userEditedAt: "2026-09-03T10:00:00.000Z" });
    const refreshedReview = review({ version: 2 });
    const updateWeeklyItem = vi.fn<WorkReviewV2CoreApi["updateWeeklyItem"]>().mockResolvedValue(editedItem);
    const createWeeklyUserNote = vi.fn<WorkReviewV2CoreApi["createWeeklyUserNote"]>().mockResolvedValue(item({
      id: "wrwi_note",
      origin: "user_note",
      systemText: null,
      userText: "补充",
      sourceRefs: [],
      verificationState: "user_authored",
      systemVersion: null
    }));
    const getWeeklyReviewDetail = vi.fn<WorkReviewV2CoreApi["getWeeklyReviewDetail"]>().mockResolvedValue({
      review: refreshedReview,
      items: [editedItem],
      sourceSummary: summary
    });
    renderWeekly(api({
      createWeeklyUserNote,
      getWeeklyReview: vi.fn().mockResolvedValue({ review: review(), items: [initialItem], sourceSummary: summary }),
      getWeeklyReviewDetail,
      updateWeeklyItem
    }));

    const row = (await screen.findByText("修改前内容")).closest("li");
    expect(row).not.toBeNull();
    fireEvent.click(within(row!).getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("编辑回顾内容"), { target: { value: "修改后内容" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() => expect(screen.queryByLabelText("编辑回顾内容")).not.toBeInTheDocument());
    expect(screen.getByText("修改后内容")).toBeVisible();
    expect(getWeeklyReviewDetail).toHaveBeenCalledWith("wrw_1");
    fireEvent.click(screen.getByRole("button", { name: "增加个人补充" }));
    fireEvent.change(screen.getByLabelText("补充内容"), { target: { value: "补充" } });
    fireEvent.click(screen.getByRole("button", { name: "保存补充" }));
    await waitFor(() => expect(createWeeklyUserNote).toHaveBeenCalledWith("wrw_1", expect.objectContaining({
      expectedVersion: 2,
      text: "补充"
    })));
  });

  it("keeps QA persistent while suppressing unverified and invalidated answer bodies", async () => {
    const qaThread = thread();
    const messages = [
      qaMessage({ id: "wrqm_user", role: "user", text: "这周完成了什么？", answerStatus: null, sourceRefs: [], providerProfile: null, promptVersion: null, verifierProfile: null }),
      qaMessage(),
      qaMessage({ id: "wrqm_unverified", text: "未经过逐条核验的回答", verifierProfile: null }),
      qaMessage({ id: "wrqm_insufficient", text: null, answerStatus: "insufficient_evidence", sourceRefs: [], verifierProfile: null }),
      qaMessage({ id: "wrqm_failed", text: "内部失败正文", answerStatus: "failed", sourceRefs: [], verifierProfile: null }),
      qaMessage({ id: "wrqm_invalid", text: "失效回答正文", answerStatus: "invalidated", invalidatedAt: "2026-09-03T09:00:00.000Z" }),
      qaMessage({ id: "wrqm_old", text: "旧版本但已核验", sourceSnapshotDigest: "b".repeat(64), sourceRefs: [] })
    ];
    const sourceResponse: WorkWeeklyLiveSourceResponse = {
      identity: {
        sourceRef: "evidence:publication_1:segment_1",
        sourceKind: "evidence",
        sourceId: "segment_1",
        version: null,
        digest: "c".repeat(64),
        publicationId: "publication_1",
        segmentId: "segment_1",
        included: true
      },
      source: {
        sourceRef: "evidence:publication_1:segment_1",
        publicationId: "publication_1",
        publicationDigest: "c".repeat(64),
        meetingId: "meeting/1",
        segmentId: "segment_1",
        startSeconds: 12,
        endSeconds: 18,
        rawSpeakerLabel: "Speaker 1",
        timestampQuality: "provider_exact",
        text: "这是会议中的原话。"
      }
    };
    const getWeeklyQa = vi.fn<WorkReviewV2CoreApi["getWeeklyQa"]>().mockResolvedValue({ thread: qaThread, messages });
    const getWeeklySource = vi.fn<WorkReviewV2CoreApi["getWeeklySource"]>().mockResolvedValue(sourceResponse);
    const clearWeeklyQa = vi.fn<WorkReviewV2CoreApi["clearWeeklyQa"]>().mockResolvedValue(undefined);
    renderWeekly(api({ clearWeeklyQa, getWeeklyQa, getWeeklySource }));

    await screen.findByText("有效概览");
    fireEvent.click(screen.getByRole("tab", { name: "问问本周" }));

    expect(await screen.findByText("有来源的回答")).toBeVisible();
    expect(screen.queryByText("未经过逐条核验的回答")).not.toBeInTheDocument();
    expect(screen.getByText("回答正文需要通过 Weekly QA Verifier 后才会显示。")).toBeVisible();
    expect(screen.getByText("在本周已确认的工作记录中，没有找到足够依据回答这个问题。")).toBeVisible();
    expect(screen.getByText("这轮回答没有完成。当前记录中没有可展示的回答正文。")).toBeVisible();
    expect(screen.queryByText("内部失败正文")).not.toBeInTheDocument();
    expect(screen.queryByText("失效回答正文")).not.toBeInTheDocument();
    expect(screen.getByText("基于旧的数据版本")).toBeVisible();

    fireEvent.click(screen.getAllByRole("button", { name: "来源 1" })[0]!);
    expect(await screen.findByText("这是会议中的原话。")).toBeVisible();
    expect(screen.getByRole("link", { name: "打开会议" })).toHaveAttribute("href", "/work-review/meetings/meeting%2F1");
    fireEvent.click(screen.getByRole("button", { name: "返回周回顾" }));

    fireEvent.click(screen.getByRole("button", { name: "清空记录" }));
    fireEvent.click(screen.getByRole("button", { name: "清空问答" }));
    await waitFor(() => expect(clearWeeklyQa).toHaveBeenCalledWith("wrw_1", expect.objectContaining({ expectedVersion: 4 })));
  });

  it("gates old QA immediately while a new URL scope is loading", async () => {
    const oldReview = review();
    let rejectNextScope!: (reason: unknown) => void;
    const nextScopeRequest = new Promise<never>((_resolve, reject) => {
      rejectNextScope = reject;
    });
    const getWeeklyReview = vi.fn<WorkReviewV2CoreApi["getWeeklyReview"]>()
      .mockResolvedValueOnce({ review: oldReview, items: [item()], sourceSummary: summary })
      .mockImplementationOnce(() => nextScopeRequest);
    const askWeeklyQa = vi.fn<WorkReviewV2CoreApi["askWeeklyQa"]>();
    const client = api({
      askWeeklyQa,
      getWeeklyQa: vi.fn().mockResolvedValue({ thread: thread(), messages: [qaMessage()] }),
      getWeeklyReview
    });
    const view = renderWeekly(client);

    await screen.findByText("有效概览");
    fireEvent.click(screen.getByRole("tab", { name: "问问本周" }));
    expect(await screen.findByText("有来源的回答")).toBeVisible();
    fireEvent.change(screen.getByLabelText("继续问这一周"), { target: { value: "旧范围草稿" } });

    navigation.search = new URLSearchParams("weekStart=2026-08-24&scope=unassigned");
    view.rerender(weeklyElement(client));

    expect(await screen.findByText("正在切换周回顾范围…")).toBeVisible();
    expect(screen.queryByText("有来源的回答")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("继续问这一周")).not.toBeInTheDocument();
    expect(askWeeklyQa).not.toHaveBeenCalled();

    rejectNextScope(new WorkReviewApiError(503, "weekly_review_unavailable"));
    expect(await screen.findByText("暂时无法读取周回顾")).toBeVisible();
    expect(screen.getByRole("button", { name: "重新加载" })).toBeVisible();
  });

  it("reorders only rendered user notes while Weekly Verifier is closed", async () => {
    const verifierOff = { ...capabilities, weeklyVerifier: false };
    const firstNote = item({
      id: "wrwi_note_a",
      origin: "user_note",
      systemText: null,
      userText: "第一条个人补充",
      sourceRefs: [],
      verificationState: "user_authored",
      sortOrder: 0,
      systemVersion: null
    });
    const hiddenGpt = item({ id: "wrwi_gpt_between", systemText: "不可见 GPT", sortOrder: 10 });
    const secondNote = item({
      id: "wrwi_note_b",
      origin: "user_note",
      systemText: null,
      userText: "第二条个人补充",
      sourceRefs: [],
      verificationState: "user_authored",
      sortOrder: 20,
      systemVersion: null
    });
    const updateWeeklyItem = vi.fn<WorkReviewV2CoreApi["updateWeeklyItem"]>()
      .mockImplementation(async (_reviewId, itemId, input) => item({
        ...(itemId === firstNote.id ? firstNote : secondNote),
        sortOrder: input.sortOrder ?? 0,
        version: 2
      }));
    const response = { review: review({ version: 2 }), items: [firstNote, hiddenGpt, secondNote], sourceSummary: summary };
    renderWeekly(api({
      getWeeklyReview: vi.fn().mockResolvedValue({ review: review(), items: [firstNote, hiddenGpt, secondNote], sourceSummary: summary }),
      getWeeklyReviewDetail: vi.fn().mockResolvedValue(response),
      updateWeeklyItem
    }), verifierOff);

    const secondRow = (await screen.findByText("第二条个人补充")).closest("li");
    expect(secondRow).not.toBeNull();
    fireEvent.click(within(secondRow!).getByRole("button", { name: "上移" }));

    await waitFor(() => expect(updateWeeklyItem).toHaveBeenNthCalledWith(1, "wrw_1", "wrwi_note_b", expect.objectContaining({
      sortOrder: 0
    })));
    expect(screen.queryByText("不可见 GPT")).not.toBeInTheDocument();
  });

  it("shows an explicit capability boundary without calling Weekly APIs", () => {
    const getWeeklyReview = vi.fn();
    renderWeekly(api({ getWeeklyReview }), { ...capabilities, weekly: false });

    expect(screen.getByText("周回顾暂未开放")).toBeVisible();
    expect(getWeeklyReview).not.toHaveBeenCalled();
  });

  it("shifts week keys without local-time drift", () => {
    expect(workWeeklyShiftWeek("2026-08-31", -1)).toBe("2026-08-24");
    expect(workWeeklyShiftWeek("2026-08-31", 1)).toBe("2026-09-07");
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function weeklyElement(client: WorkReviewApi, nextCapabilities: WorkReviewCapabilities = capabilities, accountId = "account_1") {
  return (
    <WorkReviewContext.Provider value={{
      api: client,
      capabilities: nextCapabilities,
      capabilitiesStatus: "ready",
      featureFlags,
      refreshCapabilities: vi.fn(),
      user: { id: accountId, email: "person@example.com", name: "Person" }
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Weekly reading layout interactions", () => {
  it("collapses detailed statistics while keeping omitted-source information visible", async () => {
    const limited = { ...summary, truncated: true, omittedFindingCount: 2 };
    renderWeekly(api({ getWeeklyReview: vi.fn().mockResolvedValue({ review: review(), items: [item()], sourceSummary: limited }) }));
    await screen.findByText("有效概览");
    expect(screen.getByText("原话证据")).not.toBeVisible();
    expect(screen.getByText(/服务端未纳入 2 项结果/u)).toBeVisible();
    fireEvent.click(screen.getByText("来源详情"));
    expect(screen.getByText("原话证据")).toBeVisible();
    expect(screen.getByText("待确认结果")).toBeVisible();
  });

  it("opens secondary actions on demand and restores focus on Escape without mutating", async () => {
    const client = api();
    renderWeekly(client);
    const row = (await screen.findByText("有效概览")).closest("li")!;
    expect(within(row).queryByRole("button", { name: "隐藏" })).not.toBeInTheDocument();
    const trigger = within(row).getByRole("button", { name: "更多条目操作" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(within(row).getByRole("button", { name: "上移" })).toBeDisabled();
    expect(within(row).getByRole("button", { name: "下移" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(client.updateWeeklyItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "更多回顾操作" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复系统版本" }));
    expect(screen.getByRole("dialog", { name: "恢复最近的系统版本？" })).toBeVisible();
    expect(client.resetWeeklyReview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("button", { name: "更多回顾操作" })).toHaveFocus();
  });

  it("keeps every original reference reachable through the compact source list", async () => {
    const refs = ["evidence:publication_1:segment_1", "evidence:publication_1:segment_2"];
    const client = api({ getWeeklyReview: vi.fn().mockResolvedValue({ review: review(), items: [item({ sourceRefs: refs })], sourceSummary: summary }), getWeeklySource: vi.fn().mockRejectedValue(new Error("fixture_source_unavailable")) });
    renderWeekly(client);
    await screen.findByText("有效概览");
    expect(client.getWeeklySource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "查看本条全部来源（2）" }));
    const sourceButton = screen.getByRole("button", { name: "来源 2" });
    sourceButton.focus();
    fireEvent.click(sourceButton);
    await waitFor(() => expect(client.getWeeklySource).toHaveBeenCalledWith("wrw_1", refs[1], expect.any(AbortSignal)));
    expect(await screen.findByText("这条来源暂时不可用")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "返回周回顾" }));
    expect(screen.getByRole("button", { name: "查看本条全部来源（2）" })).toHaveFocus();
  });

  it("hides and restores a row through the collapsed list without restoring invalidated text", async () => {
    const current = item();
    const invalid = item({ id: "invalid", systemText: "失效内容不可恢复", invalidatedAt: "2026-09-03T09:00:00.000Z", verificationState: "invalidated" });
    const client = api({
      getWeeklyReview: vi.fn().mockResolvedValue({ review: review(), items: [current, invalid], sourceSummary: summary }),
      getWeeklyReviewDetail: vi.fn().mockImplementation(async () => ({ review: review(), items: [current, invalid], sourceSummary: summary })),
      updateWeeklyItem: vi.fn().mockImplementation(async (_reviewId, _itemId, input) => {
        current.hiddenAt = input.hidden ? "2026-09-03T09:00:00.000Z" : null;
        current.version += 1;
        return { ...current };
      })
    });
    renderWeekly(client);
    const row = (await screen.findByText("有效概览")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "更多条目操作" }));
    fireEvent.click(within(row).getByRole("button", { name: "隐藏" }));
    const disclosure = await screen.findByText("已隐藏内容（1）");
    expect(screen.getByText("有效概览")).not.toBeVisible();
    fireEvent.click(disclosure);
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(screen.queryByText("已隐藏内容（1）")).not.toBeInTheDocument());
    expect(screen.getByText("有效概览")).toBeVisible();
    expect(screen.queryByText("失效内容不可恢复")).not.toBeInTheDocument();
    expect(client.updateWeeklyItem).toHaveBeenCalledTimes(2);
  });
});

describe("Weekly generation polling recovery", () => {
  it("backs off to thirty seconds without silently stopping a ten-minute queue", async () => {
    vi.useFakeTimers();
    const pending = { review: review({ status: "queued" }), items: [], sourceSummary: summary };
    const client = api({ getWeeklyReview: vi.fn().mockResolvedValue(pending), getWeeklyReviewDetail: vi.fn().mockResolvedValue(pending) });
    await act(async () => { renderWeekly(client); });
    for (let step = 0; step < 600; step++) await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    const calls = vi.mocked(client.getWeeklyReviewDetail).mock.calls.length;
    expect(calls).toBeGreaterThan(25);
    expect(calls).toBeLessThan(40);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(client.getWeeklyReviewDetail).toHaveBeenCalledTimes(calls + 1);
  });
  it("keeps checking through queued, generating and verifying until a late ready result", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const queued = review({ status: "queued", currentSystemVersion: 0 });
    const seen = new Set<string>();
    const client = api({
      getWeeklyReview: vi.fn().mockResolvedValue({ review: queued, items: [], sourceSummary: summary }),
      getWeeklyReviewDetail: vi.fn().mockImplementation(async () => {
        const elapsed = Date.now() - started;
        const status = elapsed < 25_000 ? "queued" : elapsed < 50_000 ? "generating" : elapsed < 80_000 ? "verifying" : "ready";
        seen.add(status);
        return { review: review({ status }), items: status === "ready" ? [item()] : [], sourceSummary: summary };
      })
    });
    await act(async () => { renderWeekly(client); });
    for (let step = 0; step < 110; step++) await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect([...seen]).toEqual(["queued", "generating", "verifying", "ready"]);
    expect(screen.getByText("有效概览")).toBeVisible();
    expect(vi.mocked(client.getWeeklyReviewDetail).mock.calls.length).toBeLessThan(20);
  });

  it.each(["scope", "account", "unmount"])("aborts an in-flight poll on %s and rejects its late response", async (change) => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const client = api({
      getWeeklyReview: vi.fn().mockResolvedValueOnce({ review: review({ status: "queued" }), items: [], sourceSummary: summary })
        .mockResolvedValue({ review: review({ id: "wrw_2" }), items: [item({ systemText: "当前范围内容" })], sourceSummary: summary }),
      getWeeklyReviewDetail: vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }))
    });
    let view!: ReturnType<typeof renderWeekly>;
    await act(async () => { view = renderWeekly(client); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
    const signal = vi.mocked(client.getWeeklyReviewDetail).mock.calls[0]![1]!;
    await act(async () => {
      if (change === "scope") {
        navigation.search = new URLSearchParams("weekStart=2026-09-07&scope=all");
        view.rerender(weeklyElement(client));
      } else if (change === "account") view.rerender(weeklyElement(client, capabilities, "account_2"));
      else view.unmount();
    });
    expect(signal.aborted).toBe(true);
    await act(async () => { finish({ review: review(), items: [item({ systemText: "旧范围晚到内容" })], sourceSummary: summary }); });
    expect(screen.queryByText("旧范围晚到内容")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(client.getWeeklyReviewDetail).toHaveBeenCalledTimes(1);
  });

  it("pauses hidden polling and resumes on return without an unbounded error retry loop", async () => {
    vi.useFakeTimers();
    const queued = review({ status: "queued" });
    const client = api({
      getWeeklyReview: vi.fn().mockResolvedValue({ review: queued, items: [], sourceSummary: summary }),
      getWeeklyReviewDetail: vi.fn().mockRejectedValue(new TypeError("offline"))
    });
    await act(async () => { renderWeekly(client); });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(client.getWeeklyReviewDetail).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    for (let step = 0; step < 60; step++) await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(client.getWeeklyReviewDetail).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/连续读取状态失败/u)).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(client.getWeeklyReviewDetail).toHaveBeenCalledTimes(3);
    vi.mocked(client.getWeeklyReviewDetail).mockResolvedValue({ review: queued, items: [], sourceSummary: summary });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "刷新状态" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
    expect(client.getWeeklyReviewDetail).toHaveBeenCalledTimes(5);
    visibility.mockRestore();
  });
  it("resumes a queued review on entry and observes a failure after a long queue", async () => {
    vi.useFakeTimers();
    const queued = review({ status: "queued", currentSystemVersion: 0 });
    const started = Date.now();
    const client = api({
      getWeeklyReview: vi.fn().mockResolvedValue({ review: queued, items: [], sourceSummary: summary }),
      getWeeklyReviewDetail: vi.fn().mockImplementation(async () => ({
        review: { ...queued, status: Date.now() - started >= 45_000 ? "failed" : "queued" },
        items: [], sourceSummary: summary
      }))
    });
    await act(async () => { renderWeekly(client); });
    for (let step = 0; step < 30; step++) await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByText("本次生成未完成")).toBeVisible();
    expect(client.getWeeklyReviewDetail).toHaveBeenCalled();
    const calls = vi.mocked(client.getWeeklyReviewDetail).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(client.getWeeklyReviewDetail).toHaveBeenCalledTimes(calls);
    expect(client.askWeeklyQa).not.toHaveBeenCalled();
  });
});

describe("Weekly supplied content semantics", () => {
  it("preserves formal/tentative decisions, change history and past checkpoints without inferring new facts", async () => {
    const texts = [
      "已确定：本轮仅交付检索功能。",
      "暂定方向：增加导出入口，评审后再决定。",
      "排期从周三调整至周五，原测试范围保持。",
      "联调已完成第一轮，剩余两个异常仍在排查。",
      "截至9月10日，9月9日检查点已过，后续结论尚未确认；建议先核对检查结果。"
    ];
    const sections = ["decisions", "decisions", "decisions", "in_progress", "next_week"] as const;
    const client = api({ getWeeklyReview: vi.fn().mockResolvedValue({
      review: review(), sourceSummary: summary,
      items: texts.map((text, index) => item({ id: `wrwi_semantics_${index}`, section: sections[index], systemText: text, sortOrder: index }))
    }) });
    renderWeekly(client);
    expect(await screen.findByText(texts[0])).toBeVisible();
    for (const text of texts) expect(screen.getByText(text)).toBeVisible();
    expect(screen.getByRole("heading", { name: "关键决定与变化" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "仍在进行" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "AI建议关注" })).toBeVisible();
    expect(screen.getAllByText("来源已核对")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0];
    for (const text of texts) expect(copied).toContain(text);
    expect(copied).not.toContain("将于9月9日");
    expect(client.generateWeeklyReview).not.toHaveBeenCalled();
  });
});

describe("Weekly QA fixed query window", () => {
  const question = () => qaMessage({ id: "wrqm_question", role: "user", text: "问题甲", answerStatus: null, sourceRefs: [] });
  const waiting = () => ({ thread: thread(), messages: [question()] });
  const queued = (): Awaited<ReturnType<WorkReviewV2CoreApi["askWeeklyQa"]>> => ({
    ...waiting(), reused: false,
    run: {
      id: "wrqr_1", accountId: "account_1", weeklyReviewId: "wrw_1", threadId: "wrqt_1", questionMessageId: "wrqm_question",
      runVersion: 1, state: "queued", sourceSnapshotDigest: "a".repeat(64), leaseOwner: null, leaseExpiresAt: null,
      providerProfile: null, promptVersion: null, verifierProfile: null, createdAt: "2026-09-15T00:00:00.000Z", completedAt: null, errorCode: null
    }
  });
  async function openQa(client: WorkReviewV2CoreApi) {
    let view!: ReturnType<typeof renderWeekly>;
    await act(async () => { view = renderWeekly(client); });
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "问问本周" })); });
    return view;
  }
  async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

  it("does not restart polling when the POST replay already contains this question's final result", async () => {
    vi.useFakeTimers();
    const replay = queued();
    replay.reused = true;
    replay.messages.push(qaMessage());
    const client = api({ getWeeklyQa: vi.fn().mockResolvedValue(null), askWeeklyQa: vi.fn().mockResolvedValue(replay) });
    await openQa(client);
    await act(async () => { fireEvent.change(screen.getByLabelText("继续问这一周"), { target: { value: "问题甲" } }); fireEvent.click(screen.getByRole("button", { name: "发送问题" })); });
    expect(screen.getByText("有来源的回答")).toBeVisible();
    await advance(90_000);
    expect(client.getWeeklyQa).toHaveBeenCalledTimes(1);
    expect(client.askWeeklyQa).toHaveBeenCalledTimes(1);
  });

  it("retains a POST failure and does not silently turn it into a read success", async () => {
    vi.useFakeTimers();
    const client = api({ getWeeklyQa: vi.fn().mockResolvedValue(null), askWeeklyQa: vi.fn().mockRejectedValue(new WorkReviewApiError(400, "invalid_request")) });
    await openQa(client);
    await act(async () => { fireEvent.change(screen.getByLabelText("继续问这一周"), { target: { value: "问题甲" } }); fireEvent.click(screen.getByRole("button", { name: "发送问题" })); });
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByLabelText("继续问这一周")).toHaveValue("问题甲");
    await advance(90_000);
    expect(client.getWeeklyQa).toHaveBeenCalledTimes(1);
    expect(client.askWeeklyQa).toHaveBeenCalledTimes(1);
  });

  it("stops after a deleted review response and keeps old content unavailable", async () => {
    vi.useFakeTimers();
    const client = api({ getWeeklyQa: vi.fn().mockResolvedValueOnce(waiting()).mockRejectedValue(new WorkReviewApiError(404, "not_found")) });
    await openQa(client);
    await advance(5_000);
    expect(screen.queryByText("问题甲")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更新结果" })).toBeEnabled();
    await advance(90_000);
    expect(client.getWeeklyQa).toHaveBeenCalledTimes(2);
  });

  it("aborts a submitted request on scope change so its late acknowledgement cannot start old polling", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const client = api({ getWeeklyQa: vi.fn().mockResolvedValue(null), askWeeklyQa: vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; })) });
    const view = await openQa(client);
    await act(async () => { fireEvent.change(screen.getByLabelText("继续问这一周"), { target: { value: "问题甲" } }); fireEvent.click(screen.getByRole("button", { name: "发送问题" })); });
    const signal = vi.mocked(client.askWeeklyQa).mock.calls[0]![2]!;
    await act(async () => {
      navigation.search = new URLSearchParams("weekStart=2026-08-24&scope=all");
      vi.mocked(client.getWeeklyReview).mockResolvedValue({ review: review({ id: "wrw_2" }), items: [], sourceSummary: summary });
      view.rerender(weeklyElement(client));
    });
    expect(signal.aborted).toBe(true);
    await act(async () => { finish(queued()); });
    await advance(90_000);
    expect(screen.queryByText("问题甲")).not.toBeInTheDocument();
    expect(vi.mocked(client.getWeeklyQa).mock.calls.filter(([id]) => id === "wrw_1")).toHaveLength(1);
  });

  it("queries every five seconds for a ninety-second wall-clock window and manual update uses GET only", async () => {
    vi.useFakeTimers();
    const getWeeklyQa = vi.fn<WorkReviewV2CoreApi["getWeeklyQa"]>().mockResolvedValueOnce(null).mockResolvedValue(waiting());
    const client = api({ getWeeklyQa, askWeeklyQa: vi.fn().mockResolvedValue(queued()) });
    await openQa(client);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("继续问这一周"), { target: { value: "问题甲" } });
      fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    });
    expect(client.askWeeklyQa).toHaveBeenCalledTimes(1);
    expect(getWeeklyQa).toHaveBeenCalledTimes(1);
    await advance(4_999);
    expect(getWeeklyQa).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(getWeeklyQa).toHaveBeenCalledTimes(2);
    for (let tick = 0; tick < 16; tick++) await advance(5_000);
    expect(getWeeklyQa).toHaveBeenCalledTimes(18); // Initial record read + ticks at 5..85 seconds.
    await advance(5_000);
    expect(screen.getByText(/本轮查询已满90秒/u)).toBeVisible();
    expect(screen.queryByText("这轮回答没有完成。当前记录中没有可展示的回答正文。")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更新结果" })).toBeEnabled();
    await advance(30_000);
    expect(getWeeklyQa).toHaveBeenCalledTimes(18);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "更新结果" })); });
    expect(getWeeklyQa).toHaveBeenCalledTimes(19);
    await advance(5_000);
    expect(getWeeklyQa).toHaveBeenCalledTimes(20);
    expect(client.askWeeklyQa).toHaveBeenCalledTimes(1);
  });

  it.each(["answered", "insufficient_evidence", "failed"] as const)("stops at the matching %s result without exposing failed text", async (answerStatus) => {
    vi.useFakeTimers();
    const client = api({ getWeeklyQa: vi.fn().mockResolvedValueOnce(waiting()).mockResolvedValue({ thread: thread(), messages: [question(), qaMessage({ answerStatus })] }) });
    await openQa(client);
    await advance(5_000);
    expect(screen.getByText("这轮问答结果已更新。")).toBeVisible();
    expect(screen.queryByText(/正在等待问答结果/u)).not.toBeInTheDocument();
    if (answerStatus === "answered") expect(screen.getByText("有来源的回答")).toBeVisible();
    else expect(screen.queryByText("有来源的回答")).not.toBeInTheDocument();
    await advance(90_000);
    expect(client.getWeeklyQa).toHaveBeenCalledTimes(2);
    expect(client.askWeeklyQa).not.toHaveBeenCalled();
  });

  it("does not mistake an older answer snapshot for the newly submitted question", async () => {
    vi.useFakeTimers();
    const client = api({
      getWeeklyQa: vi.fn().mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ thread: thread(), messages: [qaMessage({ text: "上一轮回答" })] })
        .mockResolvedValue({ thread: thread(), messages: [question(), qaMessage({ text: "当前问题回答" })] }),
      askWeeklyQa: vi.fn().mockResolvedValue(queued())
    });
    await openQa(client);
    await act(async () => { fireEvent.change(screen.getByLabelText("继续问这一周"), { target: { value: "问题甲" } }); fireEvent.click(screen.getByRole("button", { name: "发送问题" })); });
    await advance(5_000);
    expect(screen.getByText("问题甲")).toBeVisible();
    expect(screen.queryByText("上一轮回答")).not.toBeInTheDocument();
    expect(screen.getByText(/正在等待问答结果/u)).toBeVisible();
    await advance(5_000);
    expect(screen.getByText("当前问题回答")).toBeVisible();
  });

  it("never overlaps a hanging GET and aborts it at the actual deadline, ignoring its late answer", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const client = api({ getWeeklyQa: vi.fn().mockResolvedValueOnce(waiting()).mockImplementation(() => new Promise((resolve) => { finish = resolve; })) });
    await openQa(client);
    await advance(5_000);
    const signal = vi.mocked(client.getWeeklyQa).mock.calls[1]![1]!;
    expect(screen.getByRole("button", { name: "更新结果" })).toHaveAttribute("aria-busy", "true");
    await advance(84_999);
    expect(client.getWeeklyQa).toHaveBeenCalledTimes(2);
    expect(signal.aborted).toBe(false);
    await advance(1);
    expect(signal.aborted).toBe(true);
    expect(screen.getByText(/本轮查询已满90秒/u)).toBeVisible();
    await act(async () => { finish({ thread: thread(), messages: [question(), qaMessage({ text: "过期响应" })] }); });
    expect(screen.queryByText("过期响应")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更新结果" })).toBeEnabled();
  });

  it("pauses while hidden and reads immediately when visible again", async () => {
    vi.useFakeTimers();
    const client = api({ getWeeklyQa: vi.fn().mockResolvedValue(waiting()) });
    await openQa(client);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await advance(120_000);
    expect(client.getWeeklyQa).toHaveBeenCalledTimes(1);
    vi.mocked(client.getWeeklyQa).mockResolvedValue({ thread: thread(), messages: [question(), qaMessage()] });
    visibility.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(client.getWeeklyQa).toHaveBeenCalledTimes(2);
    expect(screen.getByText("有来源的回答")).toBeVisible();
    expect(client.askWeeklyQa).not.toHaveBeenCalled();
  });

  it("reads on QA re-entry and preserves the same-scope draft", async () => {
    vi.useFakeTimers();
    const client = api({ getWeeklyQa: vi.fn().mockResolvedValue(null) });
    await openQa(client);
    await act(async () => { fireEvent.change(screen.getByLabelText("继续问这一周"), { target: { value: "保留草稿" } }); fireEvent.click(screen.getByRole("tab", { name: "本周回顾" })); });
    await advance(60_000);
    expect(client.getWeeklyQa).toHaveBeenCalledTimes(1);
    vi.mocked(client.getWeeklyQa).mockResolvedValue(waiting());
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "问问本周" })); });
    expect(client.getWeeklyQa).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("继续问这一周")).toHaveValue("保留草稿");
    await advance(5_000);
    expect(client.getWeeklyQa).toHaveBeenCalledTimes(3);
  });

  it.each(["week", "project", "account", "unmount"])("aborts the QA read on %s and rejects its late response", async (change) => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const client = api({ getWeeklyQa: vi.fn().mockResolvedValueOnce(waiting()).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(null) });
    const view = await openQa(client);
    await advance(5_000);
    const signal = vi.mocked(client.getWeeklyQa).mock.calls[1]![1]!;
    await act(async () => {
      if (change === "unmount") view.unmount();
      else if (change === "account") view.rerender(weeklyElement(client, capabilities, "account_2"));
      else {
        navigation.search = new URLSearchParams(change === "week" ? "weekStart=2026-08-24&scope=all" : "weekStart=2026-08-31&scope=project&projectId=wrp_1");
        vi.mocked(client.getWeeklyReview).mockResolvedValue({ review: review({ id: "wrw_2" }), items: [], sourceSummary: summary });
        view.rerender(weeklyElement(client));
      }
    });
    expect(signal.aborted).toBe(true);
    await act(async () => { finish({ thread: thread(), messages: [question(), qaMessage({ text: "旧范围迟到答案" })] }); });
    expect(screen.queryByText("旧范围迟到答案")).not.toBeInTheDocument();
    expect(client.askWeeklyQa).not.toHaveBeenCalled();
  });

  it("clears with an in-flight read and never restores messages from that old response", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const client = api({
      getWeeklyQa: vi.fn().mockResolvedValueOnce(waiting()).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(null),
      clearWeeklyQa: vi.fn().mockResolvedValue(undefined)
    });
    await openQa(client);
    await advance(5_000);
    const signal = vi.mocked(client.getWeeklyQa).mock.calls[1]![1]!;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "清空记录" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "清空问答" })); });
    expect(signal.aborted).toBe(true);
    expect(screen.getByText("还没有问答记录")).toBeVisible();
    await act(async () => { finish({ thread: thread(), messages: [question(), qaMessage({ text: "清空前答案" })] }); });
    expect(screen.queryByText("清空前答案")).not.toBeInTheDocument();
    expect(screen.queryByText("问题甲")).not.toBeInTheDocument();
    expect(client.clearWeeklyQa).toHaveBeenCalledTimes(1);
  });

  it("does not hide a rejected clear operation behind a successful status GET", async () => {
    vi.useFakeTimers();
    const client = api({ getWeeklyQa: vi.fn().mockResolvedValue(waiting()), clearWeeklyQa: vi.fn().mockRejectedValue(new WorkReviewApiError(409, "version_conflict")) });
    await openQa(client);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "清空记录" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "清空问答" })); });
    await advance(5_000);
    expect(screen.getByRole("alert")).toHaveTextContent("内容已在其他页面更新");
    expect(screen.getByText("问题甲")).toBeVisible();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "更新结果" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("内容已在其他页面更新");
    expect(client.clearWeeklyQa).toHaveBeenCalledTimes(1);
  });
});

describe("Weekly QA source-backed status display", () => {
  const refs = ["1", "2", "3"].map((value) => `wrs_${value.repeat(64)}`);
  const raw = "核对匿名验收清单在本周范围内的观察截止状态为 open。\n本周系统记录中，核对匿名验收清单于合成日期被标记为 completed。\n本周系统记录中，核对匿名验收清单在标记 completed 后被重新打开为 open。";
  const translated = raw.replace("状态为 open", "状态为未完成").replace("被标记为 completed", "被标记为已完成")
    .replace("标记 completed 后被重新打开为 open", "标记完成后被重新打开为未完成");
  function source(index = 0): WorkWeeklyLiveSourceResponse {
    const state = { title: "核对匿名验收清单", kind: "self" as const, status: index === 1 ? "completed" as const : "open" as const,
      ownerLabel: null, currentDueDate: null, completedAt: null, deletedAt: null, version: 1 };
    return {
      identity: { sourceRef: refs[index], sourceKind: index === 0 ? "todo" : "todo_event", sourceId: `source_${index}`,
        version: 1, digest: "a".repeat(64), publicationId: null, segmentId: null, included: true },
      source: index === 0
        ? { sourceRef: refs[index], id: "todo_1", version: 1, current: state, stateAtWeekEnd: state, historyCompleteness: "exact",
          sourceMeetingId: null, sourceFindingId: null, sourceFindingKind: null, projects: [] }
        : { sourceRef: refs[index], id: `event_${index}`, todoId: "todo_1", eventType: index === 1 ? "todo.completed" : "todo.reopened",
          changedFields: ["status"], occurredAt: "2026-09-14T00:00:00.000Z", localDate: "2026-09-14", oldVersion: 1, newVersion: 2,
          stateAfter: state, historyCompleteness: "exact" }
    };
  }
  const answer = () => qaMessage({ text: raw, sourceRefs: [...refs] });
  async function open(client: WorkReviewV2CoreApi) {
    const view = renderWeekly(client);
    await screen.findByText("有效概览");
    fireEvent.click(screen.getByRole("tab", { name: "问问本周" }));
    return view;
  }

  it("renders all four v3 status words from existing source DTOs, deduplicates reads and keeps originals and source actions", async () => {
    const pending = new Map<string, (value: WorkWeeklyLiveSourceResponse) => void>();
    let waiting = true;
    const getWeeklySource = vi.fn<WorkReviewV2CoreApi["getWeeklySource"]>().mockImplementation(async (_, ref) => waiting
      ? new Promise((resolve) => { pending.set(ref, resolve); }) : source(refs.indexOf(ref)));
    const messages = [qaMessage({ id: "question", role: "user", text: "本周核对匿名验收清单在系统中是什么状态？", answerStatus: null, sourceRefs: [] }), answer(),
      qaMessage({ id: "second_question", role: "user", text: "再看一下系统状态", answerStatus: null, sourceRefs: [] }),
      qaMessage({ id: "second_answer", text: `再次核对：${raw}`, sourceRefs: [...refs] })];
    const original = structuredClone(messages);
    const client = api({ getWeeklyQa: vi.fn().mockImplementation(async () => ({ thread: thread(), messages: structuredClone(messages) })), getWeeklySource });
    await open(client);
    expect(await screen.findByText(raw.replaceAll("\n", " "))).toBeVisible();
    await waitFor(() => expect(getWeeklySource).toHaveBeenCalledTimes(3));
    await act(async () => { waiting = false; refs.forEach((ref, index) => pending.get(ref)!(source(index))); });
    expect(await screen.findByText(translated.replaceAll("\n", " "))).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "更新结果" }));
    await waitFor(() => expect(client.getWeeklyQa).toHaveBeenCalledTimes(2));
    expect(getWeeklySource).toHaveBeenCalledTimes(3);
    expect(messages).toEqual(original);
    fireEvent.click(screen.getAllByRole("button", { name: "来源 1" })[0]!);
    expect(await screen.findByRole("link", { name: "打开待办" })).toBeVisible();
    expect(getWeeklySource).toHaveBeenLastCalledWith("wrw_1", refs[0], expect.any(AbortSignal));
  });

  it("does not fetch metadata for ordinary, user, hidden, old-snapshot or failed answers", async () => {
    const variants = [
      qaMessage(), qaMessage({ role: "user", text: raw, answerStatus: null }),
      answer(), { ...answer(), verifierProfile: null }, { ...answer(), invalidatedAt: "2026-09-15T00:00:00.000Z" },
      { ...answer(), answerStatus: "failed" as const }, { ...answer(), answerStatus: "insufficient_evidence" as const },
      { ...answer(), sourceSnapshotDigest: "b".repeat(64) }
    ].map((message, index) => ({ ...message, id: `message_${index}`, ...(index === 2 ? { sourceRefs: [] } : {}) }));
    const client = api({ getWeeklyQa: vi.fn().mockResolvedValue({ thread: thread(), messages: variants }) });
    await open(client);
    await screen.findByText("有来源的回答");
    expect(client.getWeeklySource).not.toHaveBeenCalled();
  });

  it.each(["failure", "excluded", "mismatch"])("keeps raw text and avoids automatic retry when source metadata is %s", async (mode) => {
    const metadata = source();
    if (mode === "excluded") metadata.identity.included = false;
    if (mode === "mismatch") metadata.identity.sourceRef = "wrs_other";
    const getWeeklySource = mode === "failure" ? vi.fn().mockRejectedValue(new WorkReviewApiError(410, "source_unavailable")) : vi.fn().mockResolvedValue(metadata);
    const client = api({ getWeeklyQa: vi.fn().mockResolvedValue({ thread: thread(), messages: [{ ...answer(), sourceRefs: [refs[0]] }] }), getWeeklySource });
    await open(client);
    expect(await screen.findByText(raw.replaceAll("\n", " "))).toBeVisible();
    await waitFor(() => expect(getWeeklySource).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "更新结果" }));
    await waitFor(() => expect(client.getWeeklyQa).toHaveBeenCalledTimes(2));
    expect(getWeeklySource).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(translated.replaceAll("\n", " "))).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "来源 1" })).toBeEnabled();
  });

  it.each(["week", "project", "account", "thread", "unmount"])("cancels metadata on %s change and ignores the late result", async (change) => {
    let finish!: (value: WorkWeeklyLiveSourceResponse) => void;
    const getWeeklySource = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockRejectedValue(new Error("offline"));
    const client = api({ getWeeklyQa: vi.fn().mockResolvedValue({ thread: thread(), messages: [{ ...answer(), sourceRefs: [refs[0]] }] }), getWeeklySource });
    const view = await open(client);
    await waitFor(() => expect(getWeeklySource).toHaveBeenCalledTimes(1));
    const signal = getWeeklySource.mock.calls[0][2] as AbortSignal;
    await act(async () => {
      if (change === "unmount") view.unmount();
      else if (change === "account") view.rerender(weeklyElement(client, capabilities, "account_2"));
      else if (change === "thread") {
        vi.mocked(client.getWeeklyQa).mockResolvedValue({ thread: { ...thread(), id: "thread_new" }, messages: [{ ...answer(), threadId: "thread_new", sourceRefs: [refs[0]] }] });
        fireEvent.click(screen.getByRole("button", { name: "更新结果" }));
      } else {
        navigation.search = new URLSearchParams(change === "week" ? "weekStart=2026-08-24&scope=all" : "weekStart=2026-08-31&scope=project&projectId=wrp_1");
        vi.mocked(client.getWeeklyReview).mockResolvedValue({ review: review({ id: "wrw_2" }), items: [], sourceSummary: summary });
        view.rerender(weeklyElement(client));
      }
    });
    expect(signal.aborted).toBe(true);
    await act(async () => { finish(source()); });
    expect(screen.queryByText(translated.replaceAll("\n", " "))).not.toBeInTheDocument();
  });

  it("bounds a hanging metadata request without blocking the raw answer or accepting its late result", async () => {
    vi.useFakeTimers();
    let finish!: (value: WorkWeeklyLiveSourceResponse) => void;
    const getWeeklySource = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const client = api({ getWeeklyQa: vi.fn().mockResolvedValue({ thread: thread(), messages: [{ ...answer(), sourceRefs: [refs[0]] }] }), getWeeklySource });
    await act(async () => { renderWeekly(client); });
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "问问本周" })); });
    const signal = getWeeklySource.mock.calls[0][2] as AbortSignal;
    expect(screen.getByText(raw.replaceAll("\n", " "))).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "更新结果" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "来源 1" })).toBeEnabled();
    await act(async () => { finish(source()); });
    expect(screen.queryByText(translated.replaceAll("\n", " "))).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(getWeeklySource).toHaveBeenCalledTimes(1);
  });
});

describe("Work Review Weekly UI", () => {
  it.each(["ready", "failed", "queued"] as const)("shows available content without a manual review notice when the latest status is %s", async (status) => {
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
    expect(await screen.findByText("我的可用改文")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "已生成，部分内容待核对" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /查看待核对事项/u })).not.toBeInTheDocument();
    expect(screen.queryByText("不确定的正文不能恢复")).not.toBeInTheDocument();
    expect(screen.queryByText(/这份回顾尚未评估完整性/u)).not.toBeInTheDocument();
    if (status === "ready") expect(screen.queryByText("本次生成未完成")).not.toBeInTheDocument();
    else expect(screen.getByText(status === "failed" ? "本次生成未完成" : "等待生成本周回顾")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0]).not.toContain("部分内容待核对");
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0]).toContain("我的可用改文");
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0]).not.toContain("不确定的正文不能恢复");
    if (status !== "ready") {
      fireEvent.click(screen.getByRole("button", { name: status === "failed" ? "载入最新状态" : "刷新状态" }));
      await waitFor(() => expect(client.getWeeklyReviewDetail).toHaveBeenCalled());
      expect(screen.queryByRole("heading", { name: "已生成，部分内容待核对" })).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getAllByRole("button", { name: "来源 1" })[0]!);
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
    if (status === "generating") {
      fireEvent.click(screen.getByRole("button", { name: "更多回顾操作" }));
      expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
    }
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
    expect(screen.getByText("AI建议关注：隐藏旧条目")).not.toBeVisible();
    fireEvent.click(screen.getByText("已隐藏内容（1）"));
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
    fireEvent.click(screen.getByText("来源详情"));
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
      qaMessage({ id: "wrqm_user", role: "user", text: "待办当前状态为 open 是什么意思？", answerStatus: null, sourceRefs: [], providerProfile: null, promptVersion: null, verifierProfile: null }),
      qaMessage(),
      qaMessage({ id: "wrqm_status", text: "待办当前系统状态为 open。待办曾被标记为 completed。" }),
      qaMessage({ id: "wrqm_unverified", text: "未经过逐条核验的回答", verifierProfile: null }),
      qaMessage({ id: "wrqm_insufficient", text: null, answerStatus: "insufficient_evidence", sourceRefs: [], verifierProfile: null }),
      qaMessage({ id: "wrqm_failed", text: "内部失败正文", answerStatus: "failed", sourceRefs: [], verifierProfile: null }),
      qaMessage({ id: "wrqm_invalid", text: "失效回答正文", answerStatus: "invalidated", invalidatedAt: "2026-09-03T09:00:00.000Z" }),
      qaMessage({ id: "wrqm_old", text: "旧版本但已核验", sourceSnapshotDigest: "b".repeat(64), sourceRefs: [] })
    ];
    const originalMessages = structuredClone(messages);
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
        text: "这是会议中的原话。待办当前状态为 open。"
      }
    };
    const getWeeklyQa = vi.fn<WorkReviewV2CoreApi["getWeeklyQa"]>().mockResolvedValue({ thread: qaThread, messages });
    const getWeeklySource = vi.fn<WorkReviewV2CoreApi["getWeeklySource"]>().mockResolvedValue(sourceResponse);
    const clearWeeklyQa = vi.fn<WorkReviewV2CoreApi["clearWeeklyQa"]>().mockResolvedValue(undefined);
    renderWeekly(api({ clearWeeklyQa, getWeeklyQa, getWeeklySource }));

    await screen.findByText("有效概览");
    fireEvent.click(screen.getByRole("tab", { name: "问问本周" }));

    expect(await screen.findByText("有来源的回答")).toBeVisible();
    expect(screen.getByText("待办当前状态为 open 是什么意思？")).toBeVisible();
    expect(screen.getByText("待办当前系统状态为 open。待办曾被标记为 completed。")).toBeVisible();
    expect(messages).toEqual(originalMessages);
    expect(screen.queryByText("未经过逐条核验的回答")).not.toBeInTheDocument();
    expect(screen.getByText("回答正文需要通过 Weekly QA Verifier 后才会显示。")).toBeVisible();
    expect(screen.getByText("在本周已确认的工作记录中，没有找到足够依据回答这个问题。")).toBeVisible();
    expect(screen.getByText("这轮回答没有完成。当前记录中没有可展示的回答正文。")).toBeVisible();
    expect(screen.queryByText("内部失败正文")).not.toBeInTheDocument();
    expect(screen.queryByText("失效回答正文")).not.toBeInTheDocument();
    expect(screen.getByText("基于旧的数据版本")).toBeVisible();

    fireEvent.click(screen.getAllByRole("button", { name: "来源 1" })[0]!);
    expect(await screen.findByText("这是会议中的原话。待办当前状态为 open。")).toBeVisible();
    expect(screen.getByRole("link", { name: "打开会议" })).toHaveAttribute("href", "/work-review/meetings/meeting%2F1");
    fireEvent.click(screen.getByRole("button", { name: "返回周回顾" }));

    fireEvent.click(screen.getByRole("button", { name: "清空记录" }));
    fireEvent.click(screen.getByRole("button", { name: "清空问答" }));
    await waitFor(() => expect(clearWeeklyQa).toHaveBeenCalledWith("wrw_1", expect.objectContaining({ expectedVersion: 4 }), expect.any(AbortSignal)));
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
    fireEvent.click(within(secondRow!).getByRole("button", { name: "更多条目操作" }));
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

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkReviewApi,
  WorkReviewApiError,
  WorkMeetingDetailSchema,
  type WorkEvidenceView,
  type WorkMeetingCandidate,
  type WorkMeetingDetail,
  type WorkMeetingFinding,
  type WorkReviewApi,
  type WorkTodo
} from "@/lib/client/work-review-api";
import type { WorkProject } from "@/lib/domain/work-project";

import { WorkMeetingDetail as WorkMeetingDetailController, WorkMeetingDetailView } from "./work-meeting-detail";
import { WorkFindingTodoActions } from "./work-finding-todo-actions";
import { WorkTodoDialog } from "./work-todo-dialog";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

describe("Finding Todo confirmation quality", () => {
  it.each([false, true])("keeps the real create response reuse flag %s through the client", async (reused) => {
    const existing = workTodo();
    const client = createWorkReviewApi(vi.fn(async () => Response.json({ todo: existing, reused }, { status: reused ? 200 : 201 })));
    const result = await client.createTodoFromFinding("wrm_1", "finding_action", {
      operationKey: "projection_response_test", title: existing.title, kind: "self", ownerLabel: null,
      notes: null, currentDueDate: null, myDayDate: null, isImportant: false, ownershipOverrideConfirmed: false
    });
    expect(result).toEqual({ todo: existing, reused });
  });
  it("keeps edits when a parent rebuilds the same Finding and resets only after cancel and reopen", () => {
    const source = finding();
    const props = { finding: source, initialKind: "self" as const, mode: "projection" as const, onClose: vi.fn(), onSubmit: vi.fn(), open: true, today: "2026-09-14" };
    const view = render(<WorkTodoDialog {...props} />);
    const initialTitle = (screen.getByLabelText("标题") as HTMLInputElement).value;
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "本次编辑标题" } });
    fireEvent.change(screen.getByLabelText("备注"), { target: { value: "本次编辑备注" } });
    view.rerender(<WorkTodoDialog {...props} finding={{ ...source, evidence: [...source.evidence] }} />);
    expect(screen.getByLabelText("标题")).toHaveValue("本次编辑标题");
    expect(screen.getByLabelText("备注")).toHaveValue("本次编辑备注");
    view.rerender(<WorkTodoDialog {...props} open={false} />);
    view.rerender(<WorkTodoDialog {...props} />);
    expect(screen.getByLabelText("标题")).toHaveValue(initialTitle);
    expect(screen.getByLabelText("备注")).toHaveValue(source.body);
  });
  function renderActions(source: WorkMeetingFinding, overrides: Partial<WorkReviewApi> = {}) {
    const client = api(detail(), overrides);
    const onOpenTodo = vi.fn();
    const onCreated = vi.fn();
    render(<WorkFindingTodoActions api={client} finding={source} linkedTodo={null} meetingId="wrm_1" onCreated={onCreated} onOpenTodo={onOpenTodo} projectionEnabled />);
    return { client, onOpenTodo, onCreated };
  }

  it("shows source qualifications and leaves uncertain owner and date empty without guessing from raw date text", async () => {
    const { client } = renderActions(finding({ body: "核对清单；负责人待确认；截止时间待确认", originalDueExpression: "下周五前" }));
    fireEvent.click(screen.getByRole("button", { name: "设为等待他人" }));
    expect(screen.getByLabelText("负责人或等待对象")).toHaveValue("");
    expect(screen.getByLabelText("当前计划日期")).toHaveValue("");
    expect(screen.getByText("来源负责人：未确认")).toBeVisible();
    expect(screen.getByText("原始日期表述：下周五前")).toBeVisible();
    expect(screen.getByText("来源日期：待确认，不预填计划日期")).toBeVisible();
    fireEvent.submit(document.getElementById("work-todo-editor")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("请填写负责人或等待对象");
    expect(client.createTodoFromFinding).not.toHaveBeenCalled();
  });

  it("keeps a confirmed owner and converts the due instant to the Work Shanghai date", () => {
    renderActions(finding({ candidateOwner: "负责人甲", dueAt: "2026-09-04T16:30:00.000Z" }));
    fireEvent.click(screen.getByRole("button", { name: "设为等待他人" }));
    expect(screen.getByLabelText("负责人或等待对象")).toHaveValue("负责人甲");
    expect(screen.getByLabelText("当前计划日期")).toHaveValue("2026-09-05");
    expect(screen.getByText("来源负责人：负责人甲")).toBeVisible();
  });

  it("submits editable actionable values with no owner/date inference and immediately exposes the saved Todo", async () => {
    const saved = workTodo({ title: "核对三个发布条件并记录结论", currentDueDate: null });
    const { client, onCreated, onOpenTodo } = renderActions(finding({ actionBasis: "unowned_follow_up", candidateOwner: null, dueAt: null, originalDueExpression: "之后再确定" }), {
      createTodoFromFinding: vi.fn().mockResolvedValue({ todo: saved, reused: false })
    });
    fireEvent.click(screen.getByRole("button", { name: "加入我的待办" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: saved.title } });
    fireEvent.click(screen.getByRole("button", { name: "创建待办" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(saved));
    expect(client.createTodoFromFinding).toHaveBeenCalledWith("wrm_1", "finding_action", expect.objectContaining({ title: saved.title, ownerLabel: null, currentDueDate: null }));
    expect(screen.queryByRole("button", { name: "加入我的待办" })).not.toBeInTheDocument();
    expect(screen.getByText(saved.title)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "查看待办" }));
    expect(onOpenTodo).toHaveBeenCalledWith(saved.id);
  });

  it("discloses a reused completed Todo instead of suggesting the new draft replaced it", async () => {
    const existing = workTodo({ title: "已保存的原待办", status: "completed" });
    const { onOpenTodo } = renderActions(finding(), { createTodoFromFinding: vi.fn().mockResolvedValue({ todo: existing, reused: true }) });
    fireEvent.click(screen.getByRole("button", { name: "加入我的待办" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "本次新填写的标题" } });
    fireEvent.click(screen.getByRole("button", { name: "创建待办" }));
    expect(await screen.findByRole("status")).toHaveTextContent("本次表单不会覆盖已有内容");
    expect(screen.getByText("关联待办已完成")).toBeVisible();
    expect(screen.getByText(existing.title)).toBeVisible();
    expect(screen.queryByText("本次新填写的标题")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看待办" }));
    expect(onOpenTodo).toHaveBeenCalledWith(existing.id);
  });

  it("locks duplicate submits and closing while the create result is uncertain, then retains the retry key", async () => {
    let reject!: (reason: unknown) => void;
    const create = vi.fn<WorkReviewApi["createTodoFromFinding"]>().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
      .mockResolvedValue({ todo: workTodo(), reused: false });
    renderActions(finding(), { createTodoFromFinding: create });
    fireEvent.click(screen.getByRole("button", { name: "加入我的待办" }));
    fireEvent.submit(document.getElementById("work-todo-editor")!);
    fireEvent.submit(document.getElementById("work-todo-editor")!);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByLabelText("标题")).toBeDisabled();
    expect(screen.getByLabelText("备注")).toBeDisabled();
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new TypeError("lost response")); });
    expect(await screen.findByRole("alert")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "创建待办" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]![2]).toEqual(create.mock.calls[0]![2]);
  });

  it.each(["title", "notes"])("requires deliberate shortening of overlong source %s without silently truncating", async (field) => {
    const long = "待".repeat(field === "title" ? 241 : 5001);
    const { client } = renderActions(finding(field === "title" ? { title: long, body: long } : { body: long }));
    fireEvent.click(screen.getByRole("button", { name: "加入我的待办" }));
    expect(screen.getByLabelText(field === "title" ? "标题" : "备注")).toHaveValue(long);
    fireEvent.submit(document.getElementById("work-todo-editor")!);
    expect(await screen.findByRole("alert")).toHaveTextContent(field === "title" ? "标题超过240字" : "备注超过5000字");
    expect(client.createTodoFromFinding).not.toHaveBeenCalled();
  });
  it("retains the original topic and the complete short action with its conditions", () => {
    const body = "整理迁移清单并标注负责人，仅覆盖本轮已确认的三个模块。";
    renderActions(finding({ title: "迁移安排", body }));
    fireEvent.click(screen.getByRole("button", { name: "加入我的待办" }));
    const title = (screen.getByLabelText("标题") as HTMLInputElement).value;
    expect(title).toContain("迁移安排");
    expect(title).toContain(body);
    expect(screen.getByText("迁移安排")).toBeVisible();
  });
  it("does not replace an already actionable title with a short background description", () => {
    const title = "整理迁移清单并记录三个模块的回滚条件";
    const body = "这是本轮发布前的准备事项。";
    renderActions(finding({ title, body }));
    fireEvent.click(screen.getByRole("button", { name: "加入我的待办" }));
    const value = (screen.getByLabelText("标题") as HTMLInputElement).value;
    expect(value).toContain(title);
    expect(value).toContain(body);
    expect(screen.getByLabelText("备注")).toHaveValue(body);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const evidence: WorkEvidenceView = {
  publicationId: "wrp_1",
  segmentId: "segment_1",
  startSeconds: 42,
  endSeconds: 58,
  rawSpeakerLabel: "Speaker 2",
  timestampQuality: "provider_aligned",
  text: "那第一版先不做 Slack，先把 upload 跑起来。",
  contextBefore: "我们先确认第一版范围。",
  contextAfter: "下一步再讨论连接器。"
};

function candidate(kind: WorkMeetingCandidate["kind"], id: string, title: string): WorkMeetingCandidate {
  return {
    id,
    kind,
    status: "pending_review",
    publicationAction: "show_as_candidate",
    riskLevel: ["decision", "commitment", "action_item", "plan_change"].includes(kind)
      ? "high"
      : "low",
    title,
    body: `${title}的详细内容。`,
    version: 0,
    evidence: [evidence],
    structuredData: {
      decisionFinality: kind === "decision" ? "unclear" : null,
      rawActorLabel: kind === "commitment" ? "Speaker 1" : null,
      candidateOwner: kind === "commitment" ? "Speaker 1" : null,
      dueAt: kind === "commitment" ? "2026-09-05T00:00:00.000Z" : null,
      originalDueExpression: kind === "commitment" ? "周五前" : null,
      actionBasis: kind === "commitment" ? "explicit_commitment" : null,
      relatedCommitmentCandidateId: null,
      planStages: []
    },
    ...(kind === "decision" ? { decisionFinality: "unclear" as const } : {}),
    ...(kind === "commitment" ? {
      candidateOwner: "Speaker 1",
      dueAt: "2026-09-05T00:00:00.000Z",
      originalDueExpression: "周五前",
      actionBasis: "explicit_commitment" as const
    } : {}),
    ...(kind === "plan_change" ? {
      planChangeStages: [
        { text: "周四上线", status: "早期方案", evidence: [evidence] },
        { text: "下周一上线", status: "会议后段方案", evidence: [evidence] }
      ]
    } : {})
  };
}

function finding(overrides: Partial<WorkMeetingFinding> = {}): WorkMeetingFinding {
  return {
    id: "finding_action",
    sourceCandidateId: "candidate_action",
    kind: "action_item",
    title: "准备发布清单",
    body: "整理发布前需要核对的项目。",
    version: 0,
    candidateOwner: "Speaker 1",
    dueAt: "2026-09-05T00:00:00.000Z",
    originalDueExpression: "周五前",
    actionBasis: "explicit_commitment",
    evidence: [evidence],
    createdAt: "2026-09-01T08:20:00.000Z",
    updatedAt: "2026-09-01T08:20:00.000Z",
    ...overrides
  };
}

function workTodo(overrides: Partial<WorkTodo> = {}): WorkTodo {
  return {
    contractVersion: 1,
    id: "wrt_1",
    accountId: "account_1",
    kind: "self",
    status: "open",
    origin: "meeting_finding",
    title: "准备发布清单",
    notes: null,
    ownerLabel: null,
    currentDueDate: "2026-09-05",
    isImportant: false,
    myDayDate: null,
    sourceMeetingId: "wrm_1",
    sourceFindingId: "finding_action",
    sourceFindingVersion: 0,
    sourceFindingKind: "action_item",
    sourceOwnerLabel: "Speaker 1",
    sourceOriginalDueAt: "2026-09-05T00:00:00.000Z",
    sourceOriginalDueExpression: "周五前",
    sourceActionBasis: "explicit_commitment",
    sourceDetachedAt: null,
    version: 0,
    createdAt: "2026-09-01T08:30:00.000Z",
    updatedAt: "2026-09-01T08:30:00.000Z",
    completedAt: null,
    reopenedAt: null,
    deletedAt: null,
    ...overrides
  };
}

function detail(overrides: Partial<WorkMeetingDetail["meeting"]> = {}): WorkMeetingDetail {
  return {
    meeting: {
      id: "wrm_1",
      title: "第一版发布范围确认",
      meetingDate: "2026-09-01",
      sourceUploadId: "upload_1",
      version: 0,
      ingestionStatus: "transcript_ready",
      analysisStatus: "review_ready",
      reviewStatus: "in_progress",
      durationSeconds: 3600,
      pendingCandidateCount: 4,
      canonicalSegmentCount: 1,
      verifierMode: "enabled",
      createdAt: "2026-09-01T08:00:00.000Z",
      updatedAt: "2026-09-01T08:10:00.000Z",
      ...overrides
    },
    transcriptSegments: [{
      id: "segment_1",
      uploadId: "upload_1",
      startSeconds: 42,
      endSeconds: 58,
      speaker: "Speaker 2",
      text: evidence.text,
      confidence: 0.91
    }],
    candidates: [
      candidate("decision", "candidate_decision", "先验证上传流程"),
      candidate("commitment", "candidate_commitment", "整理测试录音"),
      candidate("open_question", "candidate_question", "Slack 接入时间"),
      candidate("plan_change", "candidate_change", "上线日期发生变化")
    ],
    findings: [],
    todoProjections: [],
    linkedTodoCount: 0,
    speakerAliases: [{ rawLabel: "Speaker 2", displayLabel: "Alex", version: 0 }]
  };
}

const handlers = {
  busyCandidateId: null,
  mutationError: null,
  onComplete: vi.fn(async () => undefined),
  onDelete: vi.fn(async () => undefined),
  onRetry: vi.fn(async () => undefined),
  onReview: vi.fn(async () => undefined),
  onTodoCreated: vi.fn(),
  onTodosChanged: vi.fn(),
  onUpdateSpeakerAlias: vi.fn(async () => undefined)
};

const flags = {
  analysisEnabled: true,
  followUpEnabled: false,
  todoEnabled: false,
  todoMeetingProjectionEnabled: false,
  uploadEnabled: true,
  verifierEnabled: true
} as const;

function project(id: string, name: string): WorkProject {
  return {
    contractVersion: 1,
    id,
    accountId: "account_1",
    name,
    description: null,
    status: "active",
    version: 0,
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-01T08:00:00.000Z",
    archivedAt: null
  };
}

function api(current: WorkMeetingDetail, overrides: Partial<WorkReviewApi> = {}): WorkReviewApi {
  return {
    getCurrentUser: vi.fn(),
    logout: vi.fn(),
    getRuntimeConfig: vi.fn().mockResolvedValue({ maxUploadBytes: 300 * 1024 * 1024, maxAudioDurationSeconds: 14_400 }),
    listMeetings: vi.fn(),
    uploadMeeting: vi.fn(),
    getMeeting: vi.fn().mockResolvedValue(current),
    retryMeeting: vi.fn(),
    reviewCandidate: vi.fn(),
    updateSpeakerAlias: vi.fn().mockResolvedValue(undefined),
    completeMeeting: vi.fn().mockResolvedValue(undefined),
    deleteMeeting: vi.fn(),
    getMeetingFollowUp: vi.fn().mockResolvedValue({
      draft: null,
      sourceStats: {
        findingCount: 0,
        todoCount: 0,
        confirmedResultCount: 0,
        myTodoCount: 0,
        waitingForOtherTodoCount: 0,
        unresolvedQuestionCount: 0
      }
    }),
    generateMeetingFollowUp: vi.fn(),
    updateMeetingFollowUp: vi.fn(),
    resetMeetingFollowUp: vi.fn(),
    listTodos: vi.fn(),
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
    getCapabilities: vi.fn(),
    listMeetingsByProject: vi.fn(),
    setMeetingProjects: vi.fn(),
    listTodosByProject: vi.fn(),
    setTodoProjects: vi.fn(),
    listProjects: vi.fn().mockResolvedValue([]),
    getProject: vi.fn(),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    getWeeklyReview: vi.fn(),
    generateWeeklyReview: vi.fn(),
    getWeeklyReviewDetail: vi.fn(),
    regenerateWeeklyReview: vi.fn(),
    updateWeeklyItem: vi.fn(),
    createWeeklyUserNote: vi.fn(),
    deleteWeeklyUserNote: vi.fn(),
    resetWeeklyReview: vi.fn(),
    deleteWeeklyReview: vi.fn(),
    getWeeklyQa: vi.fn(),
    askWeeklyQa: vi.fn(),
    clearWeeklyQa: vi.fn(),
    getWeeklySource: vi.fn(),
    ...overrides
  };
}

describe("WorkMeetingDetailView", () => {
  it("keeps folded groups mounted and leaves review state unchanged", () => {
    render(<WorkMeetingDetailView {...handlers} detail={detail()} featureFlags={flags} />);
    const toggle = screen.getByRole("button", { name: /^明确承诺.*展开$/u });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("heading", { name: "整理测试录音" })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    const card = screen.getByRole("heading", { name: "整理测试录音" }).closest("article");
    fireEvent.click(toggle);
    expect(card).toBeInTheDocument();
    expect(card).not.toBeVisible();
    fireEvent.click(toggle);
    expect(screen.getByRole("heading", { name: "整理测试录音" }).closest("article")).toBe(card);
    expect(handlers.onReview).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "完成本次会议整理" })).toBeDisabled();
  });

  it("hides raw speaker metadata while keeping transcript text and saved aliases", () => {
    const current = detail();
    current.transcriptSegments.push({ ...current.transcriptSegments[0]!, id: "segment_unaliased", speaker: "speaker123", text: "保留原文 speaker123 内容。" });
    render(<WorkMeetingDetailView {...handlers} detail={current} featureFlags={flags} />);
    fireEvent.click(screen.getByRole("tab", { name: "完整原文" }));
    const transcript = screen.getByRole("region", { name: "完整会议原文" });
    expect(within(transcript).getByText("Alex")).toBeVisible();
    expect(within(transcript).queryByText("Speaker 2")).not.toBeInTheDocument();
    expect(within(transcript).queryByText("speaker123", { exact: true })).not.toBeInTheDocument();
    expect(within(transcript).getByText("保留原文 speaker123 内容。")).toBeVisible();
    expect(screen.getByRole("button", { name: "发言人显示名称 设置" })).toHaveAttribute("aria-expanded", "false");
  });
  it("requires an explicit ownership override before projecting an assignment to My Todo", async () => {
    const current = detail({ pendingCandidateCount: 0 });
    current.candidates = [];
    current.findings = [finding({
      actionBasis: "assignment_without_acceptance",
      candidateOwner: "Speaker 1"
    })];
    const createTodoFromFinding = vi.fn<WorkReviewApi["createTodoFromFinding"]>()
      .mockResolvedValue({ todo: workTodo({ sourceActionBasis: "assignment_without_acceptance" }), reused: false });

    render(
      <WorkMeetingDetailView
        {...handlers}
        api={api(current, { createTodoFromFinding })}
        detail={current}
        featureFlags={{ ...flags, todoEnabled: true, todoMeetingProjectionEnabled: true }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /^行动事项.*展开$/u }));
    fireEvent.click(screen.getByRole("button", { name: "加入我的待办" }));
    const dialog = screen.getByRole("dialog", { name: "从会议结果创建待办" });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建待办" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("请先确认由你接手");
    expect(createTodoFromFinding).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("checkbox", { name: /仍然加入你的待办/u }));
    fireEvent.click(within(dialog).getByRole("button", { name: "创建待办" }));
    await waitFor(() => expect(createTodoFromFinding).toHaveBeenCalledWith(
      "wrm_1",
      "finding_action",
      expect.objectContaining({ kind: "self", ownershipOverrideConfirmed: true })
    ));
  });

  it("uses the current meeting projects as the Finding to Todo defaults", async () => {
    const alpha = project("wrp_alpha", "Alpha 发布");
    const beta = project("wrp_beta", "Beta 研究");
    const current = detail({
      pendingCandidateCount: 0,
      projects: [
        { id: alpha.id, name: alpha.name, status: alpha.status, version: alpha.version },
        { id: beta.id, name: beta.name, status: beta.status, version: beta.version }
      ]
    });
    current.candidates = [];
    current.findings = [finding()];
    const createTodoFromFinding = vi.fn<WorkReviewApi["createTodoFromFinding"]>()
      .mockResolvedValue({ todo: workTodo({
        projects: [
          { id: alpha.id, name: alpha.name, status: alpha.status, version: alpha.version },
          { id: beta.id, name: beta.name, status: beta.status, version: beta.version }
        ]
      }), reused: false });
    const client = api(current, {
      createTodoFromFinding,
      listProjects: vi.fn().mockResolvedValue([alpha, beta])
    });

    render(
      <WorkMeetingDetailView
        {...handlers}
        api={client}
        detail={current}
        featureFlags={{ ...flags, todoEnabled: true, todoMeetingProjectionEnabled: true }}
        projectsEnabled
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /^行动事项.*展开$/u }));
    fireEvent.click(screen.getByRole("button", { name: "加入我的待办" }));
    const dialog = screen.getByRole("dialog", { name: "从会议结果创建待办" });
    fireEvent.click(within(dialog).getByRole("button", { name: /^关联项目：/u }));
    expect(await within(dialog).findByRole("checkbox", { name: "Alpha 发布" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Beta 研究" })).toBeChecked();
    fireEvent.click(within(dialog).getByRole("button", { name: "创建待办" }));

    await waitFor(() => expect(createTodoFromFinding).toHaveBeenCalledWith(
      "wrm_1",
      "finding_action",
      expect.objectContaining({
        projectIds: ["wrp_alpha", "wrp_beta"]
      })
    ));
  });

  it("saves Meeting projects with the latest resource version returned by Core", async () => {
    const alpha = project("wrp_alpha", "Alpha 发布");
    const beta = project("wrp_beta", "Beta 研究");
    const alphaRef = { id: alpha.id, name: alpha.name, status: alpha.status, version: alpha.version };
    const betaRef = { id: beta.id, name: beta.name, status: beta.status, version: beta.version };
    const current = detail({ version: 4, projects: [alphaRef] });
    const setMeetingProjects = vi.fn<NonNullable<WorkReviewApi["setMeetingProjects"]>>()
      .mockResolvedValueOnce({ resourceVersion: 7, projects: [alphaRef, betaRef] })
      .mockResolvedValueOnce({ resourceVersion: 8, projects: [betaRef] });
    const onProjectsChanged = vi.fn();
    const client = api(current, {
      listProjects: vi.fn().mockResolvedValue([alpha, beta]),
      setMeetingProjects
    });

    render(
      <WorkMeetingDetailView
        {...handlers}
        api={client}
        detail={current}
        featureFlags={flags}
        onProjectsChanged={onProjectsChanged}
        projectsEnabled
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: /^选择项目：/u }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Beta 研究" }));
    fireEvent.click(screen.getByRole("button", { name: "保存项目" }));
    await waitFor(() => expect(setMeetingProjects).toHaveBeenNthCalledWith(
      1,
      "wrm_1",
      expect.objectContaining({
        expectedVersion: 4,
        projectIds: ["wrp_alpha", "wrp_beta"]
      })
    ));
    expect(await screen.findByText("会议所属项目已保存。")).toBeVisible();

    fireEvent.click(screen.getByRole("checkbox", { name: "Alpha 发布" }));
    fireEvent.click(screen.getByRole("button", { name: "保存项目" }));
    await waitFor(() => expect(setMeetingProjects).toHaveBeenNthCalledWith(
      2,
      "wrm_1",
      expect.objectContaining({
        expectedVersion: 7,
        projectIds: ["wrp_beta"]
      })
    ));
    expect(onProjectsChanged).toHaveBeenCalledTimes(2);
  });

  it("labels suggestions, hides projection on unrelated Findings, and replaces buttons with linked state", () => {
    const current = detail({ pendingCandidateCount: 0 });
    current.candidates = [];
    current.findings = [
      finding({ id: "finding_suggestion", title: "可以准备回滚说明", actionBasis: "suggested_action" }),
      finding({ id: "finding_linked", title: "整理最终清单" }),
      finding({ id: "finding_decision", kind: "decision", title: "不接入 Slack", actionBasis: null, candidateOwner: null, dueAt: null, originalDueExpression: null })
    ];
    current.todoProjections = [{
      id: "wrt_linked",
      sourceFindingId: "finding_linked",
      status: "open",
      title: "整理最终清单",
      version: 0,
      kind: "self",
      currentDueDate: "2026-09-08",
      sourceOriginalDueAt: "2026-09-05T00:00:00.000Z",
      sourceOriginalDueExpression: "周五前"
    }];

    render(
      <WorkMeetingDetailView
        {...handlers}
        api={api(current)}
        detail={current}
        featureFlags={{ ...flags, todoEnabled: true, todoMeetingProjectionEnabled: true }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /^行动事项.*展开$/u }));
    const suggestionCard = screen.getByRole("heading", { name: "可以准备回滚说明" }).closest("article");
    const linkedCard = screen.getByRole("heading", { name: "整理最终清单" }).closest("article");
    const decisionCard = screen.getByRole("heading", { name: "不接入 Slack" }).closest("article");
    expect(within(suggestionCard!).getByRole("button", { name: "加入我的待办" })).toBeVisible();
    fireEvent.click(within(suggestionCard!).getByRole("button", { name: "加入我的待办" }));
    expect(screen.getByText("来源性质：建议事项，不代表任何人已经承诺。")).toBeVisible();
    expect(within(linkedCard!).getByText("已加入待办")).toBeVisible();
    expect(within(linkedCard!).getByRole("button", { name: "查看待办" })).toBeVisible();
    expect(within(linkedCard!).queryByRole("button", { name: "加入我的待办" })).not.toBeInTheDocument();
    expect(within(decisionCard!).queryByRole("button", { name: "加入我的待办" })).not.toBeInTheDocument();
  });

  it("requires a linked Todo deletion policy and passes the selected policy", async () => {
    const current = detail({ pendingCandidateCount: 0 });
    current.candidates = [];
    current.linkedTodoCount = 2;
    const onDelete = vi.fn(async () => undefined);
    render(<WorkMeetingDetailView {...handlers} detail={current} featureFlags={flags} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole("button", { name: "删除这次会议" }));
    const dialog = screen.getByRole("dialog", { name: "确定删除这次会议吗？" });
    expect(within(dialog).getByRole("button", { name: "确认删除" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("radio", { name: /保留待办，但移除会议来源/u }));
    fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("detach_linked_todos"));
  });

  it("orders only real review sections and exposes type-specific actions", () => {
    render(<WorkMeetingDetailView {...handlers} detail={detail()} featureFlags={flags} />);

    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.querySelector("button > span")?.textContent ?? heading.textContent);
    expect(headings).toEqual([
      "最终决定 / 暂定方向",
      "明确承诺",
      "未解决问题",
      "方案变化",
      "完成本次会议整理"
    ]);
    expect(screen.getByRole("button", { name: "确认是最终决定" })).toBeVisible();
    for (const name of [/^明确承诺.*展开$/u, /^未解决问题.*展开$/u, /^方案变化.*展开$/u]) fireEvent.click(screen.getByRole("button", { name }));
    expect(screen.getByRole("button", { name: "只是任务分配" })).toBeVisible();
    expect(screen.getByRole("button", { name: "确认仍未解决" })).toBeVisible();
    expect(screen.getByRole("button", { name: "确认变化过程" })).toBeVisible();
    expect(screen.getByText("明确承诺", { selector: "dd" })).toBeVisible();
    expect(screen.getByText("周五前", { selector: "dd" })).toBeVisible();
    expect(screen.getByRole("button", { name: "完成本次会议整理" })).toBeDisabled();
    expect(screen.queryByText("行动事项", { selector: "h2" })).not.toBeInTheDocument();
  });

  it("opens canonical evidence in the shared dialog and keeps source status textual", () => {
    render(<WorkMeetingDetailView {...handlers} detail={detail()} featureFlags={flags} />);
    fireEvent.click(screen.getAllByRole("button", { name: "查看原文和上下文" })[0]);

    const dialog = screen.getByRole("dialog", { name: "来源核对" });
    expect(within(dialog).getByText("第一版发布范围确认")).toBeVisible();
    expect(within(dialog).queryByText("Speaker 2")).not.toBeInTheDocument();
    expect(within(dialog).getByText("Alex")).toBeVisible();
    expect(within(dialog).getByText(evidence.text)).toBeVisible();
    expect(within(dialog).getByText(/已发布的会议原文/u)).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "来源核对" })).not.toBeInTheDocument();
  });

  it("sends complete strict review payloads and preserves structured candidate data", async () => {
    render(<WorkMeetingDetailView {...handlers} detail={detail()} featureFlags={flags} />);

    fireEvent.click(screen.getByRole("button", { name: "确认是最终决定" }));
    expect(handlers.onReview).toHaveBeenCalledWith(
      expect.objectContaining({ id: "candidate_decision", version: 0 }),
      expect.objectContaining({
        action: "edit_and_accept",
        title: "先验证上传流程",
        body: "先验证上传流程的详细内容。",
        structuredData: expect.objectContaining({ decisionFinality: "final", planStages: [] })
      })
    );

    fireEvent.click(screen.getByRole("button", { name: /^明确承诺.*展开$/u }));
    const commitmentCard = screen.getByRole("heading", { name: "整理测试录音" }).closest("article");
    expect(commitmentCard).not.toBeNull();
    fireEvent.click(within(commitmentCard!).getByRole("button", { name: "编辑或改类型" }));
    const editor = screen.getByRole("dialog", { name: "编辑会议结果" });
    fireEvent.change(within(editor).getByLabelText("候选截止日期"), {
      target: { value: "2026-09-06" }
    });
    fireEvent.click(within(editor).getByRole("button", { name: "保存并确认" }));

    await waitFor(() => {
      expect(handlers.onReview).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "candidate_commitment", version: 0 }),
        expect.objectContaining({
          action: "edit_and_accept",
          structuredData: expect.objectContaining({
            actionBasis: "explicit_commitment",
            dueAt: "2026-09-06T00:00:00.000Z",
            originalDueExpression: "周五前",
            rawActorLabel: "Speaker 1"
          })
        })
      );
    });
  });

  it("keeps the complete transcript available when analysis fails", () => {
    render(
      <WorkMeetingDetailView
        {...handlers}
        detail={detail({ analysisStatus: "failed", errorStage: "meeting_analysis", errorCode: "provider_timeout" })}
        featureFlags={flags}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("会议内容整理没有完成");
    fireEvent.click(screen.getByRole("button", { name: "查看原文" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent(evidence.text);
    expect(screen.getByLabelText("Speaker 2 的显示名称")).toHaveValue("Alex");
    expect(screen.queryByText(/音频播放器/u)).not.toBeInTheDocument();
  });

  it("shows the active processing lease and blocks manual retry until it expires", () => {
    render(
      <WorkMeetingDetailView
        {...handlers}
        detail={detail({
          ingestionStatus: "transcribing",
          analysisStatus: "not_started",
          processingStage: "transcription",
          processingLeaseExpiresAt: "2099-09-01T10:15:00.000Z"
        })}
        featureFlags={flags}
      />
    );

    const retry = screen.getByRole("button", { name: /当前处理中/u });
    expect(retry).toBeDisabled();
    expect(retry).toHaveTextContent("后可重试");
  });

  it("hides high-risk candidates but still allows safe completion when verification is disabled", () => {
    const verifierLimitedDetail = detail({ pendingCandidateCount: 1, verifierMode: "disabled" });
    verifierLimitedDetail.candidates = [];
    verifierLimitedDetail.meeting.pendingCandidateCount = 0;
    render(
      <WorkMeetingDetailView
        {...handlers}
        detail={verifierLimitedDetail}
        featureFlags={{ ...flags, verifierEnabled: false }}
      />
    );

    expect(screen.getByText("会议原文已就绪，核验能力受限")).toBeVisible();
    expect(screen.getByText(/决定、承诺和行动事项不会展示/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: "确认是最终决定" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "完成本次会议整理" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "查看完整原文" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent(evidence.text);
  });

  it("explains a verified empty result before allowing completion", () => {
    const emptyDetail = detail({ pendingCandidateCount: 0, verifierMode: "enabled" });
    emptyDetail.candidates = [];
    emptyDetail.findings = [];
    render(<WorkMeetingDetailView {...handlers} detail={emptyDetail} featureFlags={flags} />);

    expect(screen.getByText("本次没有需要确认的会议结果")).toBeVisible();
    expect(screen.getByText(/整理与核验已经完成/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "完成本次会议整理" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "查看完整原文" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent(evidence.text);
  });

  it("uses current meeting and alias versions for optimistic review mutations", async () => {
    const current = detail({ pendingCandidateCount: 0, version: 7 });
    current.candidates = [];
    current.speakerAliases = [{ rawLabel: "Speaker 2", displayLabel: "Alex", version: 3 }];
    const completeMeeting = vi.fn<WorkReviewApi["completeMeeting"]>().mockResolvedValue(undefined);
    const updateSpeakerAlias = vi.fn<WorkReviewApi["updateSpeakerAlias"]>().mockResolvedValue(undefined);
    render(
      <WorkMeetingDetailController
        api={api(current, { completeMeeting, updateSpeakerAlias })}
        featureFlags={flags}
        meetingId="wrm_1"
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "完成本次会议整理" }));
    await waitFor(() => {
      expect(completeMeeting).toHaveBeenCalledWith(
        "wrm_1",
        7,
        expect.stringMatching(/^complete-/u)
      );
    });

    fireEvent.click(screen.getByRole("tab", { name: /完整原文/u }));
    fireEvent.click(screen.getByRole("button", { name: "发言人显示名称 设置" }));
    fireEvent.change(screen.getByLabelText("Speaker 2 的显示名称"), { target: { value: "Taylor" } });
    fireEvent.submit(screen.getByLabelText("Speaker 2 的显示名称").closest("form")!);
    await waitFor(() => {
      expect(updateSpeakerAlias).toHaveBeenCalledWith(
        "wrm_1",
        "Speaker 2",
        "Taylor",
        3,
        expect.stringMatching(/^speaker-/u)
      );
    });
  });

  it("reuses review operation keys after uncertain failures and rotates after success", async () => {
    const current = detail({ pendingCandidateCount: 1 });
    current.candidates = [candidate("discussion_topic", "candidate_topic", "讨论上传范围")];
    const reviewCandidate = vi.fn<WorkReviewApi["reviewCandidate"]>()
      .mockRejectedValueOnce(new WorkReviewApiError(408, "request_timeout"))
      .mockResolvedValue(undefined);
    render(
      <WorkMeetingDetailController
        api={api(current, { reviewCandidate })}
        featureFlags={flags}
        meetingId="wrm_1"
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: /^讨论内容.*展开$/u }));
    const reviewButton = await screen.findByRole("button", { name: "确认讨论内容" });
    fireEvent.click(reviewButton);
    await waitFor(() => expect(reviewCandidate).toHaveBeenCalledTimes(1));
    fireEvent.click(reviewButton);
    await waitFor(() => expect(reviewCandidate).toHaveBeenCalledTimes(2));

    const firstKey = reviewCandidate.mock.calls[0]![2].operationKey;
    const replayKey = reviewCandidate.mock.calls[1]![2].operationKey;
    expect(replayKey).toBe(firstKey);

    await screen.findByRole("button", { name: "确认讨论内容" });
    fireEvent.click(screen.getByRole("button", { name: "确认讨论内容" }));
    await waitFor(() => expect(reviewCandidate).toHaveBeenCalledTimes(3));
    expect(reviewCandidate.mock.calls[2]![2].operationKey).not.toBe(firstKey);
  });

  it("rotates review operation keys after a definitive client error", async () => {
    const current = detail({ pendingCandidateCount: 1 });
    current.candidates = [candidate("discussion_topic", "candidate_topic", "讨论上传范围")];
    const reviewCandidate = vi.fn<WorkReviewApi["reviewCandidate"]>()
      .mockRejectedValue(new WorkReviewApiError(400, "invalid_review_payload"));
    render(
      <WorkMeetingDetailController
        api={api(current, { reviewCandidate })}
        featureFlags={flags}
        meetingId="wrm_1"
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: /^讨论内容.*展开$/u }));
    const reviewButton = await screen.findByRole("button", { name: "确认讨论内容" });
    fireEvent.click(reviewButton);
    await waitFor(() => expect(reviewCandidate).toHaveBeenCalledTimes(1));
    fireEvent.click(reviewButton);
    await waitFor(() => expect(reviewCandidate).toHaveBeenCalledTimes(2));
    expect(reviewCandidate.mock.calls[1]![2].operationKey)
      .not.toBe(reviewCandidate.mock.calls[0]![2].operationKey);
  });

  it("reuses retry, completion, and speaker keys after uncertain failures", async () => {
    const processing = detail({
      ingestionStatus: "transcribing",
      analysisStatus: "not_started",
      pendingCandidateCount: 0
    });
    processing.candidates = [];
    const retryMeeting = vi.fn<WorkReviewApi["retryMeeting"]>()
      .mockRejectedValueOnce(new WorkReviewApiError(0, "network_error"))
      .mockResolvedValue(undefined);
    const { unmount } = render(
      <WorkMeetingDetailController
        api={api(processing, { retryMeeting })}
        featureFlags={flags}
        meetingId="wrm_1"
      />
    );
    const retry = await screen.findByRole("button", { name: "长时间无进展？重新处理" });
    fireEvent.click(retry);
    await waitFor(() => expect(retryMeeting).toHaveBeenCalledTimes(1));
    fireEvent.click(retry);
    await waitFor(() => expect(retryMeeting).toHaveBeenCalledTimes(2));
    expect(retryMeeting.mock.calls[1]![1]).toBe(retryMeeting.mock.calls[0]![1]);
    unmount();

    const completeMeeting = vi.fn<WorkReviewApi["completeMeeting"]>()
      .mockRejectedValueOnce(new WorkReviewApiError(500, "http_500"))
      .mockResolvedValue(undefined);
    const completeDetail = detail({ pendingCandidateCount: 0, version: 7 });
    completeDetail.candidates = [];
    const completedRender = render(
      <WorkMeetingDetailController
        api={api(completeDetail, { completeMeeting })}
        featureFlags={flags}
        meetingId="wrm_1"
      />
    );
    const complete = await screen.findByRole("button", { name: "完成本次会议整理" });
    fireEvent.click(complete);
    await waitFor(() => expect(completeMeeting).toHaveBeenCalledTimes(1));
    fireEvent.click(complete);
    await waitFor(() => expect(completeMeeting).toHaveBeenCalledTimes(2));
    expect(completeMeeting.mock.calls[1]![2]).toBe(completeMeeting.mock.calls[0]![2]);
    completedRender.unmount();

    const updateSpeakerAlias = vi.fn<WorkReviewApi["updateSpeakerAlias"]>()
      .mockRejectedValueOnce(new WorkReviewApiError(500, "http_500"))
      .mockResolvedValue(undefined);
    render(
      <WorkMeetingDetailController
        api={api(detail(), { updateSpeakerAlias })}
        featureFlags={flags}
        meetingId="wrm_1"
      />
    );
    fireEvent.click(await screen.findByRole("tab", { name: /完整原文/u }));
    fireEvent.click(screen.getByRole("button", { name: "发言人显示名称 设置" }));
    const alias = screen.getByLabelText("Speaker 2 的显示名称");
    fireEvent.change(alias, { target: { value: "Taylor" } });
    const aliasForm = alias.closest("form")!;
    fireEvent.submit(aliasForm);
    await waitFor(() => expect(updateSpeakerAlias).toHaveBeenCalledTimes(1));
    fireEvent.submit(aliasForm);
    await waitFor(() => expect(updateSpeakerAlias).toHaveBeenCalledTimes(2));
    expect(updateSpeakerAlias.mock.calls[1]![4]).toBe(updateSpeakerAlias.mock.calls[0]![4]);
  });

  it("stops automatic polling after a definitive load error", async () => {
    vi.useFakeTimers();
    const getMeeting = vi.fn<WorkReviewApi["getMeeting"]>()
      .mockRejectedValue(new WorkReviewApiError(404, "meeting_not_found"));
    try {
      render(
        <WorkMeetingDetailController
          api={api(detail(), { getMeeting })}
          featureFlags={flags}
          meetingId="missing"
        />
      );
      await act(async () => { await Promise.resolve(); });
      expect(getMeeting).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(getMeeting).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling across the transcript-ready analysis handoff", async () => {
    vi.useFakeTimers();
    const intermediate = detail({
      ingestionStatus: "transcript_ready",
      analysisStatus: "not_started"
    });
    const getMeeting = vi.fn<WorkReviewApi["getMeeting"]>().mockResolvedValue(intermediate);
    try {
      render(
        <WorkMeetingDetailController
          api={api(intermediate, { getMeeting })}
          featureFlags={flags}
          meetingId="wrm_1"
        />
      );
      await act(async () => { await Promise.resolve(); });
      expect(getMeeting).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
      expect(getMeeting).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("states completion without creating Todo or long-term assets", () => {
    const completed = detail({ reviewStatus: "completed", pendingCandidateCount: 0 });
    completed.candidates = [];
    completed.findings = [{
      id: "finding_1",
      sourceCandidateId: "candidate_decision",
      kind: "decision",
      title: "先验证上传流程",
      body: "第一版暂不接 Slack。",
      version: 0,
      decisionFinality: "final",
      evidence: [evidence],
      createdAt: "2026-09-01T08:20:00.000Z",
      updatedAt: "2026-09-01T08:20:00.000Z"
    }, {
      id: "finding_2",
      sourceCandidateId: "candidate_change",
      kind: "plan_change",
      title: "上线日期发生变化",
      body: "上线时间从周四调整到下周一。",
      version: 0,
      evidence: [evidence],
      planChangeStages: [
        { text: "周四上线", status: "早期方案", evidence: [evidence] },
        { text: "下周一上线", status: "会议后段方案", evidence: [evidence] }
      ],
      createdAt: "2026-09-01T08:20:00.000Z",
      updatedAt: "2026-09-01T08:20:00.000Z"
    }];
    expect(() => WorkMeetingDetailSchema.parse(completed)).not.toThrow();
    render(<WorkMeetingDetailView {...handlers} detail={completed} featureFlags={flags} />);

    expect(screen.getByText("本次会议已经整理完成")).toBeVisible();
    expect(screen.getByText(/不会自动创建待办、Memory 或跨会议资产/u)).toBeVisible();
    expect(screen.getByText("最终决定", { selector: "dd" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^方案变化.*展开$/u }));
    expect(screen.getByRole("list", { name: "已确认的方案变化过程" })).toHaveTextContent("下周一上线");
    expect(screen.queryByRole("button", { name: "完成本次会议整理" })).not.toBeInTheDocument();
  });

  it("shows four meeting views, server statistics, and separates Todo state from meeting facts", async () => {
    const completed = detail({ reviewStatus: "completed", pendingCandidateCount: 0 });
    completed.candidates = [];
    completed.findings = [finding({ kind: "open_question", title: "发布时间仍待确认" })];
    completed.todoProjections = [{
      id: "wrt_waiting",
      sourceFindingId: "finding_action",
      status: "completed",
      title: "等待客户确认发布时间",
      version: 2,
      kind: "waiting_for_other",
      currentDueDate: "2026-09-12",
      sourceOriginalDueAt: "2026-09-04T20:00:00.000Z",
      sourceOriginalDueExpression: null
    }];
    const getMeetingFollowUp = vi.fn<WorkReviewApi["getMeetingFollowUp"]>().mockResolvedValue({
      draft: null,
      sourceStats: {
        findingCount: 4,
        todoCount: 3,
        confirmedResultCount: 4,
        myTodoCount: 2,
        waitingForOtherTodoCount: 1,
        unresolvedQuestionCount: 1
      }
    });
    render(
      <WorkMeetingDetailView
        {...handlers}
        api={api(completed, { getMeetingFollowUp })}
        detail={completed}
        featureFlags={{ ...flags, followUpEnabled: true, todoEnabled: true }}
      />
    );

    expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual([
      "会议结果",
      "待办",
      "完整原文",
      "会后纪要"
    ]);
    expect(await screen.findByRole("region", { name: "本次会议整理统计" })).toHaveTextContent("4项会议结果已确认");
    expect(screen.getByRole("region", { name: "本次会议整理统计" })).toHaveTextContent("1项等待他人已创建");

    fireEvent.click(screen.getByRole("tab", { name: "待办" }));
    expect(screen.getByText("等待客户确认发布时间")).toBeVisible();
    expect(screen.getByText("2026-09-05")).toBeVisible();
    expect(screen.getByText("2026-09-12")).toBeVisible();
    expect(screen.getByText("当前待办状态：已完成")).toBeVisible();
    expect(screen.getByRole("button", { name: /等待客户确认发布时间/u }).querySelector("dl")).toBeNull();
    expect(screen.queryByText(/承诺已经履行/u)).not.toBeInTheDocument();
  });

  it("states audio duration rejection without offering a partial or futile retranscription", () => {
    const failed = detail({
      ingestionStatus: "failed",
      analysisStatus: "not_started",
      errorStage: "transcription",
      errorCode: "work_review_audio_duration_exceeded"
    });
    render(<WorkMeetingDetailView {...handlers} detail={failed} featureFlags={flags} />);

    expect(screen.getByText("录音时长超过当前上限")).toBeVisible();
    expect(screen.getByText(/没有执行部分转写/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: "重新转写" })).not.toBeInTheDocument();
  });
});

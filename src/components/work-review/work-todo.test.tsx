import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  WorkReviewApi,
  WorkTodo,
  WorkTodoDetailResponse,
  WorkTodoSourceResponse
} from "@/lib/client/work-review-api";
import type { WorkProject } from "@/lib/domain/work-project";

import { WorkReviewContext } from "./work-review-shell";
import { WorkReviewToday } from "./work-review-today";
import { WorkTodoDetail } from "./work-todo-detail";
import { WorkTodoListPage } from "./work-todo-list";
import { workReviewLocalDay } from "./work-todo-utils";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function todo(overrides: Partial<WorkTodo> = {}): WorkTodo {
  return {
    contractVersion: 1,
    id: "wrt_1",
    accountId: "account_1",
    kind: "self",
    status: "open",
    origin: "manual",
    title: "核对发布清单",
    notes: null,
    ownerLabel: null,
    currentDueDate: null,
    isImportant: false,
    myDayDate: null,
    sourceMeetingId: null,
    sourceFindingId: null,
    sourceFindingVersion: null,
    sourceFindingKind: null,
    sourceOwnerLabel: null,
    sourceOriginalDueAt: null,
    sourceOriginalDueExpression: null,
    sourceActionBasis: null,
    sourceDetachedAt: null,
    version: 0,
    createdAt: "2026-09-02T08:00:00.000Z",
    updatedAt: "2026-09-02T08:00:00.000Z",
    completedAt: null,
    reopenedAt: null,
    deletedAt: null,
    ...overrides
  };
}

function detail(current: WorkTodo = todo()): WorkTodoDetailResponse {
  return {
    todo: current,
    source: {
      state: "none",
      sourceChanged: false,
      currentFindingVersion: null,
      meeting: null
    }
  };
}

function api(overrides: Partial<WorkReviewApi> = {}): WorkReviewApi {
  const current = todo();
  return {
    getCurrentUser: vi.fn(),
    logout: vi.fn(),
    getRuntimeConfig: vi.fn().mockResolvedValue({ maxUploadBytes: 300 * 1024 * 1024, maxAudioDurationSeconds: 14_400 }),
    listMeetings: vi.fn(),
    uploadMeeting: vi.fn(),
    getMeeting: vi.fn(),
    retryMeeting: vi.fn(),
    reviewCandidate: vi.fn(),
    updateSpeakerAlias: vi.fn(),
    completeMeeting: vi.fn(),
    deleteMeeting: vi.fn(),
    getMeetingFollowUp: vi.fn(),
    generateMeetingFollowUp: vi.fn(),
    updateMeetingFollowUp: vi.fn(),
    resetMeetingFollowUp: vi.fn(),
    listTodos: vi.fn().mockResolvedValue([]),
    createTodo: vi.fn().mockResolvedValue(current),
    createTodoFromFinding: vi.fn().mockResolvedValue(current),
    getTodo: vi.fn().mockResolvedValue(detail(current)),
    updateTodo: vi.fn().mockResolvedValue(current),
    completeTodo: vi.fn().mockResolvedValue(current),
    reopenTodo: vi.fn().mockResolvedValue(current),
    setTodoMyDay: vi.fn().mockResolvedValue(current),
    removeTodoMyDay: vi.fn().mockResolvedValue(current),
    deleteTodo: vi.fn().mockResolvedValue(current),
    getTodoSource: vi.fn(),
    ...overrides
  };
}

const projectsEnabled = {
  projects: true,
  weekly: false,
  weeklyAi: false,
  weeklyVerifier: false,
  weeklyQa: false,
  weeklyQaVerifier: false
} as const;

const featureFlags = {
  analysisEnabled: true,
  followUpEnabled: true,
  todoEnabled: true,
  todoMeetingProjectionEnabled: true,
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

function v2Methods(overrides: Partial<WorkReviewApi> = {}): Partial<WorkReviewApi> {
  return {
    getCapabilities: vi.fn().mockResolvedValue(projectsEnabled),
    listMeetingsByProject: vi.fn().mockResolvedValue([]),
    setMeetingProjects: vi.fn(),
    listTodosByProject: vi.fn().mockResolvedValue([]),
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

function renderTodoListWithProjects(client: WorkReviewApi) {
  return render(
    <WorkReviewContext.Provider value={{
      api: client,
      capabilities: projectsEnabled,
      capabilitiesStatus: "ready",
      featureFlags,
      refreshCapabilities: vi.fn(),
      user: { id: "account_1", email: "person@example.com", name: "Person" }
    }}>
      <WorkTodoListPage />
    </WorkReviewContext.Provider>
  );
}

describe("Work Review Todo UI", () => {
  it("keeps Today explicit and offers due or overdue work without auto-adding it", async () => {
    const today = workReviewLocalDay();
    const explicit = todo({ id: "wrt_today", title: "今天明确安排", myDayDate: today });
    const dueToday = todo({ id: "wrt_due", title: "今天到期但未安排", currentDueDate: today });
    const overdue = todo({ id: "wrt_overdue", title: "已逾期但未安排", currentDueDate: "2020-01-01" });
    const listTodos = vi.fn<WorkReviewApi["listTodos"]>().mockImplementation(async (view) => (
      view === "today" ? [explicit] : [dueToday, overdue]
    ));
    const setTodoMyDay = vi.fn<WorkReviewApi["setTodoMyDay"]>().mockResolvedValue({ ...dueToday, myDayDate: today });

    render(<WorkReviewToday api={api({ listTodos, setTodoMyDay })} />);

    const todaySection = (await screen.findByRole("heading", { name: "今天安排" })).closest("section");
    expect(todaySection).not.toBeNull();
    expect(within(todaySection!).getByText("今天明确安排")).toBeVisible();
    expect(within(todaySection!).queryByText("今天到期但未安排")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "今天到期，但尚未加入今天" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "已经逾期" })).toBeVisible();
    expect(screen.getByText("逾期不会自动进入今天。")).toBeVisible();

    const dueRow = screen.getByText("今天到期但未安排").closest("li");
    fireEvent.click(within(dueRow!).getByRole("button", { name: "加入今天" }));
    await waitFor(() => expect(setTodoMyDay).toHaveBeenCalledWith(
      "wrt_due",
      expect.objectContaining({ day: today, expectedVersion: 0 })
    ));
  });

  it("loads every Todo view and manually creates a Todo without an ownership override field", async () => {
    const allTodo = todo();
    const listTodos = vi.fn<WorkReviewApi["listTodos"]>().mockResolvedValue([allTodo]);
    const createTodo = vi.fn<WorkReviewApi["createTodo"]>().mockResolvedValue(todo({ id: "wrt_created", title: "准备周会材料" }));

    render(<WorkTodoListPage api={api({ createTodo, listTodos })} />);
    expect(await screen.findByText("核对发布清单")).toBeVisible();

    for (const label of ["计划中", "等待他人", "已完成", "全部"] as const) {
      fireEvent.click(screen.getByRole("tab", { name: label }));
    }
    await waitFor(() => {
      expect(listTodos.mock.calls.map(([view]) => view)).toEqual(expect.arrayContaining([
        "all", "planned", "waiting", "completed"
      ]));
    });

    fireEvent.click(screen.getByRole("button", { name: "新建待办" }));
    const dialog = screen.getByRole("dialog", { name: "新建待办" });
    expect(within(dialog).getByRole("radio", { name: "我的待办" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "加入今天" })).not.toBeChecked();
    fireEvent.change(within(dialog).getByLabelText("标题"), { target: { value: "准备周会材料" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建待办" }));

    await waitFor(() => expect(createTodo).toHaveBeenCalledTimes(1));
    const payload = createTodo.mock.calls[0]![0];
    expect(payload).toMatchObject({
      title: "准备周会材料",
      kind: "self",
      ownerLabel: null,
      myDayDate: null
    });
    expect(payload).not.toHaveProperty("accountId");
    expect(payload).not.toHaveProperty("ownershipOverrideConfirmed");
  });

  it("filters Todos by project and carries project IDs through create and edit", async () => {
    const alpha = project("wrp_alpha", "Alpha 发布");
    const beta = project("wrp_beta", "Beta 研究");
    const current = todo({
      projects: [{ id: alpha.id, name: alpha.name, status: alpha.status, version: alpha.version }]
    });
    const listTodosByProject = vi.fn().mockResolvedValue([current]);
    const listProjects = vi.fn().mockResolvedValue([alpha, beta]);
    const createTodo = vi.fn<WorkReviewApi["createTodo"]>().mockResolvedValue(todo({ id: "wrt_created" }));
    const updateTodo = vi.fn<WorkReviewApi["updateTodo"]>().mockResolvedValue(current);
    const client = api(v2Methods({
      createTodo,
      getTodo: vi.fn().mockResolvedValue(detail(current)),
      listProjects,
      listTodosByProject,
      updateTodo
    }));

    renderTodoListWithProjects(client);
    expect(await screen.findByText("核对发布清单")).toBeVisible();

    fireEvent.change(screen.getByLabelText("项目范围"), {
      target: { value: "project:wrp_alpha" }
    });
    await waitFor(() => expect(listTodosByProject).toHaveBeenCalledWith(
      "all",
      { kind: "project", projectId: "wrp_alpha" },
      expect.any(String),
      expect.any(AbortSignal)
    ));

    fireEvent.click(screen.getByRole("button", { name: "新建待办" }));
    const createDialog = screen.getByRole("dialog", { name: "新建待办" });
    fireEvent.click(within(createDialog).getByRole("button", { name: /^关联项目：/u }));
    fireEvent.click(await within(createDialog).findByRole("checkbox", { name: "Beta 研究" }));
    fireEvent.change(within(createDialog).getByLabelText("标题"), {
      target: { value: "准备研究结论" }
    });
    fireEvent.click(within(createDialog).getByRole("button", { name: "创建待办" }));
    await waitFor(() => expect(createTodo).toHaveBeenCalledWith(expect.objectContaining({
      projectIds: ["wrp_beta"],
      title: "准备研究结论"
    })));

    fireEvent.click(await screen.findByRole("button", { name: "核对发布清单" }));
    const detailDialog = await screen.findByRole("dialog", { name: "待办详情" });
    fireEvent.click(within(detailDialog).getByRole("button", { name: "编辑" }));
    const editDialog = await screen.findByRole("dialog", { name: "编辑待办" });
    fireEvent.click(within(editDialog).getByRole("button", { name: /^关联项目：/u }));
    expect(await within(editDialog).findByRole("checkbox", { name: "Alpha 发布" })).toBeChecked();
    fireEvent.click(within(editDialog).getByRole("checkbox", { name: "Beta 研究" }));
    fireEvent.click(within(editDialog).getByRole("button", { name: "保存修改" }));

    await waitFor(() => expect(updateTodo).toHaveBeenCalledWith(
      "wrt_1",
      expect.objectContaining({
        expectedVersion: 0,
        projectIds: ["wrp_alpha", "wrp_beta"]
      })
    ));
  });

  it("uses one dialog state machine for changed source and labels direct Evidence separately", async () => {
    const meetingTodo = todo({
      origin: "meeting_finding",
      sourceMeetingId: "wrm_1",
      sourceFindingId: "wrf_1",
      sourceFindingVersion: 1,
      sourceFindingKind: "action_item"
    });
    const todoDetail: WorkTodoDetailResponse = {
      todo: meetingTodo,
      source: {
        state: "changed",
        sourceChanged: true,
        currentFindingVersion: 2,
        meeting: { id: "wrm_1", title: "发布同步会", meetingDate: "2026-09-01" }
      }
    };
    const source: WorkTodoSourceResponse = {
      todoId: meetingTodo.id,
      sourceChanged: true,
      meeting: { id: "wrm_1", title: "发布同步会", meetingDate: "2026-09-01" },
      finding: {
        id: "wrf_1",
        kind: "action_item",
        title: "准备发布清单",
        body: "整理发布前需要核对的项目。",
        version: 2,
        structuredData: {}
      },
      evidenceContexts: [
        { publicationId: "wrp_1", segmentId: "seg_1", text: "先看一下发布范围。", startSeconds: 1, endSeconds: 3, rawSpeakerLabel: "Speaker 1", displaySpeakerLabel: null, timestampQuality: "provider_aligned", isDirectEvidence: false },
        { publicationId: "wrp_1", segmentId: "seg_2", text: "请整理发布清单。", startSeconds: 3, endSeconds: 6, rawSpeakerLabel: "Speaker 2", displaySpeakerLabel: "Alex", timestampQuality: "provider_aligned", isDirectEvidence: true },
        { publicationId: "wrp_1", segmentId: "seg_3", text: "周四再一起确认。", startSeconds: 6, endSeconds: 9, rawSpeakerLabel: "Speaker 1", displaySpeakerLabel: null, timestampQuality: "provider_aligned", isDirectEvidence: false }
      ]
    };
    const getTodo = vi.fn<WorkReviewApi["getTodo"]>().mockResolvedValue(todoDetail);
    const getTodoSource = vi.fn<WorkReviewApi["getTodoSource"]>().mockResolvedValue(source);

    render(
      <WorkTodoDetail
        api={api({ getTodo, getTodoSource })}
        onChanged={vi.fn()}
        onClose={vi.fn()}
        open
        todoId={meetingTodo.id}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "查看最新来源" }));
    expect(await screen.findByRole("heading", { name: "会议来源" })).toBeVisible();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText("会议原文 2/3")).toBeVisible();
    expect(screen.getByText("前后文 1/3")).toBeVisible();
    expect(screen.getByText("前后文 3/3")).toBeVisible();
    expect(screen.getByText(/当前待办没有自动改变/u)).toBeVisible();
  });
});

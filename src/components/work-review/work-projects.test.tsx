import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Fragment, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WorkReviewApiError,
  type WorkReviewApi,
  type WorkReviewV2CoreApi
} from "@/lib/client/work-review-api";

import {
  WorkProjectBadges,
  WorkProjectFilter,
  WorkProjectPicker
} from "./work-project-picker";
import { WorkProjectsPage } from "./work-projects-page";
import { WorkTodoDialog } from "./work-todo-dialog";

type WorkProjectRecord = Awaited<ReturnType<WorkReviewV2CoreApi["listProjects"]>>[number];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function project(overrides: Partial<WorkProjectRecord> = {}): WorkProjectRecord {
  return {
    contractVersion: 1,
    id: "wrp_alpha",
    accountId: "account_1",
    name: "Alpha 发布",
    description: "整理第一版发布相关会议与待办。",
    status: "active",
    version: 1,
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-01T08:00:00.000Z",
    archivedAt: null,
    ...overrides
  };
}

function api(overrides: Partial<WorkReviewV2CoreApi> = {}): WorkReviewApi {
  const currentProject = project();
  return {
    getCurrentUser: vi.fn(),
    logout: vi.fn(),
    getRuntimeConfig: vi.fn(),
    getCapabilities: vi.fn().mockResolvedValue({
      projects: true,
      weekly: true,
      weeklyAi: true,
      weeklyVerifier: true,
      weeklyQa: true,
      weeklyQaVerifier: true
    }),
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
    listProjects: vi.fn().mockResolvedValue([currentProject]),
    getProject: vi.fn().mockResolvedValue(currentProject),
    createProject: vi.fn().mockResolvedValue(currentProject),
    updateProject: vi.fn().mockResolvedValue(currentProject),
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
  } as WorkReviewV2CoreApi;
}

describe("Work Review Project UI", () => {
  it("closes the project picker before dismissing its parent Todo dialog with Escape", async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    render(<WorkTodoDialog mode="create" onClose={onClose} onSubmit={onSubmit} open projectApi={api()} projectsEnabled today="2026-09-09" />);
    const trigger = screen.getByRole("button", { name: /^关联项目：/u });
    fireEvent.click(trigger);
    const choice = await screen.findByRole("checkbox", { name: "Alpha 发布" });
    choice.focus();
    fireEvent.keyDown(choice, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "创建待办" })).toBeVisible();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("creates, edits, archives, and restores a lightweight project", async () => {
    const alpha = project();
    const archived = project({
      id: "wrp_archive",
      name: "旧版迁移",
      status: "archived",
      archivedAt: "2026-09-02T08:00:00.000Z"
    });
    const created = project({ id: "wrp_beta", name: "Beta 发布", description: "补齐上线清单。", version: 0 });
    const createProject = vi.fn<WorkReviewV2CoreApi["createProject"]>().mockResolvedValue(created);
    const updateProject = vi.fn<WorkReviewV2CoreApi["updateProject"]>().mockImplementation(async (projectId, input) => {
      const source = projectId === archived.id ? archived : alpha;
      return {
        ...source,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.status === undefined ? {} : {
          status: input.status,
          archivedAt: input.status === "archived" ? "2026-09-03T08:00:00.000Z" : null
        }),
        version: source.version + 1
      };
    });

    render(<WorkProjectsPage api={api({
      createProject,
      listProjects: vi.fn().mockResolvedValue([alpha, archived]),
      updateProject
    })} />);

    expect(await screen.findByRole("heading", { name: "项目" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "使用中的项目" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "已归档项目" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
    fireEvent.change(screen.getByLabelText(/项目名称/u), { target: { value: "Beta 发布" } });
    fireEvent.change(screen.getByLabelText(/说明/u), { target: { value: "补齐上线清单。" } });
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));

    await waitFor(() => expect(createProject).toHaveBeenCalledWith(expect.objectContaining({
      description: "补齐上线清单。",
      name: "Beta 发布",
      operationKey: expect.any(String)
    })));
    expect(await screen.findByText("Beta 发布")).toBeVisible();

    const alphaRow = screen.getByText("Alpha 发布").closest("li");
    expect(alphaRow).not.toBeNull();
    fireEvent.click(within(alphaRow!).getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText(/项目名称/u), { target: { value: "Alpha 发布准备" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(updateProject).toHaveBeenCalledWith(alpha.id, expect.objectContaining({
      expectedVersion: alpha.version,
      name: "Alpha 发布准备"
    })));
    expect(await screen.findByText("Alpha 发布准备")).toBeVisible();

    const editedRow = screen.getByText("Alpha 发布准备").closest("li");
    expect(editedRow).not.toBeNull();
    fireEvent.click(within(editedRow!).getByRole("button", { name: "归档" }));
    expect(screen.getByText(/已有会议和待办关联不会被移除/u)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }));
    await waitFor(() => expect(updateProject).toHaveBeenCalledWith(alpha.id, expect.objectContaining({ status: "archived" })));

    const restoreRow = await screen.findByText("旧版迁移");
    fireEvent.click(within(restoreRow.closest("li")!).getByRole("button", { name: "恢复" }));
    fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));
    await waitFor(() => expect(updateProject).toHaveBeenCalledWith(archived.id, expect.objectContaining({ status: "active" })));
  });

  it("keeps active choices and a selected archived project visible while enforcing the three-project limit", async () => {
    const projects = [
      project({ id: "wrp_a", name: "项目 A" }),
      project({ id: "wrp_b", name: "项目 B" }),
      project({ id: "wrp_c", name: "项目 C" }),
      project({ id: "wrp_archive", name: "历史项目", status: "archived", archivedAt: "2026-09-02T08:00:00.000Z" }),
      project({ id: "wrp_hidden", name: "未关联归档项目", status: "archived", archivedAt: "2026-09-02T08:00:00.000Z" })
    ];
    const projectApi = api({ listProjects: vi.fn().mockResolvedValue(projects) });

    function ControlledPicker() {
      const [selectedIds, setSelectedIds] = useState(["wrp_archive"]);
      return <WorkProjectPicker api={projectApi} onChange={setSelectedIds} selectedIds={selectedIds} />;
    }

    render(<ControlledPicker />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^关联项目：/u }));

    expect(await screen.findByRole("checkbox", { name: /历史项目/u })).toBeChecked();
    expect(screen.getByText("已归档 · 可移除")).toBeVisible();
    expect(screen.queryByText("未关联归档项目")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "项目 A" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "项目 B" }));
    expect(screen.getByText("已选 3/3")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "项目 C" })).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: /历史项目/u }));
    expect(screen.getByRole("checkbox", { name: "项目 C" })).toBeEnabled();
    expect(screen.queryByRole("checkbox", { name: /历史项目/u })).not.toBeInTheDocument();
    const projectA = screen.getByRole("checkbox", { name: "项目 A" });
    fireEvent.keyDown(projectA, { key: "Escape" });
    const trigger = screen.getByRole("button", { name: /^关联项目：/u });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getByRole("checkbox", { name: "项目 A" })).toBe(projectA);
    expect(projectA).toBeChecked();
  });

  it("keeps unexpected project loading errors out of user-facing copy", async () => {
    render(
      <WorkProjectPicker
        api={api({ listProjects: vi.fn().mockRejectedValue(new Error("internal database path")) })}
        onChange={vi.fn()}
        selectedIds={[]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /^关联项目：/u }));
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法读取项目，请稍后重试。");
    expect(screen.queryByText("internal database path")).not.toBeInTheDocument();
  });

  it("submits Todo project IDs and preserves an archived edit association", async () => {
    const active = project({ id: "wrp_active", name: "当前项目" });
    const archived = project({
      id: "wrp_archived",
      name: "历史项目",
      status: "archived",
      archivedAt: "2026-09-02T08:00:00.000Z"
    });
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <WorkTodoDialog
        defaultProjectIds={[archived.id]}
        mode="create"
        onClose={vi.fn()}
        onSubmit={onSubmit}
        open
        projectApi={api({ listProjects: vi.fn().mockResolvedValue([active, archived]) })}
        projectsEnabled
        today="2026-09-03"
      />
    );

    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "核对 V2 范围" } });
    fireEvent.click(screen.getByRole("button", { name: /^关联项目：/u }));
    expect(await screen.findByRole("checkbox", { name: /历史项目/u })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "当前项目" }));
    fireEvent.click(screen.getByRole("button", { name: "创建待办" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      projectIds: [archived.id, active.id],
      title: "核对 V2 范围"
    })));
  });

  it("reuses a Todo operation key only for the same uncertain payload", async () => {
    const onSubmit = vi.fn()
      .mockRejectedValueOnce(new Error("network uncertain"))
      .mockRejectedValueOnce(new Error("network uncertain"))
      .mockRejectedValueOnce(new WorkReviewApiError(409, "idempotency_conflict"))
      .mockResolvedValueOnce(undefined);
    render(
      <WorkTodoDialog
        mode="create"
        onClose={vi.fn()}
        onSubmit={onSubmit}
        open
        today="2026-09-03"
      />
    );

    const title = screen.getByLabelText("标题");
    const submit = screen.getByRole("button", { name: "创建待办" });
    fireEvent.change(title, { target: { value: "第一版标题" } });
    fireEvent.click(submit);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const firstKey = onSubmit.mock.calls[0]?.[0].operationKey;

    fireEvent.click(submit);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1]?.[0].operationKey).toBe(firstKey);

    fireEvent.change(title, { target: { value: "第二版标题" } });
    fireEvent.click(submit);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(3));
    const changedPayloadKey = onSubmit.mock.calls[2]?.[0].operationKey;
    expect(changedPayloadKey).not.toBe(firstKey);

    fireEvent.click(submit);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(4));
    expect(onSubmit.mock.calls[3]?.[0].operationKey).not.toBe(changedPayloadKey);
  });

  it("exposes project filtering and badges without turning projects into navigation", () => {
    const active = project({ id: "wrp_active", name: "当前项目" });
    const archived = project({ id: "wrp_archived", name: "历史项目", status: "archived" });
    const onChange = vi.fn();

    render(
      <Fragment>
        <WorkProjectFilter onChange={onChange} projects={[active, archived]} value={{ kind: "all" }} />
        <WorkProjectBadges projects={[active, archived]} />
      </Fragment>
    );

    fireEvent.change(screen.getByLabelText("项目范围"), { target: { value: `project:${archived.id}` } });
    expect(onChange).toHaveBeenCalledWith({ kind: "project", projectId: archived.id });
    const badges = screen.getByLabelText("关联项目");
    expect(within(badges).getByText("当前项目")).toBeVisible();
    expect(within(badges).getByText("历史项目 · 已归档")).toBeVisible();
    expect(screen.queryByRole("link", { name: "项目" })).not.toBeInTheDocument();
  });

  it("keeps V1 usable when the project capability is disabled", async () => {
    const listProjects = vi.fn();
    render(<WorkProjectsPage api={api({
      getCapabilities: vi.fn().mockResolvedValue({
        projects: false,
        weekly: false,
        weeklyAi: false,
        weeklyVerifier: false,
        weeklyQa: false,
        weeklyQaVerifier: false
      }),
      listProjects
    })} />);

    expect(await screen.findByText("项目整理暂未开放")).toBeVisible();
    expect(listProjects).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "返回会议" })).toHaveAttribute("href", "/work-review/meetings");
  });
});

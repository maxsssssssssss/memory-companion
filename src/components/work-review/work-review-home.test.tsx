import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkReviewApi } from "@/lib/client/work-review-api";
import type { WorkProject } from "@/lib/domain/work-project";

import { WorkReviewHome } from "./work-review-home";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

afterEach(() => {
  cleanup();
  pushMock.mockReset();
  sessionStorage.clear();
});

function api(overrides: Partial<WorkReviewApi> = {}): WorkReviewApi {
  return {
    getCurrentUser: vi.fn(),
    logout: vi.fn(),
    getRuntimeConfig: vi.fn().mockResolvedValue({ maxUploadBytes: 300 * 1024 * 1024, maxAudioDurationSeconds: 14_400 }),
    listMeetings: vi.fn().mockResolvedValue([]),
    uploadMeeting: vi.fn().mockResolvedValue({
      meetingId: "wrm_1",
      receiptId: "wrr_1",
      ingestionStatus: "queued",
      analysisStatus: "not_started",
      reused: false
    }),
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
    ...overrides
  };
}

const flags = {
  analysisEnabled: true,
  followUpEnabled: false,
  todoEnabled: false,
  todoMeetingProjectionEnabled: false,
  uploadEnabled: true,
  verifierEnabled: true
} as const;

const projectsEnabled = {
  projects: true,
  weekly: false,
  weeklyAi: false,
  weeklyVerifier: false,
  weeklyQa: false,
  weeklyQaVerifier: false
} as const;

function project(overrides: Partial<WorkProject> = {}): WorkProject {
  return {
    contractVersion: 1,
    id: "wrp_alpha",
    accountId: "account_1",
    name: "Alpha 发布",
    description: null,
    status: "active",
    version: 0,
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-01T08:00:00.000Z",
    archivedAt: null,
    ...overrides
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

describe("WorkReviewHome", () => {
  it("shows a single existing-audio upload with the real format boundary and consent copy", async () => {
    render(<WorkReviewHome api={api()} featureFlags={flags} />);

    expect(await screen.findByText("还没有会议记录")).toBeVisible();
    expect(screen.getByRole("heading", { name: "工作复盘" })).toBeVisible();
    expect(screen.getByText(/请确保你有权上传和处理/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: /麦克风|开始录音/u })).not.toBeInTheDocument();
    const file = screen.getByLabelText("会议录音") as HTMLInputElement;
    expect(file).not.toHaveAttribute("multiple");
    expect(file.accept).toContain(".mp3");
    expect(file.accept).toContain("video/mp4");
    expect(file.accept).not.toContain(".mov");
    expect(await screen.findByText(/文件不超过/u)).toHaveTextContent("300 MB");
    expect(screen.getByText(/文件不超过/u)).toHaveTextContent("4 小时");
  });

  it("uses the server capacity contract for an explicit preflight size rejection", async () => {
    const uploadMeeting = vi.fn<WorkReviewApi["uploadMeeting"]>();
    render(
      <WorkReviewHome
        api={api({
          getRuntimeConfig: vi.fn().mockResolvedValue({ maxUploadBytes: 10, maxAudioDurationSeconds: 65 }),
          uploadMeeting
        })}
        featureFlags={flags}
      />
    );

    expect(await screen.findByText(/文件不超过/u)).toHaveTextContent("10 字节");
    expect(screen.getByText(/文件不超过/u)).toHaveTextContent("65 秒");
    const file = new File(["12345678901"], "meeting.mp3", { type: "audio/mpeg" });
    fireEvent.change(screen.getByLabelText("会议录音"), { target: { files: [file] } });

    expect(screen.getByRole("alert")).toHaveTextContent("10 字节");
    fireEvent.click(screen.getByRole("button", { name: "上传并开始整理" }));
    expect(uploadMeeting).not.toHaveBeenCalled();
  });

  it("lets the user retry a failed capacity read without showing stale limits", async () => {
    const getRuntimeConfig = vi.fn<WorkReviewApi["getRuntimeConfig"]>()
      .mockRejectedValueOnce(new TypeError("network interrupted"))
      .mockResolvedValueOnce({ maxUploadBytes: 25, maxAudioDurationSeconds: 120 });
    render(<WorkReviewHome api={api({ getRuntimeConfig })} featureFlags={flags} />);

    expect(await screen.findByText(/暂时无法读取当前上传限制/u)).toBeVisible();
    expect(screen.queryByText(/当前上限/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新读取限制" }));

    expect(await screen.findByText(/文件不超过/u)).toHaveTextContent("25 字节");
    expect(screen.getByText(/文件不超过/u)).toHaveTextContent("2 分钟");
    expect(getRuntimeConfig).toHaveBeenCalledTimes(2);
  });

  it("keeps one idempotency key for the selected file and opens the created meeting", async () => {
    const uploadMeeting = vi.fn<WorkReviewApi["uploadMeeting"]>().mockResolvedValue({
      meetingId: "wrm_1",
      receiptId: "wrr_1",
      ingestionStatus: "queued",
      analysisStatus: "not_started",
      reused: false
    });
    render(<WorkReviewHome api={api({ uploadMeeting })} featureFlags={flags} />);
    expect(await screen.findByText("还没有会议记录")).toBeVisible();
    const selected = new File(["fixture"], "meeting.mp3", { type: "audio/mpeg" });

    fireEvent.change(screen.getByLabelText("会议录音"), { target: { files: [selected] } });
    fireEvent.change(screen.getByLabelText(/会议名称/u), { target: { value: "发布范围确认" } });
    const submit = screen.getByRole("button", { name: "上传并开始整理" });
    fireEvent.submit(submit.closest("form") as HTMLFormElement);

    await waitFor(() => expect(uploadMeeting).toHaveBeenCalledTimes(1));
    expect(uploadMeeting.mock.calls[0][0]).toMatchObject({
      file: selected,
      title: "发布范围确认"
    });
    expect(uploadMeeting.mock.calls[0][0].idempotencyKey).toBeTruthy();
    expect(pushMock).toHaveBeenCalledWith("/work-review/meetings/wrm_1");
  });

  it("uploads selected project IDs and filters meetings with the V2 project scope", async () => {
    const alpha = project();
    const uploadMeeting = vi.fn<WorkReviewApi["uploadMeeting"]>().mockResolvedValue({
      meetingId: "wrm_project",
      receiptId: "wrr_project",
      ingestionStatus: "queued",
      analysisStatus: "not_started",
      reused: false
    });
    const listMeetingsByProject = vi.fn().mockResolvedValue([]);
    const listProjects = vi.fn().mockResolvedValue([alpha]);
    const client = api(v2Methods({ listMeetingsByProject, listProjects, uploadMeeting }));

    render(
      <WorkReviewHome
        api={client}
        capabilities={projectsEnabled}
        featureFlags={flags}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: /^所属项目（可选）：/u }));
    const projectCheckbox = await screen.findByRole("checkbox", { name: "Alpha 发布" });
    fireEvent.click(projectCheckbox);
    expect(projectCheckbox).toBeChecked();

    fireEvent.change(screen.getByLabelText("项目范围"), {
      target: { value: "project:wrp_alpha" }
    });
    await waitFor(() => expect(listMeetingsByProject).toHaveBeenCalledWith(
      { kind: "project", projectId: "wrp_alpha" },
      expect.any(AbortSignal)
    ));

    const selected = new File(["fixture"], "project-meeting.mp3", { type: "audio/mpeg" });
    fireEvent.change(screen.getByLabelText("会议录音"), { target: { files: [selected] } });
    fireEvent.submit(screen.getByRole("button", { name: "上传并开始整理" }).closest("form")!);

    await waitFor(() => expect(uploadMeeting).toHaveBeenCalledTimes(1));
    expect(uploadMeeting.mock.calls[0]![0]).toMatchObject({
      file: selected,
      projectIds: ["wrp_alpha"]
    });
    expect(pushMock).toHaveBeenCalledWith("/work-review/meetings/wrm_project");
  });

  it("recovers the same upload operation key after an uncertain failure and remount", async () => {
    const uploadMeeting = vi.fn<WorkReviewApi["uploadMeeting"]>()
      .mockRejectedValueOnce(new TypeError("network interrupted"))
      .mockResolvedValueOnce({
        meetingId: "wrm_1",
        receiptId: "wrr_1",
        ingestionStatus: "queued",
        analysisStatus: "not_started",
        reused: true
      });
    const first = render(<WorkReviewHome api={api({ uploadMeeting })} featureFlags={flags} />);
    await screen.findByText("还没有会议记录");
    const fileOptions = { type: "audio/mpeg", lastModified: 1_777_777_777_000 };
    fireEvent.change(screen.getByLabelText("会议录音"), {
      target: { files: [new File(["fixture"], "meeting.mp3", fileOptions)] }
    });
    fireEvent.submit(screen.getByRole("button", { name: "上传并开始整理" }).closest("form") as HTMLFormElement);
    await screen.findByRole("alert");
    const firstKey = uploadMeeting.mock.calls[0][0].idempotencyKey;

    first.unmount();
    render(<WorkReviewHome api={api({ uploadMeeting })} featureFlags={flags} />);
    await screen.findByText("还没有会议记录");
    fireEvent.change(screen.getByLabelText("会议录音"), {
      target: { files: [new File(["fixture"], "renamed.mp3", fileOptions)] }
    });
    fireEvent.submit(screen.getByRole("button", { name: "上传并开始整理" }).closest("form") as HTMLFormElement);

    await waitFor(() => expect(uploadMeeting).toHaveBeenCalledTimes(2));
    expect(uploadMeeting.mock.calls[1][0].idempotencyKey).toBe(firstKey);
    expect(pushMock).toHaveBeenCalledWith("/work-review/meetings/wrm_1");
    expect(sessionStorage.getItem("daily-brief.work-review.pending-upload.v1")).toBeNull();
  });

  it("keeps the page visible and states the truth when upload is disabled", async () => {
    render(
      <WorkReviewHome
        api={api()}
        featureFlags={{
          analysisEnabled: false,
          followUpEnabled: false,
          todoEnabled: false,
          todoMeetingProjectionEnabled: false,
          uploadEnabled: false,
          verifierEnabled: false
        }}
      />
    );

    expect(await screen.findByText("还没有会议记录")).toBeVisible();
    expect(screen.getByRole("button", { name: "上传并开始整理" })).toBeDisabled();
    expect(screen.getByText(/会议录音上传暂不可用/u)).toBeVisible();
  });
});

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Fragment, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WorkReviewApiError,
  type WorkMeetingFollowUpDraft,
  type WorkMeetingFollowUpGetResponse,
  type WorkReviewApi
} from "@/lib/client/work-review-api";

import {
  useWorkMeetingFollowUp,
  WorkMeetingFollowUpPanel,
  WorkMeetingResultStats
} from "./work-meeting-follow-up";

const stats: WorkMeetingFollowUpGetResponse["sourceStats"] = {
  findingCount: 6,
  todoCount: 3,
  confirmedResultCount: 6,
  myTodoCount: 2,
  waitingForOtherTodoCount: 1,
  unresolvedQuestionCount: 1
};

function draft(overrides: Partial<WorkMeetingFollowUpDraft> = {}): WorkMeetingFollowUpDraft {
  return {
    contractVersion: 1,
    meetingId: "wrm_1",
    accountId: "account_1",
    bodyMarkdown: "# 第一版发布范围确认\n\n## 最终决定\n\n- 第一版先验证上传流程。\n\n## 我的待办\n\n- 整理发布清单。",
    systemSnapshotDigest: "a".repeat(64),
    currentSnapshotDigest: "a".repeat(64),
    stale: false,
    version: 2,
    generatedAt: "2026-09-02T06:00:00.000Z",
    userEditedAt: null,
    updatedAt: "2026-09-02T06:00:00.000Z",
    copySlices: {
      full: "# 第一版发布范围确认\n\n## 最终决定\n\n- 第一版先验证上传流程。\n\n## 我的待办\n\n- 整理发布清单。",
      decisions: "最终决定\n- 第一版先验证上传流程。",
      actions: "我的待办\n- 整理发布清单。",
      selectiveSlicesSource: "system_snapshot"
    },
    sourceStats: stats,
    ...overrides
  };
}

function api(overrides: Partial<WorkReviewApi> = {}): WorkReviewApi {
  return {
    getMeetingFollowUp: vi.fn().mockResolvedValue({ draft: null, sourceStats: stats }),
    generateMeetingFollowUp: vi.fn().mockResolvedValue(draft()),
    updateMeetingFollowUp: vi.fn().mockResolvedValue(draft()),
    resetMeetingFollowUp: vi.fn().mockResolvedValue(draft()),
    ...overrides
  } as unknown as WorkReviewApi;
}

function Harness({
  active = true,
  client,
  eligible = true
}: Readonly<{
  active?: boolean;
  client: WorkReviewApi;
  eligible?: boolean;
}>) {
  const followUp = useWorkMeetingFollowUp({
    active,
    api: client,
    enabled: true,
    meetingId: "wrm_1"
  });
  return active ? <WorkMeetingFollowUpPanel eligible={eligible} followUp={followUp} /> : <p>其他会议视图</p>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WorkMeeting follow-up UI", () => {
  it("generates a draft only after an explicit action and labels it as a non-sent draft", async () => {
    const generateMeetingFollowUp = vi.fn<WorkReviewApi["generateMeetingFollowUp"]>().mockResolvedValue(draft());
    render(<Harness client={api({ generateMeetingFollowUp })} />);

    expect(await screen.findByText("还没有会后纪要")).toBeVisible();
    expect(generateMeetingFollowUp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "生成会后纪要" }));

    await waitFor(() => expect(generateMeetingFollowUp).toHaveBeenCalledWith("wrm_1", {
      expectedVersion: null,
      operationKey: expect.any(String)
    }));
    expect(await screen.findByRole("heading", { name: "会后纪要" })).toBeVisible();
    expect(screen.getByText("草稿")).toBeVisible();
    expect(screen.getByText(/不会自动发送/u)).toBeVisible();
    expect(screen.getByRole("heading", { name: "最终决定" })).toBeVisible();
  });

  it("keeps local edits across panel unmounts and saves with the current server version", async () => {
    const current = draft();
    const updateMeetingFollowUp = vi.fn<WorkReviewApi["updateMeetingFollowUp"]>().mockImplementation(async (_meetingId, input) => (
      draft({ bodyMarkdown: input.bodyMarkdown, version: 3, userEditedAt: "2026-09-02T06:10:00.000Z" })
    ));
    const client = api({
      getMeetingFollowUp: vi.fn().mockResolvedValue({ draft: current, sourceStats: stats }),
      updateMeetingFollowUp
    });
    function SwitchHarness() {
      const [active, setActive] = useState(true);
      const followUp = useWorkMeetingFollowUp({ active: true, api: client, enabled: true, meetingId: "wrm_1" });
      return (
        <Fragment>
          <button onClick={() => setActive((value) => !value)} type="button">切换视图</button>
          {active ? <WorkMeetingFollowUpPanel eligible followUp={followUp} /> : <p>完整原文</p>}
        </Fragment>
      );
    }

    render(<SwitchHarness />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑纪要" }));
    const editor = screen.getByRole("textbox", { name: "纪要正文" });
    fireEvent.change(editor, { target: { value: "# 编辑后的纪要\n\n保留这段文字。" } });
    fireEvent.click(screen.getByRole("button", { name: "切换视图" }));
    expect(screen.getByText("完整原文")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "切换视图" }));
    expect(screen.getByRole("textbox", { name: "纪要正文" })).toHaveValue("# 编辑后的纪要\n\n保留这段文字。");

    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(updateMeetingFollowUp).toHaveBeenCalledWith("wrm_1", {
      bodyMarkdown: "# 编辑后的纪要\n\n保留这段文字。",
      expectedVersion: 2,
      operationKey: expect.any(String)
    }));
    expect(await screen.findByText("纪要修改已保存。")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "编辑纪要" })).toHaveFocus());
  });

  it("uses server-provided selective copy slices and keeps stale edits untouched", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const current = draft({ stale: true, userEditedAt: "2026-09-02T06:10:00.000Z" });
    render(<Harness client={api({ getMeetingFollowUp: vi.fn().mockResolvedValue({ draft: current, sourceStats: stats }) })} />);

    expect(await screen.findByRole("heading", { name: "会议结果或待办后来发生变化" })).toBeVisible();
    expect(screen.getByText(/没有被自动覆盖/u)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "只复制决定" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(current.copySlices.decisions));
    fireEvent.click(screen.getByRole("button", { name: "只复制行动事项" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(current.copySlices.actions));
    expect(screen.getByText(/最近一次系统生成版本/u)).toBeVisible();
  });

  it("refreshes server stats and stale metadata after source changes without replacing unsaved text", async () => {
    const refreshedStats = {
      ...stats,
      todoCount: 4,
      myTodoCount: 3
    };
    const current = draft();
    const refreshed = draft({
      currentSnapshotDigest: "b".repeat(64),
      sourceStats: refreshedStats,
      stale: true
    });
    const getMeetingFollowUp = vi.fn<WorkReviewApi["getMeetingFollowUp"]>()
      .mockResolvedValueOnce({ draft: current, sourceStats: stats })
      .mockResolvedValueOnce({ draft: refreshed, sourceStats: refreshedStats });
    const client = api({ getMeetingFollowUp });
    function RefreshHarness() {
      const [sourceRevision, setSourceRevision] = useState("todo:2:open");
      const followUp = useWorkMeetingFollowUp({
        active: true,
        api: client,
        enabled: true,
        meetingId: "wrm_1",
        sourceRevision
      });
      return (
        <Fragment>
          <button onClick={() => setSourceRevision("todo:3:completed")} type="button">刷新会议来源</button>
          {followUp.sourceStats ? <WorkMeetingResultStats stats={followUp.sourceStats} /> : null}
          <WorkMeetingFollowUpPanel eligible followUp={followUp} />
        </Fragment>
      );
    }

    render(<RefreshHarness />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑纪要" }));
    fireEvent.change(screen.getByRole("textbox", { name: "纪要正文" }), {
      target: { value: "# 尚未保存的用户纪要\n\n这段文字必须保留。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "刷新会议来源" }));

    await waitFor(() => expect(getMeetingFollowUp).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("heading", { name: "会议结果或待办后来发生变化" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "纪要正文" })).toHaveValue("# 尚未保存的用户纪要\n\n这段文字必须保留。");
    expect(screen.getByRole("region", { name: "本次会议整理统计" })).toHaveTextContent("3项我的待办已创建");
  });

  it("recovers from a version conflict without discarding the local draft", async () => {
    const current = draft();
    const latest = draft({ version: 5, bodyMarkdown: "# 其他页面保存的版本" });
    const getMeetingFollowUp = vi.fn<WorkReviewApi["getMeetingFollowUp"]>()
      .mockResolvedValueOnce({ draft: current, sourceStats: stats })
      .mockResolvedValueOnce({ draft: latest, sourceStats: stats });
    const updateMeetingFollowUp = vi.fn<WorkReviewApi["updateMeetingFollowUp"]>()
      .mockRejectedValueOnce(new WorkReviewApiError(409, "version_conflict"))
      .mockImplementation(async (_meetingId, input) => draft({
        bodyMarkdown: input.bodyMarkdown,
        version: 6,
        userEditedAt: "2026-09-02T06:20:00.000Z"
      }));
    render(<Harness client={api({ getMeetingFollowUp, updateMeetingFollowUp })} />);

    fireEvent.click(await screen.findByRole("button", { name: "编辑纪要" }));
    const localBody = "# 本地尚未保存的版本\n\n请保留这段文字。";
    fireEvent.change(screen.getByRole("textbox", { name: "纪要正文" }), {
      target: { value: localBody }
    });
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    globalThis.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    expect(await screen.findByRole("button", { name: "保留文字并载入最新版本" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "保留文字并载入最新版本" }));

    expect(await screen.findByText(/已载入最新服务器版本/u)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "纪要正文" })).toHaveValue(localBody);
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(updateMeetingFollowUp).toHaveBeenLastCalledWith("wrm_1", {
      bodyMarkdown: localBody,
      expectedVersion: 5,
      operationKey: expect.any(String)
    }));
  });

  it("confirms reset and regeneration before replacing a draft", async () => {
    const current = draft({ userEditedAt: "2026-09-02T06:10:00.000Z" });
    const resetMeetingFollowUp = vi.fn<WorkReviewApi["resetMeetingFollowUp"]>().mockResolvedValue(draft({ version: 3 }));
    const generateMeetingFollowUp = vi.fn<WorkReviewApi["generateMeetingFollowUp"]>().mockResolvedValue(draft({ version: 4 }));
    render(<Harness client={api({
      getMeetingFollowUp: vi.fn().mockResolvedValue({ draft: current, sourceStats: stats }),
      generateMeetingFollowUp,
      resetMeetingFollowUp
    })} />);

    fireEvent.click(await screen.findByRole("button", { name: "恢复系统版本" }));
    let dialog = screen.getByRole("dialog", { name: "恢复最近的系统版本？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认恢复" }));
    await waitFor(() => expect(resetMeetingFollowUp).toHaveBeenCalledWith("wrm_1", {
      expectedVersion: 2,
      operationKey: expect.any(String)
    }));

    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    dialog = screen.getByRole("dialog", { name: "按最新内容重新生成？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认重新生成" }));
    await waitFor(() => expect(generateMeetingFollowUp).toHaveBeenCalledWith("wrm_1", {
      expectedVersion: 3,
      operationKey: expect.any(String)
    }));
  });

  it("renders only the server-provided four-way completion statistics", () => {
    render(<WorkMeetingResultStats stats={stats} />);
    const region = screen.getByRole("region", { name: "本次会议整理统计" });
    expect(region).toHaveTextContent("6项会议结果已确认");
    expect(region).toHaveTextContent("2项我的待办已创建");
    expect(region).toHaveTextContent("1项等待他人已创建");
    expect(region).toHaveTextContent("1个未解决问题已保留");
  });
});

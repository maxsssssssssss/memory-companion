import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DateCompanionMemoryBridgeState } from "@/lib/domain/date-companion";

import { CompanionPeople } from "./companion-people";

const now = "2026-08-11T10:00:00.000Z";
const person = (id: string) => ({
  id,
  displayName: "林澄",
  status: "confirmed" as const,
  version: 1,
  explicitlyConfirmed: true as const,
  confirmedAt: now,
  createdAt: now,
  updatedAt: now
});
const setting = { enabled: true, version: 0, createdAt: now, updatedAt: now, enabledAt: null, disabledAt: null };

function readyState(withMapping = false): Extract<DateCompanionMemoryBridgeState, { status: "ready" }> {
  const mapping = withMapping ? {
    id: "mapping_1",
    selfPersonId: "person_self",
    companionPersonId: "person_companion",
    relationshipType: "dating" as const,
    status: "confirmed" as const,
    version: 2,
    confirmedAt: now,
    createdAt: now,
    updatedAt: now
  } : null;
  return {
    status: "ready",
    people: [person("person_self"), person("person_companion")],
    selfBinding: null,
    setting,
    mapping,
    review: {
      retention: setting,
      mapping,
      interactions: [{
        interactionId: "interaction_1",
        sourceUploadId: "upload_1",
        recordingDate: "2026-08-10",
        sourceState: "server_cleaned",
        status: "retryable_failed",
        attemptCount: 1,
        selectionCount: 2,
        unknownCount: 1,
        updatedAt: now
      }]
    },
    retainedSubjects: {},
    memoryRetainedSourceKeys: [],
    relationshipPersonSources: [],
    personQaSources: []
  };
}

function renderPeople(state = readyState()) {
  const actions = {
    onCreatePerson: vi.fn(async () => undefined),
    onSaveMapping: vi.fn(async () => undefined),
    onSetRetention: vi.fn(async () => undefined),
    onPurge: vi.fn(async () => undefined),
    onRetry: vi.fn(async () => undefined),
    onRefresh: vi.fn(async () => undefined)
  };
  render(<CompanionPeople mutationState={{ status: "idle" }} state={state} {...actions} />);
  return actions;
}

describe("CompanionPeople", () => {
  it("distinguishes same-name confirmed people by stable id and rejects self=Ta", async () => {
    const actions = renderPeople();
    expect(screen.getAllByText(/人物号/)).toHaveLength(4);

    fireEvent.change(screen.getByLabelText("我"), { target: { value: "person_self" } });
    fireEvent.change(screen.getByLabelText("Ta"), { target: { value: "person_self" } });
    expect(screen.getByText("“我”和“Ta”不能是同一个人物，请重新选择。")).toBeVisible();
    expect(screen.getByRole("button", { name: "确认人物设置" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Ta"), { target: { value: "person_companion" } });
    fireEvent.change(screen.getByLabelText("你们现在的关系"), { target: { value: "friend" } });
    fireEvent.click(screen.getByRole("button", { name: "确认人物设置" }));
    await waitFor(() => expect(actions.onSaveMapping).toHaveBeenCalledWith({
      selfPersonId: "person_self",
      companionPersonId: "person_companion",
      relationshipType: "friend"
    }));
  });

  it("shows the enabled product default and explains that disabling does not purge", () => {
    renderPeople();
    expect(screen.getByRole("switch", { name: "已开启" })).toBeEnabled();
    expect(screen.getByText("默认开启。只有你确认保留、确认人物和内容归属后，才会进入长期关系记忆。")).toBeVisible();
    expect(screen.getByText("关闭只会停止未来新增，不会删除以前已经保留的内容。")).toBeVisible();
  });

  it("toggles retention independently from purge", async () => {
    const state = readyState(true);
    const actions = renderPeople(state);
    fireEvent.click(screen.getByRole("switch", { name: "已开启" }));
    await waitFor(() => expect(actions.onSetRetention).toHaveBeenCalledWith(false));
    expect(actions.onPurge).not.toHaveBeenCalled();
  });

  it("uses a second confirmation and never hides a failed purge", async () => {
    const state = readyState(true);
    const onPurge = vi.fn(async () => { throw new Error("删除没有完成"); });
    render(
      <CompanionPeople
        mutationState={{ status: "idle" }}
        onCreatePerson={async () => undefined}
        onPurge={onPurge}
        onRefresh={async () => undefined}
        onRetry={async () => undefined}
        onSaveMapping={async () => undefined}
        onSetRetention={async () => undefined}
        state={state}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "准备删除" }));
    const finalButton = screen.getByRole("button", { name: "确认删除已保留内容" });
    expect(finalButton).toBeVisible();
    fireEvent.click(finalButton);
    await waitFor(() => expect(screen.getByText("删除没有完成")).toBeVisible());
    expect(screen.getByRole("button", { name: "确认删除已保留内容" })).toBeVisible();
  });

  it("shows retryable status and calls the real retry action once", async () => {
    const actions = renderPeople(readyState(true));
    expect(screen.getByText("整理未完成，可重试")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重新整理" }));
    await waitFor(() => expect(actions.onRetry).toHaveBeenCalledTimes(1));
    expect(actions.onRetry).toHaveBeenCalledWith("interaction_1");
  });

  it.each([
    ["waiting_for_cleanup", "等待整理"],
    ["pending", "等待整理"],
    ["processing", "正在整理"],
    ["completed", "已整理"],
    ["retryable_failed", "整理未完成，可重试"],
    ["needs_review", "需要重新确认人物或内容"],
    ["cancelled", "未保留或已取消"]
  ] as const)("renders %s as user-facing copy", (status, label) => {
    const state = readyState(true);
    state.review.interactions[0] = { ...state.review.interactions[0], status };
    renderPeople(state);
    expect(screen.getByText(label)).toBeVisible();
  });
});

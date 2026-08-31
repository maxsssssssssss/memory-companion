import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DateCompanionMemoryBridgeState } from "@/lib/domain/date-companion";

import { CompanionPeople } from "./companion-people";

const now = "2026-08-11T10:00:00.000Z";
const person = (id: string, displayName: string, updatedAt = now) => ({
  id,
  displayName,
  status: "confirmed" as const,
  version: 1,
  explicitlyConfirmed: true as const,
  confirmedAt: now,
  createdAt: now,
  updatedAt
});
const setting = { enabled: true, version: 0, createdAt: now, updatedAt: now, enabledAt: null, disabledAt: null };

function readyState(withMapping = true): Extract<DateCompanionMemoryBridgeState, { status: "ready" }> {
  const mapping = withMapping ? {
    id: "mapping_1",
    selfPersonId: "person_self",
    companionPersonId: "person_companion",
    relationshipType: "friend" as const,
    status: "confirmed" as const,
    version: 2,
    confirmedAt: now,
    createdAt: now,
    updatedAt: now
  } : null;
  return {
    status: "ready",
    people: [
      person("person_self", "我"),
      person("person_companion", "林澄", "2026-08-12T10:00:00.000Z"),
      person("person_other", "周岚")
    ],
    selfBinding: withMapping ? {
      personId: "person_self",
      status: "active",
      version: 1,
      setAt: now,
      clearedAt: null,
      updatedAt: now
    } : null,
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

function renderPeople(state: DateCompanionMemoryBridgeState = readyState()) {
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
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("presents an account-scoped directory, excludes self, and links confirmed people", () => {
    renderPeople();

    expect(screen.getByRole("heading", { name: "人物", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^我/u })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /林澄/u })).toHaveAttribute("href", "/date-companion/a/people/person_companion");
    expect(screen.getByRole("link", { name: /周岚/u })).toHaveAttribute("href", "/date-companion/a/people/person_other");
    expect(screen.getByText("当前 Ta")).toBeVisible();
    expect(screen.getByText(/最近相关记录/u)).toBeVisible();
    expect(screen.queryByText(/关系评分|亲密度|匹配度/u)).not.toBeInTheDocument();
  });

  it("uses the latest retained current-person record and ignores cancelled or deleted records", () => {
    const state = readyState();
    const retained = state.review.interactions[0];
    state.review.interactions = [
      retained,
      { ...retained, interactionId: "interaction_cancelled", recordingDate: "2026-08-12", status: "cancelled" },
      { ...retained, interactionId: "interaction_deleted", recordingDate: "2026-08-13", sourceState: "explicitly_deleted" }
    ];

    renderPeople(state);

    const currentPerson = screen.getByRole("link", { name: /林澄/u });
    expect(within(currentPerson).getByText("最近相关记录 · 2026 年 8 月 10 日")).toBeVisible();
    expect(within(currentPerson).queryByText(/8 月 12 日|8 月 13 日/u)).not.toBeInTheDocument();
  });

  it("searches only confirmed names and gives a quiet no-result state", () => {
    renderPeople();
    const search = screen.getByRole("searchbox", { name: "搜索人物" });
    fireEvent.change(search, { target: { value: "周" } });
    expect(screen.getByRole("link", { name: /周岚/u })).toBeVisible();
    expect(screen.queryByRole("link", { name: /林澄/u })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "不存在" } });
    expect(screen.getByRole("heading", { name: "没有找到“不存在”" })).toBeVisible();
    expect(screen.getByText("换一个称呼试试；未确认的人物不会出现在这里。")).toBeVisible();
  });

  it("keeps relationship metadata user-selected and rejects self as Ta", async () => {
    const state = readyState(false);
    state.people = [person("person_self", "林澄"), person("person_companion", "林澄")];
    const actions = renderPeople(state);
    fireEvent.click(screen.getByText("数据与隐私"));

    const relationship = screen.getByLabelText("由你选择的关系") as HTMLSelectElement;
    expect(relationship.value).toBe("");
    expect(screen.getAllByText(/同名人物/u)).toHaveLength(6);

    fireEvent.change(screen.getByLabelText("我"), { target: { value: "person_self" } });
    fireEvent.change(screen.getByLabelText("Ta"), { target: { value: "person_self" } });
    expect(screen.getByText("“我”和“Ta”不能是同一个人物，请重新选择。")).toBeVisible();
    expect(screen.getByRole("button", { name: "确认当前人物" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Ta"), { target: { value: "person_companion" } });
    fireEvent.change(relationship, { target: { value: "friend" } });
    fireEvent.click(screen.getByRole("button", { name: "确认当前人物" }));
    await waitFor(() => expect(actions.onSaveMapping).toHaveBeenCalledWith({
      selfPersonId: "person_self",
      companionPersonId: "person_companion",
      relationshipType: "friend"
    }));
  });

  it("keeps retention and destructive purge separate with an explicit dialog", async () => {
    const actions = renderPeople();
    fireEvent.click(screen.getByText("数据与隐私"));

    fireEvent.click(screen.getByRole("switch", { name: "已开启" }));
    await waitFor(() => expect(actions.onSetRetention).toHaveBeenCalledWith(false));
    expect(actions.onPurge).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "查看删除影响" }));
    const dialog = screen.getByRole("dialog", { name: "删除当前关系的长期内容？" });
    expect(within(dialog).getByText(/人物设置与原始复盘仍会保留/u)).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认删除长期内容" }));
    await waitFor(() => expect(actions.onPurge).toHaveBeenCalledTimes(1));
  });

  it("keeps retryable processing in the trust area and invokes only its explicit retry", async () => {
    const actions = renderPeople();
    fireEvent.click(screen.getByText("数据与隐私"));
    expect(screen.getByText("整理未完成，可重试")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重新整理" }));
    await waitFor(() => expect(actions.onRetry).toHaveBeenCalledWith("interaction_1"));
  });

  it("renders loading, error, and empty states without promising automatic creation", () => {
    const props = {
      mutationState: { status: "idle" as const },
      onCreatePerson: async () => undefined,
      onPurge: async () => undefined,
      onRefresh: async () => undefined,
      onRetry: async () => undefined,
      onSaveMapping: async () => undefined,
      onSetRetention: async () => undefined
    };
    const { rerender } = render(<CompanionPeople {...props} state={{ status: "loading" }} />);
    expect(screen.getByRole("heading", { name: "正在找回人物" })).toBeVisible();

    rerender(<CompanionPeople {...props} state={{ status: "error", message: "暂时无法读取" }} />);
    expect(screen.getByRole("heading", { name: "人物暂时没有读取成功" })).toBeVisible();

    const empty = readyState(false);
    empty.people = [];
    rerender(<CompanionPeople {...props} state={empty} />);
    expect(screen.getByRole("heading", { name: "还没有已确认的人物" })).toBeVisible();
    expect(screen.getByText(/系统不会根据名字或对话自动创建/u)).toBeVisible();
  });
});

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DateCompanionMemoryBridgeState } from "@/lib/domain/date-companion";

import { CompanionPeople } from "./companion-people";
import { DateCompanionApiError } from "@/lib/client/date-companion-api";

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
    onPreviewWithdrawal: vi.fn(async () => ({preview: {version: "scope-v1", totalCount: 2, retainedCount: 1, processingCount: 1}})),
    onPurge: vi.fn(async (_version: string) => ({ purgeId: "w1", usageStopped: true as const, status: "completed", totalCount: 2, retainedCount: 1, processingCount: 1, completedCount: 2, failedCount: 0, retryable: false, updatedAt: "2026-11-24T12:00:00Z" })),
    onRetry: vi.fn(async () => undefined),
    onRefresh: vi.fn(async () => undefined)
  };
  render(<CompanionPeople mutationState={{ status: "idle" }} state={state} {...actions} />);
  return actions;
}

describe("CompanionPeople", () => {
  afterEach(() => { window.history.replaceState(null,"",window.location.pathname); });
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("opens and focuses the actual mapping form when reached from the home review link", async () => {
    window.history.replaceState(null,"","/date-companion/a/people?from=book-home#people-mapping-title");
    renderPeople(readyState(false));
    const heading=screen.getByRole("heading",{name:"确认当前这段关系"});
    await waitFor(()=>expect(heading).toHaveFocus());
    expect(heading.closest("details")).toHaveAttribute("open");
    expect(screen.getByLabelText("我")).toBeVisible();
    expect(screen.getByLabelText("Ta")).toBeVisible();
    expect(screen.getByRole("link",{name:"返回首页"})).toBeVisible();
  });

  it("keeps relationship metadata user-selected and rejects self as Ta", async () => {
    const state = readyState(false);
    state.people = [person("person_self", "林澄"), person("person_companion", "林澄")];
    const actions = renderPeople(state);

    const relationship = screen.getByLabelText("由你选择的关系") as HTMLSelectElement;
    expect(relationship.value).toBe("");
    expect(within(screen.getByLabelText("我")).getAllByText(/同名人物/u)).toHaveLength(2);
    expect(within(screen.getByLabelText("Ta")).getAllByText(/同名人物/u)).toHaveLength(2);

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

    fireEvent.click(screen.getByRole("switch", { name: "已开启" }));
    await waitFor(() => expect(actions.onSetRetention).toHaveBeenCalledWith(false));
    expect(actions.onPurge).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "查看撤回影响" }));
    const dialog = screen.getByRole("dialog", { name: "撤回这段关系的长期资料？" });
    expect(await within(dialog).findByText(/共 2 场 · 已纳入 1 场 · 仅在处理 1 场/u)).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(actions.onPurge).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "查看撤回影响" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认撤回长期资料" }));
    await waitFor(() => expect(actions.onPurge).toHaveBeenCalledWith("scope-v1"));
  });

  it("asks for a new confirmation after a scope change and retries only the stopped generation", async () => {
    const actions = renderPeople();
    actions.onPurge.mockRejectedValueOnce(new DateCompanionApiError({status: 409, code: "withdrawal_preview_stale",
      details: {preview: {version:"scope-v2", totalCount:3, retainedCount:2, processingCount:1}}}));
    actions.onPurge.mockResolvedValueOnce({purgeId:"w2", usageStopped:true, status:"partial_failed", totalCount:3,
      retainedCount:2, processingCount:1, completedCount:2, failedCount:1, retryable:true, updatedAt:now});
    fireEvent.click(screen.getByRole("button", {name:"查看撤回影响"}));
    fireEvent.click(await screen.findByRole("button", {name:"确认撤回长期资料"}));
    expect(await screen.findByText(/共 3 场 · 已纳入 2 场/)).toBeVisible();
    expect(actions.onPurge.mock.calls).toEqual([["scope-v1"]]);
    fireEvent.click(screen.getByRole("button", {name:"确认撤回长期资料"}));
    expect(await screen.findByText(/3 场资料已停止长期使用。已清理 2 场/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", {name:"重试上次清理"}));
    await waitFor(() => expect(actions.onPurge.mock.calls).toEqual([["scope-v1"], ["scope-v2"], ["scope-v2"]]));
  });

  it("keeps retryable processing in the trust area and invokes only its explicit retry", async () => {
    const actions = renderPeople();
    expect(screen.getByText("整理未完成，可重试")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /重新整理 · .*年/ }));
    await waitFor(() => expect(actions.onRetry).toHaveBeenCalledWith("interaction_1"));
  });

  it("renders loading, error, and empty states without promising automatic creation", () => {
    const props = {
      mutationState: { status: "idle" as const },
      onCreatePerson: async () => undefined,
      onPreviewWithdrawal: async () => ({preview: {version: "scope-v1", totalCount: 2, retainedCount: 1, processingCount: 1}}),
      onPurge: async () => ({ purgeId: "w1", usageStopped: true as const, status: "completed", totalCount: 2, retainedCount: 1, processingCount: 1, completedCount: 2, failedCount: 0, retryable: false, updatedAt: "2026-11-24T12:00:00Z" }),
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
    expect(screen.getByRole("heading", { name: "确认当前这段关系" })).toBeVisible();
    expect(screen.getByLabelText("我")).toHaveValue("");
    expect(screen.getByRole("button", { name: "新增并确认" })).toBeDisabled();
  });
});

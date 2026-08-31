import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DateCompanionPersonArchiveState } from "@/lib/client/date-companion-people";
import type { DateCompanionConfirmedPerson, PersonVM, RecapItemVM } from "@/lib/domain/date-companion";

import { CompanionPerson } from "./companion-person";

const source = {
  id: "source-1",
  uploadId: "upload-1",
  segmentIds: ["segment-1"],
  recordingDate: "2026-08-03",
  startSeconds: 4,
  endSeconds: 8,
  quote: "我想去海边。",
  kind: "transcript" as const,
  presentation: "direct_quote" as const
};

const kept: RecapItemVM = {
  id: "kept-1",
  kind: "mentioned",
  title: "Ta 最近",
  proposedText: "Ta 想去海边",
  displayedText: "Ta 想去海边",
  disposition: "kept",
  sources: [source]
};

const excluded: RecapItemVM = {
  ...kept,
  id: "excluded-1",
  displayedText: "这条被排除了",
  disposition: "excluded"
};

const person: PersonVM = {
  remembered: [{ ...kept, id: "remembered-1", displayedText: "Ta 喜欢在海边散步" }],
  recent: [kept, excluded],
  relationship: [{ ...kept, id: "between-1", kind: "moment", displayedText: "你们一起看过海" }],
  promises: [
    {
      id: "promise-1",
      relationshipId: "relationship-1",
      originatingRecapItemId: "recap-promise-1",
      text: "下次带那本书",
      status: "open",
      version: 2,
      sources: [source]
    },
    {
      id: "promise-untrusted",
      relationshipId: "relationship-1",
      originatingRecapItemId: "recap-promise-2",
      text: "没有来源的约定",
      status: "open",
      version: 1,
      sources: []
    }
  ],
  interactions: [
    {
      id: "interaction-confirmed",
      uploadIds: ["upload-1"],
      recordingDate: "2026-08-03",
      fileName: "first.wav",
      title: "8 月 3 日的相处",
      status: "ready",
      transcript: [],
      persistenceStatus: "confirmed",
      relationshipInteractionId: "dc-interaction-1"
    },
    {
      id: "interaction-draft",
      uploadIds: ["upload-2"],
      recordingDate: "2026-08-04",
      fileName: "draft.wav",
      title: "尚未确认",
      status: "ready",
      transcript: [],
      persistenceStatus: "draft"
    }
  ],
  observation: null,
  limitedToCurrentInteraction: false
};

const confirmedPerson: DateCompanionConfirmedPerson = {
  id: "person_companion",
  displayName: "林澄",
  status: "confirmed",
  version: 1,
  explicitlyConfirmed: true,
  confirmedAt: "2026-08-01T10:00:00.000Z",
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-11T10:00:00.000Z"
};

const archiveState: DateCompanionPersonArchiveState = {
  status: "ready",
  archive: {
    person: { id: confirmedPerson.id, displayName: confirmedPerson.displayName, confirmedAt: confirmedPerson.confirmedAt, updatedAt: confirmedPerson.updatedAt },
    entries: [
      {
        id: "memory-1",
        type: "preference",
        status: "active",
        title: "喜欢临海散步",
        summary: "林澄明确提到，海边散步会让她放松。",
        date: "2026-08-03",
        updatedAt: "2026-08-04T10:00:00.000Z",
        sourceStatement: "在 2026 年 8 月 3 日的交流中提到",
        sourceOrigin: "direct_conversation",
        shared: false,
        sources: [{ id: "person-evidence-1", uploadId: "upload-1", sourceSegmentId: "segment-1", quote: "我很喜欢傍晚去海边走一走。", date: "2026-08-03" }]
      },
      {
        id: "memory-without-source",
        type: "summary",
        status: "active",
        title: "没有可靠来源",
        summary: "这条不应作为人物事实展示。",
        date: "2026-08-02",
        updatedAt: "2026-08-02T10:00:00.000Z",
        sourceStatement: "来源尚未完全确认",
        sourceOrigin: "unknown",
        shared: false,
        sources: []
      }
    ]
  }
};

describe("CompanionPerson", () => {
  it("uses the confirmed Person identity and only renders sourced confirmed content", () => {
    render(
      <CompanionPerson
        archiveState={archiveState}
        confirmedPerson={confirmedPerson}
        currentInteraction={null}
        isCurrentRelationship
        person={person}
      />
    );

    expect(screen.getByRole("heading", { name: "林澄", level: 1 })).toBeVisible();
    expect(screen.getByText("Ta 想去海边")).toBeVisible();
    expect(screen.queryByText("这条被排除了")).not.toBeInTheDocument();
    expect(screen.queryByText("没有来源的约定")).not.toBeInTheDocument();
    expect(screen.queryByText("尚未确认")).not.toBeInTheDocument();
    expect(screen.queryByText(/关系评分|性格|亲密度/u)).not.toBeInTheDocument();
  });

  it("renders a sourced archive timeline and omits source-unavailable content as fact", () => {
    render(<CompanionPerson archiveState={archiveState} confirmedPerson={confirmedPerson} currentInteraction={null} />);

    expect(screen.getByRole("heading", { name: "可追溯的内容档案" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "喜欢临海散步" })).toBeVisible();
    expect(screen.getByText("偏好 · 当前有效")).toBeVisible();
    expect(screen.getByText("在 2026 年 8 月 3 日的交流中提到")).toBeVisible();
    expect(screen.queryByText("没有可靠来源")).not.toBeInTheDocument();
    expect(screen.getByText("1 条内容因为来源暂不可核对，没有显示在这里。")).toBeVisible();

    fireEvent.click(screen.getByText("查看来源 · 1"));
    expect(screen.getByText(/我很喜欢傍晚去海边走一走/u)).toBeVisible();
    expect(screen.getByText(/不提供失效的跳转链接/u)).toBeVisible();
  });

  it("keeps derived items visible while distinguishing their canonical supporting words", () => {
    const derived = { ...source, id: "derived-source", kind: "semantic" as const, presentation: "derived_summary" as const, quote: "这段交流对应的真实文字" };
    const unsafePerson: PersonVM = { ...person, recent: [{ ...kept, sources: [derived] }] };
    render(
      <CompanionPerson
        confirmedPerson={confirmedPerson}
        currentInteraction={null}
        isCurrentRelationship
        person={unsafePerson}
      />
    );

    const recent = screen.getByRole("heading", { name: "最近留下的片段" }).closest("section");
    fireEvent.click(within(recent!).getByText("查看来源 · 1"));
    expect(within(recent!).getByText("支持这条整理的原话")).toBeVisible();
    expect(within(recent!).getByText("这段交流对应的真实文字")).toBeVisible();
    expect(within(recent!).queryByText("原话")).not.toBeInTheDocument();
  });

  it("opens canonical local sources only when the device can resolve the transcript", () => {
    const onOpenSource = vi.fn();
    const localSource = { ...source, canOpenTranscript: true as const };
    const localPerson: PersonVM = { ...person, recent: [{ ...kept, sources: [localSource] }] };
    render(
      <CompanionPerson
        confirmedPerson={confirmedPerson}
        currentInteraction={null}
        isCurrentRelationship
        onOpenSource={onOpenSource}
        person={localPerson}
      />
    );

    const recent = screen.getByRole("heading", { name: "最近留下的片段" }).closest("section");
    fireEvent.click(within(recent!).getByText("查看来源 · 1"));
    const sourceAction = within(recent!).getByRole("button", { name: "在完整文字记录中查看" });
    expect(sourceAction.closest("blockquote")).toBeNull();
    fireEvent.click(sourceAction);
    expect(onOpenSource).toHaveBeenCalledWith(localSource, "segment-1");
  });

  it("does not point a non-current Person at unrelated relationship controls", () => {
    render(<CompanionPerson archiveState={archiveState} confirmedPerson={confirmedPerson} currentInteraction={null} />);
    expect(screen.queryByRole("link", { name: /人物与长期使用设置/u })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "来源与控制" })).toBeVisible();
  });

  it("keeps search and promise actions scoped to sourced current-relationship content", async () => {
    const onSearch = vi.fn().mockResolvedValue(undefined);
    const onUpdatePromise = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <CompanionPerson
        confirmedPerson={confirmedPerson}
        currentInteraction={null}
        isCurrentRelationship
        onSearch={onSearch}
        onUpdatePromise={onUpdatePromise}
        person={person}
      />
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "人物内容关键词" }), { target: { value: " 海边 " } });
    fireEvent.click(screen.getByRole("button", { name: "找一找" }));
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith("海边"));

    fireEvent.click(screen.getByText("明确约定"));
    fireEvent.click(screen.getByRole("button", { name: "标为已完成" }));
    await waitFor(() => expect(onUpdatePromise).toHaveBeenCalledWith(person.promises[0], "done"));

    rerender(
      <CompanionPerson
        confirmedPerson={confirmedPerson}
        currentInteraction={null}
        isCurrentRelationship
        onSearch={onSearch}
        person={person}
        searchState={{
          status: "ready",
          query: "海边",
          results: [
            { id: "trusted", kind: "mentioned", text: "Ta 想去海边", recordingDate: "2026-08-03", sources: [source] },
            { id: "untrusted", kind: "mentioned", text: "没有来源的搜索结果", recordingDate: "2026-08-03", sources: [] }
          ]
        }}
      />
    );
    expect(screen.getAllByText("Ta 想去海边").length).toBeGreaterThan(0);
    expect(screen.queryByText("没有来源的搜索结果")).not.toBeInTheDocument();
  });

  it("separates Trust controls and requires confirmation before removing a record", async () => {
    const onDeleteInteraction = vi.fn().mockResolvedValue(undefined);
    render(
      <CompanionPerson
        confirmedPerson={confirmedPerson}
        currentInteraction={null}
        isCurrentRelationship
        onDeleteInteraction={onDeleteInteraction}
        person={person}
      />
    );

    const trust = screen.getByRole("heading", { name: "来源与控制" }).closest("section");
    expect(within(trust!).getByRole("link", { name: /查看人物与长期使用设置/u })).toHaveAttribute("href", "/date-companion/a/people#trust-controls");
    fireEvent.click(within(trust!).getByText("管理相关记录"));
    fireEvent.click(within(trust!).getByRole("button", { name: "移除这次记录" }));
    expect(onDeleteInteraction).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "移除这次相处记录？" });
    expect(within(dialog).getByText(/8 月 3 日的相处/u)).toBeVisible();
    expect(within(dialog).getByText(/2026 年 8 月 3 日/u)).toBeVisible();
    expect(within(dialog).getByText(/人物本身不会因此被删除/u)).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认移除记录" }));
    await waitFor(() => expect(onDeleteInteraction).toHaveBeenCalledWith(person.interactions[0]));
  });

  it("fails closed for a missing person and keeps archive errors recoverable", () => {
    const { rerender } = render(<CompanionPerson archiveState={{ status: "not_found" }} currentInteraction={null} />);
    expect(screen.getByRole("heading", { name: "没有找到这位人物" })).toBeVisible();
    expect(screen.getByText(/不属于当前账号/u)).toBeVisible();

    rerender(<CompanionPerson archiveState={{ status: "error", message: "暂时无法读取" }} confirmedPerson={confirmedPerson} currentInteraction={null} />);
    expect(screen.getByRole("heading", { name: "人物内容暂时不可用" })).toBeVisible();
    expect(screen.getByText("暂时无法读取")).toBeVisible();
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PersonVM, RecapItemVM, RelationshipVM } from "@/lib/domain/date-companion";

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

const relationship: RelationshipVM = {
  id: "relationship-1",
  displayName: "小林",
  participantState: "confirmed",
  status: "active",
  version: 1
};

const person: PersonVM = {
  remembered: [],
  recent: [kept, excluded],
  relationship: [],
  promises: [{
    id: "promise-1",
    relationshipId: "relationship-1",
    originatingRecapItemId: "recap-promise-1",
    text: "下次带那本书",
    status: "open",
    version: 2,
    sources: [source]
  }],
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

describe("CompanionPerson", () => {
  it("shows only confirmed kept content and keeps evidence-only history link free", async () => {
    const onUpdatePromise = vi.fn().mockResolvedValue(undefined);
    render(
      <CompanionPerson
        currentInteraction={null}
        onUpdatePromise={onUpdatePromise}
        person={person}
        relationship={relationship}
      />
    );

    expect(screen.getByRole("heading", { name: "小林" })).toBeInTheDocument();
    expect(screen.getByText("Ta 想去海边")).toBeInTheDocument();
    expect(screen.queryByText("这条被排除了")).not.toBeInTheDocument();
    expect(screen.getByText("8 月 3 日的相处")).toBeInTheDocument();
    expect(screen.queryByText("尚未确认")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看完整复盘" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "标为已完成" }));
    await waitFor(() => expect(onUpdatePromise).toHaveBeenCalledWith(person.promises[0], "done"));
  });

  it("preserves card expand/squeeze and delegates relationship-only search", async () => {
    const onSearch = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <CompanionPerson
        currentInteraction={null}
        onSearch={onSearch}
        person={person}
        relationship={relationship}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "放大Ta 最近" }));
    expect(screen.getByRole("button", { name: "收起Ta 最近" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "放大你记得的 Ta" }).closest("article")).toHaveAttribute("data-card-state", "compact");

    fireEvent.change(screen.getByRole("searchbox", { name: "关系内关键词" }), { target: { value: "  海边  " } });
    fireEvent.click(screen.getByRole("button", { name: "找一找" }));
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith("海边"));

    rerender(
      <CompanionPerson
        currentInteraction={null}
        onSearch={onSearch}
        person={person}
        relationship={relationship}
        searchState={{
          status: "ready",
          query: "海边",
          results: [{ id: "result-1", kind: "mentioned", text: "Ta 想去海边", recordingDate: "2026-08-03", sources: [source] }]
        }}
      />
    );
    expect(screen.getAllByText("Ta 想去海边")).toHaveLength(2);
    expect(screen.getAllByText("已保留可核对原话").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "在完整文字稿中查看" })).not.toBeInTheDocument();
  });

  it("requires a second explicit action before deleting an interaction", async () => {
    const onDeleteInteraction = vi.fn().mockResolvedValue(undefined);
    render(
      <CompanionPerson
        currentInteraction={null}
        onDeleteInteraction={onDeleteInteraction}
        person={person}
        relationship={relationship}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "移除这次记录" }));
    expect(onDeleteInteraction).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "移除8 月 3 日的记录" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "先不移除" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "移除这次记录" }));
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    await waitFor(() => expect(onDeleteInteraction).toHaveBeenCalledWith(person.interactions[0]));
  });

  it("shows a relationship mutation failure instead of silently presenting success", () => {
    render(
      <CompanionPerson
        currentInteraction={null}
        mutationState={{ status: "error", operation: "promise", message: "约定状态暂时没有保存" }}
        person={person}
        relationship={relationship}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("约定状态暂时没有保存");
  });
});

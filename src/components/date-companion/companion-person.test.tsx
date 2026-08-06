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

const remembered: RecapItemVM = {
  ...kept,
  id: "remembered-1",
  displayedText: "Ta 喜欢在海边散步"
};

const between: RecapItemVM = {
  ...kept,
  id: "between-1",
  kind: "moment",
  displayedText: "你们一起看过海"
};

const relationship: RelationshipVM = {
  id: "relationship-1",
  displayName: "小林",
  participantState: "confirmed",
  status: "active",
  version: 1
};

const person: PersonVM = {
  remembered: [remembered],
  recent: [kept, excluded],
  relationship: [between],
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

    fireEvent.click(screen.getByRole("button", { name: "你答应了" }));
    fireEvent.click(screen.getByRole("button", { name: "标为已完成" }));
    await waitFor(() => expect(onUpdatePromise).toHaveBeenCalledWith(person.promises[0], "done"));
    expect(screen.getByRole("link", { name: /见 小林 前看一眼/ })).toHaveAttribute("href", "/date-companion/a/prepare");
  });

  it("opens a confirmed evidence-only history entry through the relationship interaction", () => {
    const onOpenInteraction = vi.fn();
    render(
      <CompanionPerson
        currentInteraction={null}
        onOpenInteraction={onOpenInteraction}
        person={person}
        relationship={relationship}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "查看保留的复盘" }));
    expect(onOpenInteraction).toHaveBeenCalledWith(person.interactions[0]);
    expect(screen.queryByRole("button", { name: "查看完整复盘" })).not.toBeInTheDocument();
  });

  it.each([
    ["你记得的 Ta", "remembered", "right"],
    ["Ta 最近", "recent", "left"],
    ["你们之间", "relationship", "right"],
    ["你答应了", "promises", "left"]
  ] as const)("expands %s (%s), squeezes the other cards to the %s rail, and restores", (title, cardId, squeezeSide) => {
    render(
      <CompanionPerson
        currentInteraction={null}
        onUpdatePromise={vi.fn()}
        person={person}
        relationship={relationship}
      />
    );

    const group = screen.getByRole("region", { name: "关于 Ta 的四类内容" });
    const trigger = screen.getByRole("button", { name: title });
    expect(group).toHaveAttribute("data-expanded-card", "none");
    expect(group).toHaveAttribute("data-squeeze-side", "none");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);

    expect(group).toHaveAttribute("data-expanded-card", cardId);
    expect(group).toHaveAttribute("data-squeeze-side", squeezeSide);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger.closest("article")).toHaveAttribute("data-card-state", "expanded");
    expect(trigger.closest("article")?.querySelector("[data-profile-card-content]")).not.toHaveAttribute("hidden");
    const compactCards = [...group.querySelectorAll<HTMLElement>('article[data-card-state="compact"]')];
    expect(compactCards).toHaveLength(3);
    expect(compactCards.map((card) => card.dataset.railOrder)).toEqual(["1", "2", "3"]);
    for (const compactCard of compactCards) {
      expect(compactCard.querySelector("small")).toHaveAttribute("hidden");
      expect(compactCard.querySelector("[data-profile-card-content]")).toHaveAttribute("hidden");
    }

    fireEvent.click(trigger);

    expect(group).toHaveAttribute("data-expanded-card", "none");
    expect(group).toHaveAttribute("data-squeeze-side", "none");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect([...group.querySelectorAll("article")].every((card) => card.getAttribute("data-card-state") === "idle")).toBe(true);
    expect(trigger).toHaveFocus();
  });

  it("keeps idle summaries short, runs FLIP for non-zero card boxes, and delegates relationship-only search", async () => {
    const onSearch = vi.fn().mockResolvedValue(undefined);
    const rect = {
      bottom: 180,
      height: 160,
      left: 20,
      right: 240,
      top: 20,
      width: 220,
      x: 20,
      y: 20,
      toJSON: () => ({})
    } as DOMRect;
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
    const animate = vi.fn(() => ({}) as Animation);
    const previousAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    const { rerender } = render(
      <CompanionPerson
        currentInteraction={null}
        onSearch={onSearch}
        person={person}
        relationship={relationship}
      />
    );

    expect(screen.getByText("Ta 喜欢在海边散步")).toBeInTheDocument();
    expect(screen.getByText("1 件待完成")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ta 最近" }));
    expect(screen.getByRole("button", { name: "Ta 最近" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "你记得的 Ta" }).closest("article")).toHaveAttribute("data-card-state", "compact");
    expect(animate).toHaveBeenCalledTimes(4);

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

    rectSpy.mockRestore();
    if (previousAnimate) Object.defineProperty(HTMLElement.prototype, "animate", previousAnimate);
    else Reflect.deleteProperty(HTMLElement.prototype, "animate");
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

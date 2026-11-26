import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DateCompanionPersonArchiveState } from "@/lib/client/date-companion-people";
import type { DateCompanionSessionValue } from "@/lib/client/date-companion-session";
import type { DateCompanionConfirmedPerson, PersonVM, RecapItemVM } from "@/lib/domain/date-companion";

import { CompanionPersonEdition } from "./companion-person-edition";

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

describe("Person record management", () => {
  it("manages a recap-only meeting under the same title as its book history", () => {
    const recapOnly = { ...person.interactions[0], title: "这次相处", fileName: "周一，桥边的红叶.m4a" };
    const deleteInteraction = vi.fn();
    const session = {
      viewModel: { person: { ...person, interactions: [] }, recap: { history: [recapOnly] } },
      mutationState: { status: "idle" }, deleteInteraction
    } as unknown as DateCompanionSessionValue;
    render(<CompanionPersonEdition session={session} accountId="account-a" relationshipId="rel-a"
      screen="person" personId={confirmedPerson.id} currentPersonId={confirmedPerson.id}
      section="records" archiveState={archiveState} retryArchive={vi.fn()} />);
    expect(screen.getByText("周一，桥边的红叶")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "移除这次记录" }));
    const dialog = screen.getByRole("dialog", { name: "移除这次相处记录？" });
    expect(within(dialog).getByText(/周一，桥边的红叶/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(deleteInteraction).not.toHaveBeenCalled();
  });


  it("requires precise record confirmation and keeps the dialog recoverable if deletion fails", async () => {
    const deleteInteraction = vi.fn().mockRejectedValueOnce(new Error("暂时无法移除。")).mockResolvedValueOnce(undefined);
    const session = {
      viewModel: { person, recap: { history: [person.interactions[0]] } }, mutationState: { status: "idle" }, deleteInteraction
    } as unknown as DateCompanionSessionValue;
    render(<CompanionPersonEdition session={session} accountId="account-a" relationshipId="rel-a"
      screen="person" personId={confirmedPerson.id} currentPersonId={confirmedPerson.id}
      section="records" archiveState={archiveState} retryArchive={vi.fn()} />);
    expect(screen.queryByText("尚未确认")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "移除这次记录" }));
    expect(deleteInteraction).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "移除这次相处记录？" });
    expect(within(dialog).getByText(/8 月 3 日的相处/u)).toBeVisible();
    expect(within(dialog).getByText(/2026 年 8 月 3 日/u)).toBeVisible();
    expect(within(dialog).getByText(/人物本身不会因此被删除/u)).toBeVisible();
    const confirm = within(dialog).getByRole("button", { name: "确认移除记录" });
    fireEvent.click(confirm);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("暂时无法移除。");
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(deleteInteraction.mock.calls).toEqual([["dc-interaction-1"], ["dc-interaction-1"]]);
  });
});

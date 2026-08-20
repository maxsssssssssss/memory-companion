import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InteractionVM, RecapItemVM } from "@/lib/domain/date-companion";

import { CompanionRecap } from "./companion-recap";

const interaction: InteractionVM = {
  id: "upload-1",
  uploadIds: ["upload-1"],
  recordingDate: "2026-08-03",
  fileName: "fixture.wav",
  title: "这次相处",
  status: "ready",
  transcript: [
    {
      id: "segment-1",
      uploadId: "upload-1",
      startSeconds: 1,
      endSeconds: 4,
      speakerId: "speaker_1",
      text: "这是一条可以核对的原话。"
    }
  ]
};

const items: RecapItemVM[] = [
  {
    id: "moment-1",
    kind: "moment",
    title: "值得记住",
    proposedText: "根据原话整理的内容",
    displayedText: "根据原话整理的内容",
    disposition: "pending",
    sources: [
      {
        id: "source-1",
        uploadId: "upload-1",
        segmentIds: ["segment-1"],
        recordingDate: "2026-08-03",
        startSeconds: 1,
        endSeconds: 4,
        speakerId: "speaker_1",
        quote: "这是一条可以核对的原话。",
        kind: "transcript",
        presentation: "direct_quote"
      }
    ]
  }
];

describe("CompanionRecap", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/date-companion/a/recap");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn()
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("places at most one async observation above the deterministic recap stages", () => {
    render(
      <CompanionRecap
        interaction={interaction}
        items={items}
        proactiveObservation={<p>只出现一次的小发现</p>}
      />
    );

    expect(screen.getAllByRole("heading", { name: "一个小发现" })).toHaveLength(1);
    const proactivePanel = screen.getByRole("heading", { name: "一个小发现" }).closest("section")!;
    const processSteps = screen.getByLabelText("本次录音整理阶段");
    expect(proactivePanel.compareDocumentPosition(processSteps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("writes the real segment id into the URL and highlights the matching transcript line", async () => {
    render(<CompanionRecap interaction={interaction} items={items} />);

    fireEvent.click(screen.getByText("展开来源"));
    fireEvent.click(screen.getByRole("button", { name: "在文字稿中查看" }));

    expect(window.location.pathname).toBe("/date-companion/a/recap");
    expect(window.location.search).toBe("?segment=segment-1");
    expect(window.location.hash).toBe("#full-transcript");
    await waitFor(() =>
      expect(document.querySelector('[data-segment-id="segment-1"]')).toHaveAttribute("aria-current", "true")
    );
  });

  it("submits the explicitly selected role and automatic dispositions in one confirmation", async () => {
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    render(
      <CompanionRecap
        interaction={{ ...interaction, persistenceStatus: "draft", relationshipInteractionId: "interaction-1", version: 0 }}
        items={[{ ...items[0], version: 3 }]}
        onFinalize={onFinalize}
        participants={[{
          speakerId: "speaker_1",
          audioSpeakerId: "speaker_1",
          voiceEnrollmentEligible: true,
          displayLabel: "说话人 1",
          state: "confirmed",
          role: "unresolved",
          sampleQuotes: []
        }]}
      />
    );

    const audio = screen.getByLabelText("说话人 1的声音节选");
    expect(audio).toHaveAttribute(
      "src",
      "/api/date-companion/interactions/interaction-1/participants/speaker_1/audio"
    );
    expect(screen.queryByText(/Provider/u)).not.toBeInTheDocument();
    fireEvent.error(audio);
    expect(screen.getByText("声音节选暂不可用，请结合下面的原话判断。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "暂不确定" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "我" }));
    fireEvent.click(screen.getByRole("button", { name: "确认并留下这次相处" }));

    await waitFor(() => expect(onFinalize).toHaveBeenCalledWith(
      [{ speakerId: "speaker_1", role: "self" }],
      [{ id: "moment-1", version: 3, disposition: "kept" }],
      []
    ));
  });

  it("uses the Qwen batch as a read-only mapping and never derives it from speaker role", async () => {
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    const now = "2026-08-11T10:00:00.000Z";
    let resolveSuggestion!: (response: Response) => void;
    const batch = {
        batchId: "batch_1",
        interactionId: "interaction-1",
        interactionVersion: 0,
        mappingVersion: 4,
        evidenceDigest: "a".repeat(64),
        proposalDigest: "b".repeat(64),
        confirmationFingerprint: "c".repeat(64),
        model: "Qwen/Qwen3.6-27B",
        status: "ready",
        suggestions: [{
          canonicalSourceKey: "d".repeat(64),
          uploadId: "upload-1",
          sourceSegmentId: "segment-1",
          contentDigest: "e".repeat(64),
          recapItemIds: ["recap-1", "recap-2"],
          evidenceSnapshotIds: ["evidence-1", "evidence-2"],
          proposedSubject: "unknown",
          confidence: 0.41,
          reasonCode: "ambiguous_pronoun"
        }],
        createdAt: now
    } as const;
    const fetchSuggestion = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") {
        return Promise.resolve(Response.json({
          status: "idle",
          interactionId: "interaction-1",
          interactionVersion: 0,
          mappingVersion: 4,
          evidenceDigest: "a".repeat(64)
        }));
      }
      return new Promise<Response>((resolve) => {
        resolveSuggestion = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchSuggestion);
    render(
      <CompanionRecap
        interaction={{ ...interaction, persistenceStatus: "draft", relationshipInteractionId: "interaction-1", version: 0 }}
        items={[
          { ...items[0], id: "recap-1", interactionId: "interaction-1", version: 3, sources: [{ ...items[0].sources[0], id: "evidence-1" }] },
          { ...items[0], id: "recap-2", interactionId: "interaction-1", version: 4, sources: [{ ...items[0].sources[0], id: "evidence-2" }] }
        ]}
        memoryBridgeState={{
          status: "ready",
          people: [],
          selfBinding: null,
          setting: { enabled: true, version: 1, createdAt: now, updatedAt: now, enabledAt: now, disabledAt: null },
          mapping: { id: "mapping-1", selfPersonId: "person-self", companionPersonId: "person-ta", relationshipType: "dating", status: "confirmed", version: 4, confirmedAt: now, createdAt: now, updatedAt: now },
          review: { retention: { enabled: true, version: 1, createdAt: now, updatedAt: now, enabledAt: now, disabledAt: null }, mapping: { id: "mapping-1", selfPersonId: "person-self", companionPersonId: "person-ta", relationshipType: "dating", status: "confirmed", version: 4, confirmedAt: now, createdAt: now, updatedAt: now }, interactions: [] },
          retainedSubjects: {},
          memoryRetainedSourceKeys: [],
          relationshipPersonSources: [],
          personQaSources: []
        }}
        onFinalize={onFinalize}
        participants={[{
          speakerId: "speaker_1",
          displayLabel: "说话人 1",
          state: "confirmed",
          role: "companion",
          sampleQuotes: []
        }]}
      />
    );

    expect(await screen.findByText("正在结合整次相处，帮你分清这些内容主要关于谁…")).toBeInTheDocument();
    await waitFor(() => expect(fetchSuggestion).toHaveBeenCalledTimes(2));
    resolveSuggestion(Response.json({ batch }));
    await screen.findByText("已经整理好");
    expect(fetchSuggestion).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("暂不确定 1")).toHaveLength(2);
    expect(screen.getByText("这次值得记住 · 1 条原话")).toBeInTheDocument();
    const themeSummary = screen.getByLabelText("这次值得记住的内容范围");
    expect(within(themeSummary).getByText("暂不确定 1")).toBeInTheDocument();
    expect(within(themeSummary).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("这次值得记住的 Subject")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("查看每条归属"));
    const sourceMapping = screen.getByLabelText("这次值得记住第 1 条原话的内容范围");
    expect(sourceMapping.closest("li")).toHaveTextContent("这是一条可以核对的原话。");
    expect(sourceMapping).toHaveTextContent("暂不确定");
    fireEvent.click(screen.getByRole("button", { name: "接受以上归属并留下" }));

    await waitFor(() => expect(onFinalize).toHaveBeenCalledWith(
      [{ speakerId: "speaker_1", role: "companion" }],
      [
        { id: "recap-1", version: 3, disposition: "kept" },
        { id: "recap-2", version: 4, disposition: "kept" }
      ],
      [],
      {
        mappingVersion: 4,
        subjectSuggestionConfirmation: {
          batchId: "batch_1",
          evidenceDigest: "a".repeat(64),
          proposalDigest: "b".repeat(64),
          confirmationFingerprint: "c".repeat(64),
          confirmedVisibleSuggestions: true
        },
        selections: [
          { evidenceSnapshotId: "evidence-1", subject: "unknown" },
          { evidenceSnapshotId: "evidence-2", subject: "unknown" }
        ]
      }
    ));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("backfills a confirmed recap with one sync call and keeps persisted exclusions out", async () => {
    const now = "2026-08-11T10:00:00.000Z";
    const mapping = { id: "mapping-1", selfPersonId: "person-self", companionPersonId: "person-ta", relationshipType: "dating" as const, status: "confirmed" as const, version: 4, confirmedAt: now, createdAt: now, updatedAt: now };
    const retention = { enabled: true, version: 1, createdAt: now, updatedAt: now, enabledAt: now, disabledAt: null };
    const confirmedBatch = {
      batchId: "batch-confirmed",
      interactionId: "interaction-1",
      interactionVersion: 1,
      mappingVersion: 4,
      evidenceDigest: "a".repeat(64),
      proposalDigest: "b".repeat(64),
      confirmationFingerprint: "c".repeat(64),
      model: "Qwen/Qwen3.6-27B",
      status: "ready",
      suggestions: [
        {
          canonicalSourceKey: "d".repeat(64),
          uploadId: "upload-1",
          sourceSegmentId: "segment-1",
          contentDigest: "e".repeat(64),
          recapItemIds: ["recap-kept"],
          evidenceSnapshotIds: ["evidence-kept"],
          proposedSubject: "companion",
          confidence: 0.95,
          reasonCode: "explicit_companion_reference"
        }
      ],
      createdAt: now
    } as const;
    const fetchSuggestion = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(Response.json(init?.method === "GET" ? {
        status: "idle",
        interactionId: "interaction-1",
        interactionVersion: 1,
        mappingVersion: 4,
        evidenceDigest: "a".repeat(64)
      } : { batch: confirmedBatch }))
    );
    vi.stubGlobal("fetch", fetchSuggestion);
    const onMemorySync = vi.fn().mockResolvedValue(undefined);
    const subjectBackfill = (secondDisposition: "kept" | "excluded") => (
      <CompanionRecap
        interaction={{ ...interaction, persistenceStatus: "confirmed", relationshipInteractionId: "interaction-1", version: 1 }}
        items={[
          {
            ...items[0],
            id: "recap-kept",
            interactionId: "interaction-1",
            version: 3,
            disposition: "kept",
            sources: [{ ...items[0].sources[0], id: "evidence-kept" }]
          },
          {
            ...items[0],
            id: "recap-excluded",
            interactionId: "interaction-1",
            version: 4,
            disposition: secondDisposition,
            sources: [{ ...items[0].sources[0], id: "evidence-excluded", segmentIds: ["segment-2"] }]
          }
        ]}
        memoryBridgeState={{
          status: "ready",
          people: [],
          selfBinding: null,
          setting: retention,
          mapping,
          review: { retention, mapping, interactions: [] },
          retainedSubjects: {},
          memoryRetainedSourceKeys: [],
          relationshipPersonSources: [],
          personQaSources: []
        }}
        onMemorySync={onMemorySync}
      />
    );
    const { rerender } = render(subjectBackfill("kept"));

    await screen.findByText("已经整理好");
    expect(screen.getByRole("button", { name: "接受以上归属并开始整理" })).toBeDisabled();
    rerender(subjectBackfill("excluded"));
    const syncButton = screen.getByRole("button", { name: "接受以上归属并开始整理" });
    expect(syncButton).toBeEnabled();
    fireEvent.click(syncButton);
    await waitFor(() => expect(onMemorySync).toHaveBeenCalledWith(
      [{ evidenceSnapshotId: "evidence-kept", subject: "companion" }],
      {
        batchId: "batch-confirmed",
        evidenceDigest: "a".repeat(64),
        proposalDigest: "b".repeat(64),
        confirmationFingerprint: "c".repeat(64),
        confirmedVisibleSuggestions: true
      }
    ));
    expect(onMemorySync).toHaveBeenCalledTimes(1);
    expect(fetchSuggestion).toHaveBeenCalledTimes(2);
  });

  it("offers an explicit archived-relationship recovery and keeps progress or errors beside the action", async () => {
    const now = "2026-08-11T10:00:00.000Z";
    const mapping = { id: "mapping-1", selfPersonId: "person-self", companionPersonId: "person-ta", relationshipType: "dating" as const, status: "confirmed" as const, version: 4, confirmedAt: now, createdAt: now, updatedAt: now };
    const retention = { enabled: true, version: 1, createdAt: now, updatedAt: now, enabledAt: now, disabledAt: null };
    const batch = {
      batchId: "batch-reconfirm",
      interactionId: "interaction-1",
      interactionVersion: 1,
      mappingVersion: 4,
      evidenceDigest: "a".repeat(64),
      proposalDigest: "b".repeat(64),
      confirmationFingerprint: "c".repeat(64),
      model: "Qwen/Qwen3.6-27B",
      status: "ready",
      suggestions: [{
        canonicalSourceKey: "d".repeat(64),
        uploadId: "upload-1",
        sourceSegmentId: "segment-1",
        contentDigest: "e".repeat(64),
        recapItemIds: ["recap-kept"],
        evidenceSnapshotIds: ["evidence-kept"],
        proposedSubject: "companion",
        confidence: 0.95,
        reasonCode: "explicit_companion_reference"
      }],
      createdAt: now
    } as const;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(Response.json(init?.method === "GET" ? {
        status: "idle",
        interactionId: "interaction-1",
        interactionVersion: 1,
        mappingVersion: 4,
        evidenceDigest: "a".repeat(64)
      } : { batch }))
    ));
    let rejectSync!: (error: Error) => void;
    const onMemorySync = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSync = reject; }));
    const syncIdempotencyKey = (callIndex: number) => {
      const call = onMemorySync.mock.calls[callIndex] as unknown as unknown[];
      return (call[2] as { idempotencyKey: string }).idempotencyKey;
    };
    const recoveryRecap = (attemptCount: number, updatedAt: string) => (
      <CompanionRecap
        interaction={{ ...interaction, persistenceStatus: "confirmed", relationshipInteractionId: "interaction-1", version: 1 }}
        items={[{
          ...items[0],
          id: "recap-kept",
          interactionId: "interaction-1",
          version: 3,
          disposition: "kept",
          sources: [{ ...items[0].sources[0], id: "evidence-kept" }]
        }]}
        memoryBridgeState={{
          status: "ready",
          people: [],
          selfBinding: null,
          setting: retention,
          mapping,
          review: {
            retention,
            mapping,
            interactions: [{
              interactionId: "interaction-1",
              sourceUploadId: "upload-1",
              recordingDate: "2026-08-03",
              sourceState: "server_cleaned",
              status: "needs_review",
              attemptCount,
              selectionCount: 1,
              unknownCount: 0,
              updatedAt,
              review: { kind: "relationship_reconfirmation_required", canReconfirm: true, reason: "relationship_was_archived", nextAction: "reconfirm_archived_relationship" }
            }]
          },
          retainedSubjects: {},
          memoryRetainedSourceKeys: [],
          relationshipPersonSources: [],
          personQaSources: []
        }}
        onMemorySync={onMemorySync}
      />
    );
    const { rerender } = render(recoveryRecap(1, now));

    const panel = screen.getByRole("heading", { name: "看看哪些内容值得留下" }).closest("section")!;
    expect(await within(panel).findByText("这段长期关系记录之前已被清理。重新启用后，我会按你刚确认的归属继续整理。")).toBeInTheDocument();
    const button = within(panel).getByRole("button", { name: "重新启用并继续整理" });
    fireEvent.click(button);
    expect(within(panel).getByRole("button", { name: "正在整理…" })).toBeDisabled();
    expect(onMemorySync).toHaveBeenCalledWith(
      [{ evidenceSnapshotId: "evidence-kept", subject: "companion" }],
      {
        batchId: "batch-reconfirm",
        evidenceDigest: "a".repeat(64),
        proposalDigest: "b".repeat(64),
        confirmationFingerprint: "c".repeat(64),
        confirmedVisibleSuggestions: true
      },
      {
        action: "reconfirm_archived_relationship",
        idempotencyKey: `dc-rel-reconfirm:v2:${"c".repeat(64)}:a1-t${Date.parse(now).toString(36)}`
      }
    );
    const initialIdempotencyKey = syncIdempotencyKey(0);
    rejectSync(new Error("长期关系暂时没有重新启用，请稍后再试。"));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("长期关系暂时没有重新启用");
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    rerender(recoveryRecap(1, now));
    fireEvent.click(within(panel).getByRole("button", { name: "重新启用并继续整理" }));
    expect(syncIdempotencyKey(1)).toBe(initialIdempotencyKey);
    rejectSync(new Error("同一次恢复仍未完成。"));
    await within(panel).findByText("同一次恢复仍未完成。");

    const later = "2026-08-11T10:01:00.000Z";
    rerender(recoveryRecap(2, later));
    fireEvent.click(within(panel).getByRole("button", { name: "重新启用并继续整理" }));
    expect(syncIdempotencyKey(2)).toBe(
      `dc-rel-reconfirm:v2:${"c".repeat(64)}:a2-t${Date.parse(later).toString(36)}`
    );
    expect(syncIdempotencyKey(2)).not.toBe(initialIdempotencyKey);
    rejectSync(new Error("新的恢复回合仍未完成。"));
    await within(panel).findByText("新的恢复回合仍未完成。");
  });

  it("does not offer a fake retry for a non-reconfirmable memory review", () => {
    const now = "2026-08-11T10:00:00.000Z";
    const mapping = { id: "mapping-1", selfPersonId: "person-self", companionPersonId: "person-ta", relationshipType: "dating" as const, status: "confirmed" as const, version: 4, confirmedAt: now, createdAt: now, updatedAt: now };
    const retention = { enabled: true, version: 1, createdAt: now, updatedAt: now, enabledAt: now, disabledAt: null };
    render(
      <CompanionRecap
        interaction={{ ...interaction, persistenceStatus: "confirmed", relationshipInteractionId: "interaction-1", version: 1 }}
        items={items}
        memoryBridgeState={{
          status: "ready",
          people: [],
          selfBinding: null,
          setting: retention,
          mapping,
          review: {
            retention,
            mapping,
            interactions: [{
              interactionId: "interaction-1",
              sourceUploadId: "upload-1",
              recordingDate: "2026-08-03",
              sourceState: "server_cleaned",
              status: "needs_review",
              attemptCount: 1,
              selectionCount: 1,
              unknownCount: 0,
              updatedAt: now,
              review: { kind: "evidence_review_required", canReconfirm: false, reason: "source_evidence_changed", nextAction: "review_source_evidence" }
            }]
          },
          retainedSubjects: {},
          memoryRetainedSourceKeys: [],
          relationshipPersonSources: [],
          personQaSources: []
        }}
        onMemorySync={vi.fn()}
      />
    );

    expect(screen.getByText("这次原话来源已经变化，暂时不能继续整理长期记录。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /整理|重新启用/u })).not.toBeInTheDocument();
  });

  it("keeps a Subject suggestion conflict out of long-term admission and still saves the local recap", async () => {
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    const now = "2026-08-11T10:00:00.000Z";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { error: "subject_suggestion_mapping_not_confirmed" },
      { status: 409 }
    )));
    const mapping = {
      id: "mapping-1",
      selfPersonId: "person-self",
      companionPersonId: "person-ta",
      relationshipType: "dating" as const,
      status: "confirmed" as const,
      version: 4,
      confirmedAt: now,
      createdAt: now,
      updatedAt: now
    };
    const retention = {
      enabled: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
      enabledAt: now,
      disabledAt: null
    };
    render(
      <CompanionRecap
        interaction={{ ...interaction, persistenceStatus: "draft", relationshipInteractionId: "interaction-1", version: 0 }}
        items={[{ ...items[0], id: "recap-1", interactionId: "interaction-1", version: 3, sources: [{ ...items[0].sources[0], id: "evidence-1" }] }]}
        memoryBridgeState={{
          status: "ready",
          people: [],
          selfBinding: null,
          setting: retention,
          mapping,
          review: { retention, mapping, interactions: [] },
          retainedSubjects: {},
          memoryRetainedSourceKeys: [],
          relationshipPersonSources: [],
          personQaSources: []
        }}
        onFinalize={onFinalize}
        participants={[{
          speakerId: "speaker_1",
          displayLabel: "说话人 1",
          state: "confirmed",
          role: "companion",
          sampleQuotes: []
        }]}
      />
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("仍可只保存本次复盘");
    expect(screen.getByRole("button", { name: "接受以上归属并留下" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "只保存本次复盘，不做长期保留" }));
    await waitFor(() => expect(onFinalize).toHaveBeenCalledWith(
      [{ speakerId: "speaker_1", role: "companion" }],
      [{ id: "recap-1", version: 3, disposition: "kept" }],
      []
    ));
  });

  it("uses the refreshed review status instead of a stale interaction status", () => {
    const now = "2026-08-11T10:00:00.000Z";
    const mapping = { id: "mapping-1", selfPersonId: "person-self", companionPersonId: "person-ta", relationshipType: "dating" as const, status: "confirmed" as const, version: 4, confirmedAt: now, createdAt: now, updatedAt: now };
    const retention = { enabled: true, version: 1, createdAt: now, updatedAt: now, enabledAt: now, disabledAt: null };
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          persistenceStatus: "confirmed",
          relationshipInteractionId: "interaction-1",
          version: 1,
          memoryBridge: { status: "pending", attemptCount: 1, updatedAt: now, retryable: true }
        }}
        items={items}
        memoryBridgeState={{
          status: "ready",
          people: [],
          selfBinding: null,
          setting: retention,
          mapping,
          review: {
            retention,
            mapping,
            interactions: [{
              interactionId: "interaction-1",
              sourceUploadId: "upload-1",
              recordingDate: "2026-08-03",
              sourceState: "server_cleaned",
              status: "completed",
              attemptCount: 1,
              selectionCount: 1,
              unknownCount: 0,
              updatedAt: now
            }]
          },
          retainedSubjects: {},
          memoryRetainedSourceKeys: [],
          relationshipPersonSources: [],
          personQaSources: []
        }}
      />
    );

    expect(document.querySelector('[data-status="completed"]')).toHaveTextContent("已整理");
    expect(screen.queryByText("等待整理")).not.toBeInTheDocument();
  });

  it("shows each completed Subject only once per recap item", () => {
    const subjects = ["both", "both", "both", "companion", "companion"] as const;
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          persistenceStatus: "confirmed",
          memoryBridge: {
            status: "completed",
            attemptCount: 1,
            updatedAt: "2026-08-11T10:00:00.000Z",
            retryable: false
          }
        }}
        items={[{
          ...items[0],
          disposition: "kept",
          sources: subjects.map((memorySubject, index) => ({
            ...items[0].sources[0],
            id: `source-${index + 1}`,
            segmentIds: [`segment-${index + 1}`],
            quote: `原话 ${index + 1}`,
            memorySubject
          }))
        }]}
      />
    );

    const subjectTags = screen.getByLabelText("这条内容的长期归属");
    expect(within(subjectTags).getAllByText("关于我们")).toHaveLength(1);
    expect(within(subjectTags).getAllByText("关于 Ta")).toHaveLength(1);
    expect([...subjectTags.querySelectorAll("span")].map((tag) => tag.textContent)).toEqual([
      "关于 Ta",
      "关于我们"
    ]);
  });

  it("keeps distinct self and unknown Subjects while ignoring sources without a Subject", () => {
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          persistenceStatus: "confirmed",
          memoryBridge: {
            status: "completed",
            attemptCount: 1,
            updatedAt: "2026-08-11T10:00:00.000Z",
            retryable: false
          }
        }}
        items={[{
          ...items[0],
          disposition: "kept",
          sources: [
            { ...items[0].sources[0], id: "source-self", memorySubject: "self" },
            { ...items[0].sources[0], id: "source-unknown-1", memorySubject: "unknown" },
            { ...items[0].sources[0], id: "source-missing" },
            { ...items[0].sources[0], id: "source-unknown-2", memorySubject: "unknown" }
          ]
        }]}
      />
    );

    const subjectTags = screen.getByLabelText("这条内容的长期归属");
    expect([...subjectTags.querySelectorAll("span")].map((tag) => tag.textContent)).toEqual([
      "关于我",
      "暂不确定"
    ]);
  });

  it("offers a read-only status refresh after bounded automatic polling stops", async () => {
    const now = "2026-08-11T10:00:00.000Z";
    const mapping = { id: "mapping-1", selfPersonId: "person-self", companionPersonId: "person-ta", relationshipType: "dating" as const, status: "confirmed" as const, version: 4, confirmedAt: now, createdAt: now, updatedAt: now };
    const retention = { enabled: true, version: 1, createdAt: now, updatedAt: now, enabledAt: now, disabledAt: null };
    const onMemoryRefresh = vi.fn().mockResolvedValue(undefined);
    const onMemorySync = vi.fn().mockResolvedValue(undefined);
    render(
      <CompanionRecap
        interaction={{ ...interaction, persistenceStatus: "confirmed", relationshipInteractionId: "interaction-1", version: 1 }}
        items={items}
        memoryBridgeState={{
          status: "ready",
          people: [],
          selfBinding: null,
          setting: retention,
          mapping,
          review: {
            retention,
            mapping,
            interactions: [{
              interactionId: "interaction-1",
              sourceUploadId: "upload-1",
              recordingDate: "2026-08-03",
              sourceState: "server_cleaned",
              status: "processing",
              attemptCount: 1,
              selectionCount: 1,
              unknownCount: 0,
              updatedAt: now
            }]
          },
          retainedSubjects: {},
          memoryRetainedSourceKeys: [],
          relationshipPersonSources: [],
          personQaSources: []
        }}
        onMemoryRefresh={onMemoryRefresh}
        onMemorySync={onMemorySync}
      />
    );

    expect(screen.getByText("整理仍在后台继续；你可以查看一次最新结果，无需重新提交。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看整理结果" }));
    await waitFor(() => expect(onMemoryRefresh).toHaveBeenCalledTimes(1));
    expect(onMemorySync).not.toHaveBeenCalled();
  });

  it("shows a cross-recording suggestion as selected but still asks for review", () => {
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          persistenceStatus: "draft",
          relationshipInteractionId: "interaction-1",
          version: 0
        }}
        items={items}
        onFinalize={vi.fn().mockResolvedValue(undefined)}
        participants={[{
          speakerId: "speaker_1",
          audioSpeakerId: "speaker_1",
          voiceEnrollmentEligible: true,
          displayLabel: "说话人 1",
          state: "unresolved",
          role: "companion",
          roleSuggestion: {
            role: "companion",
            source: "previous_confirmation"
          },
          sampleQuotes: []
        }]}
      />
    );

    expect(screen.getByText("已按你上次的确认预选，请再听一次核对")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ta" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("radio", { name: /记住这段声音/u })).not.toBeInTheDocument();
  });

  it("does not offer voice enrollment when audio exists but the server eligibility gate is absent", () => {
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          persistenceStatus: "draft",
          relationshipInteractionId: "interaction-1",
          version: 0
        }}
        items={items}
        onFinalize={vi.fn().mockResolvedValue(undefined)}
        participants={[{
          speakerId: "speaker_1",
          audioSpeakerId: "speaker_1",
          displayLabel: "说话人 1",
          state: "unresolved",
          role: "unresolved",
          sampleQuotes: []
        }]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Ta" }));
    expect(screen.queryByRole("radio", { name: /记住这段声音/u })).not.toBeInTheDocument();
  });

  it("submits one explicit voice enrollment intent only after the user opts in", async () => {
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          persistenceStatus: "draft",
          relationshipInteractionId: "interaction-1",
          version: 0
        }}
        items={[{ ...items[0], version: 2 }]}
        onFinalize={onFinalize}
        participants={[{
          speakerId: "review_same_voice",
          memberSpeakerIds: ["speaker_1", "speaker_chunk_2"],
          audioSpeakerId: "speaker_1",
          voiceEnrollmentEligible: true,
          displayLabel: "说话人 1",
          state: "unresolved",
          role: "unresolved",
          sampleQuotes: []
        }]}
      />
    );

    expect(screen.queryByRole("radio", { name: /记住这段声音/u })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ta" }));
    const enrollment = screen.getByRole("radio", { name: /记住这段声音/u });
    expect(enrollment).not.toBeChecked();
    fireEvent.click(enrollment);
    fireEvent.click(screen.getByRole("button", { name: "确认并留下这次相处" }));

    await waitFor(() => expect(onFinalize).toHaveBeenCalledWith(
      [
        { speakerId: "speaker_1", role: "companion" },
        { speakerId: "speaker_chunk_2", role: "companion" }
      ],
      [{ id: "moment-1", version: 2, disposition: "kept" }],
      [{ speakerIds: ["speaker_1", "speaker_chunk_2"] }]
    ));
  });

  it("offers multiple unproven Ta voice groups separately but submits only the one explicitly selected", async () => {
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          persistenceStatus: "draft",
          relationshipInteractionId: "interaction-1",
          version: 0
        }}
        items={[{ ...items[0], version: 2 }]}
        onFinalize={onFinalize}
        participants={[
          {
            speakerId: "speaker_1",
            audioSpeakerId: "speaker_1",
            voiceEnrollmentEligible: true,
            displayLabel: "说话人 1",
            state: "unresolved",
            role: "unresolved",
            sampleQuotes: []
          },
          {
            speakerId: "speaker_2",
            audioSpeakerId: "speaker_2",
            voiceEnrollmentEligible: true,
            displayLabel: "说话人 2",
            state: "unresolved",
            role: "unresolved",
            sampleQuotes: []
          }
        ]}
      />
    );

    const companionChoices = screen.getAllByRole("button", { name: "Ta" });
    fireEvent.click(companionChoices[0]);
    fireEvent.click(companionChoices[1]);
    const enrollmentChoices = screen.getAllByRole("radio", { name: /记住这段声音/u });
    expect(enrollmentChoices).toHaveLength(2);
    expect(enrollmentChoices[0]).not.toBeChecked();
    expect(enrollmentChoices[1]).not.toBeChecked();

    fireEvent.click(enrollmentChoices[0]);
    expect(enrollmentChoices[0]).toBeChecked();
    fireEvent.click(enrollmentChoices[1]);
    expect(enrollmentChoices[0]).not.toBeChecked();
    expect(enrollmentChoices[1]).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "确认并留下这次相处" }));

    await waitFor(() => expect(onFinalize).toHaveBeenCalledWith(
      [
        { speakerId: "speaker_1", role: "companion" },
        { speakerId: "speaker_2", role: "companion" }
      ],
      [{ id: "moment-1", version: 2, disposition: "kept" }],
      [{ speakerIds: ["speaker_2"] }]
    ));
  });

  it("confirms one reviewed voice group for every underlying chunk candidate", async () => {
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          persistenceStatus: "draft",
          relationshipInteractionId: "interaction-1",
          version: 0
        }}
        items={[{ ...items[0], version: 2 }]}
        onFinalize={onFinalize}
        participants={[{
          speakerId: "review_same_voice",
          memberSpeakerIds: ["speaker_1", "speaker_chunk_2"],
          audioSpeakerId: "speaker_chunk_2",
          displayLabel: "说话人 1",
          state: "unresolved",
          role: "unresolved",
          sampleQuotes: []
        }]}
      />
    );

    expect(screen.getByLabelText("说话人 1的声音节选")).toHaveAttribute(
      "src",
      "/api/date-companion/interactions/interaction-1/participants/speaker_chunk_2/audio"
    );
    fireEvent.click(screen.getByRole("button", { name: "我" }));
    expect(screen.getByText("根据原话整理的内容").closest("[data-disposition]")).toHaveAttribute(
      "data-disposition",
      "kept"
    );
    fireEvent.click(screen.getByRole("button", { name: "确认并留下这次相处" }));

    await waitFor(() => expect(onFinalize).toHaveBeenCalledWith(
      [
        { speakerId: "speaker_1", role: "self" },
        { speakerId: "speaker_chunk_2", role: "self" }
      ],
      [{ id: "moment-1", version: 2, disposition: "kept" }],
      []
    ));
  });

  it("keeps per-item editing and exclusion optional while preserving automatic safety", async () => {
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    const mentioned: RecapItemVM = {
      ...items[0],
      id: "mentioned-1",
      kind: "mentioned",
      version: 4
    };
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          persistenceStatus: "draft",
          relationshipInteractionId: "interaction-1",
          version: 2
        }}
        items={[{ ...items[0], version: 3 }, mentioned]}
        onFinalize={onFinalize}
        participants={[{
          speakerId: "speaker_1",
          displayLabel: "说话人 1",
          state: "confirmed",
          role: "self",
          sampleQuotes: []
        }]}
      />
    );

    expect(screen.getByRole("button", { name: "修改" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "这条不留下" })).toBeInTheDocument();
    expect(screen.getByText("未留下 1 条")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "修改" }));
    const editor = screen.getByRole("textbox", { name: "修改这条：值得记住" });
    fireEvent.change(editor, { target: { value: "用户修改后的内容" } });
    fireEvent.click(screen.getByRole("button", { name: "应用修改" }));
    fireEvent.click(screen.getByRole("button", { name: "这条不留下" }));
    expect(screen.getAllByText("你选择不留下这条")).toHaveLength(1);
    fireEvent.click(screen.getAllByText("未留下 1 条")[0]);
    fireEvent.click(screen.getByRole("button", { name: "恢复这条" }));
    fireEvent.click(screen.getByRole("button", { name: "确认并留下这次相处" }));
    await waitFor(() => expect(onFinalize).toHaveBeenCalledWith(
      [{ speakerId: "speaker_1", role: "self" }],
      [
        { id: "moment-1", version: 3, userText: "用户修改后的内容", disposition: "kept" },
        { id: "mentioned-1", version: 4, disposition: "excluded" }
      ],
      []
    ));
  });

  it("lets the speaker review collapse without changing its controls", () => {
    const { container } = render(
      <CompanionRecap
        interaction={{ ...interaction, persistenceStatus: "draft", relationshipInteractionId: "interaction-1" }}
        items={items}
        onFinalize={vi.fn()}
      />
    );

    const summary = screen.getByText("这次录音里的说话人").closest("summary");
    const details = summary?.closest("details");
    expect(details).toHaveAttribute("open");
    const selfChoice = screen.getByRole("button", { name: "我" });
    fireEvent.click(selfChoice);
    expect(selfChoice).toHaveAttribute("aria-pressed", "true");
    expect(summary).not.toBeNull();
    fireEvent.click(summary!);
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(summary!);
    expect(details).toHaveAttribute("open");
    expect(selfChoice).toHaveAttribute("aria-pressed", "true");
  });

  it("shows only five recap items until that group is expanded", () => {
    const manyMoments = Array.from({ length: 7 }, (_, index) => ({
      ...items[0],
      id: `moment-${index + 1}`,
      displayedText: `值得记住的内容 ${index + 1}`,
      proposedText: `值得记住的内容 ${index + 1}`
    }));
    render(
      <CompanionRecap
        interaction={{ ...interaction, persistenceStatus: "confirmed" }}
        items={manyMoments.map((item) => ({ ...item, disposition: "kept" }))}
      />
    );

    expect(screen.getByText("值得记住的内容 5")).toBeInTheDocument();
    expect(screen.queryByText("值得记住的内容 6")).not.toBeInTheDocument();
    const expand = screen.getByRole("button", { name: "展开其余 2 条" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(expand);
    expect(screen.getByText("值得记住的内容 6")).toBeInTheDocument();
    expect(screen.getByText("值得记住的内容 7")).toBeInTheDocument();
    const collapse = screen.getByRole("button", { name: "收起，仅显示前 5 条" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapse);
    expect(screen.queryByText("值得记住的内容 6")).not.toBeInTheDocument();
  });

  it("shows confirmed participant roles on the read-only recap", () => {
    render(
      <CompanionRecap
        interaction={{ ...interaction, persistenceStatus: "confirmed" }}
        items={[{ ...items[0], disposition: "kept" }]}
        participants={[{
          speakerId: "speaker_1",
          displayLabel: "说话人 1",
          state: "confirmed",
          role: "self",
          sampleQuotes: []
        }]}
      />
    );

    expect(screen.getByText("已确认：我")).toBeInTheDocument();
    expect(screen.queryByText("尚未核对")).not.toBeInTheDocument();
  });

  it("shows evidence without creating a broken transcript link on a new device", () => {
    render(
      <CompanionRecap
        interaction={{ ...interaction, transcript: [], persistenceStatus: "confirmed" }}
        items={[{ ...items[0], disposition: "kept" }]}
      />
    );

    fireEvent.click(screen.getByText("展开来源"));
    expect(screen.getByText("已保留可核对原话")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "在文字稿中查看" })).not.toBeInTheDocument();
    expect(screen.getByText(/这台设备没有完整文字稿/u)).toBeInTheDocument();
  });

  it("uses the complete server participant set when this device has no transcript", async () => {
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    const companionSource = {
      ...items[0].sources[0],
      id: "source-2",
      speakerId: "speaker_2",
      quote: "Ta 在服务端保留的原话。"
    };
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          transcript: [],
          persistenceStatus: "draft",
          relationshipInteractionId: "interaction-1"
        }}
        items={[
          { ...items[0], version: 1 },
          { ...items[0], id: "mentioned-1", kind: "mentioned", sources: [companionSource], version: 2 }
        ]}
        onFinalize={onFinalize}
        participants={[
          {
            speakerId: "speaker_1",
            displayLabel: "第一段声音",
            state: "confirmed",
            role: "self",
            sampleQuotes: [items[0].sources[0]]
          },
          {
            speakerId: "speaker_2",
            displayLabel: "第二段声音",
            state: "confirmed",
            role: "companion",
            sampleQuotes: [companionSource]
          }
        ]}
      />
    );

    expect(screen.getByLabelText("第一段声音的声音节选")).toHaveAttribute(
      "src",
      "/api/date-companion/interactions/interaction-1/participants/speaker_1/audio"
    );
    expect(screen.getByLabelText("第二段声音的声音节选")).toHaveAttribute(
      "src",
      "/api/date-companion/interactions/interaction-1/participants/speaker_2/audio"
    );
    expect(screen.getAllByText("“Ta 在服务端保留的原话。”")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "确认并留下这次相处" }));

    await waitFor(() => expect(onFinalize).toHaveBeenCalledWith(
      [
        { speakerId: "speaker_1", role: "self" },
        { speakerId: "speaker_2", role: "companion" }
      ],
      [
        { id: "moment-1", version: 1, disposition: "kept" },
        { id: "mentioned-1", version: 2, disposition: "kept" }
      ],
      []
    ));
  });

  it("allows finalize when an unresolved speaker appears only in an excluded item", async () => {
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    const secondSource = {
      ...items[0].sources[0],
      id: "source-2",
      segmentIds: ["segment-2"],
      speakerId: "speaker_2",
      quote: "这条不会留下。"
    };
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          persistenceStatus: "draft",
          relationshipInteractionId: "interaction-1",
          version: 5,
          transcript: [
            ...interaction.transcript,
            { id: "segment-2", uploadId: "upload-1", startSeconds: 5, endSeconds: 8, speakerId: "speaker_2", text: "这条不会留下。" }
          ]
        }}
        items={[
          { ...items[0], disposition: "kept", version: 1 },
          { ...items[0], id: "mentioned-excluded", kind: "mentioned", disposition: "excluded", sources: [secondSource], version: 1 }
        ]}
        onFinalize={onFinalize}
        participants={[
          { speakerId: "speaker_1", displayLabel: "说话人 1", state: "confirmed", role: "self", sampleQuotes: [] },
          { speakerId: "speaker_2", displayLabel: "说话人 2", state: "unresolved", role: "unresolved", sampleQuotes: [] }
        ]}
      />
    );

    const finalButton = screen.getByRole("button", { name: "确认并留下这次相处" });
    expect(finalButton).toBeEnabled();
    fireEvent.click(finalButton);
    await waitFor(() => expect(onFinalize).toHaveBeenCalledWith(
      [
        { speakerId: "speaker_1", role: "self" },
        { speakerId: "speaker_2", role: "unresolved" }
      ],
      [
        { id: "moment-1", version: 1, disposition: "kept" },
        { id: "mentioned-excluded", version: 1, disposition: "excluded" }
      ],
      []
    ));
  });

  it("does not invent a participant for transcript lines without a speaker label", () => {
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          persistenceStatus: "draft",
          relationshipInteractionId: "interaction-1",
          transcript: [{ ...interaction.transcript[0], speakerId: undefined }]
        }}
        items={[]}
        onFinalize={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getAllByText(/没有稳定的说话人标记/u)).toHaveLength(2);
    expect(screen.getByText("没有可核对的说话人")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认并留下这次相处" })).toBeDisabled();
  });
});

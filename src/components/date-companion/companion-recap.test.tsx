import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InteractionVM, RecapItemVM } from "@/lib/domain/date-companion";

import { CompanionRecap } from "./companion-recap";
import { BookObservation } from "./book-panels";

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

const openSpeakers = () => {
  const trigger = within(document.querySelector<HTMLElement>("[data-book-recap] > aside")!).getByRole("button", { name: /^核对说话人$/u });
  fireEvent.click(trigger);
  return screen.getByRole("dialog", { name: "核对说话人" });
};
const openMemory = () => {
  fireEvent.click(screen.getByRole("button", { name: /查看内容与归属|翻看长期记忆/ }));
  return screen.getByRole("dialog", { name: "长期记忆" });
};
const itemCard = (id: string) => document.querySelector<HTMLElement>('[data-book-item="' + id + '"]')!;
const openItem = (id = "moment-1") => fireEvent.click(itemCard(id).querySelector("h4 button")!);
const observation = (status: "ready" | "fallback") => ({status, fingerprint: "audit-observation", observation: "只出现一次的小发现",
  caution: "只依据本次原话。", suggestedQuestions: [], sources: items[0].sources});

describe("CompanionRecap", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/date-companion/a/recap");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn()
    });
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event("close")); } });
    vi.stubGlobal("matchMedia", (query: string) => ({ media: query, matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.stubGlobal("scrollTo", vi.fn());
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  });

  it("opens speaker review and one AI observation in the approved recap", () => {
    render(<CompanionRecap interaction={interaction} items={items}
      proactiveObservation={<BookObservation presentation={observation("ready")} />} />);
    const speakerPanel = openSpeakers();
    fireEvent.click(within(speakerPanel).getByRole("button", { name: "返回复盘" }));
    fireEvent.click(screen.getByRole("button", { name: /AI 观察/ }));
    const note = screen.getByRole("dialog", { name: "AI 观察" });
    expect(within(note).getAllByText("只出现一次的小发现")).toHaveLength(1);
    expect(within(note).getByText("观察边界")).toBeInTheDocument();
    expect(within(note).queryByText(/confidence|Provider/u)).not.toBeInTheDocument();
  });

  it("labels deterministic fallback content as a raw-text clue", () => {
    render(<CompanionRecap interaction={interaction} items={items}
      proactiveObservation={<BookObservation presentation={observation("fallback")} />} />);
    fireEvent.click(screen.getByRole("button", { name: /原话线索/ }));
    const note = screen.getByRole("dialog", { name: "原话线索" });
    expect(within(note).getByText("线索边界")).toBeInTheDocument();
    expect(within(note).getByRole("blockquote")).toHaveTextContent(items[0].sources[0].quote);
    expect(screen.queryByRole("heading", { name: "AI 观察" })).not.toBeInTheDocument();
    fireEvent.click(within(note).getByRole("button", { name: "觉得不太准确，先收起" }));
    expect(screen.queryByRole("dialog", { name: "原话线索" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /原话线索.*重新显示/ })).toBeInTheDocument();
    expect(items[0].sources[0].quote).toBe("这是一条可以核对的原话。");
  });

  it("opens the real segment and highlights the matching transcript line", async () => {
    render(<CompanionRecap interaction={interaction} items={items} />);
    openItem();
    fireEvent.click(screen.getByRole("button", { name: "查看文字稿" }));
    const transcript = screen.getByRole("dialog", { name: "完整文字稿" });
    expect(window.location.pathname).toBe("/date-companion/a/recap");
    expect(window.location.search).toBe("?segment=segment-1");
    expect(window.location.hash).toBe("#full-transcript");
    await waitFor(() => expect(transcript.querySelector('[data-segment-id="segment-1"]')).toHaveAttribute("aria-current", "true"));
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

    openSpeakers();
    const audio = screen.getByLabelText("说话人 1的声音节选");
    expect(audio).toHaveAttribute(
      "src",
      "/api/date-companion/interactions/interaction-1/participants/speaker_1/audio"
    );
    expect(screen.queryByText(/Provider/u)).not.toBeInTheDocument();
    fireEvent.error(audio);
    expect(screen.getByText("声音节选暂不可用，请结合原话判断。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "暂不确定" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /^(?:整组都是)?我$/u }));
    fireEvent.click(screen.getByRole("button", { name: "完成本次复盘" }));

    await waitFor(() => expect(onFinalize).toHaveBeenCalledWith(
      [{ speakerId: "speaker_1", role: "self" }],
      [{ id: "moment-1", version: 3, disposition: "kept" }],
      []
    ));
  });

  it("keeps mixed labels unresolved and only submits the individually confirmed original snapshot", async () => {
    const onFinalize = vi.fn().mockResolvedValue(undefined), onSaveSegmentReview = vi.fn().mockResolvedValue(undefined);
    const base = items[0].sources[0];
    const withSource = (id:string, text:string, seconds:number, digest:string): RecapItemVM => ({
      ...items[0], id, sources:[{...base,id:"source-"+id,segmentIds:[id],quote:text,
        startSeconds:seconds,endSeconds:seconds+2,contentDigest:digest}]
    });
    const mixed = withSource("segment-1","我记了地址。样图是我发的。",1,"a".repeat(64));
    const clean = withSource("segment-2","周五前寄纸样。",4,"b".repeat(64));
    render(<CompanionRecap interaction={{...interaction,relationshipInteractionId:"i",persistenceStatus:"draft",version:0}}
      items={[mixed,clean]} participants={[{speakerId:"speaker_1",displayLabel:"说话人 1",state:"unresolved",
        role:"companion",roleSuggestion:{role:"companion",source:"previous_confirmation"}, sampleQuotes:[]}]}
      onFinalize={onFinalize} onSaveSegmentReview={onSaveSegmentReview}/>);
    openSpeakers();
    fireEvent.click(screen.getByRole("button",{name:"混有不同声音，逐段核对"}));
    expect(screen.getByRole("button",{name:"完成本次复盘"})).toBeDisabled();
    const selects = screen.getAllByRole("combobox");
    expect(selects.every(el=>(el as HTMLSelectElement).value==="unresolved")).toBe(true);
    fireEvent.click(screen.getByRole("button",{name:"保存分段核对，继续留作草稿"}));
    await waitFor(()=>expect(onSaveSegmentReview).toHaveBeenCalledWith([{speakerId:"speaker_1",role:"unresolved",reviewedSegments:[]}]));
    fireEvent.change(selects[1],{target:{value:"self"}});
    fireEvent.click(screen.getByRole("button",{name:"完成本次复盘"}));
    await waitFor(()=>expect(onFinalize).toHaveBeenCalledWith([{speakerId:"speaker_1",role:"unresolved",reviewedSegments:[
      {sourceSegmentId:"segment-2",contentDigest:"b".repeat(64),role:"self"}]}],
      [{id:"segment-1",version:0,disposition:"excluded"},{id:"segment-2",version:0,disposition:"kept"}], []));
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
      if (String(_input).endsWith("?read=status")) {
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

    const memory = openMemory();
    expect(fetchSuggestion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: /这次也整理进长期记忆/u }));
    expect(await screen.findByText("正在整理内容归属；你仍可先完成本次复盘。")).toBeInTheDocument();
    await waitFor(() => expect(fetchSuggestion).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchSuggestion.mock.calls[1][1]?.body))).toEqual({
      version: 0, itemIds: ["recap-1","recap-2"], assignments: [{speakerId:"speaker_1",role:"companion"}]
    });
    resolveSuggestion(Response.json({ batch }));
    await screen.findByText(/会接受这些归属|才会接受这些归属/u);
    expect(fetchSuggestion).toHaveBeenCalledTimes(2);
    const subject = within(memory).getByRole("tab", { name: /暂不确定.*1/u });
    fireEvent.click(subject);
    expect(within(memory).getByRole("tabpanel")).toHaveTextContent("这是一条可以核对的原话。");
    expect(within(memory).queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.click(within(memory).getByRole("button", { name: /返回复盘/ }));
    fireEvent.click(screen.getByRole("button", { name: "完成本次复盘" }));

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

    const memory = openMemory();
    expect(fetchSuggestion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "生成归属建议" }));
    await screen.findByText(/会接受这些归属|才会接受这些归属/u);
    expect(onMemorySync).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "开始长期整理" })).toBeDisabled();
    rerender(subjectBackfill("excluded"));
    const syncButton = screen.getByRole("button", { name: "开始长期整理" });
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

    const memory = openMemory();
    const panel = memory;
    expect(await within(panel).findByText("这段长期关系记录之前已被清理；重新启用后会按你确认的归属继续整理。")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "生成归属建议" }));
    await within(panel).findByText(/会接受这些归属|才会接受这些归属/u);
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

    const memory = openMemory();
    expect(screen.getByText("这次原话来源已经变化，暂时不能继续长期整理。")).toBeInTheDocument();
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

    const memory = openMemory();
    fireEvent.click(screen.getByRole("checkbox", { name: /这次也整理进长期记忆/u }));
    expect(await screen.findByRole("alert")).toHaveTextContent("仍可完成本次复盘");
    expect(screen.getByRole("button", { name: "完成本次复盘" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "完成本次复盘" }));
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

    expect(screen.getByRole("button", { name: "翻看长期记忆" })).toBeVisible();
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

    openItem();
    expect(within(itemCard("moment-1")).getByText("长期归属 · Ta、我们")).toBeVisible();
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

    openItem();
    expect(within(itemCard("moment-1")).getByText("长期归属 · 我、暂不确定")).toBeVisible();
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

    const memory = openMemory();
    expect(screen.getByText("长期整理仍在后台继续。")).toBeInTheDocument();
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

    openSpeakers();
    expect(screen.getByText("已按上次确认预选，请再核对一次")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^(?:整组都是)?Ta$/u })).toHaveAttribute("aria-pressed", "true");
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

    openSpeakers();
    fireEvent.click(screen.getByRole("button", { name: /^(?:整组都是)?Ta$/u }));
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

    openSpeakers();
    expect(screen.queryByRole("radio", { name: /记住这段声音/u })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^(?:整组都是)?Ta$/u }));
    const enrollment = screen.getByRole("checkbox", { name: /记住这段声音/u });
    expect(enrollment).not.toBeChecked();
    fireEvent.click(enrollment);
    fireEvent.click(screen.getByRole("button", { name: "完成本次复盘" }));

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

    const groupPanel = openSpeakers();
    const companionChoices = within(groupPanel).getAllByRole("button", { name: /^(?:整组都是)?Ta$/u });
    fireEvent.click(companionChoices[0]);
    fireEvent.click(companionChoices[1]);
    const enrollmentChoices = screen.getAllByRole("checkbox", { name: /记住这段声音/u });
    expect(enrollmentChoices).toHaveLength(2);
    expect(enrollmentChoices[0]).not.toBeChecked();
    expect(enrollmentChoices[1]).not.toBeChecked();

    fireEvent.click(enrollmentChoices[0]);
    expect(enrollmentChoices[0]).toBeChecked();
    fireEvent.click(enrollmentChoices[1]);
    expect(enrollmentChoices[0]).not.toBeChecked();
    expect(enrollmentChoices[1]).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "完成本次复盘" }));

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

    openSpeakers();
    expect(screen.getByLabelText("说话人 1的声音节选")).toHaveAttribute(
      "src",
      "/api/date-companion/interactions/interaction-1/participants/speaker_chunk_2/audio"
    );
    fireEvent.click(screen.getByRole("button", { name: /^(?:整组都是)?我$/u }));
    expect(screen.getByText("根据原话整理的内容").closest("[data-disposition]")).toHaveAttribute(
      "data-disposition",
      "kept"
    );
    fireEvent.click(screen.getByRole("button", { name: "完成本次复盘" }));

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

    openItem();
    expect(screen.getByRole("button", { name: "修改" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "这条不留下" })).toBeInTheDocument();
    expect(itemCard("mentioned-1")).toHaveAttribute("data-disposition", "excluded");
    fireEvent.click(screen.getByRole("button", { name: "修改" }));
    const editor = screen.getByRole("textbox", { name: "修改摘要" });
    fireEvent.change(editor, { target: { value: "用户修改后的内容" } });
    fireEvent.click(screen.getByRole("button", { name: "应用修改" }));
    fireEvent.click(screen.getByRole("button", { name: "这条不留下" }));
    expect(screen.getAllByText(/你选择不留下这条/u)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "恢复这条" }));
    fireEvent.click(screen.getByRole("button", { name: "完成本次复盘" }));
    await waitFor(() => expect(onFinalize).toHaveBeenCalledWith(
      [{ speakerId: "speaker_1", role: "self" }],
      [
        { id: "moment-1", version: 3, userText: "用户修改后的内容", disposition: "kept" },
        { id: "mentioned-1", version: 4, disposition: "excluded" }
      ],
      []
    ));
  });

  it("closes and reopens speaker review without changing its current choices", () => {
    render(<CompanionRecap interaction={{ ...interaction, persistenceStatus: "draft", relationshipInteractionId: "interaction-1" }}
      items={items} onFinalize={vi.fn()} />);
    const panel = openSpeakers();
    expect(panel.querySelector("details")).toHaveAttribute("data-review-complete", "false");
    fireEvent.click(within(panel).getByRole("button", { name: /^(?:整组都是)?我$/u }));
    fireEvent.click(within(panel).getByRole("button", { name: "返回复盘" }));
    expect(screen.queryByRole("dialog", { name: "核对说话人" })).not.toBeInTheDocument();
    expect(within(openSpeakers()).getByRole("button", { name: /^(?:整组都是)?我$/u })).toHaveAttribute("aria-pressed", "true");
  });

  it("treats an explicit unresolved choice as reviewed while keeping it fail closed", () => {
    render(<CompanionRecap interaction={{ ...interaction, persistenceStatus: "draft", relationshipInteractionId: "interaction-1" }}
      items={items} onFinalize={vi.fn()} />);
    const panel = openSpeakers();
    fireEvent.click(within(panel).getByRole("button", { name: "暂不确定" }));
    expect(panel.querySelector("details")).toHaveAttribute("data-review-complete", "true");
    expect(itemCard("moment-1")).toHaveAttribute("data-disposition", "excluded");
    expect(screen.getByRole("button", { name: "完成本次复盘" })).toBeDisabled();
  });

  it("does not treat a previous role suggestion as confirmation in this review", () => {
    render(
      <CompanionRecap
        interaction={{ ...interaction, persistenceStatus: "draft", relationshipInteractionId: "interaction-1" }}
        items={items}
        onFinalize={vi.fn()}
        participants={[{
          speakerId: "speaker_1",
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

    const panel = openSpeakers();
    expect(panel.querySelector("details")).toHaveAttribute("data-review-complete", "false");
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

    openSpeakers();
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

    openItem();
    expect(itemCard("moment-1").querySelector("blockquote")).toHaveTextContent(items[0].sources[0].quote);
    expect(within(itemCard("moment-1")).queryByRole("button", { name: "查看文字稿" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "已保存的来源片段" }));
    expect(screen.getByRole("dialog", { name: "已保存的来源片段" })).toHaveTextContent(items[0].sources[0].quote);
  });

  it("does not request audio when availability is absent even if a single speaker is known", () => {
    render(<CompanionRecap interaction={{ ...interaction, relationshipInteractionId: "interaction-1" }}
      items={items} participants={[{ speakerId: "speaker_1", displayLabel: "声音 1", state: "confirmed",
        role: "self", sampleQuotes: [] }]} />);
    openSpeakers();
    expect(document.querySelector("audio")).toBeNull();
    expect(screen.getByText("声音节选暂不可用，请结合原话判断。")).toBeInTheDocument();
  });

  it("keeps unavailable audio hidden after a stale availability response fails and the same interaction rerenders", () => {
    const props = { interaction: { ...interaction, relationshipInteractionId: "interaction-1" }, items,
      participants: [{ speakerId: "speaker_1", audioSpeakerId: "speaker_1", displayLabel: "声音 1",
        state: "confirmed" as const, role: "self" as const, sampleQuotes: [] }] };
    const { rerender } = render(<CompanionRecap {...props} />);
    openSpeakers();
    fireEvent.error(screen.getByLabelText("声音 1的声音节选"));
    expect(document.querySelector("audio")).toBeNull();
    rerender(<CompanionRecap {...props} participants={props.participants.map((item) => ({ ...item }))} />);
    expect(document.querySelector("audio")).toBeNull();
    expect(screen.getByText("声音节选暂不可用，请结合原话判断。")).toBeInTheDocument();
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
            audioSpeakerId: "speaker_1",
            state: "confirmed",
            role: "self",
            sampleQuotes: [items[0].sources[0]]
          },
          {
            speakerId: "speaker_2",
            displayLabel: "第二段声音",
            audioSpeakerId: "speaker_2",
            state: "confirmed",
            role: "companion",
            sampleQuotes: [companionSource]
          }
        ]}
      />
    );

    openSpeakers();
    expect(screen.getByLabelText("第一段声音的声音节选")).toHaveAttribute(
      "src",
      "/api/date-companion/interactions/interaction-1/participants/speaker_1/audio"
    );
    expect(screen.getByLabelText("第二段声音的声音节选")).toHaveAttribute(
      "src",
      "/api/date-companion/interactions/interaction-1/participants/speaker_2/audio"
    );
    expect(screen.getAllByText("“Ta 在服务端保留的原话。”")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "完成本次复盘" }));

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

    const finalButton = screen.getByRole("button", { name: "完成本次复盘" });
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

    openSpeakers();
    expect(screen.getAllByText(/没有稳定的说话人标记/u)).toHaveLength(2);
    expect(screen.getByText("没有可核对的说话人")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "完成本次复盘" })).toBeDisabled();
  });
});

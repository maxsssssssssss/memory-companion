import { describe, expect, it } from "vitest";

import { combineDayPayloads } from "@/lib/client/day-aggregation";
import { parseDayPayload, type DayPayload } from "@/lib/domain/day-payload";
import { emptyDateCompanionViewModel } from "@/lib/domain/date-companion";
import type { DcRelationshipView } from "@/lib/domain/date-companion-stage2";

import {
  applyDateCompanionRelationshipView,
  buildDateCompanionSearchResults,
  buildDateCompanionViewModel,
  DateCompanionAdapterError
} from "./date-companion-adapter";
import { isRealDateCompanionUploadId } from "./date-companion-api";
import { dateCompanionProactiveSourceRevision } from "./date-companion-proactive-value";

function payloadFixture(): DayPayload {
  return parseDayPayload({
    upload: {
      id: "upload_1",
      originalName: "date.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 2048,
      recordingDate: "2026-08-04",
      createdAt: "2026-08-04T10:00:00.000Z",
      durationSeconds: 20,
      status: "ready"
    },
    job: {
      id: "job_1",
      uploadId: "upload_1",
      status: "ready",
      progress: 100
    },
    segments: [
      {
        id: "segment_2",
        uploadId: "upload_1",
        startSeconds: 8,
        endSeconds: 12,
        speaker: "speaker_1",
        text: "下次我们可以一起去看展。",
        confidence: 0.93,
        sceneLabels: ["unknown"],
        valueLabels: ["open_question"]
      },
      {
        id: "segment_1",
        uploadId: "upload_1",
        startSeconds: 1,
        endSeconds: 5,
        speaker: "speaker_0",
        text: "今晚聊得很放松。",
        confidence: 0.96,
        sceneLabels: ["unknown"],
        valueLabels: ["notable_quote"]
      }
    ],
    audioInsights: [],
    semanticSegments: [
      {
        id: "semantic_1",
        uploadId: "upload_1",
        title: "聊到看展",
        summary: "你们聊到了下次一起看展。",
        startSeconds: 8,
        endSeconds: 12,
        tags: ["看展"],
        sceneLabels: ["unknown"],
        valueLabels: ["open_question"],
        confidence: 0.9,
        sourceSegmentIds: ["segment_2"],
        sourceTimeRange: { startSeconds: 8, endSeconds: 12 },
        transcriptExcerpt: "下次我们可以一起去看展。"
      }
    ],
    semanticSegmentsAvailable: true,
    briefItems: [
      {
        id: "brief_moment",
        uploadId: "upload_1",
        category: "notable_quote",
        title: "值得记住",
        body: "这次聊天很放松。",
        priority: "high",
        confidence: 0.9,
        status: "candidate",
        sourceSegmentIds: ["segment_1"],
        sourceTimeRange: { startSeconds: 1, endSeconds: 5 },
        transcriptExcerpt: "今晚聊得很放松。",
        people: [],
        topics: []
      },
      {
        id: "brief_open",
        uploadId: "upload_1",
        category: "open_question",
        title: "下次可以继续",
        body: "可以继续聊想看的展。",
        priority: "medium",
        confidence: 0.86,
        status: "candidate",
        sourceSegmentIds: ["segment_2"],
        sourceTimeRange: { startSeconds: 8, endSeconds: 12 },
        transcriptExcerpt: "下次我们可以一起去看展。",
        people: [],
        topics: []
      },
      {
        id: "brief_broken_source",
        uploadId: "upload_1",
        category: "notable_quote",
        title: "没有真实来源",
        body: "这条不能展示。",
        priority: "high",
        confidence: 0.99,
        status: "candidate",
        sourceSegmentIds: ["missing_segment"],
        sourceTimeRange: { startSeconds: 13, endSeconds: 14 },
        transcriptExcerpt: "不存在",
        people: [],
        topics: []
      }
    ],
    relationshipSignals: [],
    relationshipSignalsAvailable: true,
    proactiveInsights: [],
    proactiveInsightsAvailable: true,
    speakerAliases: { speaker_0: "我", speaker_1: "Ta" },
    speakerAliasesByUploadId: { upload_1: { speaker_0: "我", speaker_1: "Ta" } }
  });
}

function relationshipViewFixture(): DcRelationshipView {
  const evidence = (id: string, recapItemId: string, segmentId: string, speakerId: string, quote: string) => ({
    id,
    recapItemId,
    uploadId: "upload_1",
    sourceSegmentId: segmentId,
    startSeconds: segmentId === "segment_1" ? 1 : 8,
    endSeconds: segmentId === "segment_1" ? 5 : 12,
    speakerId,
    quote,
    createdAt: "2026-08-04T10:00:00.000Z"
  });
  const recapItems = [
    {
      id: "recap_moment",
      interactionId: "interaction_1",
      kind: "moment" as const,
      proposedText: "今晚聊得很放松。",
      displayedText: "今晚聊得很放松。",
      disposition: "kept" as const,
      version: 1,
      sortOrder: 0,
      evidence: [evidence("evidence_moment", "recap_moment", "segment_1", "speaker_0", "今晚聊得很放松。")]
    },
    {
      id: "recap_mentioned",
      interactionId: "interaction_1",
      kind: "mentioned" as const,
      proposedText: "Ta 想去看展。",
      displayedText: "Ta 想去看展。",
      disposition: "kept" as const,
      version: 1,
      sortOrder: 1,
      evidence: [evidence("evidence_mentioned", "recap_mentioned", "segment_2", "speaker_1", "下次我们可以一起去看展。")]
    },
    {
      id: "recap_promise",
      interactionId: "interaction_1",
      kind: "promise" as const,
      proposedText: "我来查展览。",
      displayedText: "我来查展览。",
      disposition: "kept" as const,
      version: 1,
      sortOrder: 2,
      evidence: [evidence("evidence_promise", "recap_promise", "segment_1", "speaker_0", "今晚聊得很放松。")]
    },
    {
      id: "recap_excluded",
      interactionId: "interaction_1",
      kind: "continue" as const,
      proposedText: "不应进入准备页。",
      displayedText: "不应进入准备页。",
      disposition: "excluded" as const,
      version: 1,
      sortOrder: 3,
      evidence: [evidence("evidence_excluded", "recap_excluded", "segment_2", "speaker_1", "下次我们可以一起去看展。")]
    },
    {
      id: "recap_unresolved",
      interactionId: "interaction_1",
      kind: "moment" as const,
      proposedText: "来源人物仍未确认。",
      displayedText: "来源人物仍未确认。",
      disposition: "kept" as const,
      version: 1,
      sortOrder: 4,
      evidence: [evidence("evidence_unresolved", "recap_unresolved", "segment_2", "speaker_x", "下次我们可以一起去看展。")]
    }
  ];
  return {
    relationship: {
      id: "relationship_1",
      displayName: "小满",
      status: "active",
      version: 1,
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-04T10:00:00.000Z"
    },
    interactions: [
      {
        id: "interaction_1",
        relationshipId: "relationship_1",
        sourceUploadId: "upload_1",
        recordingDate: "2026-08-04",
        originalName: "date.m4a",
        durationSeconds: 20,
        status: "confirmed",
        sourceState: "server_cleaned",
        version: 2,
        createdAt: "2026-08-04T10:00:00.000Z",
        updatedAt: "2026-08-04T11:00:00.000Z",
        confirmedAt: "2026-08-04T11:00:00.000Z",
        memoryBridge: {
          status: "completed",
          attemptCount: 1,
          updatedAt: "2026-08-04T11:00:00.000Z",
          retryable: false
        },
        participants: [
          { speakerId: "speaker_0", role: "self", confirmedAt: "2026-08-04T10:30:00.000Z" },
          { speakerId: "speaker_1", role: "companion", confirmedAt: "2026-08-04T10:30:00.000Z" },
          { speakerId: "speaker_x", role: "unresolved" }
        ],
        recapItems
      }
    ],
    promises: [
      {
        id: "promise_1",
        relationshipId: "relationship_1",
        originatingRecapItemId: "recap_promise",
        text: "我来查展览。",
        status: "open",
        version: 0,
        createdAt: "2026-08-04T11:00:00.000Z",
        updatedAt: "2026-08-04T11:00:00.000Z",
        evidence: recapItems[2].evidence
      }
    ]
  };
}

describe("date-companion adapter", () => {
  it("chooses the last saved home recap by confirmation time and stable ID within the current relationship", () => {
    const view = relationshipViewFixture();
    const base = view.interactions[0];
    view.interactions = [
      { ...base, id: "older_confirmation", recordingDate: "2026-08-30" },
      { ...base, id: "saved_a", recordingDate: "2026-08-01", confirmedAt: "2026-08-05T11:00:00.000Z", memoryBridge: undefined },
      { ...base, id: "saved_b", recordingDate: "2026-08-02", confirmedAt: "2026-08-05T11:00:00.000Z", memoryBridge: undefined },
      { ...base, id: "draft", status: "draft", confirmedAt: undefined, updatedAt: "2026-08-09T11:00:00.000Z" },
      { ...base, id: "deleted", sourceState: "explicitly_deleted", confirmedAt: "2026-08-09T11:00:00.000Z" },
      { ...base, id: "other_relationship", relationshipId: "relationship_other", confirmedAt: "2026-08-09T11:00:00.000Z" }
    ];
    const home = applyDateCompanionRelationshipView(emptyDateCompanionViewModel(), view).home;
    expect(home.lastSaved?.interaction.relationshipInteractionId).toBe("saved_b");
    expect(home.lastSaved?.interaction.recordingDate).toBe("2026-08-02");
    // Legacy confirmations without confirmedAt still have a deterministic updatedAt fallback.
    view.interactions.push({ ...base, id: "legacy_saved", confirmedAt: undefined, updatedAt: "2026-08-06T11:00:00.000Z" });
    expect(applyDateCompanionRelationshipView(emptyDateCompanionViewModel(), view).home.lastSaved?.interaction.relationshipInteractionId)
      .toBe("legacy_saved");
  });

  it("uses a retained edited displayedText with evidence from that exact home recording", () => {
    const view = relationshipViewFixture();
    const record = view.interactions[0];
    const base = record.recapItems[0];
    record.recapItems = [
      { ...base, id: "unchanged", displayedText: "原来的摘要", sortOrder: 0 },
      { ...base, id: "removed", displayedText: "已移除的修改", userText: "已移除的修改", disposition: "excluded", sortOrder: 1 },
      { ...base, id: "foreign_source", displayedText: "别场的修改", userText: "别场的修改", sortOrder: 2,
        evidence: base.evidence.map(source => ({ ...source, uploadId: "another_upload" })) },
      { ...base, id: "empty", displayedText: " ", userText: " ", sortOrder: 3 },
      { ...base, id: "edited", displayedText: "用户最终留下的新措辞", userText: "用户最终留下的新措辞", sortOrder: 4 }
    ];
    const home = applyDateCompanionRelationshipView(emptyDateCompanionViewModel(), view).home;
    expect(home.lastSaved?.interaction).toMatchObject({
      relationshipInteractionId: record.id, sourceUploadId: record.sourceUploadId, recordingDate: record.recordingDate
    });
    expect(home.lastSaved?.summary).toBe("用户最终留下的新措辞");
  });

  it("keeps each history excerpt attached to its own meeting, independent of long-term selection and confirmation order", () => {
    const view = relationshipViewFixture();
    const base = view.interactions[0];
    const edited = (text: string) => [{ ...base.recapItems[0], userText: text, displayedText: text }];
    view.interactions = [
      { ...base, id: "earlier", recordingDate: "2026-08-01", recapItems: edited("第一场的修改"), memoryBridge: undefined },
      { ...base, id: "latest", recordingDate: "2026-08-08", recapItems: edited("第二场的修改"), memoryBridge: undefined },
      { ...base, id: "other-relation", relationshipId: "elsewhere", recapItems: edited("其他关系") }
    ];
    const vm = applyDateCompanionRelationshipView(emptyDateCompanionViewModel(), view);
    expect(vm.recap.history.map(m => [m.relationshipInteractionId, m.savedExcerpt])).toEqual([
      ["earlier", "第一场的修改"], ["latest", "第二场的修改"]
    ]);
    expect(vm.person.remembered).toEqual([]);
  });

  it("keeps the newest saved meeting link when no eligible excerpt remains and shows empty only without saved meetings", () => {
    const view = relationshipViewFixture();
    const base = view.interactions[0];
    view.interactions.push({
      ...base, id: "saved_without_excerpt", sourceUploadId: "new_upload", originalName: "新的见面.m4a",
      confirmedAt: "2026-08-06T11:00:00.000Z", memoryBridge: undefined,
      recapItems: base.recapItems.map(item => ({ ...item, disposition: "excluded" }))
    });
    const home = applyDateCompanionRelationshipView(emptyDateCompanionViewModel(), view).home;
    expect(home.lastSaved?.interaction).toMatchObject({
      relationshipInteractionId: "saved_without_excerpt", sourceUploadId: "new_upload"
    });
    expect(home.lastSaved?.summary).toBeNull();
    view.interactions = view.interactions.map(record => ({ ...record, status: "draft", confirmedAt: undefined }));
    expect(applyDateCompanionRelationshipView(emptyDateCompanionViewModel(), view).home.lastSaved).toBeNull();
  });

  it("builds a single-interaction, evidence-backed read model", () => {
    const viewModel = buildDateCompanionViewModel(payloadFixture());

    expect(viewModel.currentInteraction?.transcript.map((line) => line.id)).toEqual(["segment_1", "segment_2"]);
    expect(viewModel.currentInteraction?.transcript.map((line) => line.speakerLabel)).toEqual(["我", "Ta"]);
    expect(viewModel.recap.items.map((item) => item.id)).toEqual([
      "moment:brief:brief_moment",
      "continue:brief:brief_open"
    ]);
    expect(viewModel.recap.items[0].sources[0]).toMatchObject({
      segmentIds: ["segment_1"],
      quote: "今晚聊得很放松。",
      presentation: "derived_summary"
    });
    expect(viewModel.home.remembered?.id).toBe("moment:brief:brief_moment");
    expect(viewModel.prepare.lastTopic?.id).toBe("mentioned:semantic:semantic_1");
  });

  it("keeps aliases as display-only labels and does not invent a long-term person", () => {
    const viewModel = buildDateCompanionViewModel(payloadFixture());

    expect(viewModel.relationship).toBeNull();
    expect(viewModel.recap.participants).toEqual([
      expect.objectContaining({ speakerId: "local_speaker_1", alias: "Ta", state: "unresolved" }),
      expect.objectContaining({ speakerId: "local_speaker_0", alias: "我", state: "unresolved" })
    ]);
    expect(viewModel.person.remembered).toEqual([]);
    expect(viewModel.person.promises).toEqual([]);
    expect(viewModel.home.participantNotice).toBe("这次相处中的人物还没有核对");
  });

  it("does not promote an arbitrary provider speaker label into a user-confirmed nickname", () => {
    const base = payloadFixture();
    const payload = parseDayPayload({
      ...base,
      segments: base.segments.map((segment) =>
        segment.id === "segment_1" ? { ...segment, speaker: "Provider Alice" } : segment
      ),
      speakerAliases: { speaker_1: "Ta" },
      speakerAliasesByUploadId: { upload_1: { speaker_1: "Ta" } }
    });

    const viewModel = buildDateCompanionViewModel(payload);
    const providerSpeakerLine = viewModel.currentInteraction?.transcript.find(
      (line) => line.text === "今晚聊得很放松。"
    );
    const providerParticipant = viewModel.recap.participants.find(
      (participant) => participant.sampleQuotes.some(
        (quote) => quote.quote === "今晚聊得很放松。"
      )
    );

    expect(providerSpeakerLine?.speakerLabel).toBeUndefined();
    expect(providerParticipant).toMatchObject({
      displayLabel: "说话人",
      state: "unresolved"
    });
    expect(providerParticipant?.alias).toBeUndefined();
  });

  it("uses semantic chapters when valid and a neutral full-record fallback otherwise", () => {
    const payload = payloadFixture();
    expect(buildDateCompanionViewModel(payload).recap.chapters).toEqual([
      {
        id: "semantic_1",
        title: "聊到看展",
        startSeconds: 8,
        endSeconds: 12,
        sourceSegmentIds: ["segment_2"]
      }
    ]);

    const withoutSemantic = parseDayPayload({
      ...payload,
      semanticSegments: [],
      semanticSegmentsAvailable: false
    });
    expect(buildDateCompanionViewModel(withoutSemantic).recap.chapters[0]).toMatchObject({
      title: "完整记录",
      sourceSegmentIds: ["segment_1", "segment_2"]
    });
  });

  it("keeps a same-day aggregate out of the real single-upload interaction path", () => {
    const first = payloadFixture();
    const second = parseDayPayload({
      ...payloadFixture(),
      upload: { ...payloadFixture().upload, id: "upload_2", createdAt: "2026-08-04T11:00:00.000Z" },
      job: { ...payloadFixture().job, id: "job_2", uploadId: "upload_2" },
      segments: payloadFixture().segments.map((segment) => ({ ...segment, id: `${segment.id}_2`, uploadId: "upload_2" })),
      semanticSegments: [],
      briefItems: [],
      speakerAliasesByUploadId: { upload_2: {} }
    });
    const aggregate = combineDayPayloads([first, second]);

    expect(aggregate.upload.id).toBe("day_2026-08-04");
    expect(isRealDateCompanionUploadId(aggregate.upload.id)).toBe(false);
    expect(() => buildDateCompanionViewModel({ ...first, upload: aggregate.upload })).toThrow(
      DateCompanionAdapterError
    );
  });

  it("keeps current draft data local while long-term pages use only eligible confirmed server data", () => {
    const current = buildDateCompanionViewModel(payloadFixture());
    const viewModel = applyDateCompanionRelationshipView(current, relationshipViewFixture(), {
      hasLocalDay: (uploadId) => uploadId === "upload_1",
      getLocalDay: (uploadId) => uploadId === "upload_1" ? payloadFixture() : null,
      retainedSubjects: {
        ["upload_1\u0000segment_1"]: "both",
        ["upload_1\u0000segment_2"]: "companion"
      }
    });

    expect(viewModel.relationship).toMatchObject({ id: "relationship_1", displayName: "小满", participantState: "confirmed" });
    expect(viewModel.currentInteraction).toMatchObject({
      id: "upload_1",
      relationshipInteractionId: "interaction_1",
      persistenceStatus: "confirmed",
      sourceState: "server_cleaned"
    });
    expect(viewModel.recap.items.map((item) => item.id)).toEqual([
      "recap_moment",
      "recap_mentioned",
      "recap_promise",
      "recap_excluded",
      "recap_unresolved"
    ]);
    expect(viewModel.recap.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ speakerId: "speaker_0", role: "self", state: "confirmed" }),
      expect.objectContaining({ speakerId: "speaker_1", role: "companion", state: "confirmed" }),
      expect.objectContaining({ speakerId: "speaker_x", role: "unresolved", state: "unresolved" })
    ]));
    expect(viewModel.person.remembered.map((item) => item.id)).toEqual(["recap_mentioned"]);
    expect(viewModel.person.relationship.map((item) => item.id)).toEqual(["recap_moment"]);
    expect(viewModel.person.promises.map((item) => item.id)).toEqual(["promise_1"]);
    expect(viewModel.prepare.items.map((item) => item.id)).toEqual([
      "recap_mentioned",
      "recap_moment",
      "recap_promise"
    ]);
    expect(viewModel.prepare.items.some((item) => item.id === "recap_excluded" || item.id === "recap_unresolved")).toBe(false);
    expect(viewModel.person.remembered[0].sources[0]).toMatchObject({
      uploadId: "upload_1",
      segmentIds: ["segment_2"],
      speakerId: "speaker_1",
      canOpenTranscript: true
    });
    expect(viewModel.person.interactions[0].transcript.map((line) => line.id)).toEqual([
      "segment_1",
      "segment_2"
    ]);
  });

  it("preserves homepage promises and their AI source revision in the summary read", () => {
    const view = relationshipViewFixture();
    const summary = { ...view, interactions: view.interactions.map(({ recapItems, ...metadata }) => ({
      ...metadata, promiseRecapItems: recapItems.filter((item) => item.kind === "promise")
    })) };
    const options = { retainedSubjects: { ["upload_1\u0000segment_1"]: "both" as const,
      ["upload_1\u0000segment_2"]: "companion" as const } };
    const fullVm = applyDateCompanionRelationshipView(emptyDateCompanionViewModel(), view, options);
    const summaryVm = applyDateCompanionRelationshipView(emptyDateCompanionViewModel(), summary, options);
    expect(summaryVm.person.promises).toHaveLength(1);
    expect(summaryVm.person.promises).toEqual(fullVm.person.promises);
    const revision = (vm: typeof fullVm) => dateCompanionProactiveSourceRevision(
      vm.person.promises.flatMap((promise) => promise.sources),
      JSON.stringify(vm.person.promises.map((promise) => [promise.id, promise.status, promise.version, promise.text]))
    );
    expect(revision(summaryVm)).toBe(revision(fullVm));
  });

  it("uses exact relationship catalog snapshot admission when Memory sources are empty", () => {
    const view = relationshipViewFixture();
    view.interactions[0].recapItems.push({
      ...view.interactions[0].recapItems[1],
      id: "recap_same_segment_not_catalogued",
      kind: "continue",
      proposedText: "同一段原话但不是目录准入条目。",
      displayedText: "同一段原话但不是目录准入条目。",
      sortOrder: 5,
      evidence: [{
        ...view.interactions[0].recapItems[1].evidence[0],
        id: "evidence_same_segment_not_catalogued",
        recapItemId: "recap_same_segment_not_catalogued"
      }]
    });
    const viewModel = applyDateCompanionRelationshipView(emptyDateCompanionViewModel(), view, {
      retainedSubjects: { ["upload_1\u0000segment_2"]: "companion" },
      memoryRetainedSourceKeys: [],
      relationshipPersonSources: [{
        evidenceSnapshotId: "evidence_mentioned",
        interactionId: "interaction_1",
        uploadId: "upload_1",
        sourceSegmentId: "segment_2",
        recordingDate: "2026-08-04",
        startSeconds: 8,
        endSeconds: 12,
        speakerId: "speaker_1",
        quote: "下次我们可以一起去看展。",
        subject: "companion"
      }]
    });

    expect(viewModel.person.remembered.map((item) => item.id)).toEqual(["recap_mentioned"]);
    expect(viewModel.person.interactions).toHaveLength(1);
    expect(viewModel.person.remembered[0].sources[0]).toMatchObject({
      id: "evidence_mentioned",
      quote: "下次我们可以一起去看展。",
      canOpenTranscript: false
    });
    expect(viewModel.prepare.items.some((item) => item.id === "recap_same_segment_not_catalogued")).toBe(false);
  });

  it("keeps excluded, unresolved and draft items out even if a malformed caller supplies matching catalog entries", () => {
    const view = relationshipViewFixture();
    const catalog = view.interactions[0].recapItems.flatMap((item) => item.evidence.map((evidence) => ({
      evidenceSnapshotId: evidence.id,
      interactionId: item.interactionId,
      uploadId: evidence.uploadId,
      sourceSegmentId: evidence.sourceSegmentId,
      recordingDate: "2026-08-04",
      startSeconds: evidence.startSeconds,
      endSeconds: evidence.endSeconds,
      speakerId: evidence.speakerId,
      quote: evidence.quote,
      subject: "both" as const
    })));
    const options = {
      retainedSubjects: {
        ["upload_1\u0000segment_1"]: "both" as const,
        ["upload_1\u0000segment_2"]: "both" as const
      },
      memoryRetainedSourceKeys: [],
      relationshipPersonSources: catalog
    };
    const confirmed = applyDateCompanionRelationshipView(emptyDateCompanionViewModel(), view, options);
    expect(confirmed.prepare.items.some((item) => item.id === "recap_excluded" || item.id === "recap_unresolved")).toBe(false);

    view.interactions[0] = { ...view.interactions[0], status: "draft", confirmedAt: undefined };
    const draft = applyDateCompanionRelationshipView(emptyDateCompanionViewModel(), view, options);
    expect(draft.person.interactions).toEqual([]);
    expect(draft.person.remembered).toEqual([]);
  });

  it("opens a selected confirmed interaction as an evidence-only recap without making it current QA context", () => {
    const viewModel = applyDateCompanionRelationshipView(
      emptyDateCompanionViewModel(),
      relationshipViewFixture(),
      {
        selectedInteractionId: "interaction_1",
        hasLocalDay: () => false,
        getLocalDay: () => null
      }
    );

    expect(viewModel.currentInteraction).toBeNull();
    expect(viewModel.recap.interaction).toMatchObject({
      relationshipInteractionId: "interaction_1",
      persistenceStatus: "confirmed",
      transcript: []
    });
    expect(viewModel.recap.items.map((item) => item.id)).toContain("recap_moment");
    expect(viewModel.recap.items[0].sources[0].canOpenTranscript).toBe(false);
    expect(viewModel.recap.chapters).toEqual([]);
  });

  it("refuses to open a server-only draft through a historical interaction deep link", () => {
    const view = relationshipViewFixture();
    view.interactions = [{
      ...view.interactions[0],
      status: "draft",
      confirmedAt: undefined
    }];

    const viewModel = applyDateCompanionRelationshipView(
      emptyDateCompanionViewModel(),
      view,
      { selectedInteractionId: "interaction_1" }
    );

    expect(viewModel.currentInteraction).toBeNull();
    expect(viewModel.recap.interaction).toBeNull();
    expect(viewModel.recap.items).toEqual([]);
  });

  it("preselects a continuity suggestion without marking the speaker confirmed", () => {
    const relationshipView = relationshipViewFixture();
    relationshipView.interactions = [{
      ...relationshipView.interactions[0],
      status: "draft",
      confirmedAt: undefined,
      participants: [
        {
          speakerId: "speaker_0",
          role: "unresolved",
          roleSuggestion: {
            role: "self",
            source: "previous_confirmation"
          }
        },
        { speakerId: "speaker_1", role: "unresolved" }
      ]
    }];
    const current = buildDateCompanionViewModel(payloadFixture());
    const viewModel = applyDateCompanionRelationshipView(current, relationshipView, {
      hasLocalDay: () => true,
      getLocalDay: () => payloadFixture()
    });

    expect(viewModel.recap.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({
        speakerId: "speaker_0",
        role: "self",
        state: "unresolved",
        roleSuggestion: { role: "self", source: "previous_confirmation" }
      }),
      expect.objectContaining({ speakerId: "speaker_1", role: "unresolved" })
    ]));
    expect(viewModel.home.participantNotice).toBeTruthy();
  });

  it("does not invent a playable audio sample for a singleton assignment", () => {
    const viewModel = applyDateCompanionRelationshipView(
      buildDateCompanionViewModel(payloadFixture()),
      relationshipViewFixture()
    );

    expect(viewModel.recap.participants.find((participant) => participant.speakerId === "speaker_1"))
      .not.toHaveProperty("audioSpeakerId");
  });

  it("merges reviewed chunk candidates while preserving every raw speaker id", () => {
    const relationshipView = relationshipViewFixture();
    relationshipView.interactions = [{
      ...relationshipView.interactions[0],
      status: "draft",
      confirmedAt: undefined,
      participants: [
        {
          speakerId: "speaker_0",
          reviewGroupId: "review_same_voice",
          audioSampleAvailable: true,
          voiceEnrollmentEligible: true,
          role: "unresolved",
          roleSuggestion: { role: "self", source: "previous_confirmation" }
        },
        {
          speakerId: "speaker_x",
          reviewGroupId: "review_same_voice",
          voiceEnrollmentEligible: true,
          role: "unresolved",
          roleSuggestion: { role: "self", source: "previous_confirmation" }
        },
        { speakerId: "speaker_1", role: "unresolved" }
      ]
    }];

    const viewModel = applyDateCompanionRelationshipView(
      buildDateCompanionViewModel(payloadFixture()),
      relationshipView,
      { hasLocalDay: () => true, getLocalDay: () => payloadFixture() }
    );

    expect(viewModel.recap.participants).toHaveLength(2);
    expect(viewModel.recap.participants).toContainEqual(expect.objectContaining({
      speakerId: "review_same_voice",
      memberSpeakerIds: ["speaker_0", "speaker_x"],
      audioSpeakerId: "speaker_0",
      voiceEnrollmentEligible: true,
      role: "self",
      state: "unresolved",
      roleSuggestion: { role: "self", source: "previous_confirmation" }
    }));
  });

  it("defensively hides a legacy confirmed interaction with no eligible kept evidence", () => {
    const view = relationshipViewFixture();
    const allExcluded: DcRelationshipView = {
      ...view,
      interactions: view.interactions.map((interaction) => ({
        ...interaction,
        recapItems: interaction.recapItems.map((item) => ({
          ...item,
          disposition: "excluded" as const
        }))
      })),
      promises: []
    };

    const viewModel = applyDateCompanionRelationshipView(
      buildDateCompanionViewModel(payloadFixture()),
      allExcluded
    );

    expect(viewModel.person.interactions).toEqual([]);
    expect(viewModel.recap.history).toEqual([]);
    expect(viewModel.person.remembered).toEqual([]);
    expect(viewModel.person.relationship).toEqual([]);
    expect(viewModel.prepare.items).toEqual([]);
  });

  it("lists confirmed meeting metadata for reopening without admitting it into long-term uses", () => {
    const view = relationshipViewFixture();
    view.interactions[0].memoryBridge = undefined;
    const model = applyDateCompanionRelationshipView(emptyDateCompanionViewModel(), view);
    expect(model.recap.history).toHaveLength(1);
    expect(model.recap.history[0]).toMatchObject({relationshipInteractionId:"interaction_1", transcript:[]});
    expect(model.person.interactions).toHaveLength(0);
    expect(model.prepare.items).toHaveLength(0);
    view.interactions[0].status = "draft";
    expect(applyDateCompanionRelationshipView(emptyDateCompanionViewModel(), view).recap.history).toHaveLength(0);
  });

  it("marks relationship search evidence as evidence-only when this browser has no matching DayPayload", () => {
    const view = relationshipViewFixture();
    const evidence = view.interactions[0].recapItems[1].evidence;
    const results = buildDateCompanionSearchResults([
      {
        recapItemId: "recap_mentioned",
        interactionId: "interaction_1",
        kind: "mentioned",
        text: "Ta 想去看展。",
        recordingDate: "2026-08-04",
        evidence
      }
    ], {
      relationshipView: view,
      retainedSubjects: { ["upload_1\u0000segment_2"]: "companion" }
    });

    expect(results[0].sources[0]).toMatchObject({
      uploadId: "upload_1",
      segmentIds: ["segment_2"],
      canOpenTranscript: false
    });
  });

  it("keeps completed promises in history without presenting them as still open", () => {
    const view = relationshipViewFixture();
    const completedView: DcRelationshipView = {
      ...view,
      promises: view.promises.map((promise) => ({
        ...promise,
        status: "done",
        resolvedAt: "2026-08-05T09:00:00.000Z",
        version: 1
      }))
    };
    const viewModel = applyDateCompanionRelationshipView(
      buildDateCompanionViewModel(payloadFixture()),
      completedView,
      {
        retainedSubjects: {
          ["upload_1\u0000segment_1"]: "both",
          ["upload_1\u0000segment_2"]: "companion"
        }
      }
    );

    expect(viewModel.person.promises).toEqual([
      expect.objectContaining({ id: "promise_1", status: "done" })
    ]);
    expect(viewModel.prepare.openPromises).toEqual([]);
    expect(viewModel.prepare.items.some((item) => item.id === "recap_promise")).toBe(false);
  });
});

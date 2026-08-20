// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { BriefItem, RelationshipSignalCard, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import { extractUploadMemories, extractUploadMemoriesWithAudit } from "./extractor";
import {
  memoryOwnerReviewCandidateId,
  memoryOwnerReviewEvidenceDigest
} from "./owner-review";

const segments: TranscriptSegment[] = [
  {
    id: "segment_1",
    uploadId: "upload_1",
    startSeconds: 0,
    endSeconds: 8,
    speaker: "speaker_1",
    identity: {
      globalSpeakerId: "person_user",
      identityType: "known_contact",
      confidence: 0.96,
      source: "voiceprint"
    },
    text: "我会在周五前确认餐厅。",
    confidence: 0.96,
    sceneLabels: ["unknown"],
    valueLabels: ["commitment"]
  },
  {
    id: "segment_2",
    uploadId: "upload_1",
    startSeconds: 9,
    endSeconds: 18,
    speaker: "speaker_2",
    identity: {
      globalSpeakerId: "person_partner",
      identityType: "known_contact",
      confidence: 0.95,
      source: "voiceprint"
    },
    text: "那周六具体几点还需要再确认。",
    confidence: 0.94,
    sceneLabels: ["unknown"],
    valueLabels: ["open_question"]
  }
];

const briefItems: BriefItem[] = [
  {
    id: "brief_commitment",
    uploadId: "upload_1",
    category: "commitment",
    title: "周五前确认餐厅",
    body: "对方表示会在周五前确认餐厅。",
    priority: "high",
    confidence: 0.88,
    status: "candidate",
    sourceSegmentIds: ["segment_1"],
    sourceTimeRange: { startSeconds: 0, endSeconds: 8 },
    transcriptExcerpt: "我会在周五前确认餐厅。",
    people: [],
    topics: ["见面安排"]
  },
  {
    id: "brief_question",
    uploadId: "upload_1",
    category: "open_question",
    title: "周六时间待确认",
    body: "周六的具体时间还没有说清。",
    priority: "medium",
    confidence: 0.8,
    status: "candidate",
    sourceSegmentIds: ["segment_2"],
    sourceTimeRange: { startSeconds: 9, endSeconds: 18 },
    transcriptExcerpt: "那周六具体几点还需要再确认。",
    people: [],
    topics: ["见面安排"]
  }
];

const semanticSegments: SemanticSegment[] = [
  {
    id: "semantic_1",
    uploadId: "upload_1",
    title: "下次见面安排",
    summary: "双方讨论了餐厅和周六见面的时间。",
    startSeconds: 0,
    endSeconds: 18,
    tags: ["见面安排"],
    sceneLabels: ["unknown"],
    valueLabels: ["commitment", "open_question"],
    confidence: 0.84,
    sourceSegmentIds: ["segment_1", "segment_2"],
    sourceTimeRange: { startSeconds: 0, endSeconds: 18 },
    transcriptExcerpt: "我会确认餐厅，周六时间还要再确认。"
  }
];

const relationshipSignals: RelationshipSignalCard[] = [
  {
    id: "signal_1",
    uploadId: "upload_1",
    date: "2026-07-08",
    signalType: "clear_commitment",
    signalCategory: "positive",
    severity: "low",
    confidence: 0.81,
    summary: "出现了明确的时间承诺。",
    explanation: "当前片段里给出了可回看的时间点。",
    involvedSpeakers: ["speaker_1"],
    timeRange: { startSeconds: 0, endSeconds: 8 },
    evidenceSegments: [
      { segmentId: "segment_1", speaker: "speaker_1", startSeconds: 0, endSeconds: 8, text: "我会在周五前确认餐厅。" }
    ],
    textEvidence: ["我会在周五前确认餐厅。"],
    suggestedReflection: "之后可以回看这项安排是否得到确认。",
    createdAt: "2026-07-08T10:00:00.000Z"
  }
];

describe("memory extraction", () => {
  it("consumes lifecycle metadata to resolve a relationship memory with target evidence", () => {
    const extraction = extractUploadMemoriesWithAudit({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments,
      briefItems: [],
      semanticSegments: [],
      relationshipSignals,
      relationshipLifecycle: {
        candidateIdsByCardId: { signal_1: ["candidate_plan"] },
        edges: [
          {
            fromSignalId: "candidate_plan",
            toSignalId: "candidate_update",
            relationType: "updated_by",
            confidence: 0.86,
            evidence: {
              fromSegments: ["segment_1"],
              toSegments: ["segment_2"]
            },
            reason: "commitment_to_update:shared_topic:shared_speaker_context:forward_time"
          },
          {
            fromSignalId: "candidate_update",
            toSignalId: "candidate_completion",
            relationType: "fulfilled_by",
            confidence: 0.9,
            evidence: {
              fromSegments: ["segment_2"],
              toSegments: ["segment_2"]
            },
            reason: "commitment_to_fulfillment:shared_topic:shared_speaker_context:forward_time"
          }
        ]
      },
      now: "2026-07-10T10:00:00.000Z"
    });
    const memory = extraction.memories.find((item) => item.type === "relationship_signal");

    expect(memory).toEqual(expect.objectContaining({ status: "resolved" }));
    expect(memory?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: "transcript", sourceId: "segment_2", quote: segments[1].text })
    ]));
    expect(extraction.audit.relationshipSignals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        signalId: "signal_1",
        lifecycleResolved: true,
        lifecycleRelationTypes: ["updated_by", "fulfilled_by"]
      })
    ]));
  });

  it("extracts stable preferences directly from verbatim transcript evidence", () => {
    const preferenceSegments: TranscriptSegment[] = [
      { ...segments[0], id: "pref_coffee_positive", text: "我更喜欢无糖拿铁。", valueLabels: [] },
      { ...segments[1], id: "pref_coffee_negative", text: "我不喜欢太甜的咖啡。", valueLabels: [] },
      { ...segments[0], id: "pref_drink_condition", text: "点饮料的话我一般选低糖。", valueLabels: [] }
    ];

    const memories = extractUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments: preferenceSegments,
      briefItems: [],
      semanticSegments: [],
      relationshipSignals: [],
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(memories.some((memory) => memory.type === "preference")).toBe(true);
    expect(memories.flatMap((memory) => memory.evidence).filter((item) => item.sourceType === "transcript")).toEqual(
      expect.arrayContaining(preferenceSegments.map((item) => expect.objectContaining({ sourceId: item.id, quote: item.text })))
    );
  });

  it("recognizes preference language across domains without promoting one-time choices", () => {
    const stable: TranscriptSegment[] = [
      { ...segments[0], id: "pref_food", text: "吃饭时我通常更喜欢清淡一点。", valueLabels: [] },
      { ...segments[1], id: "pref_temperature", text: "我不太能接受空调温度太低。", valueLabels: [] },
      { ...segments[0], id: "pref_volume", text: "听音乐的话我一般会把音量调低。", valueLabels: [] },
      { ...segments[1], id: "pref_activity", text: "周末活动我更倾向慢慢逛，不想排太满。", valueLabels: [] }
    ];
    const oneTime: TranscriptSegment = {
      ...segments[0], id: "one_time_choice", text: "今天先喝拿铁吧。", valueLabels: []
    };

    const memories = extractUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments: [...stable, oneTime],
      briefItems: [],
      semanticSegments: [],
      relationshipSignals: [],
      now: "2026-07-10T10:00:00.000Z"
    });
    const transcriptSourceIds = memories.flatMap((memory) => memory.evidence)
      .filter((item) => item.sourceType === "transcript")
      .map((item) => item.sourceId);

    expect(stable.every((item) => transcriptSourceIds.includes(item.id))).toBe(true);
    expect(transcriptSourceIds).not.toContain(oneTime.id);
  });

  it("does not persist a preference preface without a concrete preference identity", () => {
    const preface: TranscriptSegment = {
      ...segments[0],
      id: "preference_preface",
      text: "我先把几个一直没变的饮食习惯说清楚。",
      valueLabels: []
    };

    expect(extractUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments: [preface],
      briefItems: [],
      semanticSegments: [],
      relationshipSignals: [],
      now: "2026-07-10T10:00:00.000Z"
    })).toEqual([]);
  });

  it("merges repeated observations of the same preference and audits the observation count", () => {
    const repeatedPreferenceSegments: TranscriptSegment[] = [
      { ...segments[0], id: "preference_first", text: "我不喜欢香菜。", valueLabels: [] },
      { ...segments[0], id: "preference_repeated", startSeconds: 9, endSeconds: 18, text: "我不吃香菜。", valueLabels: [] }
    ];

    const result = extractUploadMemoriesWithAudit({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments: repeatedPreferenceSegments,
      briefItems: [],
      semanticSegments: [],
      relationshipSignals: [],
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]?.evidence).toHaveLength(2);
    expect(result.audit.preferenceCandidates).toEqual([
      expect.objectContaining({ observationCount: 2, normalizedValue: "avoid", persisted: true })
    ]);
    expect(result.ownerAttributions).toEqual([
      expect.objectContaining({
        owner: expect.objectContaining({ type: "known_identity", identityId: "person_user" })
      })
    ]);
  });

  it("does not merge the same preference across different resolved owners", () => {
    const result = extractUploadMemoriesWithAudit({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments: [
        { ...segments[0], id: "preference_owner_a", text: "我不太能吃辣。", valueLabels: [] },
        { ...segments[1], id: "preference_owner_b", text: "我不喜欢吃辣。", valueLabels: [] }
      ],
      briefItems: [],
      semanticSegments: [],
      relationshipSignals: [],
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(result.memories).toHaveLength(2);
    expect(result.ownerAttributions.map((item) => item.owner.identityId).sort())
      .toEqual(["person_partner", "person_user"]);
    expect(new Set(result.memories.map((memory) => memory.id)).size).toBe(2);
  });

  it("keeps an explicit preference daily-only when identity is unavailable", () => {
    const result = extractUploadMemoriesWithAudit({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments: [{
        ...segments[0],
        id: "preference_unknown_owner",
        identity: undefined,
        text: "我不太能吃辣。",
        valueLabels: []
      }],
      briefItems: [],
      semanticSegments: [],
      relationshipSignals: [],
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(result.memories).toEqual([]);
    expect(result.audit.decisions).toEqual([
      expect.objectContaining({
        shouldPersist: false,
        memoryTier: "daily_only",
        reasons: expect.arrayContaining(["preference_owner_not_reliably_identified"])
      })
    ]);
    expect(result.audit.ownerAttribution).toMatchObject({
      memoriesProcessed: 0,
      unknownOwners: 0,
      records: []
    });
  });

  it("keeps daily relationship observations separate from long-term memory admission", () => {
    const listening: RelationshipSignalCard = {
      ...relationshipSignals[0],
      id: "signal_listening",
      signalType: "active_listening",
      summary: "这一次回应中有复述和确认。"
    };
    const support: RelationshipSignalCard = {
      ...relationshipSignals[0],
      id: "signal_support",
      signalType: "emotional_support",
      summary: "这一次回应中有安慰和支持。"
    };
    const actionableCommitment: RelationshipSignalCard = {
      ...relationshipSignals[0],
      id: "signal_actionable_commitment",
      signalType: "clear_commitment",
      summary: "明确答应周五前确认餐厅。"
    };

    const memories = extractUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments,
      briefItems: [],
      semanticSegments: [],
      relationshipSignals: [listening, support, actionableCommitment],
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(memories.filter((memory) => memory.type === "relationship_signal").map((memory) => memory.title)).toEqual([
      actionableCommitment.summary
    ]);
  });

  it("stores one verbatim transcript quote per source segment instead of an aggregate quote", () => {
    const rewrittenSemantic: SemanticSegment = {
      ...semanticSegments[0],
      id: "semantic_aggregate",
      title: "见面时间仍待确认",
      summary: "围绕见面安排展开。模型对两处原文做了概括。",
      transcriptExcerpt: "我会确认餐厅……周六时间还需要再确认。"
    };

    const memories = extractUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments,
      briefItems: [],
      semanticSegments: [rewrittenSemantic],
      relationshipSignals: [],
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(memories).toHaveLength(1);
    expect(memories[0]?.evidence.filter((item) => item.sourceType === "transcript")).toEqual([
      expect.objectContaining({ sourceId: "segment_1", quote: segments[0].text }),
      expect.objectContaining({ sourceId: "segment_2", quote: segments[1].text })
    ]);
    expect(memories[0]?.evidence.every((item) => segments.some((segment) => segment.text === item.quote))).toBe(true);
    expect(memories[0]?.evidence.some((item) => item.quote.includes("……"))).toBe(false);
  });

  it("keeps formatting differences out of persisted evidence by copying the real source text", () => {
    const formatted = {
      ...briefItems[0],
      id: "brief_formatted",
      transcriptExcerpt: "我会在周五前确认餐厅!"
    };

    const memories = extractUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments,
      briefItems: [formatted],
      semanticSegments: [],
      relationshipSignals: [],
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(memories[0]?.evidence.every((item) => item.quote === segments[0].text)).toBe(true);
  });

  it("does not carry unrelated chatter from a broad semantic excerpt into the memory summary", () => {
    const broadSemantic: SemanticSegment = {
      ...semanticSegments[0],
      id: "semantic_broad",
      title: "工作风险待确认",
      summary: "围绕工作风险、项目规划展开。今天天气有点冷，地铁换乘很顺。项目验收标准仍需确认。",
      transcriptExcerpt: "今天天气有点冷。项目验收标准仍需确认。"
    };

    const memories = extractUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments,
      briefItems: [],
      semanticSegments: [broadSemantic],
      relationshipSignals: [],
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(memories).toHaveLength(1);
    expect(memories[0]?.summary).toBe("围绕工作风险、项目规划展开。");
  });

  it("extracts v1 event, commitment, question and relationship signal memories", () => {
    const memories = extractUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments,
      briefItems,
      semanticSegments,
      relationshipSignals,
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(new Set(memories.map((memory) => memory.type))).toEqual(
      new Set(["commitment", "question", "relationship_signal"])
    );
    expect(memories.every((memory) => memory.evidence.some((evidence) => evidence.sourceType === "transcript"))).toBe(true);
    expect(memories.find((memory) => memory.type === "relationship_signal")?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceType: "relationship_signal", sourceId: "signal_1" }),
        expect.objectContaining({ sourceType: "transcript", sourceId: "segment_1", quote: segments[0].text })
      ])
    );
  });

  it("drops candidates that cannot be traced to a real transcript segment", () => {
    const memories = extractUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments,
      briefItems: [{ ...briefItems[0], id: "brief_missing", sourceSegmentIds: ["missing_segment"] }],
      semanticSegments: [],
      relationshipSignals: [],
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(memories).toEqual([]);
  });

  it("classifies an explicit future semantic action as commitment instead of event", () => {
    const futureSegment: TranscriptSegment = {
      ...segments[0],
      id: "segment_future",
      text: "下周我们一起去看电影，我会在周五前确认时间。",
      valueLabels: ["commitment"]
    };
    const futureSemantic: SemanticSegment = {
      ...semanticSegments[0],
      id: "semantic_future",
      title: "下周一起看电影",
      summary: "双方约定下周一起看电影，并在周五前确认时间。",
      valueLabels: ["commitment"],
      sourceSegmentIds: [futureSegment.id],
      transcriptExcerpt: futureSegment.text
    };

    const memories = extractUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments: [futureSegment],
      briefItems: [],
      semanticSegments: [futureSemantic],
      relationshipSignals: [],
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ type: "commitment" });
    expect(memories[0]?.importanceReasons).toContain(
      "extraction: contains future action and commitment language"
    );
  });

  it("keeps Provider-label ownership pending until an explicit Memory owner review", () => {
    const pendingSegment: TranscriptSegment = {
      ...segments[0],
      id: "preference_provider_pending",
      speaker: "Alice",
      identity: {
        globalSpeakerId: "unknown_provider_alice",
        identityType: "unknown_person",
        confidence: null,
        source: "provider_speaker_result",
        evidence: {
          type: "provider_label",
          provider: "company_voiceprint",
          providerLabel: "Alice"
        }
      },
      text: "我不太能吃辣。",
      valueLabels: []
    };
    const baseInput = {
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments: [pendingSegment],
      briefItems: [],
      semanticSegments: [],
      relationshipSignals: [],
      identityStructuralGate: { status: "healthy" as const, reasons: [] },
      now: "2026-07-10T10:00:00.000Z"
    };
    const pending = extractUploadMemoriesWithAudit(baseInput);

    expect(pending.memories).toEqual([]);
    expect(pending.ownerReviewDrafts).toHaveLength(1);
    expect(pending.ownerReviewDrafts[0]).toMatchObject({
      providerLabels: ["Alice"],
      structuralGate: { status: "healthy" }
    });

    const draft = pending.ownerReviewDrafts[0];
    const candidateId = memoryOwnerReviewCandidateId("upload_1", draft.memory.id);
    const evidenceDigest = memoryOwnerReviewEvidenceDigest({
      uploadId: "upload_1",
      memory: draft.memory,
      evidenceSegments: draft.evidenceSegments,
      providerLabels: draft.providerLabels
    });
    const confirmed = extractUploadMemoriesWithAudit({
      ...baseInput,
      ownerReviewOverrides: [{
        candidateId,
        evidenceDigest,
        ownerIdentityId: "contact_alice"
      }]
    });

    expect(confirmed.memories).toHaveLength(1);
    expect(confirmed.appliedOwnerReviewCandidateIds).toEqual([candidateId]);
    expect(confirmed.ownerAttributions[0]).toMatchObject({
      owner: {
        type: "known_identity",
        identityId: "contact_alice",
        confidence: 1,
        source: "manual_mapping"
      }
    });
  });

  it("does not create an owner review candidate for a chunk-local unknown label", () => {
    const result = extractUploadMemoriesWithAudit({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments: [{
        ...segments[0],
        id: "preference_chunk_local_unknown",
        speaker: "speaker_1",
        identity: undefined,
        text: "我不太能吃辣。",
        valueLabels: []
      }],
      briefItems: [],
      semanticSegments: [],
      relationshipSignals: [],
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(result.memories).toEqual([]);
    expect(result.ownerReviewDrafts).toEqual([]);
  });

  it("keeps a partially completed brief task as a commitment while work remains", () => {
    const pendingSegment: TranscriptSegment = {
      ...segments[0],
      id: "segment_pending_task",
      text: "导师汇报第二部分已经按7日数据重写完成，我计划明天下午提交最终版本，提交前还需要核对引用。",
      valueLabels: ["task"]
    };
    const pendingBrief: BriefItem = {
      ...briefItems[0],
      id: "brief_pending_task",
      category: "task",
      title: "明天下午提交导师汇报最终版本",
      body: "第二部分已完成，但还需要核对引用，并计划在明天下午提交最终版本。",
      sourceSegmentIds: [pendingSegment.id],
      sourceTimeRange: {
        startSeconds: pendingSegment.startSeconds,
        endSeconds: pendingSegment.endSeconds
      },
      transcriptExcerpt: pendingSegment.text
    };

    const memories = extractUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments: [pendingSegment],
      briefItems: [pendingBrief],
      semanticSegments: [],
      relationshipSignals: [],
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ type: "commitment" });
    expect(memories[0]?.importanceReasons).toContain(
      "extraction: brief task contains a future action"
    );
  });

  it("classifies an explicitly completed brief task as an event with a verified participant", () => {
    const completedSegment: TranscriptSegment = {
      ...segments[0],
      id: "segment_completed_task",
      text: "导师汇报最终版本已于15:20提交完成，任务已经结束。",
      valueLabels: ["task"]
    };
    const completedBrief: BriefItem = {
      ...briefItems[0],
      id: "brief_completed_task",
      category: "task",
      title: "导师汇报最终版本已经提交完成",
      body: "最终版本已于15:20提交完成，任务已经结束。",
      sourceSegmentIds: [completedSegment.id],
      sourceTimeRange: {
        startSeconds: completedSegment.startSeconds,
        endSeconds: completedSegment.endSeconds
      },
      transcriptExcerpt: completedSegment.text
    };

    const extraction = extractUploadMemoriesWithAudit({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments: [completedSegment],
      briefItems: [completedBrief],
      semanticSegments: [],
      relationshipSignals: [],
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(extraction.memories).toHaveLength(1);
    expect(extraction.memories[0]).toMatchObject({ type: "event" });
    expect(extraction.memories[0]?.importanceReasons).toContain(
      "extraction: brief task is explicitly completed"
    );
    expect(extraction.ownerAttributions[0]).toMatchObject({
      scope: "individual",
      owner: { type: "unknown" },
      participants: [
        {
          role: "participant",
          attribution: {
            type: "known_identity",
            identityId: "person_user"
          }
        }
      ]
    });
  });

  it("classifies explicit stable preferences and unresolved questions", () => {
    const preferenceSegment: TranscriptSegment = {
      ...segments[0],
      id: "segment_preference",
      text: "我不喜欢临时改变计划，我习惯提前一天确认。",
      valueLabels: []
    };
    const questionSegment: TranscriptSegment = {
      ...segments[1],
      id: "segment_question",
      text: "具体几点还没说清，需要继续确认。",
      valueLabels: []
    };
    const semanticInputs: SemanticSegment[] = [
      {
        ...semanticSegments[0],
        id: "semantic_preference",
        title: "提前确认的偏好",
        summary: preferenceSegment.text,
        valueLabels: [],
        sourceSegmentIds: [preferenceSegment.id],
        transcriptExcerpt: preferenceSegment.text
      },
      {
        ...semanticSegments[0],
        id: "semantic_question",
        title: "见面时间待确认",
        summary: questionSegment.text,
        valueLabels: [],
        sourceSegmentIds: [questionSegment.id],
        transcriptExcerpt: questionSegment.text
      }
    ];

    const memories = extractUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments: [preferenceSegment, questionSegment],
      briefItems: [],
      semanticSegments: semanticInputs,
      relationshipSignals: [],
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(memories.map((memory) => memory.type).sort()).toEqual(["preference", "preference", "question"]);
    expect(memories.find((memory) => memory.type === "preference")?.importanceReasons).toContain(
      "extraction: contains explicit stable preference or habit"
    );
    expect(memories.find((memory) => memory.type === "question")?.importanceReasons).toContain(
      "extraction: contains unresolved or pending confirmation language"
    );
  });

  it("does not index generic semantic chatter as a durable event", () => {
    const chatterSegment: TranscriptSegment = {
      ...segments[0],
      id: "segment_chatter",
      text: "这个游戏挺有意思，我们再玩一轮。",
      valueLabels: []
    };
    const chatterSemantic: SemanticSegment = {
      ...semanticSegments[0],
      id: "semantic_chatter",
      title: "继续玩游戏",
      summary: chatterSegment.text,
      valueLabels: [],
      sourceSegmentIds: [chatterSegment.id],
      transcriptExcerpt: chatterSegment.text
    };

    expect(
      extractUploadMemories({
        userId: "user_1",
        uploadId: "upload_1",
        recordingDate: "2026-07-08",
        segments: [chatterSegment],
        briefItems: [],
        semanticSegments: [chatterSemantic],
        relationshipSignals: [],
        now: "2026-07-10T10:00:00.000Z"
      })
    ).toEqual([]);
  });

  it("keeps explicit recent activities but does not assign second-person preferences to the reporter", () => {
    const activitySegment: TranscriptSegment = {
      ...segments[0],
      id: "segment_activity",
      text: "今天我们一起做了晚饭。",
      valueLabels: []
    };
    const preferenceSegment: TranscriptSegment = {
      ...segments[1],
      id: "segment_partner_preference",
      text: "我看到了你特别喜欢的鲍鱼。",
      valueLabels: []
    };
    const semanticInputs: SemanticSegment[] = [
      {
        ...semanticSegments[0],
        id: "semantic_activity",
        title: "一起做晚饭",
        summary: activitySegment.text,
        valueLabels: [],
        sourceSegmentIds: [activitySegment.id],
        transcriptExcerpt: activitySegment.text
      },
      {
        ...semanticSegments[0],
        id: "semantic_partner_preference",
        title: "喜欢鲍鱼",
        summary: preferenceSegment.text,
        valueLabels: [],
        sourceSegmentIds: [preferenceSegment.id],
        transcriptExcerpt: preferenceSegment.text
      }
    ];

    const memories = extractUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments: [activitySegment, preferenceSegment],
      briefItems: [],
      semanticSegments: semanticInputs,
      relationshipSignals: [],
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(memories.map((memory) => memory.type)).toEqual(["event"]);
    expect(memories.find((memory) => memory.type === "event")?.importanceReasons).toContain(
      "extraction: contains a dated or completed activity"
    );
  });
});

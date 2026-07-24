// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "@/lib/domain/types";
import type { RelationshipSignalCandidate } from "../candidates";
import { matchLifecycleIdentity } from "./matching";
import {
  relationshipLifecycleSignalsFromCandidates,
  resolveRelationshipLifecycles
} from "./resolver";
import type { RelationshipLifecycleSignal } from "./types";

function signal(input: {
  id: string;
  signalType: RelationshipLifecycleSignal["signalType"];
  summary: string;
  evidenceText?: string;
  startSeconds: number;
  speaker?: string;
}): RelationshipLifecycleSignal {
  return {
    id: input.id,
    signalType: input.signalType,
    summary: input.summary,
    evidenceSegmentIds: [`${input.id}_segment`],
    evidenceText: [input.evidenceText ?? input.summary],
    timeRange: {
      startSeconds: input.startSeconds,
      endSeconds: input.startSeconds + 20
    },
    speakers: [input.speaker ?? "speaker_1"],
    confidence: 0.9
  };
}

describe("Relationship Lifecycle Resolver", () => {
  it("connects a question to its concrete answer", () => {
    const result = resolveRelationshipLifecycles([
      signal({
        id: "question",
        signalType: "evasive_answer",
        summary: "社区课程是否预约成功还没有确认？",
        startSeconds: 120
      }),
      signal({
        id: "answer",
        signalType: "active_listening",
        summary: "社区课程已经预约成功，确认了周日下午两个位置。",
        startSeconds: 360
      })
    ]);

    expect(result.edges).toEqual([
      expect.objectContaining({
        fromSignalId: "question",
        toSignalId: "answer",
        relationType: "answered_by"
      })
    ]);
  });

  it("treats registration and reservation as the same deterministic action family", () => {
    const result = resolveRelationshipLifecycles([
      signal({
        id: "registration-question",
        signalType: "evasive_answer",
        summary: "社区课程报名是否有名额还没有确认？",
        startSeconds: 120
      }),
      signal({
        id: "reservation-answer",
        signalType: "active_listening",
        summary: "社区课程预约已经完成，两个位置均已确认。",
        startSeconds: 360
      })
    ]);

    expect(result.edges).toEqual([
      expect.objectContaining({
        fromSignalId: "registration-question",
        toSignalId: "reservation-answer",
        relationType: "answered_by"
      })
    ]);
  });

  it("allows a nearby generic completion only when action and speaker context stay anchored", () => {
    const result = resolveRelationshipLifecycles([
      signal({
        id: "scoped-question",
        signalType: "evasive_answer",
        summary: "课程报名是否有名额还没有确认？",
        startSeconds: 120
      }),
      signal({
        id: "generic-answer",
        signalType: "active_listening",
        summary: "预约已经完成，确认有两个位置。",
        startSeconds: 720
      })
    ]);

    expect(result.edges).toEqual([
      expect.objectContaining({
        fromSignalId: "scoped-question",
        toSignalId: "generic-answer",
        relationType: "answered_by"
      })
    ]);
  });

  it("classifies an explicit pending state as an update rather than an answer", () => {
    const result = resolveRelationshipLifecycles([
      signal({
        id: "pending-question",
        signalType: "evasive_answer",
        summary: "社区课程报名是否有名额还没有确认？",
        startSeconds: 120
      }),
      signal({
        id: "pending-update",
        signalType: "clear_commitment",
        summary: "报名页面尚未打开，稍后查询并回复。",
        startSeconds: 240
      })
    ]);

    expect(result.edges).toEqual([
      expect.objectContaining({
        fromSignalId: "pending-question",
        toSignalId: "pending-update",
        relationType: "updated_by"
      })
    ]);
  });

  it("connects a plan to its completion", () => {
    const result = resolveRelationshipLifecycles([
      signal({
        id: "plan",
        signalType: "clear_commitment",
        summary: "计划参加社区陶艺体验，预约状态尚未确认。",
        startSeconds: 600
      }),
      signal({
        id: "completion",
        signalType: "active_listening",
        summary: "社区陶艺体验的预约已经完成，两个位置均已确认。",
        startSeconds: 1_500
      })
    ]);

    expect(result.edges).toEqual([
      expect.objectContaining({
        fromSignalId: "plan",
        toSignalId: "completion",
        relationType: "resolved_by"
      })
    ]);
  });

  it("connects a commitment to its fulfillment", () => {
    const result = resolveRelationshipLifecycles([
      signal({
        id: "commitment",
        signalType: "clear_commitment",
        summary: "承诺周二晚上陪对方完成分享排练和模拟问答。",
        startSeconds: 500,
        speaker: "speaker_2"
      }),
      signal({
        id: "fulfillment",
        signalType: "active_listening",
        summary: "周二晚上的分享排练和模拟问答已经按约完成。",
        startSeconds: 1_800,
        speaker: "speaker_2"
      })
    ]);

    expect(result.edges).toEqual([
      expect.objectContaining({
        fromSignalId: "commitment",
        toSignalId: "fulfillment",
        relationType: "fulfilled_by"
      })
    ]);
  });

  it("connects a concern to a concrete resolution without judging either person", () => {
    const result = resolveRelationshipLifecycles([
      signal({
        id: "concern",
        signalType: "evasive_answer",
        summary: "临时改变安排却没有提前通知，让对方感到不舒服。",
        startSeconds: 900
      }),
      signal({
        id: "resolution",
        signalType: "boundary_respect",
        summary: "双方形成通知规则：安排变化时至少提前三十分钟说明。",
        startSeconds: 1_200
      })
    ]);

    expect(result.edges).toEqual([
      expect.objectContaining({
        fromSignalId: "concern",
        toSignalId: "resolution",
        relationType: "resolved_by"
      })
    ]);
    expect(JSON.stringify(result)).not.toMatch(/谁对谁错|人格|心理诊断/u);
  });

  it("rejects lifecycle links between different events", () => {
    const result = resolveRelationshipLifecycles([
      signal({
        id: "pottery-plan",
        signalType: "clear_commitment",
        summary: "计划确认社区陶艺体验的预约。",
        startSeconds: 600
      }),
      signal({
        id: "rehearsal-complete",
        signalType: "active_listening",
        summary: "读书会分享排练已经完成。",
        startSeconds: 1_500
      })
    ]);

    expect(result.edges).toEqual([]);
    expect(result.audit.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ accepted: false, rejectionReason: "different_entity" })
    ]));
  });

  it("rejects the same topic when explicit dates differ", () => {
    const result = resolveRelationshipLifecycles([
      signal({
        id: "tuesday-plan",
        signalType: "clear_commitment",
        summary: "周二确认社区课程预约。",
        startSeconds: 300
      }),
      signal({
        id: "friday-result",
        signalType: "active_listening",
        summary: "周五的社区课程预约已经完成。",
        startSeconds: 1_200
      })
    ]);

    expect(result.edges).toEqual([]);
    expect(result.audit.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ accepted: false, rejectionReason: "different_time_window" })
    ]));
  });

  it("keeps a long-range lifecycle link when both entity and action stay anchored", () => {
    const result = resolveRelationshipLifecycles([
      signal({
        id: "long-plan",
        signalType: "clear_commitment",
        summary: "计划确认社区陶艺体验预约。",
        startSeconds: 300
      }),
      signal({
        id: "long-completion",
        signalType: "active_listening",
        summary: "社区陶艺体验预约已经完成。",
        startSeconds: 2_700
      })
    ]);

    expect(result.edges).toEqual([
      expect.objectContaining({
        fromSignalId: "long-plan",
        toSignalId: "long-completion",
        relationType: "resolved_by"
      })
    ]);
  });

  it("rejects the same broad topic when action goals differ", () => {
    const result = resolveRelationshipLifecycles([
      signal({
        id: "club-registration",
        signalType: "clear_commitment",
        summary: "计划确认社区读书会报名状态。",
        startSeconds: 300
      }),
      signal({
        id: "club-rehearsal",
        signalType: "active_listening",
        summary: "社区读书会的分享排练已经完成。",
        startSeconds: 1_200
      })
    ]);

    expect(result.edges).toEqual([]);
    expect(result.audit.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ accepted: false, rejectionReason: "different_goal" })
    ]));
  });

  it("keeps audit output structural and free of conversation text", () => {
    const privateText = "private-conversation-marker";
    const result = resolveRelationshipLifecycles([
      signal({
        id: "question",
        signalType: "evasive_answer",
        summary: `课程是否确认？${privateText}`,
        startSeconds: 100
      }),
      signal({
        id: "answer",
        signalType: "active_listening",
        summary: "课程已经确认完成。",
        startSeconds: 200
      })
    ]);

    expect(JSON.stringify(result.audit)).not.toContain(privateText);
  });

  it("does not count equal display names as the same structured speaker identity", () => {
    const identifiedSegment = (
      id: string,
      startSeconds: number,
      localSpeaker: string,
      globalSpeakerId: string
    ): TranscriptSegment => ({
      id,
      uploadId: "upload_identity",
      startSeconds,
      endSeconds: startSeconds + 10,
      speaker: localSpeaker,
      identity: {
        globalSpeakerId,
        displayName: "Same display name",
        identityType: "known_contact",
        confidence: 0.95,
        source: "voiceprint"
      },
      text: `evidence-${id}`,
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: []
    });
    const firstSegment = identifiedSegment("identity_segment_1", 100, "speaker_0", "person_1");
    const secondSegment = identifiedSegment("identity_segment_2", 200, "speaker_1", "person_2");
    const lifecycleCandidate = (
      id: string,
      chunkIndex: number,
      segment: TranscriptSegment
    ): RelationshipSignalCandidate => ({
      id,
      uploadId: "upload_identity",
      transcriptChunkId: `transcript_chunk_${chunkIndex}`,
      chunkIndex,
      item: {
        signalType: "clear_commitment",
        signalCategory: "positive",
        severity: "low",
        confidence: 0.9,
        summary: "A structured lifecycle event",
        explanation: "Only the current evidence is described.",
        involvedSpeakers: ["Same display name"],
        evidenceSegmentIds: [segment.id],
        evidenceSegments: [],
        counterEvidence: [],
        acousticEvidence: [],
        textEvidence: [segment.text],
        interactionEvidence: [],
        suggestedReflection: "Review the later state."
      }
    });
    const signals = relationshipLifecycleSignalsFromCandidates({
      candidates: [
        lifecycleCandidate("candidate_1", 0, firstSegment),
        lifecycleCandidate("candidate_2", 1, secondSegment)
      ],
      segments: [firstSegment, secondSegment],
      recordingDate: "2026-07-17"
    });

    expect(signals.map((item) => item.speakers)).toEqual([["person_1"], ["person_2"]]);
    expect(matchLifecycleIdentity(signals[0], signals[1]).features.sharedSpeakers).toBe(0);
  });
});

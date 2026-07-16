// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { RelationshipSignalCard } from "@/lib/domain/types";
import { evaluateMemoryAdmission, isStablePreferenceText } from "./admission";
import type { MemoryWriteInput } from "./types";

function memory(summary: string): MemoryWriteInput {
  return {
    id: "memory_1",
    type: "relationship_signal",
    title: summary,
    summary,
    importance: 0.5,
    date: "2026-07-15",
    createdAt: "2026-07-15T10:00:00.000Z",
    updatedAt: "2026-07-15T10:00:00.000Z",
    evidence: [{
      id: "evidence_1",
      sourceType: "transcript",
      sourceId: "segment_1",
      uploadId: "upload_1",
      date: "2026-07-15",
      quote: summary,
      createdAt: "2026-07-15T10:00:00.000Z"
    }]
  };
}

function signal(signalType: RelationshipSignalCard["signalType"], summary: string): RelationshipSignalCard {
  return {
    id: "signal_1",
    uploadId: "upload_1",
    date: "2026-07-15",
    signalType,
    signalCategory: signalType === "evasive_answer" ? "uncertain" : "positive",
    severity: "low",
    confidence: 0.82,
    summary,
    explanation: summary,
    involvedSpeakers: ["speaker_1"],
    timeRange: { startSeconds: 0, endSeconds: 8 },
    evidenceSegments: [
      { segmentId: "segment_1", speaker: "speaker_1", startSeconds: 0, endSeconds: 8, text: summary },
      { segmentId: "segment_2", speaker: "speaker_2", startSeconds: 9, endSeconds: 16, text: summary }
    ],
    textEvidence: [summary],
    suggestedReflection: "可以回看这段互动。",
    ...(signalType === "evasive_answer" ? { caution: "单次片段不足以下结论。" } : {}),
    createdAt: "2026-07-15T10:00:00.000Z"
  };
}

describe("relationship signal memory admission", () => {
  it.each(["active_listening", "emotional_support"] as const)(
    "keeps a one-off %s card as daily-only",
    (signalType) => {
      const summary = "这次对话里有一次具体回应。";
      expect(evaluateMemoryAdmission({ memory: memory(summary), relationshipSignal: signal(signalType, summary) }))
        .toMatchObject({ shouldPersist: false, memoryTier: "daily_only" });
    }
  );

  it("admits actionable commitments and explicit boundary agreements", () => {
    const commitment = "我们答应周六晚上八点前检查并回复简历。";
    const boundary = "我们约定暂停十分钟，之后会回来确认是否继续沟通。";

    expect(evaluateMemoryAdmission({ memory: memory(commitment), relationshipSignal: signal("clear_commitment", commitment) }))
      .toMatchObject({ shouldPersist: true, memoryTier: "long_term" });
    expect(evaluateMemoryAdmission({ memory: memory(boundary), relationshipSignal: signal("boundary_respect", boundary) }))
      .toMatchObject({ shouldPersist: true, memoryTier: "long_term" });
  });

  it("does not persist a generic promise label or a one-off boundary response", () => {
    const genericCommitment = "对方给出了后续回应方式，涉及明确的承诺或后续行动。";
    const transientArrangement = "我们说好吃完饭如果还早，就沿河边走一小段。";
    const oneOffBoundary = "散步时我会按你舒服的速度来，不替你决定。";

    expect(evaluateMemoryAdmission({
      memory: memory(genericCommitment),
      relationshipSignal: signal("clear_commitment", genericCommitment)
    })).toMatchObject({ shouldPersist: false, memoryTier: "daily_only" });
    expect(evaluateMemoryAdmission({
      memory: memory(oneOffBoundary),
      relationshipSignal: signal("boundary_respect", oneOffBoundary)
    })).toMatchObject({ shouldPersist: false, memoryTier: "daily_only" });
    expect(evaluateMemoryAdmission({
      memory: memory(transientArrangement),
      relationshipSignal: signal("clear_commitment", transientArrangement)
    })).toMatchObject({ shouldPersist: false, memoryTier: "daily_only" });
  });

  it("does not confuse discussion about preferences with a preference expression", () => {
    expect(isStablePreferenceText("记住偏好是为了少踩雷，不是替你决定。")).toBe(false);
    expect(isStablePreferenceText("我的偏好是安静一点的音乐。")).toBe(true);
  });

  it("does not turn a one-off evasive answer into a durable pattern", () => {
    const summary = "这一次没有直接确认出发时间。";
    expect(evaluateMemoryAdmission({ memory: memory(summary), relationshipSignal: signal("evasive_answer", summary) }))
      .toMatchObject({ shouldPersist: false, memoryTier: "daily_only" });
  });

  it("admits a strong relationship observation only after repeated dated occurrences", () => {
    const summary = "在不同日期都出现了对具体担忧的复述和确认。";
    expect(evaluateMemoryAdmission({
      memory: memory(summary),
      relationshipSignal: signal("active_listening", summary),
      occurrenceCount: 2,
      distinctDates: 2
    })).toMatchObject({ shouldPersist: true, memoryTier: "long_term" });
  });
});

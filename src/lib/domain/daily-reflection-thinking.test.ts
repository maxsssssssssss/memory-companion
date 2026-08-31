import { describe, expect, it } from "vitest";

import {
  DailyReflectionThinkingContextResolveRequestSchema,
  DailyReflectionThinkingMessageSchema,
  DailyReflectionThinkingRequestSchema,
  DailyReflectionThinkingResponseSchema
} from "./daily-reflection-thinking";

function source() {
  return {
    sourceId: "source_1",
    claim: {
      text: "你曾记录：在做产品方向选择。",
      sourceMemoryIds: ["memory_1"],
      sourceCardIds: ["card_1"],
      evidenceIds: ["segment_1"],
      evidence: [{
        reflectionId: "reflection_1",
        cardId: "card_1",
        sourceSegmentId: "segment_1",
        recordingDate: "2026-08-20",
        startSeconds: 1,
        endSeconds: 4,
        snippet: "我在做产品方向选择。",
        sourceOrigin: "user_reflection"
      }],
      epistemicStatuses: ["explicit_user_statement"]
    }
  } as const;
}

describe("Daily Reflection thinking contract", () => {
  it("accepts the five modes and a strict minimal request", () => {
    for (const mode of [
      "brainstorm",
      "clarify_decision",
      "compare_directions",
      "extend_idea"
    ] as const) {
      expect(DailyReflectionThinkingRequestSchema.parse({
        operationKey: `operation_${mode}`,
        mode,
        contextMode: "none",
        message: "一起想想下一步。"
      })).toMatchObject({ mode, contextMode: "none" });
    }
    expect(DailyReflectionThinkingRequestSchema.safeParse({
      operationKey: "operation_extra",
      mode: "brainstorm",
      contextMode: "none",
      message: "一起想想。",
      evidenceReferences: []
    }).success).toBe(false);
  });

  it("requires explicit personal context for past_clues", () => {
    expect(DailyReflectionThinkingRequestSchema.safeParse({
      operationKey: "operation_past_auto",
      mode: "past_clues",
      contextMode: "auto",
      message: "过去有没有相关线索？"
    }).success).toBe(false);
    expect(DailyReflectionThinkingRequestSchema.safeParse({
      operationKey: "operation_past_personal",
      mode: "past_clues",
      contextMode: "personal",
      message: "过去有没有相关线索？"
    }).success).toBe(true);
  });

  it("rejects pinned personal IDs when context is none and duplicate pins", () => {
    expect(DailyReflectionThinkingRequestSchema.safeParse({
      operationKey: "operation_none_pin",
      mode: "brainstorm",
      contextMode: "none",
      message: "一起想想。",
      pinnedCardIds: ["card_1"]
    }).success).toBe(false);
    expect(DailyReflectionThinkingRequestSchema.safeParse({
      operationKey: "operation_duplicate_pin",
      mode: "brainstorm",
      contextMode: "personal",
      message: "一起想想。",
      pinnedCardIds: ["card_1", "card_1"]
    }).success).toBe(false);
  });

  it("freezes a resolver input that cannot be invoked with context none", () => {
    expect(DailyReflectionThinkingContextResolveRequestSchema.safeParse({
      accountId: "account_1",
      mode: "brainstorm",
      contextMode: "none",
      message: "一起想想。",
      pinnedCardIds: [],
      pinnedMemoryIds: [],
      pinnedEvidenceIds: []
    }).success).toBe(false);
  });

  it("requires response metadata and personal claims to match canonical sources", () => {
    const assistantMessage = {
      id: "message_1",
      operationKey: "operation_1",
      role: "assistant",
      mode: "past_clues",
      contextMode: "personal",
      content: "你过去记录过一个相关选择。",
      safetyBoundaryVersion: "v2",
      usedPersonalContext: true,
      sources: [source()],
      personalContextClaims: [{ text: "你记录过产品方向选择。", sourceIds: ["source_1"] }],
      interpretations: ["这可能说明你正在比较取舍。"],
      hypotheses: ["也许可以先做一个小实验。"],
      model: "gpt-5.5",
      createdAt: "2026-08-26T00:00:00.000Z",
      completionStatus: "completed"
    } as const;
    expect(DailyReflectionThinkingResponseSchema.parse({
      conversationId: "conversation_1",
      operationKey: "operation_1",
      assistantMessage,
      usedPersonalContext: true,
      sources: [source()],
      model: "gpt-5.5"
    }).assistantMessage.personalContextClaims).toHaveLength(1);
    expect(DailyReflectionThinkingResponseSchema.safeParse({
      conversationId: "conversation_1",
      operationKey: "operation_1",
      assistantMessage: {
        ...assistantMessage,
        personalContextClaims: [{ text: "伪造的过去。", sourceIds: ["missing_source"] }]
      },
      usedPersonalContext: true,
      sources: [source()],
      model: "gpt-5.5"
    }).success).toBe(false);
  });

  it("parses legacy messages without a boundary while accepting only the current version", () => {
    const legacyAssistant = {
      id: "message_legacy",
      operationKey: "operation_legacy",
      role: "assistant",
      mode: "brainstorm",
      contextMode: "none",
      content: "旧助手消息。",
      usedPersonalContext: false,
      sources: [],
      personalContextClaims: [],
      interpretations: [],
      hypotheses: [],
      model: "gpt-5.5",
      createdAt: "2026-08-26T00:00:00.000Z",
      completionStatus: "completed"
    } as const;
    expect(DailyReflectionThinkingMessageSchema.parse(legacyAssistant).safetyBoundaryVersion)
      .toBeUndefined();
    expect(DailyReflectionThinkingMessageSchema.parse({
      ...legacyAssistant,
      safetyBoundaryVersion: "v2"
    }).safetyBoundaryVersion).toBe("v2");
    expect(DailyReflectionThinkingMessageSchema.safeParse({
      ...legacyAssistant,
      safetyBoundaryVersion: "v1"
    }).success).toBe(false);
    expect(DailyReflectionThinkingMessageSchema.safeParse({
      ...legacyAssistant,
      role: "user",
      model: null,
      safetyBoundaryVersion: "v2"
    }).success).toBe(false);
  });
});

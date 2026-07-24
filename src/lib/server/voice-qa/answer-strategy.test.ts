// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import { QuestionAnswerSchema, type QuestionAnswer } from "@/lib/domain/types";
import type { AnswerQuestionWithAIInput } from "@/lib/server/retrieval/ai-qa";

import {
  AgentQAAnswerStrategy,
  DirectContextAnswerStrategy,
  VoiceAnswerModeConfigurationError,
  createVoiceAnswerStrategy,
  resolveVoiceAnswerMode,
  type VoiceAnswerMode,
  type VoiceAnswerQuestionDelegate
} from "./answer-strategy";

const input: AnswerQuestionWithAIInput = {
  uploadId: "upload_1",
  question: "What happened today?",
  segments: [],
  semanticSegments: [],
  briefItems: []
};

const answer: QuestionAnswer = {
  id: "answer_1",
  uploadId: "upload_1",
  question: input.question,
  answer: "Nothing important was recorded.",
  citedSegmentIds: [],
  createdAt: "2026-07-21T00:00:00.000Z"
};

afterEach(() => {
  vi.unstubAllEnvs();
});

function delegateReturning(result = answer) {
  return vi.fn<VoiceAnswerQuestionDelegate>(async () => result);
}

describe("voice answer mode configuration", () => {
  it("defaults undefined, empty, and whitespace-only values to agent", () => {
    expect(resolveVoiceAnswerMode(undefined)).toBe("agent");
    expect(resolveVoiceAnswerMode("")).toBe("agent");
    expect(resolveVoiceAnswerMode("   ")).toBe("agent");
  });

  it("creates the production Agent QA strategy by default", () => {
    vi.stubEnv("VOICE_ANSWER_MODE", "");
    const delegate = delegateReturning();

    const strategy = createVoiceAnswerStrategy({ answerQuestionWithAI: delegate });

    expect(strategy).toBeInstanceOf(AgentQAAnswerStrategy);
    expect(strategy.mode).toBe("agent");
  });

  it("creates the experimental direct-context strategy only when explicitly selected", () => {
    vi.stubEnv("VOICE_ANSWER_MODE", "direct");
    const delegate = delegateReturning();

    const strategy = createVoiceAnswerStrategy({ answerQuestionWithAI: delegate });

    expect(strategy).toBeInstanceOf(DirectContextAnswerStrategy);
    expect(strategy.mode).toBe("direct");
  });

  it("rejects invalid or case-normalized modes instead of silently changing paths", () => {
    expect(() => resolveVoiceAnswerMode("fallback")).toThrow(VoiceAnswerModeConfigurationError);
    expect(() => resolveVoiceAnswerMode("DIRECT")).toThrow(
      "VOICE_ANSWER_MODE must be agent or direct"
    );
  });
});

describe.each<{
  mode: VoiceAnswerMode;
  create: (delegate: VoiceAnswerQuestionDelegate) => AgentQAAnswerStrategy | DirectContextAnswerStrategy;
}>([
  { mode: "agent", create: (delegate) => new AgentQAAnswerStrategy(delegate) },
  { mode: "direct", create: (delegate) => new DirectContextAnswerStrategy(delegate) }
])("$mode voice answer strategy", ({ mode, create }) => {
  it("forces its mode, calls the delegate once, and returns the compatible answer unchanged", async () => {
    const delegate = delegateReturning();
    const strategy = create(delegate);

    const result = await strategy.answer(input);

    expect(delegate).toHaveBeenCalledTimes(1);
    expect(delegate).toHaveBeenCalledWith({ ...input, answerMode: mode });
    expect(result).toBe(answer);
    expect(QuestionAnswerSchema.safeParse(result).success).toBe(true);
  });

  it("preserves non-enumerable observability hooks used by scoped voice QA", async () => {
    const onDiagnostics = vi.fn();
    const onRetrievedEvidence = vi.fn();
    const internalInput = { ...input };
    Object.defineProperties(internalInput, {
      memoryRetrievalMs: { value: 7, enumerable: false },
      onDiagnostics: { value: onDiagnostics, enumerable: false },
      onRetrievedEvidence: { value: onRetrievedEvidence, enumerable: false }
    });
    const delegate = vi.fn<VoiceAnswerQuestionDelegate>(async (received) => {
      expect(received.memoryRetrievalMs).toBe(7);
      expect(received.onDiagnostics).toBe(onDiagnostics);
      expect(received.onRetrievedEvidence).toBe(onRetrievedEvidence);
      return answer;
    });

    await create(delegate).answer(internalInput);

    expect(delegate).toHaveBeenCalledOnce();
  });
});

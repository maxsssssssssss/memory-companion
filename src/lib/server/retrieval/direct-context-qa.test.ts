import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chatCreate = vi.hoisted(() => vi.fn());
const createOpenAIClient = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/openai/client", () => ({
  createOpenAIClient,
  resolveOpenAIClientProvider: vi.fn(() => "openai-compatible")
}));

vi.mock("@/lib/server/settings/provider-config", () => ({
  getOpenAIClientRuntimeConfig: vi.fn(async () => ({ openAiApiKey: "test-key" })),
  getQaModelPreference: vi.fn(async () => "test-model"),
  getQaPromptPreference: vi.fn(async () => "Keep the answer concise.")
}));

import type { TranscriptSegment } from "@/lib/domain/types";
import type { QaExecutionDiagnostics } from "./qa-observability";
import {
  answerQuestionWithAI,
  buildDirectContextQaSystemPrompt,
  buildHumanizedQaSystemPrompt
} from "./ai-qa";

const originalQaWireApi = process.env.OPENAI_QA_WIRE_API;

function segment(): TranscriptSegment {
  return {
    id: "segment-direct-1",
    uploadId: "upload-direct",
    startSeconds: 10,
    endSeconds: 18,
    text: "The rehearsal was confirmed for Tuesday at seven.",
    confidence: 0.95,
    sceneLabels: ["unknown"],
    valueLabels: ["commitment"]
  };
}

beforeEach(() => {
  delete process.env.OPENAI_QA_WIRE_API;
  chatCreate.mockReset();
  createOpenAIClient.mockReturnValue({
    chat: { completions: { create: chatCreate } }
  });
});

afterEach(() => {
  if (originalQaWireApi === undefined) delete process.env.OPENAI_QA_WIRE_API;
  else process.env.OPENAI_QA_WIRE_API = originalQaWireApi;
});

describe("experimental direct-context QA", () => {
  it("uses a smaller prompt while preserving citation and safety post-validation", async () => {
    chatCreate.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            mode: "memory_answer",
            answer: "The rehearsal was confirmed for Tuesday at seven. [E1]",
            citationIds: ["E1"]
          })
        }
      }]
    });
    let diagnostics: QaExecutionDiagnostics | undefined;

    const answer = await answerQuestionWithAI({
      uploadId: "upload-direct",
      question: "When is the rehearsal?",
      answerMode: "direct",
      memoryRetrievalMs: 3,
      segments: [segment()],
      semanticSegments: [],
      briefItems: [],
      onDiagnostics: (value) => {
        diagnostics = value;
      }
    });

    const request = chatCreate.mock.calls[0]?.[0];
    expect(request.messages[0].content).toBe(buildDirectContextQaSystemPrompt(
      "current",
      "Keep the answer concise."
    ));
    expect(request.messages[0].content.length).toBeLessThan(
      buildHumanizedQaSystemPrompt("current", "Keep the answer concise.").length
    );
    expect(chatCreate).toHaveBeenCalledOnce();
    expect(answer.citedSegmentIds).toEqual(["segment-direct-1"]);
    expect(answer.citations?.map((citation) => citation.id)).toEqual(["E1"]);
    expect(diagnostics).toMatchObject({
      answerMode: "direct",
      memoryRetrievalMs: 3,
      evidenceCount: 1,
      providerCallCount: 1,
      fallbackReason: "none"
    });
    expect(diagnostics?.promptCharacters).toBeGreaterThan(0);
    expect(diagnostics?.responseCharacters).toBeGreaterThan(0);
  });

  it("keeps the existing Agent QA prompt as the default mode", async () => {
    chatCreate.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            mode: "memory_answer",
            answer: "The rehearsal was confirmed. [E1]",
            citationIds: ["E1"]
          })
        }
      }]
    });

    await answerQuestionWithAI({
      uploadId: "upload-agent",
      question: "Was the rehearsal confirmed?",
      segments: [segment()],
      semanticSegments: [],
      briefItems: []
    });

    expect(chatCreate.mock.calls[0]?.[0].messages[0].content).toBe(
      buildHumanizedQaSystemPrompt("current", "Keep the answer concise.")
    );
  });

  it("rejects assistant_meta routing for a recording question", async () => {
    chatCreate.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            mode: "assistant_meta",
            answer: "I can summarize that without evidence.",
            citationIds: []
          })
        }
      }]
    });
    let diagnostics: QaExecutionDiagnostics | undefined;

    const result = await answerQuestionWithAI({
      uploadId: "upload-direct",
      question: "Summarize today's recording.",
      answerMode: "direct",
      segments: [segment()],
      semanticSegments: [],
      briefItems: [],
      onDiagnostics: (value) => {
        diagnostics = value;
      }
    });

    expect(result.answer).not.toContain("without evidence");
    expect(diagnostics?.fallbackReason).toBe("assistant_meta_scope");
  });

  it("isolates evidence observers from the evidence used for grounding", async () => {
    chatCreate.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            mode: "memory_answer",
            answer: "The rehearsal was confirmed. [E1]",
            citationIds: ["E1"]
          })
        }
      }]
    });

    const result = await answerQuestionWithAI({
      uploadId: "upload-direct",
      question: "Was the rehearsal confirmed?",
      answerMode: "direct",
      segments: [segment()],
      semanticSegments: [],
      briefItems: [],
      onRetrievedEvidence: (observed) => {
        observed.splice(0, observed.length);
      }
    });

    expect(result.citedSegmentIds).toEqual(["segment-direct-1"]);
    expect(chatCreate.mock.calls[0]?.[0].messages[1].content).toContain(
      "The rehearsal was confirmed for Tuesday at seven."
    );
  });
});

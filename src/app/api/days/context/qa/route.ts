import { NextResponse } from "next/server";
import { z } from "zod";
import {
  AudioInsightSchema,
  BriefItemSchema,
  RelationshipSignalCardSchema,
  SemanticSegmentSchema,
  TranscriptSegmentSchema
} from "@/lib/domain/types";
import { isUnauthenticatedError, requireAuthContext, unauthorizedResponse } from "@/lib/server/auth/request-context";
import {
  dateRangeFromScopeId,
  observeMemoryShadowRetrieval
} from "@/lib/server/memory/shadow-retrieval";
import {
  answerQuestionWithAI,
  normalizeQaConversation,
  retrieveQaEvidence,
  type AnswerQuestionWithAIInput,
  type QaRetrievedEvidence
} from "@/lib/server/retrieval/ai-qa";
import {
  retrieveMemoryIndexEvidence,
  type MemoryIndexQaContext
} from "@/lib/server/retrieval/memory-index-evidence";
import { qaPromptInstructionFromBody } from "@/lib/server/retrieval/qa-prompt-override";

const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

const ContextQaBodySchema = z.object({
  uploadId: z.string().min(1).regex(STORE_KEY_PATTERN),
  scope: z.enum(["current", "week", "all"]).default("current"),
  question: z.string().trim().min(1),
  conversation: z.unknown().optional(),
  promptPresetId: z.unknown().optional(),
  customPrompt: z.unknown().optional(),
  segments: z.array(TranscriptSegmentSchema).default([]),
  audioInsights: z.array(AudioInsightSchema).default([]),
  semanticSegments: z.array(SemanticSegmentSchema).default([]),
  briefItems: z.array(BriefItemSchema).default([]),
  relationshipSignals: z.array(z.unknown()).default([])
});

export async function POST(request: Request) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return unauthorizedResponse();
    }
    throw error;
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsedBody = ContextQaBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "invalid_day_context" }, { status: 400 });
  }

  const {
    uploadId,
    scope,
    question,
    conversation: rawConversation,
    segments,
    audioInsights,
    semanticSegments,
    briefItems,
    relationshipSignals: rawRelationshipSignals
  } = parsedBody.data;
  const relationshipSignals = rawRelationshipSignals.flatMap((value) => {
    const parsed = RelationshipSignalCardSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  if (
    segments.length === 0 &&
    audioInsights.length === 0 &&
    semanticSegments.length === 0 &&
    briefItems.length === 0 &&
    relationshipSignals.length === 0
  ) {
    return NextResponse.json({ error: "day_context_not_found" }, { status: 404 });
  }

  const conversation = normalizeQaConversation(rawConversation);
  const qaPromptInstruction = qaPromptInstructionFromBody(parsedBody.data);
  let memoryContext: MemoryIndexQaContext | undefined;
  let memoryIndexFallback = false;

  if (scope === "week" || scope === "all") {
    try {
      const dateRange = scope === "week" ? dateRangeFromScopeId(uploadId) : undefined;
      memoryContext = retrieveMemoryIndexEvidence({
        userId: authContext.user.id,
        scope,
        query: question,
        ...(dateRange ? { dateRange } : {})
      });
    } catch (error) {
      memoryIndexFallback = true;
      console.warn(
        `[memory-qa] scope=${scope} memory_retrieval_failure=${error instanceof Error ? error.message : "unknown_error"}`
      );
    }
  }

  const qaInput: AnswerQuestionWithAIInput = {
    uploadId,
    question,
    scope,
    segments,
    audioInsights,
    semanticSegments,
    briefItems,
    relationshipSignals,
    settingsStore: authContext.store,
    ...(memoryContext && memoryContext.count > 0 ? { memoryContext } : {}),
    ...(memoryIndexFallback ? { memoryIndexFallback: true } : {}),
    ...(qaPromptInstruction ? { qaPromptInstruction } : {}),
    ...(conversation.length > 0 ? { conversation } : {})
  };
  let shadowSnapshot: { evidence: QaRetrievedEvidence[]; elapsedMs: number } | null = null;

  if (scope === "week" || scope === "all") {
    try {
      const startedAt = performance.now();
      const evidence = retrieveQaEvidence(qaInput);
      shadowSnapshot = {
        evidence,
        elapsedMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100)
      };
    } catch (error) {
      console.warn(
        `[memory-shadow] scope=${scope} json_observer_failure=${error instanceof Error ? error.message : "unknown_error"}`
      );
    }
  }

  const answer = await answerQuestionWithAI(qaInput);

  if (shadowSnapshot && (scope === "week" || scope === "all")) {
    try {
      const dateRange = scope === "week" ? dateRangeFromScopeId(uploadId) : undefined;
      observeMemoryShadowRetrieval({
        userId: authContext.user.id,
        scope,
        query: question,
        ...(dateRange ? { dateRange } : {}),
        jsonEvidence: shadowSnapshot.evidence,
        jsonRetrievalTimeMs: shadowSnapshot.elapsedMs
      });
    } catch (error) {
      console.warn(
        `[memory-shadow] scope=${scope} observer_failure=${error instanceof Error ? error.message : "unknown_error"}`
      );
    }
  }

  return NextResponse.json(answer);
}

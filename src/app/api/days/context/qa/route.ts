import { NextResponse } from "next/server";
import { z } from "zod";
import {
  AudioInsightSchema,
  BriefItemSchema,
  RelationshipSignalCardSchema,
  SemanticSegmentSchema,
  TranscriptSegmentSchema
} from "@/lib/domain/types";
import {
  applySpeakerAliasesToPayload,
  sanitizeSpeakerAliases,
  type StoredSpeakerAliases
} from "@/lib/domain/speaker-aliases";
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
import {
  acceptsQaBrowserStream,
  createTextQaBrowserStream,
  textQaNdjsonResponse
} from "@/lib/server/retrieval/text-qa-stream";

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
  relationshipSignals: z.array(z.unknown()).default([]),
  speakerAliasesByUploadId: z.unknown().optional()
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
    relationshipSignals: rawRelationshipSignals,
    speakerAliasesByUploadId: rawSpeakerAliasesByUploadId
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
    userId: authContext.user.id,
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
  const hybridSource = { segments, audioInsights, semanticSegments, briefItems };
  const sourceUploadIds = [
    ...new Set(
      [segments, audioInsights, semanticSegments, briefItems]
        .flat()
        .map((item) => item.uploadId)
        .filter((id) => STORE_KEY_PATTERN.test(id))
    )
  ];
  const browserAliases =
    rawSpeakerAliasesByUploadId &&
    typeof rawSpeakerAliasesByUploadId === "object" &&
    !Array.isArray(rawSpeakerAliasesByUploadId)
      ? rawSpeakerAliasesByUploadId as Record<string, unknown>
      : {};
  let hybridAliasedPayload = hybridSource;
  try {
    const aliasesByUploadId = Object.fromEntries(
      await Promise.all(sourceUploadIds.map(async (sourceUploadId) => {
        if (Object.prototype.hasOwnProperty.call(browserAliases, sourceUploadId)) {
          return [
            sourceUploadId,
            sanitizeSpeakerAliases(browserAliases[sourceUploadId])
          ] as const;
        }
        const stored = await authContext.store.read<StoredSpeakerAliases>(
          "speaker-aliases",
          sourceUploadId
        );
        return [sourceUploadId, sanitizeSpeakerAliases(stored?.aliases ?? {})] as const;
      }))
    );
    hybridAliasedPayload = applySpeakerAliasesToPayload(
      hybridSource,
      aliasesByUploadId
    );
  } catch (error) {
    // Alias projection is Hybrid-only. Lexical QA must remain available even
    // if the optional projection cannot be loaded.
    console.warn(
      `[hybrid-qa] alias_projection=fallback ` +
      `error_name=${error instanceof Error ? error.name : "unknown"}`
    );
  }
  Object.defineProperty(qaInput, "hybridEvidenceInput", {
    value: { ...hybridAliasedPayload, relationshipSignals },
    enumerable: false
  });
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

  const observeShadowSnapshot = () => {
    if (!shadowSnapshot || (scope !== "week" && scope !== "all")) return;
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
  };

  if (acceptsQaBrowserStream(request)) {
    return textQaNdjsonResponse(
      createTextQaBrowserStream({
        input: qaInput,
        onFinal: observeShadowSnapshot
      })
    );
  }

  const answer = await answerQuestionWithAI(qaInput);
  observeShadowSnapshot();

  return NextResponse.json(answer);
}

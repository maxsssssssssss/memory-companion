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
import { matchesRecordingRevision, PriorCitationsSchema, verifiedPriorSources } from "@/lib/server/date-companion/qa-prior-sources";
import { getDateCompanionRepository } from "@/lib/server/date-companion";
import { recordingQaReviewedMaterials } from "@/lib/domain/date-companion-recording-qa";
import { QaTurnError } from "@/lib/server/retrieval/qa-provider";
import {
  acceptsQaBrowserStream,
  createTextQaBrowserStream,
  textQaNdjsonResponse
} from "@/lib/server/retrieval/text-qa-stream";

const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

const ContextQaBodySchema = z.object({
  uploadId: z.string().min(1).regex(STORE_KEY_PATTERN),
  scope: z.enum(["current", "week", "all"]).default("current"),
  caller: z.literal("date_companion_current").optional(),
  priorCitations: PriorCitationsSchema.optional(),
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

function currentUploadContextIsExact(input: {
  uploadId: string;
  segments: z.infer<typeof TranscriptSegmentSchema>[];
  audioInsights: z.infer<typeof AudioInsightSchema>[];
  semanticSegments: z.infer<typeof SemanticSegmentSchema>[];
  briefItems: z.infer<typeof BriefItemSchema>[];
  relationshipSignals: z.infer<typeof RelationshipSignalCardSchema>[];
}) {
  const segmentIds = input.segments.map((segment) => segment.id);
  const allowedSourceIds = new Set(segmentIds);
  const sourcesAreCurrent = (sourceIds: readonly string[]) =>
    sourceIds.length > 0 && sourceIds.every((sourceId) => allowedSourceIds.has(sourceId));
  return new Set(segmentIds).size === segmentIds.length
    && input.segments.every((segment) => segment.uploadId === input.uploadId)
    && input.audioInsights.every((insight) =>
      insight.uploadId === input.uploadId
      && sourcesAreCurrent(insight.sourceSegmentIds)
      && (insight.emotionEvidence ?? []).every((evidence) =>
        sourcesAreCurrent(evidence.sourceSegmentIds)
      )
    )
    && input.semanticSegments.every((segment) =>
      segment.uploadId === input.uploadId && sourcesAreCurrent(segment.sourceSegmentIds)
    )
    && input.briefItems.every((item) =>
      item.uploadId === input.uploadId && sourcesAreCurrent(item.sourceSegmentIds)
    )
    && input.relationshipSignals.every((card) =>
      card.uploadId === input.uploadId
      && sourcesAreCurrent(card.evidenceSegments.map((evidence) => evidence.segmentId))
    );
}

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
  if (parsedBody.data.caller === "date_companion_current" && scope !== "current") {
    return NextResponse.json({ error: "invalid_current_upload_context" }, { status: 400 });
  }
  const relationshipSignals = rawRelationshipSignals.flatMap((value) => {
    const parsed = RelationshipSignalCardSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  if (
    scope === "current"
    && !currentUploadContextIsExact({
      uploadId,
      segments,
      audioInsights,
      semanticSegments,
      briefItems,
      relationshipSignals
    })
  ) {
    return NextResponse.json({ error: "invalid_current_upload_context" }, { status: 400 });
  }
  const companionRecording = parsedBody.data.caller === "date_companion_current";
  const original = { segments, audioInsights, semanticSegments, briefItems, relationshipSignals };
  let materials = original;
  let reviewed = new Map<string, "self" | "companion">();
  let assertSourceScope: (() => void) | undefined;
  if (companionRecording) {
    try {
      const repo = getDateCompanionRepository();
      const accountId = authContext.user.id;
      const current = () => repo.getSegmentReviewVersionByUpload(accountId, uploadId);
      const start = current();
      if (start) {
        const record = repo.getInteractionDetail(accountId, start.relationshipId, start.interactionId);
        ({ materials, reviewed } = recordingQaReviewedMaterials(record, original));
      }
      assertSourceScope = () => {
        const next = current();
        if (next?.interactionId !== start?.interactionId || next?.version !== start?.version) throw new QaTurnError("qa_scope_changed");
      };
    } catch {
      return NextResponse.json({ error: "qa_source_verification_unavailable" }, { status: 503 });
    }
  }
  if (
    materials.segments.length === 0 && materials.audioInsights.length === 0 && materials.semanticSegments.length === 0
    && materials.briefItems.length === 0 && materials.relationshipSignals.length === 0
  ) {
    return NextResponse.json({ error: "day_context_not_found" }, { status: 404 });
  }

  const conversation = companionRecording
    ? verifiedPriorSources(materials.segments, (parsedBody.data.priorCitations ?? []).filter(citation =>
        !reviewed.has(citation.sourceSegmentId) || citation.revision), (citation, segment) =>
        matchesRecordingRevision(citation, segment, reviewed.get(segment.id)))
    : normalizeQaConversation(rawConversation);
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
    ...materials,
    settingsStore: authContext.store,
    ...(companionRecording
      ? { requireExplicitRetry: true, includeCitationKind: true, signal: request.signal, assertSourceScope,
          ...(materials !== original ? { disableHybridRetrieval: true } : {}) } : {}),
    ...(scope === "current"
      ? { retrievalSourceSegmentIds: [...new Set(materials.segments.map((segment) => segment.id))] }
      : {}),
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
  try {
    assertSourceScope?.();
  } catch {
    return NextResponse.json({ error: "qa_scope_changed" }, { status: 409 });
  }
  observeShadowSnapshot();

  return NextResponse.json(answer);
}

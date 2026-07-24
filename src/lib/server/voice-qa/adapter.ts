import type {
  AudioInsight,
  AudioUpload,
  BriefItem,
  QuestionAnswer,
  RelationshipSignalCard,
  SemanticSegment,
  TranscriptSegment
} from "@/lib/domain/types";
import type { VoiceQaContext } from "@/lib/domain/voice-qa-context";
import {
  applySpeakerAliasesToPayload,
  sanitizeSpeakerAliases,
  type StoredSpeakerAliases
} from "@/lib/domain/speaker-aliases";
import { VoiceEvent, type ParsedVoiceServerEvent } from "@/lib/server/voice/events";
import {
  answerMemoryScopeQuestion,
  currentWeekRange,
  isUploadInRange
} from "@/lib/server/retrieval/memory-scope-qa";
import {
  answerQuestionStream,
  answerQuestionWithAI,
  normalizeQaConversation,
  type AnswerQuestionWithAIInput,
  type QaScope
} from "@/lib/server/retrieval/ai-qa";
import { safeElapsedMs } from "@/lib/server/retrieval/qa-observability";
import type { JsonStore } from "@/lib/server/storage/json-store";
import {
  createVoiceAnswerStrategy,
  type VoiceAnswerMode
} from "./answer-strategy";
import type {
  VoiceQaAnswerer,
  VoiceQARequest,
  VoiceQaResponseMode,
  VoiceQaTranscriptFinality,
  VoiceQaTranscriptUpdate
} from "./types";

const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const ALL_MEMORY_SCOPE_ID = "all_memory";
const VOICE_QA_STYLE_INSTRUCTION = [
  "这是语音回答模式。先直接回答问题，优先使用一到三句简短、自然、适合朗读的话。",
  "保留事实边界和必要的不确定性，不使用 Markdown 标题或列表。",
  "输出仍需遵守现有 QA citation 契约并保留 [E#]；语音投影层会在朗读前移除引用编号。"
].join("\n");

export type MemoryVoiceQaScope = Extract<QaScope, "current" | "week" | "all">;

export type MemoryVoiceQaAnswererDependencies = {
  answerQuestionWithAI: typeof answerQuestionWithAI;
  answerQuestionStream: typeof answerQuestionStream;
  answerMemoryScopeQuestion: typeof answerMemoryScopeQuestion;
};

export type CreateMemoryVoiceQaAnswererOptions = {
  userId: string;
  store: JsonStore;
  scope: MemoryVoiceQaScope;
  uploadId?: string;
  referenceDate?: Date;
  context?: VoiceQaContext;
  answerMode?: VoiceAnswerMode;
  dependencies?: Partial<MemoryVoiceQaAnswererDependencies>;
};

export type VoiceQaAdapterErrorCode =
  | "invalid_configuration"
  | "invalid_request"
  | "user_mismatch"
  | "scope_mismatch"
  | "upload_mismatch"
  | "upload_not_found"
  | "upload_not_ready";

export class VoiceQaAdapterError extends Error {
  constructor(
    readonly code: VoiceQaAdapterErrorCode,
    message: string
  ) {
    super(message);
    this.name = "VoiceQaAdapterError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function transcriptFinality(value: unknown): VoiceQaTranscriptFinality {
  if (value === true) return "partial";
  if (value === false) return "final";
  return "unknown";
}

/**
 * Extracts ASR updates only from the active provider session. Chat responses and
 * malformed result entries are deliberately ignored so they cannot trigger QA.
 */
export function parseVoiceQaTranscriptUpdates(
  event: ParsedVoiceServerEvent,
  currentSessionId?: string
): VoiceQaTranscriptUpdate[] {
  if (event.eventId !== VoiceEvent.ASRResponse) return [];

  const expectedSessionId = currentSessionId?.trim();
  if (expectedSessionId && event.sessionId !== expectedSessionId) return [];

  const results = record(event.payload)?.results;
  if (!Array.isArray(results)) return [];

  return results.flatMap((result): VoiceQaTranscriptUpdate[] => {
    const item = record(result);
    const transcript = normalizeVoiceQaQuery(item?.text);
    if (!transcript) return [];

    return [{
      transcript,
      finality: transcriptFinality(item?.is_interim),
      ...(event.sessionId ? { sessionId: event.sessionId } : {})
    }];
  });
}

/** Conservative transport normalization; it does not rewrite wording. */
export function normalizeVoiceQaQuery(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const normalized = input.trim().replace(/\s+/gu, " ");
  return normalized.length > 0 ? normalized : null;
}

function voiceSafeAnswerText(text: string) {
  return text
    .replace(/\[E\d+\]/giu, "")
    .split(/\r?\n/u)
    .map((line) => line
      .replace(/^\s{0,3}#{1,6}\s+/u, "")
      .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/u, "")
      .replace(/^\s*[-*+]\s+/u, "")
      .replace(/^\s*\d+[.)]\s+/u, ""))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Keeps the evidence-bearing QuestionAnswer intact while deriving a response
 * string. TEXT preserves its answer verbatim; VOICE returns a TTS-safe view.
 */
export function projectVoiceQaAnswer(
  answer: QuestionAnswer,
  mode: VoiceQaResponseMode
): string {
  return mode === "TEXT" ? answer.answer : voiceSafeAnswerText(answer.answer);
}

function requireStoreKey(value: string, field: string, code: VoiceQaAdapterErrorCode) {
  const normalized = value.trim();
  if (!STORE_KEY_PATTERN.test(normalized)) {
    throw new VoiceQaAdapterError(code, `${field} is invalid`);
  }
  return normalized;
}

function validateReferenceDate(value: Date | undefined) {
  if (value === undefined) return undefined;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new VoiceQaAdapterError("invalid_configuration", "Voice QA reference date is invalid");
  }
  return new Date(value.getTime());
}

async function persistCurrentAnswer(store: JsonStore, uploadId: string, answer: QuestionAnswer) {
  const answers = (await store.read<QuestionAnswer[]>("answers-by-upload", uploadId)) ?? [];
  await store.write("answers", answer.id, answer);
  try {
    await store.write("answers-by-upload", uploadId, [...answers, answer]);
  } catch (error) {
    await store.delete("answers", answer.id).catch(() => undefined);
    throw error;
  }
}

async function answerCurrentUpload(input: {
  request: VoiceQARequest;
  question: string;
  uploadId: string;
  store: JsonStore;
  answer: (input: AnswerQuestionWithAIInput) => Promise<QuestionAnswer>;
}) {
  const retrievalStartedAt = performance.now();
  const upload = await input.store.read<AudioUpload>("uploads", input.uploadId);
  if (!upload) {
    throw new VoiceQaAdapterError("upload_not_found", "Voice QA upload was not found");
  }
  if (upload.status !== "ready") {
    throw new VoiceQaAdapterError("upload_not_ready", "Voice QA upload is not ready");
  }

  const [segments, audioInsights, semanticSegments, briefItems, relationshipSignals, storedSpeakerAliases] =
    await Promise.all([
      input.store.read<TranscriptSegment[]>("segments", input.uploadId),
      input.store.read<AudioInsight[]>("audio-insights", input.uploadId),
      input.store.read<SemanticSegment[]>("semantic-segments", input.uploadId),
      input.store.read<BriefItem[]>("brief-items", input.uploadId),
      input.store.read<RelationshipSignalCard[]>("relationship-signals", input.uploadId),
      input.store.read<StoredSpeakerAliases>("speaker-aliases", input.uploadId)
    ]);
  const aliasedPayload = applySpeakerAliasesToPayload(
    {
      segments: segments ?? [],
      audioInsights: audioInsights ?? [],
      semanticSegments: semanticSegments ?? [],
      briefItems: briefItems ?? []
    },
    sanitizeSpeakerAliases(storedSpeakerAliases?.aliases ?? {})
  );
  const memoryRetrievalMs = safeElapsedMs(retrievalStartedAt);
  const conversation = normalizeQaConversation(input.request.conversation);
  const qaPromptInstruction = input.request.mode === "VOICE"
    ? VOICE_QA_STYLE_INSTRUCTION
    : undefined;
  const answer = await input.answer({
    uploadId: input.uploadId,
    question: input.question,
    scope: "current",
    segments: aliasedPayload.segments,
    audioInsights: aliasedPayload.audioInsights ?? [],
    semanticSegments: aliasedPayload.semanticSegments ?? [],
    briefItems: aliasedPayload.briefItems,
    relationshipSignals: relationshipSignals ?? [],
    settingsStore: input.store,
    memoryRetrievalMs,
    ...(input.request.onQaDiagnostics
      ? { onDiagnostics: input.request.onQaDiagnostics }
      : {}),
    ...(qaPromptInstruction ? { qaPromptInstruction } : {}),
    ...(conversation.length > 0 ? { conversation } : {})
  });
  await persistCurrentAnswer(input.store, input.uploadId, answer);
  return answer;
}

async function answerProvidedContext(input: {
  request: VoiceQARequest;
  question: string;
  scope: MemoryVoiceQaScope;
  context: VoiceQaContext;
  store: JsonStore;
  answer: (input: AnswerQuestionWithAIInput) => Promise<QuestionAnswer>;
}) {
  const conversation = normalizeQaConversation(input.request.conversation);
  const qaPromptInstruction = input.request.mode === "VOICE"
    ? VOICE_QA_STYLE_INSTRUCTION
    : undefined;

  return input.answer({
    uploadId: input.context.contextId,
    question: input.question,
    scope: input.scope,
    segments: input.context.segments,
    audioInsights: input.context.audioInsights,
    semanticSegments: input.context.semanticSegments,
    briefItems: input.context.briefItems,
    relationshipSignals: input.context.relationshipSignals,
    settingsStore: input.store,
    memoryRetrievalMs: null,
    ...(input.request.onQaDiagnostics
      ? { onDiagnostics: input.request.onQaDiagnostics }
      : {}),
    ...(qaPromptInstruction ? { qaPromptInstruction } : {}),
    ...(conversation.length > 0 ? { conversation } : {})
  });
}

/**
 * Builds an answerer around a caller-supplied, already authenticated user store.
 * Request user/scope/upload values may narrow or confirm configuration, never
 * select a different user's storage.
 */
export function createMemoryVoiceQaAnswerer(
  options: CreateMemoryVoiceQaAnswererOptions
): VoiceQaAnswerer {
  const userId = requireStoreKey(options.userId, "Voice QA user id", "invalid_configuration");
  const configuredUploadId = options.uploadId === undefined
    ? undefined
    : requireStoreKey(options.uploadId, "Voice QA upload id", "invalid_configuration");
  const referenceDate = validateReferenceDate(options.referenceDate);
  if (options.scope !== "current" && configuredUploadId) {
    throw new VoiceQaAdapterError(
      "invalid_configuration",
      "Voice QA upload id is only valid for current scope"
    );
  }
  const dependencies: MemoryVoiceQaAnswererDependencies = {
    answerQuestionWithAI: options.dependencies?.answerQuestionWithAI ?? answerQuestionWithAI,
    answerQuestionStream: options.dependencies?.answerQuestionStream ?? answerQuestionStream,
    answerMemoryScopeQuestion:
      options.dependencies?.answerMemoryScopeQuestion ?? answerMemoryScopeQuestion
  };
  const answerStrategy = createVoiceAnswerStrategy({
    ...(options.answerMode ? { mode: options.answerMode } : {}),
    answerQuestionWithAI: dependencies.answerQuestionWithAI
  });
  const answerWithStrategy: typeof answerQuestionWithAI = (qaInput) =>
    answerStrategy.answer(qaInput);

  async function answerWithOptionalStream(
    request: VoiceQARequest,
    qaInput: AnswerQuestionWithAIInput
  ) {
    if (!request.onQaStreamEvent) return answerWithStrategy(qaInput);

    let finalEvent: Extract<
      import("@/lib/server/retrieval/qa-streaming").QaAnswerStreamEvent,
      { type: "final" }
    > | undefined;
    for await (const event of dependencies.answerQuestionStream({
      ...qaInput,
      answerMode: answerStrategy.mode
    })) {
      // Sentence Commit v2 emits only independently grounded sentence events.
      // Forward them immediately so Voice can begin bounded TTS while the
      // provider is still generating later sentences. Raw token events remain
      // quarantined inside answerQuestionStream and never reach this adapter.
      if (event.type === "sentence_completed") {
        await request.onQaStreamEvent(event);
      }
      if (event.type === "final") finalEvent = event;
    }
    if (!finalEvent) {
      throw new VoiceQaAdapterError(
        "invalid_request",
        "Voice QA stream completed without a final answer"
      );
    }

    await request.onQaStreamEvent(finalEvent);
    return finalEvent.answer;
  }

  return {
    answerMode: answerStrategy.mode,
    async answer(request) {
      if (!request.sessionId?.trim()) {
        throw new VoiceQaAdapterError("invalid_request", "Voice QA session id is required");
      }
      const question = normalizeVoiceQaQuery(request.transcript);
      if (!question) {
        throw new VoiceQaAdapterError("invalid_request", "Voice QA transcript is empty");
      }
      if (request.userId !== undefined) {
        const requestUserId = requireStoreKey(request.userId, "Voice QA request user id", "invalid_request");
        if (requestUserId !== userId) {
          throw new VoiceQaAdapterError("user_mismatch", "Voice QA request user does not match its trusted store");
        }
      }
      if (request.scope !== undefined && request.scope !== options.scope) {
        throw new VoiceQaAdapterError("scope_mismatch", "Voice QA request scope does not match its configured scope");
      }

      if (options.scope === "current") {
        const requestUploadId = request.uploadId === undefined
          ? undefined
          : requireStoreKey(request.uploadId, "Voice QA request upload id", "invalid_request");
        if (configuredUploadId && requestUploadId && configuredUploadId !== requestUploadId) {
          throw new VoiceQaAdapterError("upload_mismatch", "Voice QA request upload does not match its configured upload");
        }
        const uploadId = configuredUploadId ?? requestUploadId;
        if (!uploadId) {
          throw new VoiceQaAdapterError("invalid_request", "Current-scope Voice QA requires an upload id");
        }
        if (options.context) {
          if (options.context.contextId !== uploadId) {
            throw new VoiceQaAdapterError(
              "upload_mismatch",
              "Voice QA context does not match its configured upload"
            );
          }
          return answerProvidedContext({
            request,
            question,
            scope: options.scope,
            context: options.context,
            store: options.store,
            answer: (qaInput) => answerWithOptionalStream(request, qaInput)
          });
        }
        return answerCurrentUpload({
          request,
          question,
          uploadId,
          store: options.store,
          answer: (qaInput) => answerWithOptionalStream(request, qaInput)
        });
      }

      if (request.uploadId !== undefined) {
        throw new VoiceQaAdapterError("invalid_request", "Voice QA upload id is not valid for memory scope");
      }
      if (options.context) {
        return answerProvidedContext({
          request,
          question,
          scope: options.scope,
          context: options.context,
          store: options.store,
          answer: (qaInput) => answerWithOptionalStream(request, qaInput)
        });
      }
      const conversation = normalizeQaConversation(request.conversation);
      const qaPromptInstruction = request.mode === "VOICE"
        ? VOICE_QA_STYLE_INSTRUCTION
        : undefined;
      if (options.scope === "week") {
        const weekRange = currentWeekRange(referenceDate);
        return dependencies.answerMemoryScopeQuestion({
          scopeId: weekRange.scopeId,
          question,
          qaScope: "week",
          userId,
          shadowDateRange: { startDate: weekRange.startKey, endDate: weekRange.endKey },
          store: options.store,
          answerQuestion: (qaInput) => answerWithOptionalStream(request, qaInput),
          ...(request.onQaDiagnostics ? { onDiagnostics: request.onQaDiagnostics } : {}),
          ...(qaPromptInstruction ? { qaPromptInstruction } : {}),
          ...(request.onRetrievedMemoryIds
            ? { onRetrievedMemoryIds: request.onRetrievedMemoryIds }
            : {}),
          includeUpload: (upload) => isUploadInRange(upload, weekRange.start, weekRange.end),
          ...(conversation.length > 0 ? { conversation } : {})
        });
      }

      return dependencies.answerMemoryScopeQuestion({
        scopeId: ALL_MEMORY_SCOPE_ID,
        question,
        qaScope: "all",
        userId,
        store: options.store,
        answerQuestion: (qaInput) => answerWithOptionalStream(request, qaInput),
        ...(request.onQaDiagnostics ? { onDiagnostics: request.onQaDiagnostics } : {}),
        ...(qaPromptInstruction ? { qaPromptInstruction } : {}),
        ...(request.onRetrievedMemoryIds
          ? { onRetrievedMemoryIds: request.onRetrievedMemoryIds }
          : {}),
        ...(conversation.length > 0 ? { conversation } : {})
      });
    }
  };
}

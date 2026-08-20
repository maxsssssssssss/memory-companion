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
import {
  resolveVoiceQaLlmProviderId,
  type QaLlmProviderId
} from "@/lib/server/retrieval/qa-llm-provider";
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
  "第一句必须尽快形成可独立朗读的短句：只表达一个核心结论，中文正文必须控制在 6 到 12 个汉字（标点和引用编号不计），以句号、问号或感叹号结束，并紧接支持该句的 [E#]；不要用冒号、逗号长铺垫或依赖后文才能成立的半句。",
  "每一个句子都必须在本句标点后立即附上至少一个支持该句的 [E#]，不能只在回答末尾集中引用。",
  "严格遵守用户要求的句数：要求一句话时只输出一句；要求多句或多个要点时输出二到三句。如需更多细节，从第二句继续展开；不要为了凑长度扩写第一句。",
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
  llmProviderId?: QaLlmProviderId;
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

function voiceQaAbortError(signal: AbortSignal | undefined) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Voice QA request aborted", "AbortError");
}

function throwIfVoiceQaAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw voiceQaAbortError(signal);
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
  userId: string;
  question: string;
  uploadId: string;
  store: JsonStore;
  answer: (input: AnswerQuestionWithAIInput) => Promise<QuestionAnswer>;
}) {
  throwIfVoiceQaAborted(input.request.signal);
  const retrievalStartedAt = performance.now();
  const upload = await input.store.read<AudioUpload>("uploads", input.uploadId);
  throwIfVoiceQaAborted(input.request.signal);
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
  throwIfVoiceQaAborted(input.request.signal);
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
    userId: input.userId,
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
    ...(input.request.shadowReviewContext
      ? { shadowReviewContext: input.request.shadowReviewContext }
      : {}),
    ...(input.request.onQaDiagnostics
      ? { onDiagnostics: input.request.onQaDiagnostics }
      : {}),
    ...(input.request.onQaMilestone
      ? { onExecutionMilestone: input.request.onQaMilestone }
      : {}),
    ...(input.request.mode === "VOICE"
      ? { withholdUncertainProvisionalSentences: true }
      : {}),
    ...(qaPromptInstruction ? { qaPromptInstruction } : {}),
    ...(conversation.length > 0 ? { conversation } : {})
  });
  throwIfVoiceQaAborted(input.request.signal);
  await persistCurrentAnswer(input.store, input.uploadId, answer);
  throwIfVoiceQaAborted(input.request.signal);
  return answer;
}

async function answerProvidedContext(input: {
  request: VoiceQARequest;
  userId: string;
  question: string;
  scope: MemoryVoiceQaScope;
  context: VoiceQaContext;
  store: JsonStore;
  answer: (input: AnswerQuestionWithAIInput) => Promise<QuestionAnswer>;
}) {
  throwIfVoiceQaAborted(input.request.signal);
  const conversation = normalizeQaConversation(input.request.conversation);
  const qaPromptInstruction = input.request.mode === "VOICE"
    ? VOICE_QA_STYLE_INSTRUCTION
    : undefined;

  const answer = await input.answer({
    userId: input.userId,
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
    ...(input.request.shadowReviewContext
      ? { shadowReviewContext: input.request.shadowReviewContext }
      : {}),
    ...(input.request.onQaDiagnostics
      ? { onDiagnostics: input.request.onQaDiagnostics }
      : {}),
    ...(input.request.onQaMilestone
      ? { onExecutionMilestone: input.request.onQaMilestone }
      : {}),
    ...(input.request.mode === "VOICE"
      ? { withholdUncertainProvisionalSentences: true }
      : {}),
    ...(qaPromptInstruction ? { qaPromptInstruction } : {}),
    ...(conversation.length > 0 ? { conversation } : {})
  });
  throwIfVoiceQaAborted(input.request.signal);
  return answer;
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
  const llmProviderId =
    options.llmProviderId ?? resolveVoiceQaLlmProviderId();
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
    throwIfVoiceQaAborted(request.signal);
    const inheritedEvidenceObserver = qaInput.onRetrievedEvidence;
    const realtimeEvidenceObserver = request.onRetrievedEvidence;
    const trustedQaInput: AnswerQuestionWithAIInput = {
      ...qaInput,
      userId,
      llmProviderId,
      allowQwenInProduction: llmProviderId === "qwen-vllm",
      ...(request.signal ? { signal: request.signal } : {}),
      ...(qaInput.onExecutionMilestone
        ? { onExecutionMilestone: qaInput.onExecutionMilestone }
        : {}),
      ...(qaInput.onDiagnostics ? { onDiagnostics: qaInput.onDiagnostics } : {}),
      ...(qaInput.memoryRetrievalMs !== undefined
        ? { memoryRetrievalMs: qaInput.memoryRetrievalMs }
        : {}),
      ...(qaInput.withholdUncertainProvisionalSentences
        ? { withholdUncertainProvisionalSentences: true }
        : {}),
      ...(
        inheritedEvidenceObserver || realtimeEvidenceObserver
          ? {
              onRetrievedEvidence: (evidence, retrievalMs) => {
                const inherited = inheritedEvidenceObserver?.(evidence, retrievalMs);
                const realtime = realtimeEvidenceObserver?.(evidence, retrievalMs);
                if (
                  (inherited &&
                    typeof (inherited as PromiseLike<unknown>).then === "function") ||
                  (realtime &&
                    typeof (realtime as PromiseLike<unknown>).then === "function")
                ) {
                  return Promise.all([
                    Promise.resolve(inherited),
                    Promise.resolve(realtime)
                  ]);
                }
                return undefined;
              }
            }
          : {}
      )
    };
    if (!request.onQaStreamEvent) {
      const answer = await answerWithStrategy(trustedQaInput);
      throwIfVoiceQaAborted(request.signal);
      return answer;
    }

    let finalEvent: Extract<
      import("@/lib/server/retrieval/qa-streaming").QaAnswerStreamEvent,
      { type: "final" }
    > | undefined;
    for await (const event of dependencies.answerQuestionStream({
      ...trustedQaInput,
      answerMode: answerStrategy.mode
    })) {
      throwIfVoiceQaAborted(request.signal);
      // Sentence Commit v2 emits only independently grounded sentence events.
      // Forward them immediately so Voice can begin bounded TTS while the
      // provider is still generating later sentences. Raw token events remain
      // quarantined inside answerQuestionStream and never reach this adapter.
      if (event.type === "sentence_completed") {
        await request.onQaStreamEvent(event);
      }
      if (event.type === "final") finalEvent = event;
    }
    throwIfVoiceQaAborted(request.signal);
    if (!finalEvent) {
      throw new VoiceQaAdapterError(
        "invalid_request",
        "Voice QA stream completed without a final answer"
      );
    }

    await request.onQaStreamEvent(finalEvent);
    throwIfVoiceQaAborted(request.signal);
    return finalEvent.answer;
  }

  return {
    answerMode: answerStrategy.mode,
    async answer(request) {
      throwIfVoiceQaAborted(request.signal);
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
            userId,
            question,
            scope: options.scope,
            context: options.context,
            store: options.store,
            answer: (qaInput) => answerWithOptionalStream(request, qaInput)
          });
        }
        return answerCurrentUpload({
          request,
          userId,
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
          userId,
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
        const answer = await dependencies.answerMemoryScopeQuestion({
          scopeId: weekRange.scopeId,
          question,
          qaScope: "week",
          userId,
          shadowDateRange: { startDate: weekRange.startKey, endDate: weekRange.endKey },
          store: options.store,
          answerQuestion: (qaInput) => answerWithOptionalStream(request, qaInput),
          ...(request.shadowReviewContext
            ? { shadowReviewContext: request.shadowReviewContext }
            : {}),
          ...(request.onQaDiagnostics ? { onDiagnostics: request.onQaDiagnostics } : {}),
          ...(request.onQaMilestone ? { onExecutionMilestone: request.onQaMilestone } : {}),
          ...(request.mode === "VOICE"
            ? { withholdUncertainProvisionalSentences: true }
            : {}),
          ...(qaPromptInstruction ? { qaPromptInstruction } : {}),
          ...(request.onRetrievedMemoryIds
            ? { onRetrievedMemoryIds: request.onRetrievedMemoryIds }
            : {}),
          includeUpload: (upload) => isUploadInRange(upload, weekRange.start, weekRange.end),
          ...(conversation.length > 0 ? { conversation } : {})
        });
        throwIfVoiceQaAborted(request.signal);
        return answer;
      }

      const answer = await dependencies.answerMemoryScopeQuestion({
        scopeId: ALL_MEMORY_SCOPE_ID,
        question,
        qaScope: "all",
        userId,
        store: options.store,
        answerQuestion: (qaInput) => answerWithOptionalStream(request, qaInput),
        ...(request.shadowReviewContext
          ? { shadowReviewContext: request.shadowReviewContext }
          : {}),
        ...(request.onQaDiagnostics ? { onDiagnostics: request.onQaDiagnostics } : {}),
        ...(request.onQaMilestone ? { onExecutionMilestone: request.onQaMilestone } : {}),
        ...(request.mode === "VOICE"
          ? { withholdUncertainProvisionalSentences: true }
          : {}),
        ...(qaPromptInstruction ? { qaPromptInstruction } : {}),
        ...(request.onRetrievedMemoryIds
          ? { onRetrievedMemoryIds: request.onRetrievedMemoryIds }
          : {}),
        ...(conversation.length > 0 ? { conversation } : {})
      });
      throwIfVoiceQaAborted(request.signal);
      return answer;
    }
  };
}

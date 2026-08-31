import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import {
  DAILY_REFLECTION_THINKING_SAFETY_BOUNDARY_VERSION,
  DailyReflectionThinkingContextResolveResultSchema,
  DailyReflectionThinkingConversationIdSchema,
  DailyReflectionThinkingConversationSchema,
  DailyReflectionThinkingRequestSchema,
  DailyReflectionThinkingResponseSchema,
  type DailyReflectionThinkingContextResolveRequest,
  type DailyReflectionThinkingContextResolveResult,
  type DailyReflectionThinkingConversation,
  type DailyReflectionThinkingMessage,
  type DailyReflectionThinkingRequest,
  type DailyReflectionThinkingResponse,
  type DailyReflectionThinkingSource
} from "@/lib/domain/daily-reflection-thinking";
import type { JsonStore } from "@/lib/server/storage/json-store";

import {
  DailyReflectionThinkingProviderTimeoutError,
  getThinkingConversationProvider,
  normalizeDailyReflectionThinkingPlainText,
  projectDailyReflectionThinkingCanonicalClaims,
  type ThinkingConversationProvider
} from "./thinking-provider";

const CONVERSATION_COLLECTION = "daily-reflection-thinking-conversations";
const OPERATION_COLLECTION = "daily-reflection-thinking-operations";
const NO_RESULT_ANSWER = "现有可信记录里没有找到与这个问题相关的过去线索。";
const PROVIDER_ERROR_ANSWER = "这次一起想暂时没有完成，请稍后再试。";
const CANCELLED_ANSWER = "这次一起想已取消。";
const MAX_MESSAGE_CONTENT_LENGTH = 8_000;

function directAssistantContent(answer: string) {
  const content = normalizeDailyReflectionThinkingPlainText(answer);
  if (!content || content.length > MAX_MESSAGE_CONTENT_LENGTH) {
    throw new Error("Thinking Provider output exceeds the safe message boundary");
  }
  return content;
}

const ThinkingOperationRecordSchema = z.object({
  schemaVersion: z.literal(1),
  operationKey: z.string().trim().min(1).max(512),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  conversationId: DailyReflectionThinkingConversationIdSchema,
  status: z.enum(["pending", "completed"]),
  response: DailyReflectionThinkingResponseSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict().superRefine((record, context) => {
  if ((record.status === "completed") !== (record.response !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["response"],
      message: "completed operations require a response"
    });
  }
});

type ThinkingOperationRecord = z.infer<typeof ThinkingOperationRecordSchema>;

export interface DailyReflectionThinkingContextResolver {
  resolve(
    request: DailyReflectionThinkingContextResolveRequest
  ): DailyReflectionThinkingContextResolveResult | Promise<DailyReflectionThinkingContextResolveResult>;
}

export interface DailyReflectionThinkingConversationStore {
  readConversation(conversationId: string): Promise<DailyReflectionThinkingConversation | null>;
  writeConversation(conversation: DailyReflectionThinkingConversation): Promise<void>;
  readOperation(operationKey: string): Promise<ThinkingOperationRecord | null>;
  writeOperation(operation: ThinkingOperationRecord): Promise<void>;
}

export class JsonStoreThinkingConversationStore implements DailyReflectionThinkingConversationStore {
  constructor(private readonly store: JsonStore) {}

  async readConversation(conversationId: string) {
    const id = DailyReflectionThinkingConversationIdSchema.parse(conversationId);
    const value = await this.store.read<unknown>(CONVERSATION_COLLECTION, id);
    return value === null ? null : DailyReflectionThinkingConversationSchema.parse(value);
  }

  async writeConversation(conversation: DailyReflectionThinkingConversation) {
    const parsed = DailyReflectionThinkingConversationSchema.parse(conversation);
    await this.store.write(CONVERSATION_COLLECTION, parsed.conversationId, parsed);
  }

  async readOperation(operationKey: string) {
    const value = await this.store.read<unknown>(
      OPERATION_COLLECTION,
      operationStorageId(operationKey)
    );
    return value === null ? null : ThinkingOperationRecordSchema.parse(value);
  }

  async writeOperation(operation: ThinkingOperationRecord) {
    const parsed = ThinkingOperationRecordSchema.parse(operation);
    await this.store.write(
      OPERATION_COLLECTION,
      operationStorageId(parsed.operationKey),
      parsed
    );
  }
}

export class DailyReflectionThinkingConversationNotFoundError extends Error {
  constructor() {
    super("Daily Reflection Thinking conversation was not found");
    this.name = "DailyReflectionThinkingConversationNotFoundError";
  }
}

export class DailyReflectionThinkingOperationConflictError extends Error {
  constructor() {
    super("Daily Reflection Thinking operationKey was reused with another request");
    this.name = "DailyReflectionThinkingOperationConflictError";
  }
}

function operationStorageId(operationKey: string) {
  return createHash("sha256").update(operationKey).digest("hex");
}

function requestFingerprint(request: DailyReflectionThinkingRequest) {
  return createHash("sha256").update(JSON.stringify({
    conversationId: request.conversationId ?? null,
    mode: request.mode,
    contextMode: request.contextMode,
    message: request.message,
    pinnedCardIds: request.pinnedCardIds ?? [],
    pinnedMemoryIds: request.pinnedMemoryIds ?? [],
    pinnedEvidenceIds: request.pinnedEvidenceIds ?? []
  })).digest("hex");
}

function newConversationId() {
  return `thinking_${randomUUID().replace(/-/gu, "")}`;
}

function newMessageId() {
  return `thinking_message_${randomUUID().replace(/-/gu, "")}`;
}

function shouldResolveAutoContext(request: DailyReflectionThinkingRequest) {
  if (
    request.pinnedCardIds?.length
    || request.pinnedMemoryIds?.length
    || request.pinnedEvidenceIds?.length
  ) return true;
  return /过去|以前|之前|曾经|上次|记录里|我记得|还记得|回想|历史|\b(?:past|previous|before|remember|history|last\s+time)\b/iu
    .test(request.message);
}

function responseFromAssistant(
  conversationId: string,
  operationKey: string,
  assistant: DailyReflectionThinkingMessage
) {
  if (assistant.role !== "assistant" || !assistant.model) return null;
  return DailyReflectionThinkingResponseSchema.parse({
    conversationId,
    operationKey,
    assistantMessage: assistant,
    usedPersonalContext: assistant.usedPersonalContext,
    sources: assistant.sources,
    model: assistant.model
  });
}

function assistantForOperation(
  conversation: DailyReflectionThinkingConversation,
  operationKey: string
) {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message?.role === "assistant" && message.operationKey === operationKey) {
      return message;
    }
  }
  return undefined;
}

function completionForError(error: unknown) {
  if (
    error instanceof DailyReflectionThinkingProviderTimeoutError
    || !(error instanceof DOMException && error.name === "AbortError")
  ) {
    return {
      content: PROVIDER_ERROR_ANSWER,
      completionStatus: "provider_error" as const
    };
  }
  return {
    content: CANCELLED_ANSWER,
    completionStatus: "cancelled" as const
  };
}

function operationLockKey(accountId: string, operationKey: string) {
  return `${createHash("sha256").update(accountId).digest("hex")}:${operationStorageId(operationKey)}`;
}

const operationLocks = new Map<string, Promise<unknown>>();

async function serializeOperation<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = operationLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  operationLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (operationLocks.get(key) === current) operationLocks.delete(key);
  }
}

export class DailyReflectionThinkingConversationService {
  constructor(private readonly dependencies: {
    store: DailyReflectionThinkingConversationStore;
    provider: ThinkingConversationProvider;
    contextResolver: DailyReflectionThinkingContextResolver;
    settingsStore: JsonStore;
    now?: () => Date;
  }) {}

  async getConversation(conversationId: string) {
    const conversation = await this.dependencies.store.readConversation(conversationId);
    if (!conversation) throw new DailyReflectionThinkingConversationNotFoundError();
    return conversation;
  }

  async think(
    accountId: string,
    rawRequest: DailyReflectionThinkingRequest,
    signal?: AbortSignal
  ) {
    const request = DailyReflectionThinkingRequestSchema.parse(rawRequest);
    return serializeOperation(
      operationLockKey(accountId, request.operationKey),
      () => this.run(accountId, request, signal)
    );
  }

  private async run(
    accountId: string,
    request: DailyReflectionThinkingRequest,
    signal?: AbortSignal
  ): Promise<DailyReflectionThinkingResponse> {
    const fingerprint = requestFingerprint(request);
    const existingOperation = await this.dependencies.store.readOperation(request.operationKey);
    if (existingOperation) {
      if (existingOperation.requestFingerprint !== fingerprint) {
        throw new DailyReflectionThinkingOperationConflictError();
      }
      if (existingOperation.response) return existingOperation.response;
      const pendingConversation = await this.dependencies.store.readConversation(
        existingOperation.conversationId
      );
      const pendingAssistant = pendingConversation
        ? assistantForOperation(pendingConversation, request.operationKey)
        : undefined;
      const recovered = pendingAssistant
        ? responseFromAssistant(existingOperation.conversationId, request.operationKey, pendingAssistant)
        : null;
      if (recovered) {
        await this.dependencies.store.writeOperation({
          ...existingOperation,
          status: "completed",
          response: recovered,
          updatedAt: this.nowIso()
        });
        return recovered;
      }
    }

    let conversation: DailyReflectionThinkingConversation;
    if (existingOperation) {
      conversation = await this.dependencies.store.readConversation(existingOperation.conversationId)
        ?? this.newConversation(existingOperation.conversationId);
    } else if (request.conversationId) {
      conversation = await this.dependencies.store.readConversation(request.conversationId)
        ?? (() => { throw new DailyReflectionThinkingConversationNotFoundError(); })();
    } else {
      conversation = this.newConversation(newConversationId());
      await this.dependencies.store.writeConversation(conversation);
    }

    const timestamp = this.nowIso();
    if (!existingOperation) {
      await this.dependencies.store.writeOperation({
        schemaVersion: 1,
        operationKey: request.operationKey,
        requestFingerprint: fingerprint,
        conversationId: conversation.conversationId,
        status: "pending",
        response: null,
        createdAt: timestamp,
        updatedAt: timestamp
      });
    }

    const shouldResolve = request.contextMode === "personal"
      || (request.contextMode === "auto" && shouldResolveAutoContext(request));
    let sources: DailyReflectionThinkingSource[] = [];
    if (shouldResolve) {
      const resolved = await this.dependencies.contextResolver.resolve({
          accountId,
          mode: request.mode,
          contextMode: request.contextMode === "personal" ? "personal" : "auto",
          message: request.message,
          pinnedCardIds: request.pinnedCardIds ?? [],
          pinnedMemoryIds: request.pinnedMemoryIds ?? [],
          pinnedEvidenceIds: request.pinnedEvidenceIds ?? []
        });
      const result = DailyReflectionThinkingContextResolveResultSchema.parse({
        sources: resolved.sources
      });
      sources = result.sources;
    }

    let output: {
      content: string;
      personalContextClaims: DailyReflectionThinkingMessage["personalContextClaims"];
      interpretations: string[];
      hypotheses: string[];
      completionStatus: DailyReflectionThinkingMessage["completionStatus"];
    };
    if (request.mode === "past_clues" && sources.length === 0) {
      output = {
        content: NO_RESULT_ANSWER,
        personalContextClaims: [],
        interpretations: [],
        hypotheses: [],
        completionStatus: "no_result"
      };
    } else {
      try {
        const generated = await this.dependencies.provider.generate({
          mode: request.mode,
          contextMode: request.contextMode,
          message: request.message,
          history: conversation.messages,
          sources,
          settingsStore: this.dependencies.settingsStore,
          ...(signal ? { signal } : {})
        });
        const personalContextClaims = projectDailyReflectionThinkingCanonicalClaims(
          generated.personalContextClaims,
          sources
        );
        output = {
          content: directAssistantContent(generated.answer),
          personalContextClaims,
          interpretations: generated.interpretations,
          hypotheses: generated.hypotheses,
          completionStatus: "completed"
        };
      } catch (error) {
        output = {
          ...completionForError(error),
          personalContextClaims: [],
          interpretations: [],
          hypotheses: []
        };
      }
    }

    const usedPersonalContext = sources.length > 0;
    const userMessage: DailyReflectionThinkingMessage = {
      id: newMessageId(),
      operationKey: request.operationKey,
      role: "user",
      mode: request.mode,
      contextMode: request.contextMode,
      content: request.message,
      safetyBoundaryVersion: null,
      usedPersonalContext,
      sources,
      personalContextClaims: [],
      interpretations: [],
      hypotheses: [],
      model: null,
      createdAt: timestamp,
      completionStatus: "completed"
    };
    const assistantMessage: DailyReflectionThinkingMessage = {
      id: newMessageId(),
      operationKey: request.operationKey,
      role: "assistant",
      mode: request.mode,
      contextMode: request.contextMode,
      content: output.content,
      safetyBoundaryVersion: DAILY_REFLECTION_THINKING_SAFETY_BOUNDARY_VERSION,
      usedPersonalContext,
      sources,
      personalContextClaims: output.personalContextClaims,
      interpretations: output.interpretations,
      hypotheses: output.hypotheses,
      model: this.dependencies.provider.model,
      createdAt: this.nowIso(),
      completionStatus: output.completionStatus
    };
    conversation = DailyReflectionThinkingConversationSchema.parse({
      ...conversation,
      messages: [...conversation.messages, userMessage, assistantMessage].slice(-100),
      updatedAt: assistantMessage.createdAt
    });
    await this.dependencies.store.writeConversation(conversation);
    const response = responseFromAssistant(
      conversation.conversationId,
      request.operationKey,
      assistantMessage
    )!;
    await this.dependencies.store.writeOperation({
      schemaVersion: 1,
      operationKey: request.operationKey,
      requestFingerprint: fingerprint,
      conversationId: conversation.conversationId,
      status: "completed",
      response,
      createdAt: existingOperation?.createdAt ?? timestamp,
      updatedAt: assistantMessage.createdAt
    });
    return response;
  }

  private newConversation(conversationId: string): DailyReflectionThinkingConversation {
    const now = this.nowIso();
    return {
      schemaVersion: 1,
      conversationId,
      messages: [],
      createdAt: now,
      updatedAt: now
    };
  }

  private nowIso() {
    return (this.dependencies.now?.() ?? new Date()).toISOString();
  }
}

export function createDailyReflectionThinkingConversationService(input: {
  store: JsonStore;
  contextResolver: DailyReflectionThinkingContextResolver;
  provider?: ThinkingConversationProvider;
  now?: () => Date;
}) {
  return new DailyReflectionThinkingConversationService({
    store: new JsonStoreThinkingConversationStore(input.store),
    provider: input.provider ?? getThinkingConversationProvider(),
    contextResolver: input.contextResolver,
    settingsStore: input.store,
    ...(input.now ? { now: input.now } : {})
  });
}

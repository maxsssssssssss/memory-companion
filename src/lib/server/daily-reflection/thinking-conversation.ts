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
  type DailyReflectionThinkingSource, type ThinkingMode
} from "@/lib/domain/daily-reflection-thinking";
import type { JsonStore } from "@/lib/server/storage/json-store";

import {
  DailyReflectionThinkingProviderTimeoutError,
  getThinkingConversationProvider,
  normalizeDailyReflectionThinkingPlainText,
  projectDailyReflectionThinkingCanonicalClaims,
  sameDailyReflectionThinkingSource,
  type ThinkingConversationProvider
} from "./thinking-provider";

const CONVERSATION_COLLECTION = "daily-reflection-thinking-conversations";
const OPERATION_COLLECTION = "daily-reflection-thinking-operations";
const NO_RESULT_ANSWER = "现有可信记录里没有找到与这个问题相关的过去线索。";
const PROVIDER_ERROR_ANSWER = "这次一起想暂时没有完成，请稍后再试。";
const CANCELLED_ANSWER = "这次一起想已取消。";
const SOURCE_CHANGED_ANSWER = "本轮使用的资料已变化或撤回，这次回复未保存。请按当前资料重新讨论。";
const SOURCE_UNAVAILABLE_HISTORY = "此前自动回复使用的资料已失效，旧摘录不再展示或用于续接。";
const SUPERSEDED_ANSWER = "已有新的用户输入，本轮旧回复已停止保存。请以最新讨论为准。";
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
function conversationLockKey(accountId: string, conversationId: string) {
  return `conversation:${operationLockKey(accountId, conversationId)}`;
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

  async getConversation(accountId: string, conversationId: string) {
    const conversation = await this.dependencies.store.readConversation(conversationId);
    if (!conversation) throw new DailyReflectionThinkingConversationNotFoundError();
    return { ...conversation, messages: await this.projectHistory(accountId, conversation.messages) };
  }

  private async sourceIsCurrent(accountId: string, source: DailyReflectionThinkingSource, input?: { mode: ThinkingMode; message: string }) {
    try {
      const resolved = await this.dependencies.contextResolver.resolve({ accountId, mode: input?.mode === "past_clues" ? "past_clues" : "brainstorm", contextMode: "personal",
        message: input?.mode === "past_clues" ? input.message : "核对这条记录", pinnedCardIds: source.claim.sourceCardIds,
        pinnedMemoryIds: source.claim.sourceMemoryIds, pinnedEvidenceIds: source.claim.evidenceIds });
      return DailyReflectionThinkingContextResolveResultSchema.parse({ sources: resolved.sources }).sources.some(current => sameDailyReflectionThinkingSource(source, current));
    } catch { return false; }
  }

  private async projectHistory(accountId: string, messages: DailyReflectionThinkingMessage[], allowedSources?: DailyReflectionThinkingSource[], fallback?: { mode: ThinkingMode; message: string }) {
    const checks = new Map<string, Promise<boolean>>();
    const current = (source: DailyReflectionThinkingSource, message: DailyReflectionThinkingMessage) => {
      const question = message.role === "user" ? message.content : messages.find(item => item.role === "user" && item.operationKey === message.operationKey)?.content ?? fallback?.message;
      if (message.mode === "past_clues" && !question) return Promise.resolve(false);
      const input = { mode: message.mode, message: question ?? "核对这条记录" };
      const key = JSON.stringify([source, input]);
      if (!checks.has(key)) checks.set(key, this.sourceIsCurrent(accountId, source, input));
      return checks.get(key)!;
    };
    const projected: DailyReflectionThinkingMessage[] = [];
    for (const message of messages) {
      if (allowedSources !== undefined) {
        if (message.role === "user") { projected.push({ ...message, sources: [], usedPersonalContext: false }); continue; }
        if (message.safetyBoundaryVersion !== DAILY_REFLECTION_THINKING_SAFETY_BOUNDARY_VERSION
          || message.sources.some(source => !allowedSources.some(allowed => sameDailyReflectionThinkingSource(source, allowed)))) continue;
      }
      const valid = (await Promise.all(message.sources.map(source => current(source, message)))).every(Boolean);
      // User content is the user's own expression; cached source excerpts are separate.
      if (message.role === "user") {
        projected.push(allowedSources !== undefined || !valid ? { ...message, sources: [], usedPersonalContext: false } : message);
        continue;
      }
      if (allowedSources !== undefined) {
        if (!valid) continue;
      }
      projected.push(valid ? message : { ...message, content: SOURCE_UNAVAILABLE_HISTORY, sources: [], usedPersonalContext: false,
        personalContextClaims: [], interpretations: [], hypotheses: [], safetyBoundaryVersion: null });
    }
    return projected;
  }

  private async projectResponse(accountId: string, response: DailyReflectionThinkingResponse, request: DailyReflectionThinkingRequest) {
    const [assistant] = await this.projectHistory(accountId, [response.assistantMessage], undefined, request);
    return responseFromAssistant(response.conversationId, response.operationKey, assistant)!;
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
      if (existingOperation.response) return this.projectResponse(accountId, existingOperation.response, request);
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
        return this.projectResponse(accountId, recovered, request);
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

    // Save the user's input before any asynchronous source/model work. Its ID is
    // the durable generation fence; the short conversation lock never spans a model call.
    let userMessage: DailyReflectionThinkingMessage = { id: newMessageId(), operationKey: request.operationKey, role: "user", mode: request.mode,
      contextMode: request.contextMode, content: request.message, safetyBoundaryVersion: null, usedPersonalContext: false, sources: [],
      personalContextClaims: [], interpretations: [], hypotheses: [], model: null, createdAt: timestamp, completionStatus: "completed" };
    conversation = await serializeOperation(conversationLockKey(accountId, conversation.conversationId), async () => {
      const latest = await this.dependencies.store.readConversation(conversation.conversationId);
      if (!latest) throw new DailyReflectionThinkingConversationNotFoundError();
      const existingUser = latest.messages.find(message => message.role === "user" && message.operationKey === request.operationKey);
      if (existingUser) { userMessage = existingUser; return latest; }
      const registered = DailyReflectionThinkingConversationSchema.parse({ ...latest, messages: [...latest.messages, userMessage].slice(-100), updatedAt: timestamp });
      await this.dependencies.store.writeConversation(registered);
      return registered;
    });
    const latestInput = (view: DailyReflectionThinkingConversation) => [...view.messages].reverse().find(message => message.role === "user");
    const ownsInput = latestInput(conversation)?.id === userMessage.id;

    const shouldResolve = request.contextMode === "personal"
      || (request.contextMode === "auto" && shouldResolveAutoContext(request));
    let sources: DailyReflectionThinkingSource[] = [];
    if (shouldResolve && ownsInput) {
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
    if (!ownsInput) {
      output = { content: SUPERSEDED_ANSWER, personalContextClaims: [], interpretations: [], hypotheses: [], completionStatus: "provider_error" };
    } else if (request.mode === "past_clues" && sources.length === 0) {
      output = {
        content: NO_RESULT_ANSWER,
        personalContextClaims: [],
        interpretations: [],
        hypotheses: [],
        completionStatus: "no_result"
      };
    } else {
      try {
        const history = await this.projectHistory(accountId, conversation.messages.filter(message => message.id !== userMessage.id), sources);
        if (signal?.aborted) throw new DOMException("Thinking request aborted", "AbortError");
        const current = await this.dependencies.store.readConversation(conversation.conversationId);
        if (!current || latestInput(current)?.id !== userMessage.id) throw new Error("Thinking input was superseded");
        const generated = await this.dependencies.provider.generate({
          mode: request.mode,
          contextMode: request.contextMode,
          message: request.message,
          history,
          sources,
          settingsStore: this.dependencies.settingsStore,
          ...(signal ? { signal } : {})
        });
        if (signal?.aborted) throw new DOMException("Thinking request aborted", "AbortError");
        if (!(await Promise.all(sources.map(source => this.sourceIsCurrent(accountId, source, request)))).every(Boolean)) {
          sources = [];
          output = { content: SOURCE_CHANGED_ANSWER, personalContextClaims: [], interpretations: [], hypotheses: [], completionStatus: "provider_error" };
        } else {
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
        }
      } catch (error) {
        output = {
          ...completionForError(error),
          personalContextClaims: [],
          interpretations: [],
          hypotheses: []
        };
      }
    }

    const assistantMessage = await serializeOperation(conversationLockKey(accountId, conversation.conversationId), async () => {
      const latest = await this.dependencies.store.readConversation(conversation.conversationId);
      const active = latest && latestInput(latest)?.id === userMessage.id;
      if (!active) {
        sources = [];
        output = { content: SUPERSEDED_ANSWER, personalContextClaims: [], interpretations: [], hypotheses: [], completionStatus: "provider_error" };
      }
      const assistant: DailyReflectionThinkingMessage = {
      id: newMessageId(),
      operationKey: request.operationKey,
      role: "assistant",
      mode: request.mode,
      contextMode: request.contextMode,
      content: output.content,
      safetyBoundaryVersion: DAILY_REFLECTION_THINKING_SAFETY_BOUNDARY_VERSION,
      usedPersonalContext: sources.length > 0,
      sources,
      personalContextClaims: output.personalContextClaims,
      interpretations: output.interpretations,
      hypotheses: output.hypotheses,
      model: this.dependencies.provider.model,
      createdAt: this.nowIso(),
      completionStatus: output.completionStatus
      };
      if (active) await this.dependencies.store.writeConversation(DailyReflectionThinkingConversationSchema.parse({ ...latest,
        messages: [...latest.messages.map(message => message.id === userMessage.id ? { ...message, sources, usedPersonalContext: sources.length > 0 } : message), assistant].slice(-100), updatedAt: assistant.createdAt }));
      return assistant;
    });
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
    return this.projectResponse(accountId, response, request);
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

import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { JsonStore } from "@/lib/server/storage/json-store";

export const VOICE_SESSION_COLLECTION = "voice-sessions";

export const VOICE_SESSION_STATES = [
  "CREATED",
  "LISTENING",
  "PROCESSING",
  "RESPONDING",
  "IDLE",
  "CLOSED"
] as const;

export const VoiceSessionStateSchema = z.enum(VOICE_SESSION_STATES);

export type VoiceSessionState = z.infer<typeof VoiceSessionStateSchema>;

const SessionIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);

const SessionUserIdentifierSchema = z.string().trim().min(1).max(256);
const SessionTextSchema = z.string().trim().min(1).max(1_200);
const SessionTopicSchema = z.string().trim().min(1).max(200);
const RetrievedMemoryIdentifierSchema = z.string().trim().min(1).max(256);

export const VoiceSessionConversationMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: SessionTextSchema
}).strict();

export type VoiceSessionConversationMessage = z.infer<
  typeof VoiceSessionConversationMessageSchema
>;

export const VoiceSessionSchema = z.object({
  version: z.literal(1),
  sessionId: SessionIdentifierSchema,
  userId: SessionUserIdentifierSchema.optional(),
  createdAt: z.string().datetime(),
  lastActivityAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  recentTranscript: z.array(SessionTextSchema).max(100),
  conversationContext: z.array(VoiceSessionConversationMessageSchema).max(100),
  retrievedMemoryIds: z.array(RetrievedMemoryIdentifierSchema).max(1_000),
  currentTopic: SessionTopicSchema.optional(),
  activeTraceId: SessionIdentifierSchema.optional(),
  state: VoiceSessionStateSchema
}).strict().superRefine((session, context) => {
  const createdAt = Date.parse(session.createdAt);
  const lastActivityAt = Date.parse(session.lastActivityAt);
  const expiresAt = Date.parse(session.expiresAt);
  if (lastActivityAt < createdAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lastActivityAt"],
      message: "lastActivityAt must not precede createdAt"
    });
  }
  if (expiresAt <= lastActivityAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "expiresAt must follow lastActivityAt"
    });
  }
});

export type VoiceSession = z.infer<typeof VoiceSessionSchema>;

export const DEFAULT_VOICE_SESSION_TTL_MS = 30 * 60 * 1_000;
export const DEFAULT_VOICE_SESSION_RECENT_TRANSCRIPT_LIMIT = 8;
export const DEFAULT_VOICE_SESSION_CONTEXT_LIMIT = 8;
export const DEFAULT_VOICE_SESSION_MEMORY_ID_LIMIT = 64;

const MAX_VOICE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

const LEGAL_TRANSITIONS: Readonly<Record<VoiceSessionState, readonly VoiceSessionState[]>> = {
  CREATED: ["LISTENING", "PROCESSING", "IDLE", "CLOSED"],
  LISTENING: ["PROCESSING", "IDLE", "CLOSED"],
  PROCESSING: ["RESPONDING", "IDLE", "CLOSED"],
  RESPONDING: ["IDLE", "CLOSED"],
  IDLE: ["LISTENING", "PROCESSING", "CLOSED"],
  CLOSED: []
};

type VoiceSessionClock = () => Date;

export type VoiceSessionManagerOptions = {
  store: JsonStore;
  ttlMs?: number;
  recentTranscriptLimit?: number;
  conversationContextLimit?: number;
  retrievedMemoryIdLimit?: number;
  now?: VoiceSessionClock;
};

export type CreateVoiceSessionInput = {
  sessionId?: string;
  userId?: string;
  initialState?: VoiceSessionState;
};

export type UpdateVoiceSessionInput = {
  state?: VoiceSessionState;
  recentTranscript?: string[];
  conversationContext?: VoiceSessionConversationMessage[];
  retrievedMemoryIds?: string[];
  currentTopic?: string | null;
};

export type AppendVoiceSessionTurnInput = {
  transcript: string;
  response?: string;
  retrievedMemoryIds?: string[];
  currentTopic?: string | null;
};

export type VoiceSessionCleanupResult = {
  scanned: number;
  removed: number;
  invalid: number;
  removedSessionIds: string[];
};

export class VoiceSessionAlreadyExistsError extends Error {
  constructor(readonly sessionId: string) {
    super("Voice session already exists");
    this.name = "VoiceSessionAlreadyExistsError";
  }
}

export class VoiceSessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super("Voice session was not found");
    this.name = "VoiceSessionNotFoundError";
  }
}

export class VoiceSessionExpiredError extends Error {
  constructor(readonly sessionId: string) {
    super("Voice session has expired");
    this.name = "VoiceSessionExpiredError";
  }
}

export class VoiceSessionAccessError extends Error {
  constructor(readonly sessionId: string) {
    super("Voice session does not belong to the requested user");
    this.name = "VoiceSessionAccessError";
  }
}

export class VoiceSessionClosedError extends Error {
  constructor(readonly sessionId: string) {
    super("Voice session is closed");
    this.name = "VoiceSessionClosedError";
  }
}

export class VoiceSessionTransitionError extends Error {
  constructor(
    readonly from: VoiceSessionState,
    readonly to: VoiceSessionState
  ) {
    super(`Illegal managed voice session transition: ${from} -> ${to}`);
    this.name = "VoiceSessionTransitionError";
  }
}

// JsonStore atomically replaces a record, but a complete read-modify-write
// needs a wider lock. This queue protects concurrent updates made by manager
// instances in the same Node.js process.
const sessionUpdateQueues = new Map<string, Promise<void>>();

async function serializeSessionOperation<T>(
  sessionId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = sessionUpdateQueues.get(sessionId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const barrier = run.then(() => undefined, () => undefined);
  sessionUpdateQueues.set(sessionId, barrier);
  try {
    return await run;
  } finally {
    if (sessionUpdateQueues.get(sessionId) === barrier) {
      sessionUpdateQueues.delete(sessionId);
    }
  }
}

function requirePositiveInteger(value: number, field: string, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${field} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function safeNow(clock: VoiceSessionClock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("Voice session clock must return a valid Date");
  }
  return value;
}

function uniqueRecent(values: string[], limit: number) {
  const normalized = values.map((value) => RetrievedMemoryIdentifierSchema.parse(value));
  const seen = new Set<string>();
  const result: string[] = [];
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const value = normalized[index];
    if (!seen.has(value)) {
      seen.add(value);
      result.unshift(value);
    }
  }
  return result.slice(-limit);
}

function assertOwner(session: VoiceSession, requestedUserId: string | undefined) {
  const normalizedRequested = requestedUserId === undefined
    ? undefined
    : SessionUserIdentifierSchema.parse(requestedUserId);
  if (session.userId !== normalizedRequested) {
    throw new VoiceSessionAccessError(session.sessionId);
  }
}

function isTransitionAllowed(from: VoiceSessionState, to: VoiceSessionState) {
  return from === to || LEGAL_TRANSITIONS[from].includes(to);
}

export class VoiceSessionManager {
  private readonly store: JsonStore;
  private readonly ttlMs: number;
  private readonly recentTranscriptLimit: number;
  private readonly conversationContextLimit: number;
  private readonly retrievedMemoryIdLimit: number;
  private readonly now: VoiceSessionClock;

  constructor(options: VoiceSessionManagerOptions) {
    this.store = options.store;
    this.ttlMs = requirePositiveInteger(
      options.ttlMs ?? DEFAULT_VOICE_SESSION_TTL_MS,
      "Voice session TTL",
      MAX_VOICE_SESSION_TTL_MS
    );
    this.recentTranscriptLimit = requirePositiveInteger(
      options.recentTranscriptLimit ?? DEFAULT_VOICE_SESSION_RECENT_TRANSCRIPT_LIMIT,
      "Voice session recent transcript limit",
      100
    );
    this.conversationContextLimit = requirePositiveInteger(
      options.conversationContextLimit ?? DEFAULT_VOICE_SESSION_CONTEXT_LIMIT,
      "Voice session conversation context limit",
      100
    );
    if (this.conversationContextLimit < 2) {
      throw new Error("Voice session conversation context limit must be at least 2");
    }
    this.retrievedMemoryIdLimit = requirePositiveInteger(
      options.retrievedMemoryIdLimit ?? DEFAULT_VOICE_SESSION_MEMORY_ID_LIMIT,
      "Voice session retrieved memory id limit",
      1_000
    );
    this.now = options.now ?? (() => new Date());
  }

  async create(input: CreateVoiceSessionInput = {}): Promise<VoiceSession> {
    const sessionId = SessionIdentifierSchema.parse(input.sessionId ?? randomUUID());
    const userId = input.userId === undefined
      ? undefined
      : SessionUserIdentifierSchema.parse(input.userId);
    const initialState = VoiceSessionStateSchema.parse(input.initialState ?? "CREATED");
    if (!["CREATED", "IDLE"].includes(initialState)) {
      throw new VoiceSessionTransitionError("CREATED", initialState);
    }

    return serializeSessionOperation(sessionId, async () => {
      if (await this.store.read<unknown>(VOICE_SESSION_COLLECTION, sessionId)) {
        throw new VoiceSessionAlreadyExistsError(sessionId);
      }
      const now = safeNow(this.now);
      const session = VoiceSessionSchema.parse({
        version: 1,
        sessionId,
        ...(userId ? { userId } : {}),
        createdAt: now.toISOString(),
        lastActivityAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
        recentTranscript: [],
        conversationContext: [],
        retrievedMemoryIds: [],
        state: initialState
      });
      await this.store.write(VOICE_SESSION_COLLECTION, sessionId, session);
      return session;
    });
  }

  async lookup(sessionId: string, userId?: string): Promise<VoiceSession | null> {
    const id = SessionIdentifierSchema.parse(sessionId);
    const stored = await this.store.read<unknown>(VOICE_SESSION_COLLECTION, id);
    if (stored === null) return null;
    const session = VoiceSessionSchema.parse(stored);
    assertOwner(session, userId);
    if (this.isExpired(session)) return null;
    return VoiceSessionSchema.parse(session);
  }

  async update(
    sessionId: string,
    input: UpdateVoiceSessionInput,
    userId?: string
  ): Promise<VoiceSession> {
    return this.mutate(sessionId, userId, (session) => {
      const nextState = input.state === undefined
        ? session.state
        : VoiceSessionStateSchema.parse(input.state);
      if (!isTransitionAllowed(session.state, nextState)) {
        throw new VoiceSessionTransitionError(session.state, nextState);
      }

      const recentTranscript = input.recentTranscript === undefined
        ? session.recentTranscript
        : input.recentTranscript
          .map((entry) => SessionTextSchema.parse(entry))
          .slice(-this.recentTranscriptLimit);
      const conversationContext = input.conversationContext === undefined
        ? session.conversationContext
        : input.conversationContext
          .map((entry) => VoiceSessionConversationMessageSchema.parse(entry))
          .slice(-this.conversationContextLimit);
      const retrievedMemoryIds = input.retrievedMemoryIds === undefined
        ? session.retrievedMemoryIds
        : uniqueRecent(input.retrievedMemoryIds, this.retrievedMemoryIdLimit);

      const next: VoiceSession = {
        ...session,
        state: nextState,
        recentTranscript,
        conversationContext,
        retrievedMemoryIds
      };
      if (nextState === "IDLE" || nextState === "CLOSED") {
        delete next.activeTraceId;
      }
      if (input.currentTopic === null) {
        delete next.currentTopic;
      } else if (input.currentTopic !== undefined) {
        next.currentTopic = SessionTopicSchema.parse(input.currentTopic);
      }
      return next;
    });
  }

  transition(sessionId: string, state: VoiceSessionState, userId?: string) {
    return this.update(sessionId, { state }, userId);
  }

  transitionTurn(
    sessionId: string,
    traceId: string,
    state: VoiceSessionState,
    userId?: string
  ) {
    const validatedTraceId = SessionIdentifierSchema.parse(traceId);
    const nextState = VoiceSessionStateSchema.parse(state);
    return this.mutate(sessionId, userId, (session) => {
      if (session.activeTraceId !== validatedTraceId) return session;
      if (!isTransitionAllowed(session.state, nextState)) {
        throw new VoiceSessionTransitionError(session.state, nextState);
      }
      const next: VoiceSession = { ...session, state: nextState };
      if (nextState === "IDLE" || nextState === "CLOSED") {
        delete next.activeTraceId;
      }
      return next;
    });
  }

  /**
   * Atomically claims a persisted session for one push-to-talk turn.
   *
   * A plain lookup followed by transition is racy: two HTTP requests can both
   * observe IDLE before either writes LISTENING. Keeping the expected-state
   * check inside the serialized read-modify-write makes the second request fail
   * closed instead of running two QA turns against the same context.
   */
  claimTurn(sessionId: string, userId?: string): Promise<VoiceSession> {
    return this.mutate(sessionId, userId, (session) => {
      if (session.state !== "CREATED" && session.state !== "IDLE") {
        throw new VoiceSessionTransitionError(session.state, "LISTENING");
      }
      const claimed = { ...session, state: "LISTENING" as const };
      delete claimed.activeTraceId;
      return claimed;
    });
  }

  attachTrace(sessionId: string, traceId: string, userId?: string): Promise<VoiceSession> {
    const validatedTraceId = SessionIdentifierSchema.parse(traceId);
    return this.mutate(sessionId, userId, (session) => {
      if (session.state !== "LISTENING") {
        throw new VoiceSessionTransitionError(session.state, "LISTENING");
      }
      if (session.activeTraceId && session.activeTraceId !== validatedTraceId) {
        throw new Error("Voice session already belongs to another active trace");
      }
      return { ...session, activeTraceId: validatedTraceId };
    });
  }

  async releaseTurn(sessionId: string, traceId: string, userId?: string): Promise<VoiceSession> {
    const id = SessionIdentifierSchema.parse(sessionId);
    const validatedTraceId = SessionIdentifierSchema.parse(traceId);
    return serializeSessionOperation(id, async () => {
      const session = await this.readRequired(id);
      assertOwner(session, userId);
      if (this.isExpired(session)) throw new VoiceSessionExpiredError(id);
      if (session.state === "CLOSED" || session.activeTraceId !== validatedTraceId) {
        return session;
      }
      const now = this.activityTime(session);
      const released: VoiceSession = {
        ...session,
        state: "IDLE",
        lastActivityAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.ttlMs).toISOString()
      };
      delete released.activeTraceId;
      const validated = VoiceSessionSchema.parse(released);
      await this.store.write(VOICE_SESSION_COLLECTION, id, validated);
      return validated;
    });
  }

  async appendTurn(
    sessionId: string,
    input: AppendVoiceSessionTurnInput,
    userId?: string
  ): Promise<VoiceSession> {
    const transcript = SessionTextSchema.parse(input.transcript);
    const response = input.response === undefined
      ? undefined
      : SessionTextSchema.parse(input.response);
    const memoryIds = input.retrievedMemoryIds?.map((id) =>
      RetrievedMemoryIdentifierSchema.parse(id)
    ) ?? [];

    return this.mutate(sessionId, userId, (session) => {
      const conversationContext = [
        ...session.conversationContext,
        { role: "user" as const, content: transcript },
        ...(response ? [{ role: "assistant" as const, content: response }] : [])
      ].slice(-this.conversationContextLimit);
      const recentTranscript = [...session.recentTranscript, transcript]
        .slice(-this.recentTranscriptLimit);
      const retrievedMemoryIds = uniqueRecent(
        [...session.retrievedMemoryIds, ...memoryIds],
        this.retrievedMemoryIdLimit
      );
      const next: VoiceSession = {
        ...session,
        recentTranscript,
        conversationContext,
        retrievedMemoryIds
      };
      if (input.currentTopic === null) {
        delete next.currentTopic;
      } else if (input.currentTopic !== undefined) {
        next.currentTopic = SessionTopicSchema.parse(input.currentTopic);
      }
      return next;
    });
  }

  touch(sessionId: string, userId?: string) {
    return this.mutate(sessionId, userId, (session) => session);
  }

  async close(sessionId: string, userId?: string): Promise<VoiceSession> {
    const id = SessionIdentifierSchema.parse(sessionId);
    return serializeSessionOperation(id, async () => {
      const session = await this.readRequired(id);
      assertOwner(session, userId);
      if (this.isExpired(session)) throw new VoiceSessionExpiredError(id);
      if (session.state === "CLOSED") return session;
      const now = this.activityTime(session);
      const closedCandidate: VoiceSession = {
        ...session,
        state: "CLOSED",
        lastActivityAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.ttlMs).toISOString()
      };
      delete closedCandidate.activeTraceId;
      const closed = VoiceSessionSchema.parse(closedCandidate);
      await this.store.write(VOICE_SESSION_COLLECTION, id, closed);
      return closed;
    });
  }

  async cleanupExpired(): Promise<VoiceSessionCleanupResult> {
    const entries = await this.store.list<unknown>(VOICE_SESSION_COLLECTION);
    const result: VoiceSessionCleanupResult = {
      scanned: entries.length,
      removed: 0,
      invalid: 0,
      removedSessionIds: []
    };

    for (const entry of entries) {
      const parsed = VoiceSessionSchema.safeParse(entry.value);
      if (!parsed.success) {
        result.invalid += 1;
        continue;
      }
      if (!this.isExpired(parsed.data)) continue;

      await serializeSessionOperation(entry.id, async () => {
        const latestValue = await this.store.read<unknown>(VOICE_SESSION_COLLECTION, entry.id);
        const latest = VoiceSessionSchema.safeParse(latestValue);
        if (!latest.success || !this.isExpired(latest.data)) return;
        await this.store.delete(VOICE_SESSION_COLLECTION, entry.id);
        result.removed += 1;
        result.removedSessionIds.push(entry.id);
      });
    }

    return result;
  }

  isExpired(session: VoiceSession, at: Date = safeNow(this.now)) {
    const checkedAt = at instanceof Date && !Number.isNaN(at.getTime())
      ? at
      : safeNow(() => at);
    return Date.parse(session.expiresAt) <= checkedAt.getTime();
  }

  private async mutate(
    sessionId: string,
    userId: string | undefined,
    mutation: (session: VoiceSession) => VoiceSession
  ) {
    const id = SessionIdentifierSchema.parse(sessionId);
    return serializeSessionOperation(id, async () => {
      const session = await this.readRequired(id);
      assertOwner(session, userId);
      if (this.isExpired(session)) throw new VoiceSessionExpiredError(id);
      if (session.state === "CLOSED") throw new VoiceSessionClosedError(id);

      const now = this.activityTime(session);
      const updated = VoiceSessionSchema.parse({
        ...mutation(session),
        lastActivityAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.ttlMs).toISOString()
      });
      await this.store.write(VOICE_SESSION_COLLECTION, id, updated);
      return updated;
    });
  }

  private async readRequired(sessionId: string) {
    const value = await this.store.read<unknown>(VOICE_SESSION_COLLECTION, sessionId);
    if (value === null) throw new VoiceSessionNotFoundError(sessionId);
    return VoiceSessionSchema.parse(value);
  }

  private activityTime(session: VoiceSession) {
    const clockTime = safeNow(this.now);
    const lastActivity = Date.parse(session.lastActivityAt);
    return clockTime.getTime() >= lastActivity ? clockTime : new Date(lastActivity);
  }
}

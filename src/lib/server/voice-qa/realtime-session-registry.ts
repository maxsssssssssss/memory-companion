import { randomUUID } from "node:crypto";

import type { VoiceQaContext } from "@/lib/domain/voice-qa-context";
import type { QaLlmProviderId } from "@/lib/server/retrieval/qa-llm-provider";
import type { JsonStore } from "@/lib/server/storage/json-store";
import { createVoiceProvider } from "@/lib/server/voice/provider";

import {
  createMemoryVoiceQaAnswerer,
  type MemoryVoiceQaScope
} from "./adapter";
import {
  RealtimeVoiceQaController,
  type RealtimeVoiceQaEvent
} from "./realtime-controller";
import type { VoiceQaConversationMessage } from "./types";

const DEFAULT_REALTIME_SESSION_TTL_MS = 10 * 60_000;
const MAX_REALTIME_SESSIONS = 32;
const MAX_REALTIME_SESSIONS_PER_USER = 2;
const MAX_BUFFERED_EVENTS = 128;

export class RealtimeVoiceQaSessionError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "session_limit"
      | "subscriber_exists"
      | "disabled"
  ) {
    super(`Realtime Voice QA session ${code}`);
    this.name = "RealtimeVoiceQaSessionError";
  }
}

export type CreateRealtimeVoiceQaSessionInput = {
  userId: string;
  store: JsonStore;
  scope: MemoryVoiceQaScope;
  uploadId?: string;
  referenceDate?: Date;
  context?: VoiceQaContext;
  conversation?: readonly VoiceQaConversationMessage[];
  llmProviderId?: QaLlmProviderId;
};

type RealtimeVoiceQaSessionRecord = {
  id: string;
  userId: string;
  controller: RealtimeVoiceQaController;
  createdAt: number;
  lastActivityAt: number;
  bufferedEvents: RealtimeVoiceQaEvent[];
  subscriber?: (event: RealtimeVoiceQaEvent) => unknown;
  closed: boolean;
};

function realtimeEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env
) {
  return environment.VOICE_REALTIME_ENABLED?.trim().toLowerCase() === "true";
}

function safeClose(record: RealtimeVoiceQaSessionRecord) {
  if (record.closed) return;
  record.closed = true;
  void record.controller.close().catch(() => undefined);
}

export class RealtimeVoiceQaSessionRegistry {
  private readonly records = new Map<string, RealtimeVoiceQaSessionRecord>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_REALTIME_SESSION_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  async create(
    input: CreateRealtimeVoiceQaSessionInput,
    environment: Readonly<Record<string, string | undefined>> = process.env
  ) {
    if (!realtimeEnabled(environment)) {
      throw new RealtimeVoiceQaSessionError("disabled");
    }
    this.cleanupExpired();
    if (this.records.size >= MAX_REALTIME_SESSIONS) {
      throw new RealtimeVoiceQaSessionError("session_limit");
    }
    const userSessionCount = [...this.records.values()]
      .filter((record) => record.userId === input.userId && !record.closed)
      .length;
    if (userSessionCount >= MAX_REALTIME_SESSIONS_PER_USER) {
      throw new RealtimeVoiceQaSessionError("session_limit");
    }

    const id = randomUUID();
    const provider = createVoiceProvider(environment);
    const answerer = createMemoryVoiceQaAnswerer({
      userId: input.userId,
      store: input.store,
      scope: input.scope,
      ...(input.uploadId ? { uploadId: input.uploadId } : {}),
      ...(input.referenceDate ? { referenceDate: input.referenceDate } : {}),
      ...(input.context ? { context: input.context } : {}),
      ...(input.llmProviderId ? { llmProviderId: input.llmProviderId } : {})
    });
    const controller = new RealtimeVoiceQaController({
      provider,
      answerer,
      ...(input.conversation ? { conversation: input.conversation } : {})
    });
    const now = Date.now();
    const record: RealtimeVoiceQaSessionRecord = {
      id,
      userId: input.userId,
      controller,
      createdAt: now,
      lastActivityAt: now,
      bufferedEvents: [],
      closed: false
    };
    controller.onEvent((event) => {
      record.lastActivityAt = Date.now();
      if (record.subscriber) {
        record.subscriber(event);
        return;
      }
      record.bufferedEvents.push(event);
      if (record.bufferedEvents.length > MAX_BUFFERED_EVENTS) {
        record.bufferedEvents.splice(
          0,
          record.bufferedEvents.length - MAX_BUFFERED_EVENTS
        );
      }
    });
    this.records.set(id, record);
    try {
      await controller.start();
      return {
        sessionId: id,
        createdAt: new Date(now).toISOString()
      };
    } catch (error) {
      this.records.delete(id);
      safeClose(record);
      throw error;
    }
  }

  subscribe(
    sessionId: string,
    userId: string,
    listener: (event: RealtimeVoiceQaEvent) => unknown
  ) {
    const record = this.requireOwned(sessionId, userId);
    if (record.subscriber) {
      throw new RealtimeVoiceQaSessionError("subscriber_exists");
    }
    record.subscriber = listener;
    record.lastActivityAt = Date.now();
    for (const event of record.bufferedEvents.splice(0)) listener(event);
    return () => {
      if (record.subscriber === listener) record.subscriber = undefined;
    };
  }

  async sendAudio(sessionId: string, userId: string, chunk: Buffer) {
    const record = this.requireOwned(sessionId, userId);
    record.lastActivityAt = Date.now();
    await record.controller.sendAudio(chunk);
  }

  async startClientTurn(sessionId: string, userId: string) {
    const record = this.requireOwned(sessionId, userId);
    record.lastActivityAt = Date.now();
    await record.controller.startClientTurn();
  }

  async cancelSessionTurn(
    sessionId: string,
    userId: string,
    expectedTurnSequence?: number
  ) {
    const record = this.requireOwned(sessionId, userId);
    record.lastActivityAt = Date.now();
    return expectedTurnSequence === undefined
      ? await record.controller.cancelSessionTurn("barge_in")
      : await record.controller.cancelSessionTurn(
          "barge_in",
          expectedTurnSequence
        );
  }

  async keepAlive(sessionId: string, userId: string) {
    const record = this.requireOwned(sessionId, userId);
    record.lastActivityAt = Date.now();
  }

  async truncatePlayback(
    sessionId: string,
    userId: string,
    turnSequence: number,
    providerItemId: string,
    audioEndMs: number
  ) {
    const record = this.requireOwned(sessionId, userId);
    record.lastActivityAt = Date.now();
    return record.controller.truncatePlayback(
      turnSequence,
      providerItemId,
      audioEndMs
    );
  }

  async markBrowserPlaybackStarted(
    sessionId: string,
    userId: string,
    turnSequence: number
  ) {
    const record = this.requireOwned(sessionId, userId);
    record.lastActivityAt = Date.now();
    return record.controller.markBrowserPlaybackStarted(turnSequence);
  }

  async close(sessionId: string, userId: string) {
    const record = this.requireOwned(sessionId, userId);
    this.records.delete(sessionId);
    record.closed = true;
    await record.controller.close().catch(() => undefined);
  }

  has(sessionId: string, userId: string) {
    try {
      this.requireOwned(sessionId, userId);
      return true;
    } catch {
      return false;
    }
  }

  private requireOwned(sessionId: string, userId: string) {
    const record = this.records.get(sessionId);
    if (!record || record.closed || record.userId !== userId) {
      throw new RealtimeVoiceQaSessionError("not_found");
    }
    if (Date.now() - record.lastActivityAt > this.ttlMs) {
      this.records.delete(sessionId);
      safeClose(record);
      throw new RealtimeVoiceQaSessionError("not_found");
    }
    return record;
  }

  private cleanupExpired() {
    const now = Date.now();
    for (const [id, record] of this.records) {
      if (record.closed || now - record.lastActivityAt > this.ttlMs) {
        this.records.delete(id);
        safeClose(record);
      }
    }
  }
}

type RealtimeVoiceQaGlobal = typeof globalThis & {
  __dailyBriefRealtimeVoiceQaSessions?: RealtimeVoiceQaSessionRegistry;
};

const realtimeVoiceGlobal = globalThis as RealtimeVoiceQaGlobal;

export const realtimeVoiceQaSessions =
  realtimeVoiceGlobal.__dailyBriefRealtimeVoiceQaSessions ??=
    new RealtimeVoiceQaSessionRegistry();

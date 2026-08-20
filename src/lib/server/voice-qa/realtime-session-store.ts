import { randomUUID } from "node:crypto";

const DEFAULT_SESSION_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_MAX_SESSIONS_PER_USER = 2;
const DEFAULT_MAX_REPLAY_FRAMES = 256;
const DEFAULT_MAX_REPLAY_BYTES = 2 * 1024 * 1024;

export type RealtimeVoiceSessionScope = "current" | "week" | "all";

export type RealtimeVoiceSessionStatus =
  | "created"
  | "connecting"
  | "listening"
  | "processing"
  | "speaking"
  | "reconnecting"
  | "closed";

export type RealtimeVoiceTransportState = "disconnected" | "connected";

/**
 * Content-free state needed to resume a realtime transport session.
 *
 * Transcripts, answers, evidence and conversation content deliberately do not
 * belong here. They remain owned by the canonical Voice QA pipeline.
 */
export type RealtimeVoiceSession = {
  version: 1;
  sessionId: string;
  userId: string;
  scope: RealtimeVoiceSessionScope;
  uploadId?: string;
  referenceDate?: string;
  status: RealtimeVoiceSessionStatus;
  transportState: RealtimeVoiceTransportState;
  providerSessionId?: string;
  activeTurnSequence?: number;
  connectionEpoch: number;
  connectionId?: string;
  audioEpoch: number;
  audioAckSequence: number;
  outboundAckSequence: number;
  nextOutboundSequence: number;
  outboundReplayFloorSequence: number;
  outboundReplayBytes: number;
  eventCursor: number;
  createdAtMs: number;
  updatedAtMs: number;
  lastClientActivityAtMs: number;
  expiresAtMs: number;
  timestamps: Readonly<Record<string, number>>;
};

export type RealtimeVoiceConnectionFence = {
  sessionId: string;
  userId: string;
  connectionId: string;
  connectionEpoch: number;
};

export type RealtimeVoiceOutboundFrameKind = "control" | "audio";

export type RealtimeVoiceOutboundFrame = {
  sequence: number;
  kind: RealtimeVoiceOutboundFrameKind;
  data: string | Uint8Array;
  byteLength: number;
  createdAtMs: number;
};

export type CreateRealtimeVoiceSessionInput = {
  sessionId?: string;
  userId: string;
  scope: RealtimeVoiceSessionScope;
  uploadId?: string;
  referenceDate?: string;
  status?: RealtimeVoiceSessionStatus;
  timestamps?: Readonly<Record<string, number>>;
};

export type ClaimRealtimeVoiceConnectionInput = {
  sessionId: string;
  userId: string;
  connectionId: string;
  /** Required to fence an already-active connection owned by another socket. */
  expectedConnectionEpoch?: number;
};

export type ClaimRealtimeVoiceConnectionResult = {
  session: RealtimeVoiceSession;
  fence: RealtimeVoiceConnectionFence;
  claim: "new" | "resumed" | "replaced";
  replacedConnectionId?: string;
};

export type AcknowledgeRealtimeVoiceAudioInput = {
  audioEpoch: number;
  sequence: number;
};

export type RealtimeVoiceAudioAckResult = {
  status: "accepted" | "duplicate" | "gap" | "epoch_mismatch";
  audioEpoch: number;
  acceptedThrough: number;
  expectedSequence: number;
};

export type AppendRealtimeVoiceOutboundFrameInput = {
  kind: RealtimeVoiceOutboundFrameKind;
  data: string | Uint8Array;
};

export type ReplayRealtimeVoiceOutboundResult =
  | {
      status: "ok";
      availableAfter: number;
      latestSequence: number;
      frames: RealtimeVoiceOutboundFrame[];
    }
  | {
      status: "too_old";
      availableAfter: number;
      latestSequence: number;
      frames: [];
    };

export type RealtimeVoiceOutboundAckResult = {
  status: "advanced" | "duplicate";
  acknowledgedThrough: number;
};

export type PatchRealtimeVoiceSessionInput = {
  status?: RealtimeVoiceSessionStatus;
  providerSessionId?: string | null;
  activeTurnSequence?: number | null;
  /** Increasing the epoch starts a fresh input stream and resets audio ACK. */
  audioEpoch?: number;
  eventCursor?: number;
  timestamps?: Readonly<Record<string, number>>;
};

export type MemoryRealtimeVoiceSessionStoreOptions = {
  clock?: () => number;
  idFactory?: () => string;
  ttlMs?: number;
  maxSessions?: number;
  maxSessionsPerUser?: number;
  maxReplayFrames?: number;
  maxReplayBytes?: number;
};

export type RealtimeVoiceSessionStoreErrorCode =
  | "invalid_input"
  | "not_found"
  | "owner_mismatch"
  | "session_limit"
  | "connection_conflict"
  | "stale_connection"
  | "frame_too_large"
  | "cursor_ahead";

export class RealtimeVoiceSessionStoreError extends Error {
  constructor(
    readonly code: RealtimeVoiceSessionStoreErrorCode,
    message = `Realtime voice session store ${code}`,
    readonly details?: Readonly<Record<string, number | string>>
  ) {
    super(message);
    this.name = "RealtimeVoiceSessionStoreError";
  }
}

export interface SessionStore {
  create(input: CreateRealtimeVoiceSessionInput): Promise<RealtimeVoiceSession>;
  get(sessionId: string, userId: string): Promise<RealtimeVoiceSession | undefined>;
  claimConnection(
    input: ClaimRealtimeVoiceConnectionInput
  ): Promise<ClaimRealtimeVoiceConnectionResult>;
  releaseConnection(
    fence: RealtimeVoiceConnectionFence
  ): Promise<RealtimeVoiceSession>;
  acknowledgeAudio(
    fence: RealtimeVoiceConnectionFence,
    input: AcknowledgeRealtimeVoiceAudioInput
  ): Promise<RealtimeVoiceAudioAckResult>;
  appendOutboundFrame(
    fence: RealtimeVoiceConnectionFence,
    input: AppendRealtimeVoiceOutboundFrameInput
  ): Promise<RealtimeVoiceOutboundFrame>;
  replayOutbound(
    fence: RealtimeVoiceConnectionFence,
    afterSequence: number
  ): Promise<ReplayRealtimeVoiceOutboundResult>;
  acknowledgeOutbound(
    fence: RealtimeVoiceConnectionFence,
    throughSequence: number
  ): Promise<RealtimeVoiceOutboundAckResult>;
  /** Extends the soft session TTL after an authenticated client heartbeat. */
  keepAlive(fence: RealtimeVoiceConnectionFence): Promise<RealtimeVoiceSession>;
  patchState(
    fence: RealtimeVoiceConnectionFence,
    patch: PatchRealtimeVoiceSessionInput
  ): Promise<RealtimeVoiceSession>;
  delete(sessionId: string, userId: string): Promise<boolean>;
  expire(nowMs?: number): Promise<string[]>;
}

type SessionRecord = {
  session: RealtimeVoiceSession;
  outboundFrames: RealtimeVoiceOutboundFrame[];
};

function cloneData(data: string | Uint8Array) {
  return typeof data === "string" ? data : data.slice();
}

function byteLength(data: string | Uint8Array) {
  return typeof data === "string"
    ? new TextEncoder().encode(data).byteLength
    : data.byteLength;
}

function cloneFrame(frame: RealtimeVoiceOutboundFrame): RealtimeVoiceOutboundFrame {
  return { ...frame, data: cloneData(frame.data) };
}

function cloneSession(session: RealtimeVoiceSession): RealtimeVoiceSession {
  return { ...session, timestamps: { ...session.timestamps } };
}

function requireNonEmptyString(value: string, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new RealtimeVoiceSessionStoreError(
      "invalid_input",
      `${field} must be a non-empty string`
    );
  }
}

function requireNonNegativeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RealtimeVoiceSessionStoreError(
      "invalid_input",
      `${field} must be a non-negative safe integer`
    );
  }
}

function requirePositiveInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RealtimeVoiceSessionStoreError(
      "invalid_input",
      `${field} must be a positive safe integer`
    );
  }
}

function validateTimestamps(timestamps: Readonly<Record<string, number>>) {
  for (const [name, value] of Object.entries(timestamps)) {
    requireNonEmptyString(name, "timestamp name");
    if (!Number.isFinite(value) || value < 0) {
      throw new RealtimeVoiceSessionStoreError(
        "invalid_input",
        `timestamp ${name} must be a finite non-negative number`
      );
    }
  }
}

/**
 * Process-local adapter used by mocks and the first gateway implementation.
 * Its async API intentionally matches a future durable/Redis adapter.
 */
export class MemoryRealtimeVoiceSessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly maxSessionsPerUser: number;
  private readonly maxReplayFrames: number;
  private readonly maxReplayBytes: number;

  constructor(options: MemoryRealtimeVoiceSessionStoreOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxSessionsPerUser =
      options.maxSessionsPerUser ?? DEFAULT_MAX_SESSIONS_PER_USER;
    this.maxReplayFrames =
      options.maxReplayFrames ?? DEFAULT_MAX_REPLAY_FRAMES;
    this.maxReplayBytes = options.maxReplayBytes ?? DEFAULT_MAX_REPLAY_BYTES;

    requirePositiveInteger(this.ttlMs, "ttlMs");
    requirePositiveInteger(this.maxSessions, "maxSessions");
    requirePositiveInteger(this.maxSessionsPerUser, "maxSessionsPerUser");
    requirePositiveInteger(this.maxReplayFrames, "maxReplayFrames");
    requirePositiveInteger(this.maxReplayBytes, "maxReplayBytes");
  }

  async create(input: CreateRealtimeVoiceSessionInput) {
    requireNonEmptyString(input.userId, "userId");
    if (input.uploadId !== undefined) {
      requireNonEmptyString(input.uploadId, "uploadId");
    }
    if (input.referenceDate !== undefined) {
      requireNonEmptyString(input.referenceDate, "referenceDate");
    }
    validateTimestamps(input.timestamps ?? {});
    if (this.records.size >= this.maxSessions) {
      throw new RealtimeVoiceSessionStoreError("session_limit");
    }
    const ownedCount = [...this.records.values()].filter(
      ({ session }) => session.userId === input.userId
    ).length;
    if (ownedCount >= this.maxSessionsPerUser) {
      throw new RealtimeVoiceSessionStoreError("session_limit");
    }

    const sessionId = input.sessionId ?? this.idFactory();
    requireNonEmptyString(sessionId, "sessionId");
    if (this.records.has(sessionId)) {
      throw new RealtimeVoiceSessionStoreError(
        "invalid_input",
        "sessionId already exists"
      );
    }

    const now = this.clock();
    const session: RealtimeVoiceSession = {
      version: 1,
      sessionId,
      userId: input.userId,
      scope: input.scope,
      ...(input.uploadId ? { uploadId: input.uploadId } : {}),
      ...(input.referenceDate ? { referenceDate: input.referenceDate } : {}),
      status: input.status ?? "created",
      transportState: "disconnected",
      connectionEpoch: 0,
      audioEpoch: 1,
      audioAckSequence: 0,
      outboundAckSequence: 0,
      nextOutboundSequence: 1,
      outboundReplayFloorSequence: 0,
      outboundReplayBytes: 0,
      eventCursor: 0,
      createdAtMs: now,
      updatedAtMs: now,
      lastClientActivityAtMs: now,
      expiresAtMs: now + this.ttlMs,
      timestamps: { ...(input.timestamps ?? {}) }
    };
    this.records.set(sessionId, { session, outboundFrames: [] });
    return cloneSession(session);
  }

  async get(sessionId: string, userId: string) {
    const record = this.findOwned(sessionId, userId);
    return record ? cloneSession(record.session) : undefined;
  }

  async claimConnection(input: ClaimRealtimeVoiceConnectionInput) {
    requireNonEmptyString(input.connectionId, "connectionId");
    const record = this.requireOwned(input.sessionId, input.userId);
    const { session } = record;

    if (session.connectionId === input.connectionId) {
      this.touch(record, true);
      return {
        session: cloneSession(session),
        fence: this.makeFence(session),
        claim: "resumed" as const
      };
    }

    if (
      input.expectedConnectionEpoch !== undefined &&
      input.expectedConnectionEpoch !== session.connectionEpoch
    ) {
      throw this.connectionConflict(session);
    }
    if (
      session.connectionId !== undefined &&
      input.expectedConnectionEpoch !== session.connectionEpoch
    ) {
      throw this.connectionConflict(session);
    }

    const replacedConnectionId = session.connectionId;
    session.connectionEpoch += 1;
    session.connectionId = input.connectionId;
    session.transportState = "connected";
    this.touch(record, true);
    return {
      session: cloneSession(session),
      fence: this.makeFence(session),
      claim: replacedConnectionId ? ("replaced" as const) : ("new" as const),
      ...(replacedConnectionId ? { replacedConnectionId } : {})
    };
  }

  async releaseConnection(fence: RealtimeVoiceConnectionFence) {
    const record = this.requireFenced(fence);
    delete record.session.connectionId;
    record.session.transportState = "disconnected";
    this.touch(record, true);
    return cloneSession(record.session);
  }

  async acknowledgeAudio(
    fence: RealtimeVoiceConnectionFence,
    input: AcknowledgeRealtimeVoiceAudioInput
  ) {
    const record = this.requireFenced(fence);
    requirePositiveInteger(input.audioEpoch, "audioEpoch");
    requirePositiveInteger(input.sequence, "sequence");
    const { session } = record;
    this.touch(record, true);

    if (input.audioEpoch !== session.audioEpoch) {
      return this.audioAckResult("epoch_mismatch", session);
    }
    if (input.sequence <= session.audioAckSequence) {
      return this.audioAckResult("duplicate", session);
    }
    if (input.sequence !== session.audioAckSequence + 1) {
      return this.audioAckResult("gap", session);
    }

    session.audioAckSequence = input.sequence;
    this.touch(record, true);
    return this.audioAckResult("accepted", session);
  }

  async appendOutboundFrame(
    fence: RealtimeVoiceConnectionFence,
    input: AppendRealtimeVoiceOutboundFrameInput
  ) {
    const record = this.requireFenced(fence);
    if (input.kind !== "control" && input.kind !== "audio") {
      throw new RealtimeVoiceSessionStoreError(
        "invalid_input",
        "outbound frame kind is invalid"
      );
    }
    const frameBytes = byteLength(input.data);
    if (frameBytes > this.maxReplayBytes) {
      throw new RealtimeVoiceSessionStoreError(
        "frame_too_large",
        "outbound frame exceeds replay byte limit",
        { frameBytes, maxReplayBytes: this.maxReplayBytes }
      );
    }

    const sequence = record.session.nextOutboundSequence;
    const frame: RealtimeVoiceOutboundFrame = {
      sequence,
      kind: input.kind,
      data: cloneData(input.data),
      byteLength: frameBytes,
      createdAtMs: this.clock()
    };
    record.outboundFrames.push(frame);
    record.session.nextOutboundSequence = sequence + 1;
    record.session.eventCursor = Math.max(record.session.eventCursor, sequence);
    record.session.outboundReplayBytes += frameBytes;
    this.enforceReplayBounds(record);
    this.touch(record, false);
    return cloneFrame(frame);
  }

  async replayOutbound(
    fence: RealtimeVoiceConnectionFence,
    afterSequence: number
  ): Promise<ReplayRealtimeVoiceOutboundResult> {
    const record = this.requireFenced(fence);
    requireNonNegativeInteger(afterSequence, "afterSequence");
    const latestSequence = record.session.nextOutboundSequence - 1;
    if (afterSequence > latestSequence) {
      throw new RealtimeVoiceSessionStoreError(
        "cursor_ahead",
        "outbound replay cursor is ahead of the server",
        { afterSequence, latestSequence }
      );
    }
    this.touch(record, true);
    const availableAfter = Math.max(
      record.session.outboundAckSequence,
      record.session.outboundReplayFloorSequence
    );
    if (afterSequence < availableAfter) {
      return {
        status: "too_old",
        availableAfter,
        latestSequence,
        frames: []
      };
    }
    return {
      status: "ok",
      availableAfter,
      latestSequence,
      frames: record.outboundFrames
        .filter((frame) => frame.sequence > afterSequence)
        .map(cloneFrame)
    };
  }

  async acknowledgeOutbound(
    fence: RealtimeVoiceConnectionFence,
    throughSequence: number
  ) {
    const record = this.requireFenced(fence);
    requireNonNegativeInteger(throughSequence, "throughSequence");
    const latestSequence = record.session.nextOutboundSequence - 1;
    if (throughSequence > latestSequence) {
      throw new RealtimeVoiceSessionStoreError(
        "cursor_ahead",
        "outbound ACK is ahead of the server",
        { throughSequence, latestSequence }
      );
    }
    this.touch(record, true);
    if (throughSequence <= record.session.outboundAckSequence) {
      return {
        status: "duplicate" as const,
        acknowledgedThrough: record.session.outboundAckSequence
      };
    }

    record.session.outboundAckSequence = throughSequence;
    this.dropReplayThrough(record, throughSequence);
    this.touch(record, true);
    return {
      status: "advanced" as const,
      acknowledgedThrough: throughSequence
    };
  }

  async keepAlive(fence: RealtimeVoiceConnectionFence) {
    const record = this.requireFenced(fence);
    this.touch(record, true);
    return cloneSession(record.session);
  }

  async patchState(
    fence: RealtimeVoiceConnectionFence,
    patch: PatchRealtimeVoiceSessionInput
  ) {
    const record = this.requireFenced(fence);
    const { session } = record;
    if (patch.providerSessionId !== undefined) {
      if (patch.providerSessionId === null) delete session.providerSessionId;
      else {
        requireNonEmptyString(patch.providerSessionId, "providerSessionId");
        session.providerSessionId = patch.providerSessionId;
      }
    }
    if (patch.activeTurnSequence !== undefined) {
      if (patch.activeTurnSequence === null) delete session.activeTurnSequence;
      else {
        requireNonNegativeInteger(
          patch.activeTurnSequence,
          "activeTurnSequence"
        );
        session.activeTurnSequence = patch.activeTurnSequence;
      }
    }
    if (patch.audioEpoch !== undefined) {
      requirePositiveInteger(patch.audioEpoch, "audioEpoch");
      if (patch.audioEpoch < session.audioEpoch) {
        throw new RealtimeVoiceSessionStoreError(
          "invalid_input",
          "audioEpoch cannot move backwards"
        );
      }
      if (patch.audioEpoch > session.audioEpoch) {
        session.audioEpoch = patch.audioEpoch;
        session.audioAckSequence = 0;
      }
    }
    if (patch.eventCursor !== undefined) {
      requireNonNegativeInteger(patch.eventCursor, "eventCursor");
      if (patch.eventCursor < session.eventCursor) {
        throw new RealtimeVoiceSessionStoreError(
          "invalid_input",
          "eventCursor cannot move backwards"
        );
      }
      session.eventCursor = patch.eventCursor;
    }
    if (patch.timestamps !== undefined) {
      validateTimestamps(patch.timestamps);
      session.timestamps = { ...session.timestamps, ...patch.timestamps };
    }
    if (patch.status !== undefined) session.status = patch.status;
    this.touch(record, false);
    return cloneSession(session);
  }

  async delete(sessionId: string, userId: string) {
    const record = this.findOwned(sessionId, userId);
    if (!record) return false;
    return this.records.delete(sessionId);
  }

  async expire(nowMs = this.clock()) {
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      throw new RealtimeVoiceSessionStoreError(
        "invalid_input",
        "nowMs must be a finite non-negative number"
      );
    }
    return this.expireNow(nowMs);
  }

  private findOwned(sessionId: string, userId: string) {
    requireNonEmptyString(sessionId, "sessionId");
    requireNonEmptyString(userId, "userId");
    const record = this.records.get(sessionId);
    if (!record) return undefined;
    if (record.session.userId !== userId) {
      throw new RealtimeVoiceSessionStoreError("owner_mismatch");
    }
    // Only expire() removes records so the gateway can deterministically close
    // the matching runtime. Returning undefined here preserves TTL semantics
    // without silently orphaning Provider resources.
    if (record.session.expiresAtMs <= this.clock()) return undefined;
    return record;
  }

  private requireOwned(sessionId: string, userId: string) {
    const record = this.findOwned(sessionId, userId);
    if (!record) throw new RealtimeVoiceSessionStoreError("not_found");
    return record;
  }

  private requireFenced(fence: RealtimeVoiceConnectionFence) {
    requireNonEmptyString(fence.connectionId, "connectionId");
    requirePositiveInteger(fence.connectionEpoch, "connectionEpoch");
    const record = this.requireOwned(fence.sessionId, fence.userId);
    if (
      record.session.connectionId !== fence.connectionId ||
      record.session.connectionEpoch !== fence.connectionEpoch
    ) {
      throw new RealtimeVoiceSessionStoreError(
        "stale_connection",
        "connection fence no longer owns the session",
        { currentConnectionEpoch: record.session.connectionEpoch }
      );
    }
    return record;
  }

  private connectionConflict(session: RealtimeVoiceSession) {
    return new RealtimeVoiceSessionStoreError(
      "connection_conflict",
      "another connection owns the realtime voice session",
      { currentConnectionEpoch: session.connectionEpoch }
    );
  }

  private makeFence(
    session: RealtimeVoiceSession
  ): RealtimeVoiceConnectionFence {
    if (!session.connectionId) {
      throw new RealtimeVoiceSessionStoreError("stale_connection");
    }
    return {
      sessionId: session.sessionId,
      userId: session.userId,
      connectionId: session.connectionId,
      connectionEpoch: session.connectionEpoch
    };
  }

  private touch(record: SessionRecord, clientActivity: boolean) {
    const now = this.clock();
    record.session.updatedAtMs = now;
    if (clientActivity) {
      record.session.lastClientActivityAtMs = now;
      record.session.expiresAtMs = now + this.ttlMs;
    }
  }

  private audioAckResult(
    status: RealtimeVoiceAudioAckResult["status"],
    session: RealtimeVoiceSession
  ): RealtimeVoiceAudioAckResult {
    return {
      status,
      audioEpoch: session.audioEpoch,
      acceptedThrough: session.audioAckSequence,
      expectedSequence: session.audioAckSequence + 1
    };
  }

  private enforceReplayBounds(record: SessionRecord) {
    while (
      record.outboundFrames.length > this.maxReplayFrames ||
      record.session.outboundReplayBytes > this.maxReplayBytes
    ) {
      const evicted = record.outboundFrames.shift();
      if (!evicted) break;
      record.session.outboundReplayBytes -= evicted.byteLength;
      record.session.outboundReplayFloorSequence = Math.max(
        record.session.outboundReplayFloorSequence,
        evicted.sequence
      );
    }
  }

  private dropReplayThrough(record: SessionRecord, throughSequence: number) {
    while (
      record.outboundFrames[0] &&
      record.outboundFrames[0].sequence <= throughSequence
    ) {
      const removed = record.outboundFrames.shift()!;
      record.session.outboundReplayBytes -= removed.byteLength;
    }
    record.session.outboundReplayFloorSequence = Math.max(
      record.session.outboundReplayFloorSequence,
      throughSequence
    );
  }

  private expireNow(nowMs: number) {
    const expiredIds: string[] = [];
    for (const [sessionId, record] of this.records) {
      if (record.session.expiresAtMs <= nowMs) {
        this.records.delete(sessionId);
        expiredIds.push(sessionId);
      }
    }
    return expiredIds;
  }
}

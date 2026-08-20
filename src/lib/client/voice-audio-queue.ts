export const VOICE_STREAM_SAMPLE_RATE = 24_000;
export const VOICE_STREAM_CHANNELS = 1;
export const VOICE_STREAM_BYTES_PER_SAMPLE = 2;

// Voice QA already receives ordered PCM over a bounded, backpressured stream.
// Start the first valid PCM chunk immediately: Provider chunks can be smaller
// than an 80 ms prime, which otherwise waits for the next network chunk and
// adds hundreds of milliseconds before audible playback.
const DEFAULT_INITIAL_BUFFER_MS = 0;
const DEFAULT_SCHEDULE_LEAD_MS = 10;
const DEFAULT_MAX_BUFFERED_MS = 5_000;

export type VoiceAudioQueueState =
  | "idle"
  | "buffering"
  | "playing"
  | "reconnecting"
  | "completed"
  | "cancelled"
  | "failed";

export type VoiceAudioQueueErrorCode =
  | "audio_context_unavailable"
  | "audio_context_failed"
  | "invalid_sequence"
  | "invalid_audio_chunk"
  | "chunk_too_large"
  | "missing_sequence"
  | "incomplete_pcm_frame"
  | "cancelled"
  | "closed";

export class VoiceAudioQueueError extends Error {
  constructor(
    readonly code: VoiceAudioQueueErrorCode,
    message: string
  ) {
    super(message);
    this.name = "VoiceAudioQueueError";
  }
}

export type VoiceAudioBufferLike = {
  readonly duration: number;
  copyToChannel(source: Float32Array, channelNumber: number): void;
};

export type VoiceAudioBufferSourceLike = {
  buffer: VoiceAudioBufferLike | null;
  onended: ((event: Event) => void) | null;
  connect(destination: unknown): unknown;
  start(when?: number): void;
  stop(when?: number): void;
};

export type VoiceAudioContextLike = {
  currentTime: number;
  state: AudioContextState;
  readonly destination: unknown;
  createBuffer(
    numberOfChannels: number,
    length: number,
    sampleRate: number
  ): VoiceAudioBufferLike;
  createBufferSource(): VoiceAudioBufferSourceLike;
  resume(): Promise<void>;
  close(): Promise<void>;
};

export type VoiceAudioChunk = {
  sequence: number;
  pcm16le: Uint8Array | ArrayBuffer;
  /**
   * Optional Provider conversation item associated with this PCM chunk.
   * It is transport metadata only and is used to truncate the exact item on
   * barge-in; it is never rendered or treated as answer evidence.
   */
  playbackItemId?: string;
};

export type VoiceAudioEnqueueResult = "accepted" | "duplicate" | "empty";

export type VoiceAudioQueueCompletion =
  | { status: "completed" }
  | { status: "cancelled" }
  | { status: "failed"; error: VoiceAudioQueueError };

export type VoiceAudioQueueSnapshot = {
  state: VoiceAudioQueueState;
  nextSequence: number;
  pendingSequences: number[];
  bufferedBytes: number;
  bufferedMs: number;
  transportPaused: boolean;
  playbackStarted: boolean;
};

export type VoiceAudioQueueOptions = {
  contextFactory?: () => VoiceAudioContextLike;
  initialBufferMs?: number;
  scheduleLeadMs?: number;
  maxBufferedMs?: number;
  startSequence?: number;
  onStateChange?: (state: VoiceAudioQueueState) => void;
  onPlaybackStarted?: () => void;
  onError?: (error: VoiceAudioQueueError) => void;
};

type CapacityWaiter = {
  sequence: number;
  byteLength: number;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: () => void;
  reject: (error: VoiceAudioQueueError) => void;
};

type ActiveSource = {
  source: VoiceAudioBufferSourceLike;
  rawByteLength: number;
  generation: number;
  playbackItemId?: string;
  itemOffsetSeconds: number;
  startAt: number;
  durationSeconds: number;
};

type PendingAudioChunk = {
  bytes: Uint8Array;
  playbackItemId?: string;
};

export type VoiceAudioPlaybackPosition = {
  playbackItemId: string;
  audioEndMs: number;
};

function boundedMilliseconds(
  value: number | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number
) {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected < minimum || selected > maximum) {
    throw new VoiceAudioQueueError(
      "invalid_audio_chunk",
      `${name} must be between ${minimum} and ${maximum} milliseconds`
    );
  }
  return selected;
}

function defaultAudioContextFactory(): VoiceAudioContextLike {
  const scope = globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };
  const Constructor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Constructor) {
    throw new VoiceAudioQueueError(
      "audio_context_unavailable",
      "This browser does not support Web Audio playback"
    );
  }
  return new Constructor({ sampleRate: VOICE_STREAM_SAMPLE_RATE });
}

function copyAudioBytes(value: Uint8Array | ArrayBuffer) {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new VoiceAudioQueueError(
    "invalid_audio_chunk",
    "Voice audio chunks must contain PCM bytes"
  );
}

function cancelledError() {
  return new VoiceAudioQueueError("cancelled", "Voice audio playback was cancelled");
}

/**
 * A browser-only, transport-neutral PCM queue.
 *
 * The caller must await `enqueue`: that promise is the queue's backpressure
 * boundary. At most one gap-closing chunk may temporarily exceed the configured
 * byte budget so a buffered out-of-order chunk cannot deadlock the stream.
 */
export class VoiceAudioQueue {
  private readonly contextFactory: () => VoiceAudioContextLike;
  private readonly initialBufferMs: number;
  private readonly scheduleLeadSeconds: number;
  private readonly maxBufferBytes: number;
  private readonly onStateChange?: VoiceAudioQueueOptions["onStateChange"];
  private readonly onPlaybackStarted?: VoiceAudioQueueOptions["onPlaybackStarted"];
  private readonly onError?: VoiceAudioQueueOptions["onError"];
  private readonly pending = new Map<number, PendingAudioChunk>();
  private readonly reservedSequences = new Set<number>();
  private readonly capacityWaiters: CapacityWaiter[] = [];
  private readonly activeSources = new Set<ActiveSource>();
  private readonly completionPromise: Promise<VoiceAudioQueueCompletion>;
  private resolveCompletion!: (completion: VoiceAudioQueueCompletion) => void;

  private context?: VoiceAudioContextLike;
  private queueState: VoiceAudioQueueState = "idle";
  private nextSequenceValue: number;
  private outstandingBytes = 0;
  private reservedBytes = 0;
  private scheduledUntil = 0;
  private carryByte?: number;
  private transportPaused = false;
  private needsPriming = true;
  private playbackStarted = false;
  private inputEnded = false;
  private finalSequence?: number;
  private terminal?: VoiceAudioQueueCompletion;
  private generation = 0;
  private readonly scheduledItemSeconds = new Map<string, number>();
  private lastPlaybackPosition?: VoiceAudioPlaybackPosition;

  constructor(options: VoiceAudioQueueOptions = {}) {
    this.contextFactory = options.contextFactory ?? defaultAudioContextFactory;
    const requestedInitialBufferMs = boundedMilliseconds(
      options.initialBufferMs,
      DEFAULT_INITIAL_BUFFER_MS,
      "initialBufferMs",
      0,
      5_000
    );
    this.scheduleLeadSeconds = boundedMilliseconds(
      options.scheduleLeadMs,
      DEFAULT_SCHEDULE_LEAD_MS,
      "scheduleLeadMs",
      0,
      1_000
    ) / 1_000;
    const maxBufferedMs = boundedMilliseconds(
      options.maxBufferedMs,
      DEFAULT_MAX_BUFFERED_MS,
      "maxBufferedMs",
      20,
      30_000
    );
    // A priming target larger than the whole bounded buffer can never be met.
    this.initialBufferMs = Math.min(requestedInitialBufferMs, maxBufferedMs);
    this.maxBufferBytes = Math.max(
      VOICE_STREAM_BYTES_PER_SAMPLE,
      Math.floor(this.bytesPerSecond * maxBufferedMs / 1_000)
    );
    const startSequence = options.startSequence ?? 0;
    if (!Number.isSafeInteger(startSequence) || startSequence < 0) {
      throw new VoiceAudioQueueError(
        "invalid_sequence",
        "Voice audio start sequence must be a non-negative integer"
      );
    }
    this.nextSequenceValue = startSequence;
    this.onStateChange = options.onStateChange;
    this.onPlaybackStarted = options.onPlaybackStarted;
    this.onError = options.onError;
    this.completionPromise = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  private get bytesPerSecond() {
    return VOICE_STREAM_SAMPLE_RATE * VOICE_STREAM_CHANNELS * VOICE_STREAM_BYTES_PER_SAMPLE;
  }

  async prepare() {
    this.assertOpen();
    try {
      this.context ??= this.contextFactory();
      if (this.context.state === "closed") {
        throw new VoiceAudioQueueError("closed", "Voice audio context is closed");
      }
      if (this.context.state === "suspended") await this.context.resume();
    } catch (error) {
      const normalized = error instanceof VoiceAudioQueueError
        ? error
        : new VoiceAudioQueueError("audio_context_failed", "Voice audio playback could not start");
      this.fail(normalized);
      throw normalized;
    }
    this.setState(
      this.transportPaused
        ? "reconnecting"
        : this.activeSources.size > 0
          ? "playing"
          : "buffering"
    );
    this.drainPending();
  }

  async enqueue(
    chunk: VoiceAudioChunk,
    options: { signal?: AbortSignal } = {}
  ): Promise<VoiceAudioEnqueueResult> {
    this.assertOpen();
    this.assertSequence(chunk.sequence);
    if (
      chunk.sequence < this.nextSequenceValue ||
      this.pending.has(chunk.sequence) ||
      this.reservedSequences.has(chunk.sequence)
    ) {
      return "duplicate";
    }

    const bytes = copyAudioBytes(chunk.pcm16le);
    const playbackItemId = chunk.playbackItemId?.trim();
    if (chunk.playbackItemId !== undefined && !playbackItemId) {
      throw new VoiceAudioQueueError(
        "invalid_audio_chunk",
        "Voice audio playback item ID must not be empty"
      );
    }
    if (bytes.byteLength === 0) {
      this.pending.set(chunk.sequence, {
        bytes,
        ...(playbackItemId ? { playbackItemId } : {})
      });
      this.drainPending();
      return "empty";
    }
    if (bytes.byteLength > this.maxBufferBytes) {
      throw new VoiceAudioQueueError(
        "chunk_too_large",
        "Voice audio chunk exceeds the bounded playback buffer"
      );
    }

    await this.reserveCapacity(chunk.sequence, bytes.byteLength, options.signal);
    try {
      this.assertOpen();
      if (chunk.sequence < this.nextSequenceValue || this.pending.has(chunk.sequence)) {
        return "duplicate";
      }
      this.pending.set(chunk.sequence, {
        bytes,
        ...(playbackItemId ? { playbackItemId } : {})
      });
      this.outstandingBytes += bytes.byteLength;
      this.drainPending();
      return "accepted";
    } finally {
      this.releaseReservation(chunk.sequence, bytes.byteLength);
    }
  }

  pauseForReconnect() {
    if (this.terminal || this.transportPaused) return;
    this.transportPaused = true;
    this.setState("reconnecting");
  }

  async resumeAfterReconnect() {
    this.assertOpen();
    if (!this.context) await this.prepare();
    if (this.context?.state === "suspended") await this.context.resume();
    this.transportPaused = false;
    this.setState(this.activeSources.size > 0 ? "playing" : "buffering");
    this.drainPending();
  }

  finish(finalSequence?: number): Promise<VoiceAudioQueueCompletion> {
    if (this.terminal) return this.completionPromise;
    if (finalSequence !== undefined) {
      this.assertSequence(finalSequence);
      if (finalSequence < this.nextSequenceValue - 1) {
        this.fail(new VoiceAudioQueueError(
          "invalid_sequence",
          "Voice audio final sequence precedes already consumed audio"
        ));
        return this.completionPromise;
      }
      this.finalSequence = finalSequence;
    } else {
      this.finalSequence = Math.max(
        this.nextSequenceValue - 1,
        ...this.pending.keys(),
        ...this.reservedSequences
      );
    }
    this.inputEnded = true;
    this.drainPending();
    this.validateFinishedInput();
    return this.completionPromise;
  }

  async cancel() {
    if (this.terminal) return;
    const completion: VoiceAudioQueueCompletion = { status: "cancelled" };
    this.terminal = completion;
    this.generation += 1;
    this.setState("cancelled");
    this.rejectCapacityWaiters(cancelledError());
    this.pending.clear();
    this.reservedSequences.clear();
    this.reservedBytes = 0;
    this.outstandingBytes = 0;
    this.carryByte = undefined;
    this.scheduledItemSeconds.clear();
    this.lastPlaybackPosition = undefined;
    const sources = [...this.activeSources];
    this.activeSources.clear();
    for (const { source } of sources) {
      try {
        source.stop();
      } catch {
        // A source that ended concurrently is already cancelled for this queue.
      }
    }
    const context = this.context;
    this.context = undefined;
    if (context && context.state !== "closed") {
      await context.close().catch(() => undefined);
    }
    this.resolveCompletion(completion);
  }

  whenCompleted() {
    return this.completionPromise;
  }

  snapshot(): VoiceAudioQueueSnapshot {
    const bufferedBytes = this.outstandingBytes + this.reservedBytes;
    return {
      state: this.queueState,
      nextSequence: this.nextSequenceValue,
      pendingSequences: [...this.pending.keys()].sort((left, right) => left - right),
      bufferedBytes,
      bufferedMs: Math.round(bufferedBytes / this.bytesPerSecond * 1_000),
      transportPaused: this.transportPaused,
      playbackStarted: this.playbackStarted
    };
  }

  /**
   * Returns the exact Provider item and PCM duration already reached by the
   * AudioContext clock. Buffering gaps, page suspension, and future scheduled
   * audio do not advance this value.
   */
  playbackPosition(): VoiceAudioPlaybackPosition | undefined {
    const context = this.context;
    if (!context) return this.lastPlaybackPosition
      ? { ...this.lastPlaybackPosition }
      : undefined;
    const currentTime = context.currentTime;
    const candidates = [...this.activeSources]
      .filter((active) =>
        Boolean(active.playbackItemId) && active.startAt <= currentTime
      )
      .sort((left, right) => right.startAt - left.startAt);
    const active = candidates[0];
    if (!active?.playbackItemId) {
      return this.lastPlaybackPosition
        ? { ...this.lastPlaybackPosition }
        : undefined;
    }
    const playedSeconds = Math.min(
      active.durationSeconds,
      Math.max(0, currentTime - active.startAt)
    );
    return {
      playbackItemId: active.playbackItemId,
      audioEndMs: Math.max(
        0,
        Math.round((active.itemOffsetSeconds + playedSeconds) * 1_000)
      )
    };
  }

  private reserveCapacity(
    sequence: number,
    byteLength: number,
    signal: AbortSignal | undefined
  ) {
    if (signal?.aborted) return Promise.reject(cancelledError());
    if (this.canReserve(sequence, byteLength)) {
      this.reserve(sequence, byteLength);
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: CapacityWaiter = {
        sequence,
        byteLength,
        ...(signal ? { signal } : {}),
        resolve,
        reject
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.capacityWaiters.indexOf(waiter);
          if (index >= 0) this.capacityWaiters.splice(index, 1);
          reject(cancelledError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.capacityWaiters.push(waiter);
    });
  }

  private canReserve(sequence: number, byteLength: number) {
    const withinBudget = this.outstandingBytes + this.reservedBytes + byteLength <= this.maxBufferBytes;
    // A bounded one-chunk exception closes an out-of-order gap. Without it, a
    // future chunk could fill the budget and permanently block its predecessor.
    const closesCurrentGap =
      sequence === this.nextSequenceValue &&
      !this.pending.has(sequence) &&
      !this.reservedSequences.has(sequence) &&
      [...this.pending.keys()].some((pendingSequence) => pendingSequence > sequence);
    return withinBudget || closesCurrentGap;
  }

  private reserve(sequence: number, byteLength: number) {
    this.reservedSequences.add(sequence);
    this.reservedBytes += byteLength;
  }

  private releaseReservation(sequence: number, byteLength: number) {
    if (!this.reservedSequences.delete(sequence)) return;
    this.reservedBytes = Math.max(0, this.reservedBytes - byteLength);
    this.pumpCapacityWaiters();
  }

  private pumpCapacityWaiters() {
    if (this.terminal) return;
    for (let index = 0; index < this.capacityWaiters.length;) {
      const waiter = this.capacityWaiters[index]!;
      if (!this.canReserve(waiter.sequence, waiter.byteLength)) {
        index += 1;
        continue;
      }
      this.capacityWaiters.splice(index, 1);
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      this.reserve(waiter.sequence, waiter.byteLength);
      waiter.resolve();
    }
  }

  private rejectCapacityWaiters(error: VoiceAudioQueueError) {
    const waiters = this.capacityWaiters.splice(0);
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.reject(error);
    }
  }

  private drainPending() {
    if (!this.context || this.transportPaused || this.terminal) return;
    if (
      this.needsPriming &&
      !this.inputEnded &&
      this.contiguousPendingDurationMs() < this.initialBufferMs
    ) {
      this.setState("buffering");
      return;
    }

    let scheduled = false;
    while (this.pending.has(this.nextSequenceValue)) {
      const chunk = this.pending.get(this.nextSequenceValue)!;
      this.pending.delete(this.nextSequenceValue);
      this.nextSequenceValue += 1;
      if (chunk.bytes.byteLength > 0) {
        scheduled = this.scheduleBytes(
          chunk.bytes,
          chunk.playbackItemId
        ) || scheduled;
      }
      this.pumpCapacityWaiters();
    }
    if (scheduled) {
      this.needsPriming = false;
      this.setState("playing");
    } else if (this.activeSources.size === 0 && !this.inputEnded) {
      this.setState("buffering");
    }
    if (this.inputEnded) this.validateFinishedInput();
  }

  private contiguousPendingDurationMs() {
    let byteLength = this.carryByte === undefined ? 0 : 1;
    let sequence = this.nextSequenceValue;
    while (this.pending.has(sequence)) {
      byteLength += this.pending.get(sequence)!.bytes.byteLength;
      sequence += 1;
    }
    return byteLength / this.bytesPerSecond * 1_000;
  }

  private scheduleBytes(bytes: Uint8Array, playbackItemId?: string) {
    const carryLength = this.carryByte === undefined ? 0 : 1;
    const combined = new Uint8Array(carryLength + bytes.byteLength);
    if (this.carryByte !== undefined) combined[0] = this.carryByte;
    combined.set(bytes, carryLength);
    const playableByteLength = combined.byteLength - (combined.byteLength % VOICE_STREAM_BYTES_PER_SAMPLE);
    this.carryByte = playableByteLength < combined.byteLength
      ? combined[combined.byteLength - 1]
      : undefined;
    if (playableByteLength === 0) return false;

    const sampleCount = playableByteLength / VOICE_STREAM_BYTES_PER_SAMPLE;
    const samples = new Float32Array(sampleCount);
    const view = new DataView(combined.buffer, combined.byteOffset, playableByteLength);
    for (let index = 0; index < sampleCount; index += 1) {
      samples[index] = view.getInt16(index * VOICE_STREAM_BYTES_PER_SAMPLE, true) / 32_768;
    }

    try {
      const context = this.context!;
      const buffer = context.createBuffer(
        VOICE_STREAM_CHANNELS,
        sampleCount,
        VOICE_STREAM_SAMPLE_RATE
      );
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const generation = this.generation;
      const startAt = Math.max(
        context.currentTime + this.scheduleLeadSeconds,
        this.scheduledUntil
      );
      const itemOffsetSeconds = playbackItemId
        ? this.scheduledItemSeconds.get(playbackItemId) ?? 0
        : 0;
      const active: ActiveSource = {
        source,
        rawByteLength: playableByteLength,
        generation,
        ...(playbackItemId ? { playbackItemId } : {}),
        itemOffsetSeconds,
        startAt,
        durationSeconds: buffer.duration
      };
      if (playbackItemId) {
        this.scheduledItemSeconds.set(
          playbackItemId,
          itemOffsetSeconds + buffer.duration
        );
      }
      this.activeSources.add(active);
      source.onended = () => this.handleSourceEnded(active);
      source.start(startAt);
      this.scheduledUntil = startAt + buffer.duration;
      if (!this.playbackStarted) {
        this.playbackStarted = true;
        try {
          this.onPlaybackStarted?.();
        } catch {
          // Observer failures cannot corrupt playback ordering.
        }
      }
      return true;
    } catch (error) {
      const normalized = error instanceof VoiceAudioQueueError
        ? error
        : new VoiceAudioQueueError(
            "audio_context_failed",
            "Voice audio could not be scheduled for playback"
          );
      this.fail(normalized);
      throw normalized;
    }
  }

  private handleSourceEnded(active: ActiveSource) {
    if (
      this.terminal ||
      active.generation !== this.generation ||
      !this.activeSources.delete(active)
    ) {
      return;
    }
    this.outstandingBytes = Math.max(0, this.outstandingBytes - active.rawByteLength);
    if (active.playbackItemId) {
      this.lastPlaybackPosition = {
        playbackItemId: active.playbackItemId,
        audioEndMs: Math.max(
          0,
          Math.round(
            (active.itemOffsetSeconds + active.durationSeconds) * 1_000
          )
        )
      };
    }
    this.pumpCapacityWaiters();
    if (this.activeSources.size > 0) return;
    if (this.inputEnded) {
      this.validateFinishedInput();
      return;
    }
    this.needsPriming = true;
    this.setState(this.transportPaused ? "reconnecting" : "buffering");
    this.drainPending();
  }

  private validateFinishedInput() {
    if (this.terminal || !this.inputEnded) return;
    const finalSequence = this.finalSequence ?? this.nextSequenceValue - 1;
    if (this.nextSequenceValue <= finalSequence) {
      this.fail(new VoiceAudioQueueError(
        "missing_sequence",
        `Voice audio stream ended before sequence ${this.nextSequenceValue}`
      ));
      return;
    }
    if (this.pending.size > 0 || this.reservedSequences.size > 0) {
      this.fail(new VoiceAudioQueueError(
        "missing_sequence",
        "Voice audio stream ended with non-contiguous chunks"
      ));
      return;
    }
    if (this.carryByte !== undefined) {
      this.fail(new VoiceAudioQueueError(
        "incomplete_pcm_frame",
        "Voice audio stream ended in the middle of a PCM sample"
      ));
      return;
    }
    if (this.activeSources.size === 0) this.complete();
  }

  private complete() {
    if (this.terminal) return;
    const completion: VoiceAudioQueueCompletion = { status: "completed" };
    this.terminal = completion;
    this.setState("completed");
    const context = this.context;
    this.context = undefined;
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }
    this.resolveCompletion(completion);
  }

  private fail(error: VoiceAudioQueueError) {
    if (this.terminal) return;
    const completion: VoiceAudioQueueCompletion = { status: "failed", error };
    this.terminal = completion;
    this.generation += 1;
    this.setState("failed");
    this.rejectCapacityWaiters(error);
    this.pending.clear();
    this.reservedSequences.clear();
    this.reservedBytes = 0;
    this.outstandingBytes = 0;
    this.carryByte = undefined;
    const sources = [...this.activeSources];
    this.activeSources.clear();
    for (const { source } of sources) {
      try {
        source.stop();
      } catch {
        // A source that ended concurrently is already detached from the queue.
      }
    }
    const context = this.context;
    this.context = undefined;
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }
    try {
      this.onError?.(error);
    } catch {
      // Observer failures cannot replace the queue's terminal result.
    }
    this.resolveCompletion(completion);
  }

  private setState(state: VoiceAudioQueueState) {
    if (state === this.queueState) return;
    this.queueState = state;
    try {
      this.onStateChange?.(state);
    } catch {
      // State observers are diagnostics/UI only and cannot own queue control.
    }
  }

  private assertOpen() {
    if (!this.terminal) return;
    if (this.terminal.status === "cancelled") throw cancelledError();
    throw new VoiceAudioQueueError("closed", "Voice audio queue is closed");
  }

  private assertSequence(sequence: number) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new VoiceAudioQueueError(
        "invalid_sequence",
        "Voice audio sequence must be a non-negative integer"
      );
    }
  }
}

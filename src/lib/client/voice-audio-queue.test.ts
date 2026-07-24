import { describe, expect, it, vi } from "vitest";

import {
  VoiceAudioQueue,
  VoiceAudioQueueError,
  type VoiceAudioContextLike
} from "./voice-audio-queue";

class FakeAudioBuffer {
  readonly duration: number;
  readonly channels: Float32Array[];

  constructor(
    numberOfChannels: number,
    length: number,
    sampleRate: number
  ) {
    this.duration = length / sampleRate;
    this.channels = Array.from(
      { length: numberOfChannels },
      () => new Float32Array(length)
    );
  }

  copyToChannel(source: Float32Array, channelNumber: number) {
    this.channels[channelNumber]?.set(source);
  }
}

class FakeAudioBufferSource {
  buffer: FakeAudioBuffer | null = null;
  onended: (() => void) | null = null;
  startAt?: number;
  readonly stop = vi.fn(() => {
    this.onended?.();
  });

  constructor(private readonly context: FakeAudioContext) {}

  connect() {
    return undefined;
  }

  start(when = 0) {
    this.startAt = when;
  }

  finish() {
    if (this.startAt !== undefined && this.buffer) {
      this.context.currentTime = Math.max(
        this.context.currentTime,
        this.startAt + this.buffer.duration
      );
    }
    this.onended?.();
  }
}

class FakeAudioContext implements VoiceAudioContextLike {
  currentTime = 0;
  state: AudioContextState = "running";
  readonly destination = {};
  readonly sources: FakeAudioBufferSource[] = [];
  readonly resume = vi.fn(async () => {
    this.state = "running";
  });
  readonly close = vi.fn(async () => {
    this.state = "closed";
  });

  createBuffer(numberOfChannels: number, length: number, sampleRate: number) {
    return new FakeAudioBuffer(numberOfChannels, length, sampleRate);
  }

  createBufferSource() {
    const source = new FakeAudioBufferSource(this);
    this.sources.push(source);
    return source;
  }
}

function pcm16(...samples: number[]) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

function queueWith(
  context: FakeAudioContext,
  overrides: Partial<ConstructorParameters<typeof VoiceAudioQueue>[0]> = {}
) {
  return new VoiceAudioQueue({
    contextFactory: () => context,
    initialBufferMs: 0,
    scheduleLeadMs: 0,
    maxBufferedMs: 1_000,
    ...overrides
  });
}

describe("VoiceAudioQueue", () => {
  it("buffers out-of-order chunks, schedules them by sequence, and ignores duplicates", async () => {
    const context = new FakeAudioContext();
    const queue = queueWith(context);
    await queue.prepare();

    await expect(queue.enqueue({ sequence: 1, pcm16le: pcm16(2_000) }))
      .resolves.toBe("accepted");
    expect(context.sources).toHaveLength(0);
    await expect(queue.enqueue({ sequence: 1, pcm16le: pcm16(9_000) }))
      .resolves.toBe("duplicate");
    await expect(queue.enqueue({ sequence: 0, pcm16le: pcm16(1_000) }))
      .resolves.toBe("accepted");

    expect(context.sources).toHaveLength(2);
    expect(context.sources.map((source) => source.startAt)).toEqual([
      0,
      1 / 24_000
    ]);
    expect(context.sources[0]?.buffer?.channels[0]?.[0]).toBeCloseTo(1_000 / 32_768);
    expect(context.sources[1]?.buffer?.channels[0]?.[0]).toBeCloseTo(2_000 / 32_768);
    expect(queue.snapshot().nextSequence).toBe(2);
  });

  it("consumes empty chunks without breaking the following sequence", async () => {
    const context = new FakeAudioContext();
    const queue = queueWith(context);
    await queue.prepare();

    await expect(queue.enqueue({ sequence: 0, pcm16le: new Uint8Array() }))
      .resolves.toBe("empty");
    await queue.enqueue({ sequence: 1, pcm16le: pcm16(4_000) });

    expect(context.sources).toHaveLength(1);
    expect(queue.snapshot().nextSequence).toBe(2);
  });

  it("keeps adjacent PCM chunks continuously scheduled", async () => {
    const context = new FakeAudioContext();
    const queue = queueWith(context);
    await queue.prepare();
    const oneHundredMs = new Uint8Array(4_800);

    await queue.enqueue({ sequence: 0, pcm16le: oneHundredMs });
    await queue.enqueue({ sequence: 1, pcm16le: oneHundredMs });

    expect(context.sources[0]?.startAt).toBe(0);
    expect(context.sources[1]?.startAt).toBeCloseTo(0.1);
  });

  it("returns to buffering after underflow and resumes from the current clock", async () => {
    const context = new FakeAudioContext();
    const states: string[] = [];
    const queue = queueWith(context, {
      onStateChange: (state) => states.push(state)
    });
    await queue.prepare();

    await queue.enqueue({ sequence: 0, pcm16le: new Uint8Array(4_800) });
    context.sources[0]?.finish();
    expect(queue.snapshot().state).toBe("buffering");

    context.currentTime = 0.25;
    await queue.enqueue({ sequence: 1, pcm16le: new Uint8Array(4_800) });

    expect(context.sources[1]?.startAt).toBe(0.25);
    expect(states).toContain("buffering");
    expect(queue.snapshot().state).toBe("playing");
  });

  it("pauses scheduling during transport reconnect and resumes in order", async () => {
    const context = new FakeAudioContext();
    const queue = queueWith(context);
    await queue.prepare();

    queue.pauseForReconnect();
    await queue.enqueue({ sequence: 1, pcm16le: pcm16(2) });
    await queue.enqueue({ sequence: 0, pcm16le: pcm16(1) });
    expect(context.sources).toHaveLength(0);
    expect(queue.snapshot().state).toBe("reconnecting");

    await queue.resumeAfterReconnect();

    expect(context.sources).toHaveLength(2);
    expect(queue.snapshot().state).toBe("playing");
  });

  it("carries a split PCM sample across chunk boundaries", async () => {
    const context = new FakeAudioContext();
    const queue = queueWith(context);
    await queue.prepare();

    await queue.enqueue({ sequence: 0, pcm16le: new Uint8Array([0]) });
    expect(context.sources).toHaveLength(0);
    await queue.enqueue({ sequence: 1, pcm16le: new Uint8Array([128]) });

    expect(context.sources).toHaveLength(1);
    expect(context.sources[0]?.buffer?.channels[0]?.[0]).toBe(-1);
  });

  it("backpressures enqueue until scheduled audio releases bounded capacity", async () => {
    const context = new FakeAudioContext();
    const queue = queueWith(context, { maxBufferedMs: 100 });
    await queue.prepare();
    const oneHundredMs = new Uint8Array(4_800);
    await queue.enqueue({ sequence: 0, pcm16le: oneHundredMs });

    let secondSettled = false;
    const second = queue
      .enqueue({ sequence: 1, pcm16le: oneHundredMs })
      .then((result) => {
        secondSettled = true;
        return result;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    context.sources[0]?.finish();

    await expect(second).resolves.toBe("accepted");
    expect(context.sources).toHaveLength(2);
    expect(queue.snapshot().bufferedBytes).toBe(4_800);
  });

  it("allows one gap-closing chunk through a full out-of-order buffer", async () => {
    const context = new FakeAudioContext();
    const queue = queueWith(context, { maxBufferedMs: 100 });
    await queue.prepare();
    const oneHundredMs = new Uint8Array(4_800);

    await queue.enqueue({ sequence: 1, pcm16le: oneHundredMs });
    await expect(queue.enqueue({ sequence: 0, pcm16le: oneHundredMs }))
      .resolves.toBe("accepted");

    expect(context.sources).toHaveLength(2);
    expect(queue.snapshot().nextSequence).toBe(2);
    expect(queue.snapshot().bufferedBytes).toBe(9_600);
  });

  it("cancels active and backpressured work and ignores stale playback callbacks", async () => {
    const context = new FakeAudioContext();
    const queue = queueWith(context, { maxBufferedMs: 100 });
    await queue.prepare();
    await queue.enqueue({ sequence: 0, pcm16le: new Uint8Array(4_800) });
    const waiting = queue.enqueue({ sequence: 2, pcm16le: new Uint8Array(4_800) });
    await Promise.resolve();

    await queue.cancel();

    expect(context.sources[0]?.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(queue.snapshot().state).toBe("cancelled");
    await expect(waiting).rejects.toMatchObject({ code: "cancelled" });
    await expect(queue.enqueue({ sequence: 3, pcm16le: pcm16(1) }))
      .rejects.toMatchObject({ code: "cancelled" });
    context.sources[0]?.finish();
    expect(queue.snapshot().state).toBe("cancelled");
  });

  it("fails closed when the final sequence has a gap", async () => {
    const context = new FakeAudioContext();
    const onError = vi.fn();
    const queue = queueWith(context, { onError });
    await queue.prepare();
    await queue.enqueue({ sequence: 1, pcm16le: pcm16(1) });

    const completion = queue.finish(1);

    await expect(completion).resolves.toMatchObject({
      status: "failed",
      error: expect.objectContaining({ code: "missing_sequence" })
    });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "missing_sequence"
    }));
  });

  it("completes only after the final scheduled source has ended", async () => {
    const context = new FakeAudioContext();
    const onPlaybackStarted = vi.fn();
    const queue = queueWith(context, { onPlaybackStarted });
    await queue.prepare();
    await queue.enqueue({ sequence: 0, pcm16le: pcm16(1) });

    let completed = false;
    const completion = queue.finish(0).then((result) => {
      completed = true;
      return result;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(onPlaybackStarted).toHaveBeenCalledOnce();

    context.sources[0]?.finish();

    await expect(completion).resolves.toEqual({ status: "completed" });
    expect(queue.snapshot().state).toBe("completed");
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("rejects invalid sequence numbers without touching playback", async () => {
    const context = new FakeAudioContext();
    const queue = queueWith(context);
    await queue.prepare();

    await expect(queue.enqueue({ sequence: -1, pcm16le: pcm16(1) }))
      .rejects.toBeInstanceOf(VoiceAudioQueueError);
    expect(context.sources).toHaveLength(0);
  });
});

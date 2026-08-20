import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BROWSER_AUDIO_RECORDER_MIME_TYPES,
  BrowserAudioRecorder,
  DEFAULT_BROWSER_AUDIO_RECORDER_TIMESLICE_MS,
  type BrowserAudioRecorderSnapshot
} from "./browser-audio-recorder";

class FakeMediaRecorder {
  readonly mimeType: string;
  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  readonly startCalls: Array<number | undefined> = [];
  stopCalls = 0;

  constructor(
    readonly stream: MediaStream,
    options?: MediaRecorderOptions
  ) {
    this.mimeType = options?.mimeType ?? "audio/browser-default";
  }

  start(timeslice?: number) {
    if (this.state !== "inactive") {
      throw new DOMException("already recording", "InvalidStateError");
    }
    this.startCalls.push(timeslice);
    this.state = "recording";
  }

  stop() {
    if (this.state === "inactive") {
      throw new DOMException("already inactive", "InvalidStateError");
    }
    this.stopCalls += 1;
    this.state = "inactive";
  }

  emitData(value: string, type = this.mimeType) {
    this.ondataavailable?.({
      data: new Blob([value], { type })
    } as BlobEvent);
  }

  emitEmptyData() {
    this.ondataavailable?.({ data: new Blob([]) } as BlobEvent);
  }

  emitError() {
    this.onerror?.(new Event("error"));
  }

  finishStop() {
    this.onstop?.(new Event("stop"));
  }
}

function microphoneStream(trackCount = 2) {
  const stops = Array.from({ length: trackCount }, () => vi.fn());
  const tracks = stops.map((stop) => ({ stop })) as unknown as MediaStreamTrack[];
  const getTracks = vi.fn(() => tracks);
  return {
    stream: { getTracks } as unknown as MediaStream,
    getTracks,
    stops
  };
}

function recorderFactory(input: {
  failMimeTypes?: ReadonlySet<string>;
} = {}) {
  const instances: FakeMediaRecorder[] = [];
  const factory = vi.fn((stream: MediaStream, options?: MediaRecorderOptions) => {
    if (options?.mimeType && input.failMimeTypes?.has(options.mimeType)) {
      throw new DOMException("constructor rejected codec", "NotSupportedError");
    }
    const recorder = new FakeMediaRecorder(stream, options);
    instances.push(recorder);
    return recorder as unknown as MediaRecorder;
  });
  return { factory, instances };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function readBlobAsText(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BrowserAudioRecorder", () => {
  it("requests the microphone, negotiates a supported codec, and starts with a timeslice", async () => {
    const microphone = microphoneStream();
    const getUserMedia = vi.fn().mockResolvedValue(microphone.stream);
    const media = recorderFactory();
    const isTypeSupported = vi.fn(
      (mimeType: string) => mimeType === "audio/ogg;codecs=opus"
    );
    const recorder = new BrowserAudioRecorder({
      getUserMedia,
      mediaRecorderFactory: media.factory,
      mediaRecorderIsTypeSupported: isTypeSupported
    });

    await recorder.start();

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    expect(isTypeSupported.mock.calls.map(([mimeType]) => mimeType)).toEqual([
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus"
    ]);
    expect(media.factory).toHaveBeenCalledWith(microphone.stream, {
      mimeType: "audio/ogg;codecs=opus"
    });
    expect(media.instances[0]?.startCalls).toEqual([
      DEFAULT_BROWSER_AUDIO_RECORDER_TIMESLICE_MS
    ]);
    expect(recorder.getSnapshot()).toMatchObject({
      state: "recording",
      durationHint: "none",
      recording: null
    });

    recorder.cancel();
    expect(microphone.stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
  });

  it("falls through a falsely advertised codec and then uses the next supported codec", async () => {
    const microphone = microphoneStream(1);
    const media = recorderFactory({
      failMimeTypes: new Set(["audio/webm;codecs=opus"])
    });
    const recorder = new BrowserAudioRecorder({
      getUserMedia: vi.fn().mockResolvedValue(microphone.stream),
      mediaRecorderFactory: media.factory,
      mediaRecorderIsTypeSupported: (mimeType) => (
        mimeType === "audio/webm;codecs=opus"
        || mimeType === "audio/ogg;codecs=opus"
      )
    });

    await recorder.start();

    expect(media.factory.mock.calls.map(([, options]) => options?.mimeType)).toEqual([
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus"
    ]);
    expect(media.instances[0]?.mimeType).toBe("audio/ogg;codecs=opus");
    recorder.cancel();
  });

  it("uses the browser default when no explicit MIME type is supported", async () => {
    const microphone = microphoneStream(1);
    const media = recorderFactory();
    const recorder = new BrowserAudioRecorder({
      getUserMedia: vi.fn().mockResolvedValue(microphone.stream),
      mediaRecorderFactory: media.factory,
      mediaRecorderIsTypeSupported: () => false
    });

    await recorder.start();

    expect(media.factory).toHaveBeenCalledTimes(1);
    expect(media.factory.mock.calls[0]?.[1]).toBeUndefined();
    expect(media.instances[0]?.mimeType).toBe("audio/browser-default");
    recorder.cancel();
  });

  it("stops acquired tracks if every codec and browser-default constructor fails", async () => {
    const microphone = microphoneStream();
    const constructorError = new DOMException("no usable codec", "NotSupportedError");
    const factory = vi.fn(() => {
      throw constructorError;
    });
    const recorder = new BrowserAudioRecorder({
      getUserMedia: vi.fn().mockResolvedValue(microphone.stream),
      mediaRecorderFactory: factory,
      mediaRecorderIsTypeSupported: () => true
    });

    await expect(recorder.start()).rejects.toBe(constructorError);

    expect(factory).toHaveBeenCalledTimes(BROWSER_AUDIO_RECORDER_MIME_TYPES.length + 1);
    expect(microphone.stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
    expect(recorder.getSnapshot().state).toBe("idle");
  });

  it("surfaces microphone permission denial and returns to idle", async () => {
    const denied = new DOMException("Permission denied", "NotAllowedError");
    const media = recorderFactory();
    const recorder = new BrowserAudioRecorder({
      getUserMedia: vi.fn().mockRejectedValue(denied),
      mediaRecorderFactory: media.factory,
      mediaRecorderIsTypeSupported: () => true
    });

    await expect(recorder.start()).rejects.toBe(denied);

    expect(media.factory).not.toHaveBeenCalled();
    expect(recorder.getSnapshot()).toMatchObject({
      state: "idle",
      recording: null,
      clientReportedDurationMs: null
    });
  });

  it("fails before requesting the microphone when MediaRecorder is unavailable", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    const getUserMedia = vi.fn();
    const recorder = new BrowserAudioRecorder({ getUserMedia });

    await expect(recorder.start()).rejects.toMatchObject({
      name: "NotSupportedError"
    });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(recorder.getSnapshot().state).toBe("idle");
  });

  it("waits for the final dataavailable and onstop before returning one ordered Blob", async () => {
    let now = 10_000;
    const microphone = microphoneStream();
    const media = recorderFactory();
    const recorder = new BrowserAudioRecorder({
      getUserMedia: vi.fn().mockResolvedValue(microphone.stream),
      mediaRecorderFactory: media.factory,
      mediaRecorderIsTypeSupported: (mimeType) => (
        mimeType === "audio/webm;codecs=opus"
      ),
      now: () => now
    });
    await recorder.start();
    const nativeRecorder = media.instances[0]!;
    nativeRecorder.emitData("periodic-a|");
    nativeRecorder.emitEmptyData();
    nativeRecorder.emitData("periodic-b|");
    now = 12_345;

    const firstStop = recorder.stop();
    const repeatedStop = recorder.stop();
    let settled = false;
    void firstStop.then(() => {
      settled = true;
    });

    expect(repeatedStop).toBe(firstStop);
    expect(nativeRecorder.stopCalls).toBe(1);
    expect(recorder.getSnapshot().state).toBe("stopping");
    expect(microphone.stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);

    nativeRecorder.emitData("final");
    await Promise.resolve();
    expect(settled).toBe(false);
    nativeRecorder.finishStop();

    const [first, repeated] = await Promise.all([firstStop, repeatedStop]);
    expect(repeated).toBe(first);
    expect(first.blob.type).toBe("audio/webm;codecs=opus");
    expect(await readBlobAsText(first.blob)).toBe("periodic-a|periodic-b|final");
    expect(first.clientReportedDurationMs).toBe(2_345);
    expect(recorder.getSnapshot()).toEqual({
      state: "ready",
      durationHint: "none",
      clientReportedDurationMs: 2_345,
      recording: first
    });
  });

  it("cancels without preserving chunks and ignores already-queued late events", async () => {
    const microphone = microphoneStream();
    const media = recorderFactory();
    const recorder = new BrowserAudioRecorder({
      getUserMedia: vi.fn().mockResolvedValue(microphone.stream),
      mediaRecorderFactory: media.factory,
      mediaRecorderIsTypeSupported: () => false
    });
    await recorder.start();
    const nativeRecorder = media.instances[0]!;
    nativeRecorder.emitData("private-audio");
    const lateData = nativeRecorder.ondataavailable;
    const lateStop = nativeRecorder.onstop;

    recorder.cancel();
    lateData?.({ data: new Blob(["late-private-audio"]) } as BlobEvent);
    lateStop?.(new Event("stop"));

    expect(nativeRecorder.stopCalls).toBe(1);
    expect(microphone.stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
    expect(recorder.getSnapshot()).toEqual({
      state: "idle",
      durationHint: "none",
      clientReportedDurationMs: null,
      recording: null
    });
    await expect(recorder.stop()).rejects.toMatchObject({ name: "InvalidStateError" });
  });

  it("can rerecord while the first stop is pending without mixing generations", async () => {
    let now = 1_000;
    const firstMicrophone = microphoneStream(1);
    const secondMicrophone = microphoneStream(1);
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(firstMicrophone.stream)
      .mockResolvedValueOnce(secondMicrophone.stream);
    const media = recorderFactory();
    const recorder = new BrowserAudioRecorder({
      getUserMedia,
      mediaRecorderFactory: media.factory,
      mediaRecorderIsTypeSupported: () => false,
      now: () => now
    });
    await recorder.start();
    const firstNativeRecorder = media.instances[0]!;
    firstNativeRecorder.emitData("first-generation");
    const lateData = firstNativeRecorder.ondataavailable;
    const lateStop = firstNativeRecorder.onstop;
    now = 1_500;
    const abandonedStop = recorder.stop();
    const abandonedAssertion = expect(abandonedStop).rejects.toMatchObject({
      name: "AbortError"
    });

    now = 2_000;
    await recorder.rerecord();
    await abandonedAssertion;
    lateData?.({ data: new Blob(["late-first-generation"]) } as BlobEvent);
    lateStop?.(new Event("stop"));

    const secondNativeRecorder = media.instances[1]!;
    secondNativeRecorder.emitData("second-generation|");
    now = 3_250;
    const secondStop = recorder.stop();
    secondNativeRecorder.emitData("final");
    secondNativeRecorder.finishStop();
    const result = await secondStop;

    expect(await readBlobAsText(result.blob)).toBe("second-generation|final");
    expect(result.clientReportedDurationMs).toBe(1_250);
    expect(firstMicrophone.stops[0]).toHaveBeenCalledTimes(1);
    expect(secondMicrophone.stops[0]).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("fences a cancelled permission request and remains reusable", async () => {
    const lateMicrophone = microphoneStream(1);
    const nextMicrophone = microphoneStream(1);
    const pendingMicrophone = deferred<MediaStream>();
    const getUserMedia = vi.fn()
      .mockImplementationOnce(() => pendingMicrophone.promise)
      .mockResolvedValueOnce(nextMicrophone.stream);
    const media = recorderFactory();
    const recorder = new BrowserAudioRecorder({
      getUserMedia,
      mediaRecorderFactory: media.factory,
      mediaRecorderIsTypeSupported: () => false
    });
    const starting = recorder.start();
    const startingAssertion = expect(starting).rejects.toMatchObject({
      name: "AbortError"
    });

    recorder.cancel();
    expect(recorder.getSnapshot().state).toBe("idle");
    pendingMicrophone.resolve(lateMicrophone.stream);
    await startingAssertion;
    expect(lateMicrophone.stops[0]).toHaveBeenCalledTimes(1);
    expect(media.factory).not.toHaveBeenCalled();

    await recorder.start();
    expect(recorder.getSnapshot().state).toBe("recording");
    recorder.cancel();
    expect(nextMicrophone.stops[0]).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("replaces a completed local recording when rerecording", async () => {
    const firstMicrophone = microphoneStream(1);
    const secondMicrophone = microphoneStream(1);
    const media = recorderFactory();
    const recorder = new BrowserAudioRecorder({
      getUserMedia: vi.fn()
        .mockResolvedValueOnce(firstMicrophone.stream)
        .mockResolvedValueOnce(secondMicrophone.stream),
      mediaRecorderFactory: media.factory,
      mediaRecorderIsTypeSupported: () => false
    });
    await recorder.start();
    const firstNativeRecorder = media.instances[0]!;
    const firstStop = recorder.stop();
    firstNativeRecorder.emitData("completed-first-recording");
    firstNativeRecorder.finishStop();
    const firstResult = await firstStop;
    expect(recorder.getSnapshot().recording).toBe(firstResult);

    await recorder.rerecord();

    expect(recorder.getSnapshot()).toMatchObject({
      state: "recording",
      recording: null
    });
    expect(media.instances).toHaveLength(2);
    recorder.cancel();
    expect(firstMicrophone.stops[0]).toHaveBeenCalledTimes(1);
    expect(secondMicrophone.stops[0]).toHaveBeenCalledTimes(1);
  });

  it("exposes the 150-second hint but keeps recording at 180 and 181 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const snapshots: BrowserAudioRecorderSnapshot[] = [];
    const microphone = microphoneStream(1);
    const media = recorderFactory();
    const recorder = new BrowserAudioRecorder({
      getUserMedia: vi.fn().mockResolvedValue(microphone.stream),
      mediaRecorderFactory: media.factory,
      mediaRecorderIsTypeSupported: () => false,
      now: () => Date.now(),
      onSnapshot: (snapshot) => snapshots.push(snapshot)
    });
    await recorder.start();
    const nativeRecorder = media.instances[0]!;

    await vi.advanceTimersByTimeAsync(149_999);
    expect(recorder.getSnapshot()).toMatchObject({
      state: "recording",
      durationHint: "none",
      clientReportedDurationMs: 149_999
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(recorder.getSnapshot()).toMatchObject({
      state: "recording",
      durationHint: "continue_or_finish",
      clientReportedDurationMs: 150_000
    });
    expect(snapshots).toContainEqual(expect.objectContaining({
      state: "recording",
      durationHint: "continue_or_finish"
    }));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(recorder.getSnapshot()).toMatchObject({
      state: "recording",
      clientReportedDurationMs: 180_000
    });
    expect(nativeRecorder.stopCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(recorder.getSnapshot()).toMatchObject({
      state: "recording",
      clientReportedDurationMs: 181_000
    });
    expect(nativeRecorder.stopCalls).toBe(0);

    const stopped = recorder.stop();
    nativeRecorder.emitData("181-seconds");
    nativeRecorder.finishStop();
    const result = await stopped;
    expect(result.clientReportedDurationMs).toBe(181_000);
    expect(result).not.toHaveProperty("processingProfile");
    expect(result).not.toHaveProperty("effectiveDurationMs");
  });

  it("releases tracks and rejects the pending result on a recorder error", async () => {
    const microphone = microphoneStream();
    const media = recorderFactory();
    const recorder = new BrowserAudioRecorder({
      getUserMedia: vi.fn().mockResolvedValue(microphone.stream),
      mediaRecorderFactory: media.factory,
      mediaRecorderIsTypeSupported: () => false
    });
    await recorder.start();

    media.instances[0]!.emitError();

    expect(recorder.getSnapshot().state).toBe("idle");
    expect(microphone.stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
    await expect(recorder.stop()).rejects.toMatchObject({ name: "InvalidStateError" });
  });

  it("disposes an active recorder exactly once and remains terminal", async () => {
    const microphone = microphoneStream();
    const media = recorderFactory();
    const recorder = new BrowserAudioRecorder({
      getUserMedia: vi.fn().mockResolvedValue(microphone.stream),
      mediaRecorderFactory: media.factory,
      mediaRecorderIsTypeSupported: () => false
    });
    await recorder.start();
    const nativeRecorder = media.instances[0]!;
    const lateData = nativeRecorder.ondataavailable;
    const lateStop = nativeRecorder.onstop;

    recorder.dispose();
    recorder.dispose();
    lateData?.({ data: new Blob(["late"]) } as BlobEvent);
    lateStop?.(new Event("stop"));

    expect(nativeRecorder.stopCalls).toBe(1);
    expect(microphone.stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
    expect(recorder.getSnapshot()).toEqual({
      state: "disposed",
      durationHint: "none",
      clientReportedDurationMs: null,
      recording: null
    });
    await expect(recorder.start()).rejects.toMatchObject({ name: "InvalidStateError" });
    await expect(recorder.rerecord()).rejects.toMatchObject({ name: "InvalidStateError" });
  });

  it("stops a microphone stream that arrives after disposal", async () => {
    const microphone = microphoneStream();
    const pendingMicrophone = deferred<MediaStream>();
    const media = recorderFactory();
    const recorder = new BrowserAudioRecorder({
      getUserMedia: vi.fn(() => pendingMicrophone.promise),
      mediaRecorderFactory: media.factory,
      mediaRecorderIsTypeSupported: () => false
    });
    const starting = recorder.start();
    const startingAssertion = expect(starting).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(recorder.getSnapshot().state).toBe("starting");

    recorder.dispose();
    pendingMicrophone.resolve(microphone.stream);
    await startingAssertion;

    expect(media.factory).not.toHaveBeenCalled();
    expect(microphone.stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
    expect(recorder.getSnapshot().state).toBe("disposed");
  });
});

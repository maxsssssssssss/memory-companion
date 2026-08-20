export const BROWSER_AUDIO_RECORDER_MIME_TYPES = Object.freeze([
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/webm"
] as const);

export const DEFAULT_BROWSER_AUDIO_RECORDER_TIMESLICE_MS = 1_000;
export const DEFAULT_BROWSER_AUDIO_RECORDER_HINT_AFTER_MS = 150_000;

export type BrowserAudioRecorderState =
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "ready"
  | "disposed";

/**
 * This hint is presentation state only. It never stops the recorder or selects
 * a processing profile.
 */
export type BrowserAudioRecorderDurationHint =
  | "none"
  | "continue_or_finish";

export type BrowserAudioRecording = Readonly<{
  blob: Blob;
  /**
   * A client-side, monotonic measurement for UI and audit metadata only. The
   * server must probe the persisted audio before making duration decisions.
   */
  clientReportedDurationMs: number;
}>;

export type BrowserAudioRecorderSnapshot = Readonly<{
  state: BrowserAudioRecorderState;
  durationHint: BrowserAudioRecorderDurationHint;
  clientReportedDurationMs: number | null;
  recording: BrowserAudioRecording | null;
}>;

export type BrowserAudioRecorderOptions = {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  mediaRecorderFactory?: (
    stream: MediaStream,
    options?: MediaRecorderOptions
  ) => MediaRecorder;
  mediaRecorderIsTypeSupported?: (mimeType: string) => boolean;
  now?: () => number;
  timesliceMs?: number;
  hintAfterMs?: number;
  onSnapshot?: (snapshot: BrowserAudioRecorderSnapshot) => void;
};

type RecorderSession = {
  generation: number;
  stream: MediaStream;
  recorder: MediaRecorder;
  requestedMimeType?: string;
  chunks: Blob[];
  startedAtMs: number;
  stoppedAtMs?: number;
  hintTimer?: ReturnType<typeof setTimeout>;
  tracksStopped: boolean;
  settled: boolean;
  completion: Promise<BrowserAudioRecording>;
  resolve: (recording: BrowserAudioRecording) => void;
  reject: (error: Error) => void;
};

const MICROPHONE_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true
  }
};

function unsupportedBrowserError() {
  return new DOMException(
    "This browser does not support microphone recording.",
    "NotSupportedError"
  );
}

function invalidStateError(message: string) {
  return new DOMException(message, "InvalidStateError");
}

function cancelledError() {
  return new DOMException("Browser audio recording was cancelled.", "AbortError");
}

function asError(error: unknown, fallbackMessage: string) {
  return error instanceof Error ? error : new Error(fallbackMessage);
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function stopTracks(stream: MediaStream) {
  let tracks: MediaStreamTrack[];
  try {
    tracks = stream.getTracks();
  } catch {
    return;
  }
  for (const track of new Set(tracks)) {
    try {
      track.stop();
    } catch {
      // Continue releasing the remaining tracks.
    }
  }
}

function defaultGetUserMedia(constraints: MediaStreamConstraints) {
  if (
    typeof navigator === "undefined"
    || !navigator.mediaDevices?.getUserMedia
  ) {
    return Promise.reject(unsupportedBrowserError());
  }
  return navigator.mediaDevices.getUserMedia(constraints);
}

/**
 * A browser-only, transport-neutral recording primitive.
 *
 * It periodically receives MediaRecorder chunks, then returns exactly one Blob
 * after the final dataavailable/onstop sequence. It intentionally has no
 * upload, QA, conversation, retrieval, or processing-profile behavior.
 */
export class BrowserAudioRecorder {
  private readonly getUserMedia: (
    constraints: MediaStreamConstraints
  ) => Promise<MediaStream>;
  private readonly injectedMediaRecorderFactory?: BrowserAudioRecorderOptions[
    "mediaRecorderFactory"
  ];
  private readonly injectedIsTypeSupported?: BrowserAudioRecorderOptions[
    "mediaRecorderIsTypeSupported"
  ];
  private readonly now: () => number;
  private readonly timesliceMs: number;
  private readonly hintAfterMs: number;
  private readonly onSnapshot?: BrowserAudioRecorderOptions["onSnapshot"];

  private recorderState: BrowserAudioRecorderState = "idle";
  private durationHint: BrowserAudioRecorderDurationHint = "none";
  private recording?: BrowserAudioRecording;
  private session?: RecorderSession;
  private generation = 0;

  constructor(options: BrowserAudioRecorderOptions = {}) {
    this.getUserMedia = options.getUserMedia ?? defaultGetUserMedia;
    this.injectedMediaRecorderFactory = options.mediaRecorderFactory;
    this.injectedIsTypeSupported = options.mediaRecorderIsTypeSupported;
    this.now = options.now ?? (() => performance.now());
    this.timesliceMs = positiveInteger(
      options.timesliceMs ?? DEFAULT_BROWSER_AUDIO_RECORDER_TIMESLICE_MS,
      "timesliceMs"
    );
    this.hintAfterMs = positiveInteger(
      options.hintAfterMs ?? DEFAULT_BROWSER_AUDIO_RECORDER_HINT_AFTER_MS,
      "hintAfterMs"
    );
    this.onSnapshot = options.onSnapshot;
  }

  getSnapshot(): BrowserAudioRecorderSnapshot {
    const activeDuration = this.session
      ? this.durationFor(this.session)
      : null;
    return {
      state: this.recorderState,
      durationHint: this.durationHint,
      clientReportedDurationMs:
        activeDuration ?? this.recording?.clientReportedDurationMs ?? null,
      recording: this.recording ?? null
    };
  }

  async start() {
    if (this.recorderState === "disposed") {
      throw invalidStateError("The browser audio recorder has been disposed.");
    }
    if (this.recorderState !== "idle") {
      throw invalidStateError("A browser audio recording is already active.");
    }

    const recorderBindings = this.resolveMediaRecorderBindings();
    const generation = ++this.generation;
    this.recording = undefined;
    this.durationHint = "none";
    this.setState("starting");
    if (!this.isCurrentGeneration(generation)) throw cancelledError();

    let stream: MediaStream;
    try {
      stream = await this.getUserMedia(MICROPHONE_CONSTRAINTS);
    } catch (error) {
      if (!this.isCurrentGeneration(generation)) throw cancelledError();
      this.setState("idle");
      throw error;
    }

    if (!this.isCurrentGeneration(generation)) {
      stopTracks(stream);
      throw cancelledError();
    }

    let selected: { recorder: MediaRecorder; requestedMimeType?: string };
    try {
      selected = this.createMediaRecorder(stream, recorderBindings);
    } catch (error) {
      stopTracks(stream);
      if (this.isCurrentGeneration(generation)) this.setState("idle");
      throw error;
    }

    let resolve!: (recording: BrowserAudioRecording) => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<BrowserAudioRecording>((resolveValue, rejectValue) => {
      resolve = resolveValue;
      reject = rejectValue;
    });
    // A recorder error can precede a caller's stop request. Attach a rejection
    // handler immediately while still returning the original promise from stop.
    void completion.catch(() => undefined);

    const session: RecorderSession = {
      generation,
      stream,
      recorder: selected.recorder,
      requestedMimeType: selected.requestedMimeType,
      chunks: [],
      startedAtMs: this.readNow(),
      tracksStopped: false,
      settled: false,
      completion,
      resolve,
      reject
    };
    this.session = session;
    this.attachRecorderEvents(session);

    try {
      session.recorder.start(this.timesliceMs);
    } catch (error) {
      this.failSession(
        session,
        asError(error, "Browser audio recording could not start."),
        "idle"
      );
      throw error;
    }

    session.hintTimer = setTimeout(() => {
      if (!this.isCurrentSession(session) || this.recorderState !== "recording") {
        return;
      }
      this.durationHint = "continue_or_finish";
      this.emitSnapshot();
    }, this.hintAfterMs);
    this.setState("recording");
  }

  stop(): Promise<BrowserAudioRecording> {
    const session = this.session;
    if (this.recorderState === "stopping" && session) {
      return session.completion;
    }
    if (this.recorderState !== "recording" || !session) {
      return Promise.reject(
        invalidStateError("No browser audio recording is active.")
      );
    }

    session.stoppedAtMs = this.readNow();
    this.clearHintTimer(session);
    this.durationHint = "none";
    this.setState("stopping");
    if (!this.isCurrentSession(session)) return session.completion;

    try {
      session.recorder.stop();
      this.stopSessionTracks(session);
    } catch (error) {
      this.failSession(
        session,
        asError(error, "Browser audio recording could not stop."),
        "idle"
      );
    }
    return session.completion;
  }

  cancel() {
    if (this.recorderState === "disposed") return;

    const session = this.session;
    if (session) this.abandonSession(session, cancelledError());
    ++this.generation;
    this.recording = undefined;
    this.durationHint = "none";
    if (this.recorderState !== "idle") this.setState("idle");
  }

  async rerecord() {
    if (this.recorderState === "disposed") {
      throw invalidStateError("The browser audio recorder has been disposed.");
    }
    this.cancel();
    await this.start();
  }

  dispose() {
    if (this.recorderState === "disposed") return;

    const session = this.session;
    if (session) this.abandonSession(session, cancelledError());
    ++this.generation;
    this.recording = undefined;
    this.durationHint = "none";
    this.setState("disposed");
  }

  private resolveMediaRecorderBindings() {
    const Constructor = globalThis.MediaRecorder;
    if (!this.injectedMediaRecorderFactory && typeof Constructor === "undefined") {
      throw unsupportedBrowserError();
    }

    const factory = this.injectedMediaRecorderFactory
      ?? ((stream: MediaStream, options?: MediaRecorderOptions) => (
        options
          ? new Constructor(stream, options)
          : new Constructor(stream)
      ));
    const isTypeSupported = this.injectedIsTypeSupported
      ?? ((mimeType: string) => (
        typeof Constructor?.isTypeSupported === "function"
          ? Constructor.isTypeSupported(mimeType)
          : false
      ));
    return { factory, isTypeSupported };
  }

  private createMediaRecorder(
    stream: MediaStream,
    bindings: ReturnType<BrowserAudioRecorder["resolveMediaRecorderBindings"]>
  ) {
    for (const mimeType of BROWSER_AUDIO_RECORDER_MIME_TYPES) {
      let supported = false;
      try {
        supported = bindings.isTypeSupported(mimeType);
      } catch {
        // A broken support probe should not prevent the browser-default attempt.
      }
      if (!supported) continue;
      try {
        return {
          recorder: bindings.factory(stream, { mimeType }),
          requestedMimeType: mimeType
        };
      } catch {
        // Some browsers report support but reject construction. Try the next
        // codec before falling back to their default MediaRecorder format.
      }
    }
    return { recorder: bindings.factory(stream) };
  }

  private attachRecorderEvents(session: RecorderSession) {
    session.recorder.ondataavailable = (event) => {
      if (!this.isCurrentSession(session) || event.data.size === 0) return;
      session.chunks.push(event.data);
    };
    session.recorder.onerror = () => {
      if (!this.isCurrentSession(session)) return;
      this.failSession(
        session,
        new Error("Browser audio recording failed."),
        "idle"
      );
    };
    session.recorder.onstop = () => {
      if (!this.isCurrentSession(session)) return;
      if (this.recorderState !== "stopping") {
        this.failSession(
          session,
          new Error("Browser audio recording stopped unexpectedly."),
          "idle"
        );
        return;
      }
      this.finishSession(session);
    };
  }

  private finishSession(session: RecorderSession) {
    let blob: Blob;
    try {
      blob = new Blob(session.chunks, {
        type:
          session.recorder.mimeType
          || session.requestedMimeType
          || session.chunks[0]?.type
          || "application/octet-stream"
      });
    } catch (error) {
      this.failSession(
        session,
        asError(error, "Browser audio recording could not be assembled."),
        "idle"
      );
      return;
    }

    const recording: BrowserAudioRecording = {
      blob,
      clientReportedDurationMs: this.durationFor(session)
    };
    this.clearHintTimer(session);
    this.stopSessionTracks(session);
    this.detachRecorderEvents(session);
    session.chunks.length = 0;
    this.session = undefined;
    this.recording = recording;
    session.settled = true;
    session.resolve(recording);
    this.setState("ready");
  }

  private failSession(
    session: RecorderSession,
    error: Error,
    nextState: Extract<BrowserAudioRecorderState, "idle" | "disposed">
  ) {
    if (!this.isCurrentSession(session)) return;
    this.clearHintTimer(session);
    this.detachRecorderEvents(session);
    if (session.recorder.state !== "inactive") {
      try {
        session.recorder.stop();
      } catch {
        // Track cleanup below is the authoritative release path.
      }
    }
    this.stopSessionTracks(session);
    session.chunks.length = 0;
    this.session = undefined;
    if (!session.settled) {
      session.settled = true;
      session.reject(error);
    }
    this.recording = undefined;
    this.durationHint = "none";
    this.setState(nextState);
  }

  private abandonSession(session: RecorderSession, error: Error) {
    if (!this.isCurrentSession(session)) return;
    this.clearHintTimer(session);
    this.detachRecorderEvents(session);
    session.chunks.length = 0;
    this.session = undefined;
    if (session.recorder.state !== "inactive") {
      try {
        session.recorder.stop();
      } catch {
        // Track cleanup below is the authoritative release path.
      }
    }
    this.stopSessionTracks(session);
    if (!session.settled) {
      session.settled = true;
      session.reject(error);
    }
  }

  private stopSessionTracks(session: RecorderSession) {
    if (session.tracksStopped) return;
    session.tracksStopped = true;
    stopTracks(session.stream);
  }

  private detachRecorderEvents(session: RecorderSession) {
    session.recorder.ondataavailable = null;
    session.recorder.onerror = null;
    session.recorder.onstop = null;
  }

  private clearHintTimer(session: RecorderSession) {
    if (session.hintTimer === undefined) return;
    clearTimeout(session.hintTimer);
    session.hintTimer = undefined;
  }

  private durationFor(session: RecorderSession) {
    const endedAtMs = session.stoppedAtMs ?? this.readNow();
    const elapsedMs = endedAtMs - session.startedAtMs;
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
    return Math.min(Number.MAX_SAFE_INTEGER, Math.round(elapsedMs));
  }

  private readNow() {
    const value = this.now();
    return Number.isFinite(value) ? value : 0;
  }

  private isCurrentGeneration(generation: number) {
    return this.generation === generation && this.recorderState !== "disposed";
  }

  private isCurrentSession(session: RecorderSession) {
    return this.session === session
      && this.generation === session.generation
      && this.recorderState !== "disposed";
  }

  private setState(state: BrowserAudioRecorderState) {
    this.recorderState = state;
    this.emitSnapshot();
  }

  private emitSnapshot() {
    try {
      this.onSnapshot?.(this.getSnapshot());
    } catch {
      // Observers cannot break microphone cleanup or recorder control flow.
    }
  }
}

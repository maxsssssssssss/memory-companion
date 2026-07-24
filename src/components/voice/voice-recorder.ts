export type VoiceRecorderPort = {
  start(): Promise<void>;
  stop(): Promise<Blob>;
  dispose(): void;
};

const RECORDER_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/webm"
] as const;

export function preferredRecorderMimeType() {
  if (typeof MediaRecorder === "undefined") return undefined;
  return RECORDER_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

function stopTracks(stream: MediaStream | undefined) {
  stream?.getTracks().forEach((track) => track.stop());
}

function unsupportedBrowserError() {
  return new DOMException("This browser does not support microphone recording.", "NotSupportedError");
}

export class BrowserVoiceRecorder implements VoiceRecorderPort {
  private mediaRecorder?: MediaRecorder;
  private stream?: MediaStream;
  private chunks: Blob[] = [];
  private stopPromise?: Promise<Blob>;
  private resolveStop?: (audio: Blob) => void;
  private rejectStop?: (error: Error) => void;
  private disposed = false;

  async start() {
    if (this.mediaRecorder) {
      throw new DOMException("A voice recording is already active.", "InvalidStateError");
    }
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw unsupportedBrowserError();
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    if (this.disposed) {
      stopTracks(stream);
      throw new DOMException("Voice recording was cancelled.", "AbortError");
    }

    const mimeType = preferredRecorderMimeType();
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);
    this.stream = stream;
    this.mediaRecorder = recorder;
    this.chunks = [];
    this.stopPromise = new Promise<Blob>((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
    });
    void this.stopPromise.catch(() => undefined);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    recorder.onerror = () => {
      this.finishWithError(new Error("Browser voice recording failed."));
    };
    recorder.onstop = () => {
      const audio = new Blob(this.chunks, {
        type: recorder.mimeType || mimeType || this.chunks[0]?.type || "application/octet-stream"
      });
      this.cleanupMedia();
      this.resolveStop?.(audio);
      this.clearStopCallbacks();
    };
    recorder.start();
  }

  async stop() {
    const recorder = this.mediaRecorder;
    const result = this.stopPromise;
    if (!recorder || !result) {
      throw new DOMException("No voice recording is active.", "InvalidStateError");
    }
    if (recorder.state !== "inactive") recorder.stop();
    return result;
  }

  dispose() {
    this.disposed = true;
    const recorder = this.mediaRecorder;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        this.cleanupMedia();
      }
    } else {
      this.cleanupMedia();
    }
    if (this.rejectStop) {
      this.finishWithError(new DOMException("Voice recording was cancelled.", "AbortError"));
    }
  }

  private finishWithError(error: Error) {
    this.cleanupMedia();
    this.rejectStop?.(error);
    this.clearStopCallbacks();
  }

  private cleanupMedia() {
    stopTracks(this.stream);
    if (this.mediaRecorder) {
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onerror = null;
      this.mediaRecorder.onstop = null;
    }
    this.stream = undefined;
    this.mediaRecorder = undefined;
  }

  private clearStopCallbacks() {
    this.resolveStop = undefined;
    this.rejectStop = undefined;
  }
}

import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserVoiceRecorder, preferredRecorderMimeType } from "./voice-recorder";

class FakeMediaRecorder {
  static isTypeSupported = vi.fn((type: string) => type === "audio/webm;codecs=opus");

  readonly mimeType: string;
  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;

  constructor(
    readonly stream: MediaStream,
    options?: MediaRecorderOptions
  ) {
    this.mimeType = options?.mimeType ?? "audio/webm";
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.ondataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) } as BlobEvent);
    this.state = "inactive";
    this.onstop?.(new Event("stop"));
  }
}

describe("BrowserVoiceRecorder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("selects a browser-supported recording format", () => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

    expect(preferredRecorderMimeType()).toBe("audio/webm;codecs=opus");
  });

  it("records a complete blob and stops every microphone track", async () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) }
    });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const recorder = new BrowserVoiceRecorder();

    await recorder.start();
    const audio = await recorder.stop();

    expect(audio.type).toBe("audio/webm;codecs=opus");
    expect(audio.size).toBeGreaterThan(0);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("surfaces microphone permission denial without leaving resources active", async () => {
    const denied = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockRejectedValue(denied) }
    });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const recorder = new BrowserVoiceRecorder();

    await expect(recorder.start()).rejects.toMatchObject({ name: "NotAllowedError" });
    recorder.dispose();
  });

  it("stops active microphone tracks during disposal", async () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) }
    });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const recorder = new BrowserVoiceRecorder();

    await recorder.start();
    recorder.dispose();

    expect(stop).toHaveBeenCalledTimes(1);
  });
});

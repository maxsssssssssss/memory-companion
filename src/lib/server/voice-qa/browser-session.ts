import type { JsonStore } from "@/lib/server/storage/json-store";
import type { VoiceQaContext } from "@/lib/domain/voice-qa-context";
import {
  BROWSER_VOICE_MAX_INPUT_BYTES,
  convertBrowserAudioToPcm16,
  streamBrowserPcmToVoiceBridge,
  summarizeBrowserVoicePcm
} from "@/lib/server/voice/browser-audio";
import { DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT } from "@/lib/server/voice/audio";
import { logVoiceDebug, voiceDebugEnabled } from "@/lib/server/voice/debug";
import { createVoiceProvider } from "@/lib/server/voice/provider";
import type { VoiceProvider, VoiceUnsubscribe } from "@/lib/server/voice/types";

import {
  createMemoryVoiceQaAnswerer,
  type CreateMemoryVoiceQaAnswererOptions,
  type MemoryVoiceQaScope
} from "./adapter";
import type { VoiceAnswerMode } from "./answer-strategy";
import { VoiceQaBridge, type VoiceQaBridgeOptions } from "./bridge";
import type { VoiceSessionTraceRecorder } from "./trace";
import type {
  VoiceQaAnswerer,
  VoiceQaConversationMessage,
  VoiceQAResponse,
  VoiceQaSessionSnapshot
} from "./types";

export const MAX_BROWSER_VOICE_AUDIO_BYTES = BROWSER_VOICE_MAX_INPUT_BYTES;
// Accommodates a 60-second push-to-talk upload plus the bounded ASR (30s),
// QA (60s), and TTS (60s) recovery windows with modest conversion overhead.
export const DEFAULT_BROWSER_VOICE_RESPONSE_TIMEOUT_MS = 240_000;
export const DEFAULT_BROWSER_VOICE_ASR_TIMEOUT_MS = 30_000;

const MIN_RESPONSE_TIMEOUT_MS = 1_000;
const MAX_RESPONSE_TIMEOUT_MS = 300_000;

export type BrowserVoiceQaSessionInput = {
  audio: Buffer;
  mimeType: string;
  userId: string;
  store: JsonStore;
  scope: MemoryVoiceQaScope;
  answerMode?: VoiceAnswerMode;
  uploadId?: string;
  referenceDate?: Date;
  context?: VoiceQaContext;
  signal?: AbortSignal;
  responseTimeoutMs?: number;
  asrTimeoutMs?: number;
  trace?: VoiceSessionTraceRecorder;
  applicationSessionId?: string;
  conversation?: VoiceQaConversationMessage[];
  onLifecycleStateChange?: VoiceQaBridgeOptions["onLifecycleStateChange"];
  onTurnCompleted?: VoiceQaBridgeOptions["onTurnCompleted"];
  onStreamingEvent?: VoiceQaBridgeOptions["onStreamingEvent"];
};

export type BrowserVoiceQaSessionResult = {
  response: VoiceQAResponse;
  session: VoiceQaSessionSnapshot;
};

export interface BrowserVoiceQaBridgeLike {
  start(): Promise<VoiceQaSessionSnapshot>;
  sendAudio(chunk: Buffer): Promise<void>;
  finishAudioInput(): Promise<void>;
  onResponse(listener: (response: VoiceQAResponse) => void): VoiceUnsubscribe;
  handleAsrTimeout?(): Promise<VoiceQAResponse | null>;
  abort?(): Promise<void>;
  close(): Promise<void>;
  snapshot(): VoiceQaSessionSnapshot;
}

export type BrowserVoiceQaSessionDependencies = {
  createVoiceProvider: () => VoiceProvider;
  createMemoryVoiceQaAnswerer: (options: CreateMemoryVoiceQaAnswererOptions) => VoiceQaAnswerer;
  createBridge: (options: VoiceQaBridgeOptions) => BrowserVoiceQaBridgeLike;
  convertBrowserAudioToPcm16: typeof convertBrowserAudioToPcm16;
  streamBrowserPcmToVoiceBridge: typeof streamBrowserPcmToVoiceBridge;
};

export type BrowserVoiceQaSessionErrorCode = "request_aborted" | "response_timeout";

export class BrowserVoiceQaSessionError extends Error {
  constructor(
    readonly code: BrowserVoiceQaSessionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "BrowserVoiceQaSessionError";
  }
}

function responseTimeoutMs(value: number | undefined) {
  const timeoutMs = value ?? DEFAULT_BROWSER_VOICE_RESPONSE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_RESPONSE_TIMEOUT_MS ||
    timeoutMs > MAX_RESPONSE_TIMEOUT_MS
  ) {
    throw new BrowserVoiceQaSessionError(
      "response_timeout",
      `Browser Voice QA response timeout must be between ${MIN_RESPONSE_TIMEOUT_MS} and ${MAX_RESPONSE_TIMEOUT_MS}ms`
    );
  }
  return timeoutMs;
}

function asrTimeoutMs(value: number | undefined) {
  const timeoutMs = value ?? DEFAULT_BROWSER_VOICE_ASR_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_RESPONSE_TIMEOUT_MS ||
    timeoutMs > MAX_RESPONSE_TIMEOUT_MS
  ) {
    throw new BrowserVoiceQaSessionError(
      "response_timeout",
      `Browser Voice QA ASR timeout must be between ${MIN_RESPONSE_TIMEOUT_MS} and ${MAX_RESPONSE_TIMEOUT_MS}ms`
    );
  }
  return timeoutMs;
}

async function waitForResponseWithAsrTimeout(
  response: Promise<VoiceQAResponse>,
  bridge: BrowserVoiceQaBridgeLike,
  timeoutMs: number
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      response,
      new Promise<VoiceQAResponse>((resolve, reject) => {
        timeout = setTimeout(() => {
          if (!bridge.handleAsrTimeout) {
            reject(new BrowserVoiceQaSessionError(
              "response_timeout",
              `Browser Voice QA ASR did not finish within ${timeoutMs}ms`
            ));
            return;
          }
          void bridge.handleAsrTimeout().then((fallback) => {
            if (fallback) resolve(fallback);
            // A null result means ASR has already finalized (the bridge has
            // advanced to QA/TTS) or the bridge is closing. In that case the
            // ASR deadline no longer owns the turn; keep waiting on the main
            // response promise, which remains bounded by the session deadline.
          }, reject);
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function createDeadline(inputSignal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let failure: BrowserVoiceQaSessionError | undefined;
  const abort = (error: BrowserVoiceQaSessionError) => {
    if (controller.signal.aborted) return;
    failure = error;
    controller.abort(error);
  };
  const onInputAbort = () => abort(new BrowserVoiceQaSessionError(
    "request_aborted",
    "Browser Voice QA request was aborted"
  ));
  inputSignal?.addEventListener("abort", onInputAbort, { once: true });
  if (inputSignal?.aborted) onInputAbort();
  const timeout = setTimeout(() => abort(new BrowserVoiceQaSessionError(
    "response_timeout",
    `Browser Voice QA did not finish within ${timeoutMs}ms`
  )), timeoutMs);

  return {
    signal: controller.signal,
    failure: () => failure,
    cleanup() {
      clearTimeout(timeout);
      inputSignal?.removeEventListener("abort", onInputAbort);
    }
  };
}

function waitForResponse(bridge: BrowserVoiceQaBridgeLike, signal: AbortSignal) {
  let unsubscribe: VoiceUnsubscribe = () => undefined;
  let settled = false;
  const promise = new Promise<VoiceQAResponse>((resolve, reject) => {
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => settle(() => reject(
      signal.reason instanceof Error
        ? signal.reason
        : new BrowserVoiceQaSessionError("request_aborted", "Browser Voice QA request was aborted")
    ));
    signal.addEventListener("abort", onAbort, { once: true });
    unsubscribe = bridge.onResponse((response) => settle(() => resolve(response)));
    if (signal.aborted) onAbort();
  });

  // A conversion/start/stream error may win the operation before this waiter.
  // Attach a rejection observer so an abort cannot become an unhandled rejection.
  void promise.catch(() => undefined);
  return {
    promise,
    unsubscribe: () => unsubscribe()
  };
}

const defaultDependencies: BrowserVoiceQaSessionDependencies = {
  createVoiceProvider: () => createVoiceProvider(),
  createMemoryVoiceQaAnswerer,
  createBridge: (options) => new VoiceQaBridge(options),
  convertBrowserAudioToPcm16,
  streamBrowserPcmToVoiceBridge
};

/**
 * Runs exactly one push-to-talk recording through the existing Voice QA stack.
 * The Provider connection is turn-scoped and is always closed before returning.
 */
export async function runBrowserVoiceQaSession(
  input: BrowserVoiceQaSessionInput,
  overrides: Partial<BrowserVoiceQaSessionDependencies> = {}
): Promise<BrowserVoiceQaSessionResult> {
  if (input.signal?.aborted) {
    throw new BrowserVoiceQaSessionError("request_aborted", "Browser Voice QA request was aborted");
  }
  const dependencies = { ...defaultDependencies, ...overrides };
  const timeoutMs = responseTimeoutMs(input.responseTimeoutMs);
  const recognitionTimeoutMs = asrTimeoutMs(input.asrTimeoutMs);
  const deadline = createDeadline(input.signal, timeoutMs);
  let bridge: BrowserVoiceQaBridgeLike | undefined;
  let waiter: ReturnType<typeof waitForResponse> | undefined;
  let response: VoiceQAResponse | undefined;

  try {
    const pcm = await dependencies.convertBrowserAudioToPcm16({
      audio: input.audio,
      mimeType: input.mimeType,
      signal: deadline.signal
    });
    if (deadline.failure()) throw deadline.failure();
    const pcmDiagnostics = voiceDebugEnabled() ? summarizeBrowserVoicePcm(pcm) : undefined;

    const answererOptions: CreateMemoryVoiceQaAnswererOptions = {
      userId: input.userId,
      store: input.store,
      scope: input.scope,
      ...(input.answerMode ? { answerMode: input.answerMode } : {}),
      ...(input.uploadId ? { uploadId: input.uploadId } : {}),
      ...(input.referenceDate ? { referenceDate: input.referenceDate } : {}),
      ...(input.context ? { context: input.context } : {})
    };
    const provider = dependencies.createVoiceProvider();
    const answerer = dependencies.createMemoryVoiceQaAnswerer(answererOptions);
    bridge = dependencies.createBridge({
      provider,
      answerer,
      userId: input.userId,
      scope: input.scope,
      ...(input.uploadId ? { uploadId: input.uploadId } : {}),
      responseMode: "VOICE",
      ...(input.applicationSessionId
        ? { applicationSessionId: input.applicationSessionId }
        : {}),
      ...(input.conversation ? { initialConversation: input.conversation } : {}),
      ...(input.onLifecycleStateChange
        ? { onLifecycleStateChange: input.onLifecycleStateChange }
        : {}),
      ...(input.onTurnCompleted ? { onTurnCompleted: input.onTurnCompleted } : {}),
      ...(input.onStreamingEvent ? {
        onStreamingEvent: input.onStreamingEvent,
        streamingSignal: deadline.signal
      } : {}),
      ...(input.trace ? { trace: input.trace } : {}),
      sessionConfig: {
        inputMode: "push_to_talk",
        audioOutput: {
          format: "pcm_s16le",
          sampleRate: DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT.sampleRate,
          channels: DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT.channels
        }
      }
    });
    waiter = waitForResponse(bridge, deadline.signal);
    const session = await bridge.start();
    input.trace?.setProviderSessionId(session.id);
    if (deadline.failure()) throw deadline.failure();

    input.trace?.mark("speech_started");
    try {
      const stream = await dependencies.streamBrowserPcmToVoiceBridge(pcm, bridge, {
        signal: deadline.signal
      });
      if (pcmDiagnostics) {
        logVoiceDebug("browser_pcm_stream_completed", {
          duration_ms: Math.round(stream.durationMs),
          pcm_bytes: stream.bytesSent,
          packet_count: stream.packetCount,
          peak_dbfs: pcmDiagnostics.peakDbfs,
          rms_dbfs: pcmDiagnostics.rmsDbfs,
          non_silent_ratio: pcmDiagnostics.nonSilentRatio,
          likely_silent: pcmDiagnostics.likelySilent
        });
      }
      await bridge.finishAudioInput();
    } catch (error) {
      throw deadline.failure() ?? error;
    } finally {
      input.trace?.mark("speech_ended");
    }
    response = await waitForResponseWithAsrTimeout(
      waiter.promise,
      bridge,
      recognitionTimeoutMs
    );
  } finally {
    waiter?.unsubscribe();
    const deadlineFailure = deadline.failure();
    deadline.cleanup();
    if (bridge) {
      if (deadlineFailure) {
        if (bridge.abort) {
          await bridge.abort().catch(() => undefined);
        } else {
          // Compatibility path for bridge implementations that predate hard abort.
          // Do not let their potentially draining close extend the request deadline.
          void bridge.close().catch(() => undefined);
        }
      } else {
        await bridge.close().catch(() => undefined);
      }
    }
    await input.trace?.flush();
  }

  if (!response || !bridge) {
    throw new BrowserVoiceQaSessionError("response_timeout", "Browser Voice QA returned no response");
  }
  return {
    response,
    session: bridge.snapshot()
  };
}

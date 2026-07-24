import { VoiceEvent, type ParsedVoiceServerEvent } from "./events";
import type { VoiceProvider, VoiceSessionConfig, VoiceUnsubscribe } from "./types";
import { VoiceProviderError } from "./types";

export type VoiceTextToSpeechResult = {
  sessionId: string;
  dialogId?: string;
  audio: Buffer;
  connectLatencyMs: number;
  ttsLatencyMs: number;
};

export type VoiceTextSessionOptions = {
  provider: VoiceProvider;
  sessionConfig?: VoiceSessionConfig;
  turnTimeoutMs?: number;
  now?: () => number;
};

const DEFAULT_TURN_TIMEOUT_MS = 120_000;

function providerFailure(event: ParsedVoiceServerEvent) {
  return (
    event.errorCode !== undefined ||
    event.eventId === VoiceEvent.ConnectionFailed ||
    event.eventId === VoiceEvent.SessionFailed ||
    event.eventId === VoiceEvent.DialogCommonError
  );
}

function waitForTtsEnd(
  provider: VoiceProvider,
  timeoutMs: number,
  sessionId: string
): { promise: Promise<void>; unsubscribe: () => void } {
  let unsubscribe: VoiceUnsubscribe = () => undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    const finish = (action: () => void) => {
      if (timeout) clearTimeout(timeout);
      unsubscribe();
      action();
    };
    unsubscribe = provider.onEvent((event) => {
      if (event.eventId === VoiceEvent.TTSEnded && event.sessionId === sessionId) {
        finish(resolve);
      } else if (providerFailure(event)) {
        finish(() => reject(new VoiceProviderError(
          "provider_error",
          `Volcengine voice event ${event.eventName} failed`,
          event.errorCode
        )));
      }
    });
    timeout = setTimeout(() => {
      finish(() => reject(new VoiceProviderError("timeout", `Voice TTS did not finish within ${timeoutMs}ms`)));
    }, timeoutMs);
  });
  return { promise, unsubscribe: () => unsubscribe() };
}

export async function synthesizeVoiceText(
  text: string,
  options: VoiceTextSessionOptions
): Promise<VoiceTextToSpeechResult> {
  const normalizedText = text.trim();
  if (!normalizedText) {
    throw new VoiceProviderError("invalid_request", "Voice text must not be empty");
  }
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs < 1_000 || turnTimeoutMs > 300_000) {
    throw new VoiceProviderError("invalid_configuration", "Voice turn timeout must be between 1000 and 300000ms");
  }

  const now = options.now ?? Date.now;
  const audioChunks: Buffer[] = [];
  const unsubscribeAudio = options.provider.onAudio((audio) => {
    if (audio.byteLength > 0) audioChunks.push(Buffer.from(audio));
  });
  let turnWaiter: ReturnType<typeof waitForTtsEnd> | undefined;

  try {
    const connectStartedAt = now();
    await options.provider.connect();
    const connectLatencyMs = Math.max(0, now() - connectStartedAt);
    const session = await options.provider.startSession(options.sessionConfig);

    turnWaiter = waitForTtsEnd(options.provider, turnTimeoutMs, session.sessionId);
    const ttsStartedAt = now();
    await options.provider.sendText(normalizedText);
    await turnWaiter.promise;
    const ttsLatencyMs = Math.max(0, now() - ttsStartedAt);

    if (audioChunks.length === 0) {
      throw new VoiceProviderError("protocol_error", "Voice provider ended TTS without returning audio");
    }

    await options.provider.finishSession();
    return {
      sessionId: session.sessionId,
      ...(session.dialogId ? { dialogId: session.dialogId } : {}),
      audio: Buffer.concat(audioChunks),
      connectLatencyMs,
      ttsLatencyMs
    };
  } finally {
    turnWaiter?.unsubscribe();
    unsubscribeAudio();
    await options.provider.close().catch(() => undefined);
  }
}

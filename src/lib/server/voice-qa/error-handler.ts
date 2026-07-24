import type { VoiceProvider, VoiceSessionInfo } from "@/lib/server/voice/types";
import { VoiceProviderError } from "@/lib/server/voice/types";

export const VOICE_ERROR_CODES = [
  "VOICE_ASR_TIMEOUT",
  "VOICE_QA_TIMEOUT",
  "VOICE_TTS_FAILED",
  "VOICE_CONNECTION_LOST"
] as const;

export type VoiceErrorCode = (typeof VOICE_ERROR_CODES)[number];

export type VoiceRecoveryDecision = {
  code: VoiceErrorCode;
  message: string;
  preserveSession: boolean;
  returnText: boolean;
  reconnectRecommended: boolean;
};

export type ReconnectableVoiceProvider = VoiceProvider & {
  reconnect?: () => Promise<VoiceSessionInfo>;
};

export type VoiceErrorHandlerOptions = {
  maxReconnectAttempts?: number;
};

const ASR_TIMEOUT_MESSAGE = "没听清楚，可以再说一遍吗？";
const QA_TIMEOUT_MESSAGE = "这次查询稍微超时了。你可以再问一次，我会接着刚才的话题。";
const QA_TIMEOUT_WITHOUT_CONTEXT_MESSAGE = "暂时没能查到相关记录，可以再问一次吗？";
const CONNECTION_LOST_MESSAGE = "语音连接中断了，这段会话还保留着。请再试一次。";

function boundedReconnectAttempts(value: number | undefined) {
  const attempts = value ?? 1;
  if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts > 3) {
    throw new VoiceProviderError(
      "invalid_configuration",
      "Voice reconnect attempts must be an integer between 0 and 3"
    );
  }
  return attempts;
}
export function isVoiceConnectionLoss(error: unknown) {
  return error instanceof VoiceProviderError && (
    error.reason === "connection_closed" || error.reason === "connection_failed"
  );
}

/**
 * Centralizes user-safe, deterministic degradation decisions. It never reads
 * provider payloads and never invents an answer from conversation history.
 */
export class VoiceErrorHandler {
  private readonly maxReconnectAttempts: number;

  constructor(options: VoiceErrorHandlerOptions = {}) {
    this.maxReconnectAttempts = boundedReconnectAttempts(options.maxReconnectAttempts);
  }

  asrTimeout(): VoiceRecoveryDecision {
    return {
      code: "VOICE_ASR_TIMEOUT",
      message: ASR_TIMEOUT_MESSAGE,
      preserveSession: true,
      returnText: true,
      reconnectRecommended: false
    };
  }

  qaTimeout(hasConversationContext: boolean): VoiceRecoveryDecision {
    return {
      code: "VOICE_QA_TIMEOUT",
      message: hasConversationContext
        ? QA_TIMEOUT_MESSAGE
        : QA_TIMEOUT_WITHOUT_CONTEXT_MESSAGE,
      preserveSession: true,
      returnText: true,
      reconnectRecommended: false
    };
  }

  ttsFailed(textResponse: string): VoiceRecoveryDecision {
    const normalized = textResponse.trim();
    return {
      code: "VOICE_TTS_FAILED",
      message: normalized || QA_TIMEOUT_WITHOUT_CONTEXT_MESSAGE,
      preserveSession: true,
      returnText: true,
      reconnectRecommended: false
    };
  }

  connectionLost(): VoiceRecoveryDecision {
    return {
      code: "VOICE_CONNECTION_LOST",
      message: CONNECTION_LOST_MESSAGE,
      preserveSession: true,
      returnText: true,
      reconnectRecommended: true
    };
  }

  async reconnect(
    provider: ReconnectableVoiceProvider,
    onRestored?: (session: VoiceSessionInfo) => void | Promise<void>
  ): Promise<VoiceSessionInfo | null> {
    if (!provider.reconnect || this.maxReconnectAttempts === 0) return null;

    for (let attempt = 0; attempt < this.maxReconnectAttempts; attempt += 1) {
      try {
        const session = await provider.reconnect();
        await onRestored?.(session);
        return session;
      } catch {
        // A bounded reconnect is best effort. The caller owns graceful fallback.
      }
    }
    return null;
  }
}

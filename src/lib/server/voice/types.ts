import type { ParsedVoiceServerEvent } from "./events";

export type VoiceAudioOutputConfig =
  | {
      format: "provider_default";
    }
  | {
      format: "pcm_s16le";
      sampleRate?: number;
      channels?: number;
    };

export type VoiceSessionConfig = {
  model?: "1.2.1.1" | "2.2.0.0";
  inputMode?: "text" | "server_vad" | "push_to_talk" | "audio_file" | "keep_alive";
  speaker?: string;
  audioOutput?: VoiceAudioOutputConfig;
  vad?: {
    endSmoothWindowMs?: number;
    enableCustomVad?: boolean;
  };
  dialog?: {
    botName?: string;
    systemRole?: string;
    speakingStyle?: string;
    dialogId?: string;
    enableConversationTruncate?: boolean;
    context?: Array<{
      role: "user" | "assistant";
      text: string;
      timestamp?: number;
    }>;
  };
};

export type VoiceSessionInfo = {
  sessionId: string;
  dialogId?: string;
};

export type VoiceUnsubscribe = () => void;

export type VoiceExternalRagItem = {
  title: string;
  content: string;
};

export interface VoiceProvider {
  connect(): Promise<void>;
  startSession(config?: VoiceSessionConfig): Promise<VoiceSessionInfo>;
  reconnect?(): Promise<VoiceSessionInfo>;
  sendAudio(chunk: Buffer): Promise<void>;
  finishAudioInput(): Promise<void>;
  /** Cancels the active Provider-side response/TTS turn without closing the session. */
  cancelSessionTurn?(): Promise<void>;
  interruptResponse?(): Promise<void>;
  sendExternalRag?(items: readonly VoiceExternalRagItem[]): Promise<void>;
  truncateConversation?(itemId: string, audioEndMs: number): Promise<void>;
  sendText(text: string): Promise<void>;
  finishSession(): Promise<void>;
  onTranscript(callback: (text: string) => void): VoiceUnsubscribe;
  onAudio(callback: (audio: Buffer) => void): VoiceUnsubscribe;
  onEvent(callback: (event: ParsedVoiceServerEvent) => void): VoiceUnsubscribe;
  close(): Promise<void>;
}

export type VoiceProviderErrorReason =
  | "invalid_configuration"
  | "invalid_state"
  | "invalid_request"
  | "connection_failed"
  | "connection_closed"
  | "provider_error"
  | "protocol_error"
  | "timeout";

export class VoiceProviderError extends Error {
  constructor(
    readonly reason: VoiceProviderErrorReason,
    message: string,
    readonly providerCode?: number
  ) {
    super(message);
    this.name = "VoiceProviderError";
  }
}

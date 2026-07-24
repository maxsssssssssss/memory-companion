import type { QuestionAnswer } from "@/lib/domain/types";
import type {
  QaAnswerMode,
  QaExecutionDiagnostics
} from "@/lib/server/retrieval/qa-observability";
import type { QaAnswerStreamEvent } from "@/lib/server/retrieval/qa-streaming";

export type VoiceQaSessionState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "closed";

export type VoiceQaResponseMode = "TEXT" | "VOICE";

export type VoiceQaConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type VoiceQARequest = {
  sessionId: string;
  transcript: string;
  userId?: string;
  scope?: "current" | "week" | "all";
  uploadId?: string;
  conversation?: VoiceQaConversationMessage[];
  mode?: VoiceQaResponseMode;
  /** Internal observer; it never changes retrieval ranking or the public QA shape. */
  onRetrievedMemoryIds?: (memoryIds: string[]) => void;
  /** Internal, content-free execution diagnostics for observability only. */
  onQaDiagnostics?: (diagnostics: QaExecutionDiagnostics) => void;
  /**
   * Internal safe-stream observer. Raw token events are never forwarded; the
   * adapter releases each independently grounded sentence as soon as Sentence
   * Commit validates it, followed by the final full-answer event.
   */
  onQaStreamEvent?: (
    event: Extract<QaAnswerStreamEvent, { type: "sentence_completed" | "final" }>
  ) => void | Promise<void>;
};

export type VoiceQaError =
  | "asr_failed"
  | "qa_failed"
  | "tts_failed"
  | "connection_lost";

export type VoiceQAResponse = {
  sessionId: string;
  transcript: string;
  mode: VoiceQaResponseMode;
  text: string;
  answer?: QuestionAnswer;
  audio?: Buffer;
  /** Audio was delivered through the bounded streaming callback, not this object. */
  streamedAudio?: boolean;
  errors?: VoiceQaError[];
  errorCodes?: import("./error-handler").VoiceErrorCode[];
};

export type VoiceQaTranscriptFinality = "partial" | "final" | "unknown";

export type VoiceQaTranscriptUpdate = {
  transcript: string;
  finality: VoiceQaTranscriptFinality;
  sessionId?: string;
};

export interface VoiceQaAnswerer {
  readonly answerMode?: QaAnswerMode;
  answer(request: VoiceQARequest): Promise<QuestionAnswer | null>;
}

export type VoiceQaSessionHistoryEntry = {
  from: VoiceQaSessionState | null;
  to: VoiceQaSessionState;
  at: string;
};

export type VoiceQaSessionSnapshot = {
  id: string;
  state: VoiceQaSessionState;
  userId?: string;
  startedAt: string;
  history: VoiceQaSessionHistoryEntry[];
};

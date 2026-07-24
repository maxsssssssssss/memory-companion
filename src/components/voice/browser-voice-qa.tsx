"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  VoiceAudioQueue,
  type VoiceAudioQueueOptions
} from "@/lib/client/voice-audio-queue";
import { parseVoiceBrowserNdjsonStream } from "@/lib/client/voice-ndjson-stream";
import type { VoiceQaContext } from "@/lib/domain/voice-qa-context";
import {
  VoiceBrowserAnswerMetadataSchema,
  type VoiceBrowserAnswerMetadata
} from "@/lib/voice-browser-stream";
import { VoicePlayer } from "./voice-player";
import { VoiceQAButton } from "./voice-qa-button";
import { BrowserVoiceRecorder, type VoiceRecorderPort } from "./voice-recorder";
import { VoiceSessionStatus, type BrowserVoiceQaState } from "./voice-session-status";

type VoiceQaScope = "current" | "week" | "all";
type BrowserVoiceAnswerMode = "agent" | "direct";
type BrowserVoiceTraceOutcome = "completed" | "failed" | "aborted";
type BrowserVoiceStreamStatus = "completed" | "completed_with_errors" | "failed" | "aborted";

type BrowserVoiceQaResponse = {
  conversationSessionId?: string;
  traceId?: string;
  sessionId: string;
  transcript: string;
  text: string;
  audioBase64?: string;
  audioMimeType?: string;
  answer?: VoiceBrowserAnswerMetadata;
  errors?: string[];
};

export type BrowserVoiceQaConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type BrowserVoiceQaCompletedTurn = {
  id: string;
  question: string;
  answer: string;
  citedSegmentIds: string[];
  citations: VoiceBrowserAnswerMetadata["citations"];
};

type BrowserVoiceAudioQueue = Pick<
  VoiceAudioQueue,
  "prepare" | "enqueue" | "finish" | "cancel"
>;

type BrowserVoiceAudioQueueFactory = (
  options: VoiceAudioQueueOptions
) => BrowserVoiceAudioQueue;

type BrowserVoiceQaProps = {
  answerMode?: BrowserVoiceAnswerMode;
  variant?: "card" | "composer";
  scope?: VoiceQaScope;
  uploadId?: string;
  referenceDate?: string;
  context?: VoiceQaContext;
  conversation?: readonly BrowserVoiceQaConversationMessage[];
  onTurnCompleted?: (turn: BrowserVoiceQaCompletedTurn) => void;
  onStateChange?: (state: BrowserVoiceQaState) => void;
  onErrorMessage?: (message: string) => void;
  disabled?: boolean;
  maxRecordingMs?: number;
  disabledReason?: string;
  recorderFactory?: () => VoiceRecorderPort;
  audioQueueFactory?: BrowserVoiceAudioQueueFactory;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

const DEFAULT_MAX_RECORDING_MS = 60_000;
const TRACE_TELEMETRY_MAX_ATTEMPTS = 3;
const TRACE_TELEMETRY_RETRY_DELAY_MS = 150;
const defaultVoiceQaFetcher = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);
const defaultAudioQueueFactory: BrowserVoiceAudioQueueFactory = (options) => (
  new VoiceAudioQueue(options)
);

function waitForTraceRetry(attempt: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, TRACE_TELEMETRY_RETRY_DELAY_MS * (2 ** attempt));
  });
}

function microphoneErrorMessage(error: unknown) {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return "没有麦克风权限，请在浏览器设置中允许访问。";
  }
  if (error instanceof Error && error.name === "NotAllowedError") {
    return "没有麦克风权限，请在浏览器设置中允许访问。";
  }
  if (error instanceof Error && error.name === "NotFoundError") {
    return "没有找到可用的麦克风。";
  }
  return "暂时无法启动麦克风，请检查浏览器设置。";
}

function voiceQaResponse(value: unknown): BrowserVoiceQaResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<BrowserVoiceQaResponse>;
  if (
    typeof candidate.sessionId !== "string" ||
    typeof candidate.transcript !== "string" ||
    typeof candidate.text !== "string" ||
    (candidate.conversationSessionId !== undefined && typeof candidate.conversationSessionId !== "string") ||
    (candidate.traceId !== undefined && typeof candidate.traceId !== "string")
  ) {
    return null;
  }
  const parsedAnswer = candidate.answer === undefined
    ? undefined
    : VoiceBrowserAnswerMetadataSchema.safeParse(candidate.answer);
  if (parsedAnswer && !parsedAnswer.success) return null;
  return {
    ...candidate,
    ...(parsedAnswer?.success ? { answer: parsedAnswer.data } : {})
  } as BrowserVoiceQaResponse;
}

function errorPayloadMessage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" && error.trim() ? error.trim() : undefined;
}

function recordingFileName(type: string) {
  if (type.includes("wav")) return "voice-question.wav";
  if (type.includes("ogg")) return "voice-question.ogg";
  if (type.includes("mp4")) return "voice-question.m4a";
  return "voice-question.webm";
}

function decodeBase64Audio(value: string) {
  const decoded = globalThis.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function traceOutcomeForStream(status: BrowserVoiceStreamStatus): BrowserVoiceTraceOutcome {
  if (status === "completed") return "completed";
  if (status === "aborted") return "aborted";
  return "failed";
}

export function BrowserVoiceQa({
  answerMode = "agent",
  variant = "card",
  scope = "all",
  uploadId,
  referenceDate,
  context,
  conversation,
  onTurnCompleted,
  onStateChange,
  onErrorMessage,
  disabled = false,
  maxRecordingMs = DEFAULT_MAX_RECORDING_MS,
  disabledReason,
  recorderFactory = () => new BrowserVoiceRecorder(),
  audioQueueFactory = defaultAudioQueueFactory,
  fetcher = defaultVoiceQaFetcher
}: BrowserVoiceQaProps) {
  const headingId = useId();
  const [state, setState] = useState<BrowserVoiceQaState>("idle");
  const [isStarting, setIsStarting] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [playback, setPlayback] = useState<{
    id: string;
    base64: string;
    mimeType: string;
    outcome?: BrowserVoiceTraceOutcome;
    completionMessage?: string;
  }>();
  const stateRef = useRef<BrowserVoiceQaState>("idle");
  const startingRef = useRef(false);
  const mountedRef = useRef(true);
  const recorderRef = useRef<VoiceRecorderPort | undefined>(undefined);
  const audioQueueRef = useRef<BrowserVoiceAudioQueue | undefined>(undefined);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeTraceIdRef = useRef<string | undefined>(undefined);
  const conversationSessionIdRef = useRef<string | undefined>(undefined);
  const traceTerminalRef = useRef(false);
  const audioPlayReportedRef = useRef(false);
  const telemetryTailRef = useRef<Promise<void>>(Promise.resolve());
  const stopRecordingRef = useRef<() => void>(() => undefined);

  const moveTo = useCallback((nextState: BrowserVoiceQaState) => {
    stateRef.current = nextState;
    if (mountedRef.current) setState(nextState);
  }, []);

  useEffect(() => {
    onStateChange?.(state);
  }, [onStateChange, state]);

  useEffect(() => {
    onErrorMessage?.(errorMessage);
  }, [errorMessage, onErrorMessage]);

  const emitCompletedTurn = useCallback((result: BrowserVoiceQaResponse) => {
    if (!result.answer || !onTurnCompleted) return;
    try {
      onTurnCompleted({
        id: result.answer.id,
        question: result.transcript,
        answer: result.text,
        citedSegmentIds: result.answer.citedSegmentIds,
        citations: result.answer.citations
      });
    } catch {
      // UI observers cannot make an otherwise valid Voice QA turn fail.
    }
  }, [onTurnCompleted]);

  const clearRecordingTimeout = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = undefined;
  }, []);

  const reportTraceEvent = useCallback((
    traceId: string,
    event: "audio_play_started" | "playback_started" | "session_completed",
    outcome?: BrowserVoiceTraceOutcome
  ) => {
    telemetryTailRef.current = telemetryTailRef.current
      .catch(() => undefined)
      .then(async () => {
        for (let attempt = 0; attempt < TRACE_TELEMETRY_MAX_ATTEMPTS; attempt += 1) {
          try {
            const response = await fetcher("/api/voice/trace", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ traceId, event, ...(outcome ? { outcome } : {}) }),
              keepalive: true
            });
            if (response.ok) return;
            const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
            if (!retryable) return;
          } catch {
            // A transient network failure is retried below. Trace delivery must
            // never make the user-facing Voice QA turn fail.
          }
          if (attempt + 1 < TRACE_TELEMETRY_MAX_ATTEMPTS) {
            await waitForTraceRetry(attempt);
          }
        }
      })
      .catch(() => undefined);
    return telemetryTailRef.current;
  }, [fetcher]);

  const completeActiveTrace = useCallback((outcome: BrowserVoiceTraceOutcome) => {
    const traceId = activeTraceIdRef.current;
    if (!traceId || traceTerminalRef.current) return;
    traceTerminalRef.current = true;
    void reportTraceEvent(traceId, "session_completed", outcome);
  }, [reportTraceEvent]);

  const cancelAudioQueue = useCallback(() => {
    const queue = audioQueueRef.current;
    audioQueueRef.current = undefined;
    if (queue) void queue.cancel();
  }, []);

  const handleStreamingPlaybackStarted = useCallback(() => {
    const traceId = activeTraceIdRef.current;
    if (traceId && !audioPlayReportedRef.current) {
      audioPlayReportedRef.current = true;
      void reportTraceEvent(traceId, "playback_started");
    }
    setErrorMessage("");
    moveTo("speaking");
  }, [moveTo, reportTraceEvent]);

  const stopRecording = useCallback(async () => {
    if (stateRef.current !== "listening") return;
    moveTo("thinking");
    clearRecordingTimeout();
    const recorder = recorderRef.current;
    const streamQueue = audioQueueRef.current;

    let activeController: AbortController | undefined;
    try {
      const audio = await recorder?.stop();
      recorder?.dispose();
      if (recorderRef.current === recorder) recorderRef.current = undefined;
      if (!audio || audio.size === 0) throw new Error("empty_recording");
      if (!mountedRef.current) return;

      const formData = new FormData();
      formData.append("audio", audio, recordingFileName(audio.type));
      formData.append("scope", scope);
      formData.append("answerMode", answerMode);
      if (uploadId?.trim()) formData.append("uploadId", uploadId.trim());
      if (referenceDate?.trim()) formData.append("referenceDate", referenceDate.trim());
      if (context) formData.append("context", JSON.stringify(context));
      if (conversation) formData.append("conversation", JSON.stringify(conversation));
      if (conversationSessionIdRef.current) {
        formData.append("conversationSessionId", conversationSessionIdRef.current);
      }

      const controller = new AbortController();
      activeController = controller;
      requestRef.current?.abort();
      requestRef.current = controller;
      const response = await fetcher("/api/voice/qa", {
        method: "POST",
        ...(streamQueue ? { headers: { Accept: "application/x-ndjson" } } : {}),
        body: formData,
        signal: controller.signal
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const errorCode = errorPayloadMessage(payload);
        if (
          errorCode === "voice_session_expired" ||
          errorCode === "voice_session_not_found"
        ) {
          conversationSessionIdRef.current = undefined;
        }
        throw new Error(errorCode ?? `voice_qa_http_${response.status}`);
      }

      const contentType = response.headers?.get?.("content-type")?.toLowerCase() ?? "";
      if (
        streamQueue &&
        response.body &&
        contentType.includes("application/x-ndjson")
      ) {
        let metaReceived = false;
        let streamedAnswer: BrowserVoiceQaResponse | undefined;
        let fallbackAudio: { base64: string; mimeType: string } | undefined;
        let streamFailure: { code: string; textAvailable: boolean } | undefined;
        let completeStatus: BrowserVoiceStreamStatus | undefined;
        let completeErrors: string[] = [];
        let lastAudioSequence = 0;
        let audioChunkCount = 0;

        for await (const event of parseVoiceBrowserNdjsonStream(response.body)) {
          if (event.type === "meta") {
            if (metaReceived) throw new Error("duplicate_voice_stream_meta");
            metaReceived = true;
            conversationSessionIdRef.current = event.conversationSessionId;
            activeTraceIdRef.current = event.traceId;
            traceTerminalRef.current = false;
            audioPlayReportedRef.current = false;
            continue;
          }
          if (!metaReceived) throw new Error("voice_stream_meta_missing");
          if (event.type === "audio_chunk") {
            audioChunkCount += 1;
            lastAudioSequence = Math.max(lastAudioSequence, event.sequence);
            await streamQueue.enqueue({
              sequence: event.sequence,
              pcm16le: decodeBase64Audio(event.audioBase64)
            }, { signal: controller.signal });
            continue;
          }
          if (event.type === "answer") {
            streamedAnswer = event;
            continue;
          }
          if (event.type === "fallback_audio") {
            fallbackAudio = {
              base64: event.audioBase64,
              mimeType: event.audioMimeType
            };
            continue;
          }
          if (event.type === "error") {
            streamFailure = event;
            continue;
          }
          completeStatus = event.status;
          completeErrors = event.errors;
        }

        if (!metaReceived) throw new Error("voice_stream_meta_missing");
        if (!completeStatus) throw new Error("voice_stream_completion_missing");
        if (streamFailure && (!streamFailure.textAvailable || !streamedAnswer)) {
          throw new Error(streamFailure.code);
        }
        if ((completeStatus === "failed" || completeStatus === "aborted") && !streamedAnswer) {
          throw new Error(`voice_stream_${completeStatus}`);
        }
        if (streamedAnswer) {
          setTranscript(streamedAnswer.transcript);
          setAnswer(streamedAnswer.text);
          setErrorMessage("");
          if (completeStatus === "completed" || completeStatus === "completed_with_errors") {
            emitCompletedTurn(streamedAnswer);
          }
        }

        if (audioChunkCount > 0) {
          const completion = await streamQueue.finish(lastAudioSequence);
          if (controller.signal.aborted) return;
          if (completion.status !== "completed") {
            throw new Error("voice_stream_playback_failed");
          }
          if (audioQueueRef.current === streamQueue) audioQueueRef.current = undefined;
          const outcome = traceOutcomeForStream(completeStatus);
          completeActiveTrace(outcome);
          moveTo("idle");
          if (outcome !== "completed") {
            setErrorMessage(
              completeErrors.includes("tts_failed")
                ? "语音播放可能不完整，文字回答仍可查看。"
                : "这次语音回答没有完整完成，文字回答仍可查看。"
            );
          }
          return;
        }

        await streamQueue.cancel();
        if (audioQueueRef.current === streamQueue) audioQueueRef.current = undefined;
        if (fallbackAudio && streamedAnswer) {
          setPlayback({
            id: streamedAnswer.sessionId,
            base64: fallbackAudio.base64,
            mimeType: fallbackAudio.mimeType,
            outcome: traceOutcomeForStream(completeStatus),
            ...(completeStatus === "completed" ? {} : {
              completionMessage: completeErrors.includes("tts_failed")
                ? "语音播放可能不完整，文字回答仍可查看。"
                : "这次语音回答没有完整完成，文字回答仍可查看。"
            })
          });
          return;
        }

        const outcome = traceOutcomeForStream(completeStatus);
        completeActiveTrace(outcome);
        moveTo("idle");
        if (outcome !== "completed") {
          setErrorMessage(
            completeErrors.includes("tts_failed")
              ? "语音播放暂时不可用，文字回答仍可查看。"
              : "这次语音回答没有完整完成，文字回答仍可查看。"
          );
        }
        return;
      }

      if (streamQueue) {
        await streamQueue.cancel();
        if (audioQueueRef.current === streamQueue) audioQueueRef.current = undefined;
      }
      const payload: unknown = await response.json().catch(() => null);
      const result = voiceQaResponse(payload);
      if (!result) throw new Error("invalid_voice_qa_response");
      if (!mountedRef.current) return;

      if (result.conversationSessionId) {
        conversationSessionIdRef.current = result.conversationSessionId;
      }

      setTranscript(result.transcript);
      setAnswer(result.text);
      setErrorMessage("");
      emitCompletedTurn(result);
      activeTraceIdRef.current = result.traceId;
      traceTerminalRef.current = false;
      audioPlayReportedRef.current = false;
      if (result.audioBase64) {
        setPlayback({
          id: result.sessionId,
          base64: result.audioBase64,
          mimeType: result.audioMimeType || "audio/wav"
        });
      } else {
        completeActiveTrace("completed");
        moveTo("idle");
        if (result.errors?.includes("tts_failed")) {
          setErrorMessage("语音播放暂时不可用，文字回答仍可查看。");
        }
      }
    } catch (error) {
      recorder?.dispose();
      if (recorderRef.current === recorder) recorderRef.current = undefined;
      if (!mountedRef.current || (error instanceof DOMException && error.name === "AbortError")) return;
      cancelAudioQueue();
      completeActiveTrace("failed");
      setErrorMessage("这次语音问答没有完成，请稍后再试。已保存的记忆不会受到影响。");
      moveTo("idle");
    } finally {
      if (requestRef.current === activeController) {
        requestRef.current = undefined;
      }
    }
  }, [
    answerMode,
    cancelAudioQueue,
    clearRecordingTimeout,
    completeActiveTrace,
    context,
    conversation,
    emitCompletedTurn,
    fetcher,
    moveTo,
    referenceDate,
    scope,
    uploadId
  ]);

  stopRecordingRef.current = () => {
    void stopRecording();
  };

  const startRecording = useCallback(async () => {
    if (disabled || disabledReason || stateRef.current !== "idle" || startingRef.current) return;
    completeActiveTrace("aborted");
    activeTraceIdRef.current = undefined;
    cancelAudioQueue();
    startingRef.current = true;
    setIsStarting(true);
    setErrorMessage("");
    setPlayback(undefined);
    const recorder = recorderFactory();
    recorderRef.current = recorder;

    try {
      let streamQueue: BrowserVoiceAudioQueue | undefined;
      try {
        streamQueue = audioQueueFactory({
          startSequence: 1,
          onPlaybackStarted: handleStreamingPlaybackStarted
        });
        await streamQueue.prepare();
        if (mountedRef.current) {
          audioQueueRef.current = streamQueue;
        } else {
          await streamQueue.cancel();
        }
      } catch {
        await streamQueue?.cancel().catch(() => undefined);
        if (audioQueueRef.current === streamQueue) audioQueueRef.current = undefined;
      }
      await recorder.start();
      if (!mountedRef.current) {
        recorder.dispose();
        cancelAudioQueue();
        return;
      }
      moveTo("listening");
      timeoutRef.current = setTimeout(() => stopRecordingRef.current(), maxRecordingMs);
    } catch (error) {
      recorder.dispose();
      recorderRef.current = undefined;
      cancelAudioQueue();
      if (mountedRef.current) {
        setErrorMessage(microphoneErrorMessage(error));
        moveTo("idle");
      }
    } finally {
      startingRef.current = false;
      if (mountedRef.current) setIsStarting(false);
    }
  }, [
    audioQueueFactory,
    cancelAudioQueue,
    completeActiveTrace,
    disabled,
    disabledReason,
    handleStreamingPlaybackStarted,
    maxRecordingMs,
    moveTo,
    recorderFactory
  ]);

  const cancelActiveTurn = useCallback(() => {
    clearRecordingTimeout();
    requestRef.current?.abort();
    requestRef.current = undefined;
    recorderRef.current?.dispose();
    recorderRef.current = undefined;
    cancelAudioQueue();
    setPlayback(undefined);
    completeActiveTrace("aborted");
    setErrorMessage("");
    moveTo("idle");
  }, [cancelAudioQueue, clearRecordingTimeout, completeActiveTrace, moveTo]);

  useEffect(() => {
    // React StrictMode intentionally replays effects in development. Re-arm the
    // mounted guard so the second setup remains usable after the probe cleanup.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearRecordingTimeout();
      requestRef.current?.abort();
      recorderRef.current?.dispose();
      cancelAudioQueue();
      completeActiveTrace("aborted");
    };
  }, [cancelAudioQueue, clearRecordingTimeout, completeActiveTrace]);

  const finishPlayback = useCallback(() => {
    completeActiveTrace(playback?.outcome ?? "completed");
    if (playback?.completionMessage) setErrorMessage(playback.completionMessage);
    setPlayback(undefined);
    moveTo("idle");
  }, [completeActiveTrace, moveTo, playback]);

  const failPlayback = useCallback(() => {
    completeActiveTrace("failed");
    setErrorMessage("语音播放暂时不可用，文字回答仍可查看。");
    setPlayback(undefined);
    moveTo("idle");
  }, [completeActiveTrace, moveTo]);

  const handleAutoplayBlocked = useCallback(() => {
    setErrorMessage("浏览器没有自动播放语音，请点击播放器上的播放按钮。");
    moveTo("idle");
  }, [moveTo]);

  const handlePlaybackStarted = useCallback(() => {
    const traceId = activeTraceIdRef.current;
    if (traceId && !audioPlayReportedRef.current) {
      audioPlayReportedRef.current = true;
      void reportTraceEvent(traceId, "audio_play_started");
    }
    setErrorMessage("");
    moveTo("speaking");
  }, [moveTo, reportTraceEvent]);

  const directMode = answerMode === "direct";

  if (variant === "composer") {
    return (
      <div
        className={`voice-qa-composer-control voice-qa-composer-control-${state}`}
        data-answer-mode={answerMode}
        data-voice-state={state}
      >
        <VoiceQAButton
          state={state}
          compact
          answerMode={answerMode}
          disabled={disabled || isStarting || Boolean(disabledReason)}
          title={disabledReason}
          onStart={() => void startRecording()}
          onStop={() => void stopRecording()}
          onCancel={cancelActiveTurn}
        />
        {playback ? (
          <div className="voice-qa-composer-player">
            <VoicePlayer
              key={playback.id}
              audioBase64={playback.base64}
              mimeType={playback.mimeType}
              onPlaying={handlePlaybackStarted}
              onEnded={finishPlayback}
              onError={failPlayback}
              onAutoplayBlocked={handleAutoplayBlocked}
            />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <section
      className={`voice-qa-card ${directMode ? "voice-qa-card-direct" : "voice-qa-card-agent"}`}
      aria-labelledby={headingId}
      data-answer-mode={answerMode}
    >
      <header className="voice-qa-heading">
        {directMode ? <span className="voice-qa-mode-badge">临时对比 · DIRECT</span> : null}
        <h2 id={headingId}>{directMode ? "Direct 实验问答" : "语音问答"}</h2>
        <p>
          {directMode
            ? "复用同一份记忆与证据，使用更紧凑的 Direct 回答路径，仅用于和右侧 Agent 模式对比。"
            : "按下按钮说完问题，再点击结束。我会从当前问答范围里寻找答案并用语音回复。"}
        </p>
      </header>

      <div className="voice-qa-controls">
        <VoiceSessionStatus state={state} />
        <VoiceQAButton
          state={state}
          disabled={disabled || isStarting || Boolean(disabledReason)}
          onStart={() => void startRecording()}
          onStop={() => void stopRecording()}
        />
        {state === "thinking" || state === "speaking" ? (
          <button
            className="voice-qa-cancel-button"
            type="button"
            aria-label="取消语音回答"
            onClick={cancelActiveTurn}
          >
            取消回答
          </button>
        ) : null}
        <small>{disabledReason ?? "单次最多录制 60 秒。录音只在你主动点击后开始。"}</small>
      </div>

      {errorMessage ? <p className="voice-qa-error" role="alert">{errorMessage}</p> : null}

      {transcript || answer ? (
        <div className="voice-qa-conversation" aria-live="polite">
          {transcript ? (
            <div className="voice-qa-turn voice-qa-turn-user">
              <span>你</span>
              <p>{transcript}</p>
            </div>
          ) : null}
          {answer ? (
            <div className="voice-qa-turn voice-qa-turn-assistant">
              <span>昼记 AI</span>
              <p>{answer}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {playback ? (
        <VoicePlayer
          key={playback.id}
          audioBase64={playback.base64}
          mimeType={playback.mimeType}
          onPlaying={handlePlaybackStarted}
          onEnded={finishPlayback}
          onError={failPlayback}
          onAutoplayBlocked={handleAutoplayBlocked}
        />
      ) : null}
    </section>
  );
}

"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  BrowserRealtimeVoiceSession
} from "./browser-realtime-voice";
import type { BrowserVoiceQaProps } from "./browser-voice-qa";
import { VoiceQAButton } from "./voice-qa-button";
import {
  VoiceSessionStatus,
  type BrowserVoiceQaState
} from "./voice-session-status";

const DEFAULT_REALTIME_SESSION_MS = 10 * 60_000;
const DEVELOPMENT_REALTIME_GATEWAY_URL =
  process.env.NEXT_PUBLIC_VOICE_REALTIME_GATEWAY_URL?.trim();

type BrowserRealtimeVoiceQaProps = BrowserVoiceQaProps & {
  onRealtimeUnavailable?: () => void;
};

function realtimeErrorMessage(code: string) {
  if (code === "voice_realtime_unsupported") {
    return "当前浏览器不支持实时语音，已保留按住说话模式可用。";
  }
  if (code === "voice_realtime_capture_backpressure") {
    return "网络暂时跟不上实时音频，已安全停止本次会话。";
  }
  return "实时语音会话暂时不可用，请停止后重试，已有记忆不会受影响。";
}

export function BrowserRealtimeVoiceQa({
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
  disabledReason,
  maxRecordingMs = DEFAULT_REALTIME_SESSION_MS,
  audioQueueFactory,
  fetcher,
  onRealtimeUnavailable
}: BrowserRealtimeVoiceQaProps) {
  const headingId = useId();
  const [state, setState] = useState<BrowserVoiceQaState>("idle");
  const [isStarting, setIsStarting] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const sessionRef = useRef<BrowserRealtimeVoiceSession | undefined>(undefined);
  const mountedRef = useRef(true);

  const moveTo = useCallback((next: BrowserVoiceQaState) => {
    if (!mountedRef.current) return;
    setState(next);
    onStateChange?.(next);
  }, [onStateChange]);

  const reportError = useCallback((code: string) => {
    const message = realtimeErrorMessage(code);
    if (mountedRef.current) setErrorMessage(message);
    onErrorMessage?.(message);
  }, [onErrorMessage]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    sessionRef.current = undefined;
    await session?.stop();
    moveTo("idle");
  }, [moveTo]);

  const start = useCallback(async () => {
    if (
      disabled ||
      disabledReason ||
      isStarting ||
      sessionRef.current
    ) {
      return;
    }
    setIsStarting(true);
    setErrorMessage("");
    const session = new BrowserRealtimeVoiceSession({
      scope,
      ...(uploadId ? { uploadId } : {}),
      ...(referenceDate ? { referenceDate } : {}),
      ...(context ? { context } : {}),
      ...(conversation ? { conversation } : {}),
      ...(fetcher ? { fetcher } : {}),
      ...(DEVELOPMENT_REALTIME_GATEWAY_URL
        ? { gatewayUrl: DEVELOPMENT_REALTIME_GATEWAY_URL }
        : {}),
      ...(audioQueueFactory ? { audioQueueFactory } : {}),
      idleTimeoutMs: Math.max(10_000, maxRecordingMs),
      onStateChange: moveTo,
      onTranscript: (value) => {
        if (mountedRef.current) setTranscript(value);
      },
      onAnswer: (value) => {
        if (mountedRef.current) setAnswer(value);
      },
      onTurnCompleted,
      onSessionEnded: () => {
        if (sessionRef.current === session) sessionRef.current = undefined;
        moveTo("idle");
      },
      onError: reportError
    });
    sessionRef.current = session;
    try {
      await session.start();
    } catch (error) {
      if (sessionRef.current === session) sessionRef.current = undefined;
      if (error instanceof DOMException && error.name === "AbortError") return;
      const code = error instanceof Error
        ? error.message
        : "voice_realtime_failed";
      reportError(code);
      moveTo("idle");
      onRealtimeUnavailable?.();
    } finally {
      if (mountedRef.current) setIsStarting(false);
    }
  }, [
    audioQueueFactory,
    context,
    conversation,
    disabled,
    disabledReason,
    fetcher,
    isStarting,
    maxRecordingMs,
    moveTo,
    onRealtimeUnavailable,
    onTurnCompleted,
    referenceDate,
    reportError,
    scope,
    stop,
    uploadId
  ]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const session = sessionRef.current;
      sessionRef.current = undefined;
      void session?.stop();
    };
  }, []);

  if (variant === "composer") {
    return (
      <div
        className={`voice-qa-composer-control voice-qa-composer-control-${state}`}
        data-answer-mode="agent"
        data-voice-state={state}
        data-voice-input-mode="realtime"
      >
        <VoiceQAButton
          state={state}
          compact
          answerMode="agent"
          disabled={disabled || isStarting || Boolean(disabledReason)}
          title={disabledReason}
          onStart={() => void start()}
          onStop={() => void stop()}
          onCancel={() => void stop()}
        />
      </div>
    );
  }

  return (
    <section
      className="voice-qa-card voice-qa-card-agent"
      aria-labelledby={headingId}
      data-answer-mode="agent"
      data-voice-input-mode="realtime"
    >
      <header className="voice-qa-heading">
        <h2 id={headingId}>实时语音问答</h2>
        <p>
          启动后可以连续提问；回答播放时直接说话即可打断。所有回答仍由
          Daily Brief 的证据链生成。
        </p>
      </header>
      <div className="voice-qa-controls">
        <VoiceSessionStatus state={state} />
        <VoiceQAButton
          state={state}
          disabled={disabled || isStarting || Boolean(disabledReason)}
          title={disabledReason}
          onStart={() => void start()}
          onStop={() => void stop()}
          onCancel={() => void stop()}
        />
        <small>
          {disabledReason ??
            (state === "idle"
              ? "点击一次启动连续会话，再次点击可结束。"
              : "麦克风持续监听；说话会打断当前播放。")}
        </small>
      </div>
      {errorMessage ? (
        <p className="voice-qa-error" role="alert">{errorMessage}</p>
      ) : null}
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
    </section>
  );
}

import type { BrowserVoiceQaState } from "./voice-session-status";

type VoiceQAButtonProps = {
  state: BrowserVoiceQaState;
  onStart: () => void;
  onStop: () => void;
  onCancel?: () => void;
  disabled?: boolean;
  compact?: boolean;
  answerMode?: "agent" | "direct";
  title?: string;
};

const BUTTON_COPY: Record<BrowserVoiceQaState, string> = {
  idle: "开始语音提问",
  listening: "结束录音",
  thinking: "正在思考",
  speaking: "正在回答"
};

export function VoiceQAButton({
  state,
  onStart,
  onStop,
  onCancel,
  disabled = false,
  compact = false,
  answerMode,
  title
}: VoiceQAButtonProps) {
  const isListening = state === "listening";
  const isBusy = state === "thinking" || state === "speaking";
  const canCancelBusyState = isBusy && Boolean(onCancel);
  const accessibleLabel = canCancelBusyState ? "取消语音回答" : BUTTON_COPY[state];

  return (
    <button
      className={[
        "voice-qa-button",
        `voice-qa-button-${state}`,
        compact ? "voice-qa-button-compact" : ""
      ].filter(Boolean).join(" ")}
      type="button"
      disabled={disabled || (isBusy && !onCancel)}
      aria-label={accessibleLabel}
      data-answer-mode={answerMode}
      title={title ?? accessibleLabel}
      onClick={isListening ? onStop : canCancelBusyState ? onCancel : onStart}
    >
      <span className="voice-qa-microphone" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
        </svg>
      </span>
      {compact ? null : <span>{BUTTON_COPY[state]}</span>}
    </button>
  );
}

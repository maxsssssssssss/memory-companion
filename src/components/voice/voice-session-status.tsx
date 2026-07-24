export type BrowserVoiceQaState = "idle" | "listening" | "thinking" | "speaking";

const STATUS_COPY: Record<BrowserVoiceQaState, string> = {
  idle: "可以开始提问",
  listening: "正在听你说话",
  thinking: "正在查找相关记忆",
  speaking: "正在播放回答"
};

export function VoiceSessionStatus({ state }: { state: BrowserVoiceQaState }) {
  return (
    <div className={`voice-qa-status voice-qa-status-${state}`} role="status" aria-live="polite">
      <span className="voice-qa-status-dot" aria-hidden="true" />
      <span>{STATUS_COPY[state]}</span>
    </div>
  );
}

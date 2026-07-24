"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";

import type { VoiceQaContext } from "@/lib/domain/voice-qa-context";

type QaVoiceScope = "current" | "week" | "all";

type QaVoiceWorkspaceProps = {
  children: ReactNode;
  active: boolean;
  scope: QaVoiceScope;
  uploadId?: string;
  referenceDate?: string;
  context?: VoiceQaContext;
  unavailableReason?: string;
};

export type QaVoiceWorkspaceContextValue = {
  active: boolean;
  scope: QaVoiceScope;
  answerMode: "agent";
  sessionKey: string;
  uploadId?: string;
  referenceDate?: string;
  context?: VoiceQaContext;
  unavailableReason?: string;
};

const QaVoiceWorkspaceContext = createContext<QaVoiceWorkspaceContextValue | undefined>(
  undefined
);

export function useQaVoiceWorkspace() {
  return useContext(QaVoiceWorkspaceContext);
}

export function QaVoiceWorkspace({
  children,
  active,
  scope,
  uploadId,
  referenceDate,
  context,
  unavailableReason
}: QaVoiceWorkspaceProps) {
  const effectiveReferenceDate = scope === "week" ? referenceDate : undefined;
  const effectiveUnavailableReason =
    unavailableReason ??
    (scope === "current" && !uploadId ? "这一天还没有可用于语音问答的录音。" : undefined);
  const sessionKey = [
    scope,
    uploadId ?? "none",
    effectiveReferenceDate ?? "none",
    effectiveUnavailableReason ?? "available"
  ].join(":");
  const voiceContext = useMemo<QaVoiceWorkspaceContextValue>(() => ({
    active,
    scope,
    answerMode: "agent",
    sessionKey,
    ...(uploadId ? { uploadId } : {}),
    ...(effectiveReferenceDate ? { referenceDate: effectiveReferenceDate } : {}),
    ...(context ? { context } : {}),
    ...(effectiveUnavailableReason
      ? { unavailableReason: effectiveUnavailableReason }
      : {})
  }), [
    active,
    context,
    effectiveReferenceDate,
    effectiveUnavailableReason,
    scope,
    sessionKey,
    uploadId
  ]);

  return (
    <QaVoiceWorkspaceContext.Provider value={voiceContext}>
      <div className={`qa-voice-workspace ${active ? "qa-voice-workspace-active" : ""}`}>
        <div className="qa-voice-main">{children}</div>
      </div>
    </QaVoiceWorkspaceContext.Provider>
  );
}

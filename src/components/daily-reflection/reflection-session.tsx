"use client";

import { useEffect } from "react";

import { DailyReflectionShellContent } from "./daily-reflection-shell";
import { useReflectionApp } from "./reflection-app-shell";

export function ReflectionSession({
  reflectionId,
  segmentId = null
}: Readonly<{ reflectionId: string; segmentId?: string | null }>) {
  const { browserRecordingEnabled, session, toySyncEnabled } = useReflectionApp();

  useEffect(() => {
    if (session.auth.status !== "authenticated" || session.reflectionId === reflectionId) return;
    void session.reload(reflectionId);
  }, [reflectionId, session]);

  return (
    <DailyReflectionShellContent
      browserRecordingEnabled={browserRecordingEnabled}
      embedded
      initialReflectionId={reflectionId}
      initialSegmentId={segmentId}
      session={session}
      surface="session"
      toySyncEnabled={toySyncEnabled}
    />
  );
}

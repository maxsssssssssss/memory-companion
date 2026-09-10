"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { DailyReflectionShellContent } from "./daily-reflection-shell";
import styles from "./daily-reflection.module.css";
import { consumeCaptureContextIntent, consumeVoiceAutostartIntent } from "./reflection-capture-intent";
import { reflectionSessionPath } from "./reflection-product";
import { useReflectionApp } from "./reflection-app-shell";
import { ReflectionRecordingRecovery } from "./reflection-recording-recovery";

type ReflectionCaptureProps = Readonly<{
  forceNew?: boolean;
  method?: "record" | "upload" | "toy" | null;
}>;

export function ReflectionCapture({ forceNew = false, method = null }: ReflectionCaptureProps) {
  const router = useRouter();
  const { browserRecordingEnabled, session, toySyncEnabled } = useReflectionApp();
  const resetApplied = useRef(false);
  const continuedRecording = useRef(false);
  const autostartChecked = useRef(false);
  const captureContextChecked = useRef(false);
  const [autoStartVoice, setAutoStartVoice] = useState(false);
  const [capturePrompt, setCapturePrompt] = useState<string | null>(null);
  const hasPendingRecording = Boolean(session.recordingRecovery && session.recordingRecovery.phase !== "saved");

  useEffect(() => {
    if (session.auth.status !== "authenticated") return;
    if (hasPendingRecording) { continuedRecording.current = true; return; }
    if (continuedRecording.current && session.recordingRecovery?.reflectionId) {
      router.replace(reflectionSessionPath(session.recordingRecovery.reflectionId));
      return;
    }
    if (forceNew && !resetApplied.current) {
      resetApplied.current = true;
      session.startNew();
      return;
    }
    if (!forceNew && session.reflectionId) {
      router.replace(reflectionSessionPath(session.reflectionId));
    }
  }, [forceNew, hasPendingRecording, router, session]);

  useEffect(() => {
    if (autostartChecked.current) return;
    autostartChecked.current = true;
    const armed = consumeVoiceAutostartIntent();
    setAutoStartVoice(method === "record" && armed);
  }, [method]);

  useEffect(() => {
    if (captureContextChecked.current) return;
    captureContextChecked.current = true;
    const storedPrompt = consumeCaptureContextIntent();
    if (storedPrompt) setCapturePrompt(storedPrompt);
  }, []);

  return (
    <>
      {hasPendingRecording ? <div className={styles.productPage}>
        <h1>继续这次复盘</h1>
        <ReflectionRecordingRecovery session={session} />
      </div> : null}
      {capturePrompt ? (
        <aside className={styles.captureContext} aria-label="继续思考的提示">
          <b>继续想：</b> {capturePrompt}
          <br />这只是这次页面里的提示，不会自动建立新的长期关联。
        </aside>
      ) : null}
      {!hasPendingRecording ? <DailyReflectionShellContent
        autoStartVoice={autoStartVoice}
        browserRecordingEnabled={browserRecordingEnabled}
        embedded
        initialCaptureMethod={method}
        session={session}
        surface="capture"
        toySyncEnabled={toySyncEnabled}
      /> : null}
    </>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { DailyReflectionShellContent } from "./daily-reflection-shell";
import styles from "./daily-reflection.module.css";
import { reflectionSessionPath } from "./reflection-product";
import { useReflectionApp } from "./reflection-app-shell";

type ReflectionCaptureProps = Readonly<{
  forceNew?: boolean;
  method?: "record" | "upload" | "toy" | null;
  prompt?: string | null;
}>;

export function ReflectionCapture({ forceNew = false, method = null, prompt = null }: ReflectionCaptureProps) {
  const router = useRouter();
  const { browserRecordingEnabled, session, toySyncEnabled } = useReflectionApp();
  const resetApplied = useRef(false);

  useEffect(() => {
    if (session.auth.status !== "authenticated") return;
    if (forceNew && !resetApplied.current) {
      resetApplied.current = true;
      session.startNew();
      return;
    }
    if (!forceNew && session.reflectionId) {
      router.replace(reflectionSessionPath(session.reflectionId));
    }
  }, [forceNew, router, session]);

  useEffect(() => {
    if (!method) return;
    const timer = window.setTimeout(() => {
      document.getElementById(`reflection-capture-${method}`)?.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [method]);

  return (
    <>
      {prompt ? (
        <aside className={styles.captureContext} aria-label="继续思考的提示">
          <b>继续想：</b> {prompt}
          <br />这只是这次页面里的提示，不会自动建立新的长期关联。
        </aside>
      ) : null}
      <DailyReflectionShellContent
        browserRecordingEnabled={browserRecordingEnabled}
        embedded
        session={session}
        surface="capture"
        toySyncEnabled={toySyncEnabled}
      />
    </>
  );
}

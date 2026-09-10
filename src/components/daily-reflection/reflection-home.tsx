"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import styles from "./daily-reflection.module.css";
import { armVoiceAutostartIntent } from "./reflection-capture-intent";
import { REFLECTION_ROUTES, reflectionSessionPath } from "./reflection-product";
import { useReflectionApp } from "./reflection-app-shell";
import { ReflectionRecordingRecovery } from "./reflection-recording-recovery";

type ReflectionHomeProps = Readonly<{
  dateKey: string;
  dateLabel: string;
  weekdayLabel: string;
}>;

function MicrophoneIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 96 96">
      <path d="M48 21c-8 0-14 6.2-14 14v16c0 7.8 6 14 14 14s14-6.2 14-14V35c0-7.8-6-14-14-14Z" />
      <path d="M25 48v3c0 13 10.3 23.5 23 23.5S71 64 71 51v-3M48 74.5V84M38 84h20" />
      <path className={styles.homeWaveLine} d="M18 43v10M10 46v4M78 43v10M86 46v4" />
    </svg>
  );
}

function ToyIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M8 8.5a4 4 0 0 1 8 0v.7a5.5 5.5 0 0 1 2.5 4.6v2.7A2.5 2.5 0 0 1 16 19H8a2.5 2.5 0 0 1-2.5-2.5v-2.7A5.5 5.5 0 0 1 8 9.2v-.7Z" />
      <path d="M8 8 5.5 5.5M16 8l2.5-2.5M9.5 13h.01M14.5 13h.01M10 16h4" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 16V4M7.5 8.5 12 4l4.5 4.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
    </svg>
  );
}

export function ReflectionHome({ dateKey, dateLabel, weekdayLabel }: ReflectionHomeProps) {
  const router = useRouter();
  const { browserRecordingEnabled, toySyncEnabled, session } = useReflectionApp();

  const startVoiceCapture = () => {
    if (!browserRecordingEnabled) return;
    armVoiceAutostartIntent();
    router.push(`${REFLECTION_ROUTES.capture}?new=1&method=record`);
  };

  return (
    <main className={`${styles.productPage} ${styles.homePage}`}>
      <ReflectionRecordingRecovery session={session} compact />
      <nav className={styles.recordingRecoveryActions} aria-label="复盘记录">
        {!session.recordingRecovery && session.reflectionId ? <Link href={reflectionSessionPath(session.reflectionId)}>继续这次复盘</Link> : null}
        <Link href="/reflection/sessions">最近复盘</Link>
      </nav>
      <section className={styles.homeCaptureLanding} aria-labelledby="reflection-home-action">
        <time className={styles.homeDate} dateTime={dateKey}>
          <strong>{dateLabel}</strong>
          <span>{weekdayLabel}</span>
        </time>

        <div className={styles.homeRecordCluster}>
          <div className={styles.homeRecordHalo}>
            <button
              aria-label="开始讲述，进入录音"
              className={styles.homeRecordButton}
              disabled={!browserRecordingEnabled}
              onClick={startVoiceCapture}
              type="button"
            >
              <MicrophoneIcon />
            </button>
          </div>
          <h1 className={styles.homeRecordLabel} id="reflection-home-action">开始讲述</h1>
        </div>

        <nav className={styles.homeSecondaryActions} aria-label="其他表达方式">
          {toySyncEnabled ? (
            <Link href={`${REFLECTION_ROUTES.capture}?new=1&method=toy`}>
              <ToyIcon />
              <span>玩偶导入</span>
            </Link>
          ) : null}
          <Link href={`${REFLECTION_ROUTES.capture}?new=1&method=upload`}>
            <UploadIcon />
            <span>上传文件</span>
          </Link>
        </nav>
      </section>
    </main>
  );
}

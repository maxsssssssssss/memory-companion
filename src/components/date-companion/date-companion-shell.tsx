"use client";

import Link from "next/link";
import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";

import { useDateCompanionSession } from "@/lib/client/date-companion-session";
import type { AuthState, QaState, SourceRefVM, UploadState } from "@/lib/domain/date-companion";

import { CompanionHome, type CompanionUploadPresentation } from "./companion-home";
import { CompanionLogin } from "./companion-login";
import { CompanionModules } from "./companion-modules";
import { CompanionPerson } from "./companion-person";
import { CompanionPrepare } from "./companion-prepare";
import { CompanionQuestionDrawer, type CompanionQaPresentationState } from "./companion-question-drawer";
import { CompanionRecap } from "./companion-recap";
import { CompanionRelationshipSetup } from "./companion-relationship-setup";
import type { TranscriptChapterPresentation } from "./companion-transcript";
import styles from "./date-companion.module.css";

export const dateCompanionScreens = ["home", "person", "recap", "prepare"] as const;
export type DateCompanionScreen = (typeof dateCompanionScreens)[number];

type DateCompanionShellProps =
  | { entry: "login" }
  | { entry: "modules" }
  | {
      entry: "companion";
      screen: DateCompanionScreen;
      initialSegmentId?: string | null;
      initialInteractionId?: string | null;
    };

const SCREEN_LABELS: Record<DateCompanionScreen, string> = {
  home: "此刻",
  person: "关于 Ta",
  recap: "这次相处",
  prepare: "见面前"
};

function screenPath(screen: DateCompanionScreen) {
  return screen === "home" ? "/date-companion/a" : `/date-companion/a/${screen}`;
}

function translatedError(message: string) {
  const messages: Record<string, string> = {
    invalid_credentials: "邮箱或密码不正确。",
    invalid_login_input: "请检查邮箱和密码后再试。",
    invalid_json: "登录信息格式不正确。",
    unauthenticated: "登录状态已失效，请重新登录。",
    missing_file: "请选择一段录音。",
    empty_file: "这段录音没有内容。",
    file_too_large: "录音超过服务允许的大小。",
    unsupported_audio_format: "暂不支持这种录音格式。",
    queue_unavailable: "整理服务暂时不可用，请稍后再试。",
    pipeline_queue_unavailable: "整理服务暂时不可用，请稍后再试。",
    day_context_not_found: "这次相处里还没有可用于回答的内容。",
    qa_stream_failed: "回答服务暂时没有完成这次提问，请重新发送。",
    qa_stream_incomplete: "这次回答没有完整返回，请重新发送。"
  };
  return messages[message] ?? message;
}

function LoadingScreen({ label = "正在确认你的私人空间…" }: { label?: string }) {
  return (
    <main className={styles.loadingScreen}>
      <div className={styles.loadingCard} role="status">
        <span className={styles.loadingMark}>DB</span>
        <span className={styles.loadingDot} aria-hidden="true" />
        <p>{label}</p>
      </div>
    </main>
  );
}

function AuthProblem({ auth }: { auth: Extract<AuthState, { status: "error" }> }) {
  return (
    <main className={styles.loadingScreen}>
      <div className={styles.loginCard}>
        <p className={styles.eyebrow}>无法进入</p>
        <h2>登录状态没有确认</h2>
        <p className={styles.inlineError} role="alert">{translatedError(auth.message)}</p>
        <Link className={styles.primaryButton} href="/date-companion"><span>返回登录</span><span aria-hidden="true">→</span></Link>
      </div>
    </main>
  );
}

function uploadPresentation(uploadState: UploadState, currentReady: boolean): CompanionUploadPresentation {
  switch (uploadState.status) {
    case "idle":
      return { status: "idle" };
    case "uploading":
      return { status: "uploading" };
    case "processing":
      return { status: "processing", jobStatus: uploadState.jobStatus, progress: uploadState.progress };
    case "ready":
      return {
        status: "ready",
        ...(uploadState.serverCleanupStatus === "not_completed"
          ? {
              cleanupWarningMessage: `本机结果和已确认内容仍在；服务器原结果尚未清理，可重新读取后重试${uploadState.cleanupMessage ? `：${translatedError(uploadState.cleanupMessage)}` : "。"}`
            }
          : {})
      };
    case "failed": {
      const message = translatedError(uploadState.message);
      if (uploadState.failureStage === "cache" && uploadState.serverDataRetained && currentReady) {
        return { status: "ready", cacheErrorMessage: message };
      }
      return { status: "failed", errorMessage: message };
    }
  }
}

function qaPresentation(qaState: QaState): CompanionQaPresentationState {
  if (qaState.status === "streaming") {
    return { status: "streaming", question: qaState.question, committedText: qaState.committedText };
  }
  if (qaState.status === "failed") {
    return { status: "failed", question: qaState.question, errorMessage: translatedError(qaState.message) };
  }
  return { status: qaState.status };
}

export function DateCompanionShell(props: DateCompanionShellProps) {
  const router = useRouter();
  const session = useDateCompanionSession();
  const { auth, viewModel } = session;

  useEffect(() => {
    if (props.entry === "login" && auth.status === "authenticated") router.replace("/date-companion/modules");
    if (props.entry !== "login" && auth.status === "anonymous") router.replace("/date-companion");
  }, [auth.status, props.entry, router]);

  useEffect(() => {
    if (
      props.entry === "companion"
      && props.screen === "recap"
      && session.relationshipState.status === "ready"
    ) {
      session.selectRelationshipInteraction(props.initialInteractionId ?? null);
    }
  }, [
    props.entry,
    props.entry === "companion" ? props.initialInteractionId : undefined,
    props.entry === "companion" ? props.screen : undefined,
    session.relationshipState.status,
    session.selectRelationshipInteraction
  ]);

  const validSegmentIds = useMemo(
    () => new Set(viewModel.currentInteraction?.transcript.map((line) => line.id) ?? []),
    [viewModel.currentInteraction?.transcript]
  );
  const segmentTextById = useMemo(
    () => new Map(viewModel.currentInteraction?.transcript.map((line) => [line.id, line.text] as const) ?? []),
    [viewModel.currentInteraction?.transcript]
  );

  if (auth.status === "checking") return <LoadingScreen />;

  if (props.entry === "login") {
    if (auth.status === "authenticated") return <LoadingScreen label="正在进入你的空间…" />;
    return (
      <CompanionLogin
        errorMessage={auth.status === "error" ? translatedError(auth.message) : undefined}
        onLogin={session.login}
      />
    );
  }

  if (auth.status === "anonymous") return <LoadingScreen label="正在返回登录页…" />;
  if (auth.status === "error") return <AuthProblem auth={auth} />;

  if (props.entry === "modules") {
    const userLabel = auth.user.name?.trim() || auth.user.email;
    return (
      <CompanionModules
        onLogout={async () => {
          await session.logout();
          router.replace("/date-companion");
        }}
        userLabel={userLabel}
      />
    );
  }

  if (session.relationshipState.status === "idle" || session.relationshipState.status === "loading") {
    return <LoadingScreen label="正在找回你和 Ta 的记录…" />;
  }

  if (
    session.relationshipState.status === "absent"
    || session.relationshipState.status === "creating"
    || session.relationshipState.status === "error"
  ) {
    return (
      <CompanionRelationshipSetup
        errorMessage={session.relationshipState.status === "error" ? translatedError(session.relationshipState.message) : undefined}
        onCreate={session.createRelationship}
      />
    );
  }

  if (session.relationshipState.status !== "ready") {
    return <LoadingScreen label="正在找回你和 Ta 的记录…" />;
  }

  const { screen } = props;
  const interaction = viewModel.currentInteraction;
  const relationship = session.relationshipState.relationship;
  const relationshipName = relationship.displayName?.trim() || "Ta";
  const chapters: TranscriptChapterPresentation[] = viewModel.recap.chapters.map((chapter) => ({
    id: chapter.id,
    title: chapter.title,
    startSeconds: chapter.startSeconds,
    endSeconds: chapter.endSeconds,
    segmentIds: chapter.sourceSegmentIds
  }));
  const recapInteraction = viewModel.recap.interaction;
  const canPersistRecap = Boolean(
    recapInteraction?.relationshipInteractionId
    && recapInteraction.persistenceStatus === "draft"
    && typeof recapInteraction.version === "number"
  );
  const latestConfirmedInteractionId = viewModel.person.interactions.at(-1)?.relationshipInteractionId;
  const qaEnabled = interaction?.status === "ready" && (
    screen !== "recap"
    || Boolean(
      recapInteraction?.transcript.length
      && recapInteraction.sourceUploadId === interaction.sourceUploadId
    )
  );

  const openSource = async (source: SourceRefVM, segmentId: string) => {
    if (!source.canOpenTranscript || !session.selectCachedInteraction(source.uploadId)) return;
    router.push(`/date-companion/a/recap?segment=${encodeURIComponent(segmentId)}#full-transcript`);
  };

  return (
    <main className={styles.companionPage} data-screen={screen}>
      <div className={styles.companionChrome}>
        <div className={styles.topBar}>
          <Link className={styles.backLink} href="/date-companion/modules"><span aria-hidden="true">←</span>返回空间选择</Link>
          <span className={styles.topBarNote}>约会陪伴 · {relationshipName}</span>
        </div>
        <nav className={styles.nav} aria-label="约会陪伴页面">
          <div className={styles.navLinks}>
            {dateCompanionScreens.map((candidate) => (
              <Link
                aria-current={screen === candidate ? "page" : undefined}
                className={`${styles.navLink} ${screen === candidate ? styles.navLinkActive : ""}`}
                href={candidate === "recap" && !interaction && latestConfirmedInteractionId
                  ? `${screenPath(candidate)}?interaction=${encodeURIComponent(latestConfirmedInteractionId)}`
                  : screenPath(candidate)}
                key={candidate}
              >
                {SCREEN_LABELS[candidate]}
              </Link>
            ))}
          </div>
          <div className={styles.navActions}>
            <CompanionQuestionDrawer
              answers={session.qaHistory}
              enabled={qaEnabled}
              onAsk={async (question) => { await session.ask(question); }}
              onCancel={session.cancelQa}
              qaState={qaPresentation(session.qaState)}
              segmentTextById={segmentTextById}
              validSegmentIds={validSegmentIds}
            />
          </div>
        </nav>
      </div>

      <div className={styles.shell}>
        <div className={styles.page}>
          {screen === "home" ? (
            <CompanionHome
              currentInteraction={interaction}
              onRetryRead={session.retryRead}
              onUpload={session.upload}
              participantNotice={viewModel.home.participantNotice}
              prepareItem={viewModel.home.preparePreview}
              recentItem={viewModel.person.recent.at(-1) ?? null}
              rememberedItem={viewModel.home.remembered}
              relationshipName={relationshipName}
              uploadState={uploadPresentation(session.uploadState, interaction?.status === "ready")}
            />
          ) : null}
          {screen === "person" ? (
            <CompanionPerson
              currentInteraction={interaction}
              onOpenInteraction={async (candidate) => {
                const uploadId = candidate.sourceUploadId ?? candidate.uploadIds[0];
                if (uploadId && session.selectCachedInteraction(uploadId)) {
                  router.push("/date-companion/a/recap");
                  return;
                }
                if (
                  candidate.relationshipInteractionId
                  && session.selectRelationshipInteraction(candidate.relationshipInteractionId)
                ) {
                  router.push(
                    `/date-companion/a/recap?interaction=${encodeURIComponent(candidate.relationshipInteractionId)}`
                  );
                }
              }}
              onDeleteInteraction={async (candidate) => {
                if (!candidate.relationshipInteractionId) return;
                await session.deleteInteraction(candidate.relationshipInteractionId);
              }}
              onOpenSource={openSource}
              onSearch={session.searchRelationship}
              onUpdatePromise={async (promise, status) => {
                await session.updatePromise(promise.id, promise.version, status);
              }}
              person={viewModel.person}
              relationship={viewModel.relationship}
              mutationState={session.mutationState}
              searchState={session.searchState}
            />
          ) : null}
          {screen === "recap" ? (
            <CompanionRecap
              chapters={chapters}
              initialSegmentId={props.initialSegmentId}
              interaction={recapInteraction}
              items={viewModel.recap.items}
              mutationState={session.mutationState}
              onFinalize={canPersistRecap ? async (assignments, recapItems, voiceEnrollmentIntents) => {
                await session.finalizeRecap(
                  recapInteraction!.relationshipInteractionId!,
                  recapInteraction!.version!,
                  assignments,
                  recapItems,
                  voiceEnrollmentIntents
                );
              } : undefined}
              participants={viewModel.recap.participants}
            />
          ) : null}
          {screen === "prepare" ? (
            <CompanionPrepare
              items={viewModel.prepare.items}
              latestInteractionId={latestConfirmedInteractionId}
              onOpenSource={openSource}
              openPromises={viewModel.prepare.openPromises}
              relationshipName={relationshipName}
            />
          ) : null}
        </div>
      </div>
    </main>
  );
}

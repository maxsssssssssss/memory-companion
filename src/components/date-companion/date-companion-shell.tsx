"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  useDateCompanionSession,
  type DateCompanionSessionValue
} from "@/lib/client/date-companion-session";
import { usePersistentDateCompanionSession } from "@/lib/client/date-companion-session-provider";
import { useDateCompanionPersonArchive } from "@/lib/client/date-companion-people";
import {
  dateCompanionProactiveSourceRevision,
  homeAboutSuggestedQuestions,
  presentDateCompanionHomeContent,
  presentDateCompanionProactiveValue,
  proactiveSuggestedQuestions,
  useDateCompanionProactiveValue,
  type DateCompanionProactiveValueTarget,
  type DateCompanionHomeContentState
} from "@/lib/client/date-companion-proactive-value";
import type { AuthState, QaState, SourceRefVM, UploadState } from "@/lib/domain/date-companion";
import { ProductAccountMenu } from "@/components/product-system/product-account-menu";
import { ProductState } from "@/components/product-system/product-primitives";
import { ProductSwitcher } from "@/components/product-system/product-switcher";

import { CompanionHome, type CompanionUploadPresentation } from "./companion-home";
import { CompanionLogin, type CompanionAuthMode } from "./companion-login";
import { CompanionModules } from "./companion-modules";
import { CompanionPeople } from "./companion-people";
import { CompanionPerson } from "./companion-person";
import { CompanionPrepare } from "./companion-prepare";
import { CompanionProactiveObservation } from "./companion-proactive-observation";
import { CompanionQuestionDrawer, type CompanionQaPresentationState } from "./companion-question-drawer";
import { CompanionRecap } from "./companion-recap";
import { CompanionRelationshipSetup } from "./companion-relationship-setup";
import type { TranscriptChapterPresentation } from "./companion-transcript";
import styles from "./date-companion.module.css";

export const dateCompanionScreens = ["home", "person", "recap", "prepare", "people"] as const;
export type DateCompanionScreen = (typeof dateCompanionScreens)[number];
const primaryDateCompanionScreens = ["home", "prepare", "recap", "people"] as const;

type DateCompanionShellProps =
  | { entry: "login" }
  | { entry: "modules"; dailyReflectionEnabled?: boolean }
  | {
      entry: "companion";
      screen: DateCompanionScreen;
      dailyReflectionEnabled?: boolean;
      toySyncEnabled?: boolean;
      initialPersonId?: string | null;
      initialSegmentId?: string | null;
      initialInteractionId?: string | null;
    };

const SCREEN_LABELS: Record<DateCompanionScreen, string> = {
  home: "首页",
  person: "人物详情",
  recap: "复盘",
  prepare: "准备",
  people: "人物"
};

function screenPath(screen: DateCompanionScreen) {
  return screen === "home" ? "/date-companion/a" : `/date-companion/a/${screen}`;
}

function translatedError(message: string) {
  const messages: Record<string, string> = {
    invalid_credentials: "邮箱或密码不正确。",
    invalid_login_input: "请检查邮箱和密码后再试。",
    invalid_register_input: "请检查邮箱、密码和邀请码后再试。密码至少需要 8 位。",
    invalid_invite_code: "邀请码不正确，请重新输入。",
    invite_not_configured: "注册暂未开放，请联系管理员。",
    user_exists: "这个邮箱已经注册过，可以直接登录。",
    invalid_json: "提交的信息格式不正确，请重新填写。",
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

function translatedAuthError(message: string, mode: CompanionAuthMode) {
  const translated = translatedError(message);
  if (translated !== message || message.startsWith("暂时无法")) return translated;
  return mode === "register"
    ? "注册没有完成，请稍后再试。"
    : "登录没有完成，请稍后再试。";
}

function LoadingScreen({ label = "正在确认你的私人空间…" }: { label?: string }) {
  return (
    <main className={styles.loadingScreen}>
      <div className={styles.authBoundaryState}>
        <ProductState title={label} tone="loading" />
      </div>
    </main>
  );
}

function AuthProblem({ auth }: { auth: Extract<AuthState, { status: "error" }> }) {
  return (
    <main className={styles.loadingScreen}>
      <div className={styles.authBoundaryState}>
        <ProductState
          action={<Link className={styles.authBoundaryAction} href="/date-companion">返回登录</Link>}
          description={translatedAuthError(auth.message, "login")}
          title="登录状态没有确认"
          tone="error"
        />
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
      return {
        status: "failed",
        errorMessage: message
      };
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
  const session = useDateCompanionSession();
  return <DateCompanionShellContent props={props} session={session} />;
}

export function DateCompanionPersistentShell(props: DateCompanionShellProps) {
  const session = usePersistentDateCompanionSession();
  return <DateCompanionShellContent props={props} session={session} />;
}

function DateCompanionShellContent({
  props,
  session
}: {
  props: DateCompanionShellProps;
  session: DateCompanionSessionValue;
}) {
  const router = useRouter();
  const { auth, viewModel } = session;
  const [authMode, setAuthMode] = useState<CompanionAuthMode>("login");
  const requestedRecapInteractionId = props.entry === "companion" && props.screen === "recap"
    ? props.initialInteractionId?.trim() || null
    : null;

  useEffect(() => {
    if (props.entry === "login" && auth.status === "authenticated") router.replace("/");
    if (props.entry !== "login" && auth.status === "anonymous") router.replace("/date-companion");
  }, [auth.status, props.entry, router]);

  useEffect(() => {
    if (
      props.entry === "companion"
      && props.screen === "recap"
      && session.relationshipState.status === "ready"
    ) {
      const selected = session.selectRelationshipInteraction(requestedRecapInteractionId);
      if (requestedRecapInteractionId && !selected) router.replace("/date-companion/a");
    }
  }, [
    props.entry,
    props.entry === "companion" ? props.screen : undefined,
    requestedRecapInteractionId,
    router,
    session.relationshipState.status,
    session.selectRelationshipInteraction
  ]);

  useEffect(() => {
    if (props.entry === "companion" && session.relationshipState.status === "ready") {
      void session.ensureMemoryBridgeLoaded();
    }
  }, [props.entry, session.ensureMemoryBridgeLoaded, session.relationshipState.status]);

  const personQaSources = useMemo(
    () => session.personQaSources(),
    [session.memoryBridgeState, session.personQaSources, viewModel]
  );
  const personQaAvailability = session.personQaAvailability();
  const validSegmentIds = useMemo(
    () => new Set(personQaSources.flatMap((source) => source.segmentIds)),
    [personQaSources]
  );
  const segmentTextById = useMemo(
    () => new Map(personQaSources.flatMap((source) =>
      source.segmentIds.map((segmentId) => [segmentId, source.quote] as const)
    )),
    [personQaSources]
  );
  const linkableSegmentIds = useMemo(
    () => new Set(personQaSources.filter((source) => source.canOpenTranscript).flatMap((source) => source.segmentIds)),
    [personQaSources]
  );
  const qaSourceBySegmentId = useMemo(
    () => new Map(personQaSources.flatMap((source) =>
      source.segmentIds.map((segmentId) => [segmentId, source] as const)
    )),
    [personQaSources]
  );
  const currentQaAvailability = session.currentInteractionQaAvailability();
  const currentQaInteraction = viewModel.recap.interaction;
  const currentProactiveSources = useMemo(
    () => viewModel.recap.items.flatMap((item) => item.sources),
    [viewModel.recap.items]
  );
  const currentProactiveSourceRevision = useMemo(
    () => dateCompanionProactiveSourceRevision(
      currentProactiveSources,
      currentQaInteraction?.version
    ),
    [currentProactiveSources, currentQaInteraction?.version]
  );
  const homeCanonicalSources = useMemo(
    () => [...personQaSources, ...viewModel.person.promises.flatMap((promise) => promise.sources)],
    [personQaSources, viewModel.person.promises]
  );
  const relationshipProactiveSourceRevision = useMemo(
    () => dateCompanionProactiveSourceRevision(homeCanonicalSources, JSON.stringify(
      viewModel.person.promises.map((promise) => [promise.id, promise.status, promise.version, promise.text])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
    )),
    [homeCanonicalSources, viewModel.person.promises]
  );
  const currentQaSegmentIds = useMemo(
    () => new Set(currentQaInteraction?.transcript.map((line) => line.id) ?? []),
    [currentQaInteraction]
  );
  const currentQaSegmentTextById = useMemo(
    () => new Map(currentQaInteraction?.transcript.map((line) => [line.id, line.text] as const) ?? []),
    [currentQaInteraction]
  );
  const proactiveRelationshipId = session.relationshipState.status === "ready"
    ? session.relationshipState.relationship.id
    : undefined;
  const proactiveMapping = session.memoryBridgeState.status === "ready"
    ? session.memoryBridgeState.mapping
    : null;
  const trustedProactiveTarget = auth.status === "authenticated"
    && proactiveRelationshipId
    && proactiveMapping?.status === "confirmed"
    && proactiveMapping.selfPersonId !== proactiveMapping.companionPersonId
    && personQaAvailability.enabled
    ? {
        accountId: auth.user.id,
        relationshipId: proactiveRelationshipId,
        personId: personQaAvailability.personId,
        mappingVersion: personQaAvailability.mappingVersion
      }
    : null;
  const currentProactiveTarget: DateCompanionProactiveValueTarget | null = trustedProactiveTarget
    && props.entry === "companion"
    && props.screen === "recap"
    && currentQaInteraction?.status === "ready"
    && currentQaInteraction.persistenceStatus === "confirmed"
    && currentQaInteraction.relationshipInteractionId
    && (!requestedRecapInteractionId
      || currentQaInteraction.relationshipInteractionId === requestedRecapInteractionId)
    ? {
        scope: "current_interaction",
        accountId: trustedProactiveTarget.accountId,
        relationshipId: trustedProactiveTarget.relationshipId,
        mappingVersion: trustedProactiveTarget.mappingVersion,
        interactionId: currentQaInteraction.relationshipInteractionId,
        sourceRevision: currentProactiveSourceRevision
      }
    : null;
  const relationshipProactiveTarget: DateCompanionProactiveValueTarget | null = auth.status === "authenticated"
    && proactiveRelationshipId
    && proactiveMapping?.status === "confirmed"
    && proactiveMapping.selfPersonId !== proactiveMapping.companionPersonId
    && homeCanonicalSources.length > 0
    && props.entry === "companion"
    ? {
        scope: "person_relationship",
        accountId: auth.user.id,
        relationshipId: proactiveRelationshipId,
        personId: proactiveMapping.companionPersonId,
        mappingVersion: proactiveMapping.version,
        sourceRevision: relationshipProactiveSourceRevision
      }
    : null;
  const currentProactiveState = useDateCompanionProactiveValue(currentProactiveTarget);
  const relationshipProactiveState = useDateCompanionProactiveValue(relationshipProactiveTarget);
  const currentProactivePresentation = useMemo(
    () => currentProactiveState.status === "ready"
      ? presentDateCompanionProactiveValue(
          currentProactiveState.response,
          currentProactiveSources
        )
      : null,
    [currentProactiveSources, currentProactiveState]
  );
  const relationshipProactivePresentation = useMemo(
    () => relationshipProactiveState.status === "ready"
      ? presentDateCompanionProactiveValue(relationshipProactiveState.response, personQaSources)
      : null,
    [personQaSources, relationshipProactiveState]
  );
  const relationshipSuggestedQuestions = useMemo(
    () => relationshipProactivePresentation
      ? proactiveSuggestedQuestions(relationshipProactivePresentation)
      : relationshipProactiveState.status === "ready"
        ? homeAboutSuggestedQuestions(relationshipProactiveState.response, personQaSources)
        : [],
    [personQaSources, relationshipProactivePresentation, relationshipProactiveState]
  );
  const homeContent: DateCompanionHomeContentState = useMemo(() => {
    if (relationshipProactiveState.status === "idle") return { status: "empty" };
    if (relationshipProactiveState.status === "loading") return { status: "loading" };
    if (relationshipProactiveState.status !== "ready") return { status: "unavailable" };
    const content = presentDateCompanionHomeContent(relationshipProactiveState.response, homeCanonicalSources);
    if (!content || content.beforeMeeting.some((item) => item.kind === "open_promise"
      && !viewModel.person.promises.some((promise) => promise.id === item.promiseId && promise.status === "open"))) {
      return { status: "unavailable" };
    }
    return content.about.length > 0 || content.beforeMeeting.length > 0
      ? { status: "ready", content }
      : { status: "empty" };
  }, [homeCanonicalSources, relationshipProactiveState, viewModel.person.promises]);
  const requestedPersonId = props.entry === "companion" && props.screen === "person"
    ? props.initialPersonId?.trim() || null
    : null;
  const readyMemoryBridge = session.memoryBridgeState.status === "ready"
    ? session.memoryBridgeState
    : null;
  const mappedCompanionPersonId = readyMemoryBridge?.mapping?.status === "confirmed"
    ? readyMemoryBridge.mapping.companionPersonId
    : null;
  const selectedPersonId = props.entry === "companion" && props.screen === "person"
    ? requestedPersonId ?? mappedCompanionPersonId
    : null;
  const selfPersonId = readyMemoryBridge?.mapping?.selfPersonId ?? readyMemoryBridge?.selfBinding?.personId ?? null;
  const selectedConfirmedPerson = selectedPersonId
    ? readyMemoryBridge?.people.find((person) => person.id === selectedPersonId) ?? null
    : null;
  const personArchiveTarget = selectedConfirmedPerson && selectedConfirmedPerson.id !== selfPersonId
    ? selectedConfirmedPerson.id
    : null;
  const personArchiveState = useDateCompanionPersonArchive(personArchiveTarget);

  if (auth.status === "checking") return <LoadingScreen />;

  if (props.entry === "login") {
    if (auth.status === "authenticated") return <LoadingScreen label="正在进入你的空间…" />;
    return (
      <CompanionLogin
        errorMessage={auth.status === "error" ? translatedAuthError(auth.message, authMode) : undefined}
        mode={authMode}
        onLogin={session.login}
        onModeChange={(mode) => {
          session.clearAuthError();
          setAuthMode(mode);
        }}
        onRegister={session.register}
      />
    );
  }

  if (auth.status === "anonymous") return <LoadingScreen label="正在返回登录页…" />;
  if (auth.status === "error") return <AuthProblem auth={auth} />;

  if (props.entry === "modules") {
    const userLabel = auth.user.name?.trim() || auth.user.email;
    return (
      <CompanionModules
        accountId={auth.user.id}
        dailyReflectionEnabled={props.dailyReflectionEnabled ?? false}
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

  if (
    requestedRecapInteractionId
    && currentQaInteraction?.relationshipInteractionId !== requestedRecapInteractionId
  ) {
    return <LoadingScreen label="正在找回这次相处…" />;
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
  const personQaEnabled = personQaAvailability.enabled;

  const openSource = async (source: SourceRefVM, segmentId: string) => {
    if (!source.canOpenTranscript || !session.selectCachedInteraction(source.uploadId)) return;
    router.push(`/date-companion/a/recap?segment=${encodeURIComponent(segmentId)}#full-transcript`);
  };
  const selectedIsCurrentRelationship = Boolean(
    selectedPersonId && selectedPersonId === mappedCompanionPersonId
  );
  const resolvedPersonArchiveState = props.entry === "companion"
    && props.screen === "person"
    && !readyMemoryBridge
    ? { status: "loading" as const }
    : requestedPersonId && readyMemoryBridge && (!selectedConfirmedPerson || requestedPersonId === selfPersonId)
      ? { status: "not_found" as const }
      : personArchiveState;

  return (
    <main className={styles.companionPage} data-screen={screen}>
      <div className={styles.companionChrome}>
        <div className={styles.topBar}>
          <ProductSwitcher
            accountId={auth.user.id}
            currentProduct="date_companion"
            dailyReflectionEnabled={props.dailyReflectionEnabled ?? false}
          />
          <div className={styles.topBarTools}>
            <span className={styles.topBarNote}>约会陪伴 · {relationshipName}</span>
            <ProductAccountMenu
              onLogout={async () => {
                await session.logout();
                router.replace("/date-companion");
              }}
              userLabel={auth.user.name?.trim() || auth.user.email}
            />
          </div>
        </div>
        <nav className={styles.nav} aria-label="约会陪伴页面">
          <div className={styles.navLinks}>
            {primaryDateCompanionScreens.map((candidate) => (
              <Link
                aria-current={screen === candidate || candidate === "people" && screen === "person" ? "page" : undefined}
                className={`${styles.navLink} ${screen === candidate || candidate === "people" && screen === "person" ? styles.navLinkActive : ""}`}
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
              disabledMessage={personQaAvailability.enabled ? undefined : personQaAvailability.message}
              enabled={personQaEnabled}
              mode="person"
              onActivate={() => session.activateQaMode("person")}
              onAsk={async (question) => { await session.ask(question); }}
              onCancel={session.cancelQa}
              onOpenTranscriptSource={(segmentId) => {
                const source = qaSourceBySegmentId.get(segmentId);
                return Boolean(source?.canOpenTranscript && session.selectCachedInteraction(source.uploadId));
              }}
              qaState={qaPresentation(session.qaState)}
              segmentTextById={segmentTextById}
              suggestedQuestions={relationshipSuggestedQuestions}
              validSegmentIds={validSegmentIds}
              linkableSegmentIds={linkableSegmentIds}
            />
          </div>
        </nav>
      </div>

      <div className={styles.shell}>
        <div className={styles.page}>
          {screen === "home" ? (
            <CompanionHome
              accountId={auth.user.id}
              currentInteraction={interaction}
              key={auth.user.id}
              onRetryRead={session.retryRead}
              onResolveToyReceipt={session.adoptToyIngestionReceipt}
              onUpload={session.upload}
              participantNotice={viewModel.home.participantNotice}
              homeContent={homeContent}
              onOpenSource={openSource}
              rememberedItem={viewModel.home.remembered}
              relationshipName={relationshipName}
              relationshipId={relationship.id}
              toySyncEnabled={props.toySyncEnabled ?? false}
              uploadState={uploadPresentation(session.uploadState, interaction?.status === "ready")}
            />
          ) : null}
          {screen === "person" ? (
            <CompanionPerson
              archiveState={resolvedPersonArchiveState}
              confirmedPerson={selectedConfirmedPerson}
              currentInteraction={interaction}
              isCurrentRelationship={selectedIsCurrentRelationship}
              onOpenInteraction={selectedIsCurrentRelationship ? async (candidate) => {
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
              } : undefined}
              onDeleteInteraction={selectedIsCurrentRelationship ? async (candidate) => {
                if (!candidate.relationshipInteractionId) return;
                await session.deleteInteraction(candidate.relationshipInteractionId);
              } : undefined}
              onOpenSource={selectedIsCurrentRelationship ? openSource : undefined}
              onSearch={selectedIsCurrentRelationship ? session.searchRelationship : undefined}
              onUpdatePromise={selectedIsCurrentRelationship ? async (promise, status) => {
                await session.updatePromise(promise.id, promise.version, status);
              } : undefined}
              person={selectedIsCurrentRelationship ? viewModel.person : undefined}
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
              onFinalize={canPersistRecap ? async (assignments, recapItems, voiceEnrollmentIntents, memoryAdmission) => {
                if (memoryAdmission) {
                  await session.finalizeRecap(
                    recapInteraction!.relationshipInteractionId!,
                    recapInteraction!.version!,
                    assignments,
                    recapItems,
                    voiceEnrollmentIntents,
                    memoryAdmission
                  );
                } else {
                  await session.finalizeRecap(
                    recapInteraction!.relationshipInteractionId!,
                    recapInteraction!.version!,
                    assignments,
                    recapItems,
                    voiceEnrollmentIntents
                  );
                }
                router.replace(
                  `/date-companion/a/recap?interaction=${encodeURIComponent(recapInteraction!.relationshipInteractionId!)}`
                );
              } : undefined}
              participants={viewModel.recap.participants}
              proactiveObservation={currentProactivePresentation ? (
                <CompanionProactiveObservation
                  onOpenSource={openSource}
                  presentation={currentProactivePresentation}
                />
              ) : undefined}
              proactiveObservationStatus={currentProactivePresentation?.status}
              memoryBridgeState={session.memoryBridgeState}
              memoryMutationState={session.memoryMutationState}
              onMemorySync={recapInteraction?.relationshipInteractionId ? async (selections, confirmation, relationshipReconfirmation) => {
                await session.syncInteractionMemory(
                  recapInteraction.relationshipInteractionId!,
                  selections,
                  confirmation,
                  relationshipReconfirmation
                );
              } : undefined}
              onMemoryRefresh={async () => {
                await session.ensureMemoryBridgeLoaded(true);
              }}
              questionControl={(
                <CompanionQuestionDrawer
                  answers={session.currentQaHistory}
                  disabledMessage={currentQaAvailability.enabled ? undefined : currentQaAvailability.message}
                  enabled={currentQaAvailability.enabled}
                  linkableSegmentIds={currentQaSegmentIds}
                  mode="current-interaction"
                  onActivate={() => session.activateQaMode("current-interaction")}
                  onAsk={async (question) => { await session.askCurrentInteraction(question); }}
                  onCancel={session.cancelQa}
                  onOpenTranscriptSource={(segmentId) => currentQaSegmentIds.has(segmentId)}
                  qaState={qaPresentation(session.currentQaState)}
                  segmentTextById={currentQaSegmentTextById}
                  suggestedQuestions={proactiveSuggestedQuestions(currentProactivePresentation)}
                  validSegmentIds={currentQaSegmentIds}
                />
              )}
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
          {screen === "people" ? (
            <CompanionPeople
              mutationState={session.memoryMutationState}
              onCreatePerson={session.createConfirmedPerson}
              onPurge={session.purgeRetainedMemory}
              onRefresh={() => session.ensureMemoryBridgeLoaded(true)}
              onRetry={(interactionId) => session.syncInteractionMemory(interactionId)}
              onSaveMapping={session.savePersonMapping}
              onSetRetention={session.setLongTermRetention}
              state={session.memoryBridgeState}
            />
          ) : null}
        </div>
      </div>
    </main>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  useDateCompanionSession,
  type DateCompanionSessionValue
} from "@/lib/client/date-companion-session";
import { useHomeMaterialRead, usePersistentDateCompanionSession } from "@/lib/client/date-companion-session-provider";
import { useDateCompanionPersonArchive } from "@/lib/client/date-companion-people";
import { PERSON_MATERIAL_READ_TIMEOUT_MS } from "@/lib/client/date-companion-read-deadline";
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
import type { AuthState, DateCompanionMemoryBridgeState, SourceRefVM, UploadState } from "@/lib/domain/date-companion";
import type { PreparationSource } from "@/lib/domain/date-companion-preparation";
import { bookPersonHref, bookPreparationHref, canonicalCompanionPath, preparationDiscussionFromQuery, safePersonReturnTo, safePreparationReturnTo } from "@/lib/domain/date-companion-book-navigation";
import { clearFormalNotebookDraftsForAccount } from "@/lib/client/date-companion-notebook";
import { keepPreparationSourceReturnFor } from "@/lib/client/preparation-source-return";
import { ProductAccountMenu } from "@/components/product-system/product-account-menu";
import { ProductState } from "@/components/product-system/product-primitives";
import { ProductSwitcher } from "@/components/product-system/product-switcher";

import { CompanionHome, type CompanionUploadPresentation } from "./companion-home";
import { BookRecapDetailReading, bookMeetingTitle } from "./book-recap";
import { bookHomeReading, keepBookHomeReadingFor } from "./book-home-reading-state";
import { CompanionLogin, type CompanionAuthMode } from "./companion-login";
import { CompanionMasthead } from "./companion-masthead";
import { CompanionPersonEdition, PersonEditionReading } from "./companion-person-edition";
import { confirmedDirectory, currentScrapbookPerson } from "./companion-person-scrapbook-model";
import { usePersonBookEntryCapture } from "./person-book-entrance";
import { CompanionPreparationBook, PreparationRestoring, type CompanionPreparationBookProps } from "./companion-preparation-book";
import { CompanionPrepare } from "./companion-prepare";
import { CompanionQaPaper } from "./companion-qa-paper";
import { BookObservation, BookTranscriptButton } from "./book-panels";
import { activateQaDraftAccount, clearQaDrafts, qaDraftKey } from "./companion-qa-drafts";
import { CompanionRecap } from "./companion-recap";
import { CompanionRelationshipSetup } from "./companion-relationship-setup";
import type { TranscriptChapterPresentation } from "./companion-transcript";
import styles from "./date-companion.module.css";
import homeChrome from "./book-home-chrome.module.css";

export const dateCompanionScreens = ["home", "person", "recap", "prepare", "people"] as const;
export type DateCompanionScreen = (typeof dateCompanionScreens)[number];
const primaryDateCompanionScreens = ["home", "prepare", "recap", "people"] as const;

function emptyMaterialNote(bridge: DateCompanionMemoryBridgeState) {
  if (bridge.status !== "ready" || bridge.mapping?.status !== "confirmed") return;
  if (!bridge.qaCatalogStatus || !["unlinked", "ready", "withdrawn"].includes(bridge.qaCatalogStatus) || bridge.relationshipPersonSources.length) return;
  const saved = bridge.review.interactions;
  if (saved.some(row => row.sourceState !== "explicitly_deleted" &&
    (row.status === "waiting_for_cleanup" || row.status === "pending" || row.status === "processing"))) {
    return "复盘已保存，相关材料正在处理。";
  }
  if (bridge.qaCatalogStatus === "withdrawn") return "这段关系的长期资料已撤回。可在已保存的单场复盘中重新选择并授权。";
  if (!saved.length) return "这段关系还没有已保存的相处资料，可以先完成一次相处复盘。";
  if (bridge.qaCatalogStatus === "unlinked" && saved.every(row =>
    row.sourceState === "explicitly_deleted" || row.status === "not_queued" || row.status === "cancelled")) {
    return "已有复盘，目前还没有可用于这段关系的材料。";
  }
}

type DateCompanionShellProps =
  | { entry: "login" }
  | {
      entry: "companion";
      screen: DateCompanionScreen;
      dailyReflectionEnabled?: boolean;
      toySyncEnabled?: boolean;
      showPreparationRecords?: boolean;
      initialPersonId?: string | null;
      initialSegmentId?: string | null;
      initialInteractionId?: string | null;
      initialRecordingId?: string | null;
      initialDiscussionId?: string | null;
      preparationReturnTo?: string | null;
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

function recapHref(target: { interaction?: string; recording?: string; segment?: string }) {
  const query = new URLSearchParams();
  if (target.interaction) query.set("interaction", target.interaction);
  else if (target.recording) query.set("recording", target.recording);
  if (target.segment) query.set("segment", target.segment);
  return screenPath("recap") + (query.size ? `?${query}` : "");
}

function safeProductReturn(value: string | null | undefined) {
  if (!value?.startsWith("/date-companion/a") || /[\\\u0000-\u001f\u007f]/u.test(value)) return null;
  const url = new URL(value, "http://localhost");
  if (url.origin !== "http://localhost" ||
    !/^\/date-companion\/a(?:\/(?:home|person|recap|prepare|people(?:\/[^/]+)?))?\/?$/u.test(url.pathname)) return null;
  return canonicalCompanionPath(url);
}

function translatedError(message: string) {
  const messages: Record<string, string> = {
    "Failed to fetch": "暂时无法连接服务，请检查连接后重试。",
    "Load failed": "暂时无法连接服务，请检查连接后重试。",
    "NetworkError when attempting to fetch resource.": "暂时无法连接服务，请检查连接后重试。",
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

function BookPreparationPage({ masthead, readError, onRetry, ...book }: CompanionPreparationBookProps & {
  masthead?: ReactNode; readError?: string; onRetry?: () => void;
}) {
  return <main className={`${styles.companionPage} ${homeChrome.home}`} data-edition="book-prepare" data-screen="prepare">
    {masthead ?? <div className={`${styles.companionChrome} ${homeChrome.mast} ${homeChrome.openingMast}`} aria-hidden="true">
      <span>Daily Brief</span><span className={homeChrome.product}>约会陪伴</span>
      <div>首页　 <b>准备</b>　 复盘　 人物</div>
    </div>}
    <div className={`${styles.shell} ${homeChrome.canvas}`}><div className={styles.page}>
      {readError ? <PreparationRestoring error={readError} retry={onRetry} /> : <CompanionPreparationBook {...book} />}
    </div></div>
  </main>;
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
      return { status: "uploading", fileName: uploadState.fileName, recordingDate: uploadState.recordingDate };
    case "processing":
      return { status: "processing", jobStatus: uploadState.jobStatus, progress: uploadState.progress,
        uploadId: uploadState.receipt?.uploadId ?? uploadState.failedReceipt?.uploadId,
        errorMessage: uploadState.statusMessage?.startsWith("这次进度") ? uploadState.statusMessage : undefined };
    case "ready":
      return {
        status: "ready",
        uploadId: uploadState.uploadId,
        ...(uploadState.serverCleanupStatus === "not_completed"
          ? {
              cleanupWarningMessage: `本机结果和已确认内容仍在；服务器原结果尚未清理，可重新读取后重试${uploadState.cleanupMessage ? `：${translatedError(uploadState.cleanupMessage)}` : "。"}`
            }
          : {})
      };
    case "failed": {
      const message = translatedError(uploadState.message);
      if (uploadState.failureStage === "cache" && uploadState.serverDataRetained && currentReady) {
        return { status: "ready", uploadId: uploadState.uploadId, failureStage: "cache", hasReceipt: true, cacheErrorMessage: message };
      }
      return {
        status: "failed",
        uploadId: uploadState.uploadId, failureStage: uploadState.failureStage,
        hasReceipt: Boolean(uploadState.receipt || uploadState.failedReceipt || uploadState.uploadId),
        errorMessage: message
      };
    }
  }
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
  const searchParams = useSearchParams();
  const signingOut = useRef(false);
  const { auth, viewModel } = session;
  // A return point only lives on the prepare → its source recap → prepare path.
  const returnTarget = props.entry === "companion" && props.screen === "recap"
    ? safePreparationReturnTo(props.preparationReturnTo) : null;
  const permittedDiscussion = props.entry === "companion" && props.screen === "prepare" && !props.showPreparationRecords
    ? searchParams?.get("preparation") : returnTarget ? new URL(returnTarget, "http://localhost").searchParams.get("preparation") : null;
  const scopeAccount = auth.status === "authenticated" ? auth.user.id : undefined;
  useEffect(() => { if (scopeAccount) activateQaDraftAccount(scopeAccount); }, [scopeAccount]);
  const scopeRelationship = session.relationshipState.status === "ready" ? session.relationshipState.relationship.id : undefined;
  useEffect(() => keepPreparationSourceReturnFor(scopeAccount, scopeRelationship, permittedDiscussion), [scopeAccount, scopeRelationship, permittedDiscussion]);
  const homeReadingScope = auth.status === "authenticated" && session.relationshipState.status === "ready"
    ? JSON.stringify([auth.user.id,session.relationshipState.relationship.id]) : undefined;
  usePersonBookEntryCapture(homeReadingScope);
  useEffect(() => keepBookHomeReadingFor(homeReadingScope), [homeReadingScope]);
  const homeScreen = props.entry === "companion" && props.screen === "home";
  const personScreen = props.entry === "companion" && (props.screen === "people" || props.screen === "person");
  const recapScreen = props.entry === "companion" && props.screen === "recap";
  const personSection = searchParams?.get("section") ?? null;
  const lastSaved = viewModel.home.lastSaved;
  const historyDetailId = lastSaved?.interaction.detailLoaded === false ? lastSaved.interaction.relationshipInteractionId : undefined;
  const historyRead = historyDetailId && (session.detailReadState.status === "loading" || session.detailReadState.status === "error")
    && session.detailReadState.interactionId === historyDetailId ? session.detailReadState : null;
  useEffect(() => {
    if (homeScreen && historyDetailId && session.relationshipState.status === "ready") void session.readSavedMeeting(historyDetailId);
  }, [homeScreen, historyDetailId, session.readSavedMeeting, session.relationshipState.status]);
  const [authMode, setAuthMode] = useState<CompanionAuthMode>("login");
  const explicitInteractionId = recapScreen ? props.initialInteractionId?.trim() || null : null;
  const recordingLinkId = recapScreen && !explicitInteractionId ? props.initialRecordingId : null;
  // A saved recap remains readable after browser-cache cleanup of the raw upload.
  // Only the signed-in relationship's confirmed history may resolve the old recording ID.
  const savedRecordingInteractionId = recordingLinkId ? viewModel.recap.history.find(record =>
    record.sourceUploadId === recordingLinkId && record.persistenceStatus === "confirmed" &&
    record.sourceState !== "explicitly_deleted"
  )?.relationshipInteractionId : undefined;
  const requestedRecapInteractionId = explicitInteractionId ?? savedRecordingInteractionId ?? null;
  const requestedRecordingId = requestedRecapInteractionId ? null : recordingLinkId;
  const activeRecordingId = viewModel.currentInteraction?.sourceUploadId ?? viewModel.currentInteraction?.id;
  const loginReturn = props.entry === "login" ? safeProductReturn(searchParams?.get("returnTo")) : null;
  useEffect(() => {
    if (props.entry === "login" && auth.status === "authenticated") router.replace(loginReturn ?? "/");
    if (props.entry === "companion" && auth.status === "anonymous" && !signingOut.current) {
      const { pathname, search, hash } = window.location;
      const target = safeProductReturn(pathname + search + hash);
      router.replace(target ? "/date-companion?" + new URLSearchParams({returnTo:target}) : "/date-companion");
    }
  }, [auth.status, loginReturn, props.entry, router]);

  useEffect(() => {
    if (
      props.entry === "companion"
      && props.screen === "recap"
      && session.relationshipState.status === "ready"
    ) {
      if (requestedRecordingId) {
        if (activeRecordingId !== requestedRecordingId) {
          const controller = new AbortController();
          void session.readRecordingForRecap(requestedRecordingId, controller.signal).then(selected => {
            if (!selected && !controller.signal.aborted) router.replace(screenPath("home"));
          }).catch(() => { if (!controller.signal.aborted) router.replace(screenPath("home")); });
          return () => controller.abort();
        }
        session.selectRelationshipInteraction(null);
        return;
      }
      const selected = session.selectRelationshipInteraction(requestedRecapInteractionId);
      if (requestedRecapInteractionId && !selected) router.replace(screenPath("home"));
    }
  }, [
    props.entry,
    props.entry === "companion" ? props.screen : undefined,
    requestedRecapInteractionId,
    requestedRecordingId,
    activeRecordingId,
    session.readRecordingForRecap,
    router,
    session.relationshipState.status,
    session.relationshipState.status === "ready" ? session.relationshipState.relationship.id : undefined,
    viewModel.recap.interaction?.relationshipInteractionId,
    session.selectRelationshipInteraction
  ]);

  useEffect(() => {
    if (props.entry === "companion" && session.relationshipState.status === "ready") {
      void session.ensureMemoryBridgeLoaded();
    }
  }, [props.entry, session.ensureMemoryBridgeLoaded, session.relationshipState.status]);

  const showPreparationRecords = props.entry === "companion" && props.screen === "prepare" && props.showPreparationRecords === true;
  useEffect(() => {
    if (showPreparationRecords && scopeRelationship) void session.ensureRelationshipDetailsLoaded();
  }, [showPreparationRecords, scopeRelationship, session.ensureRelationshipDetailsLoaded]);

  const personQaSources = useMemo(
    () => session.personQaSources().map(source => ({ ...source, speakerLabel: session.sourceSpeakerLabel(source) })),
    [session.memoryBridgeState, session.personQaSources, session.sourceSpeakerLabel, viewModel]
  );
  const personQaAvailability = session.personQaAvailability();
  const currentQaAvailability = session.currentInteractionQaAvailability();
  const currentQaInteraction = viewModel.recap.interaction;
  const recordingReview = currentQaInteraction ? session.recordingSpeakerReview(currentQaInteraction.id) : undefined;
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
    () => {
      const promises = viewModel.person.promises.flatMap((promise) => promise.sources);
      return [...personQaSources, ...promises.map(source => ({...source, speakerLabel: session.sourceSpeakerLabel(source)}))];
    }, [personQaSources, viewModel.person.promises, session.sourceSpeakerLabel]
  );
  const relationshipProactiveSourceRevision = useMemo(
    () => dateCompanionProactiveSourceRevision(homeCanonicalSources, JSON.stringify(
      viewModel.person.promises.map((promise) => [promise.id, promise.status, promise.version, promise.text])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
    )),
    [homeCanonicalSources, viewModel.person.promises]
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
    && currentQaInteraction.detailLoaded !== false
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
    && props.entry === "companion" && props.screen !== "prepare"
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
  const [homeContentReadRevision, setHomeContentReadRevision] = useState(0);
  const lastHomeRead = useHomeMaterialRead();
  const relationshipProactiveState = useDateCompanionProactiveValue(relationshipProactiveTarget, undefined, homeContentReadRevision,
    props.entry === "companion" && props.screen !== "prepare" ? lastHomeRead : null);
  const relationshipIdentityPending = session.memoryBridgeState.status === "ready"
    && (!proactiveMapping || proactiveMapping.status !== "confirmed" || proactiveMapping.selfPersonId === proactiveMapping.companionPersonId);
  const currentProactivePresentation = useMemo(
    () => currentProactiveState.status === "ready"
      ? presentDateCompanionProactiveValue(
          currentProactiveState.response,
          currentProactiveSources
        )
      : null,
    [currentProactiveSources, currentProactiveState]
  );
  const materialNote = emptyMaterialNote(session.memoryBridgeState);
  const homeContent: DateCompanionHomeContentState = useMemo(() => {
    if (session.memoryBridgeState.status === "idle" || session.memoryBridgeState.status === "loading") return { status: "loading" };
    if (session.memoryBridgeState.status === "error") return { status: "unavailable" };
    if (session.memoryBridgeState.status === "ready" && session.memoryBridgeState.qaCatalogStatus === "withdrawn" && materialNote) return { status: "empty", note: materialNote };
    if (relationshipProactiveState.status === "idle") {
      if (session.memoryBridgeState.status === "ready" && session.memoryBridgeState.mapping?.status === "confirmed") {
        if (materialNote) return { status: "empty", note: materialNote };
        if (session.memoryBridgeState.qaCatalogStatus === "needs_review") return { status: "unavailable", reason: "qualification" };
        if (session.memoryBridgeState.qaCatalogStatus === "unavailable" || session.memoryBridgeState.qaCatalogStatus === "unlinked") return { status: "unavailable" };
      }
      return { status: "empty" };
    }
    if (relationshipProactiveState.status === "loading") return { status: "loading" };
    if (relationshipProactiveState.status === "unavailable") return { status: "unavailable", reason: relationshipProactiveState.reason };
    if (relationshipProactiveState.response.status === "fallback") return { status: "unavailable", reason: "generation" };
    const content = presentDateCompanionHomeContent(relationshipProactiveState.response, homeCanonicalSources);
    if (!content || content.beforeMeeting.some((item) => item.kind === "open_promise"
      && !viewModel.person.promises.some((promise) => promise.id === item.promiseId && promise.status === "open"))) {
      return { status: "unavailable", reason: "sources" };
    }
    return content.about.length > 0 || content.beforeMeeting.length > 0
      ? { status: "ready", content, refresh: relationshipProactiveState.refresh }
      : { status: "empty" };
  }, [homeCanonicalSources, relationshipProactiveState, viewModel.person.promises, session.memoryBridgeState, materialNote]);
  const requestedPersonId = props.entry === "companion" && props.screen === "person"
    ? props.initialPersonId?.trim() || null
    : null;
  const readyMemoryBridge = session.memoryBridgeState.status === "ready"
    ? session.memoryBridgeState
    : null;
  const selfPersonId = readyMemoryBridge?.mapping?.selfPersonId ?? readyMemoryBridge?.selfBinding?.personId ?? null;
  const verifiedCompanionId = currentScrapbookPerson(session.memoryBridgeState);
  const singleConfirmedPersonId = verifiedCompanionId && confirmedDirectory(session.memoryBridgeState).length === 1
    ? verifiedCompanionId : null;
  const singlePerson = props.entry === "companion" && props.screen === "people" && !personSection ? singleConfirmedPersonId : null;
  useEffect(() => {
    if (props.entry === "companion" && props.screen === "people" && !personSection &&
      ["#people-mapping-title", "#trust-controls"].includes(window.location.hash)) {
      router.replace(bookPersonHref(null, "manage") + window.location.hash, {scroll: false});
      return;
    }
    // A resolved sole-person /people entry stays on this page. Replacing the
    // catch-all route would discard its archive read and already readable papers.
  }, [personSection, props.entry === "companion" ? props.screen : null, router]);
  const selectedPersonId = singlePerson ?? (props.entry === "companion" && props.screen === "person"
    ? requestedPersonId ?? verifiedCompanionId
    : null);
  const selectedConfirmedPerson = selectedPersonId
    ? readyMemoryBridge?.people.find((person) => person.id === selectedPersonId) ?? null
    : null;
  const personArchiveTarget = selectedConfirmedPerson && selectedConfirmedPerson.id !== selfPersonId
    ? selectedConfirmedPerson.id
    : null;
  const [archiveRevision, setArchiveRevision] = useState(0);
  const archiveScope = JSON.stringify([scopeAccount, scopeRelationship, readyMemoryBridge?.mapping?.id,
    readyMemoryBridge?.mapping?.version, readyMemoryBridge?.selfBinding?.version, readyMemoryBridge?.withdrawalVersion,
    readyMemoryBridge?.relationshipPersonSources.map(source => [source.evidenceSnapshotId, source.authorizationRevision])]);
  const personArchiveState = useDateCompanionPersonArchive(personArchiveTarget, archiveScope, archiveRevision);
  const needsPersonDetails = personScreen && verifiedCompanionId !== null && verifiedCompanionId === selectedPersonId;
  useEffect(() => {
    if (needsPersonDetails && scopeRelationship) void session.ensureRelationshipDetailsLoaded({ timeoutMs: PERSON_MATERIAL_READ_TIMEOUT_MS });
  }, [needsPersonDetails, scopeRelationship, session.ensureRelationshipDetailsLoaded]);

  if (personScreen && (auth.status === "checking" || auth.status === "authenticated" &&
    ["idle", "loading", "error"].includes(session.relationshipState.status))) {
    return <main className={`${styles.companionPage} ${homeChrome.home}`} data-edition="book-person">
      <div className={`${styles.companionChrome} ${homeChrome.mast} ${homeChrome.openingMast}`} aria-hidden="true">
        <span>Daily Brief</span><span className={homeChrome.product}>约会陪伴</span><div>首页　准备　复盘　<b>人物</b></div>
      </div>
      <PersonEditionReading error={session.relationshipState.status === "error" ? translatedError(session.relationshipState.message) : undefined}
        retry={() => void session.refreshRelationship()} />
    </main>;
  }

  const showingNotebook = props.entry === "companion" && props.screen === "prepare" && !showPreparationRecords;
  const preparationTarget = searchParams ? preparationDiscussionFromQuery(searchParams.get("preparation"), searchParams.get("draft"))
    : props.entry === "companion" ? props.initialDiscussionId : undefined;
  if (showingNotebook) {
    if (auth.status === "checking" || auth.status === "authenticated" && ["idle", "loading"].includes(session.relationshipState.status)) {
      return <BookPreparationPage session={session} initialDiscussionId={preparationTarget} />;
    }
    if (auth.status === "authenticated" && session.relationshipState.status === "error") {
      return <BookPreparationPage session={session} initialDiscussionId={preparationTarget}
        readError={translatedError(session.relationshipState.message)} onRetry={() => void session.refreshRelationship()} />;
    }
    if (auth.status === "error") {
      return <BookPreparationPage session={session} initialDiscussionId={preparationTarget}
        readError={translatedAuthError(auth.message, "login")} onRetry={() => window.location.reload()} />;
    }
  }
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

  if (session.relationshipState.status === "idle" || session.relationshipState.status === "loading") {
    return <LoadingScreen label="正在找回你和 Ta 的记录…" />;
  }

  if (
    (session.relationshipState.status === "absent" && props.screen !== "prepare")
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

  if (session.relationshipState.status !== "ready" && session.relationshipState.status !== "absent") {
    return <LoadingScreen label="正在找回你和 Ta 的记录…" />;
  }

  if (
    (requestedRecapInteractionId && currentQaInteraction?.relationshipInteractionId !== requestedRecapInteractionId)
    || (requestedRecordingId && (currentQaInteraction?.sourceUploadId ?? currentQaInteraction?.id) !== requestedRecordingId)
  ) {
    return <LoadingScreen label="正在找回这次相处…" />;
  }

  const screen = props.screen;
  const interaction = viewModel.currentInteraction;
  const relationship = session.relationshipState.status === "ready" ? session.relationshipState.relationship : null;
  const relationshipName = relationship?.displayName?.trim() || "Ta";
  const lastMeeting = lastSaved?.interaction;
  const homeCurrentTarget = interaction?.persistenceStatus === "confirmed"
    ? { interaction: interaction.relationshipInteractionId } : { recording: activeRecordingId };
  const currentRecapHref = activeRecordingId ? recapHref(homeCurrentTarget) : undefined;
  const chapters: TranscriptChapterPresentation[] = viewModel.recap.chapters.map((chapter) => ({
    id: chapter.id,
    title: chapter.title,
    startSeconds: chapter.startSeconds,
    endSeconds: chapter.endSeconds,
    segmentIds: chapter.sourceSegmentIds
  }));
  const recapInteraction = viewModel.recap.interaction;
  const preparationReturnTo = safePreparationReturnTo(props.preparationReturnTo);
  const personReturn = recapScreen && requestedRecapInteractionId &&
    viewModel.recap.history.some(record => record.relationshipInteractionId === requestedRecapInteractionId)
    ? safePersonReturnTo(searchParams?.get("returnTo"), verifiedCompanionId, singleConfirmedPersonId) : null;
  const currentDiscussionId = preparationTarget;
  const sourceOrigin = bookHomeReading(homeReadingScope);
  const returningToHomeSource = recapScreen && sourceOrigin
    && sourceOrigin.segmentId === props.initialSegmentId
    && sourceOrigin.uploadId === (recapInteraction?.sourceUploadId ?? recapInteraction?.id);
  const preparationSourceHref = (source: PreparationSource) => {
    const back = safePreparationReturnTo(window.location.pathname + window.location.search) ?? bookPreparationHref(currentDiscussionId);
    let url: URL;
    try { url = new URL(source.href, window.location.origin); }
    catch { return bookPreparationHref(currentDiscussionId); }
    if (url.origin !== window.location.origin) return bookPreparationHref(currentDiscussionId);
    if (url.pathname === screenPath("recap") && source.interactionId) {
      url.searchParams.set("interaction", source.interactionId);
      url.searchParams.set("returnTo", back);
      return canonicalCompanionPath(url);
    }
    return url.pathname === screenPath("person") ? canonicalCompanionPath(url) : bookPreparationHref(currentDiscussionId);
  };
  const recapTarget = recapInteraction?.persistenceStatus === "confirmed"
    ? { interaction: recapInteraction.relationshipInteractionId }
    : { recording: recapInteraction?.sourceUploadId ?? recapInteraction?.id };
  const detailPending = showPreparationRecords && relationship !== null && !session.relationshipDetailsLoaded;
  const detailRead = session.detailReadState;
  const recapRead = (detailRead.status === "loading" || detailRead.status === "error")
    && detailRead.interactionId === recapInteraction?.relationshipInteractionId ? detailRead : undefined;
  const canPersistRecap = Boolean(
    recapInteraction?.relationshipInteractionId
    && recapInteraction.persistenceStatus === "draft"
    && typeof recapInteraction.version === "number"
  );
  const latestConfirmedInteractionId = viewModel.person.interactions.at(-1)?.relationshipInteractionId;
  const isOtherPerson = Boolean(personScreen && selectedPersonId && verifiedCompanionId && selectedPersonId !== verifiedCompanionId);
  const scopedQaSources = personQaAvailability.enabled ? session.scopedPersonQaSources() : [];
  const verifiedName = readyMemoryBridge?.people.find(person => person.id === verifiedCompanionId)?.displayName;
  // A recording-local role can be known even without an admitted link to a named person.
  const namedRecordings = new Set(readyMemoryBridge?.qaCatalogStatus === "ready" ? scopedQaSources.map(source => source.uploadId) : []);
  const qaSpeakerLabel: typeof session.sourceSpeakerLabel = source =>
    session.sourceSpeakerLabel(source, namedRecordings.has(source.uploadId) ? verifiedName ?? null : null);
  const verifyingPerson = session.memoryBridgeState.status === "loading" || session.memoryBridgeState.status === "idle";
  const paperQaReason = verifyingPerson ? "正在核对当前关系的人物和材料…" :
    isOtherPerson ? "这里浏览的是另一位人物。请回到当前关系的 Ta 再提问。" :
    session.memoryBridgeState.status === "error" ? "暂时未能读取当前关系的人物资料。" :
    !personQaAvailability.enabled && readyMemoryBridge ? "请到「人物」打开「核对我和 Ta」，在「确认当前这段关系」中核实双方身份。" :
    !personQaAvailability.enabled ? personQaAvailability.message :
    readyMemoryBridge?.qaCatalogStatus === "needs_review" ? "人物或材料的归属需要重新核对。" :
    !scopedQaSources.length && materialNote ? materialNote :
    readyMemoryBridge?.qaCatalogStatus !== "ready" ? "暂时未能读取当前关系的材料。" :
    !scopedQaSources.length ? "这段关系还没有可用于问答的已核实材料。" : undefined;
  const verifiedQuestions = !paperQaReason && relationshipProactiveState.status === "ready"
    ? proactiveSuggestedQuestions(presentDateCompanionProactiveValue(relationshipProactiveState.response, scopedQaSources))
    : [];

  const openSource = (source: SourceRefVM, segmentId: string) => {
    if (!source.canOpenTranscript) return;
    const record = viewModel.recap.history.find(entry => entry.sourceUploadId === source.uploadId);
    const destination = recapHref({
      interaction: record?.relationshipInteractionId,
      recording: source.uploadId,
      segment: segmentId
    });
    router.push(destination + "#full-transcript");
  };
  const resolvedPersonArchiveState = props.entry === "companion"
    && props.screen === "person"
    && !readyMemoryBridge
    ? { status: "loading" as const }
    : requestedPersonId && readyMemoryBridge && (!selectedConfirmedPerson || requestedPersonId === selfPersonId)
      ? { status: "not_found" as const }
      : personArchiveState;

  const masthead = <CompanionMasthead
    relationshipName={relationshipName}
    productMenu={<ProductSwitcher
      accountId={auth.user.id}
      brandLabel="Daily Brief"
      paperMotion
      currentProduct="date_companion"
      dailyReflectionEnabled={props.dailyReflectionEnabled ?? false}
    />}
    accountMenu={<ProductAccountMenu
      paperMotion
      onLogout={async () => {
        signingOut.current = true;
        try { await session.logout(); }
        catch (error) { signingOut.current = false; throw error; }
        clearQaDrafts(auth.user.id);
        clearFormalNotebookDraftsForAccount(auth.user.id);
        router.replace("/date-companion");
      }}
      userLabel={auth.user.name?.trim() || auth.user.email}
    />}
    LinkComponent={Link}
    tabs={primaryDateCompanionScreens.map(candidate => ({
      label: SCREEN_LABELS[candidate],
      active: screen === candidate || candidate === "people" && screen === "person",
      // Resolve the known book before navigating: /people → /people/id mounts
      // two catch-all pages and can replace already readable papers with loading.
      href: candidate === "people" && singleConfirmedPersonId ? bookPersonHref(singleConfirmedPersonId) :
        candidate === "recap" ? (recapScreen ? recapHref(recapTarget) : currentRecapHref || recapHref({
          interaction: lastMeeting?.relationshipInteractionId
        })) : screenPath(candidate)
    }))}
    actions={<CompanionQaPaper
      mode="person" title={verifiedName ? `关于${verifiedName}` : "问问 Ta"}
      openFromLink={screen === "home" && searchParams?.get("qa") === "ta"}
      scopeKey={!isOtherPerson && scopeRelationship && personQaAvailability.enabled
        ? qaDraftKey(auth.user.id, "relationship", scopeRelationship, personQaAvailability.personId, personQaAvailability.mappingVersion) : null}
      enabled={!paperQaReason} disabledMessage={paperQaReason} verifying={verifyingPerson}
      checkCatalog={!isOtherPerson ? session.checkOpenQaCatalog : undefined}
      onRetryRead={!isOtherPerson && (session.memoryBridgeState.status === "error" ||
        personQaAvailability.enabled && !materialNote && (readyMemoryBridge?.qaCatalogStatus === "unavailable" || readyMemoryBridge?.qaCatalogStatus === "unlinked"))
        ? () => void session.ensureMemoryBridgeLoaded(true) : undefined}
      answers={paperQaReason ? [] : session.qaHistory}
      withheldCount={!isOtherPerson && personQaAvailability.enabled && readyMemoryBridge?.qaCatalogStatus === "ready" ? session.qaWithheldHistoryCount : undefined}
      qaState={session.qaState}
      sources={scopedQaSources} sourceDay={session.qaSourceDay} sourceSpeakerLabel={qaSpeakerLabel}
      suggestedQuestions={verifiedQuestions.length ? verifiedQuestions : !paperQaReason && relationshipProactiveState.status === "ready"
        ? homeAboutSuggestedQuestions(relationshipProactiveState.response, scopedQaSources, "concise") : []}
      onActivate={() => session.activateQaMode("person")} onAsk={session.ask} onCancel={session.cancelQa}
    />}
  />;
  if (showingNotebook) return <BookPreparationPage masthead={masthead} session={session}
    initialDiscussionId={currentDiscussionId} recordHref={preparationSourceHref} onVisitSource={href => router.push(href)}
    onUnauthorized={() => { clearQaDrafts(auth.user.id); clearFormalNotebookDraftsForAccount(auth.user.id); router.replace("/date-companion"); }} />;

  return (
    <main className={[styles.companionPage, homeChrome.home].join(" ")}
      data-edition={personScreen ? "book-person" : homeScreen ? "book-home" : "book"}
      data-screen={showPreparationRecords ? "prepare-records" : screen}>
      {masthead}
      <div className={`${styles.shell} ${homeChrome.canvas}`}>
        <div className={styles.page}>
          {recapScreen && (preparationReturnTo || personReturn) ? (
            <div className={homeChrome.editionRow}>
              {preparationReturnTo && <Link className={homeChrome.returnLink} href={preparationReturnTo} scroll={false}>← 返回刚才的准备</Link>}
              {personReturn && <Link className={homeChrome.returnLink} href={personReturn} scroll={false} data-person-book-return>← 返回刚才的人物记录</Link>}
            </div>
          ) : null}
          {personScreen && relationship?.id ? (
            personSection === "records" && needsPersonDetails && !session.relationshipDetailsLoaded ? <PersonEditionReading
              error={session.detailReadState.status === "error" ? session.detailReadState.message : undefined}
              retry={() => void session.ensureRelationshipDetailsLoaded()} /> :
            <CompanionPersonEdition key={JSON.stringify([scopeAccount,scopeRelationship,selectedPersonId])}
              session={session} accountId={auth.user.id} relationshipId={relationship.id}
              personId={selectedPersonId} currentPersonId={verifiedCompanionId} section={personSection}
              screen={singlePerson || screen === "person" ? "person" : "people"} archiveState={resolvedPersonArchiveState}
              retryArchive={() => setArchiveRevision(value => value + 1)} />
          ) : recapScreen && relationship && recapInteraction?.relationshipInteractionId &&
            recapInteraction.sourceState !== "explicitly_deleted" && recapInteraction.detailLoaded === false ? (
            <BookRecapDetailReading
              interaction={recapRead?.targetUnavailable ? null : recapInteraction}
              error={recapRead?.status === "error" ? recapRead.message : undefined}
              onRetry={() => void session.retryInteractionDetail()}
            />
          ) : detailPending ? (
            <div role={session.detailReadState.status === "error" ? "alert" : "status"}>
              <p>{session.detailReadState.status === "error" ? session.detailReadState.message : "正在读取相处内容…"}</p>
              {session.detailReadState.status === "error" ? (
                <button type="button" onClick={() => void session.ensureRelationshipDetailsLoaded()}>重新读取</button>
              ) : null}
            </div>
          ) : <>
          {screen === "home" ? (
            <CompanionHome
              book={{
                scopeKey:homeReadingScope, relationshipId: relationship?.id,
                lastSaved: lastMeeting?.relationshipInteractionId && !historyRead?.targetUnavailable ? {
                  id:lastMeeting.relationshipInteractionId, title:bookMeetingTitle(lastMeeting),
                  date:lastMeeting.recordingDate, summary:lastSaved?.summary
                } : null,
                historyStatus: historyDetailId ? historyRead?.status === "error" ? "error" : "loading" : "ready",
                historyError: historyRead?.status === "error" ? historyRead.message : undefined,
                onRetryHistory: historyDetailId ? () => void session.readSavedMeeting(historyDetailId) : undefined,
                onRetryContent: () => {
                  if (session.memoryBridgeState.status === "error" || (session.memoryBridgeState.status === "ready" &&
                    session.memoryBridgeState.qaCatalogStatus !== "ready")) void session.ensureMemoryBridgeLoaded(true);
                  else setHomeContentReadRevision(value => value + 1);
                },
                currentRecapHref, href:href => href
              }}
              accountId={auth.user.id}
              currentInteraction={interaction}
              key={auth.user.id + ":" + (relationship?.id ?? "")}
              onRetryRead={session.uploadState.status === "processing" ? session.readProcessingProgress : session.retryRead}
              onResolveToyReceipt={session.adoptToyIngestionReceipt}
              onUpload={session.upload}
              participantNotice={relationshipIdentityPending
                ? "先确认这段关系中的“我”和“Ta”，再查看人物近况与见面准备。" : viewModel.home.participantNotice}
              participantReviewHref={relationshipIdentityPending ? bookPersonHref(null,"manage") + "#people-mapping-title" : undefined}
              homeContent={homeContent}
              onOpenSource={openSource}
              relationshipName={relationshipName}
              relationshipId={relationship?.id}
              toySyncEnabled={props.toySyncEnabled ?? false}
              uploadState={uploadPresentation(session.uploadState, interaction?.status === "ready")}
            />
          ) : null}
          {screen === "recap" ? (
            <CompanionRecap
              key={recapInteraction?.sourceUploadId ?? recapInteraction?.id}
              bookHomeHref={screenPath("home")}
              onReturnToSourceOrigin={preparationReturnTo ? () => router.push(preparationReturnTo, { scroll: false }) : returningToHomeSource ? () => router.back() : undefined}
              relationshipName={relationshipName}
              chapters={chapters}
              initialSegmentId={props.initialSegmentId}
              interaction={recapInteraction}
              items={viewModel.recap.items}
              mutationState={session.mutationState}
              onSaveSegmentReview={canPersistRecap ? assignments => session.updateParticipants(
                recapInteraction!.relationshipInteractionId!, recapInteraction!.version!, assignments
              ) : undefined}
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
                // Both recording and interaction URLs remain valid after confirmation.
              } : undefined}
              participants={viewModel.recap.participants}
              proactiveObservation={currentProactivePresentation ? <BookObservation presentation={currentProactivePresentation} /> : undefined}
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
              questionControl={<CompanionQaPaper mode="current-interaction"
                title={bookMeetingTitle(currentQaInteraction)}
                scopeKey={scopeRelationship && currentQaAvailability.enabled
                  ? qaDraftKey(auth.user.id, "recording", scopeRelationship, currentQaAvailability.uploadId) : null}
                enabled={currentQaAvailability.enabled} disabledMessage={currentQaAvailability.enabled ? undefined : currentQaAvailability.message}
                disabledAction={!currentQaAvailability.enabled && currentQaAvailability.reason === "missing_local_transcript"
                  ? <BookTranscriptButton className="qa-link"/> : undefined}
                verifying={false} answers={session.currentQaHistory} qaState={session.currentQaState}
                recordingId={currentQaAvailability.enabled ? currentQaAvailability.uploadId : undefined}
                recordingRevision={currentQaInteraction?.transcript} sources={[]} sourceDay={session.qaSourceDay}
                recordingReview={recordingReview}
                sourceSpeakerLabel={qaSpeakerLabel}
                suggestedQuestions={proactiveSuggestedQuestions(currentProactivePresentation)}
                onActivate={() => session.activateQaMode("current-interaction")} onAsk={session.askCurrentInteraction} onCancel={session.cancelQa}
              />}
            />
          ) : null}
          {showPreparationRecords && <CompanionPrepare
            items={viewModel.prepare.items} openPromises={viewModel.prepare.openPromises}
            relationshipName={relationshipName} latestInteractionId={latestConfirmedInteractionId} onOpenSource={openSource}
          />}
          </>}
        </div>
      </div>
    </main>
  );
}

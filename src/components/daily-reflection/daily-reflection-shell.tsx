"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ReflectionRecordingRecovery } from "./reflection-recording-recovery";
import { activeUploadFailure, reflectionUploadLabel } from "./reflection-upload-status";
import { reflectionUploadFailureMessage } from "@/lib/client/daily-reflection-api";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { isSupportedAudioUpload } from "@/lib/audio/compat";
import {
  BrowserAudioRecorder,
  type BrowserAudioRecorderSnapshot,
  type BrowserAudioRecording
} from "@/lib/client/browser-audio-recorder";
import {
  createDailyReflectionApi,
  DailyReflectionApiError,
  type DailyReflectionApi,
  type DailyReflectionMemoryProposalCreateRequest
} from "@/lib/client/daily-reflection-api";
import {
  useDailyReflectionSession,
  type DailyReflectionManualCandidateDraft,
  type DailyReflectionSessionValue
} from "@/lib/client/daily-reflection-session";
import type {
  DailyReflectionCardView,
  DailyReflectionCardDecision,
  DailyReflectionCandidateView,
  DailyReflectionCandidateDecision,
  DailyReflectionDetailResponse,
  DailyReflectionHistoryItem
} from "@/lib/domain/daily-reflection-api";
import type { SourceOrigin } from "@/lib/domain/daily-reflection";
import type {
  DailyReflectionMemoryProposalAcknowledgement,
  DailyReflectionMemoryProposalConfirmationRequirement,
  DailyReflectionMemoryRecommendationResponse
} from "@/lib/domain/daily-reflection-memory-proposal";
import {
  ProductEvidence,
  ProductReviewCompletion
} from "@/components/product-system/product-primitives";

import {
  DailyReflectionTranscript,
  type TranscriptFocusRequest
} from "./daily-reflection-transcript";
import { DailyReflectionToySync } from "./daily-reflection-toy-sync";
import styles from "./daily-reflection.module.css";
import { REFLECTION_ROUTES, reflectionSessionPath } from "./reflection-product";
import { ReflectionConfirmDialog } from "./reflection-confirm-dialog";

const MAX_CLIENT_FILE_BYTES = 300 * 1024 * 1024;
const RECORDING_HINT_AFTER_MS = 150_000;
const LONG_RECORDING_HINT_AFTER_MS = 180_000;

const EMPTY_RECORDER_SNAPSHOT: BrowserAudioRecorderSnapshot = {
  state: "idle",
  durationHint: "none",
  clientReportedDurationMs: null,
  recording: null
};

export type DailyReflectionUploadSource = Extract<
  SourceOrigin,
  "user_reflection" | "direct_conversation"
>;

const SOURCE_OPTIONS: ReadonlyArray<{
  label: string;
  value: DailyReflectionUploadSource;
}> = [
  { value: "user_reflection", label: "我自己的复盘" },
  { value: "direct_conversation", label: "我和其他人的真实交流" }
];

const CANDIDATE_TYPE_LABELS: Record<DailyReflectionCandidateView["candidateType"], string> = {
  event: "发生的事",
  commitment: "约定与行动",
  question: "仍待回答的问题",
  preference: "表达的偏好",
  summary: "这段内容的整理"
};

const CANDIDATE_KIND_LABELS = {
  insight: "一个发现",
  open_question: "还想继续想的问题",
  decision: "一个决定",
  user_action: "接下来要做的事"
} as const;

function candidateLabel(candidate: DailyReflectionCandidateView) {
  return "contractVersion" in candidate
    ? CANDIDATE_KIND_LABELS[candidate.candidateKind]
    : CANDIDATE_TYPE_LABELS[candidate.candidateType];
}

export type DailyReflectionLocalReviewMetric = Readonly<{
  name:
    | "cards_shown"
    | "primary_cards_shown"
    | "more_cards_available"
    | "more_expanded"
    | "card_promoted"
    | "card_edited"
    | "card_kept"
    | "review_submitted"
    | "review_duration_ms";
  value: number;
  reflectionId: string | null;
  tier?: "primary" | "more";
}>;

type DailyReflectionShellProps = {
  api?: DailyReflectionApi;
  autoStartVoice?: boolean;
  embedded?: boolean;
  initialReflectionId?: string | null;
  initialSegmentId?: string | null;
  initialCaptureMethod?: "record" | "upload" | "toy" | null;
  browserRecordingEnabled?: boolean;
  toySyncEnabled?: boolean;
  onLocalReviewMetric?: (metric: DailyReflectionLocalReviewMetric) => void;
  surface?: "legacy" | "capture" | "session";
};

export type DailyReflectionBrowserRecorder = Pick<
  BrowserAudioRecorder,
  "getSnapshot" | "start" | "stop" | "cancel" | "rerecord" | "dispose"
>;

export type DailyReflectionBrowserRecorderFactory = (
  onSnapshot: (snapshot: BrowserAudioRecorderSnapshot) => void
) => DailyReflectionBrowserRecorder;

type DailyReflectionShellContentProps = DailyReflectionShellProps & {
  session: DailyReflectionSessionValue;
  createBrowserRecorder?: DailyReflectionBrowserRecorderFactory;
  createOperationKey?: (adapter: "file_picker" | "browser_recorder") => string;
};

const defaultBrowserRecorderFactory: DailyReflectionBrowserRecorderFactory = (
  onSnapshot
) => new BrowserAudioRecorder({ onSnapshot });

function localDateValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function formatFileSize(bytes: number) {
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}

function formatRecordingDuration(durationMs: number | null) {
  const totalSeconds = Math.max(0, Math.floor((durationMs ?? 0) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDurationSeconds(durationSeconds: number | null | undefined) {
  if (!durationSeconds || durationSeconds <= 0) return "暂未读取";
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = Math.round(durationSeconds % 60);
  if (minutes === 0) return `${seconds} 秒`;
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}

function formatEvidenceTime(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  const rounded = Math.max(0, Math.floor(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

export function recordingDurationCopy(durationMs: number | null) {
  const elapsedMs = Math.max(0, durationMs ?? 0);
  if (elapsedMs > LONG_RECORDING_HINT_AFTER_MS) {
    return "你可以继续说。我会按完整复盘为你整理。";
  }
  if (elapsedMs >= RECORDING_HINT_AFTER_MS) {
    return "已经说了两分半。你可以继续，也可以开始整理。";
  }
  return "正在记录";
}

function browserRecordingError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "AbortError") return null;
    if (
      error.name === "NotAllowedError"
      || error.name === "PermissionDeniedError"
      || error.name === "SecurityError"
    ) {
      return "没有获得麦克风权限。请在浏览器设置中允许访问后再试。";
    }
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return "没有找到可用的麦克风，请连接设备后再试。";
    }
    if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      return "麦克风暂时无法使用，可能正被其他应用占用。";
    }
    if (error.name === "NotSupportedError") {
      return "当前浏览器不支持直接录音，你仍可以上传已有录音。";
    }
  }
  return "录音没有完成。你可以重新尝试，或上传已有录音。";
}

function browserRecordingExtension(mimeType: string) {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "audio/ogg") return "ogg";
  if (normalized === "audio/mp4") return "m4a";
  if (normalized === "audio/mpeg") return "mp3";
  if (normalized === "audio/wav" || normalized === "audio/x-wav") return "wav";
  return "webm";
}

function browserRecordingFile(
  recording: BrowserAudioRecording,
  recordingDate: string
) {
  const extension = browserRecordingExtension(recording.blob.type);
  return new File(
    [recording.blob],
    `daily-reflection-${recordingDate}.${extension}`,
    { type: recording.blob.type || "audio/webm" }
  );
}

function defaultOperationKey(adapter: "file_picker" | "browser_recorder") {
  const id = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `daily-reflection-${adapter}-${id}`;
}

function sourceLabel(source: SourceOrigin | null | undefined) {
  if (!source) return "正在读取";
  return SOURCE_OPTIONS.find((option) => option.value === source)?.label
    ?? "其他或暂时无法确定";
}

function sourceStatement(source: SourceOrigin | null | undefined, date: string) {
  if (source === "user_reflection") return `你在 ${date} 的复盘中提到……`;
  if (source === "direct_conversation") return `在 ${date} 的交流中提到……`;
  return "来源尚未完全确认";
}

function historyStatusLabel(status: DailyReflectionHistoryItem["status"]) {
  if (status === "review_pending") return "待你确认";
  if (status === "confirmation_ready" || status === "admitting") return "正在保存";
  if (status === "completed") return "已完成";
  if (status === "admission_failed") return "需要继续";
  if (status === "failed") return "需要重试";
  if (status === "cancelled") return "已取消";
  return "整理中";
}

function historyCountCopy(item: DailyReflectionHistoryItem) {
  if (activeUploadFailure(item.uploadState, item.uploadFailure)) return reflectionUploadFailureMessage(item.uploadFailure!);
  if (item.status === "completed") {
    return `记住 ${item.rememberedCount} · 未保存 ${item.notSavedCount}`;
  }
  if (item.status === "review_pending") {
    return item.pendingCount > 0
      ? `${item.pendingCount} 条待选择`
      : "可以确认完成";
  }
  if (item.status === "admission_failed") {
    return `已选择 ${item.keptCount} · 可继续保存`;
  }
  return item.candidateCount > 0 ? `已整理 ${item.candidateCount} 条` : "等待整理内容";
}

function safeErrorMessage(message: string | null | undefined) {
  if (!message) return "这次操作没有完成，请稍后再试。";
  const messages: Record<string, string> = {
    unauthenticated: "登录状态已失效，请重新登录。",
    missing_file: "请选择一段录音。",
    empty_file: "这段录音没有内容，请重新选择。",
    file_too_large: "录音超过服务允许的大小，请选择较小的文件。",
    unsupported_audio_format: "暂不支持这种录音格式。",
    invalid_source_origin: "请选择这段录音的来源。",
    invalid_recording_date: "请检查录音日期。",
    daily_reflection_not_found: "没有找到这条记录，或它已被删除。",
    daily_reflection_cancelled: "这条记录已经取消。",
    daily_reflection_cleanup_failed: "记录已停止，但录音暂时没有清理完成，请稍后重试。",
    daily_reflection_upload_persist_failed: "录音没有完整保存，请稍后重试。",
    pipeline_queue_unavailable: "整理暂时没有开始，请稍后重试。",
    queue_unavailable: "整理暂时没有开始，请稍后重试。",
    request_failed: "暂时无法连接，请稍后再试。",
    invalid_response: "服务返回的内容无法安全显示，请稍后重新读取。",
    daily_reflection_subject_invalid: "原来关联的人物当前不可用，请重新选择或暂不关联。",
    daily_reflection_memory_cleanup_failed: "已保存的内容还没有安全删除完成，请稍后重试。"
  };
  if (messages[message]) return messages[message];
  if (
    /[\u3400-\u9fff]/u.test(message)
    && !/(Memory|Provider|Pipeline|Retrieval|Citation|sourceSegmentId|processingProfile|ASR|keep|edit|exclude|finalize)/iu.test(message)
  ) {
    return message.slice(0, 180);
  }
  return "这次操作没有完成，请稍后再试。";
}

function processingCopy(detail: DailyReflectionDetailResponse | null, state: DailyReflectionSessionValue["state"]) {
  const uploadLabel = reflectionUploadLabel(detail?.uploadState, detail?.uploadFailure, detail?.reflection.status);
  if (uploadLabel) return uploadLabel;
  const status = detail?.reflection.status;
  if (
    status === "created"
    || status === "uploading"
    || state === "uploading"
  ) return detail?.uploadState === "accepted" ? "录音已保存，等待整理" : "录音保存尚未确认";
  if (status === "transcribing") return "正在转成文字";
  if (status === "extracting") return "正在整理重点";
  if (status === "review_pending" || state === "review_pending") return "等你看看";
  if (
    status === "confirmation_ready"
    || state === "confirmation_ready"
    || status === "admitting"
    || state === "admitting"
  ) return "正在保存你选择的内容";
  if (status === "completed" || state === "completed") return "已完成";
  if (status === "admission_failed" || state === "admission_failed") return "长期记忆待重试";
  if (status === "failed" || state === "failed") return "这次整理没有完成";
  if (status === "cancelled" || state === "cancelled") return "这次记录已取消";
  if (state === "loading") return "正在读取这次记录";
  if (state === "error") return "暂时无法读取这次记录";
  return "准备上传录音";
}

function isProcessing(detail: DailyReflectionDetailResponse | null, state: DailyReflectionSessionValue["state"]) {
  if (activeUploadFailure(detail?.uploadState, detail?.uploadFailure)) return false;
  if (detail && (detail.reflection.status === "created" || detail.reflection.status === "uploading")
    && detail.uploadState !== "still_persisting" && detail.uploadState !== "accepted") return false;
  const status = detail?.reflection.status;
  return state === "uploading"
    || status === "created"
    || status === "uploading"
    || status === "transcribing"
    || status === "extracting";
}

function sortedCandidates(detail: DailyReflectionDetailResponse) {
  return [...detail.candidates]
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
}

function sortedCards(detail: DailyReflectionDetailResponse) {
  return [...detail.cards]
    .sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id));
}

function candidateStatusLabel(status: DailyReflectionCandidateView["status"]) {
  if (status === "kept") return "已选择长期记住";
  if (status === "excluded") return "不保存";
  return "稍后再看";
}

function completedAdmissionCopy(
  operation: NonNullable<DailyReflectionDetailResponse["admissionOperation"]>,
  rememberedCount = operation.admittedCount
) {
  const excluded = operation.excludedCount > 0
    ? `你选择不记 ${operation.excludedCount} 件。`
    : "";
  if (rememberedCount === 0 && operation.rejectedCount === 0) {
    return "这次没有保存长期内容。";
  }
  if (rememberedCount === 0) {
    return `${operation.rejectedCount} 件内容还不够明确，所以我暂时没有长期保存。${excluded}`;
  }
  if (operation.rejectedCount === 0) {
    return `我记住了 ${rememberedCount} 件事。${excluded}`;
  }
  return `我记住了 ${rememberedCount} 件事，另有 ${operation.rejectedCount} 件暂时没有保存。${excluded}`;
}

function normalizedCandidateText(
  draftText: string,
  proposedText: string
): string | null {
  const trimmed = draftText.normalize("NFKC").trim();
  return !trimmed || trimmed === proposedText ? null : trimmed;
}

type CandidateReviewCardProps = Readonly<{
  candidate: DailyReflectionCandidateView;
  busy: boolean;
  onDecision(decision: DailyReflectionCandidateDecision): Promise<void>;
  onDelete(candidateId: string): void;
  onSource(segmentId: string): void;
}>;

function CandidateReviewCard({
  candidate,
  busy,
  onDecision,
  onDelete,
  onSource
}: CandidateReviewCardProps) {
  const [draftText, setDraftText] = useState(candidate.userText ?? candidate.proposedText);
  const [editing, setEditing] = useState(false);
  const [evidenceExpanded, setEvidenceExpanded] = useState(false);
  const label = candidateLabel(candidate);

  useEffect(() => {
    setDraftText(candidate.userText ?? candidate.proposedText);
    setEditing(false);
    setEvidenceExpanded(false);
  }, [candidate.id, candidate.proposedText, candidate.userText, candidate.version]);

  const decide = (status: DailyReflectionCandidateDecision["status"]) =>
    onDecision({
      candidateId: candidate.id,
      status,
      userText: normalizedCandidateText(draftText, candidate.proposedText),
      subjectPersonId: null,
      ...("contractVersion" in candidate ? { actionClaimed: candidate.actionClaimed } : {})
    });

  return (
    <li className={styles.candidateCard}>
      <div className={styles.candidateCardTop}>
        <span className={styles.candidateType}>{label}</span>
        <span className={`${styles.pendingBadge} ${candidate.status === "kept"
          ? styles.keptBadge
          : candidate.status === "excluded"
            ? styles.excludedBadge
            : ""}`}>{candidateStatusLabel(candidate.status)}</span>
      </div>

      {editing ? (
        <div className={styles.reviewCardEditor}>
          <label className={styles.candidateEditor}>
            <span>你想留下的文字</span>
            <textarea
              aria-label={`编辑${label}`}
              disabled={busy}
              maxLength={4_000}
              onChange={(event) => setDraftText(event.target.value)}
              rows={4}
              value={draftText}
            />
          </label>
          <div className={styles.editorMeta}>
            <span>{draftText.trim().length}/4000</span>
            <button
              className={styles.textButton}
              disabled={busy || draftText === candidate.proposedText}
              onClick={() => setDraftText(candidate.proposedText)}
              type="button"
            >恢复最初整理</button>
          </div>
          <div className={styles.reviewEditActions}>
            <button
              className={styles.textButton}
              disabled={busy}
              onClick={() => {
                setDraftText(candidate.userText ?? candidate.proposedText);
                setEditing(false);
              }}
              type="button"
            >取消</button>
            <button
              className={styles.primaryButton}
              disabled={busy || !draftText.trim()}
              onClick={() => void decide(candidate.status)}
              type="button"
            >保存编辑</button>
          </div>
        </div>
      ) : (
        <div className={styles.reviewCardReading}>
          <h3>{label}</h3>
          <p>{candidate.userText ?? candidate.proposedText}</p>
        </div>
      )}

      {"contractVersion" in candidate && candidate.candidateKind === "user_action" ? (
        <label className={styles.actionClaim}>
          <input
            checked={candidate.actionClaimed}
            disabled={busy || candidate.evidence.length === 0}
            onChange={(event) => void onDecision({
              candidateId: candidate.id,
              status: candidate.status,
              userText: normalizedCandidateText(draftText, candidate.proposedText),
              subjectPersonId: null,
              actionClaimed: event.target.checked
            })}
            type="checkbox"
          />
          <span>
            <b>这是我要做的</b>
            <small>{candidate.evidence.length > 0
              ? "由你明确认领后，才会作为行动保存。"
              : "没有可核对原话时，只能留在这次复盘。"}</small>
          </span>
        </label>
      ) : null}

      <div className={styles.candidateSource}>
        <span>{candidate.sourceSegmentIds.length} 段原话</span>
        <button
          aria-expanded={evidenceExpanded}
          className={styles.sourceButton}
          onClick={() => setEvidenceExpanded((current) => !current)}
          type="button"
        >{evidenceExpanded ? "收起原话" : "展开全部原话"}</button>
      </div>
      {evidenceExpanded ? (
        candidate.evidence.length > 0 ? (
          <ol className={`${styles.evidenceList} ${styles.canonicalEvidenceList}`}>
            {candidate.evidence.map((evidence) => (
              <li key={evidence.sourceSegmentId}>
                <ProductEvidence
                  label="原话"
                  meta={formatEvidenceTime(evidence.startSeconds)}
                >{evidence.text}</ProductEvidence>
                <button
                  className={styles.textButton}
                  onClick={() => onSource(evidence.sourceSegmentId)}
                  type="button"
                >在完整文字稿中查看</button>
              </li>
            ))}
          </ol>
        ) : (
          <p className={styles.evidenceUnavailable}>这条是你手写补充的内容，目前没有可核对原话。</p>
        )
      ) : null}
      <div className={styles.candidateActions}>
        {!editing ? (
          <button
            className={styles.secondaryButton}
            disabled={busy}
            onClick={() => setEditing(true)}
            type="button"
          >编辑</button>
        ) : null}
        <button
          aria-pressed={candidate.status === "pending"}
          className={styles.secondaryButton}
          disabled={busy}
          onClick={() => void decide("pending")}
          type="button"
        >稍后再看</button>
        <button
          aria-pressed={candidate.status === "excluded"}
          className={styles.secondaryButton}
          disabled={busy}
          onClick={() => void decide("excluded")}
          type="button"
        >不保存</button>
        <button
          aria-pressed={candidate.status === "kept"}
          className={styles.secondaryButton}
          disabled={busy}
          onClick={() => void decide("kept")}
          type="button"
        >{candidate.status === "kept" ? "保存修改" : "长期记住"}</button>
        {"contractVersion" in candidate ? (
          <button
            className={styles.textButton}
            disabled={busy || candidate.status === "excluded"}
            onClick={() => onDelete(candidate.id)}
            type="button"
          >删除这张卡</button>
        ) : null}
      </div>
    </li>
  );
}

const CARD_RISK_LABELS: Record<DailyReflectionCardView["riskFlags"][number], string> = {
  ai_inference: "含 AI 推断，请核对",
  attribution_uncertain: "说话归属不确定",
  low_evidence: "可核对依据较少",
  sensitive: "可能包含敏感内容"
};

type ReflectionMemoryFeedback = Readonly<{
  message: string;
  tone: "error" | "notice" | "success";
}>;
type ReflectionMemoryConfirmation = Readonly<{
  requirements: DailyReflectionMemoryProposalConfirmationRequirement[];
  selected: DailyReflectionMemoryProposalAcknowledgement[];
}>;
type ReflectionPendingAdmission = Readonly<{
  expectedVersion: number;
  proposalId: string;
}>;

function memoryTypeForReflectionCard(
  card: DailyReflectionCardView
): DailyReflectionMemoryProposalCreateRequest["memoryType"] | null {
  switch (card.cardKind) {
    case "insight": return "summary";
    case "open_question": return "question";
    case "decision": return "decision";
    case "user_action": return card.actionClaimed ? "commitment" : null;
  }
}

function reflectionMemoryConfirmationCopy(
  requirement: DailyReflectionMemoryProposalConfirmationRequirement
) {
  switch (requirement.code) {
    case "acknowledge_sensitive_content":
      return "这可能包含较敏感的个人内容；确认后才会长期记住。";
    case "acknowledge_inference":
      return "这部分包含系统整理出的推测；请确认它符合你的意思。";
    case "acknowledge_attribution_uncertainty":
      return "这段表达的归属不够明确；请确认它可以作为你的长期内容。";
    case "verify_fact_owner":
      return "这条内容的归属还需要先确认；确认前不会加入长期记忆。";
  }
}

function isReflectionAcknowledgement(
  requirement: DailyReflectionMemoryProposalConfirmationRequirement
): requirement is DailyReflectionMemoryProposalConfirmationRequirement & {
  code: DailyReflectionMemoryProposalAcknowledgement;
  resolution: "acknowledgement";
} {
  return requirement.resolution === "acknowledgement"
    && requirement.code !== "verify_fact_owner";
}

function activeWorkingCardStatus(status: string | undefined) {
  return status === "saved" || status === "archived" || status === "removed"
    ? status
    : undefined;
}

type ReflectionMemoryActionProps = Readonly<{
  busy: boolean;
  confirmation?: ReflectionMemoryConfirmation;
  feedback?: ReflectionMemoryFeedback;
  onConfirm(acknowledgements: DailyReflectionMemoryProposalAcknowledgement[]): void;
  onRemember(): void;
  onToggleConfirmation(
    acknowledgement: DailyReflectionMemoryProposalAcknowledgement,
    checked: boolean
  ): void;
  selected?: boolean;
}>;

function ReflectionMemoryAction({
  busy,
  confirmation,
  feedback,
  onConfirm,
  onRemember,
  onToggleConfirmation,
  selected = false
}: ReflectionMemoryActionProps) {
  const acknowledgementRequirements = confirmation?.requirements
    .filter(isReflectionAcknowledgement) ?? [];
  const hasOwnerVerification = confirmation?.requirements.some(
    (requirement) => requirement.code === "verify_fact_owner"
  ) ?? false;
  const allAcknowledged = acknowledgementRequirements.every(
    (requirement) => confirmation?.selected.includes(requirement.code)
  );

  return (
    <div className={styles.cardMemoryAction}>
      {confirmation ? (
        <fieldset className={styles.cardMemoryConfirmation}>
          <legend>确认后再长期记住</legend>
          {confirmation.requirements.map((requirement) => (
            isReflectionAcknowledgement(requirement) ? (
              <label key={requirement.code}>
                <input
                  checked={confirmation.selected.includes(requirement.code)}
                  disabled={busy}
                  onChange={(event) => onToggleConfirmation(
                    requirement.code,
                    event.target.checked
                  )}
                  type="checkbox"
                />
                <span>{reflectionMemoryConfirmationCopy(requirement)}</span>
              </label>
            ) : (
              <p key={requirement.code}>{reflectionMemoryConfirmationCopy(requirement)}</p>
            )
          ))}
          {!hasOwnerVerification ? (
            <button
              className={styles.secondaryButton}
              disabled={busy || !allAcknowledged}
              onClick={() => onConfirm(confirmation.selected)}
              type="button"
            >{busy ? "正在确认…" : "确认并长期记住"}</button>
          ) : null}
        </fieldset>
      ) : (
        <button
          aria-pressed={selected}
          className={styles.secondaryButton}
          disabled={busy || selected}
          onClick={onRemember}
          type="button"
        >{selected ? "已选择长期记住" : busy ? "正在处理…" : "长期记住"}</button>
      )}
      {feedback ? (
        <p
          className={feedback.tone === "error" ? styles.inlineError : styles.memoryActionFeedback}
          role={feedback.tone === "error" ? "alert" : "status"}
        >{feedback.message}</p>
      ) : null}
    </div>
  );
}

function ReflectionRecommendationEvidence({
  card,
  onSource
}: Readonly<{
  card: DailyReflectionCardView;
  onSource(segmentId: string): void;
}>) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <button
        aria-expanded={expanded}
        className={styles.secondaryButton}
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >{expanded ? "收起来源" : "查看来源"}</button>
      {expanded ? (
        <ol className={`${styles.evidenceList} ${styles.canonicalEvidenceList}`}>
          {card.evidence.map((evidence) => (
            <li key={evidence.sourceSegmentId}>
              <ProductEvidence
                label="原话"
                meta={formatEvidenceTime(evidence.startSeconds)}
              >{evidence.text}</ProductEvidence>
              <button
                className={styles.textButton}
                onClick={() => onSource(evidence.sourceSegmentId)}
                type="button"
              >在完整文字记录中查看</button>
            </li>
          ))}
        </ol>
      ) : null}
    </>
  );
}

type ReflectionCardReviewProps = Readonly<{
  card: DailyReflectionCardView;
  busy: boolean;
  editing: boolean;
  onCancelEdit(): void;
  onDecision(decision: DailyReflectionCardDecision): Promise<void>;
  onArchiveFromCards(cardId: string): void;
  onRestoreToCards(cardId: string): void;
  onSaveToCards(
    cardId: string,
    draft: Pick<DailyReflectionCardDecision, "userTitle" | "userText">
  ): Promise<boolean>;
  onSource(segmentId: string): void;
  onStartEdit(): void;
  workingCardStatus?: "saved" | "archived" | "removed";
}>;

function ReflectionCardReview({
  card,
  busy,
  editing,
  onCancelEdit,
  onDecision,
  onArchiveFromCards,
  onRestoreToCards,
  onSaveToCards,
  onSource,
  onStartEdit,
  workingCardStatus
}: ReflectionCardReviewProps) {
  const [draftTitle, setDraftTitle] = useState(card.userTitle ?? card.proposedTitle);
  const [draftText, setDraftText] = useState(card.userText ?? card.proposedText);
  const [evidenceExpanded, setEvidenceExpanded] = useState(false);
  const pendingEditVersion = useRef<number | null>(null);

  useEffect(() => {
    setDraftTitle(card.userTitle ?? card.proposedTitle);
    setDraftText(card.userText ?? card.proposedText);
  }, [card.id, card.proposedTitle, card.proposedText, card.userTitle, card.userText, card.version]);

  useEffect(() => {
    if (pendingEditVersion.current === null || card.version === pendingEditVersion.current) return;
    pendingEditVersion.current = null;
    onCancelEdit();
  }, [card.version, onCancelEdit]);

  const displayedRiskFlags = Array.from(new Set([
    ...(card.epistemicStatus === "ai_inference" ? ["ai_inference" as const] : []),
    ...card.riskFlags
  ]));

  const decide = (
    reviewStatus: DailyReflectionCardDecision["reviewStatus"],
    actionClaimed?: boolean,
    promoteToPrimary?: true
  ) => onDecision({
    cardId: card.id,
    reviewStatus,
    userTitle: normalizedCandidateText(draftTitle, card.proposedTitle),
    userText: normalizedCandidateText(draftText, card.proposedText),
    ...(actionClaimed === undefined ? {} : { actionClaimed }),
    ...(promoteToPrimary ? { promoteToPrimary } : {})
  });

  const cancelEdit = () => {
    pendingEditVersion.current = null;
    setDraftTitle(card.userTitle ?? card.proposedTitle);
    setDraftText(card.userText ?? card.proposedText);
    onCancelEdit();
  };

  const saveEdit = () => {
    pendingEditVersion.current = card.version;
    void decide(card.reviewStatus);
  };

  const selectForLongTermMemory = async () => {
    if (!workingCardStatus) {
      const saved = await onSaveToCards(card.id, {
        userTitle: normalizedCandidateText(draftTitle, card.proposedTitle),
        userText: normalizedCandidateText(draftText, card.proposedText)
      });
      if (!saved) return;
    }
    await decide("kept");
  };

  const firstEvidenceTime = formatEvidenceTime(card.evidence[0]?.startSeconds);
  const unclaimedAction = card.cardKind === "user_action" && !card.actionClaimed;
  const eligibleKept = card.reviewStatus === "kept" && !unclaimedAction;

  return (
    <li className={`${styles.candidateCard} ${styles.reviewCard} ${card.displayTier === "more" ? styles.reviewCardCompact : ""}`}>
      <div className={styles.candidateCardTop}>
        <span className={styles.candidateType}>{CANDIDATE_KIND_LABELS[card.cardKind]}</span>
        <span className={`${styles.pendingBadge} ${eligibleKept
          ? styles.keptBadge
          : card.reviewStatus === "excluded"
            ? styles.excludedBadge
            : ""}`}>{eligibleKept
          ? "已选择长期记住"
          : card.reviewStatus === "excluded"
            ? "不保存"
            : card.reviewStatus === "kept" && unclaimedAction
              ? "尚未选择长期记住"
              : "稍后再看"}</span>
      </div>
      {editing ? (
        <div className={styles.reviewCardEditor}>
          <label className={styles.candidateEditor}>
            <span>标题</span>
            <input aria-label={`编辑标题：${card.proposedTitle}`} disabled={busy} maxLength={240} onChange={(event) => setDraftTitle(event.target.value)} value={draftTitle} />
          </label>
          <label className={styles.candidateEditor}>
            <span>正文</span>
            <textarea aria-label={`编辑内容：${card.proposedTitle}`} disabled={busy} maxLength={4_000} onChange={(event) => setDraftText(event.target.value)} rows={5} value={draftText} />
          </label>
          <div className={styles.reviewEditActions}>
            <button className={styles.textButton} disabled={busy} onClick={cancelEdit} type="button">取消</button>
            <button className={styles.primaryButton} disabled={busy || !draftTitle.trim() || !draftText.trim()} onClick={saveEdit} type="button">保存编辑</button>
          </div>
        </div>
      ) : (
        <div className={styles.reviewCardReading}>
          <h3>{card.userTitle ?? card.proposedTitle}</h3>
          <p>{card.userText ?? card.proposedText}</p>
        </div>
      )}
      {card.cardKind === "user_action" ? (
        <label className={styles.actionClaim}>
          <input
            checked={card.actionClaimed}
            disabled={busy}
            onChange={(event) => void decide(card.reviewStatus, event.target.checked)}
            type="checkbox"
          />
          <span><b>这是我要做的</b><small>只有你主动勾选后，才会作为行动保留。</small></span>
        </label>
      ) : null}
      <div className={styles.reviewCardMeta}><span>{firstEvidenceTime ? `${firstEvidenceTime} · ` : ""}{card.evidence.length} 段来源</span></div>
      {evidenceExpanded ? (
        <ol className={`${styles.evidenceList} ${styles.canonicalEvidenceList}`}>
          {card.evidence.map((evidence) => (
            <li key={evidence.sourceSegmentId}>
              <ProductEvidence
                label="原话"
                meta={formatEvidenceTime(evidence.startSeconds)}
              >{evidence.text}</ProductEvidence>
              <button
                className={styles.textButton}
                onClick={() => onSource(evidence.sourceSegmentId)}
                type="button"
              >在完整文字记录中查看</button>
            </li>
          ))}
        </ol>
      ) : null}
      <div className={`${styles.candidateActions} ${styles.reviewCardActions}`}>
        {!workingCardStatus && card.reviewStatus !== "excluded" ? (
          <button
            className={styles.secondaryButton}
            disabled={busy}
            onClick={() => void onSaveToCards(card.id, {
              userTitle: normalizedCandidateText(draftTitle, card.proposedTitle),
              userText: normalizedCandidateText(draftText, card.proposedText)
            })}
            type="button"
          >保存为卡片</button>
        ) : workingCardStatus === "saved" ? (
          <Link className={styles.secondaryButton} href={`/reflection/cards/${encodeURIComponent(card.id)}`}>打开卡片</Link>
        ) : workingCardStatus ? (
          <button className={styles.secondaryButton} disabled={busy} onClick={() => onRestoreToCards(card.id)} type="button">恢复卡片</button>
        ) : null}
        {!editing ? (
          <button
            aria-pressed={eligibleKept}
            className={styles.secondaryButton}
            disabled={busy || unclaimedAction}
            onClick={() => void selectForLongTermMemory()}
            type="button"
          >{unclaimedAction
            ? "先确认“这是我要做的”"
            : card.reviewStatus === "kept" ? "已选择长期记住" : "长期记住"}</button>
        ) : null}
        <button aria-expanded={evidenceExpanded} className={styles.secondaryButton} onClick={() => setEvidenceExpanded((current) => !current)} type="button">{evidenceExpanded ? "收起来源" : "查看来源"}</button>
        <details className={styles.cardAdvancedActions}>
          <summary aria-label="更多选择">⋯</summary>
          <div>
            <button className={styles.textButton} disabled={busy || editing} onClick={onStartEdit} type="button">编辑</button>
            {workingCardStatus === "saved" ? (
              <button className={styles.textButton} disabled={busy} onClick={() => onArchiveFromCards(card.id)} type="button">归档</button>
            ) : null}
            {displayedRiskFlags.length > 0 ? <p className={styles.reviewRiskCopy}>{displayedRiskFlags.map((flag) => CARD_RISK_LABELS[flag]).join(" · ")}</p> : null}
            {card.displayTier === "more" ? (
          <button
            className={styles.textButton}
            disabled={busy}
            onClick={() => decide("pending", undefined, true)}
            type="button"
          >设为重点</button>
            ) : null}
            <button
              aria-pressed={card.reviewStatus === "pending"}
              className={styles.secondaryButton}
              disabled={busy}
            onClick={() => void decide("pending")}
              type="button"
            >稍后再看</button>
            <button
              aria-pressed={card.reviewStatus === "excluded"}
              className={styles.secondaryButton}
              disabled={busy}
              onClick={() => void decide("excluded")}
              type="button"
            >不保存</button>
          </div>
        </details>
      </div>
    </li>
  );
}

type ManualCandidateComposerProps = Readonly<{
  busy: boolean;
  segments: DailyReflectionDetailResponse["segments"];
  onCreate(candidate: DailyReflectionManualCandidateDraft): void;
}>;

function ManualCandidateComposer({ busy, segments, onCreate }: ManualCandidateComposerProps) {
  const [open, setOpen] = useState(false);
  const [candidateKind, setCandidateKind] = useState<DailyReflectionManualCandidateDraft["candidateKind"]>("insight");
  const [text, setText] = useState("");
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [actionClaimed, setActionClaimed] = useState(false);
  const normalized = text.normalize("NFKC").trim();

  const toggleEvidence = (segmentId: string, checked: boolean) => {
    setEvidenceIds((current) => checked
      ? [...current, segmentId]
      : current.filter((id) => id !== segmentId));
  };

  return (
    <section className={styles.manualCandidate} aria-label="手写补充">
      <button
        aria-expanded={open}
        className={styles.secondaryButton}
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >{open ? "收起手写补充" : "手写补充一张卡片"}</button>
      {open ? (
        <div className={styles.manualCandidateForm}>
          <label>
            <span>这张卡片是什么</span>
            <select
              disabled={busy}
              onChange={(event) => {
                const next = event.target.value as DailyReflectionManualCandidateDraft["candidateKind"];
                setCandidateKind(next);
                if (next !== "user_action") setActionClaimed(false);
              }}
              value={candidateKind}
            >
              {Object.entries(CANDIDATE_KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>你想补充的内容</span>
            <textarea
              aria-label="手写卡片内容"
              disabled={busy}
              maxLength={20_000}
              onChange={(event) => setText(event.target.value)}
              value={text}
            />
          </label>
          <fieldset>
            <legend>可核对原话（可选）</legend>
            <p>不选择原话时，这张卡只能保留在本次复盘中。</p>
            <div className={styles.manualEvidenceChoices}>
              {segments.map((segment) => (
                <label key={segment.id}>
                  <input
                    checked={evidenceIds.includes(segment.id)}
                    disabled={busy}
                    onChange={(event) => toggleEvidence(segment.id, event.target.checked)}
                    type="checkbox"
                  />
                  <span>{segment.text}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {candidateKind === "user_action" ? (
            <label className={styles.actionClaim}>
              <input
                checked={actionClaimed}
                disabled={busy || evidenceIds.length === 0}
                onChange={(event) => setActionClaimed(event.target.checked)}
                type="checkbox"
              />
              <span><b>这是我要做的</b><small>只有选择了可核对原话，才能认领为行动。</small></span>
            </label>
          ) : null}
          <button
            className={styles.primaryButton}
            disabled={busy || !normalized}
            onClick={() => onCreate({
              candidateKind,
              proposedText: normalized,
              evidenceIds,
              confidence: 1,
              caution: "这是你手写补充的内容，请按原话核对。",
              actionClaimed: candidateKind === "user_action" && actionClaimed
            })}
            type="button"
          >保存这张手写卡</button>
        </div>
      ) : null}
    </section>
  );
}

type DailyReflectionHistoryProps = Readonly<{
  session: DailyReflectionSessionValue;
}>;

function DailyReflectionHistory({ session }: DailyReflectionHistoryProps) {
  return (
    <section className={styles.historySection} aria-labelledby="daily-reflection-history-title">
      <div className={styles.historyHeading}>
        <div>
          <p className={styles.eyebrow}>最近留下的记录</p>
          <h2 id="daily-reflection-history-title">最近复盘</h2>
        </div>
        <button
          className={styles.secondaryButton}
          disabled={session.historyState === "loading"}
          onClick={() => void session.refreshHistory()}
          type="button"
        >{session.historyState === "loading" ? "正在刷新…" : "刷新"}</button>
      </div>
      {session.historyErrorMessage ? (
        <p className={styles.inlineError} role="alert">
          {safeErrorMessage(session.historyErrorMessage)}
        </p>
      ) : null}
      {session.historyState === "loading" && session.history.length === 0 ? (
        <p className={styles.historyEmpty} role="status">正在读取最近复盘…</p>
      ) : session.history.length === 0 ? (
        <p className={styles.historyEmpty}>还没有复盘记录。你可以从上面的任一入口开始。</p>
      ) : (
        <ol className={styles.historyList}>
          {session.history.map((item) => (
            <li key={item.id}>
              <button
                className={styles.historyCard}
                onClick={() => void session.reload(item.id)}
                type="button"
              >
                <span className={styles.historyCardTop}>
                  <b>{item.recordingDate ?? item.createdAt.slice(0, 10)}</b>
                  <span>{reflectionUploadLabel(item.uploadState, item.uploadFailure, item.status) ?? historyStatusLabel(item.status)}</span>
                </span>
                <span className={styles.historySource}>{item.sourceStatement}</span>
                <span className={styles.historyMeta}>
                  <span>{historyCountCopy(item)}</span>
                  <span>{item.transcriptAvailable ? "可查看原话" : "原话暂不可用"}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

type ReflectionResultListProps = Readonly<{
  detail: DailyReflectionDetailResponse;
  activeCandidateId: string | null;
  busy: boolean;
  errorMessage: string | null;
  operation: DailyReflectionSessionValue["operation"];
  onRevoke(candidateId: string): void;
  onSource(candidate: DailyReflectionCandidateView): void;
}>;

function ReflectionResultList({
  detail,
  activeCandidateId,
  busy,
  errorMessage,
  operation,
  onRevoke,
  onSource
}: ReflectionResultListProps) {
  const recapOnly = detail.confirmation !== null
    && "contractVersion" in detail.confirmation
    && detail.confirmation.saveIntent === "recap_only";
  const [confirmingCandidateId, setConfirmingCandidateId] = useState<string | null>(null);
  const resultByCandidate = new Map(
    detail.admissionResults.map((result) => [result.candidateId, result] as const)
  );
  const revoked = useMemo(
    () => new Set(detail.revokedCandidateIds ?? []),
    [detail.revokedCandidateIds]
  );
  const revocationStateAvailable = detail.rememberedCount !== undefined
    && detail.revokedCandidateIds !== undefined;
  useEffect(() => {
    if (confirmingCandidateId && revoked.has(confirmingCandidateId)) {
      setConfirmingCandidateId(null);
      return;
    }
    if (activeCandidateId && errorMessage && !revoked.has(activeCandidateId)) {
      setConfirmingCandidateId(activeCandidateId);
    }
  }, [activeCandidateId, confirmingCandidateId, errorMessage, revoked]);
  const candidates = sortedCandidates(detail);
  if (candidates.length === 0) {
    return <p className={styles.emptyCandidates}>这次没有需要保存的内容。</p>;
  }
  const confirmingCandidate = confirmingCandidateId
    ? candidates.find((candidate) => candidate.id === confirmingCandidateId) ?? null
    : null;
  const confirmingIsPersisted = confirmingCandidate
    ? confirmingCandidate.status === "kept"
      && (resultByCandidate.get(confirmingCandidate.id)?.status === "admitted"
        || resultByCandidate.get(confirmingCandidate.id)?.status === "already_admitted")
      && !revoked.has(confirmingCandidate.id)
    : false;
  const confirmingRetry = confirmingCandidateId === activeCandidateId && Boolean(errorMessage);
  const confirmingBusy = confirmingCandidateId === activeCandidateId
    && operation === "revoking_candidate";
  return (
    <>
      <ol className={styles.resultList}>
      {candidates.map((candidate) => {
        const result = resultByCandidate.get(candidate.id);
        const persisted = candidate.status === "kept"
          && (result?.status === "admitted" || result?.status === "already_admitted");
        const wasRevoked = persisted && revoked.has(candidate.id);
        const remembered = persisted && !wasRevoked;
        const pendingSave = candidate.status === "kept" && !result
          && detail.reflection.status !== "completed";
        const resultLabel = candidate.status === "excluded"
          ? "你选择不保存"
          : recapOnly
            ? "只留在这次复盘"
          : wasRevoked
            ? "已撤销保存"
          : remembered
            ? "已经记住"
            : pendingSave
              ? "正在保存"
              : result?.status === "retryable_error"
                ? "还需要重试"
                : "暂未保存";
        const retrying = activeCandidateId === candidate.id && Boolean(errorMessage);
        const revoking = activeCandidateId === candidate.id
          && operation === "revoking_candidate";
        const canRevoke = detail.reflection.status === "completed"
          && revocationStateAvailable
          && persisted
          && !wasRevoked;
        return (
          <li className={`${styles.resultCard} ${wasRevoked ? styles.revokedResultCard : ""}`} key={candidate.id}>
            <div className={styles.candidateCardTop}>
              <span className={styles.candidateType}>{candidateLabel(candidate)}</span>
              <span className={`${styles.pendingBadge} ${remembered ? styles.keptBadge : styles.excludedBadge}`}>
                {resultLabel}
              </span>
            </div>
            <p>{candidate.userText ?? candidate.proposedText}</p>
            <div className={styles.candidateSource}>
              <span>{candidate.sourceSegmentIds.length} 段原话</span>
              <button className={styles.sourceButton} onClick={() => onSource(candidate)} type="button">查看原话</button>
            </div>
            {canRevoke ? (
              <div className={styles.resultActions}>
                <button
                  className={styles.secondaryButton}
                  disabled={busy}
                  onClick={() => setConfirmingCandidateId(candidate.id)}
                  type="button"
                >{revoking ? "正在撤销…" : retrying ? "重试撤销" : "撤销保存"}</button>
              </div>
            ) : null}
          </li>
        );
      })}
      </ol>
      <ReflectionConfirmDialog
        busy={confirmingBusy}
        busyLabel="正在撤销…"
        cancelLabel="先保留"
        confirmLabel={confirmingRetry ? "重试撤销" : "确认撤销"}
        onCancel={() => setConfirmingCandidateId(null)}
        onConfirm={() => {
          if (confirmingCandidate) onRevoke(confirmingCandidate.id);
        }}
        open={Boolean(confirmingCandidate && confirmingIsPersisted)}
        role="alertdialog"
        title="只撤销这一条保存？"
      >
        <p>这只会撤销这一条长期保存，不会修改原始复盘文字，也不会删除整次复盘。查看原话仍会保留。</p>
        {confirmingRetry && errorMessage ? <p className={styles.inlineError} role="alert">{safeErrorMessage(errorMessage)}</p> : null}
      </ReflectionConfirmDialog>
    </>
  );
}

export function DailyReflectionShell({
  api: providedApi,
  autoStartVoice = false,
  embedded = false,
  initialReflectionId = null,
  initialSegmentId = null,
  initialCaptureMethod = null,
  browserRecordingEnabled = false,
  onLocalReviewMetric,
  toySyncEnabled = false,
  surface = "legacy"
}: DailyReflectionShellProps) {
  const api = useMemo(() => providedApi ?? createDailyReflectionApi(), [providedApi]);
  const session = useDailyReflectionSession({ api, initialReflectionId });
  return (
    <DailyReflectionShellContent
      api={api}
      autoStartVoice={autoStartVoice}
      browserRecordingEnabled={browserRecordingEnabled}
      embedded={embedded}
      initialReflectionId={initialReflectionId}
      initialSegmentId={initialSegmentId}
      initialCaptureMethod={initialCaptureMethod}
      onLocalReviewMetric={onLocalReviewMetric}
      session={session}
      surface={surface}
      toySyncEnabled={toySyncEnabled}
    />
  );
}

export function DailyReflectionShellContent({
  api,
  autoStartVoice = false,
  browserRecordingEnabled = false,
  createBrowserRecorder = defaultBrowserRecorderFactory,
  createOperationKey = defaultOperationKey,
  embedded = false,
  initialReflectionId = null,
  initialSegmentId = null,
  initialCaptureMethod = null,
  onLocalReviewMetric,
  session,
  surface = "legacy",
  toySyncEnabled = false
}: DailyReflectionShellContentProps) {
  const router = useRouter();
  const memoryApi = useMemo(
    () => api ?? (embedded ? createDailyReflectionApi() : null),
    [api, embedded]
  );
  const [file, setFile] = useState<File | null>(null);
  const [sourceOrigin, setSourceOrigin] = useState<DailyReflectionUploadSource | null>(null);
  const [browserSourceOrigin, setBrowserSourceOrigin] = useState<DailyReflectionUploadSource | null>(null);
  const [recordingDate, setRecordingDate] = useState(() => localDateValue());
  const [fileError, setFileError] = useState<string | null>(null);
  const [recorderSnapshot, setRecorderSnapshot] = useState(EMPTY_RECORDER_SNAPSHOT);
  const [recorderError, setRecorderError] = useState<string | null>(null);
  const [browserSubmitting, setBrowserSubmitting] = useState(false);
  const [focusRequest, setFocusRequest] = useState<TranscriptFocusRequest | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);
  const [moreCardsExpanded, setMoreCardsExpanded] = useState(false);
  const [captureMode, setCaptureMode] = useState<"voice" | "upload" | "toy">(() => {
    if (initialCaptureMethod === "upload") return "upload";
    if (initialCaptureMethod === "toy") return "toy";
    return browserRecordingEnabled ? "voice" : "upload";
  });
  const [toyPanelVisited, setToyPanelVisited] = useState(initialCaptureMethod === "toy");
  const captureModeLocked = recorderSnapshot.state === "starting"
    || recorderSnapshot.state === "recording"
    || recorderSnapshot.state === "stopping";
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [memoryRecommendations, setMemoryRecommendations] = useState<
    DailyReflectionMemoryRecommendationResponse | null
  >(null);
  const [memoryRecommendationState, setMemoryRecommendationState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [memoryRecommendationRefresh, setMemoryRecommendationRefresh] = useState(0);
  const [memoryBusyCardId, setMemoryBusyCardId] = useState<string | null>(null);
  const [memoryFeedback, setMemoryFeedback] = useState<Record<string, ReflectionMemoryFeedback>>({});
  const [memoryConfirmations, setMemoryConfirmations] = useState<
    Record<string, ReflectionMemoryConfirmation>
  >({});
  const recorderRef = useRef<DailyReflectionBrowserRecorder | null>(null);
  const browserSubmitLatch = useRef(false);
  const browserReadyOperationKey = useRef<string | null>(null);
  const fileOperationKey = useRef<string | null>(null);
  const lastUrlReflectionId = useRef<string | null>(initialReflectionId);
  const observedReflectionId = useRef(false);
  const lastCardExposureKey = useRef<string | null>(null);
  const appliedInitialSegmentKey = useRef<string | null>(null);
  const reviewStartedAt = useRef<number | null>(null);
  const voiceAutostartAttempted = useRef(false);
  const memoryRecommendationController = useRef<AbortController | null>(null);
  const memoryBusyCardIdRef = useRef<string | null>(null);
  const pendingMemoryAdmissions = useRef(new Map<string, ReflectionPendingAdmission>());

  useEffect(() => {
    const recording = recorderSnapshot.recording;
    if (!recording || recorderSnapshot.state !== "ready") return;
    browserReadyOperationKey.current ??= createOperationKey("browser_recorder");
    void session.preserveRecording({
      file: browserRecordingFile(recording, recordingDate),
      clientReportedDurationMs: recording.clientReportedDurationMs || undefined,
      recordingDate,
      sourceOrigin: browserSourceOrigin,
      operationKey: browserReadyOperationKey.current
    });
  }, [recorderSnapshot.recording, recorderSnapshot.state, recordingDate, browserSourceOrigin, createOperationKey, session.preserveRecording]);

  useEffect(() => {
    if (!browserRecordingEnabled) return;
    let active = true;
    const recorder = createBrowserRecorder((snapshot) => {
      if (active) setRecorderSnapshot(snapshot);
    });
    recorderRef.current = recorder;
    setRecorderSnapshot(recorder.getSnapshot());
    return () => {
      active = false;
      if (recorderRef.current === recorder) recorderRef.current = null;
      recorder.dispose();
    };
  }, [browserRecordingEnabled, createBrowserRecorder]);

  useEffect(() => {
    if (recorderSnapshot.state !== "recording") return;
    const refreshDuration = () => {
      const snapshot = recorderRef.current?.getSnapshot();
      if (snapshot) setRecorderSnapshot(snapshot);
    };
    refreshDuration();
    const interval = window.setInterval(refreshDuration, 1_000);
    return () => window.clearInterval(interval);
  }, [recorderSnapshot.state]);

  useEffect(() => {
    setDeleteConfirmation(false);
    setMoreCardsExpanded(false);
    setEditingCardId(null);
    memoryRecommendationController.current?.abort();
    memoryRecommendationController.current = null;
    pendingMemoryAdmissions.current.clear();
    memoryBusyCardIdRef.current = null;
    setMemoryBusyCardId(null);
    setMemoryFeedback({});
    setMemoryConfirmations({});
    setMemoryRecommendations(null);
    setMemoryRecommendationState("idle");
  }, [session.reflectionId]);

  useEffect(() => {
    if (session.auth.status === "authenticated") return;
    memoryRecommendationController.current?.abort();
    memoryRecommendationController.current = null;
    pendingMemoryAdmissions.current.clear();
    memoryBusyCardIdRef.current = null;
    setMemoryBusyCardId(null);
    setMemoryFeedback({});
    setMemoryConfirmations({});
    setMemoryRecommendations(null);
    setMemoryRecommendationState("idle");
  }, [session.auth.status]);

  useEffect(() => () => {
    memoryRecommendationController.current?.abort();
  }, []);

  useEffect(() => {
    const nextMode = initialCaptureMethod === "upload"
      ? "upload"
      : initialCaptureMethod === "toy"
        ? "toy"
        : browserRecordingEnabled
          ? "voice"
          : "upload";
    setCaptureMode(nextMode);
    if (nextMode === "toy") setToyPanelVisited(true);
  }, [browserRecordingEnabled, initialCaptureMethod]);

  useEffect(() => {
    if (!session.reflectionId) return;
    recorderRef.current?.cancel();
    browserReadyOperationKey.current = null;
    fileOperationKey.current = null;
    browserSubmitLatch.current = false;
    setBrowserSubmitting(false);
  }, [session.reflectionId]);

  useEffect(() => {
    if (session.auth.status === "authenticated") return;
    recorderRef.current?.cancel();
    browserReadyOperationKey.current = null;
    fileOperationKey.current = null;
    browserSubmitLatch.current = false;
    setBrowserSubmitting(false);
    setRecorderSnapshot(recorderRef.current?.getSnapshot() ?? EMPTY_RECORDER_SNAPSHOT);
  }, [session.auth.status]);

  useEffect(() => {
    if (session.auth.status === "anonymous") router.replace("/date-companion");
  }, [router, session.auth.status]);

  useEffect(() => {
    if (session.auth.status !== "authenticated") return;
    const reflectionId = session.reflectionId;
    if (reflectionId && reflectionId !== lastUrlReflectionId.current) {
      observedReflectionId.current = true;
      lastUrlReflectionId.current = reflectionId;
      router.replace(reflectionSessionPath(reflectionId));
      return;
    }
    if (reflectionId) observedReflectionId.current = true;
    if (
      !reflectionId
      && observedReflectionId.current
      && lastUrlReflectionId.current
      && session.state === "idle"
      && session.operation === "idle"
    ) {
      lastUrlReflectionId.current = null;
      router.replace(REFLECTION_ROUTES.home);
    }
  }, [embedded, router, session.auth.status, session.operation, session.reflectionId, session.state]);

  const busy = session.operation !== "idle";
  const detail = session.detail;
  const uploadFailure = activeUploadFailure(detail?.uploadState, detail?.uploadFailure);
  const processing = isProcessing(detail, session.state);
  const showRecord = Boolean(detail || session.reflectionId)
    || session.state === "uploading"
    || session.state === "loading"
    || session.operation !== "idle"
    || browserSubmitting;
  const candidates = useMemo(
    () => detail && detail.reflection.status === "review_pending"
      ? sortedCandidates(detail)
      : [],
    [detail]
  );
  const cards = useMemo(
    () => detail && detail.reflection.status === "review_pending"
      ? sortedCards(detail)
      : [],
    [detail]
  );
  useEffect(() => {
    if (cards.length === 0 || !onLocalReviewMetric) return;
    const exposureKey = `${session.reflectionId ?? "unknown"}:${cards
      .map((card) => `${card.id}:${card.version}`)
      .join("|")}`;
    if (lastCardExposureKey.current === exposureKey) return;
    lastCardExposureKey.current = exposureKey;
    reviewStartedAt.current = performance.now();
    onLocalReviewMetric({
      name: "cards_shown",
      value: cards.length,
      reflectionId: session.reflectionId
    });
    onLocalReviewMetric({
      name: "primary_cards_shown",
      value: cards.filter((card) => card.displayTier === "primary").length,
      reflectionId: session.reflectionId,
      tier: "primary"
    });
    onLocalReviewMetric({
      name: "more_cards_available",
      value: cards.filter((card) => card.displayTier === "more").length,
      reflectionId: session.reflectionId,
      tier: "more"
    });
  }, [cards, onLocalReviewMetric, session.reflectionId]);
  const primaryCards = cards.filter((card) => card.displayTier === "primary");
  const moreCards = cards.filter((card) => card.displayTier === "more");
  const pendingCandidateCount = cards.length > 0
    ? cards.filter((card) => card.reviewStatus === "pending").length
    : candidates.filter((candidate) => candidate.status === "pending").length;
  const keptCandidateCount = cards.length > 0
    ? cards.filter((card) => card.reviewStatus === "kept").length
    : candidates.filter((candidate) => candidate.status === "kept").length;
  const keptWithoutEvidenceCount = cards.length > 0
    ? 0
    : candidates.filter(
      (candidate) => candidate.status === "kept" && candidate.evidence.length === 0
    ).length;
  const keptUnclaimedActionCount = cards.length > 0
    ? cards.filter((card) => (
      card.reviewStatus === "kept"
      && card.cardKind === "user_action"
      && !card.actionClaimed
    )).length
    : candidates.filter((candidate) => (
      candidate.status === "kept"
      && candidate.evidence.length > 0
      && "contractVersion" in candidate
      && candidate.candidateKind === "user_action"
      && !candidate.actionClaimed
    )).length;
  const retainedCandidateCount = keptCandidateCount
    - keptWithoutEvidenceCount
    - keptUnclaimedActionCount;
  const recapOnlyRequired = keptWithoutEvidenceCount > 0;
  const savedCardCount = Object.values(session.workingCardStates)
    .filter((item) => item.status === "saved").length;
  const hasCompletionSelection = savedCardCount > 0 || retainedCandidateCount > 0;
  const unsavedPrimaryCards = primaryCards.filter(
    (card) => session.workingCardStates[card.id]?.status !== "saved"
      && card.reviewStatus !== "excluded"
  );
  const workingCardRecommendationKey = Object.entries(session.workingCardStates)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cardId, state]) => (
      `${cardId}:${state.status}:${state.memoryLifecycleStatus ?? "not_admitted"}:${state.version}`
    ))
    .join("|");
  const reflectionCardRecommendationKey = detail?.cards
    .map((card) => (
      `${card.id}:${card.reviewStatus}:${card.actionClaimed}:${card.version}:${card.evidenceIds.join(",")}`
    ))
    .join("|") ?? "";

  useEffect(() => {
    const reflectionId = session.reflectionId;
    const canLoad = Boolean(
      memoryApi
      && reflectionId
      && session.auth.status === "authenticated"
      && (
        detail?.reflection.status === "review_pending"
        || detail?.reflection.status === "completed"
      )
    );
    if (!canLoad || !memoryApi || !reflectionId) {
      memoryRecommendationController.current?.abort();
      memoryRecommendationController.current = null;
      setMemoryRecommendations(null);
      setMemoryRecommendationState("idle");
      return;
    }

    memoryRecommendationController.current?.abort();
    const controller = new AbortController();
    memoryRecommendationController.current = controller;
    setMemoryRecommendationState("loading");
    void memoryApi.getMemoryRecommendations(reflectionId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setMemoryRecommendations(response);
        setMemoryRecommendationState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof DailyReflectionApiError && error.status === 404) {
          setMemoryRecommendations(null);
          setMemoryRecommendationState("ready");
          return;
        }
        setMemoryRecommendations(null);
        setMemoryRecommendationState("error");
      });
    return () => controller.abort();
  }, [
    memoryApi,
    detail?.reflection.status,
    memoryRecommendationRefresh,
    reflectionCardRecommendationKey,
    session.auth.status,
    session.reflectionId,
    workingCardRecommendationKey
  ]);

  const recommendedCards = useMemo(() => {
    if (!detail || !memoryRecommendations || memoryRecommendations.recommendations.length === 0) {
      return [];
    }
    const cardsById = new Map(detail.cards.map((card) => [card.id, card]));
    const resolved = memoryRecommendations.recommendations.map((recommendation) => {
      const card = cardsById.get(recommendation.cardId);
      return card ? { card, recommendation } : null;
    });
    return resolved.some((item) => item === null)
      ? []
      : resolved.filter((item): item is NonNullable<typeof item> => item !== null);
  }, [detail, memoryRecommendations]);
  const reviewPrimaryCards = primaryCards;
  const reviewMoreCards = moreCards;
  const outcomeCards = useMemo(
    () => detail ? sortedCards(detail) : [],
    [detail]
  );

  const toggleMemoryConfirmation = (
    cardId: string,
    acknowledgement: DailyReflectionMemoryProposalAcknowledgement,
    checked: boolean
  ) => {
    setMemoryConfirmations((current) => {
      const confirmation = current[cardId];
      if (!confirmation) return current;
      const selected = checked
        ? Array.from(new Set([...confirmation.selected, acknowledgement]))
        : confirmation.selected.filter((item) => item !== acknowledgement);
      return { ...current, [cardId]: { ...confirmation, selected } };
    });
  };

  const rememberWorkingCard = async (
    card: DailyReflectionCardView,
    memoryType: DailyReflectionMemoryProposalCreateRequest["memoryType"],
    acknowledgements: DailyReflectionMemoryProposalAcknowledgement[] = []
  ) => {
    if (!memoryApi || memoryBusyCardIdRef.current) return;
    const workingCard = session.workingCardStates[card.id];
    if (
      !workingCard
      || workingCard.status !== "saved"
      || (workingCard.memoryLifecycleStatus ?? "not_admitted") !== "not_admitted"
      || card.evidenceIds.length === 0
    ) {
      setMemoryFeedback((current) => ({
        ...current,
        [card.id]: {
          message: "这张卡片目前不能加入长期记忆；卡片本身仍会保留。",
          tone: "notice"
        }
      }));
      return;
    }

    memoryBusyCardIdRef.current = card.id;
    setMemoryBusyCardId(card.id);
    setMemoryFeedback((current) => {
      const next = { ...current };
      delete next[card.id];
      return next;
    });
    try {
      let pending = pendingMemoryAdmissions.current.get(card.id);
      if (!pending) {
        const created = await memoryApi.createWorkingCardMemoryProposal(card.id, {
          expectedCardVersion: workingCard.version,
          memoryType
        });
        pending = {
          proposalId: created.proposal.id,
          expectedVersion: created.proposal.version
        };
        pendingMemoryAdmissions.current.set(card.id, pending);
      }
      const admitted = await memoryApi.admitMemoryProposal(pending.proposalId, {
        expectedVersion: pending.expectedVersion,
        acknowledgements
      });
      if (admitted.status === "admitted" || admitted.status === "already_exists") {
        pendingMemoryAdmissions.current.delete(card.id);
        setMemoryConfirmations((current) => {
          const next = { ...current };
          delete next[card.id];
          return next;
        });
        setMemoryFeedback((current) => ({
          ...current,
          [card.id]: {
            message: admitted.status === "already_exists"
              ? "这条内容已经在长期记忆里了。"
              : "已长期记住",
            tone: "success"
          }
        }));
        await session.reload();
        setMemoryRecommendationRefresh((current) => current + 1);
        return;
      }
      if (admitted.status === "needs_confirmation") {
        pendingMemoryAdmissions.current.set(card.id, {
          proposalId: admitted.proposal.id,
          expectedVersion: admitted.proposal.version
        });
        setMemoryConfirmations((current) => ({
          ...current,
          [card.id]: {
            requirements: admitted.confirmationRequirements,
            selected: acknowledgements.filter((acknowledgement) => (
              admitted.confirmationRequirements.some(
                (requirement) => requirement.code === acknowledgement
              )
            ))
          }
        }));
        setMemoryFeedback((current) => ({
          ...current,
          [card.id]: {
            message: "还需要你明确确认，确认前不会加入长期记忆。",
            tone: "notice"
          }
        }));
        return;
      }
      pendingMemoryAdmissions.current.delete(card.id);
      setMemoryConfirmations((current) => {
        const next = { ...current };
        delete next[card.id];
        return next;
      });
      setMemoryFeedback((current) => ({
        ...current,
        [card.id]: {
          message: "这张卡片不符合长期保存的安全条件；卡片本身仍会保留。",
          tone: "notice"
        }
      }));
    } catch (error) {
      const conflict = error instanceof DailyReflectionApiError && error.status === 409;
      const retryable = error instanceof DailyReflectionApiError && error.status === 503;
      if (conflict) {
        pendingMemoryAdmissions.current.delete(card.id);
        setMemoryConfirmations((current) => {
          const next = { ...current };
          delete next[card.id];
          return next;
        });
        await session.reload();
        setMemoryRecommendationRefresh((current) => current + 1);
      } else if (!retryable) {
        pendingMemoryAdmissions.current.delete(card.id);
      }
      setMemoryFeedback((current) => ({
        ...current,
        [card.id]: {
          message: conflict
            ? "这份内容已在其他页面更新，请重新加载最新内容。"
            : retryable
              ? "这次保存还没有确认完成，请重试；重试会继续同一次操作。"
              : "暂时无法长期记住，请稍后重试。",
          tone: "error"
        }
      }));
    } finally {
      memoryBusyCardIdRef.current = null;
      setMemoryBusyCardId(null);
    }
  };

  const decideCard = async (
    card: DailyReflectionCardView,
    decision: DailyReflectionCardDecision
  ) => {
    if (
      onLocalReviewMetric
      && (decision.userTitle !== card.userTitle || decision.userText !== card.userText)
    ) {
      onLocalReviewMetric({
        name: "card_edited",
        value: 1,
        reflectionId: session.reflectionId,
        tier: card.displayTier
      });
    }
    if (onLocalReviewMetric && decision.reviewStatus === "kept" && card.reviewStatus !== "kept") {
      onLocalReviewMetric({
        name: "card_kept",
        value: 1,
        reflectionId: session.reflectionId,
        tier: card.displayTier
      });
    }
    if (onLocalReviewMetric && decision.promoteToPrimary) {
      onLocalReviewMetric({
        name: "card_promoted",
        value: 1,
        reflectionId: session.reflectionId,
        tier: "more"
      });
    }
    await session.updateCard(decision);
  };

  const selectRecommendedCardForLongTermMemory = async (
    card: DailyReflectionCardView
  ) => {
    if (
      memoryBusyCardIdRef.current
      || card.evidenceIds.length === 0
      || (card.cardKind === "user_action" && !card.actionClaimed)
    ) return;
    memoryBusyCardIdRef.current = card.id;
    setMemoryBusyCardId(card.id);
    setMemoryFeedback((current) => {
      const next = { ...current };
      delete next[card.id];
      return next;
    });
    try {
      if (session.workingCardStates[card.id]?.status !== "saved") {
        const saved = await session.saveWorkingCard(card.id, {
          userTitle: card.userTitle,
          userText: card.userText
        });
        if (!saved) {
          setMemoryFeedback((current) => ({
            ...current,
            [card.id]: {
              message: "卡片还没有保存成功，请重试。",
              tone: "error"
            }
          }));
          return;
        }
      }
      await decideCard(card, {
        cardId: card.id,
        reviewStatus: "kept",
        userTitle: card.userTitle,
        userText: card.userText,
        ...(card.cardKind === "user_action"
          ? { actionClaimed: card.actionClaimed }
          : {})
      });
      setMemoryFeedback((current) => ({
        ...current,
        [card.id]: {
          message: "已选择长期记住，完成复盘后处理。",
          tone: "success"
        }
      }));
    } finally {
      memoryBusyCardIdRef.current = null;
      setMemoryBusyCardId(null);
    }
  };

  const toggleMoreCards = () => {
    if (!moreCardsExpanded && onLocalReviewMetric) {
      onLocalReviewMetric({
        name: "more_expanded",
        value: 1,
        reflectionId: session.reflectionId,
        tier: "more"
      });
    }
    setMoreCardsExpanded((current) => !current);
  };

  const savePrimaryCards = async () => {
    for (const card of unsavedPrimaryCards) {
      await session.saveWorkingCard(card.id, {
        userTitle: card.userTitle,
        userText: card.userText
      });
    }
  };

  const finalizeReview = (saveIntent: "recap_only" | "retain_selected") => {
    if (onLocalReviewMetric) {
      onLocalReviewMetric({
        name: "review_submitted",
        value: 1,
        reflectionId: session.reflectionId
      });
      if (reviewStartedAt.current !== null) {
        onLocalReviewMetric({
          name: "review_duration_ms",
          value: Math.max(0, Math.round(performance.now() - reviewStartedAt.current)),
          reflectionId: session.reflectionId
        });
      }
    }
    void session.finalize(saveIntent);
  };

  const selectFile = (nextFile: File | null) => {
    if (!nextFile) {
      setFile(null);
      fileOperationKey.current = null;
      setFileError(null);
      return;
    }
    if (nextFile.size <= 0) {
      setFile(null);
      fileOperationKey.current = null;
      setFileError("这段录音没有内容，请重新选择。最终仍以实际上传检查为准。");
      return;
    }
    if (nextFile.size > MAX_CLIENT_FILE_BYTES) {
      setFile(null);
      fileOperationKey.current = null;
      setFileError("文件超过 300MB，请选择较小的录音。最终仍以实际上传检查为准。");
      return;
    }
    if (!isSupportedAudioUpload(nextFile)) {
      setFile(null);
      fileOperationKey.current = null;
      setFileError("暂不支持这种录音格式。最终仍以实际上传检查为准。");
      return;
    }
    setFile(nextFile);
    fileOperationKey.current = null;
    setFileError(null);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file || !sourceOrigin || !recordingDate || busy) return;
    recorderRef.current?.cancel();
    browserReadyOperationKey.current = null;
    setFileError(null);
    const operationKey = fileOperationKey.current ?? createOperationKey("file_picker");
    fileOperationKey.current = operationKey;
    void session.upload(file, sourceOrigin, recordingDate, {
      operationKey,
      inputAdapter: "file_picker"
    });
  };

  const startBrowserRecording = useCallback(async (allowWithoutSource = false) => {
    if (!browserSourceOrigin && !allowWithoutSource) {
      setRecorderError("先确认这段声音来自自己的复盘，还是一段真实交流。");
      return;
    }
    const recorder = recorderRef.current;
    if (!recorder) return;
    setRecorderError(null);
    setRecordingDate(localDateValue());
    browserSubmitLatch.current = false;
    browserReadyOperationKey.current = null;
    try {
      await recorder.start();
      setRecorderSnapshot(recorder.getSnapshot());
    } catch (error) {
      const message = browserRecordingError(error);
      if (message) setRecorderError(message);
    }
  }, [browserSourceOrigin]);

  const selectCaptureMode = (mode: "voice" | "upload" | "toy") => {
    if (captureModeLocked && mode !== "voice") return;
    if (mode === "toy") setToyPanelVisited(true);
    setCaptureMode(mode);
  };

  const moveCaptureTabFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')];
    if (tabs.length === 0) return;
    const currentIndex = Math.max(0, tabs.indexOf(document.activeElement as HTMLButtonElement));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[nextIndex]?.focus();
    tabs[nextIndex]?.click();
  };

  useEffect(() => {
    if (
      !autoStartVoice
      || voiceAutostartAttempted.current
      || !browserRecordingEnabled
      || captureMode !== "voice"
      || session.auth.status !== "authenticated"
      || recorderSnapshot.state !== "idle"
      || !recorderRef.current
    ) return;
    voiceAutostartAttempted.current = true;
    void startBrowserRecording(true);
  }, [
    autoStartVoice,
    browserRecordingEnabled,
    captureMode,
    recorderSnapshot.state,
    session.auth.status,
    startBrowserRecording
  ]);

  const stopBrowserRecording = async () => {
    const recorder = recorderRef.current;
    if (!recorder || recorderSnapshot.state !== "recording") return;
    setRecorderError(null);
    try {
      const recording = await recorder.stop();
      browserReadyOperationKey.current = createOperationKey("browser_recorder");
      setRecorderSnapshot({
        ...recorder.getSnapshot(),
        recording
      });
    } catch (error) {
      const message = browserRecordingError(error);
      if (message) setRecorderError(message);
    }
  };

  const cancelBrowserRecording = () => {
    recorderRef.current?.cancel();
    browserSubmitLatch.current = false;
    browserReadyOperationKey.current = null;
    setBrowserSubmitting(false);
    setRecorderError(null);
    setRecorderSnapshot(recorderRef.current?.getSnapshot() ?? EMPTY_RECORDER_SNAPSHOT);
  };

  const rerecordBrowserRecording = async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    browserSubmitLatch.current = false;
    browserReadyOperationKey.current = null;
    setBrowserSubmitting(false);
    setRecorderError(null);
    try {
      await recorder.rerecord();
      setRecorderSnapshot(recorder.getSnapshot());
    } catch (error) {
      const message = browserRecordingError(error);
      if (message) setRecorderError(message);
    }
  };

  const submitBrowserRecording = async () => {
    const recording = recorderSnapshot.recording;
    if (!recording || !browserSourceOrigin || busy || browserSubmitLatch.current) return;
    const operationKey = browserReadyOperationKey.current
      ?? createOperationKey("browser_recorder");
    browserReadyOperationKey.current = operationKey;
    browserSubmitLatch.current = true;
    setBrowserSubmitting(true);
    setRecorderError(null);
    const browserFile = browserRecordingFile(recording, recordingDate);
    try {
      await session.uploadBrowserRecording(
        browserFile,
        recording.clientReportedDurationMs > 0
          ? recording.clientReportedDurationMs
          : undefined,
        recordingDate,
        operationKey,
        browserSourceOrigin
      );
    } catch {
      setRecorderError("录音没有提交成功。你可以保留这段本地录音并重新尝试。");
    } finally {
      browserSubmitLatch.current = false;
      setBrowserSubmitting(false);
    }
  };

  const requestTranscriptFocus = (candidate: DailyReflectionCandidateView) => {
    const segmentId = candidate.sourceSegmentIds[0];
    if (!segmentId) return;
    requestTranscriptSegmentFocus(segmentId);
  };

  const requestTranscriptSegmentFocus = (segmentId: string) => {
    setFocusRequest((current) => ({
      segmentId,
      requestId: (current?.requestId ?? 0) + 1
    }));
  };

  useEffect(() => {
    if (
      !initialSegmentId
      || !detail
      || (initialReflectionId !== null && detail.reflection.id !== initialReflectionId)
      || !detail.segments.some((segment) => segment.id === initialSegmentId)
    ) return;
    const focusKey = `${detail.reflection.id}:${initialSegmentId}`;
    if (appliedInitialSegmentKey.current === focusKey) return;
    appliedInitialSegmentKey.current = focusKey;
    requestTranscriptSegmentFocus(initialSegmentId);
  }, [detail, initialReflectionId, initialSegmentId]);

  if (session.auth.status === "checking") {
    return (
      <div className={styles.root}>
        <main className={styles.loadingScreen}>
          <div className={styles.loadingCard} role="status">
            <span className={styles.loadingDot} aria-hidden="true" />
            <p>正在确认你的私人空间…</p>
          </div>
        </main>
      </div>
    );
  }

  if (session.auth.status === "anonymous") {
    return (
      <div className={styles.root}>
        <main className={styles.loadingScreen}>
          <div className={styles.loadingCard} role="status">
            <span className={styles.loadingDot} aria-hidden="true" />
            <p>正在返回登录页…</p>
          </div>
        </main>
      </div>
    );
  }

  if (session.auth.status === "error") {
    return (
      <div className={styles.root}>
        <main className={styles.loadingScreen}>
          <div className={styles.loadingCard}>
            <h1>暂时无法进入</h1>
            <p className={styles.inlineError} role="alert">{safeErrorMessage(session.auth.message)}</p>
            <Link className={styles.primaryButton} href="/date-companion">返回登录</Link>
          </div>
        </main>
      </div>
    );
  }

  const userLabel = session.auth.user.name?.trim() || session.auth.user.email;
  const status = detail?.reflection.status;
  const progress = detail?.job?.progress;
  const isIndeterminateUpload = !uploadFailure && (session.operation === "uploading" || detail?.uploadState === "still_persisting");
  const recordFileName = detail?.upload?.originalName
    ?? session.selectedFile?.name
    ?? file?.name
    ?? (status === "cancelled" ? "原录音已清理" : "正在读取");
  const recordDate = detail?.upload?.recordingDate
    ?? (session.selectedFile || file || browserSubmitting ? recordingDate : "正在读取");
  const recordSource = detail?.effectiveOrigin
    ?? detail?.reflection.sourceOrigin
    ?? (session.sourceOrigin ?? (file ? sourceOrigin : browserSubmitting ? browserSourceOrigin : null));

  return (
    <div className={embedded ? styles.embeddedRoot : styles.root}>
      {!embedded ? <header className={styles.header}>
        <Link className={styles.wordmark} href="/" aria-label="返回产品选择">
          <span className={styles.wordmarkMark}>DB</span>
          <b>日常复盘</b>
        </Link>
        <nav className={styles.productNav} aria-label="产品空间">
          <Link href="/date-companion/a">约会陪伴</Link>
          <Link aria-current="page" className={styles.activeProductNav} href={REFLECTION_ROUTES.home}>日常复盘</Link>
          <Link href="/reflection/cards">卡片</Link>
          <Link href="/reflection/memory">记忆</Link>
          <Link href="/reflection/reflect">回看</Link>
          <Link href="/reflection/think?mode=past_clues">一起想</Link>
        </nav>
        <div className={styles.headerTools}>
          <span title={userLabel}>{userLabel}</span>
          <button
            className={styles.quietButton}
            onClick={async () => {
              recorderRef.current?.cancel();
              browserReadyOperationKey.current = null;
              fileOperationKey.current = null;
              await session.logout();
              router.replace("/date-companion");
            }}
            type="button"
          >退出</button>
        </div>
      </header> : null}

      <main className={styles.page}>
        {!showRecord && surface !== "session" ? <section className={styles.intro}>
          <div>
            <p className={styles.eyebrow}>真实表达 · 由你决定留下什么</p>
            <h1>{surface === "capture" ? "今天想留下什么？" : "把一天里值得回看的话，慢慢整理出来。"}</h1>
          </div>
          <p className={styles.introText}>{browserRecordingEnabled
            ? "开始说、上传一段已有录音，或从玩偶录音中选择一段。整理出的卡片不会自动成为长期记忆。"
            : "上传一段已有录音并确认来源。整理出的卡片不会自动成为长期记忆。"}</p>
        </section> : null}

        {!showRecord && surface !== "session" ? (
          <div className={styles.captureWorkspace}>
            <div
              className={styles.captureModeTabs}
              role="tablist"
              aria-label="选择表达方式"
              onKeyDown={moveCaptureTabFocus}
            >
              {browserRecordingEnabled ? (
                <button
                  aria-controls="reflection-capture-record"
                  aria-selected={captureMode === "voice"}
                  id="reflection-capture-tab-voice"
                  onClick={() => selectCaptureMode("voice")}
                  role="tab"
                  tabIndex={captureMode === "voice" ? 0 : -1}
                  type="button"
                >开始说</button>
              ) : null}
              <button
                aria-controls="reflection-capture-upload"
                aria-selected={captureMode === "upload"}
                disabled={captureModeLocked}
                id="reflection-capture-tab-upload"
                onClick={() => selectCaptureMode("upload")}
                role="tab"
                tabIndex={captureMode === "upload" ? 0 : -1}
                type="button"
              >上传录音</button>
              {toySyncEnabled ? (
                <button
                  aria-controls="reflection-capture-toy-panel"
                  aria-selected={captureMode === "toy"}
                  disabled={captureModeLocked}
                  id="reflection-capture-tab-toy"
                  onClick={() => selectCaptureMode("toy")}
                  role="tab"
                  tabIndex={captureMode === "toy" ? 0 : -1}
                  type="button"
                >从玩偶导入</button>
              ) : null}
            </div>
            {toySyncEnabled && (toyPanelVisited || captureMode === "toy") ? (
              <div
                aria-labelledby="reflection-capture-tab-toy"
                className={styles.capturePanel}
                hidden={captureMode !== "toy"}
                id="reflection-capture-toy-panel"
                role="tabpanel"
              >
                <DailyReflectionToySync
                  accountId={session.auth.user.id}
                  busy={busy}
                  key={session.auth.user.id}
                  onUpload={(toyFile, toyRecordingDate, operationKey, toySourceOrigin) => session.upload(
                    toyFile,
                    toySourceOrigin,
                    toyRecordingDate,
                    { operationKey, inputAdapter: "toy_sync" }
                  )}
                />
              </div>
            ) : null}
            {browserRecordingEnabled ? (
              <section hidden={captureMode !== "voice"} id="reflection-capture-record" className={`${styles.uploadCard} ${styles.recordingCard} ${styles.capturePanel}`} aria-labelledby="reflection-capture-tab-voice" role="tabpanel">
                <div>
                  <p className={styles.eyebrow}>现在说一说</p>
                  <h2 id="daily-reflection-recording-title">开始说</h2>
                </div>
                <p className={styles.cardLead}>只录下这次复盘。停止后先留在本地，由你确认后再提交整理。</p>

                <fieldset className={styles.sourceFieldset}>
                  <legend>这段录音来自哪里？</legend>
                  {SOURCE_OPTIONS.map((option) => (
                    <label className={styles.sourceChoice} key={option.value}>
                      <input
                        checked={browserSourceOrigin === option.value}
                        name="browserSourceOrigin"
                        onChange={() => setBrowserSourceOrigin(option.value)}
                        type="radio"
                        value={option.value}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </fieldset>

                {recorderSnapshot.state === "starting" ? (
                  <div className={styles.recorderState} role="status">
                    <b>正在请求麦克风权限…</b>
                    <p>请在浏览器提示中选择是否允许。</p>
                    <button className={styles.secondaryButton} onClick={cancelBrowserRecording} type="button">取消这次表达</button>
                  </div>
                ) : recorderSnapshot.state === "recording" ? (
                  <div className={styles.recorderState}>
                    <time
                      aria-label={`录音时长 ${formatRecordingDuration(recorderSnapshot.clientReportedDurationMs)}`}
                      className={styles.recorderTimer}
                    >{formatRecordingDuration(recorderSnapshot.clientReportedDurationMs)}</time>
                    <p aria-live="polite" className={styles.recorderHint}>
                      {recordingDurationCopy(recorderSnapshot.clientReportedDurationMs)}
                    </p>
                    <div className={styles.recorderActions}>
                      <button className={styles.primaryButton} onClick={() => void stopBrowserRecording()} type="button">结束表达</button>
                      <button className={styles.secondaryButton} onClick={cancelBrowserRecording} type="button">取消这次表达</button>
                    </div>
                  </div>
                ) : recorderSnapshot.state === "stopping" ? (
                  <div className={styles.recorderState} role="status">
                    <b>正在准备本地录音…</b>
                    <p>正在准备可由你确认的本地录音。</p>
                  </div>
                ) : recorderSnapshot.state === "ready" && recorderSnapshot.recording ? (
                  <div className={styles.recorderState}>
                    <b role="status">本地录音已准备好</b>
                    <time
                      aria-label={`本地录音时长 ${formatRecordingDuration(recorderSnapshot.recording.clientReportedDurationMs)}`}
                      className={styles.recorderTimer}
                    >{formatRecordingDuration(recorderSnapshot.recording.clientReportedDurationMs)}</time>
                    <p>先听从自己的感受决定：提交整理，或重新录一段。</p>
                    <div className={styles.recorderActions}>
                      <button
                        className={styles.primaryButton}
                        disabled={busy || browserSubmitting}
                        onClick={() => void submitBrowserRecording()}
                        type="button"
                      >{browserSubmitting ? "正在开始整理……" : "开始整理"}</button>
                      <button className={styles.secondaryButton} disabled={browserSubmitting} onClick={() => void rerecordBrowserRecording()} type="button">重新录制</button>
                      <button className={styles.dangerButton} disabled={browserSubmitting} onClick={cancelBrowserRecording} type="button">删除本地录音</button>
                    </div>
                  </div>
                ) : (
                  <div className={styles.recorderState}>
                    <p>准备好后开始，说完由你自己停止；录到三分钟也不会被中断。</p>
                    <button
                      className={styles.primaryButton}
                      disabled={!browserSourceOrigin && !autoStartVoice}
                      onClick={() => void startBrowserRecording(autoStartVoice)}
                      type="button"
                    >{recorderError ? "重新尝试" : "开始说"}</button>
                  </div>
                )}

                {recorderError ? <p className={styles.inlineError} role="alert">{recorderError}</p> : null}
                <p className={styles.localOnlyNote}>提交前请不要刷新或离开，本地录音不会自动恢复。提交成功后可以稍后从“最近复盘”回来。</p>
              </section>
            ) : null}
            <div
              aria-labelledby="reflection-capture-tab-upload"
              className={styles.capturePanel}
              hidden={captureMode !== "upload"}
              id="reflection-capture-upload"
              role="tabpanel"
            >
              <form
                aria-label="上传日常复盘录音"
                className={styles.uploadCard}
                onSubmit={submit}
              >
              <div>
                  <p className={styles.eyebrow}>已有一段声音</p>
                  <h2>上传录音</h2>
              </div>
              <p className={styles.cardLead}>来源需要由你明确选择；初始不会替你预选。</p>

              <fieldset className={styles.sourceFieldset}>
                <legend>这段录音来自哪里？</legend>
                {SOURCE_OPTIONS.map((option) => (
                  <label className={styles.sourceChoice} key={option.value}>
                    <input
                      checked={sourceOrigin === option.value}
                      name="sourceOrigin"
                      onChange={() => {
                        setSourceOrigin(option.value);
                        fileOperationKey.current = null;
                      }}
                      type="radio"
                      value={option.value}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </fieldset>

              <label className={styles.filePicker}>
                <input
                  accept="audio/*,video/mp4,.aac,.flac,.m4a,.mp3,.mp4,.mpga,.ogg,.opus,.pcm,.wav,.webm"
                  onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
                  type="file"
                />
                <strong>{file ? "重新选择录音" : "选择一段已有录音"}</strong>
                <small>常见音频格式，单个文件不超过 300MB</small>
              </label>
              {file ? (
                <div className={styles.selectedFile}>
                  <b>{file.name}</b>
                  <span>{formatFileSize(file.size)}</span>
                </div>
              ) : null}
              {fileError ? <p className={styles.inlineError} role="alert">{fileError}</p> : null}
              {session.state === "error" && session.errorMessage ? (
                <p className={styles.inlineError} role="alert">{safeErrorMessage(session.errorMessage)}</p>
              ) : null}

              <label className={styles.dateField}>
                <span>录音发生在</span>
                <input
                  max={localDateValue()}
                  onChange={(event) => {
                    setRecordingDate(event.target.value);
                    fileOperationKey.current = null;
                    browserReadyOperationKey.current = null;
                  }}
                  required
                  type="date"
                  value={recordingDate}
                />
              </label>

              <div className={styles.uploadActions}>
                <button
                  className={styles.primaryButton}
                  disabled={!file || !sourceOrigin || !recordingDate || Boolean(fileError) || busy}
                  type="submit"
                >开始整理</button>
              </div>
              </form>
            </div>
          </div>
        ) : showRecord ? (
          <div className={styles.statusColumn}>
            <div className={styles.detailToolbar}>
              <button className={`${styles.secondaryButton} ${styles.sessionBackButton}`} onClick={() => {
                if (embedded) router.push(REFLECTION_ROUTES.home);
                else session.startNew();
              }} type="button">
                返回今天
              </button>
              <Link href="/reflection/sessions">最近复盘</Link>
            </div>
            {session.recordingRecovery && (!session.reflectionId || session.recordingRecovery.reflectionId === session.reflectionId)
              ? <ReflectionRecordingRecovery session={session} /> : null}
            <section
              aria-live="polite"
              className={styles.statusCard}
              data-status={status ?? session.state}
            >
              <div className={styles.statusTop}>
                <div>
                  <p className={styles.eyebrow}>这次记录</p>
                  <h2>{browserSubmitting && !session.reflectionId
                    ? "正在上传这次录音……"
                    : status === "review_pending"
                      ? "这次复盘"
                      : processingCopy(detail, session.state)}</h2>
                </div>
                <span className={styles.statusBadge}>{uploadFailure ? "保存失败" : detail?.uploadState === "still_persisting" ? "保存中" : detail?.uploadState === "unresolved" || detail?.uploadState === "reupload_allowed" || (status === "created" || status === "uploading") && detail?.uploadState !== "accepted" ? "尚未确认" : status === "review_pending"
                  ? "等你看看"
                  : status === "confirmation_ready" || status === "admitting"
                    ? "正在保存"
                    : status === "completed"
                      ? "已完成"
                      : status === "admission_failed"
                        ? "需要查看"
                  : status === "failed"
                    ? "需要重试"
                    : status === "cancelled"
                      ? "已取消"
                      : session.state === "error"
                        ? "暂时中断"
                        : "处理中"}</span>
              </div>

              <div className={styles.recordMeta}>
                <div><span>日期</span><b>{recordDate}</b></div>
                <div><span>来源</span><b>{sourceLabel(recordSource)}</b></div>
                <div><span>时长</span><b>{formatDurationSeconds(detail?.upload?.durationSeconds)}</b></div>
              </div>
              <p className={styles.recordFileName} title={recordFileName}>原始录音：{recordFileName}</p>
              <p className={styles.sourceAttribution}>{sourceStatement(recordSource, recordDate)}</p>

              {isIndeterminateUpload ? (
                <div className={styles.progressBlock} role="status">
                  <div className={styles.progressTop}><span>{detail?.uploadState === "still_persisting" ? "服务器正在保存录音" : "正在上传录音"}</span><span>请稍候</span></div>
                  <div className={`${styles.progressTrack} ${styles.indeterminateTrack}`} aria-label="正在上传，暂无百分比"><span /></div>
                </div>
              ) : null}
              {processing && !isIndeterminateUpload && typeof progress === "number" ? (
                <div className={styles.progressBlock} role="status">
                  <div className={styles.progressTop}><span>{processingCopy(detail, session.state)}</span><span>{Math.round(progress)}%</span></div>
                  <div className={styles.progressTrack} aria-label={`整理进度 ${Math.round(progress)}%`}>
                    <span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
                  </div>
                </div>
              ) : null}

              {uploadFailure ? <p className={styles.inlineError} role="alert">{reflectionUploadFailureMessage(uploadFailure)} 排查代码：{uploadFailure.code} · 记录编号：{session.reflectionId}</p> : null}
              {uploadFailure && !session.recordingRecovery ? <p>此浏览器没有可恢复的原音频副本。请先删除失败记录，再重新选择原文件或录制；页面不会自动重传。</p> : null}
              {!uploadFailure && (status === "failed" || session.state === "failed" || session.state === "error") ? (
                <p className={styles.inlineError} role="alert">
                  {safeErrorMessage(detail?.reflection.errorCode ?? session.errorMessage)}
                </p>
              ) : null}
              {processing && !session.recordingRecovery ? (
                <p className={styles.backgroundNote}>{isIndeterminateUpload
                  ? "尚未确认录音保存成功，请保持页面打开。"
                  : "录音已接收，正在整理。可以稍后从最近复盘回来查看，内容仍由你确认。"}</p>
              ) : null}
              {session.errorMessage && session.state !== "error" && status !== "failed" ? (
                <p className={styles.inlineError} role="alert">{safeErrorMessage(session.errorMessage)}</p>
              ) : null}
              {status === "cancelled" || session.state === "cancelled" ? (
                <p className={styles.cancelledNote}>这次整理已经停止。你仍可以删除这条记录。</p>
              ) : null}

              <div className={styles.statusActions}>
                {uploadFailure && !session.recordingRecovery ? <button className={styles.dangerButton} disabled={busy} onClick={() => setDeleteConfirmation(true)} type="button">删除失败记录</button> : null}
                {!uploadFailure && (status === "failed" || session.state === "failed") ? (
                  <button className={styles.secondaryButton} disabled={busy} onClick={() => void session.retry()} type="button">
                    {session.operation === "retrying" ? "正在重试…" : "重试整理"}
                  </button>
                ) : null}
                {session.state === "error" && session.reflectionId ? (
                  <button className={styles.secondaryButton} disabled={busy} onClick={() => void session.reload()} type="button">重新读取</button>
                ) : null}
                {processing ? (
                  <button className={styles.secondaryButton} disabled={busy} onClick={() => void session.cancel()} type="button">
                    {session.operation === "cancelling" ? "正在取消…" : "取消整理"}
                  </button>
                ) : null}
                {session.reflectionId ? (
                  <details className={styles.recordAdvancedActions}>
                    <summary aria-label="更多">⋯</summary>
                    <div>
                      <button className={styles.dangerButton} disabled={busy} onClick={() => setDeleteConfirmation(true)} type="button">删除原始记录</button>
                    </div>
                  </details>
                ) : null}
              </div>
              <ReflectionConfirmDialog
                busy={session.operation === "deleting"}
                busyLabel="正在删除…"
                cancelLabel="先保留"
                confirmLabel="确认删除"
                onCancel={() => setDeleteConfirmation(false)}
                onConfirm={() => void session.delete()}
                open={deleteConfirmation && Boolean(session.reflectionId)}
                role="alertdialog"
                title="删除这次复盘和原始记录？"
              >
                <p>这会删除录音、完整文字记录和由本次复盘产生的长期记忆。已经保存到卡片库的卡片可以保留，但会明确显示原始来源已不可用。删除失败时页面会保留，方便你重试。</p>
              </ReflectionConfirmDialog>
            </section>

            {detail && detail.reflection.status === "failed" && detail.segments.length > 0 ? (
              <div>
                <section className={styles.candidateSection} aria-labelledby="daily-reflection-incomplete-title">
                  <div className={styles.sectionHeading}>
                    <div>
                      <p>文字记录已经保留</p>
                      <h2 id="daily-reflection-incomplete-title">这次整理还不完整</h2>
                    </div>
                  </div>
                  <p className={styles.outcomeCopy}>你仍然可以回看完整文字记录。稍后重试时，会继续整理重点，不会把当前的不完整结果当成最终内容。</p>
                  <button
                    className={styles.secondaryButton}
                    disabled={busy}
                    onClick={() => void session.retry()}
                    type="button"
                  >{session.operation === "retrying" ? "正在重试…" : "重新整理重点"}</button>
                  <ManualCandidateComposer
                    busy={busy}
                    onCreate={(candidate) => void session.createManualCandidate(candidate)}
                    segments={detail.segments}
                  />
                </section>
                <DailyReflectionTranscript focusRequest={focusRequest} segments={detail.segments} />
              </div>
            ) : null}

            {detail?.reflection.status === "review_pending" ? (
              <div>
                <section className={`${styles.candidateSection} ${styles.reviewSection}`} aria-labelledby="daily-reflection-candidates-title">
                  <div className={styles.sectionHeading}>
                    <div>
                      <p>先查看，不会自动进入长期记忆</p>
                      <h2 id="daily-reflection-candidates-title">这次表达里有什么值得带走</h2>
                    </div>
                    <span>{cards.length > 0 ? cards.length : candidates.length} 条</span>
                  </div>
                  {cards.length > 0 ? (
                    <div className={styles.reviewOverview}>
                      <div>
                        <span>你主要在思考</span>
                        <strong>{[...new Set(cards.map((card) => card.clusterTitle))].join(" · ")}</strong>
                        <small>{[...new Set(cards.map((card) => card.clusterTitle))].length} 个主题 · {cards.length} 张卡片</small>
                      </div>
                      <button
                        className={styles.secondaryButton}
                        disabled={busy || unsavedPrimaryCards.length === 0}
                        onClick={() => void savePrimaryCards()}
                        type="button"
                      >保存这些重点为卡片</button>
                    </div>
                  ) : candidates.length > 0 ? (
                    <div className={styles.reviewToolbar}>
                      <p>这是较早保存的复盘记录，可以逐条确认。</p>
                      <button
                        className={styles.secondaryButton}
                        disabled={busy || candidates.every((candidate) => candidate.status === "kept")}
                        onClick={() => void session.acceptAllCandidates()}
                        type="button"
                      >长期记住这些重点</button>
                    </div>
                  ) : null}
                  {recommendedCards.length > 0 ? (
                    <section
                      aria-labelledby="daily-reflection-review-memory-recommendations-title"
                      className={styles.memoryRecommendationSection}
                    >
                      <div className={styles.memoryRecommendationHeading}>
                        <div>
                          <p>可选，不影响完成本次复盘</p>
                          <h3 id="daily-reflection-review-memory-recommendations-title">建议长期记住</h3>
                        </div>
                        <span>{recommendedCards.length} 张</span>
                      </div>
                      <p className={styles.memoryRecommendationLead}>
                        这些卡片以后可能继续有用。默认不会长期保存，只有你明确选择时才会处理。
                      </p>
                      <ol className={styles.memoryRecommendationGrid}>
                        {recommendedCards.map(({ card }) => (
                          <li className={styles.memoryRecommendationCard} key={card.id}>
                            <span className={styles.candidateType}>{CANDIDATE_KIND_LABELS[card.cardKind]}</span>
                            <h4>{card.userTitle ?? card.proposedTitle}</h4>
                            <small>{card.evidenceIds.length} 条来源</small>
                            <ReflectionRecommendationEvidence
                              card={card}
                              onSource={requestTranscriptSegmentFocus}
                            />
                            <ReflectionMemoryAction
                              busy={memoryBusyCardId === card.id}
                              feedback={memoryFeedback[card.id]}
                              onConfirm={() => undefined}
                              onRemember={() => void selectRecommendedCardForLongTermMemory(card)}
                              onToggleConfirmation={() => undefined}
                              selected={card.reviewStatus === "kept"}
                            />
                          </li>
                        ))}
                      </ol>
                    </section>
                  ) : null}
                  {memoryRecommendationState === "error" ? (
                    <div className={styles.memoryRecommendationError} role="status">
                      <p>长期记住的建议暂时没有读取到；你的复盘和卡片不受影响。</p>
                      <button
                        className={styles.textButton}
                        onClick={() => setMemoryRecommendationRefresh((current) => current + 1)}
                        type="button"
                      >重新读取建议</button>
                    </div>
                  ) : null}
                  {cards.length > 0 ? (
                    <>
                      {reviewPrimaryCards.length > 0 ? (
                        <>
                          <h3>值得带走</h3>
                          <ol className={`${styles.candidateList} ${styles.primaryCardGrid}`}>
                            {reviewPrimaryCards.map((card) => (
                              <ReflectionCardReview
                                busy={busy}
                                card={card}
                                editing={editingCardId === card.id}
                                key={card.id}
                                onCancelEdit={() => setEditingCardId(null)}
                                onDecision={(decision) => decideCard(card, decision)}
                                onArchiveFromCards={(cardId) => void session.archiveWorkingCard(cardId)}
                                onRestoreToCards={(cardId) => void session.restoreWorkingCard(cardId)}
                                onSaveToCards={(cardId, draft) => session.saveWorkingCard(cardId, draft)}
                                onSource={requestTranscriptSegmentFocus}
                                onStartEdit={() => setEditingCardId(card.id)}
                                workingCardStatus={activeWorkingCardStatus(
                                  session.workingCardStates[card.id]?.status
                                )}
                              />
                            ))}
                          </ol>
                        </>
                      ) : null}
                      {reviewMoreCards.length > 0 ? (
                        <section aria-label="更多整理结果">
                          <button
                            aria-expanded={moreCardsExpanded}
                            className={styles.secondaryButton}
                            onClick={toggleMoreCards}
                            type="button"
                          >{moreCardsExpanded
                            ? "收起更多整理结果"
                            : `还有 ${reviewMoreCards.length} 条可能有用的内容`}</button>
                          {moreCardsExpanded ? (
                            <ol className={`${styles.candidateList} ${styles.moreCardList}`}>
                              {reviewMoreCards.map((card) => (
                                <ReflectionCardReview
                                  busy={busy}
                                  card={card}
                                  editing={editingCardId === card.id}
                                  key={card.id}
                                  onCancelEdit={() => setEditingCardId(null)}
                                  onDecision={(decision) => decideCard(card, decision)}
                                  onArchiveFromCards={(cardId) => void session.archiveWorkingCard(cardId)}
                                  onRestoreToCards={(cardId) => void session.restoreWorkingCard(cardId)}
                                  onSaveToCards={(cardId, draft) => session.saveWorkingCard(cardId, draft)}
                                  onSource={requestTranscriptSegmentFocus}
                                  onStartEdit={() => setEditingCardId(card.id)}
                                  workingCardStatus={activeWorkingCardStatus(
                                    session.workingCardStates[card.id]?.status
                                  )}
                                />
                              ))}
                            </ol>
                          ) : null}
                        </section>
                      ) : null}
                    </>
                  ) : candidates.length > 0 ? (
                    <>
                      <ol className={styles.candidateList}>
                        {candidates.map((candidate) => (
                          <CandidateReviewCard
                            busy={busy}
                            candidate={candidate}
                            key={candidate.id}
                            onDecision={(decision) => session.updateCandidate(decision)}
                            onDelete={(candidateId) => void session.excludeCandidate(candidateId)}
                            onSource={requestTranscriptSegmentFocus}
                          />
                        ))}
                      </ol>
                    </>
                  ) : (
                    <p className={styles.emptyCandidates}>这段录音暂时没有整理出待确认内容。</p>
                  )}
                  {cards.length === 0 ? (
                    <ManualCandidateComposer
                      busy={busy}
                      onCreate={(candidate) => void session.createManualCandidate(candidate)}
                      segments={detail.segments}
                    />
                  ) : null}
                </section>

                <DailyReflectionTranscript
                  focusRequest={focusRequest}
                  segments={detail.segments}
                />
                <div className={styles.completionBlock}>
                  <ProductReviewCompletion
                    action={(
                      <button
                        className={styles.primaryButton}
                        disabled={busy}
                        onClick={() => finalizeReview(!recapOnlyRequired && retainedCandidateCount > 0
                          ? "retain_selected"
                          : "recap_only")}
                        type="button"
                      >{session.operation === "finalizing" ? "正在保存…" : "完成这次复盘"}</button>
                    )}
                    className={`${styles.finalizePanel} ${hasCompletionSelection
                      ? styles.finalizePanelActive
                      : styles.finalizePanelIdle}`}
                    description={hasCompletionSelection
                      ? `已保存的卡片会留在卡片库；${retainedCandidateCount > 0
                        ? `只有你明确选择的 ${retainedCandidateCount} 条会进入长期记忆处理。`
                        : "其余整理内容只留在本次复盘中。"}${pendingCandidateCount > 0
                          ? ` 还有 ${pendingCandidateCount} 条可以以后再看。`
                          : ""}`
                      : pendingCandidateCount > 0
                        ? `还有 ${pendingCandidateCount} 条可以以后再看；没有要保存的内容，也可以直接完成。`
                        : "没有要保存的内容，也可以直接完成。"}
                    title={`${savedCardCount} 张卡片 · ${retainedCandidateCount} 条长期记忆（已选择，待处理）`}
                  />
                  {keptWithoutEvidenceCount > 0 ? (
                    <p className={styles.completionNotice}>有 {keptWithoutEvidenceCount} 条手写内容没有原话，只能随本次复盘保存。</p>
                  ) : null}
                  {keptUnclaimedActionCount > 0 ? (
                    <p className={styles.completionNotice}>有 {keptUnclaimedActionCount} 条行动还没有由你认领，只能随本次复盘保存。</p>
                  ) : null}
                </div>
              </div>
            ) : null}

            {detail && (
              detail.reflection.status === "confirmation_ready"
              || detail.reflection.status === "admitting"
              || detail.reflection.status === "completed"
              || detail.reflection.status === "admission_failed"
            ) ? (
              <div>
                <section className={`${styles.candidateSection} ${styles.outcomeSection}`} aria-labelledby="daily-reflection-outcome-title">
                  <div className={styles.sectionHeading}>
                    <div>
                      <p>由你确认的结果</p>
                      <h2 id="daily-reflection-outcome-title">{detail.reflection.status === "completed"
                        ? "这次复盘已经整理好"
                        : detail.reflection.status === "admission_failed"
                          ? "长期记忆还没有保存完成"
                          : "正在整理你确认的内容"}</h2>
                    </div>
                  </div>
                  {detail.reflection.status === "completed"
                    && detail.confirmation
                    && "contractVersion" in detail.confirmation
                    && detail.confirmation.saveIntent === "recap_only" ? (
                    <p className={styles.outcomeCopy}>这次复盘已经保存。没有内容被自动加入长期记忆。</p>
                  ) : detail.reflection.status === "completed" && detail.admissionOperation ? (
                    <p className={styles.outcomeCopy}>
                      {completedAdmissionCopy(
                        detail.admissionOperation,
                        detail.rememberedCount
                      )}
                    </p>
                  ) : detail.reflection.status === "admission_failed" ? (
                    <p className={styles.outcomeCopy}>卡片和原始记录已经保留，但长期记忆暂时没有保存完成。你可以重新保存。</p>
                  ) : (
                    <p className={styles.outcomeCopy}>正在安全保存你刚刚确认的内容。</p>
                  )}
                  {detail.reflection.status === "completed" ? (
                    <dl className={styles.outcomeStats}>
                      <div><dt>你的卡片</dt><dd>{savedCardCount}</dd></div>
                      <div><dt>长期记住</dt><dd>{detail.rememberedCount ?? 0}</dd></div>
                      <div><dt>只留在本次复盘</dt><dd>{Math.max(
                        0,
                        detail.cards.length - (detail.rememberedCount ?? 0)
                      )}</dd></div>
                    </dl>
                  ) : null}
                  {detail.reflection.status === "completed" && recommendedCards.length > 0 ? (
                    <section
                      aria-labelledby="daily-reflection-memory-recommendations-title"
                      className={styles.memoryRecommendationSection}
                    >
                      <div className={styles.memoryRecommendationHeading}>
                        <div>
                          <p>由你最后决定</p>
                          <h3 id="daily-reflection-memory-recommendations-title">建议长期记住</h3>
                        </div>
                        <span>{recommendedCards.length} 张</span>
                      </div>
                      <p className={styles.memoryRecommendationLead}>
                        这些卡片可能在以后继续有用。不会自动保存，只有你明确选择后才会处理。
                      </p>
                      <ol className={styles.memoryRecommendationGrid}>
                        {recommendedCards.map(({ card, recommendation }) => (
                          <li className={styles.memoryRecommendationCard} key={card.id}>
                            <span className={styles.candidateType}>{CANDIDATE_KIND_LABELS[card.cardKind]}</span>
                            <h4>{card.userTitle ?? card.proposedTitle}</h4>
                            <p>{card.userText ?? card.proposedText}</p>
                            <small>{card.evidenceIds.length} 条来源</small>
                            <ReflectionRecommendationEvidence
                              card={card}
                              onSource={requestTranscriptSegmentFocus}
                            />
                            <ReflectionMemoryAction
                              busy={memoryBusyCardId === card.id}
                              confirmation={memoryConfirmations[card.id]}
                              feedback={memoryFeedback[card.id]}
                              onConfirm={(acknowledgements) => void rememberWorkingCard(
                                card,
                                recommendation.memoryType,
                                acknowledgements
                              )}
                              onRemember={() => void rememberWorkingCard(card, recommendation.memoryType)}
                              onToggleConfirmation={(acknowledgement, checked) => (
                                toggleMemoryConfirmation(card.id, acknowledgement, checked)
                              )}
                            />
                          </li>
                        ))}
                      </ol>
                    </section>
                  ) : null}
                  {detail.reflection.status === "completed" && memoryRecommendationState === "error" ? (
                    <div className={styles.memoryRecommendationError} role="status">
                      <p>长期记住的建议暂时没有读取到；你的复盘和卡片不受影响。</p>
                      <button
                        className={styles.textButton}
                        onClick={() => setMemoryRecommendationRefresh((current) => current + 1)}
                        type="button"
                      >重新读取建议</button>
                    </div>
                  ) : null}
                  {detail.cards.length > 0 && outcomeCards.length > 0 ? (
                    <ol className={styles.candidateList}>
                      {outcomeCards.map((card) => {
                        const result = detail.admissionResults.find(
                          (item) => item.candidateId === card.id
                        );
                        const memoryLifecycleStatus = session
                          .workingCardStates[card.id]?.memoryLifecycleStatus;
                        const revoked = memoryLifecycleStatus === "revoked";
                        const revocationPending = memoryLifecycleStatus === "revocation_requested";
                        const remembered = !revoked
                          && !revocationPending
                          && (result?.status === "admitted"
                            || result?.status === "already_admitted");
                        const statusCopy = revoked
                          ? "已撤销长期记忆"
                          : revocationPending
                            ? "正在撤销长期记忆"
                            : remembered
                              ? "已长期记住"
                              : result?.status === "rejected"
                                ? "暂未长期保存"
                                : card.reviewStatus === "excluded"
                                  ? "仅保留在本次复盘"
                                  : "你的卡片";
                        const workingCard = session.workingCardStates[card.id];
                        const explicitMemoryType = memoryTypeForReflectionCard(card);
                        const canRemember = workingCard?.status === "saved"
                          && (workingCard.memoryLifecycleStatus ?? "not_admitted") === "not_admitted"
                          && card.evidenceIds.length > 0
                          && explicitMemoryType !== null;
                        return (
                        <li className={styles.candidateCard} key={card.id}>
                          <div className={styles.candidateCardTop}>
                            <b>{card.userTitle ?? card.proposedTitle}</b>
                            <span className={`${styles.pendingBadge} ${remembered
                              ? styles.keptBadge
                              : styles.excludedBadge}`}>{statusCopy}</span>
                          </div>
                          <p>{card.userText ?? card.proposedText}</p>
                          <button
                            className={styles.textButton}
                            onClick={() => requestTranscriptSegmentFocus(card.evidenceIds[0])}
                            type="button"
                          >查看来源</button>
                          {session.workingCardStates[card.id]?.status === "saved" ? (
                            <div className={styles.candidateActions}>
                              <Link className={styles.secondaryButton} href={`/reflection/cards/${encodeURIComponent(card.id)}`}>打开卡片</Link>
                              {canRemember && explicitMemoryType ? (
                                <ReflectionMemoryAction
                                  busy={memoryBusyCardId === card.id}
                                  confirmation={memoryConfirmations[card.id]}
                                  feedback={memoryFeedback[card.id]}
                                  onConfirm={(acknowledgements) => void rememberWorkingCard(
                                    card,
                                    explicitMemoryType,
                                    acknowledgements
                                  )}
                                  onRemember={() => void rememberWorkingCard(card, explicitMemoryType)}
                                  onToggleConfirmation={(acknowledgement, checked) => (
                                    toggleMemoryConfirmation(card.id, acknowledgement, checked)
                                  )}
                                />
                              ) : card.cardKind === "user_action" && !card.actionClaimed ? (
                                <span className={styles.memoryActionHint}>先在复盘中明确认领这项行动后，才能长期记住。</span>
                              ) : null}
                              <button className={styles.textButton} disabled={busy} onClick={() => void session.archiveWorkingCard(card.id)} type="button">归档卡片</button>
                            </div>
                          ) : session.workingCardStates[card.id]?.status === "archived"
                            || session.workingCardStates[card.id]?.status === "removed" ? (
                              <button className={styles.secondaryButton} disabled={busy} onClick={() => void session.restoreWorkingCard(card.id)} type="button">恢复卡片</button>
                            ) : card.reviewStatus !== "excluded" ? (
                              <button
                                className={styles.secondaryButton}
                                disabled={busy}
                                onClick={() => void session.saveWorkingCard(card.id, {
                                  userTitle: card.userTitle,
                                  userText: card.userText
                                })}
                                type="button"
                              >保存为卡片</button>
                            ) : null}
                        </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <ReflectionResultList
                      activeCandidateId={session.activeCandidateId}
                      busy={busy}
                      detail={detail}
                      errorMessage={session.errorMessage}
                      onRevoke={(candidateId) => void session.revokeCandidate(candidateId)}
                      onSource={requestTranscriptFocus}
                      operation={session.operation}
                    />
                  )}
                  {detail.reflection.status === "admission_failed" ? (
                    <button
                      className={styles.secondaryButton}
                      disabled={busy}
                      onClick={() => void session.finalize(
                        detail.confirmation && "contractVersion" in detail.confirmation
                          ? detail.confirmation.saveIntent
                          : "retain_selected"
                      )}
                      type="button"
                    >重新保存长期记忆</button>
                  ) : null}
                </section>
                <DailyReflectionTranscript focusRequest={focusRequest} segments={detail.segments} />
              </div>
            ) : null}
          </div>
        ) : surface === "session" ? <p className={styles.productEmpty} role="status">正在读取这次复盘…</p> : null}
        {!showRecord && surface === "legacy" ? <DailyReflectionHistory session={session} /> : null}
      </main>
    </div>
  );
}

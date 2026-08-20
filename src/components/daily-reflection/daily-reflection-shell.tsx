"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { isSupportedAudioUpload } from "@/lib/audio/compat";
import {
  BrowserAudioRecorder,
  type BrowserAudioRecorderSnapshot,
  type BrowserAudioRecording
} from "@/lib/client/browser-audio-recorder";
import {
  useDailyReflectionSession,
  type DailyReflectionSessionValue
} from "@/lib/client/daily-reflection-session";
import type {
  DailyReflectionCandidateView,
  DailyReflectionCandidateDecision,
  DailyReflectionDetailResponse,
  DailyReflectionHistoryItem
} from "@/lib/domain/daily-reflection-api";
import type { DateCompanionConfirmedPerson } from "@/lib/domain/date-companion";
import type { SourceOrigin } from "@/lib/domain/daily-reflection";

import {
  DailyReflectionTranscript,
  type TranscriptFocusRequest
} from "./daily-reflection-transcript";
import { DailyReflectionToySync } from "./daily-reflection-toy-sync";
import styles from "./daily-reflection.module.css";

const MAX_CLIENT_FILE_BYTES = 300 * 1024 * 1024;
const REFLECTION_PATH = "/date-companion/reflection";
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
  "user_reflection" | "direct_conversation" | "unknown"
>;

const SOURCE_OPTIONS: ReadonlyArray<{
  label: string;
  value: DailyReflectionUploadSource;
}> = [
  { value: "user_reflection", label: "我自己的复盘" },
  { value: "direct_conversation", label: "我和其他人的真实交流" },
  { value: "unknown", label: "其他或暂时无法确定" }
];

const CANDIDATE_TYPE_LABELS: Record<DailyReflectionCandidateView["candidateType"], string> = {
  event: "发生的事",
  commitment: "约定与行动",
  question: "仍待回答的问题",
  preference: "表达的偏好",
  summary: "这段内容的整理"
};

type DailyReflectionShellProps = {
  initialReflectionId?: string | null;
  browserRecordingEnabled?: boolean;
  toySyncEnabled?: boolean;
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
  createBrowserRecordingIdempotencyKey?: () => string;
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

function defaultBrowserRecordingIdempotencyKey() {
  const id = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `daily-reflection-browser-${id}`;
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
  const status = detail?.reflection.status;
  if (
    status === "created"
    || status === "uploading"
    || status === "transcribing"
    || status === "extracting"
    || state === "uploading"
  ) return "正在整理这次复盘……";
  if (status === "review_pending" || state === "review_pending") return "整理好了，待你确认";
  if (status === "confirmation_ready" || state === "confirmation_ready") return "正在整理你确认的内容";
  if (status === "admitting" || state === "admitting") return "正在把确认结果整理好";
  if (status === "completed" || state === "completed") return "这次复盘已确认";
  if (status === "admission_failed" || state === "admission_failed") return "有些内容还没有整理好";
  if (status === "failed" || state === "failed") return "这次整理没有完成";
  if (status === "cancelled" || state === "cancelled") return "这次记录已取消";
  if (state === "loading") return "正在读取这次记录";
  if (state === "error") return "暂时无法读取这次记录";
  return "准备上传录音";
}

function isProcessing(detail: DailyReflectionDetailResponse | null, state: DailyReflectionSessionValue["state"]) {
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

function candidateStatusLabel(status: DailyReflectionCandidateView["status"]) {
  if (status === "kept") return "会记住";
  if (status === "excluded") return "不会记住";
  return "待你选择";
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

function personOptionLabel(person: DateCompanionConfirmedPerson) {
  const name = person.displayName?.trim() || "未命名人物";
  return `${name} · ${person.id.slice(-6)}`;
}

function personDisplayLabel(
  personId: string,
  confirmedPeople: readonly DateCompanionConfirmedPerson[]
) {
  const person = confirmedPeople.find((item) => item.id === personId);
  return person?.displayName?.trim() || (person ? "未命名人物" : "原关联人物当前不可用");
}

type CandidateReviewCardProps = Readonly<{
  candidate: DailyReflectionCandidateView;
  confirmedPeople: DateCompanionConfirmedPerson[];
  peopleState: DailyReflectionSessionValue["peopleState"];
  busy: boolean;
  onDecision(decision: DailyReflectionCandidateDecision): void;
  onSource(candidate: DailyReflectionCandidateView): void;
}>;

function CandidateReviewCard({
  candidate,
  confirmedPeople,
  peopleState,
  busy,
  onDecision,
  onSource
}: CandidateReviewCardProps) {
  const [draftText, setDraftText] = useState(candidate.userText ?? candidate.proposedText);
  const [subjectPersonId, setSubjectPersonId] = useState(candidate.subjectPersonId ?? "");
  const selectedPersonUnavailable = Boolean(
    subjectPersonId
    && !confirmedPeople.some((person) => person.id === subjectPersonId)
  );

  useEffect(() => {
    setDraftText(candidate.userText ?? candidate.proposedText);
    setSubjectPersonId(candidate.subjectPersonId ?? "");
  }, [candidate.id, candidate.proposedText, candidate.subjectPersonId, candidate.userText, candidate.version]);

  const decide = (status: DailyReflectionCandidateDecision["status"]) => {
    onDecision({
      candidateId: candidate.id,
      status,
      userText: normalizedCandidateText(draftText, candidate.proposedText),
      subjectPersonId: status === "kept" && subjectPersonId ? subjectPersonId : null
    });
  };

  return (
    <li className={styles.candidateCard}>
      <div className={styles.candidateCardTop}>
        <span className={styles.candidateType}>{CANDIDATE_TYPE_LABELS[candidate.candidateType]}</span>
        <span className={`${styles.pendingBadge} ${candidate.status === "kept"
          ? styles.keptBadge
          : candidate.status === "excluded"
            ? styles.excludedBadge
            : ""}`}>{candidateStatusLabel(candidate.status)}</span>
      </div>

      <label className={styles.candidateEditor}>
        <span>你想留下的文字</span>
        <textarea
          aria-label={`编辑${CANDIDATE_TYPE_LABELS[candidate.candidateType]}`}
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

      {candidate.status === "kept" ? (
        <label className={styles.personField}>
          <span>这条内容关于谁（可选）</span>
          {peopleState === "loading" ? <small>正在读取可选择的人物…</small> : null}
          {peopleState === "error" ? <small>人物暂时没有读取成功，不选择也可以继续。</small> : null}
          <select
            aria-label={`为${CANDIDATE_TYPE_LABELS[candidate.candidateType]}选择人物`}
            disabled={busy || peopleState !== "ready"}
            onChange={(event) => setSubjectPersonId(event.target.value)}
            value={subjectPersonId}
          >
            <option value="">暂不关联人物</option>
            {selectedPersonUnavailable ? (
              <option value={subjectPersonId}>原关联人物当前不可用，请重新选择</option>
            ) : null}
            {confirmedPeople.map((person) => (
              <option key={person.id} value={person.id}>{personOptionLabel(person)}</option>
            ))}
          </select>
          {peopleState === "ready" && confirmedPeople.length === 0 ? (
            <small>当前没有可选择的已确认人物。</small>
          ) : null}
        </label>
      ) : null}

      <div className={styles.candidateSource}>
        <span>{candidate.sourceSegmentIds.length} 段原话</span>
        <button className={styles.sourceButton} onClick={() => onSource(candidate)} type="button">查看原话</button>
      </div>
      <div className={styles.candidateActions}>
        <button
          aria-pressed={candidate.status === "excluded"}
          className={styles.secondaryButton}
          disabled={busy}
          onClick={() => decide("excluded")}
          type="button"
        >不记</button>
        <button
          aria-pressed={candidate.status === "kept"}
          className={styles.primaryButton}
          disabled={busy}
          onClick={() => decide("kept")}
          type="button"
        >{candidate.status === "kept" ? "保存修改" : "记住"}</button>
      </div>
    </li>
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
                  <span>{historyStatusLabel(item.status)}</span>
                </span>
                <span className={styles.historySource}>{item.sourceStatement}</span>
                <span className={styles.historyMeta}>
                  <span>{historyCountCopy(item)}</span>
                  <span>{item.transcriptAvailable ? "可查看原话" : "原话暂不可用"}</span>
                </span>
                {item.subjectPersonIds.length > 0 ? (
                  <span className={styles.historyPeople}>
                    {item.subjectPersonIds.map((personId) => (
                      <span key={personId}>{personDisplayLabel(personId, session.confirmedPeople)}</span>
                    ))}
                  </span>
                ) : null}
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
  confirmedPeople: readonly DateCompanionConfirmedPerson[];
  activeCandidateId: string | null;
  busy: boolean;
  errorMessage: string | null;
  operation: DailyReflectionSessionValue["operation"];
  onRevoke(candidateId: string): void;
  onSource(candidate: DailyReflectionCandidateView): void;
}>;

function ReflectionResultList({
  confirmedPeople,
  detail,
  activeCandidateId,
  busy,
  errorMessage,
  operation,
  onRevoke,
  onSource
}: ReflectionResultListProps) {
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
  return (
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
              <span className={styles.candidateType}>{CANDIDATE_TYPE_LABELS[candidate.candidateType]}</span>
              <span className={`${styles.pendingBadge} ${remembered ? styles.keptBadge : styles.excludedBadge}`}>
                {resultLabel}
              </span>
            </div>
            <p>{candidate.userText ?? candidate.proposedText}</p>
            {candidate.subjectPersonId ? (
              <span className={styles.resultPerson}>
                关联人物：{personDisplayLabel(candidate.subjectPersonId, confirmedPeople)}
              </span>
            ) : null}
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
            {confirmingCandidateId === candidate.id && canRevoke ? (
              <div className={styles.revocationConfirmation} role="alertdialog" aria-labelledby={`revoke-${candidate.id}`}>
                <div>
                  <b id={`revoke-${candidate.id}`}>只撤销这一条保存？</b>
                  <p>这只会撤销这一条长期保存，不会修改原始复盘文字，也不会删除整次复盘。查看原话仍会保留。</p>
                </div>
                <div>
                  <button
                    className={styles.secondaryButton}
                    disabled={busy}
                    onClick={() => setConfirmingCandidateId(null)}
                    type="button"
                  >先保留</button>
                  <button
                    className={styles.dangerButton}
                    disabled={busy}
                    onClick={() => onRevoke(candidate.id)}
                    type="button"
                  >{revoking ? "正在撤销…" : retrying ? "重试撤销" : "确认撤销"}</button>
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export function DailyReflectionShell({
  initialReflectionId = null,
  browserRecordingEnabled = false,
  toySyncEnabled = false
}: DailyReflectionShellProps) {
  const session = useDailyReflectionSession({ initialReflectionId });
  return (
    <DailyReflectionShellContent
      browserRecordingEnabled={browserRecordingEnabled}
      initialReflectionId={initialReflectionId}
      session={session}
      toySyncEnabled={toySyncEnabled}
    />
  );
}

export function DailyReflectionShellContent({
  browserRecordingEnabled = false,
  createBrowserRecorder = defaultBrowserRecorderFactory,
  createBrowserRecordingIdempotencyKey = defaultBrowserRecordingIdempotencyKey,
  initialReflectionId = null,
  session,
  toySyncEnabled = false
}: DailyReflectionShellContentProps) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [sourceOrigin, setSourceOrigin] = useState<DailyReflectionUploadSource | null>(null);
  const [recordingDate, setRecordingDate] = useState(() => localDateValue());
  const [fileError, setFileError] = useState<string | null>(null);
  const [recorderSnapshot, setRecorderSnapshot] = useState(EMPTY_RECORDER_SNAPSHOT);
  const [recorderError, setRecorderError] = useState<string | null>(null);
  const [browserSubmitting, setBrowserSubmitting] = useState(false);
  const [showAllCandidates, setShowAllCandidates] = useState(false);
  const [focusRequest, setFocusRequest] = useState<TranscriptFocusRequest | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);
  const recorderRef = useRef<DailyReflectionBrowserRecorder | null>(null);
  const browserSubmitLatch = useRef(false);
  const browserReadyIdempotencyKey = useRef<string | null>(null);
  const lastUrlReflectionId = useRef<string | null>(initialReflectionId);
  const observedReflectionId = useRef(false);

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
    setShowAllCandidates(false);
    setDeleteConfirmation(false);
  }, [session.reflectionId]);

  useEffect(() => {
    if (!session.reflectionId) return;
    recorderRef.current?.cancel();
    browserReadyIdempotencyKey.current = null;
    browserSubmitLatch.current = false;
    setBrowserSubmitting(false);
  }, [session.reflectionId]);

  useEffect(() => {
    if (session.auth.status === "authenticated") return;
    recorderRef.current?.cancel();
    browserReadyIdempotencyKey.current = null;
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
      router.replace(`${REFLECTION_PATH}?reflectionId=${encodeURIComponent(reflectionId)}`);
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
      router.replace(REFLECTION_PATH);
    }
  }, [router, session.auth.status, session.operation, session.reflectionId, session.state]);

  const busy = session.operation !== "idle";
  const detail = session.detail;
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
  const quickReview = detail?.processingPlan?.processingProfile === "quick_reflection";
  const visibleCandidates = quickReview
    ? candidates.slice(0, 3)
    : showAllCandidates
      ? candidates
      : candidates.slice(0, 3);
  const remainingCandidateCount = Math.max(0, candidates.length - 3);
  const pendingCandidateCount = candidates.filter((candidate) => candidate.status === "pending").length;

  const selectFile = (nextFile: File | null) => {
    if (!nextFile) {
      setFile(null);
      setFileError(null);
      return;
    }
    if (nextFile.size <= 0) {
      setFile(null);
      setFileError("这段录音没有内容，请重新选择。最终仍以实际上传检查为准。");
      return;
    }
    if (nextFile.size > MAX_CLIENT_FILE_BYTES) {
      setFile(null);
      setFileError("文件超过 300MB，请选择较小的录音。最终仍以实际上传检查为准。");
      return;
    }
    if (!isSupportedAudioUpload(nextFile)) {
      setFile(null);
      setFileError("暂不支持这种录音格式。最终仍以实际上传检查为准。");
      return;
    }
    setFile(nextFile);
    setFileError(null);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file || !sourceOrigin || !recordingDate || busy) return;
    recorderRef.current?.cancel();
    browserReadyIdempotencyKey.current = null;
    setFileError(null);
    void session.upload(file, sourceOrigin, recordingDate);
  };

  const startBrowserRecording = async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    setRecorderError(null);
    setRecordingDate(localDateValue());
    browserSubmitLatch.current = false;
    browserReadyIdempotencyKey.current = null;
    try {
      await recorder.start();
      setRecorderSnapshot(recorder.getSnapshot());
    } catch (error) {
      const message = browserRecordingError(error);
      if (message) setRecorderError(message);
    }
  };

  const stopBrowserRecording = async () => {
    const recorder = recorderRef.current;
    if (!recorder || recorderSnapshot.state !== "recording") return;
    setRecorderError(null);
    try {
      const recording = await recorder.stop();
      browserReadyIdempotencyKey.current = createBrowserRecordingIdempotencyKey();
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
    browserReadyIdempotencyKey.current = null;
    setBrowserSubmitting(false);
    setRecorderError(null);
    setRecorderSnapshot(recorderRef.current?.getSnapshot() ?? EMPTY_RECORDER_SNAPSHOT);
  };

  const rerecordBrowserRecording = async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    browserSubmitLatch.current = false;
    browserReadyIdempotencyKey.current = null;
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
    if (!recording || busy || browserSubmitLatch.current) return;
    const idempotencyKey = browserReadyIdempotencyKey.current
      ?? createBrowserRecordingIdempotencyKey();
    browserReadyIdempotencyKey.current = idempotencyKey;
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
        idempotencyKey
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
    setFocusRequest((current) => ({
      segmentId,
      requestId: (current?.requestId ?? 0) + 1
    }));
  };

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
  const isIndeterminateUpload = session.operation === "uploading"
    || session.state === "uploading"
    || status === "uploading";
  const recordFileName = detail?.upload?.originalName
    ?? session.selectedFile?.name
    ?? file?.name
    ?? (status === "cancelled" ? "原录音已清理" : "正在读取");
  const recordDate = detail?.upload?.recordingDate
    ?? (session.selectedFile || file || browserSubmitting ? recordingDate : "正在读取");
  const recordSource = detail?.effectiveOrigin
    ?? detail?.reflection.sourceOrigin
    ?? (session.sourceOrigin ?? (file ? sourceOrigin : browserSubmitting ? "user_reflection" : null));

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <Link className={styles.wordmark} href="/date-companion/modules" aria-label="返回空间选择">
          <span className={styles.wordmarkMark}>DB</span>
          <b>日常复盘</b>
        </Link>
        <nav className={styles.productNav} aria-label="产品空间">
          <Link href="/date-companion/a">约会陪伴</Link>
          <Link aria-current="page" className={styles.activeProductNav} href={REFLECTION_PATH}>日常复盘</Link>
        </nav>
        <div className={styles.headerTools}>
          <span title={userLabel}>{userLabel}</span>
          <button
            className={styles.quietButton}
            onClick={async () => {
              recorderRef.current?.cancel();
              browserReadyIdempotencyKey.current = null;
              await session.logout();
              router.replace("/date-companion");
            }}
            type="button"
          >退出</button>
        </div>
      </header>

      <main className={styles.page}>
        <section className={styles.intro}>
          <div>
            <p className={styles.eyebrow}>{browserRecordingEnabled
              ? "快速复盘 · 已有录音 · 先看再确认"
              : "已有录音 · 先看再确认"}</p>
            <h1>把一天里值得回看的话，慢慢整理出来。</h1>
          </div>
          <p className={styles.introText}>{browserRecordingEnabled
            ? "你可以直接说一段快速复盘，也可以上传已有录音并说明来源。整理完成后，这里会呈现完整文字稿与待你确认的内容；本页不会替你做最后决定。"
            : "选择已有录音并说明来源。整理完成后，这里会呈现完整文字稿与待你确认的内容；本页不会替你做最后决定。"}</p>
        </section>

        {!showRecord ? (
          <div className={styles.workspace}>
            {toySyncEnabled ? (
              <DailyReflectionToySync
                accountId={session.auth.user.id}
                busy={busy}
                key={session.auth.user.id}
                onUpload={(toyFile, toyRecordingDate, idempotencyKey) => session.upload(
                  toyFile,
                  "user_reflection",
                  toyRecordingDate,
                  { idempotencyKey, inputAdapter: "toy_sync" }
                )}
              />
            ) : null}
            {browserRecordingEnabled ? (
              <section className={`${styles.uploadCard} ${styles.recordingCard}`} aria-labelledby="daily-reflection-recording-title">
                <div>
                  <p className={styles.eyebrow}>现在说一说</p>
                  <h2 id="daily-reflection-recording-title">开始快速复盘</h2>
                </div>
                <p className={styles.cardLead}>只录下这次复盘。停止后先留在本地，由你确认后再提交整理。</p>

                {recorderSnapshot.state === "starting" ? (
                  <div className={styles.recorderState} role="status">
                    <b>正在请求麦克风权限…</b>
                    <p>请在浏览器提示中选择是否允许。</p>
                    <button className={styles.secondaryButton} onClick={cancelBrowserRecording} type="button">取消录音</button>
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
                      <button className={styles.primaryButton} onClick={() => void stopBrowserRecording()} type="button">停止录音</button>
                      <button className={styles.secondaryButton} onClick={cancelBrowserRecording} type="button">取消录音</button>
                    </div>
                  </div>
                ) : recorderSnapshot.state === "stopping" ? (
                  <div className={styles.recorderState} role="status">
                    <b>正在整理这次复盘……</b>
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
                      >{browserSubmitting ? "正在整理这次复盘……" : "提交并开始整理"}</button>
                      <button className={styles.secondaryButton} disabled={browserSubmitting} onClick={() => void rerecordBrowserRecording()} type="button">重新录制</button>
                      <button className={styles.dangerButton} disabled={browserSubmitting} onClick={cancelBrowserRecording} type="button">删除本地录音</button>
                    </div>
                  </div>
                ) : (
                  <div className={styles.recorderState}>
                    <p>准备好后开始，说完由你自己停止；录到三分钟也不会被中断。</p>
                    <button className={styles.primaryButton} onClick={() => void startBrowserRecording()} type="button">开始快速复盘</button>
                  </div>
                )}

                {recorderError ? <p className={styles.inlineError} role="alert">{recorderError}</p> : null}
                <p className={styles.localOnlyNote}>提交前请不要刷新或离开，本地录音不会自动恢复。提交成功后可以稍后从“最近复盘”回来。</p>
              </section>
            ) : null}
            <form className={styles.uploadCard} aria-label="上传日常复盘录音" onSubmit={submit}>
              <div>
                <p className={styles.eyebrow}>第一步</p>
                <h2>上传已有录音</h2>
              </div>
              <p className={styles.cardLead}>来源需要由你明确选择；初始不会替你预选。</p>

              <fieldset className={styles.sourceFieldset}>
                <legend>这段录音来自哪里？</legend>
                {SOURCE_OPTIONS.map((option) => (
                  <label className={styles.sourceChoice} key={option.value}>
                    <input
                      checked={sourceOrigin === option.value}
                      name="sourceOrigin"
                      onChange={() => setSourceOrigin(option.value)}
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
                  onChange={(event) => setRecordingDate(event.target.value)}
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
                >开始上传</button>
              </div>
            </form>
          </div>
        ) : (
          <div className={styles.statusColumn}>
            <div className={styles.detailToolbar}>
              <button className={styles.secondaryButton} disabled={busy} onClick={session.startNew} type="button">
                返回日常复盘首页
              </button>
              <span>这条记录会一直保留在最近复盘中，直到你明确删除。</span>
            </div>
            <section className={styles.statusCard} aria-live="polite">
              <div className={styles.statusTop}>
                <div>
                  <p className={styles.eyebrow}>这次记录</p>
                  <h2>{browserSubmitting ? "正在整理这次复盘……" : processingCopy(detail, session.state)}</h2>
                </div>
                <span className={styles.statusBadge}>{status === "review_pending"
                  ? "待你确认"
                  : status === "confirmation_ready" || status === "admitting"
                    ? "正在整理"
                    : status === "completed"
                      ? "已确认"
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
                <div><span>文件</span><b title={recordFileName}>{recordFileName}</b></div>
                <div><span>来源</span><b>{sourceLabel(recordSource)}</b></div>
                <div><span>录音日期</span><b>{recordDate}</b></div>
              </div>
              <p className={styles.sourceAttribution}>{sourceStatement(recordSource, recordDate)}</p>

              {isIndeterminateUpload ? (
                <div className={styles.progressBlock} role="status">
                  <div className={styles.progressTop}><span>正在接收录音</span><span>请稍候</span></div>
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

              {status === "failed" || session.state === "failed" || session.state === "error" ? (
                <p className={styles.inlineError} role="alert">
                  {safeErrorMessage(detail?.reflection.errorCode ?? session.errorMessage)}
                </p>
              ) : null}
              {processing ? (
                <p className={styles.backgroundNote}>提交已经完成。你可以稍后从“最近复盘”回来查看；关闭本页不会替你自动确认内容。</p>
              ) : null}
              {session.errorMessage && session.state !== "error" && status !== "failed" ? (
                <p className={styles.inlineError} role="alert">{safeErrorMessage(session.errorMessage)}</p>
              ) : null}
              {status === "cancelled" || session.state === "cancelled" ? (
                <p className={styles.cancelledNote}>这次整理已经停止。你仍可以删除这条记录。</p>
              ) : null}

              <div className={styles.statusActions}>
                {status === "failed" || session.state === "failed" ? (
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
                  <button className={styles.dangerButton} disabled={busy} onClick={() => setDeleteConfirmation(true)} type="button">
                    删除本次复盘
                  </button>
                ) : null}
              </div>
              {deleteConfirmation && session.reflectionId ? (
                <div className={styles.deleteConfirmation} role="alertdialog" aria-labelledby="daily-reflection-delete-title">
                  <div>
                    <b id="daily-reflection-delete-title">确定删除这次复盘吗？</b>
                    <p>这会删除这条复盘、查看原话所需记录，以及由本次复盘保存的内容。删除失败时页面会保留，方便你重试。</p>
                  </div>
                  <div>
                    <button className={styles.secondaryButton} disabled={busy} onClick={() => setDeleteConfirmation(false)} type="button">先保留</button>
                    <button className={styles.dangerButton} disabled={busy} onClick={() => void session.delete()} type="button">
                      {session.operation === "deleting" ? "正在删除…" : "确认删除"}
                    </button>
                  </div>
                </div>
              ) : null}
            </section>

            {detail?.reflection.status === "review_pending" ? (
              <div className={styles.reviewGrid}>
                <section className={styles.candidateSection} aria-labelledby="daily-reflection-candidates-title">
                  <div className={styles.sectionHeading}>
                    <div>
                      <p>先查看，不会自动留下</p>
                      <h2 id="daily-reflection-candidates-title">
                        {quickReview
                          ? "我整理出了最多3件可能值得记住的事"
                          : "我先整理出了最值得记住的几件事"}
                      </h2>
                    </div>
                    <span>{candidates.length} 条</span>
                  </div>
                  {candidates.length > 0 ? (
                    <>
                      <ol className={styles.candidateList}>
                        {visibleCandidates.map((candidate) => (
                          <CandidateReviewCard
                            busy={busy}
                            candidate={candidate}
                            confirmedPeople={session.confirmedPeople}
                            key={candidate.id}
                            onDecision={(decision) => void session.updateCandidate(decision)}
                            onSource={requestTranscriptFocus}
                            peopleState={session.peopleState}
                          />
                        ))}
                      </ol>
                      {!quickReview && remainingCandidateCount > 0 ? (
                        <div className={styles.candidateRemainder}>
                          <p>{showAllCandidates
                            ? `已展开全部 ${candidates.length} 件`
                            : `还有${remainingCandidateCount}件可能值得记住`}</p>
                          <button
                            className={styles.secondaryButton}
                            onClick={() => setShowAllCandidates((current) => !current)}
                            type="button"
                          >{showAllCandidates ? "收起" : "查看全部"}</button>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <p className={styles.emptyCandidates}>这段录音暂时没有整理出待确认内容。</p>
                  )}
                  <div className={styles.finalizePanel}>
                    <div>
                      <b>{pendingCandidateCount > 0
                        ? `还有 ${pendingCandidateCount} 条待选择`
                        : "都选择好了"}</b>
                      <p>{pendingCandidateCount > 0
                        ? "每一条都需要由你决定记住或不记。"
                        : "确认后会以你刚刚保存的最新选择为准。"}</p>
                    </div>
                    <button
                      className={styles.primaryButton}
                      disabled={busy || pendingCandidateCount > 0}
                      onClick={() => void session.finalize()}
                      type="button"
                    >{session.operation === "finalizing" ? "正在确认…" : "确认并完成这次复盘"}</button>
                  </div>
                </section>

                <DailyReflectionTranscript
                  focusRequest={focusRequest}
                  segments={detail.segments}
                />
              </div>
            ) : null}

            {detail && (
              detail.reflection.status === "confirmation_ready"
              || detail.reflection.status === "admitting"
              || detail.reflection.status === "completed"
              || detail.reflection.status === "admission_failed"
            ) ? (
              <div className={styles.reviewGrid}>
                <section className={`${styles.candidateSection} ${styles.outcomeSection}`} aria-labelledby="daily-reflection-outcome-title">
                  <div className={styles.sectionHeading}>
                    <div>
                      <p>由你确认的结果</p>
                      <h2 id="daily-reflection-outcome-title">{detail.reflection.status === "completed"
                        ? "这次复盘已经整理好"
                        : detail.reflection.status === "admission_failed"
                          ? "有些内容还没有整理好"
                          : "正在整理你确认的内容"}</h2>
                    </div>
                  </div>
                  {detail.reflection.status === "completed" && detail.admissionOperation ? (
                    <p className={styles.outcomeCopy}>
                      {completedAdmissionCopy(
                        detail.admissionOperation,
                        detail.rememberedCount
                      )}
                    </p>
                  ) : detail.reflection.status === "admission_failed" ? (
                    <p className={styles.outcomeCopy}>这次整理没有完整完成，你可以稍后重新读取结果。</p>
                  ) : (
                    <p className={styles.outcomeCopy}>正在安全保存你刚刚确认的内容。</p>
                  )}
                  <ReflectionResultList
                    activeCandidateId={session.activeCandidateId}
                    busy={busy}
                    confirmedPeople={session.confirmedPeople}
                    detail={detail}
                    errorMessage={session.errorMessage}
                    onRevoke={(candidateId) => void session.revokeCandidate(candidateId)}
                    onSource={requestTranscriptFocus}
                    operation={session.operation}
                  />
                  {detail.reflection.status === "admission_failed" ? (
                    <button className={styles.secondaryButton} disabled={busy} onClick={() => void session.finalize()} type="button">重新安全保存</button>
                  ) : null}
                </section>
                <DailyReflectionTranscript focusRequest={focusRequest} segments={detail.segments} />
              </div>
            ) : null}
          </div>
        )}
        {!showRecord ? <DailyReflectionHistory session={session} /> : null}
      </main>
    </div>
  );
}

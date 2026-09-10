"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import {
  ProductDialog,
  ProductEvidence,
  ProductReviewCompletion,
  ProductState,
  ProductTabs
} from "@/components/product-system/product-primitives";
import {
  isDefinitiveWorkReviewApiError,
  WorkReviewApiError,
  type WorkCandidateReviewDraft,
  type WorkEvidenceView,
  type WorkMeetingCandidate,
  type WorkMeetingCandidateKind,
  type WorkMeetingDetail,
  type WorkMeetingFinding,
  type WorkReviewApi,
  type WorkMeetingDeletePolicy,
  type WorkTodo,
  type WorkTodoProjection
} from "@/lib/client/work-review-api";

import { WorkFindingTodoActions } from "./work-finding-todo-actions";
import {
  useWorkMeetingFollowUp,
  WorkMeetingFollowUpPanel,
  WorkMeetingResultStats
} from "./work-meeting-follow-up";
import { WorkProjectPicker } from "./work-project-picker";
import { WorkReviewContext, type WorkReviewFeatureFlags } from "./work-review-shell";
import { formatEvidenceTime, formatMeetingDuration, WorkMeetingStatus } from "./work-review-shared";
import { WorkTodoDetail } from "./work-todo-detail";
import { formatWorkTodoSourceDateTime } from "./work-todo-utils";
import { asWorkReviewV2Api, DISABLED_WORK_REVIEW_CAPABILITIES, workReviewOperationKey } from "./work-review-v2";
import styles from "./work-review.module.css";

const KIND_LABELS: Readonly<Record<WorkMeetingCandidateKind, string>> = {
  discussion_topic: "讨论内容",
  proposal: "建议",
  decision: "可能的决定",
  commitment: "可能的承诺",
  open_question: "可能仍未解决",
  plan_change: "可能的方案变化",
  action_item: "行动事项候选"
};

const DECISION_FINALITY_LABELS = {
  final: "最终决定",
  tentative: "暂定方向",
  unclear: "尚不明确"
} as const;

const ACTION_BASIS_LABELS = {
  explicit_commitment: "明确承诺",
  assignment_without_acceptance: "被分配但尚未明确接受",
  suggested_action: "建议采取的行动",
  unowned_follow_up: "尚无负责人的跟进项"
} as const;

const REVIEW_SECTIONS: readonly Readonly<{
  kinds: readonly WorkMeetingCandidateKind[];
  title: string;
}>[] = [
  { title: "最终决定 / 暂定方向", kinds: ["decision"] },
  { title: "行动事项", kinds: ["action_item"] },
  { title: "明确承诺", kinds: ["commitment"] },
  { title: "未解决问题", kinds: ["open_question"] },
  { title: "方案变化", kinds: ["plan_change"] },
  { title: "建议", kinds: ["proposal"] },
  { title: "讨论内容", kinds: ["discussion_topic"] }
] as const;

function operationKey(prefix: string) {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${id}`;
}

function isProcessing(detail: WorkMeetingDetail, analysisEnabled: boolean) {
  return ["created", "queued", "transcribing"].includes(detail.meeting.ingestionStatus)
    || ["queued", "extracting", "verifying"].includes(detail.meeting.analysisStatus)
    || analysisEnabled
      && detail.meeting.ingestionStatus === "transcript_ready"
      && detail.meeting.analysisStatus === "not_started";
}

function errorMessage(error: unknown) {
  return error instanceof WorkReviewApiError ? error.message : "暂时无法完成操作，请稍后重试。";
}

function isDefinitiveOperationError(error: unknown) {
  return isDefinitiveWorkReviewApiError(error);
}

type ReviewHandler = (
  candidate: WorkMeetingCandidate,
  input: WorkCandidateReviewDraft
) => Promise<void>;

type EditorState = Readonly<{
  candidate: WorkMeetingCandidate;
  kind: WorkMeetingCandidateKind;
}>;

function structuredDataForKind(
  candidate: WorkMeetingCandidate,
  kind: WorkMeetingCandidateKind,
  overrides: Readonly<Record<string, unknown>> = {}
) {
  const current = candidate.structuredData ?? {};
  const assignmentKind = kind === "commitment" || kind === "action_item";
  return {
    ...current,
    decisionFinality: kind === "decision"
      ? (current.decisionFinality ?? candidate.decisionFinality ?? null)
      : null,
    rawActorLabel: assignmentKind ? (current.rawActorLabel ?? null) : null,
    candidateOwner: assignmentKind ? (current.candidateOwner ?? candidate.candidateOwner ?? null) : null,
    dueAt: assignmentKind ? (current.dueAt ?? candidate.dueAt ?? null) : null,
    originalDueExpression: assignmentKind
      ? (current.originalDueExpression ?? candidate.originalDueExpression ?? null)
      : null,
    actionBasis: kind === "commitment"
      ? "explicit_commitment"
      : kind === "action_item"
        ? (current.actionBasis ?? candidate.actionBasis ?? null)
        : null,
    relatedCommitmentCandidateId: kind === "action_item"
      ? (current.relatedCommitmentCandidateId ?? null)
      : null,
    planStages: kind === "plan_change" && Array.isArray(current.planStages)
      ? current.planStages
      : [],
    ...overrides
  };
}

function candidateSnapshot(
  candidate: WorkMeetingCandidate,
  kind: WorkMeetingCandidateKind,
  overrides?: Readonly<Record<string, unknown>>
) {
  return {
    title: candidate.title,
    body: candidate.body,
    structuredData: structuredDataForKind(candidate, kind, overrides)
  };
}

function dueDateToIso(value: string) {
  return value ? `${value}T00:00:00.000Z` : null;
}

function EvidenceDialog({
  displaySpeakerLabel,
  evidence,
  meetingTitle,
  onClose,
  onLocate
}: Readonly<{
  displaySpeakerLabel?: string;
  evidence: WorkEvidenceView | null;
  meetingTitle: string;
  onClose: () => void;
  onLocate: (evidence: WorkEvidenceView) => void;
}>) {
  return (
    <ProductDialog onClose={onClose} open={Boolean(evidence)} title="来源核对">
      {evidence ? (
        <div className={styles.evidenceDialogContent}>
          <dl>
            <div><dt>会议</dt><dd>{meetingTitle}</dd></div>
            <div><dt>时间点</dt><dd>{formatEvidenceTime(evidence.startSeconds, evidence.endSeconds)}</dd></div>
            {displaySpeakerLabel ? <div><dt>本次会议显示名称</dt><dd>{displaySpeakerLabel}</dd></div> : null}
          </dl>
          {evidence.contextBefore ? <p className={styles.evidenceContext}>{evidence.contextBefore}</p> : null}
          <ProductEvidence label="会议原文" meta={evidence.timestampQuality ? `时间信息：${evidence.timestampQuality}` : undefined}>
            {evidence.text}
          </ProductEvidence>
          {evidence.contextAfter ? <p className={styles.evidenceContext}>{evidence.contextAfter}</p> : null}
          <p className={styles.evidenceAuthorityNote}>这里显示的是已发布的会议原文；编辑会议结果不会改写这段内容。</p>
          <button className={styles.secondaryButton} onClick={() => onLocate(evidence)} type="button">
            在完整原文中定位
          </button>
        </div>
      ) : null}
    </ProductDialog>
  );
}

function CandidateEditor({
  editor,
  error,
  onClose,
  onSubmit
}: Readonly<{
  editor: EditorState | null;
  error: string | null;
  onClose: () => void;
  onSubmit: ReviewHandler;
}>) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<WorkMeetingCandidateKind>("discussion_topic");
  const [owner, setOwner] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editor) return;
    setTitle(editor.candidate.title);
    setBody(editor.candidate.body);
    setKind(editor.kind);
    setOwner(editor.candidate.candidateOwner ?? "");
    setDueAt(editor.candidate.dueAt?.slice(0, 10) ?? "");
  }, [editor]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || saving) return;
    setSaving(true);
    try {
      const snapshot = {
        title: title.trim(),
        body: body.trim(),
        structuredData: structuredDataForKind(editor.candidate, kind, {
          candidateOwner: kind === "commitment" || kind === "action_item" ? owner.trim() || null : null,
          dueAt: kind === "commitment" || kind === "action_item" ? dueDateToIso(dueAt) : null
        })
      };
      const review: WorkCandidateReviewDraft = kind === editor.candidate.kind
        ? { action: "edit_and_accept", ...snapshot }
        : { action: "retype_and_accept", kind, ...snapshot };
      try {
        await onSubmit(editor.candidate, review);
        onClose();
      } catch {
        // The parent renders the actionable mutation error and keeps the editor open.
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <ProductDialog
      footer={(
        <>
          <button className={styles.secondaryButton} disabled={saving} onClick={onClose} type="button">取消</button>
          <button className={styles.primaryButton} disabled={saving} form="work-candidate-editor" type="submit">
            {saving ? "正在保存…" : "保存并确认"}
          </button>
        </>
      )}
      onClose={onClose}
      open={Boolean(editor)}
      title="编辑会议结果"
    >
      {editor ? (
        <form className={styles.editorForm} id="work-candidate-editor" onSubmit={submit}>
          <label><span>类型</span><select name="candidateKind" onChange={(event) => setKind(event.target.value as WorkMeetingCandidateKind)} value={kind}>
            {Object.entries(KIND_LABELS)
              .filter(([value]) => value !== "plan_change"
                || (editor.candidate.planChangeStages?.length ?? 0) >= 2)
              .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label><span>标题</span><input autoComplete="off" maxLength={200} name="candidateTitle" onChange={(event) => setTitle(event.target.value)} required value={title} /></label>
          <label><span>内容</span><textarea autoComplete="off" maxLength={4000} name="candidateBody" onChange={(event) => setBody(event.target.value)} required rows={6} value={body} /></label>
          {kind === "commitment" || kind === "action_item" ? (
            <div className={styles.editorColumns}>
              <label><span>候选负责人</span><input autoComplete="off" name="candidateOwner" onChange={(event) => setOwner(event.target.value)} value={owner} /></label>
              <label><span>候选截止日期</span><input autoComplete="off" name="candidateDueAt" onChange={(event) => setDueAt(event.target.value)} type="date" value={dueAt} /></label>
            </div>
          ) : null}
          <p>这些修改只影响确认后的会议结果，不会修改会议原文。</p>
          {error ? <p className={styles.formError} role="alert">{error}</p> : null}
        </form>
      ) : null}
    </ProductDialog>
  );
}

function quickActions(candidate: WorkMeetingCandidate): readonly Readonly<{
  label: string;
  input: WorkCandidateReviewDraft;
}>[] {
  switch (candidate.kind) {
    case "decision":
      return [
        {
          label: "确认是最终决定",
          input: {
            action: "edit_and_accept",
            ...candidateSnapshot(candidate, "decision", { decisionFinality: "final" })
          }
        },
        {
          label: "改为暂定方向",
          input: {
            action: "edit_and_accept",
            ...candidateSnapshot(candidate, "decision", { decisionFinality: "tentative" })
          }
        },
        {
          label: "改为建议",
          input: { action: "retype_and_accept", kind: "proposal", ...candidateSnapshot(candidate, "proposal") }
        }
      ];
    case "commitment":
      return [
        { label: "确认承诺", input: { action: "accept" } },
        {
          label: "只是任务分配",
          input: {
            action: "retype_and_accept",
            kind: "action_item",
            ...candidateSnapshot(candidate, "action_item", { actionBasis: "assignment_without_acceptance" })
          }
        },
        {
          label: "只是建议",
          input: { action: "retype_and_accept", kind: "proposal", ...candidateSnapshot(candidate, "proposal") }
        }
      ];
    case "open_question":
      return [
        { label: "确认仍未解决", input: { action: "accept" } },
        { label: "会议中已经解决", input: { action: "ignore" } }
      ];
    case "plan_change":
      return [{ label: "确认变化过程", input: { action: "accept" } }];
    case "action_item":
      return [
        { label: "确认行动事项", input: { action: "accept" } },
        {
          label: "改为只是建议",
          input: { action: "retype_and_accept", kind: "proposal", ...candidateSnapshot(candidate, "proposal") }
        },
        {
          label: "改为未解决问题",
          input: {
            action: "retype_and_accept",
            kind: "open_question",
            ...candidateSnapshot(candidate, "open_question")
          }
        }
      ];
    case "proposal":
      return [{ label: "确认是建议", input: { action: "accept" } }];
    case "discussion_topic":
      return [{ label: "确认讨论内容", input: { action: "accept" } }];
  }
}

function CandidateCard({
  busy,
  candidate,
  onEdit,
  onEvidence,
  onReview
}: Readonly<{
  busy: boolean;
  candidate: WorkMeetingCandidate;
  onEdit: (editor: EditorState) => void;
  onEvidence: (evidence: WorkEvidenceView) => void;
  onReview: ReviewHandler;
}>) {
  const titleId = `candidate-${candidate.id}-title`;
  const evidence = candidate.evidence[0];
  const relatedCommitmentCandidateId = typeof candidate.structuredData?.relatedCommitmentCandidateId === "string"
    ? candidate.structuredData.relatedCommitmentCandidateId
    : null;
  return (
    <article aria-busy={busy} aria-labelledby={titleId} className={styles.candidateCard}>
      <header>
        <span className={styles.kindLabel}>{KIND_LABELS[candidate.kind]}</span>
        <h3 id={titleId}>{candidate.title}</h3>
      </header>
      <p className={styles.candidatePolicy}>
        {candidate.publicationAction === "show_as_question"
          ? "证据支持不完整，请结合原文判断"
          : "已通过来源核对，仍需你明确确认"}
      </p>
      <p className={styles.candidateBody}>{candidate.body}</p>
      {candidate.candidateOwner || candidate.dueAt || candidate.originalDueExpression
        || candidate.actionBasis || candidate.decisionFinality || relatedCommitmentCandidateId ? (
        <dl className={styles.candidateMeta}>
          {candidate.candidateOwner ? <div><dt>候选负责人</dt><dd>{candidate.candidateOwner}</dd></div> : null}
          {candidate.dueAt ? <div><dt>候选截止日期</dt><dd>{candidate.dueAt.slice(0, 10)}</dd></div> : null}
          {candidate.originalDueExpression ? <div><dt>原始截止表述</dt><dd>{candidate.originalDueExpression}</dd></div> : null}
          {candidate.actionBasis ? <div><dt>行动依据</dt><dd>{ACTION_BASIS_LABELS[candidate.actionBasis]}</dd></div> : null}
          {candidate.decisionFinality ? <div><dt>决定状态</dt><dd>{DECISION_FINALITY_LABELS[candidate.decisionFinality]}</dd></div> : null}
          {relatedCommitmentCandidateId ? <div><dt>关联承诺候选</dt><dd>{relatedCommitmentCandidateId}</dd></div> : null}
        </dl>
      ) : null}
      {candidate.kind === "plan_change" && candidate.planChangeStages?.length ? (
        <ol aria-label="方案变化过程" className={styles.planChangeList}>
          {candidate.planChangeStages.map((stage, index) => (
            <li key={`${candidate.id}-stage-${index}`}>
              <div><b>{stage.text}</b>{stage.status ? <small>{stage.status}</small> : null}</div>
              <div className={styles.sourceButtonGroup}>
                {stage.evidence.map((item, evidenceIndex) => (
                  <button
                    disabled={busy}
                    key={item.segmentId}
                    onClick={() => onEvidence(item)}
                    type="button"
                  >{stage.evidence.length === 1 ? "查看这一步的来源" : `查看阶段来源 ${evidenceIndex + 1}/${stage.evidence.length}`}</button>
                ))}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      <ProductEvidence
        label="来源原文"
        meta={formatEvidenceTime(evidence.startSeconds, evidence.endSeconds)}
      >
        {evidence.text}
      </ProductEvidence>
      <div aria-label="候选来源" className={styles.sourceButtonGroup}>
        {candidate.evidence.map((item, index) => (
          <button
            className={styles.sourceButton}
            disabled={busy}
            key={item.segmentId}
            onClick={() => onEvidence(item)}
            type="button"
          >{candidate.evidence.length === 1 ? "查看原文和上下文" : `查看原文和上下文 ${index + 1}/${candidate.evidence.length}`}</button>
        ))}
      </div>
      <div aria-label="核对操作" className={styles.candidateActions}>
        {quickActions(candidate).map((action, index) => (
          <button
            className={index === 0 ? styles.primaryButton : styles.secondaryButton}
            disabled={busy}
            key={action.label}
            onClick={() => void onReview(candidate, action.input).catch(() => undefined)}
            type="button"
          >{action.label}</button>
        ))}
        <button className={styles.secondaryButton} disabled={busy} onClick={() => onEdit({ candidate, kind: candidate.kind })} type="button">
          编辑或改类型
        </button>
        <button className={styles.tertiaryButton} disabled={busy} onClick={() => void onReview(candidate, { action: "ignore" }).catch(() => undefined)} type="button">
          忽略
        </button>
      </div>
    </article>
  );
}

function FindingCard({
  api,
  defaultProjectIds,
  finding,
  linkedTodo,
  meetingId,
  onEvidence,
  onTodoCreated,
  onOpenTodo,
  projectionEnabled,
  projectsEnabled,
  todoEnabled
}: Readonly<{
  api?: WorkReviewApi;
  defaultProjectIds: readonly string[];
  finding: WorkMeetingFinding;
  linkedTodo: WorkTodoProjection | null;
  meetingId: string;
  onEvidence: (evidence: WorkEvidenceView) => void;
  onTodoCreated: (todo: WorkTodo) => void;
  onOpenTodo: (todoId: string) => void;
  projectionEnabled: boolean;
  projectsEnabled: boolean;
  todoEnabled: boolean;
}>) {
  return (
    <article className={styles.findingCard}>
      <header><span>已确认</span><h3>{finding.title}</h3></header>
      <p>{finding.body}</p>
      {finding.candidateOwner || finding.dueAt || finding.originalDueExpression
        || finding.actionBasis || finding.decisionFinality ? (
        <dl className={styles.candidateMeta}>
          {finding.candidateOwner ? <div><dt>负责人</dt><dd>{finding.candidateOwner}</dd></div> : null}
          {finding.dueAt ? <div><dt>截止日期</dt><dd>{finding.dueAt.slice(0, 10)}</dd></div> : null}
          {finding.originalDueExpression ? <div><dt>原始截止表述</dt><dd>{finding.originalDueExpression}</dd></div> : null}
          {finding.actionBasis ? <div><dt>行动依据</dt><dd>{ACTION_BASIS_LABELS[finding.actionBasis]}</dd></div> : null}
          {finding.decisionFinality ? <div><dt>决定状态</dt><dd>{DECISION_FINALITY_LABELS[finding.decisionFinality]}</dd></div> : null}
        </dl>
      ) : null}
      {finding.kind === "plan_change" && finding.planChangeStages?.length ? (
        <ol aria-label="已确认的方案变化过程" className={styles.planChangeList}>
          {finding.planChangeStages.map((stage, index) => (
            <li key={`${finding.id}-stage-${index}`}>
              <div><b>{stage.text}</b>{stage.status ? <small>{stage.status}</small> : null}</div>
              <div className={styles.sourceButtonGroup}>
                {stage.evidence.map((item, evidenceIndex) => (
                  <button
                    key={item.segmentId}
                    onClick={() => onEvidence(item)}
                    type="button"
                  >{stage.evidence.length === 1 ? "查看这一步的来源" : `查看阶段来源 ${evidenceIndex + 1}/${stage.evidence.length}`}</button>
                ))}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      <div aria-label="已确认结果来源" className={styles.sourceButtonGroup}>
        {finding.evidence.map((item, index) => (
          <button className={styles.sourceButton} key={item.segmentId} onClick={() => onEvidence(item)} type="button">
            查看来源 {index + 1}/{finding.evidence.length} · {formatEvidenceTime(item.startSeconds, item.endSeconds)}
          </button>
        ))}
      </div>
      {api && todoEnabled && (finding.kind === "action_item" || finding.kind === "commitment") ? (
        <WorkFindingTodoActions
          api={api}
          defaultProjectIds={defaultProjectIds}
          finding={finding}
          linkedTodo={linkedTodo}
          meetingId={meetingId}
          onCreated={onTodoCreated}
          onOpenTodo={onOpenTodo}
          projectionEnabled={projectionEnabled}
          projectsEnabled={projectsEnabled}
        />
      ) : null}
    </article>
  );
}

function ReviewPanel({
  api,
  busyCandidateId,
  detail,
  featureFlags,
  mutationError,
  onComplete,
  onRetry,
  onReview,
  onTodoCreated,
  onOpenTodo,
  onSelectTranscript,
  projectsEnabled
}: Readonly<{
  api?: WorkReviewApi;
  busyCandidateId: string | null;
  detail: WorkMeetingDetail;
  featureFlags: WorkReviewFeatureFlags;
  mutationError: string | null;
  onComplete: () => Promise<void>;
  onRetry: () => Promise<void>;
  onReview: ReviewHandler;
  onTodoCreated: (todo: WorkTodo) => void;
  onOpenTodo: (todoId: string) => void;
  onSelectTranscript: () => void;
  projectsEnabled: boolean;
}>) {
  const [evidence, setEvidence] = useState<WorkEvidenceView | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({ decision: true });
  const locateEvidence = (item: WorkEvidenceView) => {
    setEvidence(null);
    onSelectTranscript();
    globalThis.setTimeout(() => {
      const target = document.getElementById(`segment-${item.segmentId}`);
      target?.scrollIntoView?.({ block: "center" });
      target?.focus();
    }, 0);
  };
  const pending = detail.candidates.filter((candidate) => candidate.status === "pending_review");
  const analysis = detail.meeting.analysisStatus;
  const ingestion = detail.meeting.ingestionStatus;
  const reviewAvailable = analysis === "review_ready";
  const leaseExpiresAt = detail.meeting.processingLeaseExpiresAt;
  const retryAvailable = !leaseExpiresAt || Date.parse(leaseExpiresAt) <= Date.now();
  const leaseExpiryLabel = leaseExpiresAt
    ? new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }).format(new Date(leaseExpiresAt))
    : null;
  const processingRetryAction = (
    <button
      className={styles.secondaryButton}
      disabled={!retryAvailable}
      onClick={() => void onRetry()}
      type="button"
    >
      {retryAvailable
        ? "长时间无进展？重新处理"
        : `当前处理中 · ${leaseExpiryLabel} 后可重试`}
    </button>
  );
  let state: ReactNode = null;

  if (["created", "queued", "transcribing"].includes(ingestion)) {
    state = (
      <ProductState
        action={processingRetryAction}
        description="长录音会按现有能力切块处理；重复触发会由处理租约安全拦截。"
        title="正在转写会议录音"
        tone="loading"
      />
    );
  } else if (ingestion === "failed") {
    state = detail.meeting.errorCode === "work_review_audio_duration_exceeded" ? (
      <ProductState
        description="这段录音在调用转写前已被拒绝，没有执行部分转写。请返回会议列表并上传一段符合当前时长限制的录音。"
        title="录音时长超过当前上限"
        tone="error"
      />
    ) : (
      <ProductState action={<button className={styles.primaryButton} onClick={() => void onRetry()} type="button">重新转写</button>} description="会议原文尚未发布。你可以重试或删除这次会议。" title="会议录音没有转写完成" tone="error" />
    );
  } else if (analysis === "failed") {
    state = (
      <ProductState
        action={<div className={styles.stateActions}><button className={styles.secondaryButton} onClick={onSelectTranscript} type="button">查看原文</button><button className={styles.primaryButton} onClick={() => void onRetry()} type="button">重新整理</button></div>}
        description="会议原文已经安全保存，重新整理不会再次执行转写。"
        title="会议内容整理没有完成"
        tone="error"
      />
    );
  } else if (analysis === "review_ready" && detail.meeting.verifierMode === "disabled") {
    state = (
      <ProductState
        action={detail.transcriptSegments.length ? <button className={styles.secondaryButton} onClick={onSelectTranscript} type="button">查看完整原文</button> : undefined}
        description="独立核验当前未开放；只显示通过安全策略的低风险候选，决定、承诺和行动事项不会展示。"
        title="会议原文已就绪，核验能力受限"
        tone="status"
      />
    );
  } else if (analysis === "review_ready" && detail.candidates.length === 0 && detail.findings.length === 0) {
    state = (
      <ProductState
        action={detail.transcriptSegments.length ? <button className={styles.secondaryButton} onClick={onSelectTranscript} type="button">查看完整原文</button> : undefined}
        description="整理与核验已经完成，没有生成需要你确认的结果。你可以先核对完整原文，再决定是否完成本次整理。"
        title="本次没有需要确认的会议结果"
        tone="status"
      />
    );
  } else if (analysis !== "review_ready") {
    state = (
      <ProductState
        action={(
          <div className={styles.stateActions}>
            {detail.transcriptSegments.length ? <button className={styles.secondaryButton} onClick={onSelectTranscript} type="button">查看完整原文</button> : null}
            {featureFlags.analysisEnabled ? processingRetryAction : null}
          </div>
        )}
        description={featureFlags.analysisEnabled ? "会议原文已经准备好，正在提取并核对会议内容。" : "会议原文已经准备好；会议内容整理当前未开放。"}
        title={featureFlags.analysisEnabled ? "正在整理会议内容" : "会议原文已就绪"}
        tone={featureFlags.analysisEnabled ? "loading" : "status"}
      />
    );
  }

  return (
    <div className={styles.reviewPanel}>
      {state}
      {reviewAvailable ? (
        <>
          {REVIEW_SECTIONS.map((section) => {
            const candidates = pending.filter((candidate) => section.kinds.includes(candidate.kind));
            const findings = detail.findings.filter((finding) => section.kinds.includes(finding.kind));
            if (!candidates.length && !findings.length) return null;
            const sectionId = `work-section-${section.kinds[0]}`;
            const expanded = expandedSections[section.kinds[0]] ?? false;
            return (
              <section aria-labelledby={sectionId} className={styles.reviewSection} key={section.title}>
                <h2 id={sectionId}>
                  <button aria-controls={`${sectionId}-items`} aria-expanded={expanded} className={styles.sectionToggle} onClick={() => setExpandedSections((current) => ({ ...current, [section.kinds[0]]: !expanded }))} type="button">
                    <span>{section.title}</span><small>{candidates.length + findings.length} 条</small><span className={styles.sectionToggleState}>{expanded ? "收起" : "展开"}</span>
                  </button>
                </h2>
                <div className={styles.reviewItems} hidden={!expanded} id={`${sectionId}-items`}>
                  {candidates.map((candidate) => (
                    <CandidateCard
                      busy={busyCandidateId === candidate.id}
                      candidate={candidate}
                      key={candidate.id}
                      onEdit={setEditor}
                      onEvidence={setEvidence}
                      onReview={onReview}
                    />
                  ))}
                  {findings.map((finding) => (
                    <FindingCard
                      api={api}
                      defaultProjectIds={(detail.meeting.projects ?? []).map((project) => project.id)}
                      finding={finding}
                      key={finding.id}
                      linkedTodo={detail.todoProjections.find((todo) => todo.sourceFindingId === finding.id) ?? null}
                      meetingId={detail.meeting.id}
                      onEvidence={setEvidence}
                      onOpenTodo={onOpenTodo}
                      onTodoCreated={onTodoCreated}
                      projectionEnabled={featureFlags.todoMeetingProjectionEnabled}
                      projectsEnabled={projectsEnabled}
                      todoEnabled={featureFlags.todoEnabled}
                    />
                  ))}
                </div>
              </section>
            );
          })}
          {detail.meeting.reviewStatus === "completed" ? (
            <ProductState description="已完成逐项核对。系统不会自动创建待办、Memory 或跨会议资产。" title="本次会议已经整理完成" />
          ) : (
            <ProductReviewCompletion
              action={<button className={styles.primaryButton} disabled={pending.length > 0} onClick={() => void onComplete()} type="button">完成本次会议整理</button>}
              description={pending.length > 0 ? `还有 ${pending.length} 条候选需要确认或忽略。` : "完成只代表你已处理当前候选；不会创建 Todo。"}
              title="完成本次会议整理"
            />
          )}
        </>
      ) : null}
      <EvidenceDialog
        displaySpeakerLabel={detail.speakerAliases.find((alias) => alias.rawLabel === evidence?.rawSpeakerLabel)?.displayLabel}
        evidence={evidence}
        meetingTitle={detail.meeting.title}
        onClose={() => setEvidence(null)}
        onLocate={locateEvidence}
      />
      <CandidateEditor
        editor={editor}
        error={mutationError}
        onClose={() => setEditor(null)}
        onSubmit={onReview}
      />
    </div>
  );
}

function TranscriptPanel({
  detail,
  onUpdateSpeakerAlias
}: Readonly<{
  detail: WorkMeetingDetail;
  onUpdateSpeakerAlias: (rawLabel: string, displayName: string, expectedVersion: number) => Promise<void>;
}>) {
  const speakers = useMemo(() => Array.from(new Set(
    detail.transcriptSegments.flatMap((segment) => segment.speaker ? [segment.speaker] : [])
  )), [detail.transcriptSegments]);
  const aliasesBySpeaker = useMemo(() => Object.fromEntries(
    detail.speakerAliases.map((alias) => [alias.rawLabel, alias.displayLabel])
  ), [detail.speakerAliases]);
  const aliasVersions = useMemo(() => Object.fromEntries(
    detail.speakerAliases.map((alias) => [alias.rawLabel, alias.version])
  ), [detail.speakerAliases]);
  const [drafts, setDrafts] = useState<Record<string, string>>(aliasesBySpeaker);
  const [savingSpeaker, setSavingSpeaker] = useState<string | null>(null);
  const [showSpeakerSettings, setShowSpeakerSettings] = useState(false);

  useEffect(() => setDrafts(aliasesBySpeaker), [aliasesBySpeaker]);

  if (!detail.transcriptSegments.length) {
    return <ProductState description="转写完成后，完整原文会显示在这里。" title="会议原文还没有准备好" tone="loading" />;
  }
  return (
    <div className={styles.transcriptPanel}>
      {speakers.length ? (
        <section aria-labelledby="work-speaker-alias-title" className={styles.speakerAliases}>
          <div><h2 id="work-speaker-alias-title"><button aria-controls="work-speaker-settings" aria-expanded={showSpeakerSettings} className={styles.sectionToggle} onClick={() => setShowSpeakerSettings((value) => !value)} type="button"><span>发言人显示名称</span><span className={styles.sectionToggleState}>{showSpeakerSettings ? "收起" : "设置"}</span></button></h2></div>
          <div className={styles.speakerAliasGrid} hidden={!showSpeakerSettings} id="work-speaker-settings">
            <p>名称只在本次会议中显示，不会修改原始标签或共享人物资料。</p>
            {speakers.map((speaker) => (
              <form
                key={speaker}
                onSubmit={(event) => {
                  event.preventDefault();
                  setSavingSpeaker(speaker);
                  void onUpdateSpeakerAlias(
                    speaker,
                    drafts[speaker] ?? "",
                    aliasVersions[speaker] ?? 0
                  ).finally(() => setSavingSpeaker(null));
                }}
              >
                <label><span>{speaker}</span><input aria-label={`${speaker} 的显示名称`} autoComplete="off" name={`speakerAlias-${speaker}`} onChange={(event) => setDrafts((current) => ({ ...current, [speaker]: event.target.value }))} placeholder="例如：Alex、我" value={drafts[speaker] ?? ""} /></label>
                <button className={styles.secondaryButton} disabled={savingSpeaker === speaker} type="submit">保存名称</button>
              </form>
            ))}
          </div>
        </section>
      ) : null}
      <section aria-label="完整会议原文" className={styles.transcriptRegion}>
        <ol>
          {detail.transcriptSegments.map((segment) => {
            const alias = segment.speaker ? aliasesBySpeaker[segment.speaker] : undefined;
            return (
              <li data-segment-id={segment.id} id={`segment-${segment.id}`} key={segment.id} tabIndex={-1}>
                <div>
                  <time>{formatEvidenceTime(segment.startSeconds, segment.endSeconds)}</time>
                  {alias ? <span>{alias}</span> : null}
                </div>
                <p>{segment.text}</p>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

function MeetingTodosPanel({
  onOpenTodo,
  todos
}: Readonly<{
  onOpenTodo: (todoId: string) => void;
  todos: readonly WorkTodoProjection[];
}>) {
  if (!todos.length) {
    return (
      <ProductState
        description="从已确认的行动事项或明确承诺创建待办后，会显示在这里。"
        title="这次会议还没有关联待办"
        tone="empty"
      />
    );
  }
  return (
    <div className={styles.meetingTodosPanel}>
      <header>
        <h2>本次会议的待办</h2>
        <p>会议中的期限与待办当前计划分开显示；完成待办不会改写会议承诺。</p>
      </header>
      <ul>
        {todos.map((todo) => {
          const sourceDue = todo.sourceOriginalDueExpression
            ?? (todo.sourceOriginalDueAt ? formatWorkTodoSourceDateTime(todo.sourceOriginalDueAt) : null)
            ?? "会议中未明确";
          return (
            <li key={todo.id}>
              <button className={styles.meetingTodoHeading} onClick={() => onOpenTodo(todo.id)} type="button">
                <b>{todo.title}</b>
                <small>{todo.kind === "waiting_for_other" ? "等待他人" : "我的待办"}</small>
              </button>
              <dl>
                <div><dt>会议原始期限</dt><dd>{sourceDue}</dd></div>
                <div><dt>当前计划时间</dt><dd>{todo.currentDueDate ?? "尚未安排"}</dd></div>
              </dl>
              <span className={styles.meetingTodoStatus} data-complete={todo.status === "completed" ? "true" : "false"}>
                当前待办状态：{todo.status === "completed" ? "已完成" : "待处理"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function WorkMeetingProjectEditor({
  api,
  meeting,
  onChanged
}: Readonly<{
  api: WorkReviewApi;
  meeting: WorkMeetingDetail["meeting"];
  onChanged: () => void;
}>) {
  const v2Api = asWorkReviewV2Api(api);
  const linkedIds = useMemo(() => (meeting.projects ?? []).map((project) => project.id), [meeting.projects]);
  const [selectedIds, setSelectedIds] = useState<string[]>(linkedIds);
  const [resourceVersion, setResourceVersion] = useState(meeting.version);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operationKeyRef = useRef(workReviewOperationKey("meeting-projects"));

  useEffect(() => {
    setSelectedIds(linkedIds);
    setResourceVersion(meeting.version);
    operationKeyRef.current = workReviewOperationKey("meeting-projects");
  }, [linkedIds, meeting.version]);

  if (!v2Api) {
    return <p className={styles.inlineNotice} role="status">项目能力暂时无法在这次会议中使用。</p>;
  }

  const unchanged = selectedIds.length === linkedIds.length
    && selectedIds.every((id) => linkedIds.includes(id));
  return (
    <section aria-labelledby="meeting-projects-title" className={styles.meetingProjects}>
      <div className={styles.meetingProjectsHeading}>
        <div>
          <h2 id="meeting-projects-title">所属项目</h2>
          <p>项目只用于整理这次会议；不会改变原文或会议结果。</p>
        </div>
        <Link className={styles.secondaryButton} href="/work-review/projects">管理项目</Link>
      </div>
      <WorkProjectPicker
        api={api}
        disabled={busy}
        label="选择项目"
        onChange={(ids) => {
          setSelectedIds([...ids]);
          operationKeyRef.current = workReviewOperationKey("meeting-projects");
          setNotice(null);
          setError(null);
        }}
        selectedIds={selectedIds}
      />
      <div className={styles.meetingProjectsActions}>
        <button
          className={styles.primaryButton}
          disabled={busy || unchanged}
          onClick={() => {
            if (busy) return;
            setBusy(true);
            setNotice(null);
            setError(null);
            void v2Api.setMeetingProjects(meeting.id, {
              expectedVersion: resourceVersion,
              operationKey: operationKeyRef.current,
              projectIds: selectedIds
            }).then((result) => {
              operationKeyRef.current = workReviewOperationKey("meeting-projects");
              setResourceVersion(result.resourceVersion);
              setSelectedIds(result.projects.map((project) => project.id));
              setNotice("会议所属项目已保存。");
              onChanged();
            }).catch((saveError: unknown) => {
              if (isDefinitiveWorkReviewApiError(saveError)) {
                operationKeyRef.current = workReviewOperationKey("meeting-projects");
              }
              setError(errorMessage(saveError));
            }).finally(() => setBusy(false));
          }}
          type="button"
        >{busy ? "正在保存…" : "保存项目"}</button>
        {notice ? <p aria-live="polite" className={styles.projectSaveNotice}>{notice}</p> : null}
      </div>
      {error ? <p className={styles.formError} role="alert">{error}</p> : null}
    </section>
  );
}

export function WorkMeetingDetailView({
  api,
  busyCandidateId,
  detail,
  featureFlags,
  mutationError,
  onComplete,
  onDelete,
  onRetry,
  onReview,
  onProjectsChanged,
  onTodoCreated,
  onTodosChanged,
  onUpdateSpeakerAlias,
  projectsEnabled = false
}: Readonly<{
  api?: WorkReviewApi;
  busyCandidateId: string | null;
  detail: WorkMeetingDetail;
  featureFlags: WorkReviewFeatureFlags;
  mutationError: string | null;
  onComplete: () => Promise<void>;
  onDelete: (policy?: WorkMeetingDeletePolicy) => Promise<void>;
  onRetry: () => Promise<void>;
  onReview: ReviewHandler;
  onProjectsChanged?: () => void;
  onTodoCreated: (todo: WorkTodo) => void;
  onTodosChanged: () => void;
  onUpdateSpeakerAlias: (rawLabel: string, displayName: string, expectedVersion: number) => Promise<void>;
  projectsEnabled?: boolean;
}>) {
  const [tab, setTab] = useState("results");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePolicy, setDeletePolicy] = useState<WorkMeetingDeletePolicy | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null);
  const duration = formatMeetingDuration(detail.meeting.durationSeconds);
  const reviewCompleted = detail.meeting.reviewStatus === "completed";
  const followUpSourceRevision = [
    `${detail.meeting.version}:${detail.meeting.reviewStatus}`,
    detail.findings.map((finding) => `${finding.id}:${finding.version}`).join(","),
    detail.todoProjections.map((todo) => (
      `${todo.id}:${todo.version}:${todo.status}:${todo.currentDueDate ?? ""}`
    )).join(",")
  ].join("|");
  const followUp = useWorkMeetingFollowUp({
    active: featureFlags.followUpEnabled && (tab === "follow-up" || reviewCompleted),
    api,
    enabled: featureFlags.followUpEnabled,
    meetingId: detail.meeting.id,
    sourceRevision: followUpSourceRevision
  });
  return (
    <main className={styles.page}>
      <Link className={styles.backLink} href="/work-review/meetings">← 返回会议</Link>
      <header className={styles.meetingHeader}>
        <div><h1>{detail.meeting.title}</h1><p><time dateTime={detail.meeting.meetingDate}>{detail.meeting.meetingDate}</time>{duration ? <span>{duration}</span> : null}</p></div>
        <WorkMeetingStatus meeting={detail.meeting} />
      </header>
      {projectsEnabled && api ? (
        <WorkMeetingProjectEditor api={api} meeting={detail.meeting} onChanged={onProjectsChanged ?? (() => undefined)} />
      ) : null}
      {mutationError && !deleteOpen ? <p className={styles.formError} role="alert">{mutationError}</p> : null}
      {reviewCompleted && followUp.sourceStats ? <WorkMeetingResultStats stats={followUp.sourceStats} /> : null}
      <ProductTabs
        ariaLabel="会议详情"
        items={[
          {
            id: "results",
            label: "会议结果",
            panel: (
              <ReviewPanel
                api={api}
                busyCandidateId={busyCandidateId}
                detail={detail}
                featureFlags={featureFlags}
                mutationError={mutationError}
                onComplete={onComplete}
                onRetry={onRetry}
                onReview={onReview}
                onSelectTranscript={() => setTab("transcript")}
                onOpenTodo={setSelectedTodoId}
                onTodoCreated={onTodoCreated}
                projectsEnabled={projectsEnabled}
              />
            )
          },
          ...(featureFlags.todoEnabled ? [{
            id: "todos",
            label: "待办",
            panel: <MeetingTodosPanel onOpenTodo={setSelectedTodoId} todos={detail.todoProjections} />
          }] : []),
          {
            id: "transcript",
            label: "完整原文",
            panel: <TranscriptPanel detail={detail} onUpdateSpeakerAlias={onUpdateSpeakerAlias} />
          },
          ...(featureFlags.followUpEnabled ? [{
            id: "follow-up",
            label: "会后纪要",
            panel: <WorkMeetingFollowUpPanel eligible={reviewCompleted} followUp={followUp} />
          }] : [])
        ]}
        onChange={setTab}
        value={tab}
      />
      <footer className={styles.meetingFooter}>
        <p>删除会议会移除原文、候选和已确认结果，并阻止晚到处理重新发布内容。</p>
        <button className={styles.dangerButton} onClick={() => { setDeletePolicy(null); setDeleteOpen(true); }} type="button">删除这次会议</button>
      </footer>
      <ProductDialog
        footer={(
          <>
            <button className={styles.secondaryButton} disabled={deleting} onClick={() => setDeleteOpen(false)} type="button">取消</button>
            <button
              className={styles.dangerButton}
              disabled={deleting || detail.linkedTodoCount > 0 && !deletePolicy}
              onClick={() => {
                setDeleting(true);
                void onDelete(deletePolicy ?? undefined).catch(() => undefined).finally(() => setDeleting(false));
              }}
              type="button"
            >{deleting ? "正在删除…" : "确认删除"}</button>
          </>
        )}
        onClose={() => setDeleteOpen(false)}
        open={deleteOpen}
        title="确定删除这次会议吗？"
      >
        {mutationError ? <p className={styles.formError} role="alert">{mutationError}</p> : null}
        {detail.linkedTodoCount > 0 ? (
          <fieldset className={styles.deletePolicyOptions}>
            <legend>这次会议有 {detail.linkedTodoCount} 条关联待办，请选择处理方式</legend>
            <label>
              <input checked={deletePolicy === "delete_linked_todos"} name="meetingDeletePolicy" onChange={() => setDeletePolicy("delete_linked_todos")} type="radio" />
              <span><b>删除会议和关联待办</b><small>同时移除这些来源待办，适合作为隐私安全的默认选择。</small></span>
            </label>
            <label>
              <input checked={deletePolicy === "detach_linked_todos"} name="meetingDeletePolicy" onChange={() => setDeletePolicy("detach_linked_todos")} type="radio" />
              <span><b>保留待办，但移除会议来源</b><small>待办内容保留；会议原文、发言人和来源日期都会解除关联。</small></span>
            </label>
          </fieldset>
        ) : (
          <p className={styles.deleteCopy}>删除后无法在工作复盘中找回这次会议的原文与结果；不会影响其他会议或产品。</p>
        )}
      </ProductDialog>
      {api ? (
        <WorkTodoDetail
          api={api}
          onChanged={onTodosChanged}
          onClose={() => setSelectedTodoId(null)}
          open={Boolean(selectedTodoId)}
          todoId={selectedTodoId}
        />
      ) : null}
    </main>
  );
}

export function WorkMeetingDetail({
  api: apiOverride,
  featureFlags: flagsOverride,
  meetingId
}: Readonly<{
  api?: WorkReviewApi;
  featureFlags?: WorkReviewFeatureFlags;
  meetingId: string;
}>) {
  const context = useContext(WorkReviewContext);
  const api = apiOverride ?? context?.api;
  const featureFlags = flagsOverride ?? context?.featureFlags;
  if (!api || !featureFlags) throw new Error("WorkMeetingDetail requires an API and feature flags");
  const capabilities = context?.capabilities ?? DISABLED_WORK_REVIEW_CAPABILITIES;
  const projectsEnabled = capabilities.projects && Boolean(asWorkReviewV2Api(api));
  const router = useRouter();
  const [detail, setDetail] = useState<WorkMeetingDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busyCandidateId, setBusyCandidateId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const operationKeysRef = useRef(new Map<string, string>());

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let continuePolling = true;
    const load = async () => {
      try {
        const next = await api.getMeeting(meetingId, controller.signal);
        if (controller.signal.aborted) return;
        setDetail(next);
        setLoadError(null);
        continuePolling = isProcessing(next, featureFlags.analysisEnabled);
        if (continuePolling) timer = setTimeout(() => void load(), 2_000);
      } catch (error) {
        if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
        setLoadError(errorMessage(error));
        if (isDefinitiveOperationError(error)) continuePolling = false;
        if (continuePolling) timer = setTimeout(() => void load(), 4_000);
      }
    };
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [api, featureFlags.analysisEnabled, loadAttempt, meetingId]);

  const refresh = () => setLoadAttempt((value) => value + 1);
  const keyForOperation = (logicalKey: string, prefix: string) => {
    const existing = operationKeysRef.current.get(logicalKey);
    if (existing) return existing;
    const created = operationKey(prefix);
    operationKeysRef.current.set(logicalKey, created);
    return created;
  };
  const settleOperation = (logicalKey: string, error?: unknown) => {
    if (error === undefined || isDefinitiveOperationError(error)) {
      operationKeysRef.current.delete(logicalKey);
    }
  };
  const review: ReviewHandler = async (candidate, input) => {
    if (busyCandidateId) return;
    setBusyCandidateId(candidate.id);
    setMutationError(null);
    const logicalKey = `review:${candidate.id}:${candidate.version}:${JSON.stringify(input)}`;
    try {
      await api.reviewCandidate(meetingId, candidate.id, {
        ...input,
        expectedVersion: candidate.version,
        operationKey: keyForOperation(logicalKey, `review-${candidate.id}`)
      });
      settleOperation(logicalKey);
      refresh();
    } catch (error) {
      settleOperation(logicalKey, error);
      setMutationError(errorMessage(error));
      throw error;
    } finally {
      setBusyCandidateId(null);
    }
  };

  if (!detail) {
    return (
      <main className={styles.centeredState}>
        <ProductState
          action={loadError ? <button className={styles.secondaryButton} onClick={refresh} type="button">重新加载</button> : undefined}
          description={loadError ?? undefined}
          title={loadError ? "暂时无法读取这次会议" : "正在读取会议…"}
          tone={loadError ? "error" : "loading"}
        />
      </main>
    );
  }

  return (
    <WorkMeetingDetailView
      api={api}
      busyCandidateId={busyCandidateId}
      detail={detail}
      featureFlags={featureFlags}
      mutationError={mutationError ?? loadError}
      onComplete={async () => {
        setMutationError(null);
        const logicalKey = `complete:${meetingId}:${detail.meeting.version}`;
        try {
          await api.completeMeeting(
            meetingId,
            detail.meeting.version,
            keyForOperation(logicalKey, "complete")
          );
          settleOperation(logicalKey);
          refresh();
        } catch (error) {
          settleOperation(logicalKey, error);
          setMutationError(errorMessage(error));
        }
      }}
      onDelete={async (policy) => {
        setMutationError(null);
        try {
          await api.deleteMeeting(meetingId, policy);
          router.replace("/work-review/meetings");
        } catch (error) {
          setMutationError(errorMessage(error));
          if (error instanceof WorkReviewApiError && error.code === "linked_todos_require_policy") {
            const count = error.details?.linkedTodoCount;
            if (typeof count === "number" && Number.isInteger(count) && count >= 0) {
              setDetail((current) => current ? { ...current, linkedTodoCount: count } : current);
            }
          }
          throw error;
        }
      }}
      onRetry={async () => {
        setMutationError(null);
        const logicalKey = `retry:${meetingId}:${detail.meeting.ingestionStatus}:${detail.meeting.analysisStatus}`;
        try {
          await api.retryMeeting(meetingId, keyForOperation(logicalKey, "retry"));
          settleOperation(logicalKey);
          refresh();
        } catch (error) {
          settleOperation(logicalKey, error);
          setMutationError(errorMessage(error));
        }
      }}
      onReview={review}
      onProjectsChanged={refresh}
      onTodoCreated={() => refresh()}
      onTodosChanged={refresh}
      onUpdateSpeakerAlias={async (rawLabel, displayName, expectedVersion) => {
        setMutationError(null);
        const logicalKey = `speaker:${meetingId}:${rawLabel}:${expectedVersion}:${displayName.trim()}`;
        try {
          await api.updateSpeakerAlias(
            meetingId,
            rawLabel,
            displayName,
            expectedVersion,
            keyForOperation(logicalKey, "speaker")
          );
          settleOperation(logicalKey);
          refresh();
        } catch (error) {
          settleOperation(logicalKey, error);
          setMutationError(errorMessage(error));
        }
      }}
      projectsEnabled={projectsEnabled}
    />
  );
}

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  ProductDialog,
  ProductEvidence,
  ProductState
} from "@/components/product-system/product-primitives";
import {
  WorkReviewApiError,
  type WorkReviewV2CoreApi,
  type WorkWeeklyLiveSourceResponse
} from "@/lib/client/work-review-api";
import type { WorkWeeklySourceSnapshot } from "@/lib/domain/work-weekly";

import { formatEvidenceTime } from "./work-review-shared";
import styles from "./work-weekly.module.css";

type MeetingSource = WorkWeeklySourceSnapshot["meetings"][number];
type FindingSource = WorkWeeklySourceSnapshot["findings"][number];
type TodoSource = WorkWeeklySourceSnapshot["todos"][number];
type TodoEventSource = WorkWeeklySourceSnapshot["todoEvents"][number];
type EvidenceSource = WorkWeeklySourceSnapshot["evidence"][number];
type ProjectSource = WorkWeeklySourceSnapshot["projects"][number];

const SOURCE_TITLES = {
  meeting: "会议来源",
  finding: "已确认的会议结果",
  todo: "待办来源",
  todo_event: "待办变化记录",
  project: "项目来源",
  evidence: "原话证据"
} as const;

function sourceError(error: unknown) {
  if (error instanceof WorkReviewApiError && error.code === "weekly_source_not_found") {
    return "这条来源已经删除、失效，或不再属于当前周回顾范围。";
  }
  return error instanceof WorkReviewApiError
    ? error.message
    : "暂时无法读取这条来源，请稍后重试。";
}

function DefinitionList({ rows }: Readonly<{
  rows: ReadonlyArray<readonly [string, string | null | undefined]>;
}>) {
  return (
    <dl className={styles.sourceFacts}>
      {rows.filter((row) => row[1]).map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SourceBody({
  response,
  onOpenSource
}: Readonly<{
  response: WorkWeeklyLiveSourceResponse;
  onOpenSource: (sourceRef: string) => void;
}>) {
  const { identity } = response;
  if (identity.sourceKind === "meeting") {
    const source = response.source as MeetingSource;
    return (
      <div className={styles.sourceBody}>
        <DefinitionList rows={[
          ["会议", source.title],
          ["日期", source.meetingDate],
          ["确认状态", source.reviewStatus === "completed" ? "已完成确认" : source.reviewStatus === "in_progress" ? "确认中" : "尚未开始确认"],
          ["待确认结果", `${source.pendingCandidateCount} 项`]
        ]} />
        <Link className={styles.textLink} href={`/work-review/meetings/${encodeURIComponent(source.id)}`}>打开会议</Link>
      </div>
    );
  }
  if (identity.sourceKind === "finding") {
    const source = response.source as FindingSource;
    return (
      <div className={styles.sourceBody}>
        <DefinitionList rows={[
          ["标题", source.title],
          ["类型", source.kind],
          ["确认时间", new Date(source.userConfirmedAt).toLocaleString("zh-CN")]
        ]} />
        <p className={styles.sourceText}>{source.body}</p>
        <div className={styles.sourceLinks}>
          <Link className={styles.textLink} href={`/work-review/meetings/${encodeURIComponent(source.meetingId)}`}>打开会议</Link>
          {source.evidenceRefs.map((sourceRef, index) => (
            <button className={styles.textButton} key={sourceRef} onClick={() => onOpenSource(sourceRef)} type="button">
              查看原话 {index + 1}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (identity.sourceKind === "todo") {
    const source = response.source as TodoSource;
    const state = source.stateAtWeekEnd ?? source.current;
    return (
      <div className={styles.sourceBody}>
        <DefinitionList rows={[
          ["待办", state.title],
          ["类型", state.kind === "self" ? "我的待办" : "等待他人"],
          ["周末状态", state.status === "completed" ? "在系统中标记完成" : "待处理"],
          ["当前计划日期", state.currentDueDate],
          ["历史完整度", source.historyCompleteness === "exact" ? "完整" : "旧记录有限"]
        ]} />
        <p className={styles.sourceBoundary}>待办状态只表示系统记录，不证明会议承诺已经在现实中履行。</p>
        <div className={styles.sourceLinks}>
          <Link className={styles.textLink} href="/work-review/todos">打开待办</Link>
          {source.sourceMeetingId ? <Link className={styles.textLink} href={`/work-review/meetings/${encodeURIComponent(source.sourceMeetingId)}`}>打开来源会议</Link> : null}
        </div>
      </div>
    );
  }
  if (identity.sourceKind === "todo_event") {
    const source = response.source as TodoEventSource;
    return (
      <div className={styles.sourceBody}>
        <DefinitionList rows={[
          ["变化", source.eventType],
          ["本地日期", source.localDate],
          ["发生时间", new Date(source.occurredAt).toLocaleString("zh-CN")],
          ["变化字段", source.changedFields.join("、") || "状态记录"],
          ["历史完整度", source.historyCompleteness === "exact" ? "完整" : "旧记录有限"]
        ]} />
        <Link className={styles.textLink} href="/work-review/todos">打开待办</Link>
      </div>
    );
  }
  if (identity.sourceKind === "evidence") {
    const source = response.source as EvidenceSource;
    return (
      <div className={styles.sourceBody}>
        <ProductEvidence
          label="Canonical Evidence"
          meta={formatEvidenceTime(source.startSeconds, source.endSeconds)}
        >
          {source.text}
        </ProductEvidence>
        <p className={styles.sourceBoundary}>引用来自当前 Work Review 的 Canonical Evidence；周回顾文本本身不是原话证据。</p>
        <Link className={styles.textLink} href={`/work-review/meetings/${encodeURIComponent(source.meetingId)}`}>打开会议</Link>
      </div>
    );
  }
  const source = response.source as ProjectSource;
  return (
    <div className={styles.sourceBody}>
      <DefinitionList rows={[
        ["项目", source.name],
        ["状态", source.status === "active" ? "使用中" : "已归档"]
      ]} />
      <Link className={styles.textLink} href="/work-review/projects">管理项目</Link>
    </div>
  );
}

export function WorkWeeklySourceDialog({
  api,
  onClose,
  onOpenSource,
  reviewId,
  sourceRef
}: Readonly<{
  api: WorkReviewV2CoreApi;
  onClose: () => void;
  onOpenSource: (sourceRef: string) => void;
  reviewId: string;
  sourceRef: string | null;
}>) {
  const [state, setState] = useState<
    | { status: "idle" | "loading" }
    | { status: "ready"; response: WorkWeeklyLiveSourceResponse }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!sourceRef) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    void api.getWeeklySource(reviewId, sourceRef, controller.signal).then((response) => {
      if (!controller.signal.aborted) setState({ status: "ready", response });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
      setState({ status: "error", message: sourceError(error) });
    });
    return () => controller.abort();
  }, [api, attempt, reviewId, sourceRef]);

  const readyResponse = state.status === "ready" ? state.response : null;
  const title = readyResponse
    ? SOURCE_TITLES[readyResponse.identity.sourceKind]
    : "查看来源";

  return (
    <ProductDialog
      footer={<button className={styles.secondaryButton} onClick={onClose} type="button">返回周回顾</button>}
      onClose={onClose}
      open={Boolean(sourceRef)}
      title={title}
    >
      {state.status === "idle" || state.status === "loading" ? (
        <ProductState title="正在读取来源…" tone="loading" />
      ) : state.status === "error" ? (
        <ProductState
          action={<button className={styles.secondaryButton} onClick={() => setAttempt((value) => value + 1)} type="button">重新加载</button>}
          description={state.message}
          title="这条来源暂时不可用"
          tone="error"
        />
      ) : readyResponse ? (
        <div className={styles.sourceDialogContent}>
          {!readyResponse.identity.included ? (
            <p className={styles.sourceBoundary}>这条引用仍属于历史版本，但没有进入当前有界生成输入。</p>
          ) : null}
          <SourceBody response={readyResponse} onOpenSource={onOpenSource} />
        </div>
      ) : null}
    </ProductDialog>
  );
}

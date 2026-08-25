"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createDailyReflectionApi,
  DailyReflectionApiError,
  type DailyReflectionApi
} from "@/lib/client/daily-reflection-api";
import type {
  DailyReflectionMemoryDetailResponse,
  DailyReflectionMemoryView
} from "@/lib/domain/daily-reflection-memory-view";

import styles from "./daily-reflection.module.css";
import { ReflectionConfirmDialog } from "./reflection-confirm-dialog";
import { reflectionMemoryPath, reflectionSessionPath } from "./reflection-product";

const MEMORY_TYPE_LABELS: Record<DailyReflectionMemoryView["memoryType"], string> = {
  decision: "决定",
  commitment: "行动约定",
  preference: "偏好",
  person_fact: "人物信息",
  event: "经历",
  question: "未解决问题"
};

function epistemicCopy(memory: DailyReflectionMemoryView) {
  if (memory.epistemicStatus === "explicit_user_statement") return "你明确表达过";
  if (memory.epistemicStatus === "reported_event") return "你记录过的经历";
  return "系统整理的推测";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" })
    .format(new Date(`${value}T12:00:00+08:00`));
}

type DailyReflectionMemoryProps = Readonly<{
  api?: DailyReflectionApi;
  memoryId?: string | null;
}>;

export function DailyReflectionMemory({ api: providedApi, memoryId = null }: DailyReflectionMemoryProps) {
  const api = useMemo(() => providedApi ?? createDailyReflectionApi(), [providedApi]);
  const router = useRouter();
  const [memories, setMemories] = useState<DailyReflectionMemoryView[]>([]);
  const [detail, setDetail] = useState<DailyReflectionMemoryDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const memoryTypeCounts = useMemo(() => memories.reduce<Record<string, number>>((counts, memory) => ({
    ...counts,
    [memory.memoryType]: (counts[memory.memoryType] ?? 0) + 1
  }), {}), [memories]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    setActionError(null);
    try {
      if (memoryId) {
        const response = await api.getMemory(memoryId, signal);
        setDetail(response);
      } else {
        const response = await api.listMemories(signal);
        setMemories(response.memories);
      }
    } catch (cause) {
      if (signal?.aborted) return;
      if (cause instanceof DailyReflectionApiError && cause.status === 404 && memoryId) {
        setLoadError("这条记忆已撤销，或当前无法读取。");
      } else {
        setLoadError(cause instanceof Error ? cause.message : "长期记忆暂时无法读取。");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [api, memoryId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const revoke = async () => {
    const memory = detail?.memory;
    if (!memory || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const card = (await api.getWorkingCard(memory.cardId)).card;
      if (card.memoryLifecycleStatus === "revoked") {
        router.replace("/reflection/memory");
        return;
      }
      let expectedMemoryLifecycleVersion = card.memoryLifecycleVersion;
      if (card.memoryLifecycleStatus === "revocation_requested") {
        const recovery = await api.getWorkingCardMemoryRevocation(card.id);
        if (!recovery.found) throw new Error("撤销进度暂时无法恢复，请重新加载后再试。");
        expectedMemoryLifecycleVersion = recovery.result.operation.requestedMemoryLifecycleVersion;
      }
      await api.revokeWorkingCardMemory(card.id, {
        expectedMemoryLifecycleVersion,
        idempotencyKey: `daily-reflection-card-revoke:${card.id}:v${expectedMemoryLifecycleVersion}`
      });
      setConfirmOpen(false);
      router.replace("/reflection/memory");
      router.refresh();
    } catch (cause) {
      setActionError(cause instanceof DailyReflectionApiError && cause.status === 409
        ? "这条记忆已经在其他页面更新，请重新加载最新内容。"
        : cause instanceof Error ? cause.message : "这条记忆暂时没有撤销成功。");
    } finally {
      setBusy(false);
    }
  };

  if (memoryId) {
    return (
      <main className={`${styles.productPage} ${styles.memoryPage}`}>
        <Link className={styles.backLink} href="/reflection/memory">← 返回记忆</Link>
        {loading ? <p role="status">正在读取这条记忆…</p> : loadError ? (
          <div className={styles.productEmpty}><h1>暂时无法打开</h1><p className={styles.inlineError} role="alert">{loadError}</p><Link className={styles.secondaryButton} href="/reflection/memory">查看其他记忆</Link></div>
        ) : detail ? (
          <article className={styles.memoryDetailArticle}>
            <div className={styles.cardDetailHeading}>
              <div><p className={styles.eyebrow}>{MEMORY_TYPE_LABELS[detail.memory.memoryType]}</p><h1>{detail.memory.title}</h1></div>
              <span className={styles.keptBadge}>已长期记住</span>
            </div>
            <p className={styles.readingText}>{detail.memory.content}</p>
            {detail.memory.epistemicCaution ? <p className={styles.cautionCopy}>这是系统根据你的表达整理出的理解，查看原话可以帮助你判断它是否准确。</p> : null}
            <dl className={styles.cardLibraryDefinitionList}>
              <div><dt>状态</dt><dd>已长期记住</dd></div>
              <div><dt>依据性质</dt><dd>{epistemicCopy(detail.memory)}</dd></div>
              <div><dt>首次出现</dt><dd>{formatDate(detail.memory.recordingDate)}</dd></div>
              <div><dt>来源数量</dt><dd>{detail.memory.sourceCount} 段</dd></div>
              <div><dt>范围</dt><dd>你的日常复盘</dd></div>
            </dl>
            <section className={styles.whyRemembered} aria-labelledby="why-remembered-title">
              <h2 id="why-remembered-title">为什么记住？</h2>
              <p>因为你在完成这次复盘时明确选择了长期记住，并且它保留了可核对的原始来源。</p>
            </section>
            <section className={styles.memoryTimelineSection} aria-labelledby="memory-evidence-title">
              <h2 id="memory-evidence-title">来源时间线</h2>
              <ol className={styles.evidenceTimeline}>
                {detail.memory.evidence.map((evidence) => (
                  <li key={evidence.sourceSegmentId}>
                    <time dateTime={evidence.recordingDate}>{evidence.sourceOrigin === "user_reflection"
                      ? `你在 ${formatDate(evidence.recordingDate)} 的复盘中提到`
                      : `在 ${formatDate(evidence.recordingDate)} 的交流中提到`}</time>
                    <p>{evidence.snippet}</p>
                    <Link href={`${reflectionSessionPath(evidence.reflectionId)}?segment=${encodeURIComponent(evidence.sourceSegmentId)}`}>查看来源</Link>
                  </li>
                ))}
              </ol>
            </section>
            {actionError && !confirmOpen ? <p className={styles.inlineError} role="alert">{actionError}</p> : null}
            <section className={styles.dangerZone} aria-labelledby="memory-danger-title">
              <div><h2 id="memory-danger-title">不再长期使用这条内容</h2><p>原始复盘与卡片仍会保留，只有长期上下文会被撤销。</p></div>
              <button className={styles.dangerButton} disabled={busy} onClick={() => setConfirmOpen(true)} type="button">撤销这条记忆</button>
            </section>
          </article>
        ) : null}
        <ReflectionConfirmDialog busy={busy} confirmLabel="确认撤销" onCancel={() => setConfirmOpen(false)} onConfirm={() => void revoke()} open={confirmOpen} title="撤销这条长期记忆？">
          <p>撤销后，系统不再把它作为长期上下文。原始复盘和已保存卡片不会删除，你仍可查看当时的表达。</p>
          {actionError ? <p className={styles.inlineError} role="alert">{actionError}</p> : null}
        </ReflectionConfirmDialog>
      </main>
    );
  }

  return (
    <main className={`${styles.productPage} ${styles.memoryPage}`}>
      <section className={styles.productIntro}>
        <div><p className={styles.eyebrow}>长期上下文</p><h1>记忆</h1><p>Daily Reflection 会在未来继续使用这些内容。你可以随时核对来源或撤销。</p></div>
        <Link className={styles.secondaryButton} href="/reflection/cards">进入卡片库</Link>
      </section>
      {loadError ? <p className={styles.inlineError} role="alert">{loadError}</p> : null}
      {loading ? <p role="status">正在读取长期记忆…</p> : memories.length === 0 ? (
        <div className={styles.productEmpty}><h2>还没有长期记忆</h2><p>只有你明确选择长期记住的内容，才会出现在这里。</p><Link className={styles.primaryButton} href="/reflection/capture?new=1">开始一次复盘</Link></div>
      ) : (
        <>
          <section className={styles.memoryOverview} aria-labelledby="memory-overview-title">
            <div><p className={styles.eyebrow}>当前有效</p><h2 id="memory-overview-title">{memories.length} 条记忆</h2><p>这些内容都来自你明确确认过、仍可核对的表达。</p></div>
            <dl>{Object.entries(memoryTypeCounts).map(([type, count]) => <div key={type}><dt>{MEMORY_TYPE_LABELS[type as keyof typeof MEMORY_TYPE_LABELS]}</dt><dd>{count}</dd></div>)}</dl>
          </section>
          <section className={styles.recentMemory} aria-labelledby="recent-memory-title">
            <div className={styles.homeSectionHeading}><div><p className={styles.eyebrow}>最近记住</p><h2 id="recent-memory-title">{memories[0]?.title}</h2></div><Link href={reflectionMemoryPath(memories[0]!.id)}>打开</Link></div>
            <p>{memories[0]?.content}</p>
          </section>
          <section className={styles.memoryArchive} aria-labelledby="all-memories-title">
            <div className={styles.sectionHeading}><h2 id="all-memories-title">全部记忆</h2><span>{memories.length} 条</span></div>
            <ol className={styles.memoryList}>
              {memories.map((memory) => (
                <li key={memory.id}>
                  <Link href={reflectionMemoryPath(memory.id)}>
                    <div><span className={styles.pendingBadge}>{MEMORY_TYPE_LABELS[memory.memoryType]}</span><span className={styles.keptBadge}>当前有效</span></div>
                    <h2>{memory.title}</h2><p>{memory.content}</p>
                    <small>{epistemicCopy(memory)} · {memory.sourceCount} 段来源 · {formatDate(memory.recordingDate)}</small>
                  </Link>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </main>
  );
}

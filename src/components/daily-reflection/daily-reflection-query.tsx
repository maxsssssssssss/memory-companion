"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import {
  createDailyReflectionApi,
  type DailyReflectionApi
} from "@/lib/client/daily-reflection-api";
import {
  DailyReflectionQueryScopeSchema,
  type DailyReflectionQueryIntent,
  type DailyReflectionQueryResponse,
  type DailyReflectionQueryScope
} from "@/lib/domain/daily-reflection-query";
import type { DailyReflectionReturnEvidence } from "@/lib/domain/daily-reflection-return";

import styles from "./daily-reflection.module.css";
import { REFLECTION_ASK_EXAMPLES, reflectionSessionPath } from "./reflection-product";

export type DailyReflectionQueryApi = Pick<DailyReflectionApi, "queryReflection">;

type DailyReflectionQueryProps = Readonly<{
  api?: DailyReflectionQueryApi;
  embedded?: boolean;
  initialQuestion?: string;
}>;

const INTENT_LABELS: Record<DailyReflectionQueryIntent, string> = {
  decision_reasoning: "决定的来龙去脉",
  first_appearance: "第一次出现",
  belief_change: "想法如何变化",
  commitment_recall: "待完成的事项",
  memory_exploration: "相关回顾"
};

function formatTimestamp(seconds: number) {
  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3_600);
  const minutes = Math.floor((rounded % 3_600) / 60);
  const remaining = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function safeSourceLink(evidence: DailyReflectionReturnEvidence) {
  return `${reflectionSessionPath(evidence.reflectionId)}?segment=${encodeURIComponent(evidence.sourceSegmentId)}`;
}

function sourceContext(evidence: DailyReflectionReturnEvidence) {
  return evidence.sourceOrigin === "user_reflection"
    ? `你在 ${evidence.recordingDate} 的复盘中提到`
    : `在 ${evidence.recordingDate} 的交流中提到`;
}

function displayRecordingDate(value: string) {
  const [, month, day] = value.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

function EvidenceDisclosure({
  controlId,
  evidence,
  label = "查看来源"
}: Readonly<{
  controlId: string;
  evidence: DailyReflectionReturnEvidence[];
  label?: string;
}>) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <div className={styles.candidateSource}>
        <span>{evidence.length} 段可核对来源</span>
        <button
          aria-controls={controlId}
          aria-expanded={expanded}
          className={styles.sourceButton}
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >{expanded ? "收起来源" : label}</button>
      </div>
      {expanded ? (
        <ol className={styles.evidenceList} id={controlId}>
          {evidence.map((source) => (
            <li key={`${source.cardId}:${source.sourceSegmentId}`}>
              <p>{source.snippet}</p>
              <small>{sourceContext(source)} · 录音 {formatTimestamp(source.startSeconds)}</small>
              <Link className={styles.textButton} href={safeSourceLink(source)}>
                在原复盘中查看
              </Link>
            </li>
          ))}
        </ol>
      ) : null}
    </>
  );
}

export function DailyReflectionQuery({ api: providedApi, embedded = false, initialQuestion = "" }: DailyReflectionQueryProps) {
  const api = useMemo(() => providedApi ?? createDailyReflectionApi(), [providedApi]);
  const [query, setQuery] = useState(initialQuestion);
  const [scope, setScope] = useState<DailyReflectionQueryScope>("all");
  const [result, setResult] = useState<DailyReflectionQueryResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resurfacingVisible, setResurfacingVisible] = useState(true);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => () => activeRequest.current?.abort(), []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedQuery = query.normalize("NFKC").trim();
    if (busy) return;
    if (Array.from(normalizedQuery).length < 2) {
      setError("问题至少需要 2 个字符。");
      return;
    }
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true);
    setError(null);
    setResult(null);
    setResurfacingVisible(true);
    try {
      const response = await api.queryReflection(
        { query: normalizedQuery, scope },
        controller.signal
      );
      if (!controller.signal.aborted) setResult(response);
    } catch {
      if (!controller.signal.aborted) setError("暂时无法查找你的复盘，请稍后重试。");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  };

  const sourceCounts = result ? {
    cards: new Set(result.claims.flatMap((claim) => claim.sourceCardIds)).size,
    reflections: new Set(result.claims.flatMap((claim) => claim.evidence.map((item) => item.reflectionId))).size,
    memories: new Set(result.claims.flatMap((claim) => claim.sourceMemoryIds)).size
  } : null;
  const uniqueEvidence = result ? Array.from(new Map(
    result.claims.flatMap((claim) => claim.evidence)
      .map((item) => [`${item.reflectionId}:${item.sourceSegmentId}`, item] as const)
  ).values()) : [];
  const singleSource = result && result.claims.length === 1 && uniqueEvidence.length === 1
    ? { claim: result.claims[0]!, evidence: uniqueEvidence[0]! }
    : null;

  return (
    <div className={embedded ? styles.embeddedRoot : styles.root}>
      {!embedded ? <header className={styles.header}>
        <Link className={styles.wordmark} href="/date-companion/modules" aria-label="返回空间选择">
          <span className={styles.wordmarkMark}>DB</span>
          <b>问问复盘</b>
        </Link>
        <nav className={styles.productNav} aria-label="产品空间">
          <Link href="/reflection">今天</Link>
          <Link href="/reflection/cards">卡片</Link>
          <Link href="/reflection/reflect">回看</Link>
          <Link aria-current="page" className={styles.activeProductNav} href="/reflection/ask">问问过去</Link>
        </nav>
      </header> : null}

      <main className={`${embedded ? styles.productPage : styles.page} ${styles.cardLibraryPage}`}>
        <section className={embedded ? styles.productIntro : styles.intro}>
          <div>
            <p className={styles.eyebrow}>基于你的真实表达</p>
            <h1>问问过去</h1>
          </div>
          <p className={styles.introText}>每次只回答当前这一问，不保存聊天记录。依据不足时会明确告诉你。</p>
        </section>

        <form className={styles.askComposer} onSubmit={(event) => void submit(event)}>
          <label className={styles.visuallyHidden} htmlFor="daily-reflection-question">你想问什么</label>
          <div className={styles.askInputRow}>
            <input id="daily-reflection-question" aria-label="你想问什么" disabled={busy} maxLength={512} onChange={(event) => setQuery(event.target.value)} placeholder="我之前为什么决定换一个方向？" value={query} />
            <button aria-label={busy ? "正在查找" : "查找"} className={styles.primaryButton} disabled={busy || Array.from(query.normalize("NFKC").trim()).length < 2} type="submit">{busy ? "…" : "↵"}</button>
          </div>
          <div className={styles.askComposerMeta}>
            <div className={styles.questionChips} aria-label="问题示例">
              {REFLECTION_ASK_EXAMPLES.map((example) => <button disabled={busy} key={example} onClick={() => setQuery(example)} type="button">{example}</button>)}
            </div>
            <details className={styles.askScope}>
              <summary>{scope === "all" ? "全部时间 · 全部内容" : scope === "last_7_days" ? "最近 7 天" : "最近 30 天"}</summary>
              <label><span>查找范围</span><select aria-label="查找范围" disabled={busy} onChange={(event) => setScope(DailyReflectionQueryScopeSchema.parse(event.target.value))} value={scope}><option value="all">全部已确认内容</option><option value="last_7_days">最近 7 天</option><option value="last_30_days">最近 30 天</option></select></label>
            </details>
          </div>
        </form>

        {error ? <p className={styles.inlineError} role="alert">{error}</p> : null}

        {result ? (
          <section
            aria-labelledby="daily-reflection-query-answer"
            aria-live="polite"
            className={styles.askAnswer}
          >
            <div className={styles.sectionHeading}>
              <div>
                <p>{INTENT_LABELS[result.intent]}</p>
                <h2 id="daily-reflection-query-answer">回答</h2>
              </div>
            </div>
             <p className={styles.askAnswerText}>{result.answer}</p>
             {sourceCounts ? (
               <p className={styles.answerSourceSummary}>
                 这次回答参考了 {sourceCounts.cards} 张卡片、{sourceCounts.reflections} 次复盘
                 {sourceCounts.memories > 0 ? `和 ${sourceCounts.memories} 条长期记忆` : ""}。
               </p>
             ) : null}
            {result.insufficientEvidence ? (
              <p className={styles.evidenceUnavailable}>现有记录还不足以支持确定结论。</p>
            ) : null}
            {singleSource ? (
              <article className={styles.askSingleSource} aria-label="回答依据">
                <div className={styles.askSingleSourceMeta}>
                  <time dateTime={singleSource.evidence.recordingDate}>{displayRecordingDate(singleSource.evidence.recordingDate)}</time>
                  <span>{singleSource.evidence.sourceOrigin === "user_reflection" ? "你的复盘" : "真实交流"}</span>
                </div>
                <h3>{singleSource.claim.text}</h3>
                <blockquote>
                  <p>{singleSource.evidence.snippet}</p>
                  <footer>{sourceContext(singleSource.evidence)} · 录音 {formatTimestamp(singleSource.evidence.startSeconds)}</footer>
                </blockquote>
                <Link className={styles.secondaryButton} href={safeSourceLink(singleSource.evidence)}>查看完整来源</Link>
              </article>
            ) : result.claims.length > 0 ? (
              <ol className={styles.askEvidenceTimeline} aria-label="回答依据">
                {result.claims.map((claim, index) => (
                  <li className={styles.askClaim} key={`${result.createdAt}:${index}`}>
                    <p>{claim.text}</p>
                    <EvidenceDisclosure
                      controlId={`daily-reflection-query-claim-${index}-sources`}
                      evidence={claim.evidence}
                      label={`查看第 ${index + 1} 条回答来源`}
                    />
                  </li>
                ))}
              </ol>
            ) : (
              <p className={styles.historyEmpty}>没有足够来源可以展开。</p>
            )}
          </section>
        ) : null}

        {result?.resurfacing && resurfacingVisible ? (
          <section className={styles.askResurfacing} aria-label="回看提示">
            <div className={styles.candidateCardTop}>
              <div>
                <p className={styles.eyebrow}>也许还值得回看</p>
                <h2>{result.resurfacing.title}</h2>
              </div>
              <button
                aria-label="关闭回看提示"
                className={styles.textButton}
                onClick={() => setResurfacingVisible(false)}
                type="button"
              >关闭</button>
            </div>
            <p className={styles.candidateText}>{result.resurfacing.body}</p>
            <small>最早提到：{result.resurfacing.earliestDate}</small>
            <EvidenceDisclosure
              controlId="daily-reflection-query-resurfacing-sources"
              evidence={[result.resurfacing.evidence]}
              label="查看提示来源"
            />
          </section>
        ) : null}
      </main>
    </div>
  );
}

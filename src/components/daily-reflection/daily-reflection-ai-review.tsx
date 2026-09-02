"use client";

import Link from "next/link";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";

import { ProductEvidence, ProductState } from "@/components/product-system/product-primitives";
import type {
  DailyReflectionAiReviewOperationView,
  DailyReflectionAiReviewScope
} from "@/lib/client/daily-reflection-ai-review-api";

import styles from "./daily-reflection.module.css";
import { reflectionSessionPath } from "./reflection-product";
import { useReflectionAiReview } from "./reflection-ai-review-provider";

const REVIEW_POLL_INTERVAL_MS = 2_500;
const PENDING_STATUSES = new Set(["queued", "processing", "validating"]);

const STATUS_COPY = {
  queued: {
    title: "AI 深度回看正在等待整理",
    description: "快速回看已经可以阅读；更深入的跨来源整理会在后台继续。"
  },
  processing: {
    title: "AI 正在综合这段时间的线索",
    description: "快速回看不会被阻塞，你可以先从已有内容开始。"
  },
  validating: {
    title: "AI 正在核对来源",
    description: "只有通过来源校验的内容才会出现在深度回看里。"
  }
} as const;

type DailyReflectionAiReviewProps = Readonly<{
  hasRuleContent: boolean;
  quickViewOpen: boolean;
  referenceDate: string;
  rules: ReactNode;
  scope: DailyReflectionAiReviewScope;
}>;

function formatTimestamp(seconds: number) {
  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3_600);
  const minutes = Math.floor((rounded % 3_600) / 60);
  const remaining = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function sourceContext(sourceOrigin: "user_reflection" | "direct_conversation", recordingDate: string) {
  return sourceOrigin === "user_reflection"
    ? `${recordingDate} 的个人复盘`
    : `${recordingDate} 的交流`;
}

function AiReviewReady({ review }: Readonly<{ review: DailyReflectionAiReviewOperationView }>) {
  if (!review.content) return null;
  return (
    <section aria-labelledby={`ai-review-title-${review.reviewId}`} className={styles.aiReviewReady}>
      <header className={styles.aiReviewHeader}>
        <div>
          <h2 id={`ai-review-title-${review.reviewId}`}>AI 深度回看</h2>
          <p>这是基于已确认来源形成的综合理解，不会替代你的原话或长期记忆。</p>
        </div>
        <span>已核对来源</span>
      </header>
      <ol className={styles.aiReviewObservationList}>
        {review.content.observations.map((observation, index) => (
          <li key={`${review.reviewId}:${index}`}>
            <article className={styles.aiReviewObservation}>
              <h3>{index === 0 ? "这次值得看见的变化" : `另一个值得留意的线索`}</h3>
              <p className={styles.aiReviewInferenceLabel}>AI 综合理解 · 不等于你的历史原话</p>
              <p className={styles.aiReviewInterpretation}>{observation.modelInterpretation.text}</p>
              {observation.followUpQuestion ? (
                <div className={styles.aiReviewQuestion}>
                  <span>AI 建议继续想</span>
                  <p>{observation.followUpQuestion.text}</p>
                </div>
              ) : null}
              <details className={styles.aiReviewSources}>
                <summary>{observation.canonicalSources.length} 条已核对来源</summary>
                <div>
                  {observation.canonicalSources.map((source) => (
                    <section aria-label={source.title} key={source.sourceId}>
                      <h4>{source.title}</h4>
                      <ProductEvidence
                        label="规则回看中的可信内容"
                        meta={source.recordingDates.join("、")}
                      >
                        {source.content}
                      </ProductEvidence>
                      <ol className={styles.aiReviewEvidenceList}>
                        {source.evidence.map((evidence) => (
                          <li key={`${source.sourceId}:${evidence.sourceSegmentId}`}>
                            <div>
                              <span>{sourceContext(evidence.sourceOrigin, evidence.recordingDate)}</span>
                              <time>{formatTimestamp(evidence.startSeconds)}</time>
                            </div>
                            <blockquote>{evidence.snippet}</blockquote>
                            <Link href={`${reflectionSessionPath(evidence.reflectionId)}?segment=${encodeURIComponent(evidence.sourceSegmentId)}`}>
                              查看原话
                            </Link>
                          </li>
                        ))}
                      </ol>
                    </section>
                  ))}
                </div>
              </details>
            </article>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function DailyReflectionAiReview({
  hasRuleContent,
  quickViewOpen,
  referenceDate,
  rules,
  scope
}: DailyReflectionAiReviewProps) {
  const { api, markSeen, reviewUpdated } = useReflectionAiReview();
  const [review, setReview] = useState<DailyReflectionAiReviewOperationView | null>(null);
  const [exposureMode, setExposureMode] = useState<"shadow" | "on" | null>(null);
  const [readError, setReadError] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(true);
  const generation = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const pollTimer = useRef<number | null>(null);
  const ensuredKeys = useRef(new Set<string>());
  const seenReviewIds = useRef(new Set<string>());
  const rulesInteracted = useRef(false);
  const rulesWrapper = useRef<HTMLDivElement | null>(null);
  const anchorTop = useRef<number | null>(null);
  const previousStatus = useRef<DailyReflectionAiReviewOperationView["status"] | null>(null);
  const exposureModeRef = useRef(exposureMode);
  const quickViewOpenRef = useRef(quickViewOpen);
  const key = `${scope}:${referenceDate}`;
  exposureModeRef.current = exposureMode;
  quickViewOpenRef.current = quickViewOpen;

  const clearPoll = useCallback(() => {
    if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    pollTimer.current = null;
  }, []);

  const commitReview = useCallback((next: DailyReflectionAiReviewOperationView | null) => {
    const becameReady = next?.status === "ready" && previousStatus.current !== "ready";
    if (becameReady && exposureModeRef.current === "on" && next.content) {
      anchorTop.current = rulesWrapper.current?.getBoundingClientRect().top ?? null;
      const readerIsInsideRules = (rulesWrapper.current?.getBoundingClientRect().top ?? 0) < -96;
      setRulesOpen(quickViewOpenRef.current || rulesInteracted.current || readerIsInsideRules);
    }
    previousStatus.current = next?.status ?? null;
    setReview(next);
  }, []);

  const load = useCallback(async (requestGeneration: number) => {
    clearPoll();
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const lookup = await api.get({ scope, referenceDate }, controller.signal);
      if (controller.signal.aborted || requestGeneration !== generation.current) return;
      setExposureMode(lookup.exposureMode);
      exposureModeRef.current = lookup.exposureMode;
      setReadError(false);
      let next = lookup.review;
      if (
        hasRuleContent
        && (next === null || next.status === "stale")
        && !ensuredKeys.current.has(key)
      ) {
        ensuredKeys.current.add(key);
        next = await api.ensure({ scope, referenceDate }, controller.signal);
        if (controller.signal.aborted || requestGeneration !== generation.current) return;
        reviewUpdated();
      }
      commitReview(next);
      if (next?.status === "ready" || next?.status === "failed") {
        reviewUpdated();
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setReadError(true);
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }, [api, clearPoll, commitReview, hasRuleContent, key, referenceDate, reviewUpdated, scope]);

  useEffect(() => {
    generation.current += 1;
    const requestGeneration = generation.current;
    clearPoll();
    activeRequest.current?.abort();
    previousStatus.current = null;
    setReview(null);
    setExposureMode(null);
    setReadError(false);
    setRulesOpen(true);
    rulesInteracted.current = false;
    void load(requestGeneration);
    return () => {
      generation.current += 1;
      clearPoll();
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [clearPoll, key, load]);

  useEffect(() => {
    if (!review || !PENDING_STATUSES.has(review.status) || document.visibilityState === "hidden") {
      clearPoll();
      return;
    }
    clearPoll();
    pollTimer.current = window.setTimeout(
      () => void load(generation.current),
      REVIEW_POLL_INTERVAL_MS
    );
    return clearPoll;
  }, [clearPoll, load, review]);

  useEffect(() => {
    const resume = () => {
      if (
        document.visibilityState === "visible"
        && (!review || PENDING_STATUSES.has(review.status))
      ) {
        void load(generation.current);
      } else if (document.visibilityState === "hidden") {
        clearPoll();
        activeRequest.current?.abort();
      }
    };
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, [clearPoll, load, review]);

  useLayoutEffect(() => {
    if (anchorTop.current === null || !rulesWrapper.current) return;
    const previousTop = anchorTop.current;
    anchorTop.current = null;
    const delta = rulesWrapper.current.getBoundingClientRect().top - previousTop;
    if (Math.abs(delta) > 1) window.scrollBy({ behavior: "auto", top: delta });
  }, [review?.status, rulesOpen]);

  useEffect(() => {
    if (
      !hasRuleContent
      || exposureMode !== "on"
      || review?.status !== "ready"
      || !review.content
      || review.seenAt !== null
      || seenReviewIds.current.has(review.reviewId)
      || document.visibilityState !== "visible"
    ) return;
    seenReviewIds.current.add(review.reviewId);
    void markSeen(review.reviewId);
  }, [exposureMode, hasRuleContent, markSeen, review]);

  const ready = hasRuleContent
    && exposureMode === "on"
    && review?.status === "ready"
    && review.content !== null;
  const visibleStatus = hasRuleContent
    && exposureMode === "on"
    && review
    && PENDING_STATUSES.has(review.status)
    ? STATUS_COPY[review.status as keyof typeof STATUS_COPY]
    : null;

  return (
    <div className={styles.aiReviewRoot}>
      <div aria-live="polite" className={styles.aiReviewLiveRegion} role="status">
        {visibleStatus?.title ?? (ready ? "AI 深度回看已完成" : "")}
      </div>
      {visibleStatus ? (
        <div className={styles.aiReviewState}>
          <ProductState description={visibleStatus.description} title={visibleStatus.title} />
        </div>
      ) : null}
      {hasRuleContent && exposureMode === "on" && (review?.status === "failed" || readError) ? (
        <div className={styles.aiReviewState}>
          <ProductState
            description="快速回看仍然可用，你不需要等待或重新操作。"
            title="这次 AI 深度回看暂时没有生成"
          />
        </div>
      ) : null}
      {ready ? <AiReviewReady review={review} /> : null}
      <div className={styles.aiReviewRules} ref={rulesWrapper}>
        {ready ? (
          <details
            onToggle={(event) => {
              rulesInteracted.current = true;
              setRulesOpen(event.currentTarget.open);
            }}
            open={rulesOpen}
          >
            <summary>查看快速回看</summary>
            <div>{rules}</div>
          </details>
        ) : rules}
      </div>
    </div>
  );
}

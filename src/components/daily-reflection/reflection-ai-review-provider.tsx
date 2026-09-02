"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import {
  createDailyReflectionAiReviewApi,
  type DailyReflectionAiReviewApi,
  type DailyReflectionAiReviewSummaryResponse
} from "@/lib/client/daily-reflection-ai-review-api";

const DEFAULT_API = createDailyReflectionAiReviewApi();
const ACTIVE_POLL_INTERVAL_MS = 2_500;

type SummaryItem = DailyReflectionAiReviewSummaryResponse["items"][number];

type ReflectionAiReviewContextValue = Readonly<{
  api: DailyReflectionAiReviewApi;
  completionNotice: SummaryItem | null;
  dismissCompletionNotice(): void;
  markSeen(reviewId: string): Promise<void>;
  refreshSummary(): Promise<void>;
  reviewUpdated(): void;
  summary: DailyReflectionAiReviewSummaryResponse | null;
}>;

const ReflectionAiReviewContext = createContext<ReflectionAiReviewContextValue | null>(null);

export function useReflectionAiReview() {
  const value = useContext(ReflectionAiReviewContext);
  if (!value) throw new Error("ReflectionAiReviewProvider is required");
  return value;
}

export function ReflectionAiReviewProvider({
  accountId,
  api = DEFAULT_API,
  children
}: Readonly<{
  accountId: string;
  api?: DailyReflectionAiReviewApi;
  children: ReactNode;
}>) {
  const [summary, setSummary] = useState<DailyReflectionAiReviewSummaryResponse | null>(null);
  const [completionNotice, setCompletionNotice] = useState<SummaryItem | null>(null);
  const generation = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const loaded = useRef(false);
  const knownReadyIds = useRef(new Set<string>());

  const loadSummary = useCallback(async () => {
    const requestGeneration = generation.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const next = await api.getSummary(controller.signal);
      if (controller.signal.aborted || requestGeneration !== generation.current) return;
      const nextIds = new Set(next.items.map((item) => item.reviewId));
      if (loaded.current && next.exposureMode === "on") {
        const newlyReady = next.items
          .filter((item) => !knownReadyIds.current.has(item.reviewId))
          .sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0];
        if (newlyReady) setCompletionNotice(newlyReady);
      }
      knownReadyIds.current = nextIds;
      loaded.current = true;
      setSummary(next);
      if (next.exposureMode !== "on") setCompletionNotice(null);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        // The global shell remains usable when this optional status read fails.
      }
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }, [api]);

  useEffect(() => {
    generation.current += 1;
    loaded.current = false;
    knownReadyIds.current = new Set();
    setSummary(null);
    setCompletionNotice(null);
    void loadSummary();
    return () => {
      generation.current += 1;
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [accountId, loadSummary]);

  useEffect(() => {
    if (!summary || summary.pendingCount === 0 || document.visibilityState === "hidden") return;
    const timeout = window.setTimeout(() => void loadSummary(), ACTIVE_POLL_INTERVAL_MS);
    return () => window.clearTimeout(timeout);
  }, [loadSummary, summary]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void loadSummary();
    };
    const refreshOnFocus = () => {
      if (document.visibilityState !== "hidden") void loadSummary();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [loadSummary]);

  const dismissCompletionNotice = useCallback(() => setCompletionNotice(null), []);

  const markSeen = useCallback(async (reviewId: string) => {
    const controller = new AbortController();
    try {
      await api.markSeen(reviewId, controller.signal);
      setCompletionNotice((current) => current?.reviewId === reviewId ? null : current);
      setSummary((current) => current ? {
        ...current,
        unseenReadyCount: Math.max(0, current.unseenReadyCount - 1),
        items: current.items.filter((item) => item.reviewId !== reviewId)
      } : current);
      await loadSummary();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      // Seen state is best-effort; the persisted unread badge remains truthful on failure.
    }
  }, [api, loadSummary]);

  const reviewUpdated = useCallback(() => {
    void loadSummary();
  }, [loadSummary]);

  const value = useMemo<ReflectionAiReviewContextValue>(() => ({
    api,
    completionNotice,
    dismissCompletionNotice,
    markSeen,
    refreshSummary: loadSummary,
    reviewUpdated,
    summary
  }), [
    api,
    completionNotice,
    dismissCompletionNotice,
    loadSummary,
    markSeen,
    reviewUpdated,
    summary
  ]);

  return (
    <ReflectionAiReviewContext.Provider value={value}>
      {children}
    </ReflectionAiReviewContext.Provider>
  );
}

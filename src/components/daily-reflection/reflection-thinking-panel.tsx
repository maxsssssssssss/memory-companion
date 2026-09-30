"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createContext,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from "react";

import {
  DailyReflectionThinkingRequestSchema,
  DailyReflectionThinkingResponseSchema,
  ContextModeSchema,
  ThinkingModeSchema,
  type DailyReflectionThinkingConversation,
  type ContextMode,
  type DailyReflectionThinkingRequest,
  type DailyReflectionThinkingResponse,
  type DailyReflectionThinkingSource,
  type ThinkingMode
} from "@/lib/domain/daily-reflection-thinking";
import {
  DailyReflectionThinkingApiError,
  type DailyReflectionThinkingApi
} from "@/lib/client/daily-reflection-thinking-api";

import styles from "./daily-reflection.module.css";
import { reflectionSessionPath } from "./reflection-product";

type ThinkingTurn = Readonly<{
  contextMode: ContextMode;
  id: string;
  mode: ThinkingMode;
  operationKey: string;
  response: DailyReflectionThinkingResponse | null;
  status: "pending" | "completed" | "failed" | "cancelled";
  userText: string;
}>;

type RetryRequest = Readonly<{
  input: DailyReflectionThinkingRequest;
  turnId: string;
  userText: string;
}>;

type ReflectionThinkingContextValue = Readonly<{
  abort(): void;
  busy: boolean;
  changeMode(mode: ThinkingMode): void;
  closePanel(restoreFocus?: boolean): void;
  conversationId?: string;
  draft: string;
  error: string | null;
  initializeWorkspace(initialMode?: ThinkingMode): void;
  mode: ThinkingMode;
  openPanel(trigger?: HTMLElement): void;
  panelOpen: boolean;
  prepareWorkspaceHandoff(): void;
  retry(): Promise<void>;
  send(): Promise<void>;
  setDraft(value: string): void;
  turns: ThinkingTurn[];
}>;

const ThinkingContext = createContext<ReflectionThinkingContextValue | null>(null);
const MAX_DRAFT_LENGTH = 8_000;
const THINKING_HANDOFF_KEY = "daily-reflection:thinking-handoff:v1";
const THINKING_HANDOFF_MAX_AGE_MS = 60_000;

type ThinkingHandoff = Readonly<{
  contextMode: ContextMode;
  conversationId?: string;
  createdAt: number;
  draft: string;
  mode: ThinkingMode;
}>;

export const THINKING_MODE_COPY: Readonly<Record<ThinkingMode, Readonly<{
  description: string;
  label: string;
}>>> = {
  brainstorm: { label: "头脑风暴", description: "先把一个念头打开，不急着收束。" },
  clarify_decision: { label: "想清一个决定", description: "把真正需要权衡的部分放到桌面上。" },
  compare_directions: { label: "比较几个方向", description: "并排看见不同选择的代价与可能。" },
  extend_idea: { label: "延伸一个想法", description: "沿着已有的线索，再多走几步。" },
  past_clues: { label: "从过去找线索", description: "只依据你留下的可信内容寻找关联。" }
};

const DEFAULT_THINKING_CONTEXT_MODE: ContextMode = "personal";

function readThinkingHandoff(): ThinkingHandoff | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(THINKING_HANDOFF_KEY);
  window.sessionStorage.removeItem(THINKING_HANDOFF_KEY);
  if (!raw) return null;
  try {
    const candidate = JSON.parse(raw) as Partial<ThinkingHandoff>;
    const mode = ThinkingModeSchema.safeParse(candidate.mode);
    const contextMode = ContextModeSchema.safeParse(candidate.contextMode);
    if (
      !mode.success
      || !contextMode.success
      || typeof candidate.createdAt !== "number"
      || Date.now() - candidate.createdAt > THINKING_HANDOFF_MAX_AGE_MS
      || typeof candidate.draft !== "string"
      || (candidate.conversationId !== undefined && typeof candidate.conversationId !== "string")
    ) return null;
    return {
      contextMode: contextMode.data,
      conversationId: candidate.conversationId,
      createdAt: candidate.createdAt,
      draft: candidate.draft,
      mode: mode.data
    };
  } catch {
    return null;
  }
}

function createOperationKey() {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `drthink_${id}`;
}

function normalizeDraft(value: string) {
  return value.normalize("NFKC").trim();
}

/**
 * Thinking answers are intentionally plain text. Older provider responses may
 * still contain a few presentational Markdown markers, so remove only those
 * common wrappers without interpreting HTML or creating rich content.
 */
export function normalizeThinkingPlainText(value: string) {
  return value
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => {
      if (/^\s*```[^`]*$/u.test(line) || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
        return "";
      }
      return line
        .replace(/^\s{0,3}#{1,6}\s+/u, "")
        .replace(/^\s{0,3}>\s?/u, "")
        .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/u, "")
        .replace(/^\s{0,3}\[[ xX]\]\s+/u, "");
    })
    .join("\n")
    .replace(/\[([^\]\n]+)\]\((?:[^()\n]|\([^()\n]*\))*\)/gu, "$1")
    .replace(/\*\*([^*\n]+)\*\*/gu, "$1")
    .replace(/__([^_\n]+)__/gu, "$1")
    .replace(/~~([^~\n]+)~~/gu, "$1")
    .replace(/`([^`\n]+)`/gu, "$1")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function errorMessage(error: unknown) {
  if (error instanceof DailyReflectionThinkingApiError) return error.message;
  return "这次没有继续下去。你可以保留原问题，再试一次。";
}

function turnsFromConversation(
  conversation: DailyReflectionThinkingConversation
): ThinkingTurn[] {
  const userByOperation = new Map(conversation.messages
    .filter((message) => message.role === "user")
    .map((message) => [message.operationKey, message]));
  return conversation.messages.flatMap((assistant) => {
    if (
      assistant.role !== "assistant"
      || (assistant.completionStatus !== "completed" && assistant.completionStatus !== "no_result")
      || !assistant.model
    ) return [];
    const user = userByOperation.get(assistant.operationKey);
    if (!user || user.mode !== assistant.mode || user.contextMode !== assistant.contextMode) return [];
    const response = DailyReflectionThinkingResponseSchema.safeParse({
      conversationId: conversation.conversationId,
      operationKey: assistant.operationKey,
      assistantMessage: assistant,
      usedPersonalContext: assistant.usedPersonalContext,
      sources: assistant.sources,
      model: assistant.model
    });
    if (!response.success) return [];
    return [{
      contextMode: user.contextMode,
      id: assistant.operationKey,
      mode: user.mode,
      operationKey: assistant.operationKey,
      response: response.data,
      status: "completed" as const,
      userText: user.content
    }];
  });
}

export function useReflectionThinking() {
  const value = useContext(ThinkingContext);
  if (!value) throw new Error("ReflectionThinkingProvider is required");
  return value;
}

export function ReflectionThinkingProvider({
  api,
  children
}: Readonly<{
  api: DailyReflectionThinkingApi;
  children: ReactNode;
}>) {
  const [mode, setMode] = useState<ThinkingMode>("brainstorm");
  const [conversationId, setConversationId] = useState<string>();
  const [draft, setDraftState] = useState("");
  const [turns, setTurns] = useState<ThinkingTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);
  const retryRequest = useRef<RetryRequest | null>(null);
  const submitting = useRef(false);
  const conversationIdRef = useRef(conversationId);
  const refreshBeforeNextRequest = useRef(false);
  const panelTrigger = useRef<HTMLElement | null>(null);
  conversationIdRef.current = conversationId;

  const abort = useCallback(() => {
    if (activeRequest.current && conversationIdRef.current) {
      refreshBeforeNextRequest.current = true;
    }
    activeRequest.current?.abort();
    activeRequest.current = null;
    submitting.current = false;
    setTurns((current) => current.map((turn) => turn.status === "pending"
      ? { ...turn, status: "cancelled" } : turn));
    setBusy(false);
  }, []);

  useEffect(() => () => activeRequest.current?.abort(), []);

  const changeMode = useCallback((nextMode: ThinkingMode) => {
    if (nextMode === mode) return;
    abort();
    setError(null);
    retryRequest.current = null;
    setMode(nextMode);
  }, [abort, mode]);

  const openPanel = useCallback((trigger?: HTMLElement) => {
    abort();
    setError(null);
    retryRequest.current = null;
    setMode("brainstorm");
    panelTrigger.current = trigger ?? (document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null);
    setPanelOpen(true);
  }, [abort]);

  const closePanel = useCallback((restoreFocus = true) => {
    setPanelOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => panelTrigger.current?.focus());
    }
  }, []);

  const run = useCallback(async (request: RetryRequest) => {
    if (submitting.current) return;
    submitting.current = true;
    const controller = new AbortController();
    activeRequest.current = controller;
    retryRequest.current = request;
    setBusy(true);
    setError(null);
    const pendingTurn: ThinkingTurn = {
      contextMode: request.input.contextMode,
      id: request.turnId,
      mode: request.input.mode,
      operationKey: request.input.operationKey,
      response: null,
      status: "pending",
      userText: request.userText
    };
    setTurns((current) => current.some((turn) => turn.id === request.turnId)
      ? current.map((turn) => turn.id === request.turnId ? pendingTurn : turn)
      : [...current, pendingTurn]);
    const updateTurn = (status: ThinkingTurn["status"], response: ThinkingTurn["response"] = null) => {
      setTurns((current) => current.map((turn) => turn.id === request.turnId
        ? { ...turn, status, response } : turn));
    };
    try {
      if (refreshBeforeNextRequest.current && conversationIdRef.current) {
        const conversation = await api.getConversation(
          conversationIdRef.current,
          controller.signal
        );
        if (controller.signal.aborted) return;
        const recovered = turnsFromConversation(conversation);
        setTurns((current) => [
          ...recovered,
          ...current.filter((turn) => !recovered.some((saved) => saved.operationKey === turn.operationKey))
        ]);
        refreshBeforeNextRequest.current = false;
      }
      const response = await api.think(request.input, controller.signal);
      if (controller.signal.aborted) return;
      if (
        response.operationKey !== request.input.operationKey
        || response.assistantMessage.mode !== request.input.mode
        || response.assistantMessage.contextMode !== request.input.contextMode
        || (request.input.conversationId !== undefined
          && response.conversationId !== request.input.conversationId)
      ) {
        throw new DailyReflectionThinkingApiError(
          502,
          "invalid_response",
          "服务器返回了无法识别的数据，请稍后重试。"
        );
      }
      setConversationId(response.conversationId);
      conversationIdRef.current = response.conversationId;
      const completionStatus = response.assistantMessage.completionStatus;
      if (completionStatus === "provider_error") {
        retryRequest.current = {
          input: {
            ...request.input,
            conversationId: response.conversationId,
            operationKey: createOperationKey()
          },
          turnId: request.turnId,
          userText: request.userText
        };
        updateTurn("failed");
        setError("这次没有继续下去。原问题仍然保留，你可以再试一次。");
        return;
      }
      if (completionStatus === "cancelled") {
        retryRequest.current = request;
        updateTurn("cancelled");
        setError("这次已停止，原问题仍然保留。");
        return;
      }
      updateTurn("completed", response);
      retryRequest.current = null;
    } catch (caught) {
      if (!controller.signal.aborted) {
        updateTurn("failed");
        setError(errorMessage(caught));
      }
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setBusy(false);
        submitting.current = false;
      }
    }
  }, [api]);

  const send = useCallback(async () => {
    if (busy || submitting.current) return;
    const message = normalizeDraft(draft);
    if (!message) {
      setError("先写下你想一起推演的内容。");
      return;
    }
    const input = DailyReflectionThinkingRequestSchema.parse({
      contextMode: DEFAULT_THINKING_CONTEXT_MODE,
      conversationId,
      message,
      mode,
      operationKey: createOperationKey()
    });
    setDraftState("");
    await run({ input, turnId: input.operationKey, userText: message });
  }, [busy, conversationId, draft, mode, run]);

  const retry = useCallback(async () => {
    if (!retryRequest.current || busy) return;
    await run(retryRequest.current);
  }, [busy, run]);

  const setDraft = useCallback((value: string) => {
    setDraftState(Array.from(value).slice(0, MAX_DRAFT_LENGTH).join(""));
    setError(null);
  }, []);

  const prepareWorkspaceHandoff = useCallback(() => {
    if (typeof window === "undefined") return;
    const handoff: ThinkingHandoff = {
      contextMode: DEFAULT_THINKING_CONTEXT_MODE,
      conversationId,
      createdAt: Date.now(),
      draft,
      mode
    };
    window.sessionStorage.setItem(THINKING_HANDOFF_KEY, JSON.stringify(handoff));
  }, [conversationId, draft, mode]);

  const initializeWorkspace = useCallback((initialMode?: ThinkingMode) => {
    const handoff = readThinkingHandoff();
    const nextMode = handoff?.mode ?? initialMode;
    if (nextMode && nextMode !== mode) setMode(nextMode);
    if (handoff) {
      setDraftState(handoff.draft);
      if (handoff.conversationId && handoff.conversationId !== conversationIdRef.current) {
        setConversationId(handoff.conversationId);
        conversationIdRef.current = handoff.conversationId;
        const controller = new AbortController();
        activeRequest.current?.abort();
        activeRequest.current = controller;
        void api.getConversation(handoff.conversationId, controller.signal).then((conversation) => {
          if (!controller.signal.aborted) setTurns(turnsFromConversation(conversation));
        }).catch((caught) => {
          if (!controller.signal.aborted) setError(errorMessage(caught));
        }).finally(() => {
          if (activeRequest.current === controller) activeRequest.current = null;
        });
      }
    }
    setError(null);
    retryRequest.current = null;
  }, [api, mode]);

  const value = useMemo<ReflectionThinkingContextValue>(() => ({
    abort,
    busy,
    changeMode,
    closePanel,
    conversationId,
    draft,
    error,
    initializeWorkspace,
    mode,
    openPanel,
    panelOpen,
    prepareWorkspaceHandoff,
    retry,
    send,
    setDraft,
    turns
  }), [
    abort, busy, changeMode, closePanel, conversationId, draft, error,
    initializeWorkspace, mode, openPanel,
    panelOpen, prepareWorkspaceHandoff, retry, send, setDraft, turns
  ]);

  return <ThinkingContext.Provider value={value}>{children}</ThinkingContext.Provider>;
}

function formatTimestamp(seconds: number) {
  const rounded = Math.max(0, Math.floor(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function ThinkingSourceList({ sources }: Readonly<{ sources: DailyReflectionThinkingSource[] }>) {
  if (sources.length === 0) return null;
  return (
    <details className={styles.thinkingSources}>
      <summary>本轮参考 · {sources.length} 组来源</summary>
      <ol>
        {sources.map((source) => (
          <li key={source.sourceId}>
            <p>{source.claim.text}</p>
            {source.claim.evidence.map((evidence) => (
              <blockquote key={`${source.sourceId}:${evidence.sourceSegmentId}`}>
                <p>{evidence.snippet}</p>
                <footer>
                  <span>{evidence.recordingDate} · {formatTimestamp(evidence.startSeconds)}</span>
                  <Link href={`${reflectionSessionPath(evidence.reflectionId)}?segment=${encodeURIComponent(evidence.sourceSegmentId)}`}>
                    查看原话
                  </Link>
                </footer>
              </blockquote>
            ))}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function ThinkingResponse({ response }: Readonly<{
  response: DailyReflectionThinkingResponse;
}>) {
  const message = response.assistantMessage;
  return (
    <article className={styles.thinkingResponse}>
      <p className={styles.thinkingAnswer} data-testid="thinking-answer">
        {normalizeThinkingPlainText(message.content)}
      </p>
      <ThinkingSourceList sources={response.sources} />
    </article>
  );
}

export function ThinkingConversation() {
  const { turns } = useReflectionThinking();
  if (turns.length === 0) return null;
  return (
    <ol className={styles.thinkingConversation} aria-label="本次一起想的内容">
      {turns.map((turn) => (
        <li key={turn.id}>
          <p className={styles.thinkingTurnContext}>
            {THINKING_MODE_COPY[turn.mode].label}
          </p>
          <p className={styles.thinkingUserMessage}>{turn.userText}</p>
          {turn.response ? <ThinkingResponse response={turn.response} /> : turn.status === "pending" ? (
            <div className={styles.thinkingPending} role="status">
              <span aria-hidden="true" />
              <p>AI 正在思考回复…</p>
            </div>
          ) : <p className={styles.thinkingTurnContext}>
            {turn.status === "cancelled" ? "已停止回复" : "这次回复未完成，原问题已保留。"}
          </p>}
        </li>
      ))}
    </ol>
  );
}

const FOLLOW_LATEST_THRESHOLD_PX = 96;

export function ThinkingMessageViewport({ empty }: Readonly<{ empty?: ReactNode }>) {
  const { busy, turns } = useReflectionThinking();
  const viewport = useRef<HTMLDivElement | null>(null);
  const followsLatest = useRef(true);

  const updateFollowState = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    followsLatest.current = distanceFromBottom <= FOLLOW_LATEST_THRESHOLD_PX;
  }, []);

  useEffect(() => {
    if (!followsLatest.current) return;
    const frame = requestAnimationFrame(() => {
      const element = viewport.current;
      if (!element || !followsLatest.current) return;
      const reduceMotion = typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (typeof element.scrollTo === "function") {
        element.scrollTo({
          behavior: reduceMotion ? "auto" : "smooth",
          top: element.scrollHeight
        });
      } else {
        element.scrollTop = element.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [busy, turns.length]);

  return (
    <div
      aria-label="一起想的消息"
      aria-live="polite"
      className={styles.thinkingMessageViewport}
      data-testid="thinking-message-viewport"
      onScroll={updateFollowState}
      ref={viewport}
      role="log"
    >
      {turns.length === 0 && !busy ? empty : <ThinkingConversation />}
    </div>
  );
}

export function ThinkingComposer({ compact = false }: Readonly<{ compact?: boolean }>) {
  const { abort, busy, draft, error, retry, send, setDraft } = useReflectionThinking();
  const draftId = useId();
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };
  return (
    <form className={`${styles.thinkingComposer} ${compact ? styles.thinkingComposerCompact : ""}`} onSubmit={(event: FormEvent) => {
      event.preventDefault();
      void send();
    }}>
      <label className={styles.visuallyHidden} htmlFor={draftId}>
        想一起推演什么
      </label>
      <textarea
        id={draftId}
        maxLength={MAX_DRAFT_LENGTH}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="把还没想清楚的部分写在这里…"
        rows={5}
        value={draft}
      />
      <div>
        <small>Enter 发送 · Shift + Enter 换行</small>
        {busy ? <button className={styles.textButton} onClick={abort} type="button">停止</button> : null}
        <button className={styles.primaryButton} disabled={busy || normalizeDraft(draft).length === 0} type="submit">
          {busy ? "正在一起想" : "一起想"}
        </button>
      </div>
      {error ? <div className={styles.thinkingError} role="alert">
        <p>{error}</p>
        <button className={styles.textButton} onClick={() => void retry()} type="button">重试</button>
      </div> : null}
    </form>
  );
}

export function ReflectionThinkingQuickPanel() {
  const router = useRouter();
  const {
    closePanel,
    panelOpen,
    prepareWorkspaceHandoff
  } = useReflectionThinking();
  const panel = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!panelOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      panel.current?.querySelector<HTMLElement>("button, textarea, a")?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>(
        "a[href], button:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closePanel, panelOpen]);

  if (!panelOpen) return null;
  return (
    <div
      className={styles.thinkingPanelBackdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closePanel();
      }}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.thinkingPanel}
        ref={panel}
        role="dialog"
      >
        <header className={styles.thinkingPanelHeader}>
          <div>
            <p>轻量头脑风暴</p>
            <h2 id={titleId}>先把这个念头打开</h2>
          </div>
          <button aria-label="关闭头脑风暴" className={styles.iconButton} onClick={() => closePanel()} type="button">×</button>
        </header>
        <div className={styles.thinkingPanelConversation}>
          <ThinkingMessageViewport empty={(
            <div className={styles.thinkingPanelEmpty}>
              <p>写下一句还没想清楚的话，我们从这里开始。</p>
            </div>
          )} />
        </div>
        <ThinkingComposer compact />
        <button
          className={styles.thinkingPanelExpand}
          onClick={() => {
            prepareWorkspaceHandoff();
            closePanel(false);
            router.push(`/reflection/think?mode=brainstorm`);
          }}
          type="button"
        >
          在“一起想”中展开 <span aria-hidden="true">→</span>
        </button>
      </section>
    </div>
  );
}

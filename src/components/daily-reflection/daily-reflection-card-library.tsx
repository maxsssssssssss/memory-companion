"use client";

import Link from "next/link";
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from "react";

import { ProductState } from "@/components/product-system/product-primitives";
import {
  createDailyReflectionApi,
  DailyReflectionApiError,
  type DailyReflectionApi,
  type DailyReflectionWorkingCardMemoryLookupResponse,
  type DailyReflectionMemoryProposalCreateRequest
} from "@/lib/client/daily-reflection-api";
import type {
  DailyReflectionWorkingCardDetailResponse,
  DailyReflectionWorkingCardView
} from "@/lib/domain/daily-reflection-api";
import type {
  DailyReflectionMemoryProposalAcknowledgement,
  DailyReflectionMemoryProposalConfirmationRequirement
} from "@/lib/domain/daily-reflection-memory-proposal";
import type {
  DailyReflectionWorkingCardKind,
  DailyReflectionWorkingCardStatus
} from "@/lib/domain/daily-reflection-working-card";

import styles from "./daily-reflection.module.css";
import { ReflectionConfirmDialog } from "./reflection-confirm-dialog";
import { reflectionCardPath, reflectionSessionPath } from "./reflection-product";

const FILTER_KIND_LABELS = {
  insight: "洞察",
  question: "问题",
  decision: "决定",
  action: "行动"
} as const satisfies Partial<Record<DailyReflectionWorkingCardKind, string>>;

type ProductCardKind = keyof typeof FILTER_KIND_LABELS;
type ConfirmAction = "discard" | "remove" | "revoke";
type ExpansionPhase = "opening" | "open" | "closing";
type Rect = Readonly<{ height: number; left: number; top: number; width: number }>;
type CardExpansion = Readonly<{
  cardId: string;
  origin: Rect | null;
  phase: ExpansionPhase;
  target: Rect;
}>;
type CardExpansionStyle = CSSProperties & Readonly<{
  "--card-expansion-origin-transform": string;
}>;
type CardMemoryFeedback = Readonly<{
  message: string;
  tone: "error" | "notice" | "success";
  reasons?: string[];
}>;
type PendingMemoryAdmission = Readonly<{
  expectedVersion: number;
  proposalId: string;
}>;
type CardMemoryConfirmation = Readonly<{
  requirements: DailyReflectionMemoryProposalConfirmationRequirement[];
  selected: DailyReflectionMemoryProposalAcknowledgement[];
}>;

type DailyReflectionCardLibraryProps = Readonly<{
  api?: DailyReflectionApi;
  embedded?: boolean;
  initialCardId?: string | null;
  now?: () => Date;
}>;

const STATUS_LABELS: Record<DailyReflectionWorkingCardStatus, string> = {
  generated: "等待保存",
  review_pending: "稍后再看",
  saved: "你的卡片",
  archived: "已归档",
  removed: "已从卡片库移除"
};
const OVERLAY_HISTORY_KEY = "__dailyReflectionCardOverlay";
const defaultNow = () => new Date();

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function presentationKind(kind: DailyReflectionWorkingCardKind): ProductCardKind {
  if (kind === "question" || kind === "decision" || kind === "action") return kind;
  return "insight";
}

function memoryTypeForWorkingCard(
  kind: DailyReflectionWorkingCardKind,
  actionClaimed = false
): DailyReflectionMemoryProposalCreateRequest["memoryType"] | null {
  switch (kind) {
    case "idea":
    case "insight": return "summary";
    case "question": return "question";
    case "decision": return "decision";
    case "event": return "event";
    case "action": return actionClaimed ? "commitment" : null;
  }
}

const POLICY_REASON_LABELS: Record<string, string> = {
  card_not_saved: "卡片尚未保存或已归档、移除",
  source_unavailable: "原始来源不可用",
  canonical_evidence_invalid: "原话依据未通过核对",
  action_not_claimed: "这项行动尚未由你认领",
  existing_person_path_required: "当前不支持将这张卡片保存为人物事实",
  subject_person_not_confirmed: "尚未确认内容对应的人物",
  fact_epistemic_status_not_explicit: "内容并非明确陈述，不能作为事实保存",
  summary_score_below_threshold: "未达到当时的长期记忆评估标准"
};

function proposalFeedback(proposal: NonNullable<DailyReflectionWorkingCardMemoryLookupResponse["proposal"]>): CardMemoryFeedback {
  return {
    message: proposal.status === "rejected"
      ? "未通过长期记忆审核；卡片本身仍会保留。"
      : proposal.status === "admitted"
        ? "已接纳，正在等待完成发布；暂不可作为长期记忆读取。"
        : proposal.status === "approved"
          ? "已通过审核，尚未加入长期记忆。"
          : "待审核或确认，尚未加入长期记忆。",
    tone: "notice",
    reasons: proposal.status === "rejected" ? proposal.reasons : []
  };
}

function memoryConfirmationCopy(
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
      return "这条内容的归属还需要先在复盘中确认；确认前不会加入长期记忆。";
  }
}

function isAcknowledgementRequirement(
  requirement: DailyReflectionMemoryProposalConfirmationRequirement
): requirement is DailyReflectionMemoryProposalConfirmationRequirement & {
  code: DailyReflectionMemoryProposalAcknowledgement;
  resolution: "acknowledgement";
} {
  return requirement.resolution === "acknowledgement"
    && requirement.code !== "verify_fact_owner";
}

function CardMemoryAction({
  busy,
  card,
  compact = false,
  confirmation,
  feedback,
  onConfirm,
  onOpenConfirmation,
  onRemember,
  onToggleConfirmation,
  lookup
}: Readonly<{
  busy: boolean;
  card: DailyReflectionWorkingCardView;
  compact?: boolean;
  lookup?: DailyReflectionWorkingCardMemoryLookupResponse;
  confirmation?: CardMemoryConfirmation;
  feedback?: CardMemoryFeedback;
  onConfirm: (acknowledgements: DailyReflectionMemoryProposalAcknowledgement[]) => void;
  onOpenConfirmation?: () => void;
  onRemember: (card: DailyReflectionWorkingCardView) => void;
  onToggleConfirmation: (
    acknowledgement: DailyReflectionMemoryProposalAcknowledgement,
    selected: boolean
  ) => void;
}>) {
  const [confirming, setConfirming] = useState(false);
  if (card.status !== "saved") return null;
  if (card.sourceUnavailable || card.evidenceIds.length === 0) {
    return <div className={styles.cardMemoryAction}><span>来源不可用，无法长期记住</span></div>;
  }
  if (card.memoryLifecycleStatus === "active" && !lookup) {
    return <div className={styles.cardMemoryAction}>
      <span>已接纳，打开卡片核对发布状态</span>
      {onOpenConfirmation ? <button className={styles.textButton} onClick={onOpenConfirmation} type="button">查看长期记忆状态</button> : null}
    </div>;
  }
  if (card.memoryLifecycleStatus === "active"
    && lookup?.proposal?.status === "admitted" && lookup.publicationStatus === "published" && !lookup.revoked) {
    return <div className={styles.cardMemoryAction}><span role="status">已长期记住</span></div>;
  }
  if (card.memoryLifecycleStatus === "revocation_requested") {
    return <div className={styles.cardMemoryAction}><span role="status">正在撤销长期记忆</span></div>;
  }
  if (card.memoryLifecycleStatus === "revoked" || lookup?.revoked || lookup?.publicationStatus === "deleted") {
    return <div className={styles.cardMemoryAction}><span role="status">已撤销长期记忆</span></div>;
  }
  if (card.cardKind === "action" && !lookup?.actionClaimed) {
    return (
      <div className={styles.cardMemoryAction} data-tone="notice">
        <button className={styles.secondaryButton} disabled type="button">长期记住</button>
        <span>{compact ? "打开卡片核对行动认领状态" : "先在复盘中明确认领这项行动后，才能长期记住"}</span>
        {compact && onOpenConfirmation ? <button className={styles.textButton} onClick={onOpenConfirmation} type="button">打开卡片核对</button> : null}
      </div>
    );
  }
  if (memoryTypeForWorkingCard(card.cardKind, lookup?.actionClaimed) === null) return null;
  const acknowledgementRequirements = confirmation?.requirements.filter(
    isAcknowledgementRequirement
  ) ?? [];
  const ownerVerificationRequired = confirmation?.requirements.some(
    (requirement) => requirement.resolution === "verified_owner"
  ) ?? false;
  const allAcknowledged = acknowledgementRequirements.every(
    (requirement) => confirmation?.selected.includes(requirement.code)
  );
  if (confirmation && compact) {
    return (
      <div className={styles.cardMemoryAction} data-tone="notice">
        <span>{ownerVerificationRequired ? "需要先确认内容归属" : "需要确认后才能长期记住"}</span>
        {onOpenConfirmation ? (
          <button
            className={styles.textButton}
            disabled={busy}
            onClick={onOpenConfirmation}
            type="button"
          >打开卡片确认</button>
        ) : null}
        {feedback ? (
          <span role={feedback.tone === "error" ? "alert" : "status"}>
            {feedback.message}
            {feedback.reasons?.map((reason) => <span key={reason}> {POLICY_REASON_LABELS[reason] ?? "未满足长期记忆条件"}（{reason}）</span>)}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <div className={styles.cardMemoryAction} data-tone={feedback?.tone}>
      {confirmation ? (
        <fieldset className={styles.cardMemoryConfirmation}>
          <legend>长期记住前再确认</legend>
          {confirmation.requirements.map((requirement) => isAcknowledgementRequirement(requirement) ? (
            <label key={requirement.code}>
              <input
                checked={confirmation.selected.includes(requirement.code)}
                disabled={busy || ownerVerificationRequired}
                onChange={(event) => onToggleConfirmation(
                  requirement.code,
                  event.currentTarget.checked
                )}
                type="checkbox"
              />
              <span>{memoryConfirmationCopy(requirement)}</span>
            </label>
          ) : (
            <p key={requirement.code}>{memoryConfirmationCopy(requirement)}</p>
          ))}
          {!ownerVerificationRequired ? (
            <button
              className={styles.secondaryButton}
              disabled={busy || !allAcknowledged}
              onClick={() => onConfirm(confirmation.selected)}
              type="button"
            >{busy ? "正在长期记住…" : "确认并长期记住"}</button>
          ) : null}
        </fieldset>
      ) : confirming ? (
        <div className={styles.cardMemoryConfirmation}>
          <p>确认将“{card.title}”加入长期记忆？通过审核并保存后，可在长期记忆中读取和检索；你可以撤销。</p>
          <button className={styles.textButton} disabled={busy} onClick={() => setConfirming(false)} type="button">先只保留卡片</button>
          <button className={styles.secondaryButton} disabled={busy} onClick={() => {
            setConfirming(false);
            onRemember(card);
          }} type="button">确认长期记住</button>
        </div>
      ) : (
        <button
          aria-label={`长期记住：${card.title}`}
          className={styles.secondaryButton}
          disabled={busy}
          onClick={() => setConfirming(true)}
          type="button"
        >
          {busy ? "正在长期记住…" : "长期记住"}
        </button>
      )}
      {feedback ? (
        <span role={feedback.tone === "error" ? "alert" : "status"}>
          {feedback.message}
            {feedback.reasons?.map((reason) => <span key={reason}> {POLICY_REASON_LABELS[reason] ?? "未满足长期记忆条件"}（{reason}）</span>)}
        </span>
      ) : null}
    </div>
  );
}

function CardKindIcon({ kind }: Readonly<{ kind: ProductCardKind }>) {
  if (kind === "question") {
    return <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M9.8 9.5a2.4 2.4 0 0 1 4.6 1c0 1.8-2.4 2-2.4 3.6" /><path d="M12 17.2h.01" /></svg>;
  }
  if (kind === "decision") {
    return <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12 2.3 2.3 4.8-5" /></svg>;
  }
  if (kind === "action") {
    return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 5.5 17 12 7 18.5Z" /></svg>;
  }
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8.5 14.5c-1.2-1-2-2.5-2-4.1a5.5 5.5 0 0 1 11 0c0 1.7-.8 3.2-2.1 4.2-.8.6-1.1 1.2-1.2 2H9.8c-.1-.8-.5-1.5-1.3-2.1Z" /><path d="M9.8 19h4.4" /></svg>;
}

function rectFromElement(element: HTMLElement | null): Rect | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { height: rect.height, left: rect.left, top: rect.top, width: rect.width };
}

function targetRect(): Rect {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const mobile = viewportWidth <= 620;
  const horizontalMargin = mobile ? 14 : 32;
  const verticalMargin = mobile ? 14 : 54;
  const width = Math.min(mobile ? viewportWidth - 28 : 820, viewportWidth - horizontalMargin * 2);
  const maxHeight = Math.min(
    mobile ? viewportHeight * 0.87 : viewportHeight * 0.76,
    viewportHeight - verticalMargin * 2
  );
  const height = Math.max(Math.min(maxHeight, mobile ? 720 : 640), Math.min(420, maxHeight));
  return {
    height,
    left: Math.max(horizontalMargin, (viewportWidth - width) / 2),
    top: Math.max(verticalMargin, (viewportHeight - height) / 2),
    width
  };
}

function originTransform(origin: Rect, target: Rect) {
  const scaleX = origin.width / target.width;
  const scaleY = origin.height / target.height;
  return `translate3d(${origin.left - target.left}px, ${origin.top - target.top}px, 0) scale(${scaleX}, ${scaleY})`;
}

function fallbackOrigin(target: Rect): Rect {
  return {
    height: target.height * 0.9,
    left: target.left + target.width * 0.04,
    top: target.top + target.height * 0.05,
    width: target.width * 0.92
  };
}

function cardIdFromPathname(pathname: string) {
  const match = /^\/reflection\/cards\/([^/]+)\/?$/u.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function DailyReflectionCardLibrary({
  api: providedApi,
  embedded = false,
  initialCardId = null,
  now = defaultNow
}: DailyReflectionCardLibraryProps) {
  const api = useMemo(() => providedApi ?? createDailyReflectionApi(), [providedApi]);
  const dialogId = useId();
  const dialogTitleId = useId();
  const cardTabsId = useId();
  const [cards, setCards] = useState<DailyReflectionWorkingCardView[]>([]);
  const [total, setTotal] = useState(0);
  const [countsComplete, setCountsComplete] = useState(false);
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [cardKind, setCardKind] = useState<ProductCardKind | "">("");
  const [status, setStatus] = useState<"saved" | "archived" | "removed">("saved");
  const [timeRange, setTimeRange] = useState<"all" | "30d">("all");
  const [sort, setSort] = useState<"updated_desc" | "created_desc" | "created_asc" | "title_asc">("updated_desc");
  const [selected, setSelected] = useState<DailyReflectionWorkingCardDetailResponse | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [contentDraft, setContentDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [editing, setEditing] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [expansion, setExpansion] = useState<CardExpansion | null>(null);
  const [listBusyCardId, setListBusyCardId] = useState<string | null>(null);
  const [memoryBusyCardId, setMemoryBusyCardId] = useState<string | null>(null);
  const [memoryLookups, setMemoryLookups] = useState<Record<string, DailyReflectionWorkingCardMemoryLookupResponse>>({});
  const [memoryFeedback, setMemoryFeedback] = useState<Record<string, CardMemoryFeedback>>({});
  const [memoryConfirmations, setMemoryConfirmations] = useState<
    Record<string, CardMemoryConfirmation>
  >({});
  const expansionRef = useRef<CardExpansion | null>(null);
  const dirtyRef = useRef(false);
  const detailControllerRef = useRef<AbortController | null>(null);
  const detailRequestVersionRef = useRef(0);
  const deepLinkSeededRef = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeNavigationRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const expansionCloseRef = useRef<HTMLButtonElement | null>(null);
  const filterCloseRef = useRef<HTMLButtonElement | null>(null);
  const filterTriggerRef = useRef<HTMLButtonElement | null>(null);
  const titleRefs = useRef(new Map<string, HTMLButtonElement>());
  const memoryBusyCardIdRef = useRef<string | null>(null);
  const pendingMemoryAdmissionsRef = useRef(new Map<string, PendingMemoryAdmission>());

  const dirty = Boolean(
    editing
    && selected
    && (titleDraft !== selected.card.title || contentDraft !== selected.card.content)
  );
  const expansionOpen = expansion !== null;
  dirtyRef.current = dirty;
  expansionRef.current = expansion;

  const visibleCards = useMemo(() => cardKind
    ? cards.filter((card) => presentationKind(card.cardKind) === cardKind)
    : cards, [cardKind, cards]);
  const kindCounts = useMemo(() => cards.reduce<Record<ProductCardKind, number>>((counts, card) => {
    counts[presentationKind(card.cardKind)] += 1;
    return counts;
  }, { action: 0, decision: 0, insight: 0, question: 0 }), [cards]);

  const loadCards = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const createdFrom = timeRange === "30d"
        ? new Date(now().getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString()
        : undefined;
      const result = await api.listWorkingCards({
        ...(query ? { query } : {}),
        ...(status ? { status } : {}),
        ...(createdFrom ? { createdFrom } : {}),
        sort,
        limit: 50,
        offset: 0
      }, signal);
      setCards(result.cards);
      setTotal(result.total);
      setCountsComplete(result.total <= result.cards.length);
    } catch (cause) {
      if (signal?.aborted) return;
      setError(cause instanceof Error ? cause.message : "卡片暂时无法加载。");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [api, now, query, sort, status, timeRange]);

  useEffect(() => {
    const controller = new AbortController();
    void loadCards(controller.signal);
    return () => controller.abort();
  }, [loadCards]);

  const openCard = useCallback(async (cardId: string) => {
    detailControllerRef.current?.abort();
    const controller = new AbortController();
    detailControllerRef.current = controller;
    const requestVersion = detailRequestVersionRef.current + 1;
    detailRequestVersionRef.current = requestVersion;
    setDetailLoading(true);
    setDetailError(null);
    setSelected(null);
    try {
      const result = await api.getWorkingCard(cardId, controller.signal);
      if (controller.signal.aborted || requestVersion !== detailRequestVersionRef.current) return;
      setSelected(result);
      setTitleDraft(result.card.title);
      setContentDraft(result.card.content);
      setEditing(false);
      // Proposal lookup must not delay reading or editing the saved Card.
      setDetailLoading(false);
      try {
        const lookup = await api.getWorkingCardMemoryProposal(cardId, controller.signal);
        if (controller.signal.aborted || requestVersion !== detailRequestVersionRef.current) return;
        setMemoryLookups((current) => ({ ...current, [cardId]: lookup }));
        if (lookup.proposal && (lookup.proposal.status !== "admitted" || lookup.publicationStatus !== "published")) {
          setMemoryFeedback((current) => ({ ...current, [cardId]: proposalFeedback(lookup.proposal!) }));
        }
      } catch {
        if (controller.signal.aborted || requestVersion !== detailRequestVersionRef.current) return;
        setMemoryFeedback((current) => ({ ...current, [cardId]: {
          message: "长期记忆状态暂时无法读取，请重新打开卡片重试。",
          tone: "error"
        } }));
      }
    } catch (cause) {
      if (controller.signal.aborted || requestVersion !== detailRequestVersionRef.current) return;
      setDetailError(cause instanceof Error ? cause.message : "卡片详情暂时无法加载。");
    } finally {
      if (!controller.signal.aborted && requestVersion === detailRequestVersionRef.current) setDetailLoading(false);
    }
  }, [api]);

  const beginExpansion = useCallback((
    cardId: string,
    originElement: HTMLElement | null,
    updateHistory: boolean,
    animate = true
  ) => {
    if (expansionRef.current?.cardId === cardId && expansionRef.current.phase !== "closing") {
      if (detailControllerRef.current?.signal.aborted) void openCard(cardId);
      return;
    }
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    const target = targetRect();
    const origin = rectFromElement(originElement);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const shouldAnimate = animate && !reducedMotion;
    setExpansion({ cardId, origin, phase: shouldAnimate ? "opening" : "open", target });
    void openCard(cardId);
    if (updateHistory) {
      window.history.pushState({ ...(window.history.state ?? {}), [OVERLAY_HISTORY_KEY]: cardId }, "", reflectionCardPath(cardId));
    }
    if (shouldAnimate) {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        setExpansion((current) => current?.cardId === cardId ? { ...current, phase: "open" } : current);
      }));
    }
  }, [openCard]);

  const finishClosing = useCallback((navigateAfter: boolean) => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    const closingCardId = expansionRef.current?.cardId ?? null;
    detailControllerRef.current?.abort();
    setExpansion(null);
    setSelected(null);
    setDetailError(null);
    setDetailLoading(false);
    setEditing(false);
    setConfirmAction(null);
    if (navigateAfter) {
      if (window.history.state?.[OVERLAY_HISTORY_KEY]) window.history.back();
      else window.history.replaceState(window.history.state ?? {}, "", "/reflection/cards");
    }
    window.requestAnimationFrame(() => {
      if (closingCardId) titleRefs.current.get(closingCardId)?.focus();
    });
  }, []);

  const beginClosing = useCallback((navigateAfter: boolean, animate = true) => {
    const current = expansionRef.current;
    if (!current || current.phase === "closing") return;
    closeNavigationRef.current = navigateAfter;
    const origin = rectFromElement(titleRefs.current.get(current.cardId)?.closest<HTMLElement>("[data-card-id]") ?? null) ?? current.origin;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reducedMotion || !animate) {
      finishClosing(navigateAfter);
      return;
    }
    setExpansion({ ...current, origin, phase: "closing" });
    closeTimerRef.current = setTimeout(() => finishClosing(navigateAfter), 340);
  }, [finishClosing]);

  const requestClose = useCallback((navigateAfter = true, animate = true) => {
    if (dirtyRef.current) {
      setConfirmAction("discard");
      return;
    }
    beginClosing(navigateAfter, animate);
  }, [beginClosing]);

  useEffect(() => {
    if (!initialCardId || deepLinkSeededRef.current) return;
    deepLinkSeededRef.current = true;
    const currentState = window.history.state ?? {};
    const alreadySeeded = currentState[OVERLAY_HISTORY_KEY] === initialCardId
      && cardIdFromPathname(window.location.pathname) === initialCardId;
    if (!alreadySeeded) {
      window.history.replaceState({ ...currentState }, "", "/reflection/cards");
      window.history.pushState({ ...currentState, [OVERLAY_HISTORY_KEY]: initialCardId }, "", reflectionCardPath(initialCardId));
    }
    beginExpansion(initialCardId, null, false);
    return () => {
      deepLinkSeededRef.current = false;
    };
  }, [beginExpansion, initialCardId]);

  useEffect(() => {
    const onPopState = () => {
      const nextCardId = cardIdFromPathname(window.location.pathname);
      const current = expansionRef.current;
      if (nextCardId) {
        if (current?.cardId !== nextCardId || current.phase === "closing") {
          beginExpansion(nextCardId, titleRefs.current.get(nextCardId)?.closest<HTMLElement>("[data-card-id]") ?? null, false);
        }
        return;
      }
      if (!current) return;
      if (dirtyRef.current) {
        window.history.pushState({ ...(window.history.state ?? {}), [OVERLAY_HISTORY_KEY]: current.cardId }, "", reflectionCardPath(current.cardId));
        setConfirmAction("discard");
        return;
      }
      beginClosing(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [beginClosing, beginExpansion]);

  useEffect(() => {
    if (!expansionOpen) return;
    const onResize = () => setExpansion((current) => current ? { ...current, target: targetRect() } : current);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [expansionOpen]);

  useEffect(() => {
    if (!expansionOpen) return;
    const body = document.body;
    const previousOverflow = body.style.overflow;
    const previousPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0 && scrollbarWidth < 64) body.style.paddingRight = `${scrollbarWidth}px`;
    const frame = window.requestAnimationFrame(() => expansionCloseRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose(true, false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex='-1'])"
      );
      if (!focusable?.length) return;
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
      document.removeEventListener("keydown", onKeyDown);
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPaddingRight;
    };
  }, [expansionOpen, requestClose]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  useEffect(() => () => {
    detailControllerRef.current?.abort();
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!filtersOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    filterCloseRef.current?.focus();
    const restoreFilterFocus = () => window.requestAnimationFrame(() => filterTriggerRef.current?.focus());
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setFiltersOpen(false);
        restoreFilterFocus();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = filterCloseRef.current?.closest<HTMLElement>("[role='dialog']");
      const focusable = panel?.querySelectorAll<HTMLElement>("button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])");
      if (!focusable?.length) return;
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
    window.addEventListener("keydown", closeOnKey);
    return () => {
      window.removeEventListener("keydown", closeOnKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [filtersOpen]);

  const saveEdits = async () => {
    const card = selected?.card;
    const title = titleDraft.normalize("NFKC").trim();
    const content = contentDraft.normalize("NFKC").trim();
    if (!card || !title || !content || busy) return;
    setBusy(true);
    setDetailError(null);
    try {
      const result = await api.updateWorkingCard(card.id, { expectedVersion: card.version, title, content });
      setSelected(result);
      setTitleDraft(result.card.title);
      setContentDraft(result.card.content);
      setEditing(false);
      await loadCards();
    } catch (cause) {
      if (cause instanceof DailyReflectionApiError && cause.status === 409) {
        await openCard(card.id);
        await loadCards();
        setDetailError("这张卡片已经在其他页面更新，已重新加载最新内容。");
      } else {
        setDetailError(cause instanceof Error ? cause.message : "卡片修改没有保存成功。");
      }
    } finally {
      setBusy(false);
    }
  };

  const applyLifecycle = async (operation: "archive" | "restore" | "remove") => {
    const card = selected?.card;
    if (!card || busy) return;
    setBusy(true);
    setDetailError(null);
    try {
      const input = { expectedVersion: card.version };
      const result = operation === "archive"
        ? await api.archiveWorkingCard(card.id, input)
        : operation === "restore"
          ? await api.restoreWorkingCard(card.id, input)
          : await api.removeWorkingCard(card.id, input);
      setSelected(result);
      await loadCards();
      if (operation === "remove") setConfirmAction(null);
    } catch (cause) {
      if (cause instanceof DailyReflectionApiError && cause.status === 409) {
        await openCard(card.id);
        await loadCards();
        setDetailError("这张卡片已经在其他页面更新，已重新加载最新内容。");
      } else {
        setDetailError(cause instanceof Error ? cause.message : "卡片状态没有更新成功。");
      }
    } finally {
      setBusy(false);
    }
  };

  const applyListLifecycle = async (card: DailyReflectionWorkingCardView, operation: "archive" | "restore") => {
    if (listBusyCardId) return;
    setListBusyCardId(card.id);
    setError(null);
    try {
      const input = { expectedVersion: card.version };
      if (operation === "archive") await api.archiveWorkingCard(card.id, input);
      else await api.restoreWorkingCard(card.id, input);
      await loadCards();
    } catch (cause) {
      if (cause instanceof DailyReflectionApiError && cause.status === 409) {
        await loadCards();
        setError("这张卡片已经在其他页面更新，已重新加载最新内容。");
      } else {
        setError(cause instanceof Error ? cause.message : "卡片状态没有更新成功。");
      }
    } finally {
      setListBusyCardId(null);
    }
  };

  const rememberCard = async (
    card: DailyReflectionWorkingCardView,
    acknowledgements: DailyReflectionMemoryProposalAcknowledgement[] = []
  ) => {
    const memoryType = memoryTypeForWorkingCard(card.cardKind, memoryLookups[card.id]?.actionClaimed);
    if (
      memoryBusyCardIdRef.current
      || card.status !== "saved"
      || (card.memoryLifecycleStatus !== "not_admitted"
        && !(card.memoryLifecycleStatus === "active" && memoryLookups[card.id]?.publicationStatus === "unpublished"))
      || memoryLookups[card.id]?.revoked
      || memoryLookups[card.id]?.publicationStatus === "deleted"
      || card.sourceUnavailable
      || card.evidenceIds.length === 0
      || memoryType === null
    ) return;
    memoryBusyCardIdRef.current = card.id;
    setMemoryBusyCardId(card.id);
    setMemoryFeedback((current) => {
      const next = { ...current };
      delete next[card.id];
      return next;
    });
    try {
      let pending = pendingMemoryAdmissionsRef.current.get(card.id);
      let evaluation: Awaited<ReturnType<DailyReflectionApi["evaluateMemoryProposal"]>> | undefined;
      if (!pending) {
        const created = await api.createWorkingCardMemoryProposal(card.id, {
          expectedCardVersion: card.version,
          memoryType
        });
        if (created.proposal.status !== "admitted") {
          setMemoryFeedback((current) => ({ ...current, [card.id]: proposalFeedback(created.proposal) }));
          evaluation = await api.evaluateMemoryProposal(created.proposal.id, {
            expectedVersion: created.proposal.version
          });
          setMemoryFeedback((current) => ({ ...current, [card.id]: proposalFeedback(evaluation!.proposal) }));
        }
        pending = {
          expectedVersion: evaluation?.proposal.version ?? created.proposal.version,
          proposalId: created.proposal.id
        };
        pendingMemoryAdmissionsRef.current.set(card.id, pending);
      }
      const result = evaluation && evaluation.status !== "approved"
        ? evaluation
        : await api.admitMemoryProposal(pending.proposalId, {
        expectedVersion: pending.expectedVersion,
        acknowledgements
      });
      if (result.status === "admitted" || result.status === "already_exists") {
        // The existing admit endpoint returns these receipts only after publication.
        setMemoryLookups((current) => ({ ...current, [card.id]: {
          proposal: result.proposal,
          publicationStatus: "published",
          revoked: false,
          actionClaimed: result.proposal.actionClaimed
        } }));
        pendingMemoryAdmissionsRef.current.delete(card.id);
        setMemoryConfirmations((current) => {
          const next = { ...current };
          delete next[card.id];
          return next;
        });
        setMemoryFeedback((current) => ({
          ...current,
          [card.id]: { message: "已长期记住", tone: "success" }
        }));
      } else if (result.status === "needs_confirmation") {
        pendingMemoryAdmissionsRef.current.set(card.id, {
          expectedVersion: result.proposal.version,
          proposalId: result.proposal.id
        });
        setMemoryConfirmations((current) => ({
          ...current,
          [card.id]: {
            requirements: result.confirmationRequirements,
            selected: current[card.id]?.selected.filter((item) =>
              result.confirmationRequirements.some((requirement) => requirement.code === item)
            ) ?? []
          }
        }));
        setMemoryFeedback((current) => ({
          ...current,
          [card.id]: {
            message: "还需要你明确确认，确认前不会加入长期记忆。",
            tone: "notice"
          }
        }));
      } else if (result.status === "rejected") {
        pendingMemoryAdmissionsRef.current.delete(card.id);
        setMemoryConfirmations((current) => {
          const next = { ...current };
          delete next[card.id];
          return next;
        });
        setMemoryFeedback((current) => ({
          ...current,
          [card.id]: {
            ...proposalFeedback(result.proposal),
            reasons: result.reasons
          }
        }));
      } else {
        setMemoryFeedback((current) => ({
          ...current,
          [card.id]: {
            message: "长期记忆还没有完成保存，请重试",
            tone: "error"
          }
        }));
      }
      const refreshDetail = expansionRef.current?.cardId === card.id;
      await Promise.all([
        loadCards(),
        refreshDetail ? openCard(card.id) : Promise.resolve()
      ]);
    } catch (cause) {
      if (cause instanceof DailyReflectionApiError && cause.status === 409) {
        pendingMemoryAdmissionsRef.current.delete(card.id);
        setMemoryConfirmations((current) => {
          const next = { ...current };
          delete next[card.id];
          return next;
        });
        const refreshDetail = expansionRef.current?.cardId === card.id;
        await Promise.all([
          loadCards(),
          refreshDetail ? openCard(card.id) : Promise.resolve()
        ]);
        setMemoryFeedback((current) => ({
          ...current,
          [card.id]: {
            message: cause.code === "version_conflict"
              ? "这张卡片已经在其他页面更新，已重新加载最新内容。"
              : cause.message,
            tone: "error"
          }
        }));
      } else {
        setMemoryFeedback((current) => ({
          ...current,
          [card.id]: {
            message: cause instanceof Error
              ? cause.message
              : "长期记忆还没有完成保存，请重试。",
            tone: "error"
          }
        }));
      }
    } finally {
      if (memoryBusyCardIdRef.current === card.id) {
        memoryBusyCardIdRef.current = null;
        setMemoryBusyCardId(null);
      }
    }
  };

  const toggleMemoryConfirmation = (
    cardId: string,
    acknowledgement: DailyReflectionMemoryProposalAcknowledgement,
    selected: boolean
  ) => {
    setMemoryConfirmations((current) => {
      const confirmation = current[cardId];
      if (!confirmation) return current;
      const nextSelected = selected
        ? [...new Set([...confirmation.selected, acknowledgement])]
        : confirmation.selected.filter((item) => item !== acknowledgement);
      return {
        ...current,
        [cardId]: { ...confirmation, selected: nextSelected }
      };
    });
  };

  const revokeMemorySource = async () => {
    const card = selected?.card;
    if (!card || busy || (card.memoryLifecycleStatus !== "active" && card.memoryLifecycleStatus !== "revocation_requested")) return;
    setBusy(true);
    setDetailError(null);
    try {
      let expectedMemoryLifecycleVersion = card.memoryLifecycleVersion;
      if (card.memoryLifecycleStatus === "revocation_requested") {
        const recovery = await api.getWorkingCardMemoryRevocation(card.id);
        if (!recovery.found) throw new Error("撤销进度无法恢复，请重新加载后再试。");
        expectedMemoryLifecycleVersion = recovery.result.operation.requestedMemoryLifecycleVersion;
      }
      await api.revokeWorkingCardMemory(card.id, {
        expectedMemoryLifecycleVersion,
        idempotencyKey: `daily-reflection-card-revoke:${card.id}:v${expectedMemoryLifecycleVersion}`
      });
      const refreshed = await api.getWorkingCard(card.id);
      setSelected(refreshed);
      await loadCards();
      setConfirmAction(null);
    } catch (cause) {
      if (cause instanceof DailyReflectionApiError && cause.status === 409) {
        await openCard(card.id);
        await loadCards();
        setDetailError("这张卡片已经在其他页面更新，已重新加载最新内容。");
      } else {
        setDetailError(cause instanceof Error ? cause.message : "这条长期记忆暂时没有撤销成功。");
      }
    } finally {
      setBusy(false);
    }
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setQuery(queryDraft.normalize("NFKC").trim());
  };
  const openFromTitle = (event: ReactMouseEvent<HTMLButtonElement>, cardId: string) => {
    beginExpansion(cardId, event.currentTarget.closest<HTMLElement>("[data-card-id]"), true, event.detail !== 0);
  };
  const moveCardKindFocus = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    const tabs = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role='tab']") ?? []
    );
    if (tabs.length === 0) return;
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    tabs[nextIndex]?.focus();
    tabs[nextIndex]?.click();
  };

  const selectedCard = selected?.card;
  const selectedSummary = cards.find((card) => card.id === expansion?.cardId);
  const expandedTitle = selectedCard?.title ?? selectedSummary?.title ?? "正在打开卡片";
  const expandedKind = presentationKind(selectedCard?.cardKind ?? selectedSummary?.cardKind ?? "insight");
  const expansionOrigin = expansion ? expansion.origin ?? fallbackOrigin(expansion.target) : null;
  const expandedStyle = expansion && expansionOrigin ? {
    "--card-expansion-origin-transform": originTransform(expansionOrigin, expansion.target),
    height: `${expansion.target.height}px`,
    left: `${expansion.target.left}px`,
    top: `${expansion.target.top}px`,
    width: `${expansion.target.width}px`
  } satisfies CardExpansionStyle : undefined;

  const expandedDetail = (
    <>
      <header className={styles.cardExpansionHeader}>
        <div>
          <span className={styles.cardKindMark} data-kind={expandedKind}><CardKindIcon kind={expandedKind} />{FILTER_KIND_LABELS[expandedKind]}</span>
          <h2 className={styles.cardExpansionTitle} id={dialogTitleId}>
            <button aria-label={`收起卡片：${expandedTitle}`} onClick={(event) => requestClose(true, event.detail !== 0)} type="button">{expandedTitle}</button>
          </h2>
        </div>
        <button aria-label="关闭卡片详情" className={styles.cardExpansionClose} onClick={(event) => requestClose(true, event.detail !== 0)} ref={expansionCloseRef} type="button">×</button>
      </header>
      {detailLoading ? (
        <div className={styles.cardExpansionSkeleton} role="status"><span /><span /><span /><p>正在读取完整内容…</p></div>
      ) : !selectedCard ? (
        <div className={styles.productEmpty}>
          <h3>这张卡片暂时无法打开</h3><p>{detailError ?? "它可能已被移除，或当前无法读取。"}</p>
          {expansion ? <button className={styles.secondaryButton} onClick={() => void openCard(expansion.cardId)} type="button">重新尝试</button> : null}
        </div>
      ) : (
        <div className={styles.cardExpansionContent}>
          <div className={styles.cardExpansionStatusLine}><span>{STATUS_LABELS[selectedCard.status]}</span><span>{selectedCard.evidence.length} 段来源</span><span>更新于 {formatTime(selectedCard.updatedAt)}</span></div>
          {detailError ? <p className={styles.inlineError} role="alert">{detailError}</p> : null}
          {editing ? (
            <div className={styles.cardDetailEditor}>
              <label className={styles.candidateEditor}><span>标题</span><input aria-label="编辑卡片标题" disabled={busy || selectedCard.status === "removed"} maxLength={240} onChange={(event) => setTitleDraft(event.target.value)} value={titleDraft} /></label>
              <label className={styles.candidateEditor}><span>正文</span><textarea aria-label="编辑卡片正文" disabled={busy || selectedCard.status === "removed"} maxLength={20_000} onChange={(event) => setContentDraft(event.target.value)} rows={9} value={contentDraft} /></label>
              <div className={styles.reviewEditActions}>
                <button className={styles.textButton} disabled={busy} onClick={() => { setTitleDraft(selectedCard.title); setContentDraft(selectedCard.content); setEditing(false); }} type="button">取消</button>
                <button className={styles.primaryButton} disabled={busy || !titleDraft.trim() || !contentDraft.trim()} onClick={() => void saveEdits()} type="button">保存修改</button>
              </div>
            </div>
          ) : (
            <section className={styles.cardExpansionReading}>
              <p>{selectedCard.content}</p>
              {selectedCard.status !== "removed" ? <button className={styles.secondaryButton} onClick={() => setEditing(true)} type="button">编辑卡片</button> : null}
              <CardMemoryAction
                busy={busy || memoryBusyCardId === selectedCard.id}
                key={selectedCard.id}
                card={selectedCard}
                lookup={memoryLookups[selectedCard.id]}
                confirmation={memoryConfirmations[selectedCard.id]}
                feedback={memoryFeedback[selectedCard.id]}
                onConfirm={(acknowledgements) => void rememberCard(
                  selectedCard,
                  acknowledgements
                )}
                onRemember={(card) => void rememberCard(card)}
                onToggleConfirmation={(acknowledgement, checked) =>
                  toggleMemoryConfirmation(selectedCard.id, acknowledgement, checked)}
              />
            </section>
          )}
          <dl className={styles.cardLibraryDefinitionList}>
            <div><dt>创建时间</dt><dd>{formatTime(selectedCard.createdAt)}</dd></div>
            <div><dt>长期记忆</dt><dd>{selectedCard.memoryLifecycleStatus === "active" ? (memoryLookups[selectedCard.id]?.publicationStatus === "published" && !memoryLookups[selectedCard.id]?.revoked ? "已长期记住" : "已接纳，发布待确认") : selectedCard.memoryLifecycleStatus === "revocation_requested" ? "正在撤销" : selectedCard.memoryLifecycleStatus === "revoked" ? "已撤销" : "暂未长期保存"}</dd></div>
            <div><dt>来源</dt><dd>{selectedCard.sourceUnavailable ? "原始复盘已不可用" : selectedCard.sourceReflectionIds.map((reflectionId, index) => <Link href={reflectionSessionPath(reflectionId)} key={reflectionId}>{selectedCard.sourceReflectionIds.length === 1 ? "查看来源复盘" : `查看来源复盘 ${index + 1}`}</Link>)}</dd></div>
          </dl>
          <details className={styles.progressivePanel}>
            <summary>查看来源 · {selectedCard.evidence.length} 段</summary>
            {selectedCard.sourceUnavailable ? <p className={styles.evidenceUnavailable}>原始来源已不可用；卡片仍然保留，但不会伪装成仍可核对。</p> : (
              <ol className={styles.evidenceList}>{selectedCard.evidence.map((evidence) => <li key={evidence.sourceSegmentId}><p>{evidence.text}</p><small>{evidence.effectiveOrigin === "user_reflection" ? "自己的复盘原话" : "真实交流原话"} · {Math.floor(evidence.startSeconds / 60)}:{String(Math.floor(evidence.startSeconds % 60)).padStart(2, "0")}</small>{selectedCard.sourceReflectionIds.length === 1 ? <Link className={styles.textButton} href={`${reflectionSessionPath(selectedCard.sourceReflectionIds[0]!)}?segment=${encodeURIComponent(evidence.sourceSegmentId)}`}>在完整文字记录中查看</Link> : null}</li>)}</ol>
            )}
          </details>
          <details className={`${styles.progressivePanel} ${styles.assetManagement}`}>
            <summary>管理这张卡片</summary>
            <div className={styles.candidateActions}>
              {selectedCard.memoryLifecycleStatus === "active" || selectedCard.memoryLifecycleStatus === "revocation_requested" ? <button className={styles.dangerButton} disabled={busy} onClick={() => setConfirmAction("revoke")} type="button">撤销这条记忆</button> : null}
              {selectedCard.status === "saved" ? <button className={styles.secondaryButton} disabled={busy} onClick={() => void applyLifecycle("archive")} type="button">归档</button> : null}
              {selectedCard.status === "archived" || selectedCard.status === "removed" ? <button className={styles.primaryButton} disabled={busy} onClick={() => void applyLifecycle("restore")} type="button">恢复</button> : null}
              {selectedCard.status === "saved" || selectedCard.status === "archived" ? <button className={styles.dangerButton} disabled={busy} onClick={() => setConfirmAction("remove")} type="button">从卡片库移除</button> : null}
            </div>
          </details>
        </div>
      )}
    </>
  );

  return (
    <div className={embedded ? styles.embeddedRoot : styles.root}>
      <main aria-hidden={expansionOpen ? "true" : undefined} className={`${embedded ? styles.productPage : styles.page} ${styles.cardLibraryPage}`}>
        <section className={`${styles.productIntro} ${styles.cardLibraryIntro}`}>
          <div><p className={styles.eyebrow}>思想资产</p><h1>你的卡片</h1><p>记录灵感、决定与问题，让过去的思考能够继续使用。</p></div>
          <div className={styles.cardLibraryIntroAside}><span aria-live="polite">{error ? "读取失败" : loading ? "正在读取" : `${total} 张`}</span><Link href="/reflection/memory">查看长期记忆</Link></div>
        </section>

        <div className={styles.cardLibraryTools}>
          <div className={styles.cardTypeTabs} role="tablist" aria-label="卡片类型">
            <button aria-controls={`${cardTabsId}-panel`} aria-selected={cardKind === ""} id={`${cardTabsId}-all`} onClick={() => setCardKind("")} onKeyDown={(event) => moveCardKindFocus(event, 0)} role="tab" tabIndex={cardKind === "" ? 0 : -1} type="button">全部 <small>{total}</small></button>
            {Object.entries(FILTER_KIND_LABELS).map(([value, label], index) => <button aria-controls={`${cardTabsId}-panel`} aria-selected={cardKind === value} id={`${cardTabsId}-${value}`} key={value} onClick={() => setCardKind(value as ProductCardKind)} onKeyDown={(event) => moveCardKindFocus(event, index + 1)} role="tab" tabIndex={cardKind === value ? 0 : -1} type="button">{label}{countsComplete ? <small>{kindCounts[value as ProductCardKind]}</small> : null}</button>)}
          </div>
          <form className={styles.cardSearchBar} onSubmit={submitSearch}>
            <label><span className={styles.visuallyHidden}>搜索卡片</span><input aria-label="搜索卡片" maxLength={200} onChange={(event) => setQueryDraft(event.target.value)} placeholder="搜索卡片标题或内容…" value={queryDraft} /></label>
            <button className={styles.secondaryButton} type="submit">搜索</button>
            <label className={styles.cardSortControl}><span className={styles.visuallyHidden}>卡片排序</span><select aria-label="卡片排序" onChange={(event) => setSort(event.target.value as typeof sort)} value={sort}><option value="updated_desc">最近更新</option><option value="created_desc">最新创建</option><option value="created_asc">最早创建</option><option value="title_asc">按标题</option></select></label>
            <button aria-expanded={filtersOpen} className={styles.secondaryButton} onClick={() => setFiltersOpen(true)} ref={filterTriggerRef} type="button">筛选</button>
          </form>
        </div>

        {filtersOpen ? (
          <div className={styles.filterBackdrop} onMouseDown={(event) => {
            if (event.currentTarget === event.target) { setFiltersOpen(false); window.requestAnimationFrame(() => filterTriggerRef.current?.focus()); }
          }}>
            <section aria-labelledby="card-filter-title" aria-modal="true" className={styles.filterPanel} role="dialog">
              <div className={styles.filterPanelHeading}><div><p className={styles.eyebrow}>缩小范围</p><h2 id="card-filter-title">筛选卡片</h2></div><button aria-label="关闭筛选" className={styles.textButton} onClick={() => { setFiltersOpen(false); window.requestAnimationFrame(() => filterTriggerRef.current?.focus()); }} ref={filterCloseRef} type="button">关闭</button></div>
              <label><span>状态</span><select aria-label="按状态筛选" onChange={(event) => setStatus(event.target.value as typeof status)} value={status}><option value="saved">使用中</option><option value="archived">已归档</option><option value="removed">已移除</option></select></label>
              <label><span>时间</span><select aria-label="按时间筛选" onChange={(event) => setTimeRange(event.target.value as typeof timeRange)} value={timeRange}><option value="all">全部时间</option><option value="30d">最近 30 天</option></select></label>
              <label><span>排序</span><select aria-label="筛选面板卡片排序" onChange={(event) => setSort(event.target.value as typeof sort)} value={sort}><option value="updated_desc">最近更新</option><option value="created_desc">最新创建</option><option value="created_asc">最早创建</option><option value="title_asc">按标题</option></select></label>
              <button className={styles.primaryButton} onClick={() => { setFiltersOpen(false); window.requestAnimationFrame(() => filterTriggerRef.current?.focus()); }} type="button">应用筛选</button>
            </section>
          </div>
        ) : null}

        <section aria-labelledby={cardKind === "" ? `${cardTabsId}-all` : `${cardTabsId}-${cardKind}`} aria-live="polite" className={styles.cardLibraryList} id={`${cardTabsId}-panel`} role="tabpanel">
          <h2 className={styles.visuallyHidden} id="reflection-cards-title">卡片列表</h2>
          {loading ? (
            <ProductState description="正在找回你保存的思想资产。" title="正在读取卡片" tone="loading" />
          ) : error ? (
            <ProductState action={<button className={styles.secondaryButton} onClick={() => void loadCards()} type="button">重新尝试</button>} description="请稍后再试；已经保存的卡片不会受影响。" title="卡片暂时没有加载完成" tone="error" />
          ) : visibleCards.length === 0 ? (
            <div className={styles.productEmpty}><h3>这里还没有卡片</h3><p>完成一次复盘后，把真正想留下的重点保存到这里。</p><Link className={styles.primaryButton} href="/reflection/capture?new=1">开始讲述</Link></div>
          ) : (
            <ol className={styles.cardAssetGrid}>{visibleCards.map((card) => {
              const kind = presentationKind(card.cardKind);
              const expanded = expansion?.cardId === card.id;
              return <li key={card.id}><article className={styles.cardAsset} data-card-id={card.id} data-card-kind={kind} data-density={card.content.length > 140 ? "compact" : "standard"} data-expanded={expanded ? "true" : undefined} data-status={card.status}>
                <div className={styles.cardAssetTop}>
                  <span className={styles.cardKindMark} data-kind={kind}><CardKindIcon kind={kind} />{FILTER_KIND_LABELS[kind]}</span>
                   <details className={styles.cardAssetMenu}><summary aria-label={`更多操作：${card.title}`}>⋯</summary><div>{card.sourceReflectionIds[0] ? <Link href={reflectionSessionPath(card.sourceReflectionIds[0])}>查看来源复盘</Link> : null}{card.status === "saved" ? <button disabled={listBusyCardId === card.id} onClick={() => void applyListLifecycle(card, "archive")} type="button">归档</button> : null}{card.status === "archived" || card.status === "removed" ? <button disabled={listBusyCardId === card.id} onClick={() => void applyListLifecycle(card, "restore")} type="button">恢复</button> : null}</div></details>
                </div>
                <h3><button aria-controls={dialogId} aria-expanded={expanded} aria-label={`打开卡片：${card.title}`} onClick={(event) => openFromTitle(event, card.id)} ref={(node) => { if (node) titleRefs.current.set(card.id, node); else titleRefs.current.delete(card.id); }} type="button">{card.title}</button></h3>
                <p className={styles.cardExcerpt}>{card.content}</p>
                <CardMemoryAction
                  busy={listBusyCardId === card.id || memoryBusyCardId === card.id}
                  card={card}
                  compact
                  lookup={memoryLookups[card.id]}
                  confirmation={memoryConfirmations[card.id]}
                  feedback={memoryFeedback[card.id]}
                  onConfirm={(acknowledgements) => void rememberCard(card, acknowledgements)}
                  onOpenConfirmation={() => beginExpansion(
                    card.id,
                    titleRefs.current.get(card.id)?.closest<HTMLElement>("[data-card-id]") ?? null,
                    true
                  )}
                  onRemember={(target) => void rememberCard(target)}
                  onToggleConfirmation={(acknowledgement, checked) =>
                    toggleMemoryConfirmation(card.id, acknowledgement, checked)}
                />
                <div className={styles.cardLibraryMeta}><span>{STATUS_LABELS[card.status]}</span><span>{card.evidenceIds.length} 段来源</span><span>更新于 {formatTime(card.updatedAt)}</span></div>
              </article></li>;
            })}</ol>
          )}
          {total > cards.length ? <p className={styles.cardLibraryLimit}>当前显示最近 {cards.length} 张卡片。</p> : null}
        </section>
      </main>

      {expansion && expandedStyle ? <div className={styles.cardExpansionBackdrop} data-phase={expansion.phase} onMouseDown={(event) => { if (event.currentTarget === event.target) requestClose(true); }}>
        <div aria-labelledby={dialogTitleId} aria-modal="true" className={styles.cardExpansionCard} data-card-expansion={expansion.cardId} data-phase={expansion.phase} id={dialogId} onTransitionEnd={(event) => { if (event.currentTarget === event.target && event.propertyName === "transform" && expansionRef.current?.phase === "closing") finishClosing(closeNavigationRef.current); }} ref={dialogRef} role="dialog" style={expandedStyle} tabIndex={-1}>{expandedDetail}</div>
      </div> : null}

      <ReflectionConfirmDialog busy={busy} confirmLabel={confirmAction === "revoke" ? "确认撤销" : confirmAction === "remove" ? "确认移除" : "放弃并关闭"} onCancel={() => setConfirmAction(null)} onConfirm={() => {
        if (confirmAction === "revoke") void revokeMemorySource();
        if (confirmAction === "remove") void applyLifecycle("remove");
        if (confirmAction === "discard") {
          if (selectedCard) { setTitleDraft(selectedCard.title); setContentDraft(selectedCard.content); }
          setEditing(false); setConfirmAction(null); beginClosing(true);
        }
      }} open={confirmAction !== null} role="alertdialog" title={confirmAction === "revoke" ? "撤销这条长期记忆？" : confirmAction === "remove" ? "从卡片库移除？" : "放弃未保存的修改？"}>
        <p>{confirmAction === "revoke" ? "只撤销这张卡片对应的长期记忆。原始复盘和卡片仍会保留，你仍可查看来源。" : confirmAction === "remove" ? "卡片会从卡片库移除，但原始复盘不会删除。之后仍可恢复这张卡片。" : "你对标题或正文的修改还没有保存。放弃后，这些修改不会保留。"}</p>
        {detailError && confirmAction !== "discard" ? <p className={styles.inlineError} role="alert">{detailError}</p> : null}
      </ReflectionConfirmDialog>
    </div>
  );
}

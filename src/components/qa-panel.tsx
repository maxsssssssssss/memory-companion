"use client";

import { Fragment, type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ProactiveObservation, SuggestedQuestion } from "@/lib/client/proactive-qa-presentation";
import type { QaScopeMeta } from "@/lib/client/qa-scope-metadata";
import { formatTime } from "@/lib/domain/time";

type QaPanelProps = {
  uploadId?: string;
  isActive?: boolean;
  scope?: "current" | "week" | "all";
  referenceDate?: string;
  proactiveObservations?: ProactiveObservation[];
  suggestedQuestions?: SuggestedQuestion[];
  scopeMeta?: QaScopeMeta;
  onLocalQuestion?: (input: {
    question: string;
    conversation: ConversationMessage[];
    model: string;
    promptPresetId: QaPromptPresetId;
    customPrompt: string;
  }) => Promise<AnswerPayload>;
  loadQuestionHistory?: () => Promise<StoredAnswerPayload[]> | StoredAnswerPayload[];
  saveQuestionHistory?: (turn: ConversationTurn) => Promise<void> | void;
  includeLoadedHistoryInConversation?: boolean;
  emptyState?: {
    title: string;
    detail: string;
    placeholder: string;
    actions?: Array<{
      label: string;
      onClick: () => void;
    }>;
  };
};

type AnswerPayload = {
  answer: string;
  citedSegmentIds: string[];
  citations?: Array<{
    id: string;
    title: string;
    startSeconds: number;
    endSeconds: number;
    excerpt: string;
    sourceSegmentIds: string[];
  }>;
};

type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

type ConversationTurn = AnswerPayload & {
  id: string;
  question: string;
  createdAt?: string;
  isPending?: boolean;
  isRestored?: boolean;
};

type StoredAnswerPayload = Partial<AnswerPayload> & {
  id?: unknown;
  question?: unknown;
  createdAt?: unknown;
};

type QaModelPreset = {
  label: string;
  value: string;
};

type QaPromptPresetId = "work" | "date" | "negotiation" | "learning" | "casual" | "custom";

type QaPromptPreset = {
  id: QaPromptPresetId;
  label: string;
  description: string;
};

type QaScope = NonNullable<QaPanelProps["scope"]>;

type DisplaySuggestion = {
  id: string;
  question: string;
  helper: string;
};

function insightTypeLabel(insightType: ProactiveObservation["type"]) {
  if (insightType === "reminder" || insightType === "follow_up") {
    return "可以确认";
  }
  if (insightType === "pattern_observation") {
    return "值得关注";
  }
  return "一个小发现";
}

const MAX_CONTEXT_MESSAGES = 8;
const MAX_CONTEXT_MESSAGE_LENGTH = 1200;
const MAX_DISPLAYED_SUGGESTIONS = 3;
const DEFAULT_QA_MODEL = "openai/gpt-5-mini";

const scopeCopy: Record<
  QaScope,
  {
    title: string;
    description: string;
    placeholder: string;
    hint: string;
    loadingMessage: string;
    submitErrorMessage: string;
    unavailableMessage: string;
    suggestions: Array<{ question: string; helper: string }>;
  }
> = {
  current: {
    title: "问问这一天",
    description: "我会只根据这一天的录音回答，不确定的地方会直接说明。",
    placeholder: "问问这一天发生了什么...",
    hint: "基于当天证据",
    loadingMessage: "我在翻这一天的记录",
    submitErrorMessage: "这次没有答出来，可能是模型服务或记忆检索出了问题。已保存的录音数据不会因此丢失，你可以稍后再问。",
    unavailableMessage: "上传并处理完成后才能提问。",
    suggestions: [
      { question: "这一天最值得我记住的是什么？", helper: "先抓住今天最重要的线索" },
      { question: "有没有我答应了但还没推进的事？", helper: "检查承诺和待办" },
      { question: "今天有哪些关键决定需要回看？", helper: "带证据看决策来源" },
      { question: "今天有什么问题还没想清楚？", helper: "整理未决问题" }
    ]
  },
  week: {
    title: "问问这一周",
    description: "我会帮你把一周里的反复主题、推进和卡点串起来。",
    placeholder: "问问这一周反复出现的事...",
    hint: "基于本周记忆",
    loadingMessage: "我在把本周相关片段串起来",
    submitErrorMessage: "这次没有答出来，可能是模型服务或记忆检索出了问题。已保存的录音数据不会因此丢失，你可以稍后再问。",
    unavailableMessage: "本周还没有处理完成的录音。",
    suggestions: [
      { question: "这周反复出现的主题是什么？", helper: "把多天线索串起来" },
      { question: "这一周哪些事情一直没推进？", helper: "看卡点和停滞" },
      { question: "有没有我答应了但还没推进的事？", helper: "检查本周承诺" },
      { question: "这周有哪些卡点需要我处理？", helper: "定位阻塞和风险" }
    ]
  },
  all: {
    title: "问问全部记忆",
    description: "我会跨日期查找证据，但不会把没有证据的判断说成事实。",
    placeholder: "问问过去记录里的线索...",
    hint: "基于全部记忆",
    loadingMessage: "我在核对全部记忆，不乱猜",
    submitErrorMessage: "这次没有答出来，可能是模型服务或记忆检索出了问题。已保存的录音数据不会因此丢失，你可以稍后再问。",
    unavailableMessage: "还没有处理完成的历史录音。",
    suggestions: [
      { question: "我之前怎么想这个问题的？", helper: "回看过去表达和证据" },
      { question: "最近我在哪些事情上一直卡住？", helper: "寻找反复出现的阻塞" },
      { question: "哪些主题在过去反复出现？", helper: "看长期重复线索" },
      { question: "有没有长期没推进的承诺或问题？", helper: "检查沉淀下来的尾巴" }
    ]
  }
};

function AiIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M12 2a4 4 0 0 1 4 4v6a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4Z" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" />
    </svg>
  );
}

function referenceDateQuery(referenceDate?: string) {
  const normalizedReferenceDate = referenceDate?.trim();
  return normalizedReferenceDate ? `?referenceDate=${encodeURIComponent(normalizedReferenceDate)}` : "";
}

function endpointForScope(scope: QaScope, uploadId?: string, referenceDate?: string) {
  if (scope === "week") {
    return `/api/memory/week/qa${referenceDateQuery(referenceDate)}`;
  }

  if (scope === "all") {
    return "/api/memory/all/qa";
  }

  return uploadId ? `/api/days/${uploadId}/qa` : null;
}

function trimContextMessage(content: string) {
  const compacted = content.replace(/\s+/g, " ").trim();
  return compacted.length > MAX_CONTEXT_MESSAGE_LENGTH ? `${compacted.slice(0, MAX_CONTEXT_MESSAGE_LENGTH - 1)}…` : compacted;
}

function createAnswerTurnId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `qa_${crypto.randomUUID()}`;
  }

  return `qa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function conversationFromTurns(turns: ConversationTurn[], includeRestoredHistory: boolean): ConversationMessage[] {
  return turns
    .filter((turn) => !turn.isPending && (includeRestoredHistory || !turn.isRestored) && turn.question.trim() && turn.answer.trim())
    .flatMap((turn): ConversationMessage[] => [
      { role: "user", content: trimContextMessage(turn.question) },
      { role: "assistant", content: trimContextMessage(turn.answer) }
    ])
    .slice(-MAX_CONTEXT_MESSAGES);
}

function answerPayloadToTurn(answer: StoredAnswerPayload, fallbackQuestion: string, fallbackId: string): ConversationTurn | null {
  const question = typeof answer.question === "string" && answer.question.trim() ? answer.question.trim() : fallbackQuestion;

  if (typeof answer.answer !== "string" || !Array.isArray(answer.citedSegmentIds)) {
    return null;
  }

  return {
    id: typeof answer.id === "string" && answer.id ? answer.id : fallbackId,
    question,
    answer: answer.answer,
    citedSegmentIds: answer.citedSegmentIds,
    citations: Array.isArray(answer.citations) ? answer.citations : undefined,
    createdAt: typeof answer.createdAt === "string" ? answer.createdAt : undefined
  };
}

export function QaPanel({
  uploadId,
  isActive = true,
  scope = "current",
  referenceDate,
  proactiveObservations = [],
  suggestedQuestions = [],
  scopeMeta,
  onLocalQuestion,
  loadQuestionHistory,
  saveQuestionHistory,
  includeLoadedHistoryInConversation,
  emptyState
}: QaPanelProps) {
  const copy = scopeCopy[scope];
  const effectiveScopeMeta: QaScopeMeta = scopeMeta ?? {
    scope,
    label: copy.hint,
    description: copy.description
  };
  const isDataEmpty = Boolean(emptyState);
  const shouldIncludeLoadedHistoryInConversation = includeLoadedHistoryInConversation ?? !loadQuestionHistory;
  const activeProactiveObservations = proactiveObservations
    .filter((observation) => observation.scope === scope)
    .slice(0, MAX_DISPLAYED_SUGGESTIONS);
  const activeSuggestedQuestions = suggestedQuestions
    .filter((suggestion) => suggestion.scope === scope)
    .slice(0, MAX_DISPLAYED_SUGGESTIONS);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [qaModel, setQaModel] = useState(DEFAULT_QA_MODEL);
  const [qaModelPresets, setQaModelPresets] = useState<QaModelPreset[]>([]);
  const [isSavingModel, setIsSavingModel] = useState(false);
  const [modelMessage, setModelMessage] = useState("");
  const [qaPromptPresetId, setQaPromptPresetId] = useState<QaPromptPresetId>("work");
  const [qaPromptPresets, setQaPromptPresets] = useState<QaPromptPreset[]>([]);
  const [customQaPrompt, setCustomQaPrompt] = useState("");
  const [isSavingPrompt, setIsSavingPrompt] = useState(false);
  const [promptMessage, setPromptMessage] = useState("");
  const requestIdRef = useRef(0);
  const threadRef = useRef<HTMLDivElement>(null);
  const questionInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    requestIdRef.current += 1;
    setQuestion("");
    setTurns([]);
    setErrorMessage("");
    setIsSubmitting(false);
  }, [uploadId, scope, referenceDate, isDataEmpty]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread || turns.length === 0) {
      return;
    }
    thread.scrollTop = thread.scrollHeight;
  }, [turns]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    if (isDataEmpty) {
      setTurns([]);
      setErrorMessage("");
      setIsSubmitting(false);
      return;
    }

    if (loadQuestionHistory) {
      let isCancelled = false;
      const historyRequestId = requestIdRef.current;

      const fetchCustomHistory = async () => {
        try {
          const history = await loadQuestionHistory();

          if (isCancelled || historyRequestId !== requestIdRef.current) {
            return;
          }

          const restoredTurns = history.flatMap((answer, index) => {
            const turn = answerPayloadToTurn(answer, "", `history_${index}`);
            return turn ? [{ ...turn, isRestored: true }] : [];
          });
          setTurns(restoredTurns);
        } catch {
          if (!isCancelled && historyRequestId === requestIdRef.current) {
            setTurns([]);
          }
        }
      };

      void fetchCustomHistory();

      return () => {
        isCancelled = true;
      };
    }

    const endpoint = endpointForScope(scope, uploadId, referenceDate);
    if (onLocalQuestion) {
      setTurns([]);
      return;
    }

    if (!endpoint) {
      setTurns([]);
      return;
    }

    const controller = new AbortController();
    const historyRequestId = requestIdRef.current;

    const fetchHistory = async () => {
      try {
        const response = await fetch(endpoint, {
          cache: "no-store",
          signal: controller.signal
        });
        const payload = (await response.json()) as { answers?: StoredAnswerPayload[] };

        if (!response.ok || controller.signal.aborted || historyRequestId !== requestIdRef.current) {
          return;
        }

        const restoredTurns = (payload.answers ?? []).flatMap((answer, index) => {
          const turn = answerPayloadToTurn(answer, "", `history_${index}`);
          return turn ? [{ ...turn, isRestored: true }] : [];
        });
        setTurns(restoredTurns);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
      }
    };

    void fetchHistory();

    return () => {
      controller.abort();
    };
  }, [isActive, isDataEmpty, loadQuestionHistory, onLocalQuestion, scope, uploadId, referenceDate]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const controller = new AbortController();

    const fetchSettings = async () => {
      try {
        const response = await fetch("/api/settings", {
          cache: "no-store",
          signal: controller.signal
        });
        const settings = (await response.json()) as {
          qaModel?: string;
          qaModelPresets?: QaModelPreset[];
          qaPromptPresetId?: QaPromptPresetId;
          qaPromptPresets?: QaPromptPreset[];
          customQaPrompt?: string;
        };

        if (!response.ok || controller.signal.aborted) {
          return;
        }

        const presets = settings.qaModelPresets ?? [];
        setQaModelPresets(presets);
        setQaModel(settings.qaModel ?? presets[0]?.value ?? DEFAULT_QA_MODEL);
        setQaPromptPresets(settings.qaPromptPresets ?? []);
        setQaPromptPresetId(settings.qaPromptPresetId ?? "work");
        setCustomQaPrompt(settings.customQaPrompt ?? "");
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        setModelMessage("读取模型配置失败。");
      }
    };

    void fetchSettings();

    return () => {
      controller.abort();
    };
  }, [isActive]);

  async function submitQuestion(nextQuestion: string) {
    const normalizedQuestion = nextQuestion.trim();

    if (!normalizedQuestion) {
      return;
    }

    if (isDataEmpty) {
      setErrorMessage("");
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (scope === "current" && !uploadId) {
      setErrorMessage(copy.unavailableMessage);
      return;
    }

    const useLocalQuestionHandler = Boolean(onLocalQuestion);
    const endpoint = endpointForScope(scope, uploadId, referenceDate);
    if (!useLocalQuestionHandler && !endpoint) {
      setErrorMessage(copy.unavailableMessage);
      return;
    }

    const pendingTurnId = `pending_${requestId}`;
    const conversation = conversationFromTurns(turns, shouldIncludeLoadedHistoryInConversation);
    setErrorMessage("");
    setIsSubmitting(true);
    setQuestion("");
    setTurns((currentTurns) => [
      ...currentTurns,
      {
        id: pendingTurnId,
        question: normalizedQuestion,
        answer: "",
        citedSegmentIds: [],
        isPending: true
      }
    ]);

    try {
      const payload = useLocalQuestionHandler
        ? await onLocalQuestion!({
            question: normalizedQuestion,
            conversation,
            model: qaModel,
            promptPresetId: qaPromptPresetId,
            customPrompt: customQaPrompt
          })
        : await (async () => {
            const response = await fetch(endpoint!, {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                question: normalizedQuestion,
                promptPresetId: qaPromptPresetId,
                customPrompt: customQaPrompt,
                ...(conversation.length > 0 ? { conversation } : {})
              })
            });
            const responsePayload = (await response.json()) as {
              answer?: string;
              citedSegmentIds?: string[];
              citations?: AnswerPayload["citations"];
              id?: string;
              question?: string;
              createdAt?: string;
              error?: string;
            };

            if (!response.ok) {
              return {
                ...responsePayload,
                answer: "",
                citedSegmentIds: undefined
              };
            }

            return responsePayload;
          })();

      if (requestId !== requestIdRef.current) {
        return;
      }

      if (!payload.answer || !payload.citedSegmentIds) {
        setErrorMessage(copy.submitErrorMessage);
        setTurns((currentTurns) => currentTurns.map((turn) => (turn.id === pendingTurnId ? { ...turn, isPending: false } : turn)));
        return;
      }

      const answeredTurn = answerPayloadToTurn(payload, normalizedQuestion, createAnswerTurnId());
      if (!answeredTurn) {
        setErrorMessage(copy.submitErrorMessage);
        setTurns((currentTurns) => currentTurns.map((turn) => (turn.id === pendingTurnId ? { ...turn, isPending: false } : turn)));
        return;
      }

      setTurns((currentTurns) => currentTurns.map((turn) => (turn.id === pendingTurnId ? answeredTurn : turn)));
      if (saveQuestionHistory) {
        void Promise.resolve(saveQuestionHistory(answeredTurn)).catch(() => undefined);
      }
    } catch {
      if (requestId !== requestIdRef.current) {
        return;
      }

      setErrorMessage(copy.submitErrorMessage);
      setTurns((currentTurns) => currentTurns.map((turn) => (turn.id === pendingTurnId ? { ...turn, isPending: false } : turn)));
    } finally {
      if (requestId === requestIdRef.current) {
        setIsSubmitting(false);
      }
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitQuestion(question);
  }

  function handleQuestionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter") {
      return;
    }

    event.stopPropagation();

    if (event.shiftKey) {
      return;
    }

    event.preventDefault();
    if (isSubmitting) {
      return;
    }

    void submitQuestion(question);
  }

  function fillQuestionInput(nextQuestion: string) {
    setQuestion(nextQuestion);
    setErrorMessage("");
    questionInputRef.current?.focus();
  }

  async function saveQaModel(nextModel: string) {
    if (!nextModel) {
      return;
    }

    setIsSavingModel(true);
    setModelMessage("正在切换模型");

    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ qaModel: nextModel })
      });
      const settings = (await response.json()) as {
        qaModel?: string;
        qaModelPresets?: QaModelPreset[];
        error?: string;
      };

      if (!response.ok) {
        setModelMessage("保存问答模型失败。");
        return;
      }

      setQaModel(settings.qaModel ?? nextModel);
      setQaModelPresets(settings.qaModelPresets ?? qaModelPresets);
      setModelMessage("已切换问答模型");
    } catch {
      setModelMessage("保存问答模型失败。");
    } finally {
      setIsSavingModel(false);
    }
  }

  function handleQaModelChange(nextModel: string) {
    setQaModel(nextModel);
    void saveQaModel(nextModel);
  }

  async function saveQaPromptRole(input?: { presetId?: QaPromptPresetId; customPrompt?: string }) {
    const presetId = input?.presetId ?? qaPromptPresetId;
    const normalizedCustomPrompt = (input?.customPrompt ?? customQaPrompt).trim();

    if (presetId === "custom" && !normalizedCustomPrompt) {
      setPromptMessage("请输入自定义问答角色提示词。");
      return;
    }

    setIsSavingPrompt(true);
    setPromptMessage("正在保存问答角色");

    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          qaPromptPresetId: presetId,
          customQaPrompt: presetId === "custom" ? normalizedCustomPrompt : ""
        })
      });
      const settings = (await response.json()) as {
        qaPromptPresetId?: QaPromptPresetId;
        qaPromptPresets?: QaPromptPreset[];
        customQaPrompt?: string;
        error?: string;
      };

      if (!response.ok) {
        setPromptMessage(settings.error === "missing_custom_qa_prompt" ? "请输入自定义问答角色提示词。" : "保存问答角色失败。");
        return;
      }

      setQaPromptPresetId(settings.qaPromptPresetId ?? presetId);
      setQaPromptPresets(settings.qaPromptPresets ?? qaPromptPresets);
      setCustomQaPrompt(settings.customQaPrompt ?? "");
      setPromptMessage("已保存问答角色");
    } catch {
      setPromptMessage("保存问答角色失败。");
    } finally {
      setIsSavingPrompt(false);
    }
  }

  function handleQaPromptRoleChange(nextPresetId: string) {
    const matchedPreset = qaPromptPresets.find((preset) => preset.id === nextPresetId);

    if (!matchedPreset) {
      return;
    }

    setQaPromptPresetId(matchedPreset.id);
    setPromptMessage("");

    if (matchedPreset.id === "custom") {
      setPromptMessage(customQaPrompt.trim() ? "编辑后保存自定义角色" : "填写自定义角色后保存");
      return;
    }

    void saveQaPromptRole({ presetId: matchedPreset.id, customPrompt: "" });
  }

  const displayedSuggestions: DisplaySuggestion[] =
    activeSuggestedQuestions.length > 0
      ? activeSuggestedQuestions.map((suggestion) => ({
          id: suggestion.id,
          question: suggestion.question,
          helper: suggestion.reason ?? "填入输入框后，可以先修改再发送。"
        }))
      : turns.length === 0
        ? copy.suggestions.slice(0, MAX_DISPLAYED_SUGGESTIONS).map((suggestion) => ({
            id: suggestion.question,
            question: suggestion.question,
            helper: suggestion.helper
          }))
        : [];
  const scopeMetaFacts = scopeMeta
    ? [
        effectiveScopeMeta.recordingCount !== undefined ? `${effectiveScopeMeta.recordingCount} 条录音` : "",
        effectiveScopeMeta.dateRangeLabel ?? "",
        effectiveScopeMeta.evidenceCount !== undefined
          ? `约 ${effectiveScopeMeta.evidenceCount} 条证据`
          : effectiveScopeMeta.recordingCount !== undefined || effectiveScopeMeta.dateRangeLabel
            ? "证据将在回答中引用"
            : ""
      ].filter(Boolean)
    : [];

  return (
    <div className="qa-wrap">
      <div ref={threadRef} className="thread" role="log" aria-label="QA history" aria-live="polite">
        <header className="qa-head">
          <div className="ai">
            <AiIcon />
          </div>
          <h2 id="qa-panel-title">{emptyState?.title ?? copy.title}</h2>
          <p>{emptyState?.detail ?? copy.description}</p>
          {scopeMeta ? (
            <div className="qa-scope-meta" aria-label="回答范围">
              <div className="qa-scope-meta-main">
                <strong>{effectiveScopeMeta.label}</strong>
                <span>{effectiveScopeMeta.description}</span>
              </div>
              {scopeMetaFacts.length > 0 ? (
                <div className="qa-scope-meta-facts">
                  {scopeMetaFacts.map((fact) => (
                    <span key={fact}>{fact}</span>
                  ))}
                </div>
              ) : null}
              {effectiveScopeMeta.caution ? <small>{effectiveScopeMeta.caution}</small> : null}
            </div>
          ) : null}
          {isDataEmpty && emptyState?.actions?.length ? (
            <div className="qa-empty-actions">
              {emptyState.actions.map((action) => (
                <button key={action.label} className="secondary-button" type="button" onClick={action.onClick}>
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
          {!isDataEmpty && activeProactiveObservations.length > 0 ? (
            <section className="proactive-observation-block" aria-labelledby="proactive-observation-title">
              <div id="proactive-observation-title" className="suggest-title">
                AI 主动观察
              </div>
              <div className="proactive-observation-list">
                {activeProactiveObservations.map((observation) => (
                  <article key={observation.id} className="proactive-observation-card">
                    <div className="proactive-observation-heading">
                      <span className="sg-insight-type">{insightTypeLabel(observation.type)}</span>
                      {observation.memoryAware ? <span className="sg-agent-meta">结合当前记录和已有记忆</span> : null}
                    </div>
                    <p className="proactive-observation-content">{observation.content}</p>
                    {observation.caution ? <p className="sg-caution">{observation.caution}</p> : null}
                    <details className="proactive-observation-evidence">
                      <summary>查看依据 · {observation.evidenceRefs.length} 条</summary>
                      <div className="proactive-observation-evidence-list">
                        {observation.evidenceRefs.map((evidence) => (
                          <div key={evidence.evidenceId} className="proactive-observation-evidence-item">
                            <span>
                              {evidence.recordingDate} · {formatTime(evidence.timeRange.startSeconds)}-{formatTime(evidence.timeRange.endSeconds)}
                            </span>
                            <strong>{evidence.title}</strong>
                            <p>{evidence.excerpt}</p>
                          </div>
                        ))}
                      </div>
                    </details>
                    {observation.relatedQuestions[0] ? (
                      <button className="observation-question-action" type="button" onClick={() => fillQuestionInput(observation.relatedQuestions[0]!)}>
                        基于此提问
                      </button>
                    ) : null}
                  </article>
                ))}
              </div>
            </section>
          ) : null}
          {!isDataEmpty && displayedSuggestions.length > 0 ? (
            <div className="suggest-block">
              <div className="suggest-title">你可能想问</div>
              <div className="suggest">
                {displayedSuggestions.map((suggestion) => (
                  <button
                    key={suggestion.id}
                    className="sg"
                    type="button"
                    onClick={() => fillQuestionInput(suggestion.question)}
                  >
                    <span className="si" aria-hidden="true">
                      ?
                    </span>
                    <span className="sg-copy">
                      <b>{suggestion.question}</b>
                      <span className="sg-reason">{suggestion.helper}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </header>

        {turns.map((turn) => (
          <Fragment key={turn.id}>
            <div className="msg u">
              <div className="mav">你</div>
              <div className="mc">
                <div className="nm">你</div>
                <div className="bub">{turn.question}</div>
              </div>
            </div>

            {turn.isPending ? (
              <div className="msg a">
                <div className="mav">
                  <AiIcon />
                </div>
                <div className="mc">
                  <div className="nm">昼记 AI</div>
                  <div className="typing">
                    <span className="typing-label">{copy.loadingMessage}</span>
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
              </div>
            ) : null}

            {turn.answer ? (
              <div className="msg a qa-answer">
                <div className="mav">
                  <AiIcon />
                </div>
                <div className="mc">
                  <div className="nm">昼记 AI</div>
                  <pre className="qa-answer-content">{turn.answer}</pre>
                  {turn.citations && turn.citations.length > 0 ? (
                    <details className="qa-citations" aria-label="引用证据">
                      <summary className="qa-citations-summary">
                        <span className="qa-citations-title">引用证据</span>
                        <span>{turn.citations.length} 条</span>
                      </summary>
                      <div className="qa-citation-list">
                        {turn.citations.map((citation) => (
                          <div key={citation.id} className="qa-citation-card">
                            <span className="qa-citation-time">
                              {formatTime(citation.startSeconds)}-{formatTime(citation.endSeconds)}
                            </span>
                            <strong>{citation.title}</strong>
                            <p>{citation.excerpt}</p>
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : turn.citedSegmentIds.length > 0 ? (
                    <p className="qa-citations">已引用 {turn.citedSegmentIds.length} 段录音证据</p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </Fragment>
        ))}

        {!isDataEmpty && turns.length === 0 ? (
          <p className="panel-empty qa-empty">选择一个建议问题，或直接输入你想追问的内容。</p>
        ) : null}
      </div>

      <form className="compose" aria-label="QA composer" onSubmit={handleSubmit}>
        <div className="cbox">
          <textarea
            ref={questionInputRef}
            aria-label="问题"
            name="question"
            rows={1}
            placeholder={emptyState?.placeholder ?? copy.placeholder}
            value={question}
            disabled={isDataEmpty}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={handleQuestionKeyDown}
          />
          <div className="composer-toolbar">
            <div className="composer-tools">
              {qaPromptPresets.length > 0 ? (
                <label className="model-chip role-chip">
                  <span>角色</span>
                  <select value={qaPromptPresetId} aria-label="AI 问答角色" onChange={(event) => handleQaPromptRoleChange(event.target.value)} disabled={isSavingPrompt}>
                    {qaPromptPresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="model-chip">
                <span>模型</span>
                <select value={qaModel} aria-label="AI 问答模型" onChange={(event) => handleQaModelChange(event.target.value)} disabled={qaModelPresets.length === 0 || isSavingModel}>
                  {qaModelPresets.map((preset) => (
                    <option key={preset.value} value={preset.value}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
              {promptMessage ? <span className="model-state">{promptMessage}</span> : null}
              {modelMessage ? <span className="model-state">{modelMessage}</span> : null}
            </div>
            <button className="send" type="submit" disabled={isDataEmpty || (scope === "current" && !uploadId) || isSubmitting} aria-label="提问">
              <SendIcon />
            </button>
          </div>
          {qaPromptPresetId === "custom" ? (
            <div className="custom-role-inline">
              <label className="prompt-custom-field">
                <span>自定义角色提示词</span>
                <textarea
                  aria-label="自定义问答角色提示词"
                  value={customQaPrompt}
                  rows={3}
                  maxLength={4000}
                  placeholder="例如：请像我的学习助教一样回答，优先整理知识点、例子和我还没想清楚的问题。"
                  onChange={(event) => {
                    setCustomQaPrompt(event.target.value);
                    setPromptMessage("");
                  }}
                />
              </label>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void saveQaPromptRole({ presetId: "custom" })}
                disabled={isSavingPrompt || !customQaPrompt.trim()}
              >
                {isSavingPrompt ? "保存中..." : "保存自定义角色"}
              </button>
            </div>
          ) : null}
        </div>
        {errorMessage ? <p className="form-error">{errorMessage}</p> : null}
        <div className="hint">{copy.hint}</div>
      </form>
    </div>
  );
}

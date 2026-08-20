import { createHash, randomUUID } from "crypto";
import { transcriptSpeakerLabel } from "@/lib/domain/speaker-identity";
import type {
  AudioInsight,
  BriefItem,
  QuestionAnswer,
  RelationshipSignalCard,
  SemanticSegment,
  TranscriptSegment,
  ValueLabel
} from "@/lib/domain/types";
import { getQaPromptPreference } from "@/lib/server/settings/provider-config";
import type { JsonStore } from "@/lib/server/storage/json-store";
import { meaningfulTextTokens, sharedTokenCount } from "@/lib/server/text-features";
import {
  buildRelationshipSignalEvidence,
  buildRelationshipSignalEvidenceCorpus,
  isForbiddenRelationshipQaOutput,
  isRelationshipEvidenceQuestion
} from "./relationship-signal-evidence";
import type { MemoryIndexQaContext } from "./memory-index-evidence";
import {
  buildCompanionResponseStyleInstruction,
  classifyCompanionResponseIntent,
  containsAbsoluteRelationshipConclusion,
  normalizeCompanionResponseStyle
} from "./response-style";
import {
  notifyQaExecutionDiagnostics,
  safeElapsedMs,
  type QaAnswerMode,
  type QaExecutionDiagnostics,
  type QaExecutionDiagnosticsObserver
} from "./qa-observability";
import {
  QaProviderStreamError
} from "./qa-provider";
import {
  resolveQaLlmProvider,
  type QaLlmProviderId,
  type QaLlmProviderMetricsObserver
} from "./qa-llm-provider";
import {
  createQaStreamingTraceRecorder,
  notifyQaStreamingTrace,
  type QaAnswerStreamEvent,
  type QaStreamingFallbackReason,
  type QaStreamingTraceObserver
} from "./qa-streaming";
import {
  createSentenceCommitManager,
  summarizeSentenceCommits,
  type SentenceCommitEvidence,
  type SentenceCommitManager,
  type SentenceCommitReason,
  type ProvisionalSentenceCommitInput
} from "./qa-sentence-commit";
import {
  analyzeQaQueryIntent,
  assessQaLifecycleEvidence,
  lifecycleCompletionLabel,
  type QaLifecycleEvidenceState,
  type QaQueryIntentAnalysis
} from "./lifecycle-retrieval";
import {
  compactEvidencePromptForEvaluation,
  projectCompactEvidence
} from "./evidence-compression/projection";
import { observeCompactEvidenceShadow } from "./evidence-compression/shadow";
import {
  resolveQaHybridRetrievalMode,
  type QaHybridRetrievalMode
} from "./hybrid/runtime-config";

export { analyzeQaQueryIntent } from "./lifecycle-retrieval";

export type QaScope = "current" | "week" | "all";
export type QaAnswerScope = QaScope | "relationship";

export type QaConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type QaEvaluationEvidenceView = "canonical" | "compact";

export type QaExecutionMilestone =
  | "retrieval_complete"
  | "llm_started"
  | "llm_first_token";

export type QaExecutionMilestoneObserver = (
  milestone: QaExecutionMilestone
) => unknown;

export type VoiceQaShadowReviewContext = {
  voiceSessionId: string;
  traceId: string;
  caseId?: string;
  started?: boolean;
};

export type AnswerQuestionWithAIInput = {
  /** Trusted authenticated user id used only to resolve a user-scoped sidecar. */
  userId?: string;
  uploadId: string;
  question: string;
  conversation?: QaConversationMessage[];
  scope?: QaScope;
  /** Server-only relationship Evidence scope; never accepted from browser QA context. */
  relationshipScope?: boolean;
  qaPromptInstruction?: string;
  settingsStore?: JsonStore;
  segments: TranscriptSegment[];
  audioInsights?: AudioInsight[];
  semanticSegments: SemanticSegment[];
  briefItems: BriefItem[];
  relationshipSignals?: RelationshipSignalCard[];
  memoryContext?: MemoryIndexQaContext;
  memoryIndexFallback?: boolean;
  /** Internal execution mode. The default keeps the production Agent QA prompt unchanged. */
  answerMode?: QaAnswerMode;
  /** Time spent loading the trusted context before this function was invoked. */
  memoryRetrievalMs?: number | null;
  /** Internal diagnostics observer. It must never alter answer generation. */
  onDiagnostics?: QaExecutionDiagnosticsObserver;
  /** Content-free real-time milestone observer used by Voice latency tracing. */
  onExecutionMilestone?: QaExecutionMilestoneObserver;
  /** Voice-only fail-closed policy for uncertainty-bearing provisional sentences. */
  withholdUncertainProvisionalSentences?: boolean;
  /** Internal observer used by the Memory shadow audit to reuse the actual ranked evidence. */
  onRetrievedEvidence?: (evidence: QaRetrievedEvidence[], retrievalMs: number) => unknown;
  /** Caller-owned hard boundary for scopes that must stay on canonical lexical retrieval. */
  disableHybridRetrieval?: boolean;
  /** Caller-owned fail-closed policy for a model/provider contract mismatch. */
  failClosedOnModelProviderMismatch?: boolean;
  /** Evaluation-only Provider usage observer. It must never alter answer generation. */
  onProviderMetrics?: QaLlmProviderMetricsObserver;
  /**
   * Internal caller-owned Provider selection. Voice uses this to select Qwen
   * without changing Text QA or the public canonical answer contract.
   */
  llmProviderId?: QaLlmProviderId;
  /** Allows only an explicitly Voice-selected loopback Qwen Provider in production. */
  allowQwenInProduction?: boolean;
  /**
   * Internal Voice-only review context.
   *
   * It is never serialized into the public QA contract. The mutable fields make
   * one Voice turn single-flight even when streaming falls back to the
   * non-streaming answer path.
   */
  shadowReviewContext?: VoiceQaShadowReviewContext;
  /** Internal provenance for a synchronous Voice answer attempt. */
  shadowReviewAttemptKind?: "sync_primary" | "sync_fallback";
  /**
   * Evaluation-only Provider payload switch.
   *
   * Production callers must omit this field. Retrieval, validation, citation
   * mapping, and sentence grounding always continue to use canonical Evidence.
   */
  evaluationEvidenceView?: QaEvaluationEvidenceView;
  /** Internal cancellation boundary for Voice/realtime work; omitted by Text QA. */
  signal?: AbortSignal;
};

function qaAbortError(signal: AbortSignal | undefined) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Canonical QA request aborted", "AbortError");
}

function throwIfQaAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw qaAbortError(signal);
}

function isQaAbort(error: unknown, signal: AbortSignal | undefined) {
  return signal?.aborted === true ||
    (error instanceof Error && error.name === "AbortError");
}

function notifyQaExecutionMilestone(
  observer: QaExecutionMilestoneObserver | undefined,
  milestone: QaExecutionMilestone
) {
  if (!observer) return;
  try {
    const result = observer(milestone);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch((error: unknown) => {
        console.warn(
          `[qa-observability] milestone_observer_failed milestone=${milestone} ` +
          `error_name=${error instanceof Error ? error.name : "unknown"}`
        );
      });
    }
  } catch (error) {
    console.warn(
      `[qa-observability] milestone_observer_failed milestone=${milestone} ` +
      `error_name=${error instanceof Error ? error.name : "unknown"}`
    );
  }
}

export type AnswerQuestionStreamInput = AnswerQuestionWithAIInput & {
  /** Content-free stream trace observer. It never receives prompts, deltas, or answers. */
  onStreamTrace?: QaStreamingTraceObserver;
};

export type QaRetrievedEvidence = {
  id: string;
  kind: "brief" | "semantic" | "audio" | "audio_emotion" | "raw" | "relationship_signal";
  title: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
  sourceSegmentIds: string[];
  priority: number;
  relationshipSignal?: {
    sourceId: string;
    label: string;
    category: RelationshipSignalCard["signalCategory"];
    confidence: number;
    caution: string;
    recordingDate: string;
  };
};

function snapshotQaEvidence(evidence: QaRetrievedEvidence[]): QaRetrievedEvidence[] {
  return evidence.map((item) => ({
    ...item,
    sourceSegmentIds: [...item.sourceSegmentIds],
    ...(item.relationshipSignal
      ? { relationshipSignal: { ...item.relationshipSignal } }
      : {})
  }));
}

type EvidenceItem = QaRetrievedEvidence;

type AiAnswerMode = "assistant_meta" | "memory_answer" | "unsupported";

type StructuredAiAnswer = {
  mode: AiAnswerMode;
  answer: string;
  citationIds: string[];
};

const MAX_EVIDENCE_ITEMS = 16;
const MAX_EVIDENCE_TEXT_LENGTH = 900;
const MAX_CONVERSATION_MESSAGES = 8;
const MAX_CONVERSATION_TEXT_LENGTH = 1200;
const MAX_QA_PROVIDER_ANSWER_CHARACTERS = 1200;
const MAX_VOICE_PROVISIONAL_SENTENCES = 3;
const SAFE_UNCERTAINTY_ANSWER = "没有找到足够证据确认这个信息。";
const MIN_LIFECYCLE_TOPIC_OVERLAP = 2;
const qaScopeLabels: Record<QaAnswerScope, string> = {
  current: "当天证据",
  week: "本周记忆",
  all: "全部本地记忆",
  relationship: "当前关系内已确认的相处证据"
};

const qaScopeInstructions: Record<QaAnswerScope, string> = {
  current: "当天问答，只基于当前日期或当前上传录音，不能引用其它日期。",
  week:
    "本周问答，关注反复主题、项目推进、承诺、风险、变化和卡点；如果证据只来自一天，要说明“目前证据主要来自某一天”。",
  all:
    "全部记忆问答，关注长期反复问题、过去表达、跨日期变化；长期判断必须有至少两个不同日期的证据，只有单日证据时，不能包装成长期趋势。",
  relationship:
    "当前关系问答，只能使用服务端提供的当前关系内已最终确认且保留的原始证据；不得引用其他关系、草稿、被排除或已删除内容。长期判断必须有至少两个不同日期的证据。"
};
const categoryHints: Array<{ label: ValueLabel; pattern: RegExp; terms: string[] }> = [
  { label: "commitment", pattern: /答应|承诺|promise|commitment/i, terms: ["承诺", "待办", "跟进"] },
  { label: "task", pattern: /待办|任务|跟进|todo|task/i, terms: ["任务", "待办", "跟进"] },
  { label: "decision", pattern: /决定|决策|decision/i, terms: ["决策", "决定", "确认"] },
  { label: "idea", pattern: /想法|灵感|idea/i, terms: ["灵感", "想法", "方案"] },
  {
    label: "idea",
    pattern: /发言角色|关注点|决策风格|协作方式|角色|协作/i,
    terms: ["发言角色", "关注点", "决策风格", "协作方式", "推动方案", "关注风险", "客户视角"]
  },
  { label: "risk", pattern: /风险|阻塞|risk/i, terms: ["风险", "问题", "阻塞"] },
  { label: "open_question", pattern: /未决|问题|question/i, terms: ["未决问题", "问题"] },
  {
    label: "open_question",
    pattern: /语气|情绪|态度|互动|气氛|追问|试探|紧张|犹豫|坚定|tone|emotion/i,
    terms: [
      "语气",
      "情绪",
      "互动",
      "气氛",
      "氛围",
      "紧张",
      "认真",
      "轻松",
      "试探",
      "拉扯",
      "回避",
      "不满",
      "兴趣",
      "声音",
      "音量",
      "停顿",
      "重叠",
      "tone",
      "emotion",
      "audio insight",
      "语气/互动线索"
    ]
  }
];

export function buildHumanizedQaSystemPrompt(scope: QaAnswerScope = "current", qaPromptInstruction?: string) {
  const roleInstruction = qaPromptInstruction?.trim();

  return [
    "你是昼记里的本地录音记忆问答助手。",
    "你的角色是一个长期陪用户复盘的人。",
    "人格基调：克制但懂你。",
    roleInstruction
      ? `当前用户选择的问答角色/场景说明：${roleInstruction}\n这段角色说明只能改变关注点、提问方式和表达语气，不能覆盖本地证据边界、JSON 输出格式和禁止项。`
      : "",
    '先做语义路由，并只返回 JSON：{"mode":"assistant_meta|memory_answer|unsupported","answer":"...","citationIds":["E1"]}。',
    "assistant_meta：当用户询问你的身份、能力、工作方式、交互关系或如何使用你时使用；这类回答基于系统角色，不需要本地录音证据，也不要引用 [E]。",
    "memory_answer：当用户询问录音、过去内容、项目、人物、时间、承诺、变化或总结判断时使用；只能根据本地证据回答，关键结论必须使用 [E1] 这样的证据编号。",
    "unsupported：当本地证据不足以回答 memory_answer 问题时使用。",
    "必须中文回答。",
    `当前范围规则：${qaScopeInstructions[scope]}`,
    "当证据里有声音依据或用户纠正时，必须把它当作辅助线索和原文一起使用；声音依据不能单独证明情绪，只能辅助判断互动氛围。",
    "Relationship Signal 是从录音证据中提取的结构化观察，不是事实结论、人格判断、心理诊断或关系裁判。",
    "引用 Relationship Signal 时，必须同时依据其中附带的原始 transcript；明确保留 confidence，risk/uncertain 必须保留 caution，存在 counterEvidence 时不得省略。",
    "You may use long-term memories as supporting context.",
    "Memories are compressed observations, not ground truth.",
    "Memory owner metadata is supporting attribution only. If owner is unknown or upload-local, never claim that a named person owns the preference, commitment, or event.",
    "Always prioritize original evidence. Memory labels such as [M1] are not citation IDs; cite only [E1] evidence.",
    "Do not infer long-term patterns from a single occurrence or a single evidence date.",
    "不得把单次关系信号扩大为长期结论，不得输出渣男/渣女、绝对操控判断、心理诊断、人格定性或分手建议。",
    "memory_answer 先回答用户真正的问题，再自然补充必要证据和边界；不要固定使用分析报告式三段结构。",
    "用户没有明确请求建议时，不主动提供建议、行动步骤或“你应该”；用户明确询问怎么办时，才用柔和语气给出少量选项。",
    "关系理解只描述证据中的一次具体行为并保留不确定性；一次具体行为不代表所有情况，不替用户下关系结论。",
    "避免反复使用“我留意到的模式”“当天讨论里”“这说明”“可以怎么做”等机械标题。",
    "assistant_meta 的 answer 简短自然说明你是谁、能帮什么、不会假装知道没有证据的事。",
    roleInstruction
      ? "当用户问你是谁、能做什么时，也必须贴合当前角色/场景说明来介绍你能帮什么。不要默认使用会议、产品、待办等工作场景示例，除非当前角色本身就是工作复盘。"
      : "",
    "证据不足时使用这个边界：我在当前记忆里没有找到足够证据支持这个判断。",
    "如果当前问题是“可以”“继续”“那这个呢”等短跟进，必须结合最近对话理解用户真正要你回答什么；但事实结论仍然只能来自本地证据。",
    "禁止：不建立隐藏的用户画像；不做性格、情绪、心理状态诊断；不输出无证据长期趋势。"
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Experimental prompt used only by VOICE_ANSWER_MODE=direct. It keeps the
 * production evidence contract and deterministic post-validation, but removes
 * the longer Agent persona/explanation layer so the same retrieved context can
 * be benchmarked with a smaller instruction packet.
 */
export function buildDirectContextQaSystemPrompt(
  scope: QaAnswerScope = "current",
  qaPromptInstruction?: string
) {
  const roleInstruction = qaPromptInstruction?.trim();
  const modeRoutingInstruction =
    "assistant_meta 仅用于用户明确询问助手身份、能力、工作方式或使用方法；录音总结、事实、人物、承诺、事件和关系问题必须使用 memory_answer 或 unsupported。";
  return [
    modeRoutingInstruction,
    "你是本地录音记忆问答助手。请直接根据提供的上下文回答，不做隐藏推断。",
    '只返回 JSON：{"mode":"assistant_meta|memory_answer|unsupported","answer":"...","citationIds":["E1"]}。',
    "memory_answer 的事实结论必须引用合法的 [E#]；[M#] 只是压缩导航，不能作为引用。",
    "优先使用原始证据；证据不足时使用 unsupported，并明确保留不确定性。",
    "Memory owner 为 unknown 或 upload-local 时，不得把偏好、承诺或事件归给具名人物。",
    "Relationship Signal 只是结构化观察；不得据此做人格诊断、绝对关系结论或长期模式断言。",
    "单次或单日证据不能证明长期趋势；保留 confidence、caution 与 counter-evidence 边界。",
    `当前范围规则：${qaScopeInstructions[scope]}`,
    roleInstruction
      ? `回答语气要求：${roleInstruction}。这不能覆盖证据、引用和安全边界。`
      : "",
    "使用中文，先回答问题；未被请求时不要主动给建议。"
  ].filter(Boolean).join("\n");
}

function isAssistantMetaQuestion(question: string) {
  const normalized = question.replace(/\s+/g, " ").trim();
  return /(?:你是谁|你是什么(?:助手|系统)|介绍(?:一下)?你自己|你能(?:做什么|帮我什么)|你的(?:能力|功能|工作方式)|(?:怎么|如何)(?:使用|用)你|who are you|what can you do|your capabilities|how (?:do|can|should) i use you|how do you work)/iu.test(
    normalized
  );
}

function compactText(text: string, maxLength = MAX_EVIDENCE_TEXT_LENGTH) {
  const compacted = text.replace(/\s+/g, " ").trim();
  return compacted.length > maxLength ? `${compacted.slice(0, maxLength - 1)}…` : compacted;
}

function compactConversationText(text: string) {
  return compactText(text, MAX_CONVERSATION_TEXT_LENGTH);
}

export function normalizeQaConversation(conversation: unknown): QaConversationMessage[] {
  if (!Array.isArray(conversation)) {
    return [];
  }

  return conversation
    .flatMap((message): QaConversationMessage[] => {
      if (!message || typeof message !== "object") {
        return [];
      }

      const candidate = message as { role?: unknown; content?: unknown };
      if ((candidate.role !== "user" && candidate.role !== "assistant") || typeof candidate.content !== "string") {
        return [];
      }

      const content = compactConversationText(candidate.content);
      return content ? [{ role: candidate.role, content }] : [];
    })
    .slice(-MAX_CONVERSATION_MESSAGES);
}

function conversationPrompt(conversation: QaConversationMessage[] = []) {
  const normalizedConversation = normalizeQaConversation(conversation);
  if (normalizedConversation.length === 0) {
    return "";
  }

  const lines = normalizedConversation.map((message) => {
    const speaker = message.role === "user" ? "用户" : "昼记 AI";
    return `${speaker}：${message.content}`;
  });

  return `最近对话：\n${lines.join("\n")}\n\n`;
}

function contextualQuestion(input: AnswerQuestionWithAIInput) {
  const context = conversationPrompt(input.conversation);
  return `${context}当前问题：${input.question}`;
}

function questionTerms(question: string) {
  const baseTerms = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}\u4e00-\u9fa5]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  const hintedTerms = categoryHints.flatMap((hint) => (hint.pattern.test(question) ? hint.terms : []));

  return [...new Set([...baseTerms, ...hintedTerms])];
}

function scoreEvidence(
  question: string,
  evidence: EvidenceItem,
  memorySourceIds: Set<string> | undefined,
  queryIntent: QaQueryIntentAnalysis,
  maxEvidenceEndSeconds: number
) {
  const terms = queryIntent.intent === "lifecycle_resolution"
    ? queryIntent.topicTokens
    : questionTerms(question);
  const text = `${evidence.title} ${evidence.text}`.toLowerCase();
  const termScore = Math.min(
    queryIntent.intent === "lifecycle_resolution" ? 24 : Number.POSITIVE_INFINITY,
    terms.reduce((score, term) => score + (text.includes(term.toLowerCase()) ? 4 : 0), 0)
  );
  const memoryBoost =
    memorySourceIds &&
    (memorySourceIds.has(evidence.id) || evidence.sourceSegmentIds.some((id) => memorySourceIds.has(id)))
      ? 12
      : 0;
  const lifecycleAssessment = assessQaLifecycleEvidence(queryIntent, text);
  const lifecycleBoost = lifecycleAssessment.topicOverlap >= MIN_LIFECYCLE_TOPIC_OVERLAP
    ? (lifecycleAssessment.state === "resolved" ? 14 : lifecycleAssessment.state === "pending" ? -4 : 0) +
      Math.round((Math.max(0, evidence.endSeconds) / Math.max(1, maxEvidenceEndSeconds)) * 8) +
      (evidence.kind === "brief" ? 3 : evidence.kind === "raw" ? 2 : 0)
    : 0;

  return {
    score: evidence.priority + termScore + memoryBoost + lifecycleBoost,
    lifecycleState: lifecycleAssessment.state,
    topicOverlap: lifecycleAssessment.topicOverlap
  };
}

function evidenceFromBriefItems(briefItems: BriefItem[]): EvidenceItem[] {
  return briefItems.map((item) => ({
    id: item.id,
    kind: "brief",
    title: item.title,
    text: `${item.body}\n原文摘录：${item.transcriptExcerpt}`,
    startSeconds: item.sourceTimeRange.startSeconds,
    endSeconds: item.sourceTimeRange.endSeconds,
    sourceSegmentIds: item.sourceSegmentIds,
    priority: item.priority === "high" ? 8 : item.priority === "medium" ? 5 : 3
  }));
}

function evidenceFromSemanticSegments(semanticSegments: SemanticSegment[]): EvidenceItem[] {
  return semanticSegments.map((segment) => ({
    id: segment.id,
    kind: "semantic",
    title: segment.title,
    text: `${segment.summary}\n原文摘录：${segment.transcriptExcerpt}`,
    startSeconds: segment.sourceTimeRange.startSeconds,
    endSeconds: segment.sourceTimeRange.endSeconds,
    sourceSegmentIds: segment.sourceSegmentIds,
    priority: segment.valueLabels.length > 0 ? 10 : 7
  }));
}

function speakerTitle(insight: AudioInsight) {
  const speakerName = insight.speaker.displayName ?? insight.speaker.id;
  return `${speakerName}的语气/互动线索`;
}

function voiceExplanationText(insight: AudioInsight) {
  const explanations = insight.voice.explanations ?? [];
  if (explanations.length === 0) {
    return [];
  }

  return [
    "声音依据：",
    ...explanations.map((explanation) => `- ${explanation.label}：${explanation.detail}`)
  ];
}

function emotionEvidenceText(insight: AudioInsight) {
  const evidence = insight.emotionEvidence ?? [];
  if (evidence.length === 0) {
    return [];
  }

  return [
    `气氛线索：${(insight.atmosphereLabels ?? []).join("、") || "未标注"}`,
    ...evidence.slice(0, 6).map((item) => {
      const features = item.features ?? [];
      const featureLabels = [...new Set(features.map((feature) => feature.label).filter(Boolean))].slice(0, 6);
      const featureText =
        featureLabels.length > 0 ? `；特征：${featureLabels.join("、")}` : "";
      return `- ${item.label}：${item.source}，置信度 ${Math.round(item.confidence * 100)}%）：${compactText(item.detail, 260)}${featureText}`;
    })
  ];
}

function userCorrectionText(insight: AudioInsight) {
  const corrections = insight.userCorrections ?? [];
  if (corrections.length === 0) {
    return [];
  }

  return [
    "用户纠正：",
    ...corrections.flatMap((correction) => {
      const labels = correction.labelCorrections.map((item) => `${item.from} -> ${item.to}`);
      return [labels.length > 0 ? `- ${labels.join("；")}` : "", correction.note ? `  说明：${correction.note}` : ""].filter(Boolean);
    })
  ];
}

function evidenceFromAudioInsights(audioInsights: AudioInsight[] = []): EvidenceItem[] {
  return audioInsights.map((insight) => ({
    id: insight.id,
    kind: (insight.emotionEvidence?.length ?? 0) > 0 ? "audio_emotion" : "audio",
    title: speakerTitle(insight),
    text: [
      "语气/互动线索",
      `说话人：${insight.speaker.displayName ?? insight.speaker.id}；角色：${insight.speaker.role}`,
      `语气标签：${insight.toneLabels.join("、")}`,
      `情绪线索：${insight.emotionLabels.join("、")}`,
      `互动标签：${insight.interactionLabels.join("、")}`,
      `声音估计：语速${insight.voice.pace}，音量${insight.voice.volume}，停顿${insight.voice.pause}`,
      ...voiceExplanationText(insight),
      ...userCorrectionText(insight),
      ...emotionEvidenceText(insight),
      `摘要：${insight.summary}`,
      `依据：${insight.evidence}`
    ].join("\n"),
    startSeconds: insight.sourceTimeRange.startSeconds,
    endSeconds: insight.sourceTimeRange.endSeconds,
    sourceSegmentIds: insight.sourceSegmentIds,
    priority:
      (insight.emotionEvidence?.length ?? 0) > 0
        ? 11
        : (insight.voice.explanations?.length ?? 0) > 0 ||
            (insight.userCorrections?.length ?? 0) > 0 ||
            insight.interactionLabels.some((label) => label !== "unknown") ||
            insight.toneLabels.some((label) => label !== "unknown")
        ? 9
        : 4
  }));
}

function evidenceFromRawSegments(segments: TranscriptSegment[]): EvidenceItem[] {
  return segments
    .filter((segment) => segment.text.trim().length > 0)
    .map((segment) => {
      const speaker = transcriptSpeakerLabel(segment);
      return {
        id: segment.id,
        kind: "raw",
        title: speaker ? `${speaker} 的原始转写` : "原始转写片段",
        text: segment.text,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        sourceSegmentIds: [segment.id],
        priority: segment.valueLabels.length > 0 ? 3 : 1
      };
    });
}

function duplicateEvidenceRank(question: string, item: EvidenceItem) {
  const isAtmosphereQuestion = /语气|情绪|态度|互动|气氛|氛围|紧张|认真|轻松|试探|拉扯|回避|不满|兴趣|tone|emotion/i.test(question);
  const isRelationshipQuestion = isRelationshipEvidenceQuestion({ question });

  if (isRelationshipQuestion && item.kind === "relationship_signal") return 6;
  if (isAtmosphereQuestion && item.kind === "audio_emotion") return 5;
  if (item.kind === "brief") return 4;
  if (item.kind === "semantic") return 3;
  if (item.kind === "audio_emotion") return 2;
  if (item.kind === "audio") return 1;
  return 0;
}

function canonicalQaEvidenceFromInput(
  input: AnswerQuestionWithAIInput,
  relationshipEvidence: QaRetrievedEvidence[]
) {
  return [
    ...relationshipEvidence,
    ...evidenceFromBriefItems(input.briefItems),
    ...evidenceFromAudioInsights(input.audioInsights),
    ...evidenceFromSemanticSegments(input.semanticSegments),
    ...evidenceFromRawSegments(input.segments)
  ];
}

/**
 * Returns the existing Canonical Evidence pool before ranking and Top-16 selection.
 * Hybrid Retrieval uses this only in shadow/evaluation paths; QA continues to call
 * retrieveQaEvidenceWithDiagnostics and receives the unchanged ranked shape.
 */
export function buildCanonicalQaEvidence(
  input: AnswerQuestionWithAIInput
): QaRetrievedEvidence[] {
  const relationshipEvidence = buildRelationshipSignalEvidence({
    question: input.question,
    conversation: input.conversation,
    cards: input.relationshipSignals,
    segments: input.segments
  });
  return canonicalQaEvidenceFromInput(input, relationshipEvidence);
}

export function buildCanonicalQaEvidenceCorpus(input: Pick<
  AnswerQuestionWithAIInput,
  "segments" | "audioInsights" | "semanticSegments" | "briefItems" | "relationshipSignals"
>): QaRetrievedEvidence[] {
  return canonicalQaEvidenceFromInput(
    {
      uploadId: "embedding-corpus",
      question: "",
      segments: input.segments,
      audioInsights: input.audioInsights,
      semanticSegments: input.semanticSegments,
      briefItems: input.briefItems,
      relationshipSignals: input.relationshipSignals
    },
    buildRelationshipSignalEvidenceCorpus({
      cards: input.relationshipSignals,
      segments: input.segments
    })
  );
}

export type QaEvidenceRetrievalResult = {
  evidence: QaRetrievedEvidence[];
  relationshipContextBuildingMs: number;
  rerankingMs: number;
  lifecycleContext: {
    queryIntent: QaQueryIntentAnalysis;
    relevantEvidence: Array<{
      item: QaRetrievedEvidence;
      state: QaLifecycleEvidenceState;
      topicOverlap: number;
    }>;
  };
  hybridDiagnostics?: {
    mode: QaHybridRetrievalMode;
    denseRetrievalMs: number | null;
    indexCoverage: number | null;
    fallbackReason: string | null;
  };
  /** Non-enumerable evaluation-only view of the lexical ordering before Top-16. */
  reviewRanking?: QaLexicalReviewCandidate[];
};

type RankedEvidenceCandidate = {
  item: EvidenceItem;
  score: number;
  duplicateRank: number;
  lifecycleState: QaLifecycleEvidenceState;
  topicOverlap: number;
};

export type QaLexicalReviewCandidate = {
  evidence: QaRetrievedEvidence;
  score: number;
  duplicateRank: number;
  lifecycleState: QaLifecycleEvidenceState;
  topicOverlap: number;
  representative: boolean;
  reasons: string[];
};

function compareRankedEvidence(
  left: RankedEvidenceCandidate,
  right: RankedEvidenceCandidate,
  queryIntent: QaQueryIntentAnalysis
) {
  const scoreDifference = right.score - left.score;
  if (scoreDifference !== 0) return scoreDifference;
  return queryIntent.preferLatestState
    ? right.item.endSeconds - left.item.endSeconds
    : left.item.startSeconds - right.item.startSeconds;
}

function lifecycleStateRank(state: QaLifecycleEvidenceState) {
  if (state === "resolved") return 2;
  if (state === "pending") return 1;
  return 0;
}

function lifecycleChainRepresentatives(
  candidates: RankedEvidenceCandidate[],
  queryIntent: QaQueryIntentAnalysis
) {
  if (queryIntent.intent !== "lifecycle_resolution") return [];
  const relevant = candidates.filter((candidate) =>
    candidate.topicOverlap >= MIN_LIFECYCLE_TOPIC_OVERLAP
  );
  const byLifecycleValue = [...relevant].sort((left, right) =>
    lifecycleStateRank(right.lifecycleState) - lifecycleStateRank(left.lifecycleState) ||
    right.topicOverlap - left.topicOverlap ||
    compareRankedEvidence(left, right, queryIntent)
  );
  const resolved = byLifecycleValue.find((candidate) => candidate.lifecycleState === "resolved");
  const pending = byLifecycleValue.find((candidate) => candidate.lifecycleState === "pending");
  const topical = byLifecycleValue[0];

  return [resolved, pending, topical].filter(
    (candidate, index, all): candidate is RankedEvidenceCandidate =>
      Boolean(candidate) && all.findIndex((other) => other?.item.id === candidate?.item.id) === index
  );
}

export function retrieveQaEvidenceWithDiagnostics(
  input: AnswerQuestionWithAIInput,
  now: () => number = () => performance.now()
): QaEvidenceRetrievalResult {
  const retrievalQuestion = contextualQuestion(input);
  const queryIntent = analyzeQaQueryIntent(input.question);
  const memorySourceIds = input.memoryContext ? new Set(input.memoryContext.sourceIds) : undefined;
  const relationshipStartedAt = now();
  const relationshipEvidence = buildRelationshipSignalEvidence({
    question: input.question,
    conversation: input.conversation,
    cards: input.relationshipSignals,
    segments: input.segments
  });
  const relationshipContextBuildingMs = safeElapsedMs(relationshipStartedAt, now());
  const rerankingStartedAt = now();
  const evidence = canonicalQaEvidenceFromInput(input, relationshipEvidence);
  const maxEvidenceEndSeconds = evidence.reduce((maximum, item) => Math.max(maximum, item.endSeconds), 0);
  const bestBySourceSet = new Map<string, RankedEvidenceCandidate>();

  evidence
    .map((item): RankedEvidenceCandidate => {
      const score = scoreEvidence(
        retrievalQuestion,
        item,
        memorySourceIds,
        queryIntent,
        maxEvidenceEndSeconds
      );
      return {
        item,
        score: score.score,
        duplicateRank: duplicateEvidenceRank(retrievalQuestion, item),
        lifecycleState: score.lifecycleState,
        topicOverlap: score.topicOverlap
      };
    })
    .forEach((candidate) => {
      const sourceKey = candidate.item.sourceSegmentIds.join("|");
      const existing = bestBySourceSet.get(sourceKey);
      if (
        !existing ||
        candidate.duplicateRank > existing.duplicateRank ||
        (candidate.duplicateRank === existing.duplicateRank && candidate.score > existing.score) ||
        (candidate.duplicateRank === existing.duplicateRank &&
          candidate.score === existing.score &&
          candidate.item.startSeconds < existing.item.startSeconds)
      ) {
        bestBySourceSet.set(sourceKey, candidate);
      }
    });

  const deduplicatedCandidates = [...bestBySourceSet.values()];
  const generallyRanked = [...deduplicatedCandidates].sort((left, right) =>
    compareRankedEvidence(left, right, queryIntent)
  );
  const representatives = lifecycleChainRepresentatives(deduplicatedCandidates, queryIntent);
  const representativeIds = new Set(representatives.map((candidate) => candidate.item.id));
  const orderedCandidates = [
    ...representatives,
    ...generallyRanked.filter((candidate) => !representativeIds.has(candidate.item.id))
  ];
  const rankedEvidence = orderedCandidates
    .map(({ item }) => item)
    .slice(0, MAX_EVIDENCE_ITEMS);
  const reviewRanking: QaLexicalReviewCandidate[] = orderedCandidates
    .slice(0, 30)
    .map((candidate) => {
      const representative = representativeIds.has(candidate.item.id);
      return {
        evidence: candidate.item,
        score: candidate.score,
        duplicateRank: candidate.duplicateRank,
        lifecycleState: candidate.lifecycleState,
        topicOverlap: candidate.topicOverlap,
        representative,
        reasons: [
          `lexical_score:${candidate.score.toFixed(6)}`,
          `duplicate_rank:${candidate.duplicateRank}`,
          `lifecycle_state:${candidate.lifecycleState}`,
          `topic_overlap:${candidate.topicOverlap}`,
          ...(representative ? ["lifecycle_chain_representative"] : [])
        ]
      };
    });

  const result: QaEvidenceRetrievalResult = {
    evidence: rankedEvidence,
    relationshipContextBuildingMs,
    rerankingMs: safeElapsedMs(rerankingStartedAt, now()),
    lifecycleContext: {
      queryIntent,
      relevantEvidence: generallyRanked
        .filter((candidate) => candidate.topicOverlap >= MIN_LIFECYCLE_TOPIC_OVERLAP)
        .map((candidate) => ({
          item: candidate.item,
          state: candidate.lifecycleState,
          topicOverlap: candidate.topicOverlap
      }))
    }
  };
  Object.defineProperty(result, "reviewRanking", {
    value: reviewRanking,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return result;
}

export function retrieveQaEvidence(input: AnswerQuestionWithAIInput): QaRetrievedEvidence[] {
  return retrieveQaEvidenceWithDiagnostics(input).evidence;
}

function voiceQaShadowReviewMode() {
  const normalized =
    process.env.VOICE_QA_SHADOW_REVIEW_MODE?.trim().toLowerCase() || "off";
  return normalized === "off" || normalized === "collect"
    ? normalized
    : "invalid";
}

function enqueueVoiceQaShadowReview(
  input: AnswerQuestionWithAIInput,
  lexical: QaEvidenceRetrievalResult
) {
  const mode = voiceQaShadowReviewMode();
  const context = input.shadowReviewContext;
  if (mode === "invalid") {
    if (context) {
      console.warn(
        `[voice-qa-shadow-review] status=fallback scope=${input.scope ?? "current"} ` +
        "fallback_reason=invalid_configuration"
      );
    }
    return false;
  }
  if (mode !== "collect" || !context || !input.userId) return false;

  context.caseId ??= randomUUID();
  if (!context.started) {
    context.started = true;
    const caseId = context.caseId;
    void import("@/lib/server/evaluation/voice-qa-shadow-review")
      .then(({ collectVoiceQaShadowReviewRetrieval }) =>
        collectVoiceQaShadowReviewRetrieval({
          caseId,
          input,
          lexical
        })
      )
      .catch((error: unknown) => {
        console.warn(
          `[voice-qa-shadow-review] case_id=${caseId} ` +
          `scope=${input.scope ?? "current"} status=fallback ` +
          `fallback_reason=collector_unavailable ` +
          `error_name=${error instanceof Error ? error.name : "unknown"}`
        );
      });
  }
  return true;
}

function recordVoiceQaShadowReviewAnswer(input: {
  qaInput: AnswerQuestionWithAIInput;
  answer: QuestionAnswer;
  attemptKind:
    | "sync_primary"
    | "sync_fallback"
    | "final_projection";
  provider: string;
  selectedModel: string;
  providerMetadata?: {
    providerId: "gpt-5.5" | "qwen-vllm";
    wireApi: "chat" | "responses";
    reasoningEnabled: boolean | null;
    endpointFingerprint: string;
  };
  fallbackReason: string | null;
  systemPrompt?: string;
  userPrompt?: string;
  qaLatencyMs: number;
}) {
  const context = input.qaInput.shadowReviewContext;
  if (
    voiceQaShadowReviewMode() !== "collect" ||
    !context?.caseId ||
    !input.qaInput.userId
  ) {
    return;
  }
  const caseId = context.caseId;
  void import("@/lib/server/evaluation/voice-qa-shadow-review")
    .then(({ recordVoiceQaShadowReviewOfficialAnswer }) =>
      recordVoiceQaShadowReviewOfficialAnswer({
        caseId,
        userId: input.qaInput.userId!,
        answer: input.answer,
        attemptKind: input.attemptKind,
        provider: input.provider,
        selectedModel: input.selectedModel,
        ...(input.providerMetadata
          ? { providerMetadata: input.providerMetadata }
          : {}),
        fallbackReason: input.fallbackReason,
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
        ...(input.userPrompt ? { userPrompt: input.userPrompt } : {}),
        qaLatencyMs: input.qaLatencyMs
      })
    )
    .catch((error: unknown) => {
      console.warn(
        `[voice-qa-shadow-review] case_id=${caseId} ` +
        `scope=${input.qaInput.scope ?? "current"} status=fallback ` +
        `fallback_reason=answer_persistence_failed ` +
        `error_name=${error instanceof Error ? error.name : "unknown"}`
      );
    });
}

async function retrieveQaEvidenceForAnswer(
  input: AnswerQuestionWithAIInput
): Promise<QaEvidenceRetrievalResult> {
  throwIfQaAborted(input.signal);
  const lexical = retrieveQaEvidenceWithDiagnostics(input);
  // Lexical ranking is synchronous. It cannot be preempted mid-call, so both
  // sides are guarded to prevent cancelled work from reaching a Provider.
  throwIfQaAborted(input.signal);
  if (input.disableHybridRetrieval === true) {
    return {
      ...lexical,
      hybridDiagnostics: {
        mode: "off",
        denseRetrievalMs: null,
        indexCoverage: null,
        fallbackReason: null
      }
    };
  }
  if (enqueueVoiceQaShadowReview(input, lexical)) {
    return {
      ...lexical,
      hybridDiagnostics: {
        mode: "off",
        denseRetrievalMs: null,
        indexCoverage: null,
        fallbackReason: null
      }
    };
  }
  let mode: QaHybridRetrievalMode;
  try {
    mode = resolveQaHybridRetrievalMode();
  } catch (error) {
    console.warn(
      `[hybrid-qa] mode=off fallback_reason=invalid_configuration ` +
      `error_name=${error instanceof Error ? error.name : "unknown"}`
    );
    return {
      ...lexical,
      hybridDiagnostics: {
        mode: "off",
        denseRetrievalMs: null,
        indexCoverage: null,
        fallbackReason: "invalid_configuration"
      }
    };
  }
  if (mode === "off") {
    return {
      ...lexical,
      hybridDiagnostics: {
        mode,
        denseRetrievalMs: null,
        indexCoverage: null,
        fallbackReason: null
      }
    };
  }
  const runHybrid = async () => {
    const hybrid = await import("./hybrid/production-retrieval");
    try {
      return await hybrid.retrieveProductionHybridEvidence({
        qaInput: input,
        lexical
      });
    } catch (error) {
      const reason =
        error instanceof hybrid.ProductionHybridRetrievalError
          ? error.reason
          : "embedding_unavailable";
      const coverage =
        error instanceof hybrid.ProductionHybridRetrievalError
          ? error.indexCoverage
          : null;
      throw Object.assign(
        error instanceof Error ? error : new Error("Hybrid retrieval failed"),
        { hybridReason: reason, hybridCoverage: coverage }
      );
    }
  };
  if (mode === "shadow") {
    throwIfQaAborted(input.signal);
    void runHybrid().then((result) => {
      const lexicalIds = new Set(lexical.evidence.map((item) => item.id));
      const overlap = result.evidence.filter((item) => lexicalIds.has(item.id)).length;
      console.info(
        `[hybrid-qa] mode=shadow status=completed candidates=${result.evidence.length} ` +
        `overlap=${overlap} dense_ms=${result.denseRetrievalMs} ` +
        `index_coverage=${result.indexCoverage.toFixed(4)}`
      );
    }).catch((error: unknown) => {
      const detail = error as Error & {
        hybridReason?: string;
        hybridCoverage?: number | null;
      };
      console.warn(
        `[hybrid-qa] mode=shadow status=fallback ` +
        `fallback_reason=${detail.hybridReason ?? "embedding_unavailable"} ` +
        `index_coverage=${detail.hybridCoverage ?? "unknown"} ` +
        `error_name=${detail.name || "unknown"}`
      );
    });
    return {
      ...lexical,
      hybridDiagnostics: {
        mode,
        denseRetrievalMs: null,
        indexCoverage: null,
        fallbackReason: null
      }
    };
  }
  const hybridStartedAt = performance.now();
  try {
    const result = await runHybrid();
    throwIfQaAborted(input.signal);
    return {
      ...lexical,
      evidence: result.evidence,
      rerankingMs:
        lexical.rerankingMs + safeElapsedMs(hybridStartedAt),
      hybridDiagnostics: {
        mode,
        denseRetrievalMs: result.denseRetrievalMs,
        indexCoverage: result.indexCoverage,
        fallbackReason: null
      }
    };
  } catch (error) {
    if (isQaAbort(error, input.signal)) throw qaAbortError(input.signal);
    const detail = error as Error & {
      hybridReason?: string;
      hybridCoverage?: number | null;
    };
    const fallbackReason = detail.hybridReason ?? "embedding_unavailable";
    console.warn(
      `[hybrid-qa] mode=phase31 status=fallback fallback_reason=${fallbackReason} ` +
      `index_coverage=${detail.hybridCoverage ?? "unknown"} ` +
      `error_name=${detail.name || "unknown"}`
    );
    return {
      ...lexical,
      hybridDiagnostics: {
        mode,
        denseRetrievalMs: safeElapsedMs(hybridStartedAt),
        indexCoverage: detail.hybridCoverage ?? null,
        fallbackReason
      }
    };
  }
}

function qaHybridDiagnosticFields(retrieval: QaEvidenceRetrievalResult) {
  const diagnostics = retrieval.hybridDiagnostics;
  return diagnostics
    ? {
        retrievalMode: diagnostics.mode,
        denseRetrievalMs: diagnostics.denseRetrievalMs,
        embeddingIndexCoverage: diagnostics.indexCoverage,
        retrievalFallbackReason: diagnostics.fallbackReason
      }
    : {};
}

function evidencePrompt(evidence: EvidenceItem[]) {
  return evidence
    .map((item, index) => {
      const label = `E${index + 1}`;
      return `[${label}] ${item.startSeconds}-${item.endSeconds}s ${item.title}\n${compactText(item.text)}`;
    })
    .join("\n\n");
}

function evidenceSourceSemanticsPrompt(
  evidence: EvidenceItem[],
  context?: MemoryIndexQaContext
) {
  const attributions = context?.sourceAttributions ?? [];
  const lines = evidence.flatMap((item, index) => {
    const sourceIds = new Set(item.sourceSegmentIds);
    const source = attributions.find((candidate) =>
      candidate.sourceSegmentIds.some((sourceId) => sourceIds.has(sourceId))
    );
    if (!source) return [];
    const boundary = source.origin === "user_reflection"
      ? "Memory wording is user_confirmed_derived_content and is not a verbatim quote; cite only this canonical transcript Evidence."
      : source.origin === "unknown"
        ? "Do not infer a speaker, owner, or verbatim quote from this source."
        : "Treat Memory wording as navigation; cite only this canonical transcript Evidence.";
    return [`[E${index + 1}] ${source.statement} ${boundary}`];
  });
  return lines.length > 0
    ? `\n\n[Evidence source semantics]\n${lines.join("\n")}`
    : "";
}

function providerEvidencePrompt(input: {
  evidence: EvidenceItem[];
  queryIntent: QaQueryIntentAnalysis;
  view?: QaEvaluationEvidenceView;
  memoryContext?: MemoryIndexQaContext;
}) {
  if (input.view === undefined || input.view === "canonical") {
    return evidencePrompt(input.evidence)
      + evidenceSourceSemanticsPrompt(input.evidence, input.memoryContext);
  }
  if (input.view !== "compact") {
    throw new Error("Unknown evaluation Evidence view");
  }

  const projection = projectCompactEvidence({
    evidence: input.evidence,
    queryIntent: input.queryIntent
  });
  if (
    !projection.citationMappingUnchanged ||
    !projection.sourceIdsUnchanged ||
    !projection.lifecycleStateUnchanged
  ) {
    throw new Error("Compact Evidence projection failed safety invariants");
  }
  return compactEvidencePromptForEvaluation(projection)
    + evidenceSourceSemanticsPrompt(input.evidence, input.memoryContext);
}

type MemoryPromptResult = {
  text: string;
  memoryCount: number;
  evidenceCount: number;
};

function evidenceIdsForMemory(memory: MemoryIndexQaContext["memories"][number], evidence: EvidenceItem[]) {
  const sourceIds = new Set(memory.evidence.map((item) => item.sourceId));
  return evidence.flatMap((item, index) =>
    sourceIds.has(item.id) || item.sourceSegmentIds.some((id) => sourceIds.has(id))
      ? [`E${index + 1}`]
      : []
  );
}

function safeOwnerIdentityId(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[^\p{Letter}\p{Number}_:.-]+/gu, "_")
    .slice(0, 120);
}

function memoryOwnerPrompt(
  memoryId: string,
  context: MemoryIndexQaContext
) {
  const metadata = (context.ownerAttributions ?? []).find((item) => item.memoryId === memoryId);
  if (!metadata || metadata.scope === "unknown" || metadata.owner.type === "unknown" && metadata.scope !== "shared") {
    return "Owner attribution: unknown. Do not assign this memory to a specific person.";
  }
  if (metadata.scope === "shared") {
    const participantIds = metadata.participants
      .filter((participant) => participant.attribution.type === "known_identity")
      .map((participant) => safeOwnerIdentityId(participant.attribution.identityId ?? ""))
      .filter(Boolean);
    return participantIds.length > 0
      ? `Owner scope: shared. Known participant IDs: ${[...new Set(participantIds)].join(", ")}.`
      : "Owner scope: shared. Participant identities are not reliable enough to name.";
  }
  if (metadata.owner.type === "local_speaker") {
    return "Owner attribution: upload-local anonymous speaker. Do not treat it as a stable named identity.";
  }
  return `Owner attribution: known_identity id=${safeOwnerIdentityId(metadata.owner.identityId ?? "")} confidence=${metadata.owner.confidence.toFixed(2)} source=${metadata.owner.source}.`;
}

function memoryContextPrompt(
  scope: QaAnswerScope,
  context: MemoryIndexQaContext | undefined,
  evidence: EvidenceItem[]
): MemoryPromptResult {
  if (!context || scope === "relationship") {
    return { text: "", memoryCount: 0, evidenceCount: 0 };
  }

  const mapped = context.memories.flatMap((memory) => {
    const evidenceIds = [...new Set(evidenceIdsForMemory(memory, evidence))];
    if (evidenceIds.length === 0) {
      return [];
    }
    const dates = [...new Set(memory.evidence.map((item) => item.date))].sort();
    const caution = dates.length < 2
      ? "Caution: this memory currently maps to one evidence date and cannot establish a long-term pattern."
      : "Caution: treat this compressed memory as navigation and verify every claim with the listed original evidence.";
    const source = context.sourceAttributions?.find(
      (candidate) => candidate.memoryId === memory.id
    );
    return [{ memory, evidenceIds, dates, caution, source }];
  });
  if (mapped.length === 0) {
    return { text: "", memoryCount: 0, evidenceCount: 0 };
  }

  const evidenceIds = new Set(mapped.flatMap((item) => item.evidenceIds));
  const text = [
    "[Long-term memory]",
    "This is compressed supporting context, not direct fact. Use only the mapped original evidence in the answer.",
    ...mapped.map(({ memory, evidenceIds: mappedEvidenceIds, dates, caution, source }, index) =>
      [
        `[M${index + 1}] type=${memory.type} status=${memory.status} importance=${memory.importanceScore.toFixed(2)} occurrences=${memory.occurrenceCount}`,
        `Date coverage: ${dates.join(", ")}`,
        `Source semantics: ${source?.statement ?? "来源尚未完全确认"}`,
        `Content kind: ${source?.contentKind ?? "memory_navigation"}`,
        `Observation: ${compactText(`${memory.title}: ${memory.summary}`, 500)}`,
        memoryOwnerPrompt(memory.id, context),
        `Original evidence: ${mappedEvidenceIds.map((id) => `[${id}]`).join(" ")}`,
        caution
      ].join("\n")
    )
  ].join("\n\n");

  return { text, memoryCount: mapped.length, evidenceCount: evidenceIds.size };
}

function evidenceDates(evidence: EvidenceItem[]) {
  return [
    ...new Set(
      evidence.flatMap((item) => `${item.title}\n${item.text}`.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [])
    )
  ].sort();
}

function scopeMetadataPrompt(scope: QaAnswerScope, evidence: EvidenceItem[]) {
  const dates = evidenceDates(evidence);
  const dateText = dates.length > 0 ? dates.join(", ") : scope === "current" ? "当前录音" : "未从证据中识别到日期";

  return [`范围元信息：`, `- 范围：${qaScopeLabels[scope]}`, `- 可用证据日期：${dateText}`, `- 证据条数：${evidence.length}`].join("\n");
}

function citationIdsFromAnswer(answer: string, evidence: EvidenceItem[]) {
  const validIds = new Set(evidence.map((_, index) => `E${index + 1}`));
  const citedIds = [...answer.matchAll(/\[E(\d+)\]/g)]
    .map((match) => `E${match[1]}`)
    .filter((id) => validIds.has(id));

  return [...new Set(citedIds)];
}

function normalizeCitationIds(citationIds: string[], evidence: EvidenceItem[]) {
  const validIds = new Set(evidence.map((_, index) => `E${index + 1}`));

  return [...new Set(citationIds.filter((id) => validIds.has(id)))];
}

function evidenceForCitationIds(citationIds: string[], evidence: EvidenceItem[]) {
  return citationIds.flatMap((id) => {
    const index = Number.parseInt(id.slice(1), 10) - 1;
    return evidence[index] ? [evidence[index]] : [];
  });
}

function violatesRelationshipScopeBoundary(
  scope: QaAnswerScope,
  question: string,
  answerText: string,
  evidence: EvidenceItem[],
  citationIds: string[]
) {
  const citedEvidence = evidenceForCitationIds(citationIds, evidence);
  const asksForPattern =
    scope === "all" || scope === "relationship"
      ? /长期|反复|一直|模式|趋势/u.test(question)
      : scope === "week" && /本周|这一周/u.test(question) && /反复|变化|模式|趋势|一直/u.test(question);
  const longTermTerms = "长期|反复|一直|总是|每次|模式|趋势";
  const hasLongTermLanguage = new RegExp(longTermTerms, "u").test(answerText);
  const explicitlyUncertain =
    new RegExp(`(?:不能|不足以|无法|不代表|不可|仅凭|只有|尚不足).{0,24}(?:${longTermTerms})`, "u").test(answerText) ||
    new RegExp(`(?:${longTermTerms}).{0,24}(?:证据不足|不能判断|无法判断|需要更多证据|不成立)`, "u").test(answerText);
  const affirmativeLongTermClaim =
    hasLongTermLanguage &&
    !explicitlyUncertain &&
    (new RegExp(`(?:显示|说明|表明|证明|意味着|可以看出|属于|存在|就是|是|发现).{0,30}(?:${longTermTerms})`, "u").test(answerText) ||
      new RegExp(`(?:${longTermTerms}).{0,30}(?:回避|否定|模式|倾向|问题|态度|行为)`, "u").test(answerText));

  if (scope === "relationship") {
    return evidenceDates(citedEvidence).length < 2 && (asksForPattern || affirmativeLongTermClaim);
  }

  const relationshipEvidence = citedEvidence.filter((item) => item.relationshipSignal);
  if (relationshipEvidence.length === 0) {
    return false;
  }
  const relationshipDates = new Set(
    relationshipEvidence.flatMap((item) => (item.relationshipSignal?.recordingDate ? [item.relationshipSignal.recordingDate] : []))
  );

  if (scope === "current") {
    return affirmativeLongTermClaim;
  }

  return relationshipDates.size < 2 && (asksForPattern || affirmativeLongTermClaim);
}

function violatesMemoryScopeBoundary(
  scope: QaAnswerScope,
  question: string,
  answerText: string,
  evidence: EvidenceItem[],
  citationIds: string[],
  memoryPrompt: MemoryPromptResult
) {
  if (memoryPrompt.memoryCount === 0) {
    return false;
  }

  const patternTerms = /长期|反复|一直|总是|每次|模式|趋势|long[- ]?term|repeated|pattern|trend/i;
  const uncertainTerms = /证据不足|不足以|不能判断|无法判断|只看到|仅有|单次|单日|需要更多证据|insufficient|cannot conclude|single occurrence/i;
  const affirmativeTerms = /说明|显示|表明|证明|意味着|可以看出|属于|存在|就是|发现|shows|proves|indicates|demonstrates/i;
  const asksForPattern = patternTerms.test(question);
  const affirmativePattern = patternTerms.test(answerText) && affirmativeTerms.test(answerText) && !uncertainTerms.test(answerText);
  if (!asksForPattern && !affirmativePattern) {
    return false;
  }

  const citedEvidence = evidenceForCitationIds(citationIds, evidence);
  const citedDates = evidenceDates(citedEvidence);
  if (scope === "current") {
    return affirmativePattern;
  }
  if (scope === "week" || scope === "all") {
    return citedDates.length < 2 && !uncertainTerms.test(answerText);
  }
  return false;
}

function parseStructuredAiAnswer(answerText: string): StructuredAiAnswer | null {
  const trimmed = answerText.trim();
  const jsonText = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/u, "")
    .replace(/\s*```$/u, "")
    .trim();

  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const candidate = parsed as { mode?: unknown; answer?: unknown; citationIds?: unknown };
    if (candidate.mode !== "assistant_meta" && candidate.mode !== "memory_answer" && candidate.mode !== "unsupported") {
      return null;
    }

    const answer = typeof candidate.answer === "string" ? candidate.answer.trim() : "";
    if (!answer) {
      return null;
    }

    const citationIds = Array.isArray(candidate.citationIds)
      ? candidate.citationIds.filter((id): id is string => typeof id === "string")
      : [];

    return {
      mode: candidate.mode,
      answer,
      citationIds
    };
  } catch {
    return null;
  }
}

function answerLooksUnsupported(answer: string) {
  return /没有找到|证据不足|无法根据/i.test(answer);
}

function answerWithRelationshipBoundaries(answerText: string, citedEvidence: EvidenceItem[]) {
  const missingBoundaries = citedEvidence.flatMap((item) => {
    const signal = item.relationshipSignal;
    if (!signal) {
      return [];
    }

    const confidenceLabel = `${Math.round(signal.confidence * 100)}%`;
    if (answerText.includes(confidenceLabel) && answerText.includes(signal.caution)) {
      return [];
    }

    return [`- ${signal.label}：置信度 ${confidenceLabel}；${signal.caution}`];
  });

  return missingBoundaries.length > 0
    ? `${answerText.trim()}\n\n证据边界：\n${missingBoundaries.join("\n")}`
    : answerText.trim();
}

function buildAnswerFromAI(
  input: AnswerQuestionWithAIInput,
  answerText: string,
  evidence: EvidenceItem[],
  citationIds?: string[]
): QuestionAnswer {
  const citedIds = citationIds ? normalizeCitationIds(citationIds, evidence) : citationIdsFromAnswer(answerText, evidence);
  const citedEvidence = citedIds.flatMap((id) => {
    const index = Number.parseInt(id.slice(1), 10) - 1;
    return evidence[index] ? [{ id, item: evidence[index] }] : [];
  });
  const memoryProjection = (item: EvidenceItem) => {
    const sourceIds = new Set(item.sourceSegmentIds);
    const memories = input.memoryContext?.memories.filter((memory) =>
      memory.evidence.some((evidenceItem) => sourceIds.has(evidenceItem.sourceId))
    ) ?? [];
    if (memories.length === 0) return {};
    const memoryIds = memories.map((memory) => memory.id);
    const memoryEvidenceIds = memories.flatMap((memory) =>
      memory.evidence
        .filter((evidenceItem) => sourceIds.has(evidenceItem.sourceId))
        .map((evidenceItem) => evidenceItem.id)
    );
    const sources = input.memoryContext?.sourceAttributions?.filter((source) =>
      memoryIds.includes(source.memoryId)
    ) ?? [];
    const sourceOrigins = new Set(sources.map((source) => source.origin));
    const contentKinds = new Set(sources.map((source) => source.contentKind));
    return {
      memoryIds: [...new Set(memoryIds)],
      memoryEvidenceIds: [...new Set(memoryEvidenceIds)],
      ...(sourceOrigins.size === 1 ? { sourceOrigin: [...sourceOrigins][0] } : {}),
      ...(contentKinds.size === 1 ? { contentKind: [...contentKinds][0] } : {})
    };
  };

  return {
    id: randomUUID(),
    uploadId: input.uploadId,
    question: input.question,
    answer: answerWithRelationshipBoundaries(
      answerText,
      citedEvidence.map(({ item }) => item)
    ),
    citedSegmentIds: [...new Set(citedEvidence.flatMap(({ item }) => item.sourceSegmentIds))],
    citations: citedEvidence.map(({ id, item }) => ({
      id,
      title: item.title,
      startSeconds: item.startSeconds,
      endSeconds: item.endSeconds,
      excerpt: compactText(item.text, 220),
      sourceSegmentIds: item.sourceSegmentIds,
      ...memoryProjection(item)
    })),
    createdAt: new Date().toISOString()
  };
}

function groundedLifecycleUnsupportedAnswer(
  input: AnswerQuestionWithAIInput,
  evidence: EvidenceItem[],
  lifecycleContext: QaEvidenceRetrievalResult["lifecycleContext"]
) {
  const queryIntent = lifecycleContext.queryIntent;
  if (queryIntent.intent !== "lifecycle_resolution" || !queryIntent.asksForCompletionEvidence) {
    return null;
  }

  const selectedEvidenceIds = new Map(evidence.map((item, index) => [item.id, `E${index + 1}`]));
  const lifecycleFallbackKindRank: Record<EvidenceItem["kind"], number> = {
    brief: 5,
    relationship_signal: 4,
    raw: 3,
    semantic: 2,
    audio_emotion: 1,
    audio: 0
  };
  const selectedRelevant = lifecycleContext.relevantEvidence
    .filter(({ item }) => selectedEvidenceIds.has(item.id))
    .sort((left, right) =>
      lifecycleFallbackKindRank[right.item.kind] - lifecycleFallbackKindRank[left.item.kind] ||
      right.item.endSeconds - left.item.endSeconds ||
      left.item.id.localeCompare(right.item.id)
    );
  const resolvedEvidence = selectedRelevant.filter(({ state }) => state === "resolved");
  const pendingEvidence = selectedRelevant.filter(({ state }) => state === "pending");
  const selectDistinctEvidence = (
    candidates: typeof selectedRelevant,
    initial: typeof selectedRelevant = [],
    limit = 3
  ) => candidates.reduce<typeof selectedRelevant>((selected, candidate) => {
    if (selected.length >= limit) return selected;
    const alreadyCovered = candidate.item.sourceSegmentIds.some((sourceId) =>
      selected.some(({ item }) => item.sourceSegmentIds.includes(sourceId))
    );
    return alreadyCovered ? selected : [...selected, candidate];
  }, initial);
  const citationIdsFor = (items: typeof selectedRelevant) => items.flatMap(({ item }) => {
    const citationId = selectedEvidenceIds.get(item.id);
    return citationId ? [citationId] : [];
  });
  const citationsText = (citationIds: string[]) => citationIds.map((id) => `[${id}]`).join("");

  if (
    queryIntent.aggregateCommitmentCompletion &&
    resolvedEvidence.length > 0 &&
    pendingEvidence.length > 0
  ) {
    const resolved = selectDistinctEvidence(resolvedEvidence, [], 2);
    const pending = selectDistinctEvidence(pendingEvidence, resolved, 3).slice(resolved.length);
    const cited = [...resolved, ...pending];
    const citationIds = citationIdsFor(cited);
    const resolvedSummary = resolved.map(({ item }) => compactText(item.title, 80)).join("；");
    const pendingSummary = pending.map(({ item }) => compactText(item.title, 80)).join("；");
    return buildAnswerFromAI(
      input,
      `已完成证据：${resolvedSummary}。${citationsText(citationIdsFor(resolved))}\n` +
        `仍只有承诺：${pendingSummary}。${citationsText(citationIdsFor(pending))}\n` +
        "当前状态：只能确认部分完成，不能确认所有承诺都已完成。",
      evidence,
      citationIds
    );
  }

  if (resolvedEvidence.length > 0) {
    const cited = selectDistinctEvidence(resolvedEvidence);
    const citationIds = citationIdsFor(cited);
    const stateSummary = cited.map(({ item }) => compactText(item.title, 80)).join("；");
    return buildAnswerFromAI(
      input,
      `已完成证据：${stateSummary}。${citationsText(citationIds)}\n` +
        "当前状态：这些事项有完成记录；现有证据不能扩大为未列出事项也都已完成。",
      evidence,
      citationIds
    );
  }

  if (pendingEvidence.length > 0) {
    const cited = selectDistinctEvidence(pendingEvidence);
    const citationIds = citationIdsFor(cited);
    const precursorSummary = cited.map(({ item }) => compactText(item.title, 80)).join("；");
    const completionLabel = lifecycleCompletionLabel(input.question);
    return buildAnswerFromAI(
      input,
      `已承诺（目前只有计划或承诺记录）：${precursorSummary}。${citationsText(citationIds)}\n` +
        `已完成证据：没有找到${completionLabel}的记录。\n` +
        "当前状态：未知，不能推测相关承诺已经完成。",
      evidence,
      citationIds
    );
  }

  return null;
}

function safeUncertaintyAnswer(input: AnswerQuestionWithAIInput): QuestionAnswer {
  return {
    id: randomUUID(),
    uploadId: input.uploadId,
    question: input.question,
    answer: SAFE_UNCERTAINTY_ANSWER,
    citedSegmentIds: [],
    citations: [],
    createdAt: new Date().toISOString()
  };
}

type QaFallbackReason =
  | "none"
  | "insufficient_evidence"
  | "empty_answer"
  | "answer_too_long"
  | "forbidden_relationship_output"
  | "unsupported_answer"
  | "missing_citations"
  | "relationship_scope_boundary"
  | "memory_scope_boundary"
  | "assistant_meta_scope"
  | "provider_error"
  | "model_provider_mismatch";

function isQaModelProviderMismatchError(error: unknown) {
  return error instanceof Error && error.name === "QaModelProviderMismatchError";
}

function qaRunLog(input: {
  provider: "openrouter" | "openai-compatible" | "qwen-vllm";
  selectedModel: string;
  fallbackReason: QaFallbackReason;
  startedAt: number;
}) {
  return (
    `[qa] provider=${input.provider} selected_model=${input.selectedModel} ` +
    `fallback_reason=${input.fallbackReason} elapsed_ms=${Date.now() - input.startedAt}`
  );
}

type QaProviderAnswerFinalizationInput = {
  input: AnswerQuestionWithAIInput;
  scope: QaAnswerScope;
  answerMode: QaAnswerMode;
  answerText: string;
  evidence: EvidenceItem[];
  lifecycleContext: QaEvidenceRetrievalResult["lifecycleContext"];
  memoryPrompt: MemoryPromptResult;
  responseIntent: ReturnType<typeof classifyCompanionResponseIntent>;
};

type QaProviderAnswerFinalizationResult = {
  answer: QuestionAnswer;
  fallbackReason: QaFallbackReason;
};

function finalizeQaProviderAnswerText(
  context: QaProviderAnswerFinalizationInput
): QaProviderAnswerFinalizationResult {
  const {
    input,
    scope,
    answerMode,
    answerText,
    evidence,
    lifecycleContext,
    memoryPrompt,
    responseIntent
  } = context;
  const result = (
    answer: QuestionAnswer,
    fallbackReason: QaFallbackReason = "none"
  ): QaProviderAnswerFinalizationResult => ({ answer, fallbackReason });

  if (!answerText) {
    return result(safeUncertaintyAnswer(input), "empty_answer");
  }

  const isRelationshipQuestion =
    responseIntent === "relationship_understanding" ||
    isRelationshipEvidenceQuestion({
      question: input.question,
      conversation: input.conversation
    });
  if (
    isRelationshipQuestion &&
    (isForbiddenRelationshipQaOutput(answerText) || containsAbsoluteRelationshipConclusion(answerText))
  ) {
    return result(safeUncertaintyAnswer(input), "forbidden_relationship_output");
  }

  const structuredAnswer = parseStructuredAiAnswer(answerText);
  if (structuredAnswer) {
    if (structuredAnswer.mode === "assistant_meta") {
      if (answerMode === "direct" && !isAssistantMetaQuestion(input.question)) {
        return result(safeUncertaintyAnswer(input), "assistant_meta_scope");
      }
      return result(buildAnswerFromAI(input, structuredAnswer.answer, evidence, []));
    }
    if (structuredAnswer.answer.length > MAX_QA_PROVIDER_ANSWER_CHARACTERS) {
      return result(safeUncertaintyAnswer(input), "answer_too_long");
    }

    if (structuredAnswer.mode === "unsupported") {
      const groundedLifecycleAnswer = groundedLifecycleUnsupportedAnswer(
        input,
        evidence,
        lifecycleContext
      );
      if (groundedLifecycleAnswer) {
        return result(groundedLifecycleAnswer, "unsupported_answer");
      }
      return result(safeUncertaintyAnswer(input), "unsupported_answer");
    }

    const citationIds = normalizeCitationIds(structuredAnswer.citationIds, evidence);
    const inlineCitationIds = citationIdsFromAnswer(structuredAnswer.answer, evidence);
    if (citationIds.length === 0 && inlineCitationIds.length === 0) {
      return result(safeUncertaintyAnswer(input), "missing_citations");
    }

    const effectiveCitationIds = citationIds.length > 0 ? citationIds : inlineCitationIds;
    if (
      violatesRelationshipScopeBoundary(
        scope,
        input.question,
        structuredAnswer.answer,
        evidence,
        effectiveCitationIds
      )
    ) {
      return result(safeUncertaintyAnswer(input), "relationship_scope_boundary");
    }
    if (
      violatesMemoryScopeBoundary(
        scope,
        input.question,
        structuredAnswer.answer,
        evidence,
        effectiveCitationIds,
        memoryPrompt
      )
    ) {
      return result(safeUncertaintyAnswer(input), "memory_scope_boundary");
    }

    return result(
      buildAnswerFromAI(
        input,
        structuredAnswer.answer,
        evidence,
        effectiveCitationIds
      )
    );
  }

  if (answerText.length > MAX_QA_PROVIDER_ANSWER_CHARACTERS) {
    return result(safeUncertaintyAnswer(input), "answer_too_long");
  }
  const citationIds = citationIdsFromAnswer(answerText, evidence);
  if (citationIds.length === 0) {
    return result(
      safeUncertaintyAnswer(input),
      answerLooksUnsupported(answerText) ? "unsupported_answer" : "missing_citations"
    );
  }
  if (violatesRelationshipScopeBoundary(scope, input.question, answerText, evidence, citationIds)) {
    return result(safeUncertaintyAnswer(input), "relationship_scope_boundary");
  }
  if (violatesMemoryScopeBoundary(scope, input.question, answerText, evidence, citationIds, memoryPrompt)) {
    return result(safeUncertaintyAnswer(input), "memory_scope_boundary");
  }

  return result(buildAnswerFromAI(input, answerText, evidence));
}

function normalizeCompletedQaAnswer(
  input: Pick<AnswerQuestionWithAIInput, "question" | "conversation">,
  answer: QuestionAnswer
): QuestionAnswer {
  return {
    ...answer,
    answer: normalizeCompanionResponseStyle({
      question: input.question,
      conversation: input.conversation,
      answer: answer.answer
    })
  };
}

const QA_EVALUATION_EVIDENCE_DELIMITER = "\n\n本地证据：\n";

function qaEvaluationSha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function qaEvaluationPromptFingerprint(
  systemPrompt: string,
  userPrompt: string
) {
  return qaEvaluationSha256(JSON.stringify({
    systemPromptHash: qaEvaluationSha256(systemPrompt),
    userPromptHash: qaEvaluationSha256(userPrompt)
  }));
}

export type QaSelectedEvidenceEvaluationInput = {
  qaInput: AnswerQuestionWithAIInput;
  selectedEvidence: readonly QaRetrievedEvidence[];
  systemPrompt: string;
  userPromptPrefix: string;
  expectedEvidenceSectionHash?: string;
  expectedOfficialPromptFingerprint?: string;
  expectedMemoryCount?: number;
  expectedMemoryEvidenceCount?: number;
};

export type QaSelectedEvidenceEvaluationPreparation = {
  evidenceSection: string;
  evidenceSectionHash: string;
  systemPromptHash: string;
  userPromptPrefixHash: string;
  fullPromptFingerprint: string;
  memoryCount: number;
  memoryEvidenceCount: number;
  lexicalEvidenceIds: string[];
};

type InternalQaSelectedEvidenceEvaluationPreparation =
  QaSelectedEvidenceEvaluationPreparation & {
    qaInput: AnswerQuestionWithAIInput;
    selectedEvidence: QaRetrievedEvidence[];
    systemPrompt: string;
    userPrompt: string;
    scope: QaAnswerScope;
    answerMode: QaAnswerMode;
    lifecycleContext: QaEvidenceRetrievalResult["lifecycleContext"];
    memoryPrompt: MemoryPromptResult;
    responseIntent: ReturnType<typeof classifyCompanionResponseIntent>;
  };

function prepareQaSelectedEvidenceInternal(
  input: QaSelectedEvidenceEvaluationInput
): InternalQaSelectedEvidenceEvaluationPreparation {
  if (
    input.selectedEvidence.length === 0 ||
    input.selectedEvidence.length > MAX_EVIDENCE_ITEMS
  ) {
    throw new Error("Evaluation selected Evidence count is invalid");
  }
  const selectedEvidenceIds = new Set<string>();
  const selectedEvidence = input.selectedEvidence.map((item) => {
    if (selectedEvidenceIds.has(item.id)) {
      throw new Error("Evaluation selected Evidence ids must be unique");
    }
    selectedEvidenceIds.add(item.id);
    return {
      ...item,
      sourceSegmentIds: [...item.sourceSegmentIds],
      ...(item.relationshipSignal
        ? { relationshipSignal: { ...item.relationshipSignal } }
        : {})
    };
  });
  const lexical = retrieveQaEvidenceWithDiagnostics(input.qaInput);
  const scope = input.qaInput.scope ?? "current";
  const answerMode = input.qaInput.answerMode ?? "agent";
  const memoryPrompt = memoryContextPrompt(
    scope,
    input.qaInput.memoryContext,
    selectedEvidence
  );
  const evidenceSection = providerEvidencePrompt({
    evidence: selectedEvidence,
    queryIntent: lexical.lifecycleContext.queryIntent,
    view: "canonical",
    memoryContext: input.qaInput.memoryContext
  });
  if (
    input.userPromptPrefix.includes(QA_EVALUATION_EVIDENCE_DELIMITER) ||
    evidenceSection.includes(QA_EVALUATION_EVIDENCE_DELIMITER)
  ) {
    throw new Error("Evaluation Prompt Evidence delimiter is not unique");
  }
  const evidenceSectionHash = qaEvaluationSha256(evidenceSection);
  const userPrompt =
    input.userPromptPrefix +
    QA_EVALUATION_EVIDENCE_DELIMITER +
    evidenceSection;
  const fullPromptFingerprint = qaEvaluationPromptFingerprint(
    input.systemPrompt,
    userPrompt
  );
  if (
    input.expectedEvidenceSectionHash !== undefined &&
    input.expectedEvidenceSectionHash !== evidenceSectionHash
  ) {
    throw new Error("Evaluation Evidence section hash mismatch");
  }
  if (
    input.expectedOfficialPromptFingerprint !== undefined &&
    input.expectedOfficialPromptFingerprint !== fullPromptFingerprint
  ) {
    throw new Error("Evaluation official Prompt fingerprint mismatch");
  }
  if (
    input.expectedMemoryCount !== undefined &&
    input.expectedMemoryCount !== memoryPrompt.memoryCount
  ) {
    throw new Error("Evaluation Memory count mismatch");
  }
  if (
    input.expectedMemoryEvidenceCount !== undefined &&
    input.expectedMemoryEvidenceCount !== memoryPrompt.evidenceCount
  ) {
    throw new Error("Evaluation Memory Evidence count mismatch");
  }
  return {
    qaInput: input.qaInput,
    selectedEvidence,
    systemPrompt: input.systemPrompt,
    userPrompt,
    scope,
    answerMode,
    lifecycleContext: lexical.lifecycleContext,
    memoryPrompt,
    responseIntent: classifyCompanionResponseIntent(
      input.qaInput.question,
      input.qaInput.conversation
    ),
    evidenceSection,
    evidenceSectionHash,
    systemPromptHash: qaEvaluationSha256(input.systemPrompt),
    userPromptPrefixHash: qaEvaluationSha256(input.userPromptPrefix),
    fullPromptFingerprint,
    memoryCount: memoryPrompt.memoryCount,
    memoryEvidenceCount: memoryPrompt.evidenceCount,
    lexicalEvidenceIds: lexical.evidence.map((item) => item.id)
  };
}

/**
 * Evaluation-only preflight for a frozen selected-Evidence QA attempt.
 * It does not resolve or call a Provider and is not used by Text/Voice QA.
 */
export function prepareQaSelectedEvidenceForEvaluation(
  input: QaSelectedEvidenceEvaluationInput
): QaSelectedEvidenceEvaluationPreparation {
  const prepared = prepareQaSelectedEvidenceInternal(input);
  return {
    evidenceSection: prepared.evidenceSection,
    evidenceSectionHash: prepared.evidenceSectionHash,
    systemPromptHash: prepared.systemPromptHash,
    userPromptPrefixHash: prepared.userPromptPrefixHash,
    fullPromptFingerprint: prepared.fullPromptFingerprint,
    memoryCount: prepared.memoryCount,
    memoryEvidenceCount: prepared.memoryEvidenceCount,
    lexicalEvidenceIds: prepared.lexicalEvidenceIds
  };
}

export type QaSelectedEvidenceEvaluationAnswer = {
  answer: QuestionAnswer;
  fallbackReason: QaFallbackReason;
  providerId: "gpt-5.5";
  logProvider: "openrouter" | "openai-compatible";
  model: string;
  wireApi: "chat" | "responses";
  reasoningEnabled: boolean | null;
  endpointFingerprint: string;
  generationLatencyMs: number;
  evidenceSectionHash: string;
  fullPromptFingerprint: string;
  memoryCount: number;
  memoryEvidenceCount: number;
};

export type QaSelectedEvidenceEvaluationSession = {
  providerId: "gpt-5.5";
  logProvider: "openrouter" | "openai-compatible";
  model: string;
  wireApi: "chat" | "responses";
  reasoningEnabled: boolean | null;
  endpointFingerprint: string;
  answer(
    input: QaSelectedEvidenceEvaluationInput
  ): Promise<QaSelectedEvidenceEvaluationAnswer>;
};

/**
 * Evaluation-only selected-Evidence entry. It resolves the same configured
 * production GPT-5.5 Provider once, then reuses the canonical Evidence prompt,
 * lifecycle/Memory boundaries, finalizer, and response normalization.
 */
export async function createQaSelectedEvidenceEvaluationSession(input: {
  settingsStore?: JsonStore;
  expectedLogProvider: "openrouter" | "openai-compatible";
  expectedModel: string;
  expectedWireApi: "chat" | "responses";
  expectedReasoningEnabled: boolean | null;
  expectedEndpointFingerprint: string;
}): Promise<QaSelectedEvidenceEvaluationSession> {
  const provider = await resolveQaLlmProvider({
    settingsStore: input.settingsStore
  });
  if (
    provider.id !== "gpt-5.5" ||
    provider.logProvider === "qwen-vllm" ||
    provider.logProvider !== input.expectedLogProvider ||
    provider.model !== input.expectedModel ||
    provider.wireApi !== input.expectedWireApi ||
    provider.reasoningEnabled !== input.expectedReasoningEnabled ||
    provider.endpointFingerprint !== input.expectedEndpointFingerprint ||
    !/(?:^|\/)gpt-5\.5$/u.test(provider.model)
  ) {
    throw new Error("Evaluation Provider or model does not match official GPT-5.5");
  }
  const providerId = provider.id as "gpt-5.5";
  const logProvider = provider.logProvider as
    | "openrouter"
    | "openai-compatible";
  return {
    providerId,
    logProvider,
    model: provider.model,
    wireApi: provider.wireApi,
    reasoningEnabled: provider.reasoningEnabled,
    endpointFingerprint: provider.endpointFingerprint,
    async answer(
      selectedInput: QaSelectedEvidenceEvaluationInput
    ): Promise<QaSelectedEvidenceEvaluationAnswer> {
      const prepared = prepareQaSelectedEvidenceInternal(selectedInput);
      const startedAt = performance.now();
      const answerText = await provider.answerText(
        prepared.systemPrompt,
        prepared.userPrompt
      );
      const finalized = finalizeQaProviderAnswerText({
        input: prepared.qaInput,
        scope: prepared.scope,
        answerMode: prepared.answerMode,
        answerText,
        evidence: prepared.selectedEvidence,
        lifecycleContext: prepared.lifecycleContext,
        memoryPrompt: prepared.memoryPrompt,
        responseIntent: prepared.responseIntent
      });
      return {
        answer: normalizeCompletedQaAnswer(
          prepared.qaInput,
          finalized.answer
        ),
        fallbackReason: finalized.fallbackReason,
        providerId,
        logProvider,
        model: provider.model,
        wireApi: provider.wireApi,
        reasoningEnabled: provider.reasoningEnabled,
        endpointFingerprint: provider.endpointFingerprint,
        generationLatencyMs: safeElapsedMs(startedAt),
        evidenceSectionHash: prepared.evidenceSectionHash,
        fullPromptFingerprint: prepared.fullPromptFingerprint,
        memoryCount: prepared.memoryCount,
        memoryEvidenceCount: prepared.memoryEvidenceCount
      };
    }
  };
}

/**
 * Mirrors the production evidence-poor path without resolving a Provider.
 * Consumers persist only the deterministic answer/citations projection.
 */
export function noProviderQaAnswerForEvaluation(
  input: AnswerQuestionWithAIInput
) {
  return normalizeCompletedQaAnswer(input, safeUncertaintyAnswer(input));
}

export function qaSelectedEvidenceCitationValidityForEvaluation(
  answer: QuestionAnswer,
  evidence: readonly QaRetrievedEvidence[]
) {
  const byCitationId = new Map<string, QaRetrievedEvidence>(
    evidence.map((item, index) => [`E${index + 1}`, item] as const)
  );
  const citations = answer.citations ?? [];
  const citationIds = citations.map((citation) => citation.id);
  if (new Set(citationIds).size !== citationIds.length) return false;
  const inlineCitationIds = [
    ...answer.answer.matchAll(/\[(E\d+)\]/gu)
  ].map((match) => match[1]!);
  if (
    inlineCitationIds.some(
      (citationId) => !byCitationId.has(citationId)
    )
  ) {
    return false;
  }
  for (const citation of citations) {
    const selected = byCitationId.get(citation.id);
    if (
      !selected ||
      citation.title !== selected.title ||
      citation.startSeconds !== selected.startSeconds ||
      citation.endSeconds !== selected.endSeconds ||
      citation.excerpt !== compactText(selected.text, 220) ||
      citation.sourceSegmentIds.length !== selected.sourceSegmentIds.length ||
      !citation.sourceSegmentIds.every(
        (sourceId, index) => sourceId === selected.sourceSegmentIds[index]
      )
    ) {
      return false;
    }
  }
  const citedSourceIds = [
    ...new Set(citations.flatMap((citation) => citation.sourceSegmentIds))
  ].sort();
  return (
    answer.citedSegmentIds.length === citedSourceIds.length &&
    [...answer.citedSegmentIds].sort().every(
      (sourceId, index) => sourceId === citedSourceIds[index]
    )
  );
}

function sameCanonicalIds(left: readonly string[], right: readonly string[]) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function violatesProvisionalOwnerBoundary(
  input: AnswerQuestionWithAIInput,
  supportIds: readonly string[],
  sentence: string
) {
  const supportIdSet = new Set(supportIds);
  const relevantOwners = (input.memoryContext?.ownerAttributions ?? []).filter((metadata) =>
    metadata.evidenceSegmentIds.some((sourceId) => supportIdSet.has(sourceId))
  );
  const hasUnresolvedOwner = relevantOwners.some((metadata) =>
    metadata.scope === "unknown" ||
    metadata.owner.type === "unknown" ||
    metadata.owner.type === "local_speaker"
  );
  if (!hasUnresolvedOwner) return false;

  const preservesUncertainty =
    /(?:不能|无法|尚未|还不能|不确定|未知).{0,16}(?:确认|判断|归属|是谁)|(?:cannot|can'?t|unable to|unknown|uncertain).{0,20}(?:confirm|attribute|identify)/iu
      .test(sentence);
  if (preservesUncertainty) return false;

  const namedOwnerClaim =
    /(?:他|她|对方|伴侣|男朋友|女朋友|partner|he|she).{0,24}(?:喜欢|偏好|不喜欢|不吃|爱吃|答应|承诺|负责|会做|likes?|prefers?|dislikes?|promised?|committed|responsible)/iu
      .test(sentence) ||
    /(?:偏好|承诺|责任|preference|commitment).{0,16}(?:是|属于|来自|belongs? to|is).{0,12}(?:他|她|对方|伴侣|男朋友|女朋友|partner|he|she)/iu
      .test(sentence);
  return namedOwnerClaim;
}

function isUncertaintyBearingSentence(sentence: string) {
  return /(?:证据(?:不足|有限|不够)|没有(?:找到|足够)?证据|尚未(?:确认|确定)|还不能(?:确认|确定|判断)|无法(?:确认|确定|判断)|不能(?:确认|确定|判断)|不确定|未知|未确认)/u
    .test(sentence);
}

/**
 * Reuses the production finalizer as a deterministic sentence-local policy
 * gate. The sentence has already passed the strict citation allowlist in
 * SentenceCommitManager; this layer preserves relationship, lifecycle, memory
 * owner, and scope boundaries before an early event can leave quarantine.
 */
function provisionalSentenceSafetyReason(input: {
  sentence: ProvisionalSentenceCommitInput;
  qaInput: AnswerQuestionWithAIInput;
  scope: QaAnswerScope;
  answerMode: QaAnswerMode;
  evidence: EvidenceItem[];
  lifecycleContext: QaEvidenceRetrievalResult["lifecycleContext"];
  memoryPrompt: MemoryPromptResult;
  responseIntent: ReturnType<typeof classifyCompanionResponseIntent>;
}): SentenceCommitReason | null {
  if (
    input.qaInput.withholdUncertainProvisionalSentences === true &&
    isUncertaintyBearingSentence(input.sentence.sentence)
  ) {
    return "safety_boundary";
  }
  const finalized = finalizeQaProviderAnswerText({
    input: input.qaInput,
    scope: input.scope,
    answerMode: input.answerMode,
    answerText: JSON.stringify({
      mode: "memory_answer",
      answer: input.sentence.sentence,
      citationIds: input.sentence.citationIds
    }),
    evidence: input.evidence,
    lifecycleContext: input.lifecycleContext,
    memoryPrompt: input.memoryPrompt,
    responseIntent: input.responseIntent
  });
  if (finalized.fallbackReason !== "none") return "safety_boundary";
  if (finalized.answer.answer.trim() !== input.sentence.sentence.trim()) {
    return "safety_boundary";
  }
  if (!sameCanonicalIds(finalized.answer.citedSegmentIds, input.sentence.supportIds)) {
    return "citation_metadata_mismatch";
  }
  if (
    violatesProvisionalOwnerBoundary(
      input.qaInput,
      input.sentence.supportIds,
      input.sentence.sentence
    )
  ) {
    return "safety_boundary";
  }

  const selectedEvidence = input.sentence.citationIds.flatMap((citationId) => {
    const index = Number.parseInt(citationId.slice(1), 10) - 1;
    return input.evidence[index] ? [input.evidence[index]!] : [];
  });
  const sentenceTokens = meaningfulTextTokens(input.sentence.sentence);
  const evidenceTokens = meaningfulTextTokens(
    selectedEvidence.map((item) => `${item.title}\n${item.text}`).join("\n")
  );
  if (
    sentenceTokens.size === 0 ||
    evidenceTokens.size === 0 ||
    sharedTokenCount(sentenceTokens, evidenceTokens) === 0
  ) {
    return "safety_boundary";
  }

  const queryIntent = input.lifecycleContext.queryIntent;
  if (queryIntent.intent === "lifecycle_resolution" && queryIntent.asksForCompletionEvidence) {
    const selectedIds = new Set(selectedEvidence.map((item) => item.id));
    const selectedStates = input.lifecycleContext.relevantEvidence
      .filter(({ item }) => selectedIds.has(item.id))
      .map(({ state }) => state);
    const sentenceState = assessQaLifecycleEvidence(
      queryIntent,
      input.sentence.sentence
    ).state;
    if (sentenceState === "resolved" && !selectedStates.includes("resolved")) {
      return "safety_boundary";
    }
    if (
      queryIntent.aggregateCommitmentCompletion &&
      sentenceState === "resolved" &&
      selectedStates.includes("pending")
    ) {
      return "safety_boundary";
    }
  }
  return null;
}

export async function answerQuestionWithAI(input: AnswerQuestionWithAIInput): Promise<QuestionAnswer> {
  throwIfQaAborted(input.signal);
  const totalStartedAt = performance.now();
  const scope: QaAnswerScope = input.relationshipScope === true
    ? "relationship"
    : input.scope ?? "current";
  const answerMode = input.answerMode ?? "agent";
  const retrieval = await retrieveQaEvidenceForAnswer(input);
  throwIfQaAborted(input.signal);
  const evidence = retrieval.evidence;
  notifyQaExecutionMilestone(input.onExecutionMilestone, "retrieval_complete");
  if (input.evaluationEvidenceView === undefined) {
    observeCompactEvidenceShadow({
      attempt: "sync",
      evidence,
      queryIntent: retrieval.lifecycleContext.queryIntent
    });
  }
  try {
    const observerResult = input.onRetrievedEvidence?.(
      snapshotQaEvidence(evidence),
      retrieval.relationshipContextBuildingMs + retrieval.rerankingMs
    );
    if (observerResult && typeof (observerResult as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(observerResult).catch((error: unknown) => {
        console.warn(
          `[qa-observability] evidence_observer_failed error_name=${error instanceof Error ? error.name : "unknown"}`
        );
      });
    }
  } catch (error) {
    console.warn(
      `[qa-observability] evidence_observer_failed error_name=${error instanceof Error ? error.name : "unknown"}`
    );
  }
  const initialPromptConstructionStartedAt = performance.now();
  const memoryPrompt = memoryContextPrompt(scope, input.memoryContext, evidence);
  const responseIntent = classifyCompanionResponseIntent(input.question, input.conversation);
  const responseStyleInstruction = buildCompanionResponseStyleInstruction({
    question: input.question,
    conversation: input.conversation
  });
  const initialPromptConstructionMs = safeElapsedMs(initialPromptConstructionStartedAt);
  const startedAt = Date.now();
  let provider: "openrouter" | "openai-compatible" | "qwen-vllm" = "openai-compatible";
  let selectedModel = "unresolved";
  let promptConstructionMs: number | null = null;
  let llmGenerationMs: number | null = null;
  let responseValidationMs: number | null = null;
  let promptCharacters: number | null = null;
  let responseCharacters: number | null = null;
  let providerCallCount = 0;
  let validationStartedAt: number | null = null;
  let diagnosticsEmitted = false;
  let reviewSystemPrompt: string | undefined;
  let reviewUserPrompt: string | undefined;
  let reviewProviderMetadata:
    | NonNullable<
        Parameters<typeof recordVoiceQaShadowReviewAnswer>[0]["providerMetadata"]
      >
    | undefined;
  const emitDiagnostics = (fallbackReason: QaFallbackReason) => {
    if (diagnosticsEmitted) return;
    diagnosticsEmitted = true;
    const diagnostics: QaExecutionDiagnostics = {
      answerMode,
      memoryRetrievalMs: input.memoryRetrievalMs ?? null,
      relationshipContextBuildingMs: retrieval.relationshipContextBuildingMs,
      rerankingMs: retrieval.rerankingMs,
      promptConstructionMs,
      llmGenerationMs,
      responseValidationMs,
      totalMs: safeElapsedMs(totalStartedAt),
      promptCharacters,
      responseCharacters,
      evidenceCount: evidence.length,
      providerCallCount,
      fallbackReason,
      ...qaHybridDiagnosticFields(retrieval)
    };
    notifyQaExecutionDiagnostics(input.onDiagnostics, diagnostics);
  };
  const complete = (answer: QuestionAnswer, fallbackReason: QaFallbackReason = "none") => {
    const normalizedAnswer = normalizeCompletedQaAnswer(input, answer);
    if (validationStartedAt !== null) {
      responseValidationMs = safeElapsedMs(validationStartedAt);
    }
    console.info(
      `[memory-qa] scope=${scope} memories_used=${memoryPrompt.memoryCount} evidence_used=${memoryPrompt.evidenceCount} fallback=${input.memoryIndexFallback === true}`
    );
    const message = qaRunLog({ provider, selectedModel, fallbackReason, startedAt });
    if (fallbackReason === "provider_error") {
      console.warn(message);
    } else {
      console.info(message);
    }
    emitDiagnostics(fallbackReason);
    recordVoiceQaShadowReviewAnswer({
      qaInput: input,
      answer: normalizedAnswer,
      attemptKind: input.shadowReviewAttemptKind ?? "sync_primary",
      provider,
      selectedModel,
      ...(reviewProviderMetadata
        ? { providerMetadata: reviewProviderMetadata }
        : {}),
      fallbackReason,
      ...(reviewSystemPrompt ? { systemPrompt: reviewSystemPrompt } : {}),
      ...(reviewUserPrompt ? { userPrompt: reviewUserPrompt } : {}),
      qaLatencyMs: safeElapsedMs(totalStartedAt)
    });
    return normalizedAnswer;
  };

  if (evidence.length === 0 && !isAssistantMetaQuestion(contextualQuestion(input))) {
    return complete(safeUncertaintyAnswer(input), "insufficient_evidence");
  }

  try {
    const [llmProvider, savedQaPromptInstruction] = await Promise.all([
      resolveQaLlmProvider({
        settingsStore: input.settingsStore,
        providerId: input.llmProviderId,
        allowQwenInProduction: input.allowQwenInProduction
      }),
      getQaPromptPreference(input.settingsStore)
    ]);
    provider = llmProvider.logProvider;
    selectedModel = llmProvider.model;
    reviewProviderMetadata = {
      providerId: llmProvider.id,
      wireApi: llmProvider.wireApi,
      reasoningEnabled: llmProvider.reasoningEnabled,
      endpointFingerprint: llmProvider.endpointFingerprint
    };
    const providerPromptStartedAt = performance.now();
    const qaPromptInstruction = input.qaPromptInstruction?.trim() || savedQaPromptInstruction;
    const systemPrompt = answerMode === "direct"
      ? buildDirectContextQaSystemPrompt(scope, qaPromptInstruction)
      : buildHumanizedQaSystemPrompt(scope, qaPromptInstruction);
    const userPrompt = `${conversationPrompt(input.conversation)}当前问题：${input.question}\n问答范围：${qaScopeLabels[scope]}\n\n回答风格：\n${responseStyleInstruction}\n\n${scopeMetadataPrompt(scope, evidence)}${memoryPrompt.text ? `\n\n${memoryPrompt.text}` : ""}\n\n本地证据：\n${providerEvidencePrompt({
      evidence,
      queryIntent: retrieval.lifecycleContext.queryIntent,
      view: input.evaluationEvidenceView,
      memoryContext: input.memoryContext
    })}`;
    reviewSystemPrompt = systemPrompt;
    reviewUserPrompt = userPrompt;
    promptCharacters = systemPrompt.length + userPrompt.length;
    promptConstructionMs = initialPromptConstructionMs + safeElapsedMs(providerPromptStartedAt);
    providerCallCount = 1;
    const generationStartedAt = performance.now();
    let answerText: string;
    try {
      throwIfQaAborted(input.signal);
      notifyQaExecutionMilestone(input.onExecutionMilestone, "llm_started");
      answerText = await llmProvider.answerText(
        systemPrompt,
        userPrompt,
        input.onProviderMetrics,
        input.signal
      );
      throwIfQaAborted(input.signal);
    } finally {
      llmGenerationMs = safeElapsedMs(generationStartedAt);
    }
    responseCharacters = answerText.length;
    validationStartedAt = performance.now();
    const finalized = finalizeQaProviderAnswerText({
      input,
      scope,
      answerMode,
      answerText,
      evidence,
      lifecycleContext: retrieval.lifecycleContext,
      memoryPrompt,
      responseIntent
    });
    return complete(finalized.answer, finalized.fallbackReason);
  } catch (error) {
    if (isQaAbort(error, input.signal)) throw qaAbortError(input.signal);
    if (isQaModelProviderMismatchError(error)) {
      const mismatchedModel = (error as Error & { model?: unknown }).model;
      if (typeof mismatchedModel === "string" && mismatchedModel.trim()) {
        selectedModel = mismatchedModel.trim();
      }
      if (input.failClosedOnModelProviderMismatch === true) {
        if (promptConstructionMs === null) promptConstructionMs = initialPromptConstructionMs;
        return complete(safeUncertaintyAnswer(input), "model_provider_mismatch");
      }
      console.warn(qaRunLog({ provider, selectedModel, fallbackReason: "model_provider_mismatch", startedAt }));
      if (promptConstructionMs === null) promptConstructionMs = initialPromptConstructionMs;
      emitDiagnostics("model_provider_mismatch");
      throw error;
    }

    if (promptConstructionMs === null) promptConstructionMs = initialPromptConstructionMs;
    return complete(safeUncertaintyAnswer(input), "provider_error");
  }
}

/**
 * Sentence Commit v2 QA streaming.
 *
 * Raw Provider deltas remain quarantined. A complete sentence can leave that
 * quarantine before the enclosing JSON finishes only after its inline
 * citations resolve through the current Evidence allowlist and the
 * deterministic relationship/lifecycle/owner/scope policy gate accepts it.
 * The canonical final QuestionAnswer still requires the existing whole-answer
 * parser and validator and remains the only persistable answer object.
 */
export async function* answerQuestionStream(
  input: AnswerQuestionStreamInput
): AsyncGenerator<QaAnswerStreamEvent> {
  throwIfQaAborted(input.signal);
  const recorder = createQaStreamingTraceRecorder();
  yield {
    type: "stream_started",
    streamId: recorder.streamId,
    timestamp: recorder.startedAt
  };

  const totalStartedAt = performance.now();
  const scope: QaAnswerScope = input.relationshipScope === true
    ? "relationship"
    : input.scope ?? "current";
  const answerMode = input.answerMode ?? "agent";
  let tokenChunkCount = 0;
  let accumulatedText = "";
  let source: Extract<QaAnswerStreamEvent, { type: "final" }>["source"] = "provider_stream";
  let fallbackReason: QaStreamingFallbackReason | null = null;
  let streamAttempted = false;
  let answer: QuestionAnswer;
  let sentenceCommitEvidence: SentenceCommitEvidence[] = [];
  let sentenceCommitManager: SentenceCommitManager | null = null;
  let providerMetrics: import("./qa-streaming").QaStreamingProviderMetrics | undefined;
  const observeProviderMetrics: QaLlmProviderMetricsObserver | undefined =
    input.onProviderMetrics || process.env.QA_PROVIDER_USAGE_METRICS === "1"
      ? (metrics) => {
          providerMetrics = metrics;
          return input.onProviderMetrics?.(metrics);
        }
      : undefined;
  const emittedSentenceSignatures = new Set<string>();
  let emittedSentenceCount = 0;
  let firstTokenMilestoneObserved = false;
  let reviewProvider = "unresolved";
  let reviewSelectedModel = "unresolved";
  let reviewSystemPrompt: string | undefined;
  let reviewUserPrompt: string | undefined;
  let reviewProviderMetadata:
    | NonNullable<
        Parameters<typeof recordVoiceQaShadowReviewAnswer>[0]["providerMetadata"]
      >
    | undefined;

  try {
    const retrieval = await retrieveQaEvidenceForAnswer(input);
    throwIfQaAborted(input.signal);
    const evidence = retrieval.evidence;
    notifyQaExecutionMilestone(input.onExecutionMilestone, "retrieval_complete");
    if (input.evaluationEvidenceView === undefined) {
      observeCompactEvidenceShadow({
        attempt: "stream",
        evidence,
        queryIntent: retrieval.lifecycleContext.queryIntent
      });
    }
    sentenceCommitEvidence = evidence.map((item, index) => ({
      citationId: `E${index + 1}`,
      supportIds: item.sourceSegmentIds
    }));
    try {
      const observerResult = input.onRetrievedEvidence?.(
        snapshotQaEvidence(evidence),
        retrieval.relationshipContextBuildingMs + retrieval.rerankingMs
      );
      if (observerResult && typeof (observerResult as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(observerResult).catch((error: unknown) => {
          console.warn(
            `[qa-observability] evidence_observer_failed error_name=${error instanceof Error ? error.name : "unknown"}`
          );
        });
      }
    } catch (error) {
      console.warn(
        `[qa-observability] evidence_observer_failed error_name=${error instanceof Error ? error.name : "unknown"}`
      );
    }

    if (evidence.length === 0 && !isAssistantMetaQuestion(contextualQuestion(input))) {
      const fallbackAnswer = normalizeCompletedQaAnswer(input, safeUncertaintyAnswer(input));
      const fallbackTrace = recorder.complete({
        status: "completed_with_fallback",
        tokenChunkCount: 0,
        sentenceCount: 0,
        providerCallCount: 0,
        fallbackReason: "insufficient_evidence"
      });
      notifyQaExecutionDiagnostics(input.onDiagnostics, {
        answerMode,
        memoryRetrievalMs: input.memoryRetrievalMs ?? null,
        relationshipContextBuildingMs: retrieval.relationshipContextBuildingMs,
        rerankingMs: retrieval.rerankingMs,
        promptConstructionMs: null,
        llmGenerationMs: null,
        responseValidationMs: null,
        totalMs: safeElapsedMs(totalStartedAt),
        promptCharacters: null,
        responseCharacters: 0,
        evidenceCount: 0,
        providerCallCount: 0,
        fallbackReason: "insufficient_evidence",
        ...qaHybridDiagnosticFields(retrieval)
      });
      notifyQaStreamingTrace(input.onStreamTrace, fallbackTrace);
      recordVoiceQaShadowReviewAnswer({
        qaInput: input,
        answer: fallbackAnswer,
        attemptKind: "final_projection",
        provider: reviewProvider,
        selectedModel: reviewSelectedModel,
        fallbackReason: "insufficient_evidence",
        qaLatencyMs: safeElapsedMs(totalStartedAt)
      });
      yield {
        type: "final",
        answer: fallbackAnswer,
        source: "non_stream_fallback",
        trace: fallbackTrace
      };
      return;
    }

    const initialPromptConstructionStartedAt = performance.now();
    const memoryPrompt = memoryContextPrompt(scope, input.memoryContext, evidence);
    const responseIntent = classifyCompanionResponseIntent(input.question, input.conversation);
    const responseStyleInstruction = buildCompanionResponseStyleInstruction({
      question: input.question,
      conversation: input.conversation
    });
    sentenceCommitManager = createSentenceCommitManager({
      evidence: sentenceCommitEvidence,
      validateProvisionalSentence: (sentence) => provisionalSentenceSafetyReason({
        sentence,
        qaInput: input,
        scope,
        answerMode,
        evidence,
        lifecycleContext: retrieval.lifecycleContext,
        memoryPrompt,
        responseIntent
      })
    });
    const initialPromptConstructionMs = safeElapsedMs(initialPromptConstructionStartedAt);
    const [llmProvider, savedQaPromptInstruction] = await Promise.all([
      resolveQaLlmProvider({
        settingsStore: input.settingsStore,
        providerId: input.llmProviderId,
        allowQwenInProduction: input.allowQwenInProduction
      }),
      getQaPromptPreference(input.settingsStore)
    ]);
    reviewProvider = llmProvider.logProvider;
    reviewSelectedModel = llmProvider.model;
    reviewProviderMetadata = {
      providerId: llmProvider.id,
      wireApi: llmProvider.wireApi,
      reasoningEnabled: llmProvider.reasoningEnabled,
      endpointFingerprint: llmProvider.endpointFingerprint
    };
    const providerPromptStartedAt = performance.now();
    const qaPromptInstruction = input.qaPromptInstruction?.trim() || savedQaPromptInstruction;
    const systemPrompt = answerMode === "direct"
      ? buildDirectContextQaSystemPrompt(scope, qaPromptInstruction)
      : buildHumanizedQaSystemPrompt(scope, qaPromptInstruction);
    const userPrompt = `${conversationPrompt(input.conversation)}当前问题：${input.question}\n问答范围：${qaScopeLabels[scope]}\n\n回答风格：\n${responseStyleInstruction}\n\n${scopeMetadataPrompt(scope, evidence)}${memoryPrompt.text ? `\n\n${memoryPrompt.text}` : ""}\n\n本地证据：\n${providerEvidencePrompt({
      evidence,
      queryIntent: retrieval.lifecycleContext.queryIntent,
      view: input.evaluationEvidenceView,
      memoryContext: input.memoryContext
    })}`;
    reviewSystemPrompt = systemPrompt;
    reviewUserPrompt = userPrompt;
    const promptCharacters = systemPrompt.length + userPrompt.length;
    const promptConstructionMs = initialPromptConstructionMs + safeElapsedMs(providerPromptStartedAt);
    const generationStartedAt = performance.now();
    streamAttempted = true;
    recorder.markProviderStarted();
    try {
      throwIfQaAborted(input.signal);
      notifyQaExecutionMilestone(input.onExecutionMilestone, "llm_started");
      for await (const delta of llmProvider.answerTextStream(
        systemPrompt,
        userPrompt,
        observeProviderMetrics,
        input.signal
      )) {
        throwIfQaAborted(input.signal);
        if (!delta) continue;
        if (!firstTokenMilestoneObserved) {
          firstTokenMilestoneObserved = true;
          notifyQaExecutionMilestone(input.onExecutionMilestone, "llm_first_token");
        }
        tokenChunkCount += 1;
        accumulatedText += delta;
        const sentenceSnapshot = sentenceCommitManager.ingestDelta(delta);
        if (sentenceSnapshot.candidates.length > 0) {
          recorder.markFirstSentenceCandidate();
        }
        recorder.markFirstToken();
        yield {
          type: "token",
          sequence: tokenChunkCount,
          quarantinedText: delta,
          safeForSpeech: false,
          safeForPersistence: false,
          validated: false
        };
        for (const result of sentenceCommitManager.drainCommitted()) {
          if (
            input.withholdUncertainProvisionalSentences === true &&
            emittedSentenceCount >= MAX_VOICE_PROVISIONAL_SENTENCES
          ) {
            continue;
          }
          const signature = JSON.stringify([
            result.sentence,
            result.citationIds,
            result.supportIds
          ]);
          if (emittedSentenceSignatures.has(signature)) continue;
          emittedSentenceSignatures.add(signature);
          emittedSentenceCount += 1;
          recorder.markFirstSentenceValidated();
          recorder.markFirstSentence();
          yield {
            type: "sentence_completed",
            sequence: result.sequence,
            sentence: result.sentence,
            text: result.sentence,
            citationIds: result.citationIds,
            supportIds: result.supportIds,
            citedSegmentIds: result.citedSegmentIds,
            groundingValidated: true,
            safeForSpeech: false,
            safeForPersistence: false,
            requiresResponseOptimization: true,
            validated: true,
            status: "committed",
            reason: "grounded"
          };
        }
      }
    } finally {
      recorder.markProviderEnded();
    }
    throwIfQaAborted(input.signal);
    // The normal generation metric continues to cover the full provider stream.
    const llmGenerationMs = safeElapsedMs(generationStartedAt);

    if (!accumulatedText.trim()) {
      fallbackReason = "empty_stream";
      throw new Error("QA stream produced no text deltas");
    }

    const validationStartedAt = performance.now();
    const finalized = finalizeQaProviderAnswerText({
      input,
      scope,
      answerMode,
      answerText: accumulatedText.trim(),
      evidence,
      lifecycleContext: retrieval.lifecycleContext,
      memoryPrompt,
      responseIntent
    });
    answer = normalizeCompletedQaAnswer(input, finalized.answer);
    const responseValidationMs = safeElapsedMs(validationStartedAt);
    fallbackReason = finalized.fallbackReason === "none" ? null : finalized.fallbackReason;
    if (fallbackReason) source = "provider_stream_validation_fallback";
    notifyQaExecutionDiagnostics(input.onDiagnostics, {
      answerMode,
      memoryRetrievalMs: input.memoryRetrievalMs ?? null,
      relationshipContextBuildingMs: retrieval.relationshipContextBuildingMs,
      rerankingMs: retrieval.rerankingMs,
      promptConstructionMs,
      llmGenerationMs,
      responseValidationMs,
      totalMs: safeElapsedMs(totalStartedAt),
      promptCharacters,
      responseCharacters: accumulatedText.length,
      evidenceCount: evidence.length,
      providerCallCount: 1,
      fallbackReason: finalized.fallbackReason,
      ...qaHybridDiagnosticFields(retrieval)
    });
  } catch (streamError) {
    sentenceCommitManager?.cancel(
      streamError instanceof QaProviderStreamError ? streamError.code : "provider_error"
    );
    if (isQaAbort(streamError, input.signal)) {
      throw qaAbortError(input.signal);
    }
    source = "non_stream_fallback";
    fallbackReason ??= streamError instanceof QaProviderStreamError
      ? streamError.code
      : tokenChunkCount > 0
        ? "provider_error_after_partial_stream"
        : "provider_error";
    try {
      answer = await answerQuestionWithAI({
        ...input,
        shadowReviewAttemptKind: "sync_fallback",
        ...(observeProviderMetrics ? { onProviderMetrics: observeProviderMetrics } : {})
      });
      sentenceCommitManager = createSentenceCommitManager({ evidence: sentenceCommitEvidence });
    } catch (fallbackError) {
      const trace = recorder.complete({
        status: "failed",
        tokenChunkCount,
        sentenceCount: 0,
        providerCallCount: streamAttempted ? 2 : 1,
        fallbackReason,
        ...(providerMetrics ? { providerMetrics } : {})
      });
      notifyQaStreamingTrace(input.onStreamTrace, trace);
      throw fallbackError instanceof Error ? fallbackError : streamError;
    }
  }

  sentenceCommitManager ??= createSentenceCommitManager({ evidence: sentenceCommitEvidence });
  throwIfQaAborted(input.signal);
  const sentenceResults = sentenceCommitManager.commitValidatedAnswer(answer);
  const sentenceCommit = summarizeSentenceCommits(sentenceResults);
  const committedSentences = sentenceResults.filter(
    (result) => result.status === "committed" && result.groundingValidated
  );
  const withholdFinalUncertaintySentences =
    input.withholdUncertainProvisionalSentences === true &&
    committedSentences.some((result) => isUncertaintyBearingSentence(result.sentence));
  const canReleaseFinalSentences =
    !withholdFinalUncertaintySentences &&
    (emittedSentenceSignatures.size === 0 || source === "provider_stream");
  for (const result of canReleaseFinalSentences ? committedSentences : []) {
    if (
      input.withholdUncertainProvisionalSentences === true &&
      emittedSentenceCount >= MAX_VOICE_PROVISIONAL_SENTENCES
    ) {
      continue;
    }
    const signature = JSON.stringify([
      result.sentence,
      result.citationIds,
      result.supportIds
    ]);
    if (emittedSentenceSignatures.has(signature)) continue;
    emittedSentenceSignatures.add(signature);
    emittedSentenceCount += 1;
    recorder.markFirstSentenceValidated();
    recorder.markFirstSentence();
    yield {
      type: "sentence_completed",
      sequence: result.sequence,
      sentence: result.sentence,
      text: result.sentence,
      citationIds: result.citationIds,
      supportIds: result.supportIds,
      citedSegmentIds: result.citedSegmentIds,
      groundingValidated: true,
      safeForSpeech: false,
      safeForPersistence: false,
      requiresResponseOptimization: true,
      validated: true,
      status: "committed",
      reason: "grounded"
    };
  }

  const trace = recorder.complete({
    status: source === "non_stream_fallback" || fallbackReason
      ? "completed_with_fallback"
      : "completed",
    tokenChunkCount,
    sentenceCount: emittedSentenceCount,
    providerCallCount: source === "non_stream_fallback" ? (streamAttempted ? 2 : 1) : 1,
    fallbackReason,
    sentenceCommit,
    ...(providerMetrics ? { providerMetrics } : {})
  });
  notifyQaStreamingTrace(input.onStreamTrace, trace);
  throwIfQaAborted(input.signal);
  recordVoiceQaShadowReviewAnswer({
    qaInput: input,
    answer,
    attemptKind: "final_projection",
    provider: reviewProvider,
    selectedModel: reviewSelectedModel,
    ...(reviewProviderMetadata
      ? { providerMetadata: reviewProviderMetadata }
      : {}),
    fallbackReason,
    ...(reviewSystemPrompt ? { systemPrompt: reviewSystemPrompt } : {}),
    ...(reviewUserPrompt ? { userPrompt: reviewUserPrompt } : {}),
    qaLatencyMs: safeElapsedMs(totalStartedAt)
  });
  yield { type: "final", answer, source, trace };
}

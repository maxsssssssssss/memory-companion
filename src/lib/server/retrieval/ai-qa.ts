import { randomUUID } from "crypto";
import type {
  AudioInsight,
  BriefItem,
  QuestionAnswer,
  RelationshipSignalCard,
  SemanticSegment,
  TranscriptSegment,
  ValueLabel
} from "@/lib/domain/types";
import {
  createOpenAIClient,
  resolveOpenAIClientProvider,
  type OpenAIClientProvider
} from "@/lib/server/openai/client";
import { getOpenAIClientRuntimeConfig, getQaModelPreference, getQaPromptPreference } from "@/lib/server/settings/provider-config";
import type { JsonStore } from "@/lib/server/storage/json-store";
import { answerSameDayQuestion } from "./qa";
import {
  buildRelationshipSignalEvidence,
  isForbiddenRelationshipQaOutput,
  isRelationshipEvidenceQuestion
} from "./relationship-signal-evidence";
import type { MemoryIndexQaContext } from "./memory-index-evidence";

export type QaScope = "current" | "week" | "all";

export type QaConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AnswerQuestionWithAIInput = {
  uploadId: string;
  question: string;
  conversation?: QaConversationMessage[];
  scope?: QaScope;
  qaPromptInstruction?: string;
  settingsStore?: JsonStore;
  segments: TranscriptSegment[];
  audioInsights?: AudioInsight[];
  semanticSegments: SemanticSegment[];
  briefItems: BriefItem[];
  relationshipSignals?: RelationshipSignalCard[];
  memoryContext?: MemoryIndexQaContext;
  memoryIndexFallback?: boolean;
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
const qaScopeLabels: Record<QaScope, string> = {
  current: "当天证据",
  week: "本周记忆",
  all: "全部本地记忆"
};

const qaScopeInstructions: Record<QaScope, string> = {
  current: "当天问答，只基于当前日期或当前上传录音，不能引用其它日期。",
  week:
    "本周问答，关注反复主题、项目推进、承诺、风险、变化和卡点；如果证据只来自一天，要说明“目前证据主要来自某一天”。",
  all:
    "全部记忆问答，关注长期反复问题、过去表达、跨日期变化；长期判断必须有至少两个不同日期的证据，只有单日证据时，不能包装成长期趋势。"
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

export function buildHumanizedQaSystemPrompt(scope: QaScope = "current", qaPromptInstruction?: string) {
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
    "Always prioritize original evidence. Memory labels such as [M1] are not citation IDs; cite only [E1] evidence.",
    "Do not infer long-term patterns from a single occurrence or a single evidence date.",
    "不得把单次关系信号扩大为长期结论，不得输出渣男/渣女、绝对操控判断、心理诊断、人格定性或分手建议。",
    "memory_answer 的 answer 采用三段式：直接回答 / 我留意到的模式 / 可以怎么做。",
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

function scoreEvidence(question: string, evidence: EvidenceItem, memorySourceIds?: Set<string>) {
  const terms = questionTerms(question);
  const text = `${evidence.title} ${evidence.text}`.toLowerCase();
  const termScore = terms.reduce((score, term) => score + (text.includes(term.toLowerCase()) ? 4 : 0), 0);
  const memoryBoost =
    memorySourceIds &&
    (memorySourceIds.has(evidence.id) || evidence.sourceSegmentIds.some((id) => memorySourceIds.has(id)))
      ? 12
      : 0;

  return evidence.priority + termScore + memoryBoost;
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
    .map((segment) => ({
      id: segment.id,
      kind: "raw",
      title: segment.speaker ? `${segment.speaker} 的原始转写` : "原始转写片段",
      text: segment.text,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      sourceSegmentIds: [segment.id],
      priority: segment.valueLabels.length > 0 ? 3 : 1
    }));
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

export function retrieveQaEvidence(input: AnswerQuestionWithAIInput): QaRetrievedEvidence[] {
  const retrievalQuestion = contextualQuestion(input);
  const memorySourceIds = input.memoryContext ? new Set(input.memoryContext.sourceIds) : undefined;
  const evidence = [
    ...buildRelationshipSignalEvidence({
      question: input.question,
      conversation: input.conversation,
      cards: input.relationshipSignals,
      segments: input.segments
    }),
    ...evidenceFromBriefItems(input.briefItems),
    ...evidenceFromAudioInsights(input.audioInsights),
    ...evidenceFromSemanticSegments(input.semanticSegments),
    ...evidenceFromRawSegments(input.segments)
  ];
  const bestBySourceSet = new Map<string, { item: EvidenceItem; score: number; duplicateRank: number }>();

  evidence
    .map((item) => ({
      item,
      score: scoreEvidence(retrievalQuestion, item, memorySourceIds),
      duplicateRank: duplicateEvidenceRank(retrievalQuestion, item)
    }))
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

  return [...bestBySourceSet.values()]
    .sort((left, right) => right.score - left.score || left.item.startSeconds - right.item.startSeconds)
    .map(({ item }) => item)
    .slice(0, MAX_EVIDENCE_ITEMS);
}

function evidencePrompt(evidence: EvidenceItem[]) {
  return evidence
    .map((item, index) => {
      const label = `E${index + 1}`;
      return `[${label}] ${item.startSeconds}-${item.endSeconds}s ${item.title}\n${compactText(item.text)}`;
    })
    .join("\n\n");
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

function memoryContextPrompt(
  scope: QaScope,
  context: MemoryIndexQaContext | undefined,
  evidence: EvidenceItem[]
): MemoryPromptResult {
  if (!context || scope === "current") {
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
    return [{ memory, evidenceIds, dates, caution }];
  });
  if (mapped.length === 0) {
    return { text: "", memoryCount: 0, evidenceCount: 0 };
  }

  const evidenceIds = new Set(mapped.flatMap((item) => item.evidenceIds));
  const text = [
    "[Long-term memory]",
    "This is compressed supporting context, not direct fact. Use only the mapped original evidence in the answer.",
    ...mapped.map(({ memory, evidenceIds: mappedEvidenceIds, dates, caution }, index) =>
      [
        `[M${index + 1}] type=${memory.type} status=${memory.status} importance=${memory.importanceScore.toFixed(2)} occurrences=${memory.occurrenceCount}`,
        `Date coverage: ${dates.join(", ")}`,
        `Observation: ${compactText(`${memory.title}: ${memory.summary}`, 500)}`,
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

function scopeMetadataPrompt(scope: QaScope, evidence: EvidenceItem[]) {
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
  scope: QaScope,
  question: string,
  answerText: string,
  evidence: EvidenceItem[],
  citationIds: string[]
) {
  const citedEvidence = evidenceForCitationIds(citationIds, evidence);
  const relationshipEvidence = citedEvidence.filter((item) => item.relationshipSignal);
  if (relationshipEvidence.length === 0) {
    return false;
  }

  const relationshipDates = new Set(
    relationshipEvidence.flatMap((item) => (item.relationshipSignal?.recordingDate ? [item.relationshipSignal.recordingDate] : []))
  );
  const asksForPattern =
    scope === "all"
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

  if (scope === "current") {
    return affirmativeLongTermClaim;
  }

  return relationshipDates.size < 2 && (asksForPattern || affirmativeLongTermClaim);
}

function violatesMemoryScopeBoundary(
  scope: QaScope,
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
      sourceSegmentIds: item.sourceSegmentIds
    })),
    createdAt: new Date().toISOString()
  };
}

type QaWireApi = "chat" | "responses";
type ResponsesTextCandidate = {
  output_text?: unknown;
  output?: unknown;
};

function getQaWireApi(): QaWireApi {
  const rawWireApi = (process.env.OPENAI_QA_WIRE_API ?? process.env.OPENAI_WIRE_API ?? "").trim().toLowerCase();
  return rawWireApi === "responses" ? "responses" : "chat";
}

function textFromResponsesOutput(response: ResponsesTextCandidate) {
  const outputText = typeof response.output_text === "string" ? response.output_text.trim() : "";
  if (outputText) {
    return outputText;
  }

  if (!Array.isArray(response.output)) {
    return "";
  }

  return response.output
    .flatMap((outputItem) => {
      const content = outputItem && typeof outputItem === "object" && "content" in outputItem
        ? (outputItem as { content?: unknown }).content
        : undefined;
      if (!Array.isArray(content)) {
        return [];
      }

      return content.flatMap((contentItem) => {
        if (!contentItem || typeof contentItem !== "object") {
          return [];
        }
        const text = (contentItem as { text?: unknown }).text;
        return typeof text === "string" ? [text] : [];
      });
    })
    .join("")
    .trim();
}

async function requestQaAnswerText(
  client: ReturnType<typeof createOpenAIClient>,
  model: string,
  systemPrompt: string,
  userPrompt: string
) {
  if (getQaWireApi() === "responses") {
    const response = await client.responses.create({
      model,
      temperature: 0.2,
      input: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userPrompt
        }
      ]
    });

    return textFromResponsesOutput(response as ResponsesTextCandidate);
  }

  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content: userPrompt
      }
    ]
  });

  return response.choices[0]?.message?.content?.trim() ?? "";
}

function deterministicQaAnswer(input: AnswerQuestionWithAIInput, scope: QaScope) {
  return answerSameDayQuestion(
    input.question,
    input.segments,
    input.briefItems,
    input.uploadId,
    scope,
    input.relationshipSignals ?? [],
    input.conversation ?? []
  );
}

type QaFallbackReason =
  | "none"
  | "empty_answer"
  | "forbidden_relationship_output"
  | "unsupported_answer"
  | "missing_citations"
  | "relationship_scope_boundary"
  | "memory_scope_boundary"
  | "provider_error"
  | "model_provider_mismatch";

function isQaModelProviderMismatchError(error: unknown) {
  return error instanceof Error && error.name === "QaModelProviderMismatchError";
}

function qaRunLog(input: {
  provider: OpenAIClientProvider;
  selectedModel: string;
  fallbackReason: QaFallbackReason;
  startedAt: number;
}) {
  return (
    `[qa] provider=${input.provider} selected_model=${input.selectedModel} ` +
    `fallback_reason=${input.fallbackReason} elapsed_ms=${Date.now() - input.startedAt}`
  );
}

export async function answerQuestionWithAI(input: AnswerQuestionWithAIInput): Promise<QuestionAnswer> {
  const scope = input.scope ?? "current";
  const evidence = retrieveQaEvidence(input);
  const memoryPrompt = memoryContextPrompt(scope, input.memoryContext, evidence);
  const startedAt = Date.now();
  let provider: OpenAIClientProvider = "openai-compatible";
  let selectedModel = "unresolved";
  const complete = (answer: QuestionAnswer, fallbackReason: QaFallbackReason = "none") => {
    console.info(
      `[memory-qa] scope=${scope} memories_used=${memoryPrompt.memoryCount} evidence_used=${memoryPrompt.evidenceCount} fallback=${input.memoryIndexFallback === true}`
    );
    const message = qaRunLog({ provider, selectedModel, fallbackReason, startedAt });
    if (fallbackReason === "provider_error") {
      console.warn(message);
    } else {
      console.info(message);
    }
    return answer;
  };

  try {
    const runtimeConfig = await getOpenAIClientRuntimeConfig(input.settingsStore);
    provider = resolveOpenAIClientProvider(runtimeConfig);
    const [qaModel, savedQaPromptInstruction] = await Promise.all([
      getQaModelPreference(input.settingsStore, provider),
      getQaPromptPreference(input.settingsStore)
    ]);
    selectedModel = qaModel;
    const client = createOpenAIClient(runtimeConfig);
    const qaPromptInstruction = input.qaPromptInstruction?.trim() || savedQaPromptInstruction;
    const systemPrompt = buildHumanizedQaSystemPrompt(scope, qaPromptInstruction);
    const userPrompt = `${conversationPrompt(input.conversation)}当前问题：${input.question}\n问答范围：${qaScopeLabels[scope]}\n\n${scopeMetadataPrompt(scope, evidence)}${memoryPrompt.text ? `\n\n${memoryPrompt.text}` : ""}\n\n本地证据：\n${evidencePrompt(evidence)}`;
    const answerText = await requestQaAnswerText(client, qaModel, systemPrompt, userPrompt);

    if (!answerText) {
      return complete(deterministicQaAnswer(input, scope), "empty_answer");
    }

    const isRelationshipQuestion = isRelationshipEvidenceQuestion({
      question: input.question,
      conversation: input.conversation
    });
    if (isRelationshipQuestion && isForbiddenRelationshipQaOutput(answerText)) {
      return complete(deterministicQaAnswer(input, scope), "forbidden_relationship_output");
    }

    const structuredAnswer = parseStructuredAiAnswer(answerText);
    if (structuredAnswer) {
      if (structuredAnswer.mode === "assistant_meta") {
        return complete(buildAnswerFromAI(input, structuredAnswer.answer, evidence, []));
      }

      if (structuredAnswer.mode === "unsupported") {
        const deterministicAnswer = deterministicQaAnswer(input, scope);
        if (deterministicAnswer.citedSegmentIds.length > 0) {
          return complete(deterministicAnswer, "unsupported_answer");
        }

        return complete(
          buildAnswerFromAI(input, structuredAnswer.answer, evidence, normalizeCitationIds(structuredAnswer.citationIds, evidence))
        );
      }

      const citationIds = normalizeCitationIds(structuredAnswer.citationIds, evidence);
      const inlineCitationIds = citationIdsFromAnswer(structuredAnswer.answer, evidence);
      if (citationIds.length === 0 && inlineCitationIds.length === 0) {
        return complete(deterministicQaAnswer(input, scope), "missing_citations");
      }

      const effectiveCitationIds = citationIds.length > 0 ? citationIds : inlineCitationIds;
      if (violatesRelationshipScopeBoundary(scope, input.question, structuredAnswer.answer, evidence, effectiveCitationIds)) {
        return complete(deterministicQaAnswer(input, scope), "relationship_scope_boundary");
      }
      if (violatesMemoryScopeBoundary(scope, input.question, structuredAnswer.answer, evidence, effectiveCitationIds, memoryPrompt)) {
        return complete(deterministicQaAnswer(input, scope), "memory_scope_boundary");
      }

      return complete(
        buildAnswerFromAI(
          input,
          structuredAnswer.answer,
          evidence,
          effectiveCitationIds
        )
      );
    }

    const citationIds = citationIdsFromAnswer(answerText, evidence);
    if (citationIds.length === 0 && !answerLooksUnsupported(answerText)) {
      return complete(deterministicQaAnswer(input, scope), "missing_citations");
    }
    if (violatesRelationshipScopeBoundary(scope, input.question, answerText, evidence, citationIds)) {
      return complete(deterministicQaAnswer(input, scope), "relationship_scope_boundary");
    }
    if (violatesMemoryScopeBoundary(scope, input.question, answerText, evidence, citationIds, memoryPrompt)) {
      return complete(deterministicQaAnswer(input, scope), "memory_scope_boundary");
    }

    return complete(buildAnswerFromAI(input, answerText, evidence));
  } catch (error) {
    if (isQaModelProviderMismatchError(error)) {
      const mismatchedModel = (error as Error & { model?: unknown }).model;
      if (typeof mismatchedModel === "string" && mismatchedModel.trim()) {
        selectedModel = mismatchedModel.trim();
      }
      console.warn(qaRunLog({ provider, selectedModel, fallbackReason: "model_provider_mismatch", startedAt }));
      throw error;
    }

    return complete(deterministicQaAnswer(input, scope), "provider_error");
  }
}

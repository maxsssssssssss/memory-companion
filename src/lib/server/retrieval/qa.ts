import { randomUUID } from "crypto";
import type { BriefItem, QuestionAnswer, RelationshipSignalCard, TranscriptSegment, ValueLabel } from "@/lib/domain/types";
import { formatTime } from "@/lib/domain/time";
import { buildRelationshipSignalEvidence } from "./relationship-signal-evidence";

type DeterministicQaScope = "current" | "week" | "all";
type DeterministicQaConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

const noEvidenceAnswerByScope: Record<DeterministicQaScope, string> = {
  current: "我在当前这段录音里没有找到足够证据支持这个判断。可以换成更具体的时间、人名、项目名或关键词再问。",
  week: "我在本周已处理录音里没有找到足够证据支持这个判断。可以换成更具体的时间、人名、项目名或关键词再问。",
  all: "我在全部已处理记忆里没有找到足够证据支持这个判断。可以换成更具体的时间、人名、项目名或关键词再问。"
};

const questionCategoryRules: Array<{ categories: ValueLabel[]; pattern: RegExp }> = [
  { categories: ["commitment"], pattern: /答应|承诺|\bcommitments?\b|\bpromises?\b|\bpromised\b/i },
  { categories: ["task", "open_question", "decision", "commitment"], pattern: /下一步|跟进|确认|待办|没说清|还没说清|需要继续确认/u },
  { categories: ["idea", "open_question", "task", "commitment", "decision", "risk"], pattern: /反复|长期|一直|模式|话题|趋势/u },
  { categories: ["task"], pattern: /任务|\btodos?\b|\btasks?\b/i },
  { categories: ["decision"], pattern: /决定|决策|定价|\bdecisions?\b/i },
  { categories: ["idea"], pattern: /想法|产品想法|\bideas?\b/i },
  { categories: ["risk"], pattern: /风险|\brisks?\b/i },
  { categories: ["open_question"], pattern: /问题|未决|\bquestions?\b/i }
];

const fallbackQuestionPrefixes = [
  /^今天我有没有讨论\s*/u,
  /^今天有没有讨论\s*/u,
  /^今天讨论\s*/u,
  /^今天我有没有\s*/u,
  /^今天有没有\s*/u
];

const fallbackQuestionSuffixes = [/[？?。！!\s]+$/u, /了吗$/u, /吗$/u];

function extractFallbackKeyword(question: string): string {
  let keyword = question.trim();

  fallbackQuestionPrefixes.forEach((rule) => {
    keyword = keyword.replace(rule, "").trim();
  });

  let previous: string;
  do {
    previous = keyword;
    fallbackQuestionSuffixes.forEach((rule) => {
      keyword = keyword.replace(rule, "").trim();
    });
  } while (keyword !== previous);

  return keyword;
}

function matchedBriefItemsForQuestion(question: string, briefItems: BriefItem[]) {
  const matchedCategories = [
    ...new Set(questionCategoryRules.flatMap((rule) => (rule.pattern.test(question) ? rule.categories : [])))
  ];

  if (matchedCategories.length === 0) {
    return [];
  }

  const seenIds = new Set<string>();
  return matchedCategories.flatMap((category) =>
    briefItems
      .filter((item) => item.category === category)
      .filter((item) => {
        if (seenIds.has(item.id)) {
          return false;
        }
        seenIds.add(item.id);
        return true;
      })
  );
}

function datesFromBriefItems(briefItems: BriefItem[]) {
  return [
    ...new Set(
      briefItems.flatMap((item) =>
        `${item.title}\n${item.body}\n${item.transcriptExcerpt}`.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []
      )
    )
  ].sort();
}

function asksForLongTermPattern(question: string) {
  return /长期|反复|一直|模式|趋势/u.test(question);
}

function asksForWeekPattern(question: string) {
  return /本周|这一周/u.test(question) && /反复|变化|模式|趋势|一直|话题/u.test(question);
}

function scopeEvidenceCaution(scope: DeterministicQaScope, question: string, matchedItems: BriefItem[]) {
  const dates = datesFromBriefItems(matchedItems);
  const onlyDate = dates.length === 1 ? dates[0] : "单一日期/当前证据";

  if (scope === "all" && asksForLongTermPattern(question) && dates.length <= 1) {
    return `目前只看到 ${onlyDate} 的有限证据，不足以支持长期或反复模式判断；可以先回看这些证据。`;
  }

  if (scope === "week" && asksForWeekPattern(question) && dates.length <= 1) {
    return `目前证据主要来自 ${onlyDate}，不足以支持整周反复或变化判断；可以先回看这些证据。`;
  }

  return "";
}

function relationshipScopeCaution(
  scope: DeterministicQaScope,
  question: string,
  evidence: ReturnType<typeof buildRelationshipSignalEvidence>
) {
  const dates = [...new Set(evidence.map((item) => item.relationshipSignal.recordingDate))].sort();
  const onlyDate = dates.length === 1 ? dates[0] : "单一日期/当前证据";

  if (scope === "all" && asksForLongTermPattern(question) && dates.length <= 1) {
    return `目前只看到 ${onlyDate} 的有限关系互动证据，不足以支持长期或反复模式判断；可以先回看这条结构化观察和原文。`;
  }

  if (scope === "week" && asksForWeekPattern(question) && dates.length <= 1) {
    return `目前关系互动证据主要来自 ${onlyDate}，不足以支持整周反复或变化判断；可以先回看这条结构化观察和原文。`;
  }

  return "";
}

function compactCitationExcerpt(text: string) {
  const compacted = text.replace(/\s+/g, " ").trim();
  return compacted.length <= 220 ? compacted : `${compacted.slice(0, 219)}…`;
}

export function answerSameDayQuestion(
  question: string,
  segments: TranscriptSegment[],
  briefItems: BriefItem[],
  uploadId = "upload_demo",
  scope: DeterministicQaScope = "current",
  relationshipSignals: RelationshipSignalCard[] = [],
  conversation: DeterministicQaConversationMessage[] = []
): QuestionAnswer {
  const relationshipEvidence = buildRelationshipSignalEvidence({
    question,
    conversation,
    cards: relationshipSignals,
    segments
  });

  if (relationshipEvidence.length > 0) {
    const caution = relationshipScopeCaution(scope, question, relationshipEvidence);
    return {
      id: randomUUID(),
      uploadId,
      question,
      answer: `${caution ? `${caution}\n` : ""}我找到了这些有原始录音证据支持的结构化关系观察；它们不是事实定论：\n${relationshipEvidence
        .map((item) => `- ${item.title}\n${item.text}`)
        .join("\n")}`,
      citedSegmentIds: [...new Set(relationshipEvidence.flatMap((item) => item.sourceSegmentIds))],
      citations: relationshipEvidence.map((item, index) => ({
        id: `E${index + 1}`,
        title: item.title,
        startSeconds: item.startSeconds,
        endSeconds: item.endSeconds,
        excerpt: compactCitationExcerpt(item.text),
        sourceSegmentIds: item.sourceSegmentIds
      })),
      createdAt: new Date().toISOString()
    };
  }

  const matchedItems = matchedBriefItemsForQuestion(question, briefItems);

  if (matchedItems.length > 0) {
    const caution = scopeEvidenceCaution(scope, question, matchedItems);
    const itemText = matchedItems.map((item) => `- ${item.title}：${item.body}`).join("\n");
    return {
      id: randomUUID(),
      uploadId,
      question,
      answer: `${caution ? `${caution}\n` : ""}我找到了这些有证据支持的内容：\n${itemText}`,
      citedSegmentIds: [...new Set(matchedItems.flatMap((item) => item.sourceSegmentIds))],
      createdAt: new Date().toISOString()
    };
  }

  const keyword = extractFallbackKeyword(question);
  const matchedSegments = keyword.length > 1 ? segments.filter((segment) => segment.text.includes(keyword)) : [];

  if (matchedSegments.length === 0) {
    return {
      id: randomUUID(),
      uploadId,
      question,
      answer: noEvidenceAnswerByScope[scope],
      citedSegmentIds: [],
      createdAt: new Date().toISOString()
    };
  }

  return {
    id: randomUUID(),
    uploadId,
    question,
    answer: `我找到了这些相关片段：\n${matchedSegments.map((segment) => `${formatTime(segment.startSeconds)}：${segment.text}`).join("\n")}`,
    citedSegmentIds: matchedSegments.map((segment) => segment.id),
    createdAt: new Date().toISOString()
  };
}

import { transcriptSpeakerLabel } from "@/lib/domain/speaker-identity";
import { RelationshipSignalCardSchema, type RelationshipSignalCard, type TranscriptSegment } from "@/lib/domain/types";
import { containsForbiddenRelationshipJudgment } from "@/lib/processing/relationship-signals";

type QaConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type RelationshipSignalEvidenceItem = {
  id: string;
  kind: "relationship_signal";
  title: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
  sourceSegmentIds: string[];
  priority: number;
  relationshipSignal: {
    sourceId: string;
    label: string;
    category: RelationshipSignalCard["signalCategory"];
    confidence: number;
    caution: string;
    recordingDate: string;
  };
};

const MIN_RELATIONSHIP_SIGNAL_CONFIDENCE = 0.35;
const MAX_RELATIONSHIP_SIGNAL_EVIDENCE = 4;

const directRelationshipQuestionPattern =
  /关系信号|积极信号|需要澄清|需要留意|约会|亲密关系|恋爱|伴侣关系|相处.{0,8}(?:感受|互动|沟通)|认真听|倾听|情绪接住|尊重边界|边界表达|边界.{0,8}(?:尊重|接受|回应|处理)|回避回答|回避.{0,8}(?:关键|问题|回答|感受)|答非所问|敷衍|贬低|否定(?:我|我的感受)|让我不舒服|互动.{0,8}(?:信号|关系|感受|不舒服)|(?:对方|伴侣|男朋友|女朋友|他|她).{0,12}(?:认真听|倾听|接住|尊重(?:我|我的边界)|回避(?:我|问题|回答)|承诺(?:见面|关系)|否定(?:我|我的感受)|贬低)|relationship signal|active listening|emotional support|personal boundary|relationship boundary|evasive answer|belittl/i;

const shortRelationshipFollowUpPattern =
  /^(为什么|怎么说|证据呢|原文呢|具体呢|哪一段|继续|那这个呢|这是什么意思|可以展开吗)[？?。.!！]?$/u;

const signalTypeLabels: Record<RelationshipSignalCard["signalType"], string> = {
  active_listening: "主动倾听",
  emotional_support: "情绪接住",
  boundary_respect: "尊重边界",
  clear_commitment: "承诺明确",
  evasive_answer: "回避回答",
  invalidating_or_belittling: "贬低 / 否定"
};

const signalCategoryLabels: Record<RelationshipSignalCard["signalCategory"], string> = {
  positive: "积极信号",
  uncertain: "需要澄清",
  risk: "需要留意"
};

const signalQuestionPatterns: Record<RelationshipSignalCard["signalType"], RegExp> = {
  active_listening: /认真听|倾听|追问|回应|复述/i,
  emotional_support: /接住|支持|安慰|感受|情绪/i,
  boundary_respect: /边界|尊重|停一下|空间|休息/i,
  clear_commitment: /关系.{0,6}承诺|对方.{0,6}承诺|见面|明确答复/i,
  evasive_answer: /回避|答非所问|没回答|没说清/i,
  invalidating_or_belittling: /贬低|否定|嘲讽|轻视/i
};

function compactText(text: string, maxLength = 360) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function relationshipCaution(card: RelationshipSignalCard) {
  return card.caution?.trim() || "仅代表当前片段中的互动线索，不能据此推出长期关系结论。";
}

function isDirectRelationshipQuestion(question: string) {
  return directRelationshipQuestionPattern.test(question.trim());
}

export function isRelationshipEvidenceQuestion(input: {
  question: string;
  conversation?: QaConversationMessage[];
}) {
  if (isDirectRelationshipQuestion(input.question)) {
    return true;
  }

  if (!shortRelationshipFollowUpPattern.test(input.question.trim())) {
    return false;
  }

  const latestUserMessage = [...(input.conversation ?? [])]
    .reverse()
    .find((message) => message.role === "user" && message.content.trim().length > 0);

  return latestUserMessage ? isDirectRelationshipQuestion(latestUserMessage.content) : false;
}

export function isForbiddenRelationshipQaOutput(value: unknown): boolean {
  return containsForbiddenRelationshipJudgment(value);
}

function evidenceText(card: RelationshipSignalCard, sourceSegments: TranscriptSegment[]) {
  const caution = relationshipCaution(card);
  const counterEvidence = card.counterEvidence?.length
    ? `反向或补充证据：${card.counterEvidence.map(compactText).join("；")}`
    : "";
  const acousticEvidence = card.acousticEvidence?.length
    ? `声音辅助线索：${card.acousticEvidence
        .map((item) => `${compactText(item.detail)}（置信度 ${Math.round(item.confidence * 100)}%）`)
        .join("；")}`
    : "";
  const transcriptEvidence = sourceSegments
    .map(
      (segment) =>
        `- [${segment.id}] ${segment.startSeconds}-${segment.endSeconds}s ${transcriptSpeakerLabel(segment) ?? "speaker_unknown"}: ${compactText(segment.text)}`
    )
    .join("\n");

  return [
    "结构化关系观察，不是事实结论、人格判断或心理诊断。",
    `类别：${signalCategoryLabels[card.signalCategory]} / ${signalTypeLabels[card.signalType]}`,
    `置信度：${Math.round(card.confidence * 100)}%`,
    `不确定性与注意：${compactText(caution)}`,
    "原始 transcript 证据：",
    transcriptEvidence,
    `摘要：${compactText(card.summary)}`,
    `温和解释：${compactText(card.explanation)}`,
    counterEvidence,
    acousticEvidence,
    `可追问方向：${compactText(card.suggestedReflection)}`
  ]
    .filter(Boolean)
    .join("\n");
}

function relationshipEvidencePriority(question: string, card: RelationshipSignalCard) {
  const typeMatch = signalQuestionPatterns[card.signalType].test(question) ? 6 : 0;
  return 12 + typeMatch + Math.round(card.confidence * 4);
}

export function buildRelationshipSignalEvidence(input: {
  question: string;
  conversation?: QaConversationMessage[];
  cards?: RelationshipSignalCard[];
  segments: TranscriptSegment[];
}): RelationshipSignalEvidenceItem[] {
  if (!isRelationshipEvidenceQuestion(input) || !input.cards?.length) {
    return [];
  }

  const segmentById = new Map(input.segments.map((segment) => [segment.id, segment]));

  return input.cards
    .flatMap((rawCard): Array<{ card: RelationshipSignalCard; sourceSegments: TranscriptSegment[] }> => {
      const parsedCard = RelationshipSignalCardSchema.safeParse(rawCard);
      if (!parsedCard.success || parsedCard.data.confidence < MIN_RELATIONSHIP_SIGNAL_CONFIDENCE) {
        return [];
      }

      const card = parsedCard.data;
      if (isForbiddenRelationshipQaOutput(card)) {
        return [];
      }

      const sourceSegments = card.evidenceSegments.flatMap((evidence) => {
        const segment = segmentById.get(evidence.segmentId);
        return segment && segment.uploadId === card.uploadId ? [segment] : [];
      });
      if (sourceSegments.length !== card.evidenceSegments.length) {
        return [];
      }

      return [{ card, sourceSegments }];
    })
    .map(({ card, sourceSegments }) => ({
      id: card.id,
      kind: "relationship_signal" as const,
      title: `${card.date} · 关系信号 · ${signalTypeLabels[card.signalType]}`,
      text: evidenceText(card, sourceSegments),
      startSeconds: Math.min(...sourceSegments.map((segment) => segment.startSeconds)),
      endSeconds: Math.max(...sourceSegments.map((segment) => segment.endSeconds)),
      sourceSegmentIds: sourceSegments.map((segment) => segment.id),
      priority: relationshipEvidencePriority(input.question, card),
      relationshipSignal: {
        sourceId: card.id,
        label: signalTypeLabels[card.signalType],
        category: card.signalCategory,
        confidence: card.confidence,
        caution: relationshipCaution(card),
        recordingDate: card.date
      }
    }))
    .sort((left, right) => right.priority - left.priority || left.startSeconds - right.startSeconds || left.id.localeCompare(right.id))
    .slice(0, MAX_RELATIONSHIP_SIGNAL_EVIDENCE);
}

/** Materializes every individually valid relationship card for offline embedding. */
export function buildRelationshipSignalEvidenceCorpus(input: {
  cards?: RelationshipSignalCard[];
  segments: TranscriptSegment[];
}): RelationshipSignalEvidenceItem[] {
  return (input.cards ?? []).flatMap((card) =>
    buildRelationshipSignalEvidence({
      question: "relationship signal",
      cards: [card],
      segments: input.segments
    })
  );
}

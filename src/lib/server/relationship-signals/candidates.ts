import { createHash } from "node:crypto";
import { z } from "zod";
import type { TranscriptChunk } from "@/lib/domain/chunks";
import { transcriptSpeakerLabel } from "@/lib/domain/speaker-identity";
import type { AudioInsight, RelationshipSignalCard, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import {
  RawRelationshipSignalItemSchema,
  containsForbiddenRelationshipJudgment,
  normalizeRelationshipSignalItems,
  type RawRelationshipSignalItem
} from "@/lib/processing/relationship-signals";
import {
  meaningfulTextTokens,
  roundedScore,
  sharedTokenCount,
  tokenSetSimilarity
} from "@/lib/server/text-features";

export const RelationshipSignalCandidateSchema = z.object({
  id: z.string().min(1),
  uploadId: z.string().min(1),
  transcriptChunkId: z.string().min(1),
  chunkIndex: z.number().int().nonnegative(),
  item: RawRelationshipSignalItemSchema
}).strict();

export type RelationshipSignalCandidate = z.infer<typeof RelationshipSignalCandidateSchema>;

export type RelationshipCandidateRejectionReason =
  | "invalid_schema"
  | "forbidden_judgment"
  | "caution_required"
  | "evidence_missing_or_invalid";

export type RelationshipCandidateValidationRejection = {
  candidateId: string;
  rejectionReason: RelationshipCandidateRejectionReason;
};

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function uniqueObjects<T>(items: T[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function evidenceIds(item: RawRelationshipSignalItem) {
  return unique([
    ...item.evidenceSegmentIds,
    ...item.evidenceSegments.map((segment) => segment.segmentId)
  ]);
}

function actualEvidence(input: {
  item: RawRelationshipSignalItem;
  transcriptChunk: TranscriptChunk;
}) {
  const segmentById = new Map(input.transcriptChunk.segments.map((segment) => [segment.id, segment]));
  const ids = evidenceIds(input.item);
  if (ids.length === 0 || ids.some((id) => !segmentById.has(id))) {
    return null;
  }
  return ids.map((id) => segmentById.get(id)!);
}

function normalizeRawCandidate(input: {
  item: RawRelationshipSignalItem;
  evidence: TranscriptSegment[];
  semanticSegments: SemanticSegment[];
  audioInsights: AudioInsight[];
}): RawRelationshipSignalItem {
  const semanticIds = new Set(input.semanticSegments.map((segment) => segment.id));
  const insightIds = new Set(input.audioInsights.map((insight) => insight.id));
  return RawRelationshipSignalItemSchema.parse({
    ...input.item,
    involvedSpeakers: unique(input.evidence.flatMap((segment) => {
      const speaker = transcriptSpeakerLabel(segment);
      return speaker ? [speaker] : [];
    })),
    evidenceSegmentIds: input.evidence.map((segment) => segment.id),
    evidenceSegments: [],
    textEvidence: input.evidence.map((segment) => segment.text),
    acousticEvidence: (input.item.acousticEvidence ?? []).filter((entry) => insightIds.has(entry.audioInsightId)),
    interactionEvidence: (input.item.interactionEvidence ?? []).filter(
      (entry) => semanticIds.has(entry.sourceId) || insightIds.has(entry.sourceId)
    )
  });
}

export function createRelationshipSignalCandidates(input: {
  uploadId: string;
  transcriptChunk: TranscriptChunk;
  rawItems: unknown[];
  semanticSegments: SemanticSegment[];
  audioInsights: AudioInsight[];
}) {
  let rejectedCount = 0;
  const rejectionReasons: Partial<Record<RelationshipCandidateRejectionReason, number>> = {};
  const validationRejections: RelationshipCandidateValidationRejection[] = [];
  const reject = (candidateId: string, reason: RelationshipCandidateRejectionReason) => {
    rejectedCount += 1;
    rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
    validationRejections.push({ candidateId, rejectionReason: reason });
  };
  const candidates = input.rawItems.flatMap((rawItem, index): RelationshipSignalCandidate[] => {
    const candidateId = `${input.uploadId}_relationship_candidate_${String(input.transcriptChunk.index).padStart(5, "0")}_${String(index + 1).padStart(3, "0")}`;
    const parsed = RawRelationshipSignalItemSchema.safeParse(rawItem);
    if (!parsed.success) {
      reject(candidateId, "invalid_schema");
      return [];
    }
    if (containsForbiddenRelationshipJudgment(rawItem)) {
      reject(candidateId, "forbidden_judgment");
      return [];
    }
    if (
      (parsed.data.signalCategory === "risk" || parsed.data.signalCategory === "uncertain") &&
      !parsed.data.caution?.trim()
    ) {
      reject(candidateId, "caution_required");
      return [];
    }
    const evidence = actualEvidence({ item: parsed.data, transcriptChunk: input.transcriptChunk });
    if (!evidence) {
      reject(candidateId, "evidence_missing_or_invalid");
      return [];
    }
    const item = normalizeRawCandidate({
      item: parsed.data,
      evidence,
      semanticSegments: input.semanticSegments,
      audioInsights: input.audioInsights
    });
    return [RelationshipSignalCandidateSchema.parse({
      id: candidateId,
      uploadId: input.uploadId,
      transcriptChunkId: input.transcriptChunk.id,
      chunkIndex: input.transcriptChunk.index,
      item
    })];
  });
  return { candidates, rejectedCount, rejectionReasons, validationRejections };
}

export function relationshipCardsToCandidates(input: {
  uploadId: string;
  transcriptChunk: TranscriptChunk;
  cards: RelationshipSignalCard[];
  semanticSegments: SemanticSegment[];
  audioInsights: AudioInsight[];
}) {
  const rawItems = input.cards.map((card): RawRelationshipSignalItem => ({
    signalType: card.signalType,
    signalCategory: card.signalCategory,
    severity: card.severity,
    confidence: card.confidence,
    summary: card.summary,
    explanation: card.explanation,
    involvedSpeakers: card.involvedSpeakers,
    evidenceSegmentIds: card.evidenceSegments.map((segment) => segment.segmentId),
    evidenceSegments: [],
    counterEvidence: card.counterEvidence ?? [],
    acousticEvidence: card.acousticEvidence ?? [],
    textEvidence: card.evidenceSegments.map((segment) => segment.text),
    interactionEvidence: card.interactionEvidence ?? [],
    suggestedReflection: card.suggestedReflection,
    caution: card.caution
  }));
  return createRelationshipSignalCandidates({ ...input, rawItems });
}

function severityRank(value: RawRelationshipSignalItem["severity"]) {
  return value === "high" ? 3 : value === "medium" ? 2 : 1;
}

type CandidateFeatures = {
  evidenceIds: Set<string>;
  summaryTokens: Set<string>;
  evidenceTokens: Set<string>;
  allTokens: Set<string>;
  evidenceText: string;
  startSeconds: number;
  endSeconds: number;
};

export type RelationshipReducerScoreBreakdown = {
  evidenceQuality: number;
  confidence: number;
  evidenceDiversity: number;
  temporalCoverage: number;
  actionability: number;
  specificity: number;
  informationGain: number;
  redundancyPenalty: number;
  genericityPenalty: number;
  safetyPenalty: number;
  finalScore: number;
};

export type RelationshipCandidateQualityRejectionReason =
  | "evidence_missing_or_invalid"
  | "evidence_quote_not_traceable"
  | "speaker_missing"
  | "low_confidence"
  | "generic_low_information"
  | "insufficient_specificity"
  | "insufficient_actionability";

export type RelationshipCandidateQualityDecision = {
  candidateId: string;
  accepted: boolean;
  rejectionReason?: RelationshipCandidateQualityRejectionReason;
  score: RelationshipReducerScoreBreakdown;
};

export type RelationshipCandidateSelectionAudit = {
  candidateId: string;
  selected: boolean;
  rejectionReason?: RelationshipCandidateRejectionReason | RelationshipCandidateQualityRejectionReason | RelationshipReducerSelectionAudit["rejectionReason"];
  clusterId: string | null;
  score: RelationshipReducerScoreBreakdown;
};

export type RelationshipReducerSelectionAudit = {
  clusterId: string;
  fingerprint: string;
  signalType: RawRelationshipSignalItem["signalType"];
  candidateIds: string[];
  selected: boolean;
  rejectionReason?: "below_quality_threshold" | "redundant_information" | "normalization_rejected";
  redundancyTarget?: string;
  score: RelationshipReducerScoreBreakdown;
};

function emptyReducerScore(): RelationshipReducerScoreBreakdown {
  return {
    evidenceQuality: 0,
    confidence: 0,
    evidenceDiversity: 0,
    temporalCoverage: 0,
    actionability: 0,
    specificity: 0,
    informationGain: 0,
    redundancyPenalty: 0,
    genericityPenalty: 0,
    safetyPenalty: 0,
    finalScore: 0
  };
}

function candidateFeatures(
  candidate: RelationshipSignalCandidate,
  segmentById: Map<string, TranscriptSegment>
): CandidateFeatures {
  const ids = evidenceIds(candidate.item);
  const sourceSegments = ids.flatMap((id) => {
    const segment = segmentById.get(id);
    return segment ? [segment] : [];
  });
  const summaryTokens = meaningfulTextTokens(candidate.item.summary);
  const evidenceTokens = meaningfulTextTokens(sourceSegments.map((segment) => segment.text).join(" "));
  return {
    evidenceIds: new Set(ids),
    summaryTokens,
    evidenceTokens,
    allTokens: new Set([...summaryTokens, ...evidenceTokens]),
    evidenceText: sourceSegments.map((segment) => segment.text).join(" "),
    startSeconds: sourceSegments.length > 0 ? Math.min(...sourceSegments.map((segment) => segment.startSeconds)) : 0,
    endSeconds: sourceSegments.length > 0 ? Math.max(...sourceSegments.map((segment) => segment.endSeconds)) : 0
  };
}

const GENERIC_ACKNOWLEDGEMENT_PATTERN =
  /^(?:嗯+|哦+|好的?|知道了|明白了|行吧?|可以|谢谢|不客气|我支持你|加油|没事|会好的)[。！!，, ]*$/iu;
const GENERIC_SUPPORT_PATTERN =
  /^(?:我会支持你|我支持你|我会陪着你|别担心|没关系|会好起来的|你可以的|有我呢|慢慢来|我一直站你这边)[。！!，, ]*$/iu;
const ORDINARY_SMALL_TALK_PATTERN =
  /你好|早上好|晚上好|天气|吃了吗|吃饭|通勤|路上堵|最近怎么样|随便聊聊|工作.{0,8}(?:忙不忙|忙吗|还忙|顺利吗|怎么样)|家里(?:人)?.{0,8}(?:好吗|都好|好吧|怎么样|近况)/iu;
const LISTENING_PATTERN =
  /复述|确认.{0,16}(?:感受|担心|顾虑|意思|需求)|听到|听懂|理解.{0,16}(?:担心|顾虑|感受|需要)|你的意思|你担心|对吗|被听见|被听懂/iu;
const SUPPORT_PATTERN =
  /安慰|支持|陪伴|陪你|接住|辛苦|难受|委屈|担心|压力|害怕|焦虑|不安|沮丧|自我怀疑/iu;
const BOUNDARY_PATTERN =
  /边界|暂停|休息|不追问|不再.{0,6}(?:问|追问|打扰|催)|需要空间|保留选择|不替你决定|按你.{0,8}(?:节奏|速度)|尊重.{0,12}(?:选择|决定|需求|感受)|先停一下|先这样/iu;
const COMMITMENT_PATTERN =
  /答应|承诺|约定|说好|保证|会在|将在|最晚|之前|今晚|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]|下周|下次|回复|发送|发给|检查|查询|预约|提交|完成|确认|修改|改好|回来继续|follow[- ]?up|promise|commitment|before|\bwill\b/iu;
const TRACKABLE_DETAIL_PATTERN =
  /\d{1,2}(?:点|时|[:：]\d{1,2})|(?:\d+|一|两|三|四|五|六|七)(?:分钟|小时|天|周|个月)内|周[一二三四五六日天]|星期[一二三四五六日天]|今晚|明天|后天|下周|简历|材料|修改稿|文件|预约|消息|回复|发送|提交|检查|查询|计划|边界|暂停|需求|担忧|顾虑|感受/iu;
const CONCRETE_HELP_PATTERN =
  /(?:帮|替|陪).{0,12}(?:看|检查|修改|整理|准备|联系|处理|确认|查询|提交)|(?:材料|简历|文件|修改稿).{0,12}(?:看|检查|修改|整理|发送|发给|提交)/iu;
const SUBSTANTIVE_CONTEXT_PATTERN =
  /简历|材料|文件|修改稿|面试|预约|申请|截止|压力|焦虑|担心|顾虑|难受|生病|治疗|检查结果|休息|边界|暂停|具体计划/iu;

function groundedActionability(item: RawRelationshipSignalItem, evidenceText: string) {
  const grounded = `${item.summary} ${evidenceText}`;
  switch (item.signalType) {
    case "clear_commitment":
      return COMMITMENT_PATTERN.test(grounded) && TRACKABLE_DETAIL_PATTERN.test(grounded) ? 0.94 : 0.28;
    case "boundary_respect":
      return BOUNDARY_PATTERN.test(grounded) ? 0.86 : 0.34;
    case "active_listening":
      return LISTENING_PATTERN.test(grounded) ? 0.62 : 0.3;
    case "emotional_support":
      return SUPPORT_PATTERN.test(grounded) || CONCRETE_HELP_PATTERN.test(grounded) ? 0.68 : 0.28;
    case "evasive_answer":
      return 0.68;
    case "invalidating_or_belittling":
      return 0.64;
  }
}

function qualityScore(input: {
  candidate: RelationshipSignalCandidate;
  feature: CandidateFeatures;
  evidenceValid: boolean;
  quoteTraceable: boolean;
}) {
  const { candidate, feature } = input;
  const summaryTokenCount = feature.summaryTokens.size;
  const groundedText = `${candidate.item.summary} ${feature.evidenceText}`;
  const genericAcknowledgement = GENERIC_ACKNOWLEDGEMENT_PATTERN.test(feature.evidenceText.trim());
  const genericSupport = GENERIC_SUPPORT_PATTERN.test(feature.evidenceText.trim());
  const ordinarySmallTalk = ORDINARY_SMALL_TALK_PATTERN.test(feature.evidenceText) &&
    !SUBSTANTIVE_CONTEXT_PATTERN.test(feature.evidenceText) &&
    !COMMITMENT_PATTERN.test(groundedText) &&
    !BOUNDARY_PATTERN.test(groundedText) &&
    !CONCRETE_HELP_PATTERN.test(groundedText);
  const genericObservation = GENERIC_OBSERVATION_PATTERN.test(candidate.item.summary.trim());
  const evidenceQuality = input.evidenceValid && input.quoteTraceable
    ? roundedScore(0.68 + Math.min(0.24, feature.evidenceIds.size * 0.08))
    : 0;
  const specificity = roundedScore(
    genericObservation || genericAcknowledgement || genericSupport || ordinarySmallTalk
      ? Math.min(0.24, summaryTokenCount / 40)
      : 0.28 + Math.min(0.52, summaryTokenCount / 18) + (TRACKABLE_DETAIL_PATTERN.test(groundedText) ? 0.16 : 0)
  );
  const actionability = roundedScore(groundedActionability(candidate.item, feature.evidenceText));
  const informationGain = roundedScore(
    genericAcknowledgement || genericSupport || ordinarySmallTalk
      ? 0.12
      : 0.32 + Math.min(0.5, feature.summaryTokens.size / 20 + feature.evidenceTokens.size / 60)
  );
  const genericityPenalty = roundedScore(
    (genericObservation ? 0.18 : 0) + (genericAcknowledgement || genericSupport || ordinarySmallTalk ? 0.32 : 0)
  );
  const safetyPenalty = roundedScore(
    (candidate.item.signalCategory === "positive" ? 0 : 0.04) +
    ((candidate.item.counterEvidence?.length ?? 0) > 0 ? 0.04 : 0)
  );
  const finalScore = roundedScore(
    evidenceQuality * 0.28 +
    candidate.item.confidence * 0.18 +
    actionability * 0.2 +
    specificity * 0.18 +
    informationGain * 0.16 -
    genericityPenalty -
    safetyPenalty
  );
  return {
    evidenceQuality,
    confidence: roundedScore(candidate.item.confidence),
    evidenceDiversity: roundedScore(feature.evidenceIds.size > 1 ? 0.55 : 0.35),
    temporalCoverage: 0.35,
    actionability,
    specificity,
    informationGain,
    redundancyPenalty: 0,
    genericityPenalty,
    safetyPenalty,
    finalScore
  } satisfies RelationshipReducerScoreBreakdown;
}

export function gateRelationshipSignalCandidates(input: {
  candidates: RelationshipSignalCandidate[];
  segments: TranscriptSegment[];
}) {
  const segmentById = new Map(input.segments.map((segment) => [segment.id, segment]));
  const decisions = input.candidates.map((candidate): RelationshipCandidateQualityDecision => {
    const feature = candidateFeatures(candidate, segmentById);
    const candidateEvidenceIds = evidenceIds(candidate.item);
    const sourceSegments = candidateEvidenceIds.flatMap((id) => {
      const source = segmentById.get(id);
      return source ? [source] : [];
    });
    const sourceTexts = sourceSegments.map((source) => source.text);
    const evidenceValid = candidateEvidenceIds.length > 0 && sourceTexts.length === candidateEvidenceIds.length;
    const quoteTraceable = candidate.item.textEvidence.length === 0 ||
      candidate.item.textEvidence.every((quote) => sourceTexts.includes(quote));
    const speakerValid = sourceSegments.some((source) => Boolean(source.speaker?.trim()));
    const score = qualityScore({ candidate, feature, evidenceValid, quoteTraceable });
    const genericLowInformation = score.genericityPenalty >= 0.3 || score.informationGain < 0.25;
    const requiresActionability = candidate.item.signalType === "clear_commitment" || candidate.item.signalType === "boundary_respect";
    const requiresSpecificity = candidate.item.signalType === "active_listening" || candidate.item.signalType === "emotional_support";
    const rejectionReason: RelationshipCandidateQualityRejectionReason | undefined = !evidenceValid
      ? "evidence_missing_or_invalid"
      : !quoteTraceable
        ? "evidence_quote_not_traceable"
        : !speakerValid
          ? "speaker_missing"
          : candidate.item.confidence < 0.45
            ? "low_confidence"
            : genericLowInformation
              ? "generic_low_information"
              : requiresActionability && score.actionability < 0.55
                ? "insufficient_actionability"
                : requiresSpecificity && score.specificity < 0.42
                  ? "insufficient_specificity"
                  : score.finalScore < 0.5
                    ? "insufficient_specificity"
                    : undefined;
    return {
      candidateId: candidate.id,
      accepted: rejectionReason === undefined,
      ...(rejectionReason ? { rejectionReason } : {}),
      score
    };
  });
  const acceptedIds = new Set(decisions.filter((decision) => decision.accepted).map((decision) => decision.candidateId));
  return {
    candidates: input.candidates.filter((candidate) => acceptedIds.has(candidate.id)),
    decisions,
    rejectedCount: decisions.filter((decision) => !decision.accepted).length
  };
}

function shouldCluster(input: {
  left: RelationshipSignalCandidate;
  right: RelationshipSignalCandidate;
  leftFeatures: CandidateFeatures;
  rightFeatures: CandidateFeatures;
}) {
  if (
    input.left.item.signalType !== input.right.item.signalType ||
    input.left.item.signalCategory !== input.right.item.signalCategory
  ) {
    return false;
  }
  const summarySimilarity = tokenSetSimilarity(input.leftFeatures.summaryTokens, input.rightFeatures.summaryTokens);
  const sharedSummaryTokens = sharedTokenCount(input.leftFeatures.summaryTokens, input.rightFeatures.summaryTokens);
  const evidenceSimilarity = tokenSetSimilarity(input.leftFeatures.evidenceTokens, input.rightFeatures.evidenceTokens);
  const sharedEvidenceTokens = sharedTokenCount(input.leftFeatures.evidenceTokens, input.rightFeatures.evidenceTokens);
  const sharedAllTokens = sharedTokenCount(input.leftFeatures.allTokens, input.rightFeatures.allTokens);
  const adjacentChunks = Math.abs(input.left.chunkIndex - input.right.chunkIndex) <= 1;
  const nearbyTime = Math.max(
    0,
    Math.max(input.leftFeatures.startSeconds, input.rightFeatures.startSeconds) -
      Math.min(input.leftFeatures.endSeconds, input.rightFeatures.endSeconds)
  ) <= 180;
  if (sharedTokenCount(input.leftFeatures.evidenceIds, input.rightFeatures.evidenceIds) > 0) {
    return summarySimilarity >= 0.28 || sharedSummaryTokens >= 3;
  }

  if (
    input.leftFeatures.summaryTokens.size >= 3 &&
    input.rightFeatures.summaryTokens.size >= 3 &&
    summarySimilarity >= 0.62 &&
    (evidenceSimilarity >= 0.04 || adjacentChunks || nearbyTime)
  ) {
    return true;
  }
  if (
    sharedEvidenceTokens >= 2 &&
    evidenceSimilarity >= 0.08 &&
    (adjacentChunks || nearbyTime || sharedEvidenceTokens >= 3)
  ) {
    return true;
  }
  return sharedAllTokens >= 4 && tokenSetSimilarity(input.leftFeatures.allTokens, input.rightFeatures.allTokens) >= 0.16;
}

const GENERIC_OBSERVATION_PATTERN =
  /^(?:回应|互动|边界表达|对话).{0,28}(?:线索|回应)[。！! ]*$|^(?:对方|双方).{0,20}(?:后续回应方式|明确答复时间|关系信号|互动信号)/u;

function scoreCluster(input: {
  item: RawRelationshipSignalItem;
  members: RelationshipSignalCandidate[];
  features: CandidateFeatures[];
  informationGain?: number;
  redundancyPenalty?: number;
}) {
  const evidenceCount = new Set(input.item.evidenceSegmentIds).size;
  const chunkCount = new Set(input.members.map((member) => member.chunkIndex)).size;
  const summaryTokenCount = meaningfulTextTokens(input.item.summary).size;
  const groundedEvidenceText = input.features.map((feature) => feature.evidenceText).join(" ");
  const spanSeconds = Math.max(...input.features.map((feature) => feature.endSeconds)) -
    Math.min(...input.features.map((feature) => feature.startSeconds));
  const evidenceQuality = roundedScore(0.42 + Math.min(0.42, evidenceCount * 0.11));
  const evidenceDiversity = roundedScore(0.3 + Math.min(0.5, chunkCount * 0.18 + evidenceCount * 0.04));
  const temporalCoverage = roundedScore(chunkCount > 1 ? 0.55 + Math.min(0.35, spanSeconds / 3_600) : 0.35);
  const genericObservation = GENERIC_OBSERVATION_PATTERN.test(input.item.summary.trim());
  const specificity = roundedScore(
    genericObservation
      ? Math.min(0.22, summaryTokenCount / 48)
      : 0.25 + Math.min(0.55, summaryTokenCount / 18) + (TRACKABLE_DETAIL_PATTERN.test(`${input.item.summary} ${groundedEvidenceText}`) ? 0.15 : 0)
  );
  const actionability = roundedScore(groundedActionability(input.item, groundedEvidenceText));
  const informationGain = input.informationGain ?? 1;
  const redundancyPenalty = input.redundancyPenalty ?? 0;
  const genericityPenalty = roundedScore(genericObservation ? 0.16 + (evidenceCount >= 6 ? 0.05 : 0) : 0);
  const safetyPenalty = roundedScore(
    (input.item.signalCategory === "positive" ? 0 : 0.04) +
    ((input.item.counterEvidence?.length ?? 0) > 0 ? 0.04 : 0)
  );
  const finalScore = roundedScore(
    evidenceQuality * 0.25 +
    input.item.confidence * 0.2 +
    evidenceDiversity * 0.1 +
    temporalCoverage * 0.08 +
    actionability * 0.17 +
    specificity * 0.12 +
    informationGain * 0.08 -
    redundancyPenalty -
    genericityPenalty -
    safetyPenalty
  );
  return {
    evidenceQuality,
    confidence: roundedScore(input.item.confidence),
    evidenceDiversity,
    temporalCoverage,
    actionability,
    specificity,
    informationGain: roundedScore(informationGain),
    redundancyPenalty: roundedScore(redundancyPenalty),
    genericityPenalty,
    safetyPenalty,
    finalScore
  } satisfies RelationshipReducerScoreBreakdown;
}

function minimumQuality(signalType: RawRelationshipSignalItem["signalType"]) {
  return signalType === "active_listening" || signalType === "emotional_support" ? 0.58 : 0.54;
}

function clusterFingerprint(item: RawRelationshipSignalItem, features: CandidateFeatures[]) {
  const tokens = [...new Set(features.flatMap((feature) => [...feature.allTokens]))].sort().slice(0, 24);
  const digest = createHash("sha256")
    .update([item.signalType, item.signalCategory, ...tokens].join("\u001f"))
    .digest("hex")
    .slice(0, 16);
  return `${item.signalType}:${digest}`;
}

function overlapRatio(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size === 0 || right.size === 0) return 0;
  return sharedTokenCount(left, right) / Math.min(left.size, right.size);
}

function mergeItems(left: RawRelationshipSignalItem, right: RawRelationshipSignalItem) {
  const preferred = right.confidence > left.confidence ? right : left;
  const other = preferred === left ? right : left;
  return RawRelationshipSignalItemSchema.parse({
    ...preferred,
    severity: severityRank(other.severity) > severityRank(preferred.severity) ? other.severity : preferred.severity,
    confidence: Math.max(left.confidence, right.confidence),
    evidenceSegmentIds: unique([...left.evidenceSegmentIds, ...right.evidenceSegmentIds]),
    evidenceSegments: [],
    involvedSpeakers: unique([...left.involvedSpeakers, ...right.involvedSpeakers]),
    textEvidence: unique([...left.textEvidence, ...right.textEvidence]),
    counterEvidence: unique([...(left.counterEvidence ?? []), ...(right.counterEvidence ?? [])]),
    acousticEvidence: uniqueObjects([...(left.acousticEvidence ?? []), ...(right.acousticEvidence ?? [])]),
    interactionEvidence: uniqueObjects([...(left.interactionEvidence ?? []), ...(right.interactionEvidence ?? [])])
  });
}

export function reduceRelationshipSignalCandidates(input: {
  uploadId: string;
  recordingDate: string;
  candidates: RelationshipSignalCandidate[];
  segments: TranscriptSegment[];
  semanticSegments: SemanticSegment[];
  audioInsights: AudioInsight[];
  validationRejections?: RelationshipCandidateValidationRejection[];
  createdAt?: string;
}) {
  const validationRejections = input.validationRejections ?? [];
  const rawSorted = [...input.candidates].sort((left, right) => left.chunkIndex - right.chunkIndex || left.id.localeCompare(right.id));
  const qualityGate = gateRelationshipSignalCandidates({ candidates: rawSorted, segments: input.segments });
  const sorted = qualityGate.candidates;
  const segmentById = new Map(input.segments.map((segment) => [segment.id, segment]));
  const features = sorted.map((candidate) => candidateFeatures(candidate, segmentById));
  const memberIndexClusters: number[][] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const matchingCluster = memberIndexClusters.find((memberIndexes) =>
      memberIndexes.every((memberIndex) => shouldCluster({
        left: sorted[memberIndex],
        right: sorted[index],
        leftFeatures: features[memberIndex],
        rightFeatures: features[index]
      }))
    );
    if (matchingCluster) {
      matchingCluster.push(index);
    } else {
      memberIndexClusters.push([index]);
    }
  }
  const mergedItems = memberIndexClusters.map((indexes, clusterIndex) => {
    const members = indexes.map((index) => sorted[index]);
    const memberFeatures = indexes.map((index) => features[index]);
    const ranked = [...members].sort((left, right) => {
      const leftScore = left.item.confidence + Math.min(0.2, left.item.evidenceSegmentIds.length * 0.03);
      const rightScore = right.item.confidence + Math.min(0.2, right.item.evidenceSegmentIds.length * 0.03);
      return rightScore - leftScore || left.id.localeCompare(right.id);
    });
    const item = ranked.slice(1).reduce((merged, candidate) => mergeItems(merged, candidate.item), ranked[0].item);
    const fingerprint = clusterFingerprint(item, memberFeatures);
    return {
      clusterId: `${input.uploadId}_relationship_cluster_${String(clusterIndex + 1).padStart(3, "0")}`,
      item,
      members,
      features: memberFeatures,
      candidateIds: members.map((member) => member.id),
      fingerprint,
      baseScore: scoreCluster({ item, members, features: memberFeatures })
    };
  });

  const rankedClusters = [...mergedItems].sort(
    (left, right) => right.baseScore.finalScore - left.baseScore.finalScore || left.clusterId.localeCompare(right.clusterId)
  );
  const selected: typeof rankedClusters = [];
  const audit: RelationshipReducerSelectionAudit[] = [];
  for (const cluster of rankedClusters) {
    let redundancy = 0;
    let redundancyTarget: string | undefined;
    const clusterEvidence = new Set(cluster.item.evidenceSegmentIds);
    const clusterTokens = new Set(cluster.features.flatMap((feature) => [...feature.allTokens]));
    const clusterSummaryTokens = new Set(cluster.features.flatMap((feature) => [...feature.summaryTokens]));
    for (const existing of selected) {
      const existingEvidence = new Set(existing.item.evidenceSegmentIds);
      const existingTokens = new Set(existing.features.flatMap((feature) => [...feature.allTokens]));
      const existingSummaryTokens = new Set(existing.features.flatMap((feature) => [...feature.summaryTokens]));
      const evidenceOverlap = overlapRatio(clusterEvidence, existingEvidence);
      const summarySimilarity = tokenSetSimilarity(clusterSummaryTokens, existingSummaryTokens);
      const allTokenSimilarity = tokenSetSimilarity(clusterTokens, existingTokens);
      const sameSignalType = existing.item.signalType === cluster.item.signalType;
      const similarity = sameSignalType
        ? evidenceOverlap > 0
          ? summarySimilarity >= 0.22
            ? Math.max(summarySimilarity, 0.62 + evidenceOverlap * 0.25)
            : summarySimilarity
          : Math.max(summarySimilarity, allTokenSimilarity * 0.75)
        : evidenceOverlap >= 0.8 && summarySimilarity >= 0.58
          ? summarySimilarity
          : 0;
      if (similarity > redundancy) {
        redundancy = similarity;
        redundancyTarget = existing.clusterId;
      }
    }
    const informationGain = 1 - redundancy;
    const score = scoreCluster({
      item: cluster.item,
      members: cluster.members,
      features: cluster.features,
      informationGain,
      redundancyPenalty: redundancy >= 0.45 ? redundancy * 0.2 : 0
    });
    const isRedundant = redundancy >= 0.62 || score.informationGain < 0.3;
    const belowQuality = score.finalScore < minimumQuality(cluster.item.signalType);
    const selectedCluster = !isRedundant && !belowQuality;
    if (selectedCluster) selected.push(cluster);
    audit.push({
      clusterId: cluster.clusterId,
      fingerprint: cluster.fingerprint,
      signalType: cluster.item.signalType,
      candidateIds: cluster.candidateIds,
      selected: selectedCluster,
      ...(!selectedCluster ? {
        rejectionReason: isRedundant
          ? "redundant_information" as const
          : "below_quality_threshold" as const
      } : {}),
      ...(redundancyTarget ? { redundancyTarget } : {}),
      score
    });
  }
  const selectedInTimelineOrder = [...selected].sort((left, right) => {
    const leftStart = Math.min(...left.features.map((feature) => feature.startSeconds));
    const rightStart = Math.min(...right.features.map((feature) => feature.startSeconds));
    return leftStart - rightStart || left.clusterId.localeCompare(right.clusterId);
  });
  const normalizedEntries = selectedInTimelineOrder.flatMap((entry) => {
    const [card] = normalizeRelationshipSignalItems({
      uploadId: input.uploadId,
      recordingDate: input.recordingDate,
      segments: input.segments,
      semanticSegments: input.semanticSegments,
      audioInsights: input.audioInsights,
      items: [entry.item],
      createdAt: input.createdAt
    });
    return card ? [{ entry, card }] : [];
  });
  const normalizedClusterIds = new Set(normalizedEntries.map(({ entry }) => entry.clusterId));
  const finalAudit = audit.map((selection): RelationshipReducerSelectionAudit =>
    selection.selected && !normalizedClusterIds.has(selection.clusterId)
      ? { ...selection, selected: false, rejectionReason: "normalization_rejected" }
      : selection
  );
  const cards = normalizedEntries.map(({ card }, index) => ({
    ...card,
    id: `relationship_signal_${input.uploadId}_${index + 1}`
  }));
  const qualityDecisionById = new Map(qualityGate.decisions.map((decision) => [decision.candidateId, decision]));
  const selectionByCandidateId = new Map<string, RelationshipReducerSelectionAudit>();
  finalAudit.forEach((selection) => {
    selection.candidateIds.forEach((candidateId) => selectionByCandidateId.set(candidateId, selection));
  });
  const candidateSelections = rawSorted.map((candidate): RelationshipCandidateSelectionAudit => {
    const qualityDecision = qualityDecisionById.get(candidate.id)!;
    if (!qualityDecision.accepted) {
      return {
        candidateId: candidate.id,
        selected: false,
        rejectionReason: qualityDecision.rejectionReason,
        clusterId: null,
        score: qualityDecision.score
      };
    }
    const selection = selectionByCandidateId.get(candidate.id)!;
    return {
      candidateId: candidate.id,
      selected: selection.selected,
      ...(!selection.selected ? { rejectionReason: selection.rejectionReason } : {}),
      clusterId: selection.clusterId,
      score: selection.score
    };
  });
  const validationCandidateSelections = validationRejections.map(
    (rejection): RelationshipCandidateSelectionAudit => ({
      candidateId: rejection.candidateId,
      selected: false,
      rejectionReason: rejection.rejectionReason,
      clusterId: null,
      score: emptyReducerScore()
    })
  );
  return {
    cards,
    mergedCandidateCount: mergedItems.length,
    candidateIdsByCardId: Object.fromEntries(cards.map((card, index) => [card.id, normalizedEntries[index]?.entry.candidateIds ?? []])),
    audit: {
      rawCandidateCount: rawSorted.length + validationRejections.length,
      validationRejectedCount: validationRejections.length,
      qualityAcceptedCount: sorted.length,
      qualityRejectedCount: qualityGate.rejectedCount,
      clusterCount: mergedItems.length,
      mergedCount: Math.max(0, sorted.length - mergedItems.length),
      selectedCount: cards.length,
      clusterRejectedCount: audit.filter((selection) => !selection.selected).length,
      normalizationRejectedCount: finalAudit.filter((selection) => selection.rejectionReason === "normalization_rejected").length,
      rejectedCount: validationRejections.length + qualityGate.rejectedCount + mergedItems.length - cards.length,
      selections: finalAudit,
      candidates: [...validationCandidateSelections, ...candidateSelections]
        .sort((left, right) => left.candidateId.localeCompare(right.candidateId))
    }
  };
}

export type RelationshipReducerAudit = ReturnType<typeof reduceRelationshipSignalCandidates>["audit"];

import { createHash } from "node:crypto";
import {
  meaningfulTextTokens,
  roundedScore,
  sharedTokenCount,
  tokenSetSimilarity
} from "../text-features";
import { memoryTextSimilarity } from "./deduplication";
import { MemoryRelationWriteSchema, type MemoryItem, type MemoryRelationWrite } from "./types";

const COMPLETION_PATTERN =
  /已确认|确认了|已(?:经)?.{0,8}(?:完成|解决|决定|达成|落实|参观|提交|交付|购买|预约)|完成了|交付了|完成检查|解决了|决定了|落实了|兑现了|\b(?:confirmed|completed|resolved|decided|finished|agreed|done)\b/i;
const UPDATE_PATTERN =
  /调整|改到|改为|改报|改期|延期|重新安排|更新|后续|查到|确认(?:时间|方式|日期)|reschedul|postponed|updated|follow[- ]?up/i;
const REPLACEMENT_PATTERN =
  /(?:取消|不再).{0,24}(?:改到|改为|改报|改期|重新安排)|(?:改到|改为|改报|改期|重新安排).{0,24}(?:替代|取代)/i;
const PLAN_PATTERN =
  /计划|安排|准备|打算|待确认|仍需|还要|承诺|答应|预约|需要确认|plan|schedule|promise|unresolved|still needs/i;
const UNRESOLVED_STATE_PATTERN =
  /未完成|没完成|尚未完成|仍未.{0,8}(?:完成|解决|确认|提交|交付)|还没.{0,8}(?:完成|解决|确认|提交|交付)|还剩.{0,12}(?:待完成|未完成|要完成|需完成)?|待完成|待提交|待交付|仍需|还需|still (?:open|incomplete|unfinished)|not (?:done|completed|finished)/i;
const CONTRADICTION_PATTERN =
  /已取消|取消了|决定取消|确定取消|(?:计划|安排|承诺).{0,12}(?:不再|无法|未能|没有兑现)|cancelled|canceled|(?:plan|schedule|commitment).{0,16}(?:will not|won't|cannot|failed)|did not happen/i;

const LIFECYCLE_TOKENS = new Set([
  "计划", "安排", "准备", "打算", "待确", "确认", "仍需", "需要", "后续", "调整", "改到", "改为",
  "改期", "延期", "重新", "更新", "已经", "完成", "解决", "落实", "取消", "时间", "日期", "方式",
  "plan", "planned", "schedule", "scheduled", "update", "updated", "follow", "up", "completed", "resolved",
  "finished", "cancelled", "canceled", "still", "needs", "open", "question", "conversation", "summary",
  "which", "should", "choose", "discussed", "several", "options", "commitment", "preference", "event",
  "relationship", "signal", "speaker", "承诺", "答应", "约定", "明确", "具体", "后续", "当前",
  "周一", "周二", "周三", "周四", "周五", "周六", "周日", "星期", "今晚", "明天", "后天",
  "中午", "晚上", "上午", "下午", "天气", "出发"
]);

type LifecycleStage = "plan" | "update" | "completion" | "contradiction" | "observation";

export type MemoryRelationAuditEntry = {
  sourceMemoryId: string;
  targetMemoryId: string;
  eventKey: string;
  identityScore: number;
  sourceStage: LifecycleStage;
  targetStage: LifecycleStage;
  accepted: boolean;
  relationType?: MemoryRelationWrite["relationType"];
  rejectionReason?: "different_event" | "unsupported_transition" | "incompatible_type" | "lower_priority_relation";
};

export type MemoryRelationDetectionResult = {
  relations: MemoryRelationWrite[];
  audit: MemoryRelationAuditEntry[];
};

function stableRelationId(sourceMemoryId: string, targetMemoryId: string, relationType: string) {
  const digest = createHash("sha256")
    .update(`${sourceMemoryId}\u001f${targetMemoryId}\u001f${relationType}`)
    .digest("hex")
    .slice(0, 32);
  return `memory_relation_${digest}`;
}

function chronologicalPair(left: MemoryItem, right: MemoryItem) {
  const leftKey = `${left.firstSeenDate}\u001f${left.createdAt}\u001f${left.id}`;
  const rightKey = `${right.firstSeenDate}\u001f${right.createdAt}\u001f${right.id}`;
  return leftKey <= rightKey ? [left, right] as const : [right, left] as const;
}

function lifecycleStage(memory: MemoryItem): LifecycleStage {
  const title = memory.title.normalize("NFKC");
  const text = `${title} ${memory.summary.normalize("NFKC")}`;
  // Prefer an explicit unresolved state in the title over incidental
  // completion language about a different subtask in the summary.
  if (UNRESOLVED_STATE_PATTERN.test(title)) return "plan";
  if (REPLACEMENT_PATTERN.test(title)) return "update";
  if (CONTRADICTION_PATTERN.test(title)) return "contradiction";
  if (COMPLETION_PATTERN.test(title)) return "completion";
  if (UPDATE_PATTERN.test(title)) return "update";
  if (PLAN_PATTERN.test(title)) return "plan";

  if (REPLACEMENT_PATTERN.test(text)) return "update";
  if (CONTRADICTION_PATTERN.test(text)) return "contradiction";
  // When a single extracted memory contains both completed and outstanding
  // details, keep it open until the outstanding state is explicitly closed.
  if (UNRESOLVED_STATE_PATTERN.test(text)) return "plan";
  if (COMPLETION_PATTERN.test(text)) return "completion";
  if (UPDATE_PATTERN.test(text)) return "update";
  if (PLAN_PATTERN.test(text) || memory.type === "commitment" || memory.type === "question") return "plan";
  return "observation";
}

function identityTokens(value: string) {
  const tokens = meaningfulTextTokens(value);
  return new Set([...tokens].filter((token) => !LIFECYCLE_TOKENS.has(token)));
}

function identity(input: { source: MemoryItem; target: MemoryItem }) {
  const sourceTitleTokens = identityTokens(input.source.title);
  const targetTitleTokens = identityTokens(input.target.title);
  const sourceSummaryTokens = identityTokens(input.source.summary);
  const targetSummaryTokens = identityTokens(input.target.summary);
  const sharedTitle = [...sourceTitleTokens].filter((token) => targetTitleTokens.has(token)).sort();
  const sharedSummary = [...sourceSummaryTokens].filter((token) => targetSummaryTokens.has(token)).sort();
  const titleScore = tokenSetSimilarity(sourceTitleTokens, targetTitleTokens);
  const summaryScore = tokenSetSimilarity(sourceSummaryTokens, targetSummaryTokens);
  const textScore = memoryTextSimilarity(input.source, input.target);
  const score = roundedScore(Math.max(titleScore, summaryScore * 0.8, textScore * 0.45));
  const titleSharedCount = sharedTokenCount(sourceTitleTokens, targetTitleTokens);
  const summarySharedCount = sharedTokenCount(sourceSummaryTokens, targetSummaryTokens);
  const sameEvent =
    titleSharedCount >= 2 ||
    titleSharedCount >= 1 && titleScore >= 0.18 ||
    titleSharedCount >= 1 && summarySharedCount >= 2 && score >= 0.12;
  return {
    score,
    sameEvent,
    key: sharedTitle.slice(0, 8).join("|") || sharedSummary.slice(0, 8).join("|") || "none"
  };
}

function relationTypesCompatible(source: MemoryItem, target: MemoryItem) {
  if (source.type === "relationship_signal" || target.type === "relationship_signal") {
    return source.type === "relationship_signal" &&
      target.type === "relationship_signal" &&
      source.firstSeenDate !== target.firstSeenDate;
  }
  if (source.type === "summary" || target.type === "summary") {
    return source.type === "summary" && target.type === "summary";
  }
  return true;
}

function classifyRelation(input: {
  source: MemoryItem;
  target: MemoryItem;
  sourceStage: LifecycleStage;
  targetStage: LifecycleStage;
  identityScore: number;
}) {
  const { source, target, sourceStage, targetStage, identityScore } = input;
  if (targetStage === "contradiction" && ["plan", "update"].includes(sourceStage)) {
    return { relationType: "contradicted_by" as const, confidence: roundedScore(0.66 + identityScore * 0.26) };
  }
  if (targetStage === "completion" && ["plan", "update"].includes(sourceStage)) {
    return { relationType: "resolved_by" as const, confidence: roundedScore(0.7 + identityScore * 0.24) };
  }
  if (targetStage === "update" && ["plan", "update"].includes(sourceStage)) {
    return { relationType: "follow_up" as const, confidence: roundedScore(0.58 + identityScore * 0.28) };
  }
  if (source.type === target.type && source.firstSeenDate !== target.firstSeenDate && identityScore >= 0.34) {
    return { relationType: "repeated" as const, confidence: roundedScore(0.62 + identityScore * 0.28) };
  }
  if (
    (source.type === "commitment" || source.type === "question") &&
    (target.type === "event" || target.type === "commitment" || target.type === "question")
  ) {
    return { relationType: "follow_up" as const, confidence: roundedScore(0.54 + identityScore * 0.3) };
  }
  if (identityScore >= 0.12) {
    return { relationType: "related" as const, confidence: roundedScore(0.44 + identityScore * 0.34) };
  }
  return null;
}

export function detectMemoryRelationsWithAudit(memories: MemoryItem[]): MemoryRelationDetectionResult {
  const relations = new Map<string, MemoryRelationWrite>();
  const audit: MemoryRelationAuditEntry[] = [];
  const uniqueMemories = [...new Map(memories.map((memory) => [memory.id, memory])).values()];

  for (let leftIndex = 0; leftIndex < uniqueMemories.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < uniqueMemories.length; rightIndex += 1) {
      const left = uniqueMemories[leftIndex];
      const right = uniqueMemories[rightIndex];
      if (left.userId !== right.userId) continue;
      const [source, target] = chronologicalPair(left, right);
      const sourceStage = lifecycleStage(source);
      const targetStage = lifecycleStage(target);
      if (!relationTypesCompatible(source, target)) {
        audit.push({
          sourceMemoryId: source.id,
          targetMemoryId: target.id,
          eventKey: "none",
          identityScore: 0,
          sourceStage,
          targetStage,
          accepted: false,
          rejectionReason: "incompatible_type"
        });
        continue;
      }
      const eventIdentity = identity({ source, target });
      if (!eventIdentity.sameEvent) {
        audit.push({
          sourceMemoryId: source.id,
          targetMemoryId: target.id,
          eventKey: eventIdentity.key,
          identityScore: eventIdentity.score,
          sourceStage,
          targetStage,
          accepted: false,
          rejectionReason: "different_event"
        });
        continue;
      }
      const classification = classifyRelation({
        source,
        target,
        sourceStage,
        targetStage,
        identityScore: eventIdentity.score
      });
      if (!classification) {
        audit.push({
          sourceMemoryId: source.id,
          targetMemoryId: target.id,
          eventKey: eventIdentity.key,
          identityScore: eventIdentity.score,
          sourceStage,
          targetStage,
          accepted: false,
          rejectionReason: "unsupported_transition"
        });
        continue;
      }
      const relation = MemoryRelationWriteSchema.parse({
        id: stableRelationId(source.id, target.id, classification.relationType),
        sourceMemoryId: source.id,
        targetMemoryId: target.id,
        relationType: classification.relationType,
        confidence: classification.confidence,
        createdAt: target.updatedAt
      });
      relations.set(`${relation.sourceMemoryId}:${relation.targetMemoryId}:${relation.relationType}`, relation);
      audit.push({
        sourceMemoryId: source.id,
        targetMemoryId: target.id,
        eventKey: eventIdentity.key,
        identityScore: eventIdentity.score,
        sourceStage,
        targetStage,
        accepted: true,
        relationType: relation.relationType
      });
    }
  }

  const memoryById = new Map(uniqueMemories.map((memory) => [memory.id, memory]));
  const acceptedAuditByKey = new Map(
    audit
      .filter((entry) => entry.accepted && entry.relationType)
      .map((entry) => [
        `${entry.sourceMemoryId}:${entry.targetMemoryId}:${entry.relationType}`,
        entry
      ])
  );
  const groupedRelations = new Map<string, MemoryRelationWrite[]>();
  for (const relation of relations.values()) {
    const key = `${relation.targetMemoryId}:${relation.relationType}`;
    const group = groupedRelations.get(key) ?? [];
    group.push(relation);
    groupedRelations.set(key, group);
  }
  for (const group of groupedRelations.values()) {
    if (group.length <= 1) continue;
    const ranked = [...group].sort((left, right) => {
      const leftAudit = acceptedAuditByKey.get(`${left.sourceMemoryId}:${left.targetMemoryId}:${left.relationType}`);
      const rightAudit = acceptedAuditByKey.get(`${right.sourceMemoryId}:${right.targetMemoryId}:${right.relationType}`);
      const leftStageBonus = left.relationType === "resolved_by" && leftAudit?.sourceStage === "update" ? 1 : 0;
      const rightStageBonus = right.relationType === "resolved_by" && rightAudit?.sourceStage === "update" ? 1 : 0;
      if (leftStageBonus !== rightStageBonus) return rightStageBonus - leftStageBonus;
      const leftSource = memoryById.get(left.sourceMemoryId);
      const rightSource = memoryById.get(right.sourceMemoryId);
      const dateOrder = (rightSource?.lastSeenDate ?? "").localeCompare(leftSource?.lastSeenDate ?? "");
      if (dateOrder !== 0) return dateOrder;
      const scoreOrder = (rightAudit?.identityScore ?? 0) - (leftAudit?.identityScore ?? 0);
      return scoreOrder || left.sourceMemoryId.localeCompare(right.sourceMemoryId);
    });
    for (const relation of ranked.slice(1)) {
      relations.delete(`${relation.sourceMemoryId}:${relation.targetMemoryId}:${relation.relationType}`);
      const auditEntry = acceptedAuditByKey.get(
        `${relation.sourceMemoryId}:${relation.targetMemoryId}:${relation.relationType}`
      );
      if (auditEntry) {
        auditEntry.accepted = false;
        auditEntry.relationType = undefined;
        auditEntry.rejectionReason = "lower_priority_relation";
      }
    }
  }

  return {
    relations: [...relations.values()].sort(
      (left, right) =>
        left.sourceMemoryId.localeCompare(right.sourceMemoryId) ||
        left.targetMemoryId.localeCompare(right.targetMemoryId) ||
        left.relationType.localeCompare(right.relationType)
    ),
    audit
  };
}

export function detectMemoryRelations(memories: MemoryItem[]): MemoryRelationWrite[] {
  return detectMemoryRelationsWithAudit(memories).relations;
}

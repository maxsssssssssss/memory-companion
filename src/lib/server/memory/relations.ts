import { createHash } from "node:crypto";
import { memoryTextSimilarity, textTokenOverlap } from "./deduplication";
import { MemoryRelationWriteSchema, type MemoryItem, type MemoryRelationWrite } from "./types";

const COMPLETION_PATTERN =
  /已确认|确认了|已完成|完成了|已解决|解决了|已决定|决定了|已达成|落实了|confirmed|completed|resolved|decided|finished|agreed/i;
const CONTRADICTION_PATTERN =
  /取消|改期|不再|不会|不能|拒绝|未能|没有兑现|cancelled|canceled|postponed|will not|won't|cannot|refused|did not happen/i;

function stableRelationId(sourceMemoryId: string, targetMemoryId: string, relationType: string) {
  const digest = createHash("sha256")
    .update(`${sourceMemoryId}\u001f${targetMemoryId}\u001f${relationType}`)
    .digest("hex")
    .slice(0, 32);
  return `memory_relation_${digest}`;
}

function rounded(value: number) {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

function chronologicalPair(left: MemoryItem, right: MemoryItem) {
  const leftKey = `${left.firstSeenDate}\u001f${left.createdAt}\u001f${left.id}`;
  const rightKey = `${right.firstSeenDate}\u001f${right.createdAt}\u001f${right.id}`;
  return leftKey <= rightKey ? [left, right] as const : [right, left] as const;
}

function classifyRelation(
  source: MemoryItem,
  target: MemoryItem,
  similarity: number,
  titleOverlap: number,
  summaryOverlap: number
) {
  const targetText = `${target.title} ${target.summary}`;

  if (titleOverlap < 0.2 || summaryOverlap < 0.12) {
    return null;
  }

  if (
    (source.type === "commitment" || source.type === "question") &&
    CONTRADICTION_PATTERN.test(targetText) &&
    similarity >= 0.2
  ) {
    return { relationType: "contradicted_by" as const, confidence: rounded(0.67 + similarity * 0.25) };
  }
  if (
    (source.type === "commitment" || source.type === "question") &&
    (target.type === "event" || target.type === "commitment") &&
    COMPLETION_PATTERN.test(targetText) &&
    similarity >= 0.2
  ) {
    return { relationType: "resolved_by" as const, confidence: rounded(0.7 + similarity * 0.24) };
  }
  if (
    source.type === target.type &&
    source.firstSeenDate !== target.firstSeenDate &&
    similarity >= 0.45
  ) {
    return { relationType: "repeated" as const, confidence: rounded(0.62 + similarity * 0.28) };
  }
  if (
    (source.type === "commitment" || source.type === "question") &&
    (target.type === "event" || target.type === "commitment" || target.type === "question") &&
    similarity >= 0.25
  ) {
    return { relationType: "follow_up" as const, confidence: rounded(0.56 + similarity * 0.3) };
  }
  if (similarity >= 0.2) {
    return { relationType: "related" as const, confidence: rounded(0.45 + similarity * 0.35) };
  }
  return null;
}

export function detectMemoryRelations(memories: MemoryItem[]): MemoryRelationWrite[] {
  const relations = new Map<string, MemoryRelationWrite>();
  const uniqueMemories = [...new Map(memories.map((memory) => [memory.id, memory])).values()];

  for (let leftIndex = 0; leftIndex < uniqueMemories.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < uniqueMemories.length; rightIndex += 1) {
      const left = uniqueMemories[leftIndex];
      const right = uniqueMemories[rightIndex];
      if (left.userId !== right.userId) {
        continue;
      }
      const [source, target] = chronologicalPair(left, right);
      const similarity = memoryTextSimilarity(source, target);
      const titleOverlap = textTokenOverlap(source.title, target.title);
      const summaryOverlap = textTokenOverlap(source.summary, target.summary);
      const classification = classifyRelation(source, target, similarity, titleOverlap, summaryOverlap);
      if (!classification) {
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
    }
  }

  return [...relations.values()].sort(
    (left, right) =>
      left.sourceMemoryId.localeCompare(right.sourceMemoryId) ||
      left.targetMemoryId.localeCompare(right.targetMemoryId) ||
      left.relationType.localeCompare(right.relationType)
  );
}

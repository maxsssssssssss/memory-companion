import { BriefItemSchema, type BriefItem, type TranscriptSegment } from "@/lib/domain/types";

const DEFAULT_MAX_BRIEF_ITEMS = 30;
const priorityScore: Record<BriefItem["priority"], number> = {
  high: 3,
  medium: 2,
  low: 1
};

function normalizeItem(input: {
  uploadId: string;
  item: BriefItem;
  segmentById: Map<string, TranscriptSegment>;
}) {
  const sourceSegments = Array.from(new Set(input.item.sourceSegmentIds))
    .flatMap((segmentId) => {
      const segment = input.segmentById.get(segmentId);
      return segment ? [segment] : [];
    });

  if (sourceSegments.length === 0) {
    return null;
  }

  return BriefItemSchema.parse({
    ...input.item,
    uploadId: input.uploadId,
    sourceSegmentIds: sourceSegments.map((segment) => segment.id),
    sourceTimeRange: {
      startSeconds: Math.min(...sourceSegments.map((segment) => segment.startSeconds)),
      endSeconds: Math.max(...sourceSegments.map((segment) => segment.endSeconds))
    },
    transcriptExcerpt: input.item.transcriptExcerpt.trim() || sourceSegments[0].text
  });
}

function evidenceKey(item: BriefItem) {
  return `${item.category}:${[...item.sourceSegmentIds].sort().join(",")}`;
}

function compareForSelection(left: BriefItem, right: BriefItem) {
  return (
    priorityScore[right.priority] - priorityScore[left.priority] ||
    right.confidence - left.confidence ||
    left.sourceTimeRange.startSeconds - right.sourceTimeRange.startSeconds
  );
}

function compareChronologically(left: BriefItem, right: BriefItem) {
  return (
    left.sourceTimeRange.startSeconds - right.sourceTimeRange.startSeconds ||
    left.sourceTimeRange.endSeconds - right.sourceTimeRange.endSeconds ||
    left.category.localeCompare(right.category)
  );
}

export type MergeBriefItemsInput = {
  uploadId: string;
  segments: TranscriptSegment[];
  items: BriefItem[];
  maxItems?: number;
};

export function mergeBriefItemsWithStats(input: MergeBriefItemsInput) {
  const segmentById = new Map(input.segments.map((segment) => [segment.id, segment]));
  const deduplicated = new Map<string, BriefItem>();
  let validItemCount = 0;

  for (const item of input.items) {
    const normalized = normalizeItem({ uploadId: input.uploadId, item, segmentById });
    if (!normalized) {
      continue;
    }
    validItemCount += 1;

    const key = evidenceKey(normalized);
    const existing = deduplicated.get(key);
    if (!existing || normalized.confidence > existing.confidence) {
      deduplicated.set(key, normalized);
    }
  }

  const maxItems = Math.max(0, input.maxItems ?? DEFAULT_MAX_BRIEF_ITEMS);
  const items = [...deduplicated.values()]
    .sort(compareForSelection)
    .slice(0, maxItems)
    .sort(compareChronologically)
    .map((item, index) =>
      BriefItemSchema.parse({
        ...item,
        id: `${input.uploadId}_brief_${index + 1}`
      })
    );

  return {
    items,
    stats: {
      rawItemCount: input.items.length,
      validItemCount,
      deduplicatedItemCount: deduplicated.size,
      finalItemCount: items.length
    }
  };
}

export function mergeBriefItems(input: MergeBriefItemsInput) {
  return mergeBriefItemsWithStats(input).items;
}

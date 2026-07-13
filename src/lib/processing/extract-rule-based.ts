import type { BriefItem, TranscriptSegment, ValueLabel } from "@/lib/domain/types";

const titles: Record<ValueLabel, string> = {
  commitment: "需要兑现的承诺",
  task: "需要跟进的待办",
  decision: "今天形成的决策",
  idea: "值得保留的想法",
  risk: "需要关注的风险",
  open_question: "未决问题",
  notable_quote: "重要原话"
};

const priorityByCategory: Record<ValueLabel, BriefItem["priority"]> = {
  commitment: "high",
  task: "high",
  decision: "high",
  risk: "high",
  idea: "medium",
  open_question: "medium",
  notable_quote: "low"
};

export function extractBriefItems(uploadId: string, segments: TranscriptSegment[]): BriefItem[] {
  const items: BriefItem[] = [];

  for (const segment of segments) {
    segment.valueLabels.forEach((label, index) => {
      items.push({
        id: `brief_${uploadId}_${segment.id}_${label}_${index}`,
        uploadId,
        category: label,
        title: titles[label],
        body: segment.text,
        priority: priorityByCategory[label],
        confidence: segment.confidence,
        status: "candidate",
        sourceSegmentIds: [segment.id],
        sourceTimeRange: {
          startSeconds: segment.startSeconds,
          endSeconds: segment.endSeconds
        },
        transcriptExcerpt: segment.text,
        people: [],
        topics: [...segment.sceneLabels]
      });
    });
  }

  return items;
}

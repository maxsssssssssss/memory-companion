import { z } from "zod";

import { TranscriptSegmentSchema, type TranscriptSegment } from "@/lib/domain/types";

export const DAILY_REFLECTION_CARD_PIPELINE_PROMPT_VERSION = "daily_reflection_cards_v1";

export const DailyReflectionCardPipelinePolicySchema = z.object({
  extractionInputTokenBudget: z.number().int().positive(),
  extractionOutputTokenBudget: z.number().int().positive(),
  organizerInputTokenBudget: z.number().int().positive(),
  organizerOutputTokenBudget: z.number().int().positive(),
  segmentOverlapCount: z.number().int().nonnegative(),
  maxHiddenPerWindow: z.number().int().positive(),
  maxHiddenTotal: z.number().int().positive(),
  maxCardsTotal: z.number().int().positive()
}).strict();

export type DailyReflectionCardPipelinePolicy = z.infer<
  typeof DailyReflectionCardPipelinePolicySchema
>;

export const DEFAULT_DAILY_REFLECTION_CARD_PIPELINE_POLICY =
  DailyReflectionCardPipelinePolicySchema.parse({
    extractionInputTokenBudget: 6_000,
    extractionOutputTokenBudget: 1_400,
    organizerInputTokenBudget: 7_000,
    organizerOutputTokenBudget: 1_800,
    segmentOverlapCount: 2,
    maxHiddenPerWindow: 8,
    maxHiddenTotal: 48,
    maxCardsTotal: 12
  });

/**
 * Conservative, deterministic estimate for mixed Chinese/English prompt text.
 * It is deliberately centralized so window construction and audit metadata use
 * the same unit. Canonical segment text is never sliced to satisfy the budget.
 */
export function estimateDailyReflectionTokens(text: string) {
  let tokens = 0;
  for (const character of text) {
    tokens += /[\u3400-\u9fff\uf900-\ufaff]/u.test(character) ? 1 : 0.35;
  }
  return Math.max(1, Math.ceil(tokens));
}

export type DailyReflectionTranscriptWindow = Readonly<{
  index: number;
  segments: TranscriptSegment[];
  estimatedInputTokens: number;
}>;

function segmentTokenEstimate(segment: TranscriptSegment) {
  return estimateDailyReflectionTokens(
    `[${segment.id}] ${segment.startSeconds}-${segment.endSeconds}s: ${segment.text}`
  );
}

export function buildDailyReflectionTranscriptWindows(input: {
  segments: readonly TranscriptSegment[];
  policy?: DailyReflectionCardPipelinePolicy;
}): DailyReflectionTranscriptWindow[] {
  const policy = DailyReflectionCardPipelinePolicySchema.parse(
    input.policy ?? DEFAULT_DAILY_REFLECTION_CARD_PIPELINE_POLICY
  );
  const segments = z.array(TranscriptSegmentSchema).min(1).parse(input.segments);
  const windows: DailyReflectionTranscriptWindow[] = [];
  let cursor = 0;

  while (cursor < segments.length) {
    const windowSegments: TranscriptSegment[] = [];
    let estimatedInputTokens = 0;
    let next = cursor;
    while (next < segments.length) {
      const segment = segments[next];
      const estimate = segmentTokenEstimate(segment);
      if (
        windowSegments.length > 0
        && estimatedInputTokens + estimate > policy.extractionInputTokenBudget
      ) break;
      windowSegments.push(segment);
      estimatedInputTokens += estimate;
      next += 1;
    }

    windows.push({
      index: windows.length,
      segments: windowSegments,
      estimatedInputTokens
    });
    if (next >= segments.length) break;
    const overlap = Math.min(policy.segmentOverlapCount, windowSegments.length - 1);
    cursor = Math.max(cursor + 1, next - Math.max(0, overlap));
  }
  return windows;
}

export type DailyReflectionCardDisplayPlan = Readonly<{
  primaryCount: number;
  maxCards: number;
  maxClusters: number | null;
  maxCardsPerCluster: number | null;
  presentation: "compact" | "topics" | "overview" | "chapters";
}>;

export function dailyReflectionCardDisplayPlan(
  effectiveDurationMs: number,
  policy: DailyReflectionCardPipelinePolicy = DEFAULT_DAILY_REFLECTION_CARD_PIPELINE_POLICY
): DailyReflectionCardDisplayPlan {
  const seconds = z.number().int().positive().parse(effectiveDurationMs) / 1_000;
  if (seconds <= 180) {
    return {
      primaryCount: 3,
      maxCards: Math.min(5, policy.maxCardsTotal),
      maxClusters: null,
      maxCardsPerCluster: null,
      presentation: "compact"
    };
  }
  if (seconds <= 600) {
    return {
      primaryCount: 5,
      maxCards: Math.min(9, policy.maxCardsTotal),
      maxClusters: null,
      maxCardsPerCluster: null,
      presentation: "compact"
    };
  }
  if (seconds <= 1_800) {
    return {
      primaryCount: 6,
      maxCards: Math.min(8, policy.maxCardsTotal),
      maxClusters: 4,
      maxCardsPerCluster: 2,
      presentation: "topics"
    };
  }
  if (seconds <= 3_600) {
    return {
      primaryCount: 8,
      maxCards: policy.maxCardsTotal,
      maxClusters: null,
      maxCardsPerCluster: null,
      presentation: "overview"
    };
  }
  return {
    primaryCount: 8,
    maxCards: policy.maxCardsTotal,
    maxClusters: null,
    maxCardsPerCluster: null,
    presentation: "chapters"
  };
}

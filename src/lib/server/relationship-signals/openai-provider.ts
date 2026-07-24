import { z } from "zod";
import { transcriptSpeakerLabel } from "@/lib/domain/speaker-identity";
import { RelationshipSignalSeveritySchema, RelationshipSignalTypeSchema } from "@/lib/domain/types";
import {
  RawRelationshipSignalItemSchema,
  buildConservativeRelationshipSignalFallbackCards,
  hasRelationshipSignalContext,
  normalizeRelationshipSignalItems,
  type RawRelationshipSignalItem
} from "@/lib/processing/relationship-signals";
import { createOpenAIClient } from "@/lib/server/openai/client";
import { jsonOnlyInstruction, parseStructuredJsonResponse } from "@/lib/server/openai/structured-json";
import { getOpenAIClientRuntimeConfig } from "@/lib/server/settings/provider-config";
import { captureProviderValidationFailure } from "@/lib/server/evaluation/provider-response-capture";
import { formatRelationshipInsightForProvider, selectRelationshipContext } from "./context-selector";
import type {
  RelationshipSignalCandidateAudit,
  RelationshipSignalProvider,
  RelationshipSignalRecoveryMode
} from "./provider";

function getModel() {
  return (
    process.env.OPENAI_RELATIONSHIP_SIGNAL_MODEL?.trim() ||
    process.env.OPENAI_TEXT_MODEL?.trim() ||
    "gpt-4.1-mini"
  );
}

function compactText(text: string, maxLength = 320) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function normalizedText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function readPositiveInteger(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name]?.trim() ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function compactLine(maxLength: number) {
  return z.string().trim().min(1).max(maxLength).refine(
    (value) => !/(?:```|[\r\n]|^\s{0,3}#{1,6}\s|^\s*[-*]\s)/u.test(value),
    { message: "compact candidate text must be a single plain-text line" }
  );
}

const CompactRelationshipCandidateSchema = z.object({
  signalType: RelationshipSignalTypeSchema,
  severity: RelationshipSignalSeveritySchema,
  confidence: z.number().min(0).max(1),
  summary: compactLine(180),
  evidenceSegmentIds: z.array(z.string().trim().min(1).max(96)).min(1).max(6),
  caution: compactLine(160).optional()
}).superRefine((candidate, context) => {
  if (
    (candidate.signalType === "evasive_answer" || candidate.signalType === "invalidating_or_belittling") &&
    !candidate.caution?.trim()
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["caution"],
      message: "risk and uncertain candidates require caution"
    });
  }
});

const CompactRelationshipCandidateItemsSchema = z.object({
  items: z.array(CompactRelationshipCandidateSchema)
});

type CompactRelationshipCandidate = z.infer<typeof CompactRelationshipCandidateSchema>;

const relationshipConfidenceByLabel = {
  high: 0.85,
  medium: 0.65,
  low: 0.35
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeRelationshipConfidenceLabels(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return value;
  }

  let normalizedCount = 0;
  const items = value.items.map((item) => {
    if (!isRecord(item) || typeof item.confidence !== "string") {
      return item;
    }
    const label = item.confidence.trim().toLocaleLowerCase("en-US");
    const confidence = relationshipConfidenceByLabel[label as keyof typeof relationshipConfidenceByLabel];
    if (confidence === undefined) {
      return item;
    }
    normalizedCount += 1;
    return { ...item, confidence };
  });

  if (normalizedCount === 0) {
    return value;
  }
  console.info(
    `[relationship-confidence-normalization] field=confidence original_type=string normalized=true count=${normalizedCount}`
  );
  return { ...value, items };
}

const reflectionBySignalType: Record<CompactRelationshipCandidate["signalType"], string> = {
  active_listening: "哪一处回应让你感到被认真听见？",
  emotional_support: "这份支持中，哪一部分对你最有帮助？",
  boundary_respect: "这种边界回应是否让你感到更安心？",
  clear_commitment: "可以关注这项承诺是否按约定落实。",
  evasive_answer: "后续是否获得了更清楚、可核对的回应？",
  invalidating_or_belittling: "这段互动中，哪些表达让你感到未被理解？"
};

function recoveryMode(input: Parameters<RelationshipSignalProvider["analyze"]>[0]): RelationshipSignalRecoveryMode {
  return input.recoveryMode === "compact" ? "compact" : "standard";
}

function candidateLimit(mode: RelationshipSignalRecoveryMode): 3 | 5 {
  return mode === "compact" ? 3 : 5;
}

function compactCandidateRank(candidate: CompactRelationshipCandidate, index: number) {
  const evidenceDiversity = new Set(candidate.evidenceSegmentIds).size;
  const summarySpecificity = Math.min(180, candidate.summary.length) / 180;
  return {
    candidate,
    index,
    score: candidate.confidence * 1_000 + evidenceDiversity * 10 + summarySpecificity
  };
}

function selectCompactCandidates(
  candidates: CompactRelationshipCandidate[],
  limit: 3 | 5
) {
  if (candidates.length <= limit) return candidates;
  const ranked = candidates
    .map(compactCandidateRank)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected: CompactRelationshipCandidate[] = [];
  for (const { candidate } of ranked) {
    if (selected.length >= limit) break;
    selected.push(candidate);
  }
  return selected;
}

function toRawRelationshipSignalItem(candidate: CompactRelationshipCandidate): RawRelationshipSignalItem {
  const signalCategory = candidate.signalType === "evasive_answer" || candidate.signalType === "invalidating_or_belittling"
    ? "uncertain" as const
    : "positive" as const;
  return RawRelationshipSignalItemSchema.parse({
    signalType: candidate.signalType,
    signalCategory,
    severity: candidate.severity,
    confidence: candidate.confidence,
    summary: candidate.summary,
    explanation: "该信号依据当前片段中的可追溯互动证据生成，不代表长期关系结论。",
    involvedSpeakers: [],
    evidenceSegmentIds: [...new Set(candidate.evidenceSegmentIds)],
    evidenceSegments: [],
    textEvidence: [],
    suggestedReflection: reflectionBySignalType[candidate.signalType],
    ...(candidate.caution ? { caution: candidate.caution } : {})
  });
}

function unoptimizedRelationshipContextCharacterCount(
  input: Parameters<RelationshipSignalProvider["analyze"]>[0]
) {
  const transcript = input.segments
    .map((segment) => `[${segment.id}] ${segment.startSeconds}-${segment.endSeconds}s ${transcriptSpeakerLabel(segment) ?? "speaker_unknown"}: ${compactText(segment.text, 500)}`)
    .join("\n");
  const semantic = input.semanticSegments
    .slice(0, 4)
    .map((segment) => `[${segment.id}] ${segment.sourceTimeRange.startSeconds}-${segment.sourceTimeRange.endSeconds}s ${compactText(segment.title, 500)}: ${compactText(segment.summary, 500)}`)
    .join("\n");
  const insights = input.audioInsights
    .map((insight) => {
      const labels = [
        ...insight.toneLabels,
        ...insight.emotionLabels,
        ...insight.interactionLabels,
        ...(insight.atmosphereLabels ?? [])
      ].join(",");
      return `[${insight.id}] ${insight.sourceTimeRange.startSeconds}-${insight.sourceTimeRange.endSeconds}s ${insight.speaker.id} labels=${labels}: ${compactText(insight.summary, 500)} evidence=${compactText(insight.evidence, 500)}`;
    })
    .join("\n");
  return [
    `uploadId=${input.uploadId}`,
    `recordingDate=${input.recordingDate}`,
    "Transcript segments:",
    transcript,
    semantic ? "\nSemantic segments:" : "",
    semantic,
    insights ? "\nAudio insights:" : "",
    insights
  ].filter(Boolean).join("\n").length;
}

export function buildRelationshipSignalPrompt(input: Parameters<RelationshipSignalProvider["analyze"]>[0]) {
  const currentSegmentIds = new Set(input.segments.map((segment) => segment.id));
  const segmentsById = new Map(input.segments.map((segment) => [segment.id, segment]));
  const transcript = input.segments
    .map((segment) => `[${segment.id}] ${segment.startSeconds}-${segment.endSeconds}s ${transcriptSpeakerLabel(segment) ?? "speaker_unknown"}: ${normalizedText(segment.text)}`)
    .join("\n");
  const insights = input.audioInsights
    .map((insight) => {
      const sourceSegments = insight.sourceSegmentIds.flatMap((segmentId) => {
        const segment = segmentsById.get(segmentId);
        return segment ? [segment] : [];
      });
      const speakerSegments = sourceSegments.filter(
        (segment) => segment.speaker === insight.speaker.id
      );
      const identityLabels = [...new Set(
        (speakerSegments.length > 0 ? speakerSegments : sourceSegments)
          .map((segment) => transcriptSpeakerLabel(segment))
          .filter((label): label is string => Boolean(label))
      )];
      const speakerLabel = identityLabels.length === 1
        ? identityLabels[0]
        : insight.speaker.id;
      return formatRelationshipInsightForProvider(insight, currentSegmentIds, speakerLabel);
    })
    .join("\n");

  const content = [
    `uploadId=${input.uploadId}`,
    `recordingDate=${input.recordingDate}`,
    "Transcript segments:",
    transcript,
    insights ? "\nCurrent chunk audio insights:" : "",
    insights
  ]
    .filter(Boolean)
    .join("\n");

  return {
    content,
    unoptimizedContextCharacterCount: unoptimizedRelationshipContextCharacterCount(input),
    transcriptCharacterCount: transcript.length,
    semanticCharacterCount: 0,
    semanticSegmentCount: 0,
    insightCharacterCount: insights.length
  };
}

const systemPrompt = [
  "你是 Relationship Signal Cards 结构化抽取器，只做基于录音证据的约会 / 相处 / 亲密关系互动复盘。",
  "非关系语境必须返回 {\"items\":[]}，例如技术讨论、工作会议、智能音箱讨论、普通产品讨论都不要硬生成关系信号卡。",
  "只允许生成 6 类 signalType：active_listening、emotional_support、boundary_respect、clear_commitment、evasive_answer、invalidating_or_belittling。",
  "服务端会根据 signalType 保守推导 category；不要输出 category，但必须输出 low / medium / high 之一的 severity。",
  "暂时不要生成 emotional_pressure；如果看到压力感，只能温和写成 uncertain，例如可能存在压力感 / 需要澄清的互动。",
  "每个候选必须基于证据并保持温和、不确定；最终解释和追问字段由服务端确定性补齐。",
  "每个候选必须引用真实 transcript segment id，字段名使用 evidenceSegmentIds。",
  "不做人格判断，不做心理诊断，不做关系裁判，不直接建议分手。",
  "禁止输出：他是渣男、她是渣女、对方一定在操控你、这个人有病、你应该分手、人格定性、心理诊断、绝对化关系结论。",
  "risk 或 uncertain 卡必须有 caution；低置信度必须表达不确定；证据不足返回空数组。"
].join("\n");

function relationshipJsonInstruction(mode: RelationshipSignalRecoveryMode, limit: 3 | 5) {
  return [
    "输出 relationship_signal_cards JSON 对象，根字段 items 必须是 JSON 数组。",
    `最多返回 ${limit} 个彼此独立、具有新增信息的高价值候选；没有高价值关系互动时返回 {\"items\":[]}。`,
    mode === "compact"
      ? "这是 compact recovery：只返回最多 3 个最高价值候选，不要补充解释或重复内容。"
      : "只返回高置信度、具体并且可由当前片段直接验证的候选。",
    "每个 item 只能包含 signalType、severity、confidence、summary、evidenceSegmentIds，以及 evasive_answer / invalidating_or_belittling 必需的 caution。",
    "summary 最多 180 字，caution 最多 160 字；不要输出 explanation、speaker、quote、时间、Markdown 或额外 evidence 对象。",
    "evidenceSegmentIds 必须包含 1 到 6 个输入中真实存在的 transcript segment id；不要生成 sourceId 或时间戳。",
    "只返回有具体对象、动作、边界、承诺、计划或具体担忧的高信息量候选；普通寒暄、即时点餐决定、泛泛支持和简单赞同不要生成。"
  ].join("\n");
}

export function buildRelationshipSignalRequestPlan(
  input: Parameters<RelationshipSignalProvider["analyze"]>[0]
) {
  const mode = recoveryMode(input);
  const limit = candidateLimit(mode);
  const selectedContext = selectRelationshipContext({
    segments: input.segments,
    audioInsights: input.audioInsights
  });
  const providerInput = {
    ...input,
    segments: selectedContext.segments,
    audioInsights: selectedContext.audioInsights
  };
  const prompt = buildRelationshipSignalPrompt(providerInput);
  const maxOutputTokens = readPositiveInteger("RELATIONSHIP_SIGNAL_CHUNK_MAX_OUTPUT_TOKENS", 2_800);
  const jsonInstruction = relationshipJsonInstruction(mode, limit);
  const jsonPrompt = jsonOnlyInstruction(jsonInstruction);
  const metrics = {
    responseMode: "json",
    model: getModel(),
    promptCharacterCount: systemPrompt.length + jsonPrompt.length + prompt.content.length,
    unoptimizedContextCharacterCount: unoptimizedRelationshipContextCharacterCount(input),
    optimizedContextCharacterCount: prompt.content.length,
    transcriptCharacterCount: prompt.transcriptCharacterCount,
    semanticCharacterCount: prompt.semanticCharacterCount,
    semanticSegmentCount: prompt.semanticSegmentCount,
    insightCharacterCount: prompt.insightCharacterCount,
    systemPromptCharacterCount: systemPrompt.length,
    jsonInstructionCharacterCount: jsonPrompt.length,
    maxOutputTokens,
    recoveryMode: mode,
    candidateLimit: limit,
    insightsBefore: selectedContext.audit.insightsBefore,
    insightsAfter: selectedContext.audit.insightsAfter,
    insightCharsBefore: selectedContext.audit.insightCharsBefore,
    insightCharsAfter: selectedContext.audit.insightCharsAfter,
    removedReasonCounts: selectedContext.audit.removedReasonCounts
  } as const;
  return { mode, limit, providerInput, prompt, maxOutputTokens, jsonInstruction, metrics };
}

async function extractCandidates(input: Parameters<RelationshipSignalProvider["analyze"]>[0]) {
  if (!hasRelationshipSignalContext(input)) {
    return [];
  }
  const plan = buildRelationshipSignalRequestPlan(input);
  const client = createOpenAIClient(await getOpenAIClientRuntimeConfig());
  input.onRequestMetrics?.(plan.metrics);
  const parsed = await parseStructuredJsonResponse({
      client,
      model: getModel(),
      name: "relationship_signal_cards",
      schema: CompactRelationshipCandidateItemsSchema,
      requestInput: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: plan.prompt.content
        }
      ],
      jsonInstruction: plan.jsonInstruction,
      normalize: normalizeRelationshipConfidenceLabels,
      mode: "json",
      maxOutputTokens: plan.maxOutputTokens,
      requestOptions: {
        maxRetries: 0,
        ...(input.signal ? { signal: input.signal } : {})
      },
      ...(input.evaluationRawResponseCapture ? {
        onValidationFailureRawResponse: async (capture) => {
          await captureProviderValidationFailure({
            provider: "relationship_signal",
            uploadId: input.uploadId,
            chunkIndex: input.evaluationRawResponseCapture!.chunkIndex,
            attempt: input.evaluationRawResponseCapture!.attempt,
            model: capture.model,
            schemaName: capture.schemaName,
            capturedAt: capture.capturedAt,
            rawResponse: capture.rawResponse,
            validationIssueCount: capture.validationIssueCount,
            validationIssues: capture.validationIssues,
            validationIssueSummary: capture.validationIssueSummary,
            validationIssuesTruncated: capture.validationIssuesTruncated,
            evaluationRetention: input.evaluationRawResponseCapture!.evaluationRetention
          });
        }
      } : {}),
      ...(input.onDiagnostics ? { onDiagnostics: input.onDiagnostics } : {})
    });

  const compactCandidates = selectCompactCandidates(parsed.items ?? [], plan.limit);
  const audit: RelationshipSignalCandidateAudit = {
    contract: "compact",
    recoveryMode: plan.mode,
    candidateLimit: plan.limit,
    rawCandidateCount: parsed.items?.length ?? 0,
    compactCandidateCount: compactCandidates.length,
    overLimitCount: Math.max(0, (parsed.items?.length ?? 0) - compactCandidates.length)
  };
  input.onCandidateAudit?.(audit);
  return compactCandidates.map(toRawRelationshipSignalItem);
}

export const openaiRelationshipSignalProvider: RelationshipSignalProvider = {
  extractCandidates,
  async analyze(input) {
    if (!hasRelationshipSignalContext(input)) {
      return [];
    }

    const items = await extractCandidates(input);
    const currentSegmentIds = new Set(input.segments.map((segment) => segment.id));
    const evidenceSafeItems = items.filter(
      (item) => item.evidenceSegmentIds.length > 0
        && item.evidenceSegmentIds.every((segmentId) => currentSegmentIds.has(segmentId))
    );

    const cards = normalizeRelationshipSignalItems({
      uploadId: input.uploadId,
      recordingDate: input.recordingDate,
      segments: input.segments,
      semanticSegments: input.semanticSegments,
      audioInsights: input.audioInsights,
      items: evidenceSafeItems
    });

    return cards.length > 0 ? cards : buildConservativeRelationshipSignalFallbackCards(input);
  }
};

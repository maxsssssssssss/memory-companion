import {
  RelationshipSignalModelItemsSchema,
  buildConservativeRelationshipSignalFallbackCards,
  hasRelationshipSignalContext,
  normalizeRelationshipSignalModelResponse,
  normalizeRelationshipSignalItems
} from "@/lib/processing/relationship-signals";
import { createOpenAIClient } from "@/lib/server/openai/client";
import { jsonOnlyInstruction, parseStructuredJsonResponse } from "@/lib/server/openai/structured-json";
import { getOpenAIClientRuntimeConfig } from "@/lib/server/settings/provider-config";
import type { RelationshipSignalProvider } from "./provider";

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

function unoptimizedRelationshipContextCharacterCount(
  input: Parameters<RelationshipSignalProvider["analyze"]>[0]
) {
  const transcript = input.segments
    .map((segment) => `[${segment.id}] ${segment.startSeconds}-${segment.endSeconds}s ${segment.speaker ?? "speaker_unknown"}: ${compactText(segment.text, 500)}`)
    .join("\n");
  const semantic = input.semanticSegments
    .slice(0, 4)
    .map((segment) => `[${segment.id}] ${segment.sourceTimeRange.startSeconds}-${segment.sourceTimeRange.endSeconds}s ${compactText(segment.title, 500)}: ${compactText(segment.summary, 500)}`)
    .join("\n");
  const insights = input.audioInsights
    .slice(0, 12)
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
  const transcript = input.segments
    .map((segment) => `[${segment.id}] ${segment.startSeconds}-${segment.endSeconds}s ${segment.speaker ?? "speaker_unknown"}: ${normalizedText(segment.text)}`)
    .join("\n");
  const insights = input.audioInsights
    .slice(0, 12)
    .map((insight) => {
      const labels = [
        ...insight.toneLabels,
        ...insight.emotionLabels,
        ...insight.interactionLabels,
        ...(insight.atmosphereLabels ?? [])
      ].join(",");
      const sourceSegmentIds = insight.sourceSegmentIds.filter((segmentId) => currentSegmentIds.has(segmentId));
      return `[${insight.id}] ${insight.sourceTimeRange.startSeconds}-${insight.sourceTimeRange.endSeconds}s ${insight.speaker.id} sourceSegmentIds=${sourceSegmentIds.join(",")} labels=${compactText(labels, 120)} summary=${compactText(insight.summary, 180)}`;
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
  "signalCategory 只能是 positive、uncertain、risk。evasive_answer 通常用 uncertain；invalidating_or_belittling 可用 uncertain 或 risk。",
  "暂时不要生成 emotional_pressure；如果看到压力感，只能温和写成 uncertain，例如可能存在压力感 / 需要澄清的互动。",
  "每张卡必须是证据 + 温和解释 + 不确定性 + 可追问问题。",
  "每张卡必须引用真实 transcript segment id，字段名使用 evidenceSegmentIds。",
  "不做人格判断，不做心理诊断，不做关系裁判，不直接建议分手。",
  "禁止输出：他是渣男、她是渣女、对方一定在操控你、这个人有病、你应该分手、人格定性、心理诊断、绝对化关系结论。",
  "risk 或 uncertain 卡必须有 caution；低置信度必须表达不确定；证据不足返回空数组。"
].join("\n");

const jsonInstruction = [
  "输出 relationship_signal_cards JSON 对象，根字段 items 为数组。",
  "每个 item 只需包含 signalType、signalCategory、severity、confidence、summary、explanation、evidenceSegmentIds、suggestedReflection；speaker、逐字 quote 和时间由服务端按 segment id 重建。",
  "risk 或 uncertain 必须包含 caution。",
  "counterEvidence、acousticEvidence、interactionEvidence 仅在有直接增量证据时输出，并且必须是 JSON 数组；不要重复 transcript 原文。",
  "acousticEvidence 和 interactionEvidence 只能引用输入中的 audio insight id，无法引用时省略。",
  "只能引用输入里存在的 transcript segment id；不要自己编造时间戳。没有足够关系语境或证据时输出 {\"items\":[]}。",
  "只返回有具体对象、动作、边界、承诺、计划或具体担忧的高信息量候选；普通寒暄、即时点餐决定、泛泛支持和简单赞同不要生成。",
  "只返回彼此独立、具有新增信息的高价值候选；summary 和 explanation 保持简洁，不要逐句生成卡片。"
].join("\n");

async function extractCandidates(input: Parameters<RelationshipSignalProvider["analyze"]>[0]) {
  if (!hasRelationshipSignalContext(input)) {
    return [];
  }
  const client = createOpenAIClient(await getOpenAIClientRuntimeConfig());
  const prompt = buildRelationshipSignalPrompt(input);
  const maxOutputTokens = readPositiveInteger("RELATIONSHIP_SIGNAL_CHUNK_MAX_OUTPUT_TOKENS", 2_000);
  const jsonPrompt = jsonOnlyInstruction(jsonInstruction);
  input.onRequestMetrics?.({
    responseMode: "json",
    model: getModel(),
    promptCharacterCount: systemPrompt.length + jsonPrompt.length + prompt.content.length,
    unoptimizedContextCharacterCount: prompt.unoptimizedContextCharacterCount,
    optimizedContextCharacterCount: prompt.content.length,
    transcriptCharacterCount: prompt.transcriptCharacterCount,
    semanticCharacterCount: prompt.semanticCharacterCount,
    semanticSegmentCount: prompt.semanticSegmentCount,
    insightCharacterCount: prompt.insightCharacterCount,
    systemPromptCharacterCount: systemPrompt.length,
    jsonInstructionCharacterCount: jsonPrompt.length,
    maxOutputTokens
  });
  const parsed = await parseStructuredJsonResponse({
      client,
      model: getModel(),
      name: "relationship_signal_cards",
      schema: RelationshipSignalModelItemsSchema,
      requestInput: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: prompt.content
        }
      ],
      jsonInstruction,
      normalize: normalizeRelationshipSignalModelResponse,
      mode: "json",
      maxOutputTokens,
      requestOptions: {
        maxRetries: 0,
        ...(input.signal ? { signal: input.signal } : {})
      },
      ...(input.onDiagnostics ? { onDiagnostics: input.onDiagnostics } : {})
    });

  return parsed.items ?? [];
}

export const openaiRelationshipSignalProvider: RelationshipSignalProvider = {
  extractCandidates,
  async analyze(input) {
    if (!hasRelationshipSignalContext(input)) {
      return [];
    }

    const items = await extractCandidates(input);

    const cards = normalizeRelationshipSignalItems({
      uploadId: input.uploadId,
      recordingDate: input.recordingDate,
      segments: input.segments,
      semanticSegments: input.semanticSegments,
      audioInsights: input.audioInsights,
      items
    });

    return cards.length > 0 ? cards : buildConservativeRelationshipSignalFallbackCards(input);
  }
};

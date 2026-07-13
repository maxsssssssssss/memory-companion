import {
  RelationshipSignalModelItemsSchema,
  buildConservativeRelationshipSignalFallbackCards,
  hasRelationshipSignalContext,
  normalizeRelationshipSignalItems
} from "@/lib/processing/relationship-signals";
import { createOpenAIClient } from "@/lib/server/openai/client";
import { parseStructuredJsonResponse } from "@/lib/server/openai/structured-json";
import { getOpenAIClientRuntimeConfig } from "@/lib/server/settings/provider-config";
import type { RelationshipSignalProvider } from "./provider";

function getModel() {
  return (
    process.env.OPENAI_RELATIONSHIP_SIGNAL_MODEL?.trim() ||
    process.env.OPENAI_TEXT_MODEL?.trim() ||
    "gpt-4.1-mini"
  );
}

function compactText(text: string, maxLength = 500) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function segmentPrompt(input: Parameters<RelationshipSignalProvider["analyze"]>[0]) {
  const transcript = input.segments
    .map((segment) => `[${segment.id}] ${segment.startSeconds}-${segment.endSeconds}s ${segment.speaker ?? "speaker_unknown"}: ${compactText(segment.text)}`)
    .join("\n");
  const semantic = input.semanticSegments
    .slice(0, 12)
    .map((segment) => `[${segment.id}] ${segment.sourceTimeRange.startSeconds}-${segment.sourceTimeRange.endSeconds}s ${compactText(segment.title)}: ${compactText(segment.summary)}`)
    .join("\n");
  const insights = input.audioInsights
    .slice(0, 30)
    .map((insight) => {
      const labels = [
        ...insight.toneLabels,
        ...insight.emotionLabels,
        ...insight.interactionLabels,
        ...(insight.atmosphereLabels ?? [])
      ].join(",");
      return `[${insight.id}] ${insight.sourceTimeRange.startSeconds}-${insight.sourceTimeRange.endSeconds}s ${insight.speaker.id} labels=${labels}: ${compactText(insight.summary)} evidence=${compactText(insight.evidence)}`;
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
  ]
    .filter(Boolean)
    .join("\n");
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
  "每个 item 包含 signalType、signalCategory、severity、confidence、summary、explanation、involvedSpeakers、evidenceSegmentIds、textEvidence、suggestedReflection。",
  "risk 或 uncertain 必须包含 caution。",
  "可选字段：counterEvidence、acousticEvidence、interactionEvidence。",
  "只能引用输入里存在的 transcript segment id；不要自己编造时间戳。没有足够关系语境或证据时输出 {\"items\":[]}。"
].join("\n");

export const openaiRelationshipSignalProvider: RelationshipSignalProvider = {
  async analyze(input) {
    if (!hasRelationshipSignalContext(input)) {
      return [];
    }

    const client = createOpenAIClient(await getOpenAIClientRuntimeConfig());
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
          content: segmentPrompt(input)
        }
      ],
      jsonInstruction
    });

    const cards = normalizeRelationshipSignalItems({
      uploadId: input.uploadId,
      recordingDate: input.recordingDate,
      segments: input.segments,
      semanticSegments: input.semanticSegments,
      audioInsights: input.audioInsights,
      items: parsed.items ?? []
    });

    return cards.length > 0 ? cards : buildConservativeRelationshipSignalFallbackCards(input);
  }
};

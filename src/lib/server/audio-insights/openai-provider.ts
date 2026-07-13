import { AiAudioInsightItemsSchema, normalizeAiAudioInsightItems } from "@/lib/processing/ai-audio-insights";
import { createOpenAIClient } from "@/lib/server/openai/client";
import { parseStructuredJsonResponse } from "@/lib/server/openai/structured-json";
import { getOpenAIClientRuntimeConfig } from "@/lib/server/settings/provider-config";

import type { AudioInsightProvider } from "./provider";

import type { TranscriptSegment } from "@/lib/domain/types";

function segmentPrompt(segments: TranscriptSegment[]) {
  return segments
    .map(
      (segment) =>
        `[${segment.id}] ${segment.startSeconds}-${segment.endSeconds}s ${segment.speaker ?? "speaker_unknown"} ` +
        `scene=${segment.sceneLabels.join(",")} value=${segment.valueLabels.join(",")}: ${segment.text}`
    )
    .join("\n");
}

function getModel() {
  return (
    process.env.OPENAI_AUDIO_INSIGHT_MODEL?.trim() ||
    process.env.OPENAI_TEXT_MODEL?.trim() ||
    "gpt-4.1-mini"
  );
}

export const openaiAudioInsightProvider: AudioInsightProvider = {
  async analyze(uploadId, segments) {
    const client = createOpenAIClient(await getOpenAIClientRuntimeConfig());
    const parsed = await parseStructuredJsonResponse({
      client,
      model: getModel(),
      name: "audio_interaction_insights",
      schema: AiAudioInsightItemsSchema,
      requestInput: [
        {
          role: "system",
          content:
            "你是录音互动分析助手。只根据给定转写片段输出可追溯的语气、情绪线索、气氛线索和互动关系。" +
            "不要做心理诊断，不要给人物下性格结论；情绪只能表达为线索。" +
            "每个判断必须有 sourceSegmentIds；emotionEvidence 中的每条证据也必须有 sourceSegmentIds，且只能引用该洞察的来源片段。" +
            "atmosphereLabels 是气氛线索枚举数组；emotionEvidence[] 每条必须包含 kind、label、normalizedLabel、source、confidence、detail、sourceSegmentIds、sourceTimeRange、features。" +
            "模型生成的 emotionEvidence source 使用 llm；sourceTimeRange 必须落在引用片段的时间范围内。" +
            "使用给定枚举标签。"
        },
        {
          role: "user",
          content: segmentPrompt(segments)
        }
      ],
      jsonInstruction:
        "输出 audio_interaction_insights JSON：items 为数组；每项包含 sourceSegmentIds、speaker、voice、toneLabels、emotionLabels、interactionLabels、summary、evidence、confidence。" +
        "speaker.role 使用 self、other、customer、teammate、teacher、unknown；voice.pace 使用 slow、normal、fast、unknown；voice.volume 使用 low、normal、high、unknown；voice.pause 使用 few、normal、many、unknown。" +
        "toneLabels 使用 firm、hesitant、explaining、questioning、pushing_back、comforting、excited、perfunctory、playful、serious、unknown。" +
        "emotionLabels 使用 relaxed、happy、interested、neutral、tense、anxious、confused、dissatisfied、tired、unknown。" +
        "interactionLabels 使用 agreement、disagreement、follow_up_question、interruption、silence、topic_shift、tension、rapport、flirtation_or_testing、decision_moment、unknown。" +
        "只引用给定片段 id；无法判断时输出 unknown 标签。"
    });

    const insights = normalizeAiAudioInsightItems({
      uploadId,
      segments,
      items: parsed.items ?? []
    });

    if (segments.length > 0 && insights.length === 0) {
      throw new Error("OpenAI audio insight provider returned no valid audio insights");
    }

    return insights;
  }
};

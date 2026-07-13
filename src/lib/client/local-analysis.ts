import {
  QuestionAnswerSchema,
  type AudioInsight,
  type AudioUpload,
  type BriefItem,
  type ProcessingJob,
  type QuestionAnswer,
  type RelationshipSignalCard,
  type SemanticSegment,
  type SpeakerAliasesByUploadId,
  type SpeakerAliasMap,
  type TranscriptSegment
} from "@/lib/domain/types";
import type { ProactiveInsight } from "@/lib/domain/proactive-insights";
import { normalizeAudioForTranscription } from "@/lib/audio/compat";
import { resolveQaPromptInstruction } from "@/lib/domain/qa-prompts";
import { applyAcousticFeaturesToAudioInsights } from "@/lib/processing/acoustic-features";
import { AiAudioInsightItemsSchema, normalizeAiAudioInsightItems } from "@/lib/processing/ai-audio-insights";
import { buildAudioInsights } from "@/lib/processing/audio-insights";
import { classifySegment } from "@/lib/processing/classifier";
import { applyEmotionEvidenceToAudioInsights } from "@/lib/processing/emotion-evidence";
import { extractBriefItems } from "@/lib/processing/extract-rule-based";
import { buildSemanticSegments } from "@/lib/processing/semantic-segments";

import { transcribeAudioFileWithOpenRouter } from "./openrouter-local";
import { extractBrowserAcousticFeatures } from "./acoustic-features";

type LocalConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

type LocalQaScope = "current" | "week" | "all";

export type LocalDayPayload = {
  upload: AudioUpload;
  job?: ProcessingJob;
  segments: TranscriptSegment[];
  audioInsights: AudioInsight[];
  semanticSegments: SemanticSegment[];
  semanticSegmentsAvailable: boolean;
  briefItems: BriefItem[];
  relationshipSignals?: RelationshipSignalCard[];
  relationshipSignalsAvailable?: boolean;
  proactiveInsights?: ProactiveInsight[];
  proactiveInsightsAvailable?: boolean;
  speakerAliases?: SpeakerAliasMap;
  speakerAliasesByUploadId?: SpeakerAliasesByUploadId;
};

type LocalDayIndexItem = {
  uploadId: string;
  recordingDate: string;
  originalName: string;
  createdAt: string;
};

type OpenRouterChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
  message?: string;
};

const DEFAULT_LOCAL_TRANSCRIPTION_MODEL = "openai/gpt-4o-transcribe";
const DEFAULT_LOCAL_QA_MODEL = "openai/gpt-5-mini";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const ACTIVE_USER_STORAGE_KEY = "daily-brief:active-user-id";
const TARGET_SEGMENT_CHARS = 180;
const MIN_SEGMENT_SECONDS = 15;
const MAX_LOCAL_QA_CONTEXT_CHARS = 14000;
const MAX_LOCAL_QA_HISTORY_ITEMS = 100;
const memoryStorage = new Map<string, string>();

function isAggregatedDayUploadId(uploadId: string) {
  return /^day_\d{4}-\d{2}-\d{2}$/.test(uploadId);
}

function getStorage() {
  const browserStorage = typeof window !== "undefined" ? window.localStorage : null;
  if (
    browserStorage &&
    typeof browserStorage.getItem === "function" &&
    typeof browserStorage.setItem === "function" &&
    typeof browserStorage.removeItem === "function"
  ) {
    return browserStorage;
  }

  return {
    getItem: (key: string) => memoryStorage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memoryStorage.set(key, value);
    },
    removeItem: (key: string) => {
      memoryStorage.delete(key);
    }
  };
}

function activeLocalUserId() {
  try {
    const userId = getStorage().getItem(ACTIVE_USER_STORAGE_KEY)?.trim();
    return userId || "anonymous";
  } catch {
    return "anonymous";
  }
}

function scopedLocalStorageKey(key: string) {
  return `daily-brief:${activeLocalUserId()}:${key}`;
}

function localDayStorageKey(uploadId: string) {
  return scopedLocalStorageKey(`local-day:${uploadId}`);
}

function localDayIndexStorageKey() {
  return scopedLocalStorageKey("local-day-index");
}

function localQaHistoryKey(uploadId: string) {
  return scopedLocalStorageKey(`qa-history:${encodeURIComponent(uploadId)}`);
}

function createLocalUploadId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `local_${crypto.randomUUID()}`;
  }

  return `local_${Date.now().toString(36)}`;
}

function uint8ArrayToArrayBuffer(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function normalizeTranscriptText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function trimText(text: string, maxLength: number) {
  const normalizedText = normalizeTranscriptText(text);
  return normalizedText.length <= maxLength ? normalizedText : `${normalizedText.slice(0, maxLength - 1)}…`;
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function formatContextTime(seconds: number) {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainderSeconds = safeSeconds % 60;

  return `${minutes}:${String(remainderSeconds).padStart(2, "0")}`;
}

function splitLongSentence(sentence: string) {
  const chunks: string[] = [];

  for (let index = 0; index < sentence.length; index += TARGET_SEGMENT_CHARS) {
    const chunk = sentence.slice(index, index + TARGET_SEGMENT_CHARS).trim();
    if (chunk) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

function splitTranscriptIntoChunks(text: string) {
  const normalizedText = normalizeTranscriptText(text);
  if (!normalizedText) {
    return [];
  }

  return normalizedText
    .split(/(?<=[。！？!?；;])\s*/)
    .flatMap((sentence) => {
      const trimmedSentence = sentence.trim();
      if (!trimmedSentence) {
        return [];
      }

      return trimmedSentence.length > TARGET_SEGMENT_CHARS ? splitLongSentence(trimmedSentence) : [trimmedSentence];
    });
}

function buildLocalTranscriptSegments(input: { uploadId: string; text: string; durationSeconds?: number }) {
  const chunks = splitTranscriptIntoChunks(input.text);
  const durationSeconds = Math.max(
    input.durationSeconds ?? chunks.reduce((sum, chunk) => sum + Math.max(MIN_SEGMENT_SECONDS, Math.ceil(chunk.length / 3)), 0),
    chunks.length * MIN_SEGMENT_SECONDS
  );
  const segmentDurationSeconds = chunks.length > 0 ? durationSeconds / chunks.length : MIN_SEGMENT_SECONDS;

  return chunks.map((chunk, index) => {
    const startSeconds = Math.round(index * segmentDurationSeconds * 100) / 100;
    const endSeconds = Math.round((index + 1) * segmentDurationSeconds * 100) / 100;
    const segment: TranscriptSegment = {
      id: `${input.uploadId}_seg_${index + 1}`,
      uploadId: input.uploadId,
      startSeconds,
      endSeconds: Math.max(endSeconds, startSeconds + 1),
      text: chunk,
      confidence: 0.82,
      sceneLabels: ["unknown"],
      valueLabels: []
    };

    return classifySegment(segment);
  });
}

function localVoiceExplanationText(insight: AudioInsight) {
  const explanations = insight.voice.explanations ?? [];
  if (explanations.length === 0) {
    return "";
  }

  return `\n声音依据：${explanations.map((explanation) => `${explanation.label}：${explanation.detail}`).join("；")}`;
}

function localEmotionEvidenceText(insight: AudioInsight) {
  const evidence = insight.emotionEvidence ?? [];
  if (evidence.length === 0) {
    return "";
  }

  const atmosphereText = (insight.atmosphereLabels ?? []).join("、") || "未标注";
  const evidenceText = evidence
    .slice(0, 6)
    .map((item) => {
      const features = item.features ?? [];
      const featureLabels = [...new Set(features.map((feature) => feature.label).filter(Boolean))].slice(0, 6);
      const featureText =
        featureLabels.length > 0 ? `；特征：${featureLabels.join("、")}` : "";
      return `${item.label}（${item.source}，置信度 ${Math.round(item.confidence * 100)}%）：${trimText(item.detail, 260)}${featureText}`;
    })
    .join("；");

  return `\n气氛线索：${atmosphereText}\n情绪证据：${evidenceText}`;
}

function localUserCorrectionText(insight: AudioInsight) {
  const corrections = insight.userCorrections ?? [];
  if (corrections.length === 0) {
    return "";
  }

  const lines = corrections
    .flatMap((correction) => {
      const labelText = correction.labelCorrections.map((item) => `${item.from} -> ${item.to}`).join("；");
      return [labelText ? `用户纠正：${labelText}` : "", correction.note ? `纠正说明：${correction.note}` : ""].filter(Boolean);
    })
    .join("；");

  return lines ? `\n${lines}` : "";
}

function localQaContext(payload: LocalDayPayload) {
  const audioInsightContext =
    payload.audioInsights.length > 0
      ? `\n\n语气/互动线索：\n${payload.audioInsights
          .slice(0, 12)
          .map(
            (insight, index) =>
              `${index + 1}. ${formatContextTime(insight.sourceTimeRange.startSeconds)}-${formatContextTime(insight.sourceTimeRange.endSeconds)} ${insight.summary}\n说话人：${insight.speaker.displayName ?? insight.speaker.id}；语气：${insight.toneLabels.join("、")}；情绪线索：${insight.emotionLabels.join("、")}；互动：${insight.interactionLabels.join("、")}；声音：语速 ${insight.voice.pace}，音量 ${insight.voice.volume}，停顿 ${insight.voice.pause}，重叠 ${insight.voice.overlap}${localVoiceExplanationText(insight)}${localEmotionEvidenceText(insight)}${localUserCorrectionText(insight)}\n依据：${insight.evidence}`
          )
          .join("\n\n")}`
      : "";
  const semanticContext =
    payload.semanticSegments.length > 0
      ? payload.semanticSegments
          .map(
            (segment, index) =>
              `${index + 1}. ${formatContextTime(segment.startSeconds)}-${formatContextTime(segment.endSeconds)} ${segment.title}\n标签：${segment.tags.join("、") || "无"}\n摘要：${segment.summary}\n原文：${segment.transcriptExcerpt}`
          )
          .join("\n\n")
      : payload.segments
          .map(
            (segment, index) =>
              `${index + 1}. ${formatContextTime(segment.startSeconds)}-${formatContextTime(segment.endSeconds)}\n原文：${segment.text}`
          )
          .join("\n\n");

  return trimText(`${semanticContext}${audioInsightContext}`, MAX_LOCAL_QA_CONTEXT_CHARS);
}

function localQaCitations(payload: LocalDayPayload) {
  if (payload.semanticSegments.length > 0) {
    return payload.semanticSegments.slice(0, 5).map((segment) => ({
      id: segment.id,
      title: segment.title,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      excerpt: segment.transcriptExcerpt,
      sourceSegmentIds: segment.sourceSegmentIds
    }));
  }

  return payload.segments.slice(0, 5).map((segment) => ({
    id: segment.id,
    title: "本地录音片段",
    startSeconds: segment.startSeconds,
    endSeconds: segment.endSeconds,
    excerpt: segment.text,
    sourceSegmentIds: [segment.id]
  }));
}

function localAudioInsightContext(segments: TranscriptSegment[]) {
  return segments
    .slice(0, 80)
    .map(
      (segment) =>
        `[${segment.id}] ${formatContextTime(segment.startSeconds)}-${formatContextTime(segment.endSeconds)} ` +
        `${segment.speaker ?? "speaker_unknown"} scene=${segment.sceneLabels.join(",")} value=${segment.valueLabels.join(",")}: ${segment.text}`
    )
    .join("\n");
}

function parseLocalAudioInsightContent(content: string) {
  const trimmedContent = content.trim();
  const fencedMatch = trimmedContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const jsonText = fencedMatch?.[1]?.trim() ?? trimmedContent;

  try {
    return AiAudioInsightItemsSchema.parse(JSON.parse(jsonText));
  } catch (error) {
    throw new Error("OpenRouter audio insight failed: invalid JSON response", { cause: error });
  }
}

async function buildAudioInsightsLocallyWithOpenRouter(input: {
  uploadId: string;
  segments: TranscriptSegment[];
  apiKey: string;
  model?: string;
  baseUrl?: string;
}) {
  const baseUrl = (input.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: input.model || DEFAULT_LOCAL_QA_MODEL,
      messages: [
        {
          role: "system",
          content:
            "你是录音互动分析助手。只根据给定转写片段判断可追溯的语气、情绪线索和互动关系。" +
            "不要做心理诊断，不要给人物下性格结论；情绪只能表达为线索。" +
            "只返回 JSON，格式为 {\"items\":[...]}，每条必须引用 sourceSegmentIds。"
        },
        {
          role: "user",
          content: localAudioInsightContext(input.segments)
        }
      ]
    })
  });
  const payload = await parseOpenRouterChatResponse(response);

  if (!response.ok) {
    throw new Error(`OpenRouter audio insight failed: ${response.status} ${payload.error?.message ?? payload.message ?? response.statusText}`);
  }

  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("OpenRouter audio insight failed: empty response");
  }

  const insights = normalizeAiAudioInsightItems({
    uploadId: input.uploadId,
    segments: input.segments,
    items: parseLocalAudioInsightContent(content).items
  });

  if (input.segments.length > 0 && insights.length === 0) {
    throw new Error("OpenRouter audio insight failed: no valid audio insights");
  }

  return insights;
}

async function enrichLocalAudioInsightsWithAcousticFeatures(input: {
  bytes: Uint8Array;
  segments: TranscriptSegment[];
  audioInsights: AudioInsight[];
}) {
  try {
    const features = await extractBrowserAcousticFeatures({
      bytes: input.bytes,
      segments: input.segments
    });

    return applyAcousticFeaturesToAudioInsights(input.audioInsights, features);
  } catch {
    return input.audioInsights;
  }
}

function normalizeLocalDayPayload(payload: LocalDayPayload): LocalDayPayload {
  return {
    ...payload,
    audioInsights: payload.audioInsights ?? [],
    semanticSegments: payload.semanticSegments ?? [],
    semanticSegmentsAvailable: payload.semanticSegmentsAvailable ?? (payload.semanticSegments?.length ?? 0) > 0,
    briefItems: payload.briefItems ?? [],
    relationshipSignals: payload.relationshipSignals ?? [],
    relationshipSignalsAvailable: payload.relationshipSignalsAvailable ?? (payload.relationshipSignals?.length ?? 0) > 0,
    proactiveInsights: payload.proactiveInsights ?? [],
    proactiveInsightsAvailable: payload.proactiveInsightsAvailable ?? (payload.proactiveInsights?.length ?? 0) > 0,
    speakerAliases: payload.speakerAliases ?? {},
    speakerAliasesByUploadId: payload.speakerAliasesByUploadId ?? {}
  };
}

const localQaScopeInstructions: Record<LocalQaScope, string> = {
  current: "只根据用户当天录音上下文回答；证据不足时直接说明，不要编造。可以承接上文对话意图。",
  week:
    "只根据用户本周录音记忆回答；可以串联一周里的反复主题、推进、卡点、承诺和互动变化。证据只来自某一天时要说清楚，不能包装成整周趋势。",
  all:
    "只根据用户全部录音记忆回答；可以回看跨日期变化和长期反复线索。长期判断必须有至少两个不同日期的证据，只有单日证据时不能包装成长期趋势。"
};

const localQaContextLabels: Record<LocalQaScope, string> = {
  current: "当天录音上下文",
  week: "本周记忆上下文",
  all: "全部记忆上下文"
};

function localQaScopeMetadata(payload: LocalDayPayload, scope: LocalQaScope) {
  const contextText = localQaContext(payload);
  const dates = [...new Set(contextText.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [])].sort();
  const dateText = dates.length > 0 ? dates.join(", ") : scope === "current" ? payload.upload.recordingDate : "未从上下文中识别到日期";
  const evidenceCount =
    payload.segments.length + payload.audioInsights.length + payload.semanticSegments.length + payload.briefItems.length;

  return [`范围：${localQaContextLabels[scope]}`, `可用证据日期：${dateText}`, `证据条数：${evidenceCount}`].join("\n");
}

function promptForLocalQa(input?: { promptPresetId?: string; customPrompt?: string; scope?: LocalQaScope }) {
  const roleInstruction = resolveQaPromptInstruction(input);
  const scope = input?.scope ?? "current";

  return [
    "你是昼记 AI，一个克制、温暖、可信的个人录音记忆助手。",
    roleInstruction ? `当前用户选择的问答角色/场景说明：${roleInstruction}` : "",
    roleInstruction
      ? "当用户问你是谁、能做什么时，也必须贴合当前角色/场景说明来介绍你能帮什么；不要默认使用会议、产品、待办等工作场景示例，除非当前角色本身就是工作复盘。"
      : "",
    localQaScopeInstructions[scope],
    "当证据里有声音依据或情绪/气氛线索时，只能作为辅助线索，不能单独证明情绪。",
    "禁止：不做心理诊断，不给人物下性格结论；情绪只能作为线索，不输出无证据长期趋势。"
  ]
    .filter(Boolean)
    .join("\n");
}

async function parseOpenRouterChatResponse(response: Response): Promise<OpenRouterChatResponse> {
  const rawBody = await response.text();
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody) as OpenRouterChatResponse;
  } catch {
    return { message: rawBody };
  }
}

function readLocalDayIndex() {
  try {
    const rawIndex = getStorage().getItem(localDayIndexStorageKey());
    if (!rawIndex) {
      return [];
    }

    const parsedIndex = JSON.parse(rawIndex) as LocalDayIndexItem[];
    return Array.isArray(parsedIndex) ? parsedIndex : [];
  } catch {
    return [];
  }
}

function writeLocalDayIndex(index: LocalDayIndexItem[]) {
  getStorage().setItem(localDayIndexStorageKey(), JSON.stringify(index));
}

export async function analyzeAudioLocally(input: {
  file: File;
  recordingDate: string;
  apiKey: string;
  uploadId?: string;
  model?: string;
  baseUrl?: string;
}): Promise<LocalDayPayload> {
  const uploadId = input.uploadId ?? createLocalUploadId();
  const createdAt = new Date().toISOString();
  const originalBytes = new Uint8Array(await input.file.arrayBuffer());
  const normalizedAudio = normalizeAudioForTranscription({
    name: input.file.name,
    type: input.file.type,
    bytes: originalBytes
  });
  const normalizedBuffer = uint8ArrayToArrayBuffer(normalizedAudio.bytes);
  const transcriptionFile = new File([normalizedBuffer], normalizedAudio.name, { type: normalizedAudio.mimeType });
  Object.defineProperty(transcriptionFile, "arrayBuffer", {
    value: () => Promise.resolve(normalizedBuffer)
  });
  const transcription = await transcribeAudioFileWithOpenRouter({
    file: transcriptionFile,
    apiKey: input.apiKey,
    model: input.model ?? DEFAULT_LOCAL_TRANSCRIPTION_MODEL,
    baseUrl: input.baseUrl
  });
  const segments = buildLocalTranscriptSegments({
    uploadId,
    text: transcription.text,
    durationSeconds: transcription.durationSeconds
  });
  const textAudioInsights = await buildAudioInsightsLocallyWithOpenRouter({
    uploadId,
    segments,
    apiKey: input.apiKey,
    model: input.model,
    baseUrl: input.baseUrl
  }).catch(() => buildAudioInsights(uploadId, segments));
  const acousticAudioInsights = await enrichLocalAudioInsightsWithAcousticFeatures({
    bytes: normalizedAudio.bytes,
    segments,
    audioInsights: textAudioInsights
  });
  const audioInsights = applyEmotionEvidenceToAudioInsights(acousticAudioInsights);
  const semanticSegments = buildSemanticSegments(uploadId, segments);
  const briefItems = extractBriefItems(uploadId, segments);

  return {
    upload: {
      id: uploadId,
      originalName: input.file.name,
      mimeType: normalizedAudio.mimeType,
      sizeBytes: input.file.size,
      recordingDate: input.recordingDate,
      createdAt,
      durationSeconds: transcription.durationSeconds,
      status: "ready"
    },
    job: {
      id: `${uploadId}_job`,
      uploadId,
      status: "ready",
      progress: 100,
      startedAt: createdAt,
      finishedAt: new Date().toISOString()
    },
    segments,
    audioInsights,
    semanticSegments,
    semanticSegmentsAvailable: true,
    briefItems,
    relationshipSignals: [],
    relationshipSignalsAvailable: true,
    proactiveInsights: [],
    proactiveInsightsAvailable: false
  };
}

export function saveLocalDayPayload(payload: LocalDayPayload) {
  if (isAggregatedDayUploadId(payload.upload.id)) {
    throw new Error("不能把聚合日视图保存为真实本地录音。");
  }

  getStorage().setItem(localDayStorageKey(payload.upload.id), JSON.stringify(payload));

  const currentIndex = readLocalDayIndex().filter((item) => item.uploadId !== payload.upload.id);
  writeLocalDayIndex([
    ...currentIndex,
    {
      uploadId: payload.upload.id,
      recordingDate: payload.upload.recordingDate,
      originalName: payload.upload.originalName,
      createdAt: payload.upload.createdAt ?? new Date().toISOString()
    }
  ]);
}

export function readLocalDayPayload(uploadId: string) {
  try {
    const rawPayload = getStorage().getItem(localDayStorageKey(uploadId));
    return rawPayload ? normalizeLocalDayPayload(JSON.parse(rawPayload) as LocalDayPayload) : null;
  } catch {
    return null;
  }
}

export function deleteLocalDayPayload(uploadId: string) {
  getStorage().removeItem(localDayStorageKey(uploadId));
  writeLocalDayIndex(readLocalDayIndex().filter((item) => item.uploadId !== uploadId));
}

export function listLocalDayIndex() {
  return readLocalDayIndex().sort((a, b) => a.recordingDate.localeCompare(b.recordingDate) || a.createdAt.localeCompare(b.createdAt));
}

export function readLocalQaHistory(uploadId: string): QuestionAnswer[] {
  try {
    const rawHistory = getStorage().getItem(localQaHistoryKey(uploadId));
    if (!rawHistory) {
      return [];
    }

    const parsedHistory = JSON.parse(rawHistory) as unknown;
    if (!Array.isArray(parsedHistory)) {
      return [];
    }

    return parsedHistory.flatMap((answer) => {
      const parsedAnswer = QuestionAnswerSchema.safeParse(answer);
      return parsedAnswer.success ? [parsedAnswer.data] : [];
    });
  } catch {
    return [];
  }
}

export function appendLocalQaHistory(uploadId: string, answer: QuestionAnswer) {
  const normalizedAnswer: QuestionAnswer = {
    ...answer,
    uploadId,
    createdAt: answer.createdAt || new Date().toISOString()
  };
  const parsedAnswer = QuestionAnswerSchema.safeParse(normalizedAnswer);
  if (!parsedAnswer.success) {
    return;
  }

  const nextHistory = [...readLocalQaHistory(uploadId).filter((item) => item.id !== parsedAnswer.data.id), parsedAnswer.data].slice(
    -MAX_LOCAL_QA_HISTORY_ITEMS
  );
  getStorage().setItem(localQaHistoryKey(uploadId), JSON.stringify(nextHistory));
}

export function clearLocalQaHistory(uploadId: string) {
  getStorage().removeItem(localQaHistoryKey(uploadId));
}

export async function answerQuestionLocally(input: {
  payload: LocalDayPayload;
  apiKey: string;
  question: string;
  conversation: LocalConversationMessage[];
  scope?: LocalQaScope;
  model?: string;
  baseUrl?: string;
  promptPresetId?: string;
  customPrompt?: string;
}) {
  const baseUrl = (input.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, "");
  const citations = localQaCitations(input.payload);
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: input.model || DEFAULT_LOCAL_QA_MODEL,
      messages: [
        {
          role: "system",
          content: promptForLocalQa({
            promptPresetId: input.promptPresetId,
            customPrompt: input.customPrompt,
            scope: input.scope
          })
        },
        ...input.conversation,
        {
          role: "user",
          content: `参考日期：${input.payload.upload.recordingDate}\n\n范围元信息：\n${localQaScopeMetadata(input.payload, input.scope ?? "current")}\n\n${localQaContextLabels[input.scope ?? "current"]}：\n${localQaContext(input.payload)}\n\n用户问题：${input.question}`
        }
      ]
    })
  });
  const payload = await parseOpenRouterChatResponse(response);

  if (!response.ok) {
    throw new Error(`OpenRouter QA failed: ${response.status} ${payload.error?.message ?? payload.message ?? response.statusText}`);
  }

  const answer = payload.choices?.[0]?.message?.content?.trim();
  if (!answer) {
    throw new Error("OpenRouter QA failed: empty answer");
  }

  return {
    answer,
    citedSegmentIds: unique(citations.flatMap((citation) => citation.sourceSegmentIds)),
    citations
  };
}

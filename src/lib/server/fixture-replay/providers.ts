import {
  AudioInsightSchema,
  BriefItemSchema,
  type BriefCategory,
  type BriefItem,
  type TranscriptSegment
} from "@/lib/domain/types";
import type { ProactiveInsightRawItem } from "@/lib/domain/proactive-insights";
import { normalizeRelationshipSignalItems, normalizeRelationshipSignalModelResponse, RelationshipSignalModelItemsSchema } from "@/lib/processing/relationship-signals";
import { ruleAudioInsightProvider } from "@/lib/server/audio-insights/rule-provider";
import type { AudioInsightProvider } from "@/lib/server/audio-insights/provider";
import type { EmotionSignalProvider } from "@/lib/server/emotion-signals/provider";
import type { ExtractionProvider } from "@/lib/server/extraction/provider";
import type { MemoryRelevanceJudge } from "@/lib/server/memory/relevance/types";
import type { ProactiveInsightProvider } from "@/lib/server/proactive-insights/provider";
import { validateProactiveInsights } from "@/lib/server/proactive-insights/validator";
import type { RelationshipSignalProvider } from "@/lib/server/relationship-signals/provider";
import { fingerprintAnalysisInput } from "@/lib/server/analysis-chunks/checkpoint";
import { processDailyBriefChunks, resolveDailyBriefChunkConcurrency } from "@/lib/server/extraction/chunk-processing";
import type { TranscriptionProvider } from "@/lib/server/transcription/provider";

type FixtureBriefRule = {
  key: string;
  pattern: RegExp;
  category: BriefCategory;
  title: string;
  body: string;
  priority?: BriefItem["priority"];
};

const briefRules: FixtureBriefRule[] = [
  {
    key: "coffee_preference",
    pattern: /无糖拿铁最好|无糖拿铁就好/u,
    category: "notable_quote",
    title: "咖啡偏好 / coffee preference",
    body: "preference: 饮料倾向无糖拿铁，备选低糖饮品，不额外加糖浆。",
    priority: "medium"
  },
  {
    key: "resume_commitment_initial",
    pattern: /明确答应你，周五晚上八点之前/u,
    category: "commitment",
    title: "简历检查承诺 / resume review",
    body: "commitment resume review: 周五晚上八点前完成简历检查并返回批注。",
    priority: "high"
  },
  {
    key: "resume_question",
    pattern: /你已经看过了吗/u,
    category: "open_question",
    title: "简历检查进度 / resume review",
    body: "unresolved resume review: 需要确认简历检查进度和后续时间。",
    priority: "high"
  },
  {
    key: "resume_commitment_follow_up",
    pattern: /完整版本最晚周日晚上八点前发/u,
    category: "commitment",
    title: "简历检查后续 / resume review follow-up",
    body: "commitment resume review follow-up: 新时间为周日晚上八点前完成完整检查。",
    priority: "high"
  },
  {
    key: "resume_completed",
    pattern: /已经把检查做完了/u,
    category: "decision",
    title: "简历检查完成 / completed resume review",
    body: "completed resume review: 简历检查已完成，并给出量化结果和缩短个人简介两项建议。",
    priority: "high"
  },
  {
    key: "museum_time_question",
    pattern: /我们是十二点半走，还是一点半走/u,
    category: "open_question",
    title: "博物馆出发时间 / museum plan",
    body: "unresolved museum plan: 出发时间仍需在十二点半和一点半之间确认。",
    priority: "medium"
  },
  {
    key: "museum_initial_commitment",
    pattern: /周五中午之前问清楚/u,
    category: "commitment",
    title: "博物馆计划 / museum plan",
    body: "commitment museum plan: 周五中午前确认周六的出发时间和天气。",
    priority: "high"
  },
  {
    key: "museum_rescheduled",
    pattern: /倾向改到十二号/u,
    category: "decision",
    title: "博物馆计划调整 / museum plan",
    body: "postponed museum plan: 因天气和时间冲突，计划调整到十二号下午。",
    priority: "high"
  },
  {
    key: "museum_confirmation_commitment",
    pattern: /周四晚上九点前给你明确答复/u,
    category: "commitment",
    title: "博物馆计划确认 / museum plan follow-up",
    body: "commitment museum plan follow-up: 周四晚上九点前确认十二号行程或取消。",
    priority: "high"
  },
  {
    key: "museum_departure_confirmed",
    pattern: /对，十二点半出发/u,
    category: "commitment",
    title: "博物馆出发确认 / museum plan",
    body: "commitment museum plan: 已确认十二点半出发和楼下碰面时间。",
    priority: "high"
  },
  {
    key: "museum_completed",
    pattern: /计划算是落实了/u,
    category: "decision",
    title: "博物馆计划完成 / completed museum plan",
    body: "completed museum plan: 调整后的博物馆行程已落实，并看完航海图和青花瓷。",
    priority: "high"
  }
];

function makeBriefItem(uploadId: string, rule: FixtureBriefRule, segment: TranscriptSegment) {
  return BriefItemSchema.parse({
    id: `fixture_brief_${uploadId}_${rule.key}`,
    uploadId,
    category: rule.category,
    title: rule.title,
    body: rule.body,
    priority: rule.priority ?? "medium",
    confidence: 0.92,
    status: "confirmed",
    sourceSegmentIds: [segment.id],
    sourceTimeRange: {
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds
    },
    transcriptExcerpt: segment.text,
    people: segment.speaker ? [segment.speaker] : [],
    topics: rule.title.split(" / ")
  });
}

export const fixtureExtractionProvider: ExtractionProvider = {
  async extract(uploadId, segments, options) {
    const processorFingerprint = options?.analysisCheckpoint?.processorFingerprint ?? fingerprintAnalysisInput({
      kind: "daily_brief",
      provider: "fixture",
      promptVersion: "fixture_brief_rules_v1",
      schemaVersion: "brief_item_v1"
    });
    const result = await processDailyBriefChunks({
      uploadId,
      segments,
      semanticSegments: options?.semanticSegments,
      concurrency: resolveDailyBriefChunkConcurrency(),
      onProgress: options?.onProgress,
      providerLabel: "fixture",
      ...(options?.analysisCheckpoint ? {
        checkpoint: {
          store: options.analysisCheckpoint.store,
          userId: options.analysisCheckpoint.userId,
          recordingDate: options.analysisCheckpoint.recordingDate,
          processorFingerprint,
          staleAfterMs: options.analysisCheckpoint.staleAfterMs ?? 60_000
        }
      } : {}),
      executeChunk: async (chunk) => ({
        items: briefRules.flatMap((rule) => {
          const segment = chunk.segments.find((item) => rule.pattern.test(item.text));
          return segment ? [makeBriefItem(uploadId, rule, segment)] : [];
        }),
        resultSource: "provider_success"
      }),
      fallbackChunk: async (_chunk, error) => { throw error; }
    });
    return result.items;
  }
};

export const fixtureAudioInsightProvider: AudioInsightProvider = {
  async analyze(uploadId, segments) {
    const segmentById = new Map(segments.map((segment) => [segment.id, segment] as const));
    const insights = await ruleAudioInsightProvider.analyze(uploadId, segments);
    return insights.map((insight) => {
      const source = segmentById.get(insight.sourceSegmentIds[0]);
      if (!source || !/差不多了吧，晚一点再说/u.test(source.text)) {
        return insight;
      }
      return AudioInsightSchema.parse({
        ...insight,
        toneLabels: ["hesitant"],
        interactionLabels: ["follow_up_question"],
        summary: "关系沟通里出现了较含糊的回避回答，需要结合后续说明继续澄清。",
        evidence: source.text,
        confidence: 0.68
      });
    });
  }
};

type RelationshipCandidate = {
  signalType: "active_listening" | "emotional_support" | "boundary_respect" | "clear_commitment" | "evasive_answer";
  signalCategory: "positive" | "uncertain";
  summary: string;
  explanation: string;
  suggestedReflection: string;
  evidence: TranscriptSegment[];
  counterEvidence?: string[];
  caution?: string;
};

function candidateFromMatch(input: {
  segments: TranscriptSegment[];
  pattern: RegExp;
  includePrevious?: boolean;
  signalType: RelationshipCandidate["signalType"];
  signalCategory?: RelationshipCandidate["signalCategory"];
  summary: string;
  explanation: string;
  suggestedReflection: string;
  caution?: string;
  counterPattern?: RegExp;
}): RelationshipCandidate | null {
  const index = input.segments.findIndex((segment) => input.pattern.test(segment.text));
  if (index < 0) {
    return null;
  }
  const evidence = input.includePrevious && index > 0
    ? [input.segments[index - 1], input.segments[index]]
    : [input.segments[index]];
  const counter = input.counterPattern
    ? input.segments.find((segment) => input.counterPattern?.test(segment.text))
    : undefined;
  return {
    signalType: input.signalType,
    signalCategory: input.signalCategory ?? "positive",
    summary: input.summary,
    explanation: input.explanation,
    suggestedReflection: input.suggestedReflection,
    evidence,
    ...(counter ? { counterEvidence: [counter.text] } : {}),
    ...(input.caution ? { caution: input.caution } : {})
  };
}

function relationshipCandidates(segments: TranscriptSegment[]): RelationshipCandidate[] {
  const candidates = [
    candidateFromMatch({
      segments,
      pattern: /我听出来你|记得，你之前说|明白，你更倾向/u,
      includePrevious: true,
      signalType: "active_listening",
      summary: "回应中复述并确认了对方刚表达的具体需要。",
      explanation: "这段回应对应到明确原话，显示当下有认真接收信息的动作。",
      suggestedReflection: "这次被复述和确认时，你自己的感受是什么？"
    }),
    candidateFromMatch({
      segments,
      pattern: /明确答应你|周四晚上九点前给你明确答复|完整版本最晚周日晚上八点前发/u,
      signalType: "clear_commitment",
      summary: "对话里给出了具体时间和下一步安排。",
      explanation: "承诺包含可回看的时间点，后续可以用实际进展继续确认。",
      suggestedReflection: "到了约定时间后，这件事有怎样的后续？"
    }),
    candidateFromMatch({
      segments,
      pattern: /我尊重你现在不想继续聊的边界|我理解，你不是要求现在就保证/u,
      includePrevious: true,
      signalType: "boundary_respect",
      summary: "边界说清后，对方给出了接住和尊重的回应。",
      explanation: "现有证据只支持这次具体回应，不代表所有场景都会相同。",
      suggestedReflection: "这次边界被回应后，你有没有更放松一点？"
    }),
    candidateFromMatch({
      segments,
      pattern: /听起来不是材料没做完|不用因为我提了就有压力|你想多看一会儿时我就在附近等/u,
      includePrevious: true,
      signalType: "emotional_support",
      summary: "回应里出现了安抚、陪伴或给对方留出空间的动作。",
      explanation: "这些动作来自当前片段，可以作为这次互动的支持线索。",
      suggestedReflection: "哪一句回应最让你觉得被支持？"
    }),
    candidateFromMatch({
      segments,
      pattern: /差不多了吧，晚一点再说/u,
      includePrevious: true,
      signalType: "evasive_answer",
      signalCategory: "uncertain",
      summary: "第一次回应没有直接说明实际进度。",
      explanation: "这段回答较含糊，但后续出现了更具体的说明，因此更适合作为需要澄清的互动回看。",
      suggestedReflection: "当回答比较含糊时，怎样追问会让你更容易安排下一步？",
      caution: "单看片段不能判断动机；后续已经补充了实际进度和新时间。",
      counterPattern: /刚才那样回答太含糊了/u
    })
  ];
  return candidates.filter((candidate): candidate is RelationshipCandidate => candidate !== null).slice(0, 3);
}

export const fixtureRelationshipSignalProvider: RelationshipSignalProvider = {
  async analyze(input) {
    const candidates = relationshipCandidates(input.segments);
    const rawResponse = normalizeRelationshipSignalModelResponse({
      items: candidates.map((candidate) => ({
        signalType: candidate.signalType,
        signalCategory: candidate.signalCategory,
        severity: "low",
        confidence: candidate.signalCategory === "positive" ? 0.82 : 0.66,
        summary: candidate.summary,
        explanation: candidate.explanation,
        involvedSpeakers: [...new Set(candidate.evidence.flatMap((segment) => segment.speaker ? [segment.speaker] : []))],
        evidenceSegmentIds: candidate.evidence.map((segment) => segment.id),
        evidenceSegments: [],
        counterEvidence: candidate.counterEvidence ?? [],
        acousticEvidence: [],
        textEvidence: candidate.evidence.map((segment) => segment.text),
        interactionEvidence: [],
        suggestedReflection: candidate.suggestedReflection,
        caution: candidate.caution
      }))
    });
    const parsed = RelationshipSignalModelItemsSchema.parse(rawResponse);
    return normalizeRelationshipSignalItems({
      uploadId: input.uploadId,
      recordingDate: input.recordingDate,
      segments: input.segments,
      semanticSegments: input.semanticSegments,
      audioInsights: input.audioInsights,
      items: parsed.items,
      createdAt: `${input.recordingDate}T12:00:00.000Z`
    });
  }
};

function topicKeys(value: string) {
  const topics = ["简历", "咖啡", "博物馆", "面试", "航海图", "青花瓷", "安静", "边界"];
  return topics.filter((topic) => value.includes(topic));
}

export const fixtureMemoryRelevanceJudge: MemoryRelevanceJudge = {
  async judge(input) {
    const currentText = [
      ...input.current.topics,
      ...input.current.briefItems,
      ...input.current.semanticSummaries,
      ...input.current.relationshipSignals
    ].join(" ");
    const currentTopics = new Set(topicKeys(currentText));
    return {
      status: "judged",
      provider: "none",
      elapsedMs: 0,
      rawResults: input.candidates.map((candidate) => {
        const candidateText = `${candidate.summary} ${candidate.evidenceSummaries.join(" ")}`;
        const overlap = topicKeys(candidateText).filter((topic) => currentTopics.has(topic));
        const shouldUse = overlap.length > 0;
        return {
          memoryId: candidate.memoryId,
          shouldUse,
          relevanceScore: shouldUse ? 0.88 : 0.18,
          usefulnessScore: shouldUse ? 0.82 : 0.15,
          reason: shouldUse
            ? `当前记录和历史记忆都提到${overlap.join("、")}。`
            : "这条历史记忆与当前记录中的具体事情无关。",
          ...(!shouldUse ? { caution: "不要把无关历史内容带入当前提醒。" } : {})
        };
      })
    };
  }
};

function compact(value: string, maxLength: number) {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

export const fixtureProactiveInsightProvider: ProactiveInsightProvider = {
  async generate(input) {
    const currentEvidence = input.context.evidence[0];
    if (!currentEvidence) {
      return {
        status: "generated",
        items: [],
        provider: "none",
        elapsedMs: 0,
        sourceFingerprint: input.sourceFingerprint ?? "fixture_empty"
      };
    }
    const memory = input.memoryContext?.memories[0];
    const rawItem: ProactiveInsightRawItem = memory
      ? {
          type: "follow_up_question",
          insightType: "follow_up",
          category: "follow_up",
          observation: compact(`这次“${currentEvidence.title}”和之前记录的“${memory.title}”有直接关联。`, 280),
          question: compact(`之前提到的“${memory.title}”，这次有新的进展吗？`, 280),
          reason: compact(`当前证据提到“${currentEvidence.title}”，历史证据提到“${memory.title}”，可以回看具体后续。`, 360),
          evidenceIds: [currentEvidence.evidenceId],
          memoryRefs: [memory.evidenceId],
          confidence: 0.78,
          caution: "历史记忆是压缩观察，请以原始片段和实际后续为准。"
        }
      : {
          type: "reflection",
          insightType: "reflection",
          category: currentEvidence.kind === "relationship_signal" ? "relationship" : "summary",
          observation: compact(`这次记录里，“${currentEvidence.title}”值得回看。`, 280),
          question: compact(`关于“${currentEvidence.title}”，你最想继续确认哪一点？`, 280),
          reason: compact(`当前片段直接提到了“${currentEvidence.title}”。`, 360),
          evidenceIds: [currentEvidence.evidenceId],
          confidence: 0.72,
          caution: "这只是基于当前记录的小提醒，不代表长期结论。"
        };
    const items = validateProactiveInsights({
      context: input.context,
      memoryContext: input.memoryContext,
      rawItems: [rawItem],
      createdAt: input.createdAt,
      maxItems: input.maxItems ?? 3
    });
    return {
      status: "generated",
      items,
      provider: "none",
      elapsedMs: 0,
      sourceFingerprint: input.sourceFingerprint ?? "fixture_generated"
    };
  }
};

export const fixtureEmotionSignalProvider: EmotionSignalProvider = {
  async analyze() {
    return [];
  }
};

export function createFixtureTranscriptionProvider(segments: TranscriptSegment[]): TranscriptionProvider {
  return {
    async transcribe(input) {
      return segments.map((segment) => ({ ...segment, uploadId: input.uploadId }));
    }
  };
}

export const fixtureReplayProviders = {
  audioInsightProvider: fixtureAudioInsightProvider,
  acousticFeatureExtractor: async (_input: {
    filePath: string;
    segments: TranscriptSegment[];
  }) => [],
  emotionSignalProvider: fixtureEmotionSignalProvider,
  extractionProvider: fixtureExtractionProvider,
  relationshipSignalProvider: fixtureRelationshipSignalProvider,
  memoryRelevanceJudge: fixtureMemoryRelevanceJudge,
  proactiveInsightProvider: fixtureProactiveInsightProvider
};

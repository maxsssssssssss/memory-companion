"use client";

import { type FormEvent, useEffect, useState } from "react";

import { formatTime } from "@/lib/domain/time";
import { replaceSpeakerIdsForUpload, speakerAliasForUpload, type SpeakerAliasLookup } from "@/lib/domain/speaker-aliases";
import type {
  AtmosphereLabel,
  AudioInsight,
  EmotionEvidenceSource,
  EmotionLabel,
  InteractionLabel,
  SceneLabel,
  SemanticSegment,
  ToneLabel,
  TranscriptSegment,
  ValueLabel
} from "@/lib/domain/types";
import { inferSemanticConcept } from "@/lib/processing/semantic-segments";

const sceneLabels: Record<SceneLabel, string> = {
  investor_call: "投资人",
  product_discussion: "产品",
  customer_call: "客户",
  team_management: "团队",
  self_reflection: "复盘",
  low_value_chatter: "闲聊",
  private_content: "私人内容",
  unknown: "未分类"
};

const valueLabels: Record<ValueLabel, string> = {
  commitment: "承诺",
  task: "待办",
  decision: "决策",
  idea: "灵感/想法",
  risk: "风险",
  open_question: "未决问题",
  notable_quote: "重要原话"
};

const toneLabels: Record<ToneLabel, string> = {
  firm: "坚定",
  hesitant: "犹豫",
  explaining: "解释",
  questioning: "追问",
  pushing_back: "反驳",
  comforting: "安抚",
  excited: "兴奋",
  perfunctory: "敷衍",
  playful: "轻松",
  serious: "严肃",
  unknown: "未知"
};

const emotionLabels: Record<EmotionLabel, string> = {
  relaxed: "放松",
  happy: "开心",
  interested: "感兴趣",
  neutral: "中性",
  tense: "紧张",
  anxious: "紧张",
  confused: "困惑",
  dissatisfied: "不满",
  tired: "疲惫",
  unknown: "未知"
};

const interactionLabels: Record<InteractionLabel, string> = {
  agreement: "达成一致",
  disagreement: "分歧",
  follow_up_question: "追问",
  interruption: "打断",
  silence: "沉默",
  topic_shift: "转折",
  tension: "紧张",
  rapport: "默契",
  flirtation_or_testing: "试探",
  decision_moment: "决策时刻",
  unknown: "未知"
};

const atmosphereLabels: Record<AtmosphereLabel, string> = {
  focused: "专注",
  serious: "认真",
  tense: "偏紧",
  warm: "温和",
  playful: "轻松",
  awkward: "尴尬",
  rushed: "赶时间",
  uncertain: "不确定",
  collaborative: "协作",
  conflicted: "有分歧",
  avoidant: "回避",
  unknown: "未知"
};

const emotionEvidenceSourceLabels: Record<EmotionEvidenceSource, string> = {
  transcript: "原文",
  acoustic: "声音",
  llm: "AI",
  user_correction: "用户纠正",
  fusion: "融合"
};

const voiceVolumeLabels: Record<AudioInsight["voice"]["volume"], string> = {
  high: "音量高",
  normal: "音量正常",
  low: "音量低",
  unknown: ""
};

const voicePauseLabels: Record<AudioInsight["voice"]["pause"], string> = {
  many: "停顿多",
  normal: "停顿正常",
  few: "停顿少",
  unknown: ""
};

const titleStopWords = /^(嗯|啊|呃|然后|就是|那个|所以|我觉得|我们先)?/;

const hiddenOnlySceneLabels: SceneLabel[] = ["unknown", "low_value_chatter", "private_content"];

const keywordGroups = {
  meeting: ["会议", "开会", "会面", "沟通", "讨论", "同步", "复盘", "call", "meeting"],
  chatter: ["闲聊", "随便聊", "吃饭", "午饭", "天气", "低价值", "没(?:有)?重要结论"],
  customer: ["客户", "用户", "试用", "反馈", "续费", "合同"],
  investor: ["投资人", "融资", "路演", "股东", "资本"],
  product: ["产品", "功能", "版本", "需求", "体验", "定价"],
  team: ["团队", "招聘", "同事", "绩效", "协作", "王敏", "负责人"],
  decision: ["决定", "确认", "拍板", "取舍", "定下来"],
  task: ["待办", "跟进", "发给", "完成", "推进", "下周", "今天", "今晚"],
  risk: ["风险", "延期", "阻塞", "担心", "问题", "不确定"],
  idea: ["灵感", "想法", "可以试试", "方案", "机会", "假设"],
  business: ["授权", "销售", "目标", "费用", "预算", "收入", "成本"],
  value: ["决策", "承诺"]
};

function keywordPattern(keywords: string[]) {
  return new RegExp(keywords.join("|"), "i");
}

const inferredTagRules: { label: string; pattern: RegExp }[] = [
  { label: "会议", pattern: keywordPattern(keywordGroups.meeting) },
  { label: "闲聊", pattern: keywordPattern(keywordGroups.chatter) },
  { label: "客户", pattern: keywordPattern(keywordGroups.customer) },
  { label: "投资人", pattern: keywordPattern(keywordGroups.investor) },
  { label: "产品", pattern: keywordPattern(keywordGroups.product) },
  { label: "团队", pattern: keywordPattern(keywordGroups.team) },
  { label: "决策", pattern: keywordPattern(keywordGroups.decision) },
  { label: "任务", pattern: keywordPattern(keywordGroups.task) },
  { label: "风险", pattern: keywordPattern(keywordGroups.risk) },
  { label: "灵感/想法", pattern: keywordPattern(keywordGroups.idea) }
];

const valuableTextPattern = keywordPattern([
  ...keywordGroups.meeting.filter((keyword) => keyword !== "call" && keyword !== "meeting"),
  ...keywordGroups.customer.filter((keyword) => keyword !== "试用"),
  ...keywordGroups.product.filter((keyword) => keyword !== "版本" && keyword !== "体验"),
  ...keywordGroups.team.filter((keyword) => keyword !== "同事" && keyword !== "王敏"),
  ...keywordGroups.investor.filter((keyword) => keyword !== "路演" && keyword !== "股东" && keyword !== "资本"),
  "风险",
  "延期",
  "阻塞",
  "问题",
  "待办",
  "跟进",
  "推进",
  "决定",
  "确认",
  ...keywordGroups.value,
  "灵感",
  "想法",
  "方案",
  "机会",
  "假设",
  "授权",
  "销售",
  "目标",
  "费用"
]);

const concreteBusinessTextPattern = keywordPattern([
  ...keywordGroups.customer.filter((keyword) => keyword !== "试用"),
  ...keywordGroups.product.filter((keyword) => keyword !== "版本" && keyword !== "体验"),
  ...keywordGroups.team.filter((keyword) => keyword !== "同事" && keyword !== "王敏"),
  ...keywordGroups.investor.filter((keyword) => keyword !== "路演" && keyword !== "股东" && keyword !== "资本"),
  "风险",
  "延期",
  "阻塞",
  "问题",
  "方案",
  "机会",
  ...keywordGroups.business
]);

const strongValueLabels: ValueLabel[] = ["commitment", "decision", "risk", "open_question", "notable_quote"];
const broadValueLabels: ValueLabel[] = ["task", "idea"];
const maxTimelineTags = 6;
const maxInsightLabelsPerChip = 2;

const timelineTagPriority: Record<string, number> = {
  承诺: 100,
  待办: 95,
  任务: 95,
  决策: 90,
  未决问题: 85,
  风险: 80,
  重要原话: 75,
  客户: 70,
  投资人: 68,
  产品: 66,
  团队: 64,
  硬件: 62,
  软件: 60,
  商业: 58,
  生态: 56,
  会议: 54,
  "灵感/想法": 52,
  复盘: 46,
  闲聊: 20,
  私人内容: 10,
  未分类: 0
};

const tonePriority: Record<ToneLabel, number> = {
  pushing_back: 100,
  hesitant: 92,
  questioning: 90,
  excited: 82,
  perfunctory: 78,
  comforting: 74,
  playful: 72,
  firm: 58,
  serious: 52,
  explaining: 36,
  unknown: 0
};

const emotionPriority: Record<EmotionLabel, number> = {
  dissatisfied: 100,
  anxious: 94,
  tense: 92,
  confused: 86,
  tired: 76,
  happy: 72,
  interested: 64,
  relaxed: 58,
  neutral: 0,
  unknown: 0
};

const interactionPriority: Record<InteractionLabel, number> = {
  tension: 100,
  disagreement: 96,
  follow_up_question: 90,
  interruption: 84,
  flirtation_or_testing: 78,
  decision_moment: 76,
  rapport: 70,
  agreement: 58,
  topic_shift: 52,
  silence: 46,
  unknown: 0
};

const atmospherePriority: Record<AtmosphereLabel, number> = {
  tense: 100,
  conflicted: 96,
  awkward: 90,
  avoidant: 86,
  uncertain: 80,
  rushed: 76,
  collaborative: 70,
  warm: 66,
  playful: 62,
  serious: 58,
  focused: 54,
  unknown: 0
};

const lowInformationPatterns = [
  /^(我们是)?其实想表达意思[。？?]?$/,
  /^我们想还能表达意思就是说[。？?]?$/,
  /^难道.*不清楚.*[吗嘛][。？?]?$/,
  /^这些细节.*都要对的?[。？?]?$/,
  /^所以?其实也是想把这个[。？?]?$/,
  /^这个还能分场景[吗嘛][。？?]?$/,
  /^还能分.*还能分.*[啊呀吗嘛][。？?]?$/,
  /^这扯淡的?[。？?]?$/,
  /^(嗯|啊|呃|那个|这个|就是|然后|所以|其实|可能|反正|对吧|是吧)[，,。？?！!]*$/,
  /^(对|好|行|可以|不是|没有|知道|明白|清楚)[的了啊呀吗嘛吧，,。？?！!]*$/
];

type TimelineProps = {
  segments: TranscriptSegment[];
  audioInsights?: AudioInsight[];
  semanticSegments?: SemanticSegment[];
  preferSemanticSegments?: boolean;
  speakerAliasesByUploadId?: SpeakerAliasLookup;
  onSaveAudioInsightCorrection?: (input: {
    uploadId: string;
    insightId: string;
    correction: {
      labelCorrections: Array<{ from: string; to: string }>;
      note?: string;
    };
  }) => Promise<void>;
};

type TimelineEntry = TranscriptSegment | SemanticSegment;

function formatDuration(startSeconds: number, endSeconds: number) {
  const minutes = Math.max(1, Math.round((endSeconds - startSeconds) / 60));
  return `~${minutes} min`;
}

function timelineClass(segment: TimelineEntry) {
  if (segment.valueLabels.some((label) => label === "commitment" || label === "task")) {
    return "promise-mark";
  }

  if (segment.sceneLabels.some((label) => label === "investor_call" || label === "product_discussion" || label === "team_management")) {
    return "meeting";
  }

  return "";
}

function cleanTitleText(text: string) {
  return text.replace(/\s+/g, " ").trim().replace(titleStopWords, "").trim();
}

function shortenTitle(text: string) {
  const cleanText = cleanTitleText(text);
  const clauses = cleanText.split(/[，。！？；,.!?;]/).map((clause) => clause.trim()).filter(Boolean);
  const title = clauses.find((clause) => clause.length >= 6) ?? clauses[0] ?? cleanText;

  return title.length > 18 ? `${title.slice(0, 18)}...` : title;
}

function segmentTitle(segment: TranscriptSegment) {
  const title = shortenTitle(segment.text);

  if (title) {
    return segment.speaker ? `${segment.speaker}：${title}` : title;
  }

  const primaryLabel = [...segment.valueLabels.map((label) => valueLabels[label]), ...segment.sceneLabels.filter((label) => label !== "unknown").map((label) => sceneLabels[label])][0];

  return primaryLabel ? `${primaryLabel}片段` : "录音片段";
}

function uniqueTags(tags: string[]) {
  return [...new Set(tags.filter(Boolean))];
}

function selectTimelineTags(tags: string[]) {
  return uniqueTags(tags)
    .map((label, index) => ({ label, index, priority: timelineTagPriority[label] ?? 40 }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .slice(0, maxTimelineTags)
    .map((tag) => tag.label);
}

function inferredTags(segment: TranscriptSegment) {
  const baseTags = uniqueTags([
    ...segment.sceneLabels.filter((label) => label !== "unknown").map((label) => sceneLabels[label]),
    ...segment.valueLabels.map((label) => valueLabels[label])
  ]);
  const inferredTags = inferredTagRules.filter((rule) => rule.pattern.test(segment.text)).map((rule) => rule.label);

  if (segment.sceneLabels.some((label) => label === "customer_call" || label === "investor_call" || label === "product_discussion" || label === "team_management")) {
    inferredTags.unshift("会议");
  }

  return uniqueTags([...baseTags, ...inferredTags]);
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, "").trim();
}

function hasBusinessScene(segment: TranscriptSegment) {
  return segment.sceneLabels.some((label) => !hiddenOnlySceneLabels.includes(label));
}

function hasValueLabel(segment: TranscriptSegment, labels: ValueLabel[]) {
  return segment.valueLabels.some((label) => labels.includes(label));
}

function isPrivateSegment(segment: TranscriptSegment) {
  return segment.sceneLabels.includes("private_content");
}

function isLowInformationText(text: string) {
  const normalizedText = normalizeText(text);

  if (!normalizedText) {
    return true;
  }

  return normalizedText.length <= 18 && lowInformationPatterns.some((pattern) => pattern.test(normalizedText));
}

function hasSpecificBroadValueContext(segment: TranscriptSegment) {
  const normalizedText = normalizeText(segment.text);

  return concreteBusinessTextPattern.test(segment.text) || (normalizedText.length >= 24 && !isLowInformationText(segment.text));
}

function isValuableTimelineSegment(segment: TranscriptSegment) {
  if (isPrivateSegment(segment)) {
    return false;
  }

  if (hasValueLabel(segment, strongValueLabels)) {
    return true;
  }

  if (isLowInformationText(segment.text)) {
    return false;
  }

  if (hasBusinessScene(segment)) {
    return true;
  }

  if (hasValueLabel(segment, broadValueLabels)) {
    return hasSpecificBroadValueContext(segment);
  }

  if (valuableTextPattern.test(segment.text)) {
    return true;
  }

  return normalizeText(segment.text).length >= 36 && !isLowInformationText(segment.text);
}

function isSemanticSegment(segment: TimelineEntry): segment is SemanticSegment {
  return "sourceSegmentIds" in segment && "summary" in segment;
}

function semanticEvidenceText(segment: SemanticSegment, sourceSegments: TranscriptSegment[]) {
  return [segment.title, segment.summary, segment.transcriptExcerpt, ...sourceSegments.map((sourceSegment) => sourceSegment.text)]
    .filter(Boolean)
    .join(" ");
}

function sourceStartsWithTitle(segment: SemanticSegment) {
  const title = normalizeText(segment.title).slice(0, 12);
  const excerpt = normalizeText(segment.transcriptExcerpt);

  return title.length >= 8 && excerpt.startsWith(title);
}

function shouldRepairSemanticDisplay(segment: SemanticSegment, sourceSegments: TranscriptSegment[]) {
  const concept = inferSemanticConcept(semanticEvidenceText(segment, sourceSegments));

  if (!concept) {
    return false;
  }

  return segment.tags.length === 0 || /…|\.\.\./.test(segment.title) || sourceStartsWithTitle(segment);
}

function timelineEntryTitle(segment: TimelineEntry, sourceSegments: TranscriptSegment[] = []) {
  if (!isSemanticSegment(segment)) {
    return segmentTitle(segment);
  }

  if (shouldRepairSemanticDisplay(segment, sourceSegments)) {
    return inferSemanticConcept(semanticEvidenceText(segment, sourceSegments))?.title ?? segment.title;
  }

  return segment.title;
}

function timelineEntryTags(segment: TimelineEntry, sourceSegments: TranscriptSegment[] = []) {
  if (!isSemanticSegment(segment)) {
    return selectTimelineTags(inferredTags(segment));
  }

  if (shouldRepairSemanticDisplay(segment, sourceSegments)) {
    const conceptTags = inferSemanticConcept(semanticEvidenceText(segment, sourceSegments))?.tags ?? [];
    return selectTimelineTags([...conceptTags, ...segment.tags]);
  }

  return selectTimelineTags(segment.tags);
}

function timelineEntrySummary(segment: TimelineEntry, sourceSegments: TranscriptSegment[] = []) {
  if (!isSemanticSegment(segment)) {
    return segment.text;
  }

  if (shouldRepairSemanticDisplay(segment, sourceSegments)) {
    return inferSemanticConcept(semanticEvidenceText(segment, sourceSegments))?.summary ?? segment.summary;
  }

  return segment.summary;
}

function timelineEntryExcerpt(segment: TimelineEntry) {
  return isSemanticSegment(segment) ? segment.transcriptExcerpt : segment.text;
}

function timelineEntrySourceIds(segment: TimelineEntry) {
  return isSemanticSegment(segment) ? segment.sourceSegmentIds : [segment.id];
}

function timelineEntrySourceRange(segment: TimelineEntry) {
  return isSemanticSegment(segment) ? segment.sourceTimeRange : segment;
}

function tagClassName(label: string) {
  const tagTypeByLabel: Record<string, string> = {
    会议: "meeting",
    客户: "customer",
    投资人: "investor",
    产品: "product",
    团队: "team",
    任务: "task",
    待办: "task",
    承诺: "task",
    决策: "decision",
    风险: "risk",
    未决问题: "risk",
    "灵感/想法": "idea",
    复盘: "reflection",
    商业: "business",
    硬件: "product",
    软件: "business",
    生态: "business",
    闲聊: "chatter",
    私人内容: "private"
  };
  const tagType = tagTypeByLabel[label] ?? "default";

  return `chip tag tag-${tagType}`;
}

function insightTagClassName(kind: "tone" | "emotion" | "interaction" | "sound" | "atmosphere") {
  return `chip tag tag-${kind}`;
}

function sourceSegmentsForEntry(segment: TimelineEntry, segmentById: Map<string, TranscriptSegment>) {
  if (!isSemanticSegment(segment)) {
    return [];
  }

  return segment.sourceSegmentIds
    .map((sourceSegmentId) => segmentById.get(sourceSegmentId))
    .filter((sourceSegment): sourceSegment is TranscriptSegment => sourceSegment !== undefined);
}

function sourceInsightsForEntry(segment: TimelineEntry, insightBySegmentId: Map<string, AudioInsight[]>) {
  return timelineEntrySourceIds(segment).flatMap((sourceSegmentId) => insightBySegmentId.get(sourceSegmentId) ?? []);
}

function rankedInsightLabels<T extends string>(
  labels: T[],
  options: {
    labelMap: Record<T, string>;
    priorityMap: Record<T, number>;
    minimumPriority: number;
  }
) {
  const counts = new Map<T, number>();
  labels.forEach((label) => {
    if ((options.priorityMap[label] ?? 0) <= 0) {
      return;
    }

    counts.set(label, (counts.get(label) ?? 0) + 1);
  });

  const ranked = [...counts.entries()]
    .map(([label, count]) => ({
      label,
      count,
      text: options.labelMap[label],
      priority: options.priorityMap[label] ?? 0
    }))
    .sort((a, b) => b.priority - a.priority || b.count - a.count || a.text.localeCompare(b.text, "zh-Hans-CN"));

  const highSignalLabels = ranked.filter((label) => label.priority >= options.minimumPriority);
  return highSignalLabels.length > 0 ? highSignalLabels : ranked;
}

function insightSummaryTag<T extends string>(
  prefix: string,
  rankedLabels: { text: string }[],
  kind: "tone" | "emotion" | "interaction" | "atmosphere"
) {
  if (rankedLabels.length === 0) {
    return null;
  }

  return {
    label: `${prefix}: ${rankedLabels
      .slice(0, maxInsightLabelsPerChip)
      .map((label) => label.text)
      .join("、")}`,
    kind
  };
}

function soundSummaryTag(insights: AudioInsight[]) {
  const labels: string[] = [];
  const volume = insights.map((insight) => insight.voice.volume).find((item) => item !== "unknown");
  const pause = insights.map((insight) => insight.voice.pause).find((item) => item !== "unknown");

  if (volume) {
    labels.push(voiceVolumeLabels[volume]);
  }
  if (pause) {
    labels.push(voicePauseLabels[pause]);
  }
  if (insights.some((insight) => insight.voice.overlap)) {
    labels.push("多人重叠");
  }

  const visibleLabels = labels.filter(Boolean);
  if (visibleLabels.length === 0) {
    return null;
  }

  return {
    label: `声音: ${visibleLabels.join("、")}`,
    kind: "sound" as const
  };
}

function uniqueInsightTags(insights: AudioInsight[]) {
  return [
    soundSummaryTag(insights),
    insightSummaryTag(
      "气氛",
      rankedInsightLabels(insights.flatMap((insight) => insight.atmosphereLabels ?? []), {
        labelMap: atmosphereLabels,
        priorityMap: atmospherePriority,
        minimumPriority: 54
      }),
      "atmosphere"
    ),
    insightSummaryTag(
      "语气",
      rankedInsightLabels(insights.flatMap((insight) => insight.toneLabels), {
        labelMap: toneLabels,
        priorityMap: tonePriority,
        minimumPriority: 70
      }),
      "tone"
    ),
    insightSummaryTag(
      "情绪",
      rankedInsightLabels(insights.flatMap((insight) => insight.emotionLabels), {
        labelMap: emotionLabels,
        priorityMap: emotionPriority,
        minimumPriority: 58
      }),
      "emotion"
    ),
    insightSummaryTag(
      "互动",
      rankedInsightLabels(insights.flatMap((insight) => insight.interactionLabels), {
        labelMap: interactionLabels,
        priorityMap: interactionPriority,
        minimumPriority: 70
      }),
      "interaction"
    )
  ].filter((tag): tag is { label: string; kind: "tone" | "emotion" | "interaction" | "sound" | "atmosphere" } => tag !== null);
}

function userCorrectionLines(insight: AudioInsight) {
  return (insight.userCorrections ?? []).flatMap((correction) => {
    const labels = correction.labelCorrections.map((item) => `${item.from} -> ${item.to}`);
    return [labels.length > 0 ? labels.join("；") : "", correction.note ?? ""].filter(Boolean);
  });
}

function VoiceExplanationList({ insight }: { insight: AudioInsight }) {
  const explanations = insight.voice.explanations ?? [];
  const corrections = userCorrectionLines(insight);

  if (explanations.length === 0 && corrections.length === 0) {
    return null;
  }

  return (
    <div className="voice-explain">
      {explanations.length > 0 ? (
        <>
          <p className="voice-explain-title">声音依据</p>
          <ul>
            {explanations.map((explanation) => (
              <li key={`${insight.id}-${explanation.kind}-${explanation.label}`}>
                <b>{explanation.label}</b>
                <span>{explanation.detail}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {corrections.length > 0 ? (
        <div className="user-corrections">
          <p className="voice-explain-title">用户纠正</p>
          {corrections.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EmotionEvidenceList({
  insight,
  speakerAliasesByUploadId
}: {
  insight: AudioInsight;
  speakerAliasesByUploadId: SpeakerAliasLookup;
}) {
  const evidence = insight.emotionEvidence ?? [];

  if (evidence.length === 0) {
    return null;
  }

  return (
    <details className="emotion-evidence-list">
      <summary>气氛证据 {evidence.length} 条</summary>
      <p className="emotion-evidence-note">仅作复盘线索，需要和原文一起看，不代表心理诊断。</p>
      <ul>
        {evidence.slice(0, 6).map((item) => {
          const featureLabels = [...new Set((item.features ?? []).map((feature) => feature.label).filter(Boolean))].slice(0, 5);

          return (
            <li key={item.id}>
              <div className="emotion-evidence-head">
                <b>{item.label}</b>
                <span>
                  {emotionEvidenceSourceLabels[item.source]} · {Math.round(item.confidence * 100)}%
                </span>
              </div>
              <p>{replaceSpeakerIdsForUpload(insight.uploadId, item.detail, speakerAliasesByUploadId)}</p>
              {featureLabels.length > 0 ? (
                <div className="emotion-evidence-features">
                  {featureLabels.map((label) => (
                    <span key={label}>{label}</span>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function AudioInsightCorrectionForm({
  insight,
  onSave
}: {
  insight: AudioInsight;
  onSave?: TimelineProps["onSaveAudioInsightCorrection"];
}) {
  const [fromLabel, setFromLabel] = useState("");
  const [toLabel, setToLabel] = useState("");
  const [note, setNote] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    setFromLabel("");
    setToLabel("");
    setNote("");
    setSaveState("idle");
  }, [insight.id]);

  if (!onSave) {
    return null;
  }

  async function submitCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!onSave) {
      return;
    }

    const from = fromLabel.trim();
    const to = toLabel.trim();
    const trimmedNote = note.trim();

    if ((!from || !to) && !trimmedNote) {
      setSaveState("error");
      return;
    }

    setSaveState("saving");
    try {
      await onSave({
        uploadId: insight.uploadId,
        insightId: insight.id,
        correction: {
          labelCorrections: from && to ? [{ from, to }] : [],
          ...(trimmedNote ? { note: trimmedNote } : {})
        }
      });
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  return (
    <form className="insight-correction-form" onSubmit={submitCorrection}>
      <p className="voice-explain-title">纠正这条判断</p>
      <div className="insight-correction-row">
        <label>
          <span>原判断</span>
          <input value={fromLabel} onChange={(event) => setFromLabel(event.target.value)} placeholder="例如 紧张" aria-label="原判断" />
        </label>
        <label>
          <span>改成</span>
          <input value={toLabel} onChange={(event) => setToLabel(event.target.value)} placeholder="例如 认真" aria-label="改成" />
        </label>
      </div>
      <label className="insight-correction-note">
        <span>补充说明</span>
        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="可选，说明你为什么这么改" aria-label="补充说明" />
      </label>
      <div className="insight-correction-actions">
        <button type="submit" className="ghost-button" disabled={saveState === "saving"}>
          {saveState === "saving" ? "保存中" : "保存纠正"}
        </button>
        {saveState === "saved" ? <span>已保存</span> : null}
        {saveState === "error" ? <span className="form-error">请填写纠正内容</span> : null}
      </div>
    </form>
  );
}

export function Timeline({
  segments,
  audioInsights = [],
  semanticSegments = [],
  preferSemanticSegments = false,
  speakerAliasesByUploadId = {},
  onSaveAudioInsightCorrection
}: TimelineProps) {
  const sortedSegments = [...segments].sort((a, b) => a.startSeconds - b.startSeconds);
  const segmentById = new Map(sortedSegments.map((segment) => [segment.id, segment]));
  const insightBySegmentId = new Map<string, AudioInsight[]>();
  audioInsights.forEach((insight) => {
    insight.sourceSegmentIds.forEach((sourceSegmentId) => {
      insightBySegmentId.set(sourceSegmentId, [...(insightBySegmentId.get(sourceSegmentId) ?? []), insight]);
    });
  });
  const sortedSemanticSegments = [...semanticSegments].sort((a, b) => a.startSeconds - b.startSeconds);
  const useSemanticSegments = preferSemanticSegments || sortedSemanticSegments.length > 0;
  const visibleSegments: TimelineEntry[] = useSemanticSegments ? sortedSemanticSegments : sortedSegments.filter(isValuableTimelineSegment);
  const hiddenSegmentCount = useSemanticSegments
    ? Math.max(sortedSegments.length - visibleSegments.reduce((count, segment) => count + timelineEntrySourceIds(segment).length, 0), 0)
    : sortedSegments.length - visibleSegments.length;
  const hasRawSegments = sortedSegments.length > 0;
  const timelineUnitLabel = useSemanticSegments ? "语义段落" : "关键片段";

  return (
    <div className="wrap timeline-wrap">
      <header className="masthead anim">
        <div className="kicker">
          时间轴 · TIMELINE
          <div className="rule" />
        </div>
        <h1>
          你的一天，<span className="accent-word">按时间</span>展开。
        </h1>
        <div className="meta-row">
          <span className="m">点击任意{timelineUnitLabel}查看原文转录与来源详情</span>
          <span className="sep" />
          {useSemanticSegments ? (
            <span className="m">
              展示 <b>{visibleSegments.length}</b> 个语义段落 / 已合并或隐藏 <b>{hiddenSegmentCount}</b> 个原始片段
            </span>
          ) : (
            <span className="m">
              展示 <b>{visibleSegments.length}</b> 个关键片段 / 已隐藏 <b>{hiddenSegmentCount}</b> 个低信息片段
            </span>
          )}
          {visibleSegments.length > 0 ? (
            <>
              <span className="sep" />
              <span className="m">
                覆盖 {formatTime(visibleSegments[0].startSeconds)}-{formatTime(visibleSegments[visibleSegments.length - 1].endSeconds)}
              </span>
            </>
          ) : null}
        </div>
      </header>

      {visibleSegments.length > 0 ? (
        <div className="tl anim">
          {visibleSegments.map((segment) => {
            const sourceSegments = sourceSegmentsForEntry(segment, segmentById);
            const sourceInsights = sourceInsightsForEntry(segment, insightBySegmentId);
            const title = timelineEntryTitle(segment, sourceSegments);
            const sourceRange = timelineEntrySourceRange(segment);
            const timeLabel = isSemanticSegment(segment) ? "段落" : segment.speaker ?? "片段";
            const summaryLabel = useSemanticSegments ? `${title} 语义段落摘要` : `${title} 片段摘要`;

            return (
              <details key={segment.id} className={`tl-item ${timelineClass(segment)}`}>
                <summary className="tl-summary">
                  <span className="tl-time">
                    {formatTime(segment.startSeconds)}
                    <span>{timeLabel}</span>
                  </span>
                  <span className="tl-node" aria-hidden="true" />
                  <span className="tl-card" role="group" aria-label={summaryLabel}>
                    <span className="th">
                      <span className="tt">{title}</span>
                      <span className="dur">{formatDuration(segment.startSeconds, segment.endSeconds)}</span>
                    </span>
                    <span className="tl-tags">
                      {timelineEntryTags(segment, sourceSegments).map((label) => (
                        <span key={label} className={tagClassName(label)}>
                          {label}
                        </span>
                      ))}
                      {uniqueInsightTags(sourceInsights).map((tag) => (
                        <span key={`${tag.kind}-${tag.label}`} className={insightTagClassName(tag.kind)}>
                          {tag.label}
                        </span>
                      ))}
                    </span>
                    <span className="tl-sum">{timelineEntrySummary(segment, sourceSegments)}</span>
                  </span>
                </summary>
                <div className="tl-detail">
                  <div className="dline" />
                  <p className="dk">
                    {useSemanticSegments ? "语义段落证据" : "原文转录"} · {formatTime(sourceRange.startSeconds)}
                  </p>
                  <blockquote className="tl-quote">
                    {"speaker" in segment && segment.speaker ? <span className="sp">{segment.speaker}</span> : null}
                    {timelineEntryExcerpt(segment)}
                  </blockquote>
                  <ul className="tl-points">
                    <li>
                      来源范围：{formatTime(sourceRange.startSeconds)}-{formatTime(sourceRange.endSeconds)}
                    </li>
                    <li>识别置信度：{Math.round(segment.confidence * 100)}%</li>
                    {useSemanticSegments ? <li>证据片段：{timelineEntrySourceIds(segment).length} 段原始转写</li> : null}
                  </ul>
                  {sourceInsights.length > 0 ? (
                    <div className="source-transcript audio-insights">
                      <p className="dk">语气/互动线索</p>
                      <ol>
                        {sourceInsights.map((insight) => (
                          <li key={insight.id}>
                            <span>
                              {formatTime(insight.sourceTimeRange.startSeconds)}-{formatTime(insight.sourceTimeRange.endSeconds)}
                            </span>
                            <p>
                              <b>{speakerAliasForUpload(insight.uploadId, insight.speaker.id, speakerAliasesByUploadId) ?? insight.speaker.displayName ?? insight.speaker.id}</b>：
                              {replaceSpeakerIdsForUpload(insight.uploadId, insight.summary, speakerAliasesByUploadId)}
                              <br />
                              {replaceSpeakerIdsForUpload(insight.uploadId, insight.evidence, speakerAliasesByUploadId)}
                            </p>
                            <VoiceExplanationList insight={insight} />
                            <EmotionEvidenceList insight={insight} speakerAliasesByUploadId={speakerAliasesByUploadId} />
                            <AudioInsightCorrectionForm insight={insight} onSave={onSaveAudioInsightCorrection} />
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : null}
                  {useSemanticSegments && sourceSegments.length > 0 ? (
                    <details className="source-transcript">
                      <summary>查看 {sourceSegments.length} 段原始转写</summary>
                      <ol>
                        {sourceSegments.map((sourceSegment) => (
                          <li key={sourceSegment.id}>
                            <span>
                              {formatTime(sourceSegment.startSeconds)}-{formatTime(sourceSegment.endSeconds)}
                            </span>
                            <p>{sourceSegment.text}</p>
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : null}
                </div>
              </details>
            );
          })}
        </div>
      ) : (
        <section className="empty-workspace compact-empty">
          <div className="empty-mark">线</div>
          <p className="kicker-line">时间轴 · TIMELINE</p>
          <h1>{hasRawSegments ? "本次没有足够有价值的时间轴内容。" : "录音转写完成后会展示语义时间线。"}</h1>
        </section>
      )}
    </div>
  );
}

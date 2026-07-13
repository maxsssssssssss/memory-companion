import type {
  AudioInsight,
  EmotionLabel,
  InteractionLabel,
  SpeakerRole,
  ToneLabel,
  TranscriptSegment,
  VoicePace
} from "@/lib/domain/types";

const QUESTION_PATTERN = /[?？]|吗|么|是不是|是否|能不能|有没有|为什么|怎么|如何/;
const FIRM_PATTERN = /必须|一定|马上|直接|确认|确定|决定|拍板|不能|不可以|不行/;
const HESITANT_PATTERN = /可能|也许|好像|应该|我觉得|不确定|再看看|试试看|是不是/;
const EXPLAINING_PATTERN = /因为|所以|也就是说|其实|比如|举例|原因|逻辑|意味着/;
const PUSHING_BACK_PATTERN = /但是|不过|不对|不同意|问题是|风险|担心|阻塞|扯淡/;
const COMFORTING_PATTERN = /没关系|别担心|不用急|慢慢来|可以理解|辛苦了/;
const EXCITED_PATTERN = /太好了|很棒|非常好|特别好|兴奋|开心|喜欢|期待/;
const PERFUNCTORY_PATTERN = /随便|都行|无所谓|还好吧|就这样|算了/;
const PLAYFUL_PATTERN = /哈哈|嘿嘿|开玩笑|好玩|有意思/;
const SERIOUS_PATTERN = /风险|决策|合同|预算|授权|交付|延期|成本|收入|目标/;

const ANXIOUS_PATTERN = /焦虑|担心|压力|害怕|怕|风险|阻塞|延期|来不及/;
const CONFUSED_PATTERN = /不清楚|不知道|困惑|没想明白|为什么|怎么会/;
const DISSATISFIED_PATTERN = /不满|失望|糟糕|不行|扯淡|离谱|不接受/;
const TIRED_PATTERN = /累|疲惫|困|撑不住|没精神/;
const HAPPY_PATTERN = /开心|高兴|太好了|很棒|喜欢|期待/;
const INTERESTED_PATTERN = /想了解|有意思|感兴趣|能不能|有没有|如何|为什么/;
const RELAXED_PATTERN = /轻松|舒服|没关系|慢慢来|不着急/;

const AGREEMENT_PATTERN = /同意|可以|没问题|确认|就这么定|认可|好的/;
const DISAGREEMENT_PATTERN = /不同意|不对|不行|不能接受|但是|不过|问题是/;
const TOPIC_SHIFT_PATTERN = /另外|接下来|换个话题|还有一个|再说|回到/;
const RAPPORT_PATTERN = /哈哈|开心|喜欢|默契|聊得挺好|舒服/;
const FLIRTATION_PATTERN = /约会|暧昧|喜欢你|想见|有感觉|试探/;
const SILENCE_PATTERN = /沉默|停顿|没人说话|冷场/;
const INTERRUPTION_PATTERN = /打断|插一句|等一下|先别/;

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function compactText(text: string, maxLength = 120) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function effectiveTextLength(text: string) {
  return text.replace(/\s/g, "").length;
}

function inferSpeakerRole(segment: TranscriptSegment): { role: SpeakerRole; displayName?: string; confidence: number } {
  const text = segment.text;

  if (/我|我们/.test(text)) {
    return { role: "self", displayName: "我", confidence: 0.62 };
  }

  if (/你|您|对方/.test(text)) {
    return { role: "other", displayName: "对方", confidence: 0.5 };
  }

  if (/客户|用户|甲方/.test(text)) {
    return { role: "customer", displayName: "客户", confidence: 0.55 };
  }

  if (/老师|课程|课堂|讲师/.test(text)) {
    return { role: "teacher", displayName: "老师", confidence: 0.52 };
  }

  if (/团队|同事|负责人|老板|员工/.test(text)) {
    return { role: "teammate", displayName: "同事", confidence: 0.5 };
  }

  return { role: "unknown", confidence: segment.speaker ? 0.45 : 0.25 };
}

function inferPace(segment: TranscriptSegment): VoicePace {
  const duration = Math.max(1, segment.endSeconds - segment.startSeconds);
  const charsPerSecond = effectiveTextLength(segment.text) / duration;

  if (charsPerSecond >= 3.2) {
    return "fast";
  }

  if (charsPerSecond <= 0.9) {
    return "slow";
  }

  return "normal";
}

function inferToneLabels(segment: TranscriptSegment): ToneLabel[] {
  const text = segment.text;
  const labels: ToneLabel[] = [];

  if (FIRM_PATTERN.test(text) || segment.valueLabels.includes("decision")) labels.push("firm");
  if (HESITANT_PATTERN.test(text)) labels.push("hesitant");
  if (EXPLAINING_PATTERN.test(text)) labels.push("explaining");
  if (QUESTION_PATTERN.test(text) || segment.valueLabels.includes("open_question")) labels.push("questioning");
  if (PUSHING_BACK_PATTERN.test(text) || segment.valueLabels.includes("risk")) labels.push("pushing_back");
  if (COMFORTING_PATTERN.test(text)) labels.push("comforting");
  if (EXCITED_PATTERN.test(text)) labels.push("excited");
  if (PERFUNCTORY_PATTERN.test(text)) labels.push("perfunctory");
  if (PLAYFUL_PATTERN.test(text)) labels.push("playful");
  if (SERIOUS_PATTERN.test(text)) labels.push("serious");

  return unique(labels).length > 0 ? unique(labels) : ["unknown"];
}

function inferEmotionLabels(segment: TranscriptSegment): EmotionLabel[] {
  const text = segment.text;
  const labels: EmotionLabel[] = [];

  if (RELAXED_PATTERN.test(text)) labels.push("relaxed");
  if (HAPPY_PATTERN.test(text)) labels.push("happy");
  if (INTERESTED_PATTERN.test(text)) labels.push("interested");
  if (ANXIOUS_PATTERN.test(text) || segment.valueLabels.includes("risk")) labels.push("anxious");
  if (CONFUSED_PATTERN.test(text)) labels.push("confused");
  if (DISSATISFIED_PATTERN.test(text)) labels.push("dissatisfied");
  if (TIRED_PATTERN.test(text)) labels.push("tired");

  return unique(labels).length > 0 ? unique(labels) : ["neutral"];
}

function inferInteractionLabels(segment: TranscriptSegment, toneLabels: ToneLabel[]): InteractionLabel[] {
  const text = segment.text;
  const labels: InteractionLabel[] = [];

  if (AGREEMENT_PATTERN.test(text) || segment.valueLabels.includes("decision")) labels.push("agreement");
  if (DISAGREEMENT_PATTERN.test(text) || toneLabels.includes("pushing_back")) labels.push("disagreement");
  if (QUESTION_PATTERN.test(text) || segment.valueLabels.includes("open_question")) labels.push("follow_up_question");
  if (INTERRUPTION_PATTERN.test(text)) labels.push("interruption");
  if (SILENCE_PATTERN.test(text)) labels.push("silence");
  if (TOPIC_SHIFT_PATTERN.test(text)) labels.push("topic_shift");
  if (segment.valueLabels.includes("risk") || toneLabels.includes("pushing_back")) labels.push("tension");
  if (RAPPORT_PATTERN.test(text)) labels.push("rapport");
  if (FLIRTATION_PATTERN.test(text)) labels.push("flirtation_or_testing");
  if (segment.valueLabels.includes("decision")) labels.push("decision_moment");

  return unique(labels).length > 0 ? unique(labels) : ["unknown"];
}

function insightSummary(input: {
  toneLabels: ToneLabel[];
  emotionLabels: EmotionLabel[];
  interactionLabels: InteractionLabel[];
}) {
  if (input.toneLabels.includes("hesitant") && input.toneLabels.includes("questioning")) {
    return "说话人以试探方式提出问题或风险确认。";
  }

  if (input.interactionLabels.includes("decision_moment")) {
    return "这一段出现明确的确认或决策信号。";
  }

  if (input.interactionLabels.includes("tension")) {
    return "这一段存在风险、分歧或紧张信号。";
  }

  if (input.emotionLabels.includes("happy") || input.toneLabels.includes("excited")) {
    return "这一段表达更积极，带有兴趣或兴奋迹象。";
  }

  if (input.toneLabels.includes("explaining")) {
    return "这一段主要是在解释背景、原因或逻辑。";
  }

  return "这一段没有明显强烈语气，先按中性互动信号保存。";
}

function insightEvidence(segment: TranscriptSegment, labels: string[]) {
  const labelText = labels.filter((label) => label !== "unknown" && label !== "neutral").join("、") || "中性";
  return `原文：“${compactText(segment.text)}”。判断依据：文本中出现的表达更接近「${labelText}」。`;
}

function confidenceFor(input: {
  segment: TranscriptSegment;
  toneLabels: ToneLabel[];
  emotionLabels: EmotionLabel[];
  interactionLabels: InteractionLabel[];
}) {
  const signalCount = [
    ...input.toneLabels.filter((label) => label !== "unknown"),
    ...input.emotionLabels.filter((label) => label !== "neutral" && label !== "unknown"),
    ...input.interactionLabels.filter((label) => label !== "unknown")
  ].length;
  const signalConfidence = Math.min(0.28, signalCount * 0.04);

  return Math.min(0.82, Math.max(0.35, input.segment.confidence * 0.45 + signalConfidence));
}

export function buildAudioInsights(uploadId: string, segments: TranscriptSegment[]): AudioInsight[] {
  return [...segments]
    .sort((left, right) => left.startSeconds - right.startSeconds)
    .filter((segment) => segment.text.trim().length > 0)
    .map((segment, index) => {
      const speakerRole = inferSpeakerRole(segment);
      const toneLabels = inferToneLabels(segment);
      const emotionLabels = inferEmotionLabels(segment);
      const interactionLabels = inferInteractionLabels(segment, toneLabels);
      const allLabels = [...toneLabels, ...emotionLabels, ...interactionLabels];

      return {
        id: `insight_${uploadId}_${index + 1}`,
        uploadId,
        sourceSegmentIds: [segment.id],
        sourceTimeRange: {
          startSeconds: segment.startSeconds,
          endSeconds: segment.endSeconds
        },
        speaker: {
          id: segment.speaker?.trim() || "speaker_unknown",
          ...speakerRole
        },
        voice: {
          pace: inferPace(segment),
          volume: "unknown",
          pause: "unknown",
          overlap: interactionLabels.includes("interruption"),
          confidence: 0.35
        },
        toneLabels,
        emotionLabels,
        interactionLabels,
        summary: insightSummary({ toneLabels, emotionLabels, interactionLabels }),
        evidence: insightEvidence(segment, allLabels),
        confidence: confidenceFor({ segment, toneLabels, emotionLabels, interactionLabels })
      };
    });
}

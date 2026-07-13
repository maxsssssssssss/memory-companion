import type { SceneLabel, SemanticSegment, TranscriptSegment, ValueLabel } from "@/lib/domain/types";

const MAX_MERGE_GAP_SECONDS = 120;
const CONTEXT_GAP_SECONDS = 45;
const LONG_FORM_RECORDING_SECONDS = 20 * 60;
const LONG_FORM_MIN_SEGMENTS = 40;
const LONG_FORM_MIN_BLOCK_SECONDS = 5 * 60;
const LONG_FORM_TARGET_BLOCK_SECONDS = 8 * 60;
const LONG_FORM_MAX_BLOCK_SECONDS = 12 * 60;
const MAX_TITLE_LENGTH = 24;
const MAX_SUMMARY_LENGTH = 160;

const hiddenSceneLabels: SceneLabel[] = ["unknown", "low_value_chatter", "private_content"];
const strongValueLabels: ValueLabel[] = ["commitment", "decision", "risk", "open_question", "notable_quote"];
const broadValueLabels: ValueLabel[] = ["task", "idea"];

export type SemanticConcept = {
  title: string;
  summary: string;
  tags: string[];
  pattern: RegExp;
};

export const semanticConceptRules: SemanticConcept[] = [
  {
    title: "硬件形态与软件优势讨论",
    summary: "围绕实体屏幕、平板电脑形态和软件优势展开，重点讨论硬件承载与软件体验之间的取舍。",
    tags: ["产品", "硬件", "软件"],
    pattern: /实体屏幕|平板电脑|键盘|显示屏|电子曲笛|CPU|软件.{0,16}(期待|优势)|硬件.{0,12}软件/i
  },
  {
    title: "软件平台持续价值讨论",
    summary: "围绕软件平台和移动互联网服务展开，重点讨论平台更迭、内容库和持续价值的关系。",
    tags: ["产品", "软件", "商业"],
    pattern: /软件.{0,16}问题|移动互联网|网飞|Netflix|Facebook|内容库|平台.{0,16}更迭/i
  },
  {
    title: "生态合作心态与平台取舍",
    summary: "围绕生态合作、协同心态和平台取舍展开，重点讨论合作伙伴关系与竞争边界。",
    tags: ["商业", "生态", "决策"],
    pattern: /协同心态|同心态|同心態|替代心态|替代心態|生态合作伙伴|合作伙伴|合作夥伴|平台.{0,24}(决定|取舍|合作)/i
  }
];

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
  /^(对|好|行|可以|不是|没有|知道|明白|清楚)[的了啊呀吗嘛吧，,。？?！!]*$/,
  /^要跟进[。？?！!]*$/
];

const tagRules: Array<{ tag: string; pattern: RegExp }> = [
  { tag: "会议", pattern: /会议|开会|会面|沟通|讨论|同步|复盘|call|meeting/i },
  { tag: "客户", pattern: /客户|用户|试用|反馈|续费|合同/ },
  { tag: "投资人", pattern: /投资人|融资|路演|股东|资本|估值/ },
  { tag: "产品", pattern: /产品|功能|版本|需求|体验|定价|MVP|硬件|软件|平台|屏幕|平板|键盘|设备/ },
  { tag: "硬件", pattern: /硬件|设备|实体屏幕|屏幕|平板|键盘|显示屏|CPU|电子曲笛/ },
  { tag: "软件", pattern: /软件|平台|服务|移动互联网|互联网|网飞|Netflix|Facebook|内容库|算法/i },
  { tag: "团队", pattern: /团队|招聘|同事|绩效|协作|负责人|王敏/ },
  { tag: "任务", pattern: /待办|跟进|发给|完成|推进|今天|今晚|明天|下周/ },
  { tag: "决策", pattern: /决定|确认|拍板|取舍|定下来|先做|不做|定价/ },
  { tag: "风险", pattern: /风险|延期|阻塞|担心|问题|不确定|失败/ },
  { tag: "灵感/想法", pattern: /灵感|想法|可以试试|方案|机会|假设/ },
  { tag: "生态", pattern: /生态|合作伙伴|合作夥伴|协同|替代|对手|开放|平台/ },
  { tag: "商业", pattern: /授权|销售|目标|费用|预算|收入|成本|报价/ }
];

const titleTopicRules: Array<{ label: string; pattern: RegExp }> = [
  { label: "新品发布", pattern: /新品|发布会|线下发布|Flybus|Pro\s?2|T2|Nano|渠道会/gi },
  { label: "硬件形态", pattern: /实体屏幕|屏幕|平板|键盘|显示屏|硬件|设备|CPU|电子曲笛/gi },
  { label: "软件平台", pattern: /软件|平台|服务|移动互联网|互联网|网飞|Netflix|Facebook|内容库|更迭/gi },
  { label: "生态合作", pattern: /生态|合作伙伴|合作夥伴|协同|替代|对手|开放|合作/gi },
  { label: "渠道销售", pattern: /渠道|销售|营收|占比|客户|用户|合同|续费|授权|费用|报价|市场/gi },
  { label: "产品规划", pattern: /产品|功能|版本|需求|体验|定价|CMF|硬件|耳机|输入法|转写|离线|技术|组件/gi },
  { label: "融资资金", pattern: /融资|资金|研发投入|估值|投资人|股东|资本/gi },
  { label: "团队协作", pattern: /团队|负责人|协作|跟进|推进|王敏|杨总|胡伟|沟通/gi },
  { label: "风险问题", pattern: /风险|问题|延期|阻塞|担心|不确定|失败|没办法/gi },
  { label: "策略背景", pattern: /策略|项目|背景|权力|博弈|逻辑|判断|取舍/gi },
  { label: "会议安排", pattern: /会议|开会|同步|复盘|议程|安排/gi }
];

const specificTitleRules: Array<{ title: string; pattern: RegExp }> = [
  ...semanticConceptRules.map((rule) => ({ title: rule.title, pattern: rule.pattern })),
  { title: "5月15日新品发布会安排", pattern: /5月15.{0,40}发布会|发布会.{0,40}5月15/i },
  { title: "翻译营销爆发点复盘", pattern: /翻译素材|录音转写.*翻译|520|投流|营销.*爆发|一天十万|三十万|四十万/i },
  { title: "ProArt操作卡顿改进", pattern: /ProArt|这次.{0,20}压杆/i },
  { title: "翻译耳机体验与退货风险", pattern: /退货|准确度|流畅度|原子反馈|卖那么贵|离线.*效果|耳机不好用/i },
  { title: "翻译机需求验证复盘", pattern: /Alpha弹|外国人.*演示|翻译机|传统功能|翻译.*发布会/i },
  { title: "开放式耳机增量市场讨论", pattern: /开放式|Openfit|挂耳|耳夹|少英|欧拉|1000多万台/i },
  { title: "智能Agent记忆与主动性", pattern: /agent|主动.*规划|记忆|情感驱动|念头/i },
  { title: "陪伴娱乐中的智能体交互", pattern: /娱乐|游戏|智能体|陪伴|情感|肢体语言|眼睛和嘴巴/i },
  { title: "用户付费价值与产品痛点", pattern: /消费者|付钱|痛点|卖点|自动驾驶|智能车机|无线连续信息/i },
  { title: "老人助行产品需求案例", pattern: /脑电波|脑机接口|轮椅|助行器|老人|三合一/i },
  { title: "聊天场景需求与软硬件组合", pattern: /聊天|公共场合|隐私|场景客户需求|软硬件组合|大模型/i },
  { title: "智能耳机品牌定位讨论", pattern: /独立品牌|品牌定位|战略自主|阿尔法蛋|讯飞智能耳机|大品类/i },
  { title: "软硬组合与AI路线讨论", pattern: /软硬组合|未来中局|AI怎么走|大模型|硬件.*软件|软硬件组合/i },
  { title: "产品功能模式与场景组合", pattern: /功能.*模式|模式.*场景|场景.*客户|记录.*翻译|翻译.*记录/i },
  { title: "新品发布会安排", pattern: /线下发布会|新品发布会|渠道会/i }
];

const sceneTags: Record<SceneLabel, string> = {
  investor_call: "投资人",
  product_discussion: "产品",
  customer_call: "客户",
  team_management: "团队",
  self_reflection: "复盘",
  low_value_chatter: "闲聊",
  private_content: "私人内容",
  unknown: "未分类"
};

const valueTags: Record<ValueLabel, string> = {
  commitment: "承诺",
  task: "任务",
  decision: "决策",
  idea: "灵感/想法",
  risk: "风险",
  open_question: "未决问题",
  notable_quote: "重要原话"
};

const topicPatterns = [
  /客户|用户|续费|合同|报价|销售|授权|费用/g,
  /产品|功能|版本|需求|体验|定价|MVP/g,
  /团队|招聘|绩效|协作|负责人|王敏/g,
  /投资人|融资|估值|路演/g,
  /风险|延期|阻塞|问题|失败/g,
  /待办|跟进|推进|完成|明天|下周/g,
  /灵感|想法|方案|机会|假设/g
];

const topicBoundaryPattern =
  /^(我们)?(先|接下来|然后)?(说|聊|看|讲)(一下)?(第[一二三四五六七八九十0-9]+个|下一个|另外|还有|回到|总结|最后)|第[一二三四五六七八九十0-9]+个事|换个话题|另外一个|接下来/i;

function normalizeText(text: string) {
  return text.replace(/\s+/g, "").trim();
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function hasValueLabel(segment: TranscriptSegment, labels: ValueLabel[]) {
  return segment.valueLabels.some((label) => labels.includes(label));
}

function hasBusinessScene(segment: TranscriptSegment) {
  return segment.sceneLabels.some((label) => !hiddenSceneLabels.includes(label));
}

function isPrivateSegment(segment: TranscriptSegment) {
  return segment.sceneLabels.includes("private_content");
}

function matchesValuableText(text: string) {
  return tagRules.some((rule) => rule.tag !== "闲聊" && rule.pattern.test(text));
}

function isLowInformationText(text: string) {
  const normalizedText = normalizeText(text);

  if (!normalizedText) {
    return true;
  }

  return normalizedText.length <= 20 && lowInformationPatterns.some((pattern) => pattern.test(normalizedText));
}

function isValuableSegment(segment: TranscriptSegment) {
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
    return matchesValuableText(segment.text) || normalizeText(segment.text).length >= 24;
  }

  return matchesValuableText(segment.text) || normalizeText(segment.text).length >= 36;
}

function extractTopics(text: string) {
  return unique(
    topicPatterns.flatMap((pattern) => {
      const matches = text.match(pattern);
      return matches ?? [];
    })
  );
}

function shareMeaning(a: TranscriptSegment[], b: TranscriptSegment) {
  const groupText = a.map((segment) => segment.text).join(" ");
  const sharedScenes = unique(a.flatMap((segment) => segment.sceneLabels)).some(
    (label) => !hiddenSceneLabels.includes(label) && b.sceneLabels.includes(label)
  );
  const sharedValues = unique(a.flatMap((segment) => segment.valueLabels)).some((label) => b.valueLabels.includes(label));
  const groupTopics = extractTopics(groupText);
  const segmentTopics = extractTopics(b.text);
  const sharedTopics = groupTopics.some((topic) => segmentTopics.includes(topic));

  return sharedScenes || sharedValues || sharedTopics;
}

function shouldMergeGroup(group: TranscriptSegment[], segment: TranscriptSegment) {
  const lastSegment = group[group.length - 1];
  const gap = segment.startSeconds - lastSegment.endSeconds;
  const related = shareMeaning(group, segment);
  const groupHasStrongValue = group.some((item) => hasValueLabel(item, strongValueLabels));
  const segmentHasStrongValue = hasValueLabel(segment, strongValueLabels);

  if (gap < 0) {
    return true;
  }

  if (groupHasStrongValue && segmentHasStrongValue && !related) {
    return false;
  }

  return gap <= MAX_MERGE_GAP_SECONDS && related;
}

function groupDurationSeconds(group: TranscriptSegment[]) {
  return Math.max(...group.map((segment) => segment.endSeconds)) - Math.min(...group.map((segment) => segment.startSeconds));
}

function isLongFormRecording(segments: TranscriptSegment[]) {
  if (segments.length >= LONG_FORM_MIN_SEGMENTS) {
    return true;
  }

  if (segments.length === 0) {
    return false;
  }

  const startSeconds = Math.min(...segments.map((segment) => segment.startSeconds));
  const endSeconds = Math.max(...segments.map((segment) => segment.endSeconds));
  return endSeconds - startSeconds >= LONG_FORM_RECORDING_SECONDS;
}

function shouldMergeLongFormGroup(group: TranscriptSegment[], segment: TranscriptSegment) {
  const lastSegment = group[group.length - 1];
  const gap = segment.startSeconds - lastSegment.endSeconds;

  if (gap > MAX_MERGE_GAP_SECONDS) {
    return false;
  }

  const duration = groupDurationSeconds(group);

  if (duration < LONG_FORM_MIN_BLOCK_SECONDS) {
    return true;
  }

  if (duration >= LONG_FORM_MAX_BLOCK_SECONDS) {
    return false;
  }

  if (duration >= LONG_FORM_TARGET_BLOCK_SECONDS) {
    return !topicBoundaryPattern.test(segment.text) && shareMeaning(group, segment);
  }

  return true;
}

function trimText(text: string, maxLength: number) {
  const cleanText = text.replace(/\s+/g, " ").trim();

  if (cleanText.length <= maxLength) {
    return cleanText;
  }

  return `${cleanText.slice(0, maxLength - 1)}…`;
}

function cleanTitleText(text: string) {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(嗯|啊|呃|然后|就是|那个|所以|其实|我觉得|我们先)[，,。 ]*/, "")
    .trim();
}

function scoreTitleTopic(text: string, pattern: RegExp) {
  pattern.lastIndex = 0;
  return text.match(pattern)?.length ?? 0;
}

function titleTopicsFromGroup(group: TranscriptSegment[]) {
  const text = group.map((segment) => segment.text).join(" ");
  return titleTopicRules
    .map((rule, index) => ({
      label: rule.label,
      index,
      score: scoreTitleTopic(text, rule.pattern)
    }))
    .filter((rule) => rule.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 2)
    .map((rule) => rule.label);
}

function titleIntentFromGroup(group: TranscriptSegment[]) {
  const valueLabels = unique(group.flatMap((segment) => segment.valueLabels));

  if (valueLabels.includes("risk") || valueLabels.includes("open_question")) {
    return "梳理";
  }

  if (valueLabels.includes("decision")) {
    return "决策";
  }

  if (valueLabels.includes("commitment") || valueLabels.includes("task")) {
    return "安排";
  }

  if (valueLabels.includes("idea")) {
    return "方案讨论";
  }

  return "讨论";
}

function specificTitleFromGroup(group: TranscriptSegment[]) {
  const text = group.map((segment) => segment.text).join(" ");
  const focusText = trimText(text, 1200);
  return specificTitleRules.find((rule) => rule.pattern.test(focusText))?.title ?? null;
}

export function inferSemanticConcept(text: string) {
  const focusText = trimText(text, 1600);
  return semanticConceptRules.find((rule) => rule.pattern.test(focusText)) ?? null;
}

function titleFromGroup(group: TranscriptSegment[]) {
  const specificTitle = specificTitleFromGroup(group);

  if (specificTitle) {
    return trimText(specificTitle, MAX_TITLE_LENGTH);
  }

  const topics = titleTopicsFromGroup(group);
  const intent = titleIntentFromGroup(group);

  if (topics.length > 0) {
    const topicTitle = topics.length >= 2 ? `${topics[0]}与${topics[1]}` : topics[0];
    const title = topicTitle === "风险问题" && intent === "梳理" ? "风险问题梳理" : `${topicTitle}${intent}`;

    return trimText(title, MAX_TITLE_LENGTH);
  }

  const valuableSegment = group.find((segment) => hasValueLabel(segment, strongValueLabels)) ?? group.find(isValuableSegment);
  const fallback = valuableSegment ? cleanTitleText(valuableSegment.text) : "会议阶段讨论";
  const clauses = fallback
    .split(/[，。！？；,.!?;]/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const title = clauses.find((clause) => clause.length >= 6) ?? "会议阶段讨论";

  return trimText(title || "语义段落", MAX_TITLE_LENGTH);
}

function summaryFromGroup(group: TranscriptSegment[]) {
  const concept = inferSemanticConcept(group.map((segment) => segment.text).join(" "));

  if (concept) {
    return concept.summary;
  }

  const topics = titleTopicsFromGroup(group);
  const intro = topics.length > 0 ? `围绕${topics.join("、")}展开。` : "";

  return trimText(`${intro}${group.map((segment) => segment.text).join(" ")}`, MAX_SUMMARY_LENGTH);
}

function tagsFromGroup(group: TranscriptSegment[]) {
  const text = group.map((segment) => segment.text).join(" ");
  const labelTags = group.flatMap((segment) => [
    ...segment.sceneLabels.filter((label) => !hiddenSceneLabels.includes(label)).map((label) => sceneTags[label]),
    ...segment.valueLabels.map((label) => valueTags[label])
  ]);
  const inferredTags = tagRules.filter((rule) => rule.pattern.test(text)).map((rule) => rule.tag);
  const conceptTags = inferSemanticConcept(text)?.tags ?? [];

  return unique([...labelTags, ...conceptTags, ...inferredTags]).filter((tag) => tag !== "未分类");
}

function averageConfidence(group: TranscriptSegment[]) {
  const total = group.reduce((sum, segment) => sum + segment.confidence, 0);
  return Math.round((total / group.length) * 100) / 100;
}

function nearbyPendingContext(pendingContext: TranscriptSegment[], segment: TranscriptSegment) {
  return pendingContext.filter(
    (contextSegment) => !isPrivateSegment(contextSegment) && segment.startSeconds - contextSegment.endSeconds <= CONTEXT_GAP_SECONDS
  );
}

function buildSemanticSegment(uploadId: string, group: TranscriptSegment[]): SemanticSegment {
  const sortedGroup = [...group].sort((a, b) => a.startSeconds - b.startSeconds);
  const sourceTimeRange = {
    startSeconds: Math.min(...sortedGroup.map((segment) => segment.startSeconds)),
    endSeconds: Math.max(...sortedGroup.map((segment) => segment.endSeconds))
  };
  const sceneLabels = unique(sortedGroup.flatMap((segment) => segment.sceneLabels));
  const valueLabels = unique(sortedGroup.flatMap((segment) => segment.valueLabels));

  return {
    id: `semantic_${uploadId}_${sortedGroup[0].id}_${sortedGroup[sortedGroup.length - 1].id}`,
    uploadId,
    title: titleFromGroup(sortedGroup),
    summary: summaryFromGroup(sortedGroup),
    startSeconds: sourceTimeRange.startSeconds,
    endSeconds: sourceTimeRange.endSeconds,
    tags: tagsFromGroup(sortedGroup),
    sceneLabels: sceneLabels.length > 0 ? sceneLabels : ["unknown"],
    valueLabels,
    confidence: averageConfidence(sortedGroup),
    sourceSegmentIds: sortedGroup.map((segment) => segment.id),
    sourceTimeRange,
    transcriptExcerpt: trimText(sortedGroup.map((segment) => segment.text).join(" "), 500)
  };
}

export function buildSemanticSegments(uploadId: string, segments: TranscriptSegment[]): SemanticSegment[] {
  const sortedSegments = [...segments].sort((a, b) => a.startSeconds - b.startSeconds);
  const longFormRecording = isLongFormRecording(sortedSegments);
  const groups: TranscriptSegment[][] = [];
  let currentGroup: TranscriptSegment[] = [];
  let pendingContext: TranscriptSegment[] = [];

  function flushGroup() {
    if (currentGroup.some(isValuableSegment)) {
      groups.push(currentGroup);
    }
    currentGroup = [];
  }

  for (const segment of sortedSegments) {
    const valuable = isValuableSegment(segment);

    if (!valuable) {
      if (isPrivateSegment(segment)) {
        continue;
      }

      if (currentGroup.length > 0) {
        const lastSegment = currentGroup[currentGroup.length - 1];
        if (segment.startSeconds - lastSegment.endSeconds <= CONTEXT_GAP_SECONDS) {
          currentGroup.push(segment);
        }
      } else {
        pendingContext.push(segment);
      }
      continue;
    }

    const context = nearbyPendingContext(pendingContext, segment);
    pendingContext = [];

    if (currentGroup.length === 0) {
      currentGroup = [...context, segment];
      continue;
    }

    const shouldMerge = longFormRecording ? shouldMergeLongFormGroup(currentGroup, segment) : shouldMergeGroup(currentGroup, segment);

    if (shouldMerge) {
      currentGroup.push(...context, segment);
      continue;
    }

    flushGroup();
    currentGroup = [...context, segment];
  }

  flushGroup();

  return groups.map((group) => buildSemanticSegment(uploadId, group));
}

import { meaningfulTextTokens } from "@/lib/server/text-features";
import { analyzeQaQueryIntent } from "../lifecycle-retrieval";

export type HybridQueryType =
  | "general"
  | "lifecycle"
  | "preference"
  | "relationship"
  | "decision"
  | "temporal";

export type HybridTemporalIntent =
  | "none"
  | "recent"
  | "earlier"
  | "later"
  | "final"
  | "first"
  | "last"
  | "sequence";

export type HybridRelationshipMode =
  | "none"
  | "named_person"
  | "speaker_pair"
  | "owner"
  | "generic";

export type HybridQuery = {
  normalized: string;
  tokens: string[];
  types: HybridQueryType[];
  entities: string[];
  explicitDates: string[];
  relativeDateTerms: string[];
  temporalIntent: HybridTemporalIntent;
  relationshipMode: HybridRelationshipMode;
  inheritedRelationshipIntent: boolean;
  inheritedEntities: string[];
  lifecycle: ReturnType<typeof analyzeQaQueryIntent>;
};

type QueryConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

const ENTITY_STOP_WORDS = new Set([
  "什么", "为什么", "怎么", "怎样", "如何", "关系", "偏好", "决定", "最后", "后来",
  "之前", "最近", "长期", "当前", "我的", "我们", "对方", "事情", "记录", "两人",
  "双方", "说话者", "哪些", "什么样", "计划变化", "沟通方式"
]);

const RELATIONSHIP_PATTERN =
  /关系|相处|互动|支持|倾听|边界|承诺|约定|沟通方式|(?:两人|双方|说话者).{0,12}(?:沟通|支持|承诺|行为)|伴侣|男朋友|女朋友|同事|朋友|家人|relationship/iu;
const RELATIONSHIP_FOLLOW_UP_PATTERN =
  /^(?:那|那么)?(?:他|她|他们|她们|这个人|对方|那个人)(?:呢|怎么样|是什么关系|后来呢)?[？?。.!！]?$/u;

function normalizedDate(year: string, month: string, day: string) {
  return [year, month.padStart(2, "0"), day.padStart(2, "0")].join("-");
}

function explicitDates(value: string) {
  const dates = new Set<string>();
  for (const match of value.matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/gu)) {
    dates.add(normalizedDate(match[1]!, match[2]!, match[3]!));
  }
  for (const match of value.matchAll(/(20\d{2})年(\d{1,2})月(\d{1,2})[日号]?/gu)) {
    dates.add(normalizedDate(match[1]!, match[2]!, match[3]!));
  }
  for (const match of value.matchAll(/(?<!\d)(\d{1,2})月(\d{1,2})[日号]/gu)) {
    dates.add(`--${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}`);
  }
  return [...dates].sort();
}

function addEntity(candidates: Set<string>, raw: string | undefined) {
  const entity = raw?.trim().replace(/^(?:关于|有关|提到|那|这个)/u, "");
  if (
    entity &&
    entity.length >= 2 &&
    entity.length <= 24 &&
    !ENTITY_STOP_WORDS.has(entity) &&
    !/^(?:他|她|他们|她们|对方|双方|两人|说话者)$/u.test(entity)
  ) {
    candidates.add(entity);
  }
}

function entityCandidates(value: string) {
  const candidates = new Set<string>();
  for (const match of value.matchAll(/\b[A-Z][A-Za-z0-9_-]{1,31}\b/gu)) {
    addEntity(candidates, match[0]);
  }
  for (const pattern of [
    /([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_-]{1,15})(?:和我|与我|跟我)的?关系/gu,
    /(?:我和|我与|我跟)([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_-]{1,15})的?关系/gu,
    /(?:关于|有关|提到)([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_-]{1,15})/gu,
    /((?:小|老|阿)[\p{Script=Han}]{1,3})/gu,
    /([\p{Script=Han}]{1,4}(?:老师|经理|主任|姐|哥|阿姨|叔叔))/gu,
    /[「“"]([^」”"]{2,24})[」”"]/gu
  ]) {
    for (const match of value.matchAll(pattern)) addEntity(candidates, match[1]);
  }
  return [...candidates];
}

function temporalIntent(value: string): HybridTemporalIntent {
  if (/第一次|最初一次|首次/iu.test(value)) return "first";
  if (/最后一次|末次/iu.test(value)) return "last";
  if (/先后|时间线|按顺序|顺序|过程|各阶段/iu.test(value)) return "sequence";
  if (/最终|最后(?:选择|决定|结果|状态)|结果|到头来/iu.test(value)) return "final";
  if (/后来|随后|之后|后续|变化后/iu.test(value)) return "later";
  if (/之前|起初|最初|原来|先前|当时|曾经/iu.test(value)) return "earlier";
  if (/最近|近期|最新|当前|目前|现在|近来/iu.test(value)) return "recent";
  return "none";
}

function relativeDateTerms(value: string) {
  const terms = value.match(
    /第一周|第二周|本周|这周|上周|下周|今天|昨天|前天|明天|当天|某天|哪天/gu
  );
  return [...new Set(terms ?? [])];
}

function latestUserContext(conversation: readonly QueryConversationMessage[] | undefined) {
  return [...(conversation ?? [])]
    .reverse()
    .find((message) => message.role === "user" && message.content.trim().length > 0)
    ?.content.trim();
}

function relationshipMode(value: string, entities: readonly string[]): HybridRelationshipMode {
  if (/owner|归属|属于谁|谁的(?:偏好|承诺|决定|事件)/iu.test(value)) return "owner";
  if (/两位说话者|两人|双方|speaker[_\s-]?\d/iu.test(value)) return "speaker_pair";
  if (entities.length > 0) return "named_person";
  return RELATIONSHIP_PATTERN.test(value) ? "generic" : "none";
}

export function parseHybridQuery(
  question: string,
  conversation?: readonly QueryConversationMessage[]
): HybridQuery {
  const normalized = question.normalize("NFKC").trim();
  const previousUser = latestUserContext(conversation);
  const directEntities = entityCandidates(normalized);
  const inheritedEntities =
    directEntities.length === 0 && RELATIONSHIP_FOLLOW_UP_PATTERN.test(normalized) && previousUser
      ? entityCandidates(previousUser.normalize("NFKC"))
      : [];
  const entities = [...new Set([...directEntities, ...inheritedEntities])];
  const inheritedRelationshipIntent = Boolean(
    previousUser &&
    RELATIONSHIP_FOLLOW_UP_PATTERN.test(normalized) &&
    RELATIONSHIP_PATTERN.test(previousUser)
  );
  const lifecycle = analyzeQaQueryIntent(
    inheritedRelationshipIntent && previousUser ? `${previousUser} ${normalized}` : normalized
  );
  const types = new Set<HybridQueryType>();
  if (lifecycle.intent === "lifecycle_resolution") types.add("lifecycle");
  if (/喜欢|偏好|习惯|长期.*(?:爱|选择|更愿意)|prefer/iu.test(normalized)) {
    types.add("preference");
  }
  if (RELATIONSHIP_PATTERN.test(normalized) || inheritedRelationshipIntent) {
    types.add("relationship");
  }
  if (/决定|选择|为什么.*选|决策|decision/iu.test(normalized)) types.add("decision");
  const temporal = temporalIntent(normalized);
  const dates = explicitDates(normalized);
  const relativeTerms = relativeDateTerms(normalized);
  if (temporal !== "none" || dates.length > 0 || relativeTerms.length > 0) {
    types.add("temporal");
  }
  if (types.size === 0) types.add("general");

  return {
    normalized,
    tokens: [...meaningfulTextTokens(normalized)].sort(),
    types: [...types],
    entities,
    explicitDates: dates,
    relativeDateTerms: relativeTerms,
    temporalIntent: temporal,
    relationshipMode: relationshipMode(normalized, entities),
    inheritedRelationshipIntent,
    inheritedEntities,
    lifecycle
  };
}

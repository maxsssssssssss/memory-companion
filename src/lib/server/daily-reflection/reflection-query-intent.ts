import { z } from "zod";

import { DailyReflectionIdSchema } from "@/lib/domain/daily-reflection";
import {
  DailyReflectionQueryIntentSchema,
  type DailyReflectionQueryIntent
} from "@/lib/domain/daily-reflection-query";

export const DAILY_REFLECTION_QUERY_INTENTS =
  DailyReflectionQueryIntentSchema.options;

export type DailyReflectionQueryIntentRoute = Readonly<{
  intent: DailyReflectionQueryIntent;
  personId: string | null;
}>;

export const DAILY_REFLECTION_QUERY_MAX_LENGTH = 512;

const QueryInputSchema = z.object({
  query: z.string().min(2).max(DAILY_REFLECTION_QUERY_MAX_LENGTH),
  personId: DailyReflectionIdSchema.nullable().optional()
}).strict();

const ILLEGAL_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const MEANINGFUL_QUERY_CHARACTER = /[\p{L}\p{N}]/u;

function hasUnpairedSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function normalizeQuery(value: string) {
  if (ILLEGAL_CONTROL_CHARACTERS.test(value) || hasUnpairedSurrogate(value)) {
    return null;
  }
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (
    normalized.length === 0
    || Array.from(normalized).length < 2
    || Array.from(normalized).length > DAILY_REFLECTION_QUERY_MAX_LENGTH
    || !MEANINGFUL_QUERY_CHARACTER.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

type IntentRule = Readonly<{
  intent: Exclude<DailyReflectionQueryIntent, "memory_exploration">;
  patterns: readonly RegExp[];
}>;

// Ordering is part of the deterministic contract. More specific longitudinal
// intents win before general decision or commitment recall.
const INTENT_RULES: readonly IntentRule[] = [
  {
    intent: "first_appearance",
    patterns: [
      /(?:第一次|首次|最早).{0,40}(?:提到|出现|开始|说|想|记录|决定)?/u,
      /最初.{0,24}(?:提到|出现|开始|想到|记录)/u,
      /(?:什么时候|何时).{0,24}(?:第一次|首次|最早|开始|提到|出现)/u,
      /\b(?:first\s+time|first\s+mention(?:ed)?|earliest)\b/iu,
      /\bwhen\s+(?:did\s+i|was\s+\w+).{0,32}\bfirst\b/iu
    ]
  },
  {
    intent: "belief_change",
    patterns: [
      /(?:想法|看法|观点|态度|决定|计划|偏好).{0,24}(?:变化|改变|转变|演变|不同)/u,
      /(?:改变主意|改主意|转而|不再).{0,30}(?:认为|觉得|想|选择|决定|喜欢|计划)?/u,
      /(?:想法|看法|观点|态度|决定|计划|偏好).{0,24}从.{1,24}(?:变成|转为|改为).{1,24}/u,
      /\b(?:change(?:d)?\s+my\s+mind|belief\s+change|opinion\s+change)\b/iu,
      /\b(?:view|opinion|belief|attitude|plan|preference).{0,24}\b(?:change|changed|evolve|evolved)\b/iu,
      /\bused\s+to\b.{1,48}\bbut\s+now\b/iu
    ]
  },
  {
    intent: "decision_reasoning",
    patterns: [
      /(?:为什么|为何|什么原因|原因是什么|出于什么考虑).{0,48}(?:决定|选择|选了|放弃|采纳|答应)/u,
      /(?:决定|选择|选了|放弃|采纳).{0,28}(?:为什么|为何|原因|考虑)/u,
      /(?:怎么|如何).{0,24}(?:做出|作出).{0,12}(?:决定|选择)/u,
      /\bwhy\b.{0,48}\b(?:decide|decided|choose|chose|pick|picked|opt|opted)\b/iu,
      /\breason(?:s)?\b.{0,32}\b(?:decision|choice)\b/iu,
      /\bwhat\s+(?:led|made|prompted)\s+me\s+to\b/iu
    ]
  },
  {
    intent: "commitment_recall",
    patterns: [
      /(?:承诺|答应|约定|待办|未完成|还没完成|要做|打算做|说过要|需要跟进|跟进事项)/u,
      /\b(?:commitment|commitments|promise|promised|to-do|todo|follow-up|unfinished)\b/iu,
      /\bwhat\s+did\s+i\s+say\s+i\s+would\b/iu,
      /\bwhat\s+do\s+i\s+still\s+need\s+to\s+do\b/iu
    ]
  }
] as const;

function classifyQuery(query: string): DailyReflectionQueryIntent {
  return INTENT_RULES.find((rule) => (
    rule.patterns.some((pattern) => pattern.test(query))
  ))?.intent ?? "memory_exploration";
}

/**
 * Routes a Daily Reflection query without retrieving data or inferring people.
 * A person identifier is returned only when the caller supplied it explicitly.
 */
export function routeDailyReflectionQueryIntent(
  rawInput: unknown
): DailyReflectionQueryIntentRoute | null {
  const parsed = QueryInputSchema.safeParse(rawInput);
  if (!parsed.success) return null;
  const query = normalizeQuery(parsed.data.query);
  if (!query) return null;
  return Object.freeze({
    intent: classifyQuery(query),
    personId: parsed.data.personId ?? null
  });
}

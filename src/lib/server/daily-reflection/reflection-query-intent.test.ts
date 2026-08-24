import { describe, expect, it } from "vitest";

import {
  DAILY_REFLECTION_QUERY_MAX_LENGTH,
  routeDailyReflectionQueryIntent
} from "./reflection-query-intent";

describe("Daily Reflection query intent router", () => {
  it.each([
    ["我为什么最后选择了这个方案？", "decision_reasoning"],
    ["What led me to choose that option?", "decision_reasoning"],
    ["我第一次提到这个想法是什么时候？", "first_appearance"],
    ["When did I first mention this project?", "first_appearance"],
    ["我对这件事的看法后来发生了什么变化？", "belief_change"],
    ["我最初的看法后来如何变化？", "belief_change"],
    ["How did my opinion change over time?", "belief_change"],
    ["我之前承诺要跟进哪些事项？", "commitment_recall"],
    ["What commitments are still unfinished?", "commitment_recall"],
    ["回顾一下我过去对旅行的记录", "memory_exploration"],
    ["从北京到上海的记录", "memory_exploration"],
    ["我最初为什么选择这个方案？", "decision_reasoning"],
    ["Explore my memories about learning languages", "memory_exploration"]
  ] as const)("routes %s as %s", (query, intent) => {
    expect(routeDailyReflectionQueryIntent({ query })).toEqual({
      intent,
      personId: null
    });
  });

  it("uses deterministic precedence for a query with multiple signals", () => {
    const input = { query: "我第一次提到为什么选择这个方向是什么时候？" };
    const first = routeDailyReflectionQueryIntent(input);
    expect(first).toEqual({ intent: "first_appearance", personId: null });
    for (let index = 0; index < 20; index += 1) {
      expect(routeDailyReflectionQueryIntent(input)).toEqual(first);
    }
  });

  it("passes through only an explicitly supplied personId", () => {
    expect(routeDailyReflectionQueryIntent({
      query: "Alice 和我以前讨论过什么？"
    })).toEqual({ intent: "memory_exploration", personId: null });
    expect(routeDailyReflectionQueryIntent({
      query: "Alice 和我以前讨论过什么？",
      personId: "person_alice_01"
    })).toEqual({ intent: "memory_exploration", personId: "person_alice_01" });
  });

  it.each([
    null,
    undefined,
    {},
    { query: 123 },
    { query: "" },
    { query: "问" },
    { query: " \n\t " },
    { query: "？！..." },
    { query: `正常问题\u0000隐藏内容` },
    { query: "\ud800" },
    { query: "问".repeat(DAILY_REFLECTION_QUERY_MAX_LENGTH + 1) },
    { query: "有效问题", personId: 123 },
    { query: "有效问题", personId: "" },
    { query: "有效问题", unexpected: true }
  ])("fails closed for invalid input %#", (input) => {
    expect(routeDailyReflectionQueryIntent(input)).toBeNull();
  });

  it("accepts the exact query length boundary and normalizes display whitespace", () => {
    expect(routeDailyReflectionQueryIntent({
      query: `  ${"问".repeat(DAILY_REFLECTION_QUERY_MAX_LENGTH - 4)}  `
    })).toEqual({ intent: "memory_exploration", personId: null });
    expect(routeDailyReflectionQueryIntent({
      query: "为什么　最后选择这个方案"
    })).toEqual({ intent: "decision_reasoning", personId: null });
  });
});

/** Bounded, explicit user preferences, not an intent classifier. Ambiguous
 * requests remain with the existing decision model and never expand scope. */
export function learningAgentActionPreferences(goal: string) {
  const clauses = goal.split(/[，。！？；,!?;\n]/u).map(value => value.trim());
  const noQuiz = clauses.some(clause =>
    /^(?:我|请)?(?:不要|不想|别)(?:再)?(?:给我)?(?:安排|进行)?(?:做题|出题|测验|考试)/u.test(clause)
    || /^(?:请)?(?:只|仅)(?:要|需)?(?:给我)?(?:解释|讲解)(?:一下|就好|即可)?$/u.test(clause));
  const quantity = clauses.map(clause => clause.match(/^(?:请)?(?:先(?:给我)?(?:出|考|来)?|(?:给我)?出)\s*([一二两三四五1-5])\s*(?:道)?\s*题/u)?.[1]).find(Boolean);
  const numbers: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5 };
  const initialQuizCount = quantity ? numbers[quantity] ?? Number(quantity) : undefined;
  return {
    quizAllowed: !noQuiz,
    ...(initialQuizCount ? { initialQuizCount } : {}),
    notice: "这里只保留明确的当前用户限制；未指定题量、难度或方式时由助手结合已授权内容选择，不要求用户填写工具参数。用户目标不会被改写，也不会扩大资料授权。",
  };
}

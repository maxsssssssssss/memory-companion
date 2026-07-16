const GENERIC_TOKENS = new Set([
  "一个", "一些", "这个", "那个", "这里", "当前", "片段", "对方", "双方", "我们", "你们", "他们",
  "回应", "出现", "进行", "可以", "需要", "已经", "还是", "以及", "没有", "明确", "具体", "说明",
  "表示", "继续", "之后", "后来", "当时", "同时", "关系", "互动", "沟通", "安排", "问题", "事情",
  "相关", "记录", "内容", "情况", "一次", "一种", "比较", "部分", "当前", "the", "and", "with",
  "this", "that", "from", "about", "into", "current", "record", "response"
]);

export function normalizeAnalysisText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function meaningfulTextTokens(value: string) {
  const normalized = normalizeAnalysisText(value);
  const tokens = new Set<string>();

  for (const word of normalized.match(/[a-z0-9]+/g) ?? []) {
    if (word.length >= 2 && !GENERIC_TOKENS.has(word)) tokens.add(word);
  }
  for (const block of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (block.length === 1) {
      if (!GENERIC_TOKENS.has(block)) tokens.add(block);
      continue;
    }
    for (let index = 0; index < block.length - 1; index += 1) {
      const token = block.slice(index, index + 2);
      if (!GENERIC_TOKENS.has(token)) tokens.add(token);
    }
  }

  return tokens;
}

export function sharedTokenCount(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  let count = 0;
  for (const token of left) {
    if (right.has(token)) count += 1;
  }
  return count;
}

export function tokenSetSimilarity(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size === 0 || right.size === 0) return 0;
  const shared = sharedTokenCount(left, right);
  return shared / (left.size + right.size - shared);
}

export function textFeatureSimilarity(left: string, right: string) {
  return tokenSetSimilarity(meaningfulTextTokens(left), meaningfulTextTokens(right));
}

export function roundedScore(value: number) {
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000) / 1_000;
}

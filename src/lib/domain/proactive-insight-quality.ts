export type ProactiveInsightText = {
  observation: string;
  question: string;
  reason: string;
  caution?: string;
};

const STRONGLY_ABSTRACT_PHRASES = [
  "关系质量",
  "长期方向",
  "沟通一致性",
  "认知偏差",
  "双方关系发展"
] as const;

const SOFT_ABSTRACT_PHRASES = [
  "互动模式",
  "关系模式",
  "未来发展",
  "关系发展",
  "关系走向"
] as const;

const COUNSELOR_STYLE_PATTERNS = [
  /是否有助于.*(?:关系|沟通|认知|发展)/,
  /如何(?:改善|提升|促进|优化).*(?:关系|沟通|互动)/,
  /你们是否保持.*一致性/,
  /这(?:是否|会不会).*(?:反映|说明).*(?:关系|模式|发展)/,
  /这对.*(?:关系|未来|长期).*(?:意味着什么|有何影响)/
] as const;

function normalizedText(input: ProactiveInsightText) {
  return `${input.observation}\n${input.question}\n${input.reason}\n${input.caution ?? ""}`
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

export function proactiveInsightHasAbstractLanguage(input: ProactiveInsightText) {
  const text = normalizedText(input);
  const question = input.question.normalize("NFKC");
  const strongHits = STRONGLY_ABSTRACT_PHRASES.filter((phrase) => text.includes(phrase));
  const softHits = SOFT_ABSTRACT_PHRASES.filter((phrase) => text.includes(phrase));

  return (
    strongHits.length > 0 ||
    softHits.some((phrase) => question.includes(phrase)) ||
    strongHits.length + softHits.length >= 2 ||
    COUNSELOR_STYLE_PATTERNS.some((pattern) => pattern.test(question))
  );
}

export function proactiveInsightAbstractLanguagePenalty(input: ProactiveInsightText) {
  const text = normalizedText(input);
  return SOFT_ABSTRACT_PHRASES.some((phrase) => text.includes(phrase)) ? 8 : 0;
}

import { parseFiniteSetAtoms } from "./quiz-set-cardinality";

type ExplanationSource = { materialId: string; paragraph: number; text: string };
export type LearningExplanationContentIssue = {
  code: "literal_intersection_contradiction";
  /** Offsets point into the unchanged saved answer; no second copy of its body. */
  start: number;
  end: number;
};

const atom = String.raw`[+-]?\d+|[A-Za-z]`;

function literalDefinitions(text: string) {
  const definitions = new Map<string, string[]>();
  for (const match of text.matchAll(/\b([A-Za-z])\s*=\s*(\{[^{}\n]*\}|∅)/g)) {
    // The trailing B in A∩B={3} is not a new definition of B.
    if (/[∩∪+*×/\\−-]$/.test(text.slice(0, match.index).trimEnd())) continue;
    const value = parseFiniteSetAtoms(match[2]);
    if (!value) return null;
    const previous = definitions.get(match[1]);
    if (previous && JSON.stringify(previous) !== JSON.stringify(value)) return null;
    definitions.set(match[1], value);
  }
  return definitions;
}

function insideQuotation(text: string, index: number) {
  for (const [open, close] of [["“", "”"], ["「", "」"], ["『", "』"], ["\"", "\""]]) {
    let start = text.indexOf(open);
    while (start !== -1) {
      const end = text.indexOf(close, start + 1);
      if (end === -1) break;
      if (start < index && index < end) return true;
      start = text.indexOf(open, end + 1);
    }
  }
  return false;
}

/** A deliberately bounded content gate, not a semantic verifier. It only detects
 * an affirmative local claim that a literal element belongs to both of the one
 * unambiguous pair of literal sets, yet therefore fails their intersection.
 * The pair must be written in the answer AND match the cited original text.
 * Unsupported syntax, quotations and hypothetical/corrected misconceptions are
 * left undecided. Empty issues never means the explanation has been verified. */
export function inspectLearningExplanationContent(
  materialAnswer: string | null | undefined,
  citedSources: readonly ExplanationSource[],
): { status: "known_issue" | "no_known_issue"; issues: LearningExplanationContentIssue[] } {
  const none = { status: "no_known_issue", issues: [] } as const;
  if (!materialAnswer?.trim() || !citedSources.length) return { ...none, issues: [] };
  const answerDefinitions = literalDefinitions(materialAnswer);
  const originalDefinitions = literalDefinitions(citedSources.map(source => source.text).join("\n"));
  if (!answerDefinitions || !originalDefinitions || answerDefinitions.size !== 2) return { ...none, issues: [] };
  const pair = [...answerDefinitions.keys()].sort();
  if (pair.some(name => JSON.stringify(answerDefinitions.get(name)) !== JSON.stringify(originalDefinitions.get(name)))) return { ...none, issues: [] };
  const intersectionPairs = [...materialAnswer.matchAll(/([A-Za-z])\s*∩\s*([A-Za-z])/g)].map(match => [match[1], match[2]].sort().join(""));
  if (!intersectionPairs.length || intersectionPairs.some(value => value !== pair.join(""))) return { ...none, issues: [] };

  const issues: LearningExplanationContentIssue[] = [];
  // Require a causal affirmative assertion, rather than searching for the words
  // "intersection" and "not" anywhere in the answer.
  const contradiction = new RegExp(String.raw`元素\s*(${atom})\s*同时属于\s*(两个集合|这两个集合|([A-Za-z])\s*(?:和|与|、)\s*([A-Za-z]))\s*[,，]\s*(?:所以|因此|因而|故)\s*(?:它|该元素)?\s*(?:不满足交集(?:的)?(?:双条件|条件)|不属于交集)`, "g");
  for (const match of materialAnswer.matchAll(contradiction)) {
    const start = match.index, end = start + match[0].length;
    const before = materialAnswer.slice(0, start), after = materialAnswer.slice(end);
    const sentencePrefix = before.slice(Math.max(before.lastIndexOf("。"), before.lastIndexOf("！"), before.lastIndexOf("？"), before.lastIndexOf("\n")) + 1);
    const sentenceSuffix = after.match(/^[^。！？\n]*(?:[。！？]|$)/)?.[0] ?? "";
    if (insideQuotation(materialAnswer, start)
      || /(?:误以为|错误|说法|声称|假设|如果|假如|不能说|并非|不是|不应认为|是否)/.test(sentencePrefix)
      || /(?:是错的|是错误的|并不正确|不正确|不成立|说法错误|[?？])/.test(sentenceSuffix)) continue;
    if (match[3] && [match[3], match[4]].sort().join("") !== pair.join("")) continue;
    const element = parseFiniteSetAtoms(`{${match[1]}}`)?.[0];
    if (!element || !pair.every(name => answerDefinitions.get(name)!.includes(element))) continue;
    issues.push({ code: "literal_intersection_contradiction", start, end });
  }
  return { status: issues.length ? "known_issue" : "no_known_issue", issues };
}

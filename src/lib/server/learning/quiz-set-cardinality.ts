// A bounded check for affirmative, literal finite-set cardinality questions.
// This does not evaluate formulas, resolve symbols, or verify source entailment.
const atom = String.raw`(?:[+-]?\d+|[A-Za-z])`;
const literalSet = new RegExp(String.raw`^\{\s*(?:${atom}(?:\s*[,，、]\s*${atom})*)?\s*\}$`);

/** null means unsupported syntax, not an empty set. Atom keys preserve case. */
export function parseFiniteSetAtoms(literal: string): string[] | null {
  const text = literal.trim();
  if (text === "∅") return [];
  if (!literalSet.test(text)) return null;
  return [...new Set((text.match(/[+-]?\d+|[A-Za-z]/g) ?? []).map(value =>
    /^[A-Za-z]$/.test(value) ? `letter:${value.charCodeAt(0)}` : `integer:${BigInt(value)}`))].sort();
}

type CardinalityInspection =
  | { status: "not_applicable" }
  | { status: "consistent"; targetCount: number; matchingOptionIds: string[] }
  | { status: "invalid"; code: "multiple_answers" | "no_answer" | "incorrect_answer"; targetCount: number; matchingOptionIds: string[] };

/** Only a whole, simple same-cardinality question with complete literal choices
 * is decidable here. Returning consistent means this one local constraint holds,
 * not that the entire question or its cited material has been verified. */
export function inspectLiteralSetCardinality(
  stem: string,
  options: ReadonlyArray<{ id: string; text: string }>,
  correctOptionId: string,
): CardinalityInspection {
  const unsupported = { status: "not_applicable" } as const;
  // Leave negation, other mathematical relations and representation questions to
  // their existing contracts. Do not turn a partial sentence into an answer test.
  if (/不|非|错误|除外|多重集|重集|multiset|序列|元组|数组|列表|字符串|JSON|代码|写法|字面|表示法/i.test(stem)) return unsupported;
  const literals = [...stem.matchAll(/\{[^{}]*\}|∅/g)];
  if (literals.length !== 1) return unsupported;
  const target = parseFiniteSetAtoms(literals[0][0]);
  if (target === null) return unsupported;
  const question = stem.replace(literals[0][0], "@集合值@").replace(/\s/g, "").replace(/[？?。.]$/, "");
  const property = "(?:元素(?:个数|数量)相同|(?:含有?|具有)相同数量的元素)";
  const patterns = [
    `^(?:集合)?@集合值@(?:与|和)(?:下列|以下)?哪(?:一)?个集合${property}$`,
    `^(?:下列|以下)?哪(?:一)?个集合(?:与|和)(?:集合)?@集合值@${property}$`,
    `^(?:与|和)(?:集合)?@集合值@${property}的集合是(?:下列|以下)?哪(?:一)?个(?:集合)?$`,
  ];
  if (!patterns.some(pattern => new RegExp(pattern).test(question))) return unsupported;
  if (options.length < 2 || new Set(options.map(o => o.id)).size !== options.length
    || !options.some(o => o.id === correctOptionId)) return unsupported;
  const choices = options.map(option => ({ id: option.id, atoms: parseFiniteSetAtoms(option.text) }));
  if (choices.some(option => option.atoms === null)) return unsupported;
  const matchingOptionIds = choices.filter(option => option.atoms!.length === target.length).map(option => option.id);
  const detail = { targetCount: target.length, matchingOptionIds };
  if (matchingOptionIds.length > 1) return { status: "invalid", code: "multiple_answers", ...detail };
  if (!matchingOptionIds.length) return { status: "invalid", code: "no_answer", ...detail };
  if (matchingOptionIds[0] !== correctOptionId) return { status: "invalid", code: "incorrect_answer", ...detail };
  return { status: "consistent", ...detail };
}

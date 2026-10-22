import { parseFiniteSetAtoms } from "./quiz-set-cardinality";

/** Two explicit finite sets and complete intersection/union result equations.
 * Different equations can both be true without being equivalent options. Count
 * their truth values before trusting the model's correct ID or distractor prose.
 * Unsupported syntax is not a correctness certificate; do not infer conditions. */
export function inspectLiteralSetOperationResults(
  stem: string, options: ReadonlyArray<{ id: string; text: string }>, correctOptionId: string,
): ReturnType<typeof inspectLiteralSetMembership> {
  const unsupported = { status: "not_applicable" } as const;
  const match = stem.trim().match(/^(?:(?:已知|假设|给定|设)\s*)?(?:集合\s*)?([A-Za-z])\s*=\s*(\{[^{}]*\}|∅)\s*[,，、;；]\s*(?:集合\s*)?([A-Za-z])\s*=\s*(\{[^{}]*\}|∅)\s*[。.;；]?\s*(?:下列|以下)\s*(?:集合\s*)?(?:运算结果|等式)\s*(?:中\s*)?(?:正确|成立)\s*的是\s*[:：?？。]?$/u);
  if (!match || match[1] === match[3] || options.length < 2
    || new Set(options.map(o => o.id)).size !== options.length || !options.some(o => o.id === correctOptionId)) return unsupported;
  const left = parseFiniteSetAtoms(match[2]), right = parseFiniteSetAtoms(match[4]);
  if (left === null || right === null) return unsupported;
  const sets = new Map([[match[1], left], [match[3], right]]);
  const matchingOptionIds: string[] = [];
  for (const option of options) {
    const equation = option.text.trim().match(/^([A-Za-z])\s*([∩∪])\s*([A-Za-z])\s*=\s*(\{[^{}]*\}|∅)\s*[。.]?$/u);
    if (!equation) return unsupported;
    const first = sets.get(equation[1]), second = sets.get(equation[3]), actual = parseFiniteSetAtoms(equation[4]);
    if (!first || !second || actual === null) return unsupported;
    const expected = equation[2] === "∩" ? first.filter(atom => second.includes(atom)) : [...new Set([...first, ...second])].sort();
    if (actual.length === expected.length && actual.every((atom, index) => atom === expected[index])) matchingOptionIds.push(option.id);
  }
  const code = matchingOptionIds.length > 1 ? "multiple_answers" : !matchingOptionIds.length ? "no_answer"
    : matchingOptionIds[0] !== correctOptionId ? "incorrect_answer" : null;
  return { status: code ? "invalid" : "consistent", code, matchingOptionIds };
}

/** Only two complete finite-set declarations followed by one literal membership
 * question are supported. No inferred declarations, complements, quantifiers,
 * expressions, or partial matches inside a longer question. A consistent result
 * checks this constraint alone; it is not a semantic or source verification. */
export function inspectLiteralSetMembership(
  stem: string, options: ReadonlyArray<{ id: string; text: string }>, correctOptionId: string,
): { status: "not_applicable" } | {
  status: "consistent" | "invalid";
  code: "multiple_answers" | "no_answer" | "incorrect_answer" | null;
  matchingOptionIds: string[];
} {
  const unsupported = { status: "not_applicable" } as const;
  const match = stem.trim().match(/^(?:(?:已知|假设|给定|设)\s*)?(?:集合\s*)?([A-Za-z])\s*=\s*(\{[^{}]*\}|∅)\s*[,，、;；]\s*(?:集合\s*)?([A-Za-z])\s*=\s*(\{[^{}]*\}|∅)\s*[。.;；]?\s*(?:(?:在上述集合中|在这两个集合中)[,，]\s*)?(?:下列|以下)?哪(?:一)?个元素\s*(不属于|属于)\s*(?:集合\s*)?([A-Za-z])\s*([∩∪])\s*([A-Za-z])\s*[?？。]?$/u);
  if (!match || match[1] === match[3]) return unsupported;
  const left = parseFiniteSetAtoms(match[2]), right = parseFiniteSetAtoms(match[4]);
  if (left === null || right === null) return unsupported;
  const sets = new Map([[match[1], left], [match[3], right]]);
  const first = sets.get(match[6]), second = sets.get(match[8]);
  if (!first || !second) return unsupported;
  const atoms = options.map(option => {
    if (/[,，、{}∅]/u.test(option.text)) return null;
    const parsed = parseFiniteSetAtoms(`{${option.text}}`);
    return parsed?.length === 1 ? parsed[0] : null;
  });
  if (atoms.some(atom => atom === null)) return unsupported;
  const matchingOptionIds = options.flatMap((option, index) => {
    const atom = atoms[index]!;
    const member = match[7] === "∩" ? first.includes(atom) && second.includes(atom) : first.includes(atom) || second.includes(atom);
    return (match[5] === "不属于" ? !member : member) ? [option.id] : [];
  });
  const code = matchingOptionIds.length > 1 ? "multiple_answers" : !matchingOptionIds.length ? "no_answer"
    : matchingOptionIds[0] !== correctOptionId ? "incorrect_answer" : null;
  return { status: code ? "invalid" : "consistent", code, matchingOptionIds };
}

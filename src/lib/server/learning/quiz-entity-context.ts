import { findFiniteSetLiterals } from "./quiz-set-cardinality";

type Range = [start: number, end: number];
const symbol = /(?<![A-Za-z0-9_])[A-Za-z](?![A-Za-z0-9_])/g;
const coordinated = /(?<![A-Za-z0-9_])[A-Za-z](?:\s*(?:和|与|及|、|或|and|or|&)\s*[A-Za-z])+(?![A-Za-z0-9_])/g;
// Ownership of an occurrence, not a sentence-wide exemption. A choice introducer
// owns the following names even if the same letters are defined as sets elsewhere.
const choicePrefix = /(?:选项|答案|option|choice|正确项|错误项|选择|选|choose|select)\s*[:：]?\s*(?:(?:中(?:的)?|分别(?:是|为)|是|为|只(?:能|有)?|仅(?:有|能)?|应(?:当|该)?|必须|可能|可以|同时|从|在|属于|归入)\s*[:：]?\s*)*$/i;
const choiceSuffix = /^\s*(?:(?:[一二两三四五六七八九十\d]+\s*(?:个\s*)?)?(?:项|选项)|(?:都|均|皆)?\s*(?:并)?(?:不|非)?(?:是|为)?\s*(?:不)?(?:正确|错误|准确|成立|符合|可选))/;
export const hasQuizChoicePrefix = (text: string) => choicePrefix.test(text);
const names = (text: string) => [...text.matchAll(symbol)].map(match => match[0]);

/** Build only from this question's scenario/stem. Explicit local mathematical
 * syntax in the inspected text is handled as a bounded occurrence below; it
 * never teaches declarations to another phrase or candidate. */
function questionEntities(context: string) {
  const sets = new Set<string>(), atoms = new Set<string>();
  for (const literal of findFiniteSetLiterals(context)) {
    const declaration = /(?<![A-Za-z0-9_])([A-Za-z])\s*=\s*$/.exec(context.slice(0, literal.index));
    if (declaration && !hasQuizChoicePrefix(context.slice(0, declaration.index))) sets.add(declaration[1]);
    for (const name of names(literal.text)) atoms.add(name);
  }
  return { sets, atoms };
}

/** Ranges with explicit content identity. Callers mask these ranges only while
 * inspecting display dependencies; saved text and stable option IDs stay intact. */
export function quizEntityRanges(text: string, question = ""): Range[] {
  const ranges: Range[] = [];
  const literals = findFiniteSetLiterals(text);
  ranges.push(...literals.map(literal => [literal.index, literal.index + literal.text.length] as Range));
  const context = questionEntities(question || text);
  // A self-contained element literal supports its nearby element explanation,
  // without introducing a new set-name declaration into the question context.
  const atoms = new Set([...context.atoms, ...literals.flatMap(literal => names(literal.text))]);
  const protect = (start: number, end: number) => {
    if (!hasQuizChoicePrefix(text.slice(0, start)) && !choiceSuffix.test(text.slice(end))) ranges.push([start, end]);
  };

  // Explicit content types are recognizable without requiring set declarations.
  // Keep these ranges narrow: "A组...第二项正确" still exposes the ordinal.
  const typed = /(?:方案|计划|组别|类型|模型|区域|\bplan\b|\bgroup\b|\bcase\b)\s*[A-Z](?:\s*(?:和|与|及|、|或|and|or|&)\s*[A-Z])*|\b[A-Z]\s*(?:组|队|型|类|区|站)/gi;
  for (const match of text.matchAll(typed)) ranges.push([match.index!, match.index! + match[0].length]);
  const expressions = /(?<![A-Za-z0-9_])[A-Za-z](?:\s*[∩∪⊆⊂⊇⊃∈∉]\s*[A-Za-z])+(?![A-Za-z0-9_])/g;
  for (const match of text.matchAll(expressions)) protect(match.index!, match.index! + match[0].length);
  const typedSets = /集合\s*[A-Za-z](?:\s*(?:和|与|及|、|或|and|or|&)\s*[A-Za-z])*(?![A-Za-z0-9_])/g;
  for (const match of text.matchAll(typedSets)) protect(match.index!, match.index! + match[0].length);

  for (const match of text.matchAll(coordinated)) {
    const start = match.index!, end = start + match[0].length;
    const before = text.slice(0, start), after = text.slice(end), ids = names(match[0]);
    if (hasQuizChoicePrefix(before) || choiceSuffix.test(after)) continue;
    // Declared names have content identity regardless of which ordinary Chinese
    // predicate follows (containment, disjointness, conditions, etc.). Display
    // ownership still takes precedence at this exact occurrence.
    if (ids.every(id => context.sets.has(id))) { ranges.push([start, end]); continue; }
    // Intrinsically typed local uses remain valid, including a quoted definition
    // with generic A/B inside a question whose concrete sets are X/Y.
    const membership = /(?:不)?属于\s*$/.test(before);
    const setPredicate = /^\s*(?:(?:分别)?(?:含有?|包含)\s*元素|(?:都|均)(?:非空|为空)|(?:都|均)?(?:是|为)(?:(?:非空|空|有限|无限)?集合|非空集|空集)|的(?:元素|交集|并集|补集))/.test(after);
    const elementUse = /(?:元素|含有?|包含)\s*$/.test(before)
      || /^\s*(?:[一二两三四五六七八九十\d]+\s*个元素|(?:都|均)(?:只)?出现[一二两三四五六七八九十\d]+\s*次)/.test(after);
    if (membership || setPredicate || (elementUse && ids.every(id => atoms.has(id)))) ranges.push([start, end]);
  }
  // An explicit alphabet enumeration is content, not a displayed choice list.
  const letters = /\b([A-Z](?:\s*[、,，]\s*[A-Z])+)\s*(?:(?:含有?|包含|有|共)\s*)?(?:[一二两三四五六七八九十\d]+\s*个)?\s*(?:字母|letters?\b)/gi;
  for (const match of text.matchAll(letters)) protect(match.index!, match.index! + match[1].length);
  return ranges;
}

export function maskQuizEntities(text: string, question = "") {
  const characters = text.split("");
  for (const [start, end] of quizEntityRanges(text, question)) for (let i = start; i < end; i++) characters[i] = " ";
  return characters.join("");
}

import type { ThinkingMatterEvent } from "@/lib/domain/reflection-thinking-matter";

// Quote a short user question verbatim. Long instructions need a neutral
// heading, not another inferred summary (which can invent dates or constraints).
function initialQuestion(text: string) {
  const firstQuestion = /^[^。！？!?\n]{1,119}[？?]/u.exec(text)?.[0];
  if (firstQuestion) return firstQuestion;
  return text.length <= 120 && !/[。！？!?\n]/u.test(text.replace(/[。！？!?]$/u, ""))
    ? text : "这几个方案怎么选？";
}

function snapshotQuestion(snapshot: unknown) {
  return snapshot && typeof snapshot === "object" && "question" in snapshot && typeof snapshot.question === "string"
    ? snapshot.question : undefined;
}

/** The same user events determine the heading for old JSON, writes and model
 * observations. Assistant events (including withdrawn card excerpts) never do. */
export function comparisonQuestion(matterQuestion: string, events: ThinkingMatterEvent[]) {
  let question = initialQuestion(matterQuestion);
  let previousMatterQuestion: string | undefined;
  for (const { kind, text, data } of events) {
    if (kind === "created" || (kind === "edited" && typeof data.question === "string")) {
      const next = kind === "created" ? text : String(data.question);
      if (next !== previousMatterQuestion) question = initialQuestion(next);
      previousMatterQuestion = next;
    } else if (kind === "comparison_edited" || kind === "corrected") {
      if (typeof data.comparisonQuestion === "string") {
        question = data.comparisonQuestion;
      } else if (kind === "comparison_edited") {
        // Legacy full-form edits recorded both snapshots. Saving another field
        // did not confirm the automatic heading displayed by that form.
        const next = snapshotQuestion(data.comparison), previous = snapshotQuestion(data.previousComparison);
        if (next && (data.previousComparison === null || (previous !== undefined && next !== previous))) question = next;
      }
    }
  }
  return question;
}

/** Require an affirmative title command. If it also asks for analysis, only
 * the title belongs to the edit; the entire message still goes to the agent. */
export function requestedComparisonQuestion(message: string) {
  const command = message.trim().replace(/^(?:更正|纠正)(?:一下)?[，,：:]\s*/u, "");
  const match = /^(?:(?:请|我想)\s*)?(?:(?:把|将)?(?:这次|当前)?(?:比较(?:的)?(?:标题|题目|问题)|题目|标题)\s*(?:(?:改|修改|换|更正|纠正)(?:成|为)|应该是|应为)|(?:改题|更正(?:比较)?(?:题目|标题)|纠正(?:比较)?(?:题目|标题)|换个问题)\s*[：:])\s*[：:]?\s*/u.exec(command);
  if (!match) return undefined;
  const rest = command.slice(match[0].length);
  const quoted = /^(?:「([^「」]+)」|“([^“”]+)”|"([^"]+)")/u.exec(rest);
  const boundary = /[。；;\n]|[，,](?=\s*(?:然后|接着|请|继续|重新|再比较))/u.exec(rest);
  const question = (quoted ? quoted[1] ?? quoted[2] ?? quoted[3] : rest.slice(0, boundary?.index)).trim();
  const remainder = rest.slice(quoted?.[0].length ?? boundary?.index ?? rest.length);
  if (quoted && remainder && !/^[，,。！!；;\s]/u.test(remainder)) return undefined;
  const tail = remainder.replace(/^[，,。！!；;\s]+/u, "");
  if (!question || (!quoted && /[「」“”"]/u.test(question))) return undefined;
  const asksForAdvice = /(?:吗|么|怎么样|会不会更好|好不好)[？?]?$/u;
  if ((!quoted && asksForAdvice.test(question)) || (tail && (/^(?:还是|的话|[？?])/u.test(tail) || asksForAdvice.test(tail)))) return undefined;
  return { question, standalone: !tail };
}

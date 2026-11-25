import type { DateCompanionHomeContentPresentation } from "@/lib/client/date-companion-proactive-value";

export type BookHomeMaterial =
  | DateCompanionHomeContentPresentation["about"][number]
  | DateCompanionHomeContentPresentation["beforeMeeting"][number];

export type BookHomeMaterialPresentation = {
  text: string;
  reason?: string;
  status?: "仍待办";
  followUpTopic?: boolean;
};

const followUpLead = "这件事的进展" as const;
const followUpPrefix = `可以问问${followUpLead}：`;

const repeatedLabels: Record<BookHomeMaterial["kind"], readonly string[]> = {
  open_promise: ["你答应过"],
  follow_up: ["可以问问 Ta"],
  recent_update: ["Ta 的近况"],
  preference: ["Ta 的偏好"],
  shared_moment: ["一起经历的事", "你们一起经历的"]
};

function comparable(text: string) {
  // Ignore layout whitespace and a terminal full stop, not semantic punctuation.
  return text.trim().replace(/\s+/gu, " ").replace(/[。.]$/u, "");
}

/** Presentation only: never infer a shorter topic, a question, or new facts. */
export function presentBookHomeMaterial(item: BookHomeMaterial): BookHomeMaterialPresentation {
  const original = item.text.trim();
  let text = original;
  for (const label of repeatedLabels[item.kind]) {
    if (!original.startsWith(label)) continue;
    const suffix = original.slice(label.length);
    const delimiter = /^\s*[:：]\s*/u.exec(suffix);
    if (!delimiter) continue;
    const body = suffix.slice(delimiter[0].length).trim();
    if (body) text = body;
    break;
  }

  // Split an existing intent/context sentence only; do not infer its topic.
  // The adjacent follow_up kind label retains the "可以问问" action.
  // In particular, formal reflection attribution prefixes must stay attached.
  const followUpContext = item.kind === "follow_up" && original.startsWith(followUpPrefix)
    ? original.slice(followUpPrefix.length).trim()
    : "";
  if (followUpContext) {
    // Only unwrap the generated attribution. Keep qualifiers, negation and the
    // speaker's subject intact if the template does not match.
    text = item.sources.find(source => source.presentation === "suggestion" && source.quote.trim())?.quote.trim()
      || followUpContext.replace(/^Ta 上次提到(?:在(?=给)|[：:])/u, "").trim() || followUpContext;
  }

  const reason = "reason" in item ? item.reason.trim() : "";
  const repeatedReason = reason && (
    comparable(reason) === comparable(original)
    || comparable(reason) === comparable(text)
  );
  const statusReason = item.kind === "open_promise"
    && comparable(reason) === "这项约定仍然待办";
  const genericFollowUpReason = !followUpContext && item.kind === "follow_up"
    && comparable(reason) === "Ta 上次提到了这件正在做的事";

  return {
    text,
    ...(followUpContext ? { followUpTopic: true } : {}),
    ...(reason && !repeatedReason && !statusReason && !genericFollowUpReason ? { reason } : {}),
    // The formal home-content validator already requires an open promise.
    ...(item.kind === "open_promise" ? { status: "仍待办" as const } : {})
  };
}

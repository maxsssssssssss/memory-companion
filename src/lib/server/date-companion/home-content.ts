import {
  DateCompanionHomeContentSchema,
  DateCompanionProactiveValueContextSchema,
  type DateCompanionHomeContent,
  type DateCompanionProactiveValueContext
} from "@/lib/domain/date-companion-proactive-value";

const REFLECTION_PREFIX = "你在复盘中提到：";
const MIXED_PREFIX = "结合相处记录和你的复盘：";

/** Validate authority and provenance here; content selection belongs to the model. */
export function validateDateCompanionHomeContent(input: {
  context: DateCompanionProactiveValueContext;
  value: unknown;
}): { value: DateCompanionHomeContent | null; failureCode?: string } {
  const context = DateCompanionProactiveValueContextSchema.safeParse(input.context);
  const parsed = DateCompanionHomeContentSchema.safeParse(input.value);
  if (!context.success || !parsed.success || context.data.scope !== "person_relationship") {
    return { value: null, failureCode: "invalid_home_content" };
  }
  const evidence = new Map(context.data.evidence.map((item) => [item.evidenceId, item]));
  const value = parsed.data;
  const items = [...value.home.about, ...value.home.beforeMeeting];
  if (value.evidenceIds.some((id) => !evidence.has(id))) {
    return { value: null, failureCode: "invalid_evidence" };
  }
  for (const item of value.home.about) {
    const sources = item.evidenceIds.map((id) => evidence.get(id)!);
    const eligible = item.kind === "shared_moment"
      ? sources.some((source) => source.subject === "both")
      : sources.every((source) => source.subject === "companion" || source.subject === "both");
    if (!eligible) return { value: null, failureCode: "invalid_home_subject" };
  }
  for (const item of value.home.beforeMeeting) {
    const promises = context.data.promises ?? [];
    if (item.kind === "open_promise") {
      const promise = promises.find((candidate) => candidate.id === item.promiseId);
      if (!promise || promise.status !== "open"
        || item.evidenceIds.some((id) => !promise.evidenceIds.includes(id))) {
        return { value: null, failureCode: "invalid_home_promise" };
      }
    } else if (promises.some((promise) => promise.status === "done"
      && item.evidenceIds.every((id) => promise.evidenceIds.includes(id)))) {
      // A finished promise cannot reappear as a generic outstanding follow-up.
      return { value: null, failureCode: "resolved_home_promise" };
    }
  }
  for (const item of items) {
    const origins = new Set(item.evidenceIds.map((id) => evidence.get(id)!.origin));
    const expectedPrefix = origins.has("user_reflection")
      ? origins.has("direct_conversation") ? MIXED_PREFIX : REFLECTION_PREFIX
      : "";
    const existingPrefix = [REFLECTION_PREFIX, MIXED_PREFIX].find((prefix) => item.text.startsWith(prefix));
    if (existingPrefix && existingPrefix !== expectedPrefix) {
      return { value: null, failureCode: "invalid_home_attribution" };
    }
    if (expectedPrefix && !existingPrefix) item.text = `${expectedPrefix}${item.text}`;
  }
  const canonical = DateCompanionHomeContentSchema.safeParse(value);
  return canonical.success
    ? { value: canonical.data }
    : { value: null, failureCode: "invalid_home_content" };
}

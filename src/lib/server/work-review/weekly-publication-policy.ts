import {
  WorkWeeklyPublishedItemInputSchema,
  type WorkWeeklyReviewIssue,
  type WorkWeeklyPublishedItemInput,
  type WorkWeeklySourceSnapshot
} from "@/lib/domain/work-weekly";

import {
  assertWorkWeeklySnapshotAuthority,
  resolveWorkWeeklySourceRecord,
  WorkWeeklySynthesizerResponseSchema,
  validateWorkWeeklyVerifierOutput,
  validateWorkWeeklyCoverage,
  workWeeklyCoverageSourceRefs,
  workWeeklyCoverageClaimIsRelated,
  workWeeklyCompletionClaimSupported,
  type WorkWeeklyCoverageAssessment,
  type WorkWeeklyClaimVerifier,
  type WorkWeeklyGeneratedClaim,
  type WorkWeeklyGeneratedItem,
  type WorkWeeklySynthesizer,
  type WorkWeeklyVerifierItem,
  type WorkWeeklyVerificationAuditDetails
} from "./weekly-ai-provider";

export const WORK_WEEKLY_PUBLICATION_POLICY_VERSION = "work_weekly_publication_v11" as const;

export type WorkWeeklyQualityAssessment = {
  status: "passed" | "needs_review" | "insufficient";
  reviewIssues: WorkWeeklyReviewIssue[];
  reasonCodes: string[];
  sourceCount: number;
  coveredSourceCount: number;
  partialSourceCount: number;
  omittedSourceCount: number;
  notApplicableSourceCount: number;
  unassessedSourceCount: number;
};

export type WorkWeeklyClaimPublicationTrace = {
  itemId: string;
  claimId: string;
  section: WorkWeeklyGeneratedItem["section"];
  claimType: WorkWeeklyGeneratedClaim["claimType"];
  sourceRefs: string[];
  outcome: "published" | "merged" | "rejected";
  reasonCode: string;
  publishedSortOrder: number | null;
};

/** Opt-in private artifact data. Never emit to general logs. "published" is
 * policy candidates only; the repository has not been called at this stage. */
export type WorkWeeklyGenerationTrace = {
  snapshotDigest: string;
  inputPackDigest: string;
} & (
  | { stage: "synthesized"; generated: WorkWeeklyGeneratedItem[] }
  | { stage: "verified"; verdicts: WorkWeeklyVerifierItem[]; coverage: WorkWeeklyCoverageAssessment[] | null;
      auditDetails?: WorkWeeklyVerificationAuditDetails }
  | { stage: "published"; publicationStatus: "candidate_only"; items: WorkWeeklyPublishedItemInput[];
      claims: WorkWeeklyClaimPublicationTrace[]; quality_assessment: WorkWeeklyQualityAssessment }
);

export const WORK_WEEKLY_SAFETY_ISSUE_CODES = [
  "proposal_not_decision",
  "assignment_not_commitment",
  "todo_state_not_real_world_completion",
  "date_not_deadline",
  "temporal_order_not_causality",
  "single_source_not_frequency",
  "absolute_frequency_not_supported",
  "person_not_confirmed",
  "source_does_not_support_claim"
] as const;

const SECTION_ORDER = [
  "overview",
  "progress",
  "decisions",
  "completed",
  "in_progress",
  "waiting_for_others",
  "open_questions",
  "next_week"
] as const;

type SafeClaim = {
  claimId: string;
  text: string;
  sourceRefs: string[];
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function records(snapshot: WorkWeeklySourceSnapshot, refs: string[]) {
  return refs.map((ref) => resolveWorkWeeklySourceRecord(snapshot, ref)).filter(
    (value): value is NonNullable<typeof value> => value !== null
  );
}

function findings(snapshot: WorkWeeklySourceSnapshot, refs: string[]) {
  const allow = new Set(refs);
  return snapshot.findings.filter((finding) => allow.has(finding.sourceRef));
}

function linkedFindings(snapshot: WorkWeeklySourceSnapshot, refs: string[]) {
  const allow = new Set(refs);
  return snapshot.findings.filter((finding) => allow.has(finding.sourceRef)
    || finding.evidenceRefs.some((ref) => allow.has(ref)));
}

function todos(snapshot: WorkWeeklySourceSnapshot, refs: string[]) {
  const allow = new Set(refs);
  return snapshot.todos.filter((todo) => allow.has(todo.sourceRef));
}

function todoEvents(snapshot: WorkWeeklySourceSnapshot, refs: string[]) {
  const allow = new Set(refs);
  return snapshot.todoEvents.filter((event) => allow.has(event.sourceRef));
}

function evidence(snapshot: WorkWeeklySourceSnapshot, refs: string[]) {
  const allow = new Set(refs);
  return snapshot.evidence.filter((item) => allow.has(item.sourceRef));
}

function distinctSourceCount(snapshot: WorkWeeklySourceSnapshot, refs: string[]) {
  const identities = refs.map((ref) => snapshot.identities.find((identity) =>
    identity.included && identity.sourceRef === ref
  )).filter((value): value is NonNullable<typeof value> => Boolean(value));
  const keys = new Set<string>();
  for (const identity of identities) {
    const finding = snapshot.findings.find((item) => item.sourceRef === identity.sourceRef);
    const evidenceItem = snapshot.evidence.find((item) => item.sourceRef === identity.sourceRef);
    const todo = snapshot.todos.find((item) => item.sourceRef === identity.sourceRef);
    const todoEvent = snapshot.todoEvents.find((item) => item.sourceRef === identity.sourceRef);
    if (finding) keys.add(`meeting:${finding.meetingId}`);
    else if (evidenceItem) keys.add(`meeting:${evidenceItem.meetingId}`);
    else if (todo) keys.add(todo.sourceMeetingId
      ? `meeting:${todo.sourceMeetingId}`
      : `todo:${todo.id}`);
    else if (todoEvent) {
      const eventTodo = snapshot.todos.find((item) => item.id === todoEvent.todoId);
      keys.add(eventTodo?.sourceMeetingId
        ? `meeting:${eventTodo.sourceMeetingId}`
        : `todo:${todoEvent.todoId}`);
    }
    else keys.add(`${identity.sourceKind}:${identity.sourceId}`);
  }
  return keys.size;
}

function hasExplicitCausalLanguage(snapshot: WorkWeeklySourceSnapshot, refs: string[]) {
  return evidence(snapshot, refs).some((item) =>
    /(?:因为|由于|考虑到|原因是|之所以|因此|所以|基于)/u.test(item.text)
  );
}

function hasDeadlineSource(snapshot: WorkWeeklySourceSnapshot, refs: string[]) {
  for (const finding of findings(snapshot, refs)) {
    const structured = object(finding.structuredData);
    const dueAt = typeof structured?.dueAt === "string" ? structured.dueAt : null;
    const expression = typeof structured?.originalDueExpression === "string"
      ? structured.originalDueExpression.trim()
      : null;
    if (dueAt || expression) return true;
  }
  for (const todo of todos(snapshot, refs)) {
    const date = todo.stateAtWeekEnd?.currentDueDate ?? todo.current.currentDueDate;
    if (date) return true;
  }
  for (const event of todoEvents(snapshot, refs)) {
    if (event.changedFields.includes("currentDueDate") && event.stateAfter?.currentDueDate) {
      return true;
    }
  }
  return false;
}

// A conservative lexical backstop, not a semantic classifier. The independent
// verifier also checks the actual meaning of every claim regardless of its tag.
function hasDisguisedHighRiskClaim(claim: WorkWeeklyGeneratedClaim) {
  // Typed claims may contain necessary subordinate explanations (e.g. a
  // decision to keep already-written code disabled). Do not relabel those
  // clauses by keyword; their complete meaning is independently verified.
  if (claim.claimType !== "fact" && claim.claimType !== "person"
    && claim.claimType !== "temporal_order") return false;
  // A verified absence of an actor's commitment is not an affirmative
  // commitment. Remove only that predicate, keeping later affirmative clauses
  // and direct double negations available to the conservative backstop.
  const affirmative = claim.text.replace(
    /(?<!不是|并非|不能说)(?:无人|没有(?:任何)?人)(?:明确)?承诺/gu, ""
  ).replace(
    /(?:尚未|还未|并未|未|不|没有|无|是否|待)(?:明确)?(?:承诺|决定|确认|接受|完成)/gu, ""
  );
  // Match the frequency word, not a character overlap such as 汇总 + 是否.
  const always = /总是/u.test(affirmative) && Array.from(
    new Intl.Segmenter("zh", { granularity: "word" }).segment(affirmative)
  ).some(({ segment }) => segment === "总是");
  return /承诺(?:负责|完成|交付|跟进|检查|采用)|明确接受(?:负责|完成|交付)|答应负责/u.test(affirmative)
    || /(?:已|已经)(?:实际|现实)(?:履行|交付)/u.test(affirmative)
    || /截止(?:日期|时间)(?:是|为)|必须.{0,24}(?:之前|前)完成/u.test(affirmative)
    || /导致|因此|所以/u.test(affirmative)
    || /反复|从未|历史上第一次/u.test(affirmative) || always;
}

function confirmedPersonSource(snapshot: WorkWeeklySourceSnapshot, refs: string[]) {
  for (const finding of findings(snapshot, refs)) {
    const structured = object(finding.structuredData);
    if (typeof structured?.candidateOwner === "string" && structured.candidateOwner.trim()) return true;
    if (typeof structured?.rawActorLabel === "string" && structured.rawActorLabel.trim()) return true;
  }
  return todos(snapshot, refs).some((todo) => Boolean(todo.current.ownerLabel));
}

function projectClaim(input: {
  snapshot: WorkWeeklySourceSnapshot;
  claim: WorkWeeklyGeneratedClaim;
  verdict: WorkWeeklyVerifierItem;
  onReject?: (reasonCode: string) => void;
}): SafeClaim | null {
  const { snapshot, claim, verdict } = input;
  const reject = (code: string) => { input.onReject?.(code); return null; };
  if (verdict.verdict !== "entailed"
    || verdict.issueCodes.length > 0
    || verdict.supportedSourceRefs.length === 0) return reject(`verifier_${verdict.verdict === "entailed" ? "issues" : verdict.verdict}`);
  const refs = [...new Set(verdict.supportedSourceRefs)].sort();
  const sources = records(snapshot, refs);
  if (sources.length !== refs.length || sources.some((source) =>
    source.sourceKind === "meeting" || source.sourceKind === "project"
  )) return reject("source_not_allowed");
  if (hasDisguisedHighRiskClaim(claim)) return reject("claim_type_mismatch");
  const claimFindings = linkedFindings(snapshot, refs);
  const hasDecisionSource = claimFindings.some((finding) => finding.kind === "decision");
  const hasPlanChangeSource = claimFindings.some((finding) => finding.kind === "plan_change");
  const explicitDecision = /最终决定|已经定案|已定案|(?:决定|拍板|敲定)(?:采用|上线|执行|实施|取消|停止|提供|不提供|改为)/u.test(claim.text);
  // A verified plan change can describe an arrangement in the decision category;
  // it is not authority for an explicit claim that a decision has been finalized.
  if ((claim.claimType === "decision" && !hasDecisionSource && !hasPlanChangeSource)
    || (explicitDecision && !hasDecisionSource)) return reject("decision_source_missing");
  switch (claim.claimType) {
    case "decision": {
      // Finality and necessary qualifications are semantic verifier judgments;
      // requiring one particular uncertainty phrase rejects valid paraphrases.
      break;
    }
    case "commitment": {
      const commitment = linkedFindings(snapshot, refs).find((finding) => finding.kind === "commitment");
      if (!commitment) return reject("commitment_source_missing");
      break;
    }
    case "completion": {
      if (!workWeeklyCompletionClaimSupported(snapshot, refs)) return reject("completion_not_current_week_event");
      break;
    }
    case "deadline":
      if (!hasDeadlineSource(snapshot, refs)) return reject("deadline_source_missing");
      break;
    case "causality":
      if (!hasExplicitCausalLanguage(snapshot, refs)) return reject("causality_source_missing");
      break;
    case "frequency": {
      const count = distinctSourceCount(snapshot, refs);
      if (/一直|总是|从未|历史上第一次/u.test(claim.text)) return reject("frequency_not_supported");
      if (/反复|很多次/u.test(claim.text) ? count < 3 : count < 2) return reject("frequency_not_supported");
      break;
    }
    case "person":
      if (!confirmedPersonSource(snapshot, refs)) return reject("person_source_missing");
      break;
    case "temporal_order":
      if (distinctSourceCount(snapshot, refs) < 2) return reject("temporal_sources_missing");
      break;
    case "fact":
      break;
  }
  return {
    claimId: claim.id,
    text: claim.text,
    sourceRefs: refs
  };
}

function exactTextKey(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}

function exactPublicationKey(item: WorkWeeklyGeneratedItem, text: string) {
  // An identical attention claim adds nothing to an already published fact.
  // Interpretation has an explicit cautious stance and must retain it.
  return `${item.itemType === "interpretation" ? "interpretation" : "fact"}:${exactTextKey(text)}`;
}

function mergeExactClaims(claims: SafeClaim[]) {
  const unique = new Map<string, SafeClaim>();
  for (const claim of claims) {
    const key = exactTextKey(claim.text);
    const previous = unique.get(key);
    if (previous) previous.sourceRefs = [...new Set([...previous.sourceRefs, ...claim.sourceRefs])].sort();
    else unique.set(key, { ...claim, sourceRefs: [...claim.sourceRefs] });
  }
  return [...unique.values()];
}

function sectionAllowsClaim(snapshot: WorkWeeklySourceSnapshot, section: WorkWeeklyGeneratedItem["section"], claim: SafeClaim) {
  if (section === "completed") return workWeeklyCompletionClaimSupported(snapshot, claim.sourceRefs);
  // Actual progress is checked by the verifier, independent of wording.
  return true;
}

export function applyWorkWeeklyClaimPublicationPolicy(input: {
  snapshot: WorkWeeklySourceSnapshot;
  items: WorkWeeklyGeneratedItem[];
  verdicts: WorkWeeklyVerifierItem[];
  onClaims?: (claims: WorkWeeklyClaimPublicationTrace[]) => void;
}): WorkWeeklyPublishedItemInput[] {
  const snapshot = assertWorkWeeklySnapshotAuthority({
    snapshot: input.snapshot,
    accountId: input.snapshot.accountId
  });
  const trace = input.items.flatMap((item) => item.claims.map((claim): WorkWeeklyClaimPublicationTrace => ({
    itemId: item.id, claimId: claim.id, section: item.section, claimType: claim.claimType,
    sourceRefs: claim.sourceRefs, outcome: "rejected", reasonCode: "invalid_contract", publishedSortOrder: null
  })));
  const traceById = new Map(trace.map((entry) => [entry.claimId, entry]));
  const finish = (items: WorkWeeklyPublishedItemInput[]) => { input.onClaims?.(trace); return items; };
  // Keep the direct policy seam as strict as the structured Provider path.
  const parsed = WorkWeeklySynthesizerResponseSchema.safeParse({ items: input.items });
  if (!parsed.success) return finish([]);
  const allowlist = new Set(snapshot.allowlistedSourceRefs);
  const generatedClaims = parsed.data.items.flatMap((item) => item.claims);
  if (generatedClaims.some((claim) => claim.sourceRefs.some((ref) => !allowlist.has(ref)))) return finish([]);
  try {
    validateWorkWeeklyVerifierOutput({ response: { items: input.verdicts }, claims: generatedClaims });
  } catch { return finish([]); }
  const verdictByClaim = new Map(input.verdicts.map((verdict) => [verdict.claimId, verdict]));
  const published: Array<WorkWeeklyPublishedItemInput & { sourceItemId: string }> = [];
  const seenFacts = new Map<string, SafeClaim>();
  const candidates: Array<{ item: WorkWeeklyGeneratedItem; claims: SafeClaim[] }> = [];
  // Prefer a specific fact, then its overview, over an identical attention claim.
  const sectionPriority = (item: WorkWeeklyGeneratedItem) =>
    item.section === "next_week" ? 2 : item.section === "overview" ? 1 : 0;
  const orderedItems = [...parsed.data.items].sort((a, b) =>
    sectionPriority(a) - sectionPriority(b)
  );
  for (const item of orderedItems) {
    if (item.section === "next_week" && item.claims.length !== 1) {
      item.claims.forEach((claim) => { traceById.get(claim.id)!.reasonCode = "attention_requires_single_claim"; });
      continue;
    }
    if (item.claims.some((claim) => verdictByClaim.get(claim.id)?.issueCodes.some((issue) =>
      ["mixed_topics", "non_atomic_claim", "section_mismatch", "invalid_attention_target"].includes(issue)
    ))) {
      item.claims.forEach((claim) => { traceById.get(claim.id)!.reasonCode = "item_verifier_issue"; });
      continue;
    }
    const projected = item.claims.map((claim) => {
      const verdict = verdictByClaim.get(claim.id);
      const entry = traceById.get(claim.id)!;
      const safe = verdict ? projectClaim({ snapshot, claim, verdict, onReject: (code) => { entry.reasonCode = code; } }) : null;
      if (safe && !sectionAllowsClaim(snapshot, item.section, safe)) {
        entry.reasonCode = `section_${item.section}_not_supported`;
        return null;
      }
      return safe;
    }).filter((claim): claim is SafeClaim => claim !== null);
    // Claims sharing a source may contain each other's conditions. If one is
    // rejected, do not publish a now-unqualified remainder from that source.
    const rejectedRefs = new Set(item.claims.filter((claim) => !projected.some((safe) => safe.claimId === claim.id))
      .flatMap((claim) => [...claim.sourceRefs, ...linkedFindings(snapshot, claim.sourceRefs).map((finding) => finding.sourceRef)]));
    const independent = projected.filter((claim) => {
      const relatedRefs = [...claim.sourceRefs, ...linkedFindings(snapshot, claim.sourceRefs).map((finding) => finding.sourceRef)];
      if (!relatedRefs.some((ref) => rejectedRefs.has(ref))) return true;
      traceById.get(claim.claimId)!.reasonCode = "related_claim_rejected";
      return false;
    });
    if (item.section === "next_week" && projected.length !== item.claims.length) {
      projected.forEach((claim) => { traceById.get(claim.claimId)!.reasonCode = "attention_grounds_not_verified"; });
      continue;
    }
    const safeClaims = mergeExactClaims(independent).filter((claim) => {
      const key = exactPublicationKey(item, claim.text);
      const previous = seenFacts.get(key);
      if (previous) {
        previous.sourceRefs = [...new Set([...previous.sourceRefs, ...claim.sourceRefs])].sort();
        return false;
      }
      seenFacts.set(key, claim);
      return true;
    });
    if (safeClaims.length === 0) continue;
    candidates.push({ item, claims: safeClaims });
  }
  for (const { item, claims: safeClaims } of candidates) {
    const content = safeClaims.map((claim) => claim.text).join("；");
    const text = item.section === "next_week"
      ? `AI建议关注：${content}`
      : item.itemType === "interpretation"
        ? `根据本周记录，可谨慎理解为：${content}`
        : content;
    const candidate = WorkWeeklyPublishedItemInputSchema.safeParse({
      section: item.section,
      text,
      sourceRefs: [...new Set(safeClaims.flatMap((claim) => claim.sourceRefs))].sort(),
      verificationState: "verified",
      sortOrder: 0
    });
    if (!candidate.success) continue;
    published.push({ ...candidate.data, sourceItemId: item.id });
  }
  published.sort((left, right) =>
    SECTION_ORDER.indexOf(left.section) - SECTION_ORDER.indexOf(right.section)
    || left.sourceItemId.localeCompare(right.sourceItemId)
  );
  const result = published.map(({ sourceItemId: _sourceItemId, ...item }, index) => ({
    ...item,
    sortOrder: index
  }));
  for (const entry of trace) {
    if (entry.reasonCode !== "invalid_contract") continue;
    const original = generatedClaims.find((claim) => claim.id === entry.claimId)!;
    const originalItem = parsed.data.items.find((item) => item.id === entry.itemId)!;
    const holder = candidates.find(({ item, claims }) =>
      claims.some((claim) => exactPublicationKey(item, claim.text) === exactPublicationKey(originalItem, original.text)));
    const order = published.findIndex((item) => item.sourceItemId === holder?.item.id);
    if (order < 0 || !holder) { entry.reasonCode = "item_output_invalid"; continue; }
    entry.outcome = holder.claims.some((claim) => claim.claimId === entry.claimId) ? "published" : "merged";
    entry.reasonCode = entry.outcome === "merged" ? "exact_duplicate" : "accepted";
    entry.publishedSortOrder = order;
  }
  return finish(result);
}

export function buildDeterministicWorkWeeklySourceOutline(snapshot: WorkWeeklySourceSnapshot) {
  const safe = assertWorkWeeklySnapshotAuthority({ snapshot, accountId: snapshot.accountId });
  return {
    policyVersion: WORK_WEEKLY_PUBLICATION_POLICY_VERSION,
    snapshotDigest: safe.digest,
    sourceSummary: safe.summary,
    confirmedFindingOutline: safe.findings.map((finding) => ({
      sourceRef: finding.sourceRef,
      kind: finding.kind,
      title: finding.title
    })),
    todoOutline: safe.todos.map((todo) => ({
      sourceRef: todo.sourceRef,
      title: todo.current.title,
      status: todo.stateAtWeekEnd?.status ?? todo.current.status,
      kind: todo.stateAtWeekEnd?.kind ?? todo.current.kind
    }))
  } as const;
}

export function assessWorkWeeklyCoverage(input: {
  snapshot: WorkWeeklySourceSnapshot;
  generated: WorkWeeklyGeneratedItem[];
  verdicts: WorkWeeklyVerifierItem[];
  coverage: WorkWeeklyCoverageAssessment[] | null;
  publicationClaims: WorkWeeklyClaimPublicationTrace[];
}): WorkWeeklyQualityAssessment {
  const refs = workWeeklyCoverageSourceRefs(input.snapshot);
  const result: WorkWeeklyQualityAssessment = {
    status: "insufficient", reasonCodes: [], reviewIssues: [], sourceCount: refs.length, coveredSourceCount: 0,
    partialSourceCount: 0, omittedSourceCount: 0, notApplicableSourceCount: 0, unassessedSourceCount: 0
  };
  const issues = new Set<string>();
  const addIssue = (sourceRef: WorkWeeklyReviewIssue["sourceRef"], reasonCode: WorkWeeklyReviewIssue["reasonCode"]) => {
    issues.add(reasonCode);
    if (!result.reviewIssues.some((issue) => issue.sourceRef === sourceRef && issue.reasonCode === reasonCode)) {
      result.reviewIssues.push({ sourceRef, reasonCode });
    }
  };
  if (input.snapshot.summary.truncated) addIssue(null, "source_pack_truncated");
  if (input.snapshot.summary.historyCompleteness !== "exact") addIssue(null, "source_history_incomplete");
  if (!input.coverage) {
    result.unassessedSourceCount = refs.length;
    result.reasonCodes = [...issues, "coverage_not_assessed"];
    return result;
  }
  try {
    validateWorkWeeklyCoverage({ coverage: input.coverage, snapshot: input.snapshot,
      claims: input.generated.flatMap((item) => item.claims) });
  } catch {
    result.unassessedSourceCount = refs.length;
    result.reasonCodes = [...issues, "coverage_contract_invalid"];
    return result;
  }
  const generatedClaims = input.generated.flatMap((item) => item.claims);
  for (const entry of input.coverage) {
    if (entry.status === "partial") {
      result.partialSourceCount++; addIssue(entry.sourceRef, entry.reasonCode === "missing_qualification" ? "missing_qualification" : "missing_key_content"); continue;
    }
    if (entry.status === "omitted") {
      result.omittedSourceCount++; addIssue(entry.sourceRef, entry.reasonCode === "missing_qualification" ? "missing_qualification" : "missing_key_content"); continue;
    }
    if (entry.status === "covered" || entry.reasonCode === "duplicate") {
      const survives = entry.claimIds.every((id) => {
        const audited = generatedClaims.find((claim) => claim.id === id)!;
        // Coverage audits content, not the survival of redundant item IDs. A
        // filtered item may have identical content already safely published;
        // a shorter overview cannot stand in for a missing qualification.
        return input.publicationClaims.some((trace) => {
          if (trace.outcome === "rejected" || trace.publishedSortOrder === null) return false;
          const published = generatedClaims.find((claim) => claim.id === trace.claimId);
          if (!published || exactTextKey(published.text) !== exactTextKey(audited.text)) return false;
          const verdict = input.verdicts.find((claim) => claim.claimId === trace.claimId);
          return verdict?.verdict === "entailed" && verdict.issueCodes.length === 0
            && (entry.reasonCode === "duplicate"
              || workWeeklyCoverageClaimIsRelated(input.snapshot, entry.sourceRef, verdict.supportedSourceRefs));
        });
      });
      if (!survives) { result.partialSourceCount++; addIssue(entry.sourceRef, "coverage_claim_filtered"); continue; }
      if (entry.reasonCode === "duplicate") result.notApplicableSourceCount++;
      else result.coveredSourceCount++;
      continue;
    }
    const finding = input.snapshot.findings.find((source) => source.sourceRef === entry.sourceRef);
    const todo = input.snapshot.todos.find((source) => source.sourceRef === entry.sourceRef);
    const event = input.snapshot.todoEvents.find((source) => source.sourceRef === entry.sourceRef);
    const sourceText = finding ? `${finding.title}\n${finding.body}` : "";
    // A canonical open issue or condition cannot be hidden as generic background.
    const actionable = Boolean(todo || (event && event.localDate >= input.snapshot.scope.weekStart
      && event.localDate <= input.snapshot.scope.observedThrough) || (finding && (
      ["decision", "commitment", "open_question", "plan_change", "action_item"].includes(finding.kind)
      || /如果|只有|除.{0,12}外|不代表|尚未|未定|未确认|待确认|依赖|负责人|截止|前提|条件/u.test(sourceText)
    )));
    const date = finding ? input.snapshot.meetings.find((meeting) => meeting.id === finding.meetingId)?.meetingDate : event?.localDate;
    const demonstrablyOutside = Boolean(date && (date < input.snapshot.scope.weekStart || date > input.snapshot.scope.observedThrough));
    if ((entry.reasonCode === "background_only" && actionable)
      || (entry.reasonCode === "outside_week" && (!demonstrablyOutside || actionable))) {
      result.omittedSourceCount++; addIssue(entry.sourceRef, "coverage_not_applicable_invalid");
    } else result.notApplicableSourceCount++;
  }
  const hasSafeItems = input.publicationClaims.some((claim) => claim.outcome !== "rejected" && claim.publishedSortOrder !== null);
  if (!hasSafeItems) issues.add("no_safe_items");
  result.reasonCodes = [...issues].sort();
  result.status = !hasSafeItems ? "insufficient" : issues.size === 0 ? "passed" : "needs_review";
  return result;
}

export type WorkWeeklyGenerationPipelineResult =
  | {
    status: "verified" | "needs_review";
    items: WorkWeeklyPublishedItemInput[];
    synthesizerProfile: string;
    verifierProfile: string;
    quality_assessment: WorkWeeklyQualityAssessment;
  }
  | {
    status: "insufficient_sources" | "no_safe_items" | "verifier_unavailable" | "quality_insufficient";
    items: [];
    outline: ReturnType<typeof buildDeterministicWorkWeeklySourceOutline>;
    quality_assessment: WorkWeeklyQualityAssessment;
  };

export async function runWorkWeeklyGenerationPipeline(input: {
  accountId: string;
  snapshot: WorkWeeklySourceSnapshot;
  synthesizer: WorkWeeklySynthesizer | null;
  verifier: WorkWeeklyClaimVerifier | null;
  onBeforeVerify?: () => void | Promise<void>;
  onTrace?: (trace: WorkWeeklyGenerationTrace) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<WorkWeeklyGenerationPipelineResult> {
  const snapshot = assertWorkWeeklySnapshotAuthority(input);
  const outline = buildDeterministicWorkWeeklySourceOutline(snapshot);
  const unassessed = () => assessWorkWeeklyCoverage({ snapshot, generated: [], verdicts: [], coverage: null, publicationClaims: [] });
  const traceScope = { snapshotDigest: snapshot.digest, inputPackDigest: snapshot.inputPackDigest };
  if (snapshot.findings.length === 0 && snapshot.todos.length === 0
    && snapshot.todoEvents.length === 0) {
    return { status: "insufficient_sources", items: [], outline, quality_assessment: unassessed() };
  }
  if (!input.synthesizer || !input.verifier) {
    return { status: "verifier_unavailable", items: [], outline, quality_assessment: unassessed() };
  }
  const generated = await input.synthesizer.synthesize({
    accountId: input.accountId,
    snapshot,
    signal: input.signal
  });
  await input.onTrace?.({ ...traceScope, stage: "synthesized", generated });
  const claims = generated.flatMap((item) => item.claims);
  if (claims.length === 0) return { status: "no_safe_items", items: [], outline, quality_assessment: unassessed() };
  await input.onBeforeVerify?.();
  let coverage: WorkWeeklyCoverageAssessment[] | null = null;
  let auditDetails: WorkWeeklyVerificationAuditDetails | undefined;
  const verdicts = await input.verifier.verify({
    accountId: input.accountId,
    snapshot,
    claims,
    items: generated,
    onCoverage: (assessments) => { coverage = assessments; },
    onAuditDetails: (details) => { auditDetails = details; },
    signal: input.signal
  });
  await input.onTrace?.({ ...traceScope, stage: "verified", verdicts, coverage, ...(auditDetails ? { auditDetails } : {}) });
  let publicationClaims: WorkWeeklyClaimPublicationTrace[] = [];
  const items = applyWorkWeeklyClaimPublicationPolicy({ snapshot, items: generated, verdicts,
    onClaims: (claims) => { publicationClaims = claims; } });
  const quality_assessment = assessWorkWeeklyCoverage({ snapshot, generated, verdicts, coverage, publicationClaims });
  if (quality_assessment.status !== "passed" || publicationClaims.some((claim) => claim.outcome === "rejected")) {
    const rejectionReasons: Record<string, number> = {};
    for (const claim of publicationClaims) if (claim.outcome === "rejected") {
      rejectionReasons[claim.reasonCode] = (rejectionReasons[claim.reasonCode] ?? 0) + 1;
    }
    const knownIssues = new Set<string>([...WORK_WEEKLY_SAFETY_ISSUE_CODES,
      "mixed_topics", "non_atomic_claim", "section_mismatch", "invalid_attention_target", "missing_qualification", "decision_finality_conflict"]);
    const verifierIssueCounts: Record<string, number> = {};
    for (const verdict of verdicts) for (const issue of verdict.issueCodes) {
      const reason = knownIssues.has(issue) ? issue : "other";
      verifierIssueCounts[reason] = (verifierIssueCounts[reason] ?? 0) + 1;
    }
    // Policy-owned categories/counts only; raw verifier issues and trace bodies stay private.
    console.warn(JSON.stringify({ component: "work-weekly-publication", stage: "publication", qualityStatus: quality_assessment.status,
      generatedItemCount: generated.length, publishableItemCount: items.length, rejectionReasons, verifierIssueCounts,
      qualityReasonCodes: quality_assessment.reasonCodes,
      sourceCount: quality_assessment.sourceCount, coveredSourceCount: quality_assessment.coveredSourceCount,
      partialSourceCount: quality_assessment.partialSourceCount, omittedSourceCount: quality_assessment.omittedSourceCount,
      unassessedSourceCount: quality_assessment.unassessedSourceCount }));
  }
  await input.onTrace?.({ ...traceScope, stage: "published", publicationStatus: "candidate_only", items, claims: publicationClaims, quality_assessment });
  if (items.length === 0) return { status: "no_safe_items", items: [], outline, quality_assessment };
  if (quality_assessment.status === "insufficient") return { status: "quality_insufficient", items: [], outline, quality_assessment };
  return {
    status: quality_assessment.status === "needs_review" ? "needs_review" : "verified",
    items,
    synthesizerProfile: input.synthesizer.profile.id,
    verifierProfile: input.verifier.profile.id,
    quality_assessment
  };
}

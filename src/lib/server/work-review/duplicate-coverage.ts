import { createHash } from "node:crypto";
import { z } from "zod";
import { WorkCanonicalSegmentsSchema } from "@/lib/domain/work-review";

// This is one optional task in the existing Verifier request, not a second
// verifier/service. A claim being true does not prove that another covers it.
type CoverageCandidate = {
  id: string; kind: string; title: string; body: string;
  evidenceIds?: string[]; evidenceSegmentIds?: string[];
  structuredData: {
    candidateOwner: string | null; dueAt: string | null; originalDueExpression: string | null;
    decisionFinality: string | null; actionBasis: string | null;
    planStages: Array<{ status: string; content: string; evidenceIds?: string[]; evidenceRefs?: Array<{ segmentId: string }> }>;
  };
  claims: Array<{ claimType: string; text: string; evidenceIds?: string[]; evidenceSegmentIds?: string[];
    evaluation?: { publicationAction: string } }>;
};
export type WorkDuplicateRelation = { duplicateId: string; coveredByIds: string[] };
export type WorkDuplicateCoverageScope = { accountId: string; meetingId: string; publicationId: string; canonicalDigest: string };
export type WorkDuplicatePublicationCopies = ReadonlyMap<string, {
  semanticCopy: { title: string; body: string };
  renderedCopy: { title: string; body: string };
}>;
const ids = (values: string[]) => [...new Set(values)].sort();

export function workDuplicateCoverageSubject(candidate: CoverageCandidate) {
  const data = candidate.structuredData;
  return {
    id: candidate.id, kind: candidate.kind, title: candidate.title, body: candidate.body,
    candidateOwner: data.candidateOwner, dueAt: data.dueAt, originalDueExpression: data.originalDueExpression,
    decisionFinality: data.decisionFinality, actionBasis: data.actionBasis,
    evidenceIds: ids(candidate.evidenceIds ?? candidate.evidenceSegmentIds ?? []),
    facts: candidate.claims.filter(c => c.evaluation?.publicationAction !== "suppress").map(c => ({
      type: c.claimType, text: c.text, evidenceIds: ids(c.evidenceIds ?? c.evidenceSegmentIds ?? [])
    })),
    stages: data.planStages.map(s => ({ status: s.status, text: s.content,
      evidenceIds: ids(s.evidenceIds ?? s.evidenceRefs?.map(r => r.segmentId) ?? []) }))
  };
}
export type WorkDuplicateCoverageRequest = {
  relationId: string;
  original: ReturnType<typeof workDuplicateCoverageSubject>;
  coveredBy: Array<ReturnType<typeof workDuplicateCoverageSubject>>;
};

export function buildWorkDuplicateCoverageRequests(input: {
  candidates: CoverageCandidate[]; duplicates: WorkDuplicateRelation[];
  scope: WorkDuplicateCoverageScope; segments: unknown[];
}): WorkDuplicateCoverageRequest[] {
  const allowed = new Set(WorkCanonicalSegmentsSchema.parse(input.segments).map(s => s.id));
  const byId = new Map(input.candidates.map(c => [c.id, c]));
  if (byId.size !== input.candidates.length) throw new Error("work_duplicate_coverage_input_invalid");
  return input.duplicates.map(row => {
    const members = [row.duplicateId, ...row.coveredByIds].map(id => byId.get(id));
    if (!row.coveredByIds.length || members.some(c => !c) || new Set([row.duplicateId, ...row.coveredByIds]).size !== members.length
      || members.some(c => c!.kind !== members[0]!.kind)) throw new Error("work_duplicate_coverage_input_invalid");
    const [original, ...coveredBy] = members.map(c => workDuplicateCoverageSubject(c!));
    for (const subject of [original, ...coveredBy]) {
      if (!subject.facts.length || !subject.evidenceIds.length || subject.evidenceIds.some(id => !allowed.has(id))
        || [...subject.facts, ...subject.stages].some(f => !f.evidenceIds.length || f.evidenceIds.some(id => !subject.evidenceIds.includes(id)))) {
        throw new Error("work_duplicate_coverage_evidence_invalid");
      }
    }
    const relationId = `work_coverage_${createHash("sha256").update(JSON.stringify({
      version: 1, scope: input.scope, original, coveredBy
    })).digest("hex")}`;
    return { relationId, original, coveredBy };
  });
}

const CoverageReason = z.enum(["evaluated", "missing_or_invalid", "evidence_invalid", "capacity", "verifier_unavailable", "request_failed"]);
const CoverageWireItem = z.object({
  relationId: z.string().min(1), verdict: z.enum(["complete", "partial", "uncertain"]),
  supportedEvidenceIds: z.array(z.string().min(1)).max(576), reason: CoverageReason.optional()
}).strict();
export const WorkDuplicateCoverageEvaluationSchema = CoverageWireItem.extend({
  reason: CoverageReason
}).strict();
export type WorkDuplicateCoverageEvaluation = z.infer<typeof WorkDuplicateCoverageEvaluationSchema>;

/** Missing/invalid coverage never poisons independent Claim verdicts or grants deletion. */
export function validateWorkDuplicateCoverageOutput(response: unknown, requests: WorkDuplicateCoverageRequest[]): WorkDuplicateCoverageEvaluation[] {
  const rows = Array.isArray(response) && response.length <= 24 ? response : [];
  return requests.map(request => {
    const matches = rows.filter(row => row && typeof row === "object" && row.relationId === request.relationId);
    const parsed = matches.length === 1 ? CoverageWireItem.safeParse(matches[0]) : null;
    const uncertain = (reason: WorkDuplicateCoverageEvaluation["reason"]): WorkDuplicateCoverageEvaluation =>
      ({ relationId: request.relationId, verdict: "uncertain", reason, supportedEvidenceIds: [] });
    if (!parsed?.success) return uncertain("missing_or_invalid");
    const item = parsed.data, subjects = [request.original, ...request.coveredBy];
    const allowed = new Set(subjects.flatMap(s => s.evidenceIds));
    if (new Set(item.supportedEvidenceIds).size !== item.supportedEvidenceIds.length
      || item.supportedEvidenceIds.some(id => !allowed.has(id))
      || (item.verdict === "complete" && subjects.some(s =>
        !s.facts[0]?.evidenceIds.some(id => item.supportedEvidenceIds.includes(id))))) return uncertain("evidence_invalid");
    return { ...item, reason: item.reason ?? "evaluated" };
  });
}

export const WorkDuplicateDecisionSchema = z.object({
  duplicateId: z.string(), coveredByIds: z.array(z.string()), relationId: z.string().nullable(),
  applied: z.boolean(), reason: z.enum(["complete", "partial", "uncertain", "unchecked", "content_changed",
    "source_unavailable", "coverer_unavailable", "dependent_deletion", "invalid_relation", "metadata_conflict"])
}).strict();
export type WorkDuplicateDecision = z.infer<typeof WorkDuplicateDecisionSchema>;

export function applyWorkDuplicateCoverage<Candidate extends CoverageCandidate & { publicationAction: string }>(
  candidates: Candidate[], duplicates: WorkDuplicateRelation[],
  coverage: { requests: WorkDuplicateCoverageRequest[]; evaluations: WorkDuplicateCoverageEvaluation[];
    publicationCopies?: WorkDuplicatePublicationCopies } = { requests: [], evaluations: [] }
) {
  const eligible = candidates.filter(c => c.publicationAction !== "suppress");
  const byId = new Map(eligible.map(c => [c.id, c]));
  const deletionSources = new Set(duplicates.map(row => row.duplicateId));
  const finalSubject = (candidate: Candidate) => {
    const projection = coverage.publicationCopies?.get(candidate.id);
    // No suffix stripping or fuzzy matching. The actual rendered copy must
    // exactly match the backend policy projection before ignoring its notes.
    const copy = projection && candidate.title === projection.renderedCopy.title
      && candidate.body === projection.renderedCopy.body ? projection.semanticCopy : undefined;
    return workDuplicateCoverageSubject(copy ? { ...candidate, ...copy } : candidate);
  };
  const decisions: WorkDuplicateDecision[] = duplicates.map(row => {
    const requests = coverage.requests.filter(r => r.original.id === row.duplicateId
      && JSON.stringify(r.coveredBy.map(c => c.id)) === JSON.stringify(row.coveredByIds));
    const request = requests.length === 1 ? requests[0] : undefined;
    const decision = (reason: WorkDuplicateDecision["reason"]): WorkDuplicateDecision =>
      ({ ...row, relationId: request?.relationId ?? null, applied: reason === "complete", reason });
    const source = byId.get(row.duplicateId), covering = row.coveredByIds.map(id => byId.get(id));
    if (!source) return decision("source_unavailable");
    if (!covering.length || byId.size !== eligible.length || duplicates.filter(r => r.duplicateId === row.duplicateId).length !== 1
      || new Set(row.coveredByIds).size !== row.coveredByIds.length || covering.some(c => c && c.kind !== source.kind)) return decision("invalid_relation");
    // No chain traversal or recursive replacement: every listed coverer must
    // survive in its own right. This also blocks self-coverage and cycles.
    if (row.coveredByIds.some(id => deletionSources.has(id))) return decision("dependent_deletion");
    if (covering.some(c => !c || c.publicationAction !== source.publicationAction)) return decision("coverer_unavailable");
    // High-risk cores shown only as questions have not passed the required
    // factual gate. Low-risk questions legitimately use show_as_question.
    if ([source, ...covering].some(c => ["decision", "commitment", "action_item", "plan_change"].includes(c!.kind)
      && c!.publicationAction !== "show_as_candidate")) return decision("coverer_unavailable");
    if (!request) return decision("unchecked");
    const evaluations = coverage.evaluations.filter(e => e.relationId === request.relationId);
    const evaluation = evaluations.length === 1 ? evaluations[0] : undefined;
    if (!evaluation || evaluation.reason !== "evaluated") return decision("uncertain");
    // Recheck the Evidence envelope at the application boundary as well.
    const wire = { relationId: evaluation.relationId, verdict: evaluation.verdict, supportedEvidenceIds: evaluation.supportedEvidenceIds };
    const checked = validateWorkDuplicateCoverageOutput([wire], [request])[0];
    if (checked.verdict !== "complete") return decision(checked.verdict);
    if (JSON.stringify(finalSubject(source)) !== JSON.stringify(request.original)
      || covering.some((c, i) => JSON.stringify(finalSubject(c!)) !== JSON.stringify(request.coveredBy[i]))) return decision("content_changed");
    const compatible = (["candidateOwner", "dueAt", "originalDueExpression", "decisionFinality", "actionBasis"] as const).every(field => {
      const value = source.structuredData[field];
      if (field === "actionBasis" && value !== "explicit_commitment") return covering.every(c => c!.structuredData[field] !== "explicit_commitment");
      return value === null || covering.every(c => c!.structuredData[field] === value);
    });
    return decision(compatible ? "complete" : "metadata_conflict");
  });
  const removed = decisions.filter(d => d.applied).map(({ duplicateId, coveredByIds }) => ({ duplicateId, coveredByIds }));
  const removedIds = new Set(removed.map(r => r.duplicateId));
  return { candidates: eligible.filter(c => !removedIds.has(c.id)), removed, decisions };
}

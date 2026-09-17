import { z } from "zod";
import {
  WorkAtomicClaimSchema, WorkAtomicClaimTypeSchema, WorkClaimPublicationActionSchema,
  WorkClaimRiskLevelSchema, WorkClaimSupportVerdictSchema, WorkExtractorCandidateDraftSchema,
  WorkMeetingCandidateKindSchema, WorkMeetingCandidateStructuredDataSchema, WorkReviewIdSchema,
  WorkEvidenceTimestampQualitySchema
} from "@/lib/domain/work-review";
import type { TranscriptSegment } from "@/lib/domain/types";
import { applyWorkMeetingOrganization, applyVerifiedWorkMeetingDuplicates, WorkMeetingOrganizationCheckpointSchema } from "./candidate-deduplication";
import { assembleWorkMeetingCandidates, attachWorkQuestionResolutionClaims, buildWorkCandidatePublicationProjection, partitionWorkMeetingCandidateReviewCapacity } from "./candidate-normalization";
import { buildWorkDuplicateCoverageRequests, validateWorkDuplicateCoverageOutput,
  WorkDuplicateCoverageEvaluationSchema, WorkDuplicateDecisionSchema } from "./duplicate-coverage";
import { WorkExtractorValidationSummarySchema } from "./analysis-provider";

export const WORK_MEETING_ANALYSIS_AUDIT_VERSION = "work_meeting_analysis_audit_v1";
const Ids = z.array(WorkReviewIdSchema).max(2048);
const Assembled = WorkExtractorCandidateDraftSchema.extend({
  id: WorkReviewIdSchema,
  claims: z.array(WorkAtomicClaimSchema).min(1).max(256),
  sourceWindowIndexes: z.array(z.number().int().nonnegative()),
  sourceDraftReferences: z.array(z.object({ windowIndex: z.number().int().nonnegative(), clientCandidateKey: WorkReviewIdSchema }).strict())
});
const Evaluated = z.object({
  id: WorkReviewIdSchema, kind: WorkMeetingCandidateKindSchema, title: z.string(), body: z.string(),
  structuredData: WorkMeetingCandidateStructuredDataSchema,
  publicationAction: WorkClaimPublicationActionSchema, riskLevel: WorkClaimRiskLevelSchema,
  generatorProfile: z.string(), generatorPromptVersion: z.string(), evidenceSegmentIds: Ids,
  timestampQualityBySegmentId: z.record(WorkEvidenceTimestampQualitySchema).optional(),
  claims: z.array(z.object({
    id: WorkReviewIdSchema, claimType: WorkAtomicClaimTypeSchema, text: z.string(), evidenceSegmentIds: Ids,
    evaluation: z.object({
      supportVerdict: WorkClaimSupportVerdictSchema, issueCodes: z.array(z.string()),
      riskLevel: WorkClaimRiskLevelSchema, publicationAction: WorkClaimPublicationActionSchema,
      confirmationRequired: z.boolean(), supportedEvidenceIds: Ids,
      generatorProfile: z.string(), verifierProfile: z.string(), verifierPromptVersion: z.string(), policyVersion: z.string()
    }).strict()
  }).strict())
}).strict();
export const WorkMeetingAnalysisAuditSchema = z.object({
  version: z.literal(WORK_MEETING_ANALYSIS_AUDIT_VERSION),
  extraction: z.array(z.object({
    windowIndex: z.number().int().nonnegative(), segmentCount: z.number().int().positive(),
    model: z.string(), promptVersion: z.string(), schemaVersion: z.string(),
    validation: WorkExtractorValidationSummarySchema.nullable()
  }).strict()).optional(),
  batches: z.array(z.object({ windowIndex: z.number().int().nonnegative(), candidates: z.array(WorkExtractorCandidateDraftSchema) }).strict()),
  sources: z.array(Assembled), organized: z.array(Assembled), evaluated: z.array(Evaluated),
  organization: WorkMeetingOrganizationCheckpointSchema,
  sourceToResult: z.array(z.object({ sourceCandidateId: WorkReviewIdSchema, resultCandidateId: WorkReviewIdSchema }).strict()),
  removed: z.array(z.object({ duplicateId: WorkReviewIdSchema, coveredByIds: Ids }).strict()),
  priorityIds: Ids, primaryIds: Ids, overflowIds: Ids,
  coverageEvaluations: z.array(WorkDuplicateCoverageEvaluationSchema).max(128).default([]),
  duplicateDecisions: z.array(WorkDuplicateDecisionSchema).max(128).default([]),
  ranking: z.object({ strategy: z.enum(["ai_complete", "full_fallback"]), missingPriorityIds: Ids }).strict().optional(),
  fates: z.array(z.object({
    sourceCandidateId: WorkReviewIdSchema, resultCandidateId: WorkReviewIdSchema,
    fate: z.enum(["primary", "overflow", "suppressed", "duplicate"]),
    reason: z.enum(["review_priority", "review_capacity", "publication_policy", "verified_coverage"]),
    coveredByIds: Ids
  }).strict())
}).strict();
export type WorkMeetingAnalysisAudit = z.infer<typeof WorkMeetingAnalysisAuditSchema>;

/** Audit is retained model output, never review or Finding authority. */
export function validateWorkMeetingAnalysisAudit(input: {
  audit: unknown; segments: TranscriptSegment[]; publicationId: string;
  accountId: string; meetingId: string; canonicalDigest: string;
  publishedCandidates: Array<{ id?: string }>;
}): WorkMeetingAnalysisAudit {
  const audit = WorkMeetingAnalysisAuditSchema.parse(input.audit);
  const allowed = new Set(input.segments.map(s => s.id));
  const assert = (condition: boolean) => { if (!condition) throw new Error("work_review_analysis_audit_invalid"); };
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, stable(v)])) : value;
  const equal = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
  // Recompute source IDs from this account/meeting/publication contract; an
  // internally consistent audit from another scope still cannot be attached.
  assert(equal(assembleWorkMeetingCandidates({ accountId: input.accountId, meetingId: input.meetingId,
    publicationId: input.publicationId, canonicalDigest: input.canonicalDigest,
    segments: input.segments, batches: audit.batches }), audit.sources));
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  if (audit.extraction) {
    assert(audit.extraction.length === audit.batches.length && unique(audit.extraction.map(item => String(item.windowIndex))));
    for (const item of audit.extraction) {
      const batch = audit.batches.find(batch => batch.windowIndex === item.windowIndex);
      assert(Boolean(batch) && (!item.validation || item.validation.retained === batch!.candidates.length));
    }
  }
  const closure = (ids: string[], parent: Set<string> = allowed) => assert(ids.length > 0 && unique(ids) && ids.every(id => parent.has(id)));
  for (const c of [...audit.batches.flatMap(b => b.candidates), ...audit.sources, ...audit.organized]) {
    closure(c.evidenceIds);
    for (const claim of c.claims) closure(claim.evidenceIds, new Set(c.evidenceIds));
    for (const stage of c.structuredData.planStages) closure(stage.evidenceIds, new Set(c.evidenceIds));
  }
  for (const c of [...audit.sources, ...audit.organized]) {
    assert(unique(c.claims.map(claim => claim.id)) && c.claims.every(claim => claim.candidateId === c.id));
  }
  for (const e of audit.organization.response.evidence) closure(e.evidenceSegmentIds);
  const replay = applyWorkMeetingOrganization(audit.sources, audit.organization.response, input.segments);
  assert(replay.skippedInvalidCount === 0 && equal(replay.sourceToResult, audit.sourceToResult));
  assert(equal(attachWorkQuestionResolutionClaims({ candidates: replay.candidates, segments: input.segments }), audit.organized));
  for (const c of audit.evaluated) {
    closure(c.evidenceSegmentIds);
    for (const claim of c.claims) {
      closure(claim.evidenceSegmentIds, new Set(c.evidenceSegmentIds));
      assert(unique(claim.evaluation.supportedEvidenceIds) && claim.evaluation.supportedEvidenceIds.every(id => claim.evidenceSegmentIds.includes(id)));
    }
    for (const stage of c.structuredData.planStages) for (const ref of stage.evidenceRefs) {
      assert(ref.publicationId === input.publicationId && c.evidenceSegmentIds.includes(ref.segmentId));
    }
    assert(Object.keys(c.timestampQualityBySegmentId ?? {}).every(id => allowed.has(id)));
  }
  const sourceIds = audit.sources.map(c => c.id), resultIds = audit.organized.map(c => c.id);
  assert(unique(sourceIds) && unique(resultIds) && unique(audit.evaluated.map(c => c.id)));
  assert(audit.evaluated.length === resultIds.length && audit.evaluated.every(c => resultIds.includes(c.id)));
  for (const c of audit.evaluated) {
    const original = audit.organized.find(item => item.id === c.id)!;
    assert(c.kind === original.kind && JSON.stringify(c.evidenceSegmentIds) === JSON.stringify(original.evidenceIds));
    assert(c.claims.length === original.claims.length && c.claims.every((claim, index) => {
      const raw = original.claims[index];
      return claim.id === raw.id && claim.text === raw.text && claim.claimType === raw.claimType
        && JSON.stringify(claim.evidenceSegmentIds) === JSON.stringify(raw.evidenceIds);
    }));
  }
  assert(audit.sourceToResult.length === sourceIds.length && unique(audit.sourceToResult.map(m => m.sourceCandidateId)));
  assert(audit.sourceToResult.every(m => sourceIds.includes(m.sourceCandidateId) && resultIds.includes(m.resultCandidateId)));
  assert(resultIds.every(id => audit.sourceToResult.some(m => m.resultCandidateId === id)));
  const rawRefs = audit.batches.flatMap(b => b.candidates.map(c => `${b.windowIndex}/${c.clientCandidateKey}`));
  const sourceRefs = audit.sources.flatMap(c => c.sourceDraftReferences.map(r => `${r.windowIndex}/${r.clientCandidateKey}`));
  assert(unique(rawRefs) && unique(sourceRefs) && rawRefs.length === sourceRefs.length && rawRefs.every(ref => sourceRefs.includes(ref)));
  const suppressed = audit.evaluated.filter(c => c.publicationAction === "suppress").map(c => c.id);
  const removedIds = audit.removed.map(row => row.duplicateId);
  const partition = [...audit.primaryIds, ...audit.overflowIds, ...suppressed, ...removedIds];
  assert(audit.primaryIds.length <= 20 && unique(partition) && partition.length === resultIds.length && partition.every(id => resultIds.includes(id)));
  for (const row of audit.removed) {
    assert(row.coveredByIds.length > 0 && unique(row.coveredByIds) && row.coveredByIds.every(id =>
      (audit.primaryIds.includes(id) || audit.overflowIds.includes(id)) && id !== row.duplicateId));
  }
  const requests = buildWorkDuplicateCoverageRequests({ candidates: audit.organized, duplicates: replay.duplicates,
    scope: { accountId: input.accountId, meetingId: input.meetingId, publicationId: input.publicationId, canonicalDigest: input.canonicalDigest },
    segments: input.segments });
  assert(unique(audit.coverageEvaluations.map(e => e.relationId)) && audit.coverageEvaluations.length === requests.length
    && audit.coverageEvaluations.every(e => requests.some(r => r.relationId === e.relationId)));
  // A meeting may have more pending relations than fit in any one response.
  for (const evaluation of audit.coverageEvaluations) {
    assert(equal(validateWorkDuplicateCoverageOutput([evaluation], requests.filter(r => r.relationId === evaluation.relationId))[0], evaluation));
  }
  // Rebuild policy-owned notes from retained facts, evaluations and Canonical.
  // No caller-supplied display annotation becomes deletion authority.
  const coverageIds = new Set(requests.flatMap(r => [r.original, ...r.coveredBy].map(c => c.id)));
  const publicationCopies = new Map(audit.evaluated.filter(c => coverageIds.has(c.id)).map(c => [c.id,
    buildWorkCandidatePublicationProjection({ candidate: audit.organized.find(raw => raw.id === c.id)!,
      publicationId: input.publicationId, segments: input.segments, timestampQualityBySegmentId: c.timestampQualityBySegmentId,
      evaluations: c.claims.map(claim => ({ claimId: claim.id, ...claim.evaluation })),
      verifierEnabled: c.claims.every(claim => claim.evaluation.verifierProfile !== "verifier_disabled")
    })]));
  const deduplicated = applyVerifiedWorkMeetingDuplicates(audit.evaluated, replay.duplicates,
    { requests, evaluations: audit.coverageEvaluations, publicationCopies });
  assert(equal(deduplicated.removed, audit.removed) && equal(deduplicated.decisions, audit.duplicateDecisions));
  assert(unique(audit.priorityIds) && audit.priorityIds.every(id => resultIds.includes(id)));
  if (audit.ranking) {
    const proposed = [...new Set(replay.priorityIds.flatMap(id => audit.removed.find(r => r.duplicateId === id)?.coveredByIds ?? [id]))];
    const capacity = partitionWorkMeetingCandidateReviewCapacity(deduplicated.candidates, 20, proposed);
    assert(equal(capacity.ranking, audit.ranking) && equal(capacity.priorityIds, audit.priorityIds)
      && equal(capacity.primaryCandidates.map(c => c.id), audit.primaryIds) && equal(capacity.overflowCandidates.map(c => c.id), audit.overflowIds));
  }
  assert(audit.fates.length === sourceIds.length && unique(audit.fates.map(row => row.sourceCandidateId)));
  for (const row of audit.fates) {
    assert(audit.sourceToResult.some(m => m.sourceCandidateId === row.sourceCandidateId && m.resultCandidateId === row.resultCandidateId));
    const expected = audit.primaryIds.includes(row.resultCandidateId) ? ["primary", "review_priority"]
      : audit.overflowIds.includes(row.resultCandidateId) ? ["overflow", "review_capacity"]
      : suppressed.includes(row.resultCandidateId) ? ["suppressed", "publication_policy"] : ["duplicate", "verified_coverage"];
    assert(row.fate === expected[0] && row.reason === expected[1]);
    assert(JSON.stringify(row.coveredByIds) === JSON.stringify(audit.removed.find(r => r.duplicateId === row.resultCandidateId)?.coveredByIds ?? []));
  }
  const persisted = [...audit.primaryIds, ...suppressed].map(id => audit.evaluated.find(c => c.id === id)!);
  // Compare all values against the actual publication, independently of object key order.
  assert(equal(persisted, input.publishedCandidates));
  return audit;
}

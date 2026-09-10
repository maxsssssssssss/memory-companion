import { describe, expect, it, vi } from "vitest";
import type { TranscriptSegment } from "@/lib/domain/types";
import type { AssembledWorkMeetingCandidate } from "./candidate-normalization";
import { buildWorkCandidatePublicationProjection, packWorkDuplicateCoverageForVerification, partitionWorkCandidatesForVerification } from "./candidate-normalization";
import { applyVerifiedWorkMeetingDuplicates } from "./candidate-deduplication";
import { buildWorkDuplicateCoverageRequests, validateWorkDuplicateCoverageOutput, type WorkDuplicateRelation } from "./duplicate-coverage";
import { buildWorkMeetingVerifierProviderPayload, createStructuredWorkMeetingVerifier,
  validateWorkMeetingVerifierResult, type WorkStructuredJsonRequest } from "./analysis-provider";
import { resolveWorkReviewAnalysisRuntimeConfig } from "./runtime-config";

const scope = { accountId: "account_a", meetingId: "meeting_a", publicationId: "pub_a", canonicalDigest: "a".repeat(64) };
function candidate(id: string, text: string): AssembledWorkMeetingCandidate {
  return { id, clientCandidateKey: id, kind: "commitment", title: text, body: text, sourceWindowIndexes: [0],
    structuredData: { candidateOwner: null, rawActorLabel: null, dueAt: null, originalDueExpression: null,
      decisionFinality: null, actionBasis: "explicit_commitment", relatedCommitmentCandidateId: null, planStages: [] },
    evidenceIds: [`s_${id}`], claims: [{ id: `claim_${id}`, candidateId: id, claimType: "commitment_existence",
      text, evidenceIds: [`s_${id}`], semanticValue: null, semanticRiskFlags: [], createdAt: null }] };
}
function canonical(candidates: AssembledWorkMeetingCandidate[]): TranscriptSegment[] {
  return candidates.map((c, i) => ({ id: `s_${c.id}`, text: c.body, uploadId: "upload_a", startSeconds: i * 4,
    endSeconds: i * 4 + 3, confidence: 0.9, sceneLabels: [], valueLabels: [] }));
}
function fixture() {
  const candidates = [candidate("draft", "提交初稿并按反馈修订"), candidate("demo", "只组织一次演示，未接受每日培训"),
    candidate("recap", "提交初稿、按反馈修订，并只组织一次演示；不接受每日培训")];
  const segments = canonical(candidates), duplicates = [{ duplicateId: "recap", coveredByIds: ["draft", "demo"] }];
  const requests = buildWorkDuplicateCoverageRequests({ candidates, duplicates, scope, segments });
  const wire = requests.map(r => ({ relationId: r.relationId, verdict: "complete" as const,
    supportedEvidenceIds: [r.original, ...r.coveredBy].flatMap(s => s.evidenceIds) }));
  const evaluated = candidates.map(c => ({ ...structuredClone(c), publicationAction: "show_as_candidate" }));
  return { candidates, segments, duplicates, requests, wire, evaluated,
    coverage: { requests, evaluations: validateWorkDuplicateCoverageOutput(wire, requests) } };
}

describe("Work Meeting deletion coverage (mock semantic verdicts, not model acceptance)", () => {
  it("actually removes a complete joint recap while preserving all detailed coverers and inputs", () => {
    const f = fixture(), before = structuredClone(f);
    const result = applyVerifiedWorkMeetingDuplicates(f.evaluated, f.duplicates, f.coverage);
    expect(result.removed).toEqual(f.duplicates);
    expect(result.candidates.map(c => c.id)).toEqual(["draft", "demo"]);
    expect(result.decisions[0]).toMatchObject({ applied: true, reason: "complete" });
    expect(f).toEqual(before);
  });

  it("accepts an equivalent rewrite with a complete coverage verdict, without lexical equality", () => {
    const candidates = [candidate("detail", "到期前完成接口交付"), candidate("recap", "在截止日之前交付接口")];
    const duplicates = [{ duplicateId: "recap", coveredByIds: ["detail"] }];
    const requests = buildWorkDuplicateCoverageRequests({ candidates, duplicates, scope, segments: canonical(candidates) });
    const evaluations = validateWorkDuplicateCoverageOutput([{ relationId: requests[0].relationId, verdict: "complete",
      supportedEvidenceIds: ["s_detail", "s_recap"] }], requests);
    expect(applyVerifiedWorkMeetingDuplicates(candidates.map(c => ({ ...c, publicationAction: "show_as_candidate" })),
      duplicates, { requests, evaluations }).removed).toHaveLength(1);
  });

  it.each(["notes_only", "untrusted_note", "changed_condition", "changed_date", "changed_stage", "changed_owner", "changed_title", "changed_evidence"])(
    "separates policy display notes from bound semantic content: %s", mode => {
      const f = fixture();
      f.segments.forEach(s => { s.speaker = "Speaker 1"; });
      const publicationCopies = new Map(f.candidates.map(c => [c.id, buildWorkCandidatePublicationProjection({
        candidate: c, ...scope, segments: f.segments, verifierEnabled: true,
        evaluations: c.claims.map(claim => ({ claimId: claim.id, supportVerdict: "entailed", issueCodes: [], supportedEvidenceIds: claim.evidenceIds }))
      })]));
      f.evaluated.forEach(c => Object.assign(c, publicationCopies.get(c.id)!.renderedCopy));
      expect(f.evaluated.every(c => c.body.endsWith("；发言归属待确认"))).toBe(true);
      expect(applyVerifiedWorkMeetingDuplicates(f.evaluated, f.duplicates, f.coverage).removed).toEqual([]);
      const coverer = f.evaluated[0];
      if (mode === "untrusted_note") coverer.body += "；负责人待确认";
      if (mode === "changed_condition") coverer.body = coverer.body.replace("按反馈修订", "无条件修订");
      if (mode === "changed_date") coverer.structuredData.originalDueExpression = "9月11号";
      if (mode === "changed_stage") coverer.structuredData.planStages.push({ clientStageKey: "stage", status: "current",
        content: "已完成", evidenceIds: coverer.evidenceIds, rawSpeakerLabel: null });
      if (mode === "changed_owner") coverer.structuredData.candidateOwner = "甲";
      if (mode === "changed_title") coverer.title += "已完成";
      if (mode === "changed_evidence") coverer.evidenceIds = ["s_demo"];
      const result = applyVerifiedWorkMeetingDuplicates(f.evaluated, f.duplicates, { ...f.coverage, publicationCopies });
      expect(result.removed).toHaveLength(mode === "notes_only" ? 1 : 0);
      if (mode !== "notes_only") expect(result.decisions[0].reason).toBe("content_changed");
    });

  it("retains model-authored uncertainty as semantic content even when it resembles a backend note", () => {
    const f = fixture();
    f.evaluated[0].claims[0].text += "；条件待确认";
    const publicationCopies = new Map(f.evaluated.map(c => [c.id, buildWorkCandidatePublicationProjection({
      candidate: c, ...scope, segments: f.segments, verifierEnabled: true,
      evaluations: c.claims.map(claim => ({ claimId: claim.id, supportVerdict: "entailed", issueCodes: [], supportedEvidenceIds: claim.evidenceIds }))
    })]));
    f.evaluated.forEach(c => Object.assign(c, publicationCopies.get(c.id)!.renderedCopy));
    expect(applyVerifiedWorkMeetingDuplicates(f.evaluated, f.duplicates, { ...f.coverage, publicationCopies }).decisions[0].reason).toBe("content_changed");
  });

  it("shares exact input text without losing Evidence fields, relation membership or unique facts", () => {
    const f = fixture();
    const requests = buildWorkDuplicateCoverageRequests({ ...f, scope, duplicates: [
      ...f.duplicates, { duplicateId: "demo", coveredByIds: ["draft"] }
    ] });
    const payload = buildWorkMeetingVerifierProviderPayload({ ...scope, segments: f.segments, claims: f.candidates.flatMap(c => c.claims), duplicateCoverage: requests });
    expect(Object.keys(payload.coverageSubjects!)).toHaveLength(3);
    const readSubject = (ref: string) => {
      const s = payload.coverageSubjects![ref];
      return "textFromClaimId" in s ? payload.items.find(c => c.claimId === s.textFromClaimId)!.text : s.text;
    };
    expect(payload.duplicateCoverage!.map(r => [readSubject(r.original), ...r.coveredBy.map(readSubject)]))
      .toEqual(requests.map(r => [r.original.body, ...r.coveredBy.map(c => c.body)]));
    for (const segment of f.segments) {
      const row = payload.evidenceById[segment.id] as unknown[];
      expect(Object.fromEntries(payload.evidenceFields!.map((field, i) => [field, row[i]]))).toEqual({
        startSeconds: segment.startSeconds, endSeconds: segment.endSeconds, rawSpeakerLabel: null, timestampQuality: "unknown", text: segment.text
      });
    }
    const changed = structuredClone(requests); changed[1].original.body += "；独有条件";
    expect(() => buildWorkMeetingVerifierProviderPayload({ ...scope, segments: f.segments, claims: [], duplicateCoverage: changed }))
      .toThrow("work_duplicate_coverage_input_invalid");
  });

  it.each(["partial", "uncertain"] as const)("retains the source for a %s relation", verdict => {
    const f = fixture(); f.coverage.evaluations = validateWorkDuplicateCoverageOutput([{ ...f.wire[0], verdict }], f.requests);
    const result = applyVerifiedWorkMeetingDuplicates(f.evaluated, f.duplicates, f.coverage);
    expect(result.candidates).toHaveLength(3); expect(result.decisions[0].reason).toBe(verdict);
  });

  it("never borrows an unlisted candidate or its Evidence to repair partial coverage", () => {
    const f = fixture();
    const requests = buildWorkDuplicateCoverageRequests({ ...f, scope, duplicates: [{ duplicateId: "recap", coveredByIds: ["demo"] }] });
    const payload = buildWorkMeetingVerifierProviderPayload({ ...scope, segments: f.segments, claims: [], duplicateCoverage: requests });
    expect(Object.keys(payload.evidenceById)).toEqual(["s_demo", "s_recap"]);
    expect(requests[0].coveredBy.map(c => c.id)).toEqual(["demo"]);
    expect(validateWorkDuplicateCoverageOutput([{ ...f.wire[0], relationId: requests[0].relationId }], requests)[0])
      .toMatchObject({ verdict: "uncertain", reason: "evidence_invalid" });
  });

  it("isolates an invalid relation verdict from an independent complete relation", () => {
    const f = fixture(), other = candidate("other_recap", "提交修改后的初稿");
    const candidates = [...f.candidates, other], duplicates = [...f.duplicates, { duplicateId: other.id, coveredByIds: ["draft"] }];
    const requests = buildWorkDuplicateCoverageRequests({ candidates, duplicates, scope, segments: canonical(candidates) });
    const evaluations = validateWorkDuplicateCoverageOutput([
      { relationId: requests[0].relationId, verdict: "complete", supportedEvidenceIds: ["foreign"] },
      { relationId: requests[1].relationId, verdict: "complete", supportedEvidenceIds: ["s_other_recap", "s_draft"] }
    ], requests);
    const result = applyVerifiedWorkMeetingDuplicates(candidates.map(c => ({ ...c, publicationAction: "show_as_candidate" })), duplicates, { requests, evaluations });
    expect(result.removed.map(r => r.duplicateId)).toEqual(["other_recap"]);
    expect(result.candidates.some(c => c.id === "recap")).toBe(true);
    candidates[0].claims[0].evidenceIds = ["foreign"];
    expect(() => buildWorkDuplicateCoverageRequests({ candidates, duplicates, scope, segments: canonical(candidates) })).toThrow("work_duplicate_coverage_evidence_invalid");
  });

  it.each(["missing", "malformed", "unknown_id", "duplicate_id", "foreign_evidence", "no_source_evidence", "no_coverer_evidence"])(
    "a %s result cannot authorize deletion", mode => {
      const f = fixture(); let response: unknown = f.wire;
      if (mode === "missing") response = [];
      if (mode === "malformed") response = [{ relationId: f.requests[0].relationId, verdict: "yes" }];
      if (mode === "unknown_id") response = [{ ...f.wire[0], relationId: "unknown" }];
      if (mode === "duplicate_id") response = [f.wire[0], f.wire[0]];
      if (mode === "foreign_evidence") response = [{ ...f.wire[0], supportedEvidenceIds: ["foreign"] }];
      if (mode === "no_source_evidence") response = [{ ...f.wire[0], supportedEvidenceIds: ["s_draft", "s_demo"] }];
      if (mode === "no_coverer_evidence") response = [{ ...f.wire[0], supportedEvidenceIds: ["s_recap", "s_demo"] }];
      expect(applyVerifiedWorkMeetingDuplicates(f.evaluated, f.duplicates,
        { requests: f.requests, evaluations: validateWorkDuplicateCoverageOutput(response, f.requests) }).removed).toEqual([]);
    });

  it.each(["suppress", "missing", "changed_text", "changed_condition", "claim_suppressed", "source_changed", "stale_scope"])(
    "revokes an otherwise complete check when the final state is %s", mode => {
      const f = fixture();
      if (mode === "suppress") f.evaluated[0].publicationAction = "suppress";
      if (mode === "missing") f.evaluated.shift();
      if (mode === "changed_text") f.evaluated[0].body += "，后来已完成";
      if (mode === "changed_condition") f.evaluated[1].claims[0].text = "接受每日培训";
      if (mode === "claim_suppressed") Object.assign(f.evaluated[1].claims[0], { evaluation: { publicationAction: "suppress" } });
      if (mode === "source_changed") f.evaluated[2].body += "另有退出条件";
      if (mode === "stale_scope") f.coverage.requests = buildWorkDuplicateCoverageRequests({ ...f, scope: { ...scope, accountId: "account_b" } });
      const result = applyVerifiedWorkMeetingDuplicates(f.evaluated, f.duplicates, f.coverage);
      expect(result.removed).toEqual([]); expect(result.candidates.some(c => c.id === "recap")).toBe(true);
    });

  it.each(["self", "cycle", "chain"])("blocks %s coverage even if called after structural validation", mode => {
    const f = fixture();
    const duplicates: WorkDuplicateRelation[] = mode === "self" ? [{ duplicateId: "recap", coveredByIds: ["recap"] }]
      : mode === "cycle" ? [{ duplicateId: "recap", coveredByIds: ["demo"] }, { duplicateId: "demo", coveredByIds: ["recap"] }]
        : [...f.duplicates, { duplicateId: "draft", coveredByIds: ["demo"] }];
    const result = applyVerifiedWorkMeetingDuplicates(f.evaluated, duplicates, f.coverage);
    expect(result.candidates.some(c => c.id === "recap")).toBe(true);
    if (mode === "cycle") expect(result.removed).toEqual([]);
  });

  it("does not delete a high-risk core when its covering cores were downgraded to questions", () => {
    const f = fixture(); f.evaluated.forEach(c => { c.publicationAction = "show_as_question"; });
    expect(applyVerifiedWorkMeetingDuplicates(f.evaluated, f.duplicates, f.coverage).removed).toEqual([]);
  });

  it("replays a bound coverage checkpoint, but refuses the same result for changed content or scope", () => {
    const f = fixture();
    const result = validateWorkMeetingVerifierResult({ response: { items: [], coverage: f.wire }, claims: [],
      allowedSegments: f.segments, duplicateCoverage: f.requests });
    expect(validateWorkMeetingVerifierResult({ response: JSON.parse(JSON.stringify(result)), claims: [],
      allowedSegments: f.segments, duplicateCoverage: f.requests })).toEqual(result);
    f.candidates[2].body += "；另有限制";
    const changed = buildWorkDuplicateCoverageRequests({ ...f, scope });
    expect(validateWorkMeetingVerifierResult({ response: result, claims: [], allowedSegments: f.segments,
      duplicateCoverage: changed }).coverage[0].verdict).toBe("uncertain");
    expect(buildWorkDuplicateCoverageRequests({ ...f, scope: { ...scope, meetingId: "meeting_b" } })[0].relationId).not.toBe(changed[0].relationId);
  });

  it("puts only deletion relations into existing bounded Verifier batches and leaves capacity failures unchecked", () => {
    const f = fixture(), base = { ...scope, segments: f.segments };
    const batches = partitionWorkCandidatesForVerification({ candidates: f.candidates, segments: f.segments });
    const packed = packWorkDuplicateCoverageForVerification({ base, batches, requests: f.requests });
    expect(packed.inputs).toHaveLength(1); expect(packed.inputs[0].claims).toHaveLength(3);
    expect(packed.inputs[0].duplicateCoverage).toHaveLength(1); expect(packed.unchecked).toEqual([]);
    expect(JSON.stringify(buildWorkMeetingVerifierProviderPayload(packed.inputs[0])).length).toBeLessThanOrEqual(12_000);
    const full = Array.from({ length: 24 }, (_, i) => ({ ...f.candidates[0].claims[0], id: `claim_${i}` }));
    const blocked = packWorkDuplicateCoverageForVerification({ base, batches: [[{ ...f.candidates[0], claims: full }]], requests: f.requests, maxBatches: 1 });
    expect(blocked.inputs).toHaveLength(1); expect(blocked.unchecked[0]).toMatchObject({ verdict: "uncertain", reason: "capacity" });
    expect(blocked.inputs[0].claims).toHaveLength(24);
  });

  it("parses coverage alongside normal verdicts in one existing adapter call, without retry", async () => {
    const f = fixture(); const request = vi.fn<WorkStructuredJsonRequest>(async () => ({ items: [], coverage: f.wire }));
    const profile = resolveWorkReviewAnalysisRuntimeConfig({ WORK_REVIEW_EXTRACTOR_MODEL: "fixture-model", WORK_REVIEW_VERIFIER_MODEL: "fixture-model" }).verifier;
    const verifier = createStructuredWorkMeetingVerifier({ profile, requestStructuredJson: request });
    const result = await verifier.verify({ ...scope, segments: f.segments, claims: [], duplicateCoverage: f.requests });
    expect(result.coverage[0].verdict).toBe("complete"); expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0].stage).toBe("verifier");
    const normal = { claimId: f.candidates[0].claims[0].id, supportVerdict: "entailed", issueCodes: [], supportedEvidenceIds: ["s_draft"] };
    const partial = validateWorkMeetingVerifierResult({ response: { items: [normal], coverage: "bad" }, claims: [f.candidates[0].claims[0]],
      allowedSegments: f.segments, duplicateCoverage: f.requests });
    expect(partial.items).toEqual([normal]); expect(partial.coverage[0].verdict).toBe("uncertain");
    request.mockRejectedValueOnce(new Error("fixture_failure"));
    await expect(verifier.verify({ ...scope, segments: f.segments, claims: [], duplicateCoverage: f.requests })).rejects.toThrow("fixture_failure");
    expect(request).toHaveBeenCalledTimes(2);
  });
});

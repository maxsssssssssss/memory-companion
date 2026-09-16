import { describe, expect, it, vi } from "vitest";
import type { TranscriptSegment } from "@/lib/domain/types";
import { applyWorkMeetingOrganization, applyVerifiedWorkMeetingDuplicates, buildWorkMeetingDeduplicationPayload,
  createWorkMeetingDeduplicator, decodeWorkMeetingOrganizationPlan } from "./candidate-deduplication";
import type { AssembledWorkMeetingCandidate } from "./candidate-normalization";
import type { WorkStructuredJsonRequest } from "./analysis-provider";
import { buildWorkMeetingVerifierInput, selectWorkCandidatesForGptVerification } from "./candidate-normalization";
import { evaluateWorkCandidatePublication } from "./publication-policy";
import { buildWorkDuplicateCoverageRequests, validateWorkDuplicateCoverageOutput, type WorkDuplicateRelation } from "./duplicate-coverage";

function candidate(id: string, text = id): AssembledWorkMeetingCandidate {
  return { id, clientCandidateKey: id, kind: "commitment", title: text, body: text,
    sourceWindowIndexes: [0], sourceDraftReferences: [{ windowIndex: 0, clientCandidateKey: id }],
    structuredData: { candidateOwner: null, rawActorLabel: null, dueAt: null, originalDueExpression: null,
      decisionFinality: null, actionBasis: "explicit_commitment", relatedCommitmentCandidateId: null, planStages: [] },
    evidenceIds: [`s_${id}`], claims: [{ id: `claim_${id}`, candidateId: id, claimType: "commitment_existence",
      text, evidenceIds: [`s_${id}`], semanticValue: null, semanticRiskFlags: [], createdAt: null }] };
}
function segments(candidates: AssembledWorkMeetingCandidate[]): TranscriptSegment[] {
  return candidates.map((c, i) => ({ id: `s_${c.id}`, uploadId: "upload_a", startSeconds: i * 5, endSeconds: i * 5 + 4,
    text: c.body, speaker: "speaker_1", confidence: 0.9, sceneLabels: [], valueLabels: [] }));
}
function organize(candidates: AssembledWorkMeetingCandidate[], plan: unknown) {
  return applyWorkMeetingOrganization(candidates, plan, segments(candidates));
}
function eligible(candidates: AssembledWorkMeetingCandidate[]) {
  return candidates.map(c => ({ ...c, structuredData: { ...c.structuredData }, publicationAction: "show_as_candidate" }));
}
// These pre-existing publication/metadata tests assume an explicit complete
// coverage response fixture. They do not establish model semantic accuracy.
function applyWithCompleteCoverageFixture(candidates: ReturnType<typeof eligible>, duplicates: WorkDuplicateRelation[]) {
  const requests = buildWorkDuplicateCoverageRequests({ candidates, duplicates,
    segments: candidates.flatMap(c => c.evidenceIds.map(id => ({ ...segments([c])[0], id }))),
    scope: { accountId: "account_a", meetingId: "meeting_a", publicationId: "pub_a", canonicalDigest: "a".repeat(64) } });
  const evaluations = validateWorkDuplicateCoverageOutput(requests.map(r => ({ relationId: r.relationId, verdict: "complete",
    supportedEvidenceIds: [...new Set([r.original, ...r.coveredBy].flatMap(c => c.evidenceIds))] })), requests);
  return applyVerifiedWorkMeetingDuplicates(candidates, duplicates, { requests, evaluations });
}

describe("Work Meeting global organization", () => {
  it("passes proposed same-item context to attributes for verification without approving unrelated names", () => {
    const c = candidate("a", "培训材料初稿、修订和讲解");
    c.structuredData.candidateOwner = "陈宁";
    c.claims.push({ ...c.claims[0], id: "owner_a", claimType: "commitment_owner", text: "陈宁负责培训材料",
      semanticValue: { kind: "commitment_owner", value: "陈宁" } });
    const canonical = [...segments([c]), { ...segments([c])[0], id: "recap", text: "培训材料的三个阶段均已认领，转写未区分发言者。" },
      { ...segments([c])[0], id: "unrelated", text: "陈宁负责另一份试点名单。" }];
    const result = applyWorkMeetingOrganization([c], { evidence: [{ item: 1, evidenceSegmentIds: ["recap"] }] }, canonical);
    const candidates = selectWorkCandidatesForGptVerification({ candidates: result.candidates, segments: canonical });
    const input = buildWorkMeetingVerifierInput({ candidates, segments: canonical, accountId: "account_a",
      meetingId: "meeting_a", publicationId: "publication_a", canonicalDigest: "a".repeat(64) });
    expect(input.claims).toHaveLength(2);
    for (const claim of input.claims) expect(claim.evidenceIds).toEqual(["recap", "s_a"]);
    expect(JSON.stringify(input)).not.toContain("unrelated");
    const assembled = result.candidates[0];
    const publication = evaluateWorkCandidatePublication({ kind: assembled.kind, structuredData: { ...assembled.structuredData, planStages: [] },
      claims: assembled.claims, verifierEnabled: true, canonicalSegments: canonical,
      evaluations: assembled.claims.map(claim => ({ claimId: claim.id,
        supportVerdict: claim.claimType === "commitment_owner" ? "unverifiable" : "entailed",
        issueCodes: [], supportedEvidenceIds: claim.claimType === "commitment_owner" ? [] : claim.evidenceIds })) });
    expect(publication.publicationAction).toBe("show_as_candidate");
    expect(publication.structuredData.candidateOwner).toBeNull();
    expect(publication.displayClaimIds).toEqual([assembled.claims.find(claim => claim.claimType === "commitment_existence")!.id]);
  });

  it("combines one delivery's details, preserves conditions and originals, and creates stable new Claim IDs", () => {
    const input = [candidate("a", "实现接口，权限异常则停止"), candidate("b", "同一接口补三组匿名测试数据"), candidate("c", "独立交付回退脚本")];
    const original = structuredClone(input);
    const result = organize(input, { groups: [{ items: [2, 1] }], priority: [3, 2, 1] });
    expect(result.candidates).toHaveLength(2);
    const merged = result.candidates[0];
    for (const c of input.slice(0, 2)) expect(merged.claims[0].text).toContain(c.claims[0].text);
    expect(merged.claims[0].evidenceIds).toEqual(["s_a", "s_b"]);
    expect(merged.id).not.toBe(input[0].id);
    expect(merged.claims[0].id).not.toBe(input[0].claims[0].id);
    expect(merged.sourceDraftReferences).toHaveLength(2);
    expect(result.priorityIds).toEqual(["c", merged.id]);
    expect(result.candidates[1]).toBe(input[2]);
    expect(organize(input, { groups: [{ items: [1, 2] }] }).candidates).toEqual(result.candidates);
    expect(organize(input, result.acceptedPlan).candidates).toEqual(result.candidates);
    expect(input).toEqual(original);
  });

  it.each(["日", "号"])("keeps source milestone expressions with %s without inventing a year or shared deadline", suffix => {
    const input = [candidate("a", "完成接口"), candidate("b", "为该接口准备匿名测试数据")];
    input.forEach((c, i) => {
      c.structuredData.dueAt = `2023-09-${11 + i}T00:00:00.000Z`;
      c.structuredData.originalDueExpression = `9月${11 + i}${suffix}前`;
      c.claims.push({ ...c.claims[0], id: `deadline_${c.id}`, claimType: "deadline",
        text: `${c.structuredData.originalDueExpression}${c.title}`,
        semanticValue: { kind: "deadline", dueAt: c.structuredData.dueAt, originalDueExpression: c.structuredData.originalDueExpression } });
    });
    const canonical = segments(input).map((s, i) => ({ ...s, text: `${input[i].structuredData.originalDueExpression}${s.text}` }));
    const result = applyWorkMeetingOrganization(input, { groups: [{ items: [1, 2] }] }, canonical).candidates[0];
    expect(result.title).toContain(`9月11${suffix}前`);
    expect(result.title).toContain(`9月12${suffix}前`);
    expect(result.title).not.toContain("2023");
    expect(result.structuredData).toMatchObject({ dueAt: null, originalDueExpression: null, rawActorLabel: null });
    expect(result.claims.filter(c => c.claimType === "deadline")).toHaveLength(2);
  });

  it.each(["owner", "accepted", "finality", "kind", "plan_change", "too_long"])("rejects an incompatible group locally: %s", mode => {
    const input = [candidate("a"), candidate("b"), candidate("c"), candidate("d")];
    if (mode === "owner") { input[0].structuredData.candidateOwner = "甲"; input[1].structuredData.candidateOwner = "乙"; }
    if (mode === "accepted") { input[0].kind = input[1].kind = "action_item"; input[1].structuredData.actionBasis = "assignment_without_acceptance"; }
    if (mode === "finality") { input[0].kind = input[1].kind = "decision"; input[0].structuredData.decisionFinality = "final"; input[1].structuredData.decisionFinality = "tentative"; }
    if (mode === "kind") input[1].kind = "open_question";
    if (mode === "plan_change") input[0].kind = input[1].kind = "plan_change";
    if (mode === "too_long") input[0].claims[0].text = "长".repeat(1801);
    const result = organize(input, { groups: [{ items: [1, 2] }, { items: [3, 4] }] });
    expect(result.candidates.slice(0, 2)).toEqual(input.slice(0, 2));
    expect(result.candidates).toHaveLength(3);
    expect(result.skippedInvalidCount).toBe(1);
  });

  it("combines an unaccepted action and its unresolved question without inventing acceptance", () => {
    const input = [candidate("a", "权限表仍未认领"), candidate("b", "权限表由谁接收尚未决定")];
    input[0].kind = "action_item"; input[0].structuredData.actionBasis = "assignment_without_acceptance";
    input[0].claims[0].claimType = "action_item";
    input[1].kind = "open_question"; input[1].structuredData.actionBasis = null;
    input[1].claims[0].claimType = "open_question";
    const result = organize(input, { groups: [{ items: [1, 2] }] }).candidates[0];
    expect(result.kind).toBe("action_item");
    expect(result.structuredData).toMatchObject({ actionBasis: "unowned_follow_up", candidateOwner: null });
  });

  it("adds only in-scope Evidence to an existing core and reidentifies it for verification", () => {
    const input = [candidate("a"), candidate("b")];
    const canonical = [...segments(input), { ...segments(input)[0], id: "later", text: "该项的补充条件" }];
    const result = applyWorkMeetingOrganization(input, { evidence: [
      { item: 1, evidenceSegmentIds: ["later"] }, { item: 2, evidenceSegmentIds: ["foreign_segment"] }
    ] }, canonical);
    expect(result.candidates[0].claims[0].text).toBe(input[0].claims[0].text);
    expect(result.candidates[0].claims[0].evidenceIds).toEqual(["later", "s_a"]);
    expect(result.candidates[0].id).not.toBe("a");
    expect(result.candidates[1]).toBe(input[1]);
    expect(result.skippedInvalidCount).toBe(1);
    expect(JSON.stringify(result.acceptedPlan)).not.toContain("foreign_segment");
    expect(applyWorkMeetingOrganization(input, result.acceptedPlan, canonical).candidates).toEqual(result.candidates);
    expect(organize(input, { evidence: [{ item: 1, evidenceSegmentIds: ["s_a"] }] }).candidates[0]).toBe(input[0]);
  });

  it.each([null, { items: [1, 99] }, { items: [1, 1] }, { items: ["1", 2] }, { items: [1, 2], text: "新增事实" }])(
    "ignores malformed advice while preserving a separate group: %j", group => {
      const input = [candidate("a"), candidate("b"), candidate("c"), candidate("d")];
      const result = organize(input, { groups: [group, { items: [3, 4] }] });
      expect(result.candidates).toHaveLength(3); expect(result.skippedInvalidCount).toBe(1);
    });

  it("rejects overlapping groups and duplicate cycles without discarding independent advice", () => {
    const input = [candidate("a"), candidate("b"), candidate("c"), candidate("d"), candidate("e")];
    const result = organize(input, { groups: [{ items: [1, 2] }, { items: [2, 3] }], duplicates: [
      { duplicateItem: 1, coveredByItems: [2] }, { duplicateItem: 2, coveredByItems: [1] },
      { duplicateItem: 5, coveredByItems: [4] }], priority: [99, null, 4] });
    expect(result.groups).toEqual([]);
    expect(result.duplicates).toEqual([{ duplicateId: "e", coveredByIds: ["d"] }]);
    expect(result.priorityIds).toEqual(["d"]);
  });

  it("verifies recaps too and deletes one only when all covering results survive", () => {
    const input = [candidate("a", "接口"), candidate("b", "回退"), candidate("recap", "接口和回退")];
    const result = organize(input, { duplicates: [{ duplicateItem: 3, coveredByItems: [1, 2] }] });
    expect(result.candidates).toEqual(input);
    const evaluated = eligible(input);
    expect(applyWithCompleteCoverageFixture(evaluated, result.duplicates).candidates).toEqual(evaluated.slice(0, 2));
    evaluated[0].publicationAction = "suppress";
    expect(applyWithCompleteCoverageFixture(evaluated, result.duplicates).candidates).toEqual(evaluated.slice(1));
    evaluated[0].publicationAction = "show_unclear_needs_confirmation";
    expect(applyWithCompleteCoverageFixture(evaluated, result.duplicates).removed).toEqual([]);
  });

  it("preserves distinct owner/date/finality and allows different labels for unaccepted work", () => {
    const input = [candidate("a"), candidate("b")], mapping = [{ duplicateId: "b", coveredByIds: ["a"] }];
    for (const field of ["candidateOwner", "dueAt", "originalDueExpression", "decisionFinality"] as const) {
      const evaluated = eligible(input); Object.assign(evaluated[1].structuredData, { [field]: "unique" });
      expect(applyWithCompleteCoverageFixture(evaluated, mapping).removed).toEqual([]);
    }
    input.forEach(c => { c.kind = "action_item"; });
    input[0].structuredData.actionBasis = "suggested_action"; input[1].structuredData.actionBasis = "assignment_without_acceptance";
    expect(applyWithCompleteCoverageFixture(eligible(input), mapping).removed).toHaveLength(1);
    input[0].structuredData.actionBasis = "explicit_commitment";
    expect(applyWithCompleteCoverageFixture(eligible(input), mapping).removed).toHaveLength(0);
  });

  it("bounds local payload and validates source closure before requesting", () => {
    const input = [candidate("a")];
    expect(() => buildWorkMeetingDeduplicationPayload(input, [])).toThrow();
    expect(() => buildWorkMeetingDeduplicationPayload(Array.from({ length: 129 }, (_, i) => candidate(String(i))), segments(input))).toThrow();
    expect(() => buildWorkMeetingDeduplicationPayload(input, [{ ...segments(input)[0], text: "长".repeat(100_001) }])).toThrow();
    input[0].claims[0].evidenceIds = ["outside"];
    expect(() => organize(input, {})).toThrow("work_organization_input_invalid");
  });

  it("uses one existing Provider slot with distinct candidate and Canonical references", async () => {
    const request = vi.fn<WorkStructuredJsonRequest>().mockResolvedValue({ groups: [], duplicates: [], evidence: [], priority: ["C2", "C1"] });
    const service = createWorkMeetingDeduplicator({ profile: { profileId: "verifier", provider: "fixture", model: "fixture",
      reasoningEffort: "none", maxOutputTokens: 3000, timeoutMs: 90_000, promptVersion: "old", schemaVersion: "old" }, requestStructuredJson: request });
    const input = [candidate("a"), candidate("b")];
    expect(await service.deduplicate({ candidates: input, segments: segments(input) })).toMatchObject({ priority: [2, 1] });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toMatchObject({ stage: "deduplicator", profile: { timeoutMs: 90_000, maxOutputTokens: 3000, reasoningEffort: "none" } });
    const payload = JSON.parse(buildWorkMeetingDeduplicationPayload(input, segments(input)));
    expect(payload.items.map((c: { n: string }) => c.n)).toEqual(["C1", "C2"]);
    expect(payload.context).toEqual(segments(input).map((s, i) => [`E${i + 1}`, s.text]));
  });

  it("sends each Canonical passage once, keeps distinct attributes, and reverses only legal typed references", () => {
    const input = [candidate("a", "交付审核包，例外仍需单独确认"), candidate("b", "该包只包含已确认范围")];
    input[0].claims.push({ ...input[0].claims[0], id: "date_a", claimType: "deadline", text: "9月11号前交付",
      semanticValue: { kind: "deadline", dueAt: null, originalDueExpression: "9月11号前" } });
    const canonical = segments(input).map((s, i) => ({ ...s, text: `完整原文_${i}：${s.text}` }));
    canonical.push({ ...canonical[0], id: "context_only", text: "同一结果后续的限定条件，不能机械删除" });
    const payload = buildWorkMeetingDeduplicationPayload(input, canonical);
    expect(payload.split("完整原文_0")).toHaveLength(2);
    expect(payload).not.toContain("s_a"); expect(payload).not.toContain("candidateOwner");
    expect(payload).toContain("9月11号前交付"); expect(payload).toContain(canonical[2].text);
    const decoded = decodeWorkMeetingOrganizationPlan({ groups: [["C1", "C2"]], duplicates: [],
      evidence: [["C1", "E3"], ["C2", "E999"], ["C2", "s_a"]], priority: ["C2"] }, canonical);
    const organized = applyWorkMeetingOrganization(input, decoded, canonical);
    expect(organized.acceptedPlan.evidence).toEqual([{ item: 1, evidenceSegmentIds: ["context_only"] }]);
    expect(organized.skippedInvalidCount).toBe(2);
    expect(organized.candidates[0].claims[0].evidenceIds).toContain("context_only");
    expect(applyWorkMeetingOrganization(input, organized.acceptedPlan, canonical).candidates).toEqual(organized.candidates);
    expect(() => decodeWorkMeetingOrganizationPlan({ groups: [] }, canonical)).toThrow();
  });

  it("keeps every stage and condition of one deliverable, including a shorter later restatement", () => {
    const input = [candidate("a", "12日前收齐需求，15号前提交确认产物"),
      candidate("b", "同一产物移除超范围条目；未确认的部分不纳入本轮")];
    const result = organize(input, { groups: [{ items: [1, 2] }] });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].claims[0].text).toContain(input[0].title);
    expect(result.candidates[0].claims[0].text).toContain(input[1].title);
    expect(result.sourceToResult).toHaveLength(2);
    expect(selectWorkCandidatesForGptVerification({ candidates: result.candidates, segments: segments(input) })[0].claims)
      .toContainEqual(result.candidates[0].claims[0]);
  });

  it.each(["E2", "C0", "C02", "C2 ", "c2", "C129", "C999999999999999999999", 2, null])(
    "rejects a bad candidate reference without accepting its otherwise valid numeric suffix: %j", reference => {
      const input = [candidate("a"), candidate("b"), candidate("c"), candidate("d")];
      const decoded = decodeWorkMeetingOrganizationPlan({ groups: [["C1", reference], ["C3", "C4"]],
        duplicates: [], evidence: [], priority: [] }, segments(input));
      const result = organize(input, decoded);
      expect(result.candidates.slice(0, 2)).toEqual(input.slice(0, 2));
      expect(result.groups).toHaveLength(1);
      expect(result.skippedInvalidCount).toBe(1);
    });

  it("does not confuse candidate and Evidence references even when both numbers exist", () => {
    const input = [candidate("a"), candidate("b"), candidate("c"), candidate("d")];
    const decoded = decodeWorkMeetingOrganizationPlan({ groups: [],
      duplicates: [["E1", "C2"], ["C1", "E2"]],
      evidence: [["E1", "E2"], ["C1", "C2"], ["C1", "E2", "C3"], ["C3", "E4"]],
      priority: ["E2", "C2"] }, segments(input));
    const result = organize(input, decoded);
    expect(result.skippedInvalidCount).toBe(6);
    expect(result.duplicates).toEqual([]);
    expect(result.candidates.slice(0, 2)).toEqual(input.slice(0, 2));
    expect(result.acceptedPlan.evidence).toEqual([{ item: 3, evidenceSegmentIds: ["s_d"] }]);
    expect(result.priorityIds).toEqual([input[1].id]);
  });

  it("requires the new wire contract but still replays a validated durable plan with Canonical IDs", () => {
    const input = [candidate("a"), candidate("b")];
    const decoded = decodeWorkMeetingOrganizationPlan({ groups: [[1, 2]], duplicates: [[2, 1]], evidence: [[1, 2]], priority: [1] }, segments(input));
    expect(organize(input, decoded)).toMatchObject({ candidates: input, skippedInvalidCount: 4 });
    const accepted = organize(input, { groups: [{ items: [1, 2] }] });
    expect(organize(input, accepted.acceptedPlan).sourceToResult).toEqual(accepted.sourceToResult);
  });

  it.each(["open_question", "proposal", "discussion_topic"] as const)(
    "keeps independent %s items separate without suppressing them or losing recap coverage", kind => {
      const input = [candidate("a", "通知的发送时刻仍待定"), candidate("b", "附件保存多久仍待定"),
        candidate("recap", "通知时刻和附件保留时长仍待定"), candidate("c", "移动端范围仍待定")];
      input.forEach(c => {
        c.kind = kind; c.structuredData.actionBasis = null;
        c.claims[0].claimType = kind === "discussion_topic" ? "topic" : kind;
      });
      const original = structuredClone(input);
      const result = organize(input, { groups: [{ items: [1, 2, 4] }],
        duplicates: [{ duplicateItem: 3, coveredByItems: [1, 2] }] });
      expect(result.groups).toEqual([]);
      expect(result.candidates).toEqual(original);
      expect(result.sourceToResult.every(row => row.sourceCandidateId === row.resultCandidateId)).toBe(true);
      // A fixed coverage proposal exercises backend handling, not AI semantics.
      expect(applyWithCompleteCoverageFixture(eligible(result.candidates), result.duplicates).candidates.map(c => c.id))
        .toEqual(["a", "b", "c"]);
      expect(input).toEqual(original);
    });

  it("reserves a valid recap for coverage instead of merging it into its coverer", () => {
    const input = [candidate("a", "交付包含接口和测试数据"), candidate("recap", "交付接口和测试数据"),
      candidate("b", "同一发布包交付说明"), candidate("c", "同一发布包补验收清单")];
    const plan = { groups: [{ items: [1, 2] }, { items: [3, 4] }], duplicates: [{ duplicateItem: 2, coveredByItems: [1] }] };
    const result = organize(input, plan);
    expect(result.groups.map(group => group.sourceCandidateIds)).toEqual([["b", "c"]]);
    expect(result.candidates.slice(0, 2)).toEqual(input.slice(0, 2));
    expect(result.duplicates).toEqual([{ duplicateId: "recap", coveredByIds: ["a"] }]);
    expect(result.skippedInvalidCount).toBe(1);
    expect(organize(input, result.acceptedPlan).candidates).toEqual(result.candidates);
    const evaluated = eligible(result.candidates);
    evaluated[0].publicationAction = "suppress";
    expect(applyWithCompleteCoverageFixture(evaluated, result.duplicates).candidates.some(c => c.id === "recap")).toBe(true);
  });

  it("does not let an invalid deletion block a separate valid delivery group", () => {
    const input = [candidate("a"), candidate("b")];
    const result = organize(input, { groups: [{ items: [1, 2] }], duplicates: [{ duplicateItem: 1, coveredByItems: [99] }] });
    expect(result.groups).toHaveLength(1);
    expect(result.duplicates).toEqual([]);
    expect(result.skippedInvalidCount).toBe(1);
  });

  it("lets a retained source of a rejected cross-kind deletion cover an independent valid recap", () => {
    const input = [candidate("detail"), candidate("recap"), candidate("question")];
    input[2].kind = "open_question";
    const result = organize(input, { duplicates: [
      { duplicateItem: 1, coveredByItems: [3] }, { duplicateItem: 2, coveredByItems: [1] }
    ] });
    expect(result.rejectedAdvice).toEqual([{ section: "duplicates", row: 1, reason: "cross_kind" }]);
    expect(result.duplicates).toEqual([{ duplicateId: "recap", coveredByIds: ["detail"] }]);
  });

  it("maps recap coverage to a combined coverer and preserves complete source fates", () => {
    const input = [candidate("a", "交付物先收集输入"), candidate("b", "同一交付物再确认范围"), candidate("recap", "交付物包含收集和确认")];
    const result = organize(input, { groups: [{ items: [1, 2] }], duplicates: [{ duplicateItem: 3, coveredByItems: [1, 2] }], priority: [2, 3] });
    expect(result.duplicates).toEqual([{ duplicateId: "recap", coveredByIds: [result.candidates[0].id] }]);
    expect(result.sourceToResult).toHaveLength(3);
    expect(organize(input, result.acceptedPlan).sourceToResult).toEqual(result.sourceToResult);
    expect(applyWithCompleteCoverageFixture(eligible(result.candidates), result.duplicates).candidates).toHaveLength(1);
  });
});

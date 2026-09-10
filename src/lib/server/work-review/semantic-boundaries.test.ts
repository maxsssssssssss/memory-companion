import { describe, expect, it } from "vitest";
import { WorkAtomicClaimSchema, WorkMeetingCandidateStructuredDataSchema } from "@/lib/domain/work-review";
import type { TranscriptSegment } from "@/lib/domain/types";
import { buildWorkMeetingVerifierProviderPayload, validatePartialWorkVerifierOutput } from "./analysis-provider";
import { deriveCandidateCopyFromPublication } from "./candidate-normalization";
import { evaluateWorkCandidatePublication, evaluateWorkClaimPublication } from "./publication-policy";

// Fixed human-labelled regression oracles, not a simulated semantic PASS from
// a model. They test the actual Claim/Evidence/publication path offline.
const cases = [
  { name: "rollback trigger rewritten", source: "如果出现月权查看或实际发放记录错配，立即停止新的处理，保留已有状态与必要排查日志。",
    text: "出现权限查看或实际发放记录错配时立即停止新的处理，保留已有状态与必要排查日志。", code: "core_meaning_changed" },
  { name: "pending materials guessed as complete", source: "同时标出资料逮捕和取消，不把它们从总数中抹掉。",
    text: "同时标出资料补齐和取消，不从总数中抹掉。", code: "core_meaning_changed" },
  { name: "negation lost", source: "保留审计记录，不能自动删除。", text: "自动删除审计记录。", code: "core_meaning_changed" },
  { name: "conditional operation made unconditional", source: "只有校验失败才暂停新申请。", text: "暂停所有新申请。", code: "core_meaning_changed" },
  { name: "exception lost", source: "处理本轮记录，未确认的条目除外。", text: "处理本轮所有记录。", code: "core_meaning_changed" },
  { name: "future stage made completed", source: "下周确认样本，当前尚未确认。", text: "样本已经确认。", code: "core_meaning_changed" },
  { name: "independent deliverables given shared owner", source: "甲接受报告，乙接受现场组织。", text: "甲接受报告及现场组织。", code: "independent_items_conflated" },
  { name: "S38 attribution absent from own Evidence", source: "权限请求还是待认领，没有接受的人。", text: "唐宁负责权限请求。", code: "mentioned_person_inferred_responsible" }
];

describe("Work core meaning regression boundaries", () => {
  it.each(cases)("rejects $name, even with an erroneously positive verdict", ({ source, text, code }) => {
    const segment: TranscriptSegment = { id: "own", uploadId: "upload", startSeconds: 0, endSeconds: 5,
      text: source, speaker: "unknown", confidence: 0.5, sceneLabels: [], valueLabels: [] };
    const claim = WorkAtomicClaimSchema.parse({ id: "claim", candidateId: "candidate", claimType: "commitment_existence", text, evidenceIds: ["own"] });
    const payload = buildWorkMeetingVerifierProviderPayload({ accountId: "account", meetingId: "meeting", publicationId: "publication",
      canonicalDigest: "a".repeat(64), segments: [segment], claims: [claim] });
    expect(JSON.stringify(payload)).toContain(text);
    expect(JSON.stringify(payload)).toContain(source);
    for (const supportVerdict of ["unsupported", "entailed"] as const) {
      expect(evaluateWorkClaimPublication({ claimType: claim.claimType, supportVerdict, issueCodes: [code] }).publicationAction).toBe("suppress");
    }
  });

  it.each([
    "保留已有状态；发生原文“月权查看”（含糊，待确认）或实际发放记录错配时才停止新处理，不自动删除记录。",
    "统计表保留所有状态的数量，同时标出原文“资料逮捕”（状态名称含糊，待确认）及取消，不从总数删除。"
  ])("retains a cautiously quoted core through the existing review mechanism: %s", text => {
    const main = WorkAtomicClaimSchema.parse({ id: "claim", candidateId: "candidate", claimType: "decision_existence", text, evidenceIds: ["own"] });
    const policy = evaluateWorkCandidatePublication({ kind: "decision", structuredData: WorkMeetingCandidateStructuredDataSchema.parse({}),
      claims: [main], verifierEnabled: true, evaluations: [{ claimId: main.id, supportVerdict: "entailed",
        issueCodes: ["canonical_wording_unclear"], supportedEvidenceIds: ["own"] }] });
    expect(policy.publicationAction).toBe("show_as_question");
    const copy = deriveCandidateCopyFromPublication({ claims: [main], displayClaimIds: policy.displayClaimIds, displayNotes: policy.displayNotes });
    expect(copy.title).toBe(text); expect(copy.body).toContain("待确认");
    for (const supportVerdict of ["partially_entailed", "unverifiable", "unsupported", "contradicted"] as const) {
      expect(evaluateWorkClaimPublication({ claimType: main.claimType, supportVerdict,
        issueCodes: ["canonical_wording_unclear"] }).publicationAction).toBe("suppress");
    }
    expect(evaluateWorkClaimPublication({ claimType: main.claimType, supportVerdict: "entailed",
      issueCodes: ["canonical_wording_unclear", "core_meaning_changed"] }).publicationAction).toBe("suppress");
  });

  it("keeps all stages of one evidenced delivery while rejecting Evidence borrowed from elsewhere", () => {
    const segments: TranscriptSegment[] = ["12日前收需求，15号前整理仓库确认的目录。", "同一目录移除超范围或未确认单位的条目。", "唐宁在别的话题中接受了通知任务。"]
      .map((text, i) => ({ id: `e${i + 1}`, text, uploadId: "upload", startSeconds: i * 5, endSeconds: i * 5 + 5,
        speaker: "unknown", confidence: 0.9, sceneLabels: [], valueLabels: [] }));
    const main = WorkAtomicClaimSchema.parse({ id: "claim", candidateId: "candidate", claimType: "commitment_existence",
      text: "12日前收需求，15号前整理仓库确认的目录，移除超范围或未确认单位的条目。", evidenceIds: ["e1", "e2"] });
    const response = { items: [{ claimId: main.id, supportVerdict: "entailed", issueCodes: [], supportedEvidenceIds: ["e1", "e2"] }] };
    const result = validatePartialWorkVerifierOutput({ claims: [main], allowedSegments: segments, response });
    expect(result.items).toHaveLength(1);
    expect(evaluateWorkCandidatePublication({ kind: "commitment", structuredData: WorkMeetingCandidateStructuredDataSchema.parse({}),
      claims: [main], verifierEnabled: true, evaluations: result.items }).publicationAction).toBe("show_as_candidate");
    response.items[0].supportedEvidenceIds.push("e3");
    expect(() => validatePartialWorkVerifierOutput({ claims: [main], allowedSegments: segments, response })).toThrow();
  });
});

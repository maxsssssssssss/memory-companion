import { describe, expect, it, vi } from "vitest";

import {
  applyWorkWeeklyClaimPublicationPolicy,
  runWorkWeeklyGenerationPipeline,
  assessWorkWeeklyCoverage,
  type WorkWeeklyGenerationTrace,
  type WorkWeeklyClaimPublicationTrace
} from "./weekly-publication-policy";
import {
  emptyWorkWeeklyTestSnapshot,
  WORK_WEEKLY_TEST_REFS,
  workWeeklyProfile,
  workWeeklyTestSnapshot
} from "./weekly-ai-test-fixture";
import type { WorkWeeklyGeneratedClaim, WorkWeeklyGeneratedItem, WorkWeeklyVerifierItem, WorkWeeklyCoverageAssessment, WorkWeeklyClaimVerifier } from "./weekly-ai-provider";

function item(claimType: "decision" | "commitment" | "completion" | "deadline" | "causality" | "frequency", sourceRefs: string[], text = "模型自由文本") {
  return [{
    id: `item_${claimType}`,
    section: claimType === "decision" ? "decisions" as const : "overview" as const,
    itemType: "evidence_backed_fact" as const,
    text: "这段模型原文不得直接发布",
    claims: [{ id: `claim_${claimType}`, text, claimType, sourceRefs }]
  }];
}

function entailed(claimType: string, sourceRefs: string[]) {
  return [{
    claimId: `claim_${claimType}`,
    verdict: "entailed" as const,
    issueCodes: [],
    supportedSourceRefs: sourceRefs
  }];
}

function atomicItem(text: string, overrides: Partial<WorkWeeklyGeneratedItem> = {}): WorkWeeklyGeneratedItem {
  return {
    id: "item_atomic", section: "overview", itemType: "evidence_backed_fact", text: "未核验的自由摘要不得发布",
    claims: [{ id: "claim_atomic", text, claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated] }],
    ...overrides
  };
}

function verdictsFor(items: WorkWeeklyGeneratedItem[], issueCodes: string[] = []): WorkWeeklyVerifierItem[] {
  return items.flatMap((item) => item.claims.map((claim) => ({
    claimId: claim.id, verdict: "entailed" as const, issueCodes, supportedSourceRefs: claim.sourceRefs
  })));
}

describe("Work Weekly deterministic publication policy", () => {
  it("publishes exactly the fully verified atomic decision and system completion", () => {
    const snapshot = workWeeklyTestSnapshot();
    const decision = applyWorkWeeklyClaimPublicationPolicy({
      snapshot,
      items: item("decision", [WORK_WEEKLY_TEST_REFS.decision], "最终决定采用方案 B"),
      verdicts: entailed("decision", [WORK_WEEKLY_TEST_REFS.decision])
    });
    expect(decision[0]?.text).toBe("最终决定采用方案 B");
    expect(decision[0]?.text).not.toContain("这段模型原文");

    const completion = applyWorkWeeklyClaimPublicationPolicy({
      snapshot,
      items: item("completion", [WORK_WEEKLY_TEST_REFS.todoCompleted], "待办清单在系统中标记完成。"),
      verdicts: entailed("completion", [WORK_WEEKLY_TEST_REFS.todoCompleted])
    });
    expect(completion[0]?.text).toContain("在系统中标记完成");
    expect(completion[0]?.text).not.toMatch(/现实|履行/u);
  });

  it.each([
    ["proposal as decision", "decision", [WORK_WEEKLY_TEST_REFS.proposal]],
    ["assignment as commitment", "commitment", [WORK_WEEKLY_TEST_REFS.assignment]],
    ["Todo state without completion event", "completion", [WORK_WEEKLY_TEST_REFS.todo]],
    ["date without deadline semantics", "deadline", [WORK_WEEKLY_TEST_REFS.dated]],
    ["temporal order without explicit cause", "causality", [WORK_WEEKLY_TEST_REFS.evidenceDated]],
    ["single source as repeated behavior", "frequency", [WORK_WEEKLY_TEST_REFS.evidenceDecision]]
  ] as const)("rejects %s", (_name, claimType, sourceRefs) => {
    const published = applyWorkWeeklyClaimPublicationPolicy({
      snapshot: workWeeklyTestSnapshot(),
      items: item(claimType, [...sourceRefs], claimType === "frequency" ? "反复选择方案 B" : "不安全断言"),
      verdicts: entailed(claimType, [...sourceRefs])
    });
    expect(published).toEqual([]);
  });

  it("does not count a Todo derived from one meeting as an independent frequency source", () => {
    const sourceRefs = [WORK_WEEKLY_TEST_REFS.commitment, WORK_WEEKLY_TEST_REFS.todo];
    const published = applyWorkWeeklyClaimPublicationPolicy({
      snapshot: workWeeklyTestSnapshot(),
      items: item("frequency", sourceRefs, "多次讨论发布清单"),
      verdicts: entailed("frequency", sourceRefs)
    });
    expect(published).toEqual([]);
  });

  it("does not call either GPT role for an empty source snapshot", async () => {
    const synthesize = vi.fn();
    const verify = vi.fn();
    const result = await runWorkWeeklyGenerationPipeline({
      accountId: "account_a",
      snapshot: emptyWorkWeeklyTestSnapshot(),
      synthesizer: { profile: workWeeklyProfile("synthesizer"), synthesize },
      verifier: { profile: workWeeklyProfile("verifier"), verify }
    });
    expect(result.status).toBe("insufficient_sources");
    expect(synthesize).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it("fails closed before synthesis when the independent verifier is unavailable", async () => {
    const synthesize = vi.fn();
    const result = await runWorkWeeklyGenerationPipeline({
      accountId: "account_a",
      snapshot: workWeeklyTestSnapshot(),
      synthesizer: { profile: workWeeklyProfile("synthesizer"), synthesize },
      verifier: null
    });
    expect(result.status).toBe("verifier_unavailable");
    expect(synthesize).not.toHaveBeenCalled();
  });
});

describe("Work Weekly supported plan-change arrangements", () => {
  const text = "为兼容旧客户端，本轮接口切换由整体替换改为分批迁移；出现异常时恢复原路径。";
  function snapshotWithPlanChange() {
    const snapshot = workWeeklyTestSnapshot();
    const finding = snapshot.findings.find((source) => source.sourceRef === WORK_WEEKLY_TEST_REFS.decision)!;
    finding.kind = "plan_change"; finding.body = text;
    finding.structuredData = { decisionFinality: null, planStages: [] };
    snapshot.evidence.find((source) => source.sourceRef === WORK_WEEKLY_TEST_REFS.evidenceDecision)!.text = text;
    return snapshot;
  }

  it.each([WORK_WEEKLY_TEST_REFS.decision, WORK_WEEKLY_TEST_REFS.evidenceDecision])(
    "publishes the verified arrangement and all conditions through source %s", (sourceRef) => {
      const snapshot = snapshotWithPlanChange(); const before = JSON.stringify(snapshot);
      const result = applyWorkWeeklyClaimPublicationPolicy({ snapshot,
        items: item("decision", [sourceRef], text), verdicts: entailed("decision", [sourceRef]) });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ section: "decisions", text, sourceRefs: [sourceRef] });
      expect(JSON.stringify(snapshot)).toBe(before);
    }
  );

  it.each(["unsupported", "partially_entailed", "entailed"] as const)(
    "does not override %s with missing qualification merely because the source is a plan change", (verdict) => {
      const sourceRefs = [WORK_WEEKLY_TEST_REFS.evidenceDecision];
      const verdicts: WorkWeeklyVerifierItem[] = entailed("decision", sourceRefs);
      Object.assign(verdicts[0]!, { verdict, issueCodes: ["missing_qualification"] });
      const claims = item("decision", sourceRefs, "本轮接口切换改为分批迁移。");
      expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot: snapshotWithPlanChange(), items: claims, verdicts })).toEqual([]);
    }
  );

  it.each(["decision", "fact"] as const)("does not turn a tentative plan change into a finalized %s", (claimType) => {
    const snapshot = snapshotWithPlanChange();
    snapshot.findings[0]!.body = "暂拟分批迁移，是否执行仍待确认。";
    snapshot.evidence.find((source) => source.sourceRef === WORK_WEEKLY_TEST_REFS.evidenceDecision)!.text = snapshot.findings[0]!.body;
    const items = [atomicItem("最终决定采用分批迁移。", { section: "decisions", claims: [{
      id: "claim_atomic", text: "最终决定采用分批迁移。", claimType, sourceRefs: [WORK_WEEKLY_TEST_REFS.evidenceDecision]
    }] })];
    // Even a mistaken positive verdict cannot use plan_change as formal-decision authority.
    const trace: WorkWeeklyClaimPublicationTrace[] = [];
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot, items, verdicts: verdictsFor(items),
      onClaims: (rows) => { trace.push(...rows); } })).toEqual([]);
    expect(trace[0]?.reasonCode).toBe("decision_source_missing");
  });

  it.each(["proposal", "action_item", "discussion_topic", "open_question"] as const)(
    "does not treat %s as a supported decision arrangement", (kind) => {
      const snapshot = snapshotWithPlanChange(); snapshot.findings[0]!.kind = kind;
      snapshot.findings[0]!.structuredData = { actionBasis: "assignment_without_acceptance" };
      expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot,
        items: item("decision", [WORK_WEEKLY_TEST_REFS.evidenceDecision], text),
        verdicts: entailed("decision", [WORK_WEEKLY_TEST_REFS.evidenceDecision]) })).toEqual([]);
    }
  );

  it.each([WORK_WEEKLY_TEST_REFS.dated, WORK_WEEKLY_TEST_REFS.evidenceDated])(
    "does not borrow an unrelated plan change elsewhere in the snapshot for %s", (sourceRef) => {
      expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot: snapshotWithPlanChange(),
        items: item("decision", [sourceRef], text), verdicts: entailed("decision", [sourceRef]) })).toEqual([]);
    }
  );

  it("requires plan-change authority in the verifier's supported subset, not just the generated references", () => {
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot: snapshotWithPlanChange(),
      items: item("decision", [WORK_WEEKLY_TEST_REFS.evidenceDecision, WORK_WEEKLY_TEST_REFS.dated], text),
      verdicts: entailed("decision", [WORK_WEEKLY_TEST_REFS.dated]) })).toEqual([]);
  });

  it("preserves explicitly tentative wording when the verifier supports that qualified statement", () => {
    const snapshot = snapshotWithPlanChange(); const tentative = "暂拟分批迁移，是否执行仍待确认。";
    snapshot.findings[0]!.body = tentative;
    snapshot.evidence.find((source) => source.sourceRef === WORK_WEEKLY_TEST_REFS.evidenceDecision)!.text = tentative;
    const result = applyWorkWeeklyClaimPublicationPolicy({ snapshot,
      items: item("decision", [WORK_WEEKLY_TEST_REFS.evidenceDecision], tentative),
      verdicts: entailed("decision", [WORK_WEEKLY_TEST_REFS.evidenceDecision]) });
    expect(result[0]?.text).toBe(tentative);
  });
});

describe("Work Weekly retention gates and stage attribution", () => {
  function compactSnapshot() {
    const snapshot = workWeeklyTestSnapshot();
    snapshot.findings = snapshot.findings.filter((finding) => finding.sourceRef === WORK_WEEKLY_TEST_REFS.dated);
    snapshot.findings[0]!.kind = "discussion_topic";
    snapshot.findings[0]!.title = "观察记录";
    snapshot.findings[0]!.body = "来源记录了样本观察，效率提升尚无证据。";
    snapshot.evidence = snapshot.evidence.filter((source) => source.sourceRef === WORK_WEEKLY_TEST_REFS.evidenceDated);
    snapshot.todos = []; snapshot.todoEvents = [];
    const kept = new Set([...snapshot.meetings, ...snapshot.findings, ...snapshot.evidence].map((source) => source.sourceRef));
    snapshot.identities = snapshot.identities.filter((identity) => kept.has(identity.sourceRef));
    snapshot.allowlistedSourceRefs = snapshot.identities.map((identity) => identity.sourceRef).sort();
    return snapshot;
  }
  const fullCoverage = (ids = ["claim_atomic"]): WorkWeeklyCoverageAssessment[] => [{
    sourceRef: WORK_WEEKLY_TEST_REFS.dated, status: "covered", claimIds: ids, reasonCode: "covered"
  }];
  function assess(snapshot = compactSnapshot(), items = [atomicItem("样本观察不能证明效率提升。")], coverage = fullCoverage(), verdicts = verdictsFor(items)) {
    let publicationClaims: WorkWeeklyClaimPublicationTrace[] = [];
    applyWorkWeeklyClaimPublicationPolicy({ snapshot, items, verdicts, onClaims: (trace) => { publicationClaims = trace; } });
    return assessWorkWeeklyCoverage({ snapshot, generated: items, verdicts, coverage, publicationClaims });
  }

  it.each(["fact", "decision"] as const)("does not publish an unqualified adopted scope tagged %s", (claimType) => {
    const snapshot = workWeeklyTestSnapshot();
    snapshot.findings[0]!.structuredData = { decisionFinality: "tentative" };
    snapshot.findings[0]!.body = "首轮仅每日摘要；决定是否最终待确认。";
    const text = "首轮只发送每日摘要，不提供实时提醒；已完成的代码保持关闭、不算交付，试点后再评估。";
    const items = [atomicItem(text, { claims: [{ id: "claim_atomic", text, claimType, sourceRefs: [WORK_WEEKLY_TEST_REFS.decision] }] })];
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot, items, verdicts: verdictsFor(items, ["decision_finality_conflict"]) })).toEqual([]);
    items[0]!.claims[0]!.text = `暂定${text}最终性未确认。`;
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot, items, verdicts: verdictsFor(items) })[0]?.text).toBe(items[0]!.claims[0]!.text);
  });

  it("uses canonical decision finality even when a fact cites only its Evidence", () => {
    const snapshot = workWeeklyTestSnapshot();
    snapshot.findings[0]!.structuredData = { decisionFinality: "tentative" };
    const text = "首轮只提供每日摘要。";
    const items = [atomicItem(text, { claims: [{ id: "claim_atomic", text, claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.evidenceDecision] }] })];
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot, items, verdicts: verdictsFor(items, ["decision_finality_conflict"]) })).toEqual([]);
  });

  it.each(["当前接口不提供批量导出", "是否改为桌面优先尚未决定", "反馈说不清楚正式决定和个人建议的分类"])("keeps non-decision context: %s", (text) => {
    const snapshot = compactSnapshot();
    snapshot.findings[0]!.kind = "open_question";
    const items = [atomicItem(text)];
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot, items, verdicts: verdictsFor(items) })[0]?.text).toBe(text);
  });

  it.each(["fact", "completion"] as const)("requires a current-week completion event in completed for %s", (claimType) => {
    const snapshot = compactSnapshot();
    const text = "上周已手工整理两次周报。";
    const items = [atomicItem(text, { section: "completed", claims: [{ id: "claim_atomic", text, claimType, sourceRefs: [WORK_WEEKLY_TEST_REFS.dated] }] })];
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot, items, verdicts: verdictsFor(items) })).toEqual([]);
  });

  it.each(["2026-08-30", "2026-09-04", "2026-09-07"])("rejects completed event outside observed current week: %s", (date) => {
    const snapshot = workWeeklyTestSnapshot();
    snapshot.todoEvents[0]!.localDate = date;
    const text = "清单在系统中标记完成。";
    const items = [atomicItem(text, { section: "completed", claims: [{ id: "claim_atomic", text, claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.todoCompleted] }] })];
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot, items, verdicts: verdictsFor(items) })).toEqual([]);
  });

  it("accepts a system completion at observedThrough even tagged fact", () => {
    const snapshot = workWeeklyTestSnapshot();
    const text = "清单在系统中标记完成，不代表现实履行。";
    const items = [atomicItem(text, { section: "completed", claims: [{ id: "claim_atomic", text, claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.todoCompleted] }] })];
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot, items, verdicts: verdictsFor(items) })[0]?.text).toBe(text);
  });

  it("does not retain a naked arrangement after its same-source condition is rejected", () => {
    const items = [atomicItem("unused", { claims: [
      { id: "scope", text: "纳入分析指标。", claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated] },
      { id: "condition", text: "只有埋点按时完成才纳入，隐私评审不通过则放弃。", claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated] }
    ] })];
    const verdicts = verdictsFor(items); verdicts[1]!.verdict = "partially_entailed";
    const trace: WorkWeeklyClaimPublicationTrace[] = [];
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot: compactSnapshot(), items, verdicts, onClaims: (entries) => { trace.push(...entries); } })).toEqual([]);
    expect(trace.find((entry) => entry.claimId === "scope")?.reasonCode).toBe("related_claim_rejected");
    expect(trace.find((entry) => entry.claimId === "condition")?.reasonCode).toBe("verifier_partially_entailed");
  });

  it("makes full coverage a separate assessment and records all stages without another Provider call", async () => {
    const snapshot = compactSnapshot();
    const generated = [atomicItem("来源记录样本观察，效率提升尚无证据。")];
    const synthesize = vi.fn(async () => generated);
    const verify = vi.fn(async (call: Parameters<WorkWeeklyClaimVerifier["verify"]>[0]) => {
      call.onCoverage?.(fullCoverage()); return verdictsFor(generated);
    });
    const stages: WorkWeeklyGenerationTrace[] = [];
    const result = await runWorkWeeklyGenerationPipeline({ accountId: snapshot.accountId, snapshot,
      synthesizer: { profile: workWeeklyProfile("synthesizer"), synthesize },
      verifier: { profile: workWeeklyProfile("verifier"), verify }, onTrace: (entry) => { stages.push(entry); } });
    expect(result).toMatchObject({ status: "verified", quality_assessment: { status: "passed", sourceCount: 1, coveredSourceCount: 1 } });
    expect(synthesize).toHaveBeenCalledTimes(1); expect(verify).toHaveBeenCalledTimes(1);
    expect(stages.map((entry) => entry.stage)).toEqual(["synthesized", "verified", "published"]);
    expect(stages[2]).toMatchObject({ publicationStatus: "candidate_only", claims: [{ outcome: "published", publishedSortOrder: 0 }] });
  });

  it("retains coverage when its audited attention claim merges into the exact fact", async () => {
    const snapshot = compactSnapshot();
    const text = "来源记录了样本观察，效率提升尚无证据。";
    const generated = [
      atomicItem(text, { id: "fact", section: "open_questions" }),
      atomicItem(text, { id: "attention", section: "next_week", itemType: "suggestion", claims: [{
        id: "claim_attention", text, claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated]
      }] })
    ];
    const synthesize = vi.fn(async () => generated);
    const verify = vi.fn(async (call: Parameters<WorkWeeklyClaimVerifier["verify"]>[0]) => {
      call.onCoverage?.(fullCoverage(["claim_attention"]));
      return verdictsFor(generated);
    });
    const result = await runWorkWeeklyGenerationPipeline({ accountId: snapshot.accountId, snapshot,
      synthesizer: { profile: workWeeklyProfile("synthesizer"), synthesize },
      verifier: { profile: workWeeklyProfile("verifier"), verify } });
    expect(result).toMatchObject({ status: "verified", quality_assessment: {
      status: "passed", sourceCount: 1, coveredSourceCount: 1, partialSourceCount: 0
    }, items: [expect.objectContaining({ section: "open_questions", text })] });
    expect(result.items).toHaveLength(1);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("delivers verified content with needs_review when another key qualification is missing", async () => {
    const snapshot = compactSnapshot(); const generated = [atomicItem("记录了样本观察。")];
    const result = await runWorkWeeklyGenerationPipeline({ accountId: snapshot.accountId, snapshot,
      synthesizer: { profile: workWeeklyProfile("synthesizer"), synthesize: async () => generated },
      verifier: { profile: workWeeklyProfile("verifier"), verify: async (call) => {
        call.onCoverage?.([{ ...fullCoverage()[0]!, status: "partial", reasonCode: "missing_qualification" }]);
        return verdictsFor(generated);
      } } });
    expect(result).toMatchObject({ status: "needs_review", quality_assessment: { status: "needs_review", reasonCodes: ["missing_qualification"],
      reviewIssues: [{ sourceRef: WORK_WEEKLY_TEST_REFS.dated, reasonCode: "missing_qualification" }] } });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.text).toBe(generated[0]!.claims[0]!.text);
  });

  it("keeps the synthesized stage when verification throws", async () => {
    const stages: WorkWeeklyGenerationTrace[] = [];
    await expect(runWorkWeeklyGenerationPipeline({ accountId: "account_a", snapshot: compactSnapshot(),
      synthesizer: { profile: workWeeklyProfile("synthesizer"), synthesize: async () => [atomicItem("观察")] },
      verifier: { profile: workWeeklyProfile("verifier"), verify: async () => { throw new Error("fixture verifier unavailable"); } },
      onTrace: (entry) => { stages.push(entry); }
    })).rejects.toThrow("fixture verifier unavailable");
    expect(stages.map((entry) => entry.stage)).toEqual(["synthesized"]);
  });

  it("does not accept an unrelated surviving claim as coverage", () => {
    const snapshot = workWeeklyTestSnapshot(); const generated = [atomicItem("日期记录")];
    const coverage = [...snapshot.findings, ...snapshot.todos, ...snapshot.todoEvents].map((source) => ({ ...fullCoverage()[0]!, sourceRef: source.sourceRef }));
    expect(assess(snapshot, generated, coverage).reasonCodes).toContain("coverage_contract_invalid");
  });

  it("allows duplicate canonical sources to share one surviving claim through shared Evidence", () => {
    const snapshot = compactSnapshot();
    const copy = { ...snapshot.findings[0]!, id: "duplicate", sourceRef: "work:finding:duplicate" };
    snapshot.findings.push(copy);
    const identity = snapshot.identities.find((source) => source.sourceRef === WORK_WEEKLY_TEST_REFS.dated)!;
    snapshot.identities.push({ ...identity, sourceRef: copy.sourceRef, sourceId: copy.id });
    snapshot.allowlistedSourceRefs.push(copy.sourceRef);
    const coverage: WorkWeeklyCoverageAssessment[] = [...fullCoverage(), { sourceRef: copy.sourceRef, status: "not_applicable", reasonCode: "duplicate", claimIds: ["claim_atomic"] }];
    expect(assess(snapshot, undefined, coverage)).toMatchObject({ status: "passed", coveredSourceCount: 1, notApplicableSourceCount: 1 });
  });

  it.each(["background_only", "outside_week"] as const)("does not hide an unresolved canonical issue as %s", (reasonCode) => {
    const snapshot = compactSnapshot(); snapshot.findings[0]!.kind = "open_question";
    snapshot.findings[0]!.body = "保留期限尚未明确，负责人也未接受。";
    expect(assess(snapshot, undefined, [{ sourceRef: WORK_WEEKLY_TEST_REFS.dated, status: "not_applicable", reasonCode, claimIds: [] }]).reasonCodes)
      .toContain("coverage_not_applicable_invalid");
  });

  it("invalidates coverage when a required claim was filtered", () => {
    const generated = [atomicItem("若记录正文则放弃指标", { section: "in_progress" })];
    expect(assess(undefined, generated, undefined, verdictsFor(generated, ["section_mismatch"])).reasonCodes).toContain("coverage_claim_filtered");
  });

  it.each(["covered", "duplicate"] as const)("keeps %s when a policy-rejected redundant claim has identical published content", (reason) => {
    const text = "保留规则尚未明确，负责人也未接受。";
    const items = [atomicItem(text), atomicItem(text, { id: "redundant", claims: [{
      id: "wrong_type", text, claimType: "decision", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated]
    }] })];
    const coverage: WorkWeeklyCoverageAssessment[] = [{ sourceRef: WORK_WEEKLY_TEST_REFS.dated,
      status: reason === "covered" ? "covered" : "not_applicable", reasonCode: reason,
      claimIds: ["claim_atomic", "wrong_type"] }];
    expect(assess(undefined, items, coverage).status).toBe("passed");
    const published = applyWorkWeeklyClaimPublicationPolicy({ snapshot: compactSnapshot(), items, verdicts: verdictsFor(items) });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ text, sourceRefs: [WORK_WEEKLY_TEST_REFS.dated] });
  });

  it.each(["covered", "duplicate"] as const)("marks %s needs_review when the filtered claim uniquely carries a qualification", (reason) => {
    const items = [atomicItem("第三批样本还在排查。"), atomicItem("unused", { id: "qualified", claims: [{
      id: "qualified", text: "第三批样本还在排查；若涉及敏感数据，必须先隔离。", claimType: "decision", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated]
    }] })];
    const coverage: WorkWeeklyCoverageAssessment[] = [{ sourceRef: WORK_WEEKLY_TEST_REFS.dated,
      status: reason === "covered" ? "covered" : "not_applicable", reasonCode: reason,
      claimIds: ["claim_atomic", "qualified"] }];
    expect(assess(undefined, items, coverage)).toMatchObject({ status: "needs_review", reasonCodes: ["coverage_claim_filtered"],
      reviewIssues: [{ sourceRef: WORK_WEEKLY_TEST_REFS.dated, reasonCode: "coverage_claim_filtered" }] });
  });

  it("does not treat truncated input as full quality", () => {
    const snapshot = compactSnapshot(); snapshot.summary.truncated = true;
    expect(assess(snapshot).reasonCodes).toContain("source_pack_truncated");
  });

  it.each([17, 0])("preserves %i verified items while keeping rejected claims out of the deliverable", async (safeCount) => {
    const snapshot = compactSnapshot();
    const texts = Array.from({ length: safeCount }, (_, index) => `第${index + 1}项观察有记录，后续结果未记录。`);
    snapshot.findings[0]!.body = [...texts, "另一个结论暂无证据。"].join("\n");
    const generated = [...texts, "错误断言已经证实。"].map((text, index) => atomicItem(text, {
      id: `topic_${index}`, claims: [{ id: `claim_${index}`, text, claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated] }]
    }));
    const verdicts = verdictsFor(generated);
    verdicts[verdicts.length - 1]!.verdict = "unsupported";
    verdicts[verdicts.length - 1]!.issueCodes = ["source_does_not_support_claim"];
    const result = await runWorkWeeklyGenerationPipeline({ accountId: snapshot.accountId, snapshot,
      synthesizer: { profile: workWeeklyProfile("synthesizer"), synthesize: async () => generated },
      verifier: { profile: workWeeklyProfile("verifier"), verify: async (call) => {
        call.onCoverage?.([{ sourceRef: WORK_WEEKLY_TEST_REFS.dated, status: "partial", reasonCode: "missing_key_content", claimIds: [] }]);
        return verdicts;
      } } });
    expect(result.status).toBe(safeCount ? "needs_review" : "no_safe_items");
    expect(result.items.map((item) => item.text).sort()).toEqual([...texts].sort());
    expect(result.quality_assessment).toMatchObject({ status: safeCount ? "needs_review" : "insufficient",
      reviewIssues: [{ sourceRef: WORK_WEEKLY_TEST_REFS.dated, reasonCode: "missing_key_content" }] });
    expect(JSON.stringify(result)).not.toContain("错误断言");
  });

  it("can publish a verified fact about a proposal and an accepted task with pending date, but not their upgrades", () => {
    const snapshot = workWeeklyTestSnapshot();
    const good = [
      { id: "proposal", text: "方案仍是提议，若涉及敏感正文则放弃；日期尚未确认。", claimType: "fact" as const, sourceRefs: [WORK_WEEKLY_TEST_REFS.proposal] },
      { id: "task", text: "Sam 已接受核对名单，日期尚未确认。", claimType: "commitment" as const, sourceRefs: [WORK_WEEKLY_TEST_REFS.commitment] }
    ];
    const bad = [
      { ...good[0]!, id: "upgrade", text: "方案已最终决定采用。" },
      { ...good[1]!, id: "due", text: "Sam 必须在周五前完成核对名单。" }
    ];
    const generated = [...good, ...bad].map((claim) => atomicItem(claim.text, { id: claim.id, section: "open_questions", claims: [claim] }));
    const verdicts = verdictsFor(generated);
    verdicts[2]!.verdict = "contradicted"; verdicts[2]!.issueCodes = ["proposal_not_decision"];
    verdicts[3]!.verdict = "partially_entailed"; verdicts[3]!.issueCodes = ["date_not_deadline"];
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot, items: generated, verdicts }).map((item) => item.text)).toEqual(good.map((claim) => claim.text));
  });
});

describe("Work Weekly atomic content quality", () => {
  it.each([false, true])("merges an exact fact/attention repeat with both references and trace retained (reversed=%s)", (reversed) => {
    const text = "测试环境参数尚未收到，联调结果未知。";
    const items = [
      atomicItem(text, { id: "fact", section: "open_questions", claims: [{
        id: "claim_fact", text, claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated]
      }] }),
      atomicItem(text, { id: "attention", section: "next_week", itemType: "suggestion", claims: [{
        id: "claim_attention", text, claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.assignment]
      }] })
    ];
    if (reversed) items.reverse();
    let trace: WorkWeeklyClaimPublicationTrace[] = [];
    const result = applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items,
      verdicts: verdictsFor(items), onClaims: (value) => { trace = value; } });
    expect(result).toEqual([expect.objectContaining({ text, section: "open_questions", sortOrder: 0,
      sourceRefs: [WORK_WEEKLY_TEST_REFS.dated, WORK_WEEKLY_TEST_REFS.assignment].sort() })]);
    expect(trace).toHaveLength(2);
    expect(trace.find((entry) => entry.claimId === "claim_fact"))
      .toMatchObject({ outcome: "published", reasonCode: "accepted", publishedSortOrder: 0 });
    expect(trace.find((entry) => entry.claimId === "claim_attention"))
      .toMatchObject({ outcome: "merged", reasonCode: "exact_duplicate", publishedSortOrder: 0 });
  });

  it("keeps attention with a distinct gap and a separate interpretation stance", () => {
    const fact = "已完成桌面端检查，移动端验证结果未知。";
    const attention = "移动端验证结果未知，尚无覆盖移动端的检查记录。";
    const items = [
      atomicItem(fact, { id: "fact", section: "in_progress", claims: [{
        id: "claim_fact", text: fact, claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated]
      }] }),
      atomicItem(attention, { id: "attention", section: "next_week", itemType: "suggestion", claims: [{
        id: "claim_attention", text: attention, claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated]
      }] }),
      atomicItem(fact, { id: "interpretation", itemType: "interpretation", claims: [{
        id: "claim_interpretation", text: fact, claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated]
      }] })
    ];
    let trace: WorkWeeklyClaimPublicationTrace[] = [];
    const result = applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items,
      verdicts: verdictsFor(items), onClaims: (value) => { trace = value; } });
    expect(result.map((entry) => entry.text)).toEqual(expect.arrayContaining([
      fact, `AI建议关注：${attention}`, `根据本周记录，可谨慎理解为：${fact}`
    ]));
    expect(result).toHaveLength(3);
    expect(trace.every((entry) => entry.outcome === "published")).toBe(true);
  });

  it("passes generation context once and does not mistake missing coverage for quality passed", async () => {
    const generated = [atomicItem("观察记录尚未验证效率提升。")];
    const synthesize = vi.fn(async () => generated);
    const verify = vi.fn(async () => verdictsFor(generated));
    const result = await runWorkWeeklyGenerationPipeline({
      accountId: "account_a", snapshot: workWeeklyTestSnapshot(),
      synthesizer: { profile: workWeeklyProfile("synthesizer"), synthesize },
      verifier: { profile: workWeeklyProfile("verifier"), verify }
    });
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ items: generated, claims: generated[0]!.claims }));
    expect(result.status).toBe("quality_insufficient");
    expect(result.quality_assessment.reasonCodes).toContain("coverage_not_assessed");
    expect(result.items).toEqual([]);
  });

  it("merges exact duplicates' supported refs without dropping changed facts", () => {
    const items = [atomicItem("unused", { claims: [
      { id: "a", text: "同一观察", claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated] },
      { id: "b", text: "同一观察", claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.assignment] },
      { id: "c", text: "同一观察仍未验证", claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated] }
    ] })];
    const result = applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items, verdicts: verdictsFor(items) });
    expect(result[0]).toMatchObject({ text: "同一观察；同一观察仍未验证", sourceRefs: [WORK_WEEKLY_TEST_REFS.assignment, WORK_WEEKLY_TEST_REFS.dated] });
  });

  it("rejects completion prose that upgrades a system event into actual delivery", () => {
    const items = item("completion", [WORK_WEEKLY_TEST_REFS.todoCompleted], "在系统中标记完成，因此实际交付了清单");
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items, verdicts: verdictsFor(items) })).toEqual([]);
  });

  it("keeps an explicit disclaimer that system completion does not prove delivery", () => {
    const text = "清单在系统中标记完成，不代表现实履行或实际交付。";
    const items = item("completion", [WORK_WEEKLY_TEST_REFS.todoCompleted], text);
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items, verdicts: verdictsFor(items) })[0]?.text).toBe(text);
  });

  it.each([
    "首轮采用决定、建议、行动项分类，效率提升不在首轮对外表述",
    "6次反馈分不清正式决定、个人建议还是待确认代办"
  ])("preserves category nouns without treating them as assertions: %s", (text) => {
    const items = [atomicItem(text)];
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items, verdicts: verdictsFor(items) })[0]?.text).toBe(text);
  });

  it("preserves a decision's code-completion explanation and non-delivery boundary", () => {
    const snapshot = workWeeklyTestSnapshot();
    snapshot.findings[0]!.structuredData = { decisionFinality: "tentative" };
    snapshot.findings[0]!.body = "仅每日摘要，决定是否最终待确认";
    const text = "暂定仅每日摘要，已完成的实时提醒代码保持关闭、不算交付，最终性未确认";
    const items = item("decision", [WORK_WEEKLY_TEST_REFS.decision], text);
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot, items, verdicts: verdictsFor(items) })[0]?.text).toBe(text);
  });

  it("merges identical claims across items without expanding a duplicated Finding title/body", () => {
    const snapshot = workWeeklyTestSnapshot();
    const exportDecision = "首轮不提供周报导出：权限规则未定，试点手工两次后重评，并非取消需求。";
    const digestDecision = "仅提供每日摘要，不做实时提醒或个人开关；现有代码关闭且不算交付，试点后评估恢复。";
    snapshot.findings[0]!.title = exportDecision;
    snapshot.findings[0]!.body = `${exportDecision}${exportDecision}${digestDecision}`;
    const claim = (id: string, text: string): WorkWeeklyGeneratedClaim => ({
      id, text, claimType: "decision", sourceRefs: [WORK_WEEKLY_TEST_REFS.decision]
    });
    const items = [
      atomicItem(exportDecision, { id: "export", section: "decisions", claims: [claim("e1", exportDecision), claim("e2", exportDecision)] }),
      atomicItem(digestDecision, { id: "digest", section: "decisions", claims: [claim("d1", digestDecision)] }),
      atomicItem(exportDecision, { id: "duplicate", section: "decisions", claims: [claim("e3", exportDecision)] }),
      atomicItem(exportDecision, { id: "overview", claims: [claim("e4", exportDecision)] })
    ];
    const result = applyWorkWeeklyClaimPublicationPolicy({ snapshot, items, verdicts: verdictsFor(items) });
    expect(result.map((item) => item.text).sort()).toEqual([exportDecision, digestDecision].sort());
    expect(result.every((item) => item.section === "decisions")).toBe(true);
    expect(result.every((item) => item.sourceRefs.join() === WORK_WEEKLY_TEST_REFS.decision)).toBe(true);
  });

  it("retains distinct dates, changes, exceptions and hypotheses without similarity filtering", () => {
    const texts = [
      "开放日由9/18改为9/22；9/19冻结、9/21培训，冻结后仅接受阻断缺陷。",
      "观察到12人、28次交接、6次分类困惑；效率提升仍只是假设。",
      "移动验证先比较两个方案，尚未承诺采用任一方案。",
      "移动验证先比较两个方案，仅在安全评审通过时采用方案一。"
    ];
    const items = texts.map((text, i) => atomicItem(text, {
      id: `item_${i}`, section: "open_questions", claims: [{
        id: `claim_${i}`, text, claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated]
      }]
    }));
    const result = applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items, verdicts: verdictsFor(items) });
    expect(result.map((item) => item.text)).toEqual(texts);
  });

  it.each(["final", "tentative", "unclear", null])("does not erase explicit uncertainty when finality=%s", (finality) => {
    const snapshot = workWeeklyTestSnapshot();
    snapshot.findings[0]!.structuredData = { decisionFinality: finality };
    snapshot.findings[0]!.body = "开放日改为9/22，决定是否最终待确认。";
    const unsafe = item("decision", [WORK_WEEKLY_TEST_REFS.decision], "最终决定开放日改为9/22。");
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot, items: unsafe, verdicts: verdictsFor(unsafe, ["decision_finality_conflict"]) })).toEqual([]);
    const safe = item("decision", [WORK_WEEKLY_TEST_REFS.decision], "会议记录的安排：开放日改为9/22，最终性未确认。");
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot, items: safe, verdicts: verdictsFor(safe) })[0]?.text)
      .toBe(safe[0]!.claims[0]!.text);
  });

  it.each([
    ["tentative", "暂定采用方案 B"],
    ["unclear", "采用方案 B 的安排最终性未确认"],
    [null, "采用方案 B 的安排最终性未确认"]
  ])("distinguishes tentative and unknown finality=%s", (finality, text) => {
    const snapshot = workWeeklyTestSnapshot();
    snapshot.findings[0]!.structuredData = { decisionFinality: finality };
    snapshot.findings[0]!.body = "采用方案 B";
    const unsafe = item("decision", [WORK_WEEKLY_TEST_REFS.decision], "采用方案 B");
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot, items: unsafe, verdicts: verdictsFor(unsafe, ["decision_finality_conflict"]) })).toEqual([]);
    const safe = item("decision", [WORK_WEEKLY_TEST_REFS.decision], text!);
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot, items: safe, verdicts: verdictsFor(safe) })[0]?.text).toBe(text);
  });

  it.each([
    ["最终决定采用方案 C", WORK_WEEKLY_TEST_REFS.proposal],
    ["Alex 承诺负责跟进", WORK_WEEKLY_TEST_REFS.assignment],
    ["已实际履行清单", WORK_WEEKLY_TEST_REFS.todoCompleted],
    ["截止日期是9/5", WORK_WEEKLY_TEST_REFS.dated],
    ["先讨论因此采用 B", WORK_WEEKLY_TEST_REFS.evidenceDated],
    ["反复选择 B", WORK_WEEKLY_TEST_REFS.evidenceDecision]
  ])("blocks high-risk semantics disguised as fact: %s", (text, ref) => {
    const items = [atomicItem(text, { claims: [{ id: "claim_atomic", text, claimType: "fact", sourceRefs: [ref] }] })];
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items, verdicts: verdictsFor(items) })).toEqual([]);
  });

  it("never publishes partially entailed prose, even alongside a safe independent claim", () => {
    const items = [atomicItem("安全事实", { claims: [
      { id: "safe", text: "9/5出现在文档中", claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated] },
      { id: "partial", text: "采用 B，同时取消所有后续需求", claimType: "decision", sourceRefs: [WORK_WEEKLY_TEST_REFS.decision] }
    ] })];
    const verdicts = verdictsFor(items);
    verdicts[1]!.verdict = "partially_entailed";
    const result = applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items, verdicts });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ text: "9/5出现在文档中", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated] });
  });

  it.each(["source_does_not_support_claim", "claim_type_mismatch", "non_atomic_claim", "mixed_topics", "section_mismatch"])("rejects entailed carrying %s", (issue) => {
    const items = [atomicItem("一个事实")];
    const verdicts = verdictsFor(items);
    verdicts[0]!.issueCodes = [issue];
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items, verdicts })).toEqual([]);
  });

  it.each([
    "若评审会记录敏感内容则放弃指标",
    "技术结论由周琦给出，自己仅组织保存观察",
    "运营需两个工作日准备引导材料"
  ])("does not force non-progress into in_progress: %s", (text) => {
    const items = [atomicItem(text, { section: "in_progress" })];
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items, verdicts: verdictsFor(items, ["section_mismatch"]) })).toEqual([]);
  });

  it("keeps a verified underway state", () => {
    const items = [atomicItem("移动验证正在进行中，目前仅记录观察，尚未承诺采用任何方案。", { section: "in_progress" })];
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items, verdicts: verdictsFor(items) })[0]?.text)
      .toBe(items[0]!.claims[0]!.text);
  });

  it("accepts verified natural qualifications and progress without mandatory keywords", () => {
    const snapshot = workWeeklyTestSnapshot();
    snapshot.findings[0]!.structuredData = { decisionFinality: "tentative" };
    snapshot.findings[0]!.body = "目前倾向方案 B，拍板还要等评审。";
    const decision = item("decision", [WORK_WEEKLY_TEST_REFS.decision], "方案 B 是目前的选择，评审后才会拍板。");
    const progress = atomicItem("接口联调已经跑过两批样本，第三批还在排查超时。", { section: "in_progress" });
    const items = [...decision, progress];
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot, items, verdicts: verdictsFor(items) }).map((entry) => entry.text))
      .toEqual(expect.arrayContaining(items.map((entry) => entry.claims[0]!.text)));
  });

  it("publishes a single verified attention statement without a second title authority", () => {
    const items = [atomicItem("SSO沙盒账号：尚未开放，登录联调仍缺可用环境。", {
      section: "next_week", itemType: "suggestion", text: "SSO沙盒可用性（未核验摘要）"
    })];
    const result = applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items, verdicts: verdictsFor(items) });
    expect(result[0]?.text).toBe(`AI建议关注：${items[0]!.claims[0]!.text}`);
    expect(result[0]?.sourceRefs).toEqual([WORK_WEEKLY_TEST_REFS.dated]);
    const partial = verdictsFor(items);
    partial[0]!.verdict = "partially_entailed";
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items, verdicts: partial })).toEqual([]);
  });

  it.each(["李明周五完成SSO", "SSO沙盒尚未开放，登录联调仍缺可用环境。", "9/9完成SSO", "必须开放SSO", "下周SSO沙盒", "SSO沙盒；移动验证"])("ignores unverified next_week summary metadata: %s", (target) => {
    const items = [atomicItem("SSO沙盒尚未开放，登录联调仍缺可用环境。", { section: "next_week", itemType: "suggestion", text: target })];
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items, verdicts: verdictsFor(items) })[0]?.text)
      .toBe("AI建议关注：SSO沙盒尚未开放，登录联调仍缺可用环境。");
  });

  it.each(["unsupported", "contradicted", "unverifiable", "partially_entailed"] as const)("does not turn %s attention grounds into advice", (verdict) => {
    const items = [atomicItem("李明必须在周五开放SSO，已承诺完成。", { section: "next_week", itemType: "suggestion", text: "SSO" })];
    const verdicts = verdictsFor(items); verdicts[0]!.verdict = verdict;
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items, verdicts })).toEqual([]);
  });

  it("rejects verifier issues on the single attention statement", () => {
    const items = [atomicItem("SSO仍缺账号。", { section: "next_week", itemType: "suggestion" })];
    const verdicts = verdictsFor(items); verdicts[0]!.issueCodes = ["invalid_attention_target"];
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items, verdicts })).toEqual([]);
  });

  it("merges equal verified attention statements across different free summaries and preserves trace refs", () => {
    const text = "测试环境账号：尚未开放，联调前提未具备。";
    const items = [
      atomicItem(text, { id: "a", section: "next_week", itemType: "suggestion", text: "任意摘要A" }),
      atomicItem(text, { id: "b", section: "next_week", itemType: "suggestion", text: "完全不同的摘要B", claims: [{
        id: "claim_b", text, claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.assignment]
      }] })
    ];
    let trace: WorkWeeklyClaimPublicationTrace[] = [];
    const result = applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items, verdicts: verdictsFor(items),
      onClaims: (entries) => { trace = entries; } });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ text: `AI建议关注：${text}`, sourceRefs: [WORK_WEEKLY_TEST_REFS.assignment, WORK_WEEKLY_TEST_REFS.dated] });
    expect(trace.map((entry) => [entry.outcome, entry.publishedSortOrder])).toEqual([["published", 0], ["merged", 0]]);
  });

  it("keeps next_week a single self-contained unit at the publication seam", () => {
    const items = [atomicItem("unused", { section: "next_week", itemType: "suggestion", text: "SSO", claims: [
      { id: "first", text: "SSO尚未开放。", claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated] },
      { id: "second", text: "SSO是否可供正式联调仍需确认。", claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.assignment] }
    ] })];
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items, verdicts: verdictsFor(items) })).toEqual([]);
  });

  it("keeps multiple atomic facts in one item for QA and joins only their supported refs", () => {
    const items = [atomicItem("unused", { claims: [
      { id: "a", text: "第一项状态已记录", claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated] },
      { id: "b", text: "第二项状态已记录", claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.assignment] }
    ] })];
    const result = applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items, verdicts: verdictsFor(items) });
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("第一项状态已记录；第二项状态已记录");
    expect(result[0]?.sourceRefs).toEqual([WORK_WEEKLY_TEST_REFS.assignment, WORK_WEEKLY_TEST_REFS.dated]);
  });

  it("rejects verifier source expansion at the direct policy seam", () => {
    const items = [atomicItem("一个事实")];
    const verdicts = verdictsFor(items);
    verdicts[0]!.supportedSourceRefs = [WORK_WEEKLY_TEST_REFS.decision];
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items, verdicts })).toEqual([]);
  });

  it("rejects a non-allowlisted claim ref even when the verifier omits it", () => {
    const items = [atomicItem("一个事实")];
    const verdicts = verdictsFor(items);
    items[0]!.claims[0]!.sourceRefs.push("work:finding:foreign");
    verdicts[0]!.supportedSourceRefs = [WORK_WEEKLY_TEST_REFS.dated];
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot: workWeeklyTestSnapshot(), items, verdicts })).toEqual([]);
  });
});

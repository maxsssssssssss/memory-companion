// Anonymous, deterministic acceptance. All structured responses are injected.
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { WorkWeeklySourceSnapshotSchema, type WorkWeeklySourceSnapshot } from "@/lib/domain/work-weekly";
import { createOpenAIClient } from "@/lib/server/openai/client";
import {
  createStructuredWorkWeeklyClaimVerifier, createStructuredWorkWeeklySynthesizer,
  WorkWeeklySynthesizerResponseSchema, WorkWeeklyGenerationVerifierResponseSchema,
  type WorkWeeklyGeneratedClaim, type WorkWeeklyGeneratedItem,
  type WorkWeeklyStructuredJsonRequest, type WorkWeeklyVerifierItem
} from "./weekly-ai-provider";
import { workWeeklyModelResponse, workWeeklyProfile, workWeeklyTestSnapshot } from "./weekly-ai-test-fixture";
import { applyWorkWeeklyClaimPublicationPolicy, runWorkWeeklyGenerationPipeline } from "./weekly-publication-policy";
import {
  answerWorkWeeklyQuestion, createStructuredWorkWeeklyQaAnswerer,
  createStructuredWorkWeeklyQaVerifier, WORK_WEEKLY_QA_INSUFFICIENT_ANSWER
} from "./weekly-qa-provider";

vi.mock("@/lib/server/openai/client", () => ({ createOpenAIClient: vi.fn(() => {
  throw new Error("Real Provider is forbidden in this independent fixture");
}) }));

type Claim = WorkWeeklyGeneratedClaim;
type Item = WorkWeeklyGeneratedItem;
type Verdict = WorkWeeklyVerifierItem;
type Snapshot = WorkWeeklySourceSnapshot;
type FindingSpec = { title: string; body: string; kind?: Snapshot["findings"][number]["kind"];
  finality?: "final" | "tentative" | "unclear" | null };
const ref = (index: number) => `work:finding:independent_${index}`;
const evidenceRef = (index: number) => `work:evidence:independent_${index}`;
const observed: Array<{ name: string; generated: Item[]; published: unknown }> = [];

function snapshot(...specs: FindingSpec[]): Snapshot {
  const base = workWeeklyTestSnapshot();
  const findings = specs.map((spec, index) => ({
    ...base.findings[0]!, id: `independent_${index}`, sourceRef: ref(index),
    kind: spec.kind ?? "decision", title: spec.title, body: spec.body,
    structuredData: { decisionFinality: spec.finality ?? "final", rawActorLabel: null,
      candidateOwner: null, dueAt: null, originalDueExpression: null, actionBasis: null,
      relatedCommitmentCandidateId: null, planStages: [] },
    evidenceRefs: [evidenceRef(index)]
  }));
  const evidence = specs.map((spec, index) => ({ ...base.evidence[0]!, sourceRef: evidenceRef(index),
    segmentId: `independent_segment_${index}`, text: spec.body }));
  const identities: Snapshot["identities"] = [
    base.identities.find((identity) => identity.sourceKind === "meeting")!,
    ...findings.map((finding) => ({ sourceRef: finding.sourceRef, sourceKind: "finding" as const,
      sourceId: finding.id, version: finding.version, digest: "d".repeat(64), publicationId: null,
      segmentId: null, included: true })),
    ...evidence.map((source) => ({ sourceRef: source.sourceRef, sourceKind: "evidence" as const,
      sourceId: source.segmentId, version: null, digest: source.publicationDigest,
      publicationId: source.publicationId, segmentId: source.segmentId, included: true }))
  ];
  return WorkWeeklySourceSnapshotSchema.parse({ ...base, findings, evidence, identities,
    todos: [], todoEvents: [], projects: [], allowlistedSourceRefs: identities.map((entry) => entry.sourceRef).sort(),
    summary: { ...base.summary, findingCount: specs.length, evidenceCount: specs.length,
      includedFindingCount: specs.length, includedEvidenceCount: specs.length,
      todoCount: 0, todoEventCount: 0, includedTodoCount: 0, includedTodoEventCount: 0 } });
}
function claim(id: string, text: string, index = 0, claimType: Claim["claimType"] = "fact"): Claim {
  return { id, text, claimType, sourceRefs: [ref(index)] };
}
function item(id: string, claims: Claim[], section: Item["section"] = "overview", text = "未经核验的合成 item 正文"): Item {
  return { id, claims, section, text, itemType: section === "next_week" ? "suggestion" : "evidence_backed_fact" };
}
function verdict(claim: Claim, overrides: Partial<Verdict> = {}): Verdict {
  return { claimId: claim.id, verdict: "entailed", issueCodes: [], supportedSourceRefs: claim.sourceRefs, ...overrides };
}
function publish(name: string, sources: Snapshot, items: Item[], verdicts = items.flatMap((entry) => entry.claims.map((c) => verdict(c)))) {
  const published = applyWorkWeeklyClaimPublicationPolicy({ snapshot: sources, items, verdicts });
  observed.push({ name, generated: items, published });
  return published;
}
function packet<T>(request: Parameters<WorkWeeklyStructuredJsonRequest>[0]): T {
  if (!Array.isArray(request.requestInput)) throw new Error("Expected actual structured message envelope");
  const message = request.requestInput[1];
  if (!message || !("content" in message) || typeof message.content !== "string") throw new Error("Expected string user message");
  return JSON.parse(message.content) as T;
}
function systemText(request: Parameters<WorkWeeklyStructuredJsonRequest>[0]) {
  if (!Array.isArray(request.requestInput)) throw new Error("Expected actual structured message envelope");
  const message = request.requestInput[0];
  if (!message || !("content" in message) || typeof message.content !== "string") throw new Error("Expected string system message");
  return message.content;
}
function generation(items: Item[]) {
  const request = vi.fn<WorkWeeklyStructuredJsonRequest>(async (input) => {
    if (input.profile.role === "synthesizer") return workWeeklyModelResponse(items);
    const payload = packet<{ items: Array<{ claim: Claim }>; coverageSources: Array<{ source: { sourceRef: string }; sourceText: string }> }>(input);
    return { items: payload.items.map(({ claim }) => verdict(claim)), disputes: [],
      coverage: payload.coverageSources.map(({ source: { sourceRef }, sourceText }) => {
        const selected = payload.items.filter(({ claim }) => claim.sourceRefs.includes(sourceRef));
        return { sourceRef, status: "covered", reasonCode: "covered", claimIds: selected.map(({ claim }) => claim.id),
          matches: selected.map(({ claim }) => ({ claimId: claim.id, sourceExcerpt: sourceText.slice(0, 600), claimExcerpt: claim.text.slice(0, 600) })) };
      }) };
  });
  return { request,
    synthesizer: createStructuredWorkWeeklySynthesizer({ profile: workWeeklyProfile("synthesizer"), requestStructuredJson: request }),
    verifier: createStructuredWorkWeeklyClaimVerifier({ profile: workWeeklyProfile("verifier"), requestStructuredJson: request }) };
}
function qa(claims: Claim[], changeVerdict: (c: Claim) => Verdict = verdict) {
  const request = vi.fn<WorkWeeklyStructuredJsonRequest>(async (input) => input.profile.role === "qa_answerer"
    ? { status: "answered", answer: "未经核验的整段回答不得直接发布", claims,
      relevantSourceRefs: [...new Set(claims.flatMap((entry) => entry.sourceRefs))] }
    : { items: packet<{ items: Array<{ claim: Claim }> }>(input).items.map(({ claim }) => changeVerdict(claim)) });
  return { request,
    answerer: createStructuredWorkWeeklyQaAnswerer({ profile: workWeeklyProfile("qa_answerer"), requestStructuredJson: request }),
    verifier: createStructuredWorkWeeklyQaVerifier({ profile: workWeeklyProfile("qa_verifier"), requestStructuredJson: request }) };
}

const exportFinding: FindingSpec = { title: "周报导出首轮关闭", finality: "final",
  body: "周报导出首轮关闭。权限范围尚未明确，先人工运行两次再评估，并非取消。决定是否最终待确认。" };
const exportAtoms = [
  "周报导出首轮关闭，权限范围尚未明确；最终性未确认。",
  "周报导出先人工运行两次再评估，并非取消；最终性未确认。"
];
const summaryFinding: FindingSpec = { title: "每日摘要发布范围", finality: "tentative",
  body: "暂定仅上线每日摘要，已完成的实时提醒代码保持关闭，不算交付；决定是否最终待确认。" };
const summaryAtom = "暂定仅上线每日摘要，已完成的实时提醒代码保持关闭，不算交付；最终性未确认。";

afterAll(() => {
  expect(createOpenAIClient).not.toHaveBeenCalled();
  const outputDir = process.env.WORK_WEEKLY_INDEPENDENT_OUTPUT_DIR ?? "output";
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(`${outputDir}/work-weekly-quality-independent-20260909-synthetic-outputs.json`,
    JSON.stringify({ evidence: "anonymous offline fixture; not real model or production", cases: observed }, null, 2));
});

describe("1-4/11 independent atomic content preservation", () => {
  it("1/11 does not multiply an entire Finding when two atomic claims cite it", () => {
    const claims = exportAtoms.map((text, index) => claim(`export_${index}`, text, 0, "decision"));
    const output = publish("one decision, two atoms", snapshot(exportFinding), [item("export", claims, "decisions")]);
    expect(output).toHaveLength(1);
    expect(output[0]!.text).toBe(exportAtoms.join("；"));
    expect(output[0]!.text).not.toContain(exportFinding.body);
    expect(output[0]!.sourceRefs).toEqual([ref(0)]);
  });
  it("2/11 retains the second decision instead of replacing both with the first source", () => {
    const claims = [claim("export", exportAtoms[0]!, 0, "decision"), claim("summary", summaryAtom, 1, "decision")];
    const output = publish("two release decisions", snapshot(exportFinding, summaryFinding), [item("release", claims, "decisions")]);
    expect(output[0]!.text).toBe(`${exportAtoms[0]}；${summaryAtom}`);
    expect(output[0]!.sourceRefs).toEqual([ref(0), ref(1)]);
  });
  it.each([
    ["权限范围保持关闭", "权限范围保持关闭；等待评估。"],
    ["权限范围保持关闭。", "权限范围保持关闭！"]
  ])("3/11 does not concatenate source title '%s' with its overlapping body", (title, body) => {
    const text = "权限范围保持关闭。";
    const output = publish("title/body overlap", snapshot({ title, body }), [item("overlap", [claim("c", text, 0, "decision")], "decisions")]);
    expect(output[0]!.text).toBe(text);
  });
  it.each([
    { title: "发布计划变化", kind: "plan_change" as const,
      body: "发布日期由9月18日调整为9月22日；9月19日冻结，9月21日培训；冻结后只处理阻断缺陷。" },
    { title: "试用记录", kind: "proposal" as const,
      body: "本周12人使用28次，6次反馈分不清正式决定、个人建议还是待确认代办；效率改善仍是假设，尚未测量。" }
  ])("4/11 preserves complete dates, exceptions and hypotheses: $title", (source) => {
    const output = publish(source.title, snapshot(source), [item("facts", [claim("c", source.body)], "progress")]);
    expect(output[0]!.text).toBe(source.body);
    expect(output[0]!.verificationState).toBe("verified");
  });
});

describe("5-7/11 independent semantic safety gates and positive controls", () => {
  it.each([
    ["final", "决定是否最终待确认。", "最终决定上线每日摘要。", false],
    ["final", "决定是否最终待确认。", "每日摘要上线范围最终性未确认。", true],
    ["tentative", "暂定上线每日摘要。", "最终决定上线每日摘要。", false],
    ["tentative", "暂定上线每日摘要。", "暂定上线每日摘要。", true],
    ["unclear", "每日摘要发布范围待议。", "已确认决定上线每日摘要。", false],
    ["unclear", "每日摘要发布范围待议。", "每日摘要发布范围最终性未确认。", true]
  ] as const)("5/11 respects %s with source caveat %s", (finality, body, text, accepted) => {
    const sources = snapshot({ title: "每日摘要", body, finality });
    expect(sources.findings[0]!.userConfirmedAt).not.toBeNull();
    const unit = claim("c", text, 0, "decision");
    const output = publish("semantic finality verdict", sources, [item("decision", [unit], "decisions")],
      [verdict(unit, accepted ? {} : { verdict: "contradicted", issueCodes: ["decision_finality_conflict"] })]);
    expect(output).toHaveLength(accepted ? 1 : 0);
    if (accepted) expect(output[0]!.text).toBe(text);
  });
  it.each([
    "最终决定采用自动导出。", "成员甲已实际交付所有承诺。",
    "截止日期是9月22日。", "分类提示导致效率提升。"
  ])("6/11 rejects a risky assertion disguised as fact: %s", (text) => {
    const sources = snapshot({ title: "未决建议", body: "建议评估导出；尚未承诺日期，效率变化未测量。", kind: "proposal" });
    expect(publish("disguised fact", sources, [item("risk", [claim("c", text)])])).toEqual([]);
  });
  it.each([
    ["overview", "采用决定、建议、行动项分类。"],
    ["progress", "6次反馈分不清正式决定、个人建议还是待确认代办。"]
  ] as const)("6/11 retains normal %s noun mentions: %s", (section, text) => {
    const output = publish("normal noun mentions", snapshot({ title: "分类记录", body: text, kind: "proposal" }), [item("normal", [claim("c", text)], section)]);
    expect(output[0]!.text).toBe(text);
  });
  it("6/11 retains a qualified decision mentioning completed but disabled code", () => {
    const output = publish("disabled code is not delivery", snapshot(summaryFinding), [item("summary", [claim("c", summaryAtom, 0, "decision")], "decisions")]);
    expect(output[0]!.text).toBe(summaryAtom);
  });
  it("7/11 drops an entire partially supported atom while retaining a separate supported atom", () => {
    const sources = snapshot(
      { title: "试用数据", body: "12人使用28次。", kind: "proposal" },
      { title: "效率反馈", body: "试用后效率改善尚未测量。", kind: "proposal" }
    );
    const safe = claim("safe", "12人使用28次。");
    const partial = claim("partial", "试用后效率提升50%。", 1);
    const output = publish("partial is not safe with a qualifier", sources, [item("trial", [safe, partial])],
      [verdict(safe), verdict(partial, { verdict: "partially_entailed" })]);
    expect(output[0]!.text).toBe(safe.text);
    expect(output[0]!.text).not.toMatch(/50%|谨慎|限定/);
  });
  it("7/11 does not publish an unqualified remainder when a sibling from the same source is rejected", () => {
    const sources = snapshot({ title: "试用数据", body: "12人使用28次；效率改善尚未测量。", kind: "proposal" });
    const safe = claim("safe", "12人使用28次。");
    const partial = claim("partial", "12人使用28次，并且效率提升50%。");
    expect(publish("same-source qualification cannot be discarded", sources, [item("trial", [safe, partial])],
      [verdict(safe), verdict(partial, { verdict: "partially_entailed" })])).toEqual([]);
  });
});

describe("8-9/11 independent deduplication and authority", () => {
  it("8/11 merges identical atoms and references, preferring a specific section", () => {
    const text = "导出权限范围尚未确认。";
    const sources = snapshot({ title: "范围甲", body: text }, { title: "范围乙", body: text });
    const output = publish("exact cross-section duplicate", sources,
      [item("overview", [claim("a", text)]), item("question", [claim("b", text, 1)], "open_questions")]);
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ section: "open_questions", text, sourceRefs: [ref(0), ref(1)] });
  });
  it("8/11 retains similar facts with different dates, scopes and conditions", () => {
    const texts = ["试点甲9月18日开放，仅限内部账号。", "试点甲9月22日开放，权限通过后才含外部账号。", "试点乙9月18日开放，若授权不足则保持关闭。"];
    const sources = snapshot(...texts.map((body, index) => ({ title: `范围${index}`, body, kind: "proposal" as const })));
    const output = publish("substantive differences", sources, texts.map((text, index) => item(`i${index}`, [claim(`c${index}`, text, index)], "open_questions")));
    expect(output.map((entry) => entry.text)).toEqual(texts);
    expect(output.map((entry) => entry.sourceRefs)).toEqual([[ref(0)], [ref(1)], [ref(2)]]);
  });
  it("9/11 publishes only the verifier-supported citation subset", () => {
    const sources = snapshot(exportFinding, summaryFinding);
    const c = { ...claim("c", "周报导出权限范围尚未明确。"), sourceRefs: [ref(0), ref(1)] };
    const output = publish("supported citation subset", sources, [item("subset", [c])], [verdict(c, { supportedSourceRefs: [ref(0)] })]);
    expect(output[0]!.sourceRefs).toEqual([ref(0)]);
  });
  it("9/11 refuses invalid/out-of-scope references and fabricated supported references", () => {
    const sources = snapshot(exportFinding, summaryFinding);
    const outside = { ...claim("outside", "其他范围的记录。"), sourceRefs: ["work:finding:another_scope"] };
    expect(publish("outside scope", sources, [item("outside", [outside])])).toEqual([]);
    const c = claim("c", "权限范围待确认。");
    expect(publish("unsupported citation expansion", sources, [item("c", [c])], [verdict(c, { supportedSourceRefs: [ref(1)] })])).toEqual([]);
  });
  it("9/11 refuses an excluded source identity instead of reviving it", () => {
    const sources = snapshot(exportFinding);
    sources.identities.find((entry) => entry.sourceRef === ref(0))!.included = false;
    expect(() => applyWorkWeeklyClaimPublicationPolicy({ snapshot: sources, items: [item("c", [claim("c", "权限未决。")])], verdicts: [] })).toThrow("work_weekly_source_allowlist_invalid");
  });
  it("9/11 rejects another account before the structured request seam", async () => {
    const providers = generation([item("c", [claim("c", "权限未决。")])]);
    await expect(runWorkWeeklyGenerationPipeline({ accountId: "account_other", snapshot: snapshot(exportFinding), ...providers })).rejects.toThrow("work_weekly_snapshot_account_mismatch");
    expect(providers.request).not.toHaveBeenCalled();
  });
});

describe("10/11 actual prompt envelope and semantic section verdicts", () => {
  it("passes section/attention/sibling context in one verifier call with only each claim's own sources", async () => {
    const sources = snapshot({ title: "导出权限", body: "导出权限范围尚未确认。" }, { title: "导出权限", body: "导出权限审批入口尚未提供。" });
    const completeClaim = { ...claim("a", "导出权限范围尚未确认，导出权限审批入口尚未提供。"), sourceRefs: [ref(0), ref(1)] };
    const items = [item("attention", [completeClaim], "next_week", "导出权限")];
    const providers = generation(items);
    const result = await runWorkWeeklyGenerationPipeline({ accountId: sources.accountId, snapshot: sources, ...providers });
    expect(result.status).toBe("verified");
    expect(result.items[0]!.text).toBe("AI建议关注：导出权限范围尚未确认，导出权限审批入口尚未提供。");
    expect(providers.request).toHaveBeenCalledTimes(2);
    const synth = providers.request.mock.calls[0]![0];
    const verify = providers.request.mock.calls[1]![0];
    expect(synth.schema).not.toBe(WorkWeeklySynthesizerResponseSchema);
    expect(synth.schema.safeParse(workWeeklyModelResponse(items)).success).toBe(true);
    const fragmented = { items: [item("attention", [claim("a", "导出权限范围尚未确认。"),
      claim("b", "导出权限审批入口尚未提供。", 1)], "next_week", "导出权限")] };
    expect(WorkWeeklySynthesizerResponseSchema.safeParse(fragmented).success).toBe(true);
    expect(synth.schema.safeParse(fragmented).success).toBe(false);
    expect(verify.schema).toBe(WorkWeeklyGenerationVerifierResponseSchema);
    expect(systemText(synth)).toContain("generationGuidance");
    expect(systemText(synth)).toContain("observedThrough");
    expect(systemText(verify)).toContain("publicationContext");
    expect(systemText(verify)).toContain("不是 Evidence");
    expect(systemText(verify)).toContain("sourceQualifications");
    expect(systemText(verify)).toContain("candidateClaims");
    const envelope = packet<{ scope: Snapshot["scope"]; items: Array<{ claim: Claim; sources: Array<{ sourceRef: string }>;
      publicationContext: { section: string; itemType: string; siblingClaims: Array<{ id: string; text: string }> } }> }>(verify);
    expect(envelope.scope).toEqual(sources.scope);
    expect(envelope.items).toHaveLength(1);
    for (const entry of envelope.items) {
      expect(entry.sources.map((source) => source.sourceRef)).toEqual(entry.claim.sourceRefs);
      expect(entry.publicationContext).toMatchObject({ section: "next_week", itemType: "suggestion" });
      expect(entry.publicationContext).not.toHaveProperty("attentionTarget");
      expect(entry.publicationContext.siblingClaims.map((c) => c.text)).toEqual(items[0]!.claims.map((c) => c.text));
    }
    observed.push({ name: "actual generation adapters / fixture verdicts", generated: items, published: result.items });
  });
  it.each(["若权限通过即可开始集成。", "成员甲负责权限核对。", "准备权限样例需要三天。"]) (
    "does not label a condition, allocation or duration as work underway: %s", (text) => {
      const unit = claim("c", text);
      expect(publish("semantic section mismatch", snapshot({ title: "权限准备", body: text }),
        [item("progress", [unit], "in_progress")], [verdict(unit, { issueCodes: ["section_mismatch"] })])).toEqual([]);
    });
  it("keeps an explicit ongoing state", () => {
    const text = "权限样例核对正在进行中，当前已检查第一组。";
    expect(publish("actual ongoing state", snapshot({ title: "权限样例", body: text }), [item("progress", [claim("c", text)], "in_progress")])[0]!.text).toBe(text);
  });
  it.each(["成员甲负责导出权限", "9月22日前完成导出权限", "导出权限范围尚未确认。", "不存在的关注对象"]) (
    "never gives a free-form item title authority over the verified attention claim: %s", (target) => {
      const output = publish("free title has no publication authority", snapshot({ title: "导出权限", body: "导出权限范围尚未确认。" }),
        [item("attention", [claim("c", "导出权限范围尚未确认。")], "next_week", target)]);
      expect(output).toHaveLength(1);
      expect(output[0]).toMatchObject({ text: "AI建议关注：导出权限范围尚未确认。", sourceRefs: [ref(0)] });
    });
  it.each(["mixed_topics", "section_mismatch", "non_atomic_claim", "invalid_attention_target"]) (
    "honors verifier item-level rejection: %s", (issue) => {
      const unit = claim("a", "导出权限范围尚未确认，审批入口尚未提供。");
      expect(publish("verifier context rejection", snapshot({ title: "导出权限", body: unit.text }),
        [item("i", [unit], "next_week", "任意自由标题")], [verdict(unit, { issueCodes: [issue] })])).toEqual([]);
    });
  it("rejects the entire suggestion when one basis is partially supported", () => {
    const unit = claim("a", "导出权限范围尚未确认，但导出权限审批将于明天完成。");
    expect(publish("partially supported suggestion", snapshot({ title: "导出权限", body: "导出权限范围尚未确认。" }),
      [item("i", [unit], "next_week", "任意自由标题")], [verdict(unit, { verdict: "partially_entailed" })])).toEqual([]);
  });
  it("keeps strict DTO fields and section/itemType constraints without free-text fallback", async () => {
    const sources = snapshot(exportFinding);
    const modelResponse = workWeeklyModelResponse([item("i", [claim("c", "权限未决。")])]);
    const request = vi.fn<WorkWeeklyStructuredJsonRequest>().mockResolvedValue({ items: [{ ...modelResponse.items[0], quote: "fabricated" }] });
    const synthesizer = createStructuredWorkWeeklySynthesizer({ profile: workWeeklyProfile("synthesizer"), requestStructuredJson: request });
    await expect(synthesizer.synthesize({ accountId: sources.accountId, snapshot: sources })).rejects.toThrow("work_weekly_synthesizer_output_invalid");
    expect(request).toHaveBeenCalledTimes(1);
    const bad = { ...item("i", [claim("c", "权限未决。")], "next_week", "权限"), itemType: "evidence_backed_fact" as const };
    expect(publish("invalid suggestion DTO", sources, [bad])).toEqual([]);
  });
});

describe("QA adjacent use of the shared atomic publication policy", () => {
  const sources = () => snapshot(exportFinding, summaryFinding);
  const ask = (providers: ReturnType<typeof qa>, question = "本周会议有哪些发布范围决定？") => answerWorkWeeklyQuestion({
    accountId: "account_a", weeklyReviewId: "independent_weekly", snapshot: sources(), question, ...providers
  });
  it("keeps all supported QA atoms and their precise citations", async () => {
    const claims = [claim("a", exportAtoms[0]!, 0, "decision"), claim("b", summaryAtom, 1, "decision")];
    const providers = qa(claims);
    const output = await ask(providers);
    expect(WorkWeeklySynthesizerResponseSchema.safeParse({ items: [item("qa_multiple_claims", claims)] }).success).toBe(true);
    expect(output).toMatchObject({ answerStatus: "answered", answer: claims.map((c) => c.text).join("\n\n"), sourceRefs: [ref(0), ref(1)], failureCode: null });
    expect(providers.request).toHaveBeenCalledTimes(2);
    observed.push({ name: "QA two atomic answers", generated: [item("qa", claims)], published: output });
  });
  it("keeps the supported QA answer while excluding partial text and its citation", async () => {
    const claims = [claim("a", exportAtoms[0]!, 0, "decision"), claim("b", "每日摘要显著提升效率。", 1)];
    const output = await ask(qa(claims, (c) => verdict(c, c.id === "b" ? { verdict: "partially_entailed" } : {})));
    expect(output).toMatchObject({ answerStatus: "partially_answered", answer: claims[0]!.text, sourceRefs: [ref(0)] });
  });
  it.each(["谁应该被晋升？", "成员甲是否负责？", "按贡献给团队成员排名。"])("still refuses personnel judgments without a request: %s", async (question) => {
    const providers = qa([claim("a", "某人表现优秀。")]);
    expect(await ask(providers, question)).toMatchObject({ answerStatus: "insufficient_evidence", answer: WORK_WEEKLY_QA_INSUFFICIENT_ANSWER, sourceRefs: [] });
    expect(providers.request).not.toHaveBeenCalled();
  });
  it("fails closed when the QA draft cites another scope", async () => {
    const providers = qa([{ ...claim("a", "外部范围记录。"), sourceRefs: ["work:finding:outside_qa_pack"] }]);
    await expect(ask(providers)).rejects.toMatchObject({ code: "weekly_qa_source_not_allowlisted" });
    expect(providers.request).toHaveBeenCalledTimes(1);
  });
});

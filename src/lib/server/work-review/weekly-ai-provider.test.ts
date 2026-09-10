import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkWeeklySectionKindSchema } from "@/lib/domain/work-weekly";

import {
  createStructuredWorkWeeklyClaimVerifier,
  createStructuredWorkWeeklySynthesizer,
  resolveWorkWeeklySourceRecord,
  resolveWorkWeeklyProviderProfile,
  validateWorkWeeklyVerifierOutput,
  WorkWeeklyClaimTypeSchema,
  WorkWeeklyClaimVerdictSchema,
  WorkWeeklyProviderError,
  WorkWeeklyGenerationVerifierResponseSchema,
  workWeeklyCoverageSourceRefs,
  type WorkWeeklyCoverageAssessment,
  type WorkWeeklyStructuredJsonRequest
} from "./weekly-ai-provider";
import {
  buildWorkWeeklySynthesisResponseSchema, buildWorkWeeklySynthesisPack,
  WorkWeeklySynthesizerResponseSchema, validateWorkWeeklyCoverage,
  type WorkWeeklyGeneratedClaim, type WorkWeeklyVerifierItem
} from "./weekly-ai-provider";
import { runWorkWeeklyGenerationPipeline } from "./weekly-publication-policy";
import {
  WORK_WEEKLY_TEST_REFS,
  workWeeklyProfile,
  workWeeklyTestSnapshot
} from "./weekly-ai-test-fixture";

describe("Work Weekly AI providers", () => {
  it.each([
    ["synthesizer", "WORK_REVIEW_WEEKLY_SYNTHESIZER", 120_000, 16_000],
    ["verifier", "WORK_REVIEW_WEEKLY_VERIFIER", 120_000, 8_000],
    ["qa_answerer", "WORK_REVIEW_WEEKLY_QA_ANSWERER", 30_000, 4_000],
    ["qa_verifier", "WORK_REVIEW_WEEKLY_QA_VERIFIER", 30_000, 4_000]
  ] as const)("preserves independent %s budget defaults, explicit overrides and limits", (role, prefix, timeoutMs, maxOutputTokens) => {
    const env = { OPENAI_QA_MODEL: "configured-global-model" };
    const defaults = resolveWorkWeeklyProviderProfile(role, env);
    expect(defaults).toMatchObject({ timeoutMs, maxOutputTokens, model: "configured-global-model", reasoningEffort: "provider_default" });
    const configured = { ...env, [`${prefix}_TIMEOUT_MS`]: "9000", [`${prefix}_MAX_OUTPUT_TOKENS`]: "1500",
      [`${prefix}_MODEL`]: "deepseek-v4-pro", [`${prefix}_REASONING_EFFORT`]: "none" };
    expect(resolveWorkWeeklyProviderProfile(role, configured)).toMatchObject({ timeoutMs: 9_000, maxOutputTokens: 1_500,
      provider: "openai_compatible", model: "deepseek-v4-pro", reasoningEffort: "none" });
    expect(resolveWorkWeeklyProviderProfile(role, { ...env, [`${prefix}_TIMEOUT_MS`]: "120000", [`${prefix}_MAX_OUTPUT_TOKENS`]: "32000" }))
      .toMatchObject({ timeoutMs: 120_000, maxOutputTokens: 32_000 });
    expect(() => resolveWorkWeeklyProviderProfile(role, { ...env, [`${prefix}_TIMEOUT_MS`]: "120001" })).toThrow("work_weekly_provider_config_invalid");
    expect(() => resolveWorkWeeklyProviderProfile(role, { ...env, [`${prefix}_MAX_OUTPUT_TOKENS`]: "32001" })).toThrow("work_weekly_provider_config_invalid");
  });

  it("resolves four independent profiles without hard-coding a model in the domain", () => {
    const env = {
      NODE_ENV: "test",
      OPENAI_QA_MODEL: "gpt-configured-by-env",
      WORK_REVIEW_WEEKLY_SYNTHESIZER_MODEL: "weekly-model",
      WORK_REVIEW_WEEKLY_SYNTHESIZER_REASONING_EFFORT: "high",
      WORK_REVIEW_WEEKLY_SYNTHESIZER_TIMEOUT_MS: "12000",
      WORK_REVIEW_WEEKLY_SYNTHESIZER_MAX_OUTPUT_TOKENS: "3000"
    };
    const synthesizer = resolveWorkWeeklyProviderProfile("synthesizer", env);
    const verifier = resolveWorkWeeklyProviderProfile("verifier", env);
    const answerer = resolveWorkWeeklyProviderProfile("qa_answerer", env);
    expect(synthesizer).toMatchObject({
      id: "work_weekly_synthesizer_v1",
      model: "weekly-model",
      reasoningEffort: "high",
      timeoutMs: 12_000,
      maxOutputTokens: 3_000
    });
    expect(verifier.id).toBe("work_weekly_verifier_v1");
    expect(answerer.id).toBe("work_weekly_qa_answerer_v1");
    expect(verifier.model).toBe("gpt-configured-by-env");
    expect(() => resolveWorkWeeklyProviderProfile("verifier", {
      NODE_ENV: "production",
      OPENAI_QA_MODEL: "configured",
      WORK_REVIEW_WEEKLY_VERIFIER_PROVIDER: "fixture",
      WORK_REVIEW_ALLOW_FIXTURE_PROVIDER: "true"
    })).toThrowError(WorkWeeklyProviderError);
  });

  it("sends only the bounded snapshot pack and rejects a fabricated sourceRef", async () => {
    const snapshot = workWeeklyTestSnapshot();
    let captured = "";
    const request = vi.fn(async (input: Parameters<WorkWeeklyStructuredJsonRequest>[0]) => {
      captured = JSON.stringify(input.requestInput);
      return {
        items: [{
          id: "item_1",
          section: "decisions",
          text: "模型自由文本不会直接发布",
          itemType: "evidence_backed_fact",
          claims: [{
            id: "claim_1",
            text: "选择了方案 B",
            claimType: "decision",
            sourceRefs: ["work:finding:outside_scope"]
          }]
        }]
      };
    });
    const synthesizer = createStructuredWorkWeeklySynthesizer({
      profile: workWeeklyProfile("synthesizer"),
      requestStructuredJson: request
    });
    await expect(synthesizer.synthesize({ accountId: "account_a", snapshot }))
      .rejects.toThrow("work_weekly_source_not_allowlisted");
    expect(request).toHaveBeenCalledTimes(1);
    const instruction = request.mock.calls[0][0].jsonInstruction;
    for (const value of [...WorkWeeklySectionKindSchema.options, ...WorkWeeklyClaimTypeSchema.options,
      "evidence_backed_fact", "interpretation", "suggestion"]) {
      expect(instruction).toContain(JSON.stringify(value));
    }
    expect(captured).toContain(snapshot.inputPackDigest);
    expect(captured).toContain(WORK_WEEKLY_TEST_REFS.decision);
    expect(captured).not.toContain("Daily Reflection");
    expect(captured).not.toContain("Memory summary");
    expect(captured).toContain("不要求每个open_question再写一条关注");
    expect(captured).toContain("无真实缺口时可空，不固定建议条数");
    expect(captured).toContain("认领/拟安排不等于已开始/已推进");
    expect(captured).toContain("不能概括为取消需求");
    expect(captured).toContain("proposal即使包含认领、计划日期或行动措辞，也不能直接标为decision/commitment");
  });

  it("gives the verifier only each claim's cited sources and rejects source expansion", async () => {
    const snapshot = workWeeklyTestSnapshot();
    let payload = "";
    const request = vi.fn(async (input: Parameters<WorkWeeklyStructuredJsonRequest>[0]) => {
      payload = JSON.stringify(input.requestInput);
      return {
        items: [{
          claimId: "claim_decision",
          verdict: "entailed",
          issueCodes: [],
          supportedSourceRefs: [WORK_WEEKLY_TEST_REFS.proposal]
        }]
      };
    });
    const verifier = createStructuredWorkWeeklyClaimVerifier({
      profile: workWeeklyProfile("verifier"),
      requestStructuredJson: request
    });
    await expect(verifier.verify({
      accountId: "account_a",
      snapshot,
      claims: [{
        id: "claim_decision",
        text: "最终采用方案 B",
        claimType: "decision",
        sourceRefs: [WORK_WEEKLY_TEST_REFS.decision]
      }]
    })).rejects.toThrow("work_weekly_verifier_source_not_allowed");
    expect(payload).toContain(WORK_WEEKLY_TEST_REFS.decision);
    expect(payload).not.toContain(WORK_WEEKLY_TEST_REFS.proposal);
    const instruction = request.mock.calls[0][0].jsonInstruction;
    for (const verdict of WorkWeeklyClaimVerdictSchema.options) {
      expect(instruction).toContain(JSON.stringify(verdict));
    }
  });

  it("requires exactly one verifier verdict per claim", () => {
    expect(() => validateWorkWeeklyVerifierOutput({
      response: { items: [] },
      claims: [{
        id: "claim_1",
        text: "一个事实",
        claimType: "fact",
        sourceRefs: [WORK_WEEKLY_TEST_REFS.decision]
      }]
    })).toThrow("work_weekly_verifier_output_invalid");
  });

  it("audits full-source coverage in the same request while claim evidence remains local", async () => {
    const snapshot = workWeeklyTestSnapshot();
    const claim = { id: "claim_date", text: "文档出现9月5日", claimType: "fact" as const, sourceRefs: [WORK_WEEKLY_TEST_REFS.dated] };
    const coverage: WorkWeeklyCoverageAssessment[] = workWeeklyCoverageSourceRefs(snapshot).map((sourceRef) => ({
      sourceRef, status: sourceRef === WORK_WEEKLY_TEST_REFS.dated ? "covered" : "omitted",
      reasonCode: sourceRef === WORK_WEEKLY_TEST_REFS.dated ? "covered" : "missing_key_content",
      claimIds: sourceRef === WORK_WEEKLY_TEST_REFS.dated ? [claim.id] : []
    }));
    const request = vi.fn(async (_call: Parameters<WorkWeeklyStructuredJsonRequest>[0]) => ({
      items: [{ claimId: claim.id, verdict: "entailed", issueCodes: [], supportedSourceRefs: claim.sourceRefs }],
      coverage
    }));
    const onCoverage = vi.fn();
    const provider = createStructuredWorkWeeklyClaimVerifier({ profile: workWeeklyProfile("verifier"), requestStructuredJson: request });
    const result = await provider.verify({ accountId: snapshot.accountId, snapshot, claims: [claim], onCoverage });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0].schema).toBe(WorkWeeklyGenerationVerifierResponseSchema);
    const messages = request.mock.calls[0]![0].requestInput as Array<{ role: string; content: string }>;
    const payload = JSON.parse(messages.find((entry) => entry.role === "user")!.content);
    expect(payload.items[0].sources.map((source: { sourceRef: string }) => source.sourceRef)).toEqual(claim.sourceRefs);
    expect(payload.coverageSources.map((entry: { source: { sourceRef: string } }) => entry.source.sourceRef).sort())
      .toEqual(workWeeklyCoverageSourceRefs(snapshot));
    expect(payload.coverageSources.find((entry: { source: { sourceRef: string } }) => entry.source.sourceRef === WORK_WEEKLY_TEST_REFS.dated).candidateClaims)
      .toEqual([{ claim: { id: claim.id, text: claim.text, sourceRefs: claim.sourceRefs }, relationship: "direct_record" }]);
    expect(payload.coverageSources.find((entry: { source: { sourceRef: string } }) => entry.source.sourceRef === WORK_WEEKLY_TEST_REFS.proposal).candidateClaims)
      .toEqual([]);
    expect(payload.verificationContract).toEqual({
      expectedVerdictCount: 1, expectedClaimIds: [claim.id],
      expectedCoverageCount: workWeeklyCoverageSourceRefs(snapshot).length,
      expectedCoverageSourceRefs: workWeeklyCoverageSourceRefs(snapshot)
    });
    expect(onCoverage).toHaveBeenCalledWith(coverage);
    expect(result).toHaveLength(1);
  });

  it("rejects incomplete coverage shape without retrying the verifier", async () => {
    const snapshot = workWeeklyTestSnapshot();
    const request = vi.fn(async () => ({ items: [], coverage: [] }));
    const provider = createStructuredWorkWeeklyClaimVerifier({ profile: workWeeklyProfile("verifier"), requestStructuredJson: request });
    await expect(provider.verify({ accountId: snapshot.accountId, snapshot, claims: [], onCoverage: vi.fn() }))
      .rejects.toThrow("work_weekly_coverage_output_invalid");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not forward free summary metadata as an attention target to the verifier", async () => {
    const snapshot = workWeeklyTestSnapshot();
    const claim = {
      id: "claim_attention", text: "SSO沙盒尚未开放，登录联调缺可用环境。",
      claimType: "fact" as const, sourceRefs: [WORK_WEEKLY_TEST_REFS.dated]
    };
    const items = [{
      id: "item_attention", section: "next_week" as const, itemType: "suggestion" as const,
      text: "PRIVATE_UNVERIFIED_SUMMARY 李明周五完成SSO", claims: [claim]
    }];
    const request = vi.fn(async (_input: Parameters<WorkWeeklyStructuredJsonRequest>[0]) => ({
      items: [{ claimId: claim.id, verdict: "entailed", issueCodes: [], supportedSourceRefs: claim.sourceRefs }]
    }));
    const verifier = createStructuredWorkWeeklyClaimVerifier({ profile: workWeeklyProfile("verifier"), requestStructuredJson: request });
    await verifier.verify({ accountId: "account_a", snapshot, claims: [claim], items });
    expect(request).toHaveBeenCalledTimes(1);
    const messages = request.mock.calls[0]![0].requestInput as Array<{ role: string; content: string }>;
    const pack = JSON.parse(messages.find((message) => message.role === "user")!.content);
    expect(pack.scope).toEqual(snapshot.scope);
    expect(pack.items[0].publicationContext).toEqual({
      section: "next_week", itemType: "suggestion",
      siblingClaims: [{ id: claim.id, text: claim.text }]
    });
    expect(pack.items[0].sources.map((source: { sourceRef: string }) => source.sourceRef)).toEqual(claim.sourceRefs);
    expect(JSON.stringify(pack)).not.toContain(WORK_WEEKLY_TEST_REFS.proposal);
    expect(JSON.stringify(pack)).not.toContain("PRIVATE_UNVERIFIED_SUMMARY");
    expect(JSON.stringify(pack)).not.toContain("attentionTarget");
    const system = messages.find((message) => message.role === "system")!.content;
    expect(system).toContain("不是 Evidence");
    expect(system).toContain("claim_type_mismatch");
    expect(system).toContain("invalid_attention_target");
    expect(system).toContain("mixed_topics");
    expect(system).toContain("section_mismatch");
    expect(system).toContain("decision_finality_conflict");
    expect(system).toContain("不因没有另写关注而降低coverage");
    expect(system).toContain("partial/missing_key_content");
    expect(system).toContain("next_week是精选关注而非逐源必填栏目");
    expect(system).toContain("固定AI建议关注前缀不属于用户承诺");
  });
});

describe("Weekly verifier contract failure diagnostics", () => {
  beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });
  function claims(count = 2): WorkWeeklyGeneratedClaim[] {
    return Array.from({ length: count }, (_, index) => ({ id: `claim_${index}`, text: "PRIVATE_BODY_MARKER",
      claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated] }));
  }
  const verdicts = (input: WorkWeeklyGeneratedClaim[]): WorkWeeklyVerifierItem[] => input.map((claim) => ({
    claimId: claim.id, verdict: "entailed", issueCodes: [], supportedSourceRefs: claim.sourceRefs
  }));
  const lastDiagnostic = () => JSON.parse(vi.mocked(console.error).mock.calls.at(-1)![0] as string);

  it("distinguishes missing verdict count for 57 input claims without accepting a partial response", () => {
    const input = claims(57);
    expect(validateWorkWeeklyVerifierOutput({ claims: input, response: { items: verdicts(input) } })).toHaveLength(57);
    expect(() => validateWorkWeeklyVerifierOutput({ claims: input, response: { items: verdicts(input).slice(1) } }))
      .toThrow("work_weekly_verifier_output_invalid");
    expect(lastDiagnostic()).toMatchObject({ reason: "verdict_count", expectedCount: 57, actualCount: 56,
      missingCount: 1, duplicateCount: 0, unknownCount: 0 });
  });

  it("distinguishes duplicate output IDs even when output count is correct", () => {
    const input = claims(); const output = verdicts(input); output[1]!.claimId = input[0]!.id;
    expect(() => validateWorkWeeklyVerifierOutput({ claims: input, response: { items: output } })).toThrow("work_weekly_verifier_output_invalid");
    expect(lastDiagnostic()).toMatchObject({ reason: "verdict_claim_ids", expectedCount: 2, actualCount: 2,
      missingCount: 1, duplicateCount: 1, unknownCount: 0 });
  });

  it("counts unknown IDs without logging their contents or repairing item IDs into claim IDs", () => {
    const input = claims(); const output = verdicts(input); output[1]!.claimId = "item_PRIVATE_IDENTIFIER";
    expect(() => validateWorkWeeklyVerifierOutput({ claims: input, response: { items: output } })).toThrow("work_weekly_verifier_output_invalid");
    expect(lastDiagnostic()).toMatchObject({ reason: "verdict_claim_ids", missingCount: 1, unknownCount: 1 });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/PRIVATE|work:finding|work:evidence/u);
  });

  it.each(["entailed", "partially_entailed"] as const)("identifies empty support for %s without filling citations", (verdict) => {
    const input = claims(); const output = verdicts(input); output[0] = { ...output[0]!, verdict, supportedSourceRefs: [] };
    expect(() => validateWorkWeeklyVerifierOutput({ claims: input, response: { items: output } })).toThrow("work_weekly_verifier_output_invalid");
    expect(lastDiagnostic()).toMatchObject({ reason: "supported_verdict_without_sources", emptySupportedCount: 1 });
  });

  it("counts duplicate input IDs separately", () => {
    const input = claims(); input[1]!.id = input[0]!.id;
    expect(() => validateWorkWeeklyVerifierOutput({ claims: input, response: { items: verdicts(input) } })).toThrow("work_weekly_verifier_output_invalid");
    expect(lastDiagnostic()).toMatchObject({ reason: "input_claim_ids", inputDuplicateCount: 1 });
  });

  it("counts foreign citations without logging them", () => {
    const input = claims(); const output = verdicts(input); output[0]!.supportedSourceRefs = ["work:evidence:PRIVATE_CITATION"];
    expect(() => validateWorkWeeklyVerifierOutput({ claims: input, response: { items: output } })).toThrow("work_weekly_verifier_source_not_allowed");
    expect(lastDiagnostic()).toMatchObject({ reason: "verdict_source_subset", unsupportedRefCount: 1 });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("PRIVATE");
  });

  it("logs only Zod code counts, never unknown keys or invalid enum values", () => {
    const input = claims(); const output = { ...verdicts(input)[0]!, verdict: "PRIVATE_ENUM", PRIVATE_KEY: "PRIVATE_VALUE" };
    expect(() => validateWorkWeeklyVerifierOutput({ claims: input, response: { items: [output] } })).toThrow("work_weekly_verifier_output_invalid");
    expect(lastDiagnostic()).toMatchObject({ reason: "verdict_schema", schemaIssueCounts: { invalid_enum_value: 1, unrecognized_keys: 1 } });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("PRIVATE");
  });

  it("diagnoses missing and duplicate coverage identities without loosening source completeness", () => {
    const snapshot = workWeeklyTestSnapshot();
    const coverage = workWeeklyCoverageSourceRefs(snapshot).map((sourceRef): WorkWeeklyCoverageAssessment => ({
      sourceRef, status: "omitted", claimIds: [], reasonCode: "missing_key_content"
    }));
    coverage[1]!.sourceRef = coverage[0]!.sourceRef;
    expect(() => validateWorkWeeklyCoverage({ snapshot, claims: [], coverage })).toThrow("work_weekly_coverage_output_invalid");
    expect(lastDiagnostic()).toMatchObject({ reason: "coverage_source_set", missingCount: 1, duplicateCount: 1 });
  });

  it("distinguishes invalid coverage claim IDs and source relation", () => {
    const snapshot = workWeeklyTestSnapshot(); const input = claims(1);
    const coverage = workWeeklyCoverageSourceRefs(snapshot).map((sourceRef): WorkWeeklyCoverageAssessment => ({
      sourceRef, status: "omitted", claimIds: [], reasonCode: "missing_key_content"
    }));
    coverage[0] = { ...coverage[0]!, status: "covered", reasonCode: "covered", claimIds: ["PRIVATE_UNKNOWN"] };
    expect(() => validateWorkWeeklyCoverage({ snapshot, claims: input, coverage })).toThrow("work_weekly_coverage_output_invalid");
    expect(lastDiagnostic()).toMatchObject({ reason: "coverage_claim_ids", unknownClaimIdCount: 1 });
    coverage[0]!.claimIds = [input[0]!.id];
    expect(() => validateWorkWeeklyCoverage({ snapshot, claims: input, coverage })).toThrow("work_weekly_coverage_source_unrelated");
    expect(lastDiagnostic()).toMatchObject({ reason: "coverage_source_relation", unrelatedClaimCount: 1 });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("PRIVATE");
  });
});

describe("Weekly generation-only self-contained topic contract", () => {
  const topic = {
    id: "topic", section: "decisions", itemType: "evidence_backed_fact", text: "一个主题",
    claims: [{ id: "claim_topic", text: "暂定试点不提供功能甲（最终性未确认）；之后重新评估，并非取消需求。",
      claimType: "decision", sourceRefs: [WORK_WEEKLY_TEST_REFS.decision] }]
  };

  it("accepts one self-contained topic and rejects detached qualification fragments without changing the shared QA shape", () => {
    const schema = buildWorkWeeklySynthesisResponseSchema(workWeeklyTestSnapshot());
    expect(schema.safeParse({ items: [topic] }).success).toBe(true);
    const split = { ...topic, claims: [
      { ...topic.claims[0]!, text: "本轮不提供功能甲" },
      { ...topic.claims[0]!, id: "qualifier", text: "该安排最终性未确认" }
    ] };
    expect(schema.safeParse({ items: [split] }).success).toBe(false);
    expect(WorkWeeklySynthesizerResponseSchema.safeParse({ items: [split] }).success).toBe(true);
  });

  it("does not call the verifier after a fragmented generation contract failure", async () => {
    const response = { items: [{ ...topic, claims: [...topic.claims, { ...topic.claims[0]!, id: "detached" }] }] };
    const request = vi.fn(async () => response); const verify = vi.fn();
    await expect(runWorkWeeklyGenerationPipeline({ accountId: "account_a", snapshot: workWeeklyTestSnapshot(),
      synthesizer: createStructuredWorkWeeklySynthesizer({ profile: workWeeklyProfile("synthesizer"), requestStructuredJson: request }),
      verifier: { profile: workWeeklyProfile("verifier"), verify }
    })).rejects.toThrow("work_weekly_synthesizer_output_invalid");
    expect(request).toHaveBeenCalledTimes(1); expect(verify).not.toHaveBeenCalled();
  });

  it("excludes completed from the generation contract with zero current-week events", () => {
    const snapshot = workWeeklyTestSnapshot(); snapshot.todoEvents = [];
    snapshot.identities = snapshot.identities.filter((source) => source.sourceRef !== WORK_WEEKLY_TEST_REFS.todoCompleted);
    snapshot.allowlistedSourceRefs = snapshot.allowlistedSourceRefs.filter((ref) => ref !== WORK_WEEKLY_TEST_REFS.todoCompleted);
    const pack = buildWorkWeeklySynthesisPack({ accountId: "account_a", snapshot });
    expect(pack.generationContract.allowedSections).not.toContain("completed");
    expect(pack.generationContract.currentWeekCompletionSourceRefs).toEqual([]);
    expect(buildWorkWeeklySynthesisResponseSchema(snapshot).safeParse({ items: [{ ...topic, section: "completed" }] }).success).toBe(false);
  });

  it("rejects meeting review as completed even when another Todo completion event exists", () => {
    const response = { items: [{ ...topic, section: "completed", claims: [{ ...topic.claims[0]!, text: "会议复核已完成", claimType: "fact" }] }] };
    expect(buildWorkWeeklySynthesisResponseSchema(workWeeklyTestSnapshot()).safeParse(response).success).toBe(false);
  });

  it("does not require literal synchronization with a second attention title", () => {
    const suggestion = { ...topic, section: "next_week", itemType: "suggestion", text: "测试环境可用性",
      claims: [{ ...topic.claims[0]!, claimType: "fact", text: "测试环境尚未开放，联调仍等待账号。" }] };
    const schema = buildWorkWeeklySynthesisResponseSchema(workWeeklyTestSnapshot());
    expect(schema.safeParse({ items: [suggestion] }).success).toBe(true);
    expect(schema.safeParse({ items: [{ ...suggestion, text: "测试环境" }] }).success).toBe(true);
  });
});

describe("Weekly explicit semantic coverage and usable quality", () => {
  function boundedSnapshot(includeSummary = false) {
    const snapshot = workWeeklyTestSnapshot();
    const refs = new Set<string>([WORK_WEEKLY_TEST_REFS.meeting, WORK_WEEKLY_TEST_REFS.dated, WORK_WEEKLY_TEST_REFS.evidenceDated,
      ...(includeSummary ? [WORK_WEEKLY_TEST_REFS.decision, WORK_WEEKLY_TEST_REFS.evidenceDecision] : [])]);
    snapshot.findings = snapshot.findings.filter((source) => refs.has(source.sourceRef));
    snapshot.evidence = snapshot.evidence.filter((source) => refs.has(source.sourceRef));
    snapshot.todos = []; snapshot.todoEvents = [];
    snapshot.identities = snapshot.identities.filter((source) => refs.has(source.sourceRef));
    snapshot.allowlistedSourceRefs = [...refs];
    snapshot.findings.find((source) => source.sourceRef === WORK_WEEKLY_TEST_REFS.dated)!.body = "两批样本已联调，第三批排查超时。";
    if (includeSummary) snapshot.findings.find((source) => source.sourceRef === WORK_WEEKLY_TEST_REFS.decision)!.body = "联调已走过前两批，正在排查第三批超时。";
    for (const finding of snapshot.findings) {
      finding.title = finding.body;
      snapshot.evidence.find((source) => finding.evidenceRefs.includes(source.sourceRef))!.text = finding.body;
    }
    return snapshot;
  }

  async function generate(options: { summary?: "duplicate" | "partial"; redundant?: boolean; rejectedOnly?: boolean } = {}) {
    const snapshot = boundedSnapshot(Boolean(options.summary));
    if (options.summary === "partial") {
      snapshot.findings.find((source) => source.sourceRef === WORK_WEEKLY_TEST_REFS.decision)!.body += "第三批若涉及敏感数据必须先隔离。";
      snapshot.evidence.find((source) => source.sourceRef === WORK_WEEKLY_TEST_REFS.evidenceDecision)!.text += "第三批若涉及敏感数据必须先隔离。";
    }
    const texts = options.rejectedOnly ? ["全部联调完成。"] : ["两批样本已联调，第三批仍在排查超时。",
      ...(options.redundant ? ["全部联调完成。"] : [])];
    const synthesis = vi.fn(async () => ({ items: texts.map((text, i) => ({
      id: `i${i}`, section: "in_progress", itemType: "evidence_backed_fact", text,
      claims: [{ id: `c${i}`, text, claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated] }]
    })) }));
    const verify = vi.fn(async (input: Parameters<WorkWeeklyStructuredJsonRequest>[0]) => {
      const messages = input.requestInput as Array<{ role: string; content: string }>;
      const payload = JSON.parse(messages.find((message) => message.role === "user")!.content);
      return {
        items: payload.items.map(({ claim }: { claim: WorkWeeklyGeneratedClaim }) => ({ claimId: claim.id,
          verdict: claim.text === "全部联调完成。" ? "contradicted" : "entailed", issueCodes: [], supportedSourceRefs: claim.sourceRefs })),
        coverage: workWeeklyCoverageSourceRefs(snapshot).map((sourceRef) => sourceRef === WORK_WEEKLY_TEST_REFS.dated
          ? { sourceRef, status: "covered", reasonCode: "covered", claimIds: [payload.items[0].claim.id] }
          : options.summary === "duplicate" ? { sourceRef, status: "not_applicable", reasonCode: "duplicate", claimIds: [payload.items[0].claim.id] }
            : { sourceRef, status: "partial", reasonCode: "missing_qualification", claimIds: [] })
      };
    });
    const traces: unknown[] = [];
    const result = await runWorkWeeklyGenerationPipeline({ accountId: snapshot.accountId, snapshot,
      synthesizer: createStructuredWorkWeeklySynthesizer({ profile: workWeeklyProfile("synthesizer"), requestStructuredJson: synthesis }),
      verifier: createStructuredWorkWeeklyClaimVerifier({ profile: workWeeklyProfile("verifier"), requestStructuredJson: verify }),
      onTrace: (trace) => { traces.push(trace); }
    });
    expect(synthesis).toHaveBeenCalledTimes(1); expect(verify).toHaveBeenCalledTimes(1);
    return { result, traces, verify };
  }

  it("publishes complete safe content despite an extra rejected candidate on the same source", async () => {
    const { result } = await generate({ redundant: true });
    expect(result.status).toBe("verified");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ text: "两批样本已联调，第三批仍在排查超时。", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated] });
    expect(result.quality_assessment).toMatchObject({ status: "passed", coveredSourceCount: 1 });
  });

  it("audits a semantically duplicate summary without sharing Evidence or adding its citation", async () => {
    const { result, verify } = await generate({ summary: "duplicate", redundant: true });
    expect(result.status).toBe("verified");
    expect(result.quality_assessment).toMatchObject({ coveredSourceCount: 1, notApplicableSourceCount: 1 });
    expect(result.items[0]!.sourceRefs).toEqual([WORK_WEEKLY_TEST_REFS.dated]);
    const messages = verify.mock.calls[0]![0].requestInput as Array<{ role: string; content: string }>;
    const payload = JSON.parse(messages.find((message) => message.role === "user")!.content);
    expect(payload.coverageSources.find((entry: { source: { sourceRef: string } }) => entry.source.sourceRef === WORK_WEEKLY_TEST_REFS.decision).candidateClaims).toEqual([]);
  });

  it("retains a semantic qualification gap instead of treating a related overview as full coverage", async () => {
    const { result } = await generate({ summary: "partial" });
    expect(result.status).toBe("needs_review");
    expect(result.items).toHaveLength(1);
    expect(result.quality_assessment.reasonCodes).toContain("missing_qualification");
  });

  it("turns claimed coverage with no safe content into an explicit gap, not fabricated support", async () => {
    const { result, traces } = await generate({ rejectedOnly: true });
    expect(result.items).toEqual([]);
    expect(result.quality_assessment).toMatchObject({ status: "insufficient", partialSourceCount: 1 });
    expect(traces).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "verified",
      coverage: [{ sourceRef: WORK_WEEKLY_TEST_REFS.dated, status: "covered", reasonCode: "covered", claimIds: [expect.any(String)] }] })]));
  });

  it("projects a consistent canonical confirmation view without mutating the snapshot", () => {
    const snapshot = workWeeklyTestSnapshot();
    snapshot.findings[0]!.body = "目前倾向方案 B；决定是否最终待确认；发言归属待确认。";
    const before = JSON.stringify(snapshot);
    const pack = buildWorkWeeklySynthesisPack({ accountId: snapshot.accountId, snapshot });
    expect(pack.sources.find((source) => source.sourceRef === WORK_WEEKLY_TEST_REFS.decision)).toMatchObject({
      value: { body: snapshot.findings[0]!.body, structuredData: { decisionFinality: "unclear" } },
      generationGuidance: { mode: "decision", effectiveFinality: "unclear", finalityBasis: "canonical_confirmation_note", qualificationBasis: "body" }
    });
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(pack.sources.find((source) => source.sourceRef === WORK_WEEKLY_TEST_REFS.proposal)).toMatchObject({ generationGuidance: { mode: "proposal", suggestedClaimType: "fact" } });
    expect(pack.sources.find((source) => source.sourceRef === WORK_WEEKLY_TEST_REFS.assignment)).toMatchObject({ generationGuidance: { mode: "assignment", suggestedClaimType: "fact", progressBasis: "actual_activity_required" } });
  });

  it.each([true, false])("does not replace a selected rejected topic with a safe shared-Evidence topic (selected=%s)", async (selected) => {
    const snapshot = boundedSnapshot(true);
    const first = snapshot.findings.find((source) => source.sourceRef === WORK_WEEKLY_TEST_REFS.dated)!;
    const other = snapshot.findings.find((source) => source.sourceRef === WORK_WEEKLY_TEST_REFS.decision)!;
    first.body = "移动端布局仍待测试。"; other.body = "事件计数方案仍是提议，敏感正文不得收集。";
    other.kind = "proposal"; other.evidenceRefs = [...first.evidenceRefs];
    const safe = { id: "layout", text: first.body, claimType: "fact" as const, sourceRefs: [first.sourceRef] };
    const rejected = { id: "events", text: "事件计数已获批准并开始收集正文。", claimType: "fact" as const, sourceRefs: [other.sourceRef] };
    const generated = [safe, rejected].map((claim) => ({ id: claim.id, text: claim.text, section: "open_questions" as const,
      itemType: "evidence_backed_fact" as const, claims: [claim] }));
    const request = vi.fn(async () => ({ items: [
      { claimId: safe.id, verdict: "entailed", issueCodes: [], supportedSourceRefs: safe.sourceRefs },
      { claimId: rejected.id, verdict: "contradicted", issueCodes: ["proposal_not_decision"], supportedSourceRefs: rejected.sourceRefs }
    ], coverage: [
      { sourceRef: first.sourceRef, status: "covered", reasonCode: "covered", claimIds: [safe.id] },
      { sourceRef: other.sourceRef, status: selected ? "covered" : "omitted", reasonCode: selected ? "covered" : "missing_key_content",
        claimIds: selected ? [rejected.id] : [] }
    ] }));
    const traces: unknown[] = [];
    const result = await runWorkWeeklyGenerationPipeline({ accountId: snapshot.accountId, snapshot,
      synthesizer: { profile: workWeeklyProfile("synthesizer"), synthesize: async () => generated },
      verifier: createStructuredWorkWeeklyClaimVerifier({ profile: workWeeklyProfile("verifier"), requestStructuredJson: request }),
      onTrace: (trace) => { traces.push(trace); } });
    expect(result.status).toBe("needs_review"); expect(result.items.map((item) => item.text)).toEqual([safe.text]);
    expect(result.quality_assessment).toMatchObject({ coveredSourceCount: 1, reviewIssues: [{ sourceRef: other.sourceRef,
      reasonCode: selected ? "coverage_claim_filtered" : "missing_key_content" }] });
    expect(traces).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "verified", coverage: expect.arrayContaining([
      expect.objectContaining({ sourceRef: other.sourceRef, claimIds: selected ? [rejected.id] : [] })
    ]) })]));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("localizes known unrelated mappings and ignores imprecise diagnostic excerpts without altering verdicts", async () => {
    const snapshot = boundedSnapshot(true);
    const claim: WorkWeeklyGeneratedClaim = { id: "safe", text: "两批样本已联调，第三批仍在排查超时。", claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated] };
    const onCoverage = vi.fn(); const onAuditDetails = vi.fn();
    const request = vi.fn(async () => ({ items: [{ claimId: claim.id, verdict: "entailed", issueCodes: [], supportedSourceRefs: claim.sourceRefs }],
      disputes: [{ claimId: claim.id, issueCode: "typo", claimExcerpt: "非原文", explanation: "辅助诊断" }],
      coverage: workWeeklyCoverageSourceRefs(snapshot).map((sourceRef) => ({ sourceRef, status: "covered", reasonCode: "covered",
        claimIds: [claim.id], matches: [{ claimId: claim.id, sourceExcerpt: "非原文", claimExcerpt: "第三批仍在排查超时" }] })) }));
    const verdicts = await createStructuredWorkWeeklyClaimVerifier({ profile: workWeeklyProfile("verifier"), requestStructuredJson: request })
      .verify({ accountId: snapshot.accountId, snapshot, claims: [claim], onCoverage, onAuditDetails });
    expect(verdicts).toEqual([{ claimId: claim.id, verdict: "entailed", issueCodes: [], supportedSourceRefs: claim.sourceRefs }]);
    expect(onCoverage).toHaveBeenCalledWith(expect.arrayContaining([
      { sourceRef: WORK_WEEKLY_TEST_REFS.decision, status: "partial", reasonCode: "missing_key_content", claimIds: [] }
    ]));
    expect(onAuditDetails).toHaveBeenCalledWith(expect.objectContaining({ disputes: [], discardedDiagnosticCount: 3 }));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps accepted work and pending deadline as separate canonical guidance without changing sources", () => {
    const snapshot = workWeeklyTestSnapshot();
    const source = snapshot.findings.find((finding) => finding.sourceRef === WORK_WEEKLY_TEST_REFS.commitment)!;
    source.body = "Sam 已接受核对名单，原提到周五；截止时间待确认。";
    source.structuredData = { actionBasis: "explicit_commitment", originalDueExpression: "周五", dueAt: null };
    const original = JSON.stringify(snapshot);
    const pack = buildWorkWeeklySynthesisPack({ accountId: snapshot.accountId, snapshot });
    expect(pack.sources.find((entry) => entry.sourceRef === source.sourceRef)).toMatchObject({
      value: source, generationGuidance: { mode: "commitment", deadlineStatus: "pending_confirmation", suggestedClaimType: "commitment" }
    });
    expect(JSON.stringify(snapshot)).toBe(original);
  });

  it("delivers authoritative safe output even when auxiliary diagnostic shapes are invalid", async () => {
    const snapshot = boundedSnapshot();
    const claim: WorkWeeklyGeneratedClaim = { id: "valid", text: "两批样本已联调，第三批仍在排查超时。", claimType: "fact", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated] };
    const request = vi.fn(async () => ({ items: [{ claimId: claim.id, verdict: "entailed", issueCodes: [], supportedSourceRefs: claim.sourceRefs }],
      disputes: [{ claimId: claim.id, explanation: "x".repeat(1000), claimExcerpt: null, extra: true }],
      coverage: [{ sourceRef: WORK_WEEKLY_TEST_REFS.dated, status: "covered", reasonCode: "covered", claimIds: [claim.id],
        matches: [{ claimId: claim.id, claimExcerpt: null, extra: true }] }] }));
    const generated = [{ id: "topic", text: claim.text, section: "in_progress" as const, itemType: "evidence_backed_fact" as const, claims: [claim] }];
    const result = await runWorkWeeklyGenerationPipeline({ accountId: snapshot.accountId, snapshot,
      synthesizer: { profile: workWeeklyProfile("synthesizer"), synthesize: async () => generated },
      verifier: createStructuredWorkWeeklyClaimVerifier({ profile: workWeeklyProfile("verifier"), requestStructuredJson: request }) });
    expect(result.status).toBe("verified"); expect(result.items.map((item) => item.text)).toEqual([claim.text]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("provides canonical qualifications for Evidence-only claims without expanding their support", async () => {
    const snapshot = workWeeklyTestSnapshot();
    snapshot.findings[0]!.body = "方案 B 仍待拍板。";
    const claim: WorkWeeklyGeneratedClaim = { id: "c", text: "方案 B 已经最终决定。", claimType: "decision", sourceRefs: [WORK_WEEKLY_TEST_REFS.evidenceDecision] };
    const request = vi.fn(async (_input: Parameters<WorkWeeklyStructuredJsonRequest>[0]) => ({ items: [{ claimId: "c", verdict: "partially_entailed", issueCodes: ["decision_finality_conflict"], supportedSourceRefs: claim.sourceRefs }] }));
    await createStructuredWorkWeeklyClaimVerifier({ profile: workWeeklyProfile("verifier"), requestStructuredJson: request })
      .verify({ accountId: snapshot.accountId, snapshot, claims: [claim] });
    const messages = request.mock.calls[0]![0].requestInput as Array<{ role: string; content: string }>;
    const payload = JSON.parse(messages.find((message) => message.role === "user")!.content);
    expect(payload.items[0].sourceQualifications).toEqual([expect.objectContaining({ sourceRef: WORK_WEEKLY_TEST_REFS.decision, body: "方案 B 仍待拍板。" })]);
    expect(payload.items[0].sources.map((source: { sourceRef: string }) => source.sourceRef)).toEqual(claim.sourceRefs);
  });
});

describe("Weekly canonical confirmation Provider view", () => {
  it.each([
    { finality: "final", body: "最终采用方案 B。", expected: "final", basis: "recorded_value_and_body" },
    { finality: "final", body: "最终采用方案 B；发言归属待确认；截止时间待确认。", expected: "final", basis: "recorded_value_and_body" },
    { finality: "tentative", body: "暂用方案 B；决定是否最终待确认。", expected: "tentative", basis: "canonical_confirmation_note" },
    { finality: null, body: "采用方案 B；决定是否最终待确认。", expected: "unclear", basis: "canonical_confirmation_note" }
  ])("resolves only the known finality note: $finality / $basis", ({ finality, body, expected, basis }) => {
    const snapshot = workWeeklyTestSnapshot();
    snapshot.findings[0]!.body = body;
    snapshot.findings[0]!.structuredData = { decisionFinality: finality };
    const original = JSON.stringify(snapshot);
    const pack = buildWorkWeeklySynthesisPack({ accountId: snapshot.accountId, snapshot });
    expect(pack.sources.find((source) => source.sourceRef === WORK_WEEKLY_TEST_REFS.decision)).toMatchObject({
      value: { body, structuredData: { decisionFinality: expected } },
      generationGuidance: { effectiveFinality: expected, finalityBasis: basis },
      recordContext: { meetingDate: snapshot.meetings[0]!.meetingDate, activityTimeBasis: "source_text" }
    });
    expect(JSON.stringify(snapshot)).toBe(original);
    expect(resolveWorkWeeklySourceRecord(snapshot, WORK_WEEKLY_TEST_REFS.decision)).toMatchObject({
      value: { structuredData: { decisionFinality: finality } }
    });
    expect(pack.snapshotDigest).toBe(snapshot.digest);
    expect(pack.inputPackDigest).toBe(snapshot.inputPackDigest);
  });

  it.each([WORK_WEEKLY_TEST_REFS.decision, WORK_WEEKLY_TEST_REFS.evidenceDecision])("uses the same qualified view for verification and coverage when citing %s", async (sourceRef) => {
    const snapshot = workWeeklyTestSnapshot();
    snapshot.findings[0]!.body = "首轮暂用方案 B；试点后依据反馈重评；决定是否最终待确认。";
    const original = JSON.stringify(snapshot);
    const claim: WorkWeeklyGeneratedClaim = { id: "qualified", claimType: "decision", text: "首轮暂用方案 B，是否定案尚待确认；试点后依据反馈重评。", sourceRefs: [sourceRef] };
    const verdict: WorkWeeklyVerifierItem = { claimId: claim.id, verdict: "entailed", issueCodes: [], supportedSourceRefs: claim.sourceRefs };
    const request = vi.fn(async (_input: Parameters<WorkWeeklyStructuredJsonRequest>[0]) => ({ items: [verdict],
      coverage: workWeeklyCoverageSourceRefs(snapshot).map((ref) => ({ sourceRef: ref,
        status: ref === WORK_WEEKLY_TEST_REFS.decision ? "covered" : "omitted",
        claimIds: ref === WORK_WEEKLY_TEST_REFS.decision ? [claim.id] : [],
        reasonCode: ref === WORK_WEEKLY_TEST_REFS.decision ? "covered" : "missing_key_content" }))
    }));
    const onCoverage = vi.fn();
    const result = await createStructuredWorkWeeklyClaimVerifier({ profile: workWeeklyProfile("verifier"), requestStructuredJson: request })
      .verify({ accountId: snapshot.accountId, snapshot, claims: [claim], onCoverage });
    expect(result).toEqual([verdict]);
    const messages = request.mock.calls[0]![0].requestInput as Array<{ role: string; content: string }>;
    const payload = JSON.parse(messages.find((message) => message.role === "user")!.content);
    const synthesis = buildWorkWeeklySynthesisPack({ accountId: snapshot.accountId, snapshot });
    const { supportingEvidence: _groupEvidence, ...expectedSource } = synthesis.sources.find((source) => source.sourceRef === WORK_WEEKLY_TEST_REFS.decision)!;
    expect(payload.coverageSources.find((entry: { source: { sourceRef: string } }) => entry.source.sourceRef === WORK_WEEKLY_TEST_REFS.decision).source)
      .toEqual(expectedSource);
    if (sourceRef === WORK_WEEKLY_TEST_REFS.decision) expect(payload.items[0].sources[0]).toEqual(expectedSource);
    else expect(payload.items[0].sources[0]).toMatchObject({ sourceRef, recordContext: { meetingDate: snapshot.meetings[0]!.meetingDate, activityTimeBasis: "source_text" } });
    expect(payload.items[0].sourceQualifications).toEqual([{
      sourceRef: WORK_WEEKLY_TEST_REFS.decision, body: snapshot.findings[0]!.body,
      generationGuidance: expect.objectContaining({ effectiveFinality: "unclear", finalityBasis: "canonical_confirmation_note" })
    }]);
    expect(JSON.stringify(payload)).not.toContain("recordedFinality");
    expect(JSON.stringify(snapshot)).toBe(original);
    expect(request).toHaveBeenCalledTimes(1);
    expect(onCoverage.mock.calls[0]![0]).toContainEqual({ sourceRef: WORK_WEEKLY_TEST_REFS.decision, status: "covered", reasonCode: "covered", claimIds: [claim.id] });
  });

  it("does not rewrite a verifier rejection even when the claim expresses pending finality", async () => {
    const snapshot = workWeeklyTestSnapshot();
    snapshot.findings[0]!.body += "；决定是否最终待确认";
    const claim: WorkWeeklyGeneratedClaim = { id: "c", text: "采用方案 B，该决定是否最终尚待确认。", claimType: "decision", sourceRefs: [WORK_WEEKLY_TEST_REFS.decision] };
    const verdict: WorkWeeklyVerifierItem = { claimId: claim.id, verdict: "partially_entailed", issueCodes: ["decision_finality_conflict"], supportedSourceRefs: claim.sourceRefs };
    const request = vi.fn(async () => ({ items: [verdict] }));
    const result = await createStructuredWorkWeeklyClaimVerifier({ profile: workWeeklyProfile("verifier"), requestStructuredJson: request })
      .verify({ accountId: snapshot.accountId, snapshot, claims: [claim] });
    expect(result).toEqual([verdict]);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("Weekly source-centered model inputs", () => {
  it("groups canonical narratives with their Evidence without losing standalone sources or changing their words", () => {
    const snapshot = workWeeklyTestSnapshot();
    snapshot.evidence[1]!.text = "这次决定采用候选方案。";
    const orphan = { ...snapshot.evidence[0]!, sourceRef: "work:evidence:orphan", segmentId: "orphan" };
    snapshot.evidence.push(orphan);
    snapshot.identities.push({ ...snapshot.identities.find((source) => source.sourceRef === WORK_WEEKLY_TEST_REFS.evidenceDecision)!, sourceRef: orphan.sourceRef, sourceId: "orphan" });
    snapshot.allowlistedSourceRefs.push(orphan.sourceRef);
    const before = JSON.stringify(snapshot);
    const pack = buildWorkWeeklySynthesisPack({ accountId: snapshot.accountId, snapshot });
    expect(pack.sources.some((source) => source.sourceRef === WORK_WEEKLY_TEST_REFS.evidenceProposal)).toBe(false);
    expect(pack.sources.find((source) => source.sourceRef === WORK_WEEKLY_TEST_REFS.proposal)).toMatchObject({
      value: { kind: "proposal" }, generationGuidance: { mode: "proposal", suggestedClaimType: "fact" },
      supportingEvidence: [expect.objectContaining({ sourceRef: WORK_WEEKLY_TEST_REFS.evidenceProposal,
        value: { ...snapshot.evidence[1]!, text: "这次决定采用候选方案。" } })]
    });
    const tree = JSON.parse(JSON.stringify(pack.sources)) as Array<{ sourceRef: string; supportingEvidence?: Array<{ sourceRef: string }> }>;
    const reachable = new Set(tree.flatMap((source) => [source.sourceRef, ...(source.supportingEvidence ?? []).map((evidence) => evidence.sourceRef)]));
    expect([...reachable].sort()).toEqual([...snapshot.allowlistedSourceRefs].sort());
    expect(pack.sources.find((source) => source.sourceRef === orphan.sourceRef)).toMatchObject({ value: orphan });
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it("presents each source's candidate meanings and relationship while retaining per-claim citation scope", async () => {
    const snapshot = workWeeklyTestSnapshot();
    snapshot.findings[1]!.evidenceRefs.push(WORK_WEEKLY_TEST_REFS.evidenceDated);
    const definitions = [
      ["current", "本轮拟人工检查两次，结束后重评，不承诺长期承担。", WORK_WEEKLY_TEST_REFS.dated],
      ["history", "此前人工检查过一次。", WORK_WEEKLY_TEST_REFS.evidenceDated],
      ["shared", "讨论过人工检查的方案。", WORK_WEEKLY_TEST_REFS.proposal],
      ["unrelated", "暂用另一个方案。", WORK_WEEKLY_TEST_REFS.decision],
      ["event", "在系统中标记完成。", WORK_WEEKLY_TEST_REFS.todoCompleted]
    ] as const;
    const claims = definitions.map(([id, text, ref]): WorkWeeklyGeneratedClaim => ({ id, text, claimType: "fact", sourceRefs: [ref] }));
    const items = claims.map((claim) => ({ id: claim.id, text: claim.text, section: "open_questions" as const,
      itemType: "evidence_backed_fact" as const, claims: [claim] }));
    const request = vi.fn(async (_input: Parameters<WorkWeeklyStructuredJsonRequest>[0]) => ({
      items: claims.map((claim) => ({ claimId: claim.id, verdict: "entailed", issueCodes: [], supportedSourceRefs: claim.sourceRefs })),
      coverage: workWeeklyCoverageSourceRefs(snapshot).map((sourceRef) => ({ sourceRef, status: "omitted", reasonCode: "missing_key_content", claimIds: [] }))
    }));
    await createStructuredWorkWeeklyClaimVerifier({ profile: workWeeklyProfile("verifier"), requestStructuredJson: request })
      .verify({ accountId: snapshot.accountId, snapshot, claims, items, onCoverage: vi.fn() });
    const messages = request.mock.calls[0]![0].requestInput as Array<{ role: string; content: string }>;
    const packet = JSON.parse(messages.find((message) => message.role === "user")!.content);
    const group = packet.coverageSources.find((source: { source: { sourceRef: string } }) => source.source.sourceRef === WORK_WEEKLY_TEST_REFS.dated);
    expect(group.candidateClaims).toEqual(claims.slice(0, 3).map((claim, i) => ({
      claim: { id: claim.id, text: claim.text, sourceRefs: claim.sourceRefs }, relationship: ["direct_record", "direct_evidence", "shared_evidence"][i], section: "open_questions", itemType: "evidence_backed_fact"
    })));
    expect(packet.coverageSources.find((source: { source: { sourceRef: string } }) => source.source.sourceRef === WORK_WEEKLY_TEST_REFS.todo).candidateClaims)
      .toEqual([{ claim: { id: claims[4]!.id, text: claims[4]!.text, sourceRefs: claims[4]!.sourceRefs }, relationship: "todo_history", section: "open_questions", itemType: "evidence_backed_fact" }]);
    expect(packet.items.map((entry: { sources: Array<{ sourceRef: string }> }) => entry.sources.map((source) => source.sourceRef)))
      .toEqual(claims.map((claim) => claim.sourceRefs));
    expect(JSON.stringify(packet)).not.toContain("candidateClaimIds");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

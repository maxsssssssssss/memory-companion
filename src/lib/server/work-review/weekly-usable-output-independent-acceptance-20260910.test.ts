import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkWeeklySourceSnapshotSchema, type WorkWeeklySourceSnapshot } from "@/lib/domain/work-weekly";
import { createOpenAIClient } from "@/lib/server/openai/client";
import {
  buildWorkWeeklySynthesisPack, createStructuredWorkWeeklyClaimVerifier, createStructuredWorkWeeklySynthesizer,
  resolveWorkWeeklySourceRecord, workWeeklyCoverageClaimIsRelated,
  type WorkWeeklyCoverageAssessment, type WorkWeeklyGeneratedClaim, type WorkWeeklyGeneratedItem,
  type WorkWeeklyStructuredJsonRequest, type WorkWeeklyVerifierItem
} from "./weekly-ai-provider";
import { WORK_WEEKLY_TEST_REFS as refs, workWeeklyProfile, workWeeklyTestSnapshot } from "./weekly-ai-test-fixture";
import { createFixtureWorkWeeklyRunExecutor } from "./weekly-ai-runner";
import { runWorkWeeklyGenerationPipeline, type WorkWeeklyGenerationTrace } from "./weekly-publication-policy";
import { answerWorkWeeklyQuestion, createStructuredWorkWeeklyQaAnswerer, createStructuredWorkWeeklyQaVerifier } from "./weekly-qa-provider";
import { openWorkReviewDatabase } from "./db";
import { WorkWeeklyRepository } from "./weekly-repository";

vi.mock("@/lib/server/openai/client", () => ({ createOpenAIClient: vi.fn(() => {
  throw new Error("Real Provider forbidden in usable-output acceptance");
}) }));

type Snapshot = WorkWeeklySourceSnapshot;
type Item = WorkWeeklyGeneratedItem;
type Claim = WorkWeeklyGeneratedClaim;
type Verdict = WorkWeeklyVerifierItem;
type SourceSpec = {
  key: string; kind: Snapshot["findings"][number]["kind"]; body: string;
  finality?: "final" | "tentative"; section: Item["section"]; text: string;
  claimType?: Claim["claimType"];
};
const findingRef = (key: string) => `work:finding:usable_${key}`;
const evidenceRef = (key: string) => `work:evidence:usable_${key}`;
const databases: Database.Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  expect(createOpenAIClient).not.toHaveBeenCalled();
});

describe("independent canonical finality input view", () => {
  it.each([
    { recorded: "final" as const, note: "决定是否最终待确认", effective: "unclear", basis: "canonical_confirmation_note",
      text: "首轮范围目前按方案乙准备，是否已经定案仍待确认。" },
    { recorded: "tentative" as const, note: "决定是否最终待确认", effective: "tentative", basis: "canonical_confirmation_note",
      text: "首轮范围暂按方案乙准备，尚未成为最终决定。" },
    { recorded: "final" as const, note: "负责人待确认", effective: "final", basis: "recorded_value_and_body",
      text: "首轮范围已确定采用方案乙。" }
  ])("projects $recorded with $note consistently without changing canonical source authority", async ({ recorded, note, effective, basis, text }) => {
    const spec: SourceSpec = { key: "finality", kind: "decision", finality: recorded,
      body: `首轮范围采用方案乙；${note}；发言归属待确认`, text, section: "decisions", claimType: "decision" };
    const snapshot = sourcePack([spec]);
    const canonicalBefore = JSON.stringify(snapshot);
    const providers = fixture(snapshot, usefulDraft([spec]));
    const result = await providers.run();
    expect(result.status).toBe("verified");
    expect(result.items[0]?.text).toBe(text);
    type View = { sourceRef: string; value: unknown; generationGuidance: unknown };
    const synthesis = payload<{ sources: View[] }>(providers.request.mock.calls[0]![0]);
    const verification = payload<{ items: Array<{ sources: View[]; sourceQualifications: unknown[] }>;
      coverageSources: Array<{ source: View }> }>(providers.request.mock.calls[1]![0]);
    const expectedGuidance = { effectiveFinality: effective, finalityBasis: basis };
    const expectedView = { sourceRef: findingRef("finality"), value: {
      body: spec.body, kind: "decision", structuredData: { decisionFinality: effective }
    }, generationGuidance: expectedGuidance };
    expect(synthesis.sources.find((source) => source.sourceRef === findingRef("finality"))).toMatchObject(expectedView);
    expect(verification.items[0]!.sources[0]).toMatchObject(expectedView);
    expect(verification.coverageSources[0]!.source).toMatchObject(expectedView);
    expect(verification.items[0]!.sourceQualifications).toEqual([
      expect.objectContaining({ sourceRef: findingRef("finality"), body: spec.body, generationGuidance: expect.objectContaining(expectedGuidance) })
    ]);
    expect(verification.items[0]!.sources[0]).toMatchObject({ recordContext: {
      meetingDate: "2026-09-09", activityTimeBasis: "source_text"
    } });
    expect(resolveWorkWeeklySourceRecord(snapshot, findingRef("finality"))).toMatchObject({
      value: { body: spec.body, structuredData: { decisionFinality: recorded } }
    });
    expect(JSON.stringify(snapshot)).toBe(canonicalBefore);
    expect(result.items[0]?.sourceRefs).toEqual([findingRef("finality")]);
    expect(providers.request).toHaveBeenCalledTimes(2);
  });

  it("does not turn a real finality upgrade into approval when the input view resolves a pending note", async () => {
    const spec: SourceSpec = { key: "finality", kind: "decision", finality: "final", section: "decisions", claimType: "decision",
      body: "首轮范围采用方案乙；决定是否最终待确认", text: "首轮范围已经最终确定为方案乙，无需再确认。" };
    const providers = fixture(sourcePack([spec]), usefulDraft([spec]), {
      verdicts: { claim_finality: { verdict: "contradicted", issueCodes: ["decision_finality_conflict"] } },
      coverage: { finality: { status: "partial", reasonCode: "missing_qualification" } }
    });
    const result = await providers.run();
    expect(result.items).toEqual([]);
    expect(result.quality_assessment.status).toBe("insufficient");
    expect(providers.traces.find((trace) => trace.stage === "verified")).toMatchObject({ verdicts: [
      expect.objectContaining({ verdict: "contradicted", issueCodes: ["decision_finality_conflict"] })
    ] });
    expect(providers.request).toHaveBeenCalledTimes(2);
  });

  it("requires the current temporary arrangement instead of treating historical effort as complete coverage", async () => {
    const spec: SourceSpec = { key: "arrangement", kind: "proposal", section: "open_questions",
      body: "上周做过两次人工整理，每次约二十分钟；本轮提议先人工整理两次后复评，这是临时安排，不是长期承诺，导出需求仍保留。",
      text: "本轮提议先做两次人工整理后再评估，人工仅作临时过渡，导出需求继续保留，也没有长期承担承诺。" };
    const snapshot = sourcePack([spec]);
    const background = fixture(snapshot, [generatedItem("background", "overview",
      "上周两次人工整理每次约二十分钟，属于既往人工观察。", ["arrangement"])], {
      coverage: { arrangement: { status: "partial", reasonCode: "missing_key_content" } }
    });
    const incomplete = await background.run();
    expect(incomplete).toMatchObject({ status: "needs_review", quality_assessment: { status: "needs_review" } });
    expect(incomplete.items).toHaveLength(1);
    const complete = fixture(snapshot, usefulDraft([spec]));
    const result = await complete.run();
    expect(result.status).toBe("verified");
    expect(result.items[0]?.text).toBe(spec.text);
    expect(background.request).toHaveBeenCalledTimes(2);
    expect(complete.request).toHaveBeenCalledTimes(2);
  });
});

// Entirely invented, anonymous data. The expected paraphrases and verdicts below
// are a fixed fixture oracle, not claims about a model's semantic accuracy.
const topics: SourceSpec[] = [
  { key: "scope", kind: "decision", finality: "tentative", section: "decisions", claimType: "decision",
    body: "试用范围暂按记录卡、每日汇总、原文定位、事项分类、人工确认和基础统计六项准备，尚未定案。发言归属待确认。",
    text: "试用范围还没拍板，当前准备口径包括记录卡、每日汇总、原文定位、事项分类、人工确认及基础统计。" },
  { key: "export", kind: "decision", finality: "final", section: "decisions", claimType: "decision",
    body: "本轮不提供批量导出，权限边界还没划定，先人工核对三次再评估；不是取消导出需求，也不是长期人工方案。",
    text: "本轮先关闭批量导出：权限边界仍待澄清，人工核对三次后复评；需求保留，人工处理仅作过渡。" },
  { key: "reminder", kind: "decision", finality: "tentative", section: "decisions", claimType: "decision",
    body: "临时口径是只提供每日汇总，不提供即时提醒或个人开关；已有即时提醒代码保持关闭，不算交付，试用反馈后重议。最终性待确认。",
    text: "目前先按每日汇总准备，即时提醒和个人开关暂不纳入；现有提醒代码保持关闭、不计交付，收集试用反馈后再议，这个口径还没有定案。" },
  { key: "schedule", kind: "plan_change", section: "open_questions",
    body: "拟将开放日期从9月21日改至9月24日，9月22日冻结、9月23日培训。排期待确认。冻结后仅允许修复阻断问题，不扩大范围。",
    text: "排期草案把开放日由9月21日调整到9月24日，配套为9月22日冻结、23日培训；仍待确认，冻结后只修阻断问题。" },
  { key: "observations", kind: "proposal", section: "progress",
    body: "近两周有8名试用者进行了19次交接，4次分不清决定、建议和待确认待办；效率改善尚无测量，只是假设，不能对外作为成果。",
    text: "近两周的试用记录为8人、19次交接，其中4次分类理解不清；这些观察尚不能证明效率提升，也不足以支撑对外成果宣传。" },
  { key: "privacy", kind: "open_question", section: "waiting_for_others",
    body: "保存时长和删除规则尚未确定，政策负责人没有接受该事项，不能算已分配。发言归属待确认。",
    text: "数据保留期限和删除规则仍缺结论，也没有已接受该事项的政策负责人。" },
  { key: "identity", kind: "open_question", section: "waiting_for_others",
    body: "统一登录受外部依赖影响，当前只有临时测试身份；真实群组映射未验证，没有恢复时间。",
    text: "统一登录仍依赖外部进展，临时测试身份不能代表真实群组映射已验证，恢复时间也未知。" },
  { key: "mobile", kind: "open_question", section: "open_questions",
    body: "移动端是否属于上线门槛还没有结论，原记录把9月8日列为检查点，无后续确认；仅检查过桌面，手机长文本编辑和原文跳转未测，无已接受负责人或截止日期。",
    text: "移动端准入标准仍未决，原定9月8日检查点没有后续结论；目前只查过桌面，手机长文本编辑、原文跳转仍未验证，负责人和截止日期也未落实。" },
  { key: "guide", kind: "action_item", section: "open_questions",
    body: "指南准备至少需要两个工作日，应说明已确认、提议和待确认三个状态；尚无开工记录。",
    text: "指南需要解释已确认、提议、待确认三个状态，准备工期至少两个工作日；现有记录没有说明这项准备已经启动。" },
  { key: "metrics", kind: "proposal", section: "open_questions",
    body: "建议关注确认率、两道理解题和阻断反馈。链接打开率只有采集可行且不涉及敏感文本时才考虑；最小埋点与账号隔离检查也只是提议，执行人和9月12日日期未确认。",
    text: "指标方案仍在讨论，候选为确认率、两道理解题及阻断反馈；链接打开率须先满足可采集且不触及敏感文本，最小埋点和隔离检查也尚未获执行承诺，9月12日不能视为已确认期限。" },
  { key: "trial", kind: "proposal", section: "open_questions",
    body: "提议找三名试用者做冒烟，组织和记录模板先行；日期从9月15日讨论到9月17日，日期及接受人未确认。组织观察不等于技术验收结论。",
    text: "三人冒烟仍是待认领方案，先准备组织方式及记录模板；讨论日期由9月15日转到17日但未确认，组织观察也不能代替技术验收。" },
  { key: "roster", kind: "commitment", section: "open_questions", claimType: "commitment",
    body: "已有人接受整理18名参与者、两个小组的名单和规则渠道；记录日期9月7日的截止含义未确认，人数变化需当天登记，不得静默扩围，尚无实际开始或完成记录。发言归属待确认。",
    text: "已记录整理18人、两个小组名单及规则渠道的承诺，但没有开工或完成证据；9月7日不能当作已确认截止日，人数变化仍需当天登记，范围不能悄悄扩大。" },
  { key: "underway", kind: "action_item", section: "in_progress",
    body: "匿名测试数据校对已启动，第一批字段已核对，其余字段还在逐项检查；不代表全部完成。",
    text: "测试数据校对已查过第一批字段，其余字段仍在逐项核对，整体尚未结束。" }
];

function sourcePack(specs: SourceSpec[] = topics): Snapshot {
  const base = workWeeklyTestSnapshot();
  const findings = specs.map((spec) => ({ ...base.findings[0]!, id: `usable_${spec.key}`,
    sourceRef: findingRef(spec.key), kind: spec.kind, title: `匿名主题 ${spec.key}`, body: spec.body,
    structuredData: { decisionFinality: spec.finality ?? null, rawActorLabel: null, candidateOwner: null,
      actionBasis: spec.kind === "commitment" ? "explicit_commitment" : null },
    userConfirmedAt: "2026-09-09T08:00:00.000Z", evidenceRefs: [evidenceRef(spec.key)] }));
  const evidence = specs.map((spec, index) => ({ ...base.evidence[0]!, sourceRef: evidenceRef(spec.key),
    segmentId: `usable_segment_${spec.key}`, startSeconds: index * 10, endSeconds: index * 10 + 9, text: spec.body }));
  const identities: Snapshot["identities"] = [base.identities.find((entry) => entry.sourceKind === "meeting")!,
    ...findings.map((entry) => ({ sourceRef: entry.sourceRef, sourceKind: "finding" as const,
      sourceId: entry.id, version: entry.version, digest: "d".repeat(64), publicationId: null, segmentId: null, included: true })),
    ...evidence.map((entry) => ({ sourceRef: entry.sourceRef, sourceKind: "evidence" as const,
      sourceId: entry.segmentId, version: null, digest: entry.publicationDigest,
      publicationId: entry.publicationId, segmentId: entry.segmentId, included: true }))];
  return WorkWeeklySourceSnapshotSchema.parse({ ...base,
    scope: { ...base.scope, weekStart: "2026-09-07", weekEnd: "2026-09-13", observedThrough: "2026-09-10" },
    createdAt: "2026-09-10T08:00:00.000Z", findings, evidence, identities, todos: [], todoEvents: [],
    meetings: base.meetings.map((entry) => ({ ...entry, title: "匿名试用讨论", meetingDate: "2026-09-09" })),
    allowlistedSourceRefs: identities.map((entry) => entry.sourceRef).sort(),
    summary: { ...base.summary, findingCount: specs.length, evidenceCount: specs.length,
      includedFindingCount: specs.length, includedEvidenceCount: specs.length,
      todoCount: 0, todoEventCount: 0, includedTodoCount: 0, includedTodoEventCount: 0 } });
}

function generatedItem(key: string, section: Item["section"], text: string, keys: string[], claimType: Claim["claimType"] = "fact"): Item {
  return { id: `item_${key}`, section, text: "非发布权威的简短摘要",
    itemType: section === "next_week" ? "suggestion" : "evidence_backed_fact",
    claims: [{ id: `claim_${key}`, text, claimType, sourceRefs: keys.map(findingRef) }] };
}
function usefulDraft(specs: SourceSpec[] = topics): Item[] {
  return specs.map((spec) => generatedItem(spec.key, spec.section, spec.text, [spec.key], spec.claimType));
}
function overview(): Item {
  return generatedItem("overview", "overview",
    "本周的试用准备涉及范围和排期调整，其中每日汇总口径仍待定；外部登录和数据政策有缺口，测试数据校对则已有实际进展。",
    ["scope", "schedule", "reminder", "identity", "privacy", "underway"]);
}
function attention(): Item {
  return generatedItem("attention", "next_week",
    "统一登录的真实群组映射尚未验证，恢复时间未知，临时测试身份仍不足以消除这个试用依赖。", ["identity"]);
}
function payload<T>(input: Parameters<WorkWeeklyStructuredJsonRequest>[0]): T {
  if (!Array.isArray(input.requestInput)) throw new Error("Expected structured messages");
  const message = input.requestInput[1];
  if (!message || !("content" in message) || typeof message.content !== "string") throw new Error("Expected JSON request");
  return JSON.parse(message.content) as T;
}

type WireCoverage = Omit<WorkWeeklyCoverageAssessment, "claimIds">;
type CoverageCandidate = { claim: Claim; relationship: "direct_record" | "direct_evidence" | "shared_evidence" | "todo_history";
  section?: Item["section"]; itemType?: Item["itemType"] };
function fixture(snapshot: Snapshot, draft: Item[], options: {
  verdicts?: Record<string, Pick<Verdict, "verdict" | "issueCodes">>;
  coverage?: Record<string, Pick<WireCoverage, "status" | "reasonCode">>;
  coverageClaims?: Record<string, string[]>;
} = {}) {
  const traces: WorkWeeklyGenerationTrace[] = [];
  const request = vi.fn<WorkWeeklyStructuredJsonRequest>(async (input) => {
    if (input.profile.role === "synthesizer") return { items: draft };
    const packet = payload<{ items: Array<{ claim: Claim; sources: Array<{ sourceRef: string }> }>;
      coverageSources: Array<{ source: { sourceRef: string }; sourceText: string; candidateClaims: CoverageCandidate[] }> }>(input);
    const expected = draft.flatMap((item) => item.claims);
    expect(packet.items.map(({ claim }) => ({ ...claim, id: "normalized" })))
      .toEqual(expected.map(({ claimType: _claimType, ...claim }) => ({ ...claim, id: "normalized" })));
    for (const entry of packet.items) expect(entry.claim).not.toHaveProperty("claimType");
    for (const entry of packet.items) expect(entry.sources.map((source) => source.sourceRef)).toEqual(entry.claim.sourceRefs);
    const items: Verdict[] = packet.items.map(({ claim }, index) => {
      const judged = options.verdicts?.[expected[index]!.id] ?? { verdict: "entailed" as const, issueCodes: [] };
      return { claimId: claim.id, ...judged,
        supportedSourceRefs: ["entailed", "partially_entailed"].includes(judged.verdict) ? claim.sourceRefs : [] };
    });
    // These fixed semantic judgments do not derive completeness from candidate
    // count or mere citation overlap. Negative examples explicitly change them.
    const coverage = snapshot.findings.map((source) => {
      const key = source.id.replace("usable_", "");
      const oracle = options.coverage?.[key] ?? { status: "covered" as const, reasonCode: "covered" as const };
      const selected = oracle.status === "covered" || oracle.reasonCode === "duplicate"
        ? packet.items.filter(({ claim }, index) => options.coverageClaims?.[key]
          ? options.coverageClaims[key]!.includes(expected[index]!.id)
          : claim.sourceRefs.includes(source.sourceRef) && items[index]!.verdict === "entailed" && items[index]!.issueCodes.length === 0) : [];
      const sourceText = packet.coverageSources.find((entry) => entry.source.sourceRef === source.sourceRef)!.sourceText;
      return { sourceRef: source.sourceRef, ...oracle, claimIds: selected.map(({ claim }) => claim.id),
        matches: selected.map(({ claim }) => ({ claimId: claim.id, sourceExcerpt: sourceText.slice(0, 600), claimExcerpt: claim.text.slice(0, 600) })) };
    });
    const disputes = items.flatMap((entry, index) => entry.issueCodes.map((issueCode) => ({
      claimId: entry.claimId, issueCode, claimExcerpt: packet.items[index]!.claim.text.slice(0, 600),
      explanation: "匿名固定 oracle：该分句超出来源支持或缺少改变其含义的限定。"
    })));
    expect(packet.coverageSources.map(({ source }) => source.sourceRef).sort()).toEqual(snapshot.findings.map((source) => source.sourceRef).sort());
    expect(input.schema.safeParse({ items, disputes, coverage }).success).toBe(true);
    return { items, disputes, coverage };
  });
  const synthesizer = createStructuredWorkWeeklySynthesizer({ profile: workWeeklyProfile("synthesizer"), requestStructuredJson: request });
  const verifier = createStructuredWorkWeeklyClaimVerifier({ profile: workWeeklyProfile("verifier"), requestStructuredJson: request });
  return { request, traces, synthesizer, verifier,
    run: () => runWorkWeeklyGenerationPipeline({ accountId: snapshot.accountId, snapshot, synthesizer, verifier,
      onTrace: (trace) => { traces.push(trace); } }) };
}

describe("independent useful Weekly output through the real local publication path", () => {
  it("persists and rereads seventeen verified items with explicit gaps instead of losing the entire twenty-item draft", async () => {
    const snapshot = sourcePack();
    const omitted = new Set(["metrics", "roster", "trial"]);
    const rejected = [
      generatedItem("metrics", "open_questions", "指标方案已经最终定案，全部采集均可上线。", ["metrics"]),
      generatedItem("roster", "open_questions", "名单已承诺在9月7日全部完成，工作已经结束。", ["roster"], "commitment"),
      generatedItem("trial", "open_questions", "执行者已接受技术验收并保证9月17日完成。", ["trial"], "commitment")
    ];
    const draft = [...usefulDraft(topics.filter((topic) => !omitted.has(topic.key))), overview(), attention(),
      generatedItem("scope_detail", "open_questions", "六项试用范围仍未定案，现阶段只是准备口径。", ["scope"]),
      generatedItem("export_detail", "decisions", "导出需求继续保留，人工核对三次后复评，人工方式不作为长期方案。", ["export"], "decision"),
      generatedItem("privacy_detail", "waiting_for_others", "政策事项尚无已接受的负责人。", ["privacy"]),
      generatedItem("mobile_detail", "open_questions", "手机验证的负责人和截止时间都还没有落实。", ["mobile"]),
      generatedItem("guide_detail", "open_questions", "指南准备至少需要两个工作日，目前没有开工记录。", ["guide"]), ...rejected];
    expect(draft).toHaveLength(20);
    const providers = fixture(snapshot, draft, {
      verdicts: Object.fromEntries([...omitted].map((key) => [`claim_${key}`, {
        verdict: "partially_entailed" as const, issueCodes: [key === "roster" ? "missing_qualification" : "claim_type_mismatch"]
      }])),
      coverage: Object.fromEntries([...omitted].map((key) => [key, { status: "omitted" as const, reasonCode: "missing_qualification" as const }]))
    });
    const db = openWorkReviewDatabase({ filePath: ":memory:" });
    databases.push(db);
    let id = 0;
    const options = { now: () => "2026-09-10T08:01:00.000Z", idFactory: () => `partial17_${++id}`, currentSnapshotBuilder: () => snapshot };
    const repository = new WorkWeeklyRepository(db, options);
    const queued = repository.queueGeneration({ accountId: snapshot.accountId, snapshot,
      operationKey: "publish_seventeen_safe_items", expectedVersion: null, kind: "generate" });
    const executor = createFixtureWorkWeeklyRunExecutor({ repository, loadSnapshot: () => snapshot,
      synthesizer: providers.synthesizer, weeklyVerifier: providers.verifier, qaAnswerer: null, qaVerifier: null });
    expect(await executor.runGeneration({ accountId: snapshot.accountId, weeklyReviewId: queued.review.id,
      runId: queued.run.id, runVersion: queued.run.runVersion, sourceSnapshotDigest: snapshot.digest,
      leaseOwner: "partial_fixture_worker", leaseMs: 60_000, observedState: "queued" })).toMatchObject({ state: "published" });
    const detail = new WorkWeeklyRepository(db, options).getDetail(snapshot.accountId, queued.review.id);
    expect(detail.items).toHaveLength(17); // Fixture count, never a product threshold.
    expect(detail.items.every((item) => item.verificationState === "verified")).toBe(true);
    expect(detail.items.every((item) => item.sourceRefs.every((ref) => snapshot.allowlistedSourceRefs.includes(ref)))).toBe(true);
    expect(detail.review).toMatchObject({ status: "ready", currentSystemVersion: 1 });
    expect(detail.displayedGeneration).toMatchObject({ systemVersion: 1, qualityStatus: "needs_review" });
    expect(detail.displayedGeneration?.reviewIssues).toEqual(expect.arrayContaining([...omitted].map((key) => ({
      sourceRef: findingRef(key), reasonCode: "missing_qualification"
    }))));
    expect(detail.latestGeneration).toMatchObject({ qualityStatus: "needs_review", displayingPreviousVersion: false });
    for (const item of rejected) expect(JSON.stringify(detail)).not.toContain(item.claims[0]!.text);
    expect(providers.request).toHaveBeenCalledTimes(2);
  });

  it("publishes a readable multi-topic review with natural qualifications, change history and useful attention", async () => {
    const snapshot = sourcePack();
    const draft = [overview(), ...usefulDraft(), attention()];
    const providers = fixture(snapshot, draft);
    const db = openWorkReviewDatabase({ filePath: ":memory:" });
    databases.push(db);
    let id = 0;
    const repository = new WorkWeeklyRepository(db, { now: () => "2026-09-10T08:01:00.000Z",
      idFactory: () => `usable_${++id}`, currentSnapshotBuilder: () => snapshot });
    const queued = repository.queueGeneration({ accountId: snapshot.accountId, snapshot,
      operationKey: "publish_useful_review", expectedVersion: null, kind: "generate" });
    const executor = createFixtureWorkWeeklyRunExecutor({ repository, loadSnapshot: () => snapshot,
      synthesizer: providers.synthesizer, weeklyVerifier: providers.verifier, qaAnswerer: null, qaVerifier: null });
    expect(await executor.runGeneration({ accountId: snapshot.accountId, weeklyReviewId: queued.review.id,
      runId: queued.run.id, runVersion: queued.run.runVersion, sourceSnapshotDigest: snapshot.digest,
      leaseOwner: "anonymous_fixture_worker", leaseMs: 60_000, observedState: "queued" })).toMatchObject({ state: "published" });
    const detail = repository.getDetail(snapshot.accountId, queued.review.id);
    expect(detail.latestGeneration).toMatchObject({ qualityStatus: "passed", executionStatus: "completed", displayingPreviousVersion: false });
    expect(detail.review.currentSystemVersion).toBe(1);
    // A fixture-specific semantic checklist, not a production row-count gate.
    for (const topic of topics) expect(detail.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ section: topic.section, systemText: topic.text, verificationState: "verified" })
    ]));
    expect(detail.items.find((item) => item.section === "overview")?.systemText).toBe(overview().claims[0]!.text);
    expect(detail.items.find((item) => item.section === "next_week")?.systemText).toBe(`AI建议关注：${attention().claims[0]!.text}`);
    expect(detail.items.filter((item) => item.section === "completed")).toEqual([]);
    expect(detail.items.filter((item) => item.section === "in_progress")).toHaveLength(1);
    expect(detail.items.every((item) => item.sourceRefs.every((ref) => snapshot.allowlistedSourceRefs.includes(ref)))).toBe(true);
    expect(detail.items.some((item) => item.systemText?.includes("发言归属待确认"))).toBe(false);
    expect(detail.items.some((item) => item.systemText?.includes("非发布权威"))).toBe(false);
    expect(providers.request).toHaveBeenCalledTimes(2);
  });

  it("allows an entailed overview and concise details without requiring every source's attribution footnote", async () => {
    const specs = topics.filter((topic) => ["scope", "reminder", "privacy"].includes(topic.key));
    const output = [generatedItem("overview", "overview", "试用范围与提醒口径还没定案，数据政策也有待补齐。", ["scope", "reminder", "privacy"]), ...usefulDraft(specs)];
    const result = await fixture(sourcePack(specs), output).run();
    expect(result.status).toBe("verified");
    expect(result.items.map((item) => item.text)).toEqual(expect.arrayContaining(output.map((item) => item.claims[0]!.text)));
    expect(result.quality_assessment.status).toBe("passed");
  });

  it("keeps a complete safe expression when an extra related draft claim is rejected", async () => {
    const specs = topics.filter((topic) => topic.key === "reminder");
    const bad = generatedItem("redundant_bad", "overview", "即时提醒已正式交付。", ["reminder"]);
    const providers = fixture(sourcePack(specs), [...usefulDraft(specs), bad], {
      verdicts: { claim_redundant_bad: { verdict: "contradicted", issueCodes: ["unsupported_delivery"] } }
    });
    const result = await providers.run();
    expect(result.status).toBe("verified");
    expect(result.items.map((item) => item.text)).toEqual([specs[0]!.text]);
    expect(result.quality_assessment.status).toBe("passed");
    expect(providers.request).toHaveBeenCalledTimes(2);
  });

  it("condenses a semantically duplicate summary from different Evidence without inventing citation support", async () => {
    const detailed = topics.find((topic) => topic.key === "export")!;
    const identity = topics.find((topic) => topic.key === "identity")!;
    const summary: SourceSpec = { key: "summary", kind: "decision", finality: "final", section: "overview",
      body: "本轮导出先不开放，权限边界明确前用短期人工核对，再评估；需求没有取消。", text: "重复概述不必再生成一条。" };
    const snapshot = sourcePack([detailed, identity, summary]);
    expect(snapshot.findings[2]!.evidenceRefs).not.toEqual(snapshot.findings[0]!.evidenceRefs);
    // The factual content is supported but this redundant draft mislabels an
    // open question as a decision. Removing it must not poison other coverage.
    const redundant = generatedItem("bad_tag", "overview", identity.text, ["identity"], "decision");
    const providers = fixture(snapshot, [...usefulDraft([detailed, identity]), redundant], {
      coverage: { summary: { status: "not_applicable", reasonCode: "duplicate" } },
      coverageClaims: { summary: ["claim_export"] }
    });
    const result = await providers.run();
    expect(result.status).toBe("verified");
    expect(result.items.map((item) => item.text)).toEqual([detailed.text, identity.text]);
    expect(result.quality_assessment).toMatchObject({ status: "passed", coveredSourceCount: 2, notApplicableSourceCount: 1 });
    const packet = payload<{ coverageSources: Array<{ source: { sourceRef: string }; candidateClaims: CoverageCandidate[] }> }>(providers.request.mock.calls[1]![0]);
    expect(packet.coverageSources.find((entry) => entry.source.sourceRef === findingRef("summary"))?.candidateClaims).toEqual([]);
    expect(result.items.flatMap((item) => item.sourceRefs)).toEqual([findingRef("export"), findingRef("identity")]);
    expect(result.items.flatMap((item) => item.sourceRefs)).not.toContain(findingRef("summary"));
    const publication = providers.traces.find((trace) => trace.stage === "published");
    if (publication?.stage !== "published") throw new Error("Missing publication trace");
    expect(publication.claims).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "rejected", reasonCode: "decision_source_missing" })]));
  });

  it("does not dismiss a materially conflicting summary as a duplicate", async () => {
    const detailed = topics.find((topic) => topic.key === "export")!;
    const conflicting: SourceSpec = { key: "summary", kind: "decision", finality: "final", section: "overview",
      body: "会议收尾摘要写为导出需求已取消。", text: "与详细记录的需求保留有实质冲突。" };
    const providers = fixture(sourcePack([detailed, conflicting]), usefulDraft([detailed]), {
      coverage: { summary: { status: "partial", reasonCode: "missing_key_content" } }
    });
    const result = await providers.run();
    expect(result).toMatchObject({ status: "needs_review", quality_assessment: { status: "needs_review" } });
    expect(result.items.map((item) => item.text)).toEqual([detailed.text]);
  });

  it("cannot replace filtered unique qualifications with a shorter surviving overview", async () => {
    const detailed = topics.find((topic) => topic.key === "export")!;
    const providers = fixture(sourcePack([detailed]), [
      generatedItem("shallow", "overview", "本轮不提供批量导出。", ["export"], "decision"),
      generatedItem("qualified_bad_tag", "open_questions", detailed.text, ["export"], "commitment")
    ]);
    const result = await providers.run();
    expect(result).toMatchObject({ status: "needs_review", quality_assessment: { status: "needs_review" } });
    expect(result.items.map((item) => item.text)).toEqual(["本轮不提供批量导出。"]);
    expect(result.quality_assessment.reasonCodes).toContain("coverage_claim_filtered");
  });

  it.each([
    { key: "reminder", text: "最终决定上线每日汇总，即时提醒已正式交付。", type: "decision" as const, issue: "finality_and_delivery_changed" },
    { key: "trial", text: "三人冒烟已经启动，执行人已承诺9月17日完成技术验收。", type: "commitment" as const, issue: "proposal_upgraded_to_started_commitment" }
  ])("does not publish a material distortion of $key as a passing review", async ({ key, text, type, issue }) => {
    const snapshot = sourcePack();
    const draft = [overview(), ...usefulDraft().map((item) => item.id === `item_${key}`
      ? generatedItem(key, item.section, text, [key], type) : item)];
    const providers = fixture(snapshot, draft, {
      verdicts: { [`claim_${key}`]: { verdict: "contradicted", issueCodes: [issue] } },
      coverage: { [key]: { status: "partial", reasonCode: "missing_qualification" } }
    });
    const result = await providers.run();
    expect(result).toMatchObject({ status: "needs_review", quality_assessment: { status: "needs_review" } });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.some((item) => item.text === text)).toBe(false);
    expect(providers.request).toHaveBeenCalledTimes(2);
  });

  it("does not mistake a passing overview mention for complete coverage of an omitted important topic", async () => {
    const providers = fixture(sourcePack(), [overview(), ...usefulDraft().filter((item) => item.id !== "item_schedule")], {
      coverage: { schedule: { status: "partial", reasonCode: "missing_key_content" } }
    });
    const result = await providers.run();
    expect(result).toMatchObject({ status: "needs_review", quality_assessment: { status: "needs_review" } });
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("keeps ordinary QA multi-claim answers and exact canonical citations with the same natural wording", async () => {
    const snapshot = sourcePack();
    const claims = usefulDraft().filter((item) => ["item_reminder", "item_privacy"].includes(item.id)).flatMap((item) => item.claims);
    const request = vi.fn<WorkWeeklyStructuredJsonRequest>(async (input) => input.profile.role === "qa_answerer"
      ? { status: "answered", answer: "自由回答不参与展示", claims, relevantSourceRefs: claims.flatMap((claim) => claim.sourceRefs) }
      : { items: payload<{ items: Array<{ claim: Claim }> }>(input).items.map(({ claim }) => ({
        claimId: claim.id, verdict: "entailed", issueCodes: [], supportedSourceRefs: claim.sourceRefs })) });
    const answer = await answerWorkWeeklyQuestion({ accountId: snapshot.accountId, weeklyReviewId: "anonymous_weekly",
      snapshot, question: "试用范围里，提醒口径和数据政策现在有什么结论？",
      answerer: createStructuredWorkWeeklyQaAnswerer({ profile: workWeeklyProfile("qa_answerer"), requestStructuredJson: request }),
      verifier: createStructuredWorkWeeklyQaVerifier({ profile: workWeeklyProfile("qa_verifier"), requestStructuredJson: request }) });
    expect(answer).toMatchObject({ answerStatus: "answered", answer: claims.map((claim) => claim.text).join("；"), failureCode: null });
    expect(answer.sourceRefs).toEqual(claims.flatMap((claim) => claim.sourceRefs).sort());
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("independent source-centered generation and coverage", () => {
  it("does not substitute a safe different topic for a rejected selected claim sharing canonical Evidence", async () => {
    const mobile: SourceSpec = { key: "mobile", kind: "open_question", section: "open_questions",
      body: "平板上的长文本编辑还没有验证，准入标准尚未确定。",
      text: "平板长文本编辑未验证，准入标准仍待确定。" };
    const instrumentation: SourceSpec = { key: "instrumentation", kind: "proposal", section: "open_questions",
      body: "提议采集最小事件计数并检查账号隔离；若必须采集敏感文本则放弃该指标。截止时间待确认。",
      text: "事件计数和账号隔离检查仍是拟议事项，期限未确认；需要敏感文本就不采该指标。" };
    const snapshot = sourcePack([mobile, instrumentation]);
    snapshot.findings[1]!.evidenceRefs = [evidenceRef("mobile")];
    snapshot.evidence[0]!.text = `${mobile.body} ${instrumentation.body}`;
    // Deliberately incorrect coverage from the fixture: relationship is not
    // permission to claim that mobile text also covers instrumentation.
    const providers = fixture(snapshot, usefulDraft([mobile, instrumentation]), {
      verdicts: { claim_instrumentation: { verdict: "partially_entailed", issueCodes: ["claim_type_mismatch"] } },
      coverageClaims: { instrumentation: ["claim_instrumentation"] }
    });
    const result = await providers.run();
    expect(result.quality_assessment.status).toBe("needs_review");
    expect(result.quality_assessment).toMatchObject({ coveredSourceCount: 1, partialSourceCount: 1 });
    expect(result.quality_assessment.reviewIssues).toContainEqual({ sourceRef: findingRef("instrumentation"), reasonCode: "coverage_claim_filtered" });
    expect(result.items.map((item) => item.text)).toEqual([mobile.text]);
    expect(result.items.flatMap((item) => item.sourceRefs)).toEqual([findingRef("mobile")]);
    const verified = providers.traces.find((trace) => trace.stage === "verified");
    expect(verified).toMatchObject({ coverage: expect.arrayContaining([
      expect.objectContaining({ sourceRef: findingRef("instrumentation"), status: "covered", claimIds: expect.any(Array) })
    ]) });
    if (verified?.stage !== "verified") throw new Error("Missing verification trace");
    const selected = verified.coverage?.find((entry) => entry.sourceRef === findingRef("instrumentation"))!.claimIds;
    expect(selected).toHaveLength(1);
    expect(verified.verdicts.find((entry) => entry.claimId === selected![0])?.verdict).toBe("partially_entailed");
    expect(providers.request).toHaveBeenCalledTimes(2);
  });

  it.each(["omit_uncertain_date", "retain_uncertainty"] as const)(
    "keeps an accepted task independently of an unconfirmed deadline: %s", async (mode) => {
      const spec: SourceSpec = { key: "accepted_task", kind: "commitment", section: "open_questions", claimType: "commitment",
        body: "已接受整理测试名单和规则渠道的事项；记录中的9月12日截止含义尚未确认。没有开始或完成记录。",
        text: mode === "omit_uncertain_date" ? "已记录整理测试名单和规则渠道的承诺，尚无开始或完成证据。"
          : "已接受整理测试名单和规则渠道；记录有9月12日，但尚不能将其作为已确认截止日期。" };
      const snapshot = sourcePack([spec]);
      const providers = fixture(snapshot, usefulDraft([spec]));
      const result = await providers.run();
      expect(result.quality_assessment.status).toBe("passed");
      expect(result.items).toEqual([expect.objectContaining({ text: spec.text, sourceRefs: [findingRef("accepted_task")] })]);
      expect(result.items.some((item) => ["completed", "in_progress"].includes(item.section))).toBe(false);
      const invalid = fixture(snapshot, [generatedItem("date_upgrade", "open_questions",
        "已承诺在9月12日之前完成名单和规则渠道整理。", ["accepted_task"], "commitment")], {
        verdicts: { claim_date_upgrade: { verdict: "partially_entailed", issueCodes: ["missing_qualification"] } },
        coverage: { accepted_task: { status: "omitted", reasonCode: "missing_qualification" } }
      });
      const rejected = await invalid.run();
      expect(rejected.items).toEqual([]);
      expect(rejected.quality_assessment.status).not.toBe("passed");
      expect(providers.request).toHaveBeenCalledTimes(2);
      expect(invalid.request).toHaveBeenCalledTimes(2);
    }
  );

  it("keeps shared and orphan Evidence reachable while placing each Finding beside its own canonical support", () => {
    const snapshot = workWeeklyTestSnapshot();
    snapshot.findings[1]!.evidenceRefs = [refs.evidenceDecision];
    snapshot.findings[1]!.body = snapshot.findings[0]!.body;
    const before = JSON.stringify(snapshot);
    const pack = buildWorkWeeklySynthesisPack({ accountId: snapshot.accountId, snapshot });
    type Node = { sourceRef: string; sourceKind: string; value: unknown; supportingEvidence?: Node[] };
    const roots = pack.sources as Node[];
    const reachable = [...roots, ...roots.flatMap((source) => source.supportingEvidence ?? [])];
    expect([...new Set(reachable.map((source) => source.sourceRef))].sort()).toEqual(snapshot.allowlistedSourceRefs);
    for (const finding of snapshot.findings) {
      const group = roots.find((source) => source.sourceRef === finding.sourceRef)!;
      expect(group.supportingEvidence?.map((source) => source.sourceRef).sort()).toEqual([...finding.evidenceRefs].sort());
      for (const evidence of group.supportingEvidence ?? []) {
        expect(evidence.sourceKind).toBe("evidence");
        expect(evidence.value).toEqual(snapshot.evidence.find((source) => source.sourceRef === evidence.sourceRef));
      }
    }
    // Shared support may appear under two Findings; it is still one authority.
    expect(reachable.filter((source) => source.sourceRef === refs.evidenceDecision)).toHaveLength(2);
    expect(roots.some((source) => source.sourceRef === refs.evidenceDecision)).toBe(false);
    expect(roots.find((source) => source.sourceRef === refs.evidenceProposal)?.value)
      .toEqual(snapshot.evidence.find((source) => source.sourceRef === refs.evidenceProposal));
    for (const sourceRef of [refs.meeting, refs.todo, refs.todoCompleted]) {
      expect(roots.some((source) => source.sourceRef === sourceRef)).toBe(true);
    }
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(resolveWorkWeeklySourceRecord(snapshot, refs.evidenceProposal)?.value)
      .toEqual(snapshot.evidence.find((source) => source.sourceRef === refs.evidenceProposal));
  });

  it("shows the four real relations with exact candidate content and never expands claim citations", async () => {
    const snapshot = workWeeklyTestSnapshot();
    snapshot.findings[1]!.evidenceRefs = [refs.evidenceDecision];
    snapshot.findings[1]!.body = snapshot.findings[0]!.body;
    const before = JSON.stringify(snapshot);
    const cases = [
      { id: "direct", text: "本轮采用方案 B。", sourceRef: refs.decision },
      { id: "evidence", text: "容量风险是记录中的选择背景。", sourceRef: refs.evidenceDecision },
      { id: "shared", text: "另一条记录也保留方案 B。", sourceRef: refs.proposal },
      { id: "todo", text: "清单待办的系统状态为完成。", sourceRef: refs.todo },
      { id: "event", text: "清单在系统中标记完成。", sourceRef: refs.todoCompleted },
      { id: "unrelated", text: "另一个日期出现在文档中。", sourceRef: refs.evidenceDated }
    ];
    const claims: Claim[] = cases.map((entry) => ({ id: entry.id, text: entry.text, claimType: "fact", sourceRefs: [entry.sourceRef] }));
    const items: Item[] = claims.map((claim) => ({ id: `item_${claim.id}`, text: "非权威摘要", section: "overview", itemType: "evidence_backed_fact", claims: [claim] }));
    const request = vi.fn<WorkWeeklyStructuredJsonRequest>(async (input) => {
      const packet = payload<{ items: Array<{ claim: Claim; sources: Array<{ sourceRef: string }> }>;
        coverageSources: Array<{ source: { sourceRef: string }; candidateClaims: CoverageCandidate[] }> }>(input);
      const group = (ref: string) => packet.coverageSources.find((entry) => entry.source.sourceRef === ref)!.candidateClaims;
      expect(group(refs.decision).map((entry) => [entry.claim.id, entry.relationship]))
        .toEqual([["direct", "direct_record"], ["evidence", "direct_evidence"], ["shared", "shared_evidence"]]);
      expect(group(refs.todo).map((entry) => [entry.claim.id, entry.relationship]))
        .toEqual([["todo", "direct_record"], ["event", "todo_history"]]);
      expect(group(refs.todoCompleted).map((entry) => [entry.claim.id, entry.relationship]))
        .toEqual([["todo", "todo_history"], ["event", "direct_record"]]);
      for (const entry of packet.coverageSources) {
        for (const candidate of entry.candidateClaims) {
          const expected = claims.find((claim) => claim.id === candidate.claim.id)!;
          expect(candidate.claim).toEqual({ id: expected.id, text: expected.text, sourceRefs: expected.sourceRefs });
          expect(candidate).toMatchObject({ section: "overview", itemType: "evidence_backed_fact" });
        }
      }
      for (const entry of packet.items) expect(entry.sources.map((source) => source.sourceRef)).toEqual(entry.claim.sourceRefs);
      expect(workWeeklyCoverageClaimIsRelated(snapshot, refs.decision, [refs.evidenceDated])).toBe(false);
      expect(workWeeklyCoverageClaimIsRelated(snapshot, refs.decision, [refs.proposal])).toBe(true);
      expect(workWeeklyCoverageClaimIsRelated(snapshot, refs.todo, [refs.todoCompleted])).toBe(true);
      return { items: claims.map((claim) => ({ claimId: claim.id, verdict: "entailed", issueCodes: [], supportedSourceRefs: claim.sourceRefs })),
        disputes: [], coverage: packet.coverageSources.map(({ source }) => ({ sourceRef: source.sourceRef,
          status: "partial", reasonCode: "missing_key_content", claimIds: [], matches: [] })) };
    });
    const coverage = vi.fn();
    const verifier = createStructuredWorkWeeklyClaimVerifier({ profile: workWeeklyProfile("verifier"), requestStructuredJson: request });
    const result = await verifier.verify({ accountId: snapshot.accountId, snapshot, claims, items, onCoverage: coverage });
    expect(result.map((entry) => entry.supportedSourceRefs)).toEqual(claims.map((claim) => claim.sourceRefs));
    expect(coverage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["no_own_attention", "rejected_extra_attention"] as const)(
    "publishes complete policy content with selected AI attention: %s", async (mode) => {
      const specs = topics.filter((topic) => ["privacy", "identity"].includes(topic.key));
      const snapshot = sourcePack(specs);
      const draft = [...usefulDraft(specs), attention()];
      if (mode === "rejected_extra_attention") draft.push(generatedItem("privacy_extra", "next_week",
        "数据保留事项已经由负责人接受。", ["privacy"]));
      const providers = fixture(snapshot, draft, { verdicts: mode === "rejected_extra_attention"
        ? { claim_privacy_extra: { verdict: "contradicted", issueCodes: ["unsupported_acceptance"] } } : {} });
      const result = await providers.run();
      expect(result.status).toBe("verified");
      expect(result.quality_assessment).toMatchObject({ status: "passed", coveredSourceCount: 2 });
      expect(result.items.filter((item) => item.section === "next_week").map((item) => item.sourceRefs))
        .toEqual([[findingRef("identity")]]);
      expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({
        text: specs.find((spec) => spec.key === "privacy")!.text, sourceRefs: [findingRef("privacy")]
      })]));
      const packet = payload<{ coverageSources: Array<{ source: { sourceRef: string }; candidateClaims: CoverageCandidate[] }> }>(providers.request.mock.calls[1]![0]);
      const policyCandidates = packet.coverageSources.find((entry) => entry.source.sourceRef === findingRef("privacy"))!.candidateClaims;
      expect(policyCandidates).toEqual(expect.arrayContaining([expect.objectContaining({
        claim: expect.objectContaining({ text: specs.find((spec) => spec.key === "privacy")!.text }),
        relationship: "direct_record", section: "waiting_for_others"
      })]));
      if (mode === "rejected_extra_attention") {
        const trace = providers.traces.find((entry) => entry.stage === "published");
        if (trace?.stage !== "published") throw new Error("Missing publication trace");
        expect(trace.claims.find((entry) => entry.section === "next_week" && entry.sourceRefs.includes(findingRef("privacy"))))
          .toMatchObject({ outcome: "rejected", publishedSortOrder: null });
      }
      expect(providers.request).toHaveBeenCalledTimes(2);
    }
  );

  it("preserves a qualified canonical proposal beside decision-like Evidence without promoting its type", async () => {
    const spec: SourceSpec = { key: "metrics", kind: "proposal", section: "open_questions",
      body: "建议将确认率作为主指标，链接打开率只有埋点按时完成才纳入；决定是否最终待确认。",
      text: "确认率拟作为主指标，链接打开率须满足埋点按时完成的条件；这仍是待确认方案。" };
    const snapshot = sourcePack([spec]);
    snapshot.evidence[0]!.text = "第四个决定是主看确认率；链接打开率须等埋点按时完成。";
    const providers = fixture(snapshot, usefulDraft([spec]));
    const result = await providers.run();
    expect(result.status).toBe("verified");
    expect(result.items[0]).toMatchObject({ section: "open_questions", text: spec.text, sourceRefs: [findingRef("metrics")] });
    const pack = payload<{ sources: Array<{ sourceRef: string; value: unknown; generationGuidance?: unknown;
      supportingEvidence?: Array<{ sourceRef: string; value: unknown }> }> }>(providers.request.mock.calls[0]![0]);
    expect(pack.sources.find((source) => source.sourceRef === findingRef("metrics"))).toMatchObject({
      value: { kind: "proposal", body: spec.body }, generationGuidance: { mode: "proposal", suggestedClaimType: "fact" },
      supportingEvidence: [{ sourceRef: evidenceRef("metrics"), value: { text: snapshot.evidence[0]!.text } }]
    });
    const upgraded = fixture(snapshot, [generatedItem("metrics", "decisions", spec.text, ["metrics"], "decision")]);
    expect((await upgraded.run()).items).toEqual([]);
    expect(providers.request).toHaveBeenCalledTimes(2);
    expect(upgraded.request).toHaveBeenCalledTimes(2);
  });
});

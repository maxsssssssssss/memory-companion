// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkExtractorCandidateDraft } from "@/lib/domain/work-review";
import type { JsonStore } from "@/lib/server/storage/json-store";

import {
  createStructuredWorkMeetingExtractor,
  WorkMeetingAnalysisProviderError,
  type WorkMeetingExtractor,
  type WorkMeetingVerifier
} from "./analysis-provider";
import { openWorkReviewDatabase } from "./db";
import { mapWorkAnalysisWithConcurrency, processWorkMeeting } from "./orchestrator";
import {
  WORK_MEETING_CAUSALITY_ROUTING_ISSUE_CODE,
  WORK_MEETING_NON_GPT_ISSUE_CODE,
  WORK_MEETING_NON_GPT_PROFILE
} from "./publication-policy";
import { WorkReviewLeaseLostError, WorkReviewRepository } from "./repository";
import { createWorkMeetingDeduplicator, type WorkMeetingDeduplicator } from "./candidate-deduplication";
import {
  resolveWorkReviewExtractorExecutionPolicy,
  WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
  WORK_MEETING_EXTRACTOR_SCHEMA_VERSION,
  WORK_MEETING_VERIFIER_PROMPT_VERSION,
  WORK_MEETING_VERIFIER_SCHEMA_VERSION,
  type WorkReviewExtractorExecutionPolicy
} from "./runtime-config";
import { toWorkMeetingDetailView } from "./view";

let database: Database.Database;
let repository: WorkReviewRepository;

function deferred<Value = void>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function extractorExecutionPolicy(
  overrides: Partial<WorkReviewExtractorExecutionPolicy> = {}
): WorkReviewExtractorExecutionPolicy {
  const maxProviderCalls = overrides.maxProviderCalls ?? 15;
  const recoveryMaxProviderCalls = overrides.recoveryMaxProviderCalls
    ?? Math.min(1, Math.max(0, maxProviderCalls - 1));
  const verifierMaxProviderCalls = overrides.verifierMaxProviderCalls
    ?? Math.min(3, Math.max(0, maxProviderCalls - recoveryMaxProviderCalls - 1));
  return {
    targetInputTokensPerWindow: 1_000,
    maxInputTokensPerWindow: 1_500,
    maxRecoverySplitDepth: 1,
    maxProviderCalls,
    extractorMaxProviderCalls: overrides.extractorMaxProviderCalls
      ?? maxProviderCalls - verifierMaxProviderCalls - recoveryMaxProviderCalls,
    verifierMaxProviderCalls,
    recoveryMaxProviderCalls,
    analysisDeadlineMs: 15 * 60_000,
    ...overrides
  };
}

beforeEach(() => {
  database = openWorkReviewDatabase({ filePath: ":memory:" });
  repository = new WorkReviewRepository(database, {
    now: () => "2026-09-01T10:00:00.000Z",
    idFactory: (() => {
      let value = 0;
      return () => `orchestrator_${++value}`;
    })()
  });
});

afterEach(() => database.close());

function seedSourceAudio() {
  const meeting = repository.reserveMeeting({
    accountId: "account_a",
    idempotencyKey: "orchestrator_upload",
    operationKey: "orchestrator_upload",
    contentHash: "a".repeat(64),
    meetingId: "meeting_orchestrator",
    sourceUploadId: "source_orchestrator",
    title: "失败恢复验证会议",
    meetingDate: "2026-09-01"
  }).meeting;
  repository.publishSourceUpload({
    accountId: "account_a",
    meetingId: meeting.id,
    uploadId: meeting.sourceUploadId,
    originalName: "meeting.wav",
    mimeType: "audio/wav",
    sizeBytes: 1_024,
    recordingDate: "2026-09-01",
    filePath: "C:\\test-data\\account_a\\uploads\\source_orchestrator.wav",
    contentHash: "a".repeat(64)
  });
  return meeting;
}

function extractedDiscussion(segmentId: string): WorkExtractorCandidateDraft {
  return {
    clientCandidateKey: "candidate_1",
    kind: "discussion_topic",
    title: "项目进度",
    body: "会议讨论了项目进度。",
    structuredData: {
      decisionFinality: null,
      rawActorLabel: null,
      candidateOwner: null,
      dueAt: null,
      originalDueExpression: null,
      actionBasis: null,
      relatedCommitmentCandidateId: null,
      planStages: []
    },
    evidenceIds: [segmentId],
    claims: [{
      clientClaimKey: "claim_1",
      claimType: "topic",
      semanticRiskFlags: [],
      text: "会议讨论了项目进度",
      evidenceIds: [segmentId]
    }]
  };
}

function extractedDecision(segmentId: string): WorkExtractorCandidateDraft {
  const discussion = extractedDiscussion(segmentId);
  return {
    ...discussion,
    kind: "decision",
    title: "项目按当前计划推进",
    body: "会议明确决定按当前计划推进。",
    structuredData: {
      ...discussion.structuredData,
      decisionFinality: "final"
    },
    claims: [{
      ...discussion.claims[0],
      claimType: "decision_existence",
      text: "会议决定按当前计划推进"
    }]
  };
}

describe("processWorkMeeting", () => {
  it.each([false, true])("keeps affordable cores reviewable when optional attributes exceed three verifier batches (optional request fails: %s)", async optionalFails => {
    const meeting = seedSourceAudio();
    const drafts = Array.from({ length: 20 }, (_, i) => {
      const draft = extractedDiscussion("segment_0");
      draft.clientCandidateKey = `delivery_${i}`;
      draft.kind = "commitment";
      draft.title = draft.body = `完成独立交付 ${i}`;
      draft.structuredData.candidateOwner = `参与者${i}`;
      draft.structuredData.rawActorLabel = "speaker_1";
      draft.structuredData.originalDueExpression = "周五";
      draft.claims = [
        { clientClaimKey: `core_${i}`, claimType: "commitment_existence", text: draft.title, evidenceIds: ["segment_0"] },
        { clientClaimKey: `owner_${i}`, claimType: "commitment_owner", text: `参与者${i}认领`, evidenceIds: ["segment_0"],
          semanticValue: { kind: "commitment_owner", value: `参与者${i}` } },
        { clientClaimKey: `due_${i}`, claimType: "deadline", text: "周五完成", evidenceIds: ["segment_0"],
          semanticValue: { kind: "deadline", dueAt: null, originalDueExpression: "周五" } },
        { clientClaimKey: `speaker_${i}`, claimType: "speaker_attribution", text: "speaker_1 发言", evidenceIds: ["segment_0"],
          semanticValue: { kind: "speaker_attribution", value: "speaker_1" } }
      ];
      return draft;
    });
    const profile = { profileId: "fixture", provider: "fixture" as const, model: "fixture", reasoningEffort: "none" as const,
      timeoutMs: 1000, maxOutputTokens: 6000, promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
      schemaVersion: WORK_MEETING_EXTRACTOR_SCHEMA_VERSION };
    const verify = vi.fn<WorkMeetingVerifier["verify"]>(async ({ claims }) => {
      if (optionalFails && claims.every(c => c.claimType !== "commitment_existence")) {
        throw new WorkMeetingAnalysisProviderError("work_analysis_provider_timeout", "Fixture optional timeout");
      }
      return { items: claims.map(c => ({ claimId: c.id, supportVerdict: "entailed", issueCodes: [], supportedEvidenceIds: c.evidenceIds })), coverage: [] };
    });
    const result = await processWorkMeeting({ accountId: "account_a", meetingId: meeting.id, store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\uploads" }, { repository,
      transcriber: async () => [{ id: "segment_0", uploadId: meeting.sourceUploadId, startSeconds: 0, endSeconds: 4,
        speaker: "speaker_1", text: "逐一认领独立交付，周五完成。", confidence: 0.9, sceneLabels: [], valueLabels: [] }],
      probeDurationSeconds: async () => 5, cleanupRawAudio: async () => undefined,
      createAnalysisProviders: () => ({ extractor: { profile, extract: async () => drafts },
        verifier: { profile: { ...profile, promptVersion: WORK_MEETING_VERIFIER_PROMPT_VERSION,
          schemaVersion: WORK_MEETING_VERIFIER_SCHEMA_VERSION }, verify } }),
      resolveFeatureFlags: () => ({ enabled: true, uploadEnabled: true, analysisEnabled: true, verifierEnabled: true,
        todoEnabled: false, todoMeetingProjectionEnabled: false, followUpEnabled: false, recoveryEnabled: false }) });
    expect(repository.getMeetingDetail("account_a", meeting.id).meeting.errorCode).toBeNull();
    expect(result.analysisReady).toBe(true);
    const audit = repository.readAnalysisAudit("account_a", meeting.id)!;
    expect(audit.primaryIds).toHaveLength(20);
    expect(audit.evaluated.flatMap(c => c.claims)).toHaveLength(80);
    expect(verify).toHaveBeenCalledTimes(3);
    expect(verify.mock.calls.flatMap(([input]) => input.claims)).toHaveLength(72);
    const evaluated = audit.evaluated.flatMap(c => c.claims);
    expect(evaluated.filter(c => c.claimType === "commitment_existence").every(c => c.evaluation.supportVerdict === "entailed")).toBe(true);
    const skipped = evaluated.filter(c => c.evaluation.issueCodes.includes("verifier_capacity_not_checked"));
    expect(skipped).toHaveLength(8);
    expect(skipped.every(c => c.evaluation.supportVerdict === "unverifiable" && c.evaluation.supportedEvidenceIds.length === 0)).toBe(true);
    expect(skipped.every(c => c.evaluation.verifierProfile === "not_invoked_capacity"
      && !c.evaluation.issueCodes.includes("verifier_result_missing"))).toBe(true);
    for (const candidate of audit.evaluated) {
      const unverified = candidate.claims.filter(c => c.evaluation.issueCodes.includes("verifier_capacity_not_checked"));
      if (unverified.some(c => c.claimType === "commitment_owner")) expect(candidate.structuredData.candidateOwner).toBeNull();
      if (unverified.some(c => c.claimType === "deadline")) expect(candidate.structuredData.originalDueExpression).toBeNull();
      if (unverified.some(c => c.claimType === "speaker_attribution")) expect(candidate.structuredData.rawActorLabel).toBeNull();
    }
    expect(verify.mock.calls.flatMap(([input]) => input.claims).filter(c => c.claimType === "commitment_owner").length).toBeGreaterThan(0);
    const failed = evaluated.filter(c => c.evaluation.issueCodes.includes("verifier_optional_request_failed"));
    if (optionalFails) {
      expect(failed.length).toBeGreaterThan(0);
      expect(failed.every(c => c.evaluation.supportVerdict === "unverifiable" && c.evaluation.supportedEvidenceIds.length === 0)).toBe(true);
    } else expect(failed).toEqual([]);
    expect(repository.getMeetingDetail("account_a", meeting.id).findings).toEqual([]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it.each(["provider_empty", "all_discarded"] as const)("preserves a valid sibling window and persists %s diagnostics", async resultKind => {
    const meeting = seedSourceAudio();
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const source = ["PRIVATE_CANONICAL_TEXT" + "含糊原文".repeat(330), "决定按当前计划推进。" + "会议背景".repeat(330)]
        .map((text, i) => ({ id: `segment_${i}`, uploadId: meeting.sourceUploadId, startSeconds: i * 10,
          endSeconds: i * 10 + 9, speaker: "unknown", text, confidence: 0.9, sceneLabels: [], valueLabels: [] }));
      let calls = 0;
      const extractor = createStructuredWorkMeetingExtractor({ profile: { profileId: "fixture", provider: "openai-compatible-structured-json", model: "fixture",
        reasoningEffort: "none", timeoutMs: 1000, maxOutputTokens: 6000,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION, schemaVersion: WORK_MEETING_EXTRACTOR_SCHEMA_VERSION },
        requestStructuredJson: async () => ++calls === 1
          ? { items: resultKind === "provider_empty" ? [] : [{ kind: "decision", coreText: "PRIVATE_INVALID_TEXT" }] }
          : { items: [{ kind: "decision", coreText: "决定按当前计划推进", evidenceSegmentIds: ["segment_1"],
            decisionFinality: { value: "final", text: "最终决定", evidenceSegmentIds: ["segment_1"] } }] } });
      const verify = vi.fn<WorkMeetingVerifier["verify"]>(async ({ claims }) => ({ items: claims.map(c => ({
        claimId: c.id, supportVerdict: "entailed", issueCodes: [], supportedEvidenceIds: c.evidenceIds })), coverage: [] }));
      const result = await processWorkMeeting({ accountId: "account_a", meetingId: meeting.id,
        store: {} as JsonStore, uploadsRootDir: "C:\\test-data\\uploads" }, {
        repository, transcriber: async () => source, probeDurationSeconds: async () => 20,
        cleanupRawAudio: async () => undefined, resolveAnalysisConcurrency: () => 1,
        resolveExtractorExecutionPolicy: () => extractorExecutionPolicy(),
        createAnalysisProviders: () => ({ extractor, verifier: { profile: { ...extractor.profile,
          promptVersion: WORK_MEETING_VERIFIER_PROMPT_VERSION, schemaVersion: WORK_MEETING_VERIFIER_SCHEMA_VERSION }, verify } }),
        resolveFeatureFlags: () => ({ enabled: true, uploadEnabled: true, analysisEnabled: true, verifierEnabled: true,
          todoEnabled: false, todoMeetingProjectionEnabled: false, followUpEnabled: false, recoveryEnabled: false })
      });
      expect(result.analysisReady).toBe(true);
      expect(calls).toBe(2);
      expect(verify).toHaveBeenCalledTimes(1);
      const audit = repository.readAnalysisAudit("account_a", meeting.id)!;
      expect(audit.extraction).toHaveLength(2);
      expect(audit.extraction![0].validation).toMatchObject({ result: resultKind, retained: 0,
        returned: resultKind === "provider_empty" ? 0 : 1, discarded: resultKind === "provider_empty" ? 0 : 1 });
      expect(audit.extraction![1].validation).toMatchObject({ result: "retained", returned: 1, retained: 1, discarded: 0 });
      expect(audit.primaryIds).toHaveLength(1);
      expect(repository.getMeetingDetail("account_a", meeting.id).findings).toEqual([]);
      expect(() => repository.readAnalysisAudit("account_b", meeting.id)).toThrow();
      const logs = JSON.stringify(log.mock.calls);
      expect(logs).toContain(`extractor_validation=${resultKind}`);
      expect(logs).not.toContain("PRIVATE_CANONICAL_TEXT");
      expect(logs).not.toContain("PRIVATE_INVALID_TEXT");
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally { log.mockRestore(); }
  });

  it.each(["日", "号"])("publishes the supported core and source date with %s, without an invented year", async (daySuffix) => {
    const meeting = seedSourceAudio();
    const date = `9月11${daySuffix}前`;
    const texts = ["推荐首轮采用来源链接和分类确认。", "决定首轮采用来源链接和分类确认。",
      "也有人建议每日支持轮值，尚未批准。", `我认领埋点，${date}完成，涉及敏感内容则取消。`];
    const source = texts.map((text, index) => ({ id: `segment_${index}`, uploadId: meeting.sourceUploadId,
      startSeconds: index * 5, endSeconds: index * 5 + 4, text, speaker: "speaker_1",
      confidence: 0.9, sceneLabels: [], valueLabels: [] }));
    const extractor: WorkMeetingExtractor = {
      profile: { profileId: "fixture", provider: "fixture", model: "fixture", reasoningEffort: "provider_default",
        timeoutMs: 1000, maxOutputTokens: 6000, promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: WORK_MEETING_EXTRACTOR_SCHEMA_VERSION },
      async extract() {
        const accepted = extractedDecision("segment_1");
        accepted.title = "首轮采用来源链接和分类确认";
        accepted.evidenceIds = ["segment_0", "segment_1"];
        accepted.claims[0] = { ...accepted.claims[0], text: accepted.title, evidenceIds: accepted.evidenceIds };
        const proposal = extractedDecision("segment_2");
        proposal.clientCandidateKey = "proposal_wrongly_upgraded";
        proposal.title = "每日支持轮值已获批准";
        proposal.claims[0] = { ...proposal.claims[0], clientClaimKey: "proposal_claim", text: proposal.title };
        const commitment = extractedDiscussion("segment_3");
        commitment.clientCandidateKey = "commitment";
        commitment.kind = "commitment";
        commitment.title = "完成埋点，涉及敏感内容则取消";
        commitment.structuredData.dueAt = "2023-09-11T00:00:00.000Z";
        commitment.claims = [{ ...commitment.claims[0], clientClaimKey: "commitment_claim", claimType: "commitment_existence", text: commitment.title },
          { clientClaimKey: "deadline", claimType: "deadline", semanticRiskFlags: [],
            semanticValue: { kind: "deadline", dueAt: commitment.structuredData.dueAt, originalDueExpression: null },
            text: `${date}完成埋点`, evidenceIds: ["segment_3"] }];
        return [accepted, proposal, commitment];
      }
    };
    const verifier: WorkMeetingVerifier = {
      profile: { ...extractor.profile, promptVersion: WORK_MEETING_VERIFIER_PROMPT_VERSION,
        schemaVersion: WORK_MEETING_VERIFIER_SCHEMA_VERSION },
      async verify({ claims }) {
        expect(claims.some((claim) => claim.claimType === "deadline")).toBe(true);
        // Explicit fixture verdicts exercise publication, not model semantics.
        return { items: claims.map((claim) => ({ claimId: claim.id,
          supportVerdict: claim.text.includes("轮值") ? "unsupported" as const
            : claim.claimType === "deadline" ? "partially_entailed" as const : "entailed" as const,
          issueCodes: claim.text.includes("轮值") ? ["proposal_promoted_to_decision"] : [],
          supportedEvidenceIds: claim.text.includes("轮值") ? [] : claim.evidenceIds })), coverage: [] };
      }
    };
    const result = await processWorkMeeting({ accountId: "account_a", meetingId: meeting.id,
      store: {} as JsonStore, uploadsRootDir: "C:\\test-data\\uploads" }, {
      repository, transcriber: async () => source, probeDurationSeconds: async () => 20,
      cleanupRawAudio: async () => undefined, createAnalysisProviders: () => ({ extractor, verifier }),
      resolveFeatureFlags: () => ({ enabled: true, uploadEnabled: true, analysisEnabled: true,
        verifierEnabled: true, todoEnabled: false, todoMeetingProjectionEnabled: false,
        followUpEnabled: false, recoveryEnabled: false })
    });
    expect(result.analysisReady).toBe(true);
    const detail = repository.getMeetingDetail("account_a", meeting.id);
    expect(detail.candidates.find((candidate) => candidate.title.includes("来源链接"))?.status).toBe("pending_review");
    expect(detail.candidates.find((candidate) => candidate.title.includes("轮值"))?.status).toBe("invalidated");
    const kept = detail.candidates.find((candidate) => candidate.kind === "commitment");
    expect(kept).toMatchObject({ status: "pending_review",
      structuredData: { dueAt: null, originalDueExpression: date } });
    expect(JSON.stringify(kept)).not.toContain("2023");
    expect(detail.findings).toEqual([]);
    expect(detail.claims).toHaveLength(detail.evaluations.length);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(toWorkMeetingDetailView(detail).candidates.find((candidate) => candidate.kind === "commitment")?.structuredData)
      .toMatchObject({ dueAt: null, originalDueExpression: date });
  });

  it("falls back from an unrelated question group with every original still reviewable and audited", async () => {
    const meeting = seedSourceAudio();
    const texts = ["消息在何时发送仍待确认", "照片附件要留存几个月尚无结论", "下一版手机扫码适配边界尚未确定"];
    const source = texts.map((text, index) => ({ id: `segment_${index}`, uploadId: meeting.sourceUploadId,
      startSeconds: index * 5, endSeconds: index * 5 + 4, text, speaker: "unknown",
      confidence: 0.9, sceneLabels: [], valueLabels: [] }));
    const extractor: WorkMeetingExtractor = {
      profile: { profileId: "fixture", provider: "fixture", model: "fixture", reasoningEffort: "none",
        timeoutMs: 1000, maxOutputTokens: 6000, promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: WORK_MEETING_EXTRACTOR_SCHEMA_VERSION },
      async extract() {
        return source.map(segment => {
          const draft = extractedDecision(segment.id);
          return { ...draft, kind: "open_question" as const, clientCandidateKey: segment.id,
            title: segment.text, body: segment.text,
            structuredData: { ...draft.structuredData, decisionFinality: null },
            claims: [{ ...draft.claims[0], clientClaimKey: `claim_${segment.id}`, claimType: "open_question" as const, text: segment.text }] };
        });
      }
    };
    const verifier: WorkMeetingVerifier = {
      profile: { ...extractor.profile, promptVersion: WORK_MEETING_VERIFIER_PROMPT_VERSION,
        schemaVersion: WORK_MEETING_VERIFIER_SCHEMA_VERSION }, verify: vi.fn(async () => ({ items: [], coverage: [] }))
    };
    const deduplicator: WorkMeetingDeduplicator = {
      ...createWorkMeetingDeduplicator({ profile: verifier.profile }),
      deduplicate: vi.fn(async () => ({ groups: [{ items: [1, 2, 3] }] }))
    };
    const result = await processWorkMeeting({ accountId: "account_a", meetingId: meeting.id,
      store: {} as JsonStore, uploadsRootDir: "C:\\test-data\\uploads" }, {
      repository, transcriber: async () => source, probeDurationSeconds: async () => 20,
      cleanupRawAudio: async () => undefined, createAnalysisProviders: () => ({ extractor, verifier, deduplicator }),
      resolveFeatureFlags: () => ({ enabled: true, uploadEnabled: true, analysisEnabled: true,
        verifierEnabled: true, todoEnabled: false, todoMeetingProjectionEnabled: false,
        followUpEnabled: false, recoveryEnabled: false })
    });
    expect(result.analysisReady).toBe(true);
    expect(deduplicator.deduplicate).toHaveBeenCalledTimes(1);
    expect(verifier.verify).not.toHaveBeenCalled();
    const detail = repository.getMeetingDetail("account_a", meeting.id);
    expect(detail.candidates).toHaveLength(3);
    expect(detail.candidates.every(c => c.status === "pending_review")).toBe(true);
    expect(detail.candidates.map(c => c.title).sort()).toEqual([...texts].sort());
    expect(detail.findings).toEqual([]);
    const audit = repository.readAnalysisAudit("account_a", meeting.id)!;
    expect(audit.organization).toMatchObject({ state: "fallback", reason: "provider_or_plan_failure", skippedInvalidCount: 1 });
    expect(audit.fates).toHaveLength(3);
    expect(audit.fates.every(row => row.fate === "primary" && row.sourceCandidateId === row.resultCandidateId)).toBe(true);
    expect(audit.overflowIds).toEqual([]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it.each(["success", "display_notes", "mixed_plan", "global", "coverage_partial", "coverage_uncertain", "coverage_missing", "content_changed", "invalid_plan", "rejected_plan", "invalid_envelope", "error", "timeout", "budget", "deadline", "capacity", "deleted", "lease_lost"] as const)(
    "organizes all windows before verification with safe publication boundaries: %s", async (mode) => {
      const meeting = seedSourceAudio();
      const texts = ["关闭外部导出", "首轮禁用数据导出功能", "给全员开放"];
      if (mode === "capacity") texts.push("其他独立决定");
      if (mode === "global") texts.push(...Array.from("甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉")
        .map((character) => character.repeat(220)));
      let expectedWindows = 0;
      let completedWindows = 0;
      let verificationCompleted = false;
      const source = texts.map((text, index) => ({ id: `segment_${index}`, uploadId: meeting.sourceUploadId,
        startSeconds: index * 5, endSeconds: index * 5 + 4, text,
        ...(mode === "display_notes" ? { speaker: "Speaker 1" } : {}),
        confidence: 0.9, sceneLabels: [], valueLabels: [] }));
      if (mode === "capacity") source.push({ ...source[0], id: "extra_context", startSeconds: 25, endSeconds: 29, text: "上下文".repeat(4_500) });
      const extractor: WorkMeetingExtractor = {
        profile: { profileId: "fixture", provider: "fixture", model: "fixture", reasoningEffort: "provider_default",
          timeoutMs: 1000, maxOutputTokens: 6000, promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
          schemaVersion: WORK_MEETING_EXTRACTOR_SCHEMA_VERSION },
        async extract({ window }) {
          expectedWindows = window.count;
          const drafts = source.filter((segment) => segment.id !== "extra_context" && window.evidenceIds.includes(segment.id)).map((segment) => {
            const index = source.indexOf(segment);
            const draft = extractedDecision(segment.id);
            return { ...draft, clientCandidateKey: `candidate_${index}`, title: segment.text, body: segment.text,
              structuredData: { ...draft.structuredData, decisionFinality: mode === "content_changed" ? "final" as const : null },
              claims: [{ ...draft.claims[0], clientClaimKey: `claim_${index}`, text: segment.text }] };
          });
          completedWindows += 1;
          return drafts;
        }
      };
      const verifier: WorkMeetingVerifier = {
        profile: { ...extractor.profile, promptVersion: WORK_MEETING_VERIFIER_PROMPT_VERSION,
          schemaVersion: WORK_MEETING_VERIFIER_SCHEMA_VERSION },
        async verify({ claims, duplicateCoverage }) {
          expect(completedWindows).toBe(expectedWindows);
          verificationCompleted = true;
          if (mode === "capacity") expect(claims.some(claim => claim.evidenceIds.includes("extra_context"))).toBe(false);
          return { items: claims.map((claim) => ({ claimId: claim.id,
            supportVerdict: claim.text === texts[2] ? "contradicted" as const : "entailed" as const,
            issueCodes: claim.text === texts[2] ? ["proposal_promoted_to_decision"] : [],
            supportedEvidenceIds: claim.text === texts[2] ? [] : claim.evidenceIds })),
            coverage: (mode === "coverage_missing" ? [] : duplicateCoverage ?? []).map(r => ({ relationId: r.relationId,
              verdict: mode === "coverage_partial" ? "partial" as const : mode === "coverage_uncertain" ? "uncertain" as const : "complete" as const, reason: "evaluated" as const,
              supportedEvidenceIds: [...new Set([r.original, ...r.coveredBy].flatMap(c => c.evidenceIds))] })) };
        }
      };
      const lateResponse = deferred<unknown>();
      const deduplicate = vi.fn<WorkMeetingDeduplicator["deduplicate"]>(async ({ candidates }) => {
        expect(completedWindows).toBe(expectedWindows);
        expect(verificationCompleted).toBe(false);
        expect(candidates.map((candidate) => candidate.title)).toEqual(texts);
        if (mode === "global") {
          expect(expectedWindows).toBeGreaterThan(1);
          expect(candidates).toHaveLength(23);
          expect(candidates.at(-1)?.title).toBe(texts.at(-1));
        }
        if (mode === "error") throw new Error("PRIVATE_PROVIDER_ERROR_BODY");
        if (mode === "timeout") return lateResponse.promise;
        if (mode === "capacity") return { evidence: [1, 2, 3, 4].map(item => ({ item, evidenceSegmentIds: ["extra_context"] })) };
        if (mode === "invalid_plan") return { duplicates: [{ duplicateItem: 2, coveredByItems: [3] }] };
        if (mode === "rejected_plan") return { groups: [{ items: [1, 99] }] };
        if (mode === "invalid_envelope") return { duplicates: [], privateUnexpectedField: "PRIVATE_PROVIDER_ERROR_BODY" };
        if (mode === "mixed_plan") return { duplicates: [null,
          { duplicateItem: 99, coveredByItems: [3] }, { duplicateItem: 2, coveredByItems: [1] }] };
        if (mode === "deleted") repository.deleteMeeting({ accountId: "account_a", meetingId: meeting.id });
        if (mode === "lease_lost") vi.spyOn(repository, "renewProcessingLease").mockImplementationOnce(() => {
          throw new WorkReviewLeaseLostError();
        });
        return { duplicates: [{ duplicateItem: 2, coveredByItems: [1] }], priority: mode === "global" ? [23, 1] : [] };
      });
      const deduplicator: WorkMeetingDeduplicator = {
        ...createWorkMeetingDeduplicator({ profile: verifier.profile }),
        deduplicate
      };
      if (mode === "timeout") deduplicator.profile.timeoutMs = 15;
      const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const result = await processWorkMeeting({ accountId: "account_a", meetingId: meeting.id,
        store: {} as JsonStore, uploadsRootDir: "C:\\test-data\\uploads" }, {
        repository, transcriber: async () => source, probeDurationSeconds: async () => Math.max(20, source.length * 5),
        cleanupRawAudio: async () => undefined, createAnalysisProviders: () => ({ extractor, verifier, deduplicator }),
        resolveExtractorExecutionPolicy: () => extractorExecutionPolicy({
          ...(mode === "budget" ? { maxProviderCalls: 2, extractorMaxProviderCalls: 1, verifierMaxProviderCalls: 1 } : {}),
          ...(mode === "deadline" ? { analysisDeadlineMs: 4500 } : {}),
          ...(mode === "capacity" ? { targetInputTokensPerWindow: 20_000, maxInputTokensPerWindow: 30_000 } : {})
        }),
        resolveFeatureFlags: () => ({ enabled: true, uploadEnabled: true, analysisEnabled: true,
          verifierEnabled: true, todoEnabled: false, todoMeetingProjectionEnabled: false,
          followUpEnabled: false, recoveryEnabled: false })
      });
      expect(deduplicate).toHaveBeenCalledTimes(["budget", "deadline"].includes(mode) ? 0 : 1);
      expect(JSON.stringify(warnings.mock.calls)).not.toContain("PRIVATE_PROVIDER_ERROR_BODY");
      warnings.mockRestore();
      const count = () => (database.prepare("SELECT COUNT(*) AS n FROM wr_meeting_candidates").get() as { n: number }).n;
      if (mode === "deleted" || mode === "lease_lost") {
        expect(result.analysisReady).toBe(false);
        expect(count()).toBe(0);
      } else {
        expect(result.analysisReady).toBe(true);
        const detail = repository.getMeetingDetail("account_a", meeting.id);
        expect(detail.candidates.filter((candidate) => candidate.status === "pending_review"))
          .toHaveLength(mode === "global" ? 20 : mode === "capacity" ? 3 : ["success", "display_notes", "mixed_plan"].includes(mode) ? 1 : 2);
        if (mode === "global") {
          expect(detail.candidates.some((candidate) => candidate.title === texts[1])).toBe(false);
          expect(detail.candidates.some((candidate) => candidate.title === texts[22])).toBe(false);
          expect(detail.candidates.find((candidate) => candidate.title === texts[21])?.status).toBe("pending_review");
        }
        expect(detail.candidates.find((candidate) => candidate.title === texts[2])?.status).toBe("invalidated");
        expect(detail.claims).toHaveLength(detail.evaluations.length);
        expect(detail.findings).toEqual([]);
        const audit = repository.readAnalysisAudit("account_a", meeting.id)!;
        if (["success", "display_notes", "mixed_plan", "global"].includes(mode)) {
          expect(audit.duplicateDecisions).toMatchObject([{ applied: true, reason: "complete" }]);
          expect(audit.coverageEvaluations[0].verdict).toBe("complete");
        }
        if (mode === "display_notes") expect(audit.evaluated.filter(c => c.publicationAction !== "suppress")
          .every(c => c.body.endsWith("；发言归属待确认"))).toBe(true);
        if (mode === "global") expect(audit.ranking?.strategy).toBe("full_fallback");
        if (mode.startsWith("coverage_") || mode === "content_changed") {
          expect(audit.removed).toEqual([]);
          expect(audit.fates.filter(row => row.fate === "primary")).toHaveLength(2);
          expect(audit.duplicateDecisions[0]).toMatchObject({ applied: false,
            reason: mode === "content_changed" ? "content_changed" : mode === "coverage_partial" ? "partial" : "uncertain" });
          expect(audit.priorityIds).toHaveLength(2);
        }
        expect(audit.sources).toHaveLength(texts.length);
        expect(audit.fates).toHaveLength(texts.length);
        expect(audit.primaryIds).toHaveLength(mode === "global" ? 20 : mode === "capacity" ? 3 : ["success", "display_notes", "mixed_plan"].includes(mode) ? 1 : 2);
        if (mode === "capacity") expect(audit.organization).toMatchObject({ state: "fallback", reason: "verification_capacity" });
        if (mode === "rejected_plan") expect(audit.organization).toMatchObject({
          state: "fallback", reason: "provider_or_plan_failure", skippedInvalidCount: 1
        });
        expect(audit.overflowIds).toHaveLength(mode === "global" ? 1 : 0);
        expect(() => repository.readAnalysisAudit("other_account", meeting.id)).toThrow();
        expect(() => repository.listCandidates("other_account", meeting.id))
          .toThrowError(expect.objectContaining({ code: "work_review_not_found" }));
      }
      if (mode === "timeout") {
        const beforeLate = count();
        lateResponse.resolve({ duplicates: [{ duplicateItem: 2, coveredByItems: [1] }] });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(count()).toBe(beforeLate);
      }
      expect(database.pragma("foreign_key_check")).toEqual([]);
    }
  );

  it("publishes a valid sibling while an invalid rejection stays suppressed without its foreign Evidence", async () => {
    const meeting = seedSourceAudio();
    const source = [0, 1].map((index) => ({ id: `segment_${index}`, uploadId: meeting.sourceUploadId,
      startSeconds: index * 5, endSeconds: index * 5 + 4, text: `会议决定事项${index}`,
      speaker: "Speaker 1", confidence: 0.9, sceneLabels: [], valueLabels: [] }));
    const extractor: WorkMeetingExtractor = {
      profile: { profileId: "fixture", provider: "fixture", model: "fixture", reasoningEffort: "provider_default",
        timeoutMs: 1000, maxOutputTokens: 6000, promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: WORK_MEETING_EXTRACTOR_SCHEMA_VERSION },
      async extract() {
        return source.map((segment, index) => {
          const draft = extractedDecision(segment.id);
          const text = index === 0 ? "实施支持轮值" : "关闭外部导出";
          return {...draft, clientCandidateKey: `candidate_${index}`, title: text, body: text,
            claims: [{...draft.claims[0], clientClaimKey: `claim_${index}`, text}]};
        });
      }
    };
    const verifier: WorkMeetingVerifier = {
      profile: {...extractor.profile, promptVersion: WORK_MEETING_VERIFIER_PROMPT_VERSION,
        schemaVersion: WORK_MEETING_VERIFIER_SCHEMA_VERSION},
      async verify({claims}) {
        return { items: claims.map((claim) => claim.text === "实施支持轮值" ? {
          claimId: claim.id, supportVerdict: "contradicted" as const,
          issueCodes: ["proposal_promoted_to_decision"], supportedEvidenceIds: ["other_meeting_segment"]
        } : {claimId: claim.id, supportVerdict: "entailed" as const, issueCodes: [], supportedEvidenceIds: claim.evidenceIds}), coverage: [] };
      }
    };
    const result = await processWorkMeeting({accountId: "account_a", meetingId: meeting.id,
      store: {} as JsonStore, uploadsRootDir: "C:\\test-data\\uploads"}, {
      repository, transcriber: async () => source, probeDurationSeconds: async () => 20,
      cleanupRawAudio: async () => undefined, createAnalysisProviders: () => ({extractor, verifier}),
      resolveFeatureFlags: () => ({enabled: true, uploadEnabled: true, analysisEnabled: true,
        verifierEnabled: true, todoEnabled: false, todoMeetingProjectionEnabled: false,
        followUpEnabled: false, recoveryEnabled: false})
    });
    expect(result.analysisReady).toBe(true);
    const detail = repository.getMeetingDetail("account_a", meeting.id);
    expect(detail.candidates.find((candidate) => candidate.title === "实施支持轮值")?.status).toBe("invalidated");
    expect(detail.candidates.find((candidate) => candidate.title === "关闭外部导出")?.status).toBe("pending_review");
    expect(detail.claims).toHaveLength(detail.evaluations.length);
    expect(detail.evaluations.some((evaluation) => evaluation.issueCodes.includes("verifier_result_missing"))).toBe(true);
    expect(JSON.stringify(detail)).not.toContain("other_meeting_segment");
    expect(detail.findings).toEqual([]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it.each([true, false])("publishes question resolution only after evidence-bound verification resolves=%s", async (resolves) => {
    const meeting = seedSourceAudio();
    const texts = ["首轮提醒方式尚未确定", "首轮提醒方式决定只使用每日摘要", "值班人选需另行询问"];
    const source = texts.map((text, index) => ({ id: `segment_${index}`, uploadId: meeting.sourceUploadId,
      startSeconds: index, endSeconds: index + 1, text, speaker: `Speaker ${index}`,
      confidence: 0.9, sceneLabels: [], valueLabels: [] }));
    const extractor: WorkMeetingExtractor = {
      profile: { profileId: "fixture", provider: "fixture", model: "fixture", reasoningEffort: "provider_default",
        timeoutMs: 1000, maxOutputTokens: 6000, promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: WORK_MEETING_EXTRACTOR_SCHEMA_VERSION },
      async extract() {
        return texts.map((text, index) => {
          const base = extractedDiscussion(`segment_${index}`);
          return { ...base, clientCandidateKey: `candidate_${index}`, title: text,
            kind: index === 1 ? "decision" as const : "open_question" as const,
            claims: [{ ...base.claims[0], clientClaimKey: `claim_${index}`, text,
              claimType: index === 1 ? "decision_existence" as const : "open_question" as const }] };
        });
      }
    };
    let resolutionCount = 0;
    const verifier: WorkMeetingVerifier = {
      profile: { ...extractor.profile, promptVersion: WORK_MEETING_VERIFIER_PROMPT_VERSION,
        schemaVersion: WORK_MEETING_VERIFIER_SCHEMA_VERSION },
      async verify({ claims }) {
        return { items: claims.map((claim) => {
          const resolution = claim.claimType === "question_resolution";
          if (resolution) {
            resolutionCount += 1;
            expect(claim.evidenceIds).toEqual(["segment_0", "segment_1"]);
          }
          const supported = !resolution || resolves;
          return { claimId: claim.id, supportVerdict: supported ? "entailed" as const : "unsupported" as const,
            issueCodes: [], supportedEvidenceIds: supported ? claim.evidenceIds : [] };
        }), coverage: [] };
      }
    };
    const result = await processWorkMeeting({ accountId: "account_a", meetingId: meeting.id,
      store: {} as JsonStore, uploadsRootDir: "C:\\test-data\\uploads" }, {
      repository, transcriber: async () => source, probeDurationSeconds: async () => 20,
      cleanupRawAudio: async () => undefined, createAnalysisProviders: () => ({ extractor, verifier }),
      resolveFeatureFlags: () => ({ enabled: true, uploadEnabled: true, analysisEnabled: true,
        verifierEnabled: true, todoEnabled: false, todoMeetingProjectionEnabled: false,
        followUpEnabled: false, recoveryEnabled: false })
    });
    expect(result.analysisReady).toBe(true);
    expect(resolutionCount).toBe(1);
    const detail = repository.getMeetingDetail("account_a", meeting.id);
    expect(detail.candidates.find((candidate) => candidate.title === texts[0])?.status)
      .toBe(resolves ? "invalidated" : "pending_review");
    expect(detail.candidates.find((candidate) => candidate.title === texts[2])?.status).toBe("pending_review");
    expect(detail.findings).toEqual([]);
    expect(detail.claims).toHaveLength(detail.evaluations.length);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("applies the display cap after verification so rejected items cannot displace valid results", async () => {
    const meeting = seedSourceAudio();
    const topics = ["账单", "登录", "地图", "库存", "搜索", "密码", "审计", "文件", "邮件", "日历", "通知",
      "发票", "汇率", "采购", "设备", "路由", "索引", "回退", "培训", "名单", "指标", "权限"];
    const source = [0, 1].map((index) => ({ id: `segment_${index}`, uploadId: meeting.sourceUploadId,
      startSeconds: index * 10, endSeconds: index * 10 + 9, speaker: `Speaker ${index}`,
      text: "独立事项讨论。".repeat(180), confidence: 0.9, sceneLabels: [], valueLabels: [] }));
    const extractor: WorkMeetingExtractor = {
      profile: { profileId: "fixture", provider: "fixture", model: "fixture", reasoningEffort: "provider_default",
        timeoutMs: 1000, maxOutputTokens: 6000, promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: WORK_MEETING_EXTRACTOR_SCHEMA_VERSION },
      async extract({ window }) {
        return window.segments.flatMap((segment) => {
          const offset = segment.id === "segment_0" ? 0 : 11;
          return topics.slice(offset, offset + 11).map((topic, index) => {
            const base = extractedDecision(segment.id);
            return { ...base, clientCandidateKey: `candidate_${offset + index}`,
              title: topic, claims: [{ ...base.claims[0], clientClaimKey: `claim_${offset + index}`, text: topic }] };
          });
        });
      }
    };
    const verifiedTexts: string[] = [];
    const verifier: WorkMeetingVerifier = {
      profile: { ...extractor.profile, promptVersion: WORK_MEETING_VERIFIER_PROMPT_VERSION,
        schemaVersion: WORK_MEETING_VERIFIER_SCHEMA_VERSION },
      async verify({ claims }) {
        verifiedTexts.push(...claims.map((claim) => claim.text));
        return { items: claims.map((claim) => ({ claimId: claim.id,
          supportVerdict: claim.text === topics[0] ? "unsupported" as const : "entailed" as const,
          issueCodes: [], supportedEvidenceIds: claim.text === topics[0] ? [] : claim.evidenceIds })), coverage: [] };
      }
    };
    const result = await processWorkMeeting({ accountId: "account_a", meetingId: meeting.id,
      store: {} as JsonStore, uploadsRootDir: "C:\\test-data\\uploads" }, {
      repository, transcriber: async () => source, probeDurationSeconds: async () => 20,
      cleanupRawAudio: async () => undefined, createAnalysisProviders: () => ({ extractor, verifier }),
      resolveExtractorExecutionPolicy: () => extractorExecutionPolicy(),
      resolveFeatureFlags: () => ({ enabled: true, uploadEnabled: true, analysisEnabled: true,
        verifierEnabled: true, todoEnabled: false, todoMeetingProjectionEnabled: false,
        followUpEnabled: false, recoveryEnabled: false })
    });
    expect(result.analysisReady).toBe(true);
    expect(new Set(verifiedTexts).size).toBe(22);
    const detail = repository.getMeetingDetail("account_a", meeting.id);
    expect(detail.candidates.filter((candidate) => candidate.status === "pending_review")).toHaveLength(20);
    expect(detail.candidates.find((candidate) => candidate.title === topics[20])?.status).toBe("pending_review");
    expect(detail.candidates.find((candidate) => candidate.title === topics[0])?.status).toBe("invalidated");
    expect(detail.findings).toEqual([]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it.each([
    { target: undefined, maximum: undefined, expectedStarts: [0, 16, 32, 48, 64, 80, 96] },
    { target: "1200", maximum: "1500", expectedStarts: [0, 20, 40, 60, 80, 100] },
    { target: "4000", maximum: "6000", expectedStarts: [0, 72] },
    { target: "4000", maximum: "4000", expectedStarts: [0, 72] }
  ])("processes complete canonical coverage with window target=$target max=$maximum", async ({ target, maximum, expectedStarts }) => {
    const meeting = seedSourceAudio();
    const segments = Array.from({ length: 105 }, (_, index) => ({
      id: `segment_${index}`,
      uploadId: meeting.sourceUploadId,
      startSeconds: index,
      endSeconds: index + 1,
      speaker: `Speaker ${Math.floor(index / 2) % 3}`,
      text: "同步进展与相关事项。".repeat(4),
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: []
    }));
    const windows: Parameters<WorkMeetingExtractor["extract"]>[0]["window"][] = [];
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      async extract({ window }) {
        windows.push(window);
        return [];
      }
    };
    const policy = resolveWorkReviewExtractorExecutionPolicy({
      WORK_REVIEW_TARGET_INPUT_TOKENS_PER_WINDOW: target,
      WORK_REVIEW_MAX_INPUT_TOKENS_PER_WINDOW: maximum
    });
    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 105),
      transcriber: vi.fn(async () => segments),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveExtractorExecutionPolicy: () => policy,
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: true, busy: false });
    expect(repository.getMeetingDetail("account_a", meeting.id).meeting).toMatchObject({
      analysisStatus: "review_ready",
      errorCode: null
    });
    expect(windows.map((window) => window.evidenceIds[0])).toEqual(
      expectedStarts.map((index) => `segment_${index}`)
    );
    expect([...new Set(windows.flatMap((window) => window.evidenceIds))])
      .toEqual(segments.map((segment) => segment.id));
    expect(windows.every((window) => window.estimatedInputTokens <= policy.maxInputTokensPerWindow)).toBe(true);
    expect(windows.every((window) => window.segments.length <= 96)).toBe(true);
    const sourceById = new Map(segments.map((segment) => [segment.id, segment]));
    for (const [index, window] of windows.entries()) {
      expect(new Set(window.evidenceIds).size).toBe(window.segments.length);
      expect(window.segments).toEqual(window.evidenceIds.map((id) => sourceById.get(id)));
      if (index === 0) continue;
      const prior = windows[index - 1]!;
      const overlap = window.evidenceIds.filter((id) => prior.evidenceIds.includes(id));
      expect(overlap).toHaveLength(2);
      expect(overlap.length).toBeLessThanOrEqual(8);
      expect(overlap).toEqual(prior.evidenceIds.slice(-overlap.length));
      expect(overlap).toEqual(window.evidenceIds.slice(0, overlap.length));
    }
  });

  it("keeps bounded concurrent analysis results in source order", async () => {
    let active = 0;
    let maxActive = 0;
    const release = Array.from({ length: 4 }, () => deferred());
    const started: number[] = [];
    const execution = mapWorkAnalysisWithConcurrency({
      items: [0, 1, 2, 3],
      concurrency: 2,
      worker: async (item) => {
        started.push(item);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await release[item].promise;
        active -= 1;
        return `result_${item}`;
      }
    });

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    release[1].resolve();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    release[0].resolve();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    release[3].resolve();
    release[2].resolve();

    await expect(execution).resolves.toEqual([
      "result_0", "result_1", "result_2", "result_3"
    ]);
    expect(maxActive).toBe(2);
  });

  it("preserves the first failure, stops dispatch, and lets in-flight siblings settle", async () => {
    const originalError = new Error("original_provider_failure");
    const siblingResult = deferred<string>();
    const started: number[] = [];
    const execution = mapWorkAnalysisWithConcurrency({
      items: [0, 1, 2, 3, 4],
      concurrency: 2,
      worker: async (item) => {
        started.push(item);
        if (item === 1) throw originalError;
        return siblingResult.promise;
      }
    });

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    siblingResult.resolve("checkpointed");
    await expect(execution).rejects.toBe(originalError);
    expect(started).toEqual([0, 1]);
  });

  it("does not split a timed-out Extractor window", async () => {
    const meeting = seedSourceAudio();
    const windowSizes: number[] = [];
    const progress: Array<{ completed: number; total: number; state: string }> = [];
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      async extract({ window }) {
        windowSizes.push(window.segments.length);
        if (window.segments.length > 4) {
          throw new WorkMeetingAnalysisProviderError(
            "work_analysis_provider_timeout",
            "Work Meeting analysis provider timed out"
          );
        }
        return [];
      }
    };
    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => Array.from({ length: 8 }, (_, index) => ({
        id: `segment_${index}`,
        uploadId: meeting.sourceUploadId,
        startSeconds: index,
        endSeconds: index + 1,
        speaker: "Speaker 1",
        text: `会议片段 ${index}`,
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }))),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveExtractorExecutionPolicy: () => extractorExecutionPolicy({
        maxProviderCalls: 8
      }),
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`,
      onProgress: (event) => {
        if (event.stage === "meeting_analysis") progress.push(event);
      }
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(windowSizes).toEqual([8]);
    expect(progress.at(-1)).toMatchObject({ completed: 0, total: 1, state: "failed" });
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: { analysisStatus: "failed", errorCode: "work_analysis_provider_timeout" },
      candidates: [],
      claims: []
    });
  });

  it("does not split an incomplete Extractor window", async () => {
    const meeting = seedSourceAudio();
    const windowSegmentIds: string[][] = [];
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      async extract({ window }) {
        windowSegmentIds.push(window.evidenceIds);
        if (window.segments.length > 1) {
          throw new WorkMeetingAnalysisProviderError(
            "work_analysis_provider_incomplete",
            "Work Meeting analysis provider returned an incomplete response"
          );
        }
        return [];
      }
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => Array.from({ length: 2 }, (_, index) => ({
        id: `segment_${index}`,
        uploadId: meeting.sourceUploadId,
        startSeconds: index,
        endSeconds: index + 1,
        speaker: "Speaker 1",
        text: `会议片段 ${index}`,
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }))),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(windowSegmentIds).toEqual([["segment_0", "segment_1"]]);
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: {
        analysisStatus: "failed",
        errorCode: "work_analysis_provider_incomplete"
      },
      candidates: [],
      claims: [],
      evaluations: [],
      findings: []
    });
  });

  it("accepts exactly eight valid Extractor items without treating the cap as incomplete", async () => {
    const meeting = seedSourceAudio();
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      extract: vi.fn(async () => Array.from({ length: 8 }, (_, index) => {
        const candidate = extractedDiscussion(`segment_${index}`);
        return {
          ...candidate,
          clientCandidateKey: `candidate_${index}`,
          title: `独立议题 ${index}`,
          body: `会议讨论了独立议题 ${index}`,
          claims: [{
            ...candidate.claims[0],
            clientClaimKey: `claim_${index}`,
            text: `会议讨论了独立议题 ${index}`
          }]
        };
      }))
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => Array.from({ length: 8 }, (_, index) => ({
        id: `segment_${index}`,
        uploadId: meeting.sourceUploadId,
        startSeconds: index,
        endSeconds: index + 1,
        speaker: "Speaker 1",
        text: `独立议题 ${index}`,
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }))),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: true, busy: false });
    expect(extractor.extract).toHaveBeenCalledTimes(1);
    expect(repository.getMeeting("account_a", meeting.id)).toMatchObject({
      analysisStatus: "review_ready",
      errorCode: null
    });
  });

  it("fails a timed-out unsplittable single-segment window without a leaf retry", async () => {
    const meeting = seedSourceAudio();
    let attempts = 0;
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      async extract() {
        attempts += 1;
        throw new WorkMeetingAnalysisProviderError(
          "work_analysis_provider_timeout",
          "Work Meeting analysis provider timed out"
        );
      }
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => [{
        id: "segment_0",
        uploadId: meeting.sourceUploadId,
        startSeconds: 0,
        endSeconds: 1,
        speaker: "Speaker 1",
        text: "会议片段 0",
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }]),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(attempts).toBe(1);
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: {
        analysisStatus: "failed",
        errorCode: "work_analysis_provider_timeout"
      },
      candidates: [],
      claims: []
    });
  });

  it("does not retry a persistently timed-out single-segment leaf", async () => {
    const meeting = seedSourceAudio();
    let attempts = 0;
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      async extract() {
        attempts += 1;
        throw new WorkMeetingAnalysisProviderError(
          "work_analysis_provider_timeout",
          "Work Meeting analysis provider timed out"
        );
      }
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => [{
        id: "segment_0",
        uploadId: meeting.sourceUploadId,
        startSeconds: 0,
        endSeconds: 1,
        speaker: "Speaker 1",
        text: "会议片段 0",
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }]),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(attempts).toBe(1);
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: {
        analysisStatus: "failed",
        errorCode: "work_analysis_provider_timeout"
      },
      candidates: [],
      claims: []
    });
  });

  it.each([
    {
      label: "a transient provider failure",
      code: "work_analysis_provider_transient_unavailable" as const,
      expectedAttempts: 2
    },
    {
      label: "a rate-limited provider failure",
      code: "work_analysis_provider_rate_limited" as const,
      expectedAttempts: 2
    },
    {
      label: "invalid JSON",
      code: "work_analysis_provider_invalid_json" as const,
      expectedAttempts: 2
    },
    {
      label: "a persistent Evidence contract violation",
      code: "work_evidence_not_allowed" as const,
      expectedAttempts: 1
    },
    {
      label: "a rejected provider request",
      code: "work_analysis_provider_request_rejected" as const,
      expectedAttempts: 1
    }
  ])("bounds $label without splitting the transcript window", async ({ code, expectedAttempts }) => {
    const meeting = seedSourceAudio();
    const windowSizes: number[] = [];
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      async extract({ window }) {
        windowSizes.push(window.segments.length);
        throw new WorkMeetingAnalysisProviderError(code, "safe test provider failure");
      }
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => Array.from({ length: 8 }, (_, index) => ({
        id: `segment_${index}`,
        uploadId: meeting.sourceUploadId,
        startSeconds: index,
        endSeconds: index + 1,
        speaker: "Speaker 1",
        text: `会议片段 ${index}`,
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }))),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(windowSizes).toEqual(Array.from({ length: expectedAttempts }, () => 8));
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: { analysisStatus: "failed", errorCode: code },
      candidates: [],
      claims: [],
      evaluations: [],
      findings: []
    });
    expect((database.prepare("SELECT COUNT(*) AS count FROM wr_todos").get() as { count: number }).count)
      .toBe(0);
  });

  it("does not repair parseable JSON with an invalid Extractor schema", async () => {
    const meeting = seedSourceAudio();
    const repairs: Array<Parameters<WorkMeetingExtractor["extract"]>[0]["schemaRepair"]> = [];
    let attempts = 0;
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      async extract({ schemaRepair }) {
        attempts += 1;
        repairs.push(schemaRepair);
        if (attempts === 1) {
          throw new WorkMeetingAnalysisProviderError(
            "work_extractor_output_invalid",
            "Work Meeting analysis provider returned an invalid schema",
            undefined,
            {
              responseTextLength: 100,
              parseResult: "success",
              validationResult: "failed",
              validationIssueCount: 2,
              validationIssues: [{
                path: "items[3].claims[0].claimType",
                code: "custom"
              }, {
                path: "items[4].claims",
                code: "missing_field"
              }],
              validationIssuesTruncated: false
            }
          );
        }
        return [];
      }
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => Array.from({ length: 8 }, (_, index) => ({
        id: `segment_${index}`,
        uploadId: meeting.sourceUploadId,
        startSeconds: index,
        endSeconds: index + 1,
        speaker: "Speaker 1",
        text: `会议片段 ${index}`,
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }))),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveExtractorExecutionPolicy: () => extractorExecutionPolicy(),
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(repairs).toEqual([undefined]);
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: { analysisStatus: "failed", errorCode: "work_extractor_output_invalid" },
      candidates: [],
      claims: []
    });
  });

  it("does not repair or split a parseable schema-invalid window", async () => {
    const meeting = seedSourceAudio();
    const attempts: Array<{ segmentCount: number; hasRepair: boolean }> = [];
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      async extract({ window, schemaRepair }) {
        attempts.push({ segmentCount: window.segments.length, hasRepair: schemaRepair !== undefined });
        if (window.segments.length === 8) {
          throw new WorkMeetingAnalysisProviderError(
            "work_extractor_output_invalid",
            "Work Meeting analysis provider returned an invalid schema",
            undefined,
            {
              responseTextLength: 100,
              parseResult: "success",
              validationResult: "failed",
              validationIssueCount: 1,
              validationIssues: [{ path: "items[0].claims", code: "missing_field" }],
              validationIssuesTruncated: false
            }
          );
        }
        return [];
      }
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => Array.from({ length: 8 }, (_, index) => ({
        id: `segment_${index}`,
        uploadId: meeting.sourceUploadId,
        startSeconds: index,
        endSeconds: index + 1,
        speaker: "Speaker 1",
        text: `会议片段 ${index}`,
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }))),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveExtractorExecutionPolicy: () => extractorExecutionPolicy(),
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(attempts).toEqual([{ segmentCount: 8, hasRepair: false }]);
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: { analysisStatus: "failed", errorCode: "work_extractor_output_invalid" },
      candidates: [],
      claims: [],
      evaluations: [],
      findings: []
    });
  });

  it("fails a schema-invalid single Segment without repair", async () => {
    const meeting = seedSourceAudio();
    const repairStates: boolean[] = [];
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      async extract({ schemaRepair }) {
        repairStates.push(schemaRepair !== undefined);
        throw new WorkMeetingAnalysisProviderError(
          "work_extractor_output_invalid",
          "Work Meeting analysis provider returned an invalid schema",
          undefined,
          {
            responseTextLength: 10,
            parseResult: "success",
            validationResult: "failed",
            validationIssueCount: 1,
            validationIssues: [{ path: "items[0].claims", code: "missing_field" }],
            validationIssuesTruncated: false
          }
        );
      }
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => [{
        id: "segment_0",
        uploadId: meeting.sourceUploadId,
        startSeconds: 0,
        endSeconds: 1,
        speaker: "Speaker 1",
        text: "会议片段 0",
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }]),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveExtractorExecutionPolicy: () => extractorExecutionPolicy(),
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(repairStates).toEqual([false]);
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: {
        analysisStatus: "failed",
        errorCode: "work_extractor_output_invalid"
      },
      candidates: [],
      claims: [],
      evaluations: [],
      findings: []
    });
  });

  it("does not spend recovery budget on a parseable schema-invalid response", async () => {
    const meeting = seedSourceAudio();
    const attemptedWindowSizes: number[] = [];
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      async extract({ window }) {
        attemptedWindowSizes.push(window.segments.length);
        if (window.segments.length === 8) {
          throw new WorkMeetingAnalysisProviderError(
            "work_extractor_output_invalid",
            "Work Meeting analysis provider returned an invalid schema"
          );
        }
        return [extractedDiscussion(window.evidenceIds[0])];
      }
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => Array.from({ length: 8 }, (_, index) => ({
        id: `segment_${index}`,
        uploadId: meeting.sourceUploadId,
        startSeconds: index,
        endSeconds: index + 1,
        speaker: "Speaker 1",
        text: `会议片段 ${index}`,
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }))),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveExtractorExecutionPolicy: () => extractorExecutionPolicy({
        maxProviderCalls: 3
      }),
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(attemptedWindowSizes).toEqual([8]);
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: {
        analysisStatus: "failed",
        errorCode: "work_extractor_output_invalid"
      },
      candidates: [],
      claims: [],
      evaluations: [],
      findings: []
    });
  });

  it("repairs invalid JSON once but does not split a subsequent timeout", async () => {
    const meeting = seedSourceAudio();
    const attemptedWindows: string[][] = [];
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      async extract({ window }) {
        attemptedWindows.push(window.evidenceIds);
        if (attemptedWindows.length === 1) {
          throw new WorkMeetingAnalysisProviderError(
            "work_analysis_provider_invalid_json",
            "Work Meeting analysis provider returned invalid JSON"
          );
        }
        if (attemptedWindows.length === 2) {
          throw new WorkMeetingAnalysisProviderError(
            "work_analysis_provider_timeout",
            "Work Meeting analysis provider timed out"
          );
        }
        return [];
      }
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => Array.from({ length: 3 }, (_, index) => ({
        id: `segment_${index}`,
        uploadId: meeting.sourceUploadId,
        startSeconds: index,
        endSeconds: index + 1,
        speaker: "Speaker 1",
        text: `会议片段 ${index}`,
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }))),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveExtractorExecutionPolicy: () => extractorExecutionPolicy(),
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(attemptedWindows).toEqual([
      ["segment_0", "segment_1", "segment_2"],
      ["segment_0", "segment_1", "segment_2"]
    ]);
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: { analysisStatus: "failed", errorCode: "work_analysis_provider_timeout" },
      candidates: [],
      claims: []
    });
  });

  it("fails closed without regenerating an Evidence-invalid extractor response", async () => {
    const meeting = seedSourceAudio();
    const windowSegmentIds: string[][] = [];
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      async extract({ window }) {
        windowSegmentIds.push(window.segments.map((segment) => segment.id));
        if (windowSegmentIds.length === 1) {
          throw new WorkMeetingAnalysisProviderError(
            "work_evidence_not_allowed",
            "Extractor Evidence is outside the canonical window"
          );
        }
        return [];
      }
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => [{
        id: "segment_0",
        uploadId: meeting.sourceUploadId,
        startSeconds: 0,
        endSeconds: 1,
        speaker: "Speaker 1",
        text: "会议片段 0",
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }]),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(windowSegmentIds).toEqual([["segment_0"]]);
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: { analysisStatus: "failed", errorCode: "work_evidence_not_allowed" },
      candidates: [],
      claims: []
    });
  });

  it("fails closed at the global Provider call budget across multiple token windows", async () => {
    const meeting = seedSourceAudio();
    const windowSizes: number[] = [];
    const windowCounts: number[] = [];
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      async extract({ window }) {
        windowSizes.push(window.segments.length);
        windowCounts.push(window.count);
        return [extractedDiscussion(window.evidenceIds[0])];
      }
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => Array.from({ length: 4 }, (_, index) => ({
        id: `segment_${index}`,
        uploadId: meeting.sourceUploadId,
        startSeconds: index,
        endSeconds: index + 1,
        speaker: "Speaker 1",
        text: `会议片段 ${index} ${"中".repeat(500)}`,
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }))),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveExtractorExecutionPolicy: () => extractorExecutionPolicy({
        maxProviderCalls: 1
      }),
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(windowCounts[0]).toBeGreaterThan(1);
    expect(windowSizes).toEqual([2]);
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: {
        analysisStatus: "failed",
        errorCode: "work_analysis_call_budget_exhausted"
      },
      candidates: [],
      claims: [],
      evaluations: [],
      findings: []
    });
    expect((database.prepare("SELECT COUNT(*) AS count FROM wr_todos").get() as { count: number }).count)
      .toBe(0);
  });

  it.each([false, true])("reuses Extractor checkpoints only for the same provider contract (provider changed: %s)", async (providerChanged) => {
    const meeting = seedSourceAudio();
    const extractorCallWindows: string[][] = [];
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      extract: vi.fn(async ({ window, onItemsValidated }) => {
        extractorCallWindows.push([...window.evidenceIds]);
        if (extractorCallWindows.length === 2) {
          throw new WorkMeetingAnalysisProviderError(
            "work_analysis_provider_request_rejected",
            "Extractor request was rejected"
          );
        }
        onItemsValidated?.({ returned: 0, retained: 0, discarded: 0, result: "provider_empty", reasons: {} });
        return [];
      })
    };
    const request = {
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    };
    const dependencies = {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => Array.from({ length: 4 }, (_, index) => ({
        id: `segment_${index}`,
        uploadId: meeting.sourceUploadId,
        startSeconds: index,
        endSeconds: index + 1,
        speaker: "Speaker 1",
        text: `会议片段 ${index} ${"中".repeat(500)}`,
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }))),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveExtractorExecutionPolicy: () => extractorExecutionPolicy(),
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    } satisfies Parameters<typeof processWorkMeeting>[1];

    const firstResult = await processWorkMeeting(request, dependencies);

    expect(firstResult).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(extractor.extract).toHaveBeenCalledTimes(2);
    expect(extractorCallWindows).toHaveLength(2);
    const completedWindow = JSON.stringify(extractorCallWindows[0]);
    const unfinishedWindow = JSON.stringify(extractorCallWindows[1]);
    expect(completedWindow).not.toBe(unfinishedWindow);
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: {
        analysisStatus: "failed",
        errorCode: "work_analysis_provider_request_rejected"
      },
      candidates: [],
      claims: [],
      evaluations: [],
      findings: []
    });
    expect(database.prepare(`
      SELECT checkpoint_kind, COUNT(*) AS count
      FROM wr_analysis_checkpoints
      GROUP BY checkpoint_kind
    `).all()).toEqual([{ checkpoint_kind: "extractor_block", count: 1 }]);
    const saved = database.prepare("SELECT payload_json FROM wr_analysis_checkpoints WHERE checkpoint_kind = 'extractor_block'")
      .get() as { payload_json: string };
    expect(JSON.parse(saved.payload_json).groups[0].validation).toMatchObject({ result: "provider_empty", returned: 0 });

    // Model, prompt and schema stay identical: changing just the provider must
    // invalidate the old checkpoint instead of reusing a different route's work.
    const resumedExtractor: WorkMeetingExtractor = providerChanged
      ? { ...extractor, profile: { ...extractor.profile, provider: "deepseek-structured-json" } }
      : extractor;
    const secondResult = await processWorkMeeting(request, {
      ...dependencies, createAnalysisProviders: () => ({ extractor: resumedExtractor })
    });

    expect(secondResult).toMatchObject({ transcriptReady: true, analysisReady: true, busy: false });
    expect(repository.readAnalysisAudit("account_a", meeting.id)!.extraction!.map(block => block.validation?.result))
      .toEqual(["provider_empty", "provider_empty"]);
    expect(extractor.extract).toHaveBeenCalledTimes(providerChanged ? 4 : 3);
    expect(extractorCallWindows.map((ids) => JSON.stringify(ids)).filter((ids) => ids === completedWindow))
      .toHaveLength(providerChanged ? 2 : 1);
    expect(extractorCallWindows.map((ids) => JSON.stringify(ids)).filter((ids) => ids === unfinishedWindow))
      .toHaveLength(2);
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: { analysisStatus: "review_ready", errorCode: null },
      candidates: [],
      claims: [],
      evaluations: [],
      findings: []
    });
    expect((database.prepare("SELECT COUNT(*) AS count FROM wr_analysis_checkpoints").get() as { count: number }).count)
      .toBe(0);
  });

  it("reuses a legacy recovery child checkpoint and runs only its missing sibling", async () => {
    const meeting = seedSourceAudio();
    const extractorCallWindows: string[][] = [];
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      extract: vi.fn(async ({ window }) => {
        extractorCallWindows.push([...window.evidenceIds]);
        return [];
      })
    };
    const originalReadCheckpoint = repository.readAnalysisCheckpoint.bind(repository);
    let checkpointMissOrdinal = 0;
    vi.spyOn(repository, "readAnalysisCheckpoint").mockImplementation((input) => {
      const persisted = originalReadCheckpoint(input);
      if (persisted) return persisted;
      checkpointMissOrdinal += 1;
      // Read order is parent block, first legacy leaf, second legacy leaf.
      if (checkpointMissOrdinal !== 2) return null;
      return {
        payload: {
          groups: [{
            evidenceIds: ["segment_0", "segment_1"],
            candidates: []
          }]
        }
      } as ReturnType<WorkReviewRepository["readAnalysisCheckpoint"]>;
    });

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => Array.from({ length: 4 }, (_, index) => ({
        id: `segment_${index}`,
        uploadId: meeting.sourceUploadId,
        startSeconds: index,
        endSeconds: index + 1,
        speaker: "Speaker 1",
        text: `会议片段 ${index}`,
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }))),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveExtractorExecutionPolicy: () => extractorExecutionPolicy({
        maxRecoverySplitDepth: 1
      }),
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage: "transcription" | "meeting_analysis") => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: true, busy: false });
    expect(extractorCallWindows).toEqual([["segment_2", "segment_3"]]);
    expect((database.prepare("SELECT COUNT(*) AS count FROM wr_analysis_checkpoints").get() as { count: number }).count)
      .toBe(0);
  });

  it.each([
    {
      name: "malformed output",
      output: [{ nonsense: true }] as unknown as WorkExtractorCandidateDraft[],
      errorCode: "work_extractor_output_invalid"
    },
    {
      name: "out-of-window Evidence",
      output: [extractedDiscussion("segment_outside")],
      errorCode: "work_evidence_not_allowed"
    }
  ])("revalidates injected Extractor $name before checkpointing or publication", async ({
    output,
    errorCode: expectedErrorCode
  }) => {
    const meeting = seedSourceAudio();
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      extract: vi.fn(async () => output)
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => [{
        id: "segment_0",
        uploadId: meeting.sourceUploadId,
        startSeconds: 0,
        endSeconds: 1,
        speaker: "Speaker 1",
        text: "会议讨论了项目进度。",
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }]),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveExtractorExecutionPolicy: () => extractorExecutionPolicy(),
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: { analysisStatus: "failed", errorCode: expectedErrorCode },
      candidates: [],
      claims: [],
      evaluations: [],
      findings: []
    });
    expect((database.prepare("SELECT COUNT(*) AS count FROM wr_analysis_checkpoints").get() as { count: number }).count)
      .toBe(0);
  });

  it("fails fast when an injected Provider profile does not match the active contract", async () => {
    const meeting = seedSourceAudio();
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-stale-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: "work_meeting_extractor_stale",
        schemaVersion: "work_meeting_candidates_v7"
      },
      extract: vi.fn(async () => [])
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => [{
        id: "segment_0",
        uploadId: meeting.sourceUploadId,
        startSeconds: 0,
        endSeconds: 1,
        speaker: "Speaker 1",
        text: "会议讨论了项目进度。",
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }]),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(extractor.extract).not.toHaveBeenCalled();
    expect(repository.getMeeting("account_a", meeting.id)).toMatchObject({
      analysisStatus: "failed",
      errorCode: "work_analysis_provider_contract_mismatch"
    });
    expect((database.prepare("SELECT COUNT(*) AS count FROM wr_analysis_checkpoints").get() as { count: number }).count)
      .toBe(0);
  });

  it("applies the global Provider call budget to Verifier calls", async () => {
    const meeting = seedSourceAudio();
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      extract: vi.fn(async () => [extractedDecision("segment_0")])
    };
    const verifier: WorkMeetingVerifier = {
      profile: {
        ...extractor.profile,
        profileId: "work-meeting-verifier-test",
        promptVersion: WORK_MEETING_VERIFIER_PROMPT_VERSION,
        schemaVersion: "work_meeting_claim_evaluations_v3"
      },
      verify: vi.fn(async ({ claims }: Parameters<WorkMeetingVerifier["verify"]>[0]) =>
        ({ items: claims.map((claim) => ({
          claimId: claim.id,
          supportVerdict: "entailed" as const,
          issueCodes: [],
          supportedEvidenceIds: [...claim.evidenceIds]
        })), coverage: [] }))
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => [{
        id: "segment_0",
        uploadId: meeting.sourceUploadId,
        startSeconds: 0,
        endSeconds: 1,
        speaker: "Speaker 1",
        text: "会议明确决定按当前计划推进。",
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }]),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveExtractorExecutionPolicy: () => extractorExecutionPolicy({ maxProviderCalls: 1 }),
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: true,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor, verifier }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(extractor.extract).toHaveBeenCalledTimes(1);
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: {
        analysisStatus: "failed",
        errorCode: "work_analysis_call_budget_exhausted"
      },
      candidates: [],
      claims: [],
      evaluations: [],
      findings: []
    });
    expect((database.prepare("SELECT COUNT(*) AS count FROM wr_todos").get() as { count: number }).count)
      .toBe(0);
  });

  it("rejects a late Verifier response that ignores AbortSignal after the global deadline", async () => {
    const meeting = seedSourceAudio();
    const lateVerifierResponse = deferred<Awaited<ReturnType<WorkMeetingVerifier["verify"]>>>();
    let capturedClaims: Parameters<WorkMeetingVerifier["verify"]>[0]["claims"] = [];
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      extract: vi.fn(async () => [extractedDecision("segment_0")])
    };
    const verifier: WorkMeetingVerifier = {
      profile: {
        ...extractor.profile,
        profileId: "work-meeting-verifier-test",
        promptVersion: WORK_MEETING_VERIFIER_PROMPT_VERSION,
        schemaVersion: "work_meeting_claim_evaluations_v3"
      },
      verify: vi.fn(async ({ claims }: Parameters<WorkMeetingVerifier["verify"]>[0]) => {
        capturedClaims = claims;
        // Deliberately ignores AbortSignal to model a non-cooperative Provider.
        return lateVerifierResponse.promise;
      })
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => [{
        id: "segment_0",
        uploadId: meeting.sourceUploadId,
        startSeconds: 0,
        endSeconds: 1,
        speaker: "Speaker 1",
        text: "会议明确决定按当前计划推进。",
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }]),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveExtractorExecutionPolicy: () => extractorExecutionPolicy({ analysisDeadlineMs: 50 }),
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: true,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor, verifier }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(extractor.extract).toHaveBeenCalledTimes(1);
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: {
        analysisStatus: "failed",
        errorCode: "work_analysis_deadline_exceeded"
      },
      candidates: [],
      claims: [],
      evaluations: [],
      findings: []
    });
    expect((database.prepare("SELECT COUNT(*) AS count FROM wr_todos").get() as { count: number }).count)
      .toBe(0);

    lateVerifierResponse.resolve({ items: capturedClaims.map((claim) => ({
      claimId: claim.id,
      supportVerdict: "entailed" as const,
      issueCodes: [],
      supportedEvidenceIds: [...claim.evidenceIds]
    })), coverage: [] });
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: {
        analysisStatus: "failed",
        errorCode: "work_analysis_deadline_exceeded"
      },
      candidates: [],
      claims: [],
      evaluations: [],
      findings: []
    });
    expect((database.prepare("SELECT COUNT(*) AS count FROM wr_todos").get() as { count: number }).count)
      .toBe(0);
  });

  it("aborts at the meeting Extractor deadline and publishes no partial analysis", async () => {
    const meeting = seedSourceAudio();
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      async extract({ signal }) {
        return new Promise<WorkExtractorCandidateDraft[]>((_resolve, reject) => {
          const abort = () => reject(signal?.reason ?? new Error("aborted"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      }
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => [{
        id: "segment_0",
        uploadId: meeting.sourceUploadId,
        startSeconds: 0,
        endSeconds: 1,
        speaker: "Speaker 1",
        text: "会议片段 0",
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }]),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveExtractorExecutionPolicy: () => extractorExecutionPolicy({ analysisDeadlineMs: 5 }),
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: {
        analysisStatus: "failed",
        errorCode: "work_analysis_deadline_exceeded"
      },
      candidates: [],
      claims: [],
      evaluations: [],
      findings: []
    });
    expect((database.prepare("SELECT COUNT(*) AS count FROM wr_todos").get() as { count: number }).count)
      .toBe(0);
  });

  it("rejects a late Extractor response that ignores AbortSignal after the meeting deadline", async () => {
    const meeting = seedSourceAudio();
    const lateResponse = deferred<WorkExtractorCandidateDraft[]>();
    let extractorCalls = 0;
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      async extract({ window }) {
        extractorCalls += 1;
        if (extractorCalls === 1) return [extractedDiscussion(window.evidenceIds[0])];
        // Deliberately ignores AbortSignal to model a non-cooperative Provider.
        return lateResponse.promise;
      }
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => Array.from({ length: 4 }, (_, index) => ({
        id: `segment_${index}`,
        uploadId: meeting.sourceUploadId,
        startSeconds: index,
        endSeconds: index + 1,
        speaker: "Speaker 1",
        text: `会议片段 ${index} ${"中".repeat(500)}`,
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }))),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveExtractorExecutionPolicy: () => extractorExecutionPolicy({ analysisDeadlineMs: 50 }),
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(extractorCalls).toBe(2);
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: {
        analysisStatus: "failed",
        errorCode: "work_analysis_deadline_exceeded"
      },
      candidates: [],
      claims: [],
      evaluations: [],
      findings: []
    });
    expect((database.prepare("SELECT COUNT(*) AS count FROM wr_todos").get() as { count: number }).count)
      .toBe(0);

    lateResponse.resolve([extractedDiscussion("segment_2")]);
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: {
        analysisStatus: "failed",
        errorCode: "work_analysis_deadline_exceeded"
      },
      candidates: [],
      claims: [],
      evaluations: [],
      findings: []
    });
    expect((database.prepare("SELECT COUNT(*) AS count FROM wr_todos").get() as { count: number }).count)
      .toBe(0);
  });

  it("fails closed without regenerating an Evidence-invalid verifier batch", async () => {
    const meeting = seedSourceAudio();
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      async extract() {
        return [extractedDecision("segment_0")];
      }
    };
    const verifierClaimIds: string[][] = [];
    const verifier: WorkMeetingVerifier = {
      profile: {
        ...extractor.profile,
        profileId: "work-meeting-verifier-test",
        promptVersion: WORK_MEETING_VERIFIER_PROMPT_VERSION,
        schemaVersion: "work_meeting_claim_evaluations_v3"
      },
      async verify({ claims }) {
        verifierClaimIds.push(claims.map((claim) => claim.id));
        if (verifierClaimIds.length === 1) {
          return { items: claims.map((claim) => ({
            claimId: claim.id,
            supportVerdict: "entailed" as const,
            issueCodes: [],
            supportedEvidenceIds: ["segment_outside_batch"]
          })), coverage: [] };
        }
        return { items: claims.map((claim) => ({
          claimId: claim.id,
          supportVerdict: "entailed" as const,
          issueCodes: [],
          supportedEvidenceIds: [...claim.evidenceIds]
        })), coverage: [] };
      }
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => [{
        id: "segment_0",
        uploadId: meeting.sourceUploadId,
        startSeconds: 0,
        endSeconds: 1,
        speaker: "Speaker 1",
        text: "会议讨论了项目进度。",
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }]),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: true,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor, verifier }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(verifierClaimIds).toHaveLength(1);
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: { analysisStatus: "failed", errorCode: "work_evidence_not_allowed" },
      candidates: [],
      claims: [],
      evaluations: []
    });
  });

  it("localizes a missing Verifier result to its high-risk Candidate", async () => {
    const meeting = seedSourceAudio();
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      async extract() {
        return [extractedDecision("segment_0")];
      }
    };
    const verifier: WorkMeetingVerifier = {
      profile: {
        ...extractor.profile,
        profileId: "work-meeting-verifier-test",
        promptVersion: WORK_MEETING_VERIFIER_PROMPT_VERSION,
        schemaVersion: "work_meeting_claim_evaluations_v3"
      },
      verify: vi.fn(async () => ({ items: [], coverage: [] }))
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => [{
        id: "segment_0",
        uploadId: meeting.sourceUploadId,
        startSeconds: 0,
        endSeconds: 1,
        speaker: "Speaker 1",
        text: "会议明确决定按当前计划推进。",
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }]),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: true,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor, verifier }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: true, busy: false });
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    const detail = repository.getMeetingDetail("account_a", meeting.id);
    expect(detail.meeting.analysisStatus).toBe("review_ready");
    expect(detail.candidates).toEqual([
      expect.objectContaining({ status: "invalidated", publicationAction: "suppress" })
    ]);
    expect(detail.evaluations).toEqual([
      expect.objectContaining({
        supportVerdict: "unverifiable",
        issueCodes: ["verifier_result_missing"],
        publicationAction: "suppress",
        supportedEvidenceIds: []
      })
    ]);
    expect(detail.findings).toEqual([]);
  });

  it("publishes non-high-risk Claims as pending review without calling the GPT Verifier", async () => {
    const meeting = seedSourceAudio();
    const discussion = extractedDiscussion("segment_0");
    const proposal: WorkExtractorCandidateDraft = {
      ...discussion,
      clientCandidateKey: "candidate_proposal",
      kind: "proposal",
      title: "建议调整同步频率",
      body: "会议提出调整同步频率。",
      claims: [{
        ...discussion.claims[0],
        clientClaimKey: "claim_proposal",
        claimType: "proposal",
        text: "有人建议调整同步频率"
      }]
    };
    const openQuestion: WorkExtractorCandidateDraft = {
      ...discussion,
      clientCandidateKey: "candidate_question",
      kind: "open_question",
      title: "同步频率尚未确定",
      body: "会议尚未确定同步频率。",
      claims: [{
        ...discussion.claims[0],
        clientClaimKey: "claim_question",
        claimType: "open_question",
        text: "同步频率尚未确定"
      }]
    };
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      extract: vi.fn(async () => [discussion, proposal, openQuestion])
    };
    const verifier: WorkMeetingVerifier = {
      profile: {
        ...extractor.profile,
        profileId: "work-meeting-verifier-test",
        promptVersion: WORK_MEETING_VERIFIER_PROMPT_VERSION,
        schemaVersion: "work_meeting_claim_evaluations_v3"
      },
      verify: vi.fn(async () => ({ items: [], coverage: [] }))
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => [{
        id: "segment_0",
        uploadId: meeting.sourceUploadId,
        startSeconds: 0,
        endSeconds: 1,
        speaker: "Speaker 1",
        text: "会议讨论了项目进度和同步频率。",
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }]),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: true,
        todoMeetingProjectionEnabled: true,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor, verifier }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: true, busy: false });
    expect(verifier.verify).not.toHaveBeenCalled();
    const detail = repository.getMeetingDetail("account_a", meeting.id);
    expect(detail.meeting.analysisStatus).toBe("review_ready");
    expect(detail.candidates).toHaveLength(3);
    expect(detail.candidates.every((candidate) =>
      candidate.status === "pending_review" && candidate.publicationAction === "show_as_question"
    )).toBe(true);
    expect(detail.evaluations).toHaveLength(3);
    expect(detail.evaluations.every((evaluation) =>
      evaluation.supportVerdict === "unverifiable"
      && evaluation.issueCodes.length === 1
      && evaluation.issueCodes[0] === WORK_MEETING_NON_GPT_ISSUE_CODE
      && evaluation.supportedEvidenceIds.length === 0
      && evaluation.verifierProfile === WORK_MEETING_NON_GPT_PROFILE
    )).toBe(true);
    expect(detail.findings).toEqual([]);
    expect((database.prepare("SELECT COUNT(*) AS count FROM wr_todos").get() as { count: number }).count)
      .toBe(0);
    expect(toWorkMeetingDetailView(detail).meeting.verifierMode).toBe("not_applicable");
  });

  it("keeps a mixed Candidate fail-closed when the GPT Verifier is disabled", async () => {
    const meeting = seedSourceAudio();
    const discussion = extractedDiscussion("segment_0");
    const mixedCandidate: WorkExtractorCandidateDraft = {
      ...discussion,
      structuredData: {
        ...discussion.structuredData,
        candidateOwner: "Alex"
      },
      claims: [
        discussion.claims[0]!,
        {
          clientClaimKey: "claim_owner",
          claimType: "commitment_owner",
          semanticRiskFlags: [],
          semanticValue: { kind: "commitment_owner", value: "Alex" },
          text: "Alex 是该事项负责人",
          evidenceIds: ["segment_0"]
        }
      ]
    };
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      extract: vi.fn(async () => [mixedCandidate])
    };
    const verifier: WorkMeetingVerifier = {
      profile: {
        ...extractor.profile,
        profileId: "work-meeting-verifier-test",
        promptVersion: WORK_MEETING_VERIFIER_PROMPT_VERSION,
        schemaVersion: "work_meeting_claim_evaluations_v3"
      },
      verify: vi.fn(async () => ({ items: [], coverage: [] }))
    };

    await expect(processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => [{
        id: "segment_0",
        uploadId: meeting.sourceUploadId,
        startSeconds: 0,
        endSeconds: 1,
        speaker: "Speaker 1",
        text: "会议讨论了项目进度。",
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }]),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: true,
        todoMeetingProjectionEnabled: true,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor, verifier }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    })).resolves.toMatchObject({ transcriptReady: true, analysisReady: true, busy: false });

    expect(verifier.verify).not.toHaveBeenCalled();
    const detail = repository.getMeetingDetail("account_a", meeting.id);
    expect(detail.candidates).toEqual([
      expect.objectContaining({ status: "pending_review", publicationAction: "show_as_question" })
    ]);
    expect(detail.evaluations).toHaveLength(2);
    const topicEvaluation = detail.evaluations.find((evaluation) =>
      evaluation.issueCodes.includes(WORK_MEETING_NON_GPT_ISSUE_CODE)
    );
    const ownerClaim = detail.claims.find((claim) => claim.claimType === "commitment_owner");
    const ownerEvaluation = detail.evaluations.find((evaluation) =>
      evaluation.claimId === ownerClaim?.id
    );
    expect(topicEvaluation).toMatchObject({
      supportVerdict: "unverifiable",
      verifierProfile: WORK_MEETING_NON_GPT_PROFILE
    });
    expect(ownerEvaluation).toMatchObject({
      supportVerdict: "unverifiable",
      verifierProfile: "verifier_disabled",
      verifierPromptVersion: "verifier_disabled",
      issueCodes: ["verifier_disabled"],
      publicationAction: "suppress"
    });
    expect(detail.findings).toEqual([]);
    expect((database.prepare("SELECT COUNT(*) AS count FROM wr_todos").get() as { count: number }).count)
      .toBe(0);
    const view = toWorkMeetingDetailView(detail);
    expect(view.meeting.verifierMode).toBe("disabled");
    expect(view.candidates).toHaveLength(1);
  });

  it("sends only high-risk Claims and their Evidence from a mixed Candidate to the GPT Verifier", async () => {
    const meeting = seedSourceAudio();
    const mixedCandidate: WorkExtractorCandidateDraft = {
      clientCandidateKey: "candidate_mixed",
      kind: "discussion_topic",
      title: "混合风险讨论",
      body: "会议同时包含普通讨论与需核验的责任、日期和因果表述。",
      structuredData: {
        decisionFinality: null,
        rawActorLabel: "Speaker 5",
        candidateOwner: "Speaker 2",
        dueAt: "2026-09-08T00:00:00.000Z",
        originalDueExpression: "下周二",
        actionBasis: null,
        relatedCommitmentCandidateId: null,
        planStages: []
      },
      evidenceIds: Array.from({ length: 10 }, (_, index) => `segment_${index}`),
      claims: [{
        clientClaimKey: "claim_topic",
        claimType: "topic",
        semanticRiskFlags: [],
        text: "会议讨论了同步节奏",
        evidenceIds: ["segment_0"]
      }, {
        clientClaimKey: "claim_decision",
        claimType: "decision_existence",
        semanticRiskFlags: [],
        text: "会议作出了继续推进的决定",
        evidenceIds: ["segment_1"]
      }, {
        clientClaimKey: "claim_commitment",
        claimType: "commitment_existence",
        semanticRiskFlags: [],
        text: "Speaker 3 明确承诺继续推进",
        evidenceIds: ["segment_2"]
      }, {
        clientClaimKey: "claim_action",
        claimType: "action_item",
        semanticRiskFlags: [],
        text: "需要整理推进清单",
        evidenceIds: ["segment_3"]
      }, {
        clientClaimKey: "claim_speaker",
        claimType: "speaker_attribution",
        semanticRiskFlags: [],
        semanticValue: { kind: "speaker_attribution", value: "Speaker 5" },
        text: "该表述来自 Speaker 5",
        evidenceIds: ["segment_4"]
      }, {
        clientClaimKey: "claim_owner",
        claimType: "commitment_owner",
        semanticRiskFlags: [],
        semanticValue: { kind: "commitment_owner", value: "Speaker 2" },
        text: "Speaker 2 是该事项的负责人",
        evidenceIds: ["segment_5"]
      }, {
        clientClaimKey: "claim_due",
        claimType: "deadline",
        semanticRiskFlags: [],
        semanticValue: {
          kind: "deadline",
          dueAt: "2026-09-08T00:00:00.000Z",
          originalDueExpression: "下周二"
        },
        text: "该事项截止到下周二",
        evidenceIds: ["segment_6"]
      }, {
        clientClaimKey: "claim_plan_change",
        claimType: "plan_change",
        semanticRiskFlags: [],
        text: "方案从 A 调整为 B",
        evidenceIds: ["segment_7"]
      }, {
        clientClaimKey: "claim_causality",
        claimType: "proposal",
        semanticRiskFlags: ["causality"],
        text: "延迟由依赖变更导致",
        evidenceIds: ["segment_8"]
      }, {
        clientClaimKey: "claim_question",
        claimType: "open_question",
        semanticRiskFlags: [],
        text: "同步频率仍待确认",
        evidenceIds: ["segment_9"]
      }]
    };
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      extract: vi.fn(async () => [mixedCandidate])
    };
    const verifierInputs: Array<{
      claims: Array<{
        claimId: string;
        claimType: string;
        semanticRiskFlags?: string[];
        semanticValue?: unknown;
      }>;
      segmentIds: string[];
    }> = [];
    const verifier: WorkMeetingVerifier = {
      profile: {
        ...extractor.profile,
        profileId: "work-meeting-verifier-test",
        promptVersion: WORK_MEETING_VERIFIER_PROMPT_VERSION,
        schemaVersion: "work_meeting_claim_evaluations_v3"
      },
      async verify({ claims, segments }) {
        verifierInputs.push({
          claims: claims.map((claim) => ({
            claimId: claim.id,
            claimType: claim.claimType,
            semanticRiskFlags: claim.semanticRiskFlags,
            semanticValue: claim.semanticValue
          })),
          segmentIds: (segments as Array<{ id: string }>).map((segment) => segment.id)
        });
        return { items: claims.map((claim) => ({
          claimId: claim.id,
          supportVerdict: "entailed" as const,
          issueCodes: [],
          supportedEvidenceIds: [...claim.evidenceIds]
        })), coverage: [] };
      }
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => Array.from({ length: 10 }, (_, index) => ({
        id: `segment_${index}`,
        uploadId: meeting.sourceUploadId,
        startSeconds: index,
        endSeconds: index + 1,
        speaker: `Speaker ${index + 1}`,
        text: `会议片段 ${index}`,
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }))),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: true,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor, verifier }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: true, busy: false });
    expect(verifierInputs).toHaveLength(1);
    expect(verifierInputs[0]?.claims.map((claim) => claim.claimType).sort()).toEqual([
      "action_item",
      "commitment_existence",
      "commitment_owner",
      "deadline",
      "decision_existence",
      "plan_change",
      "proposal",
      "speaker_attribution"
    ]);
    expect(verifierInputs[0]?.claims.find((claim) => claim.claimType === "proposal"))
      .toMatchObject({ semanticRiskFlags: ["causality"] });
    expect(verifierInputs[0]?.claims).toHaveLength(8);
    expect(verifierInputs[0]?.segmentIds).toEqual([
      "segment_1", "segment_2", "segment_3", "segment_4", "segment_5", "segment_6", "segment_7", "segment_8"
    ]);
    const detail = repository.getMeetingDetail("account_a", meeting.id);
    const claimById = new Map(detail.claims.map((claim) => [claim.id, claim]));
    const highRiskClaimTypes = new Set([
      "commitment_owner",
      "deadline",
      "speaker_attribution",
      "decision_existence",
      "commitment_existence",
      "action_item",
      "plan_change",
      "proposal"
    ]);
    expect(verifierInputs[0]?.claims.map((claim) => claim.claimId)).toEqual(
      detail.claims.filter((claim) => highRiskClaimTypes.has(claim.claimType)).map((claim) => claim.id)
    );
    expect(detail.claims).toHaveLength(10);
    expect(detail.evaluations).toHaveLength(10);
    expect(detail.evaluations.map((evaluation) => evaluation.claimId).sort())
      .toEqual(detail.claims.map((claim) => claim.id).sort());
    const nonGptEvaluations = detail.evaluations.filter((evaluation) =>
      evaluation.issueCodes.includes(WORK_MEETING_NON_GPT_ISSUE_CODE)
    );
    expect(nonGptEvaluations.map((evaluation) => claimById.get(evaluation.claimId)?.claimType).sort())
      .toEqual([
        "open_question",
        "topic"
      ]);
    expect(nonGptEvaluations.every((evaluation) =>
      evaluation.supportVerdict === "unverifiable"
      && evaluation.supportedEvidenceIds.length === 0
      && evaluation.verifierProfile === WORK_MEETING_NON_GPT_PROFILE
    )).toBe(true);
    const gptEvaluations = detail.evaluations.filter((evaluation) =>
      !evaluation.issueCodes.includes(WORK_MEETING_NON_GPT_ISSUE_CODE)
    );
    expect(gptEvaluations).toHaveLength(8);
    expect(gptEvaluations.every((evaluation) =>
      evaluation.verifierProfile === "work-meeting-verifier-test"
      && evaluation.verifierPromptVersion === WORK_MEETING_VERIFIER_PROMPT_VERSION
    )).toBe(true);
    const causalityClaim = detail.claims.find((claim) => claim.claimType === "proposal");
    expect(gptEvaluations.find((evaluation) => evaluation.claimId === causalityClaim?.id)?.issueCodes)
      .toContain(WORK_MEETING_CAUSALITY_ROUTING_ISSUE_CODE);
    expect(detail.candidates).toEqual([
      expect.objectContaining({
        status: "pending_review",
        publicationAction: "show_as_question",
        structuredData: expect.objectContaining({
          rawActorLabel: null,
          candidateOwner: "Speaker 2",
          dueAt: "2026-09-08T00:00:00.000Z",
          originalDueExpression: "下周二"
        })
      })
    ]);
    expect(detail.findings).toEqual([]);
    expect((database.prepare("SELECT COUNT(*) AS count FROM wr_todos").get() as { count: number }).count)
      .toBe(0);
    expect(toWorkMeetingDetailView(detail).meeting.verifierMode).toBe("enabled");
  });

  it("verifies only server-generated core Claims with exact aggregate closure", async () => {
    const meeting = seedSourceAudio();
    const extractedCandidates: WorkExtractorCandidateDraft[] = Array.from(
      { length: 3 },
      (_, candidateIndex) => ({
        clientCandidateKey: `aggregate_candidate_${candidateIndex}`,
        kind: "decision",
        title: `聚合议题 ${candidateIndex}`,
        body: `聚合议题 ${candidateIndex} 的独立讨论内容`,
        structuredData: {
          decisionFinality: null,
          rawActorLabel: null,
          candidateOwner: null,
          dueAt: null,
          originalDueExpression: null,
          actionBasis: null,
          relatedCommitmentCandidateId: null,
          planStages: []
        },
        evidenceIds: ["segment_0"],
        claims: Array.from({ length: 20 }, (_, claimIndex) => ({
          clientClaimKey: `aggregate_claim_${candidateIndex}_${claimIndex}`,
          claimType: "decision_existence",
          text: `议题 ${candidateIndex} 的原子事实 ${claimIndex}`,
          evidenceIds: ["segment_0"]
        }))
      })
    );
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      extract: vi.fn(async () => extractedCandidates)
    };
    const verifierBatchClaimIds: string[][] = [];
    const verifier: WorkMeetingVerifier = {
      profile: {
        ...extractor.profile,
        profileId: "work-meeting-verifier-test",
        promptVersion: WORK_MEETING_VERIFIER_PROMPT_VERSION,
        schemaVersion: "work_meeting_claim_evaluations_v3"
      },
      async verify({ claims }) {
        verifierBatchClaimIds.push(claims.map((claim) => claim.id));
        return { items: [...claims].reverse().map((claim) => ({
          claimId: claim.id,
          supportVerdict: "entailed" as const,
          issueCodes: [],
          supportedEvidenceIds: [...claim.evidenceIds]
        })), coverage: [] };
      }
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => [{
        id: "segment_0",
        uploadId: meeting.sourceUploadId,
        startSeconds: 0,
        endSeconds: 1,
        speaker: "Speaker 1",
        text: "会议讨论了多个独立议题。",
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }]),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: true,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor, verifier }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    const requestedClaimIds = verifierBatchClaimIds.flat();
    expect(result).toMatchObject({ transcriptReady: true, analysisReady: true, busy: false });
    expect(verifierBatchClaimIds).toHaveLength(1);
    expect(verifierBatchClaimIds.every((batch) => batch.length <= 24)).toBe(true);
    expect(requestedClaimIds).toHaveLength(1);
    expect(new Set(requestedClaimIds).size).toBe(1);
    const detail = repository.getMeetingDetail("account_a", meeting.id);
    expect(detail.meeting.analysisStatus).toBe("review_ready");
    expect(detail.claims).toHaveLength(1);
    expect(detail.evaluations).toHaveLength(1);
    expect(detail.evaluations.map((evaluation) => evaluation.claimId).sort())
      .toEqual(detail.claims.map((claim) => claim.id).sort());
    expect(new Set(detail.evaluations.map((evaluation) => evaluation.claimId)).size).toBe(1);
  });

  it.each([false, true])("publishes 25 Claims across two Verifier batches with one missing result=%s", async (omitResult) => {
    const meeting = seedSourceAudio();
    const topics = ["账单退款", "登录令牌", "地图路线", "库存批次", "搜索索引"];
    const extractedCandidates: WorkExtractorCandidateDraft[] = topics.map((topic, index) => {
      const base = extractedDecision(`segment_${index}`);
      return {
        ...base,
        clientCandidateKey: `aggregate_candidate_${index}`,
        title: `${topic}的独立决定`,
        body: `会议明确决定处理${topic}事项。`,
        claims: [{
          ...base.claims[0]!,
          clientClaimKey: `aggregate_decision_${index}`,
          text: `${topic}的独立决定`
        }, ...(["commitment_existence", "action_item", "plan_change", "proposal"] as const).map((claimType) => ({
          clientClaimKey: `aggregate_${claimType}_${index}`,
          claimType,
          semanticRiskFlags: claimType === "proposal" ? ["causality" as const] : [],
          text: `${topic}的${claimType}事实`,
          evidenceIds: [...base.evidenceIds]
        }))]
      };
    });
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      extract: vi.fn(async () => extractedCandidates)
    };
    const verifierBatchClaimIds: string[][] = [];
    let omittedClaimId: string | undefined;
    const verifier: WorkMeetingVerifier = {
      profile: {
        ...extractor.profile,
        profileId: "work-meeting-verifier-test",
        promptVersion: WORK_MEETING_VERIFIER_PROMPT_VERSION,
        schemaVersion: "work_meeting_claim_evaluations_v3"
      },
      async verify({ claims }) {
        verifierBatchClaimIds.push(claims.map((claim) => claim.id));
        if (omitResult && verifierBatchClaimIds.length === 1) {
          omittedClaimId = claims.find((claim) => claim.claimType === "decision_existence")!.id;
        }
        return { items: [...claims].reverse().filter((claim) => claim.id !== omittedClaimId).map((claim) => ({
          claimId: claim.id,
          supportVerdict: "entailed" as const,
          issueCodes: [],
          supportedEvidenceIds: [...claim.evidenceIds]
        })), coverage: [] };
      }
    };

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => topics.map((topic, index) => ({
        id: `segment_${index}`,
        uploadId: meeting.sourceUploadId,
        startSeconds: index,
        endSeconds: index + 1,
        speaker: "Speaker 1",
        text: `会议明确决定处理${topic}事项。`,
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }))),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: true,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor, verifier }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toMatchObject({ transcriptReady: true, analysisReady: true, busy: false });
    expect(verifierBatchClaimIds.map((batch) => batch.length)).toEqual([20, 5]);
    expect(new Set(verifierBatchClaimIds.flat()).size).toBe(25);
    const detail = repository.getMeetingDetail("account_a", meeting.id);
    expect(detail.meeting.analysisStatus).toBe("review_ready");
    expect(detail.claims).toHaveLength(25);
    expect(detail.evaluations).toHaveLength(25);
    expect(detail.evaluations.filter((evaluation) => evaluation.supportVerdict === "entailed"))
      .toHaveLength(omitResult ? 24 : 25);
    expect(detail.candidates.filter((candidate) => candidate.publicationAction === "show_as_candidate"))
      .toHaveLength(omitResult ? 4 : 5);
    if (omitResult) {
      expect(detail.evaluations.find((evaluation) => evaluation.claimId === omittedClaimId)).toMatchObject({
        supportVerdict: "unverifiable",
        issueCodes: ["verifier_result_missing"],
        publicationAction: "suppress",
        supportedEvidenceIds: []
      });
      const affectedClaim = detail.claims.find((claim) => claim.id === omittedClaimId)!;
      expect(detail.candidates.find((candidate) => candidate.id === affectedClaim.candidateId)).toMatchObject({
        status: "invalidated",
        publicationAction: "suppress"
      });
    }
  });

  it.each(["applied", "fallback"])("reuses Extractor and %s organization checkpoints before a missing Verifier batch", async (organizationState) => {
    const meeting = seedSourceAudio();
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      extract: vi.fn(async () => {
        const highRisk = extractedDecision("segment_0");
        return [
          {
            ...highRisk,
            clientCandidateKey: "candidate_high_risk",
            claims: Array.from({ length: 25 }, (_, index) => ({
              ...highRisk.claims[0],
              clientClaimKey: `claim_high_risk_${index}`,
              text: `会议决定推进事项 ${index}`
            }))
          },
          { ...highRisk, clientCandidateKey: "candidate_complement", title: "核对该方案的边界用例", body: "核对该方案的边界用例",
            claims: [{ ...highRisk.claims[0], clientClaimKey: "claim_complement", text: "核对该方案的边界用例" }] }
        ];
      })
    };
    const verifierCallClaimIds: string[][] = [];
    const verifier: WorkMeetingVerifier = {
      profile: {
        ...extractor.profile,
        profileId: "work-meeting-verifier-test",
        promptVersion: WORK_MEETING_VERIFIER_PROMPT_VERSION,
        schemaVersion: "work_meeting_claim_evaluations_v3"
      },
      verify: vi.fn(async ({ claims }: Parameters<WorkMeetingVerifier["verify"]>[0]) => {
        verifierCallClaimIds.push(claims.map((claim) => claim.id));
        if (verifierCallClaimIds.length === 1) {
          throw new WorkMeetingAnalysisProviderError(
            "work_analysis_provider_request_rejected",
            "Verifier request was rejected"
          );
        }
        return { items: claims.map((claim) => ({
          claimId: claim.id,
          supportVerdict: "entailed" as const,
          issueCodes: [],
          supportedEvidenceIds: [...claim.evidenceIds]
        })), coverage: [] };
      })
    };

    const deduplicator = {
      ...createWorkMeetingDeduplicator({ profile: verifier.profile }),
      deduplicate: vi.fn(async () => {
        if (organizationState === "fallback") throw new Error("fixture_organization_rejected");
        return { groups: [{ items: [1, 2] }], priority: [2, 1] };
      })
    };
    const request = {
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    };
    const dependencies = {
      repository,
      probeDurationSeconds: vi.fn(async () => 20),
      transcriber: vi.fn(async () => [{
        id: "segment_0",
        uploadId: meeting.sourceUploadId,
        startSeconds: 0,
        endSeconds: 1,
        speaker: "Speaker 1",
        text: "会议讨论了项目进度。",
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }]),
      cleanupRawAudio: vi.fn(async () => undefined),
      resolveAnalysisConcurrency: () => 1,
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: true,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor, verifier, deduplicator }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    } satisfies Parameters<typeof processWorkMeeting>[1];

    const firstResult = await processWorkMeeting(request, dependencies);

    expect(firstResult).toMatchObject({ transcriptReady: true, analysisReady: false, busy: false });
    expect(extractor.extract).toHaveBeenCalledTimes(1);
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect(deduplicator.deduplicate).toHaveBeenCalledTimes(1);
    const expectedCandidates = organizationState === "applied" ? 1 : 2;
    expect(verifierCallClaimIds.map((ids) => ids.length)).toEqual([expectedCandidates]);
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: {
        analysisStatus: "failed",
        errorCode: "work_analysis_provider_request_rejected"
      },
      candidates: [],
      claims: [],
      evaluations: [],
      findings: []
    });
    expect(database.prepare(`
      SELECT checkpoint_kind, COUNT(*) AS count
      FROM wr_analysis_checkpoints
      GROUP BY checkpoint_kind
      ORDER BY checkpoint_kind
    `).all()).toEqual([
      { checkpoint_kind: "extractor_block", count: 1 },
      { checkpoint_kind: "organization_plan", count: 1 }
    ]);

    const secondResult = await processWorkMeeting(request, dependencies);

    expect(secondResult).toMatchObject({ transcriptReady: true, analysisReady: true, busy: false });
    expect(extractor.extract).toHaveBeenCalledTimes(1);
    expect(verifier.verify).toHaveBeenCalledTimes(2);
    expect(deduplicator.deduplicate).toHaveBeenCalledTimes(1);
    expect(verifierCallClaimIds.map((ids) => ids.length)).toEqual([expectedCandidates, expectedCandidates]);
    expect(verifierCallClaimIds[1]).toEqual(verifierCallClaimIds[0]);
    expect(repository.getMeetingDetail("account_a", meeting.id)).toMatchObject({
      meeting: {
        analysisStatus: "review_ready",
        errorCode: null
      }
    });
    const completedDetail = repository.getMeetingDetail("account_a", meeting.id);
    expect(completedDetail.candidates).toHaveLength(expectedCandidates);
    expect(completedDetail.claims).toHaveLength(expectedCandidates);
    expect(completedDetail.evaluations).toHaveLength(expectedCandidates);
    expect(repository.readAnalysisAudit("account_a", meeting.id)).toMatchObject({ organization: { state: organizationState } });
    expect(completedDetail.evaluations.map((evaluation) => evaluation.claimId).sort())
      .toEqual(completedDetail.claims.map((claim) => claim.id).sort());
    expect((database.prepare("SELECT COUNT(*) AS count FROM wr_analysis_checkpoints").get() as { count: number }).count)
      .toBe(0);
    expect((database.prepare("SELECT COUNT(*) AS count FROM wr_todos").get() as { count: number }).count)
      .toBe(0);
  });

  it("persists authoritative duration and keeps canonical transcript after analysis failure", async () => {
    const meeting = seedSourceAudio();
    const probeDurationSeconds = vi.fn(async () => 367.25);
    const transcriber = vi.fn(async () => [{
      id: "segment_1",
      uploadId: meeting.sourceUploadId,
      startSeconds: 0,
      endSeconds: 8,
      speaker: "Speaker 1",
      text: "我们先保留这个方案，下周再确认。",
      confidence: 0.97,
      sceneLabels: [],
      valueLabels: []
    }]);
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
        schemaVersion: "work_meeting_candidates_v7"
      },
      extract: vi.fn(async () => {
        throw new WorkMeetingAnalysisProviderError(
          "work_evidence_closure_invalid",
          "Extractor Evidence closure is invalid"
        );
      })
    };
    const cleanupRawAudio = vi.fn(async () => undefined);

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds,
      transcriber,
      cleanupRawAudio,
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toEqual({
      meetingId: meeting.id,
      transcriptReady: true,
      analysisReady: false,
      busy: false
    });
    expect(probeDurationSeconds).toHaveBeenCalledWith(
      "C:\\test-data\\account_a\\uploads\\source_orchestrator.wav"
    );
    expect(transcriber).toHaveBeenCalledTimes(1);
    expect(extractor.extract).toHaveBeenCalledTimes(1);
    expect(cleanupRawAudio).toHaveBeenCalledTimes(1);
    expect(repository.getMeeting("account_a", meeting.id)).toMatchObject({
      ingestionStatus: "transcript_ready",
      sourceDurationSeconds: 367.25,
      canonicalSegmentCount: 1,
      analysisStatus: "failed",
      errorStage: "meeting_analysis",
      errorCode: "work_evidence_closure_invalid"
    });
    expect(repository.readCanonicalPublication("account_a", meeting.id)).toMatchObject({
      sourceUploadId: meeting.sourceUploadId,
      segmentCount: 1,
      segments: [expect.objectContaining({
        id: "segment_1",
        text: "我们先保留这个方案，下周再确认。"
      })]
    });
    expect(repository.readSourceUpload("account_a", meeting.id)?.filePath).toBeNull();
  });

  it("fails before ASR when ffprobe reports audio beyond the Work limit", async () => {
    const meeting = seedSourceAudio();
    const transcriber = vi.fn();

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 3_601),
      transcriber,
      resolveCapacityLimits: () => ({
        maxUploadBytes: 1024,
        maxAudioDurationSeconds: 3_600
      }),
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: false,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toEqual({
      meetingId: meeting.id,
      transcriptReady: false,
      analysisReady: false,
      busy: false
    });
    expect(transcriber).not.toHaveBeenCalled();
    expect(repository.readCanonicalPublication("account_a", meeting.id)).toBeNull();
    expect(repository.getMeeting("account_a", meeting.id)).toMatchObject({
      ingestionStatus: "failed",
      sourceDurationSeconds: null,
      errorStage: "transcription",
      errorCode: "work_review_audio_duration_exceeded"
    });
  });
});

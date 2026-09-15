import { describe, expect, it, vi } from "vitest";

import type {
  WorkWeeklyQaRun,
  WorkWeeklyRun,
  WorkWeeklyRunFence,
  WorkWeeklyQaRunFence
} from "@/lib/domain/work-weekly";

import type { WorkWeeklyRepository } from "./weekly-repository";
import type { WorkWeeklyClaimVerifier } from "./weekly-ai-provider";
import type { WorkWeeklyDiagnosticSink } from "./weekly-evaluation-diagnostics";
import type { WorkWeeklyQaDiagnosticSink } from "./weekly-qa-diagnostics";
import type { WorkWeeklyQaAnswerer, WorkWeeklyQaVerifier } from "./weekly-qa-provider";
import {
  classifyWorkWeeklyGenerationRecovery,
  classifyWorkWeeklyQaRecovery,
  createFixtureWorkWeeklyRunExecutor
} from "./weekly-ai-runner";
import {
  WORK_WEEKLY_TEST_REFS,
  workWeeklyProfile,
  workWeeklyTestSnapshot
} from "./weekly-ai-test-fixture";

const digest = "a".repeat(64);
const generationFence: WorkWeeklyRunFence = {
  weeklyReviewId: "weekly_a",
  runId: "run_generation",
  runVersion: 1,
  sourceSnapshotDigest: digest,
  leaseOwner: "worker_a",
  leaseExpiresAt: "2026-09-03T09:00:00.000Z"
};
const qaFence: WorkWeeklyQaRunFence = {
  ...generationFence,
  runId: "run_qa",
  threadId: "thread_a"
};

function repository() {
  return {
    claimGenerationRun: vi.fn(() => generationFence),
    canCaptureGeneration: vi.fn(() => true),
    markGenerationVerifying: vi.fn(),
    publishSystemVersion: vi.fn(),
    markGenerationFailed: vi.fn(),
    claimQaRun: vi.fn(() => qaFence),
    getQaThread: vi.fn(() => ({
      thread: {
        id: "thread_a", accountId: "account_a", weeklyReviewId: "weekly_a",
        sourceSnapshotDigest: digest, version: 1,
        createdAt: "2026-09-03T08:00:00.000Z",
        updatedAt: "2026-09-03T08:00:00.000Z", clearedAt: null
      },
      messages: [{
        id: "question_a", accountId: "account_a", weeklyReviewId: "weekly_a",
        threadId: "thread_a", role: "user" as const, text: "本周决定了什么？",
        answerStatus: null, sourceRefs: [], sourceSnapshotDigest: digest,
        providerProfile: null, promptVersion: null, verifierProfile: null,
        version: 1, createdAt: "2026-09-03T08:00:00.000Z", invalidatedAt: null
      }]
    })),
    publishQaAnswer: vi.fn(),
    markQaRunFailed: vi.fn()
  };
}

function generationRequest() {
  return {
    accountId: "account_a",
    weeklyReviewId: "weekly_a",
    runId: "run_generation",
    runVersion: 1,
    sourceSnapshotDigest: digest,
    leaseOwner: "worker_a",
    leaseMs: 30_000,
    observedState: "queued" as const
  };
}

function qaRequest() {
  return {
    ...generationRequest(),
    runId: "run_qa",
    threadId: "thread_a",
    questionMessageId: "question_a"
  };
}

function executor(repo: ReturnType<typeof repository>, options: {
  coverage?: "covered" | "partial" | "missing";
  diagnosticSink?: WorkWeeklyDiagnosticSink;
  onSynthesize?: () => void;
  onVerify?: () => void;
  qaDiagnosticSink?: WorkWeeklyQaDiagnosticSink;
  qaAnswerer?: WorkWeeklyQaAnswerer | null;
  qaVerifier?: WorkWeeklyQaVerifier | null;
} = {}) {
  const source = workWeeklyTestSnapshot();
  const refs = new Set<string>([WORK_WEEKLY_TEST_REFS.meeting, WORK_WEEKLY_TEST_REFS.decision,
    WORK_WEEKLY_TEST_REFS.evidenceDecision]);
  // This runner fixture represents one complete decision, not a shortened multi-topic review.
  source.findings = source.findings.filter((item) => item.sourceRef === WORK_WEEKLY_TEST_REFS.decision);
  source.evidence = source.evidence.filter((item) => item.sourceRef === WORK_WEEKLY_TEST_REFS.evidenceDecision);
  source.todos = [];
  source.todoEvents = [];
  source.identities = source.identities.filter((item) => refs.has(item.sourceRef));
  source.allowlistedSourceRefs = source.allowlistedSourceRefs.filter((ref) => refs.has(ref));
  Object.assign(source.summary, { findingCount: 1, includedFindingCount: 1,
    evidenceCount: 1, includedEvidenceCount: 1, todoCount: 0, includedTodoCount: 0,
    todoEventCount: 0, includedTodoEventCount: 0 });
  return createFixtureWorkWeeklyRunExecutor({
    repository: repo as unknown as WorkWeeklyRepository,
    loadSnapshot: () => source,
    diagnosticSink: options.diagnosticSink,
    qaDiagnosticSink: options.qaDiagnosticSink ?? vi.fn(),
    synthesizer: {
      profile: workWeeklyProfile("synthesizer"),
      synthesize: vi.fn(async () => {
        options.onSynthesize?.();
        return [{
        id: "item_decision", section: "decisions" as const,
        itemType: "evidence_backed_fact" as const, text: "模型文字",
        claims: [{ id: "claim_decision", text: "选择 B", claimType: "decision" as const, sourceRefs: [WORK_WEEKLY_TEST_REFS.decision] }]
      }]; })
    },
    weeklyVerifier: {
      profile: workWeeklyProfile("verifier"),
      verify: vi.fn(async (call: Parameters<WorkWeeklyClaimVerifier["verify"]>[0]) => {
        options.onVerify?.();
        if (options.coverage !== "missing") call.onCoverage?.([{
          sourceRef: WORK_WEEKLY_TEST_REFS.decision,
          status: options.coverage ?? "covered", claimIds: ["claim_decision"],
          reasonCode: options.coverage === "partial" ? "missing_qualification" : "covered"
        }]);
        return [{ claimId: "claim_decision", verdict: "entailed" as const, issueCodes: [], supportedSourceRefs: [WORK_WEEKLY_TEST_REFS.decision] }];
      })
    },
    qaAnswerer: options.qaAnswerer !== undefined ? options.qaAnswerer : {
      profile: workWeeklyProfile("qa_answerer"),
      answer: vi.fn(async () => ({
        status: "answered" as const, answer: "模型答案",
        claims: [{ id: "claim_decision", text: "选择 B", claimType: "decision" as const, sourceRefs: [WORK_WEEKLY_TEST_REFS.decision] }],
        relevantSourceRefs: [WORK_WEEKLY_TEST_REFS.decision]
      }))
    },
    qaVerifier: options.qaVerifier !== undefined ? options.qaVerifier : {
      profile: workWeeklyProfile("qa_verifier"),
      verify: vi.fn(async () => [{ claimId: "claim_decision", verdict: "entailed" as const, issueCodes: [], supportedSourceRefs: [WORK_WEEKLY_TEST_REFS.decision] }])
    }
  });
}

describe("Work Weekly AI runner contract", () => {
  it("publishes verified generation only through the repository fence", async () => {
    const repo = repository();
    const result = await executor(repo).runGeneration(generationRequest());
    expect(result.state).toBe("published");
    expect(repo.markGenerationVerifying).toHaveBeenCalledWith(generationFence);
    expect(repo.publishSystemVersion).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account_a", fence: generationFence,
      qualityAssessment: expect.objectContaining({ status: "passed" })
    }));
    expect(repo.markGenerationFailed).not.toHaveBeenCalled();
  });

  it("publishes nonempty partial coverage with explicit review issues and a persisted outcome", async () => {
    const repo = repository();
    const diagnosticSink = vi.fn<WorkWeeklyDiagnosticSink>(async () => undefined);
    const result = await executor(repo, { coverage: "partial", diagnosticSink }).runGeneration(generationRequest());
    expect(result.state).toBe("published");
    expect(repo.publishSystemVersion).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ sourceRefs: [WORK_WEEKLY_TEST_REFS.decision] })],
      qualityAssessment: expect.objectContaining({ status: "needs_review", reviewIssues: [
        { sourceRef: WORK_WEEKLY_TEST_REFS.decision, reasonCode: "missing_qualification" }
      ] })
    }));
    expect(repo.markGenerationFailed).not.toHaveBeenCalled();
    expect(diagnosticSink.mock.calls.at(-1)![0].event).toMatchObject({
      stage: "finished", outcome: "published", qualityStatus: "needs_review", publicationStatus: "persisted"
    });
  });

  it("does not publish when coverage is missing even if every generated claim is entailed", async () => {
    const repo = repository();
    const result = await executor(repo, { coverage: "missing" }).runGeneration(generationRequest());
    expect(result).toMatchObject({ state: "failed", errorCode: "weekly_generation_quality_insufficient" });
    expect(repo.publishSystemVersion).not.toHaveBeenCalled();
    expect(repo.markGenerationFailed).toHaveBeenCalledWith(expect.objectContaining({
      qualityAssessment: { status: "insufficient" }, errorCode: "weekly_generation_quality_insufficient"
    }));
  });

  it("captures bound drafts, verdicts, policy candidates and the separate committed outcome", async () => {
    const repo = repository();
    const diagnosticSink = vi.fn<WorkWeeklyDiagnosticSink>(async ({ event }) => {
      if (event.stage === "pipeline") expect(repo.publishSystemVersion).not.toHaveBeenCalled();
      if (event.stage === "finished") expect(repo.publishSystemVersion).toHaveBeenCalledTimes(1);
    });
    expect((await executor(repo, { diagnosticSink }).runGeneration(generationRequest())).state).toBe("published");
    expect(diagnosticSink.mock.calls.map(([call]) => call.event.stage === "pipeline"
      ? call.event.trace.stage : call.event.stage)).toEqual(["started", "synthesized", "verified", "published", "finished"]);
    for (const [call] of diagnosticSink.mock.calls) expect(call.run).toEqual({
      accountId: "account_a", weeklyReviewId: "weekly_a", runId: "run_generation", runVersion: 1,
      sourceSnapshotDigest: digest, inputPackDigest: "b".repeat(64)
    });
  });

  it("stops before Provider when the explicitly requested diagnostic capture fails", async () => {
    const repo = repository();
    const onSynthesize = vi.fn();
    const diagnosticSink = vi.fn<WorkWeeklyDiagnosticSink>(async ({ event }) => {
      if (event.stage === "started") throw new Error("private path and secret body");
    });
    const result = await executor(repo, { diagnosticSink, onSynthesize }).runGeneration(generationRequest());
    expect(result).toMatchObject({ state: "failed", errorCode: "weekly_diagnostics_capture_failed" });
    expect(onSynthesize).not.toHaveBeenCalled();
    expect(repo.publishSystemVersion).not.toHaveBeenCalled();
    expect(JSON.stringify(diagnosticSink.mock.calls)).not.toContain("private path");
  });

  it.each(["synthesized", "verified"] as const)("does not capture or publish a cancelled late %s result", async (stage) => {
    const repo = repository();
    const controller = new AbortController();
    const diagnosticSink = vi.fn<WorkWeeklyDiagnosticSink>(async () => undefined);
    const onVerify = vi.fn(() => { if (stage === "verified") controller.abort(); });
    const result = await executor(repo, { diagnosticSink, coverage: "partial",
      onSynthesize: () => { if (stage === "synthesized") controller.abort(); }, onVerify
    }).runGeneration({ ...generationRequest(), signal: controller.signal });
    expect(result).toMatchObject({ state: "failed", errorCode: "weekly_generation_cancelled" });
    expect(repo.publishSystemVersion).not.toHaveBeenCalled();
    expect(diagnosticSink.mock.calls.some(([call]) => call.event.stage === "pipeline" && call.event.trace.stage === stage)).toBe(false);
    if (stage === "synthesized") expect(onVerify).not.toHaveBeenCalled();
  });

  it("does not dispatch synthesis when a run loses its fence during initial capture", async () => {
    const repo = repository();
    const onSynthesize = vi.fn();
    const diagnosticSink: WorkWeeklyDiagnosticSink = async () => { repo.canCaptureGeneration.mockReturnValue(false); };
    const result = await executor(repo, { diagnosticSink, onSynthesize }).runGeneration(generationRequest());
    expect(result.state).toBe("failed");
    expect(onSynthesize).not.toHaveBeenCalled();
    expect(repo.publishSystemVersion).not.toHaveBeenCalled();
  });

  it.each(["covered", "partial"] as const)("keeps the persisted %s result authoritative if terminal diagnostics fail", async (coverage) => {
    const repo = repository();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const diagnosticSink: WorkWeeklyDiagnosticSink = async ({ event }) => {
        if (event.stage === "finished") throw new Error("secret Provider body");
      };
      const result = await executor(repo, { diagnosticSink, coverage }).runGeneration(generationRequest());
      expect(result).toMatchObject({ state: "published" });
      expect(repo.markGenerationFailed).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    } finally { warn.mockRestore(); }
  });

  it("publishes a verified QA answer against the exact thread/question fence", async () => {
    const repo = repository();
    const result = await executor(repo).runQa(qaRequest());
    expect(result.state).toBe("published");
    expect(repo.publishQaAnswer).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account_a", fence: qaFence,
      answerStatus: "answered",
      sourceRefs: [WORK_WEEKLY_TEST_REFS.decision]
    }));
    expect(repo.markQaRunFailed).not.toHaveBeenCalled();
  });

  it("persists missing QA providers as a failed run instead of a completed insufficient answer", async () => {
    const repo = repository();
    const result = await executor(repo, { qaVerifier: null }).runQa(qaRequest());
    expect(result).toMatchObject({ state: "failed", errorCode: "weekly_qa_provider_unavailable" });
    expect(repo.markQaRunFailed).toHaveBeenCalledWith({ accountId: "account_a", fence: qaFence,
      errorCode: "weekly_qa_provider_unavailable" });
    expect(repo.publishQaAnswer).not.toHaveBeenCalled();
  });

  it("persists fixed QA technical codes with no raw error or request text in diagnostics", async () => {
    const repo = repository();
    const sink = vi.fn<WorkWeeklyQaDiagnosticSink>();
    const answer = vi.fn(async () => { throw Object.assign(new Error("private body https://secret.test?api_key=secret"),
      { code: "weekly_private_secret" }); });
    const result = await executor(repo, { qaDiagnosticSink: sink,
      qaAnswerer: { profile: workWeeklyProfile("qa_answerer"), answer } }).runQa(qaRequest());
    expect(result).toMatchObject({ state: "failed", errorCode: "weekly_qa_provider_failed" });
    expect(repo.publishQaAnswer).not.toHaveBeenCalled();
    expect(repo.markQaRunFailed).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "weekly_qa_provider_failed" }));
    expect(answer).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls.at(-1)![0]).toMatchObject({ component: "work-weekly-qa", runVersion: 1,
      runKey: expect.stringMatching(/^[a-f0-9]{64}$/u), stage: "persistence", outcome: "failed" });
    expect(JSON.stringify(sink.mock.calls)).not.toMatch(/secret|private|account_a|run_qa|本周|work:finding/u);
  });

  it("persists genuine no-support QA as completed insufficient evidence", async () => {
    const repo = repository();
    const answer = vi.fn(async () => ({ status: "insufficient_evidence" as const, answer: "ignored", claims: [], relevantSourceRefs: [] }));
    const result = await executor(repo, { qaAnswerer: { profile: workWeeklyProfile("qa_answerer"), answer } }).runQa(qaRequest());
    expect(result.state).toBe("published");
    expect(repo.publishQaAnswer).toHaveBeenCalledWith(expect.objectContaining({ answerStatus: "insufficient_evidence", sourceRefs: [] }));
    expect(repo.markQaRunFailed).not.toHaveBeenCalled();
  });

  it("does not change a persisted QA answer when the diagnostic sink throws after publication", async () => {
    const repo = repository();
    const sink = vi.fn<WorkWeeklyQaDiagnosticSink>(async () => { throw new Error("private sink failure"); });
    expect(await executor(repo, { qaDiagnosticSink: sink }).runQa(qaRequest())).toMatchObject({ state: "published" });
    expect(repo.publishQaAnswer).toHaveBeenCalledTimes(1);
    expect(repo.markQaRunFailed).not.toHaveBeenCalled();
    expect(sink.mock.calls.at(-1)![0]).toMatchObject({ stage: "persistence", outcome: "published" });
  });

  it("does not publish when cancellation arrives after verification and before persistence", async () => {
    const repo = repository();
    const controller = new AbortController();
    const sink = vi.fn<WorkWeeklyQaDiagnosticSink>((event) => {
      if (event.stage === "publication") controller.abort();
    });
    expect(await executor(repo, { qaDiagnosticSink: sink }).runQa({ ...qaRequest(), signal: controller.signal }))
      .toMatchObject({ state: "failed", errorCode: "weekly_qa_cancelled" });
    expect(repo.publishQaAnswer).not.toHaveBeenCalled();
  });

  it("fails a persisted identity mismatch before loading sources or calling GPT", async () => {
    const repo = repository();
    const loadSnapshot = vi.fn(() => workWeeklyTestSnapshot());
    const synthesize = vi.fn();
    const run = createFixtureWorkWeeklyRunExecutor({
      repository: repo as unknown as WorkWeeklyRepository,
      loadSnapshot,
      synthesizer: { profile: workWeeklyProfile("synthesizer"), synthesize },
      weeklyVerifier: null,
      qaAnswerer: null,
      qaVerifier: null
    });
    const result = await run.runGeneration({ ...generationRequest(), runVersion: 2 });
    expect(result).toMatchObject({ state: "failed", errorCode: "weekly_generation_contract_mismatch" });
    expect(loadSnapshot).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
    expect(repo.markGenerationFailed).toHaveBeenCalled();
  });

  it("classifies only queued work as executable and terminates expired active work without GPT", async () => {
    const now = new Date("2026-09-03T10:00:00.000Z");
    const base = {
      id: "run_generation", accountId: "account_a", weeklyReviewId: "weekly_a",
      runVersion: 1, sourceSnapshotDigest: digest, leaseOwner: null,
      leaseExpiresAt: null, pipelineVersion: "v1", synthesizerProfile: null,
      verifierProfile: null, createdAt: "2026-09-03T08:00:00.000Z",
      completedAt: null, errorCode: null
    };
    expect(classifyWorkWeeklyGenerationRecovery({ ...base, state: "queued" } as WorkWeeklyRun, now))
      .toBe("execute_queued");
    expect(classifyWorkWeeklyGenerationRecovery({
      ...base, state: "processing", leaseOwner: "old_worker",
      leaseExpiresAt: "2026-09-03T09:00:00.000Z"
    } as WorkWeeklyRun, now)).toBe("terminate_unknown_outcome");

    const repo = repository();
    const run = executor(repo);
    const result = await run.terminateGenerationUnknownOutcome({
      ...generationRequest(), observedState: "processing"
    });
    expect(result).toMatchObject({
      state: "failed", errorCode: "weekly_generation_provider_outcome_unknown"
    });
    expect(repo.markGenerationFailed).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "weekly_generation_provider_outcome_unknown"
    }));
    expect(repo.publishSystemVersion).not.toHaveBeenCalled();
  });

  it("applies the same unknown-outcome recovery rule to QA", async () => {
    const now = new Date("2026-09-03T10:00:00.000Z");
    const qaRun = {
      id: "run_qa", accountId: "account_a", weeklyReviewId: "weekly_a",
      threadId: "thread_a", questionMessageId: "question_a", runVersion: 1,
      sourceSnapshotDigest: digest, state: "verifying", leaseOwner: "old_worker",
      leaseExpiresAt: "2026-09-03T09:00:00.000Z", providerProfile: null,
      promptVersion: null, verifierProfile: null,
      createdAt: "2026-09-03T08:00:00.000Z", completedAt: null, errorCode: null
    } as WorkWeeklyQaRun;
    expect(classifyWorkWeeklyQaRecovery(qaRun, now)).toBe("terminate_unknown_outcome");
    const repo = repository();
    const result = await executor(repo).terminateQaUnknownOutcome({
      ...qaRequest(), observedState: "verifying"
    });
    expect(result).toMatchObject({ state: "failed", errorCode: "weekly_qa_provider_outcome_unknown" });
    expect(repo.markQaRunFailed).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "weekly_qa_provider_outcome_unknown"
    }));
    expect(repo.publishQaAnswer).not.toHaveBeenCalled();
  });
});

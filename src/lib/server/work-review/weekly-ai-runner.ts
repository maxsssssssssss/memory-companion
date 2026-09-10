import type {
  WorkWeeklyQaMessage,
  WorkWeeklyQaRun,
  WorkWeeklyRun,
  WorkWeeklySourceSnapshot
} from "@/lib/domain/work-weekly";

import {
  createStructuredWorkWeeklyClaimVerifier,
  createStructuredWorkWeeklySynthesizer,
  resolveWorkWeeklyProviderProfile,
  type WorkWeeklyClaimVerifier,
  type WorkWeeklyStructuredJsonRequest,
  type WorkWeeklySynthesizer
} from "./weekly-ai-provider";
import {
  answerWorkWeeklyQuestion,
  createStructuredWorkWeeklyQaAnswerer,
  createStructuredWorkWeeklyQaVerifier,
  type WorkWeeklyQaAnswerer,
  type WorkWeeklyQaVerifier
} from "./weekly-qa-provider";
import { runWorkWeeklyGenerationPipeline } from "./weekly-publication-policy";
import type { WorkWeeklyDiagnosticSink, WorkWeeklyDiagnosticEvent, WorkWeeklyDiagnosticRun } from "./weekly-evaluation-diagnostics";
import {
  isWorkReviewWeeklyQaVerifierEnabled,
  isWorkReviewWeeklyVerifierEnabled
} from "./runtime-config";
import {
  WorkWeeklyLeaseLostError,
  WorkWeeklyRepository
} from "./weekly-repository";

export const WORK_WEEKLY_RUNNER_CONTRACT_VERSION = 1 as const;

export type WorkWeeklyGenerationRunRequest = {
  accountId: string;
  weeklyReviewId: string;
  runId: string;
  runVersion: number;
  sourceSnapshotDigest: string;
  leaseOwner: string;
  leaseMs: number;
  observedState: "queued";
  signal?: AbortSignal;
};

export type WorkWeeklyQaRunRequest = WorkWeeklyGenerationRunRequest & {
  threadId: string;
  questionMessageId: string;
};

export type WorkWeeklyUnknownOutcomeTerminationRequest = Omit<
  WorkWeeklyGenerationRunRequest,
  "observedState" | "signal"
> & {
  observedState: "processing" | "verifying";
};

export type WorkWeeklyQaUnknownOutcomeTerminationRequest =
  WorkWeeklyUnknownOutcomeTerminationRequest & {
    threadId: string;
    questionMessageId: string;
  };

export type WorkWeeklyRecoveryDisposition =
  | "execute_queued"
  | "terminate_unknown_outcome"
  | "ignore";

function recoveryDisposition(input: {
  state: WorkWeeklyRun["state"];
  leaseExpiresAt: string | null;
}, now: Date): WorkWeeklyRecoveryDisposition {
  if (input.state === "queued") return "execute_queued";
  if ((input.state === "processing" || input.state === "verifying")
    && input.leaseExpiresAt !== null
    && Date.parse(input.leaseExpiresAt) <= now.getTime()) {
    return "terminate_unknown_outcome";
  }
  return "ignore";
}

/** Expired active work has an unknown Provider outcome and must never be called again. */
export function classifyWorkWeeklyGenerationRecovery(
  run: WorkWeeklyRun,
  now = new Date()
): WorkWeeklyRecoveryDisposition {
  return recoveryDisposition(run, now);
}

/** Expired active QA has an unknown Provider outcome and must never be called again. */
export function classifyWorkWeeklyQaRecovery(
  run: WorkWeeklyQaRun,
  now = new Date()
): WorkWeeklyRecoveryDisposition {
  return recoveryDisposition(run, now);
}

export type WorkWeeklyRunResult =
  | {
    state: "published";
    kind: "generation" | "qa";
    weeklyReviewId: string;
    runId: string;
    runVersion: number;
  }
  | {
    state: "failed" | "not_claimed";
    kind: "generation" | "qa";
    weeklyReviewId: string;
    runId: string;
    runVersion: number;
    errorCode: string;
  };

export interface WorkWeeklyRunExecutor {
  readonly contractVersion: typeof WORK_WEEKLY_RUNNER_CONTRACT_VERSION;
  runGeneration(request: WorkWeeklyGenerationRunRequest): Promise<WorkWeeklyRunResult>;
  runQa(request: WorkWeeklyQaRunRequest): Promise<WorkWeeklyRunResult>;
  terminateGenerationUnknownOutcome(
    request: WorkWeeklyUnknownOutcomeTerminationRequest
  ): Promise<WorkWeeklyRunResult>;
  terminateQaUnknownOutcome(
    request: WorkWeeklyQaUnknownOutcomeTerminationRequest
  ): Promise<WorkWeeklyRunResult>;
}

type SnapshotLoader = (input: {
  accountId: string;
  weeklyReviewId: string;
}) => WorkWeeklySourceSnapshot | Promise<WorkWeeklySourceSnapshot>;

type ProviderBundle = {
  synthesizer: WorkWeeklySynthesizer | null;
  weeklyVerifier: WorkWeeklyClaimVerifier | null;
  qaAnswerer: WorkWeeklyQaAnswerer | null;
  qaVerifier: WorkWeeklyQaVerifier | null;
  configurationError: string | null;
};

function errorCode(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "code" in error
    && typeof (error as { code?: unknown }).code === "string") {
    const code = (error as { code: string }).code;
    return /^work_|^weekly_/u.test(code) ? code : fallback;
  }
  return fallback;
}

function contractMatches(request: Pick<WorkWeeklyGenerationRunRequest,
  "weeklyReviewId" | "runId" | "runVersion" | "sourceSnapshotDigest">, fence: {
  weeklyReviewId: string;
  runId: string;
  runVersion: number;
  sourceSnapshotDigest: string;
}) {
  return request.weeklyReviewId === fence.weeklyReviewId
    && request.runId === fence.runId
    && request.runVersion === fence.runVersion
    && request.sourceSnapshotDigest === fence.sourceSnapshotDigest;
}

class DefaultWorkWeeklyRunExecutor implements WorkWeeklyRunExecutor {
  readonly contractVersion = WORK_WEEKLY_RUNNER_CONTRACT_VERSION;

  constructor(
    private readonly repository: WorkWeeklyRepository,
    private readonly loadSnapshot: SnapshotLoader,
    private readonly providers: ProviderBundle,
    private readonly diagnosticSink?: WorkWeeklyDiagnosticSink
  ) {}

  async runGeneration(request: WorkWeeklyGenerationRunRequest): Promise<WorkWeeklyRunResult> {
    let fence: ReturnType<WorkWeeklyRepository["claimGenerationRun"]> | null = null;
    let diagnosticRun: WorkWeeklyDiagnosticRun | undefined;
    const assertActive = () => {
      if (request.signal?.aborted) throw Object.assign(new Error("weekly_generation_cancelled"), { code: "weekly_generation_cancelled" });
      if (!fence || !this.repository.canCaptureGeneration(request.accountId, fence)) throw new WorkWeeklyLeaseLostError();
    };
    const capture = async (event: WorkWeeklyDiagnosticEvent["event"], terminal = false) => {
      if (!this.diagnosticSink || !diagnosticRun || !fence) return;
      const ownedFence = fence;
      const canCapture = () => !request.signal?.aborted
        && this.repository.canCaptureGeneration(request.accountId, ownedFence, terminal);
      if (!canCapture()) return;
      try {
        await this.diagnosticSink({ run: diagnosticRun, event, canCapture });
      } catch {
        throw Object.assign(new Error("weekly_diagnostics_capture_failed"), { code: "weekly_diagnostics_capture_failed" });
      }
    };
    try {
      fence = this.repository.claimGenerationRun({
        accountId: request.accountId,
        runId: request.runId,
        leaseOwner: request.leaseOwner,
        leaseMs: request.leaseMs
      });
    } catch (error) {
      return {
        state: "not_claimed",
        kind: "generation",
        weeklyReviewId: request.weeklyReviewId,
        runId: request.runId,
        runVersion: request.runVersion,
        errorCode: errorCode(error, "weekly_generation_not_claimed")
      };
    }
    if (!contractMatches(request, fence)) {
      this.failGeneration(request.accountId, fence, "weekly_generation_contract_mismatch");
      return {
        state: "failed",
        kind: "generation",
        weeklyReviewId: request.weeklyReviewId,
        runId: request.runId,
        runVersion: request.runVersion,
        errorCode: "weekly_generation_contract_mismatch"
      };
    }
    try {
      const snapshot = await this.loadSnapshot({
        accountId: request.accountId,
        weeklyReviewId: request.weeklyReviewId
      });
      if (snapshot.accountId !== request.accountId
        || snapshot.digest !== request.sourceSnapshotDigest) {
        throw Object.assign(new Error("weekly_source_changed"), { code: "weekly_source_changed" });
      }
      diagnosticRun = {
        accountId: request.accountId, weeklyReviewId: request.weeklyReviewId,
        runId: request.runId, runVersion: request.runVersion,
        sourceSnapshotDigest: snapshot.digest, inputPackDigest: snapshot.inputPackDigest
      };
      assertActive();
      await capture({ stage: "started" });
      assertActive();
      if (this.providers.configurationError) {
        throw Object.assign(new Error(this.providers.configurationError), {
          code: this.providers.configurationError
        });
      }
      const result = await runWorkWeeklyGenerationPipeline({
        accountId: request.accountId,
        snapshot,
        synthesizer: this.providers.synthesizer,
        verifier: this.providers.weeklyVerifier,
        onBeforeVerify: () => this.repository.markGenerationVerifying(fence!),
        onTrace: async (trace) => {
          assertActive();
          await capture({ stage: "pipeline", trace });
          assertActive();
        },
        signal: request.signal
      });
      if (result.status !== "verified" && result.status !== "needs_review") {
        const code = `weekly_generation_${result.status}`;
        const qualityAssessment = result.status === "quality_insufficient"
          ? { status: "insufficient" as const } : undefined;
        this.failGeneration(request.accountId, fence, code, qualityAssessment);
        try { await capture({ stage: "finished", outcome: qualityAssessment ? "quality_insufficient" : "failed", errorCode: code }, true); }
        catch { console.warn("[work-weekly] diagnostics progress=1/1 state=failed reason=weekly_diagnostics_capture_failed"); }
        return {
          state: "failed",
          kind: "generation",
          weeklyReviewId: request.weeklyReviewId,
          runId: request.runId,
          runVersion: request.runVersion,
          errorCode: code
        };
      }
      assertActive();
      const qualityStatus = result.quality_assessment?.status;
      if ((qualityStatus !== "passed" && qualityStatus !== "needs_review") || result.items.length === 0
        || (result.status === "verified") !== (qualityStatus === "passed")) {
        throw Object.assign(new Error("weekly_generation_quality_not_established"), { code: "weekly_generation_quality_not_established" });
      }
      this.repository.publishSystemVersion({
        accountId: request.accountId,
        fence,
        currentSnapshot: snapshot,
        items: result.items,
        synthesizerProfile: result.synthesizerProfile,
        verifierProfile: result.verifierProfile,
        qualityAssessment: result.quality_assessment
      });
      // A diagnostic write after commit must never turn an already-published run into a failure.
      try { await capture({ stage: "finished", outcome: "published", errorCode: null,
        qualityStatus, publicationStatus: "persisted" }, true); }
      catch { console.warn("[work-weekly] diagnostics progress=1/1 state=failed reason=weekly_diagnostics_capture_failed"); }
      return {
        state: "published",
        kind: "generation",
        weeklyReviewId: request.weeklyReviewId,
        runId: request.runId,
        runVersion: request.runVersion
      };
    } catch (error) {
      const code = errorCode(error, "weekly_generation_failed");
      this.failGeneration(request.accountId, fence, code);
      try { await capture({ stage: "finished", outcome: "failed", errorCode: code }, true); }
      catch { console.warn("[work-weekly] diagnostics progress=1/1 state=failed reason=weekly_diagnostics_capture_failed"); }
      return {
        state: "failed",
        kind: "generation",
        weeklyReviewId: request.weeklyReviewId,
        runId: request.runId,
        runVersion: request.runVersion,
        errorCode: code
      };
    }
  }

  async terminateGenerationUnknownOutcome(
    request: WorkWeeklyUnknownOutcomeTerminationRequest
  ): Promise<WorkWeeklyRunResult> {
    let fence: ReturnType<WorkWeeklyRepository["claimGenerationRun"]> | null = null;
    try {
      fence = this.repository.claimGenerationRun({
        accountId: request.accountId,
        runId: request.runId,
        leaseOwner: request.leaseOwner,
        leaseMs: request.leaseMs
      });
    } catch (error) {
      return {
        state: "not_claimed", kind: "generation", weeklyReviewId: request.weeklyReviewId,
        runId: request.runId, runVersion: request.runVersion,
        errorCode: errorCode(error, "weekly_generation_not_claimed")
      };
    }
    const code = contractMatches(request, fence)
      ? "weekly_generation_provider_outcome_unknown"
      : "weekly_generation_contract_mismatch";
    this.failGeneration(request.accountId, fence, code);
    return {
      state: "failed", kind: "generation", weeklyReviewId: request.weeklyReviewId,
      runId: request.runId, runVersion: request.runVersion, errorCode: code
    };
  }

  private failGeneration(
    accountId: string,
    fence: NonNullable<ReturnType<WorkWeeklyRepository["claimGenerationRun"]>>,
    code: string,
    qualityAssessment?: { status: "insufficient" }
  ) {
    try {
      this.repository.markGenerationFailed({ accountId, fence, errorCode: code, qualityAssessment });
    } catch (error) {
      if (!(error instanceof WorkWeeklyLeaseLostError)) throw error;
    }
  }

  async runQa(request: WorkWeeklyQaRunRequest): Promise<WorkWeeklyRunResult> {
    let fence: ReturnType<WorkWeeklyRepository["claimQaRun"]> | null = null;
    try {
      fence = this.repository.claimQaRun({
        accountId: request.accountId,
        runId: request.runId,
        leaseOwner: request.leaseOwner,
        leaseMs: request.leaseMs
      });
    } catch (error) {
      return {
        state: "not_claimed",
        kind: "qa",
        weeklyReviewId: request.weeklyReviewId,
        runId: request.runId,
        runVersion: request.runVersion,
        errorCode: errorCode(error, "weekly_qa_not_claimed")
      };
    }
    if (!contractMatches(request, fence) || fence.threadId !== request.threadId) {
      this.failQa(request.accountId, fence, "weekly_qa_contract_mismatch");
      return {
        state: "failed",
        kind: "qa",
        weeklyReviewId: request.weeklyReviewId,
        runId: request.runId,
        runVersion: request.runVersion,
        errorCode: "weekly_qa_contract_mismatch"
      };
    }
    try {
      const snapshot = await this.loadSnapshot({
        accountId: request.accountId,
        weeklyReviewId: request.weeklyReviewId
      });
      if (snapshot.accountId !== request.accountId
        || snapshot.digest !== request.sourceSnapshotDigest) {
        throw Object.assign(new Error("weekly_source_changed"), { code: "weekly_source_changed" });
      }
      const thread = this.repository.getQaThread(request.accountId, request.weeklyReviewId);
      if (!thread || thread.thread.id !== request.threadId) {
        throw Object.assign(new Error("weekly_qa_thread_missing"), { code: "weekly_qa_thread_missing" });
      }
      const question = thread.messages.find((message) =>
        message.id === request.questionMessageId && message.role === "user"
      );
      if (!question?.text) {
        throw Object.assign(new Error("weekly_qa_question_missing"), { code: "weekly_qa_question_missing" });
      }
      const answer = await answerWorkWeeklyQuestion({
        accountId: request.accountId,
        weeklyReviewId: request.weeklyReviewId,
        snapshot,
        question: question.text,
        history: thread.messages as WorkWeeklyQaMessage[],
        answerer: this.providers.configurationError ? null : this.providers.qaAnswerer,
        verifier: this.providers.configurationError ? null : this.providers.qaVerifier,
        signal: request.signal
      });
      this.repository.publishQaAnswer({
        accountId: request.accountId,
        fence,
        currentSnapshot: snapshot,
        text: answer.answer,
        answerStatus: answer.answerStatus,
        sourceRefs: answer.sourceRefs,
        providerProfile: answer.providerProfile,
        promptVersion: answer.promptVersion,
        verifierProfile: answer.verifierProfile
      });
      return {
        state: "published",
        kind: "qa",
        weeklyReviewId: request.weeklyReviewId,
        runId: request.runId,
        runVersion: request.runVersion
      };
    } catch (error) {
      const code = errorCode(error, "weekly_qa_failed");
      this.failQa(request.accountId, fence, code);
      return {
        state: "failed",
        kind: "qa",
        weeklyReviewId: request.weeklyReviewId,
        runId: request.runId,
        runVersion: request.runVersion,
        errorCode: code
      };
    }
  }

  async terminateQaUnknownOutcome(
    request: WorkWeeklyQaUnknownOutcomeTerminationRequest
  ): Promise<WorkWeeklyRunResult> {
    let fence: ReturnType<WorkWeeklyRepository["claimQaRun"]> | null = null;
    try {
      fence = this.repository.claimQaRun({
        accountId: request.accountId,
        runId: request.runId,
        leaseOwner: request.leaseOwner,
        leaseMs: request.leaseMs
      });
    } catch (error) {
      return {
        state: "not_claimed", kind: "qa", weeklyReviewId: request.weeklyReviewId,
        runId: request.runId, runVersion: request.runVersion,
        errorCode: errorCode(error, "weekly_qa_not_claimed")
      };
    }
    const code = contractMatches(request, fence) && fence.threadId === request.threadId
      ? "weekly_qa_provider_outcome_unknown"
      : "weekly_qa_contract_mismatch";
    this.failQa(request.accountId, fence, code);
    return {
      state: "failed", kind: "qa", weeklyReviewId: request.weeklyReviewId,
      runId: request.runId, runVersion: request.runVersion, errorCode: code
    };
  }

  private failQa(
    accountId: string,
    fence: NonNullable<ReturnType<WorkWeeklyRepository["claimQaRun"]>>,
    code: string
  ) {
    try {
      this.repository.markQaRunFailed({ accountId, fence, errorCode: code });
    } catch (error) {
      if (!(error instanceof WorkWeeklyLeaseLostError)) throw error;
    }
  }
}

type ExecutorDependencies = {
  repository: WorkWeeklyRepository;
  loadSnapshot: SnapshotLoader;
  diagnosticSink?: WorkWeeklyDiagnosticSink;
};

/**
 * The only production factory for Queue Runtime. It owns Provider/profile/verifier/fallback choice.
 * Queue Runtime must only pass persisted run identity/fence inputs to the returned executor.
 */
export function createConfiguredWorkWeeklyRunExecutor(input: ExecutorDependencies & {
  env?: Readonly<Record<string, string | undefined>>;
  requestStructuredJson?: WorkWeeklyStructuredJsonRequest;
}): WorkWeeklyRunExecutor {
  const env = input.env ?? process.env;
  let providers: ProviderBundle = {
    synthesizer: null,
    weeklyVerifier: null,
    qaAnswerer: null,
    qaVerifier: null,
    configurationError: null
  };
  try {
    if (isWorkReviewWeeklyVerifierEnabled(env)) {
      providers.synthesizer = createStructuredWorkWeeklySynthesizer({
        profile: resolveWorkWeeklyProviderProfile("synthesizer", env),
        requestStructuredJson: input.requestStructuredJson
      });
      providers.weeklyVerifier = createStructuredWorkWeeklyClaimVerifier({
        profile: resolveWorkWeeklyProviderProfile("verifier", env),
        requestStructuredJson: input.requestStructuredJson
      });
    }
    if (isWorkReviewWeeklyQaVerifierEnabled(env)) {
      providers.qaAnswerer = createStructuredWorkWeeklyQaAnswerer({
        profile: resolveWorkWeeklyProviderProfile("qa_answerer", env),
        requestStructuredJson: input.requestStructuredJson
      });
      providers.qaVerifier = createStructuredWorkWeeklyQaVerifier({
        profile: resolveWorkWeeklyProviderProfile("qa_verifier", env),
        requestStructuredJson: input.requestStructuredJson
      });
    }
  } catch (error) {
    providers = {
      synthesizer: null,
      weeklyVerifier: null,
      qaAnswerer: null,
      qaVerifier: null,
      configurationError: errorCode(error, "weekly_provider_configuration_failed")
    };
  }
  return new DefaultWorkWeeklyRunExecutor(input.repository, input.loadSnapshot, providers, input.diagnosticSink);
}

/** Deterministic injected seam for focused tests only; production Runtime must use configured factory. */
export function createFixtureWorkWeeklyRunExecutor(input: ExecutorDependencies & {
  synthesizer: WorkWeeklySynthesizer | null;
  weeklyVerifier: WorkWeeklyClaimVerifier | null;
  qaAnswerer: WorkWeeklyQaAnswerer | null;
  qaVerifier: WorkWeeklyQaVerifier | null;
}): WorkWeeklyRunExecutor {
  return new DefaultWorkWeeklyRunExecutor(input.repository, input.loadSnapshot, {
    synthesizer: input.synthesizer,
    weeklyVerifier: input.weeklyVerifier,
    qaAnswerer: input.qaAnswerer,
    qaVerifier: input.qaVerifier,
    configurationError: null
  }, input.diagnosticSink);
}

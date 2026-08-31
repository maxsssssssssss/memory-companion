import type {
  CandidateAdmissionResult,
  ReflectionConfirmationCandidateSnapshotV2
} from "@/lib/domain/daily-reflection";
import { ReflectionConfirmationV2Schema } from "@/lib/domain/daily-reflection";
import type {
  DailyReflectionMemoryProposal,
  DailyReflectionMemoryProposalAcknowledgement,
  DailyReflectionMemoryProposalConfirmationRequirement
} from "@/lib/domain/daily-reflection-memory-proposal";

import {
  getDailyReflectionMemoryProposalService,
  type DailyReflectionMemoryProposalAdmissionResult
} from "./memory-proposal-service";
import {
  DailyReflectionConflictError,
  createDailyReflectionRepository,
  type DailyReflectionRepository
} from "./repository";
import { getDailyReflectionDatabase } from "./db";

type ProposalService = ReturnType<typeof getDailyReflectionMemoryProposalService>;

type FinalizeRepository = Pick<
  DailyReflectionRepository,
  | "completeAdmissionOperation"
  | "failAdmissionOperation"
  | "getAdmissionExecutionMethod"
  | "getAdmissionOperation"
  | "getConfirmation"
  | "getWorkingCard"
  | "listAdmissionResults"
  | "startAdmissionOperation"
>;

export class DailyReflectionMemoryProposalConfirmationRequiredError extends Error {
  readonly code = "daily_reflection_memory_proposal_confirmation_required";

  constructor(
    readonly proposalId: string,
    readonly cardId: string,
    readonly confirmationRequirements:
      DailyReflectionMemoryProposalAdmissionResult["confirmationRequirements"]
  ) {
    super("Daily Reflection Memory Proposal requires explicit confirmation");
    this.name = "DailyReflectionMemoryProposalConfirmationRequiredError";
  }
}

export type DailyReflectionMemoryProposalFinalizeDependencies = {
  repository: FinalizeRepository;
  proposalService: Pick<
    ProposalService,
    "admit" | "create" | "getByCard" | "publish"
  >;
  now?: () => string;
};

function proposalTypeForSnapshot(
  snapshot: ReflectionConfirmationCandidateSnapshotV2
): DailyReflectionMemoryProposal["memoryType"] {
  switch (snapshot.candidateKind) {
    case "insight":
      return "summary";
    case "open_question":
      return "question";
    case "decision":
      return "decision";
    case "user_action":
      return "commitment";
  }
}

function explicitSelectionAcknowledgements(
  requirements: DailyReflectionMemoryProposalConfirmationRequirement[]
): DailyReflectionMemoryProposalAcknowledgement[] | null {
  if (requirements.length === 0) return null;
  const acknowledgements = requirements.flatMap((requirement) => {
    switch (requirement.code) {
      case "acknowledge_sensitive_content":
      case "acknowledge_inference":
      case "acknowledge_attribution_uncertainty":
        return [requirement.code];
      case "verify_fact_owner":
        return [];
    }
  });
  return acknowledgements.length === requirements.length
    ? acknowledgements
    : null;
}

function projectedResult(
  candidateId: string,
  admitted: DailyReflectionMemoryProposalAdmissionResult
): CandidateAdmissionResult {
  if (admitted.status === "needs_confirmation") {
    throw new DailyReflectionMemoryProposalConfirmationRequiredError(
      admitted.proposal.id,
      candidateId,
      admitted.confirmationRequirements
    );
  }
  if (admitted.status === "rejected") {
    return {
      candidateId,
      status: "rejected",
      memoryId: null,
      reasonCode: admitted.reasons[0] ?? "memory_proposal_policy_rejected",
      errorCode: null,
      operationKey: admitted.proposal.operationKey,
      updatedAt: admitted.proposal.updatedAt
    };
  }
  if (admitted.status === "approved") {
    throw new DailyReflectionConflictError(
      "daily_reflection_memory_proposal_admission_incomplete"
    );
  }
  return {
    candidateId,
    status: admitted.status === "already_exists" ? "already_admitted" : "admitted",
    memoryId: admitted.memoryId,
    reasonCode: null,
    errorCode: null,
    operationKey: admitted.proposal.operationKey,
    updatedAt: admitted.proposal.updatedAt
  };
}

function retryableResult(
  candidateId: string,
  now: string
): CandidateAdmissionResult {
  return {
    candidateId,
    status: "retryable_error",
    memoryId: null,
    reasonCode: null,
    errorCode: "daily_reflection_memory_proposal_finalize_failed",
    operationKey: `daily-reflection-card:${candidateId}`,
    updatedAt: now
  };
}

export function createDailyReflectionMemoryProposalFinalizeService(
  dependencies: DailyReflectionMemoryProposalFinalizeDependencies
) {
  const now = dependencies.now ?? (() => new Date().toISOString());

  async function publishCompleted(
    accountId: string,
    results: CandidateAdmissionResult[]
  ) {
    const admitted = results.find(
      (item) => item.status === "admitted" || item.status === "already_admitted"
    );
    if (!admitted) return;
    const proposal = dependencies.proposalService.getByCard(
      accountId,
      admitted.candidateId
    );
    if (!proposal || proposal.status !== "admitted") {
      throw new DailyReflectionConflictError(
        "daily_reflection_memory_proposal_receipt_mismatch"
      );
    }
    await dependencies.proposalService.publish(accountId, proposal.id);
  }

  async function admitUnderLease(input: {
    accountId: string;
    reflectionId: string;
    leaseOwner: string;
    leaseDurationMs: number;
  }) {
    if (
      dependencies.repository.getAdmissionExecutionMethod(
        input.accountId,
        input.reflectionId
      ) !== "memory_proposal_v1"
    ) {
      throw new DailyReflectionConflictError(
        "daily_reflection_memory_proposal_execution_method_mismatch"
      );
    }
    const claimed = dependencies.repository.startAdmissionOperation(input);
    if (!claimed.executionFence) {
      const results = dependencies.repository.listAdmissionResults(
        input.accountId,
        claimed.operation.id
      );
      await publishCompleted(input.accountId, results);
      return { operation: claimed.operation, results, reused: true };
    }

    const confirmation = ReflectionConfirmationV2Schema.safeParse(
      dependencies.repository.getConfirmation(input.accountId, input.reflectionId)
    );
    if (
      !confirmation.success
      || confirmation.data.saveIntent !== "retain_selected"
    ) {
      throw new DailyReflectionConflictError(
        "daily_reflection_memory_proposal_confirmation_invalid"
      );
    }
    const kept = confirmation.data.candidateSnapshots
      .filter((snapshot) => snapshot.status === "kept")
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
    const results: CandidateAdmissionResult[] = [];
    let currentCandidateId: string | null = null;
    try {
      for (const snapshot of kept) {
        currentCandidateId = snapshot.candidateId;
        const card = dependencies.repository.getWorkingCard(
          input.accountId,
          snapshot.candidateId
        );
        const created = dependencies.proposalService.create({
          accountId: input.accountId,
          cardId: snapshot.candidateId,
          expectedCardVersion: card.version,
          memoryType: proposalTypeForSnapshot(snapshot)
        });
        let admitted = await dependencies.proposalService.admit({
          accountId: input.accountId,
          proposalId: created.proposal.id,
          expectedVersion: created.proposal.version,
          deferPublication: true
        });
        if (admitted.status === "needs_confirmation") {
          // A kept Card inside retain_selected came from an explicit user click on
          // “长期记住”. Treat that action as acknowledgement of ordinary soft
          // warnings, while verified-owner requirements remain fail-closed.
          const acknowledgements = explicitSelectionAcknowledgements(
            admitted.confirmationRequirements
          );
          if (acknowledgements) {
            admitted = await dependencies.proposalService.admit({
              accountId: input.accountId,
              proposalId: admitted.proposal.id,
              expectedVersion: admitted.proposal.version,
              acknowledgements,
              deferPublication: true
            });
          }
        }
        results.push(projectedResult(snapshot.candidateId, admitted));
        currentCandidateId = null;
      }
      // Publication is idempotent, but the outer operation is the client's
      // terminal receipt. Do not mark it completed before Memory is queryable.
      await publishCompleted(input.accountId, results);
      const completed = dependencies.repository.completeAdmissionOperation({
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        leaseOwner: claimed.executionFence.leaseOwner,
        attemptVersion: claimed.executionFence.attemptVersion,
        results
      });
      return completed;
    } catch (error) {
      if (
        currentCandidateId
        && !results.some((result) => result.candidateId === currentCandidateId)
      ) {
        results.push(retryableResult(currentCandidateId, now()));
      }
      try {
        dependencies.repository.failAdmissionOperation({
          accountId: input.accountId,
          reflectionId: input.reflectionId,
          leaseOwner: claimed.executionFence.leaseOwner,
          attemptVersion: claimed.executionFence.attemptVersion,
          errorCode: "daily_reflection_memory_proposal_finalize_failed",
          results
        });
      } catch {
        // A completed/delete-requested/lost-lease outer receipt remains authoritative.
      }
      throw error;
    }
  }

  return { admitUnderLease };
}

export function getDailyReflectionMemoryProposalFinalizeService() {
  return createDailyReflectionMemoryProposalFinalizeService({
    repository: createDailyReflectionRepository(getDailyReflectionDatabase()),
    proposalService: getDailyReflectionMemoryProposalService()
  });
}

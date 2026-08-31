import { createHash, randomUUID } from "node:crypto";

import {
  memoryProposalConfirmationRequirements,
  type DailyReflectionMemoryProposal,
  type DailyReflectionMemoryProposalAcknowledgement,
  type DailyReflectionMemoryProposalConfirmationRequirement
} from "@/lib/domain/daily-reflection-memory-proposal";
import type { TranscriptSegment } from "@/lib/domain/types";
import { evaluateMemoryAdmission } from "@/lib/server/memory/admission";
import {
  createDailyReflectionProposalAdmissionRepository,
  DailyReflectionProposalAdmissionError,
  type DailyReflectionProposalAdmissionInput,
  type DailyReflectionProposalAdmissionRepository
} from "@/lib/server/memory/daily-reflection-proposal-admission";
import { getMemoryDatabase } from "@/lib/server/memory/db";
import { resolveMemoryOwnerAttribution } from "@/lib/server/memory/owner-attribution";
import type { MemoryOwnerResolution } from "@/lib/server/memory/owner-attribution/types";
import type { MemoryEvidenceWrite, MemoryWriteInput } from "@/lib/server/memory/types";
import { getPersonRepository } from "@/lib/server/person";
import type { PersonRepository } from "@/lib/server/person/repository";
import { resolvePipelineExecutionMode } from "@/lib/server/queue/config";
import { enqueueEmbeddingIndexJob } from "@/lib/server/queue/producer";
import { resolveQaHybridRetrievalMode } from "@/lib/server/retrieval/hybrid/runtime-config";

import { getDailyReflectionDatabase } from "./db";
import {
  DAILY_REFLECTION_MEMORY_PROPOSAL_POLICY_VERSION,
  evaluateDailyReflectionMemoryProposalPolicy
} from "./memory-proposal-policy";
import {
  createDailyReflectionMemoryProposalRepository,
  DailyReflectionMemoryProposalLeaseLostError,
  type DailyReflectionMemoryProposalRepository,
  type DailyReflectionMemoryProposalSource
} from "./memory-proposal-repository";
import {
  DailyReflectionConflictError,
  DailyReflectionVersionConflictError
} from "./repository";

export type DailyReflectionMemoryProposalServiceErrorCode =
  | "daily_reflection_memory_proposal_source_invalid"
  | "daily_reflection_memory_proposal_person_path_unavailable"
  | "daily_reflection_memory_proposal_admission_conflict"
  | "daily_reflection_memory_proposal_publication_failed"
  | "daily_reflection_memory_proposal_revoked";

export class DailyReflectionMemoryProposalServiceError extends Error {
  constructor(readonly code: DailyReflectionMemoryProposalServiceErrorCode) {
    super(code);
    this.name = "DailyReflectionMemoryProposalServiceError";
  }
}

type ProposalRepository = Pick<
  DailyReflectionMemoryProposalRepository,
  | "create"
  | "get"
  | "getByCard"
  | "list"
  | "evaluate"
  | "startAdmission"
  | "completeAdmission"
  | "failAdmission"
  | "reject"
  | "getAdmissionSource"
  | "listEvents"
>;

type AdmissionRepository = Pick<
  DailyReflectionProposalAdmissionRepository,
  | "applyProposal"
  | "findByOperationKey"
  | "getProvenance"
  | "getPublication"
  | "markPublished"
>;

export type DailyReflectionMemoryProposalServiceDependencies = {
  proposalRepository: ProposalRepository;
  admissionRepository: AdmissionRepository;
  personRepository: Pick<PersonRepository, "getConfirmedPerson">;
  now?: () => string;
  leaseOwnerFactory?: () => string;
  leaseDurationMs?: number;
  onPublicationVisible?: (input: {
    accountId: string;
    reflectionId: string;
    uploadId: string;
  }) => Promise<unknown> | unknown;
};

export type DailyReflectionMemoryProposalAdmissionResult = {
  status: "approved" | "needs_confirmation" | "rejected" | "admitted" | "already_exists";
  proposal: DailyReflectionMemoryProposal;
  memoryId: string | null;
  reasons: string[];
  confirmationRequirements: DailyReflectionMemoryProposalConfirmationRequirement[];
};

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${digest(parts).slice(0, 32)}`;
}

function memoryTypeForProposal(
  type: DailyReflectionMemoryProposal["memoryType"]
): MemoryWriteInput["type"] {
  switch (type) {
    case "summary":
      return "summary";
    case "question":
      return "question";
    case "commitment":
      return "commitment";
    case "preference":
      return "preference";
    case "event":
      return "event";
    case "decision":
    case "person_fact":
      return "summary";
  }
}

function canonicalSegments(source: DailyReflectionMemoryProposalSource) {
  return source.evidenceSegments.map(({ effectiveOrigin: _effectiveOrigin, ...segment }) =>
    segment
  ) satisfies TranscriptSegment[];
}

function memoryForProposal(input: {
  proposal: DailyReflectionMemoryProposal;
  source: DailyReflectionMemoryProposalSource;
  now: string;
}) {
  if (!input.source.upload || !input.source.sourceValid) {
    throw new DailyReflectionMemoryProposalServiceError(
      "daily_reflection_memory_proposal_source_invalid"
    );
  }
  const memoryType = memoryTypeForProposal(input.proposal.memoryType);
  const memoryId = stableId(
    "daily_reflection_memory",
    input.proposal.accountId,
    input.proposal.reflectionId,
    input.proposal.id
  );
  const evidence: MemoryEvidenceWrite[] = canonicalSegments(input.source).map(
    (segment) => ({
      id: stableId("daily_reflection_evidence", memoryId, segment.id),
      sourceType: "transcript",
      sourceId: segment.id,
      uploadId: input.source.upload!.id,
      date: input.source.upload!.recordingDate,
      quote: segment.text.slice(0, 4_000),
      createdAt: input.proposal.createdAt
    })
  );
  const importanceReasons = [
    "daily_reflection: user saved Working Card",
    ...(input.proposal.policyVersion === DAILY_REFLECTION_MEMORY_PROPOSAL_POLICY_VERSION
      ? ["daily_reflection: user explicitly selected long-term retention"]
      : []),
    `daily_reflection: proposal type ${input.proposal.memoryType}`,
    `daily_reflection: epistemic status ${input.proposal.epistemicStatus}`,
    ...(input.proposal.epistemicCaution
      ? [`daily_reflection: epistemic caution ${input.proposal.epistemicCaution}`]
      : []),
    ...(input.proposal.memoryType === "event"
      ? ["extraction: contains a dated or completed activity"]
      : [])
  ];
  const explicitUncertainty = input.proposal.reasons.some(
    (reason) => reason === "user_confirmation:acknowledge_inference"
      || reason === "user_confirmation:acknowledge_attribution_uncertainty"
  );
  const v2Summary = input.proposal.sourceOrigin === "direct_conversation"
    ? `基于 ${input.source.upload.recordingDate} 的交流记录整理${
      explicitUncertainty ? "（用户确认作为待核实想法保留）" : ""
    }：${input.proposal.content}`
    : `用户在 ${input.source.upload.recordingDate} 的复盘中提到${
      explicitUncertainty ? "（作为待核实想法保留）" : ""
    }：${input.proposal.content}`;
  return {
    id: memoryId,
    type: memoryType,
    title: input.proposal.title.slice(0, 500),
    summary: (input.proposal.policyVersion === DAILY_REFLECTION_MEMORY_PROPOSAL_POLICY_VERSION
      ? v2Summary
      : input.proposal.epistemicStatus === "reported_event"
        ? `用户报告：${input.proposal.content}`
        : input.proposal.content
    ).slice(0, 4_000),
    importance: input.proposal.importance,
    importanceScore: input.proposal.importance,
    importanceReasons,
    status: "active",
    date: input.source.upload.recordingDate,
    createdAt: input.proposal.createdAt,
    updatedAt: input.proposal.createdAt,
    evidence
  } satisfies MemoryWriteInput;
}

function prepareAdmission(input: {
  proposal: DailyReflectionMemoryProposal;
  source: DailyReflectionMemoryProposalSource;
  now: string;
}) {
  const memory = memoryForProposal(input);
  const evidenceSegments = canonicalSegments(input.source);
  const sourceSegments = input.source.sourceSegments;
  const ownerAttribution = resolveMemoryOwnerAttribution({
    memoryId: memory.id,
    memoryType: memory.type,
    evidenceSegments
  });
  const evidenceDigests = memory.evidence.map((evidence) => ({
    memoryEvidenceId: evidence.id,
    sourceSegmentId: evidence.sourceId,
    contentDigest: digest({
      version: 1,
      accountId: input.proposal.accountId,
      reflectionId: input.proposal.reflectionId,
      uploadId: evidence.uploadId,
      sourceSegmentId: evidence.sourceId,
      quote: evidence.quote,
      sourceOrigin: input.proposal.sourceOrigin
    })
  }));
  const publicationContract = {
    version: 1,
    accountId: input.proposal.accountId,
    reflectionId: input.proposal.reflectionId,
    uploadId: input.source.upload!.id,
    sourceOrigin: input.proposal.sourceOrigin,
    inputAdapter: input.proposal.inputAdapter,
    capturePurpose: input.proposal.capturePurpose,
    recordingDate: input.proposal.recordingDate
  };
  const publicationId = stableId(
    "daily_reflection_publication",
    input.proposal.accountId,
    input.proposal.reflectionId
  );
  const publicationFingerprint = digest(publicationContract);
  const publicationDigest = digest({
    ...publicationContract,
    publicationId
  });
  const payloadDigest = digest({
    version: 1,
    proposalId: input.proposal.id,
    cardId: input.proposal.cardId,
    requestFingerprint: input.proposal.requestFingerprint,
    memory,
    ownerAttribution,
    evidenceDigests
  });
  return {
    memory,
    ownerAttribution,
    sourceSegments,
    evidenceDigests,
    payloadDigest,
    publicationId,
    publicationFingerprint,
    publicationDigest,
    admissionInput: {
      userId: input.proposal.accountId,
      reflectionId: input.proposal.reflectionId,
      proposalId: input.proposal.id,
      cardId: input.proposal.cardId,
      operationKey: input.proposal.operationKey,
      payloadDigest,
      publicationId,
      publicationFingerprint,
      publicationDigest,
      uploadId: input.source.upload!.id,
      sourceOrigin: input.proposal.sourceOrigin,
      inputAdapter: input.proposal.inputAdapter,
      capturePurpose: input.proposal.capturePurpose,
      recordingDate: input.proposal.recordingDate,
      memory,
      ownerAttribution,
      evidenceDigests,
      sourceSegments,
      personId: null,
      subjectPersonId: null,
      now: input.now
    } satisfies DailyReflectionProposalAdmissionInput
  };
}

function policyFor(input: {
  proposal: DailyReflectionMemoryProposal;
  source: DailyReflectionMemoryProposalSource;
  personExists: boolean;
  memory: MemoryWriteInput | null;
  ownerAttribution: MemoryOwnerResolution | null;
  acknowledgements: DailyReflectionMemoryProposalAcknowledgement[];
}) {
  let existingAdmissionEligible = false;
  let existingAdmissionReasons: string[] = [];
  if (!input.source.sourceValid || !input.memory || !input.ownerAttribution) {
    existingAdmissionReasons = [
      input.source.sourceInvalidReason ?? "canonical_source_invalid"
    ];
  } else if (input.proposal.memoryType === "person_fact") {
    existingAdmissionReasons = [
      "daily_reflection_memory_proposal_person_path_unavailable"
    ];
  } else {
    const existing = evaluateMemoryAdmission({
      memory: input.memory,
      ownerAttribution: input.ownerAttribution,
      sourceSegmentCount: input.source.evidenceSegments.length
    });
    existingAdmissionEligible = existing.shouldPersist;
    existingAdmissionReasons = existing.reasons;
  }
  return evaluateDailyReflectionMemoryProposalPolicy({
    memoryType: input.proposal.memoryType,
    cardStatus: "saved",
    cardKind: input.proposal.cardKind,
    actionClaimed: input.proposal.actionClaimed,
    epistemicStatus: input.proposal.epistemicStatus,
    epistemicCaution: input.proposal.epistemicCaution,
    riskFlags: input.proposal.riskFlags,
    sourceAvailable: input.source.sourceValid,
    evidenceValid: input.source.sourceValid
      && input.source.evidenceSegments.length === input.proposal.evidenceIds.length,
    subjectPersonConfirmed: input.proposal.subjectPersonId !== null && input.personExists,
    existingPersonPathEligible: false,
    verifiedOwnerAvailable: input.ownerAttribution?.scope === "individual"
      && input.ownerAttribution.owner.type === "known_identity",
    importance: input.proposal.importance,
    durability: input.proposal.durability,
    novelty: input.proposal.novelty,
    sensitivity: input.proposal.sensitivity,
    existingAdmissionEligible,
    existingAdmissionReasons,
    acknowledgements: input.acknowledgements
  });
}

function result(
  status: DailyReflectionMemoryProposalAdmissionResult["status"],
  proposal: DailyReflectionMemoryProposal,
  reasons = proposal.reasons
): DailyReflectionMemoryProposalAdmissionResult {
  return {
    status,
    proposal,
    memoryId: proposal.memoryId,
    reasons,
    confirmationRequirements: memoryProposalConfirmationRequirements(reasons)
  };
}

export function createDailyReflectionMemoryProposalService(
  dependencies: DailyReflectionMemoryProposalServiceDependencies
) {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const leaseOwnerFactory = dependencies.leaseOwnerFactory
    ?? (() => `daily_reflection_memory_proposal_worker_${randomUUID()}`);
  const leaseDurationMs = dependencies.leaseDurationMs ?? 60_000;

  function getPrepared(proposal: DailyReflectionMemoryProposal) {
    const source = dependencies.proposalRepository.getAdmissionSource(
      proposal.accountId,
      proposal.id
    );
    if (!source.sourceValid || !source.upload) {
      return { source, prepared: null };
    }
    return { source, prepared: prepareAdmission({ proposal, source, now: now() }) };
  }

  function create(input: {
    accountId: string;
    cardId: string;
    expectedCardVersion: number;
    memoryType: DailyReflectionMemoryProposal["memoryType"];
  }) {
    return dependencies.proposalRepository.create(input);
  }

  function get(accountId: string, proposalId: string) {
    return dependencies.proposalRepository.get(accountId, proposalId);
  }

  function getByCard(accountId: string, cardId: string) {
    return dependencies.proposalRepository.getByCard(accountId, cardId);
  }

  function list(input: {
    accountId: string;
    status?: DailyReflectionMemoryProposal["status"];
    limit?: number;
    offset?: number;
  }) {
    return dependencies.proposalRepository.list(input);
  }

  function evaluate(input: {
    accountId: string;
    proposalId: string;
    expectedVersion: number;
    acknowledgements?: DailyReflectionMemoryProposalAcknowledgement[];
  }) {
    const proposal = get(input.accountId, input.proposalId);
    if (proposal.version !== input.expectedVersion) {
      throw new DailyReflectionVersionConflictError(proposal.version);
    }
    const { source, prepared } = getPrepared(proposal);
    const personExists = proposal.subjectPersonId !== null
      && dependencies.personRepository.getConfirmedPerson(
        input.accountId,
        proposal.subjectPersonId
      ) !== null;
    const decision = policyFor({
      proposal,
      source,
      personExists,
      memory: prepared?.memory ?? null,
      ownerAttribution: prepared?.ownerAttribution ?? null,
      acknowledgements: input.acknowledgements ?? []
    });
    const evaluated = dependencies.proposalRepository.evaluate({
      accountId: input.accountId,
      proposalId: input.proposalId,
      expectedVersion: proposal.version,
      decision: decision.status,
      policyVersion: decision.policyVersion,
      score: decision.score,
      reasons: decision.reasons
    });
    return {
      decision,
      proposal: evaluated.proposal,
      reused: evaluated.reused
    };
  }

  async function publishVisible(input: {
    accountId: string;
    reflectionId: string;
    uploadId: string;
  }) {
    const publication = dependencies.admissionRepository.markPublished({
      userId: input.accountId,
      reflectionId: input.reflectionId,
      now: now()
    });
    if (!publication || publication.status !== "published") {
      throw new DailyReflectionMemoryProposalServiceError(
        "daily_reflection_memory_proposal_publication_failed"
      );
    }
    await dependencies.onPublicationVisible?.(input);
  }

  async function admit(input: {
    accountId: string;
    proposalId: string;
    expectedVersion: number;
    acknowledgements?: DailyReflectionMemoryProposalAcknowledgement[];
    deferPublication?: boolean;
  }): Promise<DailyReflectionMemoryProposalAdmissionResult> {
    let proposal = get(input.accountId, input.proposalId);
    const revoked = dependencies.proposalRepository
      .listEvents(input.accountId, input.proposalId)
      .some((event) => event.event_type === "revoked");
    if (revoked) {
      throw new DailyReflectionMemoryProposalServiceError(
        "daily_reflection_memory_proposal_revoked"
      );
    }
    if (proposal.status === "admitted") {
      const { source, prepared } = getPrepared(proposal);
      const authoritative = dependencies.admissionRepository.findByOperationKey({
        userId: input.accountId,
        operationKey: proposal.operationKey
      });
      if (
        !source.sourceValid
        || !source.upload
        || !prepared
        || !authoritative
        || authoritative.proposalId !== proposal.id
        || authoritative.cardId !== proposal.cardId
        || authoritative.payloadDigest !== prepared.payloadDigest
        || authoritative.memoryId !== proposal.memoryId
      ) {
        throw new DailyReflectionMemoryProposalServiceError(
          "daily_reflection_memory_proposal_revoked"
        );
      }
      dependencies.admissionRepository.applyProposal({
        ...prepared.admissionInput,
        now: now()
      });
      if (!input.deferPublication) {
        await publishVisible({
          accountId: input.accountId,
          reflectionId: proposal.reflectionId,
          uploadId: source.upload.id
        });
      }
      return result("already_exists", proposal);
    }
    const discoveredOperation = dependencies.admissionRepository.findByOperationKey({
      userId: input.accountId,
      operationKey: proposal.operationKey
    });
    const recoverableOperation = discoveredOperation
      && discoveredOperation.proposalId === proposal.id
      && discoveredOperation.cardId === proposal.cardId;
    if (proposal.version !== input.expectedVersion && !recoverableOperation) {
      throw new DailyReflectionVersionConflictError(proposal.version);
    }
    if (
      proposal.status === "pending"
      || (
        proposal.policyVersion !== DAILY_REFLECTION_MEMORY_PROPOSAL_POLICY_VERSION
        && !recoverableOperation
      )
    ) {
      const evaluated = evaluate({
        accountId: input.accountId,
        proposalId: input.proposalId,
        expectedVersion: proposal.version,
        acknowledgements: input.acknowledgements
      });
      proposal = evaluated.proposal;
      if (evaluated.decision.status === "needs_confirmation") {
        return result("needs_confirmation", proposal, evaluated.decision.reasons);
      }
    }
    if (proposal.status === "rejected") return result("rejected", proposal);
    if (proposal.status !== "approved") {
      throw new DailyReflectionConflictError(
        "daily_reflection_memory_proposal_not_approved"
      );
    }

    const leaseOwner = leaseOwnerFactory();
    const claim = dependencies.proposalRepository.startAdmission({
      accountId: input.accountId,
      proposalId: input.proposalId,
      leaseOwner,
      leaseDurationMs,
      now: now()
    });
    if (!claim.executionFence) {
      if (claim.proposal.status === "admitted") {
        return admit({
          accountId: input.accountId,
          proposalId: input.proposalId,
          expectedVersion: claim.proposal.version,
          acknowledgements: input.acknowledgements,
          deferPublication: input.deferPublication
        });
      }
      return result("rejected", claim.proposal);
    }

    let sourceInvalid = false;
    try {
      proposal = claim.proposal;
      const { source, prepared } = getPrepared(proposal);
      if (!source.sourceValid || !source.upload || !prepared) {
        sourceInvalid = true;
        throw new DailyReflectionMemoryProposalServiceError(
          "daily_reflection_memory_proposal_source_invalid"
        );
      }
      if (proposal.memoryType === "person_fact") {
        throw new DailyReflectionMemoryProposalServiceError(
          "daily_reflection_memory_proposal_person_path_unavailable"
        );
      }
      if (discoveredOperation && (
        discoveredOperation.proposalId !== proposal.id
        || discoveredOperation.cardId !== proposal.cardId
        || discoveredOperation.payloadDigest !== prepared.payloadDigest
      )) {
        throw new DailyReflectionMemoryProposalServiceError(
          "daily_reflection_memory_proposal_admission_conflict"
        );
      }
      const applied = dependencies.admissionRepository.applyProposal({
        ...prepared.admissionInput,
        now: now()
      });
      const completed = dependencies.proposalRepository.completeAdmission({
        accountId: input.accountId,
        proposalId: input.proposalId,
        leaseOwner: claim.executionFence.leaseOwner,
        attemptVersion: claim.executionFence.attemptVersion,
        memoryId: applied.memoryId,
        recovered: applied.status === "already_exists",
        now: now()
      }).proposal;
      if (!input.deferPublication) {
        await publishVisible({
          accountId: input.accountId,
          reflectionId: proposal.reflectionId,
          uploadId: source.upload.id
        });
      }
      return result(
        applied.status === "already_exists" ? "already_exists" : "admitted",
        completed
      );
    } catch (error) {
      try {
        dependencies.proposalRepository.failAdmission({
          accountId: input.accountId,
          proposalId: input.proposalId,
          leaseOwner: claim.executionFence.leaseOwner,
          attemptVersion: claim.executionFence.attemptVersion,
          errorCode: error instanceof DailyReflectionProposalAdmissionError
            ? error.code
            : error instanceof DailyReflectionMemoryProposalServiceError
              ? error.code
              : "daily_reflection_memory_proposal_admission_failed",
          now: now()
        });
      } catch (failure) {
        if (!(failure instanceof DailyReflectionMemoryProposalLeaseLostError)) {
          // The original admission error remains authoritative.
        }
      }
      if (sourceInvalid) {
        try {
          dependencies.proposalRepository.reject({
            accountId: input.accountId,
            proposalId: input.proposalId,
            reason: "canonical_source_invalid"
          });
        } catch {
          // A concurrent delete/revocation remains authoritative.
        }
      }
      throw error;
    }
  }

  function provenance(accountId: string, proposalId: string) {
    const proposal = get(accountId, proposalId);
    const publication = dependencies.admissionRepository.getPublication(
      accountId,
      proposal.reflectionId
    );
    const evidence = dependencies.admissionRepository.getProvenance({
      userId: accountId,
      proposalId,
      cardId: proposal.cardId
    }).map((item) => ({
      memoryEvidenceId: item.memoryEvidenceId,
      sourceSegmentId: item.sourceSegmentId,
      uploadId: item.uploadId,
      effectiveOrigin: item.sourceOrigin,
      contentDigest: item.contentDigest,
      createdAt: item.createdAt
    }));
    const revoked = dependencies.proposalRepository
      .listEvents(accountId, proposalId)
      .some((event) => event.event_type === "revoked");
    return {
      proposal,
      publicationId: publication?.id ?? null,
      publicationStatus: publication?.status === "published"
        ? "published" as const
        : publication?.status === "unpublished"
          ? "unpublished" as const
          : publication?.status === "deleted"
            ? "deleted" as const
            : null,
      memoryId: proposal.memoryId,
      revoked,
      evidence
    };
  }

  async function publish(accountId: string, proposalId: string) {
    const proposal = get(accountId, proposalId);
    if (proposal.status !== "admitted") {
      throw new DailyReflectionConflictError(
        "daily_reflection_memory_proposal_not_admitted"
      );
    }
    return admit({
      accountId,
      proposalId,
      expectedVersion: proposal.version
    });
  }

  return { create, get, getByCard, list, evaluate, admit, publish, provenance };
}

export function getDailyReflectionMemoryProposalService() {
  const proposalRepository = createDailyReflectionMemoryProposalRepository(
    getDailyReflectionDatabase()
  );
  const admissionRepository = createDailyReflectionProposalAdmissionRepository(
    getMemoryDatabase()
  );
  return createDailyReflectionMemoryProposalService({
    proposalRepository,
    admissionRepository,
    personRepository: getPersonRepository(),
    onPublicationVisible: async ({ accountId }) => {
      if (
        resolvePipelineExecutionMode() === "queue"
        && resolveQaHybridRetrievalMode() !== "off"
      ) {
        await enqueueEmbeddingIndexJob({
          version: 1,
          userRef: accountId,
          reason: "upload_ready"
        });
      }
    }
  });
}

import { createHash } from "node:crypto";
import { z } from "zod";

import {
  ReflectionConfirmationSchema,
  type CandidateAdmissionResult,
  type ReflectionConfirmationCandidateSnapshot
} from "@/lib/domain/daily-reflection";
import {
  AudioUploadSchema,
  TranscriptSegmentSchema,
  type AudioUpload,
  type TranscriptSegment
} from "@/lib/domain/types";
import { evaluateMemoryAdmission } from "@/lib/server/memory/admission";
import {
  createDailyReflectionMemoryPublicationRepository,
  type DailyReflectionMemoryPublicationRepository,
  type DailyReflectionPublicationCandidate
} from "@/lib/server/memory/daily-reflection-publication";
import { getMemoryDatabase } from "@/lib/server/memory/db";
import { resolveMemoryOwnerAttribution } from "@/lib/server/memory/owner-attribution";
import type { MemoryEvidenceWrite, MemoryWriteInput } from "@/lib/server/memory/types";
import { validatePersonTranscriptEvidence } from "@/lib/server/person/evidence";
import { getPersonRepository } from "@/lib/server/person";
import type { PersonRepository } from "@/lib/server/person/repository";
import { resolvePipelineExecutionMode } from "@/lib/server/queue/config";
import { enqueueEmbeddingIndexJob } from "@/lib/server/queue/producer";
import { resolveQaHybridRetrievalMode } from "@/lib/server/retrieval/hybrid/runtime-config";

import { getDailyReflectionDatabase } from "./db";
import {
  createDailyReflectionRepository,
  type DailyReflectionRepository
} from "./repository";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export type DailyReflectionMemoryAdmissionErrorCode =
  | "daily_reflection_confirmation_missing"
  | "daily_reflection_confirmation_invalid"
  | "daily_reflection_origin_not_supported"
  | "daily_reflection_canonical_evidence_invalid";

export class DailyReflectionMemoryAdmissionError extends Error {
  constructor(readonly code: DailyReflectionMemoryAdmissionErrorCode) {
    super(code);
    this.name = "DailyReflectionMemoryAdmissionError";
  }
}

type SourceRepository = Pick<
  DailyReflectionRepository,
  "getConfirmation" | "getProcessingPlan" | "getReflection" | "readPublishedAsset"
>;

type AdmissionOperationRepository = Pick<
  DailyReflectionRepository,
  | "startAdmissionOperation"
  | "completeAdmissionOperation"
  | "failAdmissionOperation"
  | "listAdmissionResults"
>;

export type DailyReflectionMemoryAdmissionDependencies = {
  sourceRepository: SourceRepository;
  publicationRepository: DailyReflectionMemoryPublicationRepository;
  personRepository: Pick<PersonRepository, "getConfirmedPerson">;
  now?: () => string;
  onPublicationVisible?: (input: {
    accountId: string;
    reflectionId: string;
    uploadId: string;
  }) => Promise<unknown> | unknown;
};

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${digest(parts).slice(0, 32)}`;
}

function titleFor(value: string) {
  const firstLine = value.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? value.trim();
  return firstLine.slice(0, 500);
}

function memoryForCandidate(input: {
  accountId: string;
  reflectionId: string;
  confirmationCreatedAt: string;
  upload: AudioUpload;
  candidate: ReflectionConfirmationCandidateSnapshot;
  segments: TranscriptSegment[];
}) {
  const memoryId = stableId(
    "daily_reflection_memory",
    input.accountId,
    input.reflectionId,
    input.candidate.candidateId
  );
  const evidence: MemoryEvidenceWrite[] = input.segments.map((segment) => ({
    id: stableId("daily_reflection_evidence", memoryId, segment.id),
    sourceType: "transcript",
    sourceId: segment.id,
    uploadId: input.upload.id,
    date: input.upload.recordingDate,
    quote: segment.text.slice(0, 4_000),
    createdAt: input.confirmationCreatedAt
  }));
  return {
    id: memoryId,
    type: input.candidate.candidateType,
    title: titleFor(input.candidate.finalText),
    summary: input.candidate.finalText.slice(0, 4_000),
    importance: 0.5,
    importanceReasons: ["extraction: explicit daily reflection confirmation"],
    status: "active",
    date: input.upload.recordingDate,
    createdAt: input.confirmationCreatedAt,
    updatedAt: input.confirmationCreatedAt,
    evidence
  } satisfies MemoryWriteInput;
}

function canonicalStore(input: {
  upload: AudioUpload;
  segments: TranscriptSegment[];
}) {
  const readyProjection = { ...input.upload, status: "ready" as const };
  return {
    async read<T>(collection: string, id: string): Promise<T | null> {
      if (collection === "uploads" && id === input.upload.id) {
        return readyProjection as T;
      }
      if (collection === "segments" && id === input.upload.id) {
        return input.segments as T;
      }
      return null;
    }
  };
}

function canonicalAssets(input: {
  accountId: string;
  reflectionId: string;
  confirmationFingerprint: string;
  sourceRepository: SourceRepository;
}) {
  const confirmationRaw = input.sourceRepository.getConfirmation(
    input.accountId,
    input.reflectionId
  );
  if (!confirmationRaw) {
    throw new DailyReflectionMemoryAdmissionError("daily_reflection_confirmation_missing");
  }
  const confirmation = ReflectionConfirmationSchema.safeParse(confirmationRaw);
  if (
    !confirmation.success
    || confirmation.data.accountId !== input.accountId
    || confirmation.data.reflectionId !== input.reflectionId
    || confirmation.data.fingerprint !== input.confirmationFingerprint
    || !HASH_PATTERN.test(confirmation.data.fingerprint)
  ) {
    throw new DailyReflectionMemoryAdmissionError("daily_reflection_confirmation_invalid");
  }
  if (confirmation.data.sourceOrigin !== "user_reflection") {
    throw new DailyReflectionMemoryAdmissionError("daily_reflection_origin_not_supported");
  }
  const kept = confirmation.data.candidateSnapshots.filter(
    (candidate) => candidate.status === "kept"
  );
  if (kept.length === 0) {
    return { confirmation: confirmation.data, kept, upload: null, segments: [] };
  }

  const reflection = input.sourceRepository.getReflection(input.accountId, input.reflectionId);
  const plan = input.sourceRepository.getProcessingPlan(input.accountId, input.reflectionId);
  const rawUpload = input.sourceRepository.readPublishedAsset<unknown>({
    accountId: input.accountId,
    reflectionId: input.reflectionId,
    assetKind: "upload"
  });
  const rawSegments = input.sourceRepository.readPublishedAsset<unknown>({
    accountId: input.accountId,
    reflectionId: input.reflectionId,
    assetKind: "segments"
  });
  const upload = AudioUploadSchema.safeParse(rawUpload);
  const segments = z.array(TranscriptSegmentSchema).safeParse(rawSegments);
  if (
    !reflection
    || ![
      "confirmation_ready",
      "admitting",
      "completed",
      "admission_failed"
    ].includes(reflection.status)
    || reflection.accountId !== input.accountId
    || reflection.id !== input.reflectionId
    || !plan
    || plan.reflectionId !== input.reflectionId
    || plan.sourceOrigin !== "user_reflection"
    || plan.ingestionContext !== "daily_reflection"
    || plan.reviewPolicy !== "required"
    || !upload.success
    || upload.data.id !== plan.uploadId
    || reflection.uploadId !== plan.uploadId
    || !segments.success
    || segments.data.length === 0
    || new Set(segments.data.map((segment) => segment.id)).size !== segments.data.length
    || segments.data.some((segment) => segment.uploadId !== upload.data.id)
  ) {
    throw new DailyReflectionMemoryAdmissionError(
      "daily_reflection_canonical_evidence_invalid"
    );
  }
  const segmentIds = new Set(segments.data.map((segment) => segment.id));
  const segmentById = new Map(segments.data.map((segment) => [segment.id, segment]));
  if (kept.some((candidate) =>
    new Set(candidate.sourceSegmentIds).size !== candidate.sourceSegmentIds.length
    || candidate.evidenceSnapshots.length !== candidate.sourceSegmentIds.length
    || new Set(candidate.evidenceSnapshots.map((snapshot) => snapshot.sourceSegmentId)).size
      !== candidate.evidenceSnapshots.length
    || candidate.sourceSegmentIds.some((id) => !segmentIds.has(id))
    || candidate.evidenceSnapshots.some(
      (snapshot) => !candidate.sourceSegmentIds.includes(snapshot.sourceSegmentId)
    )
    || candidate.evidenceSnapshots.some((snapshot) => {
      const segment = segmentById.get(snapshot.sourceSegmentId);
      return !segment
        || snapshot.uploadId !== upload.data.id
        || snapshot.effectiveOrigin !== "user_reflection"
        || snapshot.startSeconds !== segment.startSeconds
        || snapshot.endSeconds !== segment.endSeconds
        || snapshot.text !== segment.text;
    })
  )) {
    throw new DailyReflectionMemoryAdmissionError(
      "daily_reflection_canonical_evidence_invalid"
    );
  }
  return {
    confirmation: confirmation.data,
    kept,
    upload: upload.data,
    segments: segments.data
  };
}

export function createDailyReflectionMemoryAdmissionService(
  dependencies: DailyReflectionMemoryAdmissionDependencies
) {
  const now = dependencies.now ?? (() => new Date().toISOString());

  async function admit(input: {
    accountId: string;
    reflectionId: string;
    confirmationFingerprint: string;
  }): Promise<CandidateAdmissionResult[]> {
    const canonical = canonicalAssets({
      ...input,
      sourceRepository: dependencies.sourceRepository
    });
    if (canonical.kept.length === 0 || !canonical.upload) return [];

    const segmentById = new Map(canonical.segments.map((segment) => [segment.id, segment]));
    const store = canonicalStore({ upload: canonical.upload, segments: canonical.segments });
    const candidates: DailyReflectionPublicationCandidate[] = [];
    for (const candidate of canonical.kept) {
      const evidenceSegments = candidate.sourceSegmentIds.map((id) => segmentById.get(id)!);
      const memory = memoryForCandidate({
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        confirmationCreatedAt: canonical.confirmation.createdAt,
        upload: canonical.upload,
        candidate,
        segments: evidenceSegments
      });
      const operationKey = stableId(
        "daily_reflection_admission",
        input.accountId,
        input.reflectionId,
        canonical.confirmation.id,
        canonical.confirmation.fingerprint,
        candidate.candidateId
      );
      const ownerAttribution = resolveMemoryOwnerAttribution({
        memoryId: memory.id,
        memoryType: memory.type,
        evidenceSegments
      });
      const admission = evaluateMemoryAdmission({
        memory,
        ownerAttribution,
        sourceSegmentCount: evidenceSegments.length
      });
      let reasonCode: string | null = null;
      if (ownerAttribution.owner.type !== "known_identity") {
        reasonCode = "verified_owner_required";
      } else if (!admission.shouldPersist) {
        reasonCode = admission.reasons[0] ?? "memory_admission_rejected";
      } else if (
        candidate.subjectPersonId
        && !dependencies.personRepository.getConfirmedPerson(
          input.accountId,
          candidate.subjectPersonId
        )
      ) {
        reasonCode = "subject_person_not_confirmed";
      }

      const admitted = reasonCode === null;
      const subjectEvidence = admitted && candidate.subjectPersonId
        ? await Promise.all(evidenceSegments.map((segment) =>
            validatePersonTranscriptEvidence({
              store,
              authenticatedAccountId: input.accountId,
              accountId: input.accountId,
              uploadId: canonical.upload!.id,
              sourceSegmentId: segment.id,
              quote: segment.text
            })
          ))
        : [];
      candidates.push({
        candidateId: candidate.candidateId,
        operationKey,
        status: admitted ? "admitted" : "rejected",
        reasonCode,
        memory: admitted ? memory : null,
        ownerAttribution: admitted ? ownerAttribution : null,
        subjectPersonId: admitted ? candidate.subjectPersonId : null,
        subjectEvidence,
        evidenceDigests: admitted ? memory.evidence.map((evidence) => ({
          memoryEvidenceId: evidence.id,
          sourceSegmentId: evidence.sourceId,
          contentDigest: digest({
            version: 1,
            accountId: input.accountId,
            reflectionId: input.reflectionId,
            uploadId: evidence.uploadId,
            sourceSegmentId: evidence.sourceId,
            quote: evidence.quote,
            sourceOrigin: canonical.confirmation.sourceOrigin
          })
        })) : []
      });
    }

    const admittedCount = candidates.filter((candidate) => candidate.status === "admitted").length;
    if (admittedCount === 0) {
      const updatedAt = now();
      return candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        status: "rejected",
        memoryId: null,
        reasonCode: candidate.reasonCode,
        errorCode: null,
        operationKey: candidate.operationKey,
        updatedAt
      }));
    }

    const payloadDigest = digest({
      version: 1,
      accountId: input.accountId,
      reflectionId: input.reflectionId,
      confirmationId: canonical.confirmation.id,
      confirmationFingerprint: canonical.confirmation.fingerprint,
      uploadId: canonical.upload.id,
      candidates: candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        operationKey: candidate.operationKey,
        status: candidate.status,
        reasonCode: candidate.reasonCode,
        memory: candidate.memory,
        subjectPersonId: candidate.subjectPersonId,
        evidenceDigests: candidate.evidenceDigests
      }))
    });
    const updatedAt = now();
    const published = dependencies.publicationRepository.publish({
      id: stableId(
        "daily_reflection_publication",
        input.accountId,
        input.reflectionId,
        canonical.confirmation.id
      ),
      userId: input.accountId,
      reflectionId: input.reflectionId,
      confirmationId: canonical.confirmation.id,
      confirmationFingerprint: canonical.confirmation.fingerprint,
      uploadId: canonical.upload.id,
      sourceOrigin: "user_reflection",
      payloadDigest,
      sourceSegments: canonical.segments,
      candidates,
      now: updatedAt
    });
    return published.results.map((result) => ({
      candidateId: result.candidateId,
      status: result.status,
      memoryId: result.memoryId,
      reasonCode: result.reasonCode,
      errorCode: null,
      operationKey: result.operationKey,
      updatedAt
    }));
  }

  return { admit };
}

export function createDailyReflectionMemoryAdmissionOrchestrator(
  dependencies: DailyReflectionMemoryAdmissionDependencies & {
    sourceRepository: SourceRepository & AdmissionOperationRepository;
  }
) {
  const service = createDailyReflectionMemoryAdmissionService(dependencies);

  async function makePublicationVisible(input: {
    accountId: string;
    reflectionId: string;
    results: CandidateAdmissionResult[];
  }) {
    if (!input.results.some((result) => result.memoryId !== null)) return;
    const published = dependencies.publicationRepository.markPublished({
      userId: input.accountId,
      reflectionId: input.reflectionId,
      now: dependencies.now?.() ?? new Date().toISOString()
    });
    if (!published || published.status !== "published") {
      throw new DailyReflectionMemoryAdmissionError(
        "daily_reflection_canonical_evidence_invalid"
      );
    }
    await dependencies.onPublicationVisible?.({
      accountId: input.accountId,
      reflectionId: input.reflectionId,
      uploadId: published.upload_id
    });
  }

  async function admitUnderLease(input: {
    accountId: string;
    reflectionId: string;
    leaseOwner: string;
    leaseDurationMs: number;
    now?: string;
  }): Promise<CandidateAdmissionResult[]> {
    const claim = dependencies.sourceRepository.startAdmissionOperation(input);
    const executionFence = claim.executionFence;
    if (!executionFence) {
      const results = dependencies.sourceRepository.listAdmissionResults(
        input.accountId,
        claim.operation.id
      );
      await makePublicationVisible({ ...input, results });
      return results;
    }

    let results: CandidateAdmissionResult[] = [];
    try {
      const confirmation = dependencies.sourceRepository.getConfirmation(
        input.accountId,
        input.reflectionId
      );
      if (!confirmation) {
        throw new DailyReflectionMemoryAdmissionError("daily_reflection_confirmation_missing");
      }
      results = await service.admit({
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        confirmationFingerprint: confirmation.fingerprint
      });
      const completed = dependencies.sourceRepository.completeAdmissionOperation({
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        leaseOwner: executionFence.leaseOwner,
        attemptVersion: executionFence.attemptVersion,
        results,
        now: input.now
      });
      await makePublicationVisible({ ...input, results: completed.results });
      return completed.results;
    } catch (error) {
      try {
        dependencies.sourceRepository.failAdmissionOperation({
          accountId: input.accountId,
          reflectionId: input.reflectionId,
          leaseOwner: executionFence.leaseOwner,
          attemptVersion: executionFence.attemptVersion,
          errorCode: error instanceof DailyReflectionMemoryAdmissionError
            ? error.code
            : "daily_reflection_memory_admission_failed",
          results,
          now: input.now
        });
      } catch {
        // A stale attempt must not be allowed to overwrite the current operation.
      }
      throw error;
    }
  }

  return { admitUnderLease };
}

export function getDailyReflectionMemoryAdmissionService() {
  const memoryDatabase = getMemoryDatabase();
  return createDailyReflectionMemoryAdmissionOrchestrator({
    sourceRepository: createDailyReflectionRepository(getDailyReflectionDatabase()),
    publicationRepository: createDailyReflectionMemoryPublicationRepository(memoryDatabase),
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

import type {
  AudioUpload,
  BriefItem,
  RelationshipSignalCard,
  SemanticSegment,
  TranscriptSegment
} from "@/lib/domain/types";
import type { IdentityResolverAudit } from "@/lib/server/speaker-identity/identity-resolver";
import type { JsonStore } from "@/lib/server/storage/json-store";

import { getMemoryDatabase } from "./db";
import { extractUploadMemoriesWithAudit } from "./extractor";
import {
  MemoryOwnerReviewRepository,
  type MemoryOwnerReviewOverride
} from "./owner-review";
import { createMemoryRepository } from "./repository";
import type { MemoryRepository } from "./types";

type StoredUpload = AudioUpload & { filePath?: string };

type StoredRelationshipLifecycle = {
  edges: import("@/lib/server/relationship-signals/lifecycle/types").RelationshipLifecycleEdge[];
  candidateIdsByCardId?: Record<string, string[]>;
};

export async function reprocessUploadMemoryForOwnerReview(input: {
  store: JsonStore;
  userId: string;
  uploadId: string;
  targetCandidateId: string;
  targetDecision: "confirm_owner" | "keep_daily_only" | "revoke_confirmation";
  targetOwnerIdentityId?: string;
  repository?: Pick<MemoryRepository, "replaceUploadMemories">;
  now?: () => string;
}) {
  const [
    upload,
    segments,
    briefItems,
    semanticSegments,
    relationshipSignals,
    relationshipLifecycle,
    identityAudit
  ] = await Promise.all([
    input.store.read<StoredUpload>("uploads", input.uploadId),
    input.store.read<TranscriptSegment[]>("segments", input.uploadId),
    input.store.read<BriefItem[]>("brief-items", input.uploadId),
    input.store.read<SemanticSegment[]>("semantic-segments", input.uploadId),
    input.store.read<RelationshipSignalCard[]>("relationship-signals", input.uploadId),
    input.store.read<StoredRelationshipLifecycle>("relationship-lifecycle", input.uploadId),
    input.store.read<IdentityResolverAudit>("speaker-identities", input.uploadId)
  ]);
  if (!upload) throw new Error("owner_review_upload_not_found");

  const reviewRepository = new MemoryOwnerReviewRepository(input.store, input.now);
  const candidates = await reviewRepository.listCandidates(input.uploadId);
  const target = candidates.find(
    (candidate) => candidate.candidateId === input.targetCandidateId
  );
  if (!target) throw new Error("owner_review_candidate_not_found");

  const overrides: MemoryOwnerReviewOverride[] = candidates.flatMap((candidate) => {
    if (candidate.candidateId === input.targetCandidateId) {
      return input.targetDecision === "confirm_owner" && input.targetOwnerIdentityId
        ? [{
            candidateId: candidate.candidateId,
            evidenceDigest: candidate.evidenceDigest,
            ownerIdentityId: input.targetOwnerIdentityId
          }]
        : [];
    }
    return candidate.status === "confirmed" && candidate.confirmedOwnerIdentityId
      ? [{
          candidateId: candidate.candidateId,
          evidenceDigest: candidate.evidenceDigest,
          ownerIdentityId: candidate.confirmedOwnerIdentityId
        }]
      : [];
  });

  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const extraction = extractUploadMemoriesWithAudit({
    userId: input.userId,
    uploadId: input.uploadId,
    recordingDate: upload.recordingDate,
    segments: segments ?? [],
    briefItems: briefItems ?? [],
    semanticSegments: semanticSegments ?? [],
    relationshipSignals: relationshipSignals ?? [],
    ...(relationshipLifecycle ? { relationshipLifecycle } : {}),
    ...(identityAudit?.structuralGate ? {
      identityStructuralGate: {
        status: identityAudit.structuralGate.status,
        reasons: identityAudit.structuralGate.reasons
      }
    } : {}),
    ownerReviewOverrides: overrides,
    now: timestamp
  });

  if (
    input.targetDecision === "confirm_owner" &&
    !extraction.appliedOwnerReviewCandidateIds.includes(input.targetCandidateId)
  ) {
    throw new Error("owner_review_evidence_stale");
  }

  const repository = input.repository ?? createMemoryRepository(getMemoryDatabase());
  const result = repository.replaceUploadMemories({
    userId: input.userId,
    uploadId: input.uploadId,
    sourceSegments: segments ?? [],
    memories: extraction.memories,
    ownerAttributions: extraction.ownerAttributions
  });
  await input.store.write(
    "memory-owner-audits",
    input.uploadId,
    extraction.audit.ownerAttribution
  );
  return {
    result,
    audit: extraction.audit,
    appliedOwnerReviewCandidateIds: extraction.appliedOwnerReviewCandidateIds
  };
}

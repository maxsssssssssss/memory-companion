// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AudioUpload, TranscriptSegment } from "@/lib/domain/types";
import { JsonStore } from "@/lib/server/storage/json-store";

import { extractUploadMemoriesWithAudit } from "./extractor";
import {
  memoryOwnerReviewCandidateId,
  memoryOwnerReviewEvidenceDigest,
  MemoryOwnerReviewCandidateSchema,
  MemoryOwnerReviewRepository
} from "./owner-review";
import { reprocessUploadMemoryForOwnerReview } from "./reprocess-owner-review";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("Memory-only owner review reprocessing", () => {
  it("applies a confirmed owner and removes it again on revoke without rerunning upstream stages", async () => {
    const root = await mkdtemp(join(tmpdir(), "owner-review-reprocess-"));
    temporaryDirectories.push(root);
    const store = new JsonStore(join(root, "data"));
    const segment: TranscriptSegment = {
      id: "segment_1",
      uploadId: "upload_1",
      startSeconds: 1,
      endSeconds: 4,
      speaker: "Alice",
      identity: {
        globalSpeakerId: "unknown_alice",
        identityType: "unknown_person",
        confidence: null,
        source: "provider_speaker_result",
        evidence: {
          type: "provider_label",
          provider: "company_voiceprint",
          providerLabel: "Alice"
        }
      },
      text: "我不喜欢香菜。",
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: []
    };
    const upload: AudioUpload = {
      id: "upload_1",
      originalName: "sample.wav",
      mimeType: "audio/wav",
      sizeBytes: 10,
      recordingDate: "2026-07-30",
      durationSeconds: 5,
      status: "ready"
    };
    await Promise.all([
      store.write("uploads", upload.id, upload),
      store.write("segments", upload.id, [segment]),
      store.write("brief-items", upload.id, []),
      store.write("semantic-segments", upload.id, []),
      store.write("relationship-signals", upload.id, [])
    ]);
    const initial = extractUploadMemoriesWithAudit({
      userId: "user_a",
      uploadId: upload.id,
      recordingDate: upload.recordingDate,
      segments: [segment],
      briefItems: [],
      semanticSegments: [],
      relationshipSignals: [],
      now: "2026-07-30T00:00:00.000Z"
    });
    const draft = initial.ownerReviewDrafts[0];
    const candidateId = memoryOwnerReviewCandidateId(upload.id, draft.memory.id);
    const evidenceDigest = memoryOwnerReviewEvidenceDigest({
      uploadId: upload.id,
      memory: draft.memory,
      evidenceSegments: draft.evidenceSegments,
      providerLabels: draft.providerLabels
    });
    await new MemoryOwnerReviewRepository(store).saveCandidate(
      MemoryOwnerReviewCandidateSchema.parse({
        version: 1,
        candidateId,
        uploadId: upload.id,
        memoryId: draft.memory.id,
        memoryType: draft.memory.type,
        title: draft.memory.title,
        summary: draft.memory.summary,
        evidenceSegmentIds: draft.evidenceSegments.map((item) => item.id),
        evidenceDigest,
        providerLabels: draft.providerLabels,
        structuralGate: { status: "degraded", reasons: ["test"] },
        status: "pending",
        audioClips: [],
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z",
        expiresAt: "2099-08-06T00:00:00.000Z"
      })
    );
    const replaceUploadMemories = vi.fn(() => ({
      inputCount: 1,
      memoryCount: 1,
      mergedCount: 0,
      relationCount: 0
    }));

    const confirmed = await reprocessUploadMemoryForOwnerReview({
      store,
      userId: "user_a",
      uploadId: upload.id,
      targetCandidateId: candidateId,
      targetDecision: "confirm_owner",
      targetOwnerIdentityId: "contact_alice",
      repository: { replaceUploadMemories },
      now: () => "2026-07-30T01:00:00.000Z"
    });

    expect(confirmed.appliedOwnerReviewCandidateIds).toEqual([candidateId]);
    expect(replaceUploadMemories).toHaveBeenLastCalledWith(expect.objectContaining({
      uploadId: upload.id,
      memories: [expect.objectContaining({ type: "preference" })],
      ownerAttributions: [
        expect.objectContaining({
          owner: expect.objectContaining({
            identityId: "contact_alice",
            source: "manual_mapping"
          })
        })
      ]
    }));

    await reprocessUploadMemoryForOwnerReview({
      store,
      userId: "user_a",
      uploadId: upload.id,
      targetCandidateId: candidateId,
      targetDecision: "revoke_confirmation",
      repository: { replaceUploadMemories },
      now: () => "2026-07-30T02:00:00.000Z"
    });
    expect(replaceUploadMemories).toHaveBeenLastCalledWith(expect.objectContaining({
      uploadId: upload.id,
      memories: [],
      ownerAttributions: []
    }));
  });
});

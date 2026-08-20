// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioUpload } from "@/lib/domain/types";
import {
  MemoryOwnerReviewCandidateSchema,
  MemoryOwnerReviewRepository
} from "@/lib/server/memory/owner-review";
import { JsonSpeakerIdentityRepository } from "@/lib/server/speaker-identity/repository";
import { JsonStore } from "@/lib/server/storage/json-store";

const { requireAuthContextMock, reprocessMock } = vi.hoisted(() => ({
  requireAuthContextMock: vi.fn(),
  reprocessMock: vi.fn()
}));

vi.mock("@/lib/server/auth/request-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/auth/request-context")>();
  return { ...actual, requireAuthContext: requireAuthContextMock };
});

vi.mock("@/lib/server/memory/reprocess-owner-review", () => ({
  reprocessUploadMemoryForOwnerReview: reprocessMock
}));

import { GET as getAudio } from "./[candidateId]/audio/route";
import { POST as decideOwner } from "./[candidateId]/route";
import { GET as listCandidates } from "./route";

let temporaryDirectory: string | undefined;
let originalFeatureFlag: string | undefined;

beforeEach(() => {
  originalFeatureFlag = process.env.MEMORY_OWNER_REVIEW_ENABLED;
  process.env.MEMORY_OWNER_REVIEW_ENABLED = "true";
  reprocessMock.mockResolvedValue({
    result: { inputCount: 1, memoryCount: 1, mergedCount: 0, relationCount: 0 },
    audit: {},
    appliedOwnerReviewCandidateIds: ["mor_candidate_1"]
  });
});

afterEach(async () => {
  if (originalFeatureFlag === undefined) {
    delete process.env.MEMORY_OWNER_REVIEW_ENABLED;
  } else {
    process.env.MEMORY_OWNER_REVIEW_ENABLED = originalFeatureFlag;
  }
  requireAuthContextMock.mockReset();
  reprocessMock.mockReset();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

async function context(userId: string) {
  temporaryDirectory ??= await mkdtemp(join(tmpdir(), "owner-review-routes-"));
  const dataRootDir = join(temporaryDirectory, userId);
  const uploadsRootDir = join(dataRootDir, "uploads");
  await mkdir(uploadsRootDir, { recursive: true });
  return {
    user: { id: userId, email: `${userId}@example.test`, name: userId },
    store: new JsonStore(dataRootDir),
    dataRootDir,
    uploadsRootDir
  };
}

async function seed(candidateContext: Awaited<ReturnType<typeof context>>) {
  const upload: AudioUpload = {
    id: "upload_1",
    originalName: "sample.wav",
    mimeType: "audio/wav",
    sizeBytes: 10,
    recordingDate: "2026-07-30",
    status: "ready",
    durationSeconds: 30
  };
  await candidateContext.store.write("uploads", upload.id, upload);
  const audioFilePath = join(
    candidateContext.uploadsRootDir,
    "memory-owner-review",
    upload.id,
    "mor_candidate_1",
    "evidence_1.mp3"
  );
  await mkdir(dirname(audioFilePath), { recursive: true });
  await writeFile(audioFilePath, "mp3");
  const candidate = MemoryOwnerReviewCandidateSchema.parse({
    version: 1,
    candidateId: "mor_candidate_1",
    uploadId: upload.id,
    memoryId: "memory_1",
    memoryType: "preference",
    title: "饮食偏好",
    summary: "不喜欢香菜",
    evidenceSegmentIds: ["segment_1"],
    evidenceDigest: "a".repeat(64),
    providerLabels: ["Alice"],
    structuralGate: { status: "healthy", reasons: [] },
    status: "pending",
    audioClips: [{
      segmentId: "segment_1",
      filePath: audioFilePath,
      durationMilliseconds: 3_000,
      expiresAt: "2099-08-06T00:00:00.000Z"
    }],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    expiresAt: "2099-08-06T00:00:00.000Z"
  });
  await new MemoryOwnerReviewRepository(candidateContext.store).saveCandidate(candidate);
  await new JsonSpeakerIdentityRepository(candidateContext.store).saveProfile({
    globalSpeakerId: "contact_alice",
    contactName: "Alice",
    displayName: "Alice",
    identityType: "known_contact",
    status: "active",
    providerReference: {
      provider: "company_voiceprint",
      speakerLabel: "Alice",
      lastRequestId: "save_1",
      operationType: "save"
    }
  });
  return candidate;
}

function postRequest(body: unknown) {
  return new Request("http://localhost/api/memory/owner-review/mor_candidate_1", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("Memory owner review routes", () => {
  it("hides parked Daily Reflection uploads before reading owner-review state", async () => {
    const authContext = await context("user_a");
    await authContext.store.write("uploads", "upload_reflection", {
      id: "upload_reflection",
      originalName: "reflection.wav",
      mimeType: "audio/wav",
      sizeBytes: 15,
      recordingDate: "2026-08-13",
      status: "extracting",
      ingestionContext: "daily_reflection",
      reflectionId: "reflection_1"
    });
    const listSpy = vi.spyOn(authContext.store, "list");
    requireAuthContextMock.mockResolvedValue(authContext);

    const response = await listCandidates(new Request(
      "http://localhost/api/memory/owner-review?uploadId=upload_reflection"
    ));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "upload_not_found" });
    expect(listSpy).not.toHaveBeenCalled();
    expect(reprocessMock).not.toHaveBeenCalled();
  });

  it("rejects stale Daily Reflection owner-review detail and audio", async () => {
    const authContext = await context("user_a");
    const candidate = await seed(authContext);
    const upload = await authContext.store.read("uploads", candidate.uploadId);
    await authContext.store.write("uploads", candidate.uploadId, {
      ...upload as object,
      ingestionContext: "daily_reflection",
      reflectionId: "reflection_owner_stale"
    });
    requireAuthContextMock.mockResolvedValue(authContext);

    const decision = await decideOwner(postRequest({
      requestId: "owner_stale",
      evidenceDigest: candidate.evidenceDigest,
      decision: "keep_daily_only"
    }), { params: Promise.resolve({ candidateId: candidate.candidateId }) });
    const audio = await getAudio(new Request(
      `http://localhost/api/memory/owner-review/${candidate.candidateId}/audio?segmentId=segment_1`
    ), { params: Promise.resolve({ candidateId: candidate.candidateId }) });

    expect(decision.status).toBe(404);
    expect(audio.status).toBe(404);
    expect(reprocessMock).not.toHaveBeenCalled();
  });

  it("lists safe metadata and active owner options without exposing audio paths", async () => {
    const authContext = await context("user_a");
    const candidate = await seed(authContext);
    requireAuthContextMock.mockResolvedValue(authContext);

    const response = await listCandidates(
      new Request("http://localhost/api/memory/owner-review?uploadId=upload_1")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      enabled: true,
      candidates: [{
        candidateId: candidate.candidateId,
        providerLabels: ["Alice"],
        status: "pending",
        audioSegments: [{ segmentId: "segment_1" }]
      }],
      ownerOptions: [{
        ownerIdentityId: "contact_alice",
        identityType: "known_contact",
        displayName: "Alice"
      }]
    });
    expect(JSON.stringify(body)).not.toContain(candidate.audioClips[0].filePath);
  });

  it("requires all-evidence confirmation and reuses an identical request id", async () => {
    const authContext = await context("user_a");
    const candidate = await seed(authContext);
    requireAuthContextMock.mockResolvedValue(authContext);
    const missingConfirmation = await decideOwner(postRequest({
      requestId: "request_missing_confirmation",
      evidenceDigest: candidate.evidenceDigest,
      decision: "confirm_owner",
      ownerIdentityId: "contact_alice"
    }), { params: Promise.resolve({ candidateId: candidate.candidateId }) });
    expect(missingConfirmation.status).toBe(400);

    const body = {
      requestId: "stable_request_1",
      evidenceDigest: candidate.evidenceDigest,
      decision: "confirm_owner",
      ownerIdentityId: "contact_alice",
      reviewedAllEvidence: true
    };
    const first = await decideOwner(postRequest(body), {
      params: Promise.resolve({ candidateId: candidate.candidateId })
    });
    const second = await decideOwner(postRequest(body), {
      params: Promise.resolve({ candidateId: candidate.candidateId })
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await second.json()).operation.reused).toBe(true);
    expect(reprocessMock).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when a request id is reused with different input", async () => {
    const authContext = await context("user_a");
    const candidate = await seed(authContext);
    requireAuthContextMock.mockResolvedValue(authContext);
    const base = {
      requestId: "stable_request_conflict",
      evidenceDigest: candidate.evidenceDigest
    };
    await decideOwner(postRequest({
      ...base,
      decision: "confirm_owner",
      ownerIdentityId: "contact_alice",
      reviewedAllEvidence: true
    }), { params: Promise.resolve({ candidateId: candidate.candidateId }) });
    const conflict = await decideOwner(postRequest({
      ...base,
      decision: "keep_daily_only"
    }), { params: Promise.resolve({ candidateId: candidate.candidateId }) });

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "owner_review_request_id_conflict" });
  });

  it("fails closed across accounts for candidate and audio access", async () => {
    const accountA = await context("user_a");
    const candidate = await seed(accountA);
    const accountB = await context("user_b");
    requireAuthContextMock.mockResolvedValue(accountB);

    const decision = await decideOwner(postRequest({
      requestId: "cross_account",
      evidenceDigest: candidate.evidenceDigest,
      decision: "keep_daily_only"
    }), { params: Promise.resolve({ candidateId: candidate.candidateId }) });
    const audio = await getAudio(new Request(
      `http://localhost/api/memory/owner-review/${candidate.candidateId}/audio?segmentId=segment_1`
    ), { params: Promise.resolve({ candidateId: candidate.candidateId }) });

    expect(decision.status).toBe(404);
    expect(audio.status).toBe(404);
    expect(reprocessMock).not.toHaveBeenCalled();
  });
});

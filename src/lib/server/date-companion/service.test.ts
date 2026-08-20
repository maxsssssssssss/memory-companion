import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseDayPayload } from "@/lib/domain/day-payload";
import { JsonStore } from "@/lib/server/storage/json-store";
import type { IdentityResolverAudit } from "@/lib/server/speaker-identity/identity-resolver";
import { JsonSpeakerIdentityRepository } from "@/lib/server/speaker-identity/repository";

import { openDateCompanionDatabase } from "./db";
import { DateCompanionRepository, DcRetryableError } from "./repository";
import {
  buildDateCompanionImportCandidates,
  buildDateCompanionParticipants,
  DateCompanionService,
  isDateCompanionProviderLabelContinuityEnabled,
  normalizeDateCompanionSpeakerId,
  safeDateCompanionUploadFilePath
} from "./service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DateCompanionService import", () => {
  it("fails closed before first import when a Toy upload is bound to another relationship", async () => {
    const root = await mkdtemp(join(tmpdir(), "date-companion-toy-scope-"));
    roots.push(root);
    const store = new JsonStore(root);
    await store.write("uploads", "upload_toy_scope", {
      id: "upload_toy_scope",
      originalName: "toy.wav",
      mimeType: "audio/wav",
      sizeBytes: 128,
      recordingDate: "2026-08-20",
      status: "uploaded",
      dateCompanionAudioSnapshotVersion: 1,
      toyIngestionRelationshipId: "pending_relationship"
    });
    const database = openDateCompanionDatabase({ filePath: ":memory:" });
    try {
      const repository = new DateCompanionRepository(database);
      const relationshipA = repository.createOrGetRelationship("user_toy_scope", "A").relationship;
      await store.write("uploads", "upload_toy_scope", {
        id: "upload_toy_scope",
        originalName: "toy.wav",
        mimeType: "audio/wav",
        sizeBytes: 128,
        recordingDate: "2026-08-20",
        status: "uploaded",
        dateCompanionAudioSnapshotVersion: 1,
        toyIngestionRelationshipId: relationshipA.id
      });
      await expect(new DateCompanionService(repository).importInteraction({
        store,
        userId: "user_toy_scope",
        relationshipId: "relationship_b",
        uploadId: "upload_toy_scope"
      })).rejects.toMatchObject({ code: "toy_ingestion_relationship_conflict" });
      expect(repository.getRelationshipView("user_toy_scope", relationshipA.id).interactions)
        .toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rejects a Daily Reflection upload even if legacy ready fields are forged", async () => {
    const root = await mkdtemp(join(tmpdir(), "date-companion-dr-guard-"));
    roots.push(root);
    const store = new JsonStore(root);
    await store.write("uploads", "upload_dr_guard", {
      id: "upload_dr_guard",
      originalName: "reflection.wav",
      mimeType: "audio/wav",
      sizeBytes: 128,
      recordingDate: "2026-08-13",
      status: "ready",
      ingestionContext: "daily_reflection",
      reflectionId: "reflection_dr_guard"
    });
    await store.write("jobs-by-upload", "upload_dr_guard", {
      id: "job_dr_guard",
      uploadId: "upload_dr_guard",
      status: "ready",
      progress: 100
    });
    const database = openDateCompanionDatabase({ filePath: ":memory:" });
    try {
      const repository = new DateCompanionRepository(database);
      const relationship = repository.createOrGetRelationship("user_dr_guard").relationship;
      await expect(new DateCompanionService(repository).importInteraction({
        store,
        userId: "user_dr_guard",
        relationshipId: relationship.id,
        uploadId: "upload_dr_guard"
      })).rejects.toMatchObject({ code: "date_companion_not_found" });
      expect(repository.getRelationshipView(
        "user_dr_guard",
        relationship.id
      ).interactions).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("keeps Provider-label continuity disabled unless the dedicated flag is explicitly true", () => {
    expect(isDateCompanionProviderLabelContinuityEnabled(undefined)).toBe(false);
    expect(isDateCompanionProviderLabelContinuityEnabled("false")).toBe(false);
    expect(isDateCompanionProviderLabelContinuityEnabled("1")).toBe(false);
    expect(isDateCompanionProviderLabelContinuityEnabled(" TRUE ")).toBe(true);
  });

  it("normalizes speaker ids without accepting empty or oversized identifiers", () => {
    expect(normalizeDateCompanionSpeakerId("  speaker_1  ")).toBe("speaker_1");
    expect(normalizeDateCompanionSpeakerId("   ")).toBeUndefined();
    expect(normalizeDateCompanionSpeakerId("x".repeat(513))).toBeUndefined();
    expect(normalizeDateCompanionSpeakerId(null)).toBeUndefined();
  });

  it("rejects an upload file path outside the authenticated user's upload root", () => {
    const root = join(tmpdir(), "date-companion-safe-root", "uploads");
    expect(() => safeDateCompanionUploadFilePath(
      join(tmpdir(), "date-companion-other-user", "recording.wav"),
      root
    )).toThrowError(expect.objectContaining({ code: "invalid_upload_file_path" }));
  });

  it("does not invent a participant or long-term candidate for speaker-less evidence", () => {
    const payload = parseDayPayload({
      upload: {
        id: "upload_speakerless",
        originalName: "speakerless.wav",
        mimeType: "audio/wav",
        sizeBytes: 128,
        recordingDate: "2026-08-04",
        status: "ready"
      },
      job: {
        id: "job_speakerless",
        uploadId: "upload_speakerless",
        status: "ready",
        progress: 100
      },
      segments: [{
        id: "segment_speakerless",
        uploadId: "upload_speakerless",
        startSeconds: 0,
        endSeconds: 3,
        text: "没有可靠说话人标签的原话",
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: ["commitment"]
      }],
      audioInsights: [],
      semanticSegments: [],
      semanticSegmentsAvailable: true,
      briefItems: [{
        id: "brief_speakerless",
        uploadId: "upload_speakerless",
        category: "commitment",
        title: "约定",
        body: "我来预订",
        priority: "high",
        confidence: 0.9,
        status: "candidate",
        sourceSegmentIds: ["segment_speakerless"],
        sourceTimeRange: { startSeconds: 0, endSeconds: 3 },
        transcriptExcerpt: "没有可靠说话人标签的原话",
        people: [],
        topics: []
      }],
      relationshipSignals: [],
      relationshipSignalsAvailable: true,
      proactiveInsights: [],
      proactiveInsightsAvailable: false,
      speakerAliases: {},
      speakerAliasesByUploadId: { upload_speakerless: {} }
    });

    expect(buildDateCompanionImportCandidates(payload)).toEqual([]);
  });

  it("uses only a trusted, user-owned identity as a continuity candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "date-companion-speaker-profile-"));
    roots.push(root);
    const store = new JsonStore(root);
    const profiles = new JsonSpeakerIdentityRepository(store);
    await profiles.saveProfile({
      globalSpeakerId: "user_user_a",
      userId: "user_a",
      displayName: "我",
      identityType: "known_user",
      status: "active",
      providerReference: {
        provider: "company_voiceprint",
        speakerLabel: "我",
        lastRequestId: "train_1",
        operationType: "train"
      },
      voiceprintSpeakerId: "我"
    });
    const payload = parseDayPayload({
      upload: {
        id: "upload_profile",
        originalName: "profile.wav",
        mimeType: "audio/wav",
        sizeBytes: 128,
        recordingDate: "2026-08-05",
        status: "ready"
      },
      segments: [{
        id: "segment_profile",
        uploadId: "upload_profile",
        startSeconds: 0,
        endSeconds: 2,
        speaker: "我",
        identity: {
          globalSpeakerId: "user_user_a",
          displayName: "我",
          identityType: "known_user",
          confidence: 0.9,
          source: "voiceprint"
        },
        text: "下次我来订餐厅",
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }],
      audioInsights: [],
      semanticSegments: [],
      semanticSegmentsAvailable: true,
      briefItems: [],
      relationshipSignals: [],
      relationshipSignalsAvailable: true,
      proactiveInsights: [],
      proactiveInsightsAvailable: false,
      speakerAliases: {},
      speakerAliasesByUploadId: { upload_profile: {} }
    });

    await expect(buildDateCompanionParticipants(store, payload, "user_a")).resolves.toEqual([{
      speakerId: "identity_user_user_a",
      continuityKey: "identity_user_user_a"
    }]);

    const belowThresholdPayload = parseDayPayload({
      ...payload,
      segments: [{
        ...payload.segments[0],
        identity: { ...payload.segments[0].identity!, confidence: 0.899 }
      }]
    });
    await expect(buildDateCompanionParticipants(
      store,
      belowThresholdPayload,
      "user_a"
    )).resolves.toEqual([{ speakerId: expect.stringMatching(/^local_/u) }]);

    const reviewRequiredPayload = parseDayPayload({
      ...payload,
      segments: [{
        ...payload.segments[0],
        identity: {
          globalSpeakerId: "unknown_review_required",
          identityType: "unknown_person",
          confidence: null,
          source: "provider_speaker_result",
          evidence: {
            type: "provider_label",
            provider: "company_voiceprint",
            providerLabel: "我"
          }
        }
      }]
    });
    await expect(buildDateCompanionParticipants(
      store,
      reviewRequiredPayload,
      "user_a"
    )).resolves.toEqual([{ speakerId: "candidate_unknown_review_required" }]);

    await expect(buildDateCompanionParticipants(
      store,
      reviewRequiredPayload,
      "user_a",
      { providerLabelContinuityEnabled: true }
    )).resolves.toEqual([{ speakerId: "candidate_unknown_review_required" }]);

    const reviewProviderLabel = reviewRequiredPayload.segments[0].speaker!;
    const validReviewAudit = {
      version: 1,
      uploadId: reviewRequiredPayload.upload.id,
      generatedAt: "2026-08-05T00:00:00.000Z",
      chunksProcessed: 1,
      localSpeakerGroups: 1,
      globalSpeakers: 1,
      matched: 0,
      unknown: 1,
      averageConfidence: null,
      conflicts: 0,
      assignments: [],
      comparisons: [],
      structuralGate: { status: "healthy", reasons: [], chunks: [] },
      evidenceAvailability: { manualMapping: "unknown", voiceprint: "available" },
      resolutionStates: [{
        candidateKey: `chunk_0::${reviewProviderLabel}`,
        chunkId: "chunk_0",
        globalSpeakerId: "unknown_review_required",
        localSpeaker: reviewProviderLabel,
        providerLabel: reviewProviderLabel,
        ownerIdentityId: null,
        confidence: null,
        status: "pending",
        source: "provider_speaker_result",
        reason: "provider_label_review_required",
        evidence: {
          type: "provider_label",
          provider: "company_voiceprint",
          providerLabel: reviewProviderLabel
        }
      }]
    } satisfies IdentityResolverAudit;
    await store.write(
      "speaker-identities",
      reviewRequiredPayload.upload.id,
      validReviewAudit
    );
    await expect(buildDateCompanionParticipants(
      store,
      reviewRequiredPayload,
      "user_a",
      { providerLabelContinuityEnabled: true }
    )).resolves.toEqual([{
      speakerId: "candidate_unknown_review_required",
      continuityKey: "identity_user_user_a"
    }]);

    await store.write(
      "speaker-identities",
      reviewRequiredPayload.upload.id,
      {
        ...validReviewAudit,
        structuralGate: { status: "blocked", reasons: [], chunks: [] }
      }
    );
    await expect(buildDateCompanionParticipants(
      store,
      reviewRequiredPayload,
      "user_a",
      { providerLabelContinuityEnabled: true }
    )).resolves.toEqual([{ speakerId: "candidate_unknown_review_required" }]);
    await store.write(
      "speaker-identities",
      reviewRequiredPayload.upload.id,
      { ...validReviewAudit, uploadId: "different_upload" }
    );
    await expect(buildDateCompanionParticipants(
      store,
      reviewRequiredPayload,
      "user_a",
      { providerLabelContinuityEnabled: true }
    )).resolves.toEqual([{ speakerId: "candidate_unknown_review_required" }]);
    await store.write(
      "speaker-identities",
      reviewRequiredPayload.upload.id,
      {
        ...validReviewAudit,
        resolutionStates: [
          validReviewAudit.resolutionStates[0],
          { ...validReviewAudit.resolutionStates[0] }
        ]
      }
    );
    await expect(buildDateCompanionParticipants(
      store,
      reviewRequiredPayload,
      "user_a",
      { providerLabelContinuityEnabled: true }
    )).resolves.toEqual([{ speakerId: "candidate_unknown_review_required" }]);
    await store.write(
      "speaker-identities",
      reviewRequiredPayload.upload.id,
      validReviewAudit
    );

    await profiles.saveProfile({
      globalSpeakerId: "contact_conflict",
      userId: "user_a",
      displayName: "重复标签",
      contactName: "重复标签",
      identityType: "known_contact",
      status: "active",
      providerReference: {
        provider: "company_voiceprint",
        speakerLabel: "我",
        lastRequestId: "save_conflict",
        operationType: "save"
      }
    });
    await expect(buildDateCompanionParticipants(
      store,
      reviewRequiredPayload,
      "user_a",
      { providerLabelContinuityEnabled: true }
    )).resolves.toEqual([{ speakerId: "candidate_unknown_review_required" }]);

    await profiles.saveProfile({
      globalSpeakerId: "contact_other_user",
      userId: "user_b",
      displayName: "其他账号的人",
      contactName: "其他账号的人",
      identityType: "known_contact",
      status: "active",
      voiceprintSpeakerId: "contact_other_user"
    });
    const otherUserPayload = parseDayPayload({
      ...payload,
      segments: [{
        ...payload.segments[0],
        speaker: "contact_other_user",
        identity: {
          globalSpeakerId: "contact_other_user",
          displayName: "其他账号的人",
          identityType: "known_contact",
          confidence: 0.9,
          source: "voiceprint"
        }
      }]
    });
    await expect(buildDateCompanionParticipants(store, otherUserPayload, "user_a")).resolves.toEqual([{
      speakerId: "identity_contact_other_user"
    }]);

    const rawLabelOnlyPayload = parseDayPayload({
      ...payload,
      segments: [{ ...payload.segments[0], identity: undefined }]
    });
    await expect(buildDateCompanionParticipants(store, rawLabelOnlyPayload, "user_a")).resolves.toEqual([{
      speakerId: expect.stringMatching(/^local_/u)
    }]);
  });

  it("reads a real user JsonStore, snapshots transcript evidence, and reuses after source cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "date-companion-service-"));
    roots.push(root);
    const store = new JsonStore(root);
    const uploadsRootDir = join(root, "uploads");
    const sourceFilePath = join(uploadsRootDir, "upload_1.wav");
    await store.write("uploads", "upload_1", {
      id: "upload_1",
      originalName: "fixture.wav",
      mimeType: "audio/wav",
      sizeBytes: 1024,
      recordingDate: "2026-08-04",
      status: "ready",
      filePath: sourceFilePath
    });
    await store.write("jobs-by-upload", "upload_1", {
      id: "job_1",
      uploadId: "upload_1",
      status: "ready",
      progress: 100
    });
    await store.write("segments", "upload_1", [{
      id: "segment_1",
      uploadId: "upload_1",
      startSeconds: 0,
      endSeconds: 5,
      speaker: "  speaker_0  ",
      text: "这是服务端保存的真实原话",
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: ["commitment"]
    }]);
    await store.write("audio-insights", "upload_1", []);
    await store.write("semantic-segments", "upload_1", []);
    await store.write("brief-items", "upload_1", [{
      id: "brief_1",
      uploadId: "upload_1",
      category: "commitment",
      title: "约定",
      body: "客户端可见的摘要",
      priority: "high",
      confidence: 0.9,
      status: "candidate",
      sourceSegmentIds: ["segment_1"],
      sourceTimeRange: { startSeconds: 0, endSeconds: 5 },
      transcriptExcerpt: "伪造的客户端引用",
      people: [],
      topics: []
    }]);
    await store.write("relationship-signals", "upload_1", []);

    const database = openDateCompanionDatabase({ filePath: ":memory:" });
    try {
      const repository = new DateCompanionRepository(database);
      const relationship = repository.createOrGetRelationship("user_a").relationship;
      const buildAudioSamples = vi.fn(async () => [{
        speakerId: "local_speaker_0",
        mimeType: "audio/mpeg" as const,
        durationMilliseconds: 2_500,
        audio: new Uint8Array([1, 2, 3]),
        sourceRanges: [{ startMilliseconds: 0, endMilliseconds: 2_500 }]
      }]);
      const service = new DateCompanionService(repository, { buildAudioSamples });
      const first = await service.importInteraction({
        store,
        userId: "user_a",
        relationshipId: relationship.id,
        uploadId: "upload_1",
        uploadsRootDir
      });
      expect(first.reused).toBe(false);
      expect(first.view.interactions[0].recapItems[0].evidence[0]).toMatchObject({
        uploadId: "upload_1",
        sourceSegmentId: "segment_1",
        quote: "这是服务端保存的真实原话"
      });
      expect(first.view.interactions[0].recapItems[0].evidence[0].quote).not.toContain("伪造");
      expect(buildAudioSamples).toHaveBeenCalledWith({
        uploadId: "upload_1",
        sourceFilePath,
        segments: expect.arrayContaining([expect.objectContaining({ id: "segment_1", speaker: "speaker_0" })])
      });
      expect(repository.getParticipantAudioSample("user_a", first.interactionId, "local_speaker_0")).toEqual({
        mimeType: "audio/mpeg",
        durationMilliseconds: 2_500,
        audio: new Uint8Array([1, 2, 3])
      });

      await store.delete("uploads", "upload_1");
      await store.delete("segments", "upload_1");
      expect(repository.markUploadSourceState("user_a", "upload_1", "server_cleaned")).toBe(true);
      const retained = repository.getRelationshipView("user_a", relationship.id).interactions[0];
      expect(retained.sourceState).toBe("server_cleaned");
      expect(retained.recapItems[0].evidence[0]).toMatchObject({
        uploadId: "upload_1",
        sourceSegmentId: "segment_1",
        quote: "这是服务端保存的真实原话"
      });
      const second = await service.importInteraction({
        store,
        userId: "user_a",
        relationshipId: relationship.id,
        uploadId: "upload_1",
        uploadsRootDir
      });
      expect(second.reused).toBe(true);
      expect(second.interactionId).toBe(first.interactionId);
      expect(buildAudioSamples).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("persists marked upload audio only from the authenticated staging snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "date-companion-staged-import-"));
    roots.push(root);
    const store = new JsonStore(root);
    await store.write("uploads", "upload_staged", {
      id: "upload_staged",
      originalName: "date.wav",
      mimeType: "audio/wav",
      sizeBytes: 1024,
      recordingDate: "2026-08-04",
      status: "ready",
      dateCompanionAudioSnapshotVersion: 1
    });
    await store.write("jobs-by-upload", "upload_staged", {
      id: "job_staged",
      uploadId: "upload_staged",
      status: "ready",
      progress: 100
    });
    await store.write("segments", "upload_staged", [{
      id: "segment_staged",
      uploadId: "upload_staged",
      startSeconds: 1,
      endSeconds: 5,
      speaker: "speaker_1",
      text: "这是约会陪伴音频来源",
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: []
    }]);
    await store.write("audio-insights", "upload_staged", []);
    await store.write("semantic-segments", "upload_staged", []);
    await store.write("brief-items", "upload_staged", []);
    await store.write("relationship-signals", "upload_staged", []);
    await store.write("date-companion-audio-staging", "upload_staged", {
      version: 1,
      uploadId: "upload_staged",
      userId: "user_a",
      createdAt: "2026-08-04T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      status: "ready",
      samples: [{
        speakerId: "local_speaker_1",
        mimeType: "audio/mpeg",
        durationMilliseconds: 3_800,
        sourceRanges: [{ startMilliseconds: 1_100, endMilliseconds: 4_900 }],
        audioBase64: "AQID"
      }]
    });

    const database = openDateCompanionDatabase({ filePath: ":memory:" });
    try {
      const repository = new DateCompanionRepository(database);
      const relationship = repository.createOrGetRelationship("user_a").relationship;
      const buildAudioSamples = vi.fn();
      const result = await new DateCompanionService(repository, {
        buildAudioSamples
      }).importInteraction({
        store,
        userId: "user_a",
        relationshipId: relationship.id,
        uploadId: "upload_staged",
        uploadsRootDir: join(root, "uploads")
      });

      expect(buildAudioSamples).not.toHaveBeenCalled();
      expect(repository.getParticipantAudioSample(
        "user_a",
        result.interactionId,
        "local_speaker_1"
      )).toEqual({
        mimeType: "audio/mpeg",
        durationMilliseconds: 3_800,
        audio: new Uint8Array([1, 2, 3])
      });
      expect(await store.read(
        "date-companion-audio-staging",
        "upload_staged"
      )).not.toBeNull();
    } finally {
      database.close();
    }
  });

  it("returns a retryable error before import when a marked upload has no staging snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "date-companion-missing-stage-"));
    roots.push(root);
    const store = new JsonStore(root);
    await store.write("uploads", "upload_missing_stage", {
      id: "upload_missing_stage",
      originalName: "date.wav",
      mimeType: "audio/wav",
      sizeBytes: 1024,
      recordingDate: "2026-08-04",
      status: "ready",
      dateCompanionAudioSnapshotVersion: 1
    });
    await store.write("jobs-by-upload", "upload_missing_stage", {
      id: "job_missing_stage",
      uploadId: "upload_missing_stage",
      status: "ready",
      progress: 100
    });
    await store.write("segments", "upload_missing_stage", [{
      id: "segment_missing_stage",
      uploadId: "upload_missing_stage",
      startSeconds: 0,
      endSeconds: 4,
      speaker: "speaker_1",
      text: "缺少暂存快照时不能清理来源",
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: []
    }]);
    await store.write("audio-insights", "upload_missing_stage", []);
    await store.write("semantic-segments", "upload_missing_stage", []);
    await store.write("brief-items", "upload_missing_stage", []);
    await store.write("relationship-signals", "upload_missing_stage", []);

    const database = openDateCompanionDatabase({ filePath: ":memory:" });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const repository = new DateCompanionRepository(database);
      const relationship = repository.createOrGetRelationship("user_a").relationship;
      const request = new DateCompanionService(repository).importInteraction({
        store,
        userId: "user_a",
        relationshipId: relationship.id,
        uploadId: "upload_missing_stage",
        uploadsRootDir: join(root, "uploads")
      });

      await expect(request).rejects.toMatchObject({
        code: "participant_audio_staging_unavailable"
      });
      expect(repository.getRelationshipView(
        "user_a",
        relationship.id
      ).interactions).toEqual([]);
    } finally {
      consoleWarn.mockRestore();
      database.close();
    }
  });

  it("retains the imported interaction and source for an idempotent audio retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "date-companion-audio-fail-open-"));
    roots.push(root);
    const store = new JsonStore(root);
    const uploadsRootDir = join(root, "uploads");
    await store.write("uploads", "upload_audio_fail", {
      id: "upload_audio_fail",
      originalName: "fixture.wav",
      mimeType: "audio/wav",
      sizeBytes: 1024,
      recordingDate: "2026-08-04",
      status: "ready",
      filePath: join(uploadsRootDir, "upload_audio_fail.wav")
    });
    await store.write("jobs-by-upload", "upload_audio_fail", {
      id: "job_audio_fail",
      uploadId: "upload_audio_fail",
      status: "ready",
      progress: 100
    });
    await store.write("segments", "upload_audio_fail", [{
      id: "segment_audio_fail",
      uploadId: "upload_audio_fail",
      startSeconds: 0,
      endSeconds: 4,
      speaker: "speaker_0",
      text: "这次音频节选失败也不能丢失复盘",
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: []
    }]);
    await store.write("audio-insights", "upload_audio_fail", []);
    await store.write("semantic-segments", "upload_audio_fail", []);
    await store.write("brief-items", "upload_audio_fail", []);
    await store.write("relationship-signals", "upload_audio_fail", []);

    const database = openDateCompanionDatabase({ filePath: ":memory:" });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const repository = new DateCompanionRepository(database);
      const relationship = repository.createOrGetRelationship("user_a").relationship;
      const buildAudioSamples = vi.fn()
        .mockRejectedValueOnce(new Error("ffmpeg unavailable"))
        .mockResolvedValueOnce([{
          speakerId: "local_speaker_0",
          mimeType: "audio/mpeg" as const,
          durationMilliseconds: 2_000,
          audio: new Uint8Array([4, 5, 6]),
          sourceRanges: [{ startMilliseconds: 0, endMilliseconds: 2_000 }]
        }]);
      const service = new DateCompanionService(repository, { buildAudioSamples });
      const request = () => service.importInteraction({
        store,
        userId: "user_a",
        relationshipId: relationship.id,
        uploadId: "upload_audio_fail",
        uploadsRootDir
      });

      await expect(request()).rejects.toBeInstanceOf(DcRetryableError);
      const retainedInteraction = repository.getRelationshipView("user_a", relationship.id).interactions[0];
      expect(retainedInteraction.sourceUploadId).toBe("upload_audio_fail");
      expect(repository.participantAudioSpeakerIds("user_a", retainedInteraction.id)).toEqual([]);
      expect(consoleWarn).toHaveBeenCalledWith(
        "[date-companion-audio] generation_failed upload_id=upload_audio_fail error_name=Error"
      );

      const recovered = await request();
      expect(recovered.reused).toBe(true);
      expect(recovered.interactionId).toBe(retainedInteraction.id);
      expect(repository.getParticipantAudioSample("user_a", recovered.interactionId, "local_speaker_0")).toEqual({
        mimeType: "audio/mpeg",
        durationMilliseconds: 2_000,
        audio: new Uint8Array([4, 5, 6])
      });
      expect(buildAudioSamples).toHaveBeenCalledTimes(2);
    } finally {
      consoleWarn.mockRestore();
      database.close();
    }
  });

  it("turns a first explicit companion enrollment into a second-recording role suggestion", async () => {
    const root = await mkdtemp(join(tmpdir(), "date-companion-enrollment-continuity-"));
    roots.push(root);
    const store = new JsonStore(root);
    const writeUpload = async (input: {
      uploadId: string;
      recordingDate: string;
      speaker: string;
      identity?: {
        globalSpeakerId: string;
        displayName: string;
        identityType: "known_contact";
        confidence: number;
        source: "voiceprint";
      };
    }) => {
      await store.write("uploads", input.uploadId, {
        id: input.uploadId,
        originalName: `${input.uploadId}.wav`,
        mimeType: "audio/wav",
        sizeBytes: 128,
        recordingDate: input.recordingDate,
        status: "ready"
      });
      await store.write("jobs-by-upload", input.uploadId, {
        id: `job_${input.uploadId}`,
        uploadId: input.uploadId,
        status: "ready",
        progress: 100
      });
      const segmentId = `${input.uploadId}_chunk_00000_seg_00001`;
      await store.write("segments", input.uploadId, [{
        id: segmentId,
        uploadId: input.uploadId,
        startSeconds: 0,
        endSeconds: 2,
        speaker: input.speaker,
        ...(input.identity ? { identity: input.identity } : {}),
        text: "下次一起散步",
        confidence: 0.95,
        sceneLabels: [],
        valueLabels: []
      }]);
      await store.write("audio-insights", input.uploadId, []);
      await store.write("semantic-segments", input.uploadId, []);
      await store.write("brief-items", input.uploadId, [{
        id: `brief_${input.uploadId}`,
        uploadId: input.uploadId,
        category: "notable_quote",
        title: "散步",
        body: "下次一起散步",
        priority: "medium",
        confidence: 0.9,
        status: "candidate",
        sourceSegmentIds: [segmentId],
        sourceTimeRange: { startSeconds: 0, endSeconds: 2 },
        transcriptExcerpt: "下次一起散步",
        people: [],
        topics: []
      }]);
      await store.write("relationship-signals", input.uploadId, []);
    };
    await writeUpload({
      uploadId: "upload_enroll_first",
      recordingDate: "2026-08-05",
      speaker: "speaker_1"
    });

    const database = openDateCompanionDatabase({ filePath: ":memory:" });
    try {
      const repository = new DateCompanionRepository(database);
      const relationship = repository.createOrGetRelationship("user_enroll", "Ta").relationship;
      const buildVoiceEnrollmentSnapshots = vi.fn(async (input) => {
        const speakerId = input.participantPlan.participants[0].speakerId;
        return [{
          reviewGroupId: speakerId,
          speakerIds: [speakerId],
          sourceUploadId: input.uploadId,
          providerRecordId: "provider_record_first",
          chunkId: "chunk_first",
          localSpeaker: "speaker_1",
          auditStatus: "unknown" as const,
          auditReason: "no_matching_evidence",
          auditDigest: "b".repeat(64),
          expiresAt: "2099-01-01T00:00:00.000Z"
        }];
      });
      const previousEnrollmentFlag = process.env.DATE_COMPANION_VOICE_ENROLLMENT_ENABLED;
      const previousExecutionMode = process.env.PIPELINE_EXECUTION_MODE;
      try {
        process.env.DATE_COMPANION_VOICE_ENROLLMENT_ENABLED = "true";
        process.env.PIPELINE_EXECUTION_MODE = "inline";
        const unavailable = await new DateCompanionService(repository, {
          buildVoiceEnrollmentSnapshots
        }).importInteraction({
          store,
          userId: "user_enroll",
          relationshipId: relationship.id,
          uploadId: "upload_enroll_first"
        });
        expect(buildVoiceEnrollmentSnapshots).not.toHaveBeenCalled();
        expect(unavailable.view.interactions[0].participants.every(
          (participant) => participant.voiceEnrollmentEligible !== true
        )).toBe(true);
      } finally {
        if (previousEnrollmentFlag === undefined) {
          delete process.env.DATE_COMPANION_VOICE_ENROLLMENT_ENABLED;
        } else {
          process.env.DATE_COMPANION_VOICE_ENROLLMENT_ENABLED = previousEnrollmentFlag;
        }
        if (previousExecutionMode === undefined) {
          delete process.env.PIPELINE_EXECUTION_MODE;
        } else {
          process.env.PIPELINE_EXECUTION_MODE = previousExecutionMode;
        }
      }
      const first = await new DateCompanionService(repository, {
        voiceEnrollmentEnabled: true,
        buildVoiceEnrollmentSnapshots
      }).importInteraction({
        store,
        userId: "user_enroll",
        relationshipId: relationship.id,
        uploadId: "upload_enroll_first"
      });
      expect(buildVoiceEnrollmentSnapshots).toHaveBeenCalledOnce();
      const firstInteraction = first.view.interactions[0];
      const firstSpeakerId = firstInteraction.participants[0].speakerId;
      repository.updateRecap({
        userId: "user_enroll",
        interactionId: first.interactionId,
        version: firstInteraction.version,
        assignments: [{ speakerId: firstSpeakerId, role: "companion" }],
        mutations: [{
          id: firstInteraction.recapItems[0].id,
          version: firstInteraction.recapItems[0].version,
          disposition: "kept"
        }],
        voiceEnrollmentIntents: [{ speakerIds: [firstSpeakerId] }],
        voiceEnrollmentEnabled: true,
        finalize: true
      });
      const outbox = database.prepare(`
        SELECT id, provider_speaker_id, expected_global_speaker_id
        FROM dc_voice_enrollment_outbox
        WHERE user_id = 'user_enroll' AND interaction_id = ?
      `).get(first.interactionId) as {
        id: string;
        provider_speaker_id: string;
        expected_global_speaker_id: string;
      };
      await new JsonSpeakerIdentityRepository(store).saveProfile({
        globalSpeakerId: outbox.expected_global_speaker_id,
        userId: "user_enroll",
        displayName: "Ta",
        identityType: "known_contact",
        status: "active",
        providerReference: {
          provider: "company_voiceprint",
          speakerLabel: outbox.provider_speaker_id,
          lastRequestId: "voice_enrollment_request",
          operationType: "save"
        },
        voiceprintSpeakerId: outbox.provider_speaker_id
      });
      const claim = repository.claimVoiceEnrollment("user_enroll", outbox.id);
      repository.completeVoiceEnrollment({
        userId: "user_enroll",
        outboxId: outbox.id,
        claimToken: claim.claimToken,
        profileGlobalSpeakerId: outbox.expected_global_speaker_id
      });

      await writeUpload({
        uploadId: "upload_enroll_second",
        recordingDate: "2026-08-06",
        speaker: "speaker_7",
        identity: {
          globalSpeakerId: outbox.expected_global_speaker_id,
          displayName: "Ta",
          identityType: "known_contact",
          confidence: 0.95,
          source: "voiceprint"
        }
      });
      const second = await new DateCompanionService(repository, {
        voiceEnrollmentEnabled: false
      }).importInteraction({
        store,
        userId: "user_enroll",
        relationshipId: relationship.id,
        uploadId: "upload_enroll_second"
      });
      expect(second.view.interactions.find((item) => item.id === second.interactionId)?.participants)
        .toEqual([expect.objectContaining({
          role: "unresolved",
          roleSuggestion: { role: "companion", source: "previous_confirmation" }
        })]);
    } finally {
      database.close();
    }
  });
});

// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CandidateAdmissionResult,
  ReflectionConfirmation,
  ReflectionConfirmationCandidateSnapshot
} from "@/lib/domain/daily-reflection";
import type { AudioUpload, TranscriptSegment } from "@/lib/domain/types";
import {
  createDailyReflectionMemoryCandidateRevocationRepository,
  dailyReflectionCandidateRevocationPayloadDigest
} from "@/lib/server/memory/daily-reflection-candidate-revocation";
import {
  createDailyReflectionMemoryPublicationRepository
} from "@/lib/server/memory/daily-reflection-publication";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import { deleteMemoryUploadAndRefreshIndex } from "@/lib/server/memory/upload-deletion";
import { createPersonAdmissionRepository } from "@/lib/server/person/admission-repository";
import { createPersonMemoryRepository } from "@/lib/server/person/memory-repository";
import { createPersonRepository } from "@/lib/server/person/repository";
import { resolveRetrievalUpload } from "@/lib/server/retrieval/source-awareness";

import type { DailyReflectionRepository } from "./repository";
import {
  createDailyReflectionMemoryAdmissionOrchestrator,
  createDailyReflectionMemoryAdmissionService
} from "./memory-admission";

const ACCOUNT_ID = "account_reflection";
const OTHER_ACCOUNT_ID = "account_other";
const REFLECTION_ID = "reflection_memory";
const UPLOAD_ID = "daily-reflection-reflection_memory";
const NOW = "2026-08-13T08:00:00.000Z";
const FINGERPRINT = "a".repeat(64);

let database: Database.Database;

beforeEach(() => {
  database = openMemoryDatabase({ filePath: ":memory:" });
});

afterEach(() => {
  database.close();
});

function trustedSegment(input: {
  id: string;
  text: string;
  withIdentity?: boolean;
}): TranscriptSegment {
  return {
    id: input.id,
    uploadId: UPLOAD_ID,
    startSeconds: 0,
    endSeconds: 8,
    speaker: "trusted_user",
    ...(input.withIdentity === false ? {} : {
      identity: {
        globalSpeakerId: "identity_user",
        identityType: "known_user" as const,
        confidence: null,
        source: "provider_speaker_result" as const,
        evidence: {
          type: "provider_label" as const,
          provider: "company_voiceprint" as const,
          providerLabel: "trusted_user"
        }
      }
    }),
    text: input.text,
    confidence: 0.99,
    sceneLabels: ["self_reflection"],
    valueLabels: ["commitment"]
  };
}

function kept(input: {
  id: string;
  type?: "event" | "commitment" | "question" | "preference" | "summary";
  text: string;
  segmentId: string;
  subjectPersonId?: string | null;
}): ReflectionConfirmationCandidateSnapshot {
  return {
    candidateId: input.id,
    proposedText: input.text,
    userText: null,
    finalText: input.text,
    status: "kept",
    candidateType: input.type ?? "preference",
    sourceSegmentIds: [input.segmentId],
    evidenceSnapshots: [{
      sourceSegmentId: input.segmentId,
      uploadId: UPLOAD_ID,
      startSeconds: 0,
      endSeconds: 8,
      text: input.text,
      effectiveOrigin: "user_reflection"
    }],
    subjectPersonId: input.subjectPersonId ?? null
  };
}

function excluded(input: {
  id: string;
  text: string;
  segmentId: string;
}): ReflectionConfirmationCandidateSnapshot {
  return {
    candidateId: input.id,
    proposedText: input.text,
    userText: null,
    finalText: input.text,
    status: "excluded",
    candidateType: "summary",
    sourceSegmentIds: [input.segmentId],
    evidenceSnapshots: [{
      sourceSegmentId: input.segmentId,
      uploadId: UPLOAD_ID,
      startSeconds: 0,
      endSeconds: 8,
      text: input.text,
      effectiveOrigin: "user_reflection"
    }],
    subjectPersonId: null
  };
}

function fixture(input: {
  candidates: ReflectionConfirmationCandidateSnapshot[];
  segments?: TranscriptSegment[];
}) {
  const confirmation: ReflectionConfirmation = {
    id: "confirmation_memory",
    reflectionId: REFLECTION_ID,
    accountId: ACCOUNT_ID,
    fingerprint: FINGERPRINT,
    requestFingerprint: "b".repeat(64),
    idempotencyKey: "finalize_memory",
    sourceOrigin: "user_reflection",
    inputMethod: "file_upload",
    processingProfile: "quick_reflection",
    candidateSnapshots: input.candidates,
    createdAt: NOW
  };
  const upload: AudioUpload = {
    id: UPLOAD_ID,
    originalName: "reflection.wav",
    mimeType: "audio/wav",
    sizeBytes: 100,
    recordingDate: "2026-08-13",
    status: "extracting"
  };
  const segments = input.segments ?? [];
  const readPublishedAsset = <T,>(
    request: { assetKind: "upload" | "segments" }
  ): T | null => (
    request.assetKind === "upload" ? upload : segments
  ) as T;
  const sourceRepository = {
    getConfirmation: vi.fn((accountId: string, reflectionId: string) =>
      accountId === ACCOUNT_ID && reflectionId === REFLECTION_ID ? confirmation : null
    ),
    getReflection: vi.fn(() => ({
      id: REFLECTION_ID,
      accountId: ACCOUNT_ID,
      uploadId: UPLOAD_ID,
      inputMethod: "file_upload" as const,
      sourceOrigin: "user_reflection" as const,
      processingProfile: "quick_reflection" as const,
      ingestionContext: "daily_reflection" as const,
      status: "confirmation_ready" as const,
      version: 5,
      idempotencyKey: "reflection_memory",
      errorCode: null,
      errorMessage: null,
      createdAt: NOW,
      updatedAt: NOW
    })),
    getProcessingPlan: vi.fn(() => ({
      planVersion: 1 as const,
      reflectionId: REFLECTION_ID,
      uploadId: UPLOAD_ID,
      inputMethod: "file_upload" as const,
      sourceOrigin: "user_reflection" as const,
      processingProfile: "quick_reflection" as const,
      ingestionContext: "daily_reflection" as const,
      reviewPolicy: "required" as const
    })),
    readPublishedAsset: vi.fn(readPublishedAsset) as typeof readPublishedAsset
  };
  const publicationRepository = createDailyReflectionMemoryPublicationRepository(database);
  const service = createDailyReflectionMemoryAdmissionService({
    sourceRepository,
    publicationRepository,
    personRepository: createPersonRepository(database),
    now: () => NOW
  });
  return { confirmation, upload, segments, sourceRepository, publicationRepository, service };
}

function count(table: string) {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  }).count;
}

function createConfirmedPerson(accountId: string, key: string) {
  const admission = createPersonAdmissionRepository(database);
  const candidate = admission.createPersonCandidate({
    accountId,
    idempotencyKey: key,
    displayName: "Alice",
    now: NOW
  });
  return admission.confirmPerson({
    accountId,
    personId: candidate.id,
    expectedVersion: candidate.version,
    now: NOW
  });
}

describe("Daily Reflection existing-Memory admission", () => {
  it("admits only eligible kept candidates from a fenced extracting upload", async () => {
    const admittedSegment = trustedSegment({
      id: "segment_admitted",
      text: "I usually prefer quiet cafes."
    });
    const rejectedSegment = trustedSegment({
      id: "segment_rejected",
      text: "Today I want peach soda."
    });
    const ignoredSegment = trustedSegment({
      id: "segment_excluded",
      text: "This candidate was excluded."
    });
    const setup = fixture({
      candidates: [
        kept({
          id: "candidate_admitted",
          text: admittedSegment.text,
          segmentId: admittedSegment.id
        }),
        kept({
          id: "candidate_rejected",
          type: "preference",
          text: rejectedSegment.text,
          segmentId: rejectedSegment.id
        }),
        excluded({
          id: "candidate_excluded",
          text: ignoredSegment.text,
          segmentId: ignoredSegment.id
        })
      ],
      segments: [admittedSegment, rejectedSegment, ignoredSegment]
    });

    const results = await setup.service.admit({
      accountId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      confirmationFingerprint: FINGERPRINT
    });

    expect(setup.upload.status).toBe("extracting");
    expect(results).toEqual([
      expect.objectContaining({
        candidateId: "candidate_admitted",
        status: "admitted",
        memoryId: expect.any(String),
        reasonCode: null
      }),
      expect.objectContaining({
        candidateId: "candidate_rejected",
        status: "rejected",
        memoryId: null,
        reasonCode: expect.any(String)
      })
    ]);
    expect(count("memory_items")).toBe(1);
    expect(count("memory_evidence")).toBe(1);
    expect(count("memory_daily_reflection_candidate_receipts")).toBe(2);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM memory_daily_reflection_candidate_receipts
      WHERE candidate_id = 'candidate_excluded'
    `).get()).toEqual({ count: 0 });
  });

  it("keeps all-excluded confirmation outside Memory and skips canonical asset reads", async () => {
    const setup = fixture({
      candidates: [excluded({
        id: "candidate_excluded",
        text: "Do not keep this.",
        segmentId: "segment_excluded"
      })]
    });
    const publish = vi.spyOn(setup.publicationRepository, "publish");

    await expect(setup.service.admit({
      accountId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      confirmationFingerprint: FINGERPRINT
    })).resolves.toEqual([]);

    expect(setup.sourceRepository.readPublishedAsset).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(count("memory_items")).toBe(0);
    expect(count("person_evidence")).toBe(0);
    expect(count("memory_daily_reflection_publications")).toBe(0);
  });

  it("fails closed when an immutable Evidence snapshot no longer matches the published segment", async () => {
    const segment = trustedSegment({
      id: "segment_snapshot_drift",
      text: "I usually prefer quiet cafes."
    });
    const drifted = kept({
      id: "candidate_snapshot_drift",
      text: "I usually prefer oat milk.",
      segmentId: segment.id
    });
    const setup = fixture({ candidates: [drifted], segments: [segment] });

    await expect(setup.service.admit({
      accountId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      confirmationFingerprint: FINGERPRINT
    })).rejects.toMatchObject({
      code: "daily_reflection_canonical_evidence_invalid"
    });
    expect(count("memory_items")).toBe(0);
    expect(count("memory_daily_reflection_publications")).toBe(0);
    expect(count("person_evidence")).toBe(0);
  });

  it("fails closed with zero Memory-side writes when owner Identity is unknown", async () => {
    const segment = trustedSegment({
      id: "segment_unknown_owner",
      text: "I usually prefer quiet cafes.",
      withIdentity: false
    });
    const setup = fixture({
      candidates: [kept({
        id: "candidate_unknown_owner",
        text: segment.text,
        segmentId: segment.id
      })],
      segments: [segment]
    });
    await expect(setup.service.admit({
      accountId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      confirmationFingerprint: FINGERPRINT
    })).resolves.toEqual([
      expect.objectContaining({
        status: "rejected",
        reasonCode: "verified_owner_required",
        memoryId: null
      })
    ]);
    expect(count("memory_items")).toBe(0);
    expect(count("memory_daily_reflection_publications")).toBe(0);
    expect(count("person_subject_observations")).toBe(0);
  });

  it("replaces the complete upload set once and replays a committed publication without duplication", async () => {
    createMemoryRepository(database).replaceUploadMemories({
      userId: ACCOUNT_ID,
      uploadId: UPLOAD_ID,
      memories: [{
        id: "stale_memory",
        type: "summary",
        title: "Stale",
        summary: "Stale upload content",
        importance: 0.4,
        date: "2026-08-13",
        createdAt: NOW,
        updatedAt: NOW,
        evidence: [{
          id: "stale_evidence",
          sourceType: "transcript",
          sourceId: "stale_segment",
          uploadId: UPLOAD_ID,
          date: "2026-08-13",
          quote: "Stale upload content",
          createdAt: NOW
        }]
      }]
    });
    const firstPreference = trustedSegment({
      id: "segment_preference_quiet",
      text: "I usually prefer quiet cafes."
    });
    const preference = trustedSegment({
      id: "segment_preference",
      text: "I usually prefer oat milk."
    });
    const setup = fixture({
      candidates: [
        kept({
          id: "candidate_preference_quiet",
          type: "preference",
          text: firstPreference.text,
          segmentId: firstPreference.id
        }),
        kept({
          id: "candidate_preference",
          type: "preference",
          text: preference.text,
          segmentId: preference.id
        })
      ],
      segments: [firstPreference, preference]
    });

    const first = await setup.service.admit({
      accountId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      confirmationFingerprint: FINGERPRINT
    });
    expect(first.map((result) => result.status)).toEqual(["admitted", "admitted"]);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM memory_evidence WHERE id = 'stale_evidence'
    `).get()).toEqual({ count: 0 });
    const countsAfterFirst = {
      memories: count("memory_items"),
      evidence: count("memory_evidence"),
      receipts: count("memory_daily_reflection_candidate_receipts")
    };
    const second = await setup.service.admit({
      accountId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      confirmationFingerprint: FINGERPRINT
    });
    expect(second.map((result) => result.status)).toEqual([
      "already_admitted",
      "already_admitted"
    ]);
    expect({
      memories: count("memory_items"),
      evidence: count("memory_evidence"),
      receipts: count("memory_daily_reflection_candidate_receipts")
    }).toEqual(countsAfterFirst);
    expect(database.prepare(`
      SELECT occurrence_count FROM memory_items ORDER BY id
    `).all()).toEqual([
      { occurrence_count: 1 },
      { occurrence_count: 1 }
    ]);
  });

  it("round-trips user_reflection provenance while keeping ordinary Memory and Person reads unpublished", async () => {
    const person = createConfirmedPerson(ACCOUNT_ID, "alice");
    const segment = trustedSegment({
      id: "segment_subject",
      text: "I usually prefer quiet cafes."
    });
    const setup = fixture({
      candidates: [kept({
        id: "candidate_subject",
        text: segment.text,
        segmentId: segment.id,
        subjectPersonId: person.id
      })],
      segments: [segment]
    });
    database.exec(`
      CREATE TEMP TRIGGER require_reflection_publication_guard
      BEFORE INSERT ON memory_evidence
      WHEN NEW.upload_id = '${UPLOAD_ID}'
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM memory_daily_reflection_publications
          WHERE user_id = '${ACCOUNT_ID}'
            AND upload_id = NEW.upload_id
            AND status = 'unpublished'
        ) THEN RAISE(ABORT, 'daily reflection publication guard missing') END;
      END;
    `);

    const [result] = await setup.service.admit({
      accountId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      confirmationFingerprint: FINGERPRINT
    });
    expect(result).toMatchObject({ status: "admitted", memoryId: expect.any(String) });
    expect(database.prepare(`
      SELECT source_origin, status FROM memory_daily_reflection_publications
    `).get()).toEqual({ source_origin: "user_reflection", status: "unpublished" });
    expect(database.prepare(`
      SELECT source_origin, source_segment_id, content_digest
      FROM memory_daily_reflection_evidence_provenance
    `).get()).toEqual({
      source_origin: "user_reflection",
      source_segment_id: segment.id,
      content_digest: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(count("person_subject_observations")).toBe(1);
    expect(createMemoryRepository(database).getRelevantMemories({ userId: ACCOUNT_ID }))
      .toEqual([]);
    expect(createPersonMemoryRepository(database).getPersonMemories({
      accountId: ACCOUNT_ID,
      personId: person.id
    }))?.toMatchObject({ memories: [] });

    setup.publicationRepository.markPublished({
      userId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      now: NOW
    });
    expect(createMemoryRepository(database).getRelevantMemories({ userId: ACCOUNT_ID }))
      .toEqual([expect.objectContaining({ id: result.memoryId })]);
    expect(createPersonMemoryRepository(database).getPersonMemories({
      accountId: ACCOUNT_ID,
      personId: person.id
    }))?.toMatchObject({
      memories: [expect.objectContaining({
        memory: expect.objectContaining({ id: result.memoryId }),
        sourceAttribution: {
          origin: "user_reflection",
          statement: "你在 2026-08-13 的复盘中提到……",
          date: "2026-08-13",
          contentKind: "user_confirmed_derived_content",
          reflectionId: REFLECTION_ID,
          sourceSegmentIds: [segment.id]
        },
        subjectPersonIds: [person.id]
      })]
    });
  });

  it("keeps unpublished reflection content isolated from visible Memory merges and relations", () => {
    const repository = createMemoryRepository(database);
    repository.replaceUploadMemories({
      userId: ACCOUNT_ID,
      uploadId: "upload_visible_memory",
      memories: [{
        id: "memory_visible_preference",
        type: "summary",
        title: "Visible quiet cafe preference",
        summary: "I usually prefer quiet cafes.",
        importance: 0.5,
        date: "2026-08-13",
        createdAt: "2026-08-13T09:00:00.000Z",
        updatedAt: "2026-08-13T09:00:00.000Z",
        evidence: [{
          id: "evidence_visible_preference",
          sourceType: "transcript",
          sourceId: "segment_visible_preference",
          uploadId: "upload_visible_memory",
          date: "2026-08-13",
          quote: "I usually prefer quiet cafes.",
          createdAt: "2026-08-13T09:00:00.000Z"
        }]
      }]
    });
    database.prepare(`
      INSERT INTO memory_daily_reflection_publications (
        id, user_id, reflection_id, confirmation_id, upload_id,
        confirmation_fingerprint, payload_digest, source_origin, status,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'user_reflection', 'unpublished', ?, ?, NULL)
    `).run(
      "publication_isolated_hidden",
      ACCOUNT_ID,
      "reflection_isolated_hidden",
      "confirmation_isolated_hidden",
      UPLOAD_ID,
      "c".repeat(64),
      "d".repeat(64),
      NOW,
      NOW
    );
    repository.replaceUploadMemories({
      userId: ACCOUNT_ID,
      uploadId: UPLOAD_ID,
      memories: [{
        id: "memory_hidden_preference",
        type: "summary",
        title: "UNPUBLISHED private wording",
        summary: "I usually prefer quiet cafes.",
        importance: 0.5,
        date: "2026-08-13",
        createdAt: NOW,
        updatedAt: NOW,
        evidence: [{
          id: "evidence_hidden_preference",
          sourceType: "transcript",
          sourceId: "segment_hidden_preference",
          uploadId: UPLOAD_ID,
          date: "2026-08-13",
          quote: "I usually prefer quiet cafes.",
          createdAt: NOW
        }]
      }]
    });

    expect(count("memory_items")).toBe(2);
    expect(repository.getRelevantMemories({ userId: ACCOUNT_ID })).toEqual([
      expect.objectContaining({
        id: "memory_visible_preference",
        title: "Visible quiet cafe preference",
        evidence: [expect.objectContaining({ uploadId: "upload_visible_memory" })]
      })
    ]);
    expect(repository.getMemoryRelations(ACCOUNT_ID)).toEqual([]);
    expect(repository.getMemoryOwnerAttributions(
      ACCOUNT_ID,
      ["memory_hidden_preference"]
    )).toEqual([]);

    repository.deleteByUpload(ACCOUNT_ID, UPLOAD_ID);
    expect(repository.getRelevantMemories({ userId: ACCOUNT_ID })).toEqual([
      expect.objectContaining({
        id: "memory_visible_preference",
        title: "Visible quiet cafe preference",
        summary: "I usually prefer quiet cafes."
      })
    ]);
    expect(count("memory_items")).toBe(1);
  });

  it("replays a committed Memory publication under a new fenced attempt after receipt failure", async () => {
    const segment = trustedSegment({
      id: "segment_crash_replay",
      text: "I usually prefer quiet cafes."
    });
    const setup = fixture({
      candidates: [kept({
        id: "candidate_crash_replay",
        text: segment.text,
        segmentId: segment.id
      })],
      segments: [segment]
    });
    const startAdmissionOperation = vi.fn()
      .mockReturnValueOnce({
        operation: { id: "operation_memory" },
        executionFence: {
          leaseOwner: "worker_first",
          leaseUntil: "2026-08-13T08:01:00.000Z",
          attemptVersion: 1
        },
        reused: false
      })
      .mockReturnValueOnce({
        operation: { id: "operation_memory" },
        executionFence: {
          leaseOwner: "worker_second",
          leaseUntil: "2026-08-13T08:02:00.000Z",
          attemptVersion: 2
        },
        reused: false
      });
    const completeAdmissionOperation = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("simulated_receipt_failure");
      })
      .mockImplementationOnce((input: { results: CandidateAdmissionResult[] }) => ({
        operation: { id: "operation_memory" },
        results: input.results,
        reused: false
      }));
    const failAdmissionOperation = vi.fn();
    const onPublicationVisible = vi.fn();
    const sourceRepository = {
      ...setup.sourceRepository,
      startAdmissionOperation,
      completeAdmissionOperation,
      failAdmissionOperation,
      listAdmissionResults: vi.fn(() => [])
    } as unknown as DailyReflectionRepository;
    const orchestrator = createDailyReflectionMemoryAdmissionOrchestrator({
      sourceRepository,
      publicationRepository: setup.publicationRepository,
      personRepository: createPersonRepository(database),
      now: () => NOW,
      onPublicationVisible
    });

    await expect(orchestrator.admitUnderLease({
      accountId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      leaseOwner: "worker_first",
      leaseDurationMs: 60_000,
      now: NOW
    })).rejects.toThrow("simulated_receipt_failure");
    expect(database.prepare(`
      SELECT status FROM memory_daily_reflection_publications
    `).get()).toEqual({ status: "unpublished" });
    expect(onPublicationVisible).not.toHaveBeenCalled();
    const countsAfterMemoryCommit = {
      memories: count("memory_items"),
      evidence: count("memory_evidence"),
      occurrences: database.prepare(`
        SELECT occurrence_count FROM memory_items ORDER BY id
      `).all()
    };

    await expect(orchestrator.admitUnderLease({
      accountId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      leaseOwner: "worker_second",
      leaseDurationMs: 60_000,
      now: NOW
    })).resolves.toEqual([
      expect.objectContaining({
        candidateId: "candidate_crash_replay",
        status: "already_admitted"
      })
    ]);
    expect({
      memories: count("memory_items"),
      evidence: count("memory_evidence"),
      occurrences: database.prepare(`
        SELECT occurrence_count FROM memory_items ORDER BY id
      `).all()
    }).toEqual(countsAfterMemoryCommit);
    expect(completeAdmissionOperation).toHaveBeenLastCalledWith(expect.objectContaining({
      leaseOwner: "worker_second",
      attemptVersion: 2
    }));
    expect(failAdmissionOperation).toHaveBeenCalledWith(expect.objectContaining({
      leaseOwner: "worker_first",
      attemptVersion: 1
    }));
    expect(database.prepare(`
      SELECT status FROM memory_daily_reflection_publications
    `).get()).toEqual({ status: "published" });
    expect(onPublicationVisible).toHaveBeenCalledOnce();
    expect(onPublicationVisible).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      uploadId: UPLOAD_ID
    });
  });

  it("rejects cross-account and archived Subjects before Memory publication", async () => {
    const crossAccount = createConfirmedPerson(OTHER_ACCOUNT_ID, "cross-account-alice");
    const admission = createPersonAdmissionRepository(database);
    const archived = createConfirmedPerson(ACCOUNT_ID, "archived-alice");
    admission.archivePerson({
      accountId: ACCOUNT_ID,
      personId: archived.id,
      expectedVersion: archived.version,
      now: NOW
    });
    const crossSegment = trustedSegment({
      id: "segment_cross_subject",
      text: "I usually prefer quiet cafes."
    });
    const archivedSegment = trustedSegment({
      id: "segment_archived_subject",
      text: "I usually prefer oat milk."
    });
    const setup = fixture({
      candidates: [
        kept({
          id: "candidate_cross_subject",
          text: crossSegment.text,
          segmentId: crossSegment.id,
          subjectPersonId: crossAccount.id
        }),
        kept({
          id: "candidate_archived_subject",
          text: archivedSegment.text,
          segmentId: archivedSegment.id,
          subjectPersonId: archived.id
        })
      ],
      segments: [crossSegment, archivedSegment]
    });

    const results = await setup.service.admit({
      accountId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      confirmationFingerprint: FINGERPRINT
    });
    expect(results).toEqual([
      expect.objectContaining({
        candidateId: "candidate_cross_subject",
        status: "rejected",
        reasonCode: "subject_person_not_confirmed"
      }),
      expect.objectContaining({
        candidateId: "candidate_archived_subject",
        status: "rejected",
        reasonCode: "subject_person_not_confirmed"
      })
    ]);
    expect(count("memory_items")).toBe(0);
    expect(count("person_evidence")).toBe(0);
  });

  it("deletes through the shared helper and blocks a late publication replay with a tombstone", async () => {
    const person = createConfirmedPerson(ACCOUNT_ID, "delete-alice");
    const segment = trustedSegment({
      id: "segment_delete",
      text: "I usually prefer quiet cafes."
    });
    const setup = fixture({
      candidates: [kept({
        id: "candidate_delete",
        text: segment.text,
        segmentId: segment.id,
        subjectPersonId: person.id
      })],
      segments: [segment]
    });
    await setup.service.admit({
      accountId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      confirmationFingerprint: FINGERPRINT
    });
    setup.publicationRepository.markPublished({
      userId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      now: NOW
    });
    setup.sourceRepository.getReflection.mockReturnValue({
      id: REFLECTION_ID,
      accountId: ACCOUNT_ID,
      uploadId: UPLOAD_ID,
      inputMethod: "file_upload",
      sourceOrigin: "user_reflection",
      processingProfile: "quick_reflection",
      ingestionContext: "daily_reflection",
      status: "completed",
      version: 6,
      idempotencyKey: "reflection_memory",
      errorCode: null,
      errorMessage: null,
      createdAt: NOW,
      updatedAt: NOW
    } as never);
    const retrievalUpload = {
      ...setup.upload,
      status: "ready" as const,
      ingestionContext: "daily_reflection" as const,
      reflectionId: REFLECTION_ID
    };
    expect(resolveRetrievalUpload({
      userId: ACCOUNT_ID,
      upload: retrievalUpload,
      dependencies: {
        memoryDatabase: database,
        sourceRepository: setup.sourceRepository
      }
    }).visible).toBe(true);

    await deleteMemoryUploadAndRefreshIndex({
      userId: ACCOUNT_ID,
      uploadId: UPLOAD_ID,
      indexRefreshFailure: "throw"
    }, {
      getRepository: () => createMemoryRepository(database),
      resolveExecutionMode: () => "inline",
      resolveHybridMode: () => "off"
    });

    expect(count("memory_items")).toBe(0);
    expect(count("person_evidence")).toBe(0);
    expect(resolveRetrievalUpload({
      userId: ACCOUNT_ID,
      upload: retrievalUpload,
      dependencies: {
        memoryDatabase: database,
        sourceRepository: setup.sourceRepository
      }
    }).visible).toBe(false);
    expect(database.prepare(`
      SELECT status, deleted_at FROM memory_daily_reflection_publications
    `).get()).toEqual({ status: "deleted", deleted_at: expect.any(String) });
    expect(database.prepare(`
      SELECT reason FROM memory_upload_tombstones
      WHERE user_id = ? AND upload_id = ?
    `).get(ACCOUNT_ID, UPLOAD_ID)).toEqual({ reason: "upload_deleted" });
    await expect(setup.service.admit({
      accountId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      confirmationFingerprint: FINGERPRINT
    })).rejects.toEqual(expect.objectContaining({
      code: "daily_reflection_upload_deleted"
    }));
    expect(count("memory_items")).toBe(0);
    expect(count("person_evidence")).toBe(0);
  });

  it("revokes one admitted candidate idempotently without mutating its historical receipt", async () => {
    const person = createConfirmedPerson(ACCOUNT_ID, "revoked-alice");
    const segment = trustedSegment({
      id: "segment_revoked_candidate",
      text: "I prefer a quiet place for our next meeting."
    });
    const setup = fixture({
      candidates: [kept({
        id: "candidate_revoked",
        text: segment.text,
        segmentId: segment.id,
        subjectPersonId: person.id
      })],
      segments: [segment]
    });
    const [admitted] = await setup.service.admit({
      accountId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      confirmationFingerprint: FINGERPRINT
    });
    setup.publicationRepository.markPublished({
      userId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      now: NOW
    });
    const operation = database.prepare(`
      SELECT operation_key FROM memory_daily_reflection_candidate_receipts
      WHERE candidate_id = 'candidate_revoked'
    `).get() as { operation_key: string };
    const payloadDigest = dailyReflectionCandidateRevocationPayloadDigest({
      userId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      confirmationId: "confirmation_memory",
      candidateId: "candidate_revoked",
      operationKey: operation.operation_key
    });
    const revocation = createDailyReflectionMemoryCandidateRevocationRepository(database);
    const input = {
      id: "memory_revocation_candidate",
      userId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      confirmationId: "confirmation_memory",
      candidateId: "candidate_revoked",
      operationKey: operation.operation_key,
      payloadDigest,
      now: "2026-08-13T09:00:00.000Z"
    };

    expect(revocation.apply(input)).toMatchObject({
      historicalMemoryId: admitted!.memoryId,
      removedMemoryEvidenceCount: 1,
      removedPersonSourceCount: 1,
      reused: false
    });
    expect(revocation.apply(input)).toMatchObject({ reused: true });
    expect(() => revocation.apply({
      ...input,
      payloadDigest: "e".repeat(64)
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_candidate_revocation_conflict"
    }));
    expect(count("memory_items")).toBe(0);
    expect(count("memory_evidence")).toBe(0);
    expect(count("person_subject_observations")).toBe(0);
    expect(count("person_subject_admissions")).toBe(0);
    expect(count("person_evidence")).toBe(0);
    expect(count("memory_daily_reflection_candidate_receipts")).toBe(1);
    expect(count("memory_daily_reflection_candidate_revocations")).toBe(1);
    expect(count("memory_daily_reflection_candidate_payloads")).toBe(0);
    expect(database.prepare(`
      SELECT status, current_memory_id
      FROM memory_daily_reflection_candidate_current_memories
      WHERE candidate_id = 'candidate_revoked'
    `).get()).toEqual({ status: "revoked", current_memory_id: null });
    await expect(setup.service.admit({
      accountId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      confirmationFingerprint: FINGERPRINT
    })).resolves.toEqual([
      expect.objectContaining({ candidateId: "candidate_revoked", status: "already_admitted" })
    ]);
    expect(count("memory_items")).toBe(0);
    expect(count("person_evidence")).toBe(0);

    setup.sourceRepository.getReflection.mockReturnValue({
      ...setup.sourceRepository.getReflection(),
      status: "completed"
    } as never);
    const retrievalUpload = {
      ...setup.upload,
      status: "ready" as const,
      ingestionContext: "daily_reflection" as const,
      reflectionId: REFLECTION_ID
    };
    expect(resolveRetrievalUpload({
      userId: ACCOUNT_ID,
      upload: retrievalUpload,
      dependencies: {
        memoryDatabase: database,
        sourceRepository: setup.sourceRepository
      }
    }).visible).toBe(false);
  });

  it("rebuilds a consolidated Memory from only the still-active candidate", async () => {
    const first = trustedSegment({
      id: "segment_consolidated_first",
      text: "I usually prefer oat milk."
    });
    const second = trustedSegment({
      id: "segment_consolidated_second",
      text: "I usually prefer oat milk."
    });
    const setup = fixture({
      candidates: [
        kept({
          id: "candidate_consolidated_first",
          type: "preference",
          text: first.text,
          segmentId: first.id
        }),
        kept({
          id: "candidate_consolidated_second",
          type: "preference",
          text: second.text,
          segmentId: second.id
        })
      ],
      segments: [first, second]
    });
    await setup.service.admit({
      accountId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      confirmationFingerprint: FINGERPRINT
    });
    setup.publicationRepository.markPublished({
      userId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      now: NOW
    });
    expect(count("memory_items")).toBe(2);
    createMemoryRepository(database).rebuildUserMemories(ACCOUNT_ID);
    expect(count("memory_items")).toBe(1);
    expect(count("memory_evidence")).toBe(2);
    const operation = database.prepare(`
      SELECT operation_key FROM memory_daily_reflection_candidate_receipts
      WHERE candidate_id = 'candidate_consolidated_first'
    `).get() as { operation_key: string };
    createDailyReflectionMemoryCandidateRevocationRepository(database).apply({
      id: "memory_revocation_consolidated",
      userId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      confirmationId: "confirmation_memory",
      candidateId: "candidate_consolidated_first",
      operationKey: operation.operation_key,
      payloadDigest: dailyReflectionCandidateRevocationPayloadDigest({
        userId: ACCOUNT_ID,
        reflectionId: REFLECTION_ID,
        confirmationId: "confirmation_memory",
        candidateId: "candidate_consolidated_first",
        operationKey: operation.operation_key
      }),
      now: "2026-08-13T09:00:00.000Z"
    });

    expect(count("memory_items")).toBe(1);
    expect(count("memory_evidence")).toBe(1);
    expect(database.prepare("SELECT occurrence_count FROM memory_items").get())
      .toEqual({ occurrence_count: 1 });
    const active = database.prepare(`
      SELECT current.current_memory_id, evidence.memory_id
      FROM memory_daily_reflection_candidate_current_memories current
      INNER JOIN memory_daily_reflection_evidence_provenance provenance
        ON provenance.user_id = current.user_id
        AND provenance.publication_id = current.publication_id
        AND provenance.candidate_id = current.candidate_id
      INNER JOIN memory_evidence evidence ON evidence.id = provenance.memory_evidence_id
      WHERE current.candidate_id = 'candidate_consolidated_second'
        AND current.status = 'active'
    `).get() as { current_memory_id: string; memory_id: string };
    expect(active.current_memory_id).toBe(active.memory_id);
  });

  it("preserves a Person projection while another candidate source still supports it", async () => {
    const person = createConfirmedPerson(ACCOUNT_ID, "shared-person");
    const quiet = trustedSegment({
      id: "segment_person_quiet",
      text: "I usually prefer quiet cafes."
    });
    const oat = trustedSegment({
      id: "segment_person_oat",
      text: "I usually prefer oat milk."
    });
    const setup = fixture({
      candidates: [
        kept({
          id: "candidate_person_quiet",
          text: quiet.text,
          segmentId: quiet.id,
          subjectPersonId: person.id
        }),
        kept({
          id: "candidate_person_oat",
          text: oat.text,
          segmentId: oat.id,
          subjectPersonId: person.id
        })
      ],
      segments: [quiet, oat]
    });
    await setup.service.admit({
      accountId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      confirmationFingerprint: FINGERPRINT
    });
    setup.publicationRepository.markPublished({
      userId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      now: NOW
    });
    expect(count("person_evidence")).toBe(2);
    expect(count("person_subject_observations")).toBe(2);
    const operation = database.prepare(`
      SELECT operation_key FROM memory_daily_reflection_candidate_receipts
      WHERE candidate_id = 'candidate_person_quiet'
    `).get() as { operation_key: string };
    createDailyReflectionMemoryCandidateRevocationRepository(database).apply({
      id: "memory_revocation_person_quiet",
      userId: ACCOUNT_ID,
      reflectionId: REFLECTION_ID,
      confirmationId: "confirmation_memory",
      candidateId: "candidate_person_quiet",
      operationKey: operation.operation_key,
      payloadDigest: dailyReflectionCandidateRevocationPayloadDigest({
        userId: ACCOUNT_ID,
        reflectionId: REFLECTION_ID,
        confirmationId: "confirmation_memory",
        candidateId: "candidate_person_quiet",
        operationKey: operation.operation_key
      }),
      now: "2026-08-13T09:00:00.000Z"
    });

    expect(count("person_evidence")).toBe(1);
    expect(count("person_subject_observations")).toBe(1);
    expect(createPersonMemoryRepository(database).getPersonMemories({
      accountId: ACCOUNT_ID,
      personId: person.id
    }))?.toMatchObject({
      memories: [expect.objectContaining({
        evidenceLinks: [expect.objectContaining({
          personEvidence: expect.objectContaining({ sourceSegmentId: oat.id })
        })]
      })]
    });
  });
});

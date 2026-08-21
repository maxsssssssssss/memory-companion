// @vitest-environment node

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioUpload, TranscriptSegment } from "@/lib/domain/types";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createMemoryRepository } from "@/lib/server/memory/repository";

import {
  resolveMemoryRetrievalSource,
  resolveRetrievalUpload,
  retrievalSourceStatement
} from "./source-awareness";

const USER_ID = "reflection_user";
const OTHER_USER_ID = "other_user";
const REFLECTION_ID = "reflection_source";
const UPLOAD_ID = "daily-reflection-reflection_source";
const DATE = "2026-08-13";
const NOW = "2026-08-13T10:00:00.000Z";
const SEGMENT_ID = "segment_kept";
const MEMORY_ID = "memory_kept";
const EVIDENCE_ID = "evidence_kept";
const PUBLICATION_ID = "publication_kept";

let database: Database.Database;

beforeEach(() => {
  database = openMemoryDatabase({ filePath: ":memory:" });
});

afterEach(() => database.close());

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function upload(): AudioUpload & {
  ingestionContext: "daily_reflection";
  reflectionId: string;
} {
  return {
    id: UPLOAD_ID,
    originalName: "reflection.wav",
    mimeType: "audio/wav",
    sizeBytes: 128,
    recordingDate: DATE,
    status: "ready",
    ingestionContext: "daily_reflection",
    reflectionId: REFLECTION_ID
  };
}

function segment(id = SEGMENT_ID, text = "I prefer a quiet cafe."): TranscriptSegment {
  return {
    id,
    uploadId: UPLOAD_ID,
    speaker: "self",
    startSeconds: id === SEGMENT_ID ? 0 : 8,
    endSeconds: id === SEGMENT_ID ? 8 : 16,
    text,
    confidence: 0.99,
    sceneLabels: ["self_reflection"],
    valueLabels: ["notable_quote"]
  };
}

function seedPublication(
  status: "unpublished" | "published" | "deleted",
  sourceOrigin: "user_reflection" | "direct_conversation" = "user_reflection"
) {
  const canonical = segment();
  const contractVersion = sourceOrigin === "direct_conversation" ? 2 : 1;
  database.prepare(`
    INSERT INTO memory_daily_reflection_publications (
      id, user_id, reflection_id, confirmation_id, upload_id,
      confirmation_fingerprint, payload_digest, source_origin,
      effective_source_origin, content_kind, status,
      created_at, updated_at, deleted_at, contract_version, save_intent,
      input_adapter, capture_purpose, recording_date
    ) VALUES (?, ?, ?, 'confirmation_source', ?, ?, ?, 'user_reflection', ?,
      'user_confirmed_derived_content', ?, ?, ?, ?, ?, 'retain_selected', ?, ?, ?)
  `).run(
    PUBLICATION_ID,
    USER_ID,
    REFLECTION_ID,
    UPLOAD_ID,
    "a".repeat(64),
    "b".repeat(64),
    sourceOrigin,
    status,
    NOW,
    NOW,
    status === "deleted" ? NOW : null,
    contractVersion,
    contractVersion === 2 ? "file_picker" : null,
    contractVersion === 2 ? "inspiration_capture" : null,
    contractVersion === 2 ? DATE : null
  );
  createMemoryRepository(database).replaceUploadMemories({
    userId: USER_ID,
    uploadId: UPLOAD_ID,
    memories: [{
      id: MEMORY_ID,
      type: "preference",
      title: "Quiet cafe",
      summary: "I prefer a quiet cafe.",
      importance: 0.8,
      date: DATE,
      createdAt: NOW,
      updatedAt: NOW,
      evidence: [{
        id: EVIDENCE_ID,
        sourceType: "transcript",
        sourceId: SEGMENT_ID,
        uploadId: UPLOAD_ID,
        date: DATE,
        quote: canonical.text,
        createdAt: NOW
      }]
    }],
    sourceSegments: [canonical]
  });
  database.prepare(`
    INSERT INTO memory_daily_reflection_candidate_receipts (
      user_id, publication_id, candidate_id, status, memory_id,
      reason_code, operation_key, created_at
    ) VALUES (?, ?, 'candidate_kept', 'admitted', ?, NULL, 'operation_kept', ?)
  `).run(USER_ID, PUBLICATION_ID, MEMORY_ID, NOW);
  database.prepare(`
    INSERT INTO memory_daily_reflection_candidate_current_memories (
      user_id, publication_id, reflection_id, confirmation_id, candidate_id,
      status, current_memory_id, revocation_id, created_at, updated_at, revoked_at
    ) VALUES (?, ?, ?, 'confirmation_source', 'candidate_kept',
      'active', ?, NULL, ?, ?, NULL)
  `).run(USER_ID, PUBLICATION_ID, REFLECTION_ID, MEMORY_ID, NOW, NOW);
  database.prepare(`
    INSERT INTO memory_daily_reflection_evidence_provenance (
      memory_evidence_id, user_id, publication_id, reflection_id,
      confirmation_id, candidate_id, upload_id, source_segment_id,
      source_origin, effective_source_origin, content_kind,
      content_digest, created_at
    ) VALUES (?, ?, ?, ?, 'confirmation_source', 'candidate_kept', ?, ?,
      'user_reflection', ?, 'user_confirmed_derived_content', ?, ?)
  `).run(
    EVIDENCE_ID,
    USER_ID,
    PUBLICATION_ID,
    REFLECTION_ID,
    UPLOAD_ID,
    SEGMENT_ID,
    sourceOrigin,
    hash({
      version: 1,
      accountId: USER_ID,
      reflectionId: REFLECTION_ID,
      uploadId: UPLOAD_ID,
      sourceSegmentId: SEGMENT_ID,
      quote: canonical.text,
      sourceOrigin
    }),
    NOW
  );
  return canonical;
}

function sourceRepository(
  segments: TranscriptSegment[],
  sourceOrigin: "user_reflection" | "direct_conversation" = "user_reflection"
) {
  return {
    getReflection: vi.fn((accountId: string, reflectionId: string) =>
      accountId === USER_ID && reflectionId === REFLECTION_ID
        ? {
            id: REFLECTION_ID,
            accountId: USER_ID,
            uploadId: UPLOAD_ID,
            status: "completed"
          }
        : null
    ),
    getProcessingPlan: vi.fn((accountId: string, reflectionId: string) =>
      accountId === USER_ID && reflectionId === REFLECTION_ID
        ? {
            reflectionId: REFLECTION_ID,
            uploadId: UPLOAD_ID,
            sourceOrigin,
            ingestionContext: "daily_reflection",
            reviewPolicy: "required"
          }
        : null
    ),
    readPublishedAsset: vi.fn((input: { accountId: string; assetKind: string }) => {
      if (input.accountId !== USER_ID) throw new Error("not_found");
      return input.assetKind === "upload" ? upload() : segments;
    })
  };
}

describe("retrieval source awareness", () => {
  it("uses the published provenance allowlist and canonical Reflection transcript", () => {
    const canonical = seedPublication("published");
    const excluded = segment("segment_excluded", "This candidate was excluded.");
    const dependencies = {
      memoryDatabase: database,
      sourceRepository: sourceRepository([canonical, excluded])
    };

    const resolved = resolveRetrievalUpload({
      userId: USER_ID,
      upload: upload(),
      dependencies
    });

    expect(resolved).toMatchObject({
      visible: true,
      attribution: {
        origin: "user_reflection",
        statement: `你在 ${DATE} 的复盘中提到……`,
        contentKind: "user_confirmed_derived_content",
        sourceSegmentIds: [SEGMENT_ID]
      }
    });
    expect(resolved.canonicalSegments).toEqual([canonical]);

    const memory = createMemoryRepository(database)
      .getRelevantMemories({ userId: USER_ID })[0]!;
    expect(resolveMemoryRetrievalSource({ userId: USER_ID, memory, dependencies }))
      .toMatchObject({
        eligible: true,
        attribution: {
          origin: "user_reflection",
          memoryId: MEMORY_ID,
          sourceSegmentIds: [SEGMENT_ID]
        }
      });
  });

  it("keeps direct-conversation origin separate from user-confirmed derived content", () => {
    const canonical = seedPublication("unpublished", "direct_conversation");
    const dependencies = {
      memoryDatabase: database,
      sourceRepository: sourceRepository([canonical], "direct_conversation")
    };

    expect(resolveRetrievalUpload({ userId: USER_ID, upload: upload(), dependencies }).visible)
      .toBe(false);
    database.prepare(`
      UPDATE memory_daily_reflection_publications SET status = 'published'
      WHERE id = ?
    `).run(PUBLICATION_ID);
    expect(resolveRetrievalUpload({
      userId: OTHER_USER_ID,
      upload: upload(),
      dependencies
    }).visible).toBe(false);

    expect(resolveRetrievalUpload({ userId: USER_ID, upload: upload(), dependencies }))
      .toMatchObject({
        visible: true,
        canonicalSegments: [canonical],
        attribution: {
          origin: "direct_conversation",
          statement: `在 ${DATE} 的交流中提到……`,
          contentKind: "user_confirmed_derived_content",
          sourceSegmentIds: [SEGMENT_ID]
        }
      });
    const memory = createMemoryRepository(database)
      .getRelevantMemories({ userId: USER_ID })[0]!;
    expect(resolveMemoryRetrievalSource({ userId: USER_ID, memory, dependencies }))
      .toMatchObject({
        eligible: true,
        attribution: {
          origin: "direct_conversation",
          contentKind: "user_confirmed_derived_content"
        }
      });
    database.prepare(`
      UPDATE memory_daily_reflection_evidence_provenance
      SET content_digest = ? WHERE memory_evidence_id = ?
    `).run("f".repeat(64), EVIDENCE_ID);
    expect(resolveRetrievalUpload({ userId: USER_ID, upload: upload(), dependencies }).visible)
      .toBe(false);
  });

  it("fails closed for unpublished, deleted, cross-account, and drifted evidence", () => {
    const canonical = seedPublication("unpublished");
    const dependencies = {
      memoryDatabase: database,
      sourceRepository: sourceRepository([canonical])
    };
    expect(resolveRetrievalUpload({ userId: USER_ID, upload: upload(), dependencies }).visible)
      .toBe(false);
    expect(resolveRetrievalUpload({ userId: OTHER_USER_ID, upload: upload(), dependencies }).visible)
      .toBe(false);

    database.prepare(`
      UPDATE memory_daily_reflection_publications SET status = 'published'
      WHERE id = ?
    `).run(PUBLICATION_ID);
    expect(resolveRetrievalUpload({
      userId: USER_ID,
      upload: upload(),
      dependencies: {
        memoryDatabase: database,
        sourceRepository: sourceRepository([
          segment(SEGMENT_ID, "Canonical transcript was changed.")
        ])
      }
    }).visible).toBe(false);

    database.prepare(`
      UPDATE memory_daily_reflection_publications
      SET status = 'deleted', deleted_at = ? WHERE id = ?
    `).run(NOW, PUBLICATION_ID);
    expect(resolveRetrievalUpload({ userId: USER_ID, upload: upload(), dependencies }).visible)
      .toBe(false);
  });

  it("fails closed for revoked candidate provenance even while stale evidence remains", () => {
    const canonical = seedPublication("published");
    const dependencies = {
      memoryDatabase: database,
      sourceRepository: sourceRepository([canonical])
    };
    expect(resolveRetrievalUpload({ userId: USER_ID, upload: upload(), dependencies }).visible)
      .toBe(true);
    database.prepare(`
      UPDATE memory_daily_reflection_candidate_current_memories
      SET status = 'revoked', current_memory_id = NULL,
        revocation_id = 'revocation_stale', revoked_at = ?, updated_at = ?
      WHERE user_id = ? AND publication_id = ? AND candidate_id = 'candidate_kept'
    `).run(NOW, NOW, USER_ID, PUBLICATION_ID);
    database.prepare(`
      INSERT INTO memory_daily_reflection_candidate_revocations (
        id, user_id, publication_id, reflection_id, confirmation_id,
        candidate_id, upload_id, operation_key, payload_digest, outcome,
        historical_memory_id, removed_memory_evidence_count,
        removed_person_source_count, created_at
      ) VALUES ('revocation_stale', ?, ?, ?, 'confirmation_source',
        'candidate_kept', ?, 'revocation_operation', ?, 'revoked', ?, 1, 0, ?)
    `).run(USER_ID, PUBLICATION_ID, REFLECTION_ID, UPLOAD_ID, "f".repeat(64), MEMORY_ID, NOW);

    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_evidence").get())
      .toEqual({ count: 1 });
    expect(resolveRetrievalUpload({ userId: USER_ID, upload: upload(), dependencies }).visible)
      .toBe(false);
    const memory = createMemoryRepository(database).getRelevantMemories({ userId: USER_ID })[0]!;
    expect(resolveMemoryRetrievalSource({ userId: USER_ID, memory, dependencies }))
      .toMatchObject({ eligible: false });
  });

  it("fails closed on an account-scoped tombstone even if publication still says published", () => {
    const canonical = seedPublication("published");
    const dependencies = {
      memoryDatabase: database,
      sourceRepository: sourceRepository([canonical])
    };
    database.prepare(`
      INSERT INTO memory_upload_tombstones (user_id, upload_id, reason, deleted_at)
      VALUES (?, ?, 'upload_deleted', ?)
    `).run(USER_ID, UPLOAD_ID, NOW);

    expect(resolveRetrievalUpload({ userId: USER_ID, upload: upload(), dependencies }).visible)
      .toBe(false);
    expect(resolveRetrievalUpload({ userId: OTHER_USER_ID, upload: upload(), dependencies }).visible)
      .toBe(false);
  });

  it("keeps ordinary recordings source-aware without asserting Reflection provenance", () => {
    const ordinary: AudioUpload = {
      id: "ordinary_upload",
      originalName: "conversation.wav",
      mimeType: "audio/wav",
      sizeBytes: 64,
      recordingDate: DATE,
      status: "ready"
    };
    expect(resolveRetrievalUpload({ upload: ordinary })).toMatchObject({
      visible: true,
      attribution: {
        origin: "direct_conversation",
        statement: `在 ${DATE} 的交流中提到……`
      }
    });
    expect(retrievalSourceStatement("unknown", DATE)).toBe("来源尚未完全确认");
  });
});

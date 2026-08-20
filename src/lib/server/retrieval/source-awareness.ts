import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import {
  AudioUploadSchema,
  type AudioUpload,
  type TranscriptSegment
} from "@/lib/domain/types";
import { getDailyReflectionDatabase } from "@/lib/server/daily-reflection/db";
import { parseDailyReflectionCanonicalTranscript } from "@/lib/server/daily-reflection/canonical-transcript";
import {
  createDailyReflectionRepository
} from "@/lib/server/daily-reflection/repository";
import { isDailyReflectionUpload } from "@/lib/server/daily-reflection/upload-record";
import { getMemoryDatabase } from "@/lib/server/memory/db";
import type { MemoryItem } from "@/lib/server/memory/types";

export type RetrievalSourceOrigin =
  | "user_reflection"
  | "direct_conversation"
  | "unknown";

export type RetrievalSourceAttribution = {
  origin: RetrievalSourceOrigin;
  statement: string;
  date: string;
  contentKind: "user_confirmed_derived_content" | "memory_navigation";
  reflectionId?: string;
  sourceSegmentIds: string[];
};

export type MemoryRetrievalSourceAttribution = RetrievalSourceAttribution & {
  memoryId: string;
};

export type RetrievalUploadResolution = {
  visible: boolean;
  attribution: RetrievalSourceAttribution;
  canonicalSegments?: TranscriptSegment[];
};

type PublicationRow = {
  id: string;
  reflection_id: string;
  upload_id: string;
  source_origin: "user_reflection";
  status: "unpublished" | "published" | "deleted";
};

type ProvenanceRow = {
  memory_evidence_id: string;
  memory_id: string;
  source_segment_id: string;
  quote: string;
  content_digest: string;
};

type SourceAwarenessDependencies = {
  memoryDatabase: Database.Database;
  sourceRepository: {
    getReflection(accountId: string, reflectionId: string): {
      id: string;
      accountId: string;
      uploadId: string | null;
      status: string;
    } | null;
    getProcessingPlan(accountId: string, reflectionId: string): {
      reflectionId: string;
      uploadId: string;
      sourceOrigin: string;
      ingestionContext: string;
      reviewPolicy: string;
    } | null;
    readPublishedAsset(input: {
      accountId: string;
      reflectionId: string;
      assetKind: "upload" | "segments";
    }): unknown;
  };
};

function defaultDependencies(): SourceAwarenessDependencies {
  return {
    memoryDatabase: getMemoryDatabase(),
    sourceRepository: createDailyReflectionRepository(getDailyReflectionDatabase())
  };
}

function resolveDependencies(
  dependencies: Partial<SourceAwarenessDependencies> | undefined
): SourceAwarenessDependencies {
  if (dependencies?.memoryDatabase && dependencies.sourceRepository) {
    return dependencies as SourceAwarenessDependencies;
  }
  return { ...defaultDependencies(), ...dependencies };
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function retrievalSourceStatement(origin: RetrievalSourceOrigin, date: string) {
  if (origin === "user_reflection") {
    return `你在 ${date} 的复盘中提到……`;
  }
  if (origin === "direct_conversation") {
    return `在 ${date} 的交流中提到……`;
  }
  return "来源尚未完全确认";
}

function attribution(input: {
  origin: RetrievalSourceOrigin;
  date: string;
  reflectionId?: string;
  sourceSegmentIds: string[];
}): RetrievalSourceAttribution {
  return {
    origin: input.origin,
    statement: retrievalSourceStatement(input.origin, input.date),
    date: input.date,
    contentKind: input.origin === "user_reflection"
      ? "user_confirmed_derived_content"
      : "memory_navigation",
    ...(input.reflectionId ? { reflectionId: input.reflectionId } : {}),
    sourceSegmentIds: [...new Set(input.sourceSegmentIds)]
  };
}

function publicationForUpload(
  database: Database.Database,
  userId: string,
  uploadId: string
) {
  return database.prepare(`
    SELECT id, reflection_id, upload_id, source_origin, status
    FROM memory_daily_reflection_publications
    WHERE user_id = ? AND upload_id = ?
  `).get(userId, uploadId) as PublicationRow | undefined;
}

function provenanceForPublication(
  database: Database.Database,
  userId: string,
  publicationId: string
) {
  return database.prepare(`
    SELECT provenance.memory_evidence_id,
      evidence.memory_id,
      provenance.source_segment_id,
      evidence.quote,
      provenance.content_digest
    FROM memory_daily_reflection_evidence_provenance provenance
    INNER JOIN memory_evidence evidence
      ON evidence.id = provenance.memory_evidence_id
      AND evidence.upload_id = provenance.upload_id
      AND evidence.source_id = provenance.source_segment_id
    INNER JOIN memory_items memory
      ON memory.id = evidence.memory_id
      AND memory.user_id = provenance.user_id
    INNER JOIN memory_daily_reflection_candidate_receipts receipt
      ON receipt.user_id = provenance.user_id
      AND receipt.publication_id = provenance.publication_id
      AND receipt.candidate_id = provenance.candidate_id
      AND receipt.status = 'admitted'
    INNER JOIN memory_daily_reflection_candidate_current_memories current_memory
      ON current_memory.user_id = provenance.user_id
      AND current_memory.publication_id = provenance.publication_id
      AND current_memory.candidate_id = provenance.candidate_id
      AND current_memory.status = 'active'
      AND current_memory.current_memory_id = evidence.memory_id
    LEFT JOIN memory_daily_reflection_candidate_revocations revocation
      ON revocation.user_id = provenance.user_id
      AND revocation.publication_id = provenance.publication_id
      AND revocation.candidate_id = provenance.candidate_id
    WHERE provenance.user_id = ? AND provenance.publication_id = ?
      AND revocation.id IS NULL
    ORDER BY provenance.memory_evidence_id
  `).all(userId, publicationId) as ProvenanceRow[];
}

function resolvePublishedReflection(input: {
  userId: string;
  publication: PublicationRow;
  dependencies: SourceAwarenessDependencies;
}) {
  if (input.publication.status !== "published") return null;
  const invalid = (reason: string) => {
    console.warn(
      `[retrieval-source] reflection_validation_failed `
      + `user_id=${input.userId} reflection_id=${input.publication.reflection_id} `
      + `reason=${reason}`
    );
    return null;
  };
  try {
    const reflection = input.dependencies.sourceRepository.getReflection(
      input.userId,
      input.publication.reflection_id
    );
    const plan = input.dependencies.sourceRepository.getProcessingPlan(
      input.userId,
      input.publication.reflection_id
    );
    const rawUpload = input.dependencies.sourceRepository.readPublishedAsset({
      accountId: input.userId,
      reflectionId: input.publication.reflection_id,
      assetKind: "upload"
    });
    const rawSegments = input.dependencies.sourceRepository.readPublishedAsset({
      accountId: input.userId,
      reflectionId: input.publication.reflection_id,
      assetKind: "segments"
    });
    const parsedUpload = AudioUploadSchema.safeParse(rawUpload);
    if (
      !reflection
      || reflection.accountId !== input.userId
      || reflection.id !== input.publication.reflection_id
      || reflection.status !== "completed"
      || reflection.uploadId !== input.publication.upload_id
      || !plan
      || plan.reflectionId !== input.publication.reflection_id
      || plan.uploadId !== input.publication.upload_id
      || plan.sourceOrigin !== "user_reflection"
      || plan.ingestionContext !== "daily_reflection"
      || plan.reviewPolicy !== "required"
      || !parsedUpload.success
      || parsedUpload.data.id !== input.publication.upload_id
    ) {
      return invalid("canonical_contract");
    }
    const segments = parseDailyReflectionCanonicalTranscript(
      rawSegments,
      input.publication.upload_id
    );
    if (!segments) return invalid("canonical_transcript");
    const provenance = provenanceForPublication(
      input.dependencies.memoryDatabase,
      input.userId,
      input.publication.id
    );
    if (provenance.length === 0) return invalid("provenance_missing");
    const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
    if (provenance.some((item) => {
      const segment = segmentById.get(item.source_segment_id);
      return !segment
        || item.quote !== segment.text.slice(0, 4_000)
        || item.content_digest !== digest({
          version: 1,
          accountId: input.userId,
          reflectionId: input.publication.reflection_id,
          uploadId: input.publication.upload_id,
          sourceSegmentId: item.source_segment_id,
          quote: item.quote,
          sourceOrigin: input.publication.source_origin
        });
    })) {
      return invalid("provenance_mismatch");
    }
    const allowedIds = new Set(provenance.map((item) => item.source_segment_id));
    return {
      segments: segments.filter((segment) => allowedIds.has(segment.id)),
      provenance
    };
  } catch (error) {
    console.warn(
      `[retrieval-source] reflection_validation_failed `
      + `user_id=${input.userId} reflection_id=${input.publication.reflection_id} `
      + `error_name=${error instanceof Error ? error.name : "unknown"}`
    );
    return null;
  }
}

export function resolveRetrievalUpload(input: {
  userId?: string;
  upload: AudioUpload;
  dependencies?: Partial<SourceAwarenessDependencies>;
}): RetrievalUploadResolution {
  const date = input.upload.recordingDate;
  const dailyReflection = isDailyReflectionUpload(input.upload);
  const record = input.upload as AudioUpload & {
    ingestionContext?: unknown;
  };
  const looksLikeDailyReflection = dailyReflection
    || record.ingestionContext === "daily_reflection"
    || input.upload.id.startsWith("daily-reflection-");
  if (!looksLikeDailyReflection) {
    return {
      visible: true,
      attribution: attribution({
        origin: "direct_conversation",
        date,
        sourceSegmentIds: []
      })
    };
  }
  if (!isDailyReflectionUpload(input.upload)) {
    return {
      visible: false,
      attribution: attribution({ origin: "unknown", date, sourceSegmentIds: [] })
    };
  }
  if (!input.userId) {
    return {
      visible: false,
      attribution: attribution({ origin: "unknown", date, sourceSegmentIds: [] })
    };
  }
  const dependencies = resolveDependencies(input.dependencies);
  const publication = publicationForUpload(
    dependencies.memoryDatabase,
    input.userId,
    input.upload.id
  );
  if (
    !publication
    || publication.reflection_id !== input.upload.reflectionId
    || publication.source_origin !== "user_reflection"
  ) {
    return {
      visible: false,
      attribution: attribution({ origin: "unknown", date, sourceSegmentIds: [] })
    };
  }
  const resolved = resolvePublishedReflection({
    userId: input.userId,
    publication,
    dependencies
  });
  if (!resolved || resolved.segments.length === 0) {
    return {
      visible: false,
      attribution: attribution({
        origin: "unknown",
        date,
        reflectionId: publication.reflection_id,
        sourceSegmentIds: []
      })
    };
  }
  return {
    visible: true,
    canonicalSegments: resolved.segments,
    attribution: attribution({
      origin: "user_reflection",
      date,
      reflectionId: publication.reflection_id,
      sourceSegmentIds: resolved.segments.map((segment) => segment.id)
    })
  };
}

export function resolveMemoryRetrievalSource(input: {
  userId: string;
  memory: MemoryItem;
  dependencies?: Partial<SourceAwarenessDependencies>;
}): { eligible: boolean; attribution: MemoryRetrievalSourceAttribution } {
  const dependencies = resolveDependencies(input.dependencies);
  const sourceSegmentIds = input.memory.evidence
    .filter((item) => item.sourceType === "transcript")
    .map((item) => item.sourceId);
  const publications = [...new Map(input.memory.evidence.flatMap((evidence) => {
    const publication = publicationForUpload(
      dependencies.memoryDatabase,
      input.userId,
      evidence.uploadId
    );
    return publication ? [[publication.id, publication] as const] : [];
  })).values()];
  if (publications.length === 0) {
    const looksLikeDailyReflection = input.memory.evidence.some((evidence) =>
      evidence.uploadId.startsWith("daily-reflection-")
    );
    return {
      eligible: !looksLikeDailyReflection,
      attribution: {
        memoryId: input.memory.id,
        ...attribution({
          origin: looksLikeDailyReflection ? "unknown" : "direct_conversation",
          date: input.memory.date,
          sourceSegmentIds
        })
      }
    };
  }
  if (publications.length !== 1) {
    return {
      eligible: false,
      attribution: {
        memoryId: input.memory.id,
        ...attribution({ origin: "unknown", date: input.memory.date, sourceSegmentIds })
      }
    };
  }
  const publication = publications[0]!;
  const resolved = resolvePublishedReflection({
    userId: input.userId,
    publication,
    dependencies
  });
  const memoryEvidenceIds = new Set(input.memory.evidence.map((item) => item.id));
  const mappedEvidenceIds = new Set(
    resolved?.provenance
      .filter((item) => item.memory_id === input.memory.id)
      .map((item) => item.memory_evidence_id) ?? []
  );
  const eligible = Boolean(
    resolved
    && memoryEvidenceIds.size > 0
    && memoryEvidenceIds.size === mappedEvidenceIds.size
    && [...memoryEvidenceIds].every((id) => mappedEvidenceIds.has(id))
  );
  return {
    eligible,
    attribution: {
      memoryId: input.memory.id,
      ...attribution({
        origin: eligible ? "user_reflection" : "unknown",
        date: input.memory.date,
        reflectionId: publication.reflection_id,
        sourceSegmentIds
      })
    }
  };
}

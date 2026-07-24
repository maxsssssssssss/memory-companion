import type Database from "better-sqlite3";
import { consolidateMemories } from "./deduplication";
import { calculateImportance, combineImportanceReasons } from "./importance";
import { detectMemoryRelations } from "./relations";
import { deduplicateMemoryEvidence } from "./evidence-deduplication";
import {
  PersistedMemoryOwnerObservationSchema,
  aggregateMemoryOwnerObservations,
  createPersistedMemoryOwnerObservation,
  memoryOwnerMergeCompatible,
  rekeyMemoryOwnerObservations,
  type PersistedMemoryOwnerObservation
} from "./owner-attribution/storage";
import type { MemoryOwnerMetadata } from "./owner-attribution/types";
import {
  MemoryEvidenceSchema,
  MemoryItemSchema,
  MemoryItemTypeSchema,
  MemoryRelationSchema,
  MemoryWriteInputSchema,
  type MemoryEvidence,
  type MemoryIndexUpdateResult,
  type MemoryItem,
  type MemoryRelation,
  type MemoryRepository,
  type MemoryWriteInput,
  type NormalizedMemoryWriteInput,
  type RelevantMemoryQuery,
  type ReplaceUploadMemoriesInput
} from "./types";

type MemoryItemRow = {
  id: string;
  user_id: string;
  type: string;
  title: string;
  summary: string;
  importance: number;
  importance_score: number;
  importance_reason: string;
  status: string;
  occurrence_count: number;
  first_seen_date: string;
  last_seen_date: string;
  access_count: number;
  last_accessed_at: string | null;
  date: string;
  created_at: string;
  updated_at: string;
};

type MemoryEvidenceRow = {
  id: string;
  memory_id: string;
  source_type: string;
  source_id: string;
  upload_id: string;
  date: string;
  quote: string;
  created_at: string;
};

type MemoryRelationRow = {
  id: string;
  source_memory_id: string;
  target_memory_id: string;
  relation_type: string;
  confidence: number;
  created_at: string;
};

type MemoryOwnerObservationRow = {
  id: string;
  memory_id: string;
  upload_id: string;
  memory_type: string;
  owner_scope: string;
  owner_type: string;
  identity_id: string | null;
  confidence: number;
  source: string;
  participants_json: string;
  evidence_segment_ids_json: string;
  reasons_json: string;
  created_at: string;
};

function assertIdentifier(value: string, name: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new Error(`Invalid ${name}`);
  }
  return normalized;
}

function normalizedQuote(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeIncomingMemories(input: ReplaceUploadMemoriesInput) {
  const segmentById = input.sourceSegments
    ? new Map(input.sourceSegments.map((segment) => [segment.id, segment]))
    : undefined;

  let duplicateEvidenceRemoved = 0;
  const memories = input.memories.flatMap((rawMemory) => {
    const parsed = MemoryWriteInputSchema.parse(rawMemory);
    const transcriptEvidence = parsed.evidence.flatMap((evidence) => {
      if (evidence.sourceType !== "transcript" || evidence.uploadId !== input.uploadId) {
        return [];
      }
      if (!segmentById) {
        return [evidence];
      }
      const segment = segmentById.get(evidence.sourceId);
      if (!segment || segment.uploadId !== input.uploadId) {
        return [];
      }
      const expected = normalizedQuote(segment.text);
      const actual = normalizedQuote(evidence.quote);
      if (!actual || !expected.includes(actual)) {
        return [];
      }
      return [{ ...evidence, quote: segment.text.slice(0, 4_000) }];
    });

    if (transcriptEvidence.length === 0) {
      console.warn(
        `[memory-evidence] memory rejected memory_id=${parsed.id} upload_id=${input.uploadId} reason=no_valid_transcript_evidence`
      );
      return [];
    }

    const derivedEvidence = parsed.evidence.flatMap((evidence) => {
      if (evidence.sourceType === "transcript" || evidence.uploadId !== input.uploadId) {
        return [];
      }
      const actual = normalizedQuote(evidence.quote);
      const groundedTranscript = transcriptEvidence.find((item) => {
        const source = normalizedQuote(item.quote);
        return actual.length > 0 && source.includes(actual);
      });
      if (!groundedTranscript) {
        console.warn(
          `[memory-evidence] derived evidence rejected memory_id=${parsed.id} upload_id=${input.uploadId} source_type=${evidence.sourceType} reason=quote_not_grounded`
        );
        return [];
      }
      return [{ ...evidence, quote: groundedTranscript.quote }];
    });

    const deduplicated = deduplicateMemoryEvidence(parsed.id, [...transcriptEvidence, ...derivedEvidence]);
    duplicateEvidenceRemoved += deduplicated.removed;
    return [MemoryWriteInputSchema.parse({
      ...parsed,
      evidence: deduplicated.evidence
    })];
  });
  return { memories, duplicateEvidenceRemoved };
}

function boundedLimit(value: number | undefined, fallback = 50) {
  return Math.max(1, Math.min(10_000, Math.floor(value ?? fallback)));
}

function parseImportanceReasons(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function evidenceFromRow(row: MemoryEvidenceRow): MemoryEvidence {
  return MemoryEvidenceSchema.parse({
    id: row.id,
    memoryId: row.memory_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    uploadId: row.upload_id,
    date: row.date,
    quote: row.quote,
    createdAt: row.created_at
  });
}

function itemFromRow(row: MemoryItemRow, evidence: MemoryEvidence[]): MemoryItem {
  return MemoryItemSchema.parse({
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    importance: row.importance,
    importanceScore: row.importance_score,
    importanceReasons: parseImportanceReasons(row.importance_reason),
    status: row.status,
    occurrenceCount: row.occurrence_count,
    firstSeenDate: row.first_seen_date || row.date,
    lastSeenDate: row.last_seen_date || row.date,
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at,
    date: row.date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    evidence
  });
}

function relationFromRow(row: MemoryRelationRow): MemoryRelation {
  return MemoryRelationSchema.parse({
    id: row.id,
    sourceMemoryId: row.source_memory_id,
    targetMemoryId: row.target_memory_id,
    relationType: row.relation_type,
    confidence: row.confidence,
    createdAt: row.created_at
  });
}

function parsedJsonArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function ownerObservationFromRow(row: MemoryOwnerObservationRow) {
  return PersistedMemoryOwnerObservationSchema.parse({
    id: row.id,
    memoryId: row.memory_id,
    uploadId: row.upload_id,
    memoryType: row.memory_type,
    scope: row.owner_scope,
    owner: {
      type: row.owner_type,
      ...(row.identity_id ? { identityId: row.identity_id } : {}),
      confidence: row.confidence,
      source: row.source
    },
    participants: parsedJsonArray(row.participants_json),
    evidenceSegmentIds: parsedJsonArray(row.evidence_segment_ids_json),
    reasons: parsedJsonArray(row.reasons_json),
    createdAt: row.created_at
  });
}

function observationsByMemoryId(observations: PersistedMemoryOwnerObservation[]) {
  const byMemoryId = new Map<string, PersistedMemoryOwnerObservation[]>();
  for (const observation of observations) {
    const current = byMemoryId.get(observation.memoryId) ?? [];
    current.push(observation);
    byMemoryId.set(observation.memoryId, current);
  }
  return byMemoryId;
}

function evidenceDates(evidence: MemoryEvidence[]) {
  return [...new Set(evidence.map((item) => item.date))].sort();
}

function recalculateMemory(
  memory: MemoryItem,
  input: { resetResolved?: boolean; onEvidenceDedup?: (removed: number) => void } = {}
) {
  const deduplicated = deduplicateMemoryEvidence(memory.id, memory.evidence);
  input.onEvidenceDedup?.(deduplicated.removed);
  const evidence = deduplicated.evidence;
  if (evidence.length === 0) {
    throw new Error(`Memory ${memory.id} has no evidence`);
  }
  const dates = evidenceDates(evidence);
  const status = input.resetResolved && memory.status === "resolved" ? "active" : memory.status;
  const occurrenceCount = new Set(evidence.map((item) => item.uploadId)).size;
  const importance = calculateImportance({
    type: memory.type,
    title: memory.title,
    summary: memory.summary,
    status,
    occurrenceCount,
    evidenceDates: dates,
    evidenceSourceTypes: evidence.map((item) => item.sourceType),
    evidenceCount: evidence.length
  });
  return MemoryItemSchema.parse({
    ...memory,
    status,
    importance: importance.score,
    importanceScore: importance.score,
    importanceReasons: combineImportanceReasons(importance.reasons, memory.importanceReasons),
    occurrenceCount,
    firstSeenDate: dates[0],
    lastSeenDate: dates.at(-1),
    date: dates.at(-1),
    evidence
  });
}

function incomingMemory(userId: string, input: NormalizedMemoryWriteInput): MemoryItem {
  const parsedEvidence = input.evidence.map((item) => MemoryEvidenceSchema.parse({ ...item, memoryId: input.id }));
  const evidence = deduplicateMemoryEvidence(input.id, parsedEvidence).evidence;
  if (!evidence.some((item) => item.sourceType === "transcript")) {
    throw new Error(`Memory ${input.id} has no transcript evidence`);
  }
  const dates = evidenceDates(evidence);
  const occurrenceCount = new Set(evidence.map((item) => item.uploadId)).size;
  const status = input.status ?? "active";
  const importance = calculateImportance({
    type: input.type,
    title: input.title,
    summary: input.summary,
    status,
    occurrenceCount,
    evidenceDates: dates,
    evidenceSourceTypes: evidence.map((item) => item.sourceType),
    evidenceCount: evidence.length
  });
  return MemoryItemSchema.parse({
    ...input,
    userId,
    importance: importance.score,
    importanceScore: importance.score,
    importanceReasons: combineImportanceReasons(importance.reasons, input.importanceReasons),
    status,
    occurrenceCount,
    firstSeenDate: dates[0],
    lastSeenDate: dates.at(-1),
    accessCount: input.accessCount ?? 0,
    lastAccessedAt: input.lastAccessedAt ?? null,
    date: dates.at(-1),
    evidence
  });
}

function buildManagedIndex(
  memories: MemoryItem[],
  ownerObservations: PersistedMemoryOwnerObservation[] = []
) {
  let duplicateEvidenceRemoved = 0;
  const onEvidenceDedup = (removed: number) => {
    duplicateEvidenceRemoved += removed;
  };
  const reset = memories.map((memory) => recalculateMemory(memory, { resetResolved: true, onEvidenceDedup }));
  const ownerObservationsByMemoryId = observationsByMemoryId(ownerObservations);
  const ownerMetadata = (memory: MemoryItem): MemoryOwnerMetadata | undefined =>
    aggregateMemoryOwnerObservations({
      memoryId: memory.id,
      memoryType: memory.type,
      observations: ownerObservationsByMemoryId.get(memory.id) ?? []
    });
  const consolidated = consolidateMemories(reset, onEvidenceDedup, {
    canMerge: (primary, incoming) =>
      memoryOwnerMergeCompatible(
        primary.type,
        ownerMetadata(primary),
        ownerMetadata(incoming)
      ),
    onMerged: (primary, incoming, merged) => {
      const combined = [
        ...(ownerObservationsByMemoryId.get(primary.id) ?? []),
        ...(ownerObservationsByMemoryId.get(incoming.id) ?? [])
      ];
      const rekeyed = rekeyMemoryOwnerObservations(combined, merged.id);
      const unique = new Map(rekeyed.map((observation) => [observation.id, observation]));
      ownerObservationsByMemoryId.set(merged.id, [...unique.values()]);
      if (incoming.id !== merged.id) ownerObservationsByMemoryId.delete(incoming.id);
      if (primary.id !== merged.id) ownerObservationsByMemoryId.delete(primary.id);
    }
  });
  const relations = detectMemoryRelations(consolidated);
  const resolvedIds = new Set(
    relations
      .filter((relation) => relation.relationType === "resolved_by")
      .map((relation) => relation.sourceMemoryId)
  );
  let propagated = true;
  while (propagated) {
    propagated = false;
    for (const relation of relations) {
      if (
        relation.relationType === "follow_up" &&
        resolvedIds.has(relation.targetMemoryId) &&
        !resolvedIds.has(relation.sourceMemoryId)
      ) {
        resolvedIds.add(relation.sourceMemoryId);
        propagated = true;
      }
    }
  }
  const managed = consolidated.map((memory) =>
    recalculateMemory({
      ...memory,
      status: resolvedIds.has(memory.id) ? "resolved" : memory.status
    }, { onEvidenceDedup })
  );
  const managedIds = new Set(managed.map((memory) => memory.id));
  return {
    memories: managed,
    relations,
    duplicateEvidenceRemoved,
    ownerObservations: [...ownerObservationsByMemoryId.entries()]
      .filter(([memoryId]) => managedIds.has(memoryId))
      .flatMap(([, observations]) => observations)
  };
}

export function createMemoryRepository(database: Database.Database): MemoryRepository {
  const selectEvidence = database.prepare(`
    SELECT * FROM memory_evidence
    WHERE memory_id = ?
    ORDER BY CASE source_type WHEN 'transcript' THEN 0 ELSE 1 END, date, created_at, id
  `);
  const selectUserItems = database.prepare(`
    SELECT * FROM memory_items
    WHERE user_id = ?
    ORDER BY created_at, id
  `);
  const selectItemById = database.prepare(`
    SELECT * FROM memory_items
    WHERE user_id = ? AND id = ?
  `);
  const selectUserOwnerObservations = database.prepare(`
    SELECT memory_owner_observations.*, memory_items.type AS memory_type
    FROM memory_owner_observations
    INNER JOIN memory_items ON memory_items.id = memory_owner_observations.memory_id
    WHERE memory_items.user_id = ?
    ORDER BY memory_owner_observations.created_at, memory_owner_observations.id
  `);
  const deleteUserItems = database.prepare("DELETE FROM memory_items WHERE user_id = ?");
  const insertItem = database.prepare(`
    INSERT INTO memory_items (
      id, user_id, type, title, summary, importance, importance_score, importance_reason,
      status, occurrence_count, first_seen_date, last_seen_date, access_count,
      last_accessed_at, date, created_at, updated_at
    ) VALUES (
      @id, @userId, @type, @title, @summary, @importance, @importanceScore, @importanceReason,
      @status, @occurrenceCount, @firstSeenDate, @lastSeenDate, @accessCount,
      @lastAccessedAt, @date, @createdAt, @updatedAt
    )
  `);
  const insertEvidence = database.prepare(`
    INSERT INTO memory_evidence (id, memory_id, source_type, source_id, upload_id, date, quote, created_at)
    VALUES (@id, @memoryId, @sourceType, @sourceId, @uploadId, @date, @quote, @createdAt)
  `);
  const insertRelation = database.prepare(`
    INSERT INTO memory_relations (id, source_memory_id, target_memory_id, relation_type, confidence, created_at)
    VALUES (@id, @sourceMemoryId, @targetMemoryId, @relationType, @confidence, @createdAt)
  `);
  const insertOwnerObservation = database.prepare(`
    INSERT INTO memory_owner_observations (
      id, memory_id, upload_id, owner_scope, owner_type, identity_id, confidence,
      source, participants_json, evidence_segment_ids_json, reasons_json, created_at
    ) VALUES (
      @id, @memoryId, @uploadId, @scope, @ownerType, @identityId, @confidence,
      @source, @participantsJson, @evidenceSegmentIdsJson, @reasonsJson, @createdAt
    )
  `);

  function memoriesFromRows(rows: MemoryItemRow[], evidenceFilter?: (evidence: MemoryEvidence) => boolean) {
    return rows.map((row) => {
      const evidence = (selectEvidence.all(row.id) as MemoryEvidenceRow[])
        .map(evidenceFromRow)
        .filter((item) => evidenceFilter?.(item) ?? true);
      return itemFromRow(row, evidence);
    });
  }

  function loadUserMemories(userId: string) {
    return memoriesFromRows(selectUserItems.all(userId) as MemoryItemRow[]);
  }

  function loadUserOwnerObservations(userId: string) {
    return (selectUserOwnerObservations.all(userId) as MemoryOwnerObservationRow[])
      .map(ownerObservationFromRow);
  }

  function writeUserIndex(
    userId: string,
    memories: MemoryItem[],
    relations: MemoryRelation[],
    ownerObservations: PersistedMemoryOwnerObservation[] = []
  ) {
    deleteUserItems.run(userId);
    for (const memory of memories) {
      insertItem.run({
        id: memory.id,
        userId,
        type: memory.type,
        title: memory.title,
        summary: memory.summary,
        importance: memory.importanceScore,
        importanceScore: memory.importanceScore,
        importanceReason: JSON.stringify(memory.importanceReasons),
        status: memory.status,
        occurrenceCount: memory.occurrenceCount,
        firstSeenDate: memory.firstSeenDate,
        lastSeenDate: memory.lastSeenDate,
        accessCount: memory.accessCount,
        lastAccessedAt: memory.lastAccessedAt,
        date: memory.lastSeenDate,
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt
      });
      const deduplicated = deduplicateMemoryEvidence(memory.id, memory.evidence);
      if (deduplicated.removed > 0) {
        console.warn(`[memory-evidence-dedup] removed=${deduplicated.removed} memory_id=${memory.id} operation=write`);
      }
      for (const evidence of deduplicated.evidence) {
        insertEvidence.run({ ...evidence, memoryId: memory.id });
      }
    }
    const validMemoryIds = new Set(memories.map((memory) => memory.id));
    for (const observation of ownerObservations) {
      if (!validMemoryIds.has(observation.memoryId)) continue;
      insertOwnerObservation.run({
        id: observation.id,
        memoryId: observation.memoryId,
        uploadId: observation.uploadId,
        scope: observation.scope,
        ownerType: observation.owner.type,
        identityId: observation.owner.identityId ?? null,
        confidence: observation.owner.confidence,
        source: observation.owner.source,
        participantsJson: JSON.stringify(observation.participants),
        evidenceSegmentIdsJson: JSON.stringify(observation.evidenceSegmentIds),
        reasonsJson: JSON.stringify(observation.reasons),
        createdAt: observation.createdAt
      });
    }
    for (const relation of relations) {
      insertRelation.run(relation);
    }
  }

  const replaceUploadMemories = database.transaction((input: ReplaceUploadMemoriesInput): MemoryIndexUpdateResult => {
    const userId = assertIdentifier(input.userId, "user id");
    const uploadId = assertIdentifier(input.uploadId, "upload id");
    const sanitized = sanitizeIncomingMemories({ ...input, uploadId });

    const existing = loadUserMemories(userId);
    const existingOwnerObservations = loadUserOwnerObservations(userId);
    const remaining = existing
      .map((memory) => ({
        ...memory,
        evidence: memory.evidence.filter((item) => item.uploadId !== uploadId)
      }))
      .filter((memory) => memory.evidence.length > 0)
      .map((memory) => recalculateMemory(memory));
    const incoming = sanitized.memories.map((memory) => incomingMemory(userId, memory));
    const sanitizedById = new Map(sanitized.memories.map((memory) => [memory.id, memory]));
    const incomingOwnerObservations = (input.ownerAttributions ?? []).flatMap((resolution) => {
      const memory = sanitizedById.get(resolution.memoryId);
      if (!memory || memory.type !== resolution.memoryType) return [];
      const allowedEvidenceSegmentIds = new Set(
        memory.evidence
          .filter((evidence) => evidence.sourceType === "transcript")
          .map((evidence) => evidence.sourceId)
      );
      const observation = createPersistedMemoryOwnerObservation({
        uploadId,
        resolution,
        allowedEvidenceSegmentIds,
        createdAt: memory.createdAt
      });
      return observation ? [observation] : [];
    });
    const remainingIds = new Set(remaining.map((memory) => memory.id));
    const remainingOwnerObservations = existingOwnerObservations.filter(
      (observation) => observation.uploadId !== uploadId && remainingIds.has(observation.memoryId)
    );
    const beforeConsolidation = remaining.length + incoming.length;
    const managed = buildManagedIndex(
      [...remaining, ...incoming],
      [...remainingOwnerObservations, ...incomingOwnerObservations]
    );
    writeUserIndex(userId, managed.memories, managed.relations, managed.ownerObservations);
    const duplicateEvidenceRemoved = sanitized.duplicateEvidenceRemoved + managed.duplicateEvidenceRemoved;
    if (duplicateEvidenceRemoved > 0) {
      console.warn(
        `[memory-evidence-dedup] removed=${duplicateEvidenceRemoved} user_id=${userId} upload_id=${uploadId}`
      );
    }

    return {
      inputCount: incoming.length,
      memoryCount: managed.memories.length,
      mergedCount: Math.max(0, beforeConsolidation - managed.memories.length),
      relationCount: managed.relations.length
    };
  });

  function getRelevantMemories(query: RelevantMemoryQuery) {
    const userId = assertIdentifier(query.userId, "user id");
    const conditions = ["memory_items.user_id = ?"];
    const parameters: Array<string | number> = [userId];

    if (query.startDate || query.endDate) {
      const scopedConditions = ["scoped_evidence.memory_id = memory_items.id"];
      if (query.startDate) {
        scopedConditions.push("scoped_evidence.date >= ?");
        parameters.push(query.startDate);
      }
      if (query.endDate) {
        scopedConditions.push("scoped_evidence.date <= ?");
        parameters.push(query.endDate);
      }
      conditions.push(`EXISTS (
        SELECT 1 FROM memory_evidence scoped_evidence
        WHERE ${scopedConditions.join(" AND ")}
      )`);
    }
    if (query.uploadId) {
      conditions.push(`EXISTS (
        SELECT 1 FROM memory_evidence upload_evidence
        WHERE upload_evidence.memory_id = memory_items.id AND upload_evidence.upload_id = ?
      )`);
      parameters.push(assertIdentifier(query.uploadId, "upload id"));
    }
    if (query.types && query.types.length > 0) {
      const types = query.types.map((type) => MemoryItemTypeSchema.parse(type));
      conditions.push(`memory_items.type IN (${types.map(() => "?").join(", ")})`);
      parameters.push(...types);
    }

    parameters.push(boundedLimit(query.limit));
    const rows = database.prepare(`
      SELECT memory_items.*
      FROM memory_items
      WHERE ${conditions.join(" AND ")}
      ORDER BY memory_items.importance_score DESC, memory_items.last_seen_date DESC, memory_items.updated_at DESC
      LIMIT ?
    `).all(...parameters) as MemoryItemRow[];
    const evidenceFilter = query.startDate || query.endDate || query.uploadId
      ? (evidence: MemoryEvidence) =>
          (!query.startDate || evidence.date >= query.startDate) &&
          (!query.endDate || evidence.date <= query.endDate) &&
          (!query.uploadId || evidence.uploadId === query.uploadId)
      : undefined;
    return memoriesFromRows(rows, evidenceFilter);
  }

  function deleteByUpload(userIdInput: string, uploadIdInput: string) {
    const userId = assertIdentifier(userIdInput, "user id");
    const uploadId = assertIdentifier(uploadIdInput, "upload id");
    database.transaction(() => {
      const existing = loadUserMemories(userId);
      const remaining = existing
        .map((memory) => ({
          ...memory,
          evidence: memory.evidence.filter((item) => item.uploadId !== uploadId)
        }))
        .filter((memory) => memory.evidence.length > 0)
        .map((memory) => recalculateMemory(memory));
      const remainingIds = new Set(remaining.map((memory) => memory.id));
      const ownerObservations = loadUserOwnerObservations(userId).filter(
        (observation) => observation.uploadId !== uploadId && remainingIds.has(observation.memoryId)
      );
      const managed = buildManagedIndex(remaining, ownerObservations);
      writeUserIndex(userId, managed.memories, managed.relations, managed.ownerObservations);
      if (managed.duplicateEvidenceRemoved > 0) {
        console.warn(
          `[memory-evidence-dedup] removed=${managed.duplicateEvidenceRemoved} user_id=${userId} operation=delete_upload`
        );
      }
    })();
  }

  function getImportantMemories(userId: string, limit = 20) {
    return getRelevantMemories({ userId, limit: boundedLimit(limit, 20) });
  }

  function getActiveCommitments(userId: string, limit = 50) {
    return getRelevantMemories({ userId, types: ["commitment"], limit: 10_000 })
      .filter((memory) => memory.status === "active")
      .slice(0, boundedLimit(limit));
  }

  function getUnresolvedQuestions(userId: string, limit = 50) {
    return getRelevantMemories({ userId, types: ["question"], limit: 10_000 })
      .filter((memory) => memory.status === "active")
      .slice(0, boundedLimit(limit));
  }

  function getRepeatedMemories(userId: string, limit = 50) {
    return getRelevantMemories({ userId, limit: 10_000 })
      .filter((memory) => memory.occurrenceCount > 1)
      .slice(0, boundedLimit(limit));
  }

  function getMemoryRelations(userIdInput: string) {
    const userId = assertIdentifier(userIdInput, "user id");
    const rows = database.prepare(`
      SELECT memory_relations.*
      FROM memory_relations
      INNER JOIN memory_items source ON source.id = memory_relations.source_memory_id
      INNER JOIN memory_items target ON target.id = memory_relations.target_memory_id
      WHERE source.user_id = ? AND target.user_id = ?
      ORDER BY memory_relations.created_at, memory_relations.id
    `).all(userId, userId) as MemoryRelationRow[];
    return rows.map(relationFromRow);
  }

  function getRelatedMemories(userIdInput: string, memoryIdInput: string) {
    const userId = assertIdentifier(userIdInput, "user id");
    const memoryId = assertIdentifier(memoryIdInput, "memory id");
    return getMemoryRelations(userId)
      .filter((relation) => relation.sourceMemoryId === memoryId || relation.targetMemoryId === memoryId)
      .flatMap((relation) => {
        const relatedId = relation.sourceMemoryId === memoryId ? relation.targetMemoryId : relation.sourceMemoryId;
        const row = selectItemById.get(userId, relatedId) as MemoryItemRow | undefined;
        return row ? [{ relation, memory: memoriesFromRows([row])[0] }] : [];
      });
  }

  function getMemoryOwnerAttributions(userIdInput: string, memoryIds?: string[]) {
    const userId = assertIdentifier(userIdInput, "user id");
    const requestedIds = memoryIds
      ? new Set(memoryIds.map((memoryId) => assertIdentifier(memoryId, "memory id")))
      : undefined;
    const grouped = observationsByMemoryId(
      loadUserOwnerObservations(userId).filter(
        (observation) => !requestedIds || requestedIds.has(observation.memoryId)
      )
    );
    return [...grouped.entries()].flatMap(([memoryId, observations]) => {
      const metadata = aggregateMemoryOwnerObservations({
        memoryId,
        memoryType: observations[0].memoryType,
        observations
      });
      return metadata ? [metadata] : [];
    }).sort((left, right) => left.memoryId.localeCompare(right.memoryId));
  }

  function getUserIds() {
    return (database.prepare("SELECT DISTINCT user_id FROM memory_items ORDER BY user_id").all() as Array<{ user_id: string }>)
      .map((row) => row.user_id);
  }

  const rebuildUserMemories = database.transaction((userIdInput: string): MemoryIndexUpdateResult => {
    const userId = assertIdentifier(userIdInput, "user id");
    const existing = loadUserMemories(userId);
    const managed = buildManagedIndex(existing, loadUserOwnerObservations(userId));
    writeUserIndex(userId, managed.memories, managed.relations, managed.ownerObservations);
    if (managed.duplicateEvidenceRemoved > 0) {
      console.warn(
        `[memory-evidence-dedup] removed=${managed.duplicateEvidenceRemoved} user_id=${userId} operation=rebuild`
      );
    }
    return {
      inputCount: existing.length,
      memoryCount: managed.memories.length,
      mergedCount: Math.max(0, existing.length - managed.memories.length),
      relationCount: managed.relations.length
    };
  });

  return {
    replaceUploadMemories,
    getRelevantMemories,
    deleteByUpload,
    getImportantMemories,
    getActiveCommitments,
    getUnresolvedQuestions,
    getRepeatedMemories,
    getRelatedMemories,
    getMemoryRelations,
    getMemoryOwnerAttributions,
    getUserIds,
    rebuildUserMemories
  };
}

import type Database from "better-sqlite3";
import {
  MemoryEvidenceSchema,
  MemoryItemSchema,
  MemoryItemTypeSchema,
  MemoryStatusSchema,
  type MemoryEvidence,
  type MemoryItem,
  type MemoryItemType,
  type MemoryStatus
} from "@/lib/server/memory/types";
import { createPersonRepository, PersonRepositoryError } from "./repository";
import { PersonEvidenceSchema, type PersonEntity, type PersonEvidence } from "./types";
import {
  retrievalSourceStatement,
  type RetrievalSourceAttribution
} from "@/lib/server/retrieval/source-awareness";

const RECORD_ID_PATTERN = /^[^\s]+$/u;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

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

type ScopedEvidenceRow = {
  id: string;
  memory_id: string;
  source_type: string;
  source_id: string;
  upload_id: string;
  date: string;
  quote: string;
  created_at: string;
  person_evidence_id: string;
  person_evidence_quote: string;
  person_evidence_created_at: string;
  person_evidence_updated_at: string;
  content_digest: string | null;
};

export type PersonMemoryQuery = {
  accountId: string;
  personId: string;
  startDate?: string;
  endDate?: string;
  types?: MemoryItemType[];
  statuses?: MemoryStatus[];
  limit?: number;
};

export type PersonMemoryEvidenceLink = {
  memoryEvidence: MemoryEvidence;
  personEvidence: PersonEvidence;
  contentDigest?: string;
};

export type PersonScopedMemory = {
  memory: MemoryItem;
  evidenceLinks: PersonMemoryEvidenceLink[];
  sourceAttribution: RetrievalSourceAttribution;
  subjectPersonIds: string[];
  shared: boolean;
};

export type PersonMemoryResult = {
  person: PersonEntity;
  memories: PersonScopedMemory[];
};

export type PersonTimelineEntry = PersonScopedMemory & {
  date: string;
};

function assertIdentifier(value: string, label: string) {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > 512 || !RECORD_ID_PATTERN.test(normalized)) {
    throw new PersonRepositoryError(`Invalid ${label}`);
  }
  return normalized;
}

function assertDate(value: string | undefined, label: string) {
  if (value === undefined) {
    return undefined;
  }
  if (!DATE_KEY_PATTERN.test(value)) {
    throw new PersonRepositoryError(`Invalid ${label}`);
  }
  return value;
}

function boundedLimit(value: number | undefined) {
  if (value !== undefined && (!Number.isFinite(value) || value < 1)) {
    throw new PersonRepositoryError("Invalid limit");
  }
  return Math.min(200, Math.floor(value ?? 50));
}

function parseImportanceReasons(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function memoryEvidenceFromRow(row: ScopedEvidenceRow) {
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

function personEvidenceFromRow(row: ScopedEvidenceRow, accountId: string) {
  return PersonEvidenceSchema.parse({
    id: row.person_evidence_id,
    accountId,
    uploadId: row.upload_id,
    sourceSegmentId: row.source_id,
    quote: row.person_evidence_quote,
    createdAt: row.person_evidence_created_at,
    updatedAt: row.person_evidence_updated_at
  });
}

function memoryFromRow(row: MemoryItemRow, evidence: MemoryEvidence[]) {
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

function sourceAttributionForMemory(input: {
  database: Database.Database;
  accountId: string;
  memory: MemoryItem;
}): RetrievalSourceAttribution {
  const sourceSegmentIds = input.memory.evidence.map((evidence) => evidence.sourceId);
  const publications = input.database.prepare(`
    SELECT DISTINCT publication.id, publication.reflection_id,
      publication.source_origin, publication.status
    FROM memory_evidence evidence
    INNER JOIN memory_daily_reflection_publications publication
      ON publication.user_id = ? AND publication.upload_id = evidence.upload_id
    WHERE evidence.memory_id = ?
  `).all(input.accountId, input.memory.id) as Array<{
    id: string;
    reflection_id: string;
    source_origin: "user_reflection";
    status: "unpublished" | "published" | "deleted";
  }>;
  const date = input.memory.date;
  if (publications.length === 0) {
    return {
      origin: "direct_conversation",
      statement: retrievalSourceStatement("direct_conversation", date),
      date,
      contentKind: "memory_navigation",
      sourceSegmentIds
    };
  }
  const publication = publications.length === 1 ? publications[0] : undefined;
  const mapped = publication?.status === "published"
    ? input.database.prepare(`
        SELECT COUNT(DISTINCT evidence.id) AS count
        FROM memory_evidence evidence
        INNER JOIN memory_daily_reflection_evidence_provenance provenance
          ON provenance.user_id = ?
          AND provenance.publication_id = ?
          AND provenance.memory_evidence_id = evidence.id
          AND provenance.source_segment_id = evidence.source_id
        WHERE evidence.memory_id = ?
      `).get(input.accountId, publication.id, input.memory.id) as { count: number }
    : { count: 0 };
  const origin = publication?.status === "published"
    && mapped.count === input.memory.evidence.length
    ? "user_reflection"
    : "unknown";
  return {
    origin,
    statement: retrievalSourceStatement(origin, date),
    date,
    contentKind: origin === "user_reflection"
      ? "user_confirmed_derived_content"
      : "memory_navigation",
    ...(publication ? { reflectionId: publication.reflection_id } : {}),
    sourceSegmentIds
  };
}

export function createPersonMemoryRepository(database: Database.Database) {
  const personRepository = createPersonRepository(database);

  function getPersonMemories(query: PersonMemoryQuery): PersonMemoryResult | null {
    const accountId = assertIdentifier(query.accountId, "account id");
    const personId = assertIdentifier(query.personId, "person id");
    const person = personRepository.getConfirmedPerson(accountId, personId);
    if (!person) {
      return null;
    }

    const startDate = assertDate(query.startDate, "start date");
    const endDate = assertDate(query.endDate, "end date");
    if (startDate && endDate && startDate > endDate) {
      throw new PersonRepositoryError("Invalid date range");
    }
    const types = [...new Set((query.types ?? []).map((type) => MemoryItemTypeSchema.parse(type)))];
    const statuses = [...new Set((query.statuses ?? []).map((status) => MemoryStatusSchema.parse(status)))];
    const conditions = ["memory_items.user_id = ?"];
    const parameters: Array<string | number> = [accountId];
    conditions.push(`NOT EXISTS (
      SELECT 1
      FROM memory_evidence hidden_memory_evidence
      INNER JOIN memory_daily_reflection_publications hidden_publication
        ON hidden_publication.user_id = memory_items.user_id
        AND hidden_publication.upload_id = hidden_memory_evidence.upload_id
        AND hidden_publication.status <> 'published'
      WHERE hidden_memory_evidence.memory_id = memory_items.id
    )`);
    const scopedConditions = [
      "scoped_memory_evidence.memory_id = memory_items.id",
      "scoped_memory_evidence.source_type = 'transcript'",
      "scoped_person_evidence.account_id = ?",
      "scoped_subject.account_id = ?",
      "scoped_subject.person_id = ?",
      "scoped_subject.status = 'confirmed'",
      "scoped_person.status = 'confirmed'",
      `NOT EXISTS (
        SELECT 1 FROM memory_daily_reflection_publications reflection_publication
        WHERE reflection_publication.user_id = scoped_person_evidence.account_id
          AND reflection_publication.upload_id = scoped_memory_evidence.upload_id
          AND reflection_publication.status <> 'published'
      )`
    ];
    parameters.push(accountId, accountId, personId);
    if (startDate) {
      scopedConditions.push("scoped_memory_evidence.date >= ?");
      parameters.push(startDate);
    }
    if (endDate) {
      scopedConditions.push("scoped_memory_evidence.date <= ?");
      parameters.push(endDate);
    }
    conditions.push(`EXISTS (
      SELECT 1
      FROM memory_evidence scoped_memory_evidence
      INNER JOIN person_evidence scoped_person_evidence
        ON scoped_person_evidence.upload_id = scoped_memory_evidence.upload_id
        AND scoped_person_evidence.source_segment_id = scoped_memory_evidence.source_id
      INNER JOIN person_subject_observations scoped_subject
        ON scoped_subject.evidence_id = scoped_person_evidence.id
        AND scoped_subject.account_id = scoped_person_evidence.account_id
      INNER JOIN person_entities scoped_person
        ON scoped_person.id = scoped_subject.person_id
        AND scoped_person.account_id = scoped_subject.account_id
      WHERE ${scopedConditions.join(" AND ")}
    )`);
    if (types.length > 0) {
      conditions.push(`memory_items.type IN (${types.map(() => "?").join(", ")})`);
      parameters.push(...types);
    }
    if (statuses.length > 0) {
      conditions.push(`memory_items.status IN (${statuses.map(() => "?").join(", ")})`);
      parameters.push(...statuses);
    }
    parameters.push(boundedLimit(query.limit));

    const rows = database.prepare(`
      SELECT memory_items.*
      FROM memory_items
      WHERE ${conditions.join(" AND ")}
      ORDER BY memory_items.importance_score DESC,
        memory_items.last_seen_date DESC,
        memory_items.updated_at DESC,
        memory_items.id
      LIMIT ?
    `).all(...parameters) as MemoryItemRow[];

    const memories = rows.map((row): PersonScopedMemory => {
      const evidenceConditions = [
        "memory_evidence.memory_id = ?",
        "memory_evidence.source_type = 'transcript'",
        "person_evidence.account_id = ?",
        "subject.account_id = ?",
        "subject.person_id = ?",
        "subject.status = 'confirmed'",
        "person.status = 'confirmed'",
        `NOT EXISTS (
          SELECT 1 FROM memory_daily_reflection_publications reflection_publication
          WHERE reflection_publication.user_id = person_evidence.account_id
            AND reflection_publication.upload_id = memory_evidence.upload_id
            AND reflection_publication.status <> 'published'
        )`
      ];
      const evidenceParameters: string[] = [row.id, accountId, accountId, personId];
      if (startDate) {
        evidenceConditions.push("memory_evidence.date >= ?");
        evidenceParameters.push(startDate);
      }
      if (endDate) {
        evidenceConditions.push("memory_evidence.date <= ?");
        evidenceParameters.push(endDate);
      }
      const evidenceRows = database.prepare(`
        SELECT memory_evidence.*,
          person_evidence.id AS person_evidence_id,
          person_evidence.quote AS person_evidence_quote,
          person_evidence.created_at AS person_evidence_created_at,
          person_evidence.updated_at AS person_evidence_updated_at,
          COALESCE(
            direct_provenance.content_digest,
            reflection_provenance.content_digest
          ) AS content_digest
        FROM memory_evidence
        INNER JOIN person_evidence
          ON person_evidence.upload_id = memory_evidence.upload_id
          AND person_evidence.source_segment_id = memory_evidence.source_id
        INNER JOIN person_subject_observations subject
          ON subject.evidence_id = person_evidence.id
          AND subject.account_id = person_evidence.account_id
        INNER JOIN person_entities person
          ON person.id = subject.person_id AND person.account_id = subject.account_id
        LEFT JOIN memory_evidence_provenance direct_provenance
          ON direct_provenance.memory_evidence_id = memory_evidence.id
          AND direct_provenance.user_id = ?
        LEFT JOIN memory_daily_reflection_evidence_provenance reflection_provenance
          ON reflection_provenance.memory_evidence_id = memory_evidence.id
          AND reflection_provenance.user_id = ?
        WHERE ${evidenceConditions.join(" AND ")}
        ORDER BY memory_evidence.date, memory_evidence.created_at, memory_evidence.id
      `).all(accountId, accountId, ...evidenceParameters) as ScopedEvidenceRow[];
      const evidenceLinks = evidenceRows.map((evidenceRow) => ({
        memoryEvidence: memoryEvidenceFromRow(evidenceRow),
        personEvidence: personEvidenceFromRow(evidenceRow, accountId),
        ...(evidenceRow.content_digest ? { contentDigest: evidenceRow.content_digest } : {})
      }));
      const subjectPersonIds = (database.prepare(`
        SELECT DISTINCT subject.person_id AS person_id
        FROM memory_evidence
        INNER JOIN person_evidence
          ON person_evidence.account_id = ?
          AND person_evidence.upload_id = memory_evidence.upload_id
          AND person_evidence.source_segment_id = memory_evidence.source_id
        INNER JOIN person_subject_observations subject
          ON subject.evidence_id = person_evidence.id
          AND subject.account_id = person_evidence.account_id
        INNER JOIN person_entities person
          ON person.id = subject.person_id AND person.account_id = subject.account_id
        WHERE memory_evidence.memory_id = ?
          AND memory_evidence.source_type = 'transcript'
          AND subject.status = 'confirmed'
          AND person.status = 'confirmed'
          AND NOT EXISTS (
            SELECT 1 FROM memory_daily_reflection_publications reflection_publication
            WHERE reflection_publication.user_id = person_evidence.account_id
              AND reflection_publication.upload_id = memory_evidence.upload_id
              AND reflection_publication.status <> 'published'
          )
        ORDER BY subject.person_id
      `).all(accountId, row.id) as Array<{ person_id: string }>).map((item) => item.person_id);
      const memoryEvidence = evidenceLinks.map((link) => link.memoryEvidence);
      const memory = memoryFromRow(row, memoryEvidence);
      return {
        memory,
        evidenceLinks,
        sourceAttribution: sourceAttributionForMemory({
          database,
          accountId,
          memory
        }),
        subjectPersonIds,
        shared: subjectPersonIds.length > 1
      };
    });

    return { person, memories };
  }

  function getPersonTimeline(query: PersonMemoryQuery): {
    person: PersonEntity;
    timeline: PersonTimelineEntry[];
  } | null {
    const result = getPersonMemories(query);
    if (!result) {
      return null;
    }
    return {
      person: result.person,
      timeline: result.memories
        .map((memory) => ({
          ...memory,
          date: memory.evidenceLinks.at(-1)?.memoryEvidence.date ?? memory.memory.date
        }))
        .sort((left, right) =>
          right.date.localeCompare(left.date) ||
          right.memory.importanceScore - left.memory.importanceScore ||
          left.memory.id.localeCompare(right.memory.id)
        )
    };
  }

  return { getPersonMemories, getPersonTimeline };
}

export type PersonMemoryRepository = ReturnType<typeof createPersonMemoryRepository>;

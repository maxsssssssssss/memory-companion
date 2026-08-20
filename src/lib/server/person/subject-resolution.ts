import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  isChunkLocalSpeakerLabel,
  normalizeSpeakerIdentityLabel,
  trustedTranscriptSpeakerIdentity
} from "@/lib/domain/speaker-identity";
import type { TranscriptSegment } from "@/lib/domain/types";
import type { JsonStore } from "@/lib/server/storage/json-store";
import {
  assertValidatedPersonTranscriptEvidence,
  validatePersonTranscriptEvidence,
  type ValidatedPersonTranscriptEvidence
} from "./evidence";
import {
  createPersonRepository,
  persistValidatedPersonEvidence
} from "./repository";
import {
  SubjectResolutionAuditSchema,
  type SubjectResolutionAudit,
  type SubjectResolutionDecision,
  type SubjectResolutionReasonCode
} from "./types";

const SUBJECT_RESOLVER_VERSION = 1 as const;
const QUOTED_SPEECH_PATTERN = /["“”「」『』]/u;
const REPORTED_SPEECH_PATTERN = /(?:转述|声称|表示|告诉|提到|引用|据说|听说|说过|说道|\baccording to\b|\b(?:said|says|told|mentioned|reported|quoted)\b)/iu;
const THIRD_PERSON_PATTERN = /(?:(?:他|她|他们|她们|对方|别人)(?:最近|现在|说|喜欢|想|要|会|的|是|有|在|不|觉得|认为))|\b(?:he|she|they|him|her|his|their|theirs)\b/iu;
const MULTIPLE_PEOPLE_PATTERN = /(?:我(?:和|跟|与)|我们|咱们|大家|双方)|\b(?:we|us|our|ours)\b|\b(?:i|me)\s+(?:and|with)\b/iu;
const FIRST_PERSON_PATTERN = /我(?!们)|\b(?:i|me|my|mine)\b|\bi[’'](?:m|ve|d|ll)\b/iu;
const SIMPLE_CHINESE_FIRST_PERSON_PATTERN = /^我(?!们)(?:最近|现在|目前|今天|这周|下周|周末|一直|已经|正在|也|还|不|很|更|最|真的|有点|可能|打算|计划|准备|想|希望|需要|喜欢|爱|讨厌|偏好|觉得|认为|担心|关注|完成|提交|会|要|能|没有|有|是)/u;
const SIMPLE_ENGLISH_FIRST_PERSON_PATTERN = /^(?:i\s+(?:am|like|love|prefer|want|plan|intend|need|hope|think|feel|worry|care|finished|completed|submitted|will|would|can|cannot|can't|do not|don't|have|had)|i[’'](?:m|ve|d|ll)\b|my\s+[^,;:.!?]+\s+(?:is|are|was|were|has|needs|matters)\b)/iu;
const MULTI_CLAUSE_PATTERN = /[,，:：;；]|[。.!！?？].+\S|\b(?:and|but|while|whereas)\b|(?:但是|而且|然后|同时|不过)/iu;

type IdentityLinkRow = {
  person_id: string;
  link_status: "candidate" | "confirmed" | "rejected";
  person_status: "candidate" | "confirmed" | "archived";
};

type ExistingSubjectRow = {
  id: string;
  person_id: string;
};

type SubjectResolutionAuditRow = {
  id: string;
  account_id: string;
  upload_id: string;
  source_segment_id: string;
  evidence_id: string | null;
  decision: string;
  person_id: string | null;
  identity_id: string | null;
  subject_observation_id: string | null;
  subject_observation_created: number;
  candidate_person_ids_json: string;
  reason_codes_json: string;
  resolver_version: number;
  created_at: string;
  updated_at: string;
};

export type SubjectResolutionShadowDecision = {
  decision: Exclude<SubjectResolutionDecision, "failed">;
  personId: string | null;
  identityId: string | null;
  candidatePersonIds: string[];
  reasonCodes: SubjectResolutionReasonCode[];
};

export type SubjectResolutionShadowRunResult = {
  status: "completed" | "partial";
  uploadId: string;
  inputCount: number;
  uniqueSegmentCount: number;
  confirmedCount: number;
  candidateCount: number;
  unknownCount: number;
  ambiguousCount: number;
  failedCount: number;
  audits: SubjectResolutionAudit[];
};

export type SubjectResolutionShadowRunnerInput = {
  store: Pick<JsonStore, "read">;
  database: Database.Database;
  accountId: string;
  uploadId: string;
  segments: TranscriptSegment[];
  now?: () => string;
};

function normalizeStatement(value: string) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function stableAuditId(accountId: string, uploadId: string, sourceSegmentId: string) {
  const digest = createHash("sha256")
    .update(`${accountId}\u0000${uploadId}\u0000${sourceSegmentId}`)
    .digest("hex")
    .slice(0, 32);
  return `person_subject_resolution_audit_${digest}`;
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort();
}

function textDecision(textInput: string): Pick<
  SubjectResolutionShadowDecision,
  "decision" | "reasonCodes"
> {
  const text = normalizeStatement(textInput);
  const ambiguousReasons: SubjectResolutionReasonCode[] = [];
  if (QUOTED_SPEECH_PATTERN.test(text)) {
    ambiguousReasons.push("quoted_speech");
  }
  if (REPORTED_SPEECH_PATTERN.test(text)) {
    ambiguousReasons.push("reported_speech");
  }
  if (THIRD_PERSON_PATTERN.test(text)) {
    ambiguousReasons.push("third_person_statement");
  }
  if (MULTIPLE_PEOPLE_PATTERN.test(text)) {
    ambiguousReasons.push("multiple_people");
  }
  if (ambiguousReasons.length > 0) {
    return { decision: "ambiguous", reasonCodes: uniqueSorted(ambiguousReasons) as SubjectResolutionReasonCode[] };
  }
  if (!FIRST_PERSON_PATTERN.test(text)) {
    return { decision: "candidate", reasonCodes: ["not_explicit_first_person"] };
  }
  if (
    MULTI_CLAUSE_PATTERN.test(text) ||
    (!SIMPLE_CHINESE_FIRST_PERSON_PATTERN.test(text) && !SIMPLE_ENGLISH_FIRST_PERSON_PATTERN.test(text))
  ) {
    return { decision: "candidate", reasonCodes: ["not_simple_first_person"] };
  }
  return { decision: "confirmed", reasonCodes: ["confirmed_first_person"] };
}

function auditFromRow(row: SubjectResolutionAuditRow): SubjectResolutionAudit {
  return SubjectResolutionAuditSchema.parse({
    id: row.id,
    accountId: row.account_id,
    uploadId: row.upload_id,
    sourceSegmentId: row.source_segment_id,
    evidenceId: row.evidence_id,
    decision: row.decision,
    personId: row.person_id,
    identityId: row.identity_id,
    subjectObservationId: row.subject_observation_id,
    subjectObservationCreated: row.subject_observation_created === 1,
    candidatePersonIds: JSON.parse(row.candidate_person_ids_json) as unknown,
    reasonCodes: JSON.parse(row.reason_codes_json) as unknown,
    resolverVersion: row.resolver_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function existingSubjectsForEvidence(
  database: Database.Database,
  accountId: string,
  evidenceId: string
) {
  return database.prepare(`
    SELECT id, person_id
    FROM person_subject_observations
    WHERE account_id = ? AND evidence_id = ? AND status = 'confirmed'
    ORDER BY person_id, id
  `).all(accountId, evidenceId) as ExistingSubjectRow[];
}

export function resolveSubjectShadowDecision(input: {
  database: Database.Database;
  accountId: string;
  evidence: ValidatedPersonTranscriptEvidence;
}): SubjectResolutionShadowDecision {
  assertValidatedPersonTranscriptEvidence(input.evidence);
  if (input.evidence.accountId !== input.accountId) {
    throw new Error("subject_resolution_account_mismatch");
  }
  const { segment } = input.evidence;
  const speaker = normalizeSpeakerIdentityLabel(segment.speaker);
  if (!speaker) {
    return {
      decision: "unknown",
      personId: null,
      identityId: null,
      candidatePersonIds: [],
      reasonCodes: ["missing_speaker"]
    };
  }
  if (isChunkLocalSpeakerLabel(speaker)) {
    return {
      decision: "unknown",
      personId: null,
      identityId: null,
      candidatePersonIds: [],
      reasonCodes: ["chunk_local_speaker"]
    };
  }
  const identity = trustedTranscriptSpeakerIdentity(segment);
  if (!identity || isChunkLocalSpeakerLabel(identity.globalSpeakerId)) {
    return {
      decision: "unknown",
      personId: null,
      identityId: null,
      candidatePersonIds: [],
      reasonCodes: ["untrusted_identity"]
    };
  }

  const rows = input.database.prepare(`
    SELECT
      link.person_id,
      link.status AS link_status,
      person.status AS person_status
    FROM person_identity_links link
    INNER JOIN person_entities person
      ON person.id = link.person_id AND person.account_id = link.account_id
    WHERE link.account_id = ? AND link.identity_id = ?
    ORDER BY link.person_id, link.status
  `).all(input.accountId, identity.globalSpeakerId) as IdentityLinkRow[];
  const activeRows = rows.filter((row) => row.link_status !== "rejected");
  const candidatePersonIds = uniqueSorted(activeRows.map((row) => row.person_id));
  if (candidatePersonIds.length > 1) {
    return {
      decision: "ambiguous",
      personId: null,
      identityId: identity.globalSpeakerId,
      candidatePersonIds,
      reasonCodes: ["identity_person_conflict"]
    };
  }

  const confirmedRows = activeRows.filter(
    (row) => row.link_status === "confirmed" && row.person_status === "confirmed"
  );
  const confirmedPersonIds = uniqueSorted(confirmedRows.map((row) => row.person_id));
  if (confirmedPersonIds.length !== 1) {
    const personId = candidatePersonIds[0] ?? null;
    if (activeRows.some((row) => row.link_status === "confirmed")) {
      return {
        decision: "candidate",
        personId,
        identityId: identity.globalSpeakerId,
        candidatePersonIds,
        reasonCodes: ["person_not_confirmed"]
      };
    }
    if (activeRows.length > 0) {
      return {
        decision: "candidate",
        personId,
        identityId: identity.globalSpeakerId,
        candidatePersonIds,
        reasonCodes: ["identity_link_not_confirmed"]
      };
    }
    return {
      decision: "unknown",
      personId: null,
      identityId: identity.globalSpeakerId,
      candidatePersonIds: [],
      reasonCodes: ["identity_link_missing"]
    };
  }

  const personId = confirmedPersonIds[0];
  const existingSubjects = existingSubjectsForEvidence(
    input.database,
    input.accountId,
    input.evidence.id
  );
  if (
    existingSubjects.length > 1 ||
    existingSubjects.some((subject) => subject.person_id !== personId)
  ) {
    return {
      decision: "ambiguous",
      personId: null,
      identityId: identity.globalSpeakerId,
      candidatePersonIds: uniqueSorted([
        ...candidatePersonIds,
        ...existingSubjects.map((subject) => subject.person_id)
      ]),
      reasonCodes: ["existing_subject_conflict"]
    };
  }

  const statement = textDecision(segment.text);
  return {
    decision: statement.decision,
    personId,
    identityId: identity.globalSpeakerId,
    candidatePersonIds,
    reasonCodes: statement.reasonCodes
  };
}

function persistAudit(input: {
  database: Database.Database;
  accountId: string;
  uploadId: string;
  sourceSegmentId: string;
  evidence: ValidatedPersonTranscriptEvidence | null;
  decision: SubjectResolutionDecision;
  personId: string | null;
  identityId: string | null;
  candidatePersonIds: string[];
  reasonCodes: SubjectResolutionReasonCode[];
  now: string;
}) {
  return input.database.transaction(() => {
    const previous = input.database.prepare(`
      SELECT * FROM person_subject_resolution_audits
      WHERE account_id = ? AND upload_id = ? AND source_segment_id = ?
    `).get(input.accountId, input.uploadId, input.sourceSegmentId) as SubjectResolutionAuditRow | undefined;
    if (input.evidence) {
      persistValidatedPersonEvidence(input.database, {
        accountId: input.accountId,
        evidence: input.evidence,
        now: input.now
      });
    }

    let subjectObservationId: string | null = null;
    let subjectObservationCreated = false;
    if (input.decision === "confirmed") {
      if (!input.evidence || !input.personId || !input.identityId) {
        throw new Error("confirmed_subject_resolution_missing_required_fields");
      }
      const existingSubjects = existingSubjectsForEvidence(
        input.database,
        input.accountId,
        input.evidence.id
      );
      if (existingSubjects.length > 0) {
        if (
          existingSubjects.length !== 1 ||
          existingSubjects[0]?.person_id !== input.personId
        ) {
          throw new Error("confirmed_subject_resolution_conflict");
        }
        const existingSubject = existingSubjects[0];
        subjectObservationId = existingSubject.id;
        subjectObservationCreated = Boolean(
          previous?.subject_observation_created === 1 &&
          previous.subject_observation_id === existingSubject.id
        );
      } else {
        const observation = createPersonRepository(input.database).recordConfirmedSubject({
          accountId: input.accountId,
          personId: input.personId,
          identityId: input.identityId,
          reason: `shadow:${input.reasonCodes.join(",")}`,
          evidence: input.evidence,
          now: input.now
        });
        subjectObservationId = observation.id;
        subjectObservationCreated = true;
      }
    } else if (
      previous?.subject_observation_created === 1 &&
      previous.subject_observation_id
    ) {
      input.database.prepare(`
        DELETE FROM person_subject_observations
        WHERE id = ? AND account_id = ?
      `).run(previous.subject_observation_id, input.accountId);
    }

    const id = stableAuditId(input.accountId, input.uploadId, input.sourceSegmentId);
    input.database.prepare(`
      INSERT INTO person_subject_resolution_audits (
        id, account_id, upload_id, source_segment_id, evidence_id, decision,
        person_id, identity_id, subject_observation_id, subject_observation_created,
        candidate_person_ids_json, reason_codes_json, resolver_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, upload_id, source_segment_id) DO UPDATE SET
        evidence_id = excluded.evidence_id,
        decision = excluded.decision,
        person_id = excluded.person_id,
        identity_id = excluded.identity_id,
        subject_observation_id = excluded.subject_observation_id,
        subject_observation_created = excluded.subject_observation_created,
        candidate_person_ids_json = excluded.candidate_person_ids_json,
        reason_codes_json = excluded.reason_codes_json,
        resolver_version = excluded.resolver_version,
        updated_at = excluded.updated_at
    `).run(
      id,
      input.accountId,
      input.uploadId,
      input.sourceSegmentId,
      input.evidence?.id ?? null,
      input.decision,
      input.personId,
      input.identityId,
      subjectObservationId,
      subjectObservationCreated ? 1 : 0,
      JSON.stringify(uniqueSorted(input.candidatePersonIds)),
      JSON.stringify(uniqueSorted(input.reasonCodes) as SubjectResolutionReasonCode[]),
      SUBJECT_RESOLVER_VERSION,
      input.now,
      input.now
    );
    return auditFromRow(input.database.prepare(`
      SELECT * FROM person_subject_resolution_audits
      WHERE account_id = ? AND upload_id = ? AND source_segment_id = ?
    `).get(input.accountId, input.uploadId, input.sourceSegmentId) as SubjectResolutionAuditRow);
  })();
}

function deleteStaleUploadAudits(input: {
  database: Database.Database;
  accountId: string;
  uploadId: string;
  sourceSegmentIds: string[];
}) {
  input.database.transaction(() => {
    const parameters: string[] = [input.accountId, input.uploadId];
    const segmentClause = input.sourceSegmentIds.length > 0
      ? `AND source_segment_id NOT IN (${input.sourceSegmentIds.map(() => "?").join(", ")})`
      : "";
    parameters.push(...input.sourceSegmentIds);
    const stale = input.database.prepare(`
      SELECT * FROM person_subject_resolution_audits
      WHERE account_id = ? AND upload_id = ? ${segmentClause}
    `).all(...parameters) as SubjectResolutionAuditRow[];
    for (const audit of stale) {
      if (audit.subject_observation_created === 1 && audit.subject_observation_id) {
        input.database.prepare(`
          DELETE FROM person_subject_observations
          WHERE id = ? AND account_id = ?
        `).run(audit.subject_observation_id, input.accountId);
      } else {
        input.database.prepare(`
          DELETE FROM person_subject_resolution_audits
          WHERE id = ? AND account_id = ?
        `).run(audit.id, input.accountId);
      }
    }
    input.database.prepare(`
      DELETE FROM person_evidence
      WHERE account_id = ? AND upload_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM person_names WHERE person_names.evidence_id = person_evidence.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM person_identity_links WHERE person_identity_links.evidence_id = person_evidence.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM person_subject_observations
          WHERE person_subject_observations.evidence_id = person_evidence.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM person_subject_resolution_audits
          WHERE person_subject_resolution_audits.evidence_id = person_evidence.id
        )
    `).run(input.accountId, input.uploadId);
  })();
}

export function listSubjectResolutionAudits(
  database: Database.Database,
  input: { accountId: string; uploadId?: string }
) {
  const rows = input.uploadId
    ? database.prepare(`
        SELECT * FROM person_subject_resolution_audits
        WHERE account_id = ? AND upload_id = ?
        ORDER BY source_segment_id
      `).all(input.accountId, input.uploadId)
    : database.prepare(`
        SELECT * FROM person_subject_resolution_audits
        WHERE account_id = ?
        ORDER BY upload_id, source_segment_id
      `).all(input.accountId);
  return (rows as SubjectResolutionAuditRow[]).map(auditFromRow);
}

export function isSubjectResolutionShadowEnabled(
  environment: Record<string, string | undefined> = process.env
) {
  return /^(?:1|true|yes|on)$/iu.test(
    environment.PERSON_SUBJECT_RESOLUTION_SHADOW_ENABLED?.trim() ?? ""
  );
}

export async function runSubjectResolutionShadow(
  input: SubjectResolutionShadowRunnerInput
): Promise<SubjectResolutionShadowRunResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const countsBySegmentId = new Map<string, number>();
  for (const segment of input.segments) {
    countsBySegmentId.set(segment.id, (countsBySegmentId.get(segment.id) ?? 0) + 1);
  }
  const uniqueSegments = [...new Map(input.segments.map((segment) => [segment.id, segment])).values()];
  const audits: SubjectResolutionAudit[] = [];

  for (const segment of uniqueSegments) {
    let evidence: ValidatedPersonTranscriptEvidence | null = null;
    try {
      if ((countsBySegmentId.get(segment.id) ?? 0) > 1) {
        throw new Error("duplicate_source_segment_id");
      }
      evidence = await validatePersonTranscriptEvidence({
        store: input.store,
        authenticatedAccountId: input.accountId,
        accountId: input.accountId,
        uploadId: input.uploadId,
        sourceSegmentId: segment.id,
        quote: segment.text
      });
      const decision = resolveSubjectShadowDecision({
        database: input.database,
        accountId: input.accountId,
        evidence
      });
      audits.push(persistAudit({
        database: input.database,
        accountId: input.accountId,
        uploadId: input.uploadId,
        sourceSegmentId: segment.id,
        evidence,
        ...decision,
        now: now()
      }));
    } catch (error) {
      try {
        audits.push(persistAudit({
          database: input.database,
          accountId: input.accountId,
          uploadId: input.uploadId,
          sourceSegmentId: segment.id,
          evidence,
          decision: "failed",
          personId: null,
          identityId: null,
          candidatePersonIds: [],
          reasonCodes: [evidence ? "resolver_failed" : "evidence_validation_failed"],
          now: now()
        }));
      } catch {
        audits.push(SubjectResolutionAuditSchema.parse({
          id: stableAuditId(input.accountId, input.uploadId, segment.id),
          accountId: input.accountId,
          uploadId: input.uploadId,
          sourceSegmentId: segment.id,
          evidenceId: evidence?.id ?? null,
          decision: "failed",
          personId: null,
          identityId: null,
          subjectObservationId: null,
          subjectObservationCreated: false,
          candidatePersonIds: [],
          reasonCodes: [evidence ? "resolver_failed" : "evidence_validation_failed"],
          resolverVersion: SUBJECT_RESOLVER_VERSION,
          createdAt: now(),
          updatedAt: now()
        }));
      }
    }
  }

  deleteStaleUploadAudits({
    database: input.database,
    accountId: input.accountId,
    uploadId: input.uploadId,
    sourceSegmentIds: uniqueSegments.map((segment) => segment.id)
  });
  const count = (decision: SubjectResolutionDecision) =>
    audits.filter((audit) => audit.decision === decision).length;
  const failedCount = count("failed");
  return {
    status: failedCount > 0 ? "partial" : "completed",
    uploadId: input.uploadId,
    inputCount: input.segments.length,
    uniqueSegmentCount: uniqueSegments.length,
    confirmedCount: count("confirmed"),
    candidateCount: count("candidate"),
    unknownCount: count("unknown"),
    ambiguousCount: count("ambiguous"),
    failedCount,
    audits
  };
}

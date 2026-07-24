import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { TranscriptChunkSchema, type TranscriptChunk } from "@/lib/domain/chunks";
import { resolveSpeakerIdentities } from "./resolver";
import type { SpeakerIdentityMatcher } from "./types";

const TRANSCRIPT_CHUNK_SUFFIX = /_transcript_chunk_\d{5}\.json$/;
const SAFE_AUDIT_VALUE = /^[a-z0-9_-]{1,80}$/i;

type JsonRecord = Record<string, unknown>;

export type SpeakerIdentityAuditAssignment = {
  chunkIndex: number;
  localSpeaker: string;
  segmentCount: number;
  matched: boolean;
  globalSpeakerId?: string;
  identityType?: "known_user" | "known_contact" | "unknown_person";
  confidence?: number;
  source?: "voiceprint" | "cross_chunk_matching" | "manual_mapping";
  reason: string;
};

export type SpeakerIdentityAuditTrack = {
  kind: "actual_retained" | "synthetic_label_swap";
  synthetic: boolean;
  summary: {
    chunksProcessed: number;
    segmentCount: number;
    localSpeakerGroups: number;
    uniqueLocalLabels: number;
    globalSpeakers: number;
    matched: number;
    unknown: number;
    averageConfidence: number | null;
    conflicts: number;
  };
  assignments: SpeakerIdentityAuditAssignment[];
  resolverCounters: Record<string, number>;
  integrity: SpeakerIdentityIntegrityAudit;
  swappedChunkIndexes?: number[];
  oracle?: {
    expectedAssignments: number;
    correctAssignments: number;
    accuracy: number | null;
    falseMerges: number;
    falseSplits: number;
  };
};

export type SpeakerIdentityIntegrityHashes = {
  segmentIdsSha256: string;
  transcriptTextSha256: string;
  timestampsSha256: string;
  localSpeakersSha256: string;
};

export type SpeakerIdentityIntegrityAudit = {
  before: SpeakerIdentityIntegrityHashes;
  after: SpeakerIdentityIntegrityHashes;
  segmentIdsUnchanged: boolean;
  transcriptTextUnchanged: boolean;
  timestampsUnchanged: boolean;
  localSpeakersUnchanged: boolean;
};

export type SpeakerIdentityEvaluationReport = {
  version: 1;
  generatedAt: string;
  mode: "offline";
  networkCallsAllowed: false;
  uploadId: string;
  input: {
    source: "retained_transcript_chunks";
    transcriptChunkFiles: number;
  };
  evidenceAvailability: {
    voiceprint: false;
    speakerEmbedding: false;
    persistedIdentityConfidence: false;
    note: string;
  };
  actual: SpeakerIdentityAuditTrack;
  simulated: SpeakerIdentityAuditTrack;
  limitations: string[];
};

export type LoadedSpeakerIdentityArtifacts = {
  dataDir: string;
  userRoot: string;
  uploadId: string;
  chunks: TranscriptChunk[];
};

export type SyntheticSpeakerIdentityFixture = {
  chunks: TranscriptChunk[];
  matcher: SpeakerIdentityMatcher;
  swappedChunkIndexes: number[];
  expectedGlobalSpeakerByGroup: ReadonlyMap<string, string>;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeAuditValue(value: unknown, fallback = "unspecified") {
  const normalized = safeString(value);
  return normalized && SAFE_AUDIT_VALUE.test(normalized) ? normalized : fallback;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rounded(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function immutableSegmentView(chunks: TranscriptChunk[]) {
  return [...chunks]
    .sort((left, right) => left.index - right.index)
    .flatMap((chunk) =>
      chunk.segments.map((segment) => ({
        chunkIndex: chunk.index,
        id: segment.id,
        text: segment.text,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        speaker: segment.speaker ?? null
      }))
    );
}

export function speakerIdentityIntegrityHashes(chunks: TranscriptChunk[]): SpeakerIdentityIntegrityHashes {
  const segments = immutableSegmentView(chunks);
  return {
    segmentIdsSha256: sha256(segments.map((segment) => [segment.chunkIndex, segment.id])),
    transcriptTextSha256: sha256(segments.map((segment) => [segment.id, segment.text])),
    timestampsSha256: sha256(
      segments.map((segment) => [segment.id, segment.startSeconds, segment.endSeconds])
    ),
    localSpeakersSha256: sha256(segments.map((segment) => [segment.id, segment.speaker]))
  };
}

function integrityAudit(beforeChunks: TranscriptChunk[], afterChunks: TranscriptChunk[]) {
  const before = speakerIdentityIntegrityHashes(beforeChunks);
  const after = speakerIdentityIntegrityHashes(afterChunks);
  return {
    before,
    after,
    segmentIdsUnchanged: before.segmentIdsSha256 === after.segmentIdsSha256,
    transcriptTextUnchanged: before.transcriptTextSha256 === after.transcriptTextSha256,
    timestampsUnchanged: before.timestampsSha256 === after.timestampsSha256,
    localSpeakersUnchanged: before.localSpeakersSha256 === after.localSpeakersSha256
  } satisfies SpeakerIdentityIntegrityAudit;
}

function speakerGroupKey(chunkIndex: number, localSpeaker: string) {
  return `${chunkIndex}:${localSpeaker}`;
}

function parseChunkIndex(value: unknown, chunkIdToIndex: ReadonlyMap<string, number>) {
  const direct = finiteNumber(value);
  if (direct !== undefined && Number.isInteger(direct) && direct >= 0) return direct;
  const chunkId = safeString(value);
  return chunkId ? chunkIdToIndex.get(chunkId) : undefined;
}

function identityFromRecord(record: JsonRecord) {
  return isRecord(record.identity) ? record.identity : record;
}

function normalizedResolverAssignments(
  chunks: TranscriptChunk[],
  rawAssignments: unknown
): SpeakerIdentityAuditAssignment[] {
  const chunkIdToIndex = new Map(chunks.map((chunk) => [chunk.id, chunk.index]));
  const segmentCounts = new Map<string, number>();
  for (const chunk of chunks) {
    for (const segment of chunk.segments) {
      if (!segment.speaker) continue;
      const key = speakerGroupKey(chunk.index, segment.speaker);
      segmentCounts.set(key, (segmentCounts.get(key) ?? 0) + 1);
    }
  }

  const assignmentsByGroup = new Map<string, SpeakerIdentityAuditAssignment>();
  for (const raw of Array.isArray(rawAssignments) ? rawAssignments : []) {
    if (!isRecord(raw)) continue;
    const chunkIndex =
      parseChunkIndex(raw.chunkIndex, chunkIdToIndex) ??
      parseChunkIndex(raw.transcriptChunkIndex, chunkIdToIndex) ??
      parseChunkIndex(raw.chunkId, chunkIdToIndex);
    const localSpeaker =
      safeString(raw.localSpeaker) ?? safeString(raw.localSpeakerLabel) ?? safeString(raw.speaker);
    if (chunkIndex === undefined || !localSpeaker) continue;
    const identity = identityFromRecord(raw);
    const globalSpeakerId = safeString(identity.globalSpeakerId);
    const identityTypeValue = safeString(identity.identityType);
    const identityType =
      identityTypeValue === "known_user" ||
      identityTypeValue === "known_contact" ||
      identityTypeValue === "unknown_person"
        ? identityTypeValue
        : undefined;
    const sourceValue = safeString(identity.source);
    const source =
      sourceValue === "voiceprint" ||
      sourceValue === "cross_chunk_matching" ||
      sourceValue === "manual_mapping"
        ? sourceValue
        : undefined;
    const confidence = finiteNumber(identity.confidence);
    const explicitMatched = typeof raw.matched === "boolean" ? raw.matched : undefined;
    const reason = safeAuditValue(
      raw.reason ?? raw.matchedReason ?? raw.unmatchedReason,
      globalSpeakerId ? "matched" : "insufficient_identity_evidence"
    );
    const key = speakerGroupKey(chunkIndex, localSpeaker);
    assignmentsByGroup.set(key, {
      chunkIndex,
      localSpeaker,
      segmentCount: segmentCounts.get(key) ?? 0,
      matched: explicitMatched ?? Boolean(globalSpeakerId),
      ...(globalSpeakerId ? { globalSpeakerId } : {}),
      ...(identityType ? { identityType } : {}),
      ...(confidence !== undefined ? { confidence: rounded(confidence) } : {}),
      ...(source ? { source } : {}),
      reason
    });
  }

  for (const [key, segmentCount] of segmentCounts) {
    if (assignmentsByGroup.has(key)) continue;
    const separator = key.indexOf(":");
    assignmentsByGroup.set(key, {
      chunkIndex: Number.parseInt(key.slice(0, separator), 10),
      localSpeaker: key.slice(separator + 1),
      segmentCount,
      matched: false,
      reason: "insufficient_identity_evidence"
    });
  }

  return [...assignmentsByGroup.values()].sort(
    (left, right) =>
      left.chunkIndex - right.chunkIndex || left.localSpeaker.localeCompare(right.localSpeaker, "en")
  );
}

function numericResolverCounters(rawAudit: unknown) {
  if (!isRecord(rawAudit)) return {};
  return Object.fromEntries(
    Object.entries(rawAudit)
      .filter(([key, value]) => SAFE_AUDIT_VALUE.test(key) && finiteNumber(value) !== undefined)
      .map(([key, value]) => [key, finiteNumber(value) as number])
  );
}

function trackSummary(chunks: TranscriptChunk[], assignments: SpeakerIdentityAuditAssignment[]) {
  const matchedAssignments = assignments.filter((assignment) => assignment.matched);
  const confidenceValues = assignments.flatMap((assignment) =>
    assignment.confidence === undefined ? [] : [assignment.confidence]
  );
  const identitiesByGroup = new Map<string, Set<string>>();
  for (const assignment of assignments) {
    if (!assignment.globalSpeakerId) continue;
    const key = speakerGroupKey(assignment.chunkIndex, assignment.localSpeaker);
    const identities = identitiesByGroup.get(key) ?? new Set<string>();
    identities.add(assignment.globalSpeakerId);
    identitiesByGroup.set(key, identities);
  }
  return {
    chunksProcessed: chunks.length,
    segmentCount: chunks.reduce((count, chunk) => count + chunk.segments.length, 0),
    localSpeakerGroups: assignments.length,
    uniqueLocalLabels: new Set(assignments.map((assignment) => assignment.localSpeaker)).size,
    globalSpeakers: new Set(
      matchedAssignments.flatMap((assignment) =>
        assignment.globalSpeakerId ? [assignment.globalSpeakerId] : []
      )
    ).size,
    matched: matchedAssignments.length,
    unknown: assignments.length - matchedAssignments.length,
    averageConfidence:
      confidenceValues.length > 0
        ? rounded(confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length)
        : null,
    conflicts: [...identitiesByGroup.values()].filter((identities) => identities.size > 1).length
  };
}

function oracleAudit(
  assignments: SpeakerIdentityAuditAssignment[],
  expectedGlobalSpeakerByGroup: ReadonlyMap<string, string>
) {
  const resolvedCountsByExpected = new Map<string, Map<string, number>>();
  const resolvedGroupsByExpected = new Map<string, Set<string>>();
  const expectedByResolved = new Map<string, Set<string>>();
  for (const assignment of assignments) {
    const group = speakerGroupKey(assignment.chunkIndex, assignment.localSpeaker);
    const expected = expectedGlobalSpeakerByGroup.get(group);
    if (!expected || !assignment.globalSpeakerId) continue;
    const resolvedCounts = resolvedCountsByExpected.get(expected) ?? new Map<string, number>();
    resolvedCounts.set(
      assignment.globalSpeakerId,
      (resolvedCounts.get(assignment.globalSpeakerId) ?? 0) + 1
    );
    resolvedCountsByExpected.set(expected, resolvedCounts);
    const resolvedForExpected = resolvedGroupsByExpected.get(expected) ?? new Set<string>();
    resolvedForExpected.add(assignment.globalSpeakerId);
    resolvedGroupsByExpected.set(expected, resolvedForExpected);
    const expectedForResolved = expectedByResolved.get(assignment.globalSpeakerId) ?? new Set<string>();
    expectedForResolved.add(expected);
    expectedByResolved.set(assignment.globalSpeakerId, expectedForResolved);
  }
  const expectedAssignments = expectedGlobalSpeakerByGroup.size;
  const correctAssignments = [...resolvedCountsByExpected.values()].reduce(
    (count, resolvedCounts) =>
      count + Math.max(0, ...resolvedCounts.values()),
    0
  );
  return {
    expectedAssignments,
    correctAssignments,
    accuracy: expectedAssignments > 0 ? rounded(correctAssignments / expectedAssignments) : null,
    falseMerges: [...expectedByResolved.values()].filter((identities) => identities.size > 1).length,
    falseSplits: [...resolvedGroupsByExpected.values()].filter((identities) => identities.size > 1).length
  };
}

async function evaluateTrack(input: {
  kind: SpeakerIdentityAuditTrack["kind"];
  chunks: TranscriptChunk[];
  matcher?: SpeakerIdentityMatcher;
  swappedChunkIndexes?: number[];
  expectedGlobalSpeakerByGroup?: ReadonlyMap<string, string>;
}) {
  const beforeChunks = input.chunks.map((chunk) => TranscriptChunkSchema.parse(chunk));
  const resolution = await resolveSpeakerIdentities({
    uploadId: beforeChunks[0]?.uploadId ?? "",
    chunks: beforeChunks,
    ...(input.matcher ? { matcher: input.matcher } : {})
  });
  const assignments = normalizedResolverAssignments(resolution.chunks, resolution.assignments);
  return {
    kind: input.kind,
    synthetic: input.kind === "synthetic_label_swap",
    summary: trackSummary(resolution.chunks, assignments),
    assignments,
    resolverCounters: numericResolverCounters(resolution.audit),
    integrity: integrityAudit(beforeChunks, resolution.chunks),
    ...(input.swappedChunkIndexes ? { swappedChunkIndexes: input.swappedChunkIndexes } : {}),
    ...(input.expectedGlobalSpeakerByGroup
      ? { oracle: oracleAudit(assignments, input.expectedGlobalSpeakerByGroup) }
      : {})
  } satisfies SpeakerIdentityAuditTrack;
}

async function directoryExists(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function discoverUserRoots(dataDir: string) {
  const roots = new Set<string>();
  if (await directoryExists(join(dataDir, "transcript-chunks"))) roots.add(dataDir);
  const usersDir = basename(dataDir).toLocaleLowerCase() === "users" ? dataDir : join(dataDir, "users");
  if (!(await directoryExists(usersDir))) return [...roots];
  for (const entry of await readdir(usersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const userRoot = join(usersDir, entry.name);
    if (await directoryExists(join(userRoot, "transcript-chunks"))) roots.add(userRoot);
  }
  return [...roots].sort((left, right) => left.localeCompare(right, "en"));
}

export async function loadSpeakerIdentityEvaluationArtifacts(input: {
  dataDir: string;
  uploadId: string;
}): Promise<LoadedSpeakerIdentityArtifacts> {
  const dataDir = resolve(input.dataDir);
  const matches: Array<{ userRoot: string; files: string[] }> = [];
  for (const userRoot of await discoverUserRoots(dataDir)) {
    const transcriptChunkDir = join(userRoot, "transcript-chunks");
    const files = (await readdir(transcriptChunkDir))
      .filter(
        (file) =>
          file.startsWith(`${input.uploadId}_transcript_chunk_`) && TRANSCRIPT_CHUNK_SUFFIX.test(file)
      )
      .sort((left, right) => left.localeCompare(right, "en"));
    if (files.length > 0) matches.push({ userRoot, files });
  }
  if (matches.length === 0) {
    throw new Error(`No retained transcript chunks found for upload ${input.uploadId}`);
  }
  if (matches.length > 1) {
    throw new Error(`Upload ${input.uploadId} exists under multiple retained user roots`);
  }

  const match = matches[0];
  const chunks = await Promise.all(
    match.files.map(async (file) => {
      const raw = JSON.parse(await readFile(join(match.userRoot, "transcript-chunks", file), "utf8"));
      return TranscriptChunkSchema.parse(raw);
    })
  );
  chunks.sort((left, right) => left.index - right.index);
  if (new Set(chunks.map((chunk) => chunk.index)).size !== chunks.length) {
    throw new Error(`Retained transcript chunks for upload ${input.uploadId} contain duplicate indexes`);
  }
  if (chunks.some((chunk) => chunk.uploadId !== input.uploadId)) {
    throw new Error(`Retained transcript chunk uploadId mismatch for ${input.uploadId}`);
  }
  return { dataDir, userRoot: match.userRoot, uploadId: input.uploadId, chunks };
}

export function createSyntheticLabelSwapFixture(
  inputChunks: TranscriptChunk[]
): SyntheticSpeakerIdentityFixture {
  const chunks = inputChunks.map((chunk) => TranscriptChunkSchema.parse(chunk));
  const swappedChunkIndexes: number[] = [];
  const expectedGlobalSpeakerByGroup = new Map<string, string>();

  const swappedChunks = chunks.map((chunk) => {
    const localSpeakers = [...new Set(chunk.segments.flatMap((segment) =>
      segment.speaker ? [segment.speaker] : []
    ))].sort((left, right) => left.localeCompare(right, "en"));
    const shouldSwap = chunk.index % 2 === 1 && localSpeakers.length === 2;
    const speakerSwap = new Map<string, string>();
    if (shouldSwap) {
      speakerSwap.set(localSpeakers[0], localSpeakers[1]);
      speakerSwap.set(localSpeakers[1], localSpeakers[0]);
      swappedChunkIndexes.push(chunk.index);
    }
    for (const localSpeaker of localSpeakers) {
      const observedSpeaker = speakerSwap.get(localSpeaker) ?? localSpeaker;
      expectedGlobalSpeakerByGroup.set(
        speakerGroupKey(chunk.index, observedSpeaker),
        `synthetic_identity_${localSpeaker}`
      );
    }
    return TranscriptChunkSchema.parse({
      ...chunk,
      segments: chunk.segments.map((segment) => ({
        ...segment,
        ...(segment.speaker
          ? { speaker: speakerSwap.get(segment.speaker) ?? segment.speaker }
          : {})
      }))
    });
  });

  const matcher: SpeakerIdentityMatcher = {
    score({ left, right }) {
      const leftExpected = expectedGlobalSpeakerByGroup.get(
        speakerGroupKey(left.chunkIndex, left.localSpeaker)
      );
      const rightExpected = expectedGlobalSpeakerByGroup.get(
        speakerGroupKey(right.chunkIndex, right.localSpeaker)
      );
      if (!leftExpected || !rightExpected) return null;
      return leftExpected === rightExpected ? 0.96 : 0.04;
    }
  };

  return {
    chunks: swappedChunks,
    matcher,
    swappedChunkIndexes,
    expectedGlobalSpeakerByGroup
  };
}

export async function evaluateSpeakerIdentityArtifacts(input: {
  artifacts: LoadedSpeakerIdentityArtifacts;
  syntheticFixture?: SyntheticSpeakerIdentityFixture;
  now?: () => string;
}): Promise<SpeakerIdentityEvaluationReport> {
  const syntheticFixture =
    input.syntheticFixture ?? createSyntheticLabelSwapFixture(input.artifacts.chunks);
  const actual = await evaluateTrack({ kind: "actual_retained", chunks: input.artifacts.chunks });
  const simulated = await evaluateTrack({
    kind: "synthetic_label_swap",
    chunks: syntheticFixture.chunks,
    matcher: syntheticFixture.matcher,
    swappedChunkIndexes: syntheticFixture.swappedChunkIndexes,
    expectedGlobalSpeakerByGroup: syntheticFixture.expectedGlobalSpeakerByGroup
  });
  return {
    version: 1,
    generatedAt: (input.now ?? (() => new Date().toISOString()))(),
    mode: "offline",
    networkCallsAllowed: false,
    uploadId: input.artifacts.uploadId,
    input: {
      source: "retained_transcript_chunks",
      transcriptChunkFiles: input.artifacts.chunks.length
    },
    evidenceAvailability: {
      voiceprint: false,
      speakerEmbedding: false,
      persistedIdentityConfidence: false,
      note: "Retained transcript chunks contain local speaker labels only; transcript confidence is not identity confidence."
    },
    actual,
    simulated,
    limitations: [
      "The actual retained track must remain unknown when no voiceprint, embedding, or manual mapping evidence is available.",
      "The label-swap track is synthetic and validates resolver plumbing with a deterministic matcher; it is not a production acoustic benchmark.",
      "The report stores hashes and structural counters only; transcript text, audio, embeddings, and provider responses are excluded."
    ]
  };
}

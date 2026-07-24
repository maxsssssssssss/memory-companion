import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  AudioUploadSchema,
  BriefItemSchema,
  RelationshipSignalCardSchema,
  SemanticSegmentSchema,
  TranscriptSegmentSchema,
  type TranscriptSegment
} from "@/lib/domain/types";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { extractUploadMemoriesWithAudit } from "@/lib/server/memory/extractor";
import {
  resolveMemoryOwnerAttributions,
  type ResolveMemoryOwnerAttributionInput
} from "@/lib/server/memory/owner-attribution";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import { JsonStore } from "@/lib/server/storage/json-store";

type CliOptions = {
  dataDir: string;
  uploadId: string;
  reportPath: string;
};

function argumentValue(argv: string[], flag: string) {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArguments(argv: string[]): CliOptions {
  const known = new Set(["--data-dir", "--upload-id", "--report"]);
  argv.filter((value) => value.startsWith("--")).forEach((value) => {
    if (!known.has(value)) throw new Error(`Unknown argument: ${value}. This evaluator is offline-only.`);
  });
  const dataDir = argumentValue(argv, "--data-dir");
  const uploadId = argumentValue(argv, "--upload-id");
  const reportPath = argumentValue(argv, "--report");
  if (!dataDir || !uploadId || !reportPath) {
    throw new Error("Usage: memory:owner:evaluate -- --data-dir <runtime> --upload-id <id> --report <path>");
  }
  return { dataDir: resolve(dataDir), uploadId, reportPath: resolve(reportPath) };
}

function inside(parent: string, candidate: string) {
  const path = relative(parent, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

async function findUserStore(dataDir: string, uploadId: string) {
  const usersDir = join(dataDir, "users");
  const entries = await readdir(usersDir, { withFileTypes: true });
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const store = new JsonStore(join(usersDir, entry.name));
    if (await store.read("uploads", uploadId)) return { userId: entry.name, store };
  }
  throw new Error(`Upload ${uploadId} was not found below ${usersDir}`);
}

function normalizedQuote(value: string) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function syntheticSegment(input: {
  id: string;
  text: string;
  identityId: string;
  startSeconds: number;
}): TranscriptSegment {
  return {
    id: input.id,
    uploadId: "synthetic_owner_fixture",
    startSeconds: input.startSeconds,
    endSeconds: input.startSeconds + 5,
    speaker: `local_${input.id}`,
    identity: {
      globalSpeakerId: input.identityId,
      identityType: "known_contact",
      confidence: 0.95,
      source: "manual_mapping"
    },
    text: input.text,
    confidence: 0.95,
    sceneLabels: [],
    valueLabels: []
  };
}

function syntheticValidation() {
  const userPreference = syntheticSegment({
    id: "synthetic_preference_user",
    text: "我不太能吃辣。",
    identityId: "person_user",
    startSeconds: 0
  });
  const partnerPreference = syntheticSegment({
    id: "synthetic_preference_partner",
    text: "我不太能吃辣。",
    identityId: "person_partner",
    startSeconds: 6
  });
  const actor = syntheticSegment({
    id: "synthetic_commitment_actor",
    text: "我周二晚上陪你排练。",
    identityId: "person_partner",
    startSeconds: 12
  });
  const receiver = syntheticSegment({
    id: "synthetic_commitment_receiver",
    text: "好，谢谢你。",
    identityId: "person_user",
    startSeconds: 18
  });
  const eventA = syntheticSegment({
    id: "synthetic_event_a",
    text: "我们周日下午一起参加活动。",
    identityId: "person_user",
    startSeconds: 24
  });
  const eventB = syntheticSegment({
    id: "synthetic_event_b",
    text: "好，我会按时到。",
    identityId: "person_partner",
    startSeconds: 30
  });
  const ruleA = syntheticSegment({
    id: "synthetic_rule_a",
    text: "我们约定计划变化时提前通知。",
    identityId: "person_user",
    startSeconds: 36
  });
  const ruleB = syntheticSegment({
    id: "synthetic_rule_b",
    text: "这个规则双方都可以接受。",
    identityId: "person_partner",
    startSeconds: 42
  });
  const cases: ResolveMemoryOwnerAttributionInput[] = [
    { memoryId: "synthetic_user_preference", memoryType: "preference", evidenceSegments: [userPreference] },
    { memoryId: "synthetic_partner_preference", memoryType: "preference", evidenceSegments: [partnerPreference] },
    { memoryId: "synthetic_commitment", memoryType: "commitment", evidenceSegments: [actor, receiver] },
    { memoryId: "synthetic_event", memoryType: "event", evidenceSegments: [eventA, eventB] },
    { memoryId: "synthetic_relationship", memoryType: "relationship_signal", evidenceSegments: [ruleA, ruleB] }
  ];
  const result = resolveMemoryOwnerAttributions({
    memories: cases,
    now: () => "2026-07-20T00:00:00.000Z"
  });
  const byId = new Map(result.attributions.map((item) => [item.memoryId, item]));
  return {
    mode: "synthetic_identity_fixture",
    realVoiceprintValidation: false,
    cases: cases.length,
    differentPreferenceOwnersSeparated:
      byId.get("synthetic_user_preference")?.owner.identityId !==
      byId.get("synthetic_partner_preference")?.owner.identityId,
    commitmentActor: byId.get("synthetic_commitment")?.participants
      .find((item) => item.role === "actor")?.attribution.identityId ?? null,
    commitmentReceiver: byId.get("synthetic_commitment")?.participants
      .find((item) => item.role === "receiver")?.attribution.identityId ?? null,
    sharedEventParticipants: byId.get("synthetic_event")?.participants.length ?? 0,
    sharedRelationshipParticipants: byId.get("synthetic_relationship")?.participants.length ?? 0,
    audit: result.audit
  };
}

async function run(argv: string[]) {
  const options = parseArguments(argv);
  if (inside(options.dataDir, options.reportPath)) {
    throw new Error("--report must be outside the retained runtime data root");
  }
  const { userId, store } = await findUserStore(options.dataDir, options.uploadId);
  const [uploadRaw, segmentsRaw, briefRaw, semanticRaw, relationshipRaw] = await Promise.all([
    store.read("uploads", options.uploadId),
    store.read("segments", options.uploadId),
    store.read("brief-items", options.uploadId),
    store.read("semantic-segments", options.uploadId),
    store.read("relationship-signals", options.uploadId)
  ]);
  const upload = AudioUploadSchema.parse(uploadRaw);
  const segments = z.array(TranscriptSegmentSchema).parse(segmentsRaw ?? []);
  const briefItems = z.array(BriefItemSchema).parse(briefRaw ?? []);
  const semanticSegments = z.array(SemanticSegmentSchema).parse(semanticRaw ?? []);
  const relationshipSignals = z.array(RelationshipSignalCardSchema).parse(relationshipRaw ?? []);
  let networkAttempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkAttempts += 1;
    throw new Error("Network access is disabled for memory owner evaluation");
  }) as typeof fetch;

  const database = openMemoryDatabase({ filePath: ":memory:" });
  try {
    const extraction = extractUploadMemoriesWithAudit({
      userId,
      uploadId: upload.id,
      recordingDate: upload.recordingDate,
      segments,
      briefItems,
      semanticSegments,
      relationshipSignals,
      now: "2026-07-20T00:00:00.000Z"
    });
    const repository = createMemoryRepository(database);
    repository.replaceUploadMemories({
      userId,
      uploadId: upload.id,
      sourceSegments: segments,
      memories: extraction.memories,
      ownerAttributions: extraction.ownerAttributions
    });
    const memories = repository.getRelevantMemories({ userId, limit: 10_000 });
    const sourceIdsByType = {
      transcript: new Set(segments.map((item) => item.id)),
      brief: new Set(briefItems.map((item) => item.id)),
      timeline: new Set(semanticSegments.map((item) => item.id)),
      audio_insight: new Set<string>(),
      relationship_signal: new Set(relationshipSignals.map((item) => item.id))
    };
    const segmentById = new Map(segments.map((item) => [item.id, item]));
    let invalidSourceIds = 0;
    let nonVerbatimQuotes = 0;
    let duplicateEvidence = 0;
    for (const memory of memories) {
      const seen = new Set<string>();
      for (const evidence of memory.evidence) {
        if (!sourceIdsByType[evidence.sourceType].has(evidence.sourceId)) invalidSourceIds += 1;
        if (evidence.sourceType === "transcript") {
          const source = segmentById.get(evidence.sourceId);
          if (!source || !normalizedQuote(source.text).includes(normalizedQuote(evidence.quote))) {
            nonVerbatimQuotes += 1;
          }
        }
        const key = `${evidence.sourceId}\u001f${normalizedQuote(evidence.quote)}`;
        if (seen.has(key)) duplicateEvidence += 1;
        seen.add(key);
      }
    }
    const orphanEvidence = (database.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_evidence evidence
      LEFT JOIN memory_items memory ON memory.id = evidence.memory_id
      WHERE memory.id IS NULL
    `).get() as { count: number }).count;
    const report = {
      version: 1,
      generatedAt: new Date().toISOString(),
      mode: "offline_retained_artifact_evaluation",
      uploadId: upload.id,
      recordingDate: upload.recordingDate,
      networkAttempts,
      actual: {
        segments: segments.length,
        segmentsWithIdentity: segments.filter((segment) => segment.identity !== undefined).length,
        candidateMemories: extraction.audit.candidateCount,
        persistedMemories: memories.length,
        ownerAudit: extraction.audit.ownerAttribution,
        persistedOwnerAttributions: repository.getMemoryOwnerAttributions(userId).length
      },
      synthetic: syntheticValidation(),
      evidenceFirst: {
        invalidSourceIds,
        nonVerbatimQuotes,
        duplicateEvidence,
        memoriesWithoutEvidence: memories.filter((memory) => memory.evidence.length === 0).length,
        orphanEvidence
      },
      limitations: [
        "The retained 60-minute transcript has no trusted identity metadata, so actual-track owners must remain unknown.",
        "Synthetic identity fixtures validate deterministic attribution only; they are not voiceprint or acoustic validation.",
        "No provider, ASR, Memory production database, or original retained artifact was modified."
      ]
    };
    await mkdir(dirname(options.reportPath), { recursive: true });
    await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`${JSON.stringify({
      reportPath: options.reportPath,
      actual: {
        segments: report.actual.segments,
        segmentsWithIdentity: report.actual.segmentsWithIdentity,
        candidateMemories: report.actual.candidateMemories,
        persistedMemories: report.actual.persistedMemories,
        persistedOwnerAttributions: report.actual.persistedOwnerAttributions,
        knownOwners: report.actual.ownerAudit.knownOwners,
        localSpeakerOwners: report.actual.ownerAudit.localSpeakerOwners,
        unknownOwners: report.actual.ownerAudit.unknownOwners,
        sharedMemories: report.actual.ownerAudit.sharedMemories
      },
      synthetic: {
        differentPreferenceOwnersSeparated: report.synthetic.differentPreferenceOwnersSeparated,
        commitmentActor: report.synthetic.commitmentActor,
        commitmentReceiver: report.synthetic.commitmentReceiver,
        sharedEventParticipants: report.synthetic.sharedEventParticipants,
        sharedRelationshipParticipants: report.synthetic.sharedRelationshipParticipants
      },
      evidenceFirst: report.evidenceFirst,
      networkAttempts
    }, null, 2)}\n`);
    return report;
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run(process.argv.slice(2));
}

export { parseArguments, run as runMemoryOwnerAttributionEvaluation };

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { TranscriptSegmentSchema, type TranscriptSegment } from "@/lib/domain/types";
import {
  assertFrozenMemoryManifest,
  assertRetrievalHoldoutManifest,
  canonicalManifestJson,
  holdoutManifestHash
} from "@/lib/server/retrieval/hybrid/holdout-manifest";
import { PHASE_3_1_REGRESSION_CASE_IDS } from "@/lib/server/retrieval/hybrid/ranking-regression-fixture";

const DesignSchema = z.object({
  version: z.literal(1),
  sourceId: z.string().trim().min(1),
  designedAfterMemoryManifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  cases: z.array(z.object({
    caseId: z.string().trim().min(1),
    question: z.string().trim().min(1),
    scope: z.enum(["current", "week", "all"]),
    category: z.enum([
      "decision",
      "fact",
      "lifecycle",
      "preference",
      "relationship",
      "temporal",
      "other"
    ]),
    queryIntent: z.array(z.string().trim().min(1)).min(1),
    requiredAnswerAspects: z.array(z.string().trim().min(1)).min(1),
    goldEvidenceGroups: z.array(z.object({
      id: z.string().trim().min(1),
      sourceSegmentIds: z.array(z.string().trim().min(1)).min(1)
    }).strict()).min(1),
    acceptableAlternativeEvidenceGroups: z.array(z.object({
      id: z.string().trim().min(1),
      sourceSegmentIds: z.array(z.string().trim().min(1)).min(1)
    }).strict()),
    requiredLifecycleStates: z.array(z.string().trim().min(1)),
    requiredDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)),
    requiredEntities: z.array(z.string().trim().min(1)),
    memoryShouldHelp: z.boolean()
  }).strict()).min(1)
}).strict();

const DevReportSchema = z.object({
  source: z.object({
    isolatedRuntime: z.string(),
    userId: z.string(),
    days: z.array(z.object({
      day: z.string(),
      date: z.string(),
      uploadId: z.string()
    }))
  })
});

function argument(name: string) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined;
  if (!value) throw new Error(`${name} is required`);
  return resolve(value);
}

function digest(value: unknown) {
  return createHash("sha256").update(canonicalManifestJson(value)).digest("hex");
}

function transcriptHash(segments: readonly TranscriptSegment[]) {
  return digest(segments.map((segment) => ({
    id: segment.id,
    text: segment.text,
    startSeconds: segment.startSeconds,
    endSeconds: segment.endSeconds
  })));
}

function normalizedText(value: string) {
  return value.normalize("NFKC").replace(/\s+/gu, "").trim();
}

async function readSegments(input: {
  runtimePath: string;
  userId: string;
  uploadId: string;
}) {
  const path = resolve(
    input.runtimePath,
    "users",
    input.userId,
    "segments",
    `${input.uploadId}.json`
  );
  return z.array(TranscriptSegmentSchema).parse(
    JSON.parse(await readFile(path, "utf8"))
  );
}

async function main() {
  const designPath = argument("--design");
  const memoryManifestPath = argument("--memory-manifest");
  const devReportPath = argument("--dev-report");
  const outputManifestPath = argument("--output-manifest");
  const outputSourceReportPath = argument("--output-source-report");
  const outputIsolationPath = argument("--output-isolation");
  const design = DesignSchema.parse(
    JSON.parse(await readFile(designPath, "utf8"))
  );
  const memoryManifest = assertFrozenMemoryManifest(
    JSON.parse(await readFile(memoryManifestPath, "utf8"))
  );
  if (
    design.sourceId !== memoryManifest.source.sourceId ||
    design.designedAfterMemoryManifestHash !== memoryManifest.manifestHash
  ) {
    throw new Error("Question design does not reference the frozen Memory manifest");
  }

  const sourceRuntime = resolve(memoryManifest.source.runtimePath);
  const holdoutUploads = await Promise.all(
    memoryManifest.source.uploads.map(async (upload) => ({
      ...upload,
      segments: await readSegments({
        runtimePath: sourceRuntime,
        userId: memoryManifest.source.userId,
        uploadId: upload.uploadId
      })
    }))
  );
  const holdoutSegments = holdoutUploads.flatMap((upload) => upload.segments);
  const holdoutSegmentById = new Map(
    holdoutSegments.map((segment) => [segment.id, segment])
  );
  const dayBySegmentId = new Map(
    holdoutUploads.flatMap((upload, index) =>
      upload.segments.map((segment) => [
        segment.id,
        `${design.sourceId}-day${String(index + 1).padStart(2, "0")}`
      ] as const)
    )
  );
  for (const item of design.cases) {
    for (const group of [
      ...item.goldEvidenceGroups,
      ...item.acceptableAlternativeEvidenceGroups
    ]) {
      for (const sourceSegmentId of group.sourceSegmentIds) {
        if (!holdoutSegmentById.has(sourceSegmentId)) {
          throw new Error(
            `Case ${item.caseId} gold segment is absent from holdout: ${sourceSegmentId}`
          );
        }
      }
    }
  }

  const devReport = DevReportSchema.parse(
    JSON.parse(await readFile(devReportPath, "utf8"))
  );
  const devUploads = await Promise.all(devReport.source.days.map(async (day) => ({
    ...day,
    segments: await readSegments({
      runtimePath: devReport.source.isolatedRuntime,
      userId: devReport.source.userId,
      uploadId: day.uploadId
    })
  })));
  const devSegments = devUploads.flatMap((upload) => upload.segments);
  const devTexts = new Set(
    devSegments.map((segment) => normalizedText(segment.text)).filter(Boolean)
  );
  const exactTextOverlap = holdoutSegments.filter((segment) =>
    devTexts.has(normalizedText(segment.text))
  );
  const devSegmentIds = new Set(devSegments.map((segment) => segment.id));
  const sourceSegmentIdOverlap = holdoutSegments.filter((segment) =>
    devSegmentIds.has(segment.id)
  );
  if (exactTextOverlap.length > 0 || sourceSegmentIdOverlap.length > 0) {
    throw new Error(
      `Holdout isolation failed: exact_text=${exactTextOverlap.length}, ` +
      `source_id=${sourceSegmentIdOverlap.length}`
    );
  }

  const memoryIdsForCase = (item: z.infer<typeof DesignSchema>["cases"][number]) => {
    const goldIds = new Set(
      item.goldEvidenceGroups.flatMap((group) => group.sourceSegmentIds)
    );
    return memoryManifest.memories
      .filter((memory) => memory.evidence.some((evidence) =>
        evidence.canonicalSourceSegmentIds.some((sourceId) => goldIds.has(sourceId)) ||
        goldIds.has(evidence.sourceId)
      ))
      .map((memory) => memory.memoryId)
      .sort();
  };
  const latestDate = [...memoryManifest.source.uploads]
    .map((upload) => upload.recordingDate)
    .sort()
    .at(-1)!;
  const sourceReport = {
    version: 1,
    kind: "daily_brief_retrieval_holdout_source",
    source: {
      isolatedRuntime: sourceRuntime,
      userId: memoryManifest.source.userId,
      days: memoryManifest.source.uploads.map((upload, index) => ({
        day: `${design.sourceId}-day${String(index + 1).padStart(2, "0")}`,
        date: upload.recordingDate,
        uploadId: upload.uploadId
      }))
    },
    results: design.cases.map((item) => ({
      id: item.caseId,
      scope: item.scope,
      category: item.category,
      question: item.question,
      currentDay:
        item.scope === "current"
          ? dayBySegmentId.get(item.goldEvidenceGroups[0]!.sourceSegmentIds[0]!)!
          : null,
      referenceDate: item.scope === "current" ? null : latestDate,
      retrievalEvaluable: true,
      retrievalFailures: [],
      expectedEvidence: item.goldEvidenceGroups.map((group) => ({
        day: dayBySegmentId.get(group.sourceSegmentIds[0]!)!,
        matchedSegmentIds: group.sourceSegmentIds
      })),
      retrievedTopK: []
    }))
  };
  await mkdir(dirname(outputSourceReportPath), { recursive: true });
  await writeFile(
    outputSourceReportPath,
    JSON.stringify(sourceReport, null, 2),
    "utf8"
  );

  const frozenAt = new Date().toISOString();
  const baseManifest = {
    version: 1 as const,
    kind: "daily_brief_retrieval_holdout_manifest" as const,
    role: "holdout" as const,
    splitUnit: "recording_upload_date_group" as const,
    frozenAt,
    memoryManifests: [{
      sourceId: memoryManifest.source.sourceId,
      manifestPath: memoryManifestPath.replaceAll("\\", "/"),
      manifestHash: memoryManifest.manifestHash,
      frozenAt: memoryManifest.frozenAt
    }],
    developmentSet: {
      name: "hybrid_phase31_shadow_v1" as const,
      uploadIds: devUploads.map((upload) => upload.uploadId).sort(),
      transcriptHashes: devUploads.map((upload) => transcriptHash(upload.segments)).sort(),
      eventClusterIds: devUploads
        .map((upload) => `development-upload:${upload.uploadId}`)
        .sort()
    },
    sources: [{
      ...memoryManifest.source,
      benchmarkReportPath: outputSourceReportPath.replaceAll("\\", "/")
    }],
    cases: design.cases.map((item) => ({
      ...item,
      expectedMemoryIds: item.memoryShouldHelp ? memoryIdsForCase(item) : [],
      evaluability: "retrieval-evaluable" as const,
      exclusionReasons: [],
      sourceId: design.sourceId
    }))
  };
  const manifest = {
    ...baseManifest,
    manifestHash: holdoutManifestHash(baseManifest)
  };
  assertRetrievalHoldoutManifest({
    value: manifest,
    memoryManifests: [memoryManifest],
    forbiddenCaseIds: PHASE_3_1_REGRESSION_CASE_IDS
  });
  await mkdir(dirname(outputManifestPath), { recursive: true });
  await writeFile(outputManifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const isolation = {
    version: 1,
    kind: "daily_brief_retrieval_holdout_isolation",
    generatedAt: frozenAt,
    development: {
      uploadCount: devUploads.length,
      transcriptSegmentCount: devSegments.length,
      uploadIds: devUploads.map((upload) => upload.uploadId).sort()
    },
    holdout: {
      sourceCount: 1,
      uploadCount: holdoutUploads.length,
      transcriptSegmentCount: holdoutSegments.length,
      caseCount: design.cases.length,
      uploadIds: holdoutUploads.map((upload) => upload.uploadId).sort(),
      categoryCounts: Object.fromEntries(
        [...new Set(design.cases.map((item) => item.category))]
          .sort()
          .map((category) => [
            category,
            design.cases.filter((item) => item.category === category).length
          ])
      ),
      scopeCounts: Object.fromEntries(
        (["current", "week", "all"] as const).map((scope) => [
          scope,
          design.cases.filter((item) => item.scope === scope).length
        ])
      )
    },
    isolation: {
      uploadIdOverlapCount: holdoutUploads.filter((holdout) =>
        devUploads.some((development) => development.uploadId === holdout.uploadId)
      ).length,
      sourceSegmentIdOverlapCount: sourceSegmentIdOverlap.length,
      normalizedExactTextOverlapCount: exactTextOverlap.length,
      regressionCaseIdOverlapCount: design.cases.filter((item) =>
        PHASE_3_1_REGRESSION_CASE_IDS.has(
          item.caseId as Parameters<typeof PHASE_3_1_REGRESSION_CASE_IDS.has>[0]
        )
      ).length
    },
    memoryFrozenBeforeQuestions:
      Date.parse(memoryManifest.frozenAt) <= Date.parse(frozenAt),
    memoryManifestHash: memoryManifest.manifestHash,
    holdoutManifestHash: manifest.manifestHash
  };
  await mkdir(dirname(outputIsolationPath), { recursive: true });
  await writeFile(outputIsolationPath, JSON.stringify(isolation, null, 2), "utf8");
  console.log(JSON.stringify({
    outputManifestPath,
    outputSourceReportPath,
    outputIsolationPath,
    manifestHash: manifest.manifestHash,
    memoryManifestHash: memoryManifest.manifestHash,
    holdoutCases: design.cases.length,
    holdoutSegments: holdoutSegments.length,
    devSegments: devSegments.length,
    exactTextOverlap: exactTextOverlap.length,
    sourceSegmentIdOverlap: sourceSegmentIdOverlap.length
  }, null, 2));
}

main().catch((error) => {
  console.error(
    `[build-hybrid-holdout-manifest] failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exitCode = 1;
});

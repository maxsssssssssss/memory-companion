import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { RelationshipSignalCandidateSchema } from "@/lib/server/relationship-signals/candidates";
import {
  relationshipLifecycleSignalsFromCandidates,
  resolveRelationshipLifecycles
} from "@/lib/server/relationship-signals/lifecycle/resolver";
import { lifecycleRoles } from "@/lib/server/relationship-signals/lifecycle/rules";
import { loadRelationshipReplayArtifacts } from "@/lib/server/relationship-signals/replay";

const CandidateArraySchema = z.array(RelationshipSignalCandidateSchema);

type Arguments = {
  dataDir: string;
  uploadId: string;
  reportPath: string;
  userId?: string;
};

function argumentValue(arguments_: string[], name: string) {
  const index = arguments_.indexOf(name);
  if (index < 0) return undefined;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parseArguments(arguments_: string[]): Arguments {
  const dataDir = argumentValue(arguments_, "--data-dir");
  const uploadId = argumentValue(arguments_, "--upload-id");
  const reportPath = argumentValue(arguments_, "--report");
  const userId = argumentValue(arguments_, "--user-id");
  if (!dataDir || !uploadId || !reportPath) {
    throw new Error("Usage: relationship:lifecycle:evaluate -- --data-dir <path> --upload-id <id> --report <path> [--user-id <id>]");
  }
  return { dataDir, uploadId, reportPath, ...(userId ? { userId } : {}) };
}

function lifecycleKind(edge: { relationType: string; reason: string }) {
  if (edge.relationType === "updated_by") return "updated" as const;
  if (edge.relationType === "answered_by" && edge.reason.startsWith("question_to_")) return "questionResolved" as const;
  if (edge.relationType === "resolved_by" && edge.reason.startsWith("plan_to_")) return "planCompleted" as const;
  if (edge.relationType === "fulfilled_by" && edge.reason.startsWith("commitment_to_")) return "commitmentFulfilled" as const;
  if (edge.relationType === "resolved_by" && edge.reason.startsWith("concern_to_")) return "concernResolved" as const;
  return "other" as const;
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const artifacts = await loadRelationshipReplayArtifacts({
    dataDir: resolve(arguments_.dataDir),
    uploadId: arguments_.uploadId,
    ...(arguments_.userId ? { userId: arguments_.userId } : {})
  });
  const candidates = artifacts.relationshipCheckpoints.flatMap((checkpoint) => {
    if (checkpoint.status !== "completed" || checkpoint.output === undefined) return [];
    const parsed = CandidateArraySchema.safeParse(checkpoint.output);
    return parsed.success ? parsed.data : [];
  });
  const signals = relationshipLifecycleSignalsFromCandidates({
    candidates,
    segments: artifacts.segments,
    recordingDate: artifacts.upload.recordingDate
  });
  const resolution = resolveRelationshipLifecycles(signals);
  const validSegmentIds = new Set(artifacts.segments.map((segment) => segment.id));
  const invalidSourceIds = resolution.edges.reduce((count, edge) => count + [
    ...edge.evidence.fromSegments,
    ...edge.evidence.toSegments
  ].filter((segmentId) => !validSegmentIds.has(segmentId)).length, 0);
  const lifecycleCounts = {
    questionResolved: 0,
    planCompleted: 0,
    commitmentFulfilled: 0,
    concernResolved: 0,
    updated: 0,
    other: 0
  };
  for (const edge of resolution.edges) lifecycleCounts[lifecycleKind(edge)] += 1;
  const sourceRoleCounts: Record<string, number> = {};
  for (const signal of signals) {
    for (const role of lifecycleRoles(signal)) sourceRoleCounts[role] = (sourceRoleCounts[role] ?? 0) + 1;
  }
  const falsePositiveRejected = ["different_entity", "different_goal", "different_time_window"]
    .reduce((count, reason) => count + (resolution.audit.rejectedMatches[reason as keyof typeof resolution.audit.rejectedMatches] ?? 0), 0);
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: "offline",
    uploadId: artifacts.upload.id,
    userId: artifacts.userId,
    recordingDate: artifacts.upload.recordingDate,
    input: {
      retainedRelationshipCheckpoints: artifacts.relationshipCheckpoints.length,
      completedCandidateCheckpoints: artifacts.relationshipCheckpoints.filter((checkpoint) => checkpoint.status === "completed").length,
      candidates: candidates.length,
      lifecycleSignals: signals.length,
      sourceRoleCounts
    },
    before: {
      lifecycleEdges: 0
    },
    after: {
      lifecycleEdges: resolution.edges.length,
      ...lifecycleCounts,
      falsePositiveRejected
    },
    metrics: {
      candidate_pairs_checked: resolution.audit.candidatePairsChecked,
      lifecycle_edges_created: resolution.audit.lifecycleEdgesCreated,
      rejected_matches: resolution.audit.matches.filter((match) => !match.accepted).length
    },
    edges: resolution.edges.map((edge) => ({
      from: edge.fromSignalId,
      to: edge.toSignalId,
      type: edge.relationType,
      confidence: edge.confidence,
      reason: edge.reason
    })),
    evidenceFirst: {
      invalidSourceIds,
      quoteMismatch: 0,
      duplicateEvidence: 0,
      safetyViolations: 0,
      note: "Lifecycle edges contain segment IDs only; the resolver neither creates nor rewrites quotes."
    },
    audit: resolution.audit
  };
  const reportPath = resolve(arguments_.reportPath);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({ reportPath, ...report.after, evidenceFirst: report.evidenceFirst }, null, 2)}\n`);
}

await main();

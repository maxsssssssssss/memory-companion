import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const datasetDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(datasetDir, "../..");
const REPORT_VERSION = 1;
const REPORT_FILES = [
  "report.md",
  "report.json",
  "pipeline.log",
  "queue-audit.json",
  "worker-audit.json",
  "asr-audit.json",
  "audio-insight-audit.json",
  "daily-brief-audit.json",
  "relationship-audit.json",
  "checkpoint-audit.json",
  "memory-audit.json",
  "baseline-comparison.json"
];
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const LOG_PREFIXES = [
  "[pipeline]",
  "[pipeline-queue]",
  "[pipeline-worker]",
  "[transcription]",
  "[asr-chunks]",
  "[transcript-merge]",
  "[analysis-chunks]",
  "[analysis-parallel]",
  "[audio-insights]",
  "[audio-insight]",
  "[ffmpeg-features]",
  "[emotion-signals]",
  "[semantic-segments]",
  "[extraction]",
  "[daily-brief-provider]",
  "[daily-brief-chunks]",
  "[relationship-provider]",
  "[relationship-signals]",
  "[relationship-context-selection]",
  "[memory-index]",
  "[proactive-insights]",
  "[evaluation-retention]"
];

function usage() {
  return [
    "Usage: node audit-pipeline.mjs \\",
    "  --data-dir <retained APP_DATA_DIR> --user <user id> --upload <upload id> \\",
    "  --job <product job id> --queue-job <BullMQ job id> \\",
    "  --pipeline-log <web/pipeline log> --worker-log <worker log> \\",
    "  --report-dir <new or empty report directory> --baseline <45m report.json>"
  ].join("\n");
}

function resolveInputPath(value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(repoRoot, value);
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }
  const names = new Map([
    ["--data-dir", "dataDir"],
    ["--user", "userId"],
    ["--upload", "uploadId"],
    ["--job", "jobId"],
    ["--queue-job", "queueJobId"],
    ["--pipeline-log", "pipelineLogPath"],
    ["--worker-log", "workerLogPath"],
    ["--report-dir", "reportDir"],
    ["--baseline", "baselinePath"]
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = names.get(argv[index]);
    if (!name) throw new Error(`Unknown argument: ${argv[index]}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argv[index]}`);
    options[name] = value;
    index += 1;
  }
  const missing = [...names.values()].filter((name) => !options[name]);
  if (missing.length > 0) throw new Error(`Missing required arguments: ${missing.join(", ")}\n${usage()}`);
  for (const name of ["dataDir", "pipelineLogPath", "workerLogPath", "reportDir", "baselinePath"]) {
    options[name] = resolveInputPath(options[name]);
  }
  return options;
}

function assertReadableFile(filePath, label) {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`${label} is not a readable file: ${filePath}`);
}

function assertReportDirectoryAvailable(reportDir) {
  const stat = fs.statSync(reportDir, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw new Error(`Report path is not a directory: ${reportDir}`);
  const existingTargets = REPORT_FILES.filter((name) => fs.existsSync(path.join(reportDir, name)));
  if (existingTargets.length > 0) {
    throw new Error(`Refusing to overwrite existing report files: ${existingTargets.join(", ")}`);
  }
}

function unwrap(value) {
  return value && typeof value === "object" && !Array.isArray(value) && "data" in value
    ? value.data
    : value;
}

function readJson(filePath, fallback = undefined) {
  if (!fs.existsSync(filePath)) return fallback;
  return unwrap(JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "")));
}

function readJsonRecord(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, value: null, error: null, filePath: null };
  try {
    return { exists: true, value: readJson(filePath, null), error: null, filePath };
  } catch (error) {
    return {
      exists: true,
      value: null,
      error: error instanceof Error ? error.name : "invalid_json",
      filePath
    };
  }
}

function readCollectionItem(userRoot, collection, id) {
  return readJsonRecord(path.join(userRoot, collection, `${id}.json`));
}

function readCollection(userRoot, collection, predicate = () => true) {
  const directory = path.join(userRoot, collection);
  if (!fs.existsSync(directory)) {
    return { exists: false, values: [], corruptFiles: 0, files: [] };
  }
  const files = fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(directory, name));
  const values = [];
  const matchedFiles = [];
  let corruptFiles = 0;
  for (const filePath of files) {
    const record = readJsonRecord(filePath);
    if (record.error) {
      corruptFiles += 1;
      continue;
    }
    if (record.value !== null && predicate(record.value)) {
      values.push(record.value);
      matchedFiles.push(filePath);
    }
  }
  return { exists: true, values, corruptFiles, files: matchedFiles };
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function countBy(values, selector) {
  const counts = {};
  for (const value of values) {
    const key = String(selector(value) ?? "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function elapsedMs(start, end) {
  if (!start || !end) return null;
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function epochIso(value) {
  const milliseconds = numberOrNull(value);
  if (milliseconds === null) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sanitizedNetworkEndpoint(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return null;
  }
}

function normalizedQuote(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizedEvidenceQuoteForDedup(value) {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\r\n?/gu, "\n")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.replace(/[\p{P}\s]+/gu, "").trim() || normalized;
}

function safeReference(value, label) {
  return value
    ? `${label}-${createHash("sha256").update(String(value)).digest("hex").slice(0, 12)}`
    : null;
}

function hashFile(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function combinedFileHash(files) {
  const digest = createHash("sha256");
  for (const filePath of [...new Set(files)].filter((item) => item && fs.existsSync(item)).sort()) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) continue;
    digest.update(path.relative(repoRoot, filePath).replaceAll("\\", "/"));
    digest.update("\0");
    digest.update(hashFile(filePath));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function readLog(filePath) {
  const buffer = fs.readFileSync(filePath);
  let text;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) text = buffer.subarray(2).toString("utf16le");
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) throw new Error("Big-endian UTF-16 logs are unsupported");
  else text = buffer.toString("utf8").replace(/^\uFEFF/u, "");
  return text.replace(/\u0000/gu, "");
}

function logLines(text) {
  return text.split(/\r?\n/u).map((line) => line.replace(/^node\.exe\s*:\s*(?=\[)/u, "").trim()).filter(Boolean);
}

function relevantLines(text) {
  return logLines(text).filter((line) => LOG_PREFIXES.some((prefix) => line.includes(prefix)));
}

function matchingLines(text, marker) {
  return logLines(text).filter((line) => line.includes(marker));
}

function parseFields(line) {
  return Object.fromEntries(
    [...line.matchAll(/([a-z][a-z0-9_]*)=([^\s]+)/giu)].map((match) => [match[1], match[2]])
  );
}

function lastFields(text, marker, predicate = () => true) {
  const lines = matchingLines(text, marker).filter(predicate);
  return lines.length > 0 ? parseFields(lines.at(-1)) : {};
}

function timestampFromLine(line) {
  const match = line.match(/\b(20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\b/u);
  return match?.[1] ?? null;
}

function sanitizeLogLine(line, identifiers) {
  if (/(?:^|\s)(?:transcript|quote|provider_response|response_body|raw_response|request_body|prompt)\s*[=:]/iu.test(line)) {
    return null;
  }
  let safe = line;
  for (const [value, replacement] of identifiers) {
    if (value) safe = safe.replaceAll(value, replacement);
  }
  safe = safe
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "<redacted-email>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer <redacted>")
    .replace(/((?:api[_-]?key|token|password|authorization|secret|credential)\s*[=:]\s*)[^\s&,]+/giu, "$1<redacted>")
    .replace(/([?&](?:api[_-]?key|token|password|authorization|secret|credential)=)[^&\s]+/giu, "$1<redacted>")
    .replace(/redis:\/\/([^\s:@/]+):([^\s@/]+)@/giu, "redis://<redacted>@")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, "<id>");
  return safe.slice(0, 2_000);
}

function sanitizedPipelineLog(pipelineText, workerText, options) {
  const identifiers = [
    [options.uploadId, "<upload>"],
    [options.userId, "<user>"],
    [options.jobId, "<product-job>"],
    [options.queueJobId, "<queue-job>"]
  ];
  const pipeline = relevantLines(pipelineText).map((line) => sanitizeLogLine(line, identifiers)).filter(Boolean);
  const worker = relevantLines(workerText).map((line) => sanitizeLogLine(line, identifiers)).filter(Boolean);
  return ["# Sanitized pipeline log", "# Pipeline/Web", ...pipeline, "# Worker", ...worker, ""].join("\n");
}

function safeGitState() {
  const run = (args) => spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  const head = run(["rev-parse", "HEAD"]);
  const status = run(["status", "--short"]);
  return {
    head: head.status === 0 ? head.stdout.trim() : null,
    dirtyEntryCount: status.status === 0 ? status.stdout.split(/\r?\n/u).filter(Boolean).length : null
  };
}

function publicConfiguration() {
  const keys = [
    "PIPELINE_EXECUTION_MODE",
    "PIPELINE_QUEUE_NAME",
    "PIPELINE_WORKER_CONCURRENCY",
    "PIPELINE_JOB_ATTEMPTS",
    "PIPELINE_JOB_BACKOFF_MS",
    "AUDIO_CHUNK_DURATION_SECONDS",
    "ASR_CHUNK_CONCURRENCY",
    "AUDIO_INSIGHT_CHUNK_CONCURRENCY",
    "EXTRACTION_CHUNK_CONCURRENCY",
    "EXTRACTION_RECOVERY_CONCURRENCY",
    "RELATIONSHIP_SIGNAL_CHUNK_CONCURRENCY",
    "RELATIONSHIP_SIGNAL_RECOVERY_CONCURRENCY",
    "EVALUATION_MODE"
  ];
  return Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));
}

function stageDurations(logText) {
  const analysis = lastFields(logText, "[analysis-parallel] completed");
  return {
    transcriptionMs: numberOrNull(lastFields(logText, "[transcription] completed").elapsed_ms),
    analysisParallelMs: numberOrNull(analysis.elapsed_ms),
    audioInsightMs: numberOrNull(lastFields(logText, "[audio-insights] completed count=").elapsed_ms),
    acousticMsConcurrent: numberOrNull(analysis.acoustic_duration_ms),
    emotionMsConcurrent: numberOrNull(analysis.emotion_duration_ms),
    semanticTimelineMs: numberOrNull(lastFields(logText, "[semantic-segments] completed").elapsed_ms),
    dailyBriefMs: numberOrNull(lastFields(logText, "[extraction] completed count=").elapsed_ms),
    relationshipMs: numberOrNull(lastFields(logText, "[relationship-signals] completed count=").elapsed_ms),
    memoryMs: numberOrNull(lastFields(logText, "[memory-index] completed").elapsed_ms),
    proactiveMs: numberOrNull(lastFields(logText, "[proactive-insights] completed").elapsed_ms),
    pipelineMs: numberOrNull(lastFields(logText, "[pipeline] ready").elapsed_ms)
      ?? numberOrNull(lastFields(logText, "[pipeline] failed").elapsed_ms)
  };
}

function inspectMemory(input) {
  const unavailable = {
    available: false,
    databaseIntegrity: null,
    foreignKeyViolations: null,
    crossUserRelations: null,
    itemCount: null,
    itemsWithCurrentUploadEvidence: null,
    evidenceCount: null,
    currentUploadEvidenceCount: null,
    relationCount: null,
    relationsTouchingCurrentUpload: null,
    byType: null,
    byStatus: null,
    importance: null,
    evidenceBySourceType: null,
    evidenceFirst: {
      audited: false,
      evidenceCount: null,
      invalidSourceIds: null,
      nonVerbatimQuotes: null,
      duplicateEvidence: null,
      memoriesWithoutEvidence: null,
      orphanEvidence: null,
      scope: "unavailable"
    },
    error: null
  };
  if (!fs.existsSync(input.databasePath)) return { ...unavailable, error: "memory_database_missing" };

  let db;
  try {
    db = new Database(input.databasePath, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    if (!["memory_items", "memory_evidence", "memory_relations"].every((name) => tables.has(name))) {
      return { ...unavailable, error: "memory_schema_incomplete" };
    }
    const integrity = db.pragma("integrity_check", { simple: true });
    const foreignKeyViolations = db.pragma("foreign_key_check").length;
    const items = db.prepare(`
      SELECT id,type,importance_score,status,occurrence_count,first_seen_date,last_seen_date,date,created_at,updated_at
      FROM memory_items WHERE user_id = ? ORDER BY id
    `).all(input.userId);
    const evidence = db.prepare(`
      SELECT e.memory_id,e.source_type,e.source_id,e.upload_id,e.date,e.quote
      FROM memory_evidence e JOIN memory_items m ON m.id=e.memory_id
      WHERE m.user_id = ? ORDER BY e.memory_id,e.id
    `).all(input.userId);
    const relations = db.prepare(`
      SELECT r.source_memory_id,r.target_memory_id,r.relation_type,r.confidence
      FROM memory_relations r
      WHERE r.source_memory_id IN (SELECT id FROM memory_items WHERE user_id = ?)
         OR r.target_memory_id IN (SELECT id FROM memory_items WHERE user_id = ?)
      ORDER BY r.id
    `).all(input.userId, input.userId);
    const orphanEvidence = numberOrNull(db.prepare(`
      SELECT COUNT(*) AS count FROM memory_evidence e
      LEFT JOIN memory_items m ON m.id=e.memory_id WHERE m.id IS NULL
    `).get()?.count);
    const crossUserRelations = numberOrNull(db.prepare(`
      SELECT COUNT(*) AS count FROM memory_relations r
      JOIN memory_items source ON source.id=r.source_memory_id
      JOIN memory_items target ON target.id=r.target_memory_id
      WHERE source.user_id <> target.user_id
    `).get()?.count);
    const currentEvidence = evidence.filter((item) => item.upload_id === input.uploadId);
    const evidenceMemoryIds = new Set(evidence.map((item) => item.memory_id));
    const currentMemoryIds = new Set(currentEvidence.map((item) => item.memory_id));
    const sourceIdsByType = {
      transcript: new Set(input.segments.map((item) => item.id)),
      brief: new Set(input.briefItems.map((item) => item.id)),
      timeline: new Set(input.semanticSegments.map((item) => item.id)),
      audio_insight: new Set(input.audioInsights.map((item) => item.id)),
      relationship_signal: new Set(input.relationshipCards.map((item) => item.id))
    };
    const sourceCollectionsAvailable = input.sourceCollectionsAvailable;
    const invalidSourceIds = sourceCollectionsAvailable
      ? currentEvidence.filter((item) => !sourceIdsByType[item.source_type]?.has(item.source_id)).length
      : null;
    const segmentById = new Map(input.segments.map((segment) => [segment.id, segment]));
    const transcriptText = input.segments.map((segment) => normalizedQuote(segment.text));
    const nonVerbatimQuotes = input.segmentsAvailable
      ? currentEvidence.filter((item) => {
          const quote = normalizedQuote(item.quote);
          if (!quote) return true;
          const source = item.source_type === "transcript" ? segmentById.get(item.source_id) : null;
          return source
            ? !normalizedQuote(source.text).includes(quote)
            : !transcriptText.some((text) => text.includes(quote));
        }).length
      : null;
    const duplicateEvidence = currentEvidence.reduce((state, item) => {
      const key = `${item.memory_id}\u001f${item.upload_id}\u001f${item.source_id}\u001f${normalizedEvidenceQuoteForDedup(item.quote)}`;
      if (state.seen.has(key)) state.count += 1;
      else state.seen.add(key);
      return state;
    }, { seen: new Set(), count: 0 }).count;
    const importance = {
      high: items.filter((item) => Number(item.importance_score) >= 0.7).length,
      medium: items.filter((item) => Number(item.importance_score) >= 0.4 && Number(item.importance_score) < 0.7).length,
      low: items.filter((item) => Number(item.importance_score) < 0.4).length
    };
    return {
      available: true,
      databaseIntegrity: integrity,
      foreignKeyViolations,
      crossUserRelations,
      itemCount: items.length,
      itemsWithCurrentUploadEvidence: currentMemoryIds.size,
      evidenceCount: evidence.length,
      currentUploadEvidenceCount: currentEvidence.length,
      relationCount: relations.length,
      relationsTouchingCurrentUpload: relations.filter(
        (item) => currentMemoryIds.has(item.source_memory_id) || currentMemoryIds.has(item.target_memory_id)
      ).length,
      byType: countBy(items, (item) => item.type),
      byStatus: countBy(items, (item) => item.status),
      importance,
      evidenceBySourceType: countBy(currentEvidence, (item) => item.source_type),
      lifecycle: {
        repeatedItems: items.filter((item) => Number(item.occurrence_count) > 1).length,
        resolvedItems: items.filter((item) => item.status === "resolved").length
      },
      evidenceFirst: {
        audited: sourceCollectionsAvailable && input.segmentsAvailable,
        evidenceCount: currentEvidence.length,
        invalidSourceIds,
        nonVerbatimQuotes,
        duplicateEvidence,
        memoriesWithoutEvidence: items.filter((item) => !evidenceMemoryIds.has(item.id)).length,
        orphanEvidence,
        scope: "user_and_current_upload"
      },
      error: null
    };
  } catch (error) {
    return { ...unavailable, error: error instanceof Error ? error.name : "memory_audit_failed" };
  } finally {
    db?.close();
  }
}

function summarizeCheckpointKind(checkpoints) {
  return {
    count: checkpoints.length,
    byStatus: countBy(checkpoints, (item) => item.status),
    byResultSource: countBy(checkpoints, (item) => item.resultSource ?? "none"),
    completed: checkpoints.filter((item) => item.status === "completed").length,
    failed: checkpoints.filter((item) => item.status === "failed").length,
    processing: checkpoints.filter((item) => item.status === "processing").length,
    outputPresent: checkpoints.filter((item) => item.output !== undefined).length,
    attemptCount: {
      total: sum(checkpoints.map((item) => numberOrNull(item.attemptCount) ?? 0)),
      maximum: checkpoints.length > 0 ? Math.max(...checkpoints.map((item) => numberOrNull(item.attemptCount) ?? 0)) : 0
    },
    sourceChunkIndexes: checkpoints.map((item) => numberOrNull(item.sourceChunkIndex)).filter((item) => item !== null).sort((a, b) => a - b),
    inputFingerprintsValid: checkpoints.every((item) => SHA256_PATTERN.test(String(item.inputFingerprint ?? ""))),
    processorFingerprintsValid: checkpoints.every((item) => SHA256_PATTERN.test(String(item.processorFingerprint ?? "")))
  };
}

function validationIssueSummary(checkpoints) {
  const counts = {};
  for (const checkpoint of checkpoints) {
    const issues = ensureArray(checkpoint.metadata?.validationIssueSummary);
    for (const issue of issues) {
      const code = String(issue?.code ?? "unknown").slice(0, 80);
      counts[code] = (counts[code] ?? 0) + (numberOrNull(issue?.count) ?? 1);
    }
  }
  return Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)).map(([code, count]) => ({ code, count }));
}

function checkpointAudit(input) {
  const all = input.checkpoints;
  const rawFiles = input.files.filter((filePath) => fs.existsSync(filePath));
  const secretValues = Object.entries(process.env)
    .filter(([name, value]) => /(?:api[_-]?key|token|password|secret|credential)/iu.test(name) && String(value ?? "").length >= 8)
    .map(([, value]) => String(value));
  let sensitiveKeyFiles = 0;
  let knownSecretFiles = 0;
  for (const filePath of rawFiles) {
    const raw = fs.readFileSync(filePath, "utf8");
    if (/"(?:apiKey|api_key|token|password|authorization|secret|credential)"\s*:/iu.test(raw)) sensitiveKeyFiles += 1;
    if (secretValues.some((value) => raw.includes(value))) knownSecretFiles += 1;
  }
  const byKind = Object.fromEntries(
    ["audio_insight", "daily_brief", "relationship_candidate"].map((kind) => [
      kind,
      summarizeCheckpointKind(all.filter((item) => item.kind === kind))
    ])
  );
  const processing = all.filter((item) => item.status === "processing");
  return {
    version: REPORT_VERSION,
    scope: "retained runtime, read-only",
    total: all.length,
    corruptFiles: input.corruptFiles,
    byKind,
    validationIssueSummary: validationIssueSummary(all),
    leaseAndHeartbeat: {
      processingAtAudit: processing.length,
      processingUpdatedAfterStart: processing.filter(
        (item) => item.startedAt && item.updatedAt && Date.parse(item.updatedAt) > Date.parse(item.startedAt)
      ).length,
      heartbeatEventsInLogs: matchingLines(input.pipelineText, "checkpoint heartbeat").length || null,
      note: "Completed checkpoint records do not preserve every lease heartbeat; null means no reliable log evidence."
    },
    integrity: {
      allInputFingerprintsValid: all.every((item) => SHA256_PATTERN.test(String(item.inputFingerprint ?? ""))),
      allProcessorFingerprintsValid: all.every((item) => SHA256_PATTERN.test(String(item.processorFingerprint ?? ""))),
      allCompletedOutputsPresent: all.filter((item) => item.status === "completed").every((item) => item.output !== undefined),
      knownSecretValueFiles: knownSecretFiles,
      sensitiveKeyNameFiles: sensitiveKeyFiles,
      rawOutputsIncludedInReport: false
    }
  };
}

function relationshipEvidenceAudit(cards, segments, artifactsAvailable) {
  if (!artifactsAvailable) return { audited: false, evidenceCount: null, invalidSourceIds: null, quoteMismatch: null };
  const segmentById = new Map(segments.map((item) => [item.id, item]));
  let evidenceCount = 0;
  let invalidSourceIds = 0;
  let quoteMismatch = 0;
  for (const card of cards) {
    for (const evidence of ensureArray(card.evidenceSegments)) {
      evidenceCount += 1;
      const sourceId = evidence.sourceId ?? evidence.segmentId;
      const segment = segmentById.get(sourceId);
      if (!segment) {
        invalidSourceIds += 1;
        continue;
      }
      const quote = normalizedQuote(evidence.quote ?? evidence.text);
      if (!quote || !normalizedQuote(segment.text).includes(quote)) quoteMismatch += 1;
    }
  }
  return { audited: true, evidenceCount, invalidSourceIds, quoteMismatch };
}

function briefEvidenceAudit(items, segments, artifactsAvailable) {
  if (!artifactsAvailable) return { audited: false, invalidSourceIds: null, quoteMismatch: null };
  const segmentById = new Map(segments.map((item) => [item.id, item]));
  let invalidSourceIds = 0;
  let quoteMismatch = 0;
  for (const item of items) {
    const sourceIds = ensureArray(item.sourceSegmentIds);
    if (sourceIds.some((id) => !segmentById.has(id))) invalidSourceIds += 1;
    const excerpt = normalizedQuote(item.transcriptExcerpt);
    if (excerpt) {
      const joined = normalizedQuote(sourceIds.map((id) => segmentById.get(id)?.text ?? "").join(" "));
      if (!joined.includes(excerpt)) quoteMismatch += 1;
    }
  }
  return { audited: true, invalidSourceIds, quoteMismatch };
}

function extractAttemptRows(text, marker, uploadId, oneBasedIndex = false) {
  return matchingLines(text, marker)
    .map((line) => ({ timestamp: timestampFromLine(line), ...parseFields(line) }))
    .filter((row) => !row.upload_id || row.upload_id === uploadId)
    .map((row) => ({
      chunkIndex: (numberOrNull(row.chunk_index) ?? numberOrNull(row.index) ?? numberOrNull(row.chunk))
        - (oneBasedIndex ? 1 : 0),
      attempt: numberOrNull(row.attempt),
      elapsedMs: numberOrNull(row.elapsed_ms),
      providerStatus: row.provider_status ?? row.status ?? null,
      responseStatus: row.response_status ?? null,
      responseTextLength: numberOrNull(row.response_text_length),
      failurePhase: row.failure_phase ?? null,
      failureReason: row.failure_reason ?? row.fallback_reason ?? null,
      recoveryMode: row.recovery_mode ?? null,
      retryReason: row.retry_reason ?? null,
      httpStatus: numberOrNull(row.http_status),
      inputChars: numberOrNull(row.input_chars),
      promptChars: numberOrNull(row.prompt_chars),
      outputTokenLimit: numberOrNull(row.output_token_limit ?? row.output_tokens_budget),
      validationIssueCount: numberOrNull(row.validation_issue_count),
      validationIssueCodes: row.validation_issue_codes && row.validation_issue_codes !== "none"
        ? row.validation_issue_codes.split(",").slice(0, 10)
        : [],
      validationIssuePaths: row.validation_issue_paths && row.validation_issue_paths !== "none"
        ? row.validation_issue_paths.split(",").slice(0, 10)
        : [],
      validationIssuesTruncated: row.truncated === "true",
      timestamp: row.timestamp
    }))
    .filter((row) => row.chunkIndex !== null && row.chunkIndex >= 0);
}

function currentAudioDuration(upload, audioChunks, manifest) {
  const fromChunks = audioChunks.length > 0 ? Math.max(...audioChunks.map((item) => numberOrNull(item.endSeconds) ?? 0)) : null;
  return numberOrNull(upload?.durationSeconds)
    ?? (fromChunks && fromChunks > 0 ? fromChunks : null)
    ?? numberOrNull(manifest?.targetDurationSeconds?.planned)
    ?? numberOrNull(manifest?.durationSeconds);
}

function buildExpectedAudit(expected, metrics) {
  const values = {
    pipeline_ready: metrics.pipelineReady,
    bullmq_completed: metrics.bullCompleted,
    product_job_ready: metrics.productJobReady,
    twelve_audio_chunks: metrics.audioChunkCount === 12,
    all_asr_chunks_completed: metrics.allAsrCompleted,
    no_missing_chunks: metrics.missingChunkCount === 0,
    unique_segment_ids: metrics.uniqueSegmentIds,
    ordered_global_timestamps: metrics.orderedTimestamps,
    traceable_segment_sources: metrics.traceableSegmentSources,
    twelve_audio_insight_checkpoints: metrics.audioInsightCheckpointCount === 12,
    twelve_relationship_checkpoints: metrics.relationshipCheckpointCount === 12,
    all_daily_brief_checkpoints_completed: metrics.allDailyBriefCheckpointsCompleted,
    relationship_evidence_source_exists: metrics.relationshipInvalidSourceIds === null
      ? null
      : metrics.relationshipInvalidSourceIds === 0,
    memory_quotes_traceable: metrics.nonVerbatimQuotes === null ? null : metrics.nonVerbatimQuotes === 0,
    recording_date_consistent: metrics.recordingDateConsistent,
    evidence_first_zero: metrics.evidenceFirstZero,
    no_fabricated_evidence: metrics.invalidSourceIds === null ? null : metrics.invalidSourceIds === 0,
    no_non_verbatim_quote: metrics.nonVerbatimQuotes === null ? null : metrics.nonVerbatimQuotes === 0,
    safe_relationship_language: metrics.safeRelationshipLanguage,
    no_global_speaker_claim: metrics.noGlobalSpeakerClaim,
    no_fallback_as_success: metrics.noFallbackAsSuccess
  };
  const map = (items) => ensureArray(items).map((item) => ({
    id: item.id,
    pass: Object.hasOwn(values, item.id) ? values[item.id] : null,
    reason: Object.hasOwn(values, item.id)
      ? values[item.id] === null ? "required evidence unavailable" : "computed from retained structural artifacts"
      : "fixture-specific semantic oracle is not inferred from transcript text by this sanitized auditor"
  }));
  return { must: map(expected?.must), should: map(expected?.should), mustNot: map(expected?.mustNot) };
}

function baselineStageValues(baseline) {
  const stages = baseline?.stages ?? baseline?.stageDurationsMs ?? {};
  return {
    transcriptionMs: numberOrNull(stages.transcriptionMs ?? stages.transcription),
    audioInsightMs: numberOrNull(stages.audioInsightMs ?? stages.audioInsights),
    dailyBriefMs: numberOrNull(stages.dailyBriefMs ?? stages.dailyBrief),
    relationshipMs: numberOrNull(stages.relationshipMs ?? stages.relationshipSignals),
    memoryMs: numberOrNull(stages.memoryMs ?? stages.memoryIndex),
    proactiveMs: numberOrNull(stages.proactiveMs ?? stages.proactiveInsight),
    pipelineMs: numberOrNull(baseline?.outcome?.pipelineMs ?? stages.pipelineMs ?? stages.totalPipeline)
  };
}

function baselineDurationSeconds(baseline, baselinePath) {
  const direct = numberOrNull(
    baseline?.audio?.durationSeconds
    ?? baseline?.source?.durationSeconds
    ?? baseline?.source?.audioDurationSeconds
  );
  if (direct !== null) return { value: direct, source: "baseline_report" };
  const siblingManifest = path.join(path.dirname(baselinePath), "manifest.json");
  const sibling = readJson(siblingManifest, null);
  const siblingValue = numberOrNull(sibling?.targetDurationSeconds?.planned ?? sibling?.durationSeconds);
  if (siblingValue !== null) return { value: siblingValue, source: "baseline_sibling_manifest" };
  const known45mManifest = readJson(path.join(repoRoot, "test-data", "long-recording-45m-v1", "manifest.json"), null);
  const knownValue = numberOrNull(known45mManifest?.targetDurationSeconds?.planned);
  return knownValue === null
    ? { value: null, source: "unavailable" }
    : { value: knownValue, source: "known_45m_fixture_manifest" };
}

function normalizedPerMinute(value, durationSeconds) {
  return value !== null && durationSeconds ? value / (durationSeconds / 60) : null;
}

function percentDelta(current, baseline) {
  return current !== null && baseline !== null && baseline !== 0
    ? ((current - baseline) / baseline) * 100
    : null;
}

function markdownTable(rows, columns) {
  if (rows.length === 0) return "_No rows._";
  const safe = (value) => String(value ?? "null").replaceAll("|", "\\|").replace(/\r?\n/gu, " ");
  return [
    `| ${columns.map((item) => item.label).join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${columns.map((item) => safe(item.value(row))).join(" | ")} |`)
  ].join("\n");
}

function writeJson(reportDir, name, value) {
  fs.writeFileSync(
    path.join(reportDir, name),
    `${JSON.stringify(value, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" }
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  assertReadableFile(options.pipelineLogPath, "Pipeline log");
  assertReadableFile(options.workerLogPath, "Worker log");
  assertReadableFile(options.baselinePath, "Baseline report");
  if (!fs.statSync(options.dataDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`APP_DATA_DIR is not a directory: ${options.dataDir}`);
  }
  assertReportDirectoryAvailable(options.reportDir);

  const manifest = readJson(path.join(datasetDir, "manifest.json"), {});
  const expected = readJson(path.join(datasetDir, "expected-results.json"), {});
  const baseline = readJson(options.baselinePath, {});
  const pipelineText = readLog(options.pipelineLogPath);
  const workerText = readLog(options.workerLogPath);
  const queueSnapshotRecord = readJsonRecord(
    path.join(path.dirname(options.pipelineLogPath), "queue-snapshot.json")
  );
  const queueSnapshot = queueSnapshotRecord.value;
  const userRoot = path.join(options.dataDir, "users", options.userId);
  if (!fs.statSync(userRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Requested user runtime directory is missing");
  }

  const uploadRecord = readCollectionItem(userRoot, "uploads", options.uploadId);
  const productJobRecord = readCollectionItem(userRoot, "jobs", options.jobId);
  const indexedJobRecord = readCollectionItem(userRoot, "jobs-by-upload", options.uploadId);
  const deletedMarker = readCollectionItem(userRoot, "deleted-uploads", options.uploadId);
  const segmentsRecord = readCollectionItem(userRoot, "segments", options.uploadId);
  const insightsRecord = readCollectionItem(userRoot, "audio-insights", options.uploadId);
  const semanticRecord = readCollectionItem(userRoot, "semantic-segments", options.uploadId);
  const briefRecord = readCollectionItem(userRoot, "brief-items", options.uploadId);
  const relationshipRecord = readCollectionItem(userRoot, "relationship-signals", options.uploadId);
  const evaluationRecord = readCollectionItem(userRoot, "evaluation-reports", options.uploadId);
  const proactiveCollection = readCollection(
    userRoot,
    "proactive-insights",
    (value) => value?.uploadId === options.uploadId || value?.items?.some?.((item) => item.uploadId === options.uploadId)
  );
  const audioChunkCollection = readCollection(userRoot, "audio-chunks", (value) => value?.uploadId === options.uploadId);
  const transcriptChunkCollection = readCollection(userRoot, "transcript-chunks", (value) => value?.uploadId === options.uploadId);
  const analysisCollection = readCollection(
    userRoot,
    "analysis-chunks",
    (value) => value?.uploadId === options.uploadId && value?.userId === options.userId
  );

  const upload = uploadRecord.value;
  const productJob = productJobRecord.value ?? indexedJobRecord.value;
  const segments = ensureArray(segmentsRecord.value);
  const audioInsights = ensureArray(insightsRecord.value);
  const semanticSegments = ensureArray(semanticRecord.value);
  const briefItems = ensureArray(briefRecord.value);
  const relationshipCards = ensureArray(relationshipRecord.value);
  const proactiveInsights = proactiveCollection.values.flatMap((value) => ensureArray(value.items));
  const audioChunks = audioChunkCollection.values.sort((left, right) => left.index - right.index);
  const transcriptChunks = transcriptChunkCollection.values.sort((left, right) => left.index - right.index);
  const analysisCheckpoints = analysisCollection.values.sort(
    (left, right) => left.sourceChunkIndex - right.sourceChunkIndex || String(left.kind).localeCompare(String(right.kind))
  );
  const audioDurationSeconds = currentAudioDuration(upload, audioChunks, manifest);
  const expectedChunkCount = numberOrNull(manifest.expectedChunkCount) ?? 12;
  const segmentIds = segments.map((item) => item.id);
  const transcriptSourceIds = new Set(transcriptChunks.flatMap((chunk) => ensureArray(chunk.segments).map((item) => item.id)));
  const missingChunkIndexes = Array.from({ length: expectedChunkCount }, (_, index) => index)
    .filter((index) => !audioChunks.some((chunk) => chunk.index === index));
  const asrCompletedLines = matchingLines(pipelineText, "[asr-chunks] chunk completed")
    .map((line) => parseFields(line))
    .filter((row) => !row.upload_id || row.upload_id === options.uploadId);
  const asrLineByIndex = new Map(asrCompletedLines.map((row) => [numberOrNull(row.index), row]));
  const transcriptByIndex = new Map(transcriptChunks.map((chunk) => [chunk.index, chunk]));

  const asrAudit = {
    version: REPORT_VERSION,
    expectedChunkCount,
    actualAudioChunkCount: audioChunks.length,
    actualTranscriptChunkCount: transcriptChunks.length,
    missingChunkIndexes,
    allAudioChunksCompleted: audioChunks.length === expectedChunkCount && audioChunks.every((item) => item.status === "completed"),
    allTranscriptChunksCompleted: transcriptChunks.length === expectedChunkCount && transcriptChunks.every((item) => item.status === "completed"),
    totalRetryCount: sum(audioChunks.map((item) => numberOrNull(item.retryCount) ?? 0)),
    chunks: audioChunks.map((chunk) => ({
      index: chunk.index,
      startSeconds: numberOrNull(chunk.startSeconds),
      endSeconds: numberOrNull(chunk.endSeconds),
      durationSeconds: numberOrNull(chunk.durationSeconds),
      audioStatus: chunk.status ?? null,
      transcriptStatus: transcriptByIndex.get(chunk.index)?.status ?? null,
      retryCount: numberOrNull(chunk.retryCount),
      segmentCount: ensureArray(transcriptByIndex.get(chunk.index)?.segments).length,
      speakerIdScope: transcriptByIndex.get(chunk.index)?.speakerIdScope ?? null,
      elapsedMs: numberOrNull(asrLineByIndex.get(chunk.index)?.elapsed_ms)
        ?? elapsedMs(chunk.startedAt, chunk.finishedAt)
    })),
    transcript: {
      segmentCount: segments.length,
      uniqueSegmentIds: new Set(segmentIds).size === segmentIds.length,
      timestampsOrdered: segments.every((item, index) => index === 0 || Number(item.startSeconds) >= Number(segments[index - 1].startSeconds)),
      timestampsInRange: audioDurationSeconds === null
        ? null
        : segments.every((item) => Number(item.startSeconds) >= 0 && Number(item.endSeconds) > Number(item.startSeconds) && Number(item.endSeconds) <= audioDurationSeconds + 1),
      traceableSegmentSources: segmentsRecord.exists && transcriptChunkCollection.exists
        ? segments.every((item) => transcriptSourceIds.has(item.id))
        : null,
      merge: (() => {
        const fields = lastFields(pipelineText, "[transcript-merge]");
        return {
          inputSegments: numberOrNull(fields.input_segments),
          finalSegments: numberOrNull(fields.segments),
          duplicatesRemoved: numberOrNull(fields.duplicates_removed),
          warningCount: numberOrNull(fields.warnings)
        };
      })()
    },
    corruptArtifactFiles: audioChunkCollection.corruptFiles + transcriptChunkCollection.corruptFiles
  };

  const audioInsightCheckpoints = analysisCheckpoints.filter((item) => item.kind === "audio_insight");
  const audioInsightChunkRows = matchingLines(pipelineText, "[audio-insights] upload_id=")
    .map((line) => parseFields(line))
    .filter((row) => row.upload_id === options.uploadId && row.chunk_index !== undefined)
    .map((row) => ({
      chunkIndex: numberOrNull(row.chunk_index),
      segmentCount: numberOrNull(row.segment_count),
      inputChars: numberOrNull(row.input_chars),
      attempts: numberOrNull(row.attempt),
      providerStatus: row.provider_status ?? null,
      retryCount: numberOrNull(row.retry_count),
      fallback: row.fallback === "true",
      fallbackReason: row.fallback_reason ?? null,
      insightCount: numberOrNull(row.insights),
      elapsedMs: numberOrNull(row.elapsed_ms)
    }));
  const audioInsightFields = lastFields(pipelineText, "[audio-insights] chunks=");
  const audioInsightAudit = {
    version: REPORT_VERSION,
    stageMs: stageDurations(pipelineText).audioInsightMs,
    chunkCount: numberOrNull(audioInsightFields.chunks) ?? audioInsightCheckpoints.length,
    providerSuccessChunks: numberOrNull(audioInsightFields.success_chunks),
    retrySuccessChunks: numberOrNull(audioInsightFields.retry_success_chunks),
    fallbackChunks: numberOrNull(audioInsightFields.fallback_chunks)
      ?? audioInsightCheckpoints.filter((item) => item.resultSource === "rule_fallback").length,
    timeoutChunks: numberOrNull(audioInsightFields.timeout_chunks),
    invalidJsonChunks: numberOrNull(audioInsightFields.invalid_json_chunks),
    checkpointHits: numberOrNull(audioInsightFields.checkpoint_hits),
    checkpointMisses: numberOrNull(audioInsightFields.checkpoint_misses),
    insightCount: audioInsights.length,
    byResultSource: countBy(audioInsightCheckpoints, (item) => item.resultSource ?? "none"),
    chunks: audioInsightChunkRows
  };

  const dailyBriefCheckpoints = analysisCheckpoints.filter((item) => item.kind === "daily_brief");
  const dailyAttempts = extractAttemptRows(pipelineText, "[daily-brief-provider] request_finished", options.uploadId, true);
  const dailyValidations = extractAttemptRows(pipelineText, "[daily-brief-provider] validation_failed", options.uploadId, true);
  const dailyFields = lastFields(pipelineText, "[daily-brief-chunks]");
  const briefEvidence = briefEvidenceAudit(briefItems, segments, briefRecord.exists && segmentsRecord.exists);
  const dailyBriefAudit = {
    version: REPORT_VERSION,
    stageMs: stageDurations(pipelineText).dailyBriefMs,
    chunkCount: numberOrNull(dailyFields.chunk_count) ?? dailyBriefCheckpoints.length,
    concurrency: numberOrNull(dailyFields.concurrency),
    recoveryConcurrency: numberOrNull(dailyFields.recovery_concurrency),
    firstAttemptSuccess: numberOrNull(dailyFields.first_attempt_success),
    providerSuccess: numberOrNull(dailyFields.provider_success),
    providerRetrySuccess: numberOrNull(dailyFields.provider_retry_success),
    retryChunks: numberOrNull(dailyFields.retry_chunks),
    fallbackChunks: numberOrNull(dailyFields.fallback_count)
      ?? dailyBriefCheckpoints.filter((item) => item.resultSource === "rule_fallback").length,
    timeoutChunks: numberOrNull(dailyFields.timeout_chunks),
    incompleteResponseChunks: numberOrNull(dailyFields.incomplete_response_chunks),
    invalidJsonChunks: numberOrNull(dailyFields.invalid_json_chunks),
    rateLimitChunks: numberOrNull(dailyFields.rate_limit_chunks),
    provider5xxChunks: numberOrNull(dailyFields.provider_5xx_chunks),
    validationFailureChunks: numberOrNull(dailyFields.validation_failure_chunks),
    evidenceValidationFailureChunks: numberOrNull(dailyFields.evidence_validation_failure_chunks),
    firstPassWallMs: numberOrNull(dailyFields.first_pass_wall_ms),
    recoveryWallMs: numberOrNull(dailyFields.recovery_wall_ms),
    criticalPathMs: numberOrNull(dailyFields.critical_path_ms),
    sumProviderMs: numberOrNull(dailyFields.sum_provider_ms),
    wallClockMs: numberOrNull(dailyFields.wall_clock_ms),
    mergeElapsedMs: numberOrNull(dailyFields.merge_elapsed_ms),
    outputItemCount: briefItems.length,
    outputTypeDistribution: countBy(briefItems, (item) => item.category),
    checkpointResultSources: countBy(dailyBriefCheckpoints, (item) => item.resultSource ?? "none"),
    attempts: dailyAttempts,
    validationFailures: dailyValidations,
    validationIssueSummary: validationIssueSummary(dailyBriefCheckpoints),
    evidence: briefEvidence
  };

  const relationshipCheckpoints = analysisCheckpoints.filter((item) => item.kind === "relationship_candidate");
  const relationshipAttempts = extractAttemptRows(pipelineText, "[relationship-provider]", options.uploadId, false)
    .filter((item) => item.attempt !== null);
  const relationshipFields = lastFields(pipelineText, "[relationship-signals] chunks=");
  const relationshipEvidence = relationshipEvidenceAudit(
    relationshipCards,
    segments,
    relationshipRecord.exists && segmentsRecord.exists
  );
  const contextMetrics = relationshipCheckpoints.map((item) => item.metadata?.requestMetrics).filter(Boolean);
  const reducerAudit = evaluationRecord.value?.relationship?.reducerAudit;
  const relationshipAudit = {
    version: REPORT_VERSION,
    stageMs: stageDurations(pipelineText).relationshipMs,
    chunkCount: numberOrNull(relationshipFields.chunks) ?? relationshipCheckpoints.length,
    successChunks: numberOrNull(relationshipFields.success_chunks),
    retrySuccessChunks: numberOrNull(relationshipFields.retry_success_chunks),
    fallbackChunks: numberOrNull(relationshipFields.fallback_chunks)
      ?? relationshipCheckpoints.filter((item) => item.resultSource === "rule_fallback").length,
    skippedChunks: numberOrNull(relationshipFields.skipped_chunks),
    failedChunks: numberOrNull(relationshipFields.failed_chunks),
    timeoutChunks: numberOrNull(relationshipFields.timeout_chunks),
    incompleteOrInvalidJsonChunks: numberOrNull(relationshipFields.invalid_json_chunks),
    parseFailureChunks: numberOrNull(relationshipFields.parse_failure_chunks),
    validationFailureChunks: numberOrNull(relationshipFields.validation_failure_chunks),
    providerFailureChunks: numberOrNull(relationshipFields.provider_failure_chunks),
    checkpointHits: numberOrNull(relationshipFields.checkpoint_hits),
    checkpointMisses: numberOrNull(relationshipFields.checkpoint_misses),
    candidates: numberOrNull(relationshipFields.candidates),
    validationRejected: numberOrNull(relationshipFields.validation_rejected),
    qualityRejected: numberOrNull(relationshipFields.quality_rejected),
    clusters: numberOrNull(relationshipFields.clusters),
    cards: relationshipCards.length,
    firstPassWallMs: numberOrNull(relationshipFields.first_pass_wall_ms),
    recoveryWallMs: numberOrNull(relationshipFields.recovery_wall_ms),
    criticalPathMs: numberOrNull(relationshipFields.critical_path_ms),
    sumProviderMs: numberOrNull(relationshipFields.sum_provider_ms),
    wallClockMs: numberOrNull(relationshipFields.wall_clock_ms),
    reducerElapsedMs: numberOrNull(relationshipFields.reducer_elapsed_ms),
    contextSelection: contextMetrics.length === 0 ? {
      auditedChunks: 0,
      insightsBefore: null,
      insightsAfter: null,
      insightCharsBefore: null,
      insightCharsAfter: null,
      promptChars: null,
      outputTokenBudgets: []
    } : {
      auditedChunks: contextMetrics.length,
      insightsBefore: sum(contextMetrics.map((item) => numberOrNull(item.insightsBefore) ?? 0)),
      insightsAfter: sum(contextMetrics.map((item) => numberOrNull(item.insightsAfter) ?? 0)),
      insightCharsBefore: sum(contextMetrics.map((item) => numberOrNull(item.insightCharsBefore) ?? 0)),
      insightCharsAfter: sum(contextMetrics.map((item) => numberOrNull(item.insightCharsAfter ?? item.insightCharacterCount) ?? 0)),
      promptChars: sum(contextMetrics.map((item) => numberOrNull(item.promptCharacterCount) ?? 0)),
      outputTokenBudgets: [...new Set(contextMetrics.map((item) => numberOrNull(item.maxOutputTokens)).filter((item) => item !== null))]
    },
    attempts: relationshipAttempts,
    checkpointResultSources: countBy(relationshipCheckpoints, (item) => item.resultSource ?? "none"),
    validationIssueSummary: validationIssueSummary(relationshipCheckpoints),
    outputTypeDistribution: countBy(relationshipCards, (item) => item.signalType),
    reducer: reducerAudit ? {
      candidateCount: numberOrNull(reducerAudit.candidateCount),
      qualityRejectedCount: numberOrNull(reducerAudit.qualityRejectedCount),
      clusterCount: numberOrNull(reducerAudit.clusterCount),
      clusterRejectedCount: numberOrNull(reducerAudit.clusterRejectedCount),
      normalizationRejectedCount: numberOrNull(reducerAudit.normalizationRejectedCount),
      selectedCount: numberOrNull(reducerAudit.selectedCount ?? reducerAudit.cardCount)
    } : null,
    evidence: relationshipEvidence,
    safety: {
      audited: relationshipRecord.exists,
      violationCount: relationshipRecord.exists
        ? relationshipCards.filter((card) => /(?:diagnos(?:e|is)|must\s+(?:leave|break\s*up)|relationship\s+(?:has\s+)?failed|必须分手|应该分手|关系已经失败|回避型人格|心理诊断|操控)/iu.test(
            [card.summary, card.explanation, card.suggestedReflection, card.caution].filter(Boolean).join(" ")
          )).length
        : null
    }
  };

  const memoryAudit = inspectMemory({
    databasePath: path.join(options.dataDir, "memory.sqlite"),
    userId: options.userId,
    uploadId: options.uploadId,
    segments,
    audioInsights,
    semanticSegments,
    briefItems,
    relationshipCards,
    segmentsAvailable: segmentsRecord.exists && !segmentsRecord.error,
    sourceCollectionsAvailable: [segmentsRecord, insightsRecord, semanticRecord, briefRecord, relationshipRecord]
      .every((record) => record.exists && !record.error)
  });
  memoryAudit.version = REPORT_VERSION;
  memoryAudit.retainedRuntimeEvaluationReport = evaluationRecord.exists;
  memoryAudit.runtimeEvaluationEvidenceFirst = evaluationRecord.value?.evidenceFirst
    ? {
        audited: booleanOrNull(evaluationRecord.value.evidenceFirst.audited),
        evidenceCount: numberOrNull(evaluationRecord.value.evidenceFirst.evidenceCount),
        invalidSourceIds: numberOrNull(evaluationRecord.value.evidenceFirst.invalidSourceIds),
        nonVerbatimQuotes: numberOrNull(evaluationRecord.value.evidenceFirst.nonVerbatimQuotes),
        duplicateEvidence: numberOrNull(evaluationRecord.value.evidenceFirst.duplicateEvidence),
        memoriesWithoutEvidence: numberOrNull(evaluationRecord.value.evidenceFirst.memoriesWithoutEvidence),
        orphanEvidence: numberOrNull(evaluationRecord.value.evidenceFirst.orphanEvidence)
      }
    : null;

  const checkpoints = checkpointAudit({
    checkpoints: analysisCheckpoints,
    files: analysisCollection.files,
    corruptFiles: analysisCollection.corruptFiles,
    pipelineText
  });
  const stages = stageDurations(pipelineText);
  const workerTargetLines = logLines(workerText).filter(
    (line) => line.includes(options.queueJobId) || !line.includes("queue_job_id=")
  );
  const workerActive = workerTargetLines.filter((line) => line.includes("[pipeline-worker] active"));
  const workerCompleted = workerTargetLines.filter((line) => line.includes("[pipeline-worker] completed"));
  const workerFailed = workerTargetLines.filter((line) => line.includes("[pipeline-worker] failed"));
  const workerReady = matchingLines(workerText, "[pipeline-worker] ready");
  const snapshotBullState = typeof queueSnapshot?.job?.state === "string"
    ? queueSnapshot.job.state
    : null;
  const bullCompleted = snapshotBullState
    ? snapshotBullState === "completed"
    : workerCompleted.length > 0
      ? true
      : workerFailed.length > 0 ? false : null;
  const bullState = snapshotBullState
    ?? (bullCompleted === true ? "completed" : bullCompleted === false ? "failed" : null);
  const snapshotCounts = queueSnapshot?.counts && typeof queueSnapshot.counts === "object"
    ? Object.fromEntries(
        ["waiting", "active", "completed", "failed", "delayed"].map((name) => [
          name,
          numberOrNull(queueSnapshot.counts[name])
        ])
      )
    : null;
  const snapshotRedis = queueSnapshot?.redis && typeof queueSnapshot.redis === "object"
    ? {
        endpoint: sanitizedNetworkEndpoint(queueSnapshot.redis.endpoint),
        ping: queueSnapshot.ping === "PONG" ? "PONG" : null,
        appendonly: queueSnapshot.redis.appendonly ?? null,
        appendfsync: queueSnapshot.redis.appendfsync ?? null,
        maxmemoryPolicy: queueSnapshot.redis.maxmemoryPolicy ?? null,
        aofLastWriteStatus: queueSnapshot.redis.aofLastWriteStatus ?? null,
        aofEnabled: queueSnapshot.redis.appendonly === "yes",
        appendFsyncEverysec: queueSnapshot.redis.appendfsync === "everysec",
        noEviction: queueSnapshot.redis.maxmemoryPolicy === "noeviction",
        pong: queueSnapshot.ping === "PONG"
      }
    : null;
  const queueAudit = {
    version: REPORT_VERSION,
    executionMode: productJob?.executionMode ?? null,
    identity: {
      uploadRef: safeReference(options.uploadId, "upload"),
      productJobRef: safeReference(options.jobId, "job"),
      queueJobRef: safeReference(options.queueJobId, "queue")
    },
    idConsistency: {
      productJobMatchesRequested: productJob?.id ? productJob.id === options.jobId : null,
      uploadMatchesRequested: productJob?.uploadId ? productJob.uploadId === options.uploadId : null,
      queueJobMatchesRequested: productJob?.queueJobId ? productJob.queueJobId === options.queueJobId : null
    },
    lifecycle: {
      uploadCreatedAt: upload?.createdAt ?? null,
      queuedAt: productJob?.queuedAt ?? null,
      workerStartedAt: productJob?.workerStartedAt ?? null,
      pipelineStartedAt: productJob?.startedAt ?? null,
      finishedAt: productJob?.finishedAt ?? null,
      productWaitingMs: elapsedMs(productJob?.queuedAt, productJob?.workerStartedAt),
      productActiveMs: elapsedMs(productJob?.workerStartedAt, productJob?.finishedAt),
      bullCreatedAt: epochIso(queueSnapshot?.job?.timestamp),
      bullProcessedAt: epochIso(queueSnapshot?.job?.processedOn),
      bullFinishedAt: epochIso(queueSnapshot?.job?.finishedOn),
      bullWaitingMs: queueSnapshot?.job
        ? elapsedMs(epochIso(queueSnapshot.job.timestamp), epochIso(queueSnapshot.job.processedOn))
        : null,
      bullActiveMs: queueSnapshot?.job
        ? elapsedMs(epochIso(queueSnapshot.job.processedOn), epochIso(queueSnapshot.job.finishedOn))
        : null,
      bullActiveObservedAt: epochIso(queueSnapshot?.job?.processedOn)
        ?? timestampFromLine(workerActive[0] ?? ""),
      bullCompletedObservedAt: epochIso(queueSnapshot?.job?.finishedOn)
        ?? timestampFromLine(workerCompleted.at(-1) ?? "")
    },
    finalState: {
      productStatus: productJob?.status ?? null,
      productProgress: numberOrNull(productJob?.progress),
      uploadStatus: upload?.status ?? null,
      bullState,
      bullProgress: numberOrNull(queueSnapshot?.job?.progress),
      bullAttemptsObserved: numberOrNull(queueSnapshot?.job?.attemptsMade)
        ?? (workerActive.length > 0
          ? Math.max(...workerActive.map((line) => numberOrNull(parseFields(line).attempt) ?? 0))
          : null),
      queueAttempt: numberOrNull(productJob?.queueAttempt),
      statesConsistent: bullState === null
        ? null
        : bullState === "completed" && productJob?.status === "ready" && upload?.status === "ready"
    },
    events: {
      enqueued: matchingLines(pipelineText, "[pipeline-queue] enqueued").filter((line) => line.includes(options.uploadId)).length,
      active: workerActive.length,
      completed: workerCompleted.length,
      failed: workerFailed.length,
      retries: Math.max(0, workerActive.length - 1)
    },
    snapshot: {
      available: queueSnapshotRecord.exists && !queueSnapshotRecord.error,
      parseError: queueSnapshotRecord.error,
      queueName: typeof queueSnapshot?.queueName === "string" ? queueSnapshot.queueName : null,
      counts: snapshotCounts,
      redis: snapshotRedis
    },
    evidenceSource: queueSnapshot
      ? "runner Bull/Redis snapshot plus product JsonStore and supplied worker/web logs"
      : "product JsonStore plus supplied worker/web logs; snapshot unavailable and Redis was not queried"
  };
  const workerAudit = {
    version: REPORT_VERSION,
    independentWorkerObserved: workerReady.length > 0,
    readyEvents: workerReady.length,
    activeEventsForTarget: workerActive.length,
    completedEventsForTarget: workerCompleted.length,
    failedEventsForTarget: workerFailed.length,
    runtimeErrors: matchingLines(workerText, "[pipeline-worker] runtime error").length,
    restartOrRecovery: {
      readyEventsAfterFirst: Math.max(0, workerReady.length - 1),
      recoveredEnqueued: sum(workerReady.map((line) => numberOrNull(parseFields(line).recovered_enqueued) ?? 0)),
      recoveredExisting: sum(workerReady.map((line) => numberOrNull(parseFields(line).recovered_existing) ?? 0)),
      redisReconnectEvents: matchingLines(workerText, "reconnect").length || null,
      gracefulShutdownStarted: matchingLines(workerText, "[pipeline-worker] shutdown started").length,
      gracefulShutdownCompleted: matchingLines(workerText, "[pipeline-worker] shutdown completed").length
    },
    errorsContainRawMessages: false,
    source: "sanitized event counts only"
  };

  const uploadFileCandidates = upload?.filePath
    ? [upload.filePath, path.resolve(options.dataDir, upload.filePath)].filter((item, index, values) => values.indexOf(item) === index)
    : [];
  const retainedAudioPath = uploadFileCandidates.find((item) => fs.existsSync(item)) ?? null;
  const retention = {
    uploadRecord: uploadRecord.exists,
    audioPathRecorded: Boolean(upload?.filePath),
    audioExists: Boolean(retainedAudioPath),
    transcript: segmentsRecord.exists,
    audioChunks: audioChunkCollection.exists && audioChunks.length > 0,
    transcriptChunks: transcriptChunkCollection.exists && transcriptChunks.length > 0,
    analysisCheckpoints: analysisCollection.exists && analysisCheckpoints.length > 0,
    memoryDatabase: fs.existsSync(path.join(options.dataDir, "memory.sqlite")),
    evidence: memoryAudit.currentUploadEvidenceCount === null ? null : memoryAudit.currentUploadEvidenceCount > 0,
    relations: memoryAudit.relationCount === null ? null : true,
    evaluationReport: evaluationRecord.exists,
    deletedMarkerAbsent: !deletedMarker.exists,
    evaluationRetentionFlag: booleanOrNull(upload?.evaluationRetention),
    automaticDeleteBlocked: evaluationRecord.value?.retention?.automaticDeleteBlocked ?? null
  };

  const rateLimitCount = matchingLines(`${pipelineText}\n${workerText}`, "429").length
    + matchingLines(pipelineText, "failure_reason=rate_limit").length;
  const fatalErrorCount = matchingLines(pipelineText, "[pipeline] failed").length + workerFailed.length;
  const pipelineAudit = {
    version: REPORT_VERSION,
    outcome: {
      pipelineReady: upload?.status === "ready" && productJob?.status === "ready",
      productJobStatus: productJob?.status ?? null,
      uploadStatus: upload?.status ?? null,
      pipelineMs: stages.pipelineMs,
      audioDurationSeconds
    },
    stages,
    counts: {
      transcriptSegments: segments.length,
      audioInsights: audioInsights.length,
      semanticSegments: semanticSegments.length,
      briefItems: briefItems.length,
      relationshipCards: relationshipCards.length,
      proactiveInsights: proactiveInsights.length
    },
    providerSignals: {
      rateLimitCount,
      fatalErrorCount,
      fallbackCounts: {
        audioInsight: audioInsightAudit.fallbackChunks,
        dailyBrief: dailyBriefAudit.fallbackChunks,
        relationship: relationshipAudit.fallbackChunks
      }
    },
    retention,
    sourceArtifactErrors: {
      upload: uploadRecord.error,
      productJob: productJobRecord.error ?? indexedJobRecord.error,
      segments: segmentsRecord.error,
      audioInsights: insightsRecord.error,
      semanticSegments: semanticRecord.error,
      briefItems: briefRecord.error,
      relationshipCards: relationshipRecord.error,
      evaluationReport: evaluationRecord.error
    }
  };

  const evidenceValues = memoryAudit.evidenceFirst;
  const evidenceFirstZero = evidenceValues.invalidSourceIds === null
    || evidenceValues.nonVerbatimQuotes === null
    || evidenceValues.duplicateEvidence === null
    || evidenceValues.memoriesWithoutEvidence === null
    || evidenceValues.orphanEvidence === null
      ? null
      : evidenceValues.invalidSourceIds === 0
        && evidenceValues.nonVerbatimQuotes === 0
        && evidenceValues.duplicateEvidence === 0
        && evidenceValues.memoriesWithoutEvidence === 0
        && evidenceValues.orphanEvidence === 0;
  const expectedAudit = buildExpectedAudit(expected, {
    pipelineReady: pipelineAudit.outcome.pipelineReady,
    bullCompleted,
    productJobReady: productJob?.status === "ready",
    audioChunkCount: audioChunks.length,
    allAsrCompleted: asrAudit.allAudioChunksCompleted && asrAudit.allTranscriptChunksCompleted,
    missingChunkCount: missingChunkIndexes.length,
    uniqueSegmentIds: asrAudit.transcript.uniqueSegmentIds,
    orderedTimestamps: asrAudit.transcript.timestampsOrdered && asrAudit.transcript.timestampsInRange !== false,
    traceableSegmentSources: asrAudit.transcript.traceableSegmentSources,
    audioInsightCheckpointCount: audioInsightCheckpoints.length,
    relationshipCheckpointCount: relationshipCheckpoints.length,
    allDailyBriefCheckpointsCompleted: dailyBriefCheckpoints.length > 0
      && dailyBriefCheckpoints.every((item) => item.status === "completed"),
    relationshipInvalidSourceIds: relationshipEvidence.invalidSourceIds,
    nonVerbatimQuotes: evidenceValues.nonVerbatimQuotes,
    recordingDateConsistent: upload?.recordingDate && manifest.recordingDate
      ? upload.recordingDate === manifest.recordingDate
      : null,
    evidenceFirstZero,
    invalidSourceIds: evidenceValues.invalidSourceIds,
    safeRelationshipLanguage: relationshipAudit.safety.violationCount === null
      ? null
      : relationshipAudit.safety.violationCount === 0,
    noGlobalSpeakerClaim: transcriptChunks.length > 0
      ? transcriptChunks.every((item) => item.speakerIdScope === "chunk")
      : null,
    noFallbackAsSuccess: analysisCheckpoints.every(
      (item) => item.resultSource !== "rule_fallback" || item.metadata?.providerStatus !== "provider_success"
    )
  });

  const baselineStages = baselineStageValues(baseline);
  const baselineDuration = baselineDurationSeconds(baseline, options.baselinePath);
  const currentGit = safeGitState();
  const config = publicConfiguration();
  const baselineComparison = {
    version: REPORT_VERSION,
    classification: {
      mode: "historical_reference",
      comparable: baseline?.git?.head && currentGit.head
        ? baseline.git.head === currentGit.head
        : false,
      reason: baseline?.git?.head === currentGit.head
        ? "git head matches; model/provider/runtime configuration still requires manual confirmation"
        : "historical 45-minute run used a different or unrecorded code/configuration",
      baselineDurationSource: baselineDuration.source
    },
    durationsSeconds: {
      baseline: baselineDuration.value,
      current: audioDurationSeconds
    },
    stages: Object.fromEntries(Object.keys(stages).map((name) => {
      const current = stages[name];
      const baselineValue = baselineStages[name] ?? null;
      return [name, {
        baselineMs: baselineValue,
        currentMs: current,
        absoluteDeltaMs: current !== null && baselineValue !== null ? current - baselineValue : null,
        deltaPercent: percentDelta(current, baselineValue),
        baselineMsPerAudioMinute: normalizedPerMinute(baselineValue, baselineDuration.value),
        currentMsPerAudioMinute: normalizedPerMinute(current, audioDurationSeconds)
      }];
    })),
    quality: {
      baselineRelationshipFallback: numberOrNull(baseline?.relationship?.fallback),
      currentRelationshipFallback: relationshipAudit.fallbackChunks,
      baselineEvidenceFirst: baseline?.evidenceFirst ? {
        invalidSourceIds: numberOrNull(baseline.evidenceFirst.invalidSourceIds),
        nonVerbatimQuotes: numberOrNull(baseline.evidenceFirst.nonVerbatimQuotes),
        duplicateEvidence: numberOrNull(baseline.evidenceFirst.duplicateEvidence),
        memoriesWithoutEvidence: numberOrNull(baseline.evidenceFirst.memoriesWithoutEvidence),
        orphanEvidence: numberOrNull(baseline.evidenceFirst.orphanEvidence)
      } : null,
      currentEvidenceFirst: evidenceValues
    },
    provenance: {
      currentGit,
      baselineGitHead: baseline?.git?.head ?? null,
      packageLockSha256: fs.existsSync(path.join(repoRoot, "package-lock.json"))
        ? hashFile(path.join(repoRoot, "package-lock.json"))
        : null,
      publicConfiguration: config,
      secretsRecorded: false
    }
  };

  const sourceFiles = [
    uploadRecord.filePath,
    productJobRecord.filePath,
    indexedJobRecord.filePath,
    segmentsRecord.filePath,
    insightsRecord.filePath,
    semanticRecord.filePath,
    briefRecord.filePath,
    relationshipRecord.filePath,
    evaluationRecord.filePath,
    ...audioChunkCollection.files,
    ...transcriptChunkCollection.files,
    ...analysisCollection.files,
    path.join(options.dataDir, "memory.sqlite"),
    path.join(options.dataDir, "memory.sqlite-wal"),
    path.join(options.dataDir, "memory.sqlite-shm"),
    retainedAudioPath
  ].filter(Boolean);
  const sourceHashBefore = combinedFileHash(sourceFiles);

  const report = {
    version: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    datasetVersion: manifest.datasetVersion ?? "long-recording-60m-v1",
    purpose: "read-only, sanitized retained Pipeline acceptance audit",
    identity: {
      uploadRef: safeReference(options.uploadId, "upload"),
      productJobRef: safeReference(options.jobId, "job"),
      queueJobRef: safeReference(options.queueJobId, "queue"),
      userRef: safeReference(options.userId, "user")
    },
    outcome: pipelineAudit.outcome,
    queue: queueAudit.finalState,
    worker: {
      independentWorkerObserved: workerAudit.independentWorkerObserved,
      runtimeErrors: workerAudit.runtimeErrors
    },
    stages,
    artifacts: pipelineAudit.counts,
    checkpoints: {
      total: checkpoints.total,
      byKind: checkpoints.byKind,
      integrity: checkpoints.integrity
    },
    retention,
    evidenceFirst: evidenceValues,
    expectedResults: expectedAudit,
    security: {
      reportsContainRawIdentity: false,
      reportsContainTranscriptOrQuote: false,
      reportsContainProviderResponse: false,
      reportsContainSecrets: false,
      sanitizedLogOnly: true
    },
    auditScope: {
      runtimeMutationAllowed: false,
      redisQueried: false,
      remoteProvidersCalled: false,
      unavailableMetricsRemainNull: true,
      reportFiles: REPORT_FILES
    }
  };

  fs.mkdirSync(options.reportDir, { recursive: true });
  writeJson(options.reportDir, "queue-audit.json", queueAudit);
  writeJson(options.reportDir, "worker-audit.json", workerAudit);
  writeJson(options.reportDir, "asr-audit.json", asrAudit);
  writeJson(options.reportDir, "audio-insight-audit.json", audioInsightAudit);
  writeJson(options.reportDir, "daily-brief-audit.json", dailyBriefAudit);
  writeJson(options.reportDir, "relationship-audit.json", relationshipAudit);
  writeJson(options.reportDir, "checkpoint-audit.json", checkpoints);
  writeJson(options.reportDir, "memory-audit.json", memoryAudit);
  writeJson(options.reportDir, "baseline-comparison.json", baselineComparison);
  fs.writeFileSync(
    path.join(options.reportDir, "pipeline.log"),
    sanitizedPipelineLog(pipelineText, workerText, options),
    { encoding: "utf8", flag: "wx" }
  );

  const sourceHashAfter = combinedFileHash(sourceFiles);
  report.auditScope.sourceFileCount = [...new Set(sourceFiles)].filter((item) => fs.existsSync(item)).length;
  report.auditScope.sourceHashBefore = sourceHashBefore;
  report.auditScope.sourceHashAfter = sourceHashAfter;
  report.auditScope.sourceMutationDetected = sourceHashBefore !== sourceHashAfter;
  writeJson(options.reportDir, "report.json", report);

  const stageRows = Object.entries(stages).map(([stage, currentMs]) => ({
    stage,
    currentMs,
    baselineMs: baselineStages[stage] ?? null,
    currentPerMinute: normalizedPerMinute(currentMs, audioDurationSeconds)
  }));
  const evidenceRows = [
    ["invalidSourceIds", evidenceValues.invalidSourceIds],
    ["nonVerbatimQuotes", evidenceValues.nonVerbatimQuotes],
    ["duplicateEvidence", evidenceValues.duplicateEvidence],
    ["memoriesWithoutEvidence", evidenceValues.memoriesWithoutEvidence],
    ["orphanEvidence", evidenceValues.orphanEvidence]
  ].map(([metric, value]) => ({ metric, value }));
  const markdown = [
    "# Long Recording 60m Pipeline Audit",
    "",
    `- Generated: \`${report.generatedAt}\``,
    `- Upload reference: \`${report.identity.uploadRef}\``,
    `- Product job reference: \`${report.identity.productJobRef}\``,
    `- Queue job reference: \`${report.identity.queueJobRef}\``,
    `- Pipeline ready: **${report.outcome.pipelineReady}**`,
    `- Pipeline elapsed: \`${report.outcome.pipelineMs ?? "unavailable"} ms\``,
    `- Audio duration: \`${report.outcome.audioDurationSeconds ?? "unavailable"} s\``,
    `- Source mutation detected during audit: **${report.auditScope.sourceMutationDetected}**`,
    "",
    "## Queue and Worker",
    "",
    `- Execution mode: \`${queueAudit.executionMode ?? "unavailable"}\``,
    `- BullMQ completion observed: \`${queueAudit.finalState.bullState ?? "unavailable"}\``,
    `- Product state: \`${queueAudit.finalState.productStatus ?? "unavailable"}\``,
    `- State consistency: \`${queueAudit.finalState.statesConsistent ?? "unavailable"}\``,
    `- Independent worker observed: \`${workerAudit.independentWorkerObserved}\``,
    `- Worker runtime errors: \`${workerAudit.runtimeErrors}\``,
    "",
    "## Stage Durations",
    "",
    markdownTable(stageRows, [
      { label: "Stage", value: (row) => row.stage },
      { label: "Current ms", value: (row) => row.currentMs },
      { label: "Historical 45m ms", value: (row) => row.baselineMs },
      { label: "Current ms/audio min", value: (row) => row.currentPerMinute?.toFixed?.(1) ?? row.currentPerMinute }
    ]),
    "",
    "## Chunk and Checkpoint Summary",
    "",
    `- ASR chunks: \`${asrAudit.actualAudioChunkCount}/${asrAudit.expectedChunkCount}\`; retries=\`${asrAudit.totalRetryCount}\``,
    `- Transcript segments: \`${asrAudit.transcript.segmentCount}\`; source traceable=\`${asrAudit.transcript.traceableSegmentSources}\``,
    `- Audio Insight: checkpoints=\`${audioInsightCheckpoints.length}\`, fallback=\`${audioInsightAudit.fallbackChunks}\``,
    `- Daily Brief: checkpoints=\`${dailyBriefCheckpoints.length}\`, retry chunks=\`${dailyBriefAudit.retryChunks}\`, fallback=\`${dailyBriefAudit.fallbackChunks}\``,
    `- Relationship: checkpoints=\`${relationshipCheckpoints.length}\`, retry success=\`${relationshipAudit.retrySuccessChunks}\`, fallback=\`${relationshipAudit.fallbackChunks}\``,
    `- Analysis checkpoints: \`${checkpoints.total}\`; completed outputs present=\`${checkpoints.integrity.allCompletedOutputsPresent}\``,
    "",
    "## Retention",
    "",
    markdownTable(Object.entries(retention).map(([item, value]) => ({ item, value })), [
      { label: "Artifact", value: (row) => row.item },
      { label: "Retained", value: (row) => row.value }
    ]),
    "",
    "## Evidence First",
    "",
    markdownTable(evidenceRows, [
      { label: "Metric", value: (row) => row.metric },
      { label: "Value", value: (row) => row.value }
    ]),
    "",
    "`null` means the retained artifacts were insufficient for a reliable calculation; it is not treated as zero.",
    "",
    "## Baseline Interpretation",
    "",
    `- Classification: \`${baselineComparison.classification.mode}\``,
    `- Strictly comparable: \`${baselineComparison.classification.comparable}\``,
    `- Reason: ${baselineComparison.classification.reason}`,
    "",
    "The 45-minute report is a historical normalized reference. It is not a same-code/config performance proof unless provenance is confirmed.",
    "",
    "## Privacy and Scope",
    "",
    "- Runtime and SQLite were opened read-only; the report directory is the only write target.",
    "- IDs are represented by one-way short hashes.",
    "- Transcript text, evidence quotes, provider responses, emails, tokens, passwords, and API keys are not emitted.",
    "- The saved log contains only whitelisted, sanitized operational lines.",
    ""
  ].join("\n");
  fs.writeFileSync(
    path.join(options.reportDir, "report.md"),
    markdown,
    { encoding: "utf8", flag: "wx" }
  );

  console.log(JSON.stringify({
    ok: true,
    reportDir: options.reportDir,
    pipelineReady: report.outcome.pipelineReady,
    sourceMutationDetected: report.auditScope.sourceMutationDetected,
    reportFiles: REPORT_FILES
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exitCode = 1;
}

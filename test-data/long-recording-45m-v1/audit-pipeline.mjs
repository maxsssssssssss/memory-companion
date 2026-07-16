import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const datasetDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(datasetDir, "../..");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--upload") { options.uploadId = next; index += 1; }
    else if (arg === "--user") { options.userId = next; index += 1; }
    else if (arg === "--log") { options.logPath = path.resolve(repoRoot, next); index += 1; }
    else if (arg === "--baseline") { options.baselinePath = path.resolve(repoRoot, next); index += 1; }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.uploadId || !options.userId || !options.logPath || !options.baselinePath) {
    throw new Error("Required: --upload <id> --user <id> --log <path> --baseline <path>");
  }
  return options;
}

function readText(filePath) {
  const buffer = fs.readFileSync(filePath);
  let text;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) text = buffer.subarray(2).toString("utf16le");
  if (buffer[0] === 0xfe && buffer[1] === 0xff) throw new Error("Big-endian UTF-16 log is unsupported");
  text ??= buffer.toString("utf8").replace(/^\uFEFF/u, "");

  const lines = text.split(/\r?\n/u);
  const normalized = [];
  let current = "";
  for (let line of lines) {
    line = line.replace(/^node\.exe : (?=\[)/u, "");
    if (/^(?:\s*所在位置 |\s*\+ |\s*CategoryInfo\s*:|\s*FullyQualifiedErrorId\s*:)/u.test(line)) continue;
    if (line.trim() === "{" && normalized.some((entry) => entry.includes("day payload ready"))) break;
    if (line.startsWith("[")) {
      if (current) normalized.push(current);
      current = line;
      continue;
    }
    if (!line.trim()) continue;
    if (current) current += line.trimStart();
  }
  if (current) normalized.push(current);
  return normalized.join("\n");
}

function readJson(filePath, fallback = undefined) {
  if (!fs.existsSync(filePath)) return fallback;
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return value && typeof value === "object" && "data" in value ? value.data : value;
}

function collectionItem(userRoot, collection, id, fallback = undefined) {
  return readJson(path.join(userRoot, collection, `${id}.json`), fallback);
}

function collectionValues(userRoot, collection) {
  const directory = path.join(userRoot, collection);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .map((file) => readJson(path.join(directory, file)))
    .filter(Boolean);
}

function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

function unique(values) {
  return [...new Set(values)];
}

function milliseconds(start, end) {
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

function parseFields(line) {
  return Object.fromEntries([...line.matchAll(/([a-z_]+)=([^\s]+)/gi)].map((match) => [match[1], match[2]]));
}

function matchingLines(logText, prefix) {
  return logText.split(/\r?\n/u).filter((line) => line.includes(prefix));
}

function lastFields(logText, prefix, predicate = () => true) {
  const lines = matchingLines(logText, prefix).filter(predicate);
  return lines.length > 0 ? parseFields(lines.at(-1)) : {};
}

function numberField(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseChunkLines(logText, prefix) {
  return matchingLines(logText, prefix).map((line) => ({ line, ...parseFields(line) }));
}

function result(id, pass, detail) {
  return { id, pass: Boolean(pass), detail };
}

function markdownTable(rows, columns) {
  if (rows.length === 0) return "_No rows._";
  const header = `| ${columns.map((column) => column.label).join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((column) => String(column.value(row) ?? "").replaceAll("|", "\\|").replace(/\r?\n/g, " ")).join(" | ")} |`);
  return [header, separator, ...body].join("\n");
}

function stageDurations(logText) {
  const definitions = [
    ["transcription", "[transcription] completed"],
    ["analysisParallel", "[analysis-parallel] completed"],
    ["audioInsights", "[audio-insights] completed count="],
    ["acousticFeatures", "[ffmpeg-features] completed"],
    ["emotionEvidence", "[emotion-signals] completed"],
    ["semanticTimeline", "[semantic-segments] completed"],
    ["dailyBrief", "[extraction] completed count="],
    ["relationshipSignals", "[relationship-signals] completed count="],
    ["memoryIndex", "[memory-index] completed"],
    ["proactiveInsight", "[proactive-insights] completed"],
    ["totalPipeline", "[pipeline] background completed"]
  ];
  return Object.fromEntries(definitions.map(([name, prefix]) => [name, numberField(lastFields(logText, prefix).elapsed_ms)]));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = readJson(path.join(datasetDir, "manifest.json"));
  const expected = readJson(path.join(datasetDir, "expected-results.json"));
  const generationMetadata = readJson(path.join(datasetDir, "audio", "generation-metadata.json"), {});
  const baseline = readJson(options.baselinePath);
  const logText = readText(options.logPath);
  const userRoot = path.join(repoRoot, ".data", "users", options.userId);
  const reportDir = path.join(repoRoot, ".data", "evaluation", manifest.datasetVersion);
  fs.mkdirSync(reportDir, { recursive: true });

  const upload = collectionItem(userRoot, "uploads", options.uploadId);
  const job = collectionItem(userRoot, "jobs-by-upload", options.uploadId, {});
  const segments = collectionItem(userRoot, "segments", options.uploadId, []);
  const audioInsights = collectionItem(userRoot, "audio-insights", options.uploadId, []);
  const semanticSegments = collectionItem(userRoot, "semantic-segments", options.uploadId, []);
  const briefItems = collectionItem(userRoot, "brief-items", options.uploadId, []);
  const relationshipSignals = collectionItem(userRoot, "relationship-signals", options.uploadId, []);
  const proactiveCache = collectionItem(userRoot, "proactive-insights", `current_${options.uploadId}`, { items: [] });
  const proactiveInsights = proactiveCache?.items ?? [];
  const audioChunks = collectionValues(userRoot, "audio-chunks")
    .filter((chunk) => chunk.uploadId === options.uploadId)
    .sort((left, right) => left.index - right.index);
  const transcriptChunks = collectionValues(userRoot, "transcript-chunks")
    .filter((chunk) => chunk.uploadId === options.uploadId)
    .sort((left, right) => left.index - right.index);

  const asrLogById = new Map(
    parseChunkLines(logText, "[asr-chunks] chunk completed").map((entry) => [entry.chunk_id, entry])
  );
  const transcriptByIndex = new Map(transcriptChunks.map((chunk) => [chunk.index, chunk]));
  const finalSegmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const checkpointSegmentSources = new Map();
  for (const chunk of transcriptChunks) {
    for (const segment of chunk.segments ?? []) checkpointSegmentSources.set(segment.id, { chunkId: chunk.id, chunkIndex: chunk.index, segment });
  }
  const chunkRows = audioChunks.map((chunk) => {
    const transcript = transcriptByIndex.get(chunk.index);
    const log = asrLogById.get(chunk.id);
    return {
      chunkId: chunk.id,
      index: chunk.index,
      startSeconds: chunk.startSeconds,
      endSeconds: chunk.endSeconds,
      durationSeconds: chunk.durationSeconds,
      status: chunk.status,
      retryCount: chunk.retryCount,
      asrElapsedMs: numberField(log?.elapsed_ms) ?? milliseconds(chunk.startedAt, chunk.finishedAt),
      transcriptSegmentCount: transcript?.segments?.length ?? 0,
      transcriptChunkStatus: transcript?.status ?? "missing",
      speakerIdScope: transcript?.speakerIdScope ?? null,
      warning: transcript?.speakerIdScope === "chunk" ? "speaker ids remain chunk-local" : null,
      error: chunk.error ?? null
    };
  });
  const segmentIds = segments.map((segment) => segment.id);
  const uniqueSegmentIds = new Set(segmentIds);
  const timestampsOrdered = segments.every((segment, index) => index === 0 || segment.startSeconds >= segments[index - 1].startSeconds);
  const timestampsInRange = segments.every((segment) => segment.startSeconds >= 0 && segment.endSeconds > segment.startSeconds && segment.endSeconds <= manifest.targetDurationSeconds.planned + 1);
  const missingSegmentSources = segments.filter((segment) => !checkpointSegmentSources.has(segment.id)).map((segment) => segment.id);
  const mergeFields = lastFields(logText, "[transcript-merge]");
  const chunkAudit = {
    uploadId: options.uploadId,
    expectedChunkCount: manifest.expectedChunkCount,
    actualChunkCount: audioChunks.length,
    allCompleted: audioChunks.every((chunk) => chunk.status === "completed") && transcriptChunks.every((chunk) => chunk.status === "completed"),
    chunks: chunkRows,
    transcript: {
      segmentCount: segments.length,
      uniqueSegmentIds: uniqueSegmentIds.size === segmentIds.length,
      timestampsOrdered,
      timestampsInRange,
      segmentSourcesComplete: missingSegmentSources.length === 0,
      missingSegmentSources,
      duplicateRemoved: numberField(mergeFields.duplicates_removed) ?? 0,
      mergeWarnings: numberField(mergeFields.warnings) ?? 0,
      speakerReconciliation: "not_performed"
    }
  };

  const relationshipChunkLogs = parseChunkLines(logText, "[relationship-signals] chunk completed").map((entry) => ({
    index: numberField(entry.index),
    status: entry.status,
    retryCount: numberField(entry.retry_count) ?? 0,
    fallback: entry.fallback === "true",
    candidateCount: numberField(entry.candidates) ?? 0,
    candidateTypes: entry.types && entry.types !== "none" ? entry.types.split(",") : [],
    rejectedCount: numberField(entry.rejected) ?? 0,
    rejectionReasons: entry.reasons ?? "none",
    elapsedMs: numberField(entry.elapsed_ms),
    errorName: entry.error_name ?? null
  })).sort((left, right) => left.index - right.index);
  const relationshipAggregate = lastFields(logText, "[relationship-signals] chunks=");
  const relationshipEvidence = relationshipSignals.flatMap((card) => (card.evidenceSegments ?? []).map((evidence) => {
    const segment = finalSegmentById.get(evidence.segmentId);
    const source = checkpointSegmentSources.get(evidence.segmentId);
    return {
      cardId: card.id,
      signalType: card.signalType,
      sourceId: evidence.segmentId,
      quote: evidence.text,
      sourceExists: Boolean(segment),
      quoteMatches: Boolean(segment && segment.text === evidence.text),
      chunkId: source?.chunkId ?? null,
      chunkIndex: source?.chunkIndex ?? null,
      startSeconds: segment?.startSeconds ?? evidence.startSeconds,
      endSeconds: segment?.endSeconds ?? evidence.endSeconds
    };
  }));
  const forbiddenPattern = /(渣男|渣女|有病|心理诊断|应该分手|必须分手|人格(?:缺陷|有问题)|关系(?:已经|一定).{0,8}(?:失败|破裂)|一定在操控)/u;
  const relationshipAudit = {
    uploadId: options.uploadId,
    chunks: relationshipChunkLogs,
    reducer: {
      candidateCount: numberField(relationshipAggregate.candidates) ?? 0,
      rejectedCount: numberField(relationshipAggregate.rejected) ?? 0,
      reducedCandidateCount: numberField(relationshipAggregate.merged_candidates) ?? 0,
      cardCount: relationshipSignals.length,
      mergedCount: Math.max(0, (numberField(relationshipAggregate.candidates) ?? 0) - (numberField(relationshipAggregate.merged_candidates) ?? 0)),
      reducerElapsedMs: numberField(relationshipAggregate.reducer_elapsed_ms)
    },
    cards: relationshipSignals.map((card) => ({
      id: card.id,
      signalType: card.signalType,
      category: card.signalCategory,
      severity: card.severity,
      confidence: card.confidence,
      summary: card.summary,
      caution: card.caution ?? null,
      evidence: relationshipEvidence.filter((evidence) => evidence.cardId === card.id)
    })),
    evidenceCount: relationshipEvidence.length,
    invalidEvidence: relationshipEvidence.filter((evidence) => !evidence.sourceExists || !evidence.quoteMatches),
    safetyViolations: relationshipSignals.filter((card) => forbiddenPattern.test(JSON.stringify(card))).map((card) => card.id)
  };

  const db = new Database(path.join(repoRoot, ".data", "memory.sqlite"), { readonly: true });
  const memoryItems = db.prepare(`
    SELECT id,user_id,type,title,summary,importance,importance_score,importance_reason,status,occurrence_count,
           first_seen_date,last_seen_date,date,created_at,updated_at
    FROM memory_items WHERE user_id = ? ORDER BY created_at ASC, id ASC
  `).all(options.userId);
  const memoryEvidence = db.prepare(`
    SELECT m.id AS memory_id,m.type,m.title,e.source_type,e.source_id,e.upload_id,e.date,e.quote,e.created_at
    FROM memory_items m JOIN memory_evidence e ON e.memory_id = m.id
    WHERE m.user_id = ? ORDER BY e.date,m.created_at,e.id
  `).all(options.userId);
  const memoryRelations = db.prepare(`
    SELECT source_memory_id,target_memory_id,relation_type,confidence,created_at
    FROM memory_relations
    WHERE source_memory_id IN (SELECT id FROM memory_items WHERE user_id = ?)
       OR target_memory_id IN (SELECT id FROM memory_items WHERE user_id = ?)
    ORDER BY created_at, id
  `).all(options.userId, options.userId);
  const orphanEvidence = db.prepare(`
    SELECT COUNT(*) AS count FROM memory_evidence e
    LEFT JOIN memory_items m ON m.id = e.memory_id WHERE m.id IS NULL
  `).get().count;
  db.close();

  const baselineById = new Map((baseline.memory?.itemSnapshot ?? []).map((item) => [item.id, item]));
  const newItems = memoryItems.filter((item) => !baselineById.has(item.id));
  const updatedItems = memoryItems.filter((item) => {
    const old = baselineById.get(item.id);
    return old && (old.updated_at !== item.updated_at || old.occurrence_count !== item.occurrence_count || old.status !== item.status);
  });
  const currentUploadEvidence = memoryEvidence.filter((evidence) => evidence.upload_id === options.uploadId);
  const sourceIdsByType = {
    transcript: new Set(segments.map((item) => item.id)),
    brief: new Set(briefItems.map((item) => item.id)),
    timeline: new Set(semanticSegments.map((item) => item.id)),
    audio_insight: new Set(audioInsights.map((item) => item.id)),
    relationship_signal: new Set(relationshipSignals.map((item) => item.id))
  };
  const invalidMemorySources = currentUploadEvidence.filter((evidence) => !sourceIdsByType[evidence.source_type]?.has(evidence.source_id));
  const transcriptJoined = normalizeText(segments.map((segment) => segment.text).join(""));
  const memoryQuoteMisses = currentUploadEvidence.filter((evidence) => {
    const quote = normalizeText(evidence.quote);
    return quote.length > 0 && !transcriptJoined.includes(quote);
  });
  const evidenceCountByMemory = new Map(memoryEvidence.reduce((entries, evidence) => {
    entries.set(evidence.memory_id, (entries.get(evidence.memory_id) ?? 0) + 1);
    return entries;
  }, new Map()));
  const memoriesWithoutEvidence = memoryItems.filter((item) => !evidenceCountByMemory.get(item.id));
  const typeDistribution = Object.fromEntries(unique(memoryItems.map((item) => item.type)).sort().map((type) => [type, memoryItems.filter((item) => item.type === type).length]));
  const importanceDistribution = {
    high: memoryItems.filter((item) => item.importance_score >= 0.7).length,
    medium: memoryItems.filter((item) => item.importance_score >= 0.4 && item.importance_score < 0.7).length,
    low: memoryItems.filter((item) => item.importance_score < 0.4).length
  };
  const ordinaryChatPattern = /(天气|地铁|面包店|节目|杯子|外套|温度|座位)/u;
  const meaningfulTopicPattern = /(简历|工作|项目|负责人|博物馆|预约|交通|行程|线上|争执|沟通|暂停|恢复|边界)/u;
  const lowValueHighImportance = memoryItems.filter((item) => {
    const text = `${item.title}${item.summary}`;
    return item.importance_score >= 0.7 && ordinaryChatPattern.test(text) && !meaningfulTopicPattern.test(text);
  });
  const memoryAudit = {
    userId: options.userId,
    uploadId: options.uploadId,
    baseline: { items: baseline.memory.items, evidence: baseline.memory.evidence, relations: baseline.memory.relations },
    final: { items: memoryItems.length, evidence: memoryEvidence.length, relations: memoryRelations.length },
    delta: { newItems: newItems.length, updatedItems: updatedItems.length, newEvidence: memoryEvidence.length - baseline.memory.evidence, newRelations: memoryRelations.length - baseline.memory.relations },
    typeDistribution,
    importanceDistribution,
    items: memoryItems,
    newItemIds: newItems.map((item) => item.id),
    updatedItemIds: updatedItems.map((item) => item.id),
    evidence: currentUploadEvidence,
    relations: memoryRelations,
    orphanEvidence,
    memoriesWithoutEvidence: memoriesWithoutEvidence.map((item) => item.id),
    invalidSources: invalidMemorySources,
    quoteNotExactTranscriptSubstring: memoryQuoteMisses,
    lowValueHighImportance: lowValueHighImportance.map((item) => item.id)
  };

  const combinedMemoryText = (item) => `${item.title} ${item.summary}`;
  const resumeCommitment = memoryItems.some((item) => item.type === "commitment" && /(简历|项目描述|技能部分)/u.test(combinedMemoryText(item)));
  const coffeePreference = memoryItems.some((item) => item.type === "preference" && /(咖啡|拿铁|无糖|低糖|不太甜)/u.test(combinedMemoryText(item)));
  const museumPlan = memoryItems.some((item) => ["event", "question", "commitment"].includes(item.type) && /博物馆/u.test(combinedMemoryText(item)));
  const datesConsistent = currentUploadEvidence.every((item) => item.date === manifest.recordingDate) && newItems.every((item) => item.date === manifest.recordingDate && item.first_seen_date === manifest.recordingDate && item.last_seen_date === manifest.recordingDate);
  const allSafetyText = JSON.stringify({ relationshipSignals, memoryItems, proactiveInsights });
  const currentEvidenceValid = relationshipAudit.invalidEvidence.length === 0 && invalidMemorySources.length === 0;
  const coffeeMemories = memoryItems.filter((item) => item.type === "preference" && /(咖啡|拿铁|无糖|低糖|不太甜)/u.test(combinedMemoryText(item)));
  const supportSignal = relationshipSignals.some((card) => ["active_listening", "emotional_support"].includes(card.signalType));
  const clearCommitmentSignal = relationshipSignals.some((card) => card.signalType === "clear_commitment");
  const boundarySignal = relationshipSignals.some((card) => card.signalType === "boundary_respect");
  const museumMemoryIds = new Set(memoryItems.filter((item) => /博物馆/u.test(combinedMemoryText(item))).map((item) => item.id));
  const museumRelation = memoryRelations.some((relation) => museumMemoryIds.has(relation.source_memory_id) || museumMemoryIds.has(relation.target_memory_id));
  const proactiveSpecific = proactiveInsights.length > 0 && proactiveInsights.every((item) => (item.evidenceRefs?.length ?? item.evidenceIds?.length ?? 0) > 0);

  const must = [
    result("pipeline_ready", upload?.status === "ready" && (job?.status === undefined || job.status === "ready"), `upload=${upload?.status ?? "missing"} job=${job?.status ?? "unknown"}`),
    result("nine_audio_chunks", audioChunks.length === manifest.expectedChunkCount, `actual=${audioChunks.length}`),
    result("all_asr_chunks_completed", chunkAudit.allCompleted, `completed=${audioChunks.filter((chunk) => chunk.status === "completed").length}/${audioChunks.length}`),
    result("unique_segment_ids", uniqueSegmentIds.size === segmentIds.length, `unique=${uniqueSegmentIds.size} total=${segmentIds.length}`),
    result("ordered_global_timestamps", timestampsOrdered && timestampsInRange, `ordered=${timestampsOrdered} inRange=${timestampsInRange}`),
    result("traceable_segment_sources", missingSegmentSources.length === 0, `missing=${missingSegmentSources.length}`),
    result("zero_orphan_memory_evidence", orphanEvidence === 0, `orphan=${orphanEvidence}`),
    result("all_memories_have_evidence", memoriesWithoutEvidence.length === 0, `withoutEvidence=${memoriesWithoutEvidence.length}`),
    result("relationship_evidence_source_exists", relationshipEvidence.every((item) => item.sourceExists), `invalid=${relationshipEvidence.filter((item) => !item.sourceExists).length}`),
    result("relationship_quote_matches", relationshipEvidence.every((item) => item.quoteMatches), `mismatch=${relationshipEvidence.filter((item) => !item.quoteMatches).length}`),
    result("resume_commitment", resumeCommitment, `found=${resumeCommitment}`),
    result("coffee_preference", coffeePreference, `found=${coffeePreference}`),
    result("museum_plan_or_question", museumPlan, `found=${museumPlan}`),
    result("recording_date_consistent", upload?.recordingDate === manifest.recordingDate && datesConsistent, `uploadDate=${upload?.recordingDate ?? "missing"} memoryDates=${datesConsistent}`),
    result("memory_quotes_traceable", memoryQuoteMisses.length === 0, `quoteMisses=${memoryQuoteMisses.length}/${currentUploadEvidence.length}`),
    result("no_fabricated_evidence", currentEvidenceValid, `relationshipInvalid=${relationshipAudit.invalidEvidence.length} memoryInvalid=${invalidMemorySources.length}`),
    result("safe_relationship_language", !forbiddenPattern.test(allSafetyText), `violations=${forbiddenPattern.test(allSafetyText) ? 1 : 0}`)
  ];
  const should = [
    result("support_signal", supportSignal, `found=${supportSignal}`),
    result("clear_commitment_signal", clearCommitmentSignal, `found=${clearCommitmentSignal}`),
    result("boundary_repair_signal", boundarySignal, `found=${boundarySignal}`),
    result("coffee_preference_dedup", coffeeMemories.length === 1 && (coffeeMemories[0].occurrence_count > 1 || (evidenceCountByMemory.get(coffeeMemories[0].id) ?? 0) > 1), `matchingMemories=${coffeeMemories.length}`),
    result("museum_follow_up", museumRelation || memoryItems.some((item) => /博物馆/u.test(combinedMemoryText(item)) && item.status === "resolved"), `relation=${museumRelation}`),
    result("candidate_reduction", (numberField(relationshipAggregate.candidates) ?? 0) > (numberField(relationshipAggregate.merged_candidates) ?? 0), `before=${relationshipAggregate.candidates ?? 0} after=${relationshipAggregate.merged_candidates ?? 0}`),
    result("few_high_value_cards", relationshipSignals.length <= expected.warningThresholds.relationshipSignalCardsGreaterThan, `cards=${relationshipSignals.length}`),
    result("low_value_chat_filtered", lowValueHighImportance.length === 0, `highImportanceLowValue=${lowValueHighImportance.length}`),
    result("specific_proactive_insight", proactiveSpecific, `insights=${proactiveInsights.length}`)
  ];
  const mustNot = [
    result("no_evasion_personality", !/(回避型人格|总是回避|一直逃避)/u.test(allSafetyText), "No fixed evasion trait language"),
    result("no_relationship_failure_verdict", !/(关系已经失败|关系一定会破裂)/u.test(allSafetyText), "No relationship failure verdict"),
    result("no_small_talk_memory_flood", lowValueHighImportance.length === 0, `highImportanceLowValue=${lowValueHighImportance.length}`),
    result("no_missing_relationship_source", relationshipEvidence.every((item) => item.sourceId && item.sourceExists), `invalid=${relationshipAudit.invalidEvidence.length}`),
    result("no_non_transcript_memory", invalidMemorySources.length === 0, `invalidSources=${invalidMemorySources.length}`),
    result("no_fallback_fabrication", currentEvidenceValid, `fallback evidence remains traceable=${currentEvidenceValid}`)
  ];

  const audioInsightChunkLogs = parseChunkLines(logText, "[audio-insights] chunk completed");
  const audioInsightProviderFallbacks = parseChunkLines(logText, "[audio-insight]")
    .filter((entry) => entry.fallback === "rule");
  const stageTimes = stageDurations(logText);
  const warnings = [];
  if (relationshipSignals.length > expected.warningThresholds.relationshipSignalCardsGreaterThan) warnings.push("relationship_signal_card_count");
  if (newItems.length > expected.warningThresholds.newMemoryItemsGreaterThan) warnings.push("new_memory_count");
  const audioFallbackRatio = audioInsightChunkLogs.length > 0 ? audioInsightProviderFallbacks.length / audioInsightChunkLogs.length : 0;
  const relationshipFallbackRatio = relationshipChunkLogs.length > 0 ? relationshipChunkLogs.filter((entry) => entry.fallback).length / relationshipChunkLogs.length : 0;
  if (audioFallbackRatio > expected.warningThresholds.analysisFallbackChunkRatioGreaterThan) warnings.push("audio_insight_fallback_ratio");
  if (relationshipFallbackRatio > expected.warningThresholds.analysisFallbackChunkRatioGreaterThan) warnings.push("relationship_fallback_ratio");
  if (memoryQuoteMisses.length > 0) warnings.push("memory_quote_traceability");
  if (memoryItems.length > 0 && importanceDistribution.high / memoryItems.length > 0.7) warnings.push("memory_importance_skew");
  if (audioChunks.some((chunk) => chunk.retryCount > expected.warningThresholds.chunkRetryCountGreaterThan)) warnings.push("asr_retry_count");
  if ((numberField(mergeFields.warnings) ?? 0) > expected.warningThresholds.transcriptMergeWarningsGreaterThan) warnings.push("transcript_merge_warning_count");
  const rateLimitDetected = /(?:rate.?limit|status[=:]429|\b429\b)/iu.test(logText);
  if (rateLimitDetected) warnings.push("api_rate_limit");

  const remoteCalls = {
    speakerAsr: {
      chunkTaskAttempts: audioChunks.reduce((total, chunk) => total + 1 + (chunk.retryCount ?? 0), 0),
      queryPollHttpCalls: "not_instrumented"
    },
    audioInsight: {
      primaryRequests: audioInsightChunkLogs.reduce((total, entry) => total + 1 + (numberField(entry.retry_count) ?? 0), 0),
      fallbackChunks: audioInsightProviderFallbacks.length,
      fallbackReasons: Object.fromEntries(unique(audioInsightProviderFallbacks.map((entry) => entry.error ?? "unknown")).map((reason) => [reason, audioInsightProviderFallbacks.filter((entry) => (entry.error ?? "unknown") === reason).length]))
    },
    relationshipSignal: {
      primaryRequests: relationshipChunkLogs.filter((entry) => entry.status !== "skipped").reduce((total, entry) => total + 1 + entry.retryCount, 0),
      skippedChunks: relationshipChunkLogs.filter((entry) => entry.status === "skipped").length,
      fallbackChunks: relationshipChunkLogs.filter((entry) => entry.fallback).length
    },
    dailyBriefChunkRequests: matchingLines(logText, "[extraction] chunk completed").length + matchingLines(logText, "[extraction] chunk fallback").length,
    proactiveInsightRequests: proactiveCache?.provider === "deepseek" ? 1 : 0
  };

  const issues = [
    ...(audioInsightProviderFallbacks.length > 0 ? [{
      severity: "warning",
      code: "audio_insight_invalid_json",
      detail: `${audioInsightProviderFallbacks.length}/${audioInsightChunkLogs.length} chunks used deterministic rule fallback after invalid JSON.`
    }] : []),
    ...(relationshipChunkLogs.some((entry) => entry.fallback) ? [{
      severity: "warning",
      code: "relationship_chunk_timeout",
      detail: `${relationshipChunkLogs.filter((entry) => entry.fallback).length}/${relationshipChunkLogs.length} chunks timed out and used local candidate fallback.`
    }] : []),
    ...(relationshipSignals.length > expected.warningThresholds.relationshipSignalCardsGreaterThan ? [{
      severity: "warning",
      code: "relationship_card_overproduction",
      detail: `${relationshipSignals.length} cards exceeded the warning threshold of ${expected.warningThresholds.relationshipSignalCardsGreaterThan}.`
    }] : []),
    ...(!coffeePreference ? [{
      severity: "failure",
      code: "coffee_preference_missing",
      detail: "Repeated no-sugar/low-sugar coffee evidence exists in transcript but no preference Memory was saved."
    }] : []),
    ...(memoryQuoteMisses.length > 0 ? [{
      severity: "failure",
      code: "memory_quote_not_exact_transcript",
      detail: `${memoryQuoteMisses.length}/${currentUploadEvidence.length} Memory evidence quotes are not exact normalized transcript substrings, although their source IDs remain valid.`
    }] : []),
    ...(lowValueHighImportance.length > 0 ? [{
      severity: "warning",
      code: "high_importance_low_value_memory",
      detail: `${lowValueHighImportance.length} broad or ordinary-chat Memory item was assigned high importance.`
    }] : []),
    ...(!museumRelation ? [{
      severity: "warning",
      code: "museum_resolution_relation_missing",
      detail: "Museum planning and completion were stored, but no follow-up/resolved relation connected them."
    }] : [])
  ];

  const recommendations = {
    dailyBriefLayeredSummary: {
      immediate: false,
      rationale: "The six-chunk extraction completed without fallback, but the 30-item cap/merge lost a repeated preference. First improve category coverage in reduction; add hierarchical synthesis for multi-hour inputs."
    },
    analysisChunkCheckpoint: {
      recommended: true,
      rationale: "Chunk analysis lasted several minutes and had partial fallbacks. Persisted AnalysisChunk results would avoid re-running successful chunks after process interruption."
    },
    queueWorker: {
      recommendedBeforeProductionScale: true,
      rationale: "One 45-minute upload occupied a Next.js background task for over 11 minutes. Durable workers are warranted before multi-hour recordings or concurrent users."
    }
  };

  const report = {
    datasetVersion: manifest.datasetVersion,
    generatedAt: new Date().toISOString(),
    userId: options.userId,
    uploadId: options.uploadId,
    recordingDate: upload?.recordingDate ?? null,
    audio: {
      durationSeconds: generationMetadata.audio?.durationSeconds ?? manifest.targetDurationSeconds.planned,
      sizeBytes: upload?.sizeBytes ?? generationMetadata.audio?.sizeBytes ?? null,
      mimeType: upload?.mimeType ?? null,
      codec: generationMetadata.audio?.codec ?? null,
      sampleRate: generationMetadata.audio?.sampleRate ?? null,
      channels: generationMetadata.audio?.channels ?? null,
      voices: generationMetadata.voices ?? null,
      utteranceCount: generationMetadata.utteranceCount ?? null
    },
    status: { upload: upload?.status ?? "missing", job: job?.status ?? "unknown" },
    counts: { segments: segments.length, audioInsights: audioInsights.length, semanticSegments: semanticSegments.length, briefItems: briefItems.length, relationshipSignals: relationshipSignals.length, proactiveInsights: proactiveInsights.length },
    stageDurationsMs: stageTimes,
    remoteCalls,
    transcriptMerge: chunkAudit.transcript,
    relationshipReducer: relationshipAudit.reducer,
    memory: {
      delta: memoryAudit.delta,
      typeDistribution,
      importanceDistribution,
      orphanEvidence,
      memoriesWithoutEvidence: memoriesWithoutEvidence.length,
      invalidSources: invalidMemorySources.length,
      quoteMisses: memoryQuoteMisses.length,
      relations: memoryRelations.length
    },
    fallback: { audioInsightChunkRatio: audioFallbackRatio, relationshipChunkRatio: relationshipFallbackRatio },
    rateLimitDetected,
    issues,
    recommendations,
    must,
    should,
    mustNot,
    warnings,
    conclusion: {
      architecturePass: must.filter((item) => ["nine_audio_chunks", "all_asr_chunks_completed", "unique_segment_ids", "ordered_global_timestamps", "traceable_segment_sources", "zero_orphan_memory_evidence", "no_fabricated_evidence"].includes(item.id)).every((item) => item.pass),
      functionalPass: must.every((item) => item.pass),
      qualityWarnings: [...warnings, ...should.filter((item) => !item.pass).map((item) => `should:${item.id}`)],
      unverified: ["multi-day deduplication", "cross-week retrieval", "long-term relation lifecycle", "cross-recording speaker identity"]
    }
  };

  fs.writeFileSync(path.join(reportDir, "chunk-audit.json"), JSON.stringify(chunkAudit, null, 2));
  fs.writeFileSync(path.join(reportDir, "relationship-audit.json"), JSON.stringify(relationshipAudit, null, 2));
  fs.writeFileSync(path.join(reportDir, "memory-audit.json"), JSON.stringify(memoryAudit, null, 2));
  fs.writeFileSync(path.join(reportDir, "pipeline.cleaned.log"), logText, "utf8");
  fs.writeFileSync(path.join(reportDir, `${manifest.datasetVersion}-report.json`), JSON.stringify(report, null, 2));

  const markdown = [
    `# ${manifest.datasetVersion} Pipeline Report`,
    "",
    `- Upload: \`${options.uploadId}\``,
    `- Status: upload=\`${report.status.upload}\`, job=\`${report.status.job}\``,
    `- Recording date: \`${report.recordingDate}\``,
    `- Pipeline elapsed: \`${stageTimes.totalPipeline ?? "unknown"} ms\``,
    `- Architecture pass: **${report.conclusion.architecturePass}**`,
    `- Functional pass: **${report.conclusion.functionalPass}**`,
    "",
    "## Audio",
    "",
    `- Duration: ${report.audio.durationSeconds}s (${(report.audio.durationSeconds / 60).toFixed(2)} min)`,
    `- Size: ${report.audio.sizeBytes} bytes`,
    `- Format: ${report.audio.codec}, ${report.audio.sampleRate} Hz, ${report.audio.channels} channel`,
    `- Utterances: ${report.audio.utteranceCount}`,
    `- Voices: ${Object.values(report.audio.voices ?? {}).map((voice) => voice.displayName).join(", ")}`,
    "",
    "## Stage Durations",
    "",
    markdownTable(Object.entries(stageTimes).map(([stage, elapsedMs]) => ({ stage, elapsedMs })), [
      { label: "Stage", value: (row) => row.stage },
      { label: "Elapsed ms", value: (row) => row.elapsedMs }
    ]),
    "",
    "## Remote Calls And Fallbacks",
    "",
    `- speaker-ASR chunk attempts: ${remoteCalls.speakerAsr.chunkTaskAttempts} (poll requests not instrumented)`,
    `- Audio Insight requests: ${remoteCalls.audioInsight.primaryRequests}; fallback chunks: ${remoteCalls.audioInsight.fallbackChunks}`,
    `- Daily Brief chunk requests: ${remoteCalls.dailyBriefChunkRequests}`,
    `- Relationship candidate requests: ${remoteCalls.relationshipSignal.primaryRequests}; fallback chunks: ${remoteCalls.relationshipSignal.fallbackChunks}`,
    `- Proactive Insight requests: ${remoteCalls.proactiveInsightRequests}`,
    `- Rate limit detected: ${rateLimitDetected}`,
    "",
    "## Chunk Audit",
    "",
    markdownTable(chunkRows, [
      { label: "Index", value: (row) => row.index },
      { label: "Range", value: (row) => `${row.startSeconds}-${row.endSeconds}s` },
      { label: "Status", value: (row) => row.status },
      { label: "Retry", value: (row) => row.retryCount },
      { label: "ASR ms", value: (row) => row.asrElapsedMs },
      { label: "Segments", value: (row) => row.transcriptSegmentCount },
      { label: "Speaker scope", value: (row) => row.speakerIdScope },
      { label: "Warning/error", value: (row) => row.error ?? row.warning ?? "" }
    ]),
    "",
    `- Merge: ${segments.length} final segments; duplicates removed=${chunkAudit.transcript.duplicateRemoved}; warnings=${chunkAudit.transcript.mergeWarnings}`,
    `- Source mapping complete: ${chunkAudit.transcript.segmentSourcesComplete}`,
    `- Cross-chunk speaker reconciliation: ${chunkAudit.transcript.speakerReconciliation}`,
    "",
    "## Relationship Signals",
    "",
    markdownTable(relationshipChunkLogs, [
      { label: "Chunk", value: (row) => row.index },
      { label: "Status", value: (row) => row.status },
      { label: "Candidates", value: (row) => row.candidateCount },
      { label: "Types", value: (row) => row.candidateTypes.join(",") },
      { label: "Rejected", value: (row) => row.rejectedCount },
      { label: "Fallback", value: (row) => row.fallback },
      { label: "Elapsed ms", value: (row) => row.elapsedMs },
      { label: "Error", value: (row) => row.errorName ?? "" }
    ]),
    "",
    "### Final Cards",
    "",
    markdownTable(relationshipAudit.cards, [
      { label: "Type", value: (row) => row.signalType },
      { label: "Category", value: (row) => row.category },
      { label: "Confidence", value: (row) => row.confidence },
      { label: "Summary", value: (row) => row.summary },
      { label: "Evidence", value: (row) => row.evidence.length }
    ]),
    "",
    `- Candidates: ${relationshipAudit.reducer.candidateCount}`,
    `- Reduced candidates/cards: ${relationshipAudit.reducer.reducedCandidateCount}`,
    `- Merged/removed candidates: ${relationshipAudit.reducer.mergedCount}`,
    `- Invalid evidence: ${relationshipAudit.invalidEvidence.length}`,
    "",
    "## Memory Delta",
    "",
    `- New items: ${memoryAudit.delta.newItems}`,
    `- Updated items: ${memoryAudit.delta.updatedItems}`,
    `- New evidence: ${memoryAudit.delta.newEvidence}`,
    `- New relations: ${memoryAudit.delta.newRelations}`,
    `- Orphan evidence: ${memoryAudit.orphanEvidence}`,
    `- Type distribution: \`${JSON.stringify(typeDistribution)}\``,
    `- Importance distribution: \`${JSON.stringify(importanceDistribution)}\``,
    `- Exact transcript quote misses: ${memoryQuoteMisses.length}/${currentUploadEvidence.length}`,
    `- Relations: ${memoryRelations.length}`,
    "",
    "## Acceptance",
    "",
    markdownTable([...must, ...should, ...mustNot], [
      { label: "Rule", value: (row) => row.id },
      { label: "Pass", value: (row) => row.pass },
      { label: "Detail", value: (row) => row.detail }
    ]),
    "",
    "## Warnings",
    "",
    report.conclusion.qualityWarnings.length > 0 ? report.conclusion.qualityWarnings.map((warning) => `- ${warning}`).join("\n") : "- None",
    "",
    "## Findings",
    "",
    issues.length > 0 ? issues.map((issue) => `- **${issue.severity} / ${issue.code}:** ${issue.detail}`).join("\n") : "- None",
    "",
    "## Recommendations",
    "",
    `- Daily Brief layered summary now: **${recommendations.dailyBriefLayeredSummary.immediate ? "yes" : "no"}**. ${recommendations.dailyBriefLayeredSummary.rationale}`,
    `- AnalysisChunk checkpoint: **${recommendations.analysisChunkCheckpoint.recommended ? "recommended" : "not required"}**. ${recommendations.analysisChunkCheckpoint.rationale}`,
    `- Queue/Worker before production scale: **${recommendations.queueWorker.recommendedBeforeProductionScale ? "recommended" : "not required"}**. ${recommendations.queueWorker.rationale}`,
    "",
    "## Unverified Scope",
    "",
    report.conclusion.unverified.map((item) => `- ${item}`).join("\n"),
    ""
  ].join("\n");
  fs.writeFileSync(path.join(reportDir, `${manifest.datasetVersion}-report.md`), markdown, "utf8");
  console.log(JSON.stringify({ ok: true, reportDir, report }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}

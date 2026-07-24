import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const datasetDir = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(datasetDir, "manifest.json");
const SAFE_ID = /^[A-Za-z0-9_-]+$/u;
const FORBIDDEN_LEGACY_STORY = /简历|咖啡|博物馆|线上争执/u;
const FORBIDDEN_VERDICT = /渣男|渣女|心理诊断|应该分手|人格有问题|关系已经失败/u;

function parseArgs(argv) {
  const options = { requireAudio: false };
  for (const argument of argv) {
    if (argument === "--require-audio") options.requireAudio = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: datasetDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(command)} exited with ${code}: ${stderr || stdout}`));
    });
  });
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label}: ${filePath}`, { cause: error });
  }
}

function isInside(parentPath, childPath) {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function resolveDatasetFile(relativePath, label) {
  assert(
    typeof relativePath === "string" && relativePath.trim() !== "" && !path.isAbsolute(relativePath),
    `${label} must be a relative dataset path`
  );
  const resolved = path.resolve(datasetDir, relativePath);
  assert(isInside(datasetDir, resolved), `${label} escapes the dataset directory`);
  return resolved;
}

function validateManifest(manifest) {
  assert(manifest.datasetVersion === "long-recording-60m-v1", "unexpected datasetVersion");
  assert(manifest.recordingDate === "2026-07-17", "recordingDate must be 2026-07-17");
  assert(manifest.targetDurationSeconds?.min === 3585, "minimum duration must be 3585 seconds");
  assert(manifest.targetDurationSeconds?.max === 3598, "maximum duration must be 3598 seconds");
  assert(manifest.targetDurationSeconds?.planned === 3592, "planned duration must be 3592 seconds");
  assert(manifest.expectedChunkDurationSeconds === 300, "chunk duration must be 300 seconds");
  assert(manifest.expectedChunkCount === 12, "expected chunk count must be twelve");
  assert(
    Math.ceil(manifest.targetDurationSeconds.planned / manifest.expectedChunkDurationSeconds) ===
      manifest.expectedChunkCount,
    "planned duration does not produce exactly twelve chunks"
  );
  assert(Array.isArray(manifest.sections) && manifest.sections.length === 12, "twelve sections are required");
  let expectedStart = 0;
  const sectionIds = new Set();
  for (const [index, section] of manifest.sections.entries()) {
    assert(SAFE_ID.test(section.id ?? ""), `unsafe section id: ${section.id}`);
    assert(!sectionIds.has(section.id), `duplicate section id: ${section.id}`);
    sectionIds.add(section.id);
    assert(section.startSeconds === expectedStart, `${section.id} is not contiguous`);
    assert(
      section.endSeconds - section.startSeconds === section.targetDurationSeconds,
      `${section.id} target duration does not match its range`
    );
    const expectedDuration = index === manifest.sections.length - 1 ? 292 : 300;
    assert(section.targetDurationSeconds === expectedDuration, `${section.id} must be ${expectedDuration} seconds`);
    expectedStart = section.endSeconds;
  }
  assert(expectedStart === 3592, "section ranges must end at 3592 seconds");
  assert(
    manifest.utteranceCountRange?.min === 190 && manifest.utteranceCountRange?.max === 220,
    "utterance count range must remain 190-220"
  );
  assert(
    Number.isSafeInteger(manifest.sectionUtteranceCountRange?.min) &&
      Number.isSafeInteger(manifest.sectionUtteranceCountRange?.max) &&
      manifest.sectionUtteranceCountRange.min > 0 &&
      manifest.sectionUtteranceCountRange.max >= manifest.sectionUtteranceCountRange.min,
    "section utterance count range is invalid"
  );
  assert(Array.isArray(manifest.speakers) && manifest.speakers.length === 2, "two speakers are required");
  assert(manifest.speakers[0]?.id === "A" && manifest.speakers[1]?.id === "B", "speakers must be A and B");
  assert(
    manifest.speakers[0]?.preferredVoice &&
      manifest.speakers[1]?.preferredVoice &&
      manifest.speakers[0].preferredVoice !== manifest.speakers[1].preferredVoice,
    "two distinct preferred voices are required"
  );
  for (const [field, label] of [
    [manifest.audioFile, "audioFile"],
    [manifest.generationMetadataFile, "generationMetadataFile"],
    [manifest.dialogueFile, "dialogueFile"],
    [manifest.transcriptFile, "transcriptFile"],
    [manifest.expectedResultsFile, "expectedResultsFile"]
  ]) {
    resolveDatasetFile(field, label);
  }
  assert(manifest.generationConfig?.sampleRate === 16000, "sample rate must be 16000");
  assert(manifest.generationConfig?.channels === 1, "audio must be mono");
  assert(manifest.generationConfig?.codec === "pcm_s16le", "codec must be pcm_s16le");
  assert(
    Array.isArray(manifest.generationConfig?.normalPauseSeconds) &&
      manifest.generationConfig.normalPauseSeconds.length > 0 &&
      manifest.generationConfig.normalPauseSeconds.every((value) => Number.isFinite(value) && value >= 0),
    "normal pauses must be non-negative numbers"
  );
  assert(
    Array.isArray(manifest.generationConfig?.tempoRange) &&
      manifest.generationConfig.tempoRange.length === 2 &&
      manifest.generationConfig.tempoRange[0] > 0 &&
      manifest.generationConfig.tempoRange[1] >= manifest.generationConfig.tempoRange[0],
    "tempo range is invalid"
  );
  assert(
    Number.isFinite(manifest.validationConfig?.minSpeechActivityRatio) &&
      manifest.validationConfig.minSpeechActivityRatio > 0 &&
      manifest.validationConfig.minSpeechActivityRatio <= 1,
    "speech activity ratio is invalid"
  );
}

function validateDialogue(dialogue, manifest) {
  assert(dialogue.datasetVersion === manifest.datasetVersion, "manifest/dialogue datasetVersion mismatch");
  assert(dialogue.language === "zh-CN", "dialogue language must be zh-CN");
  assert(Array.isArray(dialogue.utterances), "dialogue.utterances must be an array");
  assert(
    dialogue.utterances.length >= manifest.utteranceCountRange.min &&
      dialogue.utterances.length <= manifest.utteranceCountRange.max,
    `dialogue must contain ${manifest.utteranceCountRange.min}-${manifest.utteranceCountRange.max} utterances`
  );
  const sectionById = new Map(manifest.sections.map((section, index) => [section.id, { section, index }]));
  const utteranceIds = new Set();
  let previousSpeaker = null;
  let previousSectionIndex = -1;
  for (const utterance of dialogue.utterances) {
    assert(SAFE_ID.test(utterance.utteranceId ?? ""), `unsafe utteranceId: ${utterance.utteranceId}`);
    assert(!utteranceIds.has(utterance.utteranceId), `duplicate utteranceId: ${utterance.utteranceId}`);
    utteranceIds.add(utterance.utteranceId);
    assert(utterance.speaker === "A" || utterance.speaker === "B", `${utterance.utteranceId} has invalid speaker`);
    assert(utterance.speaker !== previousSpeaker, `${utterance.utteranceId} does not alternate speaker`);
    previousSpeaker = utterance.speaker;
    assert(
      typeof utterance.text === "string" && /[\p{Script=Han}]/u.test(utterance.text),
      `${utterance.utteranceId} must contain Chinese text`
    );
    assert(!FORBIDDEN_LEGACY_STORY.test(utterance.text), `${utterance.utteranceId} reuses a legacy story topic`);
    assert(!FORBIDDEN_VERDICT.test(utterance.text), `${utterance.utteranceId} contains forbidden verdict language`);
    const entry = sectionById.get(utterance.section);
    assert(entry, `${utterance.utteranceId} has unknown section`);
    assert(entry.index >= previousSectionIndex, `${utterance.utteranceId} moves sections backwards`);
    previousSectionIndex = entry.index;
    assert(
      Array.isArray(utterance.expectedStartRange) &&
        utterance.expectedStartRange.length === 2 &&
        utterance.expectedStartRange[0] === entry.section.startSeconds &&
        utterance.expectedStartRange[1] === entry.section.endSeconds,
      `${utterance.utteranceId} expectedStartRange does not match its section`
    );
    assert(
      Array.isArray(utterance.tags) &&
        utterance.tags.length > 0 &&
        utterance.tags.every((tag) => typeof tag === "string" && SAFE_ID.test(tag)),
      `${utterance.utteranceId} needs safe non-empty tags`
    );
  }
  for (const section of manifest.sections) {
    const count = dialogue.utterances.filter((utterance) => utterance.section === section.id).length;
    assert(
      count >= manifest.sectionUtteranceCountRange.min && count <= manifest.sectionUtteranceCountRange.max,
      `${section.id} must contain ${manifest.sectionUtteranceCountRange.min}-${manifest.sectionUtteranceCountRange.max} utterances`
    );
  }
}

function validateExpectedResults(expected, manifest) {
  assert(expected.datasetVersion === manifest.datasetVersion, "manifest/expected-results datasetVersion mismatch");
  for (const group of ["must", "should", "mustNot"]) {
    assert(Array.isArray(expected[group]) && expected[group].length > 0, `${group} assertions are required`);
    const ids = new Set();
    for (const assertion of expected[group]) {
      assert(SAFE_ID.test(assertion.id ?? ""), `${group} assertion has an unsafe id`);
      assert(!ids.has(assertion.id), `${group} contains duplicate assertion id ${assertion.id}`);
      ids.add(assertion.id);
      assert(typeof assertion.description === "string" && assertion.description.trim(), `${assertion.id} needs a description`);
    }
  }
}

function derivedDialogueText(dialogue) {
  return `${dialogue.utterances.map((utterance) => `${utterance.speaker}: ${utterance.text}`).join("\n")}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function currentInputHashes(manifest, dialogue, transcript) {
  return {
    manifestSha256: await sha256File(manifestPath),
    dialogueSha256: await sha256File(resolveDatasetFile(manifest.dialogueFile, "dialogueFile")),
    transcriptSha256: sha256(Buffer.from(transcript, "utf8")),
    canonicalInputSha256: sha256(Buffer.from(JSON.stringify({
      datasetVersion: manifest.datasetVersion,
      dialogue
    }), "utf8"))
  };
}

async function probeAudio(filePath) {
  const { stdout } = await run(ffprobeStatic.path, [
    "-v", "error",
    "-show_entries", "format=duration,size:stream=codec_name,sample_rate,channels",
    "-of", "json",
    filePath
  ]);
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0] ?? {};
  return {
    durationSeconds: Number(parsed.format?.duration ?? 0),
    sizeBytes: Number(parsed.format?.size ?? 0),
    codec: stream.codec_name,
    sampleRate: Number(stream.sample_rate),
    channels: Number(stream.channels)
  };
}

function parseSilences(stderr, durationSeconds) {
  const events = [...stderr.matchAll(/silence_(start|end):\s*(-?[\d.]+)/gu)]
    .map((match) => ({ type: match[1], time: Number(match[2]) }));
  const intervals = [];
  let start = null;
  for (const event of events) {
    if (event.type === "start") start = Math.max(0, event.time);
    else if (start !== null) {
      intervals.push({ start, end: event.time, duration: event.time - start });
      start = null;
    }
  }
  if (start !== null) intervals.push({ start, end: durationSeconds, duration: durationSeconds - start });
  return intervals.filter((interval) => interval.duration >= 0);
}

function overlap(interval, start, end) {
  return Math.max(0, Math.min(interval.end, end) - Math.max(interval.start, start));
}

async function analyzeAudio(filePath, durationSeconds, manifest) {
  const nullSink = process.platform === "win32" ? "NUL" : "/dev/null";
  const volumeRun = await run(ffmpegPath, [
    "-hide_banner", "-i", filePath, "-af", "volumedetect", "-f", "null", nullSink
  ]);
  const meanMatch = /mean_volume:\s*(-?[\d.]+) dB/u.exec(volumeRun.stderr);
  const peakMatch = /max_volume:\s*(-?[\d.]+) dB/u.exec(volumeRun.stderr);
  const silenceRun = await run(ffmpegPath, [
    "-hide_banner",
    "-i", filePath,
    "-af",
    `silencedetect=noise=${manifest.validationConfig.silenceNoiseDb}dB:d=${manifest.validationConfig.silenceMinDurationSeconds}`,
    "-f", "null", nullSink
  ]);
  const silences = parseSilences(silenceRun.stderr, durationSeconds);
  const windows = [];
  const chunkSeconds = manifest.expectedChunkDurationSeconds;
  for (let start = 0, index = 0; start < durationSeconds; start += chunkSeconds, index += 1) {
    const end = Math.min(durationSeconds, start + chunkSeconds);
    const silentSeconds = silences.reduce((sum, interval) => sum + overlap(interval, start, end), 0);
    windows.push({
      index,
      startSeconds: start,
      endSeconds: Number(end.toFixed(3)),
      durationSeconds: Number((end - start).toFixed(3)),
      speechActivitySeconds: Number((end - start - silentSeconds).toFixed(3)),
      speechActivityRatio: Number(((end - start - silentSeconds) / (end - start)).toFixed(4)),
      silentSeconds: Number(silentSeconds.toFixed(3))
    });
  }
  return {
    meanVolumeDb: meanMatch ? Number(meanMatch[1]) : null,
    peakVolumeDb: peakMatch ? Number(peakMatch[1]) : null,
    silenceIntervals: silences,
    maxSilenceSeconds: Math.max(0, ...silences.map((interval) => interval.duration)),
    windows
  };
}

function sameNumber(left, right, tolerance = 0.001) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assert(ffmpegPath && ffprobeStatic?.path, "ffmpeg-static and ffprobe-static are required");
  const manifest = await readJson(manifestPath, "manifest");
  validateManifest(manifest);
  const dialoguePath = resolveDatasetFile(manifest.dialogueFile, "dialogueFile");
  const expectedPath = resolveDatasetFile(manifest.expectedResultsFile, "expectedResultsFile");
  const [dialogue, expected] = await Promise.all([
    readJson(dialoguePath, "dialogue"),
    readJson(expectedPath, "expected results")
  ]);
  validateDialogue(dialogue, manifest);
  validateExpectedResults(expected, manifest);

  const transcript = derivedDialogueText(dialogue);
  const transcriptPath = resolveDatasetFile(manifest.transcriptFile, "transcriptFile");
  const transcriptExists = await fs.access(transcriptPath).then(() => true).catch(() => false);
  if (transcriptExists) {
    assert(await fs.readFile(transcriptPath, "utf8") === transcript, "dialogue.txt differs from dialogue.json");
  }
  const audioPath = resolveDatasetFile(manifest.audioFile, "audioFile");
  const metadataPath = resolveDatasetFile(manifest.generationMetadataFile, "generationMetadataFile");
  const audioExists = await fs.access(audioPath).then(() => true).catch(() => false);
  if (options.requireAudio) assert(audioExists, `missing audio: ${manifest.audioFile}`);
  if (!audioExists) {
    console.log(JSON.stringify({
      ok: true,
      audioRequired: false,
      datasetVersion: manifest.datasetVersion,
      utteranceCount: dialogue.utterances.length,
      sectionCount: manifest.sections.length,
      expectedChunkCount: manifest.expectedChunkCount,
      transcriptPresent: transcriptExists
    }, null, 2));
    return;
  }
  assert(transcriptExists, `${manifest.transcriptFile} must exist when generated audio exists`);

  const metadata = await readJson(metadataPath, "generation metadata");
  assert(metadata.datasetVersion === manifest.datasetVersion, "generation metadata datasetVersion mismatch");
  const hashes = await currentInputHashes(manifest, dialogue, transcript);
  for (const [key, value] of Object.entries(hashes)) {
    assert(metadata.inputHashes?.[key] === value, `generated audio is stale: ${key} mismatch`);
  }
  const audioSha256 = await sha256File(audioPath);
  assert(metadata.audio?.sha256 === audioSha256, "audio SHA-256 does not match generation metadata");
  assert(metadata.audio?.file === manifest.audioFile, "generation metadata audio file mismatch");
  assert(metadata.utteranceCount === dialogue.utterances.length, "generation metadata utterance count mismatch");
  for (const field of ["node", "platform", "powershell", "ffmpeg", "ffprobe"]) {
    assert(typeof metadata.tools?.[field] === "string" && metadata.tools[field].trim(), `metadata tool ${field} is missing`);
  }
  assert(Array.isArray(metadata.sections) && metadata.sections.length === manifest.sections.length, "generation metadata section count mismatch");
  for (const [index, section] of manifest.sections.entries()) {
    const generated = metadata.sections[index];
    const expectedUtteranceCount = dialogue.utterances.filter(
      (utterance) => utterance.section === section.id
    ).length;
    assert(generated?.sectionId === section.id, `generation metadata section ${index} mismatch`);
    assert(generated.utteranceCount === expectedUtteranceCount, `${section.id} generated utterance count mismatch`);
    assert(sameNumber(generated.durationSeconds, section.targetDurationSeconds, 0.05), `${section.id} generated duration mismatch`);
    assert(generated.finalSilenceGuardSeconds >= 3, `${section.id} has insufficient boundary silence`);
    assert(
      generated.tempo >= manifest.generationConfig.tempoRange[0] &&
        generated.tempo <= manifest.generationConfig.tempoRange[1],
      `${section.id} tempo is outside manifest range`
    );
  }
  const voiceA = metadata.voices?.A;
  const voiceB = metadata.voices?.B;
  assert(voiceA?.language?.toLowerCase() === "zh-cn", "voice A must be zh-CN");
  assert(voiceB?.language?.toLowerCase() === "zh-cn", "voice B must be zh-CN");
  assert(voiceA?.id && voiceB?.id && voiceA.id !== voiceB.id, "two distinct generated voice IDs are required");

  const probe = await probeAudio(audioPath);
  assert(
    probe.durationSeconds >= manifest.targetDurationSeconds.min &&
      probe.durationSeconds <= manifest.targetDurationSeconds.max,
    `duration ${probe.durationSeconds}s is outside target range`
  );
  assert(
    Math.abs(probe.durationSeconds - manifest.targetDurationSeconds.planned) <=
      manifest.validationConfig.durationToleranceSeconds,
    `duration ${probe.durationSeconds}s does not match the 3592-second plan`
  );
  assert(probe.codec === manifest.generationConfig.codec, `codec must be ${manifest.generationConfig.codec}`);
  assert(probe.sampleRate === manifest.generationConfig.sampleRate, `sample rate must be ${manifest.generationConfig.sampleRate}`);
  assert(probe.channels === manifest.generationConfig.channels, `channels must be ${manifest.generationConfig.channels}`);
  assert(Math.ceil(probe.durationSeconds / manifest.expectedChunkDurationSeconds) === 12, "audio does not produce twelve chunks");
  assert(sameNumber(metadata.audio.durationSeconds, probe.durationSeconds), "metadata audio duration mismatch");
  assert(metadata.audio.sizeBytes === probe.sizeBytes, "metadata audio size mismatch");
  assert(metadata.audio.codec === probe.codec, "metadata audio codec mismatch");
  assert(metadata.audio.sampleRate === probe.sampleRate, "metadata audio sample rate mismatch");
  assert(metadata.audio.channels === probe.channels, "metadata audio channel mismatch");

  const analysis = await analyzeAudio(audioPath, probe.durationSeconds, manifest);
  const [minimumMean, maximumMean] = manifest.validationConfig.meanVolumeDbRange;
  const [minimumPeak, maximumPeak] = manifest.validationConfig.peakVolumeDbRange;
  assert(
    analysis.meanVolumeDb !== null &&
      analysis.meanVolumeDb >= minimumMean &&
      analysis.meanVolumeDb <= maximumMean,
    `mean volume ${analysis.meanVolumeDb}dB is outside ${minimumMean}..${maximumMean}dB`
  );
  assert(
    analysis.peakVolumeDb !== null &&
      analysis.peakVolumeDb >= minimumPeak &&
      analysis.peakVolumeDb <= maximumPeak,
    `peak volume ${analysis.peakVolumeDb}dB is outside ${minimumPeak}..${maximumPeak}dB`
  );
  assert(
    analysis.maxSilenceSeconds <= manifest.validationConfig.maxSilenceSeconds,
    `unexpected silence of ${analysis.maxSilenceSeconds.toFixed(3)}s exceeds limit`
  );
  assert(analysis.windows.length === manifest.expectedChunkCount, "audio window count does not match expected chunks");
  for (const window of analysis.windows) {
    assert(
      window.speechActivityRatio >= manifest.validationConfig.minSpeechActivityRatio,
      `window ${window.index} has too little speech activity (${window.speechActivityRatio})`
    );
  }

  console.log(JSON.stringify({
    ok: true,
    datasetVersion: manifest.datasetVersion,
    recordingDate: manifest.recordingDate,
    utteranceCount: dialogue.utterances.length,
    sectionCount: manifest.sections.length,
    expectedChunkCount: manifest.expectedChunkCount,
    inputHashes: hashes,
    audio: {
      file: manifest.audioFile,
      durationSeconds: Number(probe.durationSeconds.toFixed(3)),
      sizeBytes: probe.sizeBytes,
      sizeMiB: Number((probe.sizeBytes / 1024 / 1024).toFixed(3)),
      sha256: audioSha256,
      codec: probe.codec,
      sampleRate: probe.sampleRate,
      channels: probe.channels,
      meanVolumeDb: analysis.meanVolumeDb,
      peakVolumeDb: analysis.peakVolumeDb,
      maxSilenceSeconds: Number(analysis.maxSilenceSeconds.toFixed(3))
    },
    windows: analysis.windows
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exitCode = 1;
});

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const datasetDir = path.dirname(fileURLToPath(import.meta.url));
const requireAudio = process.argv.includes("--require-audio");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: datasetDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || stdout)));
  });
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
  const events = [...stderr.matchAll(/silence_(start|end):\s*([\d.]+)/g)].map((match) => ({ type: match[1], time: Number(match[2]) }));
  const intervals = [];
  let start = null;
  for (const event of events) {
    if (event.type === "start") start = event.time;
    else if (start !== null) {
      intervals.push({ start, end: event.time, duration: event.time - start });
      start = null;
    }
  }
  if (start !== null) intervals.push({ start, end: durationSeconds, duration: durationSeconds - start });
  return intervals;
}

function overlap(interval, start, end) {
  return Math.max(0, Math.min(interval.end, end) - Math.max(interval.start, start));
}

async function analyzeAudio(filePath, durationSeconds, chunkSeconds) {
  const volumeRun = await run(ffmpegPath, ["-hide_banner", "-i", filePath, "-af", "volumedetect", "-f", "null", "NUL"]);
  const meanMatch = /mean_volume:\s*(-?[\d.]+) dB/.exec(volumeRun.stderr);
  const peakMatch = /max_volume:\s*(-?[\d.]+) dB/.exec(volumeRun.stderr);
  const silenceRun = await run(ffmpegPath, ["-hide_banner", "-i", filePath, "-af", "silencedetect=noise=-38dB:d=0.5", "-f", "null", "NUL"]);
  const silences = parseSilences(silenceRun.stderr, durationSeconds);
  const windows = [];
  for (let start = 0, index = 0; start < durationSeconds; start += chunkSeconds, index += 1) {
    const end = Math.min(durationSeconds, start + chunkSeconds);
    const silentSeconds = silences.reduce((sum, interval) => sum + overlap(interval, start, end), 0);
    windows.push({
      index,
      startSeconds: start,
      endSeconds: Number(end.toFixed(3)),
      durationSeconds: Number((end - start).toFixed(3)),
      speechActivitySeconds: Number((end - start - silentSeconds).toFixed(3)),
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

function derivedDialogueText(dialogue) {
  return `${dialogue.utterances.map((utterance) => `${utterance.speaker}: ${utterance.text}`).join("\n")}\n`;
}

async function main() {
  assert(ffmpegPath && ffprobeStatic?.path, "ffmpeg-static and ffprobe-static are required");
  const manifest = JSON.parse(await fs.readFile(path.join(datasetDir, "manifest.json"), "utf8"));
  const dialogue = JSON.parse(await fs.readFile(path.join(datasetDir, manifest.dialogueFile), "utf8"));
  const expected = JSON.parse(await fs.readFile(path.join(datasetDir, "expected-results.json"), "utf8"));
  assert(manifest.datasetVersion === dialogue.datasetVersion, "manifest/dialogue datasetVersion mismatch");
  assert(manifest.datasetVersion === expected.datasetVersion, "manifest/expected-results datasetVersion mismatch");
  assert(manifest.recordingDate === "2026-07-15", "recordingDate must remain 2026-07-15");
  assert(manifest.expectedChunkDurationSeconds === 300, "chunk duration must be 300 seconds");
  assert(manifest.expectedChunkCount === 9, "expected chunk count must be nine");
  assert(Array.isArray(expected.must) && expected.must.length > 0, "must assertions are required");
  assert(Array.isArray(expected.should) && expected.should.length > 0, "should assertions are required");
  assert(Array.isArray(expected.mustNot) && expected.mustNot.length > 0, "mustNot assertions are required");

  const utteranceIds = new Set();
  let previousSpeaker = null;
  for (const utterance of dialogue.utterances) {
    assert(!utteranceIds.has(utterance.utteranceId), `duplicate utteranceId: ${utterance.utteranceId}`);
    utteranceIds.add(utterance.utteranceId);
    assert(utterance.speaker === "A" || utterance.speaker === "B", `${utterance.utteranceId} has invalid speaker`);
    assert(utterance.speaker !== previousSpeaker, `${utterance.utteranceId} does not alternate speaker`);
    previousSpeaker = utterance.speaker;
    assert(/[\p{Script=Han}]/u.test(utterance.text), `${utterance.utteranceId} must contain Chinese text`);
    assert(Array.isArray(utterance.expectedStartRange) && utterance.expectedStartRange.length === 2, `${utterance.utteranceId} needs expectedStartRange`);
    assert(Array.isArray(utterance.tags) && utterance.tags.length > 0, `${utterance.utteranceId} needs tags`);
    assert(!/(渣男|渣女|心理诊断|应该分手|人格有问题|关系已经失败)/u.test(utterance.text), `${utterance.utteranceId} contains forbidden verdict language`);
  }
  for (const section of manifest.sections) {
    const sectionUtterances = dialogue.utterances.filter((utterance) => utterance.section === section.id);
    assert(sectionUtterances.length >= 12 && sectionUtterances.length <= 20, `${section.id} must contain 12-20 utterances`);
    assert(sectionUtterances.every((utterance) => utterance.expectedStartRange[0] === section.startSeconds && utterance.expectedStartRange[1] === section.endSeconds), `${section.id} expectedStartRange mismatch`);
  }

  const transcriptPath = path.join(datasetDir, manifest.transcriptFile);
  const transcriptExists = await fs.access(transcriptPath).then(() => true).catch(() => false);
  assert(transcriptExists, `${manifest.transcriptFile} must be generated from dialogue.json`);
  assert(await fs.readFile(transcriptPath, "utf8") === derivedDialogueText(dialogue), "dialogue.txt differs from dialogue.json");

  const audioPath = path.resolve(datasetDir, manifest.audioFile);
  const audioExists = await fs.access(audioPath).then(() => true).catch(() => false);
  if (requireAudio) assert(audioExists, `missing audio: ${manifest.audioFile}`);
  if (!audioExists) {
    console.log(JSON.stringify({ ok: true, audioRequired: false, utteranceCount: dialogue.utterances.length }, null, 2));
    return;
  }

  const probe = await probeAudio(audioPath);
  assert(probe.durationSeconds >= manifest.targetDurationSeconds.min && probe.durationSeconds <= manifest.targetDurationSeconds.max, `duration ${probe.durationSeconds}s is outside target range`);
  assert(probe.codec === manifest.generationConfig.codec, `codec must be ${manifest.generationConfig.codec}`);
  assert(probe.sampleRate === manifest.generationConfig.sampleRate, `sample rate must be ${manifest.generationConfig.sampleRate}`);
  assert(probe.channels === manifest.generationConfig.channels, `channels must be ${manifest.generationConfig.channels}`);
  assert(Math.ceil(probe.durationSeconds / manifest.expectedChunkDurationSeconds) === manifest.expectedChunkCount, "duration does not produce exactly nine chunks");

  const analysis = await analyzeAudio(audioPath, probe.durationSeconds, manifest.expectedChunkDurationSeconds);
  assert(analysis.meanVolumeDb !== null && analysis.meanVolumeDb >= -25 && analysis.meanVolumeDb <= -16, `mean volume ${analysis.meanVolumeDb}dB is outside -25..-16dB`);
  assert(analysis.peakVolumeDb !== null && analysis.peakVolumeDb <= -1 && analysis.peakVolumeDb >= -8, `peak volume ${analysis.peakVolumeDb}dB is outside -8..-1dB`);
  assert(analysis.maxSilenceSeconds <= 12, `unexpected silence of ${analysis.maxSilenceSeconds.toFixed(3)}s exceeds 12s`);
  assert(analysis.windows.length === 9, `expected nine 5-minute windows; found ${analysis.windows.length}`);
  for (const window of analysis.windows) {
    assert(window.speechActivitySeconds >= Math.min(120, window.durationSeconds * 0.6), `window ${window.index} has too little speech activity`);
  }

  console.log(JSON.stringify({
    ok: true,
    datasetVersion: manifest.datasetVersion,
    recordingDate: manifest.recordingDate,
    utteranceCount: dialogue.utterances.length,
    sectionCount: manifest.sections.length,
    expectedChunkCount: manifest.expectedChunkCount,
    audio: {
      file: manifest.audioFile,
      durationSeconds: Number(probe.durationSeconds.toFixed(3)),
      sizeBytes: probe.sizeBytes,
      sizeMiB: Number((probe.sizeBytes / 1024 / 1024).toFixed(3)),
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
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});

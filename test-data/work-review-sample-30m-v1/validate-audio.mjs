import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const datasetDir = path.dirname(fileURLToPath(import.meta.url));

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
    "-show_entries", "format=duration,size,format_name:stream=codec_name,sample_rate,channels",
    "-of", "json",
    filePath
  ]);
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0] ?? {};
  return {
    durationSeconds: Number(parsed.format?.duration ?? 0),
    sizeBytes: Number(parsed.format?.size ?? 0),
    container: parsed.format?.format_name,
    codec: stream.codec_name,
    sampleRateHz: Number(stream.sample_rate),
    channels: Number(stream.channels)
  };
}

async function sha256(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function parseTimestamp(value) {
  const match = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(value);
  assert(match, `Invalid timestamp: ${value}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function parseTranscript(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\[(\d{2}:\d{2}:\d{2}\.\d{3}) – (\d{2}:\d{2}:\d{2}\.\d{3})\] ([^（]+)（([^）]+)）：(.+)$/.exec(line);
    if (!match) continue;
    entries.push({
      startSeconds: parseTimestamp(match[1]),
      endSeconds: parseTimestamp(match[2]),
      speakerName: match[3],
      role: match[4],
      text: match[5]
    });
  }
  return entries;
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

async function main() {
  assert(ffmpegPath && ffprobeStatic?.path, "ffmpeg-static and ffprobe-static are required");
  const source = JSON.parse(await fs.readFile(path.join(datasetDir, "source.json"), "utf8"));
  const dialogue = JSON.parse(await fs.readFile(path.join(datasetDir, source.dialogueFile), "utf8"));
  const expected = JSON.parse(await fs.readFile(path.join(datasetDir, "expected-results.json"), "utf8"));
  const manifest = JSON.parse(await fs.readFile(path.join(datasetDir, source.manifestFile), "utf8"));
  const audioPath = path.resolve(datasetDir, source.audioFile);
  const transcriptPath = path.resolve(datasetDir, source.transcriptFile);
  const transcriptText = await fs.readFile(transcriptPath, "utf8");
  const transcript = parseTranscript(transcriptText);
  const audio = await probeAudio(audioPath);

  assert(source.datasetVersion === dialogue.datasetVersion, "source/dialogue version mismatch");
  assert(source.datasetVersion === expected.datasetVersion, "source/expected version mismatch");
  assert(source.datasetVersion === manifest.datasetVersion, "source/manifest version mismatch");
  assert(source.speakers.length === 3, "fixture must have exactly three participants");
  assert(new Set(source.speakers.map((speaker) => speaker.preferredVoice)).size === 3, "participants must have distinct voices");
  assert(dialogue.utterances.length === 90, `expected 90 utterances; got ${dialogue.utterances.length}`);
  assert(transcript.length === dialogue.utterances.length, "transcript utterance count mismatch");

  const speakerById = new Map(source.speakers.map((speaker) => [speaker.id, speaker]));
  for (const [index, entry] of transcript.entries()) {
    const utterance = dialogue.utterances[index];
    const speaker = speakerById.get(utterance.speakerId);
    assert(entry.text === utterance.text, `transcript text mismatch at ${utterance.utteranceId}`);
    assert(entry.speakerName === speaker.name, `speaker mismatch at ${utterance.utteranceId}`);
    assert(entry.role === speaker.role, `role mismatch at ${utterance.utteranceId}`);
    assert(entry.startSeconds >= 0 && entry.endSeconds > entry.startSeconds, `invalid timestamp at ${utterance.utteranceId}`);
    assert(entry.endSeconds <= audio.durationSeconds + 0.001, `timestamp exceeds audio at ${utterance.utteranceId}`);
    if (index > 0) assert(entry.startSeconds >= transcript[index - 1].endSeconds, `overlapping timestamp at ${utterance.utteranceId}`);
  }

  assert(Math.abs(audio.durationSeconds - source.targetDurationSeconds) <= 0.05, `duration mismatch: ${audio.durationSeconds}`);
  assert(audio.codec === "pcm_s16le", `unexpected codec: ${audio.codec}`);
  assert(audio.sampleRateHz === 16000, `unexpected sample rate: ${audio.sampleRateHz}`);
  assert(audio.channels === 1, `unexpected channel count: ${audio.channels}`);
  assert(audio.sizeBytes === manifest.audio.sizeBytes, "manifest audio size mismatch");
  assert(await sha256(audioPath) === manifest.audio.sha256, "manifest audio SHA-256 mismatch");
  assert(await sha256(transcriptPath) === manifest.transcript.sha256, "manifest transcript SHA-256 mismatch");
  assert(manifest.audio.durationSeconds === Number(audio.durationSeconds.toFixed(3)), "manifest duration mismatch");
  assert(manifest.transcript.utteranceCount === dialogue.utterances.length, "manifest utterance count mismatch");

  for (const section of manifest.generation.sections) {
    assert(section.tempo >= 0.82 && section.tempo <= 1.18, `${section.sectionId} tempo is not natural: ${section.tempo}`);
    assert(section.finalSilenceGuardSeconds >= 2.5 && section.finalSilenceGuardSeconds <= 5, `${section.sectionId} boundary silence is unexpected`);
  }
  const semanticTags = new Set(dialogue.utterances.flatMap((utterance) => utterance.tags));
  for (const tag of manifest.verification.expectedSemanticTags) assert(semanticTags.has(tag), `missing semantic tag: ${tag}`);
  assert(expected.must.length >= 8, "insufficient must expectations");
  assert(expected.mustNot.length >= 5, "insufficient mustNot expectations");
  const utteranceIds = new Set(dialogue.utterances.map((utterance) => utterance.utteranceId));
  for (const item of [...expected.must, ...expected.mustNot]) {
    for (const id of item.sourceUtteranceIds) assert(utteranceIds.has(id), `expected-result references unknown utterance: ${id}`);
  }

  const volumeRun = await run(ffmpegPath, ["-hide_banner", "-i", audioPath, "-af", "volumedetect", "-f", "null", "NUL"]);
  const silenceRun = await run(ffmpegPath, ["-hide_banner", "-i", audioPath, "-af", "silencedetect=noise=-38dB:d=0.5", "-f", "null", "NUL"]);
  const meanMatch = /mean_volume:\s*(-?[\d.]+) dB/.exec(volumeRun.stderr);
  const peakMatch = /max_volume:\s*(-?[\d.]+) dB/.exec(volumeRun.stderr);
  const silences = parseSilences(silenceRun.stderr, audio.durationSeconds);
  const maxSilenceSeconds = Math.max(0, ...silences.map((interval) => interval.duration));
  const meanVolumeDb = meanMatch ? Number(meanMatch[1]) : null;
  const peakVolumeDb = peakMatch ? Number(peakMatch[1]) : null;
  assert(meanVolumeDb !== null && meanVolumeDb >= -35 && meanVolumeDb <= -10, `unexpected mean volume: ${meanVolumeDb}`);
  assert(peakVolumeDb !== null && peakVolumeDb <= -1 && peakVolumeDb >= -12, `unexpected peak volume: ${peakVolumeDb}`);
  assert(maxSilenceSeconds <= 5.1, `unexpected long silence: ${maxSilenceSeconds}`);

  console.log(JSON.stringify({
    ok: true,
    datasetVersion: source.datasetVersion,
    audio,
    audioSha256: manifest.audio.sha256,
    transcriptSha256: manifest.transcript.sha256,
    utteranceCount: transcript.length,
    participantCount: source.speakers.length,
    mustCount: expected.must.length,
    mustNotCount: expected.mustNot.length,
    meanVolumeDb,
    peakVolumeDb,
    maxSilenceSeconds: Number(maxSilenceSeconds.toFixed(3)),
    timestamps: {
      firstStartSeconds: transcript[0].startSeconds,
      lastEndSeconds: transcript.at(-1).endSeconds,
      monotonicAndNonOverlapping: true
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});

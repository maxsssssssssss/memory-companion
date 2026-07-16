import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout)));
  });
}

function dateMs(dateKey) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(dateKey), `Invalid date key: ${dateKey}`);
  const value = Date.parse(`${dateKey}T00:00:00.000Z`);
  assert(Number.isFinite(value), `Invalid date: ${dateKey}`);
  return value;
}

function mondayWeekKey(dateKey) {
  const date = new Date(dateMs(dateKey));
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

function parseTranscript(text, transcriptFile) {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  assert(lines.length >= 8 && lines.length <= 14, `${transcriptFile} must have 8-14 utterances; found ${lines.length}`);
  const utterances = lines.map((line, index) => {
    const match = /^([AB]):\s*(.+)$/u.exec(line);
    assert(match, `${transcriptFile}:${index + 1} has invalid speaker format`);
    return { speaker: match[1], text: match[2] };
  });
  for (let index = 1; index < utterances.length; index += 1) {
    assert(utterances[index].speaker !== utterances[index - 1].speaker, `${transcriptFile}:${index + 1} does not alternate speakers`);
  }
  const joined = utterances.map((item) => item.text).join(" ");
  assert(!/渣男|渣女|有病|应该分手|心理诊断/u.test(joined), `${transcriptFile} contains forbidden relationship verdict language`);
  assert(!/第[一二三四五六七八0-9]+天.{0,8}测试/u.test(joined), `${transcriptFile} exposes test-day wording`);
  return utterances;
}

async function probeAudio(filePath) {
  const stdout = await run(ffprobeStatic.path, [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_name,sample_rate,channels",
    "-of", "json",
    filePath
  ]);
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0] ?? {};
  return {
    durationSeconds: Math.round(Number(parsed.format?.duration ?? 0) * 1000) / 1000,
    codec: stream.codec_name,
    sampleRate: Number(stream.sample_rate),
    channels: Number(stream.channels)
  };
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(datasetDir, "manifest.json"), "utf8"));
  const expected = JSON.parse(await fs.readFile(path.join(datasetDir, "expected-results.json"), "utf8"));
  assert(manifest.datasetVersion === "memory-multiday-v1", "Unexpected manifest datasetVersion");
  assert(expected.datasetVersion === manifest.datasetVersion, "Manifest and expected-results versions differ");
  assert(Array.isArray(manifest.sessions) && manifest.sessions.length === 8, "Dataset must contain exactly eight sessions");
  assert(Array.isArray(expected.must) && expected.must.length > 0, "expected-results must define must assertions");
  assert(Array.isArray(expected.should) && expected.should.length > 0, "expected-results must define should assertions");
  assert(Array.isArray(expected.mustNot) && expected.mustNot.length > 0, "expected-results must define mustNot assertions");

  const uniqueSessionIds = new Set();
  const uniqueDates = new Set();
  const uniqueFiles = new Set();
  const staticResults = [];
  for (const session of manifest.sessions) {
    assert(session.datasetVersion === manifest.datasetVersion, `${session.sessionId} has a mismatched datasetVersion`);
    assert(!uniqueSessionIds.has(session.sessionId), `Duplicate sessionId: ${session.sessionId}`);
    assert(!uniqueDates.has(session.date), `Duplicate date: ${session.date}`);
    assert(!uniqueFiles.has(session.audioFile), `Duplicate audio file: ${session.audioFile}`);
    uniqueSessionIds.add(session.sessionId);
    uniqueDates.add(session.date);
    uniqueFiles.add(session.audioFile);
    dateMs(session.date);
    assert(session.recordedAt.startsWith(`${session.date}T`), `${session.sessionId} recordedAt/date mismatch`);
    assert(Array.isArray(session.speakers) && session.speakers.join(",") === "A,B", `${session.sessionId} must use speakers A and B`);
    assert(Array.isArray(session.expectedThemes) && session.expectedThemes.length > 0, `${session.sessionId} needs expectedThemes`);
    assert(Array.isArray(session.expectedMemoryTypes) && session.expectedMemoryTypes.length > 0, `${session.sessionId} needs expectedMemoryTypes`);
    assert(Array.isArray(session.expectedRelationshipSignals), `${session.sessionId} needs expectedRelationshipSignals`);

    const transcriptPath = path.resolve(datasetDir, session.transcriptFile);
    const utterances = parseTranscript(await fs.readFile(transcriptPath, "utf8"), session.transcriptFile);
    const audioPath = path.resolve(datasetDir, session.audioFile);
    const audioExists = await fs.access(audioPath).then(() => true).catch(() => false);
    if (requireAudio) assert(audioExists, `Missing generated audio: ${session.audioFile}`);
    let audio = null;
    if (audioExists) {
      audio = await probeAudio(audioPath);
      assert(audio.durationSeconds >= 90 && audio.durationSeconds <= 150, `${session.audioFile} duration must be 90-150s`);
      assert(audio.codec === "pcm_s16le", `${session.audioFile} must use pcm_s16le`);
      assert(audio.sampleRate === 16000, `${session.audioFile} must use 16 kHz`);
      assert(audio.channels === 1, `${session.audioFile} must be mono`);
    }
    staticResults.push({ sessionId: session.sessionId, date: session.date, utterances: utterances.length, audio });
  }

  const sortedDates = [...uniqueDates].sort();
  const spanDays = (dateMs(sortedDates.at(-1)) - dateMs(sortedDates[0])) / 86_400_000;
  const naturalWeeks = [...new Set(sortedDates.map(mondayWeekKey))];
  assert(spanDays >= 12, `Dataset date span must be at least 12 days; found ${spanDays}`);
  assert(naturalWeeks.length >= 2, `Dataset must span at least two natural weeks; found ${naturalWeeks.length}`);

  console.log(JSON.stringify({
    ok: true,
    datasetVersion: manifest.datasetVersion,
    sessions: manifest.sessions.length,
    dateRange: { start: sortedDates[0], end: sortedDates.at(-1), spanDays },
    naturalWeekStarts: naturalWeeks,
    audioRequired: requireAudio,
    results: staticResults
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const datasetDir = path.dirname(fileURLToPath(import.meta.url));
const source = JSON.parse(await fs.readFile(path.join(datasetDir, "source.json"), "utf8"));
const dialogue = JSON.parse(await fs.readFile(path.join(datasetDir, source.dialogueFile), "utf8"));
const audioPath = path.resolve(datasetDir, source.audioFile);
const transcriptPath = path.resolve(datasetDir, source.transcriptFile);
const manifestPath = path.resolve(datasetDir, source.manifestFile);

function parseArgs(argv) {
  const options = { clean: false, force: false, listVoices: false };
  for (const arg of argv) {
    if (arg === "--clean") options.clean = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--list-voices") options.listVoices = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: datasetDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...options
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

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function runPowerShell(script) {
  return await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")
  ]);
}

async function listLocalVoices() {
  if (process.platform !== "win32") return [];
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
    "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
    "$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime]",
    "$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object {",
    "  [PSCustomObject]@{ displayName = $_.DisplayName; language = $_.Language; gender = $_.Gender.ToString(); id = $_.Id }",
    "}",
    "$voices | ConvertTo-Json -Depth 3 -Compress"
  ].join("\n");
  const { stdout } = await runPowerShell(script);
  const parsed = JSON.parse(stdout.trim() || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function synthesizeRawUtterances(requests, requestPath) {
  await fs.writeFile(requestPath, JSON.stringify(requests), "utf8");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
    "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
    "$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime]",
    "$asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {",
    "  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1",
    "} | Select-Object -First 1",
    "function Await-Result($operation, [Type]$resultType) {",
    "  $task = $asTaskMethod.MakeGenericMethod($resultType).Invoke($null, @($operation))",
    "  $task.Wait()",
    "  return $task.Result",
    "}",
    `$requests = Get-Content -LiteralPath ${quotePowerShell(requestPath)} -Raw -Encoding UTF8 | ConvertFrom-Json`,
    "$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices",
    "$synthesizers = @{}",
    "try {",
    "  foreach ($request in @($requests)) {",
    "    $voice = $voices | Where-Object { $_.DisplayName -eq $request.voiceName } | Select-Object -First 1",
    "    if (-not $voice) { throw \"Voice not found: $($request.voiceName)\" }",
    "    if (-not $synthesizers.ContainsKey($request.voiceName)) {",
    "      $synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer",
    "      $synth.Voice = $voice",
    "      $synthesizers[$request.voiceName] = $synth",
    "    }",
    "    $stream = Await-Result ($synthesizers[$request.voiceName].SynthesizeTextToStreamAsync([string]$request.text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])",
    "    $inputStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)",
    "    $outputStream = [System.IO.File]::Create([string]$request.outputPath)",
    "    try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose(); $stream.Dispose() }",
    "  }",
    "} finally { foreach ($synthesizer in $synthesizers.Values) { $synthesizer.Dispose() } }"
  ].join("\n");
  await runPowerShell(script);
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
    container: parsed.format?.format_name ?? null,
    codec: stream.codec_name ?? null,
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

function concatBody(files) {
  return files.map((filePath) => `file '${filePath.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`).join("\n");
}

function validateDialogue() {
  if (dialogue.datasetVersion !== source.datasetVersion) throw new Error("dialogue/source datasetVersion mismatch");
  const speakerIds = new Set(source.speakers.map((speaker) => speaker.id));
  const sectionIds = new Set(source.sections.map((section) => section.id));
  const ids = new Set();
  for (const utterance of dialogue.utterances) {
    if (ids.has(utterance.utteranceId)) throw new Error(`Duplicate utteranceId: ${utterance.utteranceId}`);
    ids.add(utterance.utteranceId);
    if (!speakerIds.has(utterance.speakerId)) throw new Error(`${utterance.utteranceId} has unknown speaker`);
    if (!sectionIds.has(utterance.section)) throw new Error(`${utterance.utteranceId} has unknown section`);
    if (!/[\p{Script=Han}]/u.test(utterance.text)) throw new Error(`${utterance.utteranceId} has no Chinese text`);
    if (!Array.isArray(utterance.tags) || utterance.tags.length === 0) throw new Error(`${utterance.utteranceId} has no tags`);
  }
  for (const section of source.sections) {
    const count = dialogue.utterances.filter((utterance) => utterance.section === section.id).length;
    if (count < 12 || count > 18) throw new Error(`${section.id} must contain 12-18 utterances; got ${count}`);
  }
  for (const speakerId of speakerIds) {
    if (!dialogue.utterances.some((utterance) => utterance.speakerId === speakerId)) {
      throw new Error(`Speaker has no utterances: ${speakerId}`);
    }
  }
  const requiredTags = ["decision_final", "action_assigned", "commitment_explicit", "action_unassigned", "deadline", "unresolved_question", "plan_change"];
  for (const tag of requiredTags) {
    if (!dialogue.utterances.some((utterance) => utterance.tags.includes(tag))) throw new Error(`Missing semantic tag: ${tag}`);
  }
}

async function normalizeUtterance({ sourcePath, outputPath, tempo, pauseSeconds }) {
  await run(ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", sourcePath,
    "-af", `atempo=${tempo.toFixed(8)},loudnorm=I=${source.generationConfig.loudnessTargetLufs}:TP=${source.generationConfig.truePeakDb}:LRA=7,apad=pad_dur=${pauseSeconds.toFixed(3)}`,
    "-ar", String(source.generationConfig.sampleRate),
    "-ac", String(source.generationConfig.channels),
    "-c:a", source.generationConfig.codec,
    outputPath
  ]);
}

async function buildSection(section, utterances, requests, tempDir) {
  const pauses = utterances.map((_, index) => index === utterances.length - 1
    ? source.generationConfig.sectionTransitionPauseSeconds
    : source.generationConfig.normalPauseSeconds[index % source.generationConfig.normalPauseSeconds.length]);
  const rawDurations = [];
  for (const utterance of utterances) rawDurations.push((await probeAudio(requests.get(utterance.utteranceId).outputPath)).durationSeconds);
  const rawSpeechSeconds = rawDurations.reduce((sum, value) => sum + value, 0);
  const pauseSeconds = pauses.reduce((sum, value) => sum + value, 0);
  const targetSpeechSeconds = section.targetDurationSeconds - pauseSeconds;
  const tempo = rawSpeechSeconds / targetSpeechSeconds;
  const [minTempo, maxTempo] = source.generationConfig.tempoRange;
  if (tempo < minTempo || tempo > maxTempo) {
    throw new Error(`${section.id} requires atempo=${tempo.toFixed(3)}, outside ${minTempo}-${maxTempo}; adjust dialogue length`);
  }

  const normalizedFiles = [];
  const timings = [];
  let cursorSamples = 0;
  for (const [index, utterance] of utterances.entries()) {
    const outputPath = path.join(tempDir, `${utterance.utteranceId}-normalized.wav`);
    await normalizeUtterance({
      sourcePath: requests.get(utterance.utteranceId).outputPath,
      outputPath,
      tempo,
      pauseSeconds: pauses[index]
    });
    const normalized = await probeAudio(outputPath);
    const totalSamples = Math.round(normalized.durationSeconds * source.generationConfig.sampleRate);
    const pauseSamples = Math.round(pauses[index] * source.generationConfig.sampleRate);
    const speechSamples = Math.max(0, totalSamples - pauseSamples);
    timings.push({
      ...utterance,
      relativeStartSamples: cursorSamples,
      relativeEndSamples: cursorSamples + speechSamples
    });
    cursorSamples += totalSamples;
    normalizedFiles.push(outputPath);
  }

  const concatPath = path.join(tempDir, `${section.id}-concat.txt`);
  const untrimmedPath = path.join(tempDir, `${section.id}-untrimmed.wav`);
  const sectionPath = path.join(tempDir, `${section.id}.wav`);
  await fs.writeFile(concatPath, concatBody(normalizedFiles), "utf8");
  await run(ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", concatPath,
    "-ar", String(source.generationConfig.sampleRate),
    "-ac", String(source.generationConfig.channels),
    "-c:a", source.generationConfig.codec,
    untrimmedPath
  ]);
  const untrimmed = await probeAudio(untrimmedPath);
  const overflowSeconds = Math.max(0, untrimmed.durationSeconds - section.targetDurationSeconds);
  const finalSilenceGuardSeconds = pauses.at(-1) - overflowSeconds;
  if (finalSilenceGuardSeconds < 2.5) throw new Error(`${section.id} would trim speech or leave insufficient boundary silence`);
  await run(ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", untrimmedPath,
    "-af", "apad",
    "-t", String(section.targetDurationSeconds),
    "-ar", String(source.generationConfig.sampleRate),
    "-ac", String(source.generationConfig.channels),
    "-c:a", source.generationConfig.codec,
    sectionPath
  ]);
  const finalProbe = await probeAudio(sectionPath);
  if (Math.abs(finalProbe.durationSeconds - section.targetDurationSeconds) > 0.05) throw new Error(`${section.id} duration mismatch`);
  return {
    sectionId: section.id,
    sectionPath,
    timings,
    utteranceCount: utterances.length,
    rawSpeechSeconds: Number(rawSpeechSeconds.toFixed(3)),
    pauseSeconds: Number(pauseSeconds.toFixed(3)),
    tempo: Number(tempo.toFixed(6)),
    durationSeconds: Number(finalProbe.durationSeconds.toFixed(3)),
    finalSilenceGuardSeconds: Number(finalSilenceGuardSeconds.toFixed(3))
  };
}

function formatTimestamp(totalSeconds) {
  const milliseconds = Math.max(0, Math.round(totalSeconds * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const seconds = Math.floor((milliseconds % 60000) / 1000);
  const millis = milliseconds % 1000;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":") + `.${String(millis).padStart(3, "0")}`;
}

function renderTranscript(sectionResults) {
  const speakerById = new Map(source.speakers.map((speaker) => [speaker.id, speaker]));
  const lines = [
    `# ${source.title} Transcript`,
    "",
    "> 完全合成测试素材；时间戳由最终归一化音频逐段计算。",
    ""
  ];
  let sectionOffsetSamples = 0;
  for (const [index, result] of sectionResults.entries()) {
    const section = source.sections[index];
    lines.push(`## ${section.title}`, "");
    for (const timing of result.timings) {
      const speaker = speakerById.get(timing.speakerId);
      lines.push(`[${formatTimestamp((sectionOffsetSamples + timing.relativeStartSamples) / source.generationConfig.sampleRate)} – ${formatTimestamp((sectionOffsetSamples + timing.relativeEndSamples) / source.generationConfig.sampleRate)}] ${speaker.name}（${speaker.role}）：${timing.text}`);
      lines.push("");
    }
    sectionOffsetSamples += Math.round(result.durationSeconds * source.generationConfig.sampleRate);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const voices = await listLocalVoices();
  if (options.listVoices) {
    console.log(JSON.stringify({ voices }, null, 2));
    return;
  }
  if (process.platform !== "win32") throw new Error("Windows OneCore TTS is required");
  if (!ffmpegPath || !ffprobeStatic?.path) throw new Error("ffmpeg-static and ffprobe-static are required");
  validateDialogue();
  await fs.mkdir(path.dirname(audioPath), { recursive: true });
  if (options.clean) {
    await Promise.all([
      fs.rm(audioPath, { force: true }),
      fs.rm(transcriptPath, { force: true }),
      fs.rm(manifestPath, { force: true })
    ]);
    if (!options.force) {
      console.log(JSON.stringify({ ok: true, cleaned: [source.audioFile, source.transcriptFile, source.manifestFile] }, null, 2));
      return;
    }
  }
  const exists = await fs.access(audioPath).then(() => true).catch(() => false);
  if (exists && !options.force) throw new Error("Audio already exists; use --force or --clean --force");

  const availableByName = new Map(voices.map((voice) => [voice.displayName, voice]));
  const selectedVoices = {};
  for (const speaker of source.speakers) {
    const voice = availableByName.get(speaker.preferredVoice);
    if (!voice || voice.language?.toLowerCase() !== "zh-cn") throw new Error(`Required zh-CN voice not found: ${speaker.preferredVoice}`);
    selectedVoices[speaker.id] = voice;
  }
  if (new Set(Object.values(selectedVoices).map((voice) => voice.displayName)).size !== source.speakers.length) {
    throw new Error("Each participant requires a distinct voice");
  }

  const speakerById = new Map(source.speakers.map((speaker) => [speaker.id, speaker]));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-review-sample-30m-v1-"));
  try {
    const requests = dialogue.utterances.map((utterance) => ({
      utteranceId: utterance.utteranceId,
      text: utterance.text,
      voiceName: selectedVoices[utterance.speakerId].displayName,
      outputPath: path.join(tempDir, `${utterance.utteranceId}-raw.wav`)
    }));
    await synthesizeRawUtterances(requests, path.join(tempDir, "tts-requests.json"));
    const requestById = new Map(requests.map((request) => [request.utteranceId, request]));
    const sectionResults = [];
    for (const section of source.sections) {
      const utterances = dialogue.utterances.filter((utterance) => utterance.section === section.id);
      sectionResults.push(await buildSection(section, utterances, requestById, tempDir));
      console.log(`[${sectionResults.length}/${source.sections.length}] ${section.id} generated`);
    }

    const concatPath = path.join(tempDir, "all-sections.txt");
    await fs.writeFile(concatPath, concatBody(sectionResults.map((result) => result.sectionPath)), "utf8");
    await run(ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "concat", "-safe", "0", "-i", concatPath,
      "-ar", String(source.generationConfig.sampleRate),
      "-ac", String(source.generationConfig.channels),
      "-c:a", source.generationConfig.codec,
      audioPath
    ]);
    const transcript = renderTranscript(sectionResults);
    await fs.writeFile(transcriptPath, transcript, "utf8");
    const audio = await probeAudio(audioPath);
    if (Math.abs(audio.durationSeconds - source.targetDurationSeconds) > 0.05) throw new Error(`Final duration mismatch: ${audio.durationSeconds}`);
    const manifest = {
      datasetVersion: source.datasetVersion,
      title: source.title,
      generatedAt: new Date().toISOString(),
      synthetic: true,
      privacy: "All participants, organization, project, dialogue, and facts are fictional.",
      purpose: source.purpose,
      audio: {
        file: source.audioFile,
        durationSeconds: Number(audio.durationSeconds.toFixed(3)),
        sizeBytes: audio.sizeBytes,
        sha256: await sha256(audioPath),
        container: audio.container,
        codec: audio.codec,
        sampleRateHz: audio.sampleRateHz,
        channels: audio.channels
      },
      transcript: {
        file: source.transcriptFile,
        utteranceCount: dialogue.utterances.length,
        sha256: await sha256(transcriptPath),
        timestampMethod: "Derived from each normalized utterance duration and inserted pause before section concatenation"
      },
      speakers: source.speakers.map((speaker) => ({
        id: speaker.id,
        name: speaker.name,
        role: speaker.role,
        voice: selectedVoices[speaker.id].displayName,
        voiceGender: selectedVoices[speaker.id].gender
      })),
      generation: {
        method: "Windows OneCore offline TTS per utterance, FFmpeg atempo/loudnorm normalization, deterministic section concatenation",
        script: "generate-audio.mjs",
        source: "source.json",
        dialogue: source.dialogueFile,
        targetDurationSeconds: source.targetDurationSeconds,
        sections: sectionResults.map(({ sectionPath: _sectionPath, timings: _timings, ...result }) => result)
      },
      verification: {
        audioTextSource: "Every spoken utterance is synthesized directly from dialogue.json text",
        transcriptTextSource: "Every transcript utterance is rendered from the same dialogue.json text",
        expectedSemanticTags: ["decision_final", "action_assigned", "commitment_explicit", "action_unassigned", "deadline", "unresolved_question", "plan_change"]
      }
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ok: true, manifest }, null, 2));
  } finally {
    const tempRelative = path.relative(path.resolve(os.tmpdir()), path.resolve(tempDir));
    if (!tempRelative || tempRelative.startsWith("..") || path.isAbsolute(tempRelative)
      || !path.basename(tempDir).startsWith("work-review-sample-30m-v1-")) throw new Error("unsafe_temp_cleanup_path");
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});

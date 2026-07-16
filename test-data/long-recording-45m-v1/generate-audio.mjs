import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const datasetDir = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(datasetDir, "manifest.json"), "utf8"));
const dialogue = JSON.parse(await fs.readFile(path.join(datasetDir, manifest.dialogueFile), "utf8"));
const audioDir = path.join(datasetDir, "audio");
const outputPath = path.resolve(datasetDir, manifest.audioFile);

function parseArgs(argv) {
  const options = {
    clean: false,
    force: false,
    listVoices: false,
    voiceA: process.env.LONG_RECORDING_VOICE_A?.trim() || manifest.speakers[0].preferredVoice,
    voiceB: process.env.LONG_RECORDING_VOICE_B?.trim() || manifest.speakers[1].preferredVoice
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--clean") options.clean = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--list-voices") options.listVoices = true;
    else if (arg === "--voice-a") { options.voiceA = next; index += 1; }
    else if (arg === "--voice-b") { options.voiceB = next; index += 1; }
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

function concatBody(files) {
  return files.map((filePath) => `file '${filePath.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`).join("\n");
}

function validateDialogue() {
  if (dialogue.datasetVersion !== manifest.datasetVersion) throw new Error("dialogue/manifest datasetVersion mismatch");
  const ids = new Set();
  for (const [index, utterance] of dialogue.utterances.entries()) {
    if (ids.has(utterance.utteranceId)) throw new Error(`Duplicate utteranceId: ${utterance.utteranceId}`);
    ids.add(utterance.utteranceId);
    if (!/[\p{Script=Han}]/u.test(utterance.text)) throw new Error(`${utterance.utteranceId} has no Chinese text`);
    if (!manifest.sections.some((section) => section.id === utterance.section)) throw new Error(`${utterance.utteranceId} has unknown section`);
    if (index > 0 && dialogue.utterances[index - 1].speaker === utterance.speaker) {
      throw new Error(`${utterance.utteranceId} must alternate speaker`);
    }
  }
}

function derivedDialogueText() {
  return `${dialogue.utterances.map((utterance) => `${utterance.speaker}: ${utterance.text}`).join("\n")}\n`;
}

async function normalizeUtterance(input) {
  await run(ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", input.sourcePath,
    "-af", `atempo=${input.tempo.toFixed(8)},loudnorm=I=${manifest.generationConfig.loudnessTargetLufs}:TP=${manifest.generationConfig.truePeakDb}:LRA=7,apad=pad_dur=${input.pauseSeconds.toFixed(3)}`,
    "-ar", String(manifest.generationConfig.sampleRate),
    "-ac", String(manifest.generationConfig.channels),
    "-c:a", manifest.generationConfig.codec,
    input.outputPath
  ]);
}

async function buildSection(section, utterances, requests, tempDir) {
  const pauses = utterances.map((_, index) => {
    if (index === utterances.length - 1) return manifest.generationConfig.sectionTransitionPauseSeconds;
    const values = manifest.generationConfig.normalPauseSeconds;
    return values[index % values.length];
  });
  const rawDurations = [];
  for (const utterance of utterances) {
    const request = requests.get(utterance.utteranceId);
    rawDurations.push((await probeAudio(request.outputPath)).durationSeconds);
  }
  const rawSpeechSeconds = rawDurations.reduce((sum, value) => sum + value, 0);
  const pauseSeconds = pauses.reduce((sum, value) => sum + value, 0);
  const targetSpeechSeconds = section.targetDurationSeconds - pauseSeconds;
  const tempo = rawSpeechSeconds / targetSpeechSeconds;
  const [minTempo, maxTempo] = manifest.generationConfig.tempoRange;
  if (tempo < minTempo || tempo > maxTempo) {
    throw new Error(`${section.id} requires atempo=${tempo.toFixed(3)}, outside ${minTempo}-${maxTempo}; adjust dialogue instead of padding with long silence`);
  }

  const normalizedFiles = [];
  for (const [index, utterance] of utterances.entries()) {
    const normalizedPath = path.join(tempDir, `${utterance.utteranceId}-normalized.wav`);
    await normalizeUtterance({
      sourcePath: requests.get(utterance.utteranceId).outputPath,
      outputPath: normalizedPath,
      tempo,
      pauseSeconds: pauses[index]
    });
    normalizedFiles.push(normalizedPath);
  }

  const concatPath = path.join(tempDir, `${section.id}-concat.txt`);
  const untrimmedPath = path.join(tempDir, `${section.id}-untrimmed.wav`);
  const sectionPath = path.join(tempDir, `${section.id}.wav`);
  await fs.writeFile(concatPath, concatBody(normalizedFiles), "utf8");
  await run(ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", concatPath,
    "-ar", String(manifest.generationConfig.sampleRate),
    "-ac", String(manifest.generationConfig.channels),
    "-c:a", manifest.generationConfig.codec,
    untrimmedPath
  ]);
  const untrimmed = await probeAudio(untrimmedPath);
  const overflowSeconds = Math.max(0, untrimmed.durationSeconds - section.targetDurationSeconds);
  const finalSilenceGuard = pauses.at(-1) - overflowSeconds;
  if (finalSilenceGuard < 3) {
    throw new Error(`${section.id} would trim spoken content or leave less than 3s boundary silence`);
  }
  await run(ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", untrimmedPath,
    "-af", "apad",
    "-t", String(section.targetDurationSeconds),
    "-ar", String(manifest.generationConfig.sampleRate),
    "-ac", String(manifest.generationConfig.channels),
    "-c:a", manifest.generationConfig.codec,
    sectionPath
  ]);
  const finalProbe = await probeAudio(sectionPath);
  if (Math.abs(finalProbe.durationSeconds - section.targetDurationSeconds) > 0.05) {
    throw new Error(`${section.id} duration ${finalProbe.durationSeconds} does not match target ${section.targetDurationSeconds}`);
  }
  return {
    sectionPath,
    sectionId: section.id,
    utteranceCount: utterances.length,
    rawSpeechSeconds: Number(rawSpeechSeconds.toFixed(3)),
    pauseSeconds: Number(pauseSeconds.toFixed(3)),
    tempo: Number(tempo.toFixed(6)),
    durationSeconds: Number(finalProbe.durationSeconds.toFixed(3)),
    finalSilenceGuardSeconds: Number(finalSilenceGuard.toFixed(3))
  };
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
  await fs.mkdir(audioDir, { recursive: true });
  await fs.writeFile(path.join(datasetDir, manifest.transcriptFile), derivedDialogueText(), "utf8");
  if (options.clean) {
    await fs.rm(outputPath, { force: true });
    await fs.rm(path.join(audioDir, "generation-metadata.json"), { force: true });
    if (!options.force) {
      console.log(JSON.stringify({ ok: true, cleaned: manifest.audioFile }, null, 2));
      return;
    }
  }
  const exists = await fs.access(outputPath).then(() => true).catch(() => false);
  if (exists && !options.force) throw new Error("Audio already exists; use --force or --clean --force");

  const chineseVoices = voices.filter((voice) => voice.language?.toLowerCase() === "zh-cn");
  const voiceA = chineseVoices.find((voice) => voice.displayName === options.voiceA);
  const voiceB = chineseVoices.find((voice) => voice.displayName === options.voiceB);
  if (!voiceA || !voiceB || voiceA.displayName === voiceB.displayName) {
    throw new Error(`Two distinct zh-CN voices are required. Requested A=${options.voiceA}, B=${options.voiceB}. Detected: ${chineseVoices.map((voice) => voice.displayName).join(", ") || "none"}`);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "long-recording-45m-v1-"));
  try {
    const requests = dialogue.utterances.map((utterance) => ({
      utteranceId: utterance.utteranceId,
      text: utterance.text,
      voiceName: utterance.speaker === "A" ? voiceA.displayName : voiceB.displayName,
      outputPath: path.join(tempDir, `${utterance.utteranceId}-raw.wav`)
    }));
    await synthesizeRawUtterances(requests, path.join(tempDir, "tts-requests.json"));
    const requestById = new Map(requests.map((request) => [request.utteranceId, request]));
    const sectionResults = [];
    for (const section of manifest.sections) {
      const utterances = dialogue.utterances.filter((utterance) => utterance.section === section.id);
      if (utterances.length < 12 || utterances.length > 20) throw new Error(`${section.id} must contain 12-20 utterances`);
      sectionResults.push(await buildSection(section, utterances, requestById, tempDir));
    }

    const concatPath = path.join(tempDir, "all-sections.txt");
    await fs.writeFile(concatPath, concatBody(sectionResults.map((result) => result.sectionPath)), "utf8");
    await run(ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "concat", "-safe", "0", "-i", concatPath,
      "-ar", String(manifest.generationConfig.sampleRate),
      "-ac", String(manifest.generationConfig.channels),
      "-c:a", manifest.generationConfig.codec,
      outputPath
    ]);
    const probe = await probeAudio(outputPath);
    if (probe.durationSeconds < manifest.targetDurationSeconds.min || probe.durationSeconds > manifest.targetDurationSeconds.max) {
      throw new Error(`Final duration ${probe.durationSeconds}s is outside ${manifest.targetDurationSeconds.min}-${manifest.targetDurationSeconds.max}s`);
    }
    const metadata = {
      datasetVersion: manifest.datasetVersion,
      generatedAt: new Date().toISOString(),
      voices: { A: voiceA, B: voiceB },
      utteranceCount: dialogue.utterances.length,
      sections: sectionResults.map(({ sectionPath: _sectionPath, ...result }) => result),
      audio: { file: manifest.audioFile, ...probe }
    };
    await fs.writeFile(path.join(audioDir, "generation-metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
    console.log(JSON.stringify({ ok: true, ...metadata }, null, 2));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});

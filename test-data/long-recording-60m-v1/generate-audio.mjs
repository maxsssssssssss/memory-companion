import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
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
  const options = {
    clean: false,
    force: false,
    listVoices: false,
    voiceA: undefined,
    voiceB: undefined
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--clean") options.clean = true;
    else if (argument === "--force") options.force = true;
    else if (argument === "--list-voices") options.listVoices = true;
    else if (argument === "--voice-a" || argument === "--voice-b") {
      const value = argv[index + 1]?.trim();
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a voice display name`);
      if (argument === "--voice-a") options.voiceA = value;
      else options.voiceB = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
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
    "      $synthesizer = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer",
    "      $synthesizer.Voice = $voice",
    "      $synthesizers[$request.voiceName] = $synthesizer",
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
  if (typeof relativePath !== "string" || relativePath.trim() === "" || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a relative dataset path`);
  }
  const resolved = path.resolve(datasetDir, relativePath);
  if (!isInside(datasetDir, resolved)) throw new Error(`${label} escapes the dataset directory`);
  return resolved;
}

function assertNumber(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
}

function validateManifest(manifest) {
  if (manifest.datasetVersion !== "long-recording-60m-v1") throw new Error("Unexpected datasetVersion");
  if (manifest.recordingDate !== "2026-07-17") throw new Error("recordingDate must be 2026-07-17");
  if (
    manifest.targetDurationSeconds?.min !== 3585 ||
    manifest.targetDurationSeconds?.max !== 3598 ||
    manifest.targetDurationSeconds?.planned !== 3592
  ) {
    throw new Error("target duration must remain 3585-3598 seconds with planned duration 3592 seconds");
  }
  if (manifest.expectedChunkDurationSeconds !== 300 || manifest.expectedChunkCount !== 12) {
    throw new Error("60-minute dataset must plan exactly twelve 300-second chunks");
  }
  if (Math.ceil(manifest.targetDurationSeconds.planned / manifest.expectedChunkDurationSeconds) !== 12) {
    throw new Error("planned duration does not produce exactly twelve chunks");
  }
  if (manifest.utteranceCountRange?.min !== 190 || manifest.utteranceCountRange?.max !== 220) {
    throw new Error("utterance count range must remain 190-220");
  }
  if (
    !Number.isSafeInteger(manifest.sectionUtteranceCountRange?.min) ||
    !Number.isSafeInteger(manifest.sectionUtteranceCountRange?.max) ||
    manifest.sectionUtteranceCountRange.min < 1 ||
    manifest.sectionUtteranceCountRange.max < manifest.sectionUtteranceCountRange.min
  ) {
    throw new Error("section utterance count range is invalid");
  }
  if (!Array.isArray(manifest.sections) || manifest.sections.length !== 12) {
    throw new Error("manifest must contain exactly twelve sections");
  }
  let expectedStart = 0;
  for (const [index, section] of manifest.sections.entries()) {
    if (!SAFE_ID.test(section.id)) throw new Error(`Unsafe section id: ${section.id}`);
    assertNumber(section.startSeconds, `${section.id}.startSeconds`);
    assertNumber(section.endSeconds, `${section.id}.endSeconds`);
    assertNumber(section.targetDurationSeconds, `${section.id}.targetDurationSeconds`);
    if (section.startSeconds !== expectedStart) throw new Error(`${section.id} is not contiguous`);
    if (section.endSeconds - section.startSeconds !== section.targetDurationSeconds) {
      throw new Error(`${section.id} target duration does not match its range`);
    }
    const expectedDuration = index === manifest.sections.length - 1 ? 292 : 300;
    if (section.targetDurationSeconds !== expectedDuration) {
      throw new Error(`${section.id} must be ${expectedDuration} seconds`);
    }
    expectedStart = section.endSeconds;
  }
  if (expectedStart !== 3592) throw new Error("section ranges must end at 3592 seconds");
  const sectionIds = new Set(manifest.sections.map((section) => section.id));
  if (sectionIds.size !== manifest.sections.length) throw new Error("manifest section ids must be unique");
  if (!Array.isArray(manifest.speakers) || manifest.speakers.length !== 2) {
    throw new Error("manifest must define exactly two speakers");
  }
  if (manifest.speakers[0]?.id !== "A" || manifest.speakers[1]?.id !== "B") {
    throw new Error("manifest speakers must be A and B in order");
  }
  for (const speaker of manifest.speakers) {
    if (!speaker.preferredVoice?.trim()) throw new Error(`speaker ${speaker.id} needs a preferred voice`);
  }
  if (manifest.speakers[0].preferredVoice === manifest.speakers[1].preferredVoice) {
    throw new Error("speaker voices must be distinct");
  }
  for (const [field, label] of [
    [manifest.audioFile, "audioFile"],
    [manifest.generationMetadataFile, "generationMetadataFile"],
    [manifest.dialogueFile, "dialogueFile"],
    [manifest.transcriptFile, "transcriptFile"],
    [manifest.expectedResultsFile, "expectedResultsFile"]
  ]) {
    resolveDatasetFile(field, label);
  }
  if (!Array.isArray(manifest.generationConfig?.normalPauseSeconds) || manifest.generationConfig.normalPauseSeconds.length === 0) {
    throw new Error("normalPauseSeconds must be a non-empty array");
  }
  if (manifest.generationConfig.normalPauseSeconds.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("normal pauses must be non-negative numbers");
  }
  if (!Array.isArray(manifest.generationConfig.tempoRange) || manifest.generationConfig.tempoRange.length !== 2) {
    throw new Error("tempoRange must contain min and max");
  }
  if (
    manifest.generationConfig.sampleRate !== 16000 ||
    manifest.generationConfig.channels !== 1 ||
    manifest.generationConfig.codec !== "pcm_s16le"
  ) {
    throw new Error("generation format must remain pcm_s16le, 16kHz, mono");
  }
  if (
    !Number.isFinite(manifest.validationConfig?.durationToleranceSeconds) ||
    manifest.validationConfig.durationToleranceSeconds <= 0
  ) {
    throw new Error("durationToleranceSeconds must be positive");
  }
}

function validateDialogue(dialogue, manifest) {
  if (dialogue.datasetVersion !== manifest.datasetVersion) throw new Error("dialogue/manifest datasetVersion mismatch");
  if (dialogue.language !== "zh-CN") throw new Error("dialogue language must be zh-CN");
  if (!Array.isArray(dialogue.utterances)) throw new Error("dialogue.utterances must be an array");
  const minimum = manifest.utteranceCountRange.min;
  const maximum = manifest.utteranceCountRange.max;
  if (dialogue.utterances.length < minimum || dialogue.utterances.length > maximum) {
    throw new Error(`dialogue must contain ${minimum}-${maximum} utterances`);
  }
  const sectionById = new Map(manifest.sections.map((section, index) => [section.id, { section, index }]));
  const ids = new Set();
  let previousSpeaker = null;
  let previousSectionIndex = -1;
  for (const utterance of dialogue.utterances) {
    if (!SAFE_ID.test(utterance.utteranceId ?? "")) throw new Error(`Unsafe utteranceId: ${utterance.utteranceId}`);
    if (ids.has(utterance.utteranceId)) throw new Error(`Duplicate utteranceId: ${utterance.utteranceId}`);
    ids.add(utterance.utteranceId);
    if (utterance.speaker !== "A" && utterance.speaker !== "B") {
      throw new Error(`${utterance.utteranceId} has invalid speaker`);
    }
    if (utterance.speaker === previousSpeaker) throw new Error(`${utterance.utteranceId} must alternate speaker`);
    previousSpeaker = utterance.speaker;
    if (typeof utterance.text !== "string" || !/[\p{Script=Han}]/u.test(utterance.text)) {
      throw new Error(`${utterance.utteranceId} must contain Chinese text`);
    }
    if (FORBIDDEN_LEGACY_STORY.test(utterance.text)) {
      throw new Error(`${utterance.utteranceId} reuses a forbidden legacy story topic`);
    }
    if (FORBIDDEN_VERDICT.test(utterance.text)) {
      throw new Error(`${utterance.utteranceId} contains forbidden verdict language`);
    }
    const entry = sectionById.get(utterance.section);
    if (!entry) throw new Error(`${utterance.utteranceId} has unknown section`);
    if (entry.index < previousSectionIndex) throw new Error(`${utterance.utteranceId} moves sections backwards`);
    previousSectionIndex = entry.index;
    if (
      !Array.isArray(utterance.expectedStartRange) ||
      utterance.expectedStartRange.length !== 2 ||
      utterance.expectedStartRange[0] !== entry.section.startSeconds ||
      utterance.expectedStartRange[1] !== entry.section.endSeconds
    ) {
      throw new Error(`${utterance.utteranceId} expectedStartRange does not match its section`);
    }
    if (
      !Array.isArray(utterance.tags) ||
      utterance.tags.length === 0 ||
      utterance.tags.some((tag) => typeof tag !== "string" || !SAFE_ID.test(tag))
    ) {
      throw new Error(`${utterance.utteranceId} needs safe non-empty tags`);
    }
  }
  for (const section of manifest.sections) {
    const count = dialogue.utterances.filter((utterance) => utterance.section === section.id).length;
    if (count < manifest.sectionUtteranceCountRange.min || count > manifest.sectionUtteranceCountRange.max) {
      throw new Error(
        `${section.id} must contain ${manifest.sectionUtteranceCountRange.min}-${manifest.sectionUtteranceCountRange.max} utterances`
      );
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

function concatBody(filePaths) {
  return filePaths
    .map((filePath) => `file '${filePath.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`)
    .join("\n");
}

async function normalizeUtterance(input, manifest) {
  await run(ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", input.sourcePath,
    "-af",
    `atempo=${input.tempo.toFixed(8)},loudnorm=I=${manifest.generationConfig.loudnessTargetLufs}:TP=${manifest.generationConfig.truePeakDb}:LRA=7,apad=pad_dur=${input.pauseSeconds.toFixed(3)}`,
    "-ar", String(manifest.generationConfig.sampleRate),
    "-ac", String(manifest.generationConfig.channels),
    "-c:a", manifest.generationConfig.codec,
    input.outputPath
  ]);
}

async function buildSection(section, utterances, requests, tempDir, manifest) {
  const pauses = utterances.map((_, index) => {
    if (index === utterances.length - 1) return manifest.generationConfig.sectionTransitionPauseSeconds;
    const values = manifest.generationConfig.normalPauseSeconds;
    return values[index % values.length];
  });
  const rawDurations = [];
  for (const utterance of utterances) {
    rawDurations.push((await probeAudio(requests.get(utterance.utteranceId).outputPath)).durationSeconds);
  }
  const rawSpeechSeconds = rawDurations.reduce((sum, value) => sum + value, 0);
  const pauseSeconds = pauses.reduce((sum, value) => sum + value, 0);
  const targetSpeechSeconds = section.targetDurationSeconds - pauseSeconds;
  if (targetSpeechSeconds <= 0) throw new Error(`${section.id} pauses consume the entire section`);
  const tempo = rawSpeechSeconds / targetSpeechSeconds;
  const [minimumTempo, maximumTempo] = manifest.generationConfig.tempoRange;
  if (tempo < minimumTempo || tempo > maximumTempo) {
    throw new Error(
      `${section.id} requires atempo=${tempo.toFixed(3)}, outside ${minimumTempo}-${maximumTempo}; adjust dialogue instead of padding with long silence`
    );
  }

  const normalizedFiles = [];
  for (const [index, utterance] of utterances.entries()) {
    const normalizedPath = path.join(tempDir, `${utterance.utteranceId}-normalized.wav`);
    await normalizeUtterance({
      sourcePath: requests.get(utterance.utteranceId).outputPath,
      outputPath: normalizedPath,
      tempo,
      pauseSeconds: pauses[index]
    }, manifest);
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
    throw new Error(`${section.id} duration ${finalProbe.durationSeconds} does not match target`);
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

async function atomicWriteFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    await fs.writeFile(temporaryPath, value, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function removeKnownOutputs(outputPath, metadataPath, audioDir) {
  await Promise.all([fs.rm(outputPath, { force: true }), fs.rm(metadataPath, { force: true })]);
  const entries = await fs.readdir(audioDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(".publish-"))
      .map((entry) => fs.rm(path.join(audioDir, entry.name), { recursive: true, force: true }))
  );
}

async function firstVersionLine(command) {
  const { stdout, stderr } = await run(command, ["-version"]);
  return (stdout || stderr).split(/\r?\n/u)[0]?.trim() ?? "unknown";
}

async function powerShellVersion() {
  if (process.platform !== "win32") return "not_available";
  const { stdout } = await runPowerShell(
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $PSVersionTable.PSVersion.ToString()"
  );
  return stdout.trim() || "unknown";
}

async function inputHashes(manifest, dialogue, transcript) {
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

async function existingOutputState(outputPath, metadataPath, hashes) {
  const outputExists = await fs.access(outputPath).then(() => true).catch(() => false);
  if (!outputExists) return "missing";
  const metadata = await readJson(metadataPath, "generation metadata").catch(() => null);
  if (!metadata?.inputHashes) return "stale_missing_metadata";
  return Object.entries(hashes).every(([key, value]) => metadata.inputHashes[key] === value)
    ? "current"
    : "stale_input_hash";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await readJson(manifestPath, "manifest");
  validateManifest(manifest);
  const voices = await listLocalVoices();
  if (options.listVoices) {
    console.log(JSON.stringify({ voices }, null, 2));
    return;
  }
  if (process.platform !== "win32") throw new Error("Windows OneCore TTS is required for generation");
  if (!ffmpegPath || !ffprobeStatic?.path) throw new Error("ffmpeg-static and ffprobe-static are required");

  const audioDir = path.dirname(resolveDatasetFile(manifest.audioFile, "audioFile"));
  const outputPath = resolveDatasetFile(manifest.audioFile, "audioFile");
  const metadataPath = resolveDatasetFile(manifest.generationMetadataFile, "generationMetadataFile");
  const transcriptPath = resolveDatasetFile(manifest.transcriptFile, "transcriptFile");
  await fs.mkdir(audioDir, { recursive: true });
  if (options.clean) {
    await removeKnownOutputs(outputPath, metadataPath, audioDir);
    if (!options.force) {
      console.log(JSON.stringify({ ok: true, cleaned: [manifest.audioFile, manifest.generationMetadataFile] }, null, 2));
      return;
    }
  }

  const dialogue = await readJson(resolveDatasetFile(manifest.dialogueFile, "dialogueFile"), "dialogue");
  validateDialogue(dialogue, manifest);
  const transcript = derivedDialogueText(dialogue);
  const hashes = await inputHashes(manifest, dialogue, transcript);
  const outputState = await existingOutputState(outputPath, metadataPath, hashes);
  if (outputState !== "missing" && !options.force) {
    throw new Error(
      outputState === "current"
        ? "Audio already exists for the current inputs; use --force or --clean --force"
        : "Existing audio is stale for the current inputs; use --clean --force"
    );
  }

  const environmentVoiceA = process.env.LONG_RECORDING_60M_VOICE_A?.trim();
  const environmentVoiceB = process.env.LONG_RECORDING_60M_VOICE_B?.trim();
  const preferredA = options.voiceA ?? (environmentVoiceA || manifest.speakers[0].preferredVoice);
  const preferredB = options.voiceB ?? (environmentVoiceB || manifest.speakers[1].preferredVoice);
  const chineseVoices = voices.filter((voice) => voice.language?.toLowerCase() === "zh-cn");
  const voiceA = chineseVoices.find((voice) => voice.displayName === preferredA);
  const voiceB = chineseVoices.find((voice) => voice.displayName === preferredB);
  if (!voiceA || !voiceB || voiceA.displayName === voiceB.displayName) {
    throw new Error(
      `Two distinct zh-CN voices are required. Requested A=${preferredA}, B=${preferredB}. Detected: ${chineseVoices.map((voice) => voice.displayName).join(", ") || "none"}`
    );
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "long-recording-60m-v1-"));
  const publishDir = await fs.mkdtemp(path.join(audioDir, ".publish-"));
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
      sectionResults.push(await buildSection(section, utterances, requestById, tempDir, manifest));
    }

    const concatPath = path.join(tempDir, "all-sections.txt");
    const stagedAudioPath = path.join(publishDir, path.basename(outputPath));
    await fs.writeFile(concatPath, concatBody(sectionResults.map((result) => result.sectionPath)), "utf8");
    await run(ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "concat", "-safe", "0", "-i", concatPath,
      "-ar", String(manifest.generationConfig.sampleRate),
      "-ac", String(manifest.generationConfig.channels),
      "-c:a", manifest.generationConfig.codec,
      stagedAudioPath
    ]);
    const probe = await probeAudio(stagedAudioPath);
    if (
      probe.durationSeconds < manifest.targetDurationSeconds.min ||
      probe.durationSeconds > manifest.targetDurationSeconds.max ||
      Math.abs(probe.durationSeconds - manifest.targetDurationSeconds.planned) >
        manifest.validationConfig.durationToleranceSeconds
    ) {
      throw new Error(`Final duration ${probe.durationSeconds}s does not match the 3592-second plan`);
    }
    if (
      probe.codec !== manifest.generationConfig.codec ||
      probe.sampleRate !== manifest.generationConfig.sampleRate ||
      probe.channels !== manifest.generationConfig.channels
    ) {
      throw new Error("Generated audio format does not match manifest generationConfig");
    }

    const metadata = {
      datasetVersion: manifest.datasetVersion,
      generatedAt: new Date().toISOString(),
      inputHashes: hashes,
      tools: {
        node: process.version,
        platform: `${process.platform}-${os.release()}-${process.arch}`,
        powershell: await powerShellVersion(),
        ffmpeg: await firstVersionLine(ffmpegPath),
        ffprobe: await firstVersionLine(ffprobeStatic.path)
      },
      voices: { A: voiceA, B: voiceB },
      utteranceCount: dialogue.utterances.length,
      sections: sectionResults.map(({ sectionPath: _sectionPath, ...result }) => result),
      audio: {
        file: manifest.audioFile,
        ...probe,
        sha256: await sha256File(stagedAudioPath)
      }
    };
    const stagedMetadataPath = path.join(publishDir, path.basename(metadataPath));
    await fs.writeFile(stagedMetadataPath, JSON.stringify(metadata, null, 2), { encoding: "utf8", flag: "wx" });

    // The audio and metadata are staged on the destination filesystem. Metadata is
    // published last and acts as the commit marker; validation rejects mixed generations.
    await fs.rename(stagedAudioPath, outputPath);
    await atomicWriteFile(transcriptPath, transcript);
    await fs.rename(stagedMetadataPath, metadataPath);
    console.log(JSON.stringify({ ok: true, ...metadata }, null, 2));
  } finally {
    await Promise.all([
      fs.rm(tempDir, { recursive: true, force: true }),
      fs.rm(publishDir, { recursive: true, force: true })
    ]);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exitCode = 1;
});

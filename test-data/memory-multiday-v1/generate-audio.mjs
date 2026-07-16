import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const datasetDir = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(datasetDir, "manifest.json");
const audioDir = path.join(datasetDir, "audio");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const silencePatternSeconds = [0.9, 1.1, 1.0, 1.3, 0.8, 1.2];

function parseArgs(argv) {
  const options = {
    clean: false,
    force: false,
    listVoices: false,
    voiceA: process.env.MEMORY_DATASET_VOICE_A?.trim() || "Microsoft Yaoyao",
    voiceB: process.env.MEMORY_DATASET_VOICE_B?.trim() || "Microsoft Kangkang",
    sessionIds: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--clean") {
      options.clean = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--list-voices") {
      options.listVoices = true;
    } else if (arg === "--voice-a") {
      options.voiceA = next;
      index += 1;
    } else if (arg === "--voice-b") {
      options.voiceB = next;
      index += 1;
    } else if (arg === "--session") {
      options.sessionIds.push(next);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
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
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${path.basename(command)} exited with ${code}: ${stderr || stdout}`));
    });
  });
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function runPowerShell(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded
  ]);
}

async function listLocalVoices() {
  if (process.platform !== "win32") {
    return [];
  }
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

function parseTranscript(text, transcriptFile) {
  const utterances = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const match = /^([AB]):\s*(.+)$/u.exec(line);
      if (!match) {
        throw new Error(`${transcriptFile}:${index + 1} must use \"A: text\" or \"B: text\"`);
      }
      return { speaker: match[1], text: match[2] };
    });

  if (utterances.length < 8 || utterances.length > 14) {
    throw new Error(`${transcriptFile} must contain 8-14 utterances; found ${utterances.length}`);
  }
  for (let index = 1; index < utterances.length; index += 1) {
    if (utterances[index].speaker === utterances[index - 1].speaker) {
      throw new Error(`${transcriptFile} must alternate speakers at line ${index + 1}`);
    }
  }
  return utterances;
}

function assertDatasetAudioPath(relativePath) {
  const resolved = path.resolve(datasetDir, relativePath);
  const relativeToAudio = path.relative(audioDir, resolved);
  if (relativeToAudio.startsWith("..") || path.isAbsolute(relativeToAudio)) {
    throw new Error(`Audio path escapes dataset audio directory: ${relativePath}`);
  }
  return resolved;
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
    "    $synthesizer = $synthesizers[$request.voiceName]",
    "    $stream = Await-Result ($synthesizer.SynthesizeTextToStreamAsync([string]$request.text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])",
    "    $inputStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)",
    "    $outputStream = [System.IO.File]::Create([string]$request.outputPath)",
    "    try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose(); $stream.Dispose() }",
    "  }",
    "} finally {",
    "  foreach ($synthesizer in $synthesizers.Values) { $synthesizer.Dispose() }",
    "}"
  ].join("\n");
  await runPowerShell(script);
}

async function probeAudio(filePath) {
  const { stdout } = await run(ffprobeStatic.path, [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_name,sample_rate,channels",
    "-of",
    "json",
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

async function cleanGeneratedAudio(sessions) {
  for (const session of sessions) {
    await fs.rm(assertDatasetAudioPath(session.audioFile), { force: true });
  }
}

async function synthesizeSession(session, voices) {
  const outputPath = assertDatasetAudioPath(session.audioFile);
  const exists = await fs.access(outputPath).then(() => true).catch(() => false);
  if (exists && !voices.force) {
    return { sessionId: session.sessionId, status: "skipped", file: session.audioFile, ...(await probeAudio(outputPath)) };
  }

  const transcriptPath = path.resolve(datasetDir, session.transcriptFile);
  const utterances = parseTranscript(await fs.readFile(transcriptPath, "utf8"), session.transcriptFile);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `${session.sessionId}-`));
  try {
    const requests = utterances.map((utterance, index) => ({
      text: utterance.text,
      voiceName: utterance.speaker === "A" ? voices.voiceA : voices.voiceB,
      outputPath: path.join(tempDir, `raw-${String(index + 1).padStart(2, "0")}.wav`)
    }));
    await synthesizeRawUtterances(requests, path.join(tempDir, "requests.json"));

    const normalizedFiles = [];
    for (const [index, request] of requests.entries()) {
      const normalizedPath = path.join(tempDir, `normalized-${String(index + 1).padStart(2, "0")}.wav`);
      const silenceSeconds = silencePatternSeconds[index % silencePatternSeconds.length];
      await run(ffmpegPath, [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        request.outputPath,
        "-af",
        `loudnorm=I=-20:TP=-3:LRA=7,apad=pad_dur=${silenceSeconds}`,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        normalizedPath
      ]);
      normalizedFiles.push(normalizedPath);
    }

    const concatPath = path.join(tempDir, "concat.txt");
    const concatBody = normalizedFiles
      .map((filePath) => `file '${filePath.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`)
      .join("\n");
    await fs.writeFile(concatPath, concatBody, "utf8");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await run(ffmpegPath, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatPath,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      outputPath
    ]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  const probe = await probeAudio(outputPath);
  if (probe.durationSeconds < 90 || probe.durationSeconds > 150) {
    throw new Error(`${session.sessionId} duration ${probe.durationSeconds}s is outside the required 90-150s range`);
  }
  if (probe.codec !== "pcm_s16le" || probe.sampleRate !== 16000 || probe.channels !== 1) {
    throw new Error(`${session.sessionId} has unexpected audio format: ${JSON.stringify(probe)}`);
  }
  return { sessionId: session.sessionId, status: "written", file: session.audioFile, ...probe };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const voices = await listLocalVoices();
  if (options.listVoices) {
    console.log(JSON.stringify({ voices }, null, 2));
    return;
  }
  if (process.platform !== "win32") {
    throw new Error("This deterministic generator requires Windows OneCore TTS. Use --list-voices on a Windows machine or provide equivalent local voices.");
  }
  if (!ffmpegPath || !ffprobeStatic?.path) {
    throw new Error("ffmpeg-static and ffprobe-static are required");
  }

  const selectedSessions = options.sessionIds.length > 0
    ? options.sessionIds.map((sessionId) => {
        const session = manifest.sessions.find((item) => item.sessionId === sessionId);
        if (!session) throw new Error(`Unknown session: ${sessionId}`);
        return session;
      })
    : manifest.sessions;

  if (options.clean) {
    await cleanGeneratedAudio(selectedSessions);
    if (!options.force) {
      console.log(JSON.stringify({ ok: true, cleaned: selectedSessions.map((session) => session.audioFile) }, null, 2));
      return;
    }
  }

  const chineseVoices = voices.filter((voice) => voice.language?.toLowerCase() === "zh-cn");
  const voiceA = chineseVoices.find((voice) => voice.displayName === options.voiceA);
  const voiceB = chineseVoices.find((voice) => voice.displayName === options.voiceB);
  if (!voiceA || !voiceB || voiceA.displayName === voiceB.displayName) {
    throw new Error(
      `Two distinct zh-CN voices are required. Requested A=${options.voiceA}, B=${options.voiceB}. ` +
      `Detected: ${chineseVoices.map((voice) => voice.displayName).join(", ") || "none"}`
    );
  }

  const results = [];
  for (const session of selectedSessions) {
    results.push(await synthesizeSession(session, { voiceA: voiceA.displayName, voiceB: voiceB.displayName, force: options.force }));
  }
  console.log(JSON.stringify({
    ok: true,
    datasetVersion: manifest.datasetVersion,
    voices: { A: voiceA, B: voiceB },
    results
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});

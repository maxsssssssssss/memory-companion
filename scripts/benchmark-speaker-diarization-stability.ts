import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import ffmpegPath from "ffmpeg-static";

import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";
import {
  buildStandaloneDiarizationSentences,
  parseCombinedAsrSpeakerLabels,
  parseStandaloneDiarizationLabels,
  type StandaloneDiarizationSentence
} from "@/lib/server/evaluation/voiceprint-diarization";
import {
  buildSpeakerDiarizationBenchmarkMatrix,
  classifySpeakerDiarizationFailure,
  summarizeSpeakerDiarizationBenchmark,
  type SpeakerDiarizationBenchmarkCase,
  type SpeakerDiarizationFailureCategory,
  type SpeakerDiarizationStageResult,
  type SpeakerDiarizationTrialResult
} from "@/lib/server/evaluation/speaker-diarization-stability";

const REMOTE_GATE = "RUN_SPEAKER_DIARIZATION_REMOTE_VERIFY";
const REPORT_ROOT = resolve(
  ".data",
  "evaluation",
  "speaker-diarization-stability-v1"
);
const ASR_TIMEOUT_MS = 180_000;
const SPEAKER_GRACE_MS = 30_000;
const STANDALONE_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 2_000;
const TRIAL_COOLDOWN_MS = 2_000;
const RESPONSE_LIMIT_BYTES = 512 * 1024;
const AUDIO_FORMAT = "pcm_s16le/16000Hz/mono" as const;
const SAFE_LABEL = /^speaker_\d+$/u;
const TEMP_PREFIX = "daily-brief-diarization-benchmark-";

const allowedProviderPath = /^\/api\/ai\/non-realtime-(?:asr|speaker-diarization)(?:\/query\?reqid=[A-Za-z0-9%_-]+)?$/u;

type SyntheticVoice = "A" | "B";
type SyntheticUtterance = { voice: SyntheticVoice; text: string };
type BenchmarkAudio = {
  durationSeconds: 30 | 45 | 60 | 70 | 90;
  path: string;
  actualDurationMs: number;
};

type AsrPayload = {
  code?: number;
  data?: {
    asr_result?: {
      sentences?: Array<{
        text?: string;
        timestamp?: Array<{ start?: number; end?: number }>;
        timestamps?:
          | Array<{ start?: number; end?: number }>
          | { start?: number; end?: number };
      }>;
    };
    speaker_result?: Array<{ speaker?: string; text?: string }>;
  };
};

type StandalonePayload = {
  code?: number;
  data?: {
    result?: Array<{ speaker?: string; text?: string }>;
  };
};

type StageWorkingResult = {
  stage: SpeakerDiarizationStageResult;
  asrSuccess: boolean;
  payload?: AsrPayload;
  recordId?: string;
};

type CleanupState = {
  audioRemoved: boolean;
  serverStopped: boolean;
  tunnelStopped: boolean;
};

class BenchmarkFailure extends Error {
  constructor(
    readonly category: string,
    readonly partial?: Partial<SpeakerDiarizationStageResult>
  ) {
    super(category);
    this.name = "BenchmarkFailure";
  }
}

const utterances: SyntheticUtterance[] = [
  { voice: "A", text: "今天河边的风很轻。" },
  { voice: "B", text: "远处的小船慢慢经过。" },
  { voice: "A", text: "树叶在阳光下很亮。" },
  { voice: "B", text: "桥边有人安静散步。" },
  { voice: "A", text: "水面留下细细波纹。" },
  { voice: "B", text: "岸边开着几朵小花。" },
  { voice: "A", text: "我们沿着小路向前走。" },
  { voice: "B", text: "路旁的长椅刚晒暖。" },
  { voice: "A", text: "前面的天空很清澈。" },
  { voice: "B", text: "偶尔能听见几声鸟叫。" },
  { voice: "A", text: "转弯处有一排绿树。" },
  { voice: "B", text: "树荫下面格外凉快。" },
  { voice: "A", text: "远处的云移动得很慢。" },
  { voice: "B", text: "我们在桥头停了一会儿。" },
  { voice: "A", text: "回去时阳光更加柔和。" },
  { voice: "B", text: "街边的灯也刚刚亮起。" },
  { voice: "A", text: "今天这段路走得很舒服。" },
  { voice: "B", text: "下次还可以再来看看。" }
];

const voiceNames: Record<SyntheticVoice, string> = {
  A: "Microsoft Yaoyao",
  B: "Microsoft Kangkang"
};

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(delayMs: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

function safeLabel(value: string) {
  const normalized = value.normalize("NFKC").trim();
  return SAFE_LABEL.test(normalized) ? normalized : "<opaque>";
}

function stageNotAttempted(reason: string): SpeakerDiarizationStageResult {
  return {
    attempted: false,
    success: false,
    queryCount: 0,
    totalLatencyMs: 0,
    providerCodes: [],
    terminalReason: reason,
    speakerResultExists: false,
    speakerCount: 0,
    labels: []
  };
}

function safeFailure(error: unknown) {
  if (error instanceof BenchmarkFailure) return error.category;
  if (error instanceof Error && error.name === "AbortError") return "timeout";
  if (error instanceof TypeError) return "network_error";
  return "unknown_failure";
}

function providerCodeCategory(code: number | undefined) {
  return `provider_code_${typeof code === "number" ? code : "missing"}`;
}

function runProcess(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>(
    (resolvePromise, reject) => {
      const child = spawn(command, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolvePromise({ stdout, stderr });
        else reject(new BenchmarkFailure("local_process_failure"));
      });
    }
  );
}

function quotePowerShell(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function synthesizeRaw(
  requests: Array<{ voiceName: string; text: string; outputPath: string }>,
  requestPath: string
) {
  await writeFile(requestPath, JSON.stringify(requests), {
    encoding: "utf8",
    mode: 0o600
  });
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
    "$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime]",
    "$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1",
    "function Await-Result($operation, [Type]$resultType) { $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation)); $task.Wait(); return $task.Result }",
    `$requests = Get-Content -LiteralPath ${quotePowerShell(requestPath)} -Raw -Encoding UTF8 | ConvertFrom-Json`,
    "$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices",
    "$synths = @{}",
    "try {",
    "  foreach ($request in @($requests)) {",
    "    $voice = $voices | Where-Object { $_.DisplayName -eq $request.voiceName } | Select-Object -First 1",
    "    if (-not $voice) { throw 'Required synthetic voice is unavailable' }",
    "    if (-not $synths.ContainsKey($request.voiceName)) { $s = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer; $s.Voice = $voice; $synths[$request.voiceName] = $s }",
    "    $stream = Await-Result ($synths[$request.voiceName].SynthesizeTextToStreamAsync([string]$request.text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])",
    "    $input = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)",
    "    $output = [System.IO.File]::Create([string]$request.outputPath)",
    "    try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose(); $stream.Dispose() }",
    "  }",
    "} finally { foreach ($s in $synths.Values) { $s.Dispose() } }"
  ].join("\n");
  await runProcess("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")
  ]);
}

function wavMetadata(buffer: Buffer) {
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new BenchmarkFailure("invalid_generated_wav");
  }
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  let cursor = 12;
  let dataBytes = 0;
  while (cursor + 8 <= buffer.length) {
    const id = buffer.toString("ascii", cursor, cursor + 4);
    const size = buffer.readUInt32LE(cursor + 4);
    if (id === "data") {
      dataBytes = size;
      break;
    }
    cursor += 8 + size + (size % 2);
  }
  if (
    channels !== 1 ||
    sampleRate !== 16_000 ||
    bitsPerSample !== 16 ||
    dataBytes <= 0
  ) {
    throw new BenchmarkFailure("invalid_generated_wav_format");
  }
  return {
    durationMs: Math.round(
      (dataBytes / (sampleRate * channels * (bitsPerSample / 8))) * 1_000
    )
  };
}

async function generateBenchmarkAudio(tempRoot: string) {
  if (!ffmpegPath) throw new BenchmarkFailure("ffmpeg_unavailable");
  const requests = utterances.map((utterance, index) => ({
    voiceName: voiceNames[utterance.voice],
    text: utterance.text,
    outputPath: join(tempRoot, `raw-${index}.wav`)
  }));
  await synthesizeRaw(requests, join(tempRoot, "tts-requests.json"));

  const slots: string[] = [];
  for (let index = 0; index < requests.length; index += 1) {
    const slotPath = join(tempRoot, `slot-${index}.wav`);
    await runProcess(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      requests[index].outputPath,
      "-af",
      "apad=whole_dur=5,atrim=duration=5",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      slotPath
    ]);
    slots.push(slotPath);
  }

  const concatList = join(tempRoot, "concat.txt");
  await writeFile(
    concatList,
    slots
      .map((path) => `file '${path.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`)
      .join("\n"),
    { encoding: "utf8", mode: 0o600 }
  );
  const masterPath = join(tempRoot, "master-90s.wav");
  await runProcess(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatList,
    "-c:a",
    "pcm_s16le",
    masterPath
  ]);

  const durations = [30, 45, 60, 70, 90] as const;
  const output = new Map<number, BenchmarkAudio>();
  for (const durationSeconds of durations) {
    const path = join(tempRoot, `benchmark-${durationSeconds}s.wav`);
    await runProcess(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      masterPath,
      "-t",
      String(durationSeconds),
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      path
    ]);
    const metadata = wavMetadata(await readFile(path));
    if (Math.abs(metadata.durationMs - durationSeconds * 1_000) > 50) {
      throw new BenchmarkFailure("generated_duration_mismatch");
    }
    output.set(durationSeconds, {
      durationSeconds,
      path,
      actualDurationMs: metadata.durationMs
    });
  }
  return output;
}

async function startAudioServer(
  audios: Map<number, BenchmarkAudio>,
  matrix: SpeakerDiarizationBenchmarkCase[]
) {
  const healthPath = `/health-${randomBytes(16).toString("hex")}`;
  const routes = new Map<string, string>();
  for (const benchmarkCase of matrix) {
    const audio = audios.get(benchmarkCase.durationSeconds);
    if (!audio) throw new BenchmarkFailure("audio_fixture_missing");
    routes.set(
      `/audio-${randomBytes(24).toString("hex")}.wav`,
      audio.path
    );
  }
  const pathsByCase = new Map(
    matrix.map((benchmarkCase, index) => [
      benchmarkCase.caseId,
      [...routes.keys()][index]
    ])
  );

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === healthPath) {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("ok");
      return;
    }
    const path = routes.get(pathname);
    if (!path) {
      response.writeHead(404);
      response.end();
      return;
    }
    void stat(path)
      .then((metadata) => {
        response.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": String(metadata.size),
          "Cache-Control": "no-store"
        });
        createReadStream(path).pipe(response);
      })
      .catch(() => {
        response.writeHead(404);
        response.end();
      });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new BenchmarkFailure("audio_server_failed");
  }
  return { server, port: address.port, healthPath, pathsByCase };
}

async function startTunnel(port: number) {
  const command =
    process.env.CLOUDFLARED_BIN?.trim() || "C:\\tmp\\cloudflared.exe";
  const child = spawn(
    command,
    [
      "tunnel",
      "--no-autoupdate",
      "--protocol",
      "quic",
      "--url",
      `http://127.0.0.1:${port}`
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  let output = "";
  let spawnFailed = false;
  child.once("error", () => {
    spawnFailed = true;
  });
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu);
    if (match) return { child, publicBase: match[0] };
    if (spawnFailed) throw new BenchmarkFailure("tunnel_spawn_failed");
    if (child.exitCode !== null) throw new BenchmarkFailure("tunnel_exited");
    await sleep(250);
  }
  child.kill();
  throw new BenchmarkFailure("tunnel_start_timeout");
}

async function closeServer(server: Server | undefined) {
  if (!server) return true;
  try {
    server.closeAllConnections();
    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolvePromise();
      });
    });
    return !server.listening;
  } catch {
    return false;
  }
}

async function stopChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return true;
  child.kill();
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 5_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
  if (child.exitCode === null && child.pid) {
    await runProcess("taskkill.exe", [
      "/PID",
      String(child.pid),
      "/T",
      "/F"
    ]).catch(() => undefined);
    for (
      let attempt = 0;
      attempt < 20 && child.exitCode === null;
      attempt += 1
    ) {
      await sleep(100);
    }
  }
  if (child.exitCode !== null) return true;
  if (!child.pid) return false;
  try {
    process.kill(child.pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function boundedJson<T>(response: Response): Promise<T> {
  if (!response.body) return {} as T;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RESPONSE_LIMIT_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BenchmarkFailure("invalid_response_too_large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } catch {
    throw new BenchmarkFailure("invalid_response_json");
  }
}

async function fetchProviderJson<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit
) {
  if (!allowedProviderPath.test(path) || path.includes("voiceprint")) {
    throw new BenchmarkFailure("provider_path_not_allowed");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: controller.signal
    });
    const payload = await boundedJson<T>(response);
    if (!response.ok) {
      throw new BenchmarkFailure(`http_${response.status}`);
    }
    return { payload, httpStatus: response.status };
  } catch (error) {
    if (controller.signal.aborted) throw new BenchmarkFailure("request_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function appendCode(
  codes: Array<number | "missing">,
  payload: { code?: number }
) {
  if (codes.length >= 128) return;
  codes.push(typeof payload.code === "number" ? payload.code : "missing");
}

function labelsFromCombined(payload: AsrPayload) {
  const parsed = parseCombinedAsrSpeakerLabels(payload);
  return {
    rawCount: parsed.labels.length,
    labels: parsed.labels.map(safeLabel)
  };
}

function labelsFromStandalone(payload: StandalonePayload) {
  const parsed = parseStandaloneDiarizationLabels(payload);
  return {
    rawCount: parsed.labels.length,
    labels: parsed.labels.map(safeLabel)
  };
}

function completeStage(input: {
  startedAt: number;
  queryCount: number;
  providerCodes: Array<number | "missing">;
  terminalReason: string;
  labels: { rawCount: number; labels: string[] };
  failureCategory?: SpeakerDiarizationFailureCategory;
  attempted?: boolean;
}) {
  const success = input.labels.rawCount === 2 && !input.failureCategory;
  return {
    attempted: input.attempted ?? true,
    success,
    queryCount: input.queryCount,
    totalLatencyMs: Date.now() - input.startedAt,
    providerCodes: input.providerCodes,
    terminalReason: input.terminalReason,
    speakerResultExists: input.labels.rawCount > 0,
    speakerCount: input.labels.rawCount,
    labels: input.labels.labels,
    ...(input.failureCategory ? { failureCategory: input.failureCategory } : {})
  } satisfies SpeakerDiarizationStageResult;
}

async function runCombined(input: {
  baseUrl: string;
  audioUrl: string;
  userId: string;
  benchmarkCase: SpeakerDiarizationBenchmarkCase;
}): Promise<StageWorkingResult> {
  const startedAt = Date.now();
  const providerCodes: Array<number | "missing"> = [];
  let queryCount = 0;
  let payload: AsrPayload | undefined;
  const reqId = `dia_bench_asr_${randomUUID().replaceAll("-", "")}`;
  const recordId = `dia_bench_record_${randomUUID().replaceAll("-", "")}`;
  let firstAsrReadyAt: number | undefined;

  try {
    const submit = await fetchProviderJson<AsrPayload>(
      input.baseUrl,
      "/api/ai/non-realtime-asr",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          req_id: reqId,
          audio_url: input.audioUrl,
          record_id: recordId,
          user_id: input.userId,
          language: ["cn"],
          speaker: input.benchmarkCase.speakerParameter
        })
      }
    );
    payload = submit.payload;
    appendCode(providerCodes, payload);

    while (true) {
      if (payload.code !== 0 && payload.code !== 2) {
        throw new BenchmarkFailure(providerCodeCategory(payload.code));
      }
      const labels = labelsFromCombined(payload);
      const hasAsr = Boolean(payload.data?.asr_result?.sentences?.length);
      if (payload.code === 0 && hasAsr) firstAsrReadyAt ??= Date.now();
      if (payload.code === 0 && labels.rawCount > 0) {
        const failureCategory =
          labels.rawCount === 2 ? undefined : "unexpected_speaker_count";
        return {
          stage: completeStage({
            startedAt,
            queryCount,
            providerCodes,
            terminalReason:
              labels.rawCount === 2
                ? "speaker_result"
                : "unexpected_speaker_count",
            labels,
            ...(failureCategory ? { failureCategory } : {})
          }),
          asrSuccess: hasAsr,
          payload,
          recordId
        };
      }
      if (
        firstAsrReadyAt &&
        Date.now() - firstAsrReadyAt >= SPEAKER_GRACE_MS
      ) {
        return {
          stage: completeStage({
            startedAt,
            queryCount,
            providerCodes,
            terminalReason: "speaker_grace_timeout",
            labels,
            failureCategory: "empty_speaker_result"
          }),
          asrSuccess: true,
          payload,
          recordId
        };
      }
      if (Date.now() - startedAt >= ASR_TIMEOUT_MS) {
        const category: SpeakerDiarizationFailureCategory = hasAsr
          ? "empty_speaker_result"
          : "timeout";
        return {
          stage: completeStage({
            startedAt,
            queryCount,
            providerCodes,
            terminalReason: hasAsr
              ? "timeout_waiting_for_speaker_result"
              : "timeout_without_asr_result",
            labels,
            failureCategory: category
          }),
          asrSuccess: hasAsr,
          payload,
          recordId
        };
      }
      await sleep(POLL_INTERVAL_MS);
      const query = await fetchProviderJson<AsrPayload>(
        input.baseUrl,
        `/api/ai/non-realtime-asr/query?reqid=${encodeURIComponent(reqId)}`
      );
      payload = query.payload;
      queryCount += 1;
      appendCode(providerCodes, payload);
    }
  } catch (error) {
    const category = classifySpeakerDiarizationFailure(safeFailure(error));
    const labels = payload
      ? labelsFromCombined(payload)
      : { rawCount: 0, labels: [] };
    return {
      stage: completeStage({
        startedAt,
        queryCount,
        providerCodes,
        terminalReason: safeFailure(error),
        labels,
        failureCategory: category
      }),
      asrSuccess: Boolean(payload?.data?.asr_result?.sentences?.length),
      ...(payload ? { payload } : {}),
      recordId
    };
  }
}

async function runStandalone(input: {
  baseUrl: string;
  audioUrl: string;
  userId: string;
  recordId: string;
  speakerParameter: 0 | 2;
  sentences: StandaloneDiarizationSentence[];
}) {
  const startedAt = Date.now();
  const providerCodes: Array<number | "missing"> = [];
  let queryCount = 0;
  let payload: StandalonePayload | undefined;
  const reqId = `dia_bench_standalone_${randomUUID().replaceAll("-", "")}`;
  try {
    const submit = await fetchProviderJson<StandalonePayload>(
      input.baseUrl,
      "/api/ai/non-realtime-speaker-diarization",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          req_id: reqId,
          audio_url: input.audioUrl,
          record_id: input.recordId,
          user_id: input.userId,
          speaker: input.speakerParameter,
          sentences: input.sentences
        })
      }
    );
    payload = submit.payload;
    appendCode(providerCodes, payload);
    while (true) {
      if (payload.code !== 0 && payload.code !== 2) {
        throw new BenchmarkFailure(providerCodeCategory(payload.code));
      }
      const labels = labelsFromStandalone(payload);
      if (payload.code === 0 && labels.rawCount > 0) {
        const failureCategory =
          labels.rawCount === 2 ? undefined : "unexpected_speaker_count";
        return completeStage({
          startedAt,
          queryCount,
          providerCodes,
          terminalReason:
            labels.rawCount === 2
              ? "speaker_result"
              : "unexpected_speaker_count",
          labels,
          ...(failureCategory ? { failureCategory } : {})
        });
      }
      if (Date.now() - startedAt >= STANDALONE_TIMEOUT_MS) {
        return completeStage({
          startedAt,
          queryCount,
          providerCodes,
          terminalReason: "standalone_timeout",
          labels,
          failureCategory: "timeout"
        });
      }
      await sleep(POLL_INTERVAL_MS);
      const query = await fetchProviderJson<StandalonePayload>(
        input.baseUrl,
        `/api/ai/non-realtime-speaker-diarization/query?reqid=${encodeURIComponent(reqId)}`
      );
      payload = query.payload;
      queryCount += 1;
      appendCode(providerCodes, payload);
    }
  } catch (error) {
    const reason = safeFailure(error);
    return completeStage({
      startedAt,
      queryCount,
      providerCodes,
      terminalReason: reason,
      labels: payload
        ? labelsFromStandalone(payload)
        : { rawCount: 0, labels: [] },
      failureCategory: classifySpeakerDiarizationFailure(reason)
    });
  }
}

async function runTrial(input: {
  baseUrl: string;
  audioUrl: string;
  userId: string;
  benchmarkCase: SpeakerDiarizationBenchmarkCase;
}) {
  const startedAt = Date.now();
  const combined = await runCombined(input);
  let standalone = stageNotAttempted("not_eligible");
  if (
    combined.asrSuccess &&
    !combined.stage.speakerResultExists &&
    combined.payload &&
    combined.recordId
  ) {
    try {
      const sentences = buildStandaloneDiarizationSentences(combined.payload);
      standalone = await runStandalone({
        baseUrl: input.baseUrl,
        audioUrl: input.audioUrl,
        userId: input.userId,
        recordId: combined.recordId,
        speakerParameter: input.benchmarkCase.speakerParameter,
        sentences
      });
    } catch {
      standalone = {
        ...stageNotAttempted("standalone_input_invalid"),
        attempted: false,
        failureCategory: "asr_result_missing"
      };
    }
  } else if (combined.stage.success) {
    standalone = stageNotAttempted("combined_success");
  } else if (combined.stage.speakerResultExists) {
    standalone = stageNotAttempted("combined_labels_present");
  } else if (!combined.asrSuccess) {
    standalone = stageNotAttempted("asr_not_ready");
  }

  const finalSuccess = combined.stage.success || standalone.success;
  const failureCategory = finalSuccess
    ? undefined
    : standalone.attempted
      ? standalone.failureCategory ?? combined.stage.failureCategory
      : combined.stage.failureCategory;
  return {
    caseId: input.benchmarkCase.caseId,
    executionIndex: input.benchmarkCase.executionIndex,
    durationSeconds: input.benchmarkCase.durationSeconds,
    speakerParameter: input.benchmarkCase.speakerParameter,
    repetition: input.benchmarkCase.repetition,
    audioFormat: AUDIO_FORMAT,
    asrSuccess: combined.asrSuccess,
    combined: combined.stage,
    standalone,
    finalSuccess,
    finalSource: combined.stage.success
      ? "combined_asr"
      : standalone.success
        ? "standalone_diarization"
        : "none",
    totalLatencyMs: Date.now() - startedAt,
    ...(failureCategory ? { failureCategory } : {})
  } satisfies SpeakerDiarizationTrialResult;
}

async function publicPreflight(publicBase: string, healthPath: string) {
  let lastFailure = "unknown";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${publicBase}${healthPath}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(5_000)
      });
      if (response.ok && (await response.text()) === "ok") {
        return { reachable: true, attempts: attempt };
      }
      lastFailure = `http_${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.name : "unknown";
    }
    await sleep(2_000);
  }
  return { reachable: false, attempts: 3, lastFailure };
}

function safeProgressResult(result: SpeakerDiarizationTrialResult) {
  return {
    event: "trial_completed",
    caseId: result.caseId,
    executionIndex: result.executionIndex,
    durationSeconds: result.durationSeconds,
    speakerParameter: result.speakerParameter,
    repetition: result.repetition,
    asrSuccess: result.asrSuccess,
    combinedSuccess: result.combined.success,
    combinedSpeakerCount: result.combined.speakerCount,
    combinedLabels: result.combined.labels,
    combinedQueryCount: result.combined.queryCount,
    combinedLatencyMs: result.combined.totalLatencyMs,
    standaloneAttempted: result.standalone.attempted,
    standaloneSuccess: result.standalone.success,
    standaloneSpeakerCount: result.standalone.speakerCount,
    standaloneLabels: result.standalone.labels,
    standaloneQueryCount: result.standalone.queryCount,
    standaloneLatencyMs: result.standalone.totalLatencyMs,
    finalSuccess: result.finalSuccess,
    finalSource: result.finalSource,
    totalLatencyMs: result.totalLatencyMs,
    failureCategory: result.failureCategory ?? null
  };
}

function markdownReport(
  report: Record<string, unknown>,
  reportJsonSha256: string
) {
  const summary = report.summary as ReturnType<
    typeof summarizeSpeakerDiarizationBenchmark
  >;
  const cleanup = report.cleanup as CleanupState;
  const tableRows = [30, 45, 60, 70, 90].map((duration) => {
    const fixed = summary.byDurationAndParameter[`${duration}s/speaker=2`];
    const automatic = summary.byDurationAndParameter[`${duration}s/speaker=0`];
    return `| ${duration}s | ${fixed?.combinedSuccesses ?? 0}/${fixed?.trials ?? 0} | ${automatic?.combinedSuccesses ?? 0}/${automatic?.trials ?? 0} |`;
  });
  const fixed = summary.bySpeakerParameter["speaker=2"];
  const automatic = summary.bySpeakerParameter["speaker=0"];
  const analysis = report.analysis as Record<string, unknown>;
  return [
    "# Speaker Diarization Stability Report",
    "",
    "## Scope and safety",
    "",
    "- Evaluation-only synthetic two-speaker audio.",
    "- Voiceprint Provider was not constructed.",
    "- voiceprint/train calls: `0`.",
    "- voiceprint/save calls: `0`.",
    "- No audio, transcript, URL, credential, embedding, voice feature, raw response, or raw request identifier was persisted.",
    "",
    "## Combined ASR exact-two-speaker success",
    "",
    "| Duration | speaker=2 | speaker=0 |",
    "|---:|---:|---:|",
    ...tableRows,
    "",
    "## Parameter aggregate",
    "",
    `- speaker=2: ${fixed?.combinedSuccesses ?? 0}/${fixed?.trials ?? 0}; median ${fixed?.medianLatencyMs ?? "-"} ms; p95 ${fixed?.p95LatencyMs ?? "-"} ms.`,
    `- speaker=0: ${automatic?.combinedSuccesses ?? 0}/${automatic?.trials ?? 0}; median ${automatic?.medianLatencyMs ?? "-"} ms; p95 ${automatic?.p95LatencyMs ?? "-"} ms.`,
    `- Standalone recoveries: ${summary.overall.standaloneRecoveries}/${summary.overall.trials}.`,
    `- Candidate minimum stable duration for speaker=2: ${summary.candidateMinimumStableDurationSeconds ?? "none"}${summary.candidateMinimumStableDurationSeconds ? "s" : ""}.`,
    "",
    "## Observed Provider behavior",
    "",
    `- ASR text success: ${summary.overall.asrSuccesses}/${summary.overall.trials}.`,
    `- Empty combined speaker result: ${analysis.emptyCombinedSpeakerResults ?? 0}.`,
    `- Unexpected unique-speaker count: ${analysis.unexpectedSpeakerCounts ?? 0}.`,
    `- Standalone attempts returning Provider code=1: ${analysis.standaloneProviderCode1 ?? 0}.`,
    `- Recommended next smoke: speaker=${analysis.recommendedSpeakerParameter ?? "none"}, minimum ${analysis.recommendedMinimumDurationSeconds ?? "none"}s, with an exact-two-label runtime gate.`,
    "",
    "## Interpretation boundary",
    "",
    "- A success requires exactly two unique labels; non-empty one/many-label results are not counted as stable success.",
    "- Standalone recovery is reported separately and never replaces a combined-ASR failure.",
    "- Three repetitions per cell provide an operational observation, not a production reliability guarantee.",
    "",
    "## Cleanup",
    "",
    `- Temporary audio removed: ${cleanup.audioRemoved}.`,
    `- Local audio server stopped: ${cleanup.serverStopped}.`,
    `- Quick tunnel stopped: ${cleanup.tunnelStopped}.`,
    `- report.json SHA-256: \`${reportJsonSha256}\`.`,
    ""
  ].join("\n");
}

function benchmarkAnalysis(
  results: SpeakerDiarizationTrialResult[],
  summary: ReturnType<typeof summarizeSpeakerDiarizationBenchmark>
) {
  const fixed = summary.bySpeakerParameter["speaker=2"];
  const automatic = summary.bySpeakerParameter["speaker=0"];
  const stableAtOrAbove60 = [60, 70, 90].every((duration) =>
    [0, 2].every((speakerParameter) => {
      const group =
        summary.byDurationAndParameter[
          `${duration}s/speaker=${speakerParameter}`
        ];
      return group?.trials === 3 && group.combinedSuccesses === 3;
    })
  );
  return {
    emptyCombinedSpeakerResults: results.filter(
      (result) =>
        result.combined.failureCategory === "empty_speaker_result"
    ).length,
    unexpectedSpeakerCounts: results.filter(
      (result) =>
        result.combined.failureCategory === "unexpected_speaker_count"
    ).length,
    standaloneAttempts: results.filter(
      (result) => result.standalone.attempted
    ).length,
    standaloneProviderCode1: results.filter(
      (result) => result.standalone.providerCodes.includes(1)
    ).length,
    fixedSpeakerSuccessRate: fixed?.successRate ?? 0,
    automaticSpeakerSuccessRate: automatic?.successRate ?? 0,
    stableAtOrAbove60,
    candidateMinimumStableDurationSeconds:
      summary.candidateMinimumStableDurationSeconds,
    recommendedSpeakerParameter:
      (fixed?.successRate ?? 0) >= (automatic?.successRate ?? 0) ? 2 : 0,
    recommendedMinimumDurationSeconds: stableAtOrAbove60 ? 60 : null,
    runtimeGate: "combined_asr_exactly_two_unique_labels",
    productionRuleStatus: "candidate_only_insufficient_sample_size"
  };
}

async function main() {
  loadRuntimeEnv();
  if (
    !process.argv.includes("--remote") ||
    process.env[REMOTE_GATE] !== "1"
  ) {
    throw new Error(`Benchmark requires --remote and ${REMOTE_GATE}=1`);
  }
  const asrBaseUrl = process.env.SPEAKER_ASR_BASE_URL?.trim().replace(/\/+$/u, "");
  if (!asrBaseUrl) throw new BenchmarkFailure("speaker_asr_base_url_missing");
  const parsedBaseUrl = new URL(asrBaseUrl);
  if (!["http:", "https:"].includes(parsedBaseUrl.protocol)) {
    throw new BenchmarkFailure("speaker_asr_base_url_invalid");
  }

  const runId = `run-${new Date()
    .toISOString()
    .replace(/[:.]/gu, "")
    .replace("T", "-")
    .replace("Z", "")}`;
  const reportDir = join(REPORT_ROOT, runId);
  const progressPath = join(reportDir, "progress.jsonl");
  const partialPath = join(reportDir, "partial.json");
  const partialTempPath = join(reportDir, "partial.tmp.json");
  const tempRoot = join(tmpdir(), `${TEMP_PREFIX}${randomUUID()}`);
  await mkdir(REPORT_ROOT, { recursive: true });
  await mkdir(reportDir, { recursive: false });
  await mkdir(tempRoot, { recursive: true });

  const matrix = buildSpeakerDiarizationBenchmarkMatrix();
  const results: SpeakerDiarizationTrialResult[] = [];
  const cleanup: CleanupState = {
    audioRemoved: false,
    serverStopped: false,
    tunnelStopped: false
  };
  let server: Server | undefined;
  let tunnel: ChildProcess | undefined;
  let audios: Map<number, BenchmarkAudio> | undefined;
  let fatalFailure: string | undefined;
  let interrupted = false;

  const appendProgress = async (value: Record<string, unknown>) => {
    await appendFile(progressPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  };
  const writePartial = async () => {
    const partial = {
      runId,
      status: interrupted
        ? "aborted"
        : fatalFailure
          ? "failed"
          : "running",
      plannedTrials: matrix.length,
      completedTrials: results.length,
      voiceprintTrainCalls: 0,
      voiceprintSaveCalls: 0,
      summary: summarizeSpeakerDiarizationBenchmark(results, matrix.length),
      results
    };
    await writeFile(partialTempPath, `${JSON.stringify(partial, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(partialTempPath, partialPath);
  };
  const cleanupResources = async () => {
    cleanup.tunnelStopped = await stopChild(tunnel).catch(() => false);
    cleanup.serverStopped = await closeServer(server);
    const resolvedTemp = resolve(tempRoot);
    const expectedPrefix = resolve(tmpdir(), TEMP_PREFIX);
    if (resolvedTemp.startsWith(expectedPrefix)) {
      await rm(resolvedTemp, { recursive: true, force: true });
    }
    cleanup.audioRemoved = !(await stat(tempRoot)
      .then(() => true)
      .catch(() => false));
  };
  const terminate = () => {
    interrupted = true;
    void writePartial()
      .catch(() => undefined)
      .then(async () => await appendProgress({
        event: "benchmark_aborted",
        completedTrials: results.length,
        plannedTrials: matrix.length
      }).catch(() => undefined))
      .then(cleanupResources)
      .finally(() => process.exit(130));
  };
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);

  const report: Record<string, unknown> = {
    version: 1,
    generatedAt: new Date().toISOString(),
    runId,
    status: "running",
    safety: {
      evaluationOnly: true,
      syntheticAudioOnly: true,
      voiceprintProviderConstructed: false,
      voiceprintTrainCalls: 0,
      voiceprintSaveCalls: 0,
      rawProviderResponsesPersisted: false,
      transcriptPersisted: false,
      audioPersisted: false,
      urlsPersisted: false,
      credentialsPersisted: false,
      embeddingsPersisted: false,
      voiceFeaturesPersisted: false
    },
    environment: {
      node: process.version,
      platform: process.platform,
      audioFormat: AUDIO_FORMAT,
      execution: "serial",
      repetitionsPerCell: 3,
      pollIntervalMs: POLL_INTERVAL_MS,
      speakerGraceMs: SPEAKER_GRACE_MS,
      combinedTimeoutMs: ASR_TIMEOUT_MS,
      standaloneTimeoutMs: STANDALONE_TIMEOUT_MS,
      requestFields: {
        speakerParameters: [2, 0],
        speakerDiarizationField: "omitted",
        languageType: "array",
        callbackUsed: false
      }
    },
    audio: {
      contentFamily: "shared_90_second_prefix_v1",
      voices: ["Microsoft Yaoyao", "Microsoft Kangkang"],
      durations: []
    },
    matrix: {
      plannedTrials: matrix.length,
      durationsSeconds: [30, 45, 60, 70, 90],
      speakerParameters: [2, 0],
      repetitions: 3
    },
    results,
    summary: summarizeSpeakerDiarizationBenchmark([], matrix.length),
    cleanup
  };

  try {
    await appendProgress({
      event: "benchmark_started",
      plannedTrials: matrix.length
    });
    audios = await generateBenchmarkAudio(tempRoot);
    (report.audio as Record<string, unknown>).durations = [...audios.values()]
      .map((audio) => ({
        targetDurationSeconds: audio.durationSeconds,
        actualDurationMs: audio.actualDurationMs,
        format: AUDIO_FORMAT
      }));
    console.info("[diarization-benchmark] synthetic_audio_ready durations=5");

    const audioServer = await startAudioServer(audios, matrix);
    server = audioServer.server;
    const tunnelResult = await startTunnel(audioServer.port);
    tunnel = tunnelResult.child;
    const preflight = await publicPreflight(
      tunnelResult.publicBase,
      audioServer.healthPath
    );
    (report.environment as Record<string, unknown>).publicAudioPreflight = {
      reachable: preflight.reachable,
      attempts: preflight.attempts,
      ...(preflight.reachable ? {} : { failureCategory: "local_hairpin_unavailable" })
    };

    const userId = `dia_bench_user_${randomUUID().replaceAll("-", "")}`;
    for (const benchmarkCase of matrix) {
      const route = audioServer.pathsByCase.get(benchmarkCase.caseId);
      if (!route) throw new BenchmarkFailure("audio_route_missing");
      await appendProgress({
        event: "trial_started",
        caseId: benchmarkCase.caseId,
        executionIndex: benchmarkCase.executionIndex,
        durationSeconds: benchmarkCase.durationSeconds,
        speakerParameter: benchmarkCase.speakerParameter,
        repetition: benchmarkCase.repetition
      });
      const result = await runTrial({
        baseUrl: asrBaseUrl,
        audioUrl: `${tunnelResult.publicBase}${route}`,
        userId,
        benchmarkCase
      });
      results.push(result);
      await appendProgress(safeProgressResult(result));
      await writePartial();
      console.info(
        `[diarization-benchmark] completed=${results.length}/${matrix.length} case=${result.caseId} combined=${result.combined.success ? "success" : result.combined.failureCategory ?? "failed"} standalone=${result.standalone.attempted ? result.standalone.success ? "success" : result.standalone.failureCategory ?? "failed" : "not_attempted"} latency_ms=${result.totalLatencyMs}`
      );
      if (results.length < matrix.length) await sleep(TRIAL_COOLDOWN_MS);
    }
    report.status = "completed";
  } catch (error) {
    fatalFailure = safeFailure(error);
    report.status = "failed";
    report.fatalFailure = fatalFailure;
    await appendProgress({
      event: "benchmark_failed",
      completedTrials: results.length,
      plannedTrials: matrix.length,
      failureCategory: fatalFailure
    }).catch(() => undefined);
  } finally {
    await cleanupResources();
    process.removeListener("SIGINT", terminate);
    process.removeListener("SIGTERM", terminate);
  }

  report.completedAt = new Date().toISOString();
  report.results = results;
  const finalSummary = summarizeSpeakerDiarizationBenchmark(
    results,
    matrix.length
  );
  report.summary = finalSummary;
  report.analysis = benchmarkAnalysis(results, finalSummary);
  report.cleanup = cleanup;
  await appendProgress({
    event:
      report.status === "completed"
        ? "benchmark_completed"
        : "benchmark_finished_with_failure",
    completedTrials: results.length,
    plannedTrials: matrix.length
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const jsonHash = sha256(json);
  await writeFile(join(reportDir, "report.json"), json, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  await writeFile(
    join(reportDir, "report.md"),
    `${markdownReport(report, jsonHash)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" }
  );
  await rm(partialPath, { force: true });
  await rm(partialTempPath, { force: true });
  console.info(
    `[diarization-benchmark] report_written completed=${results.length}/${matrix.length} report_json_sha256=${jsonHash}`
  );
}

main().catch((error) => {
  console.error(
    `[diarization-benchmark] startup_failed error_name=${
      error instanceof Error ? error.name : "unknown"
    }`
  );
  process.exitCode = 1;
});

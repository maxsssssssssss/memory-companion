import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import ffmpegPath from "ffmpeg-static";

import type { TranscriptChunk } from "@/lib/domain/chunks";
import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";
import {
  buildStandaloneDiarizationSentences,
  DiarizationEvaluationInputError,
  evaluateCombinedDiarizationQualityGate,
  parseCombinedAsrSpeakerLabels,
  parseStandaloneDiarizationLabels,
  summarizeDiarizationResponseShape,
  type CombinedDiarizationQualityGate,
  type DiarizationResponseShapeSummary,
  type StandaloneDiarizationSentence
} from "@/lib/server/evaluation/voiceprint-diarization";
import {
  HttpVoiceprintProvider,
  VoiceprintProviderError,
  createConfiguredVoiceprintProvider,
  type VoiceprintProvider,
  type VoiceprintTrainInput,
  type VoiceprintTrainingAudio
} from "@/lib/server/speaker-identity/voiceprint-client";
import { createVoiceprintProviderRequestId } from "@/lib/server/speaker-identity/voiceprint-api-support";
import {
  JsonVoiceprintOperationRepository,
  type SaveVoiceprintOperationInput,
  type VoiceprintOperation,
  type VoiceprintOperationRepository
} from "@/lib/server/speaker-identity/voiceprint-operation-repository";
import {
  JsonSpeakerIdentityRepository
} from "@/lib/server/speaker-identity/repository";
import { resolveSpeakerIdentities } from "@/lib/server/speaker-identity/resolver";
import { VoiceprintService } from "@/lib/server/speaker-identity/voiceprint-service";
import type { VoiceprintIdentityHint } from "@/lib/server/speaker-identity/types";
import { JsonStore } from "@/lib/server/storage/json-store";

const REMOTE_GATE = "RUN_VOICEPRINT_REMOTE_VERIFY";
const REPORT_ROOT = resolve(".data", "evaluation", "voiceprint-provider-smoke-v1");
const ASR_TIMEOUT_MS = 180_000;
const JOINT_SPEAKER_GRACE_MS = 30_000;
const STANDALONE_DIARIZATION_TIMEOUT_MS = 180_000;
const ASR_POLL_INTERVAL_MS = 2_000;
const RESPONSE_LIMIT_BYTES = 512 * 1024;
const SAFE_PROVIDER_LABEL = /^[\p{L}\p{N}_-]{1,128}$/u;
const DIARIZATION_ONLY_FLAG = "--diarization-only";

type SyntheticVoice = "B" | "C";
type SampleId = "recording-a" | "recording-b";
type SyntheticUtterance = { voice: SyntheticVoice; text: string };
type Sample = {
  id: SampleId;
  path: string;
  durationMs: number;
  byteLength: number;
  timings: Array<{ voice: SyntheticVoice; startMs: number; endMs: number }>;
};

type SpeakerResultItem = { speaker?: string; text?: string };

type AsrPayload = {
  code?: number;
  message?: unknown;
  data?: {
    asr_result?: {
      sentences?: Array<{
        text?: string;
        timestamp?: Array<{ start?: number; end?: number }>;
        timestamps?: Array<{ start?: number; end?: number }> | { start?: number; end?: number };
      }>;
    };
    speaker_result?: SpeakerResultItem[];
  };
};

type StandaloneDiarizationPayload = {
  code?: number;
  message?: unknown;
  data?: {
    result?: SpeakerResultItem[];
  };
};

type DiarizationStageAudit = {
  elapsedMs: number;
  polls: number;
  httpStatuses: number[];
  providerCodes: Array<number | "missing">;
  responseShapes: DiarizationResponseShapeSummary[];
  terminalReason: string;
};

type AsrResult = {
  recordId: string;
  elapsedMs: number;
  polls: number;
  httpStatuses: number[];
  labels: string[];
  payloadFields: string[];
  voiceLabels: Partial<Record<SyntheticVoice, string>>;
  speakerResultSource: "combined_asr" | "standalone_diarization";
  qualityGate: CombinedDiarizationQualityGate;
  asrReadyMs: number | null;
  speakerWaitMs: number | null;
  jointAsr: DiarizationStageAudit;
  standaloneDiarization?: DiarizationStageAudit;
  requestSummary: {
    speaker: number;
    speakerDiarizationField: "omitted";
    callbackUsed: false;
    languageType: "array";
  };
};

type SafeStep = {
  status: "success" | "failed" | "skipped";
  elapsedMs?: number;
  failureReason?: string;
  [key: string]: unknown;
};

class SmokeFailure extends Error {
  constructor(
    readonly category: string,
    readonly safeDetails?: Record<string, unknown>
  ) {
    super(category);
    this.name = "SmokeFailure";
  }
}

const dialogues: Record<SampleId, SyntheticUtterance[]> = {
  "recording-a": [
    { voice: "B", text: "你来的路上有没有看见河边的白鹭？" },
    { voice: "C", text: "看见了两只，它们在浅水里站了很久。" },
    { voice: "B", text: "我每次经过那里都会放慢脚步，早上的景色很安静。" },
    { voice: "C", text: "难怪你经常走这条路，比大街那边少了很多车辆。" },
    { voice: "B", text: "前面新开了一家小面包店，门口闻起来很香。" },
    { voice: "C", text: "我昨天路过时也注意到了，橱窗里摆着圆圆的面包。" },
    { voice: "B", text: "下次散步可以进去看看，再带一份回家当早餐。" },
    { voice: "C", text: "好啊，今天先沿着河边走到桥头，再慢慢回来。" },
    { voice: "B", text: "桥边的花最近开了，正好可以拍几张春天的照片。" },
    { voice: "C", text: "那我们走吧，趁现在阳光柔和，路上也还不拥挤。" },
    { voice: "B", text: "河面上有几艘小船慢慢经过，水面留下了一圈圈波纹。" },
    { voice: "C", text: "等走到桥头我们休息一会儿，再从树荫下面绕回来。" }
  ],
  "recording-b": [
    { voice: "C", text: "窗边那盆绿植换了位置，看起来比以前精神多了。" },
    { voice: "B", text: "下午的光线比较柔和，我想让它每天多晒一会儿太阳。" },
    { voice: "C", text: "旁边的小架子也整理得很清爽，那些旧杂志收起来了吗？" },
    { voice: "B", text: "我分成了两摞，留下常看的，其他准备送给邻居。" },
    { voice: "C", text: "客厅空出来以后舒服多了，坐在这里读书也不容易分心。" },
    { voice: "B", text: "我还把台灯擦干净了，晚上开灯时应该会更明亮。" },
    { voice: "C", text: "等一会儿我们泡一壶茶，试试刚买来的那盒点心吧。" },
    { voice: "B", text: "可以，我先把水烧上，再找两个合适的小杯子。" },
    { voice: "C", text: "书架上那几本旅行随笔要不要放到最容易拿的位置？" },
    { voice: "B", text: "放在中间一层吧，周末想看的时候不用再搬椅子。" },
    { voice: "C", text: "收拾完以后我们把窗户打开，让房间里再通一会儿风。" },
    { voice: "B", text: "好，我把桌面最后擦一遍，然后一起坐下来休息。" }
  ]
};

const voiceNames: Record<SyntheticVoice, string> = {
  B: "Microsoft Kangkang",
  C: "Microsoft Yaoyao"
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeLabel(value: string | undefined) {
  const normalized = value?.normalize("NFKC").trim();
  return normalized && SAFE_PROVIDER_LABEL.test(normalized) ? normalized : "<opaque>";
}

function safeFailure(error: unknown) {
  if (error instanceof SmokeFailure) return error.category;
  if (error instanceof DiarizationEvaluationInputError) return error.code;
  if (error instanceof VoiceprintProviderError) return error.reason;
  if (error instanceof Error && error.name === "AbortError") return "timeout";
  return "unexpected_error";
}

function normalizeText(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(value: string) {
  const normalized = normalizeText(value);
  const output = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    output.add(normalized.slice(index, index + 2));
  }
  return output;
}

function overlapScore(left: string, right: string) {
  const leftSet = bigrams(left);
  const rightSet = bigrams(right);
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let overlap = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) overlap += 1;
  }
  return overlap / Math.max(1, Math.min(leftSet.size, rightSet.size));
}

function expectedText(sampleId: SampleId, voice: SyntheticVoice) {
  return dialogues[sampleId]
    .filter((item) => item.voice === voice)
    .map((item) => item.text)
    .join("");
}

function mapProviderLabels(
  sampleId: SampleId,
  speakerResult: NonNullable<NonNullable<AsrPayload["data"]>["speaker_result"]>
) {
  const textByLabel = new Map<string, string>();
  for (const item of speakerResult) {
    const label = item.speaker?.normalize("NFKC").trim();
    if (!label) continue;
    textByLabel.set(label, `${textByLabel.get(label) ?? ""}${item.text ?? ""}`);
  }
  const expectedVoices = [...new Set(dialogues[sampleId].map((item) => item.voice))];
  const assigned: Partial<Record<SyntheticVoice, string>> = {};
  const used = new Set<string>();
  for (const voice of expectedVoices) {
    const ranked = [...textByLabel.entries()]
      .map(([label, text]) => ({ label, score: overlapScore(text, expectedText(sampleId, voice)) }))
      .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
    const best = ranked.find((item) => !used.has(item.label));
    const next = ranked.find((item) => item.label !== best?.label);
    if (
      best &&
      best.score >= 0.08 &&
      (next === undefined || best.score >= next.score + 0.03)
    ) {
      assigned[voice] = best.label;
      used.add(best.label);
    }
  }
  return assigned;
}

function runProcess(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
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
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        reject(new SmokeFailure(`process_failed_${command.split(/[\\/]/u).at(-1) ?? "unknown"}`));
      }
    });
  });
}

function wavMetadata(buffer: Buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new SmokeFailure("invalid_generated_wav");
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
  if (channels !== 1 || sampleRate !== 16_000 || bitsPerSample !== 16 || dataBytes <= 0) {
    throw new SmokeFailure("invalid_generated_wav_format");
  }
  return {
    byteLength: buffer.length,
    durationMs: Math.round((dataBytes / (sampleRate * channels * (bitsPerSample / 8))) * 1_000)
  };
}

async function detectFixtureUtteranceTimings(
  audioPath: string,
  durationMs: number,
  utterances: SyntheticUtterance[]
): Promise<Sample["timings"]> {
  if (!ffmpegPath) throw new SmokeFailure("ffmpeg_unavailable");
  const detected = await runProcess(ffmpegPath, [
    "-hide_banner", "-loglevel", "info",
    "-i", audioPath,
    "-af", "silencedetect=noise=-38dB:d=1.4",
    "-f", "null", "NUL"
  ]);
  const pauses = [...detected.stderr.matchAll(
    /silence_start:\s*([0-9.]+)[\s\S]*?silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/gu
  )].map((match) => ({
    startMs: Math.round(Number(match[1]) * 1_000),
    endMs: Math.round(Number(match[2]) * 1_000),
    durationMs: Math.round(Number(match[3]) * 1_000)
  })).filter((pause) =>
    Number.isFinite(pause.startMs) &&
    Number.isFinite(pause.endMs) &&
    pause.durationMs >= 1_400
  );

  const speechRanges: Array<[number, number]> = [];
  let speechStartMs = 0;
  for (const pause of pauses) {
    if (pause.startMs - speechStartMs >= 500) {
      speechRanges.push([speechStartMs, pause.startMs]);
    }
    speechStartMs = pause.endMs;
  }
  if (
    speechRanges.length < utterances.length &&
    durationMs - speechStartMs >= 500
  ) {
    speechRanges.push([speechStartMs, durationMs]);
  }
  if (speechRanges.length !== utterances.length) {
    throw new SmokeFailure("retained_synthetic_timing_detection_failed", {
      expectedUtteranceCount: utterances.length,
      detectedUtteranceCount: speechRanges.length
    });
  }
  return speechRanges.map(([startMs, endMs], index) => ({
    voice: utterances[index].voice,
    startMs,
    endMs
  }));
}

async function generateSamples(tempRoot: string): Promise<Record<SampleId, Sample>> {
  if (!ffmpegPath) throw new SmokeFailure("ffmpeg_unavailable");
  const fixtureAudioPath = resolve(
    "test-data",
    "long-recording-60m-v1",
    "audio",
    "long-recording-60m-v1.wav"
  );
  const fixtureDialoguePath = resolve(
    "test-data",
    "long-recording-60m-v1",
    "dialogue.json"
  );
  if (!(await stat(fixtureAudioPath).then(() => true).catch(() => false))) {
    throw new SmokeFailure("retained_synthetic_audio_missing");
  }
  const fixture = JSON.parse(
    await readFile(fixtureDialoguePath, "utf8")
  ) as {
    utterances?: Array<{
      speaker?: string;
      text?: string;
      section?: string;
    }>;
  };
  const sectionSamples = [
    {
      sampleId: "recording-a" as const,
      section: "daily_chat",
      startSeconds: 0
    },
    {
      sampleId: "recording-b" as const,
      section: "reading_club_anxiety",
      startSeconds: 300
    }
  ];
  const samples = {} as Record<SampleId, Sample>;
  for (const sectionSample of sectionSamples) {
    const utterances = (fixture.utterances ?? [])
      .filter((item) => item.section === sectionSample.section)
      .map((item): SyntheticUtterance => ({
        voice: item.speaker === "A" ? "C" : "B",
        text: item.text?.trim() ?? ""
      }));
    if (
      utterances.length < 2 ||
      utterances.some((item) => !item.text) ||
      new Set(utterances.map((item) => item.voice)).size !== 2
    ) {
      throw new SmokeFailure("retained_synthetic_dialogue_invalid");
    }
    dialogues[sectionSample.sampleId] = utterances;
    const samplePath = join(tempRoot, `${sectionSample.sampleId}.wav`);
    await runProcess(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(sectionSample.startSeconds),
      "-t", "300",
      "-i", fixtureAudioPath,
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      samplePath
    ]);
    const metadata = wavMetadata(await readFile(samplePath));
    const timings = await detectFixtureUtteranceTimings(
      samplePath,
      metadata.durationMs,
      utterances
    );
    samples[sectionSample.sampleId] = {
      id: sectionSample.sampleId,
      path: samplePath,
      timings,
      ...metadata
    };
  }
  return samples;
}

function parseRange(value: string | undefined, size: number) {
  const match = value?.match(/^bytes=(\d+)-(\d*)$/u);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

async function startAudioServer(samples: Record<SampleId, Sample>) {
  const healthPath = `/health-${randomBytes(16).toString("hex")}`;
  const routes = new Map<string, string>();
  for (const sample of Object.values(samples)) {
    routes.set(`/audio-${randomBytes(24).toString("hex")}.wav`, sample.path);
  }
  const server = createServer(async (request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (requestPath === healthPath) {
      response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      response.end("ok");
      return;
    }
    const filePath = routes.get(requestPath);
    if (!filePath || (request.method !== "GET" && request.method !== "HEAD")) {
      response.writeHead(404);
      response.end();
      return;
    }
    const size = (await stat(filePath)).size;
    const requestedRange = parseRange(request.headers.range, size);
    const headers: Record<string, string | number> = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Type": "audio/wav"
    };
    if (requestedRange) {
      headers["Content-Length"] = requestedRange.end - requestedRange.start + 1;
      headers["Content-Range"] = `bytes ${requestedRange.start}-${requestedRange.end}/${size}`;
      response.writeHead(206, headers);
      if (request.method === "HEAD") response.end();
      else createReadStream(filePath, requestedRange).pipe(response);
      return;
    }
    headers["Content-Length"] = size;
    response.writeHead(200, headers);
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath).pipe(response);
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new SmokeFailure("audio_server_failed");
  return { server, port: address.port, healthPath, routes };
}

async function startTunnel(port: number) {
  const command = process.env.CLOUDFLARED_BIN?.trim() || "C:\\tmp\\cloudflared.exe";
  const child = spawn(command, [
    "tunnel",
    "--no-autoupdate",
    "--protocol", "quic",
    "--url", `http://127.0.0.1:${port}`
  ], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let spawnFailed = false;
  let publicBase: string | undefined;
  let registered = false;
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-16_384);
    publicBase ??= output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu)?.[0];
    registered ||= /Registered tunnel connection/iu.test(output);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.once("error", () => {
    spawnFailed = true;
  });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    if (publicBase && registered) return { child, publicBase };
    if (spawnFailed) throw new SmokeFailure("tunnel_spawn_failed");
    if (child.exitCode !== null) throw new SmokeFailure("tunnel_exited");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  child.kill();
  throw new SmokeFailure("tunnel_start_timeout");
}

async function publicPreflight(publicBase: string, healthPath: string) {
  let lastFailure = "unknown";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${publicBase}${healthPath}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(5_000)
      });
      if (response.ok && await response.text() === "ok") {
        return { reachable: true, attempts: attempt };
      }
      lastFailure = `http_${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.name : "unknown";
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  return {
    reachable: false,
    attempts: 3,
    lastFailure
  };
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
      "/PID", String(child.pid), "/T", "/F"
    ]).catch(() => undefined);
    for (let attempt = 0; attempt < 20 && child.exitCode === null; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
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
      throw new SmokeFailure("asr_response_too_large");
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
    throw new SmokeFailure("asr_invalid_json");
  }
}

async function fetchProviderJson<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const startedAt = Date.now();
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: controller.signal
    });
    const payload = await boundedJson<T>(response);
    if (!response.ok) throw new SmokeFailure(`asr_http_${response.status}`);
    return { payload, httpStatus: response.status, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    if (controller.signal.aborted) throw new SmokeFailure("asr_request_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function appendProviderCode(
  codes: Array<number | "missing">,
  payload: { code?: number }
) {
  if (codes.length >= 128) return;
  codes.push(typeof payload.code === "number" ? payload.code : "missing");
}

function appendResponseShape(
  shapes: DiarizationResponseShapeSummary[],
  payload: unknown
) {
  const shape = summarizeDiarizationResponseShape(payload);
  const serialized = JSON.stringify(shape);
  if (
    shapes.length < 12 &&
    !shapes.some((item) => JSON.stringify(item) === serialized)
  ) {
    shapes.push(shape);
  }
}

function assertProviderCode(
  payload: { code?: number },
  prefix: "asr" | "standalone_diarization"
) {
  if (payload.code === 0 || payload.code === 2) return;
  throw new SmokeFailure(
    `${prefix}_provider_code_${
      typeof payload.code === "number" ? payload.code : "unknown"
    }`
  );
}

async function runStandaloneDiarization(input: {
  baseUrl: string;
  audioUrl: string;
  userId: string;
  recordId: string;
  speakerCount: number;
  sentences: StandaloneDiarizationSentence[];
}) {
  const requestId = `vp_diarization_${randomUUID().replaceAll("-", "")}`;
  const startedAt = Date.now();
  const statuses: number[] = [];
  const providerCodes: Array<number | "missing"> = [];
  const responseShapes: DiarizationResponseShapeSummary[] = [];
  let polls = 0;
  const submit = await fetchProviderJson<StandaloneDiarizationPayload>(
    input.baseUrl,
    "/api/ai/non-realtime-speaker-diarization",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        req_id: requestId,
        audio_url: input.audioUrl,
        record_id: input.recordId,
        user_id: input.userId,
        speaker: input.speakerCount,
        sentences: input.sentences
      })
    }
  );
  statuses.push(submit.httpStatus);
  appendProviderCode(providerCodes, submit.payload);
  appendResponseShape(responseShapes, submit.payload);
  assertProviderCode(submit.payload, "standalone_diarization");
  let payload = submit.payload;

  while (
    payload.code !== 0 ||
    parseStandaloneDiarizationLabels(payload).labels.length === 0
  ) {
    if (Date.now() - startedAt > STANDALONE_DIARIZATION_TIMEOUT_MS) {
      throw new SmokeFailure("standalone_diarization_poll_timeout", {
        standaloneDiarization: {
          elapsedMs: Date.now() - startedAt,
          polls,
          httpStatuses: [...new Set(statuses)],
          providerCodes,
          responseShapes,
          terminalReason: "timeout"
        }
      });
    }
    await new Promise((resolvePromise) => setTimeout(
      resolvePromise,
      ASR_POLL_INTERVAL_MS
    ));
    const query = await fetchProviderJson<StandaloneDiarizationPayload>(
      input.baseUrl,
      `/api/ai/non-realtime-speaker-diarization/query?reqid=${encodeURIComponent(requestId)}`
    );
    statuses.push(query.httpStatus);
    payload = query.payload;
    polls += 1;
    appendProviderCode(providerCodes, payload);
    appendResponseShape(responseShapes, payload);
    assertProviderCode(payload, "standalone_diarization");
  }

  return {
    payload,
    result: payload.data?.result ?? [],
    labels: parseStandaloneDiarizationLabels(payload).labels,
    audit: {
      elapsedMs: Date.now() - startedAt,
      polls,
      httpStatuses: [...new Set(statuses)],
      providerCodes,
      responseShapes,
      terminalReason: "speaker_result"
    } satisfies DiarizationStageAudit
  };
}

async function runAsr(input: {
  baseUrl: string;
  sampleId: SampleId;
  audioUrl: string;
  userId: string;
  speakerCount: number;
  combinedOnly?: boolean;
  requiredSpeakerLabel?: string;
}) {
  const reqId = `vp_asr_${randomUUID().replaceAll("-", "")}`;
  const recordId = `vp_record_${randomUUID().replaceAll("-", "")}`;
  const startedAt = Date.now();
  const statuses: number[] = [];
  const providerCodes: Array<number | "missing"> = [];
  const responseShapes: DiarizationResponseShapeSummary[] = [];
  const requestSummary = {
    speaker: input.speakerCount,
    speakerDiarizationField: "omitted" as const,
    callbackUsed: false as const,
    languageType: "array" as const
  };
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
        speaker: input.speakerCount
      })
    }
  );
  statuses.push(submit.httpStatus);
  appendProviderCode(providerCodes, submit.payload);
  appendResponseShape(responseShapes, submit.payload);
  assertProviderCode(submit.payload, "asr");
  let payload = submit.payload;
  let polls = 0;
  let firstAsrReadyAt: number | undefined;
  let jointTerminalReason = "speaker_result";

  const combinedGate = () => evaluateCombinedDiarizationQualityGate(payload, {
    expectedSpeakerCount: input.speakerCount,
    ...(input.requiredSpeakerLabel
      ? { requiredSpeakerLabel: input.requiredSpeakerLabel }
      : {})
  });
  while (
    payload.code !== 0 ||
    (
      input.combinedOnly
        ? !combinedGate().passed
        : parseCombinedAsrSpeakerLabels(payload).labels.length === 0
    )
  ) {
    const hasAsrSentences = Boolean(
      payload.data?.asr_result?.sentences?.length
    );
    if (payload.code === 0 && hasAsrSentences) {
      firstAsrReadyAt ??= Date.now();
      if (Date.now() - firstAsrReadyAt >= JOINT_SPEAKER_GRACE_MS) {
        jointTerminalReason = "speaker_grace_timeout";
        break;
      }
    }
    if (Date.now() - startedAt > ASR_TIMEOUT_MS) {
      if (hasAsrSentences) {
        jointTerminalReason = "asr_timeout_with_sentences";
        break;
      }
      throw new SmokeFailure("asr_poll_timeout", {
        jointAsr: {
          elapsedMs: Date.now() - startedAt,
          polls,
          httpStatuses: [...new Set(statuses)],
          providerCodes,
          responseShapes,
          terminalReason: "timeout_without_sentences"
        }
      });
    }
    await new Promise((resolvePromise) => setTimeout(
      resolvePromise,
      ASR_POLL_INTERVAL_MS
    ));
    const query = await fetchProviderJson<AsrPayload>(
      input.baseUrl,
      `/api/ai/non-realtime-asr/query?reqid=${encodeURIComponent(reqId)}`
    );
    statuses.push(query.httpStatus);
    payload = query.payload;
    polls += 1;
    appendProviderCode(providerCodes, payload);
    appendResponseShape(responseShapes, payload);
    assertProviderCode(payload, "asr");
  }

  if (
    !firstAsrReadyAt &&
    payload.code === 0 &&
    payload.data?.asr_result?.sentences?.length
  ) {
    firstAsrReadyAt = Date.now();
  }
  const jointAsr = {
    elapsedMs: Date.now() - startedAt,
    polls,
    httpStatuses: [...new Set(statuses)],
    providerCodes,
    responseShapes,
    terminalReason: jointTerminalReason
  } satisfies DiarizationStageAudit;

  let speakerResult = payload.data?.speaker_result ?? [];
  let labels = parseCombinedAsrSpeakerLabels(payload).labels;
  let speakerResultSource: AsrResult["speakerResultSource"] = "combined_asr";
  let standaloneDiarization: DiarizationStageAudit | undefined;
  let standaloneHttpStatuses: number[] = [];
  let standalonePolls = 0;
  let finalResponseFields = summarizeDiarizationResponseShape(payload).dataFields;

  if (input.combinedOnly) {
    const qualityGate = combinedGate();
    if (!qualityGate.passed) {
      throw new SmokeFailure(`diarization_gate_${qualityGate.reason}`, {
        jointAsr,
        qualityGate
      });
    }
  }

  if (labels.length === 0) {
    const sentences = buildStandaloneDiarizationSentences(payload);
    try {
      const standalone = await runStandaloneDiarization({
        baseUrl: input.baseUrl,
        audioUrl: input.audioUrl,
        userId: input.userId,
        recordId,
        speakerCount: input.speakerCount,
        sentences
      });
      speakerResult = standalone.result;
      labels = standalone.labels;
      speakerResultSource = "standalone_diarization";
      standaloneDiarization = standalone.audit;
      standaloneHttpStatuses = standalone.audit.httpStatuses;
      standalonePolls = standalone.audit.polls;
      finalResponseFields = summarizeDiarizationResponseShape(
        standalone.payload
      ).dataFields;
    } catch (error) {
      const safeDetails = error instanceof SmokeFailure
        ? error.safeDetails
        : undefined;
      throw new SmokeFailure(safeFailure(error), {
        jointAsr,
        ...(safeDetails ?? {})
      });
    }
  }

  if (labels.length === 0) {
    throw new SmokeFailure("asr_missing_speaker_labels", { jointAsr });
  }
  const qualityGate = evaluateCombinedDiarizationQualityGate(
    { data: { speaker_result: speakerResult } },
    {
      expectedSpeakerCount: input.speakerCount,
      ...(input.requiredSpeakerLabel
        ? { requiredSpeakerLabel: input.requiredSpeakerLabel }
        : {})
    }
  );
  const completedAt = Date.now();
  return {
    recordId,
    elapsedMs: completedAt - startedAt,
    polls: polls + standalonePolls,
    httpStatuses: [...new Set([...statuses, ...standaloneHttpStatuses])],
    labels,
    payloadFields: finalResponseFields,
    voiceLabels: mapProviderLabels(input.sampleId, speakerResult),
    speakerResultSource,
    qualityGate,
    asrReadyMs: firstAsrReadyAt ? firstAsrReadyAt - startedAt : null,
    speakerWaitMs: firstAsrReadyAt ? completedAt - firstAsrReadyAt : null,
    jointAsr,
    ...(standaloneDiarization ? { standaloneDiarization } : {}),
    requestSummary
  } satisfies AsrResult;
}

class CountingVoiceprintProvider implements VoiceprintProvider {
  trainCalls = 0;
  saveCalls = 0;
  constructor(private readonly delegate: VoiceprintProvider) {}
  async train(input: Parameters<VoiceprintProvider["train"]>[0]) {
    this.trainCalls += 1;
    return await this.delegate.train(input);
  }
  async save(input: Parameters<VoiceprintProvider["save"]>[0]) {
    this.saveCalls += 1;
    return await this.delegate.save(input);
  }
  async identify(input: Parameters<VoiceprintProvider["identify"]>[0]) {
    return await this.delegate.identify(input);
  }
}

class RecordingOperationRepository implements VoiceprintOperationRepository {
  readonly transitions = new Map<string, VoiceprintOperation["status"][]>();
  constructor(private readonly delegate: VoiceprintOperationRepository) {}
  async save(input: SaveVoiceprintOperationInput) {
    const transitions = this.transitions.get(input.providerRequestId) ?? [];
    transitions.push(input.status);
    this.transitions.set(input.providerRequestId, transitions);
    return await this.delegate.save(input);
  }
  async get(providerRequestId: string) {
    return await this.delegate.get(providerRequestId);
  }
  async list() {
    return await this.delegate.list();
  }
}

function buildTranscriptChunk(
  uploadId: string,
  chunkId: string,
  labels: string[]
): TranscriptChunk {
  const now = new Date().toISOString();
  return {
    id: chunkId,
    uploadId,
    audioChunkId: `audio_${chunkId}`,
    index: 0,
    startSeconds: 0,
    endSeconds: Math.max(1, labels.length),
    timebase: "upload_global",
    speakerIdScope: "chunk",
    speakerMap: Object.fromEntries(labels.map((label) => [label, label])),
    segments: labels.map((label, index) => ({
      id: `${chunkId}_segment_${index}`,
      uploadId,
      startSeconds: index,
      endSeconds: index + 0.9,
      speaker: label,
      text: "synthetic redacted segment",
      confidence: 0.8,
      sceneLabels: [],
      valueLabels: []
    })),
    status: "completed",
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: now,
    metadata: { provider: "speaker-asr", evaluationOnly: true }
  };
}

async function resolveRealLabels(input: {
  repository: JsonSpeakerIdentityRepository;
  uploadId: string;
  labels: string[];
}) {
  const chunk = buildTranscriptChunk(input.uploadId, `${input.uploadId}_chunk_0`, input.labels);
  const hints = await input.repository.loadVoiceprintHints([chunk]);
  const resolved = await resolveSpeakerIdentities({
    uploadId: input.uploadId,
    chunks: [chunk],
    voiceprintHints: hints
  });
  return {
    hintCount: hints.length,
    assignments: resolved.assignments.map((item) => ({
      inputSpeakerLabel: safeLabel(item.localSpeaker),
      identityType: item.identity.identityType,
      ...(item.identity.displayName === "Alice"
        ? { contactName: "Alice" }
        : {}),
      source: item.identity.source,
      matched: item.matched,
      reason: item.reason,
      confidence: item.identity.confidence
    })),
    audit: {
      matched: resolved.audit.matched,
      unknown: resolved.audit.unknown,
      conflicts: resolved.audit.conflicts
    }
  };
}

async function resolveAmbiguous(rootDir: string, label: string) {
  const uploadId = "ambiguous_recording";
  const repository = new JsonSpeakerIdentityRepository(new JsonStore(rootDir));
  await repository.saveProfile({
    globalSpeakerId: "contact_candidate_one",
    userId: "ambiguous_test_user",
    contactName: "Candidate One",
    displayName: "Candidate One",
    identityType: "known_contact",
    status: "active",
    providerReference: {
      provider: "company_voiceprint",
      speakerLabel: label,
      lastRequestId: "ambiguous_request_one",
      operationType: "save"
    }
  });
  await repository.saveProfile({
    globalSpeakerId: "contact_candidate_two",
    userId: "ambiguous_test_user",
    contactName: "Candidate Two",
    displayName: "Candidate Two",
    identityType: "known_contact",
    status: "active",
    providerReference: {
      provider: "company_voiceprint",
      speakerLabel: label,
      lastRequestId: "ambiguous_request_two",
      operationType: "save"
    }
  });
  const chunk = buildTranscriptChunk(uploadId, "ambiguous_chunk", [label]);
  const hints: VoiceprintIdentityHint[] = await repository.loadVoiceprintHints([chunk]);
  const result = await resolveSpeakerIdentities({
    uploadId,
    chunks: [chunk],
    voiceprintHints: hints
  });
  const assignment = result.assignments[0];
  return {
    inputSpeakerLabel: safeLabel(label),
    duplicateProfileCount: 2,
    hintCount: hints.length,
    finalIdentityType: assignment.identity.identityType,
    matched: assignment.matched,
    reason: assignment.reason,
    pass:
      hints.length === 0 &&
      assignment.identity.identityType === "unknown_person" &&
      assignment.matched === false
  };
}

const failureInput: VoiceprintTrainInput = {
  userId: "vp_failure_fixture",
  requestId: "vp_failure_request",
  audio: [{ url: "https://audio.invalid/synthetic.wav", rule: [[0, 1_000]] }]
};

async function failureCase(
  name: "timeout" | "network_error" | "malformed_response"
) {
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    calls += 1;
    if (name === "network_error") throw new TypeError("synthetic network failure");
    if (name === "malformed_response") {
      return new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return await new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("aborted", "AbortError"));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const provider = new HttpVoiceprintProvider({
    baseUrl: "https://voiceprint.invalid",
    fetcher,
    timeoutMs: 1_000,
    maxRetries: 1,
    retryDelayMs: 0
  });
  const startedAt = Date.now();
  try {
    await provider.train(failureInput);
    return { status: "failed", reason: "unexpected_success", calls, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    const expectedReason = name === "malformed_response" ? "invalid_response" : name;
    const reason = error instanceof VoiceprintProviderError ? error.reason : "unexpected_error";
    const attemptCount = error instanceof VoiceprintProviderError ? error.attemptCount : null;
    const expectedCalls = name === "malformed_response" ? 1 : 2;
    return {
      status: reason === expectedReason && calls === expectedCalls ? "success" : "failed",
      reason,
      calls,
      attemptCount,
      elapsedMs: Date.now() - startedAt
    };
  }
}

function trainingRule(
  sample: Sample,
  voice: SyntheticVoice
): VoiceprintTrainingAudio["rule"] {
  const ranges = sample.timings
    .filter((timing) => timing.voice === voice)
    .map(({ startMs, endMs }): [number, number] => [
      startMs + 100,
      endMs - 100
    ])
    .filter(([startMs, endMs]) => endMs - startMs >= 500);
  if (ranges.length === 0) {
    throw new SmokeFailure("selected_speaker_training_ranges_missing");
  }
  return ranges;
}

function reportMarkdown(report: Record<string, unknown>, reportJsonSha256: string) {
  const remote = report.remote as Record<string, SafeStep>;
  const cases = report.cases as Record<string, Record<string, unknown>>;
  const cleanup = report.cleanup as Record<string, unknown>;
  const outcome = report.outcome as Record<string, unknown>;
  const diarizationOnly = report.mode === "speaker_labels_only";
  return [
    diarizationOnly
      ? "# Voiceprint Speaker Label Diagnostic Report"
      : "# Voiceprint Cross Record Smoke Report",
    "",
    "## Test environment",
    "",
    diarizationOnly
      ? "- Scope: company ASR/diarization speaker-label acquisition only."
      : "- Scope: real company Voiceprint Provider + Speaker Identity Resolver only.",
    "- Input: privacy-safe retained Microsoft Yaoyao/Kangkang synthetic speech.",
    "- Provider raw responses, transcript text, audio URLs, audio bytes, embeddings, and voice features were not persisted.",
    diarizationOnly
      ? "- Voiceprint train/save mutations were hard-disabled for this diagnostic."
      : "- The Provider documents no cleanup endpoint; successful train/save calls may leave isolated synthetic test state.",
    ...(!diarizationOnly
      ? [
          "- The documented `voiceprint/train` contract has no speaker-label field. The selected Recording A `speaker_1` ranges were trained under an isolated synthetic training-user scope; the Alice save and both recordings used a separate shared contact-user scope to avoid treating one identity as both known_user and known_contact.",
          "- Cross-record success requires Recording B to return the saved alias directly; Recording A manual mapping is not supplied to the B resolver."
        ]
      : []),
    "",
    "## Speaker label result",
    "",
    `- Diagnostic completed: ${outcome.diarizationDiagnosticCompleted ?? false}.`,
    `- Speaker result source: ${remote.asrRecordingA?.speakerResultSource ?? "none"}.`,
    `- Unique label count: ${remote.asrRecordingA?.labelCount ?? 0}.`,
    `- ASR ready latency: ${remote.asrRecordingA?.asrReadyMs ?? "-"} ms.`,
    `- Speaker wait latency: ${remote.asrRecordingA?.speakerWaitMs ?? "-"} ms.`,
    `- Next Voiceprint test ready: ${outcome.nextVoiceprintTestReady ?? false}.`,
    "",
    "## Real Provider flow",
    "",
    "| Step | Status | Latency |",
    "|---|---|---:|",
    `| ASR + diarization A | ${remote.asrRecordingA?.status ?? "not_tested"} | ${remote.asrRecordingA?.elapsedMs ?? "-"} ms |`,
    `| voiceprint/train | ${remote.train?.status ?? "not_tested"} | ${remote.train?.elapsedMs ?? "-"} ms |`,
    `| voiceprint/save | ${remote.save?.status ?? "not_tested"} | ${remote.save?.elapsedMs ?? "-"} ms |`,
    `| ASR + diarization B | ${remote.asrRecordingB?.status ?? "not_tested"} | ${remote.asrRecordingB?.elapsedMs ?? "-"} ms |`,
    "",
    "## Resolver cases",
    "",
    `- Case 1 known contact: ${cases.knownContact?.status ?? "not_tested"}.`,
    `- Case 2 unknown voice: ${cases.unknownVoice?.status ?? "not_tested"}.`,
    `- Case 3 ambiguous identity: ${cases.ambiguousIdentity?.status ?? "not_tested"}.`,
    `- Case 4 failure boundary: ${cases.providerFailures?.status ?? "not_tested"}.`,
    "",
    "## Cleanup and artifacts",
    "",
    `- Temporary audio removed: ${cleanup.audioRemoved}.`,
    `- Local audio server stopped: ${cleanup.serverStopped}.`,
    `- Quick tunnel stopped: ${cleanup.tunnelStopped}.`,
    "- Report files: 2.",
    `- report.json SHA-256: \`${reportJsonSha256}\`.`,
    "",
    "## Limits",
    "",
    "- This smoke checks retained five-minute synthetic samples, not real-user acoustic accuracy.",
    "- The real smoke sends each train/save mutation at most once with retry disabled. Separate local tests cover application idempotency; the supplied Provider document does not prove remote req_id deduplication after an ambiguous timeout.",
    "- Diarization labels are local speaker labels; the documented response exposes no embedding, confidence, or stable identity ID.",
    "- A contact resolves only when the later Provider label exactly and uniquely matches the saved alias; otherwise the resolver keeps unknown_person.",
    "- Resolver confidence is a local exact-alias confidence, not a Provider acoustic confidence; the documented Provider response exposes no confidence value.",
    ""
  ].join("\n");
}

async function main() {
  loadRuntimeEnv();
  if (!process.argv.includes("--remote") || process.env[REMOTE_GATE] !== "1") {
    throw new Error(`Real Voiceprint smoke requires --remote and ${REMOTE_GATE}=1`);
  }
  const diarizationOnly = process.argv.includes(DIARIZATION_ONLY_FLAG);

  const runId = `run-${new Date().toISOString().replace(/[:.]/gu, "").replace("T", "-").replace("Z", "")}`;
  const reportDir = join(REPORT_ROOT, runId);
  const tempRoot = join(tmpdir(), `daily-brief-voiceprint-smoke-${randomUUID()}`);
  await mkdir(REPORT_ROOT, { recursive: true });
  await mkdir(reportDir, { recursive: false });
  await mkdir(tempRoot, { recursive: true });

  const report: Record<string, unknown> = {
    version: 3,
    generatedAt: new Date().toISOString(),
    runId,
    mode: diarizationOnly ? "speaker_labels_only" : "full_voiceprint_smoke",
    safety: {
      evaluationOnly: true,
      syntheticVoicesOnly: true,
      voiceprintMutationsAllowed: !diarizationOnly,
      rawProviderResponsesPersisted: false,
      transcriptPersisted: false,
      audioPersisted: false,
      embeddingsPersisted: false,
      voiceFeaturesPersisted: false,
      productionModulesModified: false
    },
    environment: {
      node: process.version,
      platform: process.platform,
      audioFormat: "pcm_s16le/16000Hz/mono",
      audioDelivery: "ephemeral_https_quick_tunnel",
      tunnelProtocol: "quic",
      remoteMutationMaxRetries: 0,
      combinedAsrOnlyForCrossRecord: !diarizationOnly,
      minimumCrossRecordDurationMs: 60_000,
      sameContactUserScopeAcrossRecordings: true,
      trainingScopeSeparatedFromContactScope: !diarizationOnly,
      standaloneIdentifyApiCalled: false,
      jointSpeakerGraceMs: JOINT_SPEAKER_GRACE_MS,
      standaloneDiarizationTimeoutMs: STANDALONE_DIARIZATION_TIMEOUT_MS,
      voices: Object.values(voiceNames)
    },
    samples: {},
    remote: {},
    cases: {},
    failureInjection: {},
    cleanup: {
      audioRemoved: false,
      serverStopped: false,
      tunnelStopped: false
    },
    limitations: [
      "No Provider cleanup endpoint is documented.",
      "Remote req_id deduplication after an ambiguous timeout is not proven.",
      "Exact later speaker-label matching is the only current Provider-to-resolver identity bridge."
    ]
  };
  const remote = report.remote as Record<string, SafeStep>;
  const cases = report.cases as Record<string, Record<string, unknown>>;
  const cleanup = report.cleanup as Record<string, unknown>;
  const failureInjection = report.failureInjection as Record<string, unknown>;

  let server: Server | undefined;
  let tunnel: ChildProcess | undefined;
  let remoteFailed = false;
  let cleanupPromise: Promise<void> | undefined;
  const cleanupResources = () => {
    cleanupPromise ??= (async () => {
      cleanup.tunnelStopped = await stopChild(tunnel).catch(() => false);
      cleanup.serverStopped = await closeServer(server);
      const resolvedTemp = resolve(tempRoot);
      const expectedPrefix = resolve(tmpdir(), "daily-brief-voiceprint-smoke-");
      if (resolvedTemp.startsWith(expectedPrefix)) {
        await rm(resolvedTemp, { recursive: true, force: true });
      }
      cleanup.audioRemoved = !(await stat(tempRoot).then(() => true).catch(() => false));
    })();
    return cleanupPromise;
  };
  const terminate = () => {
    void cleanupResources().finally(() => {
      process.exit(130);
    });
  };
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
  try {
    const asrBaseUrl = process.env.SPEAKER_ASR_BASE_URL?.trim().replace(/\/+$/u, "");
    if (!asrBaseUrl) throw new SmokeFailure("speaker_asr_base_url_missing");
    const parsedAsrBase = new URL(asrBaseUrl);
    if (parsedAsrBase.protocol !== "http:" && parsedAsrBase.protocol !== "https:") {
      throw new SmokeFailure("speaker_asr_base_url_invalid");
    }

    const samples = await generateSamples(tempRoot);
    report.samples = Object.fromEntries(Object.values(samples).map((sample) => [
      sample.id,
      {
        durationMs: sample.durationMs,
        byteLength: sample.byteLength,
        utteranceCount: dialogues[sample.id].length,
        voices: [...new Set(dialogues[sample.id].map((item) => item.voice))]
      }
    ]));
    for (const sampleId of ["recording-a", "recording-b"] as const) {
      if (samples[sampleId].durationMs < 60_000) {
        throw new SmokeFailure("diarization_sample_too_short", {
          sampleId,
          minimumDurationMs: 60_000,
          actualDurationMs: samples[sampleId].durationMs
        });
      }
    }
    console.info("[voiceprint-smoke] synthetic_audio_ready samples=2");

    const audioServer = await startAudioServer(samples);
    server = audioServer.server;
    const tunnelResult = await startTunnel(audioServer.port);
    tunnel = tunnelResult.child;
    const preflight = await publicPreflight(tunnelResult.publicBase, audioServer.healthPath);
    (report.environment as Record<string, unknown>).publicAudioPreflight = preflight;
    console.info(
      `[voiceprint-smoke] public_audio_preflight=${preflight.reachable ? "ok" : "locally_unreachable"} attempts=${preflight.attempts}`
    );

    const routeEntries = [...audioServer.routes.entries()];
    const audioUrl = (sampleId: SampleId) => {
      const route = routeEntries.find(([, path]) => path === samples[sampleId].path)?.[0];
      if (!route) throw new SmokeFailure("audio_route_missing");
      return `${tunnelResult.publicBase}${route}`;
    };

    const suffix = randomUUID().replaceAll("-", "");
    const contactUserId = `vp_contact_smoke_${suffix}`;
    const trainingUserId = `vp_train_smoke_${suffix}`;
    let repository: JsonSpeakerIdentityRepository | undefined;
    let operationRepository: RecordingOperationRepository | undefined;
    let countedProvider: CountingVoiceprintProvider | undefined;
    let service: VoiceprintService | undefined;
    let selectedContactVoice: SyntheticVoice | undefined;
    let untrainedVoice: SyntheticVoice | undefined;
    if (!diarizationOnly) {
      const identityStore = new JsonStore(join(tempRoot, "identity-store"));
      repository = new JsonSpeakerIdentityRepository(identityStore);
      const operationDelegate = new JsonVoiceprintOperationRepository(identityStore);
      operationRepository = new RecordingOperationRepository(operationDelegate);
      const configuredRetries = process.env.VOICEPRINT_MAX_RETRIES;
      process.env.VOICEPRINT_MAX_RETRIES = "0";
      const realProvider = createConfiguredVoiceprintProvider();
      if (configuredRetries === undefined) delete process.env.VOICEPRINT_MAX_RETRIES;
      else process.env.VOICEPRINT_MAX_RETRIES = configuredRetries;
      countedProvider = new CountingVoiceprintProvider(realProvider);
      service = new VoiceprintService(
        countedProvider,
        repository,
        operationRepository
      );
    }

    const asrAStartedAt = Date.now();
    let asrA: AsrResult | undefined;
    try {
      asrA = await runAsr({
        baseUrl: asrBaseUrl,
        sampleId: "recording-a",
        audioUrl: audioUrl("recording-a"),
        userId: contactUserId,
        speakerCount: 2,
        combinedOnly: !diarizationOnly,
        ...(!diarizationOnly ? { requiredSpeakerLabel: "speaker_1" } : {})
      });
      remote.asrRecordingA = {
        status: "success",
        elapsedMs: asrA.elapsedMs,
        asrReadyMs: asrA.asrReadyMs,
        speakerWaitMs: asrA.speakerWaitMs,
        polls: asrA.polls,
        httpStatuses: asrA.httpStatuses,
        request: asrA.requestSummary,
        speakerResultSource: asrA.speakerResultSource,
        labelCount: asrA.labels.length,
        speakerLabels: asrA.labels.map(safeLabel),
        qualityGate: asrA.qualityGate,
        responseFields: asrA.payloadFields,
        jointAsr: asrA.jointAsr,
        ...(asrA.standaloneDiarization
          ? { standaloneDiarization: asrA.standaloneDiarization }
          : {}),
        separatedSpeakers: asrA.qualityGate.passed,
        expectedVoiceMappingEstablished: Boolean(asrA.voiceLabels.B && asrA.voiceLabels.C)
      };
      if (
        !diarizationOnly &&
        (
          asrA.speakerResultSource !== "combined_asr" ||
          !asrA.qualityGate.passed ||
          !asrA.voiceLabels.B ||
          !asrA.voiceLabels.C ||
          asrA.voiceLabels.B === asrA.voiceLabels.C
        )
      ) {
        throw new SmokeFailure("asr_manual_binding_ambiguous");
      }
      if (!diarizationOnly) {
        selectedContactVoice = (["B", "C"] as const).find(
          (voice) => asrA?.voiceLabels[voice] === "speaker_1"
        );
        untrainedVoice = (["B", "C"] as const).find(
          (voice) => voice !== selectedContactVoice
        );
        if (!selectedContactVoice || !untrainedVoice) {
          throw new SmokeFailure("asr_selected_speaker_mapping_missing");
        }
        remote.asrRecordingA = {
          ...remote.asrRecordingA,
          selectedLocalSpeaker: "speaker_1",
          selectedSyntheticVoice: selectedContactVoice,
          untrainedSyntheticVoice: untrainedVoice
        };
      }
    } catch (error) {
      remote.asrRecordingA = {
        status: "failed",
        elapsedMs: Date.now() - asrAStartedAt,
        failureReason: safeFailure(error),
        ...(error instanceof SmokeFailure && error.safeDetails
          ? { diagnostics: error.safeDetails }
          : {})
      };
      remoteFailed = true;
    }
    console.info(`[voiceprint-smoke] asr_recording_a=${remote.asrRecordingA.status}`);

    const trainRequestId = createVoiceprintProviderRequestId({
      operation: "train",
      userId: trainingUserId,
      clientRequestId: `train-${suffix}`
    });
    if (
      !remoteFailed &&
      !diarizationOnly &&
      service &&
      countedProvider &&
      operationRepository &&
      selectedContactVoice
    ) {
      const trainInput = {
        userId: trainingUserId,
        requestId: trainRequestId,
        audio: [{
          url: audioUrl("recording-a"),
          rule: trainingRule(samples["recording-a"], selectedContactVoice)
        }],
        displayName: "Synthetic Training User"
      };
      const startedAt = Date.now();
      try {
        const first = await service.trainUser(trainInput);
        if (
          first.operation.status !== "succeeded" ||
          (first.operation.resultMetadata.providerAttemptCount ?? 1) !== 1 ||
          first.operation.resultMetadata.providerCode !== 0 ||
          countedProvider.trainCalls !== 1
        ) {
          throw new SmokeFailure("train_acceptance_failed");
        }
        remote.train = {
          status: "success",
          elapsedMs: Date.now() - startedAt,
          requestIdSha256: sha256(trainRequestId),
          providerCode: first.operation.resultMetadata.providerCode,
          attemptCount: first.operation.resultMetadata.providerAttemptCount ?? null,
          retryCount: Math.max(0, (first.operation.resultMetadata.providerAttemptCount ?? 1) - 1),
          operationStatus: first.operation.status,
          operationTransitions: operationRepository.transitions.get(trainRequestId) ?? [],
          providerCalls: countedProvider.trainCalls,
          subjectIdentityType: "known_user",
          trainingRuleSource: "retained_fixture_silence_boundaries",
          selectedLocalSpeaker: "speaker_1",
          selectedSyntheticVoice: selectedContactVoice,
          trainingScopeSeparatedFromContactScope: true
        };
      } catch (error) {
        const failedOperation = await operationRepository.get(trainRequestId);
        remote.train = {
          status: "failed",
          elapsedMs: Date.now() - startedAt,
          requestIdSha256: sha256(trainRequestId),
          failureReason: safeFailure(error),
          providerCode: failedOperation?.resultMetadata.providerCode ?? null,
          httpStatus: failedOperation?.resultMetadata.httpStatus ?? null,
          attemptCount: failedOperation?.resultMetadata.providerAttemptCount ?? null,
          retryCount: Math.max(
            0,
            (failedOperation?.resultMetadata.providerAttemptCount ?? 1) - 1
          ),
          providerCalls: countedProvider.trainCalls,
          operationTransitions: operationRepository.transitions.get(trainRequestId) ?? []
        };
        remoteFailed = true;
      }
    } else {
      remote.train = {
        status: "skipped",
        failureReason: diarizationOnly
          ? "diarization_only_diagnostic"
          : "prior_remote_failure",
        providerCalls: 0
      };
    }
    console.info(`[voiceprint-smoke] train=${remote.train.status}`);

    const saveRequestId = createVoiceprintProviderRequestId({
      operation: "save",
      userId: contactUserId,
      clientRequestId: `save-${suffix}`
    });
    if (
      !remoteFailed &&
      !diarizationOnly &&
      asrA &&
      service &&
      countedProvider &&
      operationRepository
    ) {
      const contactLabelA = "speaker_1";
      const saveInput = {
        userId: contactUserId,
        requestId: saveRequestId,
        recordId: asrA.recordId,
        uploadId: "recording_a",
        chunkId: "recording_a_chunk_0",
        localSpeaker: contactLabelA,
        globalSpeakerId: "contact_alice",
        displayName: "Alice",
        providerSpeakerId: "Alice"
      };
      const startedAt = Date.now();
      try {
        const first = await service.saveContact(saveInput);
        if (
          first.operation.status !== "succeeded" ||
          first.mapping.globalSpeakerId !== "contact_alice" ||
          (first.operation.resultMetadata.providerAttemptCount ?? 1) !== 1 ||
          first.operation.resultMetadata.providerCode !== 0 ||
          countedProvider.saveCalls !== 1
        ) {
          throw new SmokeFailure("save_acceptance_failed");
        }
        remote.save = {
          status: "success",
          elapsedMs: Date.now() - startedAt,
          requestIdSha256: sha256(saveRequestId),
          inputSpeakerLabel: safeLabel(contactLabelA),
          savedAlias: "Alice",
          selectedSyntheticVoice: selectedContactVoice,
          providerCode: first.operation.resultMetadata.providerCode,
          attemptCount: first.operation.resultMetadata.providerAttemptCount ?? null,
          retryCount: Math.max(0, (first.operation.resultMetadata.providerAttemptCount ?? 1) - 1),
          operationStatus: first.operation.status,
          operationTransitions: operationRepository.transitions.get(saveRequestId) ?? [],
          mappingCreated: first.mapping.globalSpeakerId === "contact_alice",
          providerCalls: countedProvider.saveCalls
        };
      } catch (error) {
        const failedOperation = await operationRepository.get(saveRequestId);
        remote.save = {
          status: "failed",
          elapsedMs: Date.now() - startedAt,
          requestIdSha256: sha256(saveRequestId),
          failureReason: safeFailure(error),
          providerCode: failedOperation?.resultMetadata.providerCode ?? null,
          httpStatus: failedOperation?.resultMetadata.httpStatus ?? null,
          attemptCount: failedOperation?.resultMetadata.providerAttemptCount ?? null,
          retryCount: Math.max(
            0,
            (failedOperation?.resultMetadata.providerAttemptCount ?? 1) - 1
          ),
          providerCalls: countedProvider.saveCalls,
          operationTransitions: operationRepository.transitions.get(saveRequestId) ?? []
        };
        remoteFailed = true;
      }
    } else {
      remote.save = {
        status: "skipped",
        failureReason: diarizationOnly
          ? "diarization_only_diagnostic"
          : "prior_remote_failure",
        providerCalls: 0
      };
    }
    console.info(`[voiceprint-smoke] save=${remote.save.status}`);

    let asrB: AsrResult | undefined;
    if (!remoteFailed && !diarizationOnly && repository) {
      const startedAt = Date.now();
      try {
        asrB = await runAsr({
          baseUrl: asrBaseUrl,
          sampleId: "recording-b",
          audioUrl: audioUrl("recording-b"),
          userId: contactUserId,
          speakerCount: 2,
          combinedOnly: true
        });
        remote.asrRecordingB = {
          status: "success",
          elapsedMs: asrB.elapsedMs,
          asrReadyMs: asrB.asrReadyMs,
          speakerWaitMs: asrB.speakerWaitMs,
          polls: asrB.polls,
          httpStatuses: asrB.httpStatuses,
          request: asrB.requestSummary,
          speakerResultSource: asrB.speakerResultSource,
          labelCount: asrB.labels.length,
          speakerLabels: asrB.labels.map(safeLabel),
          qualityGate: asrB.qualityGate,
          responseFields: asrB.payloadFields,
          jointAsr: asrB.jointAsr,
          expectedVoiceMappingEstablished: Boolean(
            selectedContactVoice &&
            untrainedVoice &&
            asrB.voiceLabels[selectedContactVoice] &&
            asrB.voiceLabels[untrainedVoice]
          )
        };
        if (
          asrB.speakerResultSource !== "combined_asr" ||
          !asrB.qualityGate.passed ||
          !selectedContactVoice ||
          !untrainedVoice
        ) {
          throw new SmokeFailure("recording_b_diarization_gate_failed");
        }
        const resolved = await resolveRealLabels({
          repository,
          uploadId: "recording_b",
          labels: asrB.labels
        });
        const expectedContactLabel = asrB.voiceLabels[selectedContactVoice];
        const expectedUnknownLabel = asrB.voiceLabels[untrainedVoice];
        const contactAssignment = resolved.assignments.find(
          (item) => item.inputSpeakerLabel === safeLabel(expectedContactLabel)
        );
        const unknownAssignment = resolved.assignments.find(
          (item) => item.inputSpeakerLabel === safeLabel(expectedUnknownLabel)
        );
        const contactPassed =
          expectedContactLabel === "Alice" &&
          resolved.hintCount === 1 &&
          contactAssignment?.identityType === "known_contact" &&
          contactAssignment.contactName === "Alice" &&
          contactAssignment.source === "voiceprint" &&
          contactAssignment.reason === "voiceprint_match" &&
          contactAssignment.matched === true &&
          resolved.assignments.filter(
            (item) => item.identityType === "known_contact"
          ).length === 1;
        const unknownPassed =
          Boolean(expectedUnknownLabel) &&
          expectedUnknownLabel !== "Alice" &&
          unknownAssignment?.identityType === "unknown_person" &&
          unknownAssignment.matched === false &&
          unknownAssignment.reason === "no_matching_evidence" &&
          resolved.assignments.filter(
            (item) => item.identityType === "unknown_person"
          ).length === 1;
        cases.knownContact = {
          status: contactPassed ? "success" : "failed",
          expectedVoiceProviderLabel: safeLabel(expectedContactLabel),
          providerAliasObserved: expectedContactLabel === "Alice",
          finalIdentityType: contactAssignment?.identityType ?? "unknown_person",
          contactName: contactAssignment?.contactName ?? null,
          source: contactAssignment?.source ?? null,
          reason: contactAssignment?.reason ?? "no_match",
          matched: contactAssignment?.matched ?? false,
          resolverConfidence: contactAssignment?.confidence ?? 0,
          providerConfidenceAvailable: false,
          manualMappingInputUsed: false,
          matcherUsed: false,
          resolver: resolved
        };
        cases.unknownVoice = {
          status: unknownPassed ? "success" : "failed",
          expectedVoiceProviderLabel: safeLabel(expectedUnknownLabel),
          finalIdentityType: unknownAssignment?.identityType ?? "unknown_person",
          source: unknownAssignment?.source ?? null,
          reason: unknownAssignment?.reason ?? "no_match",
          matched: unknownAssignment?.matched ?? false
        };
        if (!contactPassed || !unknownPassed) {
          remoteFailed = true;
        }
      } catch (error) {
        remote.asrRecordingB = {
          status: "failed",
          elapsedMs: Date.now() - startedAt,
          failureReason: safeFailure(error)
        };
        cases.knownContact = {
          status: "failed",
          failureReason: "recording_b_asr_or_resolution_failed"
        };
        cases.unknownVoice = {
          status: "failed",
          failureReason: "recording_b_asr_or_resolution_failed"
        };
        remoteFailed = true;
      }
    } else {
      const failureReason = diarizationOnly
        ? "diarization_only_diagnostic"
        : "prior_remote_failure";
      remote.asrRecordingB = { status: "skipped", failureReason };
      cases.knownContact = { status: "skipped", failureReason };
      cases.unknownVoice = { status: "skipped", failureReason };
    }
    console.info(`[voiceprint-smoke] asr_recording_b=${remote.asrRecordingB.status}`);

    const ambiguousLabel = asrB?.labels[0] ?? "speaker_1";
    cases.ambiguousIdentity = await resolveAmbiguous(
      join(tempRoot, "ambiguous-identity-store"),
      ambiguousLabel
    );
    cases.ambiguousIdentity.status = cases.ambiguousIdentity.pass ? "success" : "failed";
  } catch (error) {
    report.fatalFailure = safeFailure(error);
    console.info(`[voiceprint-smoke] fatal_failure=${safeFailure(error)}`);
  } finally {
    const timeoutFailure = await failureCase("timeout");
    const networkFailure = await failureCase("network_error");
    const malformedFailure = await failureCase("malformed_response");
    failureInjection.timeout = timeoutFailure;
    failureInjection.networkError = networkFailure;
    failureInjection.malformedResponse = malformedFailure;
    cases.providerFailures = {
      status: [timeoutFailure, networkFailure, malformedFailure].every(
        (item) => item.status === "success"
      ) ? "success" : "failed",
      realProviderMutationUsed: false
    };

    await cleanupResources();
    process.removeListener("SIGINT", terminate);
    process.removeListener("SIGTERM", terminate);
  }

  report.completedAt = new Date().toISOString();
  const caseValues = Object.values(cases);
  const asrRecordingA = remote.asrRecordingA;
  const asrRecordingB = remote.asrRecordingB;
  const diarizationDiagnosticCompleted =
    asrRecordingA?.status === "success" &&
    asrRecordingA?.qualityGate !== undefined &&
    (asrRecordingA.qualityGate as CombinedDiarizationQualityGate).passed;
  const recordingBQualityGatePassed =
    asrRecordingB?.status === "success" &&
    asrRecordingB?.qualityGate !== undefined &&
    (asrRecordingB.qualityGate as CombinedDiarizationQualityGate).passed;
  const voiceprintMutationProviderCalls =
    Number(remote.train?.providerCalls ?? 0) +
    Number(remote.save?.providerCalls ?? 0);
  report.outcome = {
    diarizationDiagnosticCompleted,
    speakerResultSource: asrRecordingA?.speakerResultSource ?? null,
    nextVoiceprintTestReady:
      diarizationDiagnosticCompleted &&
      asrRecordingA?.expectedVoiceMappingEstablished === true,
    recordingBQualityGatePassed,
    voiceprintMutationProviderCalls,
    realProviderFlowCompleted:
      remote.train?.status === "success" &&
      remote.save?.status === "success" &&
      remote.asrRecordingB?.status === "success" &&
      recordingBQualityGatePassed &&
      cases.knownContact?.status === "success" &&
      cases.unknownVoice?.status === "success" &&
      voiceprintMutationProviderCalls === 2,
    resolverCasesPassed: caseValues.filter((item) => item.status === "success").length,
    resolverCasesTotal: caseValues.length,
    remoteFailureObserved: Object.values(remote).some((item) => item.status === "failed")
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const jsonHash = sha256(json);
  await writeFile(join(reportDir, "report.json"), json, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await writeFile(
    join(reportDir, "report.md"),
    `${reportMarkdown(report, jsonHash)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" }
  );
  console.info(
    `[voiceprint-smoke] report_written files=2 report_json_sha256=${jsonHash}`
  );
}

main().catch((error) => {
  console.error(
    `[voiceprint-smoke] startup_failed error_name=${error instanceof Error ? error.name : "unknown"}`
  );
  process.exitCode = 1;
});

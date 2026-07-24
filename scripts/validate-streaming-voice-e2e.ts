import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium, type BrowserContext, type Page, type Response } from "playwright";

import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";
import {
  VoiceSessionTraceSchema,
  type VoiceSessionTrace
} from "@/lib/server/voice-qa/trace";
import {
  VoiceSessionSchema,
  type VoiceSessionState
} from "@/lib/server/voice-qa/session-manager";
import { VoiceBrowserStreamEventSchema } from "@/lib/voice-browser-stream";

type EvaluationScenario = "single_sentence" | "multi_sentence" | "uncertainty" | "cancel";
type VoiceScope = "current" | "week" | "all";
type AnswerMode = "agent" | "direct";
export type StreamingVoiceExpectedOutcome =
  | "streaming_success"
  | "safe_fallback"
  | "aborted";
export type StreamingVoiceObservedOutcome = StreamingVoiceExpectedOutcome | "unexpected";

export const STREAMING_VOICE_EXPECTED_OUTCOMES = {
  single: "streaming_success",
  multi: "streaming_success",
  uncertainty: "safe_fallback",
  cancel: "aborted"
} as const satisfies Record<string, StreamingVoiceExpectedOutcome>;

export type StreamingVoiceE2eOptions = {
  port: number;
  scope: VoiceScope;
  answerMode: AnswerMode;
  timeoutMs: number;
  headed: boolean;
  reportPath: string;
  dataDir: string;
  audio: Record<EvaluationScenario, string>;
};

type QaStreamLog = {
  observed: boolean;
  status?: string;
  firstTokenMs?: number | null;
  firstSentenceMs?: number | null;
  totalStreamMs?: number | null;
  tokenChunkCount?: number;
  sentenceCount?: number;
  providerCallCount?: number;
  fallbackReasonPresent?: boolean;
};

type BrowserTelemetry = {
  playbackStartedAt?: string;
  audioPlayStartedAt?: string;
  sessionCompletedAt?: string;
  sessionOutcome?: string;
  traceId?: string;
};

export type StreamingVoiceOutcomeSnapshot = {
  response?: {
    status?: string;
    answerPresent: boolean;
    audioChunkCount: number;
    chunkOrderingValid: boolean;
    fallbackAudioPresent: boolean;
  };
  trace: {
    status?: string;
    timestamps: {
      playback_started?: string;
      audio_play_started?: string;
      stream_completed?: string;
      session_completed?: string;
    };
  } | null;
  browserOutcome?: string;
  qaStreamTrace?: {
    observed: boolean;
    status?: string;
    fallbackReasonPresent?: boolean;
  };
  cancelled?: boolean;
  voiceSessionState?: VoiceSessionState | null;
};

export type SanitizedStreamSummary = {
  traceId?: string;
  status?: string;
  eventCount: number;
  eventCounts: Record<string, number>;
  audioChunkCount: number;
  sentenceAudioCount: number;
  audioBytes: number;
  audioSha256?: string;
  sequenceSha256?: string;
  chunkOrderingValid: boolean;
  transcriptPresent: boolean;
  transcriptChars: number;
  transcriptSha256?: string;
  answerPresent: boolean;
  answerChars: number;
  answerSha256?: string;
  answerSentenceCount: number;
  citationCount: number;
  citationMarkersRemoved: boolean;
  uncertaintyPreserved: boolean;
  fallbackAudioPresent: boolean;
  errorCount: number;
};

type SanitizedLegacySummary = {
  traceId?: string;
  transcriptPresent: boolean;
  transcriptChars: number;
  transcriptSha256?: string;
  answerPresent: boolean;
  answerChars: number;
  answerSha256?: string;
  citationCount: number;
  citationMarkersRemoved: boolean;
  uncertaintyPreserved: boolean;
  audioPresent: boolean;
  audioBytes: number;
  audioSha256?: string;
  errorCount: number;
};

const REQUIRED_PROVIDER_ENV = [
  "VOLCENGINE_APP_ID",
  "VOLCENGINE_ACCESS_KEY",
  "VOLCENGINE_APP_KEY",
  "VOLCENGINE_RESOURCE_ID"
] as const;
const TRACE_EVENTS = [
  "speech_ended",
  "asr_final_received",
  "qa_started",
  "qa_completed",
  "first_sentence_committed",
  "first_safe_sentence",
  "tts_stream_started",
  "first_audio_chunk_received",
  "playback_started",
  "audio_play_started",
  "stream_completed",
  "session_completed"
] as const;
const CITATION_MARKER_PATTERN = /(?:\[(?:E|S)\d+\]|【(?:E|S)\d+】)/iu;
const UNCERTAINTY_PATTERN = /(?:目前|暂时|尚未|未确认|不确定|没有(?:找到|足够)?证据|无法确认|不能确认|还不能确认|当前未知)/u;

function requiredValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1];
  if (!value?.trim() || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function boundedInteger(value: string, flag: string, minimum: number, maximum: number) {
  if (!/^\d+$/u.test(value)) throw new Error(`${flag} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${flag} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function defaultReportPath(dataDir: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return resolve(dataDir, "evaluation", "streaming-voice-e2e", timestamp, "report.json");
}

export function streamingVoiceE2eHelp() {
  return `Usage:
  npm run voice:streaming:e2e -- \\
    --single-audio <single-sentence-question.wav> \\
    --multi-audio <multi-sentence-question.wav> \\
    --uncertainty-audio <uncertainty-question.wav>

Required environment (values are never printed or stored in the report):
  RUN_STREAMING_VOICE_REMOTE_VERIFY=1
  EVALUATION_MODE=true
  LONG_RECORDING_EVAL_EMAIL
  LONG_RECORDING_EVAL_PASSWORD
  VOLCENGINE_APP_ID / VOLCENGINE_ACCESS_KEY / VOLCENGINE_APP_KEY / VOLCENGINE_RESOURCE_ID

Options:
  --cancel-audio <path>     Defaults to --single-audio.
  --scope current|week|all Defaults to all.
  --answer-mode agent|direct
  --port <number>           Defaults to 3216; must be free.
  --timeout-seconds <n>     30-900; defaults to 240.
  --data-dir <path>         Shared local evaluation data root.
  --report <path>           Must be a new file below APP_DATA_DIR/evaluation.
  --headed                  Show Chromium while the test runs.
`;
}

export function parseStreamingVoiceE2eArgs(
  argv: string[],
  environment: Readonly<Record<string, string | undefined>> = process.env
): StreamingVoiceE2eOptions {
  const dataDir = resolve(environment.APP_DATA_DIR?.trim() || ".data");
  const options: Omit<StreamingVoiceE2eOptions, "audio"> & {
    audio: Partial<Record<EvaluationScenario, string>>;
  } = {
    port: 3216,
    scope: "all",
    answerMode: "agent",
    timeoutMs: 240_000,
    headed: false,
    reportPath: defaultReportPath(dataDir),
    dataDir,
    audio: {}
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--headed") {
      options.headed = true;
      continue;
    }
    const value = requiredValue(argv, index, argument);
    index += 1;
    if (argument === "--port") {
      options.port = boundedInteger(value, argument, 1, 65_535);
    } else if (argument === "--timeout-seconds") {
      options.timeoutMs = boundedInteger(value, argument, 30, 900) * 1_000;
    } else if (argument === "--scope") {
      if (value !== "current" && value !== "week" && value !== "all") {
        throw new Error("--scope must be current, week, or all");
      }
      options.scope = value;
    } else if (argument === "--answer-mode") {
      if (value !== "agent" && value !== "direct") {
        throw new Error("--answer-mode must be agent or direct");
      }
      options.answerMode = value;
    } else if (argument === "--report") {
      options.reportPath = resolve(value);
    } else if (argument === "--data-dir") {
      options.dataDir = resolve(value);
      if (!argv.includes("--report")) options.reportPath = defaultReportPath(options.dataDir);
    } else if (argument === "--single-audio") {
      options.audio.single_sentence = resolve(value);
    } else if (argument === "--multi-audio") {
      options.audio.multi_sentence = resolve(value);
    } else if (argument === "--uncertainty-audio") {
      options.audio.uncertainty = resolve(value);
    } else if (argument === "--cancel-audio") {
      options.audio.cancel = resolve(value);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  const missingAudio = (["single_sentence", "multi_sentence", "uncertainty"] as const)
    .filter((scenario) => !options.audio[scenario]);
  if (missingAudio.length > 0) {
    throw new Error(`Missing required fake microphone WAV inputs: ${missingAudio.join(", ")}`);
  }
  options.audio.cancel ??= options.audio.single_sentence;
  return options as StreamingVoiceE2eOptions;
}

export function assertStreamingVoiceRemoteEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env
) {
  if (environment.RUN_STREAMING_VOICE_REMOTE_VERIFY?.trim() !== "1") {
    throw new Error("RUN_STREAMING_VOICE_REMOTE_VERIFY=1 is required; remote verification is disabled by default");
  }
  if (environment.EVALUATION_MODE?.trim().toLowerCase() !== "true") {
    throw new Error("EVALUATION_MODE=true is required for the isolated remote smoke test");
  }
  const missing = [
    ...REQUIRED_PROVIDER_ENV.filter((name) => !environment[name]?.trim()),
    ...(["LONG_RECORDING_EVAL_EMAIL", "LONG_RECORDING_EVAL_PASSWORD"] as const)
      .filter((name) => !environment[name]?.trim())
  ];
  if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  if (environment.VOICE_PROVIDER?.trim() && environment.VOICE_PROVIDER.trim() !== "volcengine") {
    throw new Error("VOICE_PROVIDER must be volcengine for real streaming validation");
  }
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function sentenceCount(text: string) {
  return text.split(/[。！？!?]+/u).map((value) => value.trim()).filter(Boolean).length;
}

function safeBase64Size(value: string) {
  return Buffer.from(value, "base64").byteLength;
}

function validateAudioOrdering(chunks: Array<{
  sequence: number;
  sentenceSequence: number;
  chunkSequence: number;
}>) {
  const sentenceLastChunk = new Map<number, number>();
  let lastSentence = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk.sequence !== index + 1 || chunk.sentenceSequence < lastSentence) return false;
    const expectedSentenceChunk = (sentenceLastChunk.get(chunk.sentenceSequence) ?? 0) + 1;
    if (chunk.chunkSequence !== expectedSentenceChunk) return false;
    sentenceLastChunk.set(chunk.sentenceSequence, chunk.chunkSequence);
    lastSentence = chunk.sentenceSequence;
  }
  return true;
}

export function summarizeVoiceNdjson(raw: string): SanitizedStreamSummary {
  const events = raw.split(/\r?\n/u).filter((line) => line.trim()).map((line) => (
    VoiceBrowserStreamEventSchema.parse(JSON.parse(line) as unknown)
  ));
  const eventCounts: Record<string, number> = {};
  for (const event of events) eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
  const meta = events.find((event) => event.type === "meta");
  const answer = events.find((event) => event.type === "answer");
  const complete = [...events].reverse().find((event) => event.type === "complete");
  const fallback = events.find((event) => event.type === "fallback_audio");
  const chunks = events.filter((event) => event.type === "audio_chunk");
  const audioHash = createHash("sha256");
  let audioBytes = 0;
  for (const chunk of chunks) {
    const bytes = Buffer.from(chunk.audioBase64, "base64");
    audioBytes += bytes.byteLength;
    audioHash.update(bytes);
  }
  const sequence = chunks.map((chunk) => ({
    sequence: chunk.sequence,
    sentenceSequence: chunk.sentenceSequence,
    chunkSequence: chunk.chunkSequence
  }));
  const answerText = answer?.text ?? "";
  const transcript = answer?.transcript ?? "";
  return {
    ...(meta?.type === "meta" ? { traceId: meta.traceId } : {}),
    ...(complete?.type === "complete" ? { status: complete.status } : {}),
    eventCount: events.length,
    eventCounts,
    audioChunkCount: chunks.length,
    sentenceAudioCount: new Set(chunks.map((chunk) => chunk.sentenceSequence)).size,
    audioBytes,
    ...(chunks.length > 0 ? { audioSha256: audioHash.digest("hex") } : {}),
    ...(sequence.length > 0 ? { sequenceSha256: sha256(JSON.stringify(sequence)) } : {}),
    chunkOrderingValid: validateAudioOrdering(sequence),
    transcriptPresent: Boolean(transcript.trim()),
    transcriptChars: transcript.length,
    ...(transcript ? { transcriptSha256: sha256(transcript) } : {}),
    answerPresent: Boolean(answerText.trim()),
    answerChars: answerText.length,
    ...(answerText ? { answerSha256: sha256(answerText) } : {}),
    answerSentenceCount: sentenceCount(answerText),
    citationCount: answer?.answer?.citations.length ?? 0,
    citationMarkersRemoved: !CITATION_MARKER_PATTERN.test(answerText),
    uncertaintyPreserved: UNCERTAINTY_PATTERN.test(answerText),
    fallbackAudioPresent: Boolean(fallback),
    errorCount: events.filter((event) => event.type === "error").length +
      (complete?.type === "complete" ? complete.errors.length : 0)
  };
}

export function summarizeLegacyVoiceResponse(raw: string): SanitizedLegacySummary {
  const value = JSON.parse(raw) as Record<string, unknown>;
  const transcript = typeof value.transcript === "string" ? value.transcript : "";
  const answerText = typeof value.text === "string" ? value.text : "";
  const audioBase64 = typeof value.audioBase64 === "string" ? value.audioBase64 : "";
  const answer = value.answer && typeof value.answer === "object" && !Array.isArray(value.answer)
    ? value.answer as Record<string, unknown>
    : undefined;
  const citations = Array.isArray(answer?.citations) ? answer.citations : [];
  const errors = Array.isArray(value.errors) ? value.errors : [];
  return {
    ...(typeof value.traceId === "string" ? { traceId: value.traceId } : {}),
    transcriptPresent: Boolean(transcript.trim()),
    transcriptChars: transcript.length,
    ...(transcript ? { transcriptSha256: sha256(transcript) } : {}),
    answerPresent: Boolean(answerText.trim()),
    answerChars: answerText.length,
    ...(answerText ? { answerSha256: sha256(answerText) } : {}),
    citationCount: citations.length,
    citationMarkersRemoved: !CITATION_MARKER_PATTERN.test(answerText),
    uncertaintyPreserved: UNCERTAINTY_PATTERN.test(answerText),
    audioPresent: Boolean(audioBase64),
    audioBytes: audioBase64 ? safeBase64Size(audioBase64) : 0,
    ...(audioBase64 ? { audioSha256: sha256(Buffer.from(audioBase64, "base64")) } : {}),
    errorCount: errors.length
  };
}

export function summarizeVoiceTrace(trace: VoiceSessionTrace) {
  const timestamps = Object.fromEntries(
    TRACE_EVENTS.flatMap((event) => trace.timestamps[event] ? [[event, trace.timestamps[event]]] : [])
  );
  return {
    traceId: trace.sessionId,
    status: trace.status,
    timestamps,
    latencies: trace.latencies,
    streamingLatencies: trace.streamingLatencies ?? null,
    failureCount: trace.failures.length
  };
}

export function classifyStreamingVoiceOutcome(
  input: StreamingVoiceOutcomeSnapshot
): StreamingVoiceObservedOutcome {
  const response = input.response;
  const trace = input.trace;
  const qaStreamTrace = input.qaStreamTrace;

  if (
    input.cancelled === true &&
    input.browserOutcome === "aborted" &&
    trace?.status === "aborted" &&
    Boolean(trace.timestamps.session_completed)
  ) {
    return "aborted";
  }
  if (
    response?.status === "completed" &&
    response.answerPresent &&
    response.audioChunkCount > 0 &&
    response.chunkOrderingValid &&
    !response.fallbackAudioPresent &&
    qaStreamTrace?.observed === true &&
    qaStreamTrace.status === "completed" &&
    !qaStreamTrace.fallbackReasonPresent &&
    trace?.status === "completed" &&
    Boolean(trace.timestamps.playback_started) &&
    Boolean(trace.timestamps.stream_completed) &&
    input.browserOutcome === "completed"
  ) {
    return "streaming_success";
  }
  if (
    response?.status === "completed" &&
    response.answerPresent &&
    response.audioChunkCount === 0 &&
    response.chunkOrderingValid &&
    response.fallbackAudioPresent &&
    qaStreamTrace?.observed === true &&
    qaStreamTrace.status === "completed_with_fallback" &&
    qaStreamTrace.fallbackReasonPresent === true &&
    trace?.status === "completed" &&
    Boolean(trace.timestamps.audio_play_started) &&
    input.browserOutcome === "completed"
  ) {
    return "safe_fallback";
  }
  return "unexpected";
}

export function matchesStreamingVoiceExpectedOutcome(
  expected: StreamingVoiceExpectedOutcome,
  input: StreamingVoiceOutcomeSnapshot
) {
  if (classifyStreamingVoiceOutcome(input) !== expected) return false;
  return expected !== "aborted" || input.voiceSessionState === "IDLE";
}

export function parseQaStreamTraceLine(line: string): QaStreamLog | null {
  const marker = "QA_STREAM_TRACE:";
  const index = line.indexOf(marker);
  if (index < 0) return null;
  try {
    const value = JSON.parse(line.slice(index + marker.length).trim()) as Record<string, unknown>;
    const numberOrNull = (key: string) => typeof value[key] === "number" || value[key] === null
      ? value[key] as number | null
      : undefined;
    return {
      observed: true,
      ...(typeof value.status === "string" ? { status: value.status } : {}),
      firstTokenMs: numberOrNull("first_token_ms"),
      firstSentenceMs: numberOrNull("first_sentence_ms"),
      totalStreamMs: numberOrNull("total_stream_ms"),
      ...(typeof value.token_chunk_count === "number" ? { tokenChunkCount: value.token_chunk_count } : {}),
      ...(typeof value.sentence_count === "number" ? { sentenceCount: value.sentence_count } : {}),
      ...(typeof value.provider_call_count === "number" ? { providerCallCount: value.provider_call_count } : {}),
      fallbackReasonPresent: value.fallback_reason !== null && value.fallback_reason !== undefined
    };
  } catch {
    return null;
  }
}

class ServerObserver {
  readonly qaStreamTraces: QaStreamLog[] = [];
  private remainder = "";

  accept(chunk: Buffer | string) {
    this.remainder += chunk.toString();
    const lines = this.remainder.split(/\r?\n/u);
    this.remainder = lines.pop() ?? "";
    for (const line of lines) {
      const parsed = parseQaStreamTraceLine(line);
      if (parsed) this.qaStreamTraces.push(parsed);
    }
  }
}

async function assertPortAvailable(port: number) {
  await new Promise<void>((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePromise()));
  });
}

function startNext(port: number, dataDir: string, observer: ServerObserver) {
  const child = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "dev", "-p", String(port)],
    {
      cwd: process.cwd(),
      env: { ...process.env, APP_DATA_DIR: dataDir },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  child.stdout.on("data", (chunk: Buffer) => observer.accept(chunk));
  child.stderr.on("data", (chunk: Buffer) => observer.accept(chunk));
  return child;
}

async function waitForServer(baseUrl: string, timeoutMs: number) {
  const deadline = Date.now() + Math.min(timeoutMs, 180_000);
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
    } catch {
      // Server compilation and startup are expected to refuse connections briefly.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error("local_next_server_start_timeout");
}

async function stopChild(child: ReturnType<typeof startNext>) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())),
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5_000))
  ]);
}

function readWavDurationMs(bytes: Buffer) {
  if (bytes.length < 44 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.subarray(8, 12).toString("ascii") !== "WAVE") {
    throw new Error("Fake microphone input must be a RIFF/WAVE file");
  }
  let offset = 12;
  let byteRate: number | undefined;
  let dataBytes: number | undefined;
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "fmt " && size >= 16 && offset + 8 + size <= bytes.length) {
      byteRate = bytes.readUInt32LE(offset + 8 + 8);
    }
    if (id === "data") {
      dataBytes = Math.min(size, Math.max(0, bytes.length - offset - 8));
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!byteRate || dataBytes === undefined) throw new Error("WAV input has no usable fmt/data chunks");
  return Math.ceil((dataBytes / byteRate) * 1_000);
}

async function inspectAudio(path: string) {
  if (extname(path).toLowerCase() !== ".wav" || !existsSync(path)) {
    throw new Error("Each fake microphone input must be an existing .wav file");
  }
  const bytes = await readFile(path);
  const durationMs = readWavDurationMs(bytes);
  if (durationMs < 500 || durationMs > 55_000) {
    throw new Error("Each fake microphone WAV must be between 0.5 and 55 seconds");
  }
  return {
    durationMs,
    fileBytes: bytes.byteLength,
    fileSha256: sha256(bytes)
  };
}

export function assertEvaluationReportPath(dataDir: string, reportPath: string) {
  const evaluationRoot = resolve(dataDir, "evaluation");
  const relativePath = relative(evaluationRoot, resolve(reportPath));
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("--report must be a new file below APP_DATA_DIR/evaluation");
  }
  if (existsSync(reportPath)) throw new Error("Evaluation report already exists; choose a new --report path");
}

async function authenticate(
  context: BrowserContext,
  baseUrl: string,
  email: string,
  password: string
) {
  // BrowserContext.request shares its cookie jar with the page. This keeps the
  // credential out of DOM snapshots and avoids coupling the evaluation to the
  // presentation details of the login form.
  const authResponse = await context.request.post(`${baseUrl}/api/auth/login`, {
    data: { email, password }
  });
  if (!authResponse.ok()) throw new Error(`test_account_login_failed_${authResponse.status()}`);
  const payload = await authResponse.json() as { user?: { id?: unknown } };
  const user = typeof payload.user?.id === "string" ? payload.user.id : "";
  if (!/^[A-Za-z0-9_-]+$/u.test(user)) throw new Error("authenticated_test_user_id_missing");
  return user;
}

async function openVoicePanel(page: Page, scope: VoiceScope, answerMode: AnswerMode) {
  if (answerMode !== "agent") {
    throw new Error("direct_voice_ui_unavailable");
  }

  const navButtons = page.locator("button.nav-btn");
  if (await navButtons.count() < 3) throw new Error("qa_navigation_not_found");
  await navButtons.nth(2).click();
  const scopeButtons = page.locator(".qa-scope-nav button.mem-day");
  const scopeIndex = scope === "current" ? 0 : scope === "week" ? 1 : 2;
  const scopeButton = scopeButtons.nth(scopeIndex);
  if (await scopeButton.isDisabled()) throw new Error(`voice_scope_unavailable_${scope}`);
  await scopeButton.click();
  const panel = page.locator(
    `.voice-qa-composer-control[data-answer-mode="agent"]`
  );
  await panel.waitFor({ state: "visible" });
  const button = panel.locator("button.voice-qa-button");
  await button.waitFor({ state: "visible" });
  if (await button.isDisabled()) throw new Error("voice_question_button_disabled");
  return { panel, button };
}

function voiceQaResponse(response: Response) {
  return response.request().method() === "POST" && new URL(response.url()).pathname === "/api/voice/qa";
}

function observeBrowserTelemetry(page: Page) {
  const telemetry: BrowserTelemetry = {};
  page.on("request", (request) => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/voice/trace") return;
    try {
      const payload = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      if (typeof payload.traceId === "string") telemetry.traceId = payload.traceId;
      const at = new Date().toISOString();
      if (payload.event === "playback_started") telemetry.playbackStartedAt = at;
      if (payload.event === "audio_play_started") telemetry.audioPlayStartedAt = at;
      if (payload.event === "session_completed") {
        telemetry.sessionCompletedAt = at;
        if (typeof payload.outcome === "string") telemetry.sessionOutcome = payload.outcome;
      }
    } catch {
      // Invalid telemetry is handled by the production endpoint; the harness never logs its body.
    }
  });
  return telemetry;
}

async function waitForTrace(
  dataDir: string,
  userId: string,
  traceId: string,
  timeoutMs: number
) {
  const path = resolve(dataDir, "users", userId, "voice-session-traces", `${traceId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const trace = VoiceSessionTraceSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (trace.status !== "in_progress") return trace;
    } catch {
      // Browser telemetry is asynchronous; wait for the atomic JsonStore write.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("voice_trace_terminal_state_timeout");
}

async function waitForVoiceSessionIdle(
  dataDir: string,
  userId: string,
  sessionId: string,
  timeoutMs: number
) {
  const path = resolve(dataDir, "users", userId, "voice-sessions", `${sessionId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const session = VoiceSessionSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (session.state === "IDLE" || session.state === "CLOSED") return session.state;
    } catch {
      // The abort and JsonStore write are asynchronous; wait for the synchronized state.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return null;
}

async function launchScenarioPage(input: {
  audioPath: string;
  baseUrl: string;
  headed: boolean;
  legacy: boolean;
  email: string;
  password: string;
  scope: VoiceScope;
  answerMode: AnswerMode;
}) {
  const browser = await chromium.launch({
    headless: !input.headed,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${input.audioPath}`,
      "--autoplay-policy=no-user-gesture-required"
    ]
  });
  const context = await browser.newContext();
  await context.grantPermissions(["microphone"], { origin: input.baseUrl });
  if (input.legacy) {
    await context.addInitScript(() => {
      Object.defineProperty(globalThis, "AudioContext", { value: undefined, configurable: true });
      Object.defineProperty(globalThis, "webkitAudioContext", { value: undefined, configurable: true });
    });
  }
  const page = await context.newPage();
  const telemetry = observeBrowserTelemetry(page);
  const userId = await authenticate(context, input.baseUrl, input.email, input.password);
  await page.goto(input.baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("button.nav-btn").length === 3);
  const panel = await openVoicePanel(page, input.scope, input.answerMode);
  return { browser, page, telemetry, userId, ...panel };
}

async function runCompletedScenario(input: {
  scenario: Exclude<EvaluationScenario, "cancel">;
  audioPath: string;
  audioDurationMs: number;
  baseUrl: string;
  options: StreamingVoiceE2eOptions;
  email: string;
  password: string;
  observer: ServerObserver;
  legacy?: boolean;
}) {
  const qaTraceStart = input.observer.qaStreamTraces.length;
  const runtime = await launchScenarioPage({
    audioPath: input.audioPath,
    baseUrl: input.baseUrl,
    headed: input.options.headed,
    legacy: Boolean(input.legacy),
    email: input.email,
    password: input.password,
    scope: input.options.scope,
    answerMode: input.options.answerMode
  });
  try {
    await runtime.button.click();
    await runtime.panel.locator(".voice-qa-button-listening").waitFor({ state: "visible" });
    await runtime.page.waitForTimeout(input.audioDurationMs + 250);
    const responsePromise = runtime.page.waitForResponse(voiceQaResponse, { timeout: input.options.timeoutMs });
    await runtime.button.click();
    const response = await responsePromise;
    if (!response.ok()) throw new Error(`voice_qa_http_${response.status()}`);
    await runtime.panel.locator(".voice-qa-button-idle").waitFor({
      state: "visible",
      timeout: input.options.timeoutMs
    });
    const raw = (await response.body()).toString("utf8");
    const responseSummary = input.legacy
      ? summarizeLegacyVoiceResponse(raw)
      : summarizeVoiceNdjson(raw);
    const traceId = responseSummary.traceId ?? runtime.telemetry.traceId;
    if (!traceId) throw new Error("voice_trace_id_missing");
    const trace = await waitForTrace(
      input.options.dataDir,
      runtime.userId,
      traceId,
      input.options.timeoutMs
    );
    const qaStreamTrace = input.observer.qaStreamTraces.slice(qaTraceStart).at(-1) ?? { observed: false };
    return {
      scenario: input.scenario,
      transport: input.legacy ? "json_wav" : "ndjson_pcm",
      response: responseSummary,
      trace: summarizeVoiceTrace(trace),
      browserTelemetry: runtime.telemetry,
      qaStreamTrace
    };
  } finally {
    await runtime.browser.close();
  }
}

async function runCancellationScenario(input: {
  audioPath: string;
  audioDurationMs: number;
  baseUrl: string;
  options: StreamingVoiceE2eOptions;
  email: string;
  password: string;
}) {
  const runtime = await launchScenarioPage({
    audioPath: input.audioPath,
    baseUrl: input.baseUrl,
    headed: input.options.headed,
    legacy: false,
    email: input.email,
    password: input.password,
    scope: input.options.scope,
    answerMode: input.options.answerMode
  });
  try {
    await runtime.button.click();
    await runtime.panel.locator(".voice-qa-button-listening").waitFor({ state: "visible" });
    await runtime.page.waitForTimeout(input.audioDurationMs + 250);
    const responsePromise = runtime.page.waitForResponse(voiceQaResponse, {
      timeout: input.options.timeoutMs
    });
    await runtime.button.click();
    await responsePromise;
    const cancel = runtime.panel.locator("button.voice-qa-button");
    await cancel.waitFor({ state: "visible", timeout: input.options.timeoutMs });
    // Give the component one bounded turn to consume the leading NDJSON meta
    // event so it can report the trace id when the user cancels.
    await runtime.page.waitForTimeout(300);
    await cancel.click();
    await runtime.panel.locator(".voice-qa-button-idle").waitFor({ state: "visible" });
    const deadline = Date.now() + 15_000;
    while (!runtime.telemetry.traceId && Date.now() < deadline) {
      await runtime.page.waitForTimeout(100);
    }
    const trace = runtime.telemetry.traceId
      ? await waitForTrace(
        input.options.dataDir,
        runtime.userId,
        runtime.telemetry.traceId,
        input.options.timeoutMs
      ).catch(() => null)
      : null;
    const voiceSessionState = trace?.applicationSessionId
      ? await waitForVoiceSessionIdle(
        input.options.dataDir,
        runtime.userId,
        trace.applicationSessionId,
        Math.min(input.options.timeoutMs, 15_000)
      )
      : null;
    return {
      scenario: "cancel" as const,
      transport: "ndjson_pcm" as const,
      browserTelemetry: runtime.telemetry,
      trace: trace ? summarizeVoiceTrace(trace) : null,
      cancelled: runtime.telemetry.sessionOutcome === "aborted" && trace?.status === "aborted",
      voiceSessionState
    };
  } finally {
    await runtime.browser.close();
  }
}

function completedOutcomeSnapshot(
  value: Awaited<ReturnType<typeof runCompletedScenario>>
): StreamingVoiceOutcomeSnapshot {
  const response = value.response as SanitizedStreamSummary;
  return {
    response: {
      status: response.status,
      answerPresent: response.answerPresent,
      audioChunkCount: response.audioChunkCount,
      chunkOrderingValid: response.chunkOrderingValid,
      fallbackAudioPresent: response.fallbackAudioPresent
    },
    trace: value.trace,
    browserOutcome: value.browserTelemetry.sessionOutcome,
    qaStreamTrace: value.qaStreamTrace
  };
}

function cancelledOutcomeSnapshot(
  value: Awaited<ReturnType<typeof runCancellationScenario>>
): StreamingVoiceOutcomeSnapshot {
  return {
    trace: value.trace,
    browserOutcome: value.browserTelemetry.sessionOutcome,
    cancelled: value.cancelled,
    voiceSessionState: value.voiceSessionState
  };
}

function buildScenarioOutcomes(input: {
  single: Awaited<ReturnType<typeof runCompletedScenario>>;
  multi: Awaited<ReturnType<typeof runCompletedScenario>>;
  uncertainty: Awaited<ReturnType<typeof runCompletedScenario>>;
  cancel: Awaited<ReturnType<typeof runCancellationScenario>>;
}) {
  const snapshots = {
    single: completedOutcomeSnapshot(input.single),
    multi: completedOutcomeSnapshot(input.multi),
    uncertainty: completedOutcomeSnapshot(input.uncertainty),
    cancel: cancelledOutcomeSnapshot(input.cancel)
  };
  return Object.fromEntries(
    (Object.keys(STREAMING_VOICE_EXPECTED_OUTCOMES) as Array<
      keyof typeof STREAMING_VOICE_EXPECTED_OUTCOMES
    >).map((scenario) => {
      const expectedOutcome = STREAMING_VOICE_EXPECTED_OUTCOMES[scenario];
      const observedOutcome = classifyStreamingVoiceOutcome(snapshots[scenario]);
      return [scenario, {
        expectedOutcome,
        observedOutcome,
        outcomeMatched: matchesStreamingVoiceExpectedOutcome(
          expectedOutcome,
          snapshots[scenario]
        )
      }];
    })
  ) as Record<keyof typeof STREAMING_VOICE_EXPECTED_OUTCOMES, {
    expectedOutcome: StreamingVoiceExpectedOutcome;
    observedOutcome: StreamingVoiceObservedOutcome;
    outcomeMatched: boolean;
  }>;
}

function buildAssertions(input: {
  single: Awaited<ReturnType<typeof runCompletedScenario>>;
  multi: Awaited<ReturnType<typeof runCompletedScenario>>;
  uncertainty: Awaited<ReturnType<typeof runCompletedScenario>>;
  legacy: Awaited<ReturnType<typeof runCompletedScenario>>;
  cancel: Awaited<ReturnType<typeof runCancellationScenario>>;
}, outcomes: ReturnType<typeof buildScenarioOutcomes>) {
  const stream = (value: typeof input.single) => value.response as SanitizedStreamSummary;
  const legacy = input.legacy.response as SanitizedLegacySummary;
  const expectedStreaming = [input.single, input.multi];
  return {
    realProviderStreamingObserved: input.single.qaStreamTrace.observed && input.multi.qaStreamTrace.observed,
    singleSentenceAnswer: stream(input.single).answerSentenceCount === 1,
    multiSentenceAnswer: stream(input.multi).answerSentenceCount >= 2,
    citationRemoval: [input.single, input.multi, input.uncertainty]
      .every((value) => stream(value).citationMarkersRemoved),
    uncertaintyPreservation: stream(input.uncertainty).uncertaintyPreserved,
    ttsChunkOrdering: expectedStreaming
      .every((value) => stream(value).audioChunkCount > 0 && stream(value).chunkOrderingValid),
    streamingPlaybackStarted: expectedStreaming
      .every((value) => Boolean(value.trace.timestamps.playback_started)),
    safeFallbackPlaybackStarted: Boolean(input.uncertainty.trace.timestamps.audio_play_started),
    legacyPlaybackStarted: Boolean(input.legacy.trace.timestamps.audio_play_started),
    legacyResponseAvailable: legacy.answerPresent && legacy.audioPresent,
    userCancellation: input.cancel.cancelled,
    voiceSessionAbortSynchronized: input.cancel.voiceSessionState === "IDLE",
    evidenceCitationsPresent: [input.single, input.multi, input.uncertainty]
      .every((value) => stream(value).citationCount > 0),
    expectedOutcomesMatched: Object.values(outcomes).every((outcome) => outcome.outcomeMatched)
  };
}

export async function runStreamingVoiceE2e(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env
) {
  const options = parseStreamingVoiceE2eArgs(argv, environment);
  assertStreamingVoiceRemoteEnvironment(environment);
  assertEvaluationReportPath(options.dataDir, options.reportPath);
  await assertPortAvailable(options.port);
  const inspected = Object.fromEntries(await Promise.all(
    (Object.entries(options.audio) as Array<[EvaluationScenario, string]>).map(async ([key, path]) => (
      [key, await inspectAudio(path)]
    ))
  )) as Record<EvaluationScenario, Awaited<ReturnType<typeof inspectAudio>>>;

  const observer = new ServerObserver();
  const server = startNext(options.port, options.dataDir, observer);
  const baseUrl = `http://127.0.0.1:${options.port}`;
  const email = environment.LONG_RECORDING_EVAL_EMAIL!;
  const password = environment.LONG_RECORDING_EVAL_PASSWORD!;
  const startedAt = new Date().toISOString();
  try {
    await waitForServer(baseUrl, options.timeoutMs);
    const common = { baseUrl, options, email, password, observer };
    process.stdout.write("[streaming-voice-e2e] scenario=single_sentence status=running\n");
    const single = await runCompletedScenario({
      ...common,
      scenario: "single_sentence",
      audioPath: options.audio.single_sentence,
      audioDurationMs: inspected.single_sentence.durationMs
    });
    process.stdout.write("[streaming-voice-e2e] scenario=multi_sentence status=running\n");
    const multi = await runCompletedScenario({
      ...common,
      scenario: "multi_sentence",
      audioPath: options.audio.multi_sentence,
      audioDurationMs: inspected.multi_sentence.durationMs
    });
    process.stdout.write("[streaming-voice-e2e] scenario=uncertainty status=running\n");
    const uncertainty = await runCompletedScenario({
      ...common,
      scenario: "uncertainty",
      audioPath: options.audio.uncertainty,
      audioDurationMs: inspected.uncertainty.durationMs
    });
    process.stdout.write("[streaming-voice-e2e] scenario=legacy_comparison status=running\n");
    const legacy = await runCompletedScenario({
      ...common,
      scenario: "single_sentence",
      audioPath: options.audio.single_sentence,
      audioDurationMs: inspected.single_sentence.durationMs,
      legacy: true
    });
    process.stdout.write("[streaming-voice-e2e] scenario=cancel status=running\n");
    const cancel = await runCancellationScenario({
      baseUrl,
      options,
      email,
      password,
      audioPath: options.audio.cancel,
      audioDurationMs: inspected.cancel.durationMs
    });
    const outcomes = buildScenarioOutcomes({ single, multi, uncertainty, cancel });
    const assertions = buildAssertions(
      { single, multi, uncertainty, legacy, cancel },
      outcomes
    );
    const pass = Object.values(assertions).every(Boolean);
    const streamingFirstPlay = single.trace.streamingLatencies?.speechToFirstAudioPlayMs ?? null;
    const legacyFirstPlay = legacy.trace.latencies.totalResponseLatencyMs;
    const report = {
      version: 2,
      kind: "streaming_voice_e2e_evaluation",
      startedAt,
      completedAt: new Date().toISOString(),
      provider: "volcengine",
      answerMode: options.answerMode,
      scope: options.scope,
      inputs: Object.fromEntries(Object.entries(inspected).map(([key, value]) => [key, {
        fileNameSha256: sha256(basename(options.audio[key as EvaluationScenario])),
        fileBytes: value.fileBytes,
        fileSha256: value.fileSha256,
        durationMs: value.durationMs
      }])),
      scenarios: { single, multi, uncertainty, legacy, cancel },
      outcomes,
      comparison: {
        streamingSpeechEndToPlaybackMs: streamingFirstPlay,
        legacySpeechEndToPlaybackMs: legacyFirstPlay,
        latencyDeltaMs: streamingFirstPlay !== null && legacyFirstPlay !== null
          ? streamingFirstPlay - legacyFirstPlay
          : null
      },
      faultCoverage: {
        realProvider: { userCancellation: cancel.cancelled },
        mockedOnly: {
          ttsFailureBeforeFirstChunk: true,
          websocketDisconnect: true,
          emptyStream: true
        }
      },
      assertions,
      pass
    };
    await mkdir(dirname(options.reportPath), { recursive: true });
    await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`${JSON.stringify({
      pass,
      reportPath: options.reportPath,
      streamingSpeechEndToPlaybackMs: streamingFirstPlay,
      legacySpeechEndToPlaybackMs: legacyFirstPlay
    }, null, 2)}\n`);
    if (!pass) process.exitCode = 1;
    return report;
  } finally {
    await stopChild(server);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  loadRuntimeEnv();
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(streamingVoiceE2eHelp());
  } else {
    try {
      await runStreamingVoiceE2e(process.argv.slice(2));
    } catch (error) {
      console.error(
        `[streaming-voice-e2e] failed error_name=${error instanceof Error ? error.name : "unknown"} ` +
        `error_message=${JSON.stringify(error instanceof Error ? error.message : "unknown")}`
      );
      process.exitCode = 1;
    }
  }
}

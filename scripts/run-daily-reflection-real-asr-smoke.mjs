import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const BLOCK_MARKER = "[daily-reflection-real-asr-network] blocked_request";
const REPORT_SCHEMA_VERSION = 1;
const RUNNER_CALL_BUDGET = 2;
const EXTERNAL_DIAGNOSTIC_CALLS = 1;
const TOTAL_AUTHORIZED_CALLS = 3;
const TARGET_LONG_SECONDS = 186;
const TARGET_SAMPLE_RATE = 22_050;
const TARGET_LONG_SAMPLES = TARGET_LONG_SECONDS * TARGET_SAMPLE_RATE;
const TARGET_LONG_SHA256 = "6a360549b9040e0e86abf1c59e143a0f5884f0bcf03b904c97f30a1c67307ae6";

export const AUDITED_FIXTURES = Object.freeze([
  Object.freeze({
    name: "non_relationship_60s",
    fileName: "non_relationship_60s.wav",
    sha256: "54e438f8c7711833ed8ab5d7350dc17b9596d4683b1e5e0a4c5c2777d61b65b5",
    durationSeconds: 55.559546,
    durationSamples: 1_225_088,
    semanticMarkers: ["technical_discussion", "non_relationship"]
  }),
  Object.freeze({
    name: "relationship_dialogue_90s",
    fileName: "relationship_dialogue_90s.wav",
    sha256: "132d928ad0f2412af35e435e329b7dbd66df5ee9ade886a437a7cb71d2079d0b",
    durationSeconds: 71.79551,
    durationSamples: 1_583_091,
    semanticMarkers: ["simulated_relationship_dialogue", "listening", "boundary", "commitment"]
  }),
  Object.freeze({
    name: "two_speaker_relationship",
    fileName: "two_speaker_relationship.wav",
    sha256: "ac4c34504bf1319a53a24fc8c054968414ec20ddd20e7811dc928fccbf8e57e5",
    durationSeconds: 48.00966,
    durationSamples: 1_058_613,
    semanticMarkers: ["synthetic_two_role_dialogue", "relationship", "commitment"]
  })
]);

export class RealAsrSmokeError extends Error {
  constructor(code) {
    super(code);
    this.name = "RealAsrSmokeError";
    this.code = code;
  }
}

function fail(code) {
  throw new RealAsrSmokeError(code);
}

function normalizedEnvironmentValue(environment, name) {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") {
    return true;
  }
  return normalized.startsWith("127.");
}

export function deriveTranscriptionTarget(rawBaseUrl) {
  let baseUrl;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    fail("dedicated_transcription_base_url_invalid");
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    fail("dedicated_transcription_base_url_protocol_invalid");
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    fail("dedicated_transcription_base_url_components_invalid");
  }
  if (isLoopbackHostname(baseUrl.hostname)) {
    fail("dedicated_transcription_base_url_must_be_remote");
  }
  let basePath = baseUrl.pathname
    .replace(/\/+$/u, "")
    .replace(/\/v1\/v1(?=\/|$)/gu, "/v1");
  let allowedPath = basePath;
  if (!allowedPath.endsWith("/audio/transcriptions")) {
    allowedPath = allowedPath.endsWith("/v1")
      ? `${allowedPath}/audio/transcriptions`
      : `${allowedPath}/v1/audio/transcriptions`;
  }
  allowedPath = allowedPath.replace(/^\/\//u, "/");
  const normalizedBaseUrl = `${baseUrl.origin}${basePath}`;
  return {
    baseUrl: normalizedBaseUrl,
    allowedOrigin: baseUrl.origin,
    allowedPath: allowedPath.startsWith("/") ? allowedPath : `/${allowedPath}`,
    tls: baseUrl.protocol === "https:"
  };
}

export function validateRealSmokeGate(args, environment = process.env) {
  const unknownArguments = args.filter((argument) => argument !== "--remote");
  if (unknownArguments.length > 0) fail("real_asr_smoke_argument_not_allowed");
  if (!args.includes("--remote")) fail("real_asr_smoke_remote_flag_required");
  if (normalizedEnvironmentValue(environment, "RUN_REAL_ASR_SMOKE") !== "1") {
    fail("real_asr_smoke_environment_gate_required");
  }
  if (normalizedEnvironmentValue(environment, "TRANSCRIPTION_PROVIDER") !== "openai") {
    fail("real_asr_smoke_openai_provider_required");
  }
  if (normalizedEnvironmentValue(environment, "TRANSCRIPTION_FALLBACK_PROVIDER") !== "none") {
    fail("real_asr_smoke_fallback_must_be_none");
  }
  if (normalizedEnvironmentValue(environment, "OPENAI_MAX_RETRIES") !== "0") {
    fail("real_asr_smoke_openai_retries_must_be_zero");
  }
  const dedicatedBaseUrl = normalizedEnvironmentValue(
    environment,
    "OPENAI_TRANSCRIBE_BASE_URL"
  );
  if (!dedicatedBaseUrl) fail("dedicated_transcription_base_url_required");
  const dedicatedApiKey = normalizedEnvironmentValue(
    environment,
    "OPENAI_TRANSCRIBE_API_KEY"
  );
  if (!dedicatedApiKey) fail("dedicated_transcription_api_key_required");
  const target = deriveTranscriptionTarget(dedicatedBaseUrl);
  return {
    ...target,
    dedicatedApiKey,
    model: normalizedEnvironmentValue(environment, "OPENAI_TRANSCRIBE_MODEL")
      ?? "gpt-4o-transcribe-diarize"
  };
}

function runTool(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs ?? 120_000,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new RealAsrSmokeError(options.errorCode ?? "local_tool_failed");
  }
  return result.stdout;
}

export async function sha256File(filePath) {
  const buffer = await readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

export function probeWav(filePath, ffprobeExecutable) {
  const output = runTool(ffprobeExecutable, [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_name,sample_rate,channels,duration_ts,time_base:format=format_name,duration",
    "-of",
    "json",
    filePath
  ], { errorCode: "ffprobe_failed" });
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    fail("ffprobe_output_invalid");
  }
  const stream = payload?.streams?.[0];
  const format = payload?.format;
  const media = {
    container: format?.format_name,
    codec: stream?.codec_name,
    channels: Number(stream?.channels),
    sampleRate: Number(stream?.sample_rate),
    durationSeconds: Number(format?.duration),
    durationSamples: Number(stream?.duration_ts),
    timeBase: stream?.time_base
  };
  if (
    media.container !== "wav"
    || media.codec !== "pcm_s16le"
    || media.channels !== 1
    || media.sampleRate !== TARGET_SAMPLE_RATE
    || media.timeBase !== `1/${TARGET_SAMPLE_RATE}`
    || !Number.isFinite(media.durationSeconds)
    || !Number.isInteger(media.durationSamples)
  ) {
    fail("wav_media_contract_invalid");
  }
  return media;
}

export async function auditFixtureFile(filePath, specification, ffprobeExecutable) {
  await access(filePath).catch(() => fail(`fixture_missing_${specification.name}`));
  const [hash, media, fileStat] = await Promise.all([
    sha256File(filePath),
    Promise.resolve(probeWav(filePath, ffprobeExecutable)),
    stat(filePath)
  ]);
  if (hash !== specification.sha256) fail(`fixture_hash_mismatch_${specification.name}`);
  if (Math.abs(media.durationSeconds - specification.durationSeconds) > 0.000001) {
    fail(`fixture_duration_mismatch_${specification.name}`);
  }
  if (media.durationSamples !== specification.durationSamples) {
    fail(`fixture_sample_count_mismatch_${specification.name}`);
  }
  return {
    name: specification.name,
    fileName: specification.fileName,
    sha256: hash,
    bytes: fileStat.size,
    media,
    semanticMarkers: [...specification.semanticMarkers]
  };
}

export function parsePcm16MonoWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) fail("wav_buffer_invalid");
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    fail("wav_riff_header_invalid");
  }
  let offset = 12;
  let format = null;
  let pcm = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) fail("wav_chunk_size_invalid");
    if (id === "fmt ") {
      if (size < 16) fail("wav_format_chunk_invalid");
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14)
      };
    } else if (id === "data") {
      pcm = buffer.subarray(start, end);
    }
    offset = end + (size % 2);
  }
  if (
    !format
    || format.audioFormat !== 1
    || format.channels !== 1
    || format.sampleRate !== TARGET_SAMPLE_RATE
    || format.bitsPerSample !== 16
    || !pcm
    || pcm.length % 2 !== 0
  ) {
    fail("wav_pcm_contract_invalid");
  }
  return { ...format, pcm, samples: pcm.length / 2 };
}

export function buildCanonicalPcmWav(pcm, sampleRate = TARGET_SAMPLE_RATE) {
  if (!Buffer.isBuffer(pcm) || pcm.length % 2 !== 0) fail("wav_pcm_payload_invalid");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function createDeterministicLongFixture(input) {
  const targetSeconds = input.targetSeconds ?? TARGET_LONG_SECONDS;
  const targetSamples = targetSeconds * TARGET_SAMPLE_RATE;
  if (!Number.isInteger(targetSamples) || targetSamples <= 0) {
    fail("long_fixture_target_sample_count_invalid");
  }
  await mkdir(dirname(input.outputPath), { recursive: true });
  const parsed = await Promise.all(input.inputPaths.map(async (filePath) =>
    parsePcm16MonoWav(await readFile(filePath))
  ));
  const sourceSamples = parsed.reduce((sum, item) => sum + item.samples, 0);
  if (sourceSamples > targetSamples) fail("long_fixture_sources_exceed_target");
  const parts = parsed.map((item) => item.pcm);
  let remainingSamples = targetSamples - sourceSamples;
  const repeatSource = parsed[1]?.pcm;
  if (!repeatSource || repeatSource.length === 0) fail("long_fixture_repeat_source_missing");
  while (remainingSamples > 0) {
    const samples = Math.min(remainingSamples, repeatSource.length / 2);
    parts.push(repeatSource.subarray(0, samples * 2));
    remainingSamples -= samples;
  }
  await writeFile(input.outputPath, buildCanonicalPcmWav(Buffer.concat(parts)));
  const media = probeWav(input.outputPath, input.ffprobeExecutable);
  if (media.durationSamples !== targetSamples || media.durationSeconds !== targetSeconds) {
    fail("long_fixture_exact_duration_failed");
  }
  const hash = await sha256File(input.outputPath);
  if (targetSamples === TARGET_LONG_SAMPLES && hash !== TARGET_LONG_SHA256) {
    fail("long_fixture_hash_mismatch");
  }
  return {
    sha256: hash,
    media,
    bytes: (await stat(input.outputPath)).size
  };
}

function providerOriginHash(origin) {
  return createHash("sha256").update(origin).digest("hex").slice(0, 16);
}

export function buildServerEnvironment(input) {
  return {
    ...input.baseEnvironment,
    NODE_OPTIONS: `--require=${input.networkGuardPath.replaceAll("\\", "/")}`,
    NEXT_TELEMETRY_DISABLED: "1",
    APP_DATA_DIR: input.appDataDir,
    APP_STORAGE_MODE: "local",
    PIPELINE_EXECUTION_MODE: "inline",
    REDIS_URL: "",
    DAILY_BRIEF_INVITE_CODES: input.inviteCode,
    DAILY_REFLECTION_UPLOAD_ENABLED: "true",
    DAILY_REFLECTION_BROWSER_RECORDING_ENABLED: "true",
    TRANSCRIPTION_PROVIDER: "openai",
    TRANSCRIPTION_FALLBACK_PROVIDER: "none",
    OPENAI_MAX_RETRIES: "0",
    OPENAI_REQUEST_TIMEOUT_MS: input.baseEnvironment.OPENAI_REQUEST_TIMEOUT_MS?.trim()
      || String(10 * 60_000),
    OPENAI_TRANSCRIBE_MODEL: input.gate.model,
    OPENAI_TRANSCRIBE_API_KEY: input.gate.dedicatedApiKey,
    OPENAI_TRANSCRIBE_BASE_URL: input.gate.baseUrl,
    OPENAI_API_KEY: "",
    OPENAI_BASE_URL: "",
    OPENROUTER_API_KEY: "",
    OPENROUTER_BASE_URL: "",
    ASR_CHUNK_DURATION_SECONDS: "300",
    ASR_CHUNK_CONCURRENCY: "1",
    ASR_CHUNK_MAX_RETRIES: "0",
    ASR_CHUNK_RETRY_DELAY_MS: "0",
    ASR_CHUNK_EMPTY_TRANSCRIPT_SPLIT_ENABLED: "false",
    EXTRACTION_PROVIDER: "rule",
    EXTRACTION_FALLBACK_PROVIDER: "none",
    AUDIO_INSIGHT_PROVIDER: "rule",
    AUDIO_INSIGHT_FALLBACK_PROVIDER: "none",
    RELATIONSHIP_SIGNAL_PROVIDER: "none",
    RELATIONSHIP_SIGNAL_FALLBACK_PROVIDER: "none",
    EMOTION_SIGNAL_PROVIDER: "none",
    PROACTIVE_INSIGHT_PROVIDER: "none",
    MEMORY_RELEVANCE_PROVIDER: "none",
    QA_HYBRID_RETRIEVAL_MODE: "off",
    QA_HIERARCHICAL_NAVIGATION_MODE: "off",
    VOICEPRINT_SELF_ENROLLMENT_ENABLED: "false",
    MEMORY_OWNER_REVIEW_ENABLED: "false",
    DATE_COMPANION_MEMORY_BRIDGE_ENABLED: "false",
    DATE_COMPANION_MEMORY_BRIDGE_CONSUMER_ENABLED: "false",
    SPEAKER_ASR_BASE_URL: "",
    SPEAKER_ASR_AUDIO_BASE_URL: "",
    SPEAKER_ASR_AUDIO_ACCESS_TOKEN: "",
    VOICEPRINT_BASE_URL: "",
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_BASE_URL: "",
    VLLM_BASE_URL: "",
    HYBRID_EMBEDDING_BASE_URL: "",
    DR_REAL_ASR_NETWORK_GUARD_MODE: "server",
    DR_REAL_ASR_NETWORK_AUDIT_PATH: input.networkAuditPath,
    DR_REAL_ASR_SUBMIT_BUDGET_DIR: input.submitBudgetDir,
    DR_REAL_ASR_MAX_SUBMITS: String(RUNNER_CALL_BUDGET),
    DR_REAL_ASR_NETWORK_GUARD_PROBE: ""
  };
}

export function buildPlaywrightEnvironment(serverEnvironment, input) {
  return {
    ...serverEnvironment,
    NODE_OPTIONS: `--require=${input.networkGuardPath.replaceAll("\\", "/")}`,
    OPENAI_API_KEY: "",
    OPENAI_BASE_URL: "",
    OPENAI_TRANSCRIBE_API_KEY: "",
    OPENAI_TRANSCRIBE_BASE_URL: "",
    DR_REAL_ASR_NETWORK_AUDIT_PATH: "",
    DR_REAL_ASR_SUBMIT_BUDGET_DIR: "",
    DR_REAL_ASR_NETWORK_GUARD_MODE: "loopback_only",
    DATE_COMPANION_E2E_BASE_URL: input.baseUrl,
    DATE_COMPANION_E2E_ARTIFACT_DIR: input.runtimeArtifactDir,
    DATE_COMPANION_E2E_SPEC: "daily-reflection-real-asr-smoke.spec.ts",
    DAILY_REFLECTION_REAL_ASR_BASE_URL: input.baseUrl,
    DAILY_REFLECTION_REAL_ASR_DATA_DIR: input.appDataDir,
    DAILY_REFLECTION_REAL_ASR_SHORT_PATH: input.shortFixturePath,
    DAILY_REFLECTION_REAL_ASR_LONG_PATH: input.longFixturePath,
    DAILY_REFLECTION_REAL_ASR_RESULT_PATH: input.scenarioResultPath,
    DAILY_REFLECTION_REAL_ASR_NETWORK_AUDIT_PATH: input.networkAuditPath,
    DAILY_REFLECTION_REAL_ASR_INVITE_CODE: input.inviteCode
  };
}

async function reserveFreePort() {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("loopback_port_unavailable"));
        else resolvePort(port);
      });
    });
  });
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail("next_server_exited_early");
    try {
      const response = await fetch(`${baseUrl}/date-companion`);
      if (response.ok) return;
    } catch {
      // The next loop retries only the local readiness probe, never Provider work.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  fail("next_server_readiness_timeout");
}

async function stopProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000))
  ]);
  if (exited || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
  } else {
    child.kill("SIGKILL");
  }
}

async function assertPortReleased(port) {
  await new Promise((resolveReleased, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close((error) => error ? reject(error) : resolveReleased());
    });
  });
}

async function runPlaywrightSpec(workspaceDir, environment) {
  const child = spawn(
    process.execPath,
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      "--config",
      "playwright.date-companion.config.ts"
    ],
    {
      cwd: workspaceDir,
      env: environment,
      stdio: "inherit",
      windowsHide: true
    }
  );
  return await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
}

async function writeJsonAtomic(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  await rename(temporaryPath, filePath);
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function readNetworkAudit(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return raw.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

export function summarizeNetworkAudit(entries) {
  const submitStarts = entries.filter((entry) =>
    entry.event === "request_start" && entry.classification === "submit"
  );
  const submitEnds = entries.filter((entry) =>
    entry.event === "request_end" && entry.classification === "submit"
  );
  const statusClasses = {};
  for (const entry of submitEnds) {
    statusClasses[entry.status_class] = (statusClasses[entry.status_class] ?? 0) + 1;
  }
  return {
    externalDiagnosticSubmits: EXTERNAL_DIAGNOSTIC_CALLS,
    runnerAuthorizedSubmits: RUNNER_CALL_BUDGET,
    totalAuthorizedSubmits: TOTAL_AUTHORIZED_CALLS,
    runnerSubmits: submitStarts.length,
    totalConsumedIncludingDiagnostic: EXTERNAL_DIAGNOSTIC_CALLS + submitStarts.length,
    queryRequests: 0,
    callbackRequests: 0,
    nonSubmitRequestBasis: "not_applicable_exact_submit_only_protocol",
    completedResponses: submitEnds.length,
    statusClasses,
    blockedRequests: entries.filter((entry) => entry.event === "request_blocked").length,
    transportErrors: entries.filter((entry) => entry.event === "request_error").length,
    nextVersionChecksServedLocally: entries.filter((entry) => entry.event === "local_stub").length
  };
}

function safeFailureCode(error) {
  return error instanceof RealAsrSmokeError ? error.code : "unexpected_failure";
}

async function main() {
  let gate;
  try {
    gate = validateRealSmokeGate(process.argv.slice(2), process.env);
  } catch (error) {
    process.stderr.write(`[daily-reflection-real-asr-smoke] refused code=${safeFailureCode(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const workspaceDir = resolve(process.cwd());
  const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const runRoot = resolve(
    workspaceDir,
    ".data/evaluation/daily-reflection-real-asr-smoke-v1",
    runId
  );
  const appDataDir = join(runRoot, "app-data");
  const fixtureRuntimeDir = join(runRoot, "fixtures");
  const runtimeArtifactDir = join(runRoot, "runtime");
  const submitBudgetDir = join(runRoot, "submit-budget");
  const shortFixturePath = join(fixtureRuntimeDir, "short-71.795510s.wav");
  const longFixturePath = join(fixtureRuntimeDir, "long-186.000s.wav");
  const networkAuditPath = join(runRoot, "network-audit.jsonl");
  const scenarioResultPath = join(runtimeArtifactDir, "scenario-result.json");
  const manifestPath = join(runRoot, "fixture-manifest.json");
  const reportPath = join(runRoot, "report.json");
  const fixtureSourceDir = resolve(
    normalizedEnvironmentValue(process.env, "DAILY_REFLECTION_REAL_ASR_FIXTURE_SOURCE_DIR")
      ?? join(workspaceDir, "fixtures/audio")
  );
  const networkGuardPath = resolve(
    workspaceDir,
    "scripts/daily-reflection-real-asr-network-guard.cjs"
  );
  const ffprobeExecutable = process.env.FFPROBE_PATH?.trim() || require("ffprobe-static").path;
  const inviteCode = `dr31-real-asr-${randomUUID()}`;
  const startedAt = Date.now();
  let server = null;
  let port = null;
  let serverOutput = "";
  let failureCode = null;
  let finalStatus = "failed";
  let scenarioResult = null;
  let networkSummary = summarizeNetworkAudit([]);
  let cleanup = {
    stagedRecordsDeleted: false,
    appDataRemoved: false,
    fixturesRemoved: false,
    runtimeArtifactsRemoved: false,
    submitBudgetRemoved: false,
    serverStopped: false,
    portReleased: false
  };

  await Promise.all([
    mkdir(appDataDir, { recursive: true }),
    mkdir(fixtureRuntimeDir, { recursive: true }),
    mkdir(runtimeArtifactDir, { recursive: true }),
    mkdir(submitBudgetDir, { recursive: true })
  ]);

  const finalizeReport = async () => {
    const entries = await readNetworkAudit(networkAuditPath).catch(() => []);
    networkSummary = summarizeNetworkAudit(entries);
    const status = failureCode === null
      && scenarioResult?.status === "passed"
      && networkSummary.runnerSubmits === RUNNER_CALL_BUDGET
      && networkSummary.completedResponses === RUNNER_CALL_BUDGET
      && networkSummary.blockedRequests === 0
      && networkSummary.transportErrors === 0
      && scenarioResult?.browserExternalRequests === 0
      && Object.values(cleanup).every((value) => value === true)
      ? "passed"
      : "failed";
    await writeJsonAtomic(reportPath, {
      schemaVersion: REPORT_SCHEMA_VERSION,
      taskId: "DR31-EVAL-SMOKE",
      status,
      failureCode,
      provider: {
        type: "openai-compatible-transcription",
        model: gate.model,
        originHash: providerOriginHash(gate.allowedOrigin),
        tls: gate.tls,
        usage: "not_reported",
        cost: "not_reported"
      },
      callBudget: networkSummary,
      scenarios: scenarioResult?.cases ?? [],
      hardGate: scenarioResult?.hardGate ?? null,
      browserExternalRequests: scenarioResult?.browserExternalRequests ?? null,
      cleanup,
      elapsedMs: Date.now() - startedAt
    });
    return status;
  };

  const shutdown = async () => {
    if (server) {
      await stopProcessTree(server);
      cleanup.serverStopped = server.exitCode !== null;
    }
    if (port !== null) {
      try {
        await assertPortReleased(port);
        cleanup.portReleased = true;
      } catch {
        cleanup.portReleased = false;
      }
    }
  };

  try {
    const audited = [];
    for (const fixture of AUDITED_FIXTURES) {
      audited.push(await auditFixtureFile(
        join(fixtureSourceDir, fixture.fileName),
        fixture,
        ffprobeExecutable
      ));
    }
    await copyFile(
      join(fixtureSourceDir, "relationship_dialogue_90s.wav"),
      shortFixturePath
    );
    const long = await createDeterministicLongFixture({
      inputPaths: AUDITED_FIXTURES.map((fixture) => join(fixtureSourceDir, fixture.fileName)),
      outputPath: longFixturePath,
      ffprobeExecutable
    });
    const short = {
      sha256: await sha256File(shortFixturePath),
      media: probeWav(shortFixturePath, ffprobeExecutable),
      bytes: (await stat(shortFixturePath)).size
    };
    await writeJsonAtomic(manifestPath, {
      schemaVersion: 1,
      privacy: "synthetic_non_user_audio",
      sources: audited,
      cases: [
        {
          name: "short",
          sha256: short.sha256,
          bytes: short.bytes,
          media: short.media,
          expectedProfile: "quick_reflection",
          semanticMarkers: AUDITED_FIXTURES[1].semanticMarkers
        },
        {
          name: "long",
          sha256: long.sha256,
          bytes: long.bytes,
          media: long.media,
          expectedProfile: "full_recording",
          sourceOrder: AUDITED_FIXTURES.map((fixture) => fixture.name),
          semanticMarkers: ["technical_discussion", "relationship", "boundary", "commitment"]
        }
      ]
    });
    console.log("[daily-reflection-real-asr-smoke] provider_calls=0/2 fixtures_verified=2/2");

    port = await reserveFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const serverEnvironment = buildServerEnvironment({
      baseEnvironment: process.env,
      gate,
      appDataDir,
      inviteCode,
      networkGuardPath,
      networkAuditPath,
      submitBudgetDir
    });
    server = spawn(
      process.execPath,
      ["node_modules/next/dist/bin/next", "dev", "-H", "127.0.0.1", "-p", String(port)],
      {
        cwd: workspaceDir,
        env: serverEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );
    const captureServerOutput = (chunk) => {
      serverOutput = `${serverOutput}${chunk.toString()}`.slice(-250_000);
    };
    server.stdout.on("data", captureServerOutput);
    server.stderr.on("data", captureServerOutput);
    await waitForServer(baseUrl, server);

    const playwrightEnvironment = buildPlaywrightEnvironment(serverEnvironment, {
      baseUrl,
      runtimeArtifactDir,
      appDataDir,
      shortFixturePath,
      longFixturePath,
      scenarioResultPath,
      networkAuditPath,
      networkGuardPath,
      inviteCode
    });
    const testExitCode = await runPlaywrightSpec(workspaceDir, playwrightEnvironment);
    scenarioResult = await readJsonIfPresent(scenarioResultPath);
    if (testExitCode !== 0 || scenarioResult?.status !== "passed") {
      fail("real_asr_playwright_scenario_failed");
    }
    cleanup.stagedRecordsDeleted = scenarioResult.cleanup?.stagedRecordsDeleted === true;
    const liveAudit = summarizeNetworkAudit(await readNetworkAudit(networkAuditPath));
    if (
      liveAudit.runnerSubmits !== RUNNER_CALL_BUDGET
      || liveAudit.completedResponses !== RUNNER_CALL_BUDGET
      || liveAudit.blockedRequests !== 0
      || liveAudit.transportErrors !== 0
    ) {
      fail("real_asr_call_budget_audit_failed");
    }
    if (serverOutput.includes(BLOCK_MARKER)) fail("real_asr_server_network_blocked");
  } catch (error) {
    failureCode = safeFailureCode(error);
    process.exitCode = 1;
  } finally {
    await shutdown();
    scenarioResult ??= await readJsonIfPresent(scenarioResultPath).catch(() => null);
    cleanup.stagedRecordsDeleted = scenarioResult?.cleanup?.stagedRecordsDeleted === true;
    await rm(appDataDir, { recursive: true, force: true });
    cleanup.appDataRemoved = true;
    await rm(fixtureRuntimeDir, { recursive: true, force: true });
    cleanup.fixturesRemoved = true;
    await rm(runtimeArtifactDir, { recursive: true, force: true });
    cleanup.runtimeArtifactsRemoved = true;
    await rm(submitBudgetDir, { recursive: true, force: true });
    cleanup.submitBudgetRemoved = true;
    finalStatus = await finalizeReport();
    if (finalStatus !== "passed") process.exitCode = 1;
    console.log(
      `[daily-reflection-real-asr-smoke] status=${finalStatus} `
      + `provider_calls=${networkSummary.runnerSubmits}/2 report=${reportPath}`
    );
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}

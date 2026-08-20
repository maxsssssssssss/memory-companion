import { spawn, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import { resolve } from "node:path";
import { appendBoundedMarkerLog } from "./lib/bounded-marker-log.mjs";

const BLOCK_MARKER = "[date-companion-e2e-network] blocked_external_request";
const workspaceDir = resolve(process.cwd());
const runId = `${Date.now()}-${process.pid}`;
const dataDir = resolve(workspaceDir, `.data/daily-reflection-e2e-${runId}`);
const artifactDir = resolve(dataDir, "artifacts");
const fileUploadArtifactDir = resolve(artifactDir, "file-upload");
const browserRecordingArtifactDir = resolve(artifactDir, "browser-recording");
const toySyncArtifactDir = resolve(artifactDir, "toy-sync");
const fixtureDir = resolve(dataDir, "fixtures");
const fixturePath = resolve(fixtureDir, "daily-reflection-fixture.mp3");
const quickFixturePath = resolve(fixtureDir, "daily-reflection-browser-90s.webm");
const fullFixturePath = resolve(fixtureDir, "daily-reflection-browser-181s.webm");
const networkGuardPath = resolve(workspaceDir, "scripts/date-companion-e2e-network-guard.cjs")
  .replaceAll("\\", "/");
const require = createRequire(import.meta.url);
const ffmpegExecutable = process.env.FFMPEG_PATH?.trim() || require("ffmpeg-static");
const requestedScenario = process.env.DAILY_REFLECTION_E2E_SCENARIO?.trim() || "all";
if (
  requestedScenario !== "all"
  && requestedScenario !== "file-upload"
  && requestedScenario !== "toy-sync"
) {
  throw new Error("DAILY_REFLECTION_E2E_SCENARIO must be all, file-upload, or toy-sync");
}
const fileUploadOnly = requestedScenario === "file-upload";
const toySyncOnly = requestedScenario === "toy-sync";
const focusedScenario = fileUploadOnly || toySyncOnly;

function progress(completed, total, message) {
  console.log(`[daily-reflection-e2e] ${completed}/${total} ${message}`);
}

function createDeterministicFixtureAudio(outputPath) {
  const result = spawnSync(ffmpegExecutable, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=16000:cl=mono",
    "-t",
    "5525",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "8k",
    "-f",
    "mp3",
    outputPath
  ], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 120_000,
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(
      `Unable to create Daily Reflection fixture audio: `
      + `${result.stderr?.trim() || `ffmpeg status ${result.status}`}`
    );
  }
}

function createDeterministicBrowserRecording(outputPath, durationSeconds) {
  const result = spawnSync(ffmpegExecutable, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=mono",
    "-t",
    String(durationSeconds),
    "-codec:a",
    "libopus",
    "-b:a",
    "24k",
    "-application",
    "voip",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-f",
    "webm",
    outputPath
  ], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 120_000,
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(
      `Unable to create ${durationSeconds}s Daily Reflection browser fixture: `
      + `${result.stderr?.trim() || `ffmpeg status ${result.status}`}`
    );
  }
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
        else if (!port) reject(new Error("Unable to reserve a loopback port"));
        else resolvePort(port);
      });
    });
  });
}

async function waitForServer(baseURL, child) {
  const deadline = Date.now() + 120_000;
  let lastError = "server_not_ready";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseURL}/date-companion`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "unknown_error";
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Timed out waiting for ${baseURL}: ${lastError}`);
}

async function stopProcessTree(child) {
  if (child.exitCode !== null) return;
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

async function runPlaywrightSpec(spec, env, scenarioArtifactDir) {
  const playwright = spawn(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", "test", "--config", "playwright.date-companion.config.ts"],
    {
      cwd: workspaceDir,
      env: {
        ...env,
        DAILY_REFLECTION_E2E_ARTIFACT_DIR: scenarioArtifactDir,
        DATE_COMPANION_E2E_ARTIFACT_DIR: scenarioArtifactDir,
        DATE_COMPANION_E2E_SPEC: spec
      },
      stdio: "inherit",
      windowsHide: true
    }
  );
  return await new Promise((resolveExit, reject) => {
    playwright.once("error", reject);
    playwright.once("exit", (code) => resolveExit(code ?? 1));
  });
}

await Promise.all([
  mkdir(artifactDir, { recursive: true }),
  ...(toySyncOnly ? [] : [mkdir(fileUploadArtifactDir, { recursive: true })]),
  ...(requestedScenario === "all" ? [mkdir(browserRecordingArtifactDir, { recursive: true })] : []),
  ...(toySyncOnly ? [mkdir(toySyncArtifactDir, { recursive: true })] : []),
  mkdir(fixtureDir, { recursive: true })
]);
progress(0, focusedScenario ? 5 : 7, focusedScenario
  ? "creating the deterministic file-upload MP3"
  : "creating file-upload MP3 plus valid 90s and 181s WebM/Opus fixtures");
createDeterministicFixtureAudio(fixturePath);
if (requestedScenario === "all") {
  createDeterministicBrowserRecording(quickFixturePath, 90);
  createDeterministicBrowserRecording(fullFixturePath, 181.001);
}

const port = await reserveFreePort();
const baseURL = `http://127.0.0.1:${port}`;
const nodeOptions = [process.env.NODE_OPTIONS?.trim(), `--require=${networkGuardPath}`]
  .filter(Boolean)
  .join(" ");
const serverEnv = {
  ...process.env,
  NODE_OPTIONS: nodeOptions,
  NEXT_TELEMETRY_DISABLED: "1",
  APP_DATA_DIR: dataDir,
  APP_STORAGE_MODE: "local",
  PIPELINE_EXECUTION_MODE: "inline",
  REDIS_URL: "",
  DAILY_BRIEF_INVITE_CODES: "reflection-e2e",
  DAILY_REFLECTION_UPLOAD_ENABLED: "true",
  DAILY_REFLECTION_BROWSER_RECORDING_ENABLED: "true",
  DAILY_BRIEF_TOY_SYNC_ENABLED: toySyncOnly ? "true" : "false",
  DAILY_REFLECTION_TOY_SYNC_ENABLED: toySyncOnly ? "true" : "false",
  TRANSCRIPTION_PROVIDER: "fixture",
  TRANSCRIPTION_FALLBACK_PROVIDER: "none",
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
  DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET: "",
  LLM_PROVIDER: "",
  QA_PROVIDER: "",
  VOICE_QA_LLM_PROVIDER: "",
  OPENAI_API_KEY: "",
  OPENAI_BASE_URL: "",
  OPENAI_ORG_ID: "",
  OPENAI_PROJECT_ID: "",
  OPENROUTER_API_KEY: "",
  OPENROUTER_BASE_URL: "",
  DEEPSEEK_API_KEY: "",
  DEEPSEEK_BASE_URL: "",
  VLLM_BASE_URL: "",
  HYBRID_EMBEDDING_BASE_URL: "",
  SPEAKER_ASR_BASE_URL: "",
  SPEAKER_ASR_AUDIO_BASE_URL: "",
  SPEAKER_ASR_AUDIO_ACCESS_TOKEN: "",
  VOICEPRINT_BASE_URL: "",
  FRP_PUBLIC_BASE_URL: "",
  DAILY_REFLECTION_E2E_BASE_URL: baseURL,
  DAILY_REFLECTION_E2E_DATA_DIR: dataDir,
  DAILY_REFLECTION_E2E_ARTIFACT_DIR: artifactDir,
  DAILY_REFLECTION_E2E_FIXTURE_PATH: fixturePath,
  DAILY_REFLECTION_E2E_QUICK_FIXTURE_PATH: quickFixturePath,
  DAILY_REFLECTION_E2E_FULL_FIXTURE_PATH: fullFixturePath,
  DATE_COMPANION_E2E_BASE_URL: baseURL,
  DATE_COMPANION_E2E_DATA_DIR: dataDir,
  DATE_COMPANION_E2E_ARTIFACT_DIR: artifactDir,
  DATE_COMPANION_E2E_SPEC: "daily-reflection-fixture.spec.ts"
};

progress(1, focusedScenario ? 5 : 7, `loopback port reserved port=${port}`);
progress(2, focusedScenario ? 5 : 7, `isolated local environment ready data_dir=${dataDir}`);
console.log(
  "[daily-reflection-e2e] providers transcription=fixture extraction=rule " +
  "audio_insight=rule relationship=none emotion=none proactive=none " +
  "memory_relevance=none hybrid=off queue=off"
);

const server = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "dev", "-H", "127.0.0.1", "-p", String(port)],
  {
    cwd: workspaceDir,
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  }
);
let serverLogState = { markerSeen: false, output: "" };
const captureServerOutput = (chunk) => {
  const text = chunk.toString();
  serverLogState = appendBoundedMarkerLog(serverLogState, text, {
    marker: BLOCK_MARKER,
    maxLength: 250_000
  });
  process.stdout.write(`[daily-reflection-server] ${text}`);
};
server.stdout.on("data", captureServerOutput);
server.stderr.on("data", captureServerOutput);

let testExitCode = 1;
try {
  await waitForServer(baseURL, server);
  progress(3, focusedScenario ? 5 : 7, "Next server ready");

  testExitCode = await runPlaywrightSpec(
    toySyncOnly
      ? "daily-reflection-toy-sync-fixture.spec.ts"
      : "daily-reflection-fixture.spec.ts",
    serverEnv,
    toySyncOnly ? toySyncArtifactDir : fileUploadArtifactDir
  );
  if (testExitCode !== 0) {
    throw new Error(
      `Daily Reflection ${toySyncOnly ? "Toy Sync" : "file-upload"} fixture failed `
      + `with code ${testExitCode}`
    );
  }
  if (serverLogState.markerSeen) throw new Error("The server attempted an external network request");
  progress(4, focusedScenario ? 5 : 7, toySyncOnly
    ? "Toy Sync fixture flow passed"
    : "file-upload fixture flow passed");

  if (focusedScenario) {
    progress(
      5,
      5,
      `single fixture gate complete artifacts=${toySyncOnly ? toySyncArtifactDir : fileUploadArtifactDir}`
    );
    testExitCode = 0;
  } else {

    testExitCode = await runPlaywrightSpec(
      "daily-reflection-browser-recording-fixture.spec.ts",
      serverEnv,
      browserRecordingArtifactDir
    );
    if (testExitCode !== 0) {
      throw new Error(`Daily Reflection browser-recording fixture failed with code ${testExitCode}`);
    }
    progress(5, 7, "browser-recording fixture flow passed");

    if (serverLogState.markerSeen) throw new Error("The server attempted an external network request");
    progress(6, 7, "server external request count is zero across both fixture scenarios");
    progress(7, 7, `fixture gate complete artifacts=${artifactDir}`);
  }
} catch (error) {
  console.error(`[daily-reflection-e2e] failed: ${error instanceof Error ? error.message : "unknown_error"}`);
  process.exitCode = testExitCode || 1;
} finally {
  await stopProcessTree(server);
  try {
    await assertPortReleased(port);
    console.log(`[daily-reflection-e2e] server_stopped pid=${server.pid ?? "unknown"} port_released=${port}`);
  } catch (error) {
    process.exitCode = 1;
    console.error(
      `[daily-reflection-e2e] server_stop_incomplete pid=${server.pid ?? "unknown"} ` +
      `port=${port} error=${error instanceof Error ? error.message : "unknown_error"}`
    );
  }
}

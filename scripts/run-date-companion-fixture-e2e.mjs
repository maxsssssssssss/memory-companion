import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { resolve } from "node:path";

const BLOCK_MARKER = "[date-companion-e2e-network] blocked_external_request";
const workspaceDir = resolve(process.cwd());
const requestedSpec = process.argv[2] ?? "date-companion-fixture.spec.ts";
const allowedSpecs = new Set([
  "date-companion-fixture.spec.ts",
  "date-companion-stage2-fixture.spec.ts"
]);
if (!allowedSpecs.has(requestedSpec)) {
  throw new Error(`Unsupported date-companion E2E spec: ${requestedSpec}`);
}
const runId = `${Date.now()}-${process.pid}`;
const relativeDataDir = `.data/date-companion-e2e-${runId}`;
const artifactDir = resolve(
  process.env.DATE_COMPANION_E2E_ARTIFACT_DIR || workspaceDir,
  process.env.DATE_COMPANION_E2E_ARTIFACT_DIR ? "" : relativeDataDir,
  process.env.DATE_COMPANION_E2E_ARTIFACT_DIR ? "" : "artifacts"
);
const fixtureDirectory = resolve(workspaceDir, relativeDataDir, "fixtures");
const fixturePath = resolve(fixtureDirectory, "date-companion-fixture.wav");
const networkGuardPath = resolve(workspaceDir, "scripts/date-companion-e2e-network-guard.cjs").replaceAll("\\", "/");

function createDeterministicPcmWav() {
  const sampleRate = 16_000;
  const channels = 1;
  const bitsPerSample = 16;
  const durationSeconds = 5;
  const bytesPerSample = bitsPerSample / 8;
  const sampleCount = sampleRate * durationSeconds;
  const pcmByteLength = sampleCount * channels * bytesPerSample;
  const wav = Buffer.alloc(44 + pcmByteLength);

  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + pcmByteLength, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  wav.writeUInt16LE(channels * bytesPerSample, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcmByteLength, 40);

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const sample = ((sampleIndex % 200) - 100) * 80;
    wav.writeInt16LE(sample, 44 + sampleIndex * bytesPerSample);
  }

  return wav;
}

function progress(completed, total, message) {
  console.log(`[date-companion-e2e] ${completed}/${total} ${message}`);
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

async function waitForServer(baseURL, child) {
  const deadline = Date.now() + 120_000;
  let lastError = "server_not_ready";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Next server exited early with code ${child.exitCode}`);
    }
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

await Promise.all([
  mkdir(artifactDir, { recursive: true }),
  mkdir(fixtureDirectory, { recursive: true })
]);
await writeFile(fixturePath, createDeterministicPcmWav());
const port = await reserveFreePort();
const baseURL = `http://127.0.0.1:${port}`;
const nodeOptions = [process.env.NODE_OPTIONS?.trim(), `--require=${networkGuardPath}`].filter(Boolean).join(" ");
const serverEnv = {
  ...process.env,
  NODE_OPTIONS: nodeOptions,
  NEXT_TELEMETRY_DISABLED: "1",
  APP_DATA_DIR: relativeDataDir,
  APP_STORAGE_MODE: "local",
  PIPELINE_EXECUTION_MODE: "inline",
  DAILY_BRIEF_INVITE_CODES: "date-e2e",
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
  EVALUATION_MODE: "false",
  LLM_PROVIDER: "",
  OPENAI_API_KEY: "",
  OPENAI_BASE_URL: "",
  OPENROUTER_API_KEY: "",
  OPENROUTER_BASE_URL: "",
  DEEPSEEK_API_KEY: "",
  DEEPSEEK_BASE_URL: "",
  VLLM_BASE_URL: "",
  SPEAKER_ASR_BASE_URL: "",
  DATE_COMPANION_E2E_BASE_URL: baseURL,
  DATE_COMPANION_E2E_ARTIFACT_DIR: artifactDir,
  DATE_COMPANION_E2E_FIXTURE_PATH: fixturePath,
  DATE_COMPANION_E2E_DATA_DIR: relativeDataDir,
  DATE_COMPANION_E2E_SPEC: requestedSpec
};

progress(1, 5, `loopback port verified port=${port}`);
progress(
  2,
  5,
  `isolated environment ready data_dir=${relativeDataDir} fixture=${fixturePath} spec=${requestedSpec}`
);
console.log(
  `[date-companion-e2e] providers transcription=fixture extraction=rule audio_insight=rule ` +
  `relationship=none emotion=none proactive=none memory_relevance=none hybrid=off hnav=off`
);

const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-H", "127.0.0.1", "-p", String(port)], {
  cwd: workspaceDir,
  env: serverEnv,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
let serverOutput = "";
const captureServerOutput = (chunk) => {
  const text = chunk.toString();
  serverOutput += text;
  if (serverOutput.length > 200_000) serverOutput = serverOutput.slice(-200_000);
  process.stdout.write(`[date-companion-server] ${text}`);
};
server.stdout.on("data", captureServerOutput);
server.stderr.on("data", captureServerOutput);

let testExitCode = 1;
try {
  await waitForServer(baseURL, server);
  progress(3, 5, "Next server ready");

  const playwright = spawn(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", "test", "--config", "playwright.date-companion.config.ts"],
    {
      cwd: workspaceDir,
      env: serverEnv,
      stdio: "inherit",
      windowsHide: true
    }
  );
  testExitCode = await new Promise((resolveExit) => playwright.once("exit", (code) => resolveExit(code ?? 1)));
  if (testExitCode !== 0) throw new Error(`Playwright fixture E2E failed with code ${testExitCode}`);
  progress(4, 5, "browser fixture flow passed");

  if (serverOutput.includes(BLOCK_MARKER)) {
    throw new Error("The server attempted an external network request");
  }
  if (!serverOutput.includes("[pipeline] background completed")) {
    throw new Error("Server log did not confirm inline Pipeline completion");
  }
  progress(5, 5, `zero external server requests confirmed artifacts=${artifactDir}`);
} catch (error) {
  console.error(`[date-companion-e2e] failed: ${error instanceof Error ? error.message : "unknown_error"}`);
  process.exitCode = testExitCode || 1;
} finally {
  await stopProcessTree(server);
  try {
    await assertPortReleased(port);
    console.log(`[date-companion-e2e] server_stopped pid=${server.pid ?? "unknown"} port_released=${port}`);
  } catch (error) {
    process.exitCode = 1;
    console.error(
      `[date-companion-e2e] server_stop_incomplete pid=${server.pid ?? "unknown"} ` +
      `port=${port} error=${error instanceof Error ? error.message : "unknown_error"}`
    );
  }
}

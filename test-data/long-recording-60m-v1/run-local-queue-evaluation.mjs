import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { loadEnvFile, parseTunnelUrlFromText, redactSensitiveUrl } from "../../scripts/lib/pipeline-validation.mjs";
import { assertLocalPortAvailable } from "../../scripts/lib/local-port.mjs";

const datasetDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(datasetDir, "../..");
const datasetVersion = "long-recording-60m-v1";
const reportDir = path.join(repoRoot, ".data", "evaluation", datasetVersion);
const runtimeDir = path.join(reportDir, "runtime");
const runDir = path.join(reportDir, "run");
const attemptMarker = path.join(runDir, "run-attempt.json");
const audioPath = path.join(datasetDir, "audio", `${datasetVersion}.wav`);

function parseArgs(argv) {
  const options = {
    redisUrl: "redis://127.0.0.1:6380",
    port: 3200,
    queueName: "daily-brief-pipeline-eval-60m",
    bullmqPrefix: "daily-brief-eval-60m"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--redis-url") { options.redisUrl = next; index += 1; }
    else if (arg === "--port") { options.port = Number(next); index += 1; }
    else if (arg === "--queue-name") { options.queueName = next; index += 1; }
    else if (arg === "--bullmq-prefix") { options.bullmqPrefix = next; index += 1; }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function secretValues(env) {
  const sensitiveKey = /(?:api[_-]?key|token|password|secret|authorization|invite[_-]?codes?|redis_url)/iu;
  return [
    env.LONG_RECORDING_EVAL_EMAIL,
    ...Object.entries(env).filter(([key]) => sensitiveKey.test(key)).map(([, value]) => value)
  ].filter((value) => typeof value === "string" && value.length >= 4).sort((left, right) => right.length - left.length);
}

function sanitize(value, secrets) {
  let text = redactSensitiveUrl(String(value));
  for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[REDACTED_EMAIL]")
    .replace(/(cookie|authorization|password|api[_-]?key|access[_-]?token)\s*[=:]\s*[^\s,;]+/giu, "$1=[REDACTED]");
}

function sanitizedRedisEndpoint(redisUrl) {
  const parsed = new URL(redisUrl);
  const port = parsed.port ? `:${parsed.port}` : "";
  return `${parsed.protocol}//${parsed.hostname}${port}`;
}

function startLoggedProcess(command, args, input) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: input.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  const stdoutStream = fs.createWriteStream(input.stdoutPath, { flags: "a" });
  const stderrStream = fs.createWriteStream(input.stderrPath, { flags: "a" });
  child.stdout.on("data", (chunk) => {
    const safe = sanitize(chunk.toString(), input.secrets);
    stdout += safe;
    stdoutStream.write(safe);
  });
  child.stderr.on("data", (chunk) => {
    const safe = sanitize(chunk.toString(), input.secrets);
    stderr += safe;
    stderrStream.write(safe);
  });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => {
    Promise.all([
      new Promise((done) => stdoutStream.end(done)),
      new Promise((done) => stderrStream.end(done))
    ]).then(() => resolve({ code, signal }));
  }));
  return { child, closed, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

async function waitForOutput(processHandle, pattern, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(`${processHandle.stdout}\n${processHandle.stderr}`)) return;
    if (processHandle.child.exitCode !== null) throw new Error(`${label} exited before ready`);
    await sleep(500);
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms`);
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.child.exitCode !== null) return;
  processHandle.child.kill("SIGTERM");
  await Promise.race([processHandle.closed, sleep(10_000)]);
  if (processHandle.child.exitCode === null) processHandle.child.kill("SIGKILL");
  await Promise.race([processHandle.closed, sleep(5_000)]);
}

async function stopProcessTree(processHandle) {
  if (!processHandle || processHandle.child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(processHandle.child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    await Promise.race([processHandle.closed, sleep(5_000)]);
    return;
  }
  await stopProcess(processHandle);
}

async function startTunnelPreflightServer(port) {
  const marker = `daily-brief-eval-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    response.end(marker);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    marker,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function verifyPublicTunnel(url, marker) {
  const deadline = Date.now() + 60_000;
  let lastFailure = "unreachable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/evaluation-preflight-${Date.now()}`, { cache: "no-store" });
      const text = await response.text();
      if (response.ok && text === marker) return;
      lastFailure = `status_${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.name : "fetch_error";
    }
    await sleep(1_000);
  }
  throw new Error(`Public tunnel preflight failed: ${lastFailure}`);
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status >= 200 && response.status < 500) return;
    } catch {
      // The dev server may still be compiling.
    }
    await sleep(500);
  }
  throw new Error(`HTTP preflight did not become ready: ${new URL(url).origin}`);
}

async function authenticatePreflight(baseUrl, env) {
  const post = (pathname, body) => fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const credentials = {
    email: env.LONG_RECORDING_EVAL_EMAIL,
    password: env.LONG_RECORDING_EVAL_PASSWORD
  };
  const login = await post("/api/auth/login", credentials);
  if (login.ok) return "login";
  const inviteCode = String(env.DAILY_BRIEF_INVITE_CODES ?? "").split(/[,\n]/u).map((value) => value.trim()).find(Boolean);
  assert(inviteCode, "DAILY_BRIEF_INVITE_CODES is required to register the isolated evaluation account");
  const registration = await post("/api/auth/register", { ...credentials, name: "Pipeline Validator", inviteCode });
  if (registration.ok) return "register";
  throw new Error(`Evaluation account authentication preflight failed: login=${login.status} register=${registration.status}`);
}

function listeningPids(port) {
  if (process.platform !== "win32") return [];
  const result = spawnSync("netstat.exe", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return [];
  const suffix = `:${port}`;
  return [...new Set(result.stdout.split(/\r?\n/u).flatMap((line) => {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 5 || fields[0].toUpperCase() !== "TCP" || fields[3].toUpperCase() !== "LISTENING") return [];
    if (!fields[1].endsWith(suffix)) return [];
    return /^\d+$/u.test(fields[4]) ? [Number(fields[4])] : [];
  }))];
}

function stopEvaluationPortListeners(port) {
  for (const pid of listeningPids(port)) {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  }
}

function findValidatorResult(stdout) {
  const candidates = [];
  for (let index = stdout.indexOf("{"); index >= 0; index = stdout.indexOf("{", index + 1)) candidates.push(index);
  for (const index of candidates.reverse()) {
    try {
      const parsed = JSON.parse(stdout.slice(index).trim());
      if (parsed && typeof parsed === "object" && "ok" in parsed && "uploadId" in parsed) return parsed;
    } catch {
      // Continue looking for the final JSON document.
    }
  }
  return null;
}

function readEnvelopeJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
}

function findRuntimeRecords(result) {
  const usersRoot = path.join(runtimeDir, "users");
  if (!fs.existsSync(usersRoot)) return {};
  const userIds = result?.auth?.userId
    ? [result.auth.userId]
    : fs.readdirSync(usersRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const userId of userIds) {
    const userRoot = path.join(usersRoot, userId);
    let uploadId = result?.uploadId;
    if (!uploadId) {
      const uploadDirectory = path.join(userRoot, "uploads");
      const candidates = fs.existsSync(uploadDirectory)
        ? fs.readdirSync(uploadDirectory).filter((name) => name.endsWith(".json")).map((name) => ({
            id: name.slice(0, -5),
            value: readEnvelopeJson(path.join(uploadDirectory, name))
          })).filter((item) => item.value?.recordingDate === "2026-07-17")
        : [];
      candidates.sort((left, right) => String(right.value?.createdAt ?? "").localeCompare(String(left.value?.createdAt ?? "")));
      uploadId = candidates[0]?.id;
    }
    if (!uploadId) continue;
    const upload = readEnvelopeJson(path.join(userRoot, "uploads", `${uploadId}.json`));
    const job = readEnvelopeJson(path.join(userRoot, "jobs-by-upload", `${uploadId}.json`));
    if (upload || job) return { userId, userRoot, upload, job };
  }
  return {};
}

async function inspectQueue(input) {
  const redis = new IORedis(input.redisUrl, {
    lazyConnect: true,
    connectTimeout: 10_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null
  });
  let queue;
  try {
    await redis.connect();
    const ping = await redis.ping();
    queue = new Queue(input.queueName, { connection: redis });
    await queue.waitUntilReady();
    const counts = await queue.getJobCounts("waiting", "active", "completed", "failed", "delayed");
    const job = input.queueJobId ? await queue.getJob(input.queueJobId) : null;
    const state = job ? await job.getState() : null;
    const config = {};
    for (const key of ["appendonly", "appendfsync", "maxmemory-policy"]) {
      try { config[key] = (await redis.config("GET", key))[1] ?? null; } catch { config[key] = null; }
    }
    let persistence = "";
    try { persistence = await redis.info("persistence"); } catch { /* Optional diagnostic only. */ }
    return {
      generatedAt: new Date().toISOString(),
      queueName: input.queueName,
      bullmqPrefixConfiguredInEnvironment: input.bullmqPrefix,
      bullmqPrefixSupportedByCurrentQueueCode: false,
      ping,
      counts,
      redis: {
        endpoint: sanitizedRedisEndpoint(input.redisUrl),
        appendonly: config.appendonly,
        appendfsync: config.appendfsync,
        maxmemoryPolicy: config["maxmemory-policy"],
        aofLastWriteStatus: /aof_last_write_status:([^\r\n]+)/u.exec(persistence)?.[1] ?? null
      },
      job: job ? {
        id: job.id,
        state,
        progress: job.progress,
        attemptsMade: job.attemptsMade,
        timestamp: job.timestamp,
        processedOn: job.processedOn ?? null,
        finishedOn: job.finishedOn ?? null,
        failedReason: job.failedReason ? input.sanitize(job.failedReason) : null,
        returnStatus: job.returnvalue?.status ?? null
      } : null
    };
  } finally {
    await queue?.close().catch(() => undefined);
    try { await redis.quit(); } catch { redis.disconnect(false); }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const envFile = loadEnvFile(path.join(repoRoot, ".env.local"));
  const baseEnv = { ...envFile, ...process.env };
  assert(baseEnv.RUN_LONG_RECORDING_REMOTE_VERIFY === "1", "RUN_LONG_RECORDING_REMOTE_VERIFY=1 is required");
  assert(baseEnv.LONG_RECORDING_EVAL_EMAIL, "LONG_RECORDING_EVAL_EMAIL is required");
  assert(baseEnv.LONG_RECORDING_EVAL_PASSWORD, "LONG_RECORDING_EVAL_PASSWORD is required");
  assert(fs.existsSync(audioPath), `Missing generated audio: ${audioPath}`);
  assert(!fs.existsSync(attemptMarker), "This dataset already has a run-attempt marker; refusing a second full upload");
  await fsp.mkdir(runDir, { recursive: true });

  const secrets = secretValues(baseEnv);
  const appDataDir = path.relative(repoRoot, runtimeDir).replaceAll("\\", "/");
  const commonEnv = {
    ...baseEnv,
    APP_DATA_DIR: appDataDir,
    BULLMQ_PREFIX: options.bullmqPrefix,
    PIPELINE_QUEUE_NAME: options.queueName,
    PIPELINE_EXECUTION_MODE: "queue",
    PIPELINE_WORKER_CONCURRENCY: "1",
    EVALUATION_MODE: "true",
    REDIS_URL: options.redisUrl
  };
  const tunnelCommand = baseEnv.CLOUDFLARED_BIN?.trim() || (fs.existsSync("C:\\tmp\\cloudflared.exe") ? "C:\\tmp\\cloudflared.exe" : "cloudflared");
  let tunnel;
  let worker;
  let validator;
  let webPreflight;
  let preflightServer;
  let queueSnapshot = null;
  let validatorResult = null;
  let records = {};
  let failure = null;
  const startedAt = Date.now();
  let interrupted = false;
  const throwIfInterrupted = () => {
    if (interrupted) throw new Error("Evaluation runner interrupted");
  };
  const cleanup = async () => {
    await stopProcessTree(validator);
    await stopProcessTree(webPreflight);
    await stopProcess(worker);
    await stopProcess(tunnel);
    await preflightServer?.close().catch(() => undefined);
    stopEvaluationPortListeners(options.port);
  };
  const onSignal = () => {
    interrupted = true;
    void cleanup();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const audioValidation = spawnSync(process.execPath, [path.join(datasetDir, "validate-audio.mjs"), "--require-audio"], {
      cwd: repoRoot,
      env: commonEnv,
      windowsHide: true,
      encoding: "utf8"
    });
    assert(audioValidation.status === 0, "Static audio validation failed before remote execution");
    throwIfInterrupted();
    await inspectQueue({
      ...options,
      queueJobId: null,
      sanitize: (value) => sanitize(value, secrets)
    });
    throwIfInterrupted();
    await assertLocalPortAvailable(options.port);
    throwIfInterrupted();
    preflightServer = await startTunnelPreflightServer(options.port);
    throwIfInterrupted();
    tunnel = startLoggedProcess(tunnelCommand, [
      "tunnel", "--url", `http://127.0.0.1:${options.port}`, "--protocol", "quic", "--no-autoupdate", "--ha-connections", "1"
    ], {
      env: commonEnv,
      secrets,
      stdoutPath: path.join(runDir, "tunnel.stdout.log"),
      stderrPath: path.join(runDir, "tunnel.stderr.log")
    });
    await waitForOutput(tunnel, /Registered tunnel connection|started tunnel|client session established/iu, 120_000, "cloudflared");
    throwIfInterrupted();
    const tunnelUrl = parseTunnelUrlFromText(`${tunnel.stdout}\n${tunnel.stderr}`);
    assert(tunnelUrl, "Cloudflare tunnel URL was not detected");
    await verifyPublicTunnel(tunnelUrl, preflightServer.marker);
    throwIfInterrupted();
    await preflightServer.close();
    preflightServer = null;
    await assertLocalPortAvailable(options.port);
    throwIfInterrupted();
    const executionEnv = { ...commonEnv, SPEAKER_ASR_AUDIO_BASE_URL: tunnelUrl };

    const nextCli = path.join(repoRoot, "node_modules", "next", "dist", "bin", "next");
    webPreflight = startLoggedProcess(process.execPath, [nextCli, "dev", "-p", String(options.port)], {
      env: executionEnv,
      secrets,
      stdoutPath: path.join(runDir, "web-preflight.stdout.log"),
      stderrPath: path.join(runDir, "web-preflight.stderr.log")
    });
    await waitForHttp(`http://127.0.0.1:${options.port}`, 60_000);
    throwIfInterrupted();
    await authenticatePreflight(`http://127.0.0.1:${options.port}`, executionEnv);
    throwIfInterrupted();
    await stopProcessTree(webPreflight);
    webPreflight = null;
    await assertLocalPortAvailable(options.port);
    throwIfInterrupted();

    const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    worker = startLoggedProcess(process.execPath, [tsxCli, "src/worker/pipeline-worker.ts"], {
      env: executionEnv,
      secrets,
      stdoutPath: path.join(runDir, "worker.stdout.log"),
      stderrPath: path.join(runDir, "worker.stderr.log")
    });
    await waitForOutput(worker, /\[pipeline-worker\] ready /u, 60_000, "pipeline worker");
    throwIfInterrupted();

    await fsp.writeFile(attemptMarker, JSON.stringify({
      datasetVersion,
      startedAt: new Date().toISOString(),
      uploadLimit: 1,
      status: "started",
      preflightPassed: true
    }, null, 2), { encoding: "utf8", flag: "wx" });
    throwIfInterrupted();

    validator = startLoggedProcess(process.execPath, [
      "scripts/validate-pipeline.mjs",
      "--audio", path.relative(repoRoot, audioPath),
      "--date", "2026-07-17",
      "--port", String(options.port),
      "--tunnel", "none",
      "--email", baseEnv.LONG_RECORDING_EVAL_EMAIL,
      "--password", baseEnv.LONG_RECORDING_EVAL_PASSWORD,
      "--timeout-seconds", "5400"
    ], {
      env: executionEnv,
      secrets,
      stdoutPath: path.join(runDir, "validator.stdout.log"),
      stderrPath: path.join(runDir, "validator.stderr.log")
    });
    const validatorExit = await validator.closed;
    validatorResult = findValidatorResult(validator.stdout);
    if (validatorExit.code !== 0) throw new Error(`validate-pipeline exited with ${validatorExit.code}`);
    assert(validatorResult?.ok === true, "validate-pipeline did not report a ready job");

  } catch (error) {
    failure = sanitize(error instanceof Error ? error.message : String(error), secrets);
  } finally {
    try {
      try {
        records = findRuntimeRecords(validatorResult);
      } catch (error) {
        failure ??= `Runtime record inspection failed: ${sanitize(error instanceof Error ? error.message : String(error), secrets)}`;
      }
      const queueJobId = records.job?.queueJobId ?? records.upload?.queueJobId ?? null;
      try {
        queueSnapshot = await inspectQueue({
          ...options,
          queueJobId,
          sanitize: (value) => sanitize(value, secrets)
        });
        await fsp.writeFile(path.join(runDir, "queue-snapshot.json"), JSON.stringify(queueSnapshot, null, 2), "utf8");
        if (validatorResult?.ok === true && (
          queueSnapshot.job?.state !== "completed"
          || Number(queueSnapshot.job?.progress) !== 100
          || queueSnapshot.job?.attemptsMade !== 1
          || queueSnapshot.job?.returnStatus !== "ready"
        )) {
          failure ??= "BullMQ final state did not match completed/100/attempts=1/ready";
        }
      } catch (error) {
        const queueFailure = sanitize(error instanceof Error ? error.message : String(error), secrets);
        try {
          await fsp.writeFile(path.join(runDir, "queue-inspection-error.json"), JSON.stringify({ error: queueFailure }, null, 2), "utf8");
        } catch {
          // Cleanup must still run if diagnostic publication fails.
        }
        if (validatorResult?.ok === true) failure ??= `Queue final-state inspection failed: ${queueFailure}`;
      }
    } finally {
      await cleanup();
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  }

  if (interrupted) failure ??= "Evaluation runner interrupted";

  const summary = {
    datasetVersion,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    uploadCount: validatorResult?.uploadId || records.upload ? 1 : 0,
    uploadId: validatorResult?.uploadId ?? records.upload?.id ?? records.job?.uploadId ?? null,
    userId: records.userId ?? validatorResult?.auth?.userId ?? null,
    productJobId: validatorResult?.jobId ?? records.job?.id ?? null,
    queueJobId: records.job?.queueJobId ?? records.upload?.queueJobId ?? queueSnapshot?.job?.id ?? null,
    productJobStatus: validatorResult?.jobStatus ?? records.job?.status ?? null,
    bullState: queueSnapshot?.job?.state ?? null,
    bullAttemptsMade: queueSnapshot?.job?.attemptsMade ?? null,
    executionMode: "queue",
    evaluationMode: true,
    appDataDir,
    queueName: options.queueName,
    bullmqPrefixConfigured: options.bullmqPrefix,
    bullmqPrefixAppliedByCurrentCode: false,
    redisEndpoint: sanitizedRedisEndpoint(options.redisUrl),
    workerConcurrency: 1,
    tunnelStrategy: "shared_cloudflared_validator_none",
    remoteProvidersUsed: Boolean(validatorResult?.uploadId),
    failure
  };
  await fsp.writeFile(path.join(runDir, "run-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  if (fs.existsSync(attemptMarker)) {
    await fsp.writeFile(attemptMarker, JSON.stringify({
      datasetVersion,
      startedAt: summary.startedAt,
      finishedAt: summary.finishedAt,
      uploadLimit: 1,
      uploadCount: summary.uploadCount,
      uploadId: summary.uploadId,
      status: failure ? "failed" : "completed"
    }, null, 2), "utf8");
  }

  const workerLog = [
    fs.existsSync(path.join(runDir, "worker.stdout.log")) ? fs.readFileSync(path.join(runDir, "worker.stdout.log"), "utf8") : "",
    fs.existsSync(path.join(runDir, "worker.stderr.log")) ? fs.readFileSync(path.join(runDir, "worker.stderr.log"), "utf8") : ""
  ].filter(Boolean).join("\n");
  const validatorStageLines = validator
    ? validator.stdout.split(/\r?\n/u).filter((line) => line.startsWith("[")).join("\n")
    : "";
  await fsp.writeFile(path.join(runDir, "validator.stdout.log"), sanitize(`${validatorStageLines}\n`, secrets), "utf8");
  await fsp.writeFile(path.join(runDir, "pipeline.source.log"), sanitize(`${workerLog}\n${validatorStageLines}\n`, secrets), "utf8");
  for (const name of ["worker.stdout.log", "worker.stderr.log", "validator.stderr.log", "tunnel.stdout.log", "tunnel.stderr.log", "web-preflight.stdout.log", "web-preflight.stderr.log"]) {
    const filePath = path.join(runDir, name);
    if (fs.existsSync(filePath)) await fsp.writeFile(filePath, sanitize(await fsp.readFile(filePath, "utf8"), secrets), "utf8");
  }

  console.log(JSON.stringify({
    ok: !failure,
    uploadId: summary.uploadId,
    productJobId: summary.productJobId,
    queueJobId: summary.queueJobId,
    productJobStatus: summary.productJobStatus,
    bullState: summary.bullState,
    elapsedMs: summary.elapsedMs,
    failure
  }, null, 2));
  if (failure) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: redactSensitiveUrl(error instanceof Error ? error.message : String(error)) }, null, 2));
  process.exitCode = 1;
});

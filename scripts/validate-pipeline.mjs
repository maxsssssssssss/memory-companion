import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { audioFixtureDefinitions, findAudioFixture } from "./lib/audio-fixtures.mjs";
import { assertLocalPortAvailable } from "./lib/local-port.mjs";
import { createPipelineChildLogForwarder } from "./lib/pipeline-child-log.mjs";
import { createStageLogger } from "./lib/pipeline-stage-logger.mjs";
import {
  firstInviteCode,
  loadEnvFile,
  parseTunnelUrlFromText,
  redactSensitiveUrl,
  repoRoot,
  summarizeDayPayload
} from "./lib/pipeline-validation.mjs";

function parseArgs(argv) {
  const options = {
    tunnel: "cloudflared",
    port: 3200,
    email: "p0-pipeline-validation@example.com",
    password: "CodexTest123!",
    recordingDate: new Date().toISOString().slice(0, 10),
    timeoutSeconds: 900,
    keepProcesses: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--fixture") {
      options.fixture = next;
      index += 1;
    } else if (arg === "--audio") {
      options.audio = next;
      index += 1;
    } else if (arg === "--date") {
      options.recordingDate = next;
      index += 1;
    } else if (arg === "--port") {
      options.port = Number(next);
      index += 1;
    } else if (arg === "--tunnel") {
      options.tunnel = next;
      index += 1;
    } else if (arg === "--email") {
      options.email = next;
      index += 1;
    } else if (arg === "--password") {
      options.password = next;
      index += 1;
    } else if (arg === "--timeout-seconds") {
      options.timeoutSeconds = Number(next);
      index += 1;
    } else if (arg === "--keep-processes") {
      options.keepProcesses = true;
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  npm run validate:pipeline -- --fixture relationship_dialogue_90s
  npm run validate:pipeline -- --audio fixtures/audio/non_relationship_60s.wav --date 2026-07-09

Options:
  --fixture <name>           One of: ${audioFixtureDefinitions.map((fixture) => fixture.name).join(", ")}
  --audio <path>             Audio file path. Overrides --fixture.
  --date <YYYY-MM-DD>        Recording date. Defaults to today.
  --port <number>            Local Next.js port. Defaults to 3200.
  --tunnel <kind>            cloudflared | ngrok | frp | none. Defaults to cloudflared.
  --email <email>            Test account email.
  --password <password>      Test account password.
  --timeout-seconds <n>      Job polling timeout. Defaults to 900.
  --keep-processes           Leave dev server and tunnel running after validation.
`);
}

function resolveAudioPath(options) {
  if (options.audio) {
    return path.resolve(repoRoot, options.audio);
  }
  const fixture = findAudioFixture(options.fixture ?? "relationship_dialogue_90s");
  if (!fixture) {
    throw new Error(`Unknown fixture: ${options.fixture}`);
  }
  return fixture.filePath;
}

function npmCommandArgs(port) {
  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/c", "npm", "run", "dev", "--", "-p", String(port)]
    };
  }
  return {
    command: "npm",
    args: ["run", "dev", "--", "-p", String(port)]
  };
}

function startProcess(command, args, options = {}) {
  const { forwardPipelineLogs = false, ...spawnOptions } = options;
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...spawnOptions
  });
  child.output = "";
  const logForwarder = forwardPipelineLogs ? createPipelineChildLogForwarder() : null;
  const capture = (chunk) => {
    child.output += chunk.toString();
    if (child.output.length > 20000) {
      child.output = child.output.slice(-20000);
    }
    logForwarder?.push(chunk);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("close", () => logForwarder?.flush());
  return child;
}

function stopProcess(child) {
  if (child && !child.killed) {
    child.kill();
  }
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(1000);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? "unknown error"}`);
}

function cloudflaredCommand() {
  return process.env.CLOUDFLARED_BIN?.trim() || (fs.existsSync("C:\\tmp\\cloudflared.exe") ? "C:\\tmp\\cloudflared.exe" : "cloudflared");
}

async function startTunnel(kind, port) {
  if (kind === "none") {
    const baseUrl = process.env.SPEAKER_ASR_AUDIO_BASE_URL || `http://localhost:${port}`;
    return { baseUrl, child: null, kind };
  }

  if (kind === "frp") {
    const baseUrl = process.env.FRP_PUBLIC_BASE_URL?.trim();
    if (!baseUrl) {
      throw new Error("FRP_PUBLIC_BASE_URL is required when --tunnel frp is used.");
    }
    const command = process.env.FRP_COMMAND?.trim();
    const child = command ? startProcess("cmd.exe", ["/c", command]) : null;
    return { baseUrl, child, kind };
  }

  const child =
    kind === "ngrok"
      ? startProcess("ngrok", ["http", String(port), "--log=stdout"])
      : startProcess(cloudflaredCommand(), [
          "tunnel",
          "--url",
          `http://127.0.0.1:${port}`,
          "--protocol",
          "quic",
          "--no-autoupdate",
          "--ha-connections",
          "1"
        ]);

  const deadline = Date.now() + 120000;
  let baseUrl = null;
  while (Date.now() < deadline) {
    baseUrl = parseTunnelUrlFromText(child.output);
    const registered = kind === "ngrok" || /Registered tunnel connection|started tunnel|client session established/i.test(child.output);
    if (baseUrl && registered) {
      return { baseUrl, child, kind };
    }
    if (child.exitCode !== null) {
      throw new Error(`${kind} exited early: ${redactSensitiveUrl(child.output)}`);
    }
    await wait(1000);
  }

  throw new Error(`Timed out waiting for ${kind} public URL. Output: ${redactSensitiveUrl(child.output)}`);
}

async function postJson(baseUrl, pathName, body, cookie) {
  const headers = { "content-type": "application/json" };
  if (cookie) {
    headers.cookie = cookie;
  }
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return {
    response,
    text,
    json: text ? JSON.parse(text) : {}
  };
}

function cookieFromResponse(response) {
  const setCookie = response.headers.get("set-cookie");
  return setCookie?.split(";")[0] ?? "";
}

async function authenticate(baseUrl, options) {
  const login = await postJson(baseUrl, "/api/auth/login", {
    email: options.email,
    password: options.password
  });
  if (login.response.ok) {
    return { user: login.json.user, cookie: cookieFromResponse(login.response), mode: "login" };
  }

  const inviteCode = firstInviteCode(loadEnvFile());
  const register = await postJson(baseUrl, "/api/auth/register", {
    email: options.email,
    password: options.password,
    name: "Pipeline Validation",
    inviteCode
  });
  if (register.response.ok) {
    return { user: register.json.user, cookie: cookieFromResponse(register.response), mode: "register" };
  }

  throw new Error(`Authentication failed: status=${register.response.status} body=${redactSensitiveUrl(register.text)}`);
}

async function uploadAudio(baseUrl, cookie, audioPath, recordingDate, evaluationRetention) {
  const bytes = await fs.promises.readFile(audioPath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/wav" }), path.basename(audioPath));
  form.append("recordingDate", recordingDate);
  const response = await fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    headers: {
      cookie,
      ...(evaluationRetention ? { "x-evaluation-retention": "true" } : {})
    },
    body: form
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`Upload failed: status=${response.status} body=${redactSensitiveUrl(text)}`);
  }
  return json;
}

async function getJson(baseUrl, pathName, cookie) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    headers: cookie ? { cookie } : undefined
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`GET ${pathName} failed: status=${response.status} body=${redactSensitiveUrl(text)}`);
  }
  return json;
}

async function pollJob(baseUrl, cookie, jobId, timeoutSeconds, logger) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastSignature = "";
  let lastHeartbeat = 0;
  while (Date.now() < deadline) {
    const job = await getJson(baseUrl, `/api/jobs/${jobId}`, cookie);
    const signature = `${job.status ?? "unknown"}:${job.progress ?? ""}:${job.errorCode ?? ""}`;
    const now = Date.now();
    if (signature !== lastSignature || now - lastHeartbeat >= 30000) {
      logger?.log("polling job", {
        status: job.status ?? "unknown",
        progress: job.progress !== undefined ? `${job.progress}%` : undefined,
        errorCode: job.errorCode ?? undefined
      });
      lastSignature = signature;
      lastHeartbeat = now;
    }
    if (job.status === "ready" || job.status === "failed") {
      return job;
    }
    await wait(5000);
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const logger = createStageLogger();
  const envValues = loadEnvFile();
  const evaluationRetention = (process.env.EVALUATION_MODE ?? envValues.EVALUATION_MODE ?? "")
    .trim()
    .toLowerCase() === "true";
  if (options.help) {
    printHelp();
    return;
  }

  const audioPath = resolveAudioPath(options);
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }
  const audioStat = fs.statSync(audioPath);

  const localBaseUrl = `http://localhost:${options.port}`;
  const processes = [];
  try {
    logger.log("checking audio file", {
      fileName: path.basename(audioPath),
      sizeKB: Math.round(audioStat.size / 1024),
      recordingDate: options.recordingDate
    });
    logger.log("checking local port", { port: options.port });
    await assertLocalPortAvailable(options.port);
    logger.log("starting tunnel", {
      kind: options.tunnel,
      target: localBaseUrl
    });
    const tunnel = await startTunnel(options.tunnel, options.port);
    if (tunnel.child) {
      processes.push(tunnel.child);
    }
    logger.log("tunnel ready", {
      kind: tunnel.kind,
      host: new URL(tunnel.baseUrl).host
    });

    const npm = npmCommandArgs(options.port);
    logger.log("starting Next.js dev server", { url: localBaseUrl });
    const server = startProcess(npm.command, npm.args, {
      forwardPipelineLogs: true,
      env: {
        ...process.env,
        SPEAKER_ASR_AUDIO_BASE_URL: tunnel.baseUrl
      }
    });
    processes.push(server);

    await waitForHttp(localBaseUrl, 60000);
    logger.log("Next.js ready", { url: localBaseUrl });
    if (options.tunnel !== "none") {
      logger.log("checking public tunnel", { host: new URL(tunnel.baseUrl).host });
      await waitForHttp(tunnel.baseUrl, 60000);
      logger.log("public tunnel reachable", { host: new URL(tunnel.baseUrl).host });
    }
    logger.log("authenticating", { email: options.email });
    const auth = await authenticate(localBaseUrl, options);
    logger.log("authenticated", {
      mode: auth.mode,
      userId: auth.user?.id
    });
    logger.log("uploading audio", {
      fileName: path.basename(audioPath),
      recordingDate: options.recordingDate,
      evaluationRetention
    });
    const upload = await uploadAudio(
      localBaseUrl,
      auth.cookie,
      audioPath,
      options.recordingDate,
      evaluationRetention
    );
    if (evaluationRetention && upload.evaluationRetention !== true) {
      throw new Error("Evaluation retention was requested but the upload was not marked for retention");
    }
    logger.log("upload created", {
      uploadId: upload.uploadId,
      jobId: upload.jobId
    });
    const job = await pollJob(localBaseUrl, auth.cookie, upload.jobId, options.timeoutSeconds, logger);
    logger.log("job finished", {
      status: job.status,
      progress: job.progress !== undefined ? `${job.progress}%` : undefined,
      errorCode: job.errorCode ?? undefined
    });
    logger.log("fetching day payload", { uploadId: upload.uploadId });
    const day = await getJson(localBaseUrl, `/api/days/${upload.uploadId}`, auth.cookie);
    const summary = summarizeDayPayload(day);
    logger.log("day payload ready", {
      uploadStatus: summary.uploadStatus,
      jobStatus: summary.jobStatus,
      segments: summary.transcriptSegments,
      speakers: summary.speakers,
      insights: summary.audioInsights,
      semantic: summary.semanticSegments,
      brief: summary.briefItems,
      signals: summary.relationshipSignals
    });

    console.log(
      JSON.stringify(
        {
          ok: job.status === "ready",
          tunnel: {
            kind: tunnel.kind,
            host: new URL(tunnel.baseUrl).host
          },
          auth: {
            mode: auth.mode,
            email: options.email,
            userId: auth.user?.id
          },
          audio: {
            fileName: path.basename(audioPath),
            recordingDate: options.recordingDate
          },
          uploadId: upload.uploadId,
          jobId: upload.jobId,
          jobStatus: job.status,
          errorCode: job.errorCode ?? null,
          errorMessage: job.errorMessage ? redactSensitiveUrl(job.errorMessage) : null,
          summary
        },
        null,
        2
      )
    );
  } finally {
    if (!options.keepProcesses) {
      processes.reverse().forEach(stopProcess);
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: redactSensitiveUrl(error.message) }, null, 2));
  process.exitCode = 1;
});

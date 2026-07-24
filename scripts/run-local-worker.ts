import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeEnv } from "../src/lib/server/env/runtime-env";
import { acquireLocalWorkerLease } from "../src/lib/server/queue/local-worker-lease";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const managedBlockStart = "# >>> daily-brief local audio tunnel (generated)";
const managedBlockEnd = "# <<< daily-brief local audio tunnel (generated)";
const audioBaseUrlKey = "SPEAKER_ASR_AUDIO_BASE_URL";
const tunnelUrlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const registeredTunnelPattern =
  /Registered tunnel connection|started tunnel|client session established/i;

export const localAudioTunnelEnvPath = resolve(repoRoot, ".env.audio-tunnel.local");

export type LocalWorkerOptions = {
  help: boolean;
  port: number;
  protocol: "auto" | "http2" | "quic";
};

class ShutdownRequestedError extends Error {
  constructor(readonly signalName: "SIGINT" | "SIGTERM") {
    super(`Local Worker shutdown requested by ${signalName}`);
    this.name = "ShutdownRequestedError";
  }
}

export function parseLocalWorkerArgs(argv: string[]): LocalWorkerOptions {
  const options: LocalWorkerOptions = {
    help: false,
    port: 3200,
    protocol: "quic"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--port") {
      const port = Number(next);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("--port must be an integer between 1 and 65535");
      }
      options.port = port;
      index += 1;
    } else if (argument === "--protocol") {
      if (next !== "auto" && next !== "http2" && next !== "quic") {
        throw new Error("--protocol must be auto, http2, or quic");
      }
      options.protocol = next;
      index += 1;
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

export function parseCloudflaredTunnelUrl(output: string) {
  return output.match(tunnelUrlPattern)?.[0] ?? null;
}

function assertSafeTunnelUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".trycloudflare.com") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("cloudflared returned an unexpected public URL");
  }
}

export function renderLocalAudioTunnelEnv(publicUrl: string) {
  assertSafeTunnelUrl(publicUrl);
  return [
    managedBlockStart,
    "# Managed by `npm run worker:local`; contains no token or credential.",
    `${audioBaseUrlKey}=${publicUrl}`,
    managedBlockEnd,
    ""
  ].join("\n");
}

export async function writeLocalAudioTunnelEnv(filePath: string, publicUrl: string) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, renderLocalAudioTunnelEnv(publicUrl), {
      encoding: "utf8",
      mode: 0o600
    });
    try {
      await rename(temporaryPath, filePath);
    } catch (error) {
      if (
        !(
          process.platform === "win32" &&
          error instanceof Error &&
          "code" in error &&
          (error.code === "EEXIST" || error.code === "EPERM")
        )
      ) {
        throw error;
      }
      await rm(filePath, { force: true });
      await rename(temporaryPath, filePath);
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function resolveCloudflaredCommand(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform = process.platform,
  fileExists: (path: string) => boolean = existsSync
) {
  const configured = env.CLOUDFLARED_BIN?.trim();
  if (configured) {
    return configured;
  }
  if (platform === "win32" && fileExists("C:\\tmp\\cloudflared.exe")) {
    return "C:\\tmp\\cloudflared.exe";
  }
  return "cloudflared";
}

export function buildCloudflaredArgs(options: LocalWorkerOptions) {
  return [
    "tunnel",
    "--url",
    `http://127.0.0.1:${options.port}`,
    "--protocol",
    options.protocol,
    "--no-autoupdate",
    "--ha-connections",
    "1"
  ];
}

function redactSensitiveOutput(value: string) {
  return value
    .replace(/([?&](?:token|access_token|auth_token)=)[^&\s"]+/gi, "$1****")
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)["'\s:=]+)[^\s"',;&]+/gi,
      "$1****"
    );
}

function throwIfShutdownRequested(signal: AbortSignal) {
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof ShutdownRequestedError) {
      throw reason;
    }
    throw new ShutdownRequestedError("SIGTERM");
  }
}

function wait(durationMs: number, signal?: AbortSignal) {
  if (!signal) {
    return new Promise<void>((resolveWait) => setTimeout(resolveWait, durationMs));
  }
  throwIfShutdownRequested(signal);
  return new Promise<void>((resolveWait, rejectWait) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveWait();
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      try {
        throwIfShutdownRequested(signal);
      } catch (error) {
        rejectWait(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForReachableHttp(url: string, timeoutMs: number, shutdown: AbortSignal) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "unreachable";
  while (Date.now() < deadline) {
    throwIfShutdownRequested(shutdown);
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.any([shutdown, AbortSignal.timeout(5_000)])
      });
      if (response.status < 500) {
        return;
      }
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      throwIfShutdownRequested(shutdown);
      lastFailure = error instanceof Error ? error.name : "request_failed";
    }
    await wait(500, shutdown);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastFailure}`);
}

function childExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function stopTunnel(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([childExit(child), wait(5_000)]);
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
    return;
  }

  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
  } else {
    child.kill("SIGKILL");
  }
}

async function waitForTunnelUrl(
  child: ChildProcess,
  readOutput: () => string,
  shutdown: AbortSignal
) {
  const deadline = Date.now() + 120_000;
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });

  while (Date.now() < deadline) {
    throwIfShutdownRequested(shutdown);
    if (spawnError) {
      throw spawnError;
    }
    const output = readOutput();
    const publicUrl = parseCloudflaredTunnelUrl(output);
    if (publicUrl && registeredTunnelPattern.test(output)) {
      assertSafeTunnelUrl(publicUrl);
      return publicUrl;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `cloudflared exited before becoming ready: ${redactSensitiveOutput(output.slice(-2_000))}`
      );
    }
    await wait(250, shutdown);
  }

  throw new Error(
    `Timed out waiting for cloudflared public URL: ${redactSensitiveOutput(readOutput().slice(-2_000))}`
  );
}

function shutdownController() {
  const controller = new AbortController();
  let resolveSignal: (signalName: "SIGINT" | "SIGTERM") => void = () => undefined;
  const promise = new Promise<"SIGINT" | "SIGTERM">((resolvePromise) => {
    resolveSignal = resolvePromise;
  });
  const requestShutdown = (signalName: "SIGINT" | "SIGTERM") => {
    if (controller.signal.aborted) {
      return;
    }
    controller.abort(new ShutdownRequestedError(signalName));
    resolveSignal(signalName);
  };
  const onSigint = () => requestShutdown("SIGINT");
  const onSigterm = () => requestShutdown("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return {
    dispose() {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    },
    promise,
    signal: controller.signal
  };
}

function printHelp() {
  console.log(`Usage: npm run worker:local -- [--port 3200] [--protocol quic]

Starts a Cloudflare Quick Tunnel, writes its current public audio URL to the
Git-ignored .env.audio-tunnel.local file, and runs the existing Queue Worker.
Keep this process running while uploading from localhost. Ctrl+C stops both.`);
}

export async function runLocalWorker(options: LocalWorkerOptions) {
  const localWebUrl = `http://127.0.0.1:${options.port}`;
  const lock = await acquireLocalWorkerLease({ enabled: true, role: "supervisor" });
  const shutdown = shutdownController();
  let tunnel: ChildProcess | undefined;
  let workerRuntime:
    | Awaited<ReturnType<(typeof import("../src/lib/server/queue/runtime"))["startPipelineWorker"]>>
    | undefined;

  try {
    await rm(localAudioTunnelEnvPath, { force: true });
    loadRuntimeEnv();
    delete process.env.SPEAKER_ASR_AUDIO_BASE_URL;
    delete process.env.SPEAKER_ASR_AUDIO_URL_TEMPLATE;

    await waitForReachableHttp(localWebUrl, 10_000, shutdown.signal);
    console.info(`[local-worker] web_ready url=${localWebUrl}`);

    let tunnelOutput = "";
    const captureTunnelOutput = (chunk: Buffer) => {
      tunnelOutput += chunk.toString();
      if (tunnelOutput.length > 20_000) {
        tunnelOutput = tunnelOutput.slice(-20_000);
      }
    };
    tunnel = spawn(resolveCloudflaredCommand(), buildCloudflaredArgs(options), {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    tunnel.stdout?.on("data", captureTunnelOutput);
    tunnel.stderr?.on("data", captureTunnelOutput);

    const publicUrl = await waitForTunnelUrl(tunnel, () => tunnelOutput, shutdown.signal);
    await waitForReachableHttp(publicUrl, 60_000, shutdown.signal);
    await writeLocalAudioTunnelEnv(localAudioTunnelEnvPath, publicUrl);
    process.env.SPEAKER_ASR_AUDIO_BASE_URL = publicUrl;
    console.info(`[local-worker] tunnel_ready host=${new URL(publicUrl).host}`);
    console.info(
      `[local-worker] config_written file=${relative(repoRoot, localAudioTunnelEnvPath)}`
    );

    const { startPipelineWorker } = await import("../src/lib/server/queue/runtime");
    throwIfShutdownRequested(shutdown.signal);
    workerRuntime = await startPipelineWorker();
    throwIfShutdownRequested(shutdown.signal);

    const outcome = await Promise.race([
      workerRuntime.runPromise.then(
        () => ({ kind: "worker_stopped" as const }),
        (error: unknown) => ({ error, kind: "worker_failed" as const })
      ),
      childExit(tunnel).then((result) => ({ kind: "tunnel" as const, result })),
      shutdown.promise.then((signalName) => ({ kind: "signal" as const, signalName }))
    ]);

    if (outcome.kind === "worker_failed") {
      process.exitCode = 1;
      const errorName = outcome.error instanceof Error ? outcome.error.name : "unknown";
      console.error(`[local-worker] worker_runtime_failed error_name=${errorName}`);
    } else if (outcome.kind === "worker_stopped") {
      process.exitCode = 1;
      console.error("[local-worker] worker_stopped_unexpectedly=true");
    } else if (outcome.kind === "tunnel") {
      process.exitCode = 1;
      console.error("[local-worker] tunnel_stopped worker_shutdown_required=true");
    } else {
      console.info(`[local-worker] received ${outcome.signalName}`);
    }
  } catch (error) {
    if (!(error instanceof ShutdownRequestedError)) {
      throw error;
    }
    console.info(`[local-worker] received ${error.signalName}`);
  } finally {
    shutdown.dispose();
    if (workerRuntime) {
      console.info("[local-worker] worker_drain_started second_interrupt_forces_process_exit=true");
    }
    await workerRuntime?.close().catch((error: unknown) => {
      console.error(
        `[local-worker] worker_cleanup_failed error_name=${error instanceof Error ? error.name : "unknown"}`
      );
    });
    await stopTunnel(tunnel).catch((error: unknown) => {
      console.error(
        `[local-worker] tunnel_cleanup_failed error_name=${error instanceof Error ? error.name : "unknown"}`
      );
    });
    delete process.env.SPEAKER_ASR_AUDIO_BASE_URL;
    delete process.env.SPEAKER_ASR_AUDIO_URL_TEMPLATE;
    await rm(localAudioTunnelEnvPath, { force: true }).catch((error: unknown) => {
      console.error(
        `[local-worker] config_cleanup_failed error_name=${error instanceof Error ? error.name : "unknown"}`
      );
    });
    await lock.release().catch((error: unknown) => {
      console.error(
        `[local-worker] lock_cleanup_failed error_name=${error instanceof Error ? error.name : "unknown"}`
      );
    });
    console.info("[local-worker] local_state_cleaned");
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseLocalWorkerArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
    } else {
      await runLocalWorker(options);
    }
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "unknown";
    const errorMessage =
      error instanceof Error ? redactSensitiveOutput(error.message).slice(0, 500) : "unknown";
    console.error(
      `[local-worker] startup_failed error_name=${errorName} error_message=${JSON.stringify(errorMessage)}`
    );
    process.exitCode = 1;
  }
}

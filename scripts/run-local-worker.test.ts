// @vitest-environment node

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCloudflaredArgs,
  localAudioTunnelEnvPath,
  parseCloudflaredTunnelUrl,
  parseLocalWorkerArgs,
  renderLocalAudioTunnelEnv,
  resolveCloudflaredCommand,
  resolveLocalWorkerLeasePath,
  writeLocalAudioTunnelEnv
} from "./run-local-worker";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("local Queue Worker tunnel supervisor", () => {
  it("parses a bounded local port and cloudflared protocol", () => {
    expect(parseLocalWorkerArgs([])).toEqual({ help: false, port: 3200, protocol: "quic" });
    expect(parseLocalWorkerArgs(["--port", "3300", "--protocol", "http2"])).toEqual({
      help: false,
      port: 3300,
      protocol: "http2"
    });
    expect(() => parseLocalWorkerArgs(["--port", "0"])).toThrow("--port");
    expect(() => parseLocalWorkerArgs(["--protocol", "invalid"])).toThrow("--protocol");
  });

  it("extracts only a Cloudflare Quick Tunnel HTTPS URL", () => {
    const output =
      "INF Requesting new quick Tunnel on trycloudflare.com\nhttps://fresh-local-audio.trycloudflare.com\nINF Registered tunnel connection";
    expect(parseCloudflaredTunnelUrl(output)).toBe(
      "https://fresh-local-audio.trycloudflare.com"
    );
    expect(parseCloudflaredTunnelUrl("https://example.com")).toBeNull();
  });

  it("renders a dedicated local file containing only the generated URL", () => {
    const rendered = renderLocalAudioTunnelEnv(
      "https://fresh-local-audio.trycloudflare.com"
    );

    expect(localAudioTunnelEnvPath).toMatch(/\.env\.audio-tunnel\.local$/);
    expect(rendered.match(/SPEAKER_ASR_AUDIO_BASE_URL=/g)).toHaveLength(1);
    expect(rendered).toContain(
      "SPEAKER_ASR_AUDIO_BASE_URL=https://fresh-local-audio.trycloudflare.com"
    );
    expect(rendered).not.toMatch(/^\s*[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET)\s*=/im);
    expect(() => renderLocalAudioTunnelEnv("https://example.com")).toThrow(
      "unexpected public URL"
    );
  });

  it("writes the dedicated config atomically without temporary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "daily-brief-local-tunnel-"));
    temporaryRoots.push(root);
    const filePath = join(root, ".env.audio-tunnel.local");

    await writeLocalAudioTunnelEnv(filePath, "https://fresh-local-audio.trycloudflare.com");

    const stored = await readFile(filePath, "utf8");
    expect(stored).toContain(
      "SPEAKER_ASR_AUDIO_BASE_URL=https://fresh-local-audio.trycloudflare.com"
    );
    expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("uses an explicit cloudflared binary and builds a loopback-only target", () => {
    expect(resolveCloudflaredCommand({ CLOUDFLARED_BIN: "D:\\tools\\cloudflared.exe" })).toBe(
      "D:\\tools\\cloudflared.exe"
    );
    expect(
      buildCloudflaredArgs({ help: false, port: 3200, protocol: "quic" })
    ).toContain("http://127.0.0.1:3200");
  });

  it("uses the configured APP_DATA_DIR for the singleton Worker lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "daily-brief-local-worker-data-"));
    temporaryRoots.push(root);
    expect(resolveLocalWorkerLeasePath({
      PIPELINE_EXECUTION_MODE: "queue",
      APP_DATA_DIR: root,
      APP_STORAGE_MODE: "server",
      REDIS_URL: "redis://127.0.0.1:6381"
    })).toBe(join(root, "local-worker", "worker-local.lock"));
  });

});

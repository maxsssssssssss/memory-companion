import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AUDITED_FIXTURES,
  buildCanonicalPcmWav,
  buildPlaywrightEnvironment,
  buildServerEnvironment,
  createDeterministicLongFixture,
  deriveTranscriptionTarget,
  parsePcm16MonoWav,
  probeWav,
  validateRealSmokeGate
} from "./run-daily-reflection-real-asr-smoke.mjs";

const runnerPath = resolve(process.cwd(), "scripts/run-daily-reflection-real-asr-smoke.mjs");
const require = createRequire(import.meta.url);
const ffprobePath = require("ffprobe-static").path;

function gatedEnvironment(overrides = {}) {
  return {
    RUN_REAL_ASR_SMOKE: "1",
    TRANSCRIPTION_PROVIDER: "openai",
    TRANSCRIPTION_FALLBACK_PROVIDER: "none",
    OPENAI_MAX_RETRIES: "0",
    OPENAI_TRANSCRIBE_BASE_URL: "https://transcribe.example.test/v1",
    OPENAI_TRANSCRIBE_API_KEY: "dedicated-test-key",
    ...overrides
  };
}

describe("Daily Reflection real ASR smoke gate", () => {
  it("requires both authorizations and the dedicated key before creating a data directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "dr31-gate-off-"));
    try {
      const missingRemote = spawnSync(process.execPath, [runnerPath], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, ...gatedEnvironment() },
        windowsHide: true
      });
      expect(missingRemote.status).toBe(1);
      expect(missingRemote.stderr).toContain("real_asr_smoke_remote_flag_required");

      const missingEnvironmentGate = spawnSync(process.execPath, [runnerPath, "--remote"], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, ...gatedEnvironment({ RUN_REAL_ASR_SMOKE: "" }) },
        windowsHide: true
      });
      expect(missingEnvironmentGate.status).toBe(1);
      expect(missingEnvironmentGate.stderr).toContain("real_asr_smoke_environment_gate_required");

      const missingDedicatedKey = spawnSync(process.execPath, [runnerPath, "--remote"], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          ...gatedEnvironment({
            OPENAI_TRANSCRIBE_API_KEY: "",
            OPENAI_API_KEY: "generic-must-not-be-used",
            OPENAI_BASE_URL: "https://generic.example.test/v1"
          })
        },
        windowsHide: true
      });
      expect(missingDedicatedKey.status).toBe(1);
      expect(missingDedicatedKey.stderr).toContain("dedicated_transcription_api_key_required");
      await expect(stat(join(root, ".data"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes adapter-compatible base URL variants to one exact path", () => {
    for (const value of [
      "https://transcribe.example.test",
      "https://transcribe.example.test/",
      "https://transcribe.example.test/v1",
      "https://transcribe.example.test/v1/v1",
      "https://transcribe.example.test/v1/audio/transcriptions"
    ]) {
      expect(deriveTranscriptionTarget(value)).toMatchObject({
        allowedOrigin: "https://transcribe.example.test",
        allowedPath: "/v1/audio/transcriptions"
      });
    }
  });

  it("passes only dedicated transcription routing to Next and clears every key from Playwright", () => {
    const gate = validateRealSmokeGate(["--remote"], gatedEnvironment());
    const server = buildServerEnvironment({
      baseEnvironment: {
        OPENAI_API_KEY: "generic-key",
        OPENAI_BASE_URL: "https://generic.example.test/v1"
      },
      gate,
      appDataDir: "C:/tmp/dr31/app-data",
      inviteCode: "invite",
      networkGuardPath: "C:/tmp/guard.cjs",
      networkAuditPath: "C:/tmp/network.jsonl",
      submitBudgetDir: "C:/tmp/budget"
    });
    expect(server).toMatchObject({
      OPENAI_TRANSCRIBE_API_KEY: "dedicated-test-key",
      OPENAI_TRANSCRIBE_BASE_URL: "https://transcribe.example.test/v1",
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      TRANSCRIPTION_PROVIDER: "openai",
      TRANSCRIPTION_FALLBACK_PROVIDER: "none",
      OPENAI_MAX_RETRIES: "0",
      DR_REAL_ASR_NETWORK_GUARD_MODE: "server",
      DR_REAL_ASR_MAX_SUBMITS: "2"
    });
    const browser = buildPlaywrightEnvironment(server, {
      networkGuardPath: "C:/tmp/guard.cjs",
      baseUrl: "http://127.0.0.1:4123",
      runtimeArtifactDir: "C:/tmp/runtime",
      appDataDir: "C:/tmp/dr31/app-data",
      shortFixturePath: "C:/tmp/short.wav",
      longFixturePath: "C:/tmp/long.wav",
      scenarioResultPath: "C:/tmp/result.json",
      networkAuditPath: "C:/tmp/network.jsonl",
      inviteCode: "invite"
    });
    expect(browser).toMatchObject({
      OPENAI_TRANSCRIBE_API_KEY: "",
      OPENAI_TRANSCRIBE_BASE_URL: "",
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      DR_REAL_ASR_NETWORK_GUARD_MODE: "loopback_only"
    });
  });
});

describe("Daily Reflection deterministic long fixture", () => {
  it("builds canonical PCM WAV data and repeats only audited synthetic audio", async () => {
    const root = await mkdtemp(join(tmpdir(), "dr31-wav-"));
    try {
      const paths = [];
      for (let index = 0; index < 3; index += 1) {
        const samples = Buffer.alloc((index + 1) * 2_000, 32 + index);
        const filePath = join(root, `input-${index}.wav`);
        await writeFile(filePath, buildCanonicalPcmWav(samples));
        paths.push(filePath);
        expect(parsePcm16MonoWav(await readFile(filePath)).samples).toBe((index + 1) * 1_000);
      }
      const outputPath = join(root, "long.wav");
      const result = await createDeterministicLongFixture({
        inputPaths: paths,
        outputPath,
        targetSeconds: 1,
        ffprobeExecutable: ffprobePath
      });
      expect(result.media).toMatchObject({
        durationSeconds: 1,
        durationSamples: 22_050,
        codec: "pcm_s16le",
        channels: 1,
        sampleRate: 22_050
      });
      expect(probeWav(outputPath, ffprobePath).durationSamples).toBe(22_050);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the committed fixture contract free of transcript bodies and secrets", () => {
    const serialized = JSON.stringify(AUDITED_FIXTURES);
    expect(serialized).not.toMatch(/(?:transcript|api[_-]?key|authorization|password|text)/iu);
    expect(AUDITED_FIXTURES).toHaveLength(3);
  });
});

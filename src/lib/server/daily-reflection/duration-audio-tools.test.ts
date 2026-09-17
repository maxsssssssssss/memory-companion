// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getFfmpegExecutable, getFfprobeExecutable } from "@/lib/server/ffmpeg";
import { planAudioChunks, cleanupGeneratedAudioChunks } from "@/lib/server/transcription/chunks/audio-planner";
import { resolveDailyReflectionAuthoritativeDuration } from "./duration-resolver";
import type { DurationToolDiagnostic } from "./duration-audio-tools";

const exec = promisify(execFile);
let root: string;
const paths: Record<string, string> = {};
async function generate(name: string, args: string[]) {
  const path = join(root, name);
  await exec(getFfmpegExecutable(), ["-nostdin", "-hide_banner", "-v", "error", "-y", ...args, path], { timeout: 20_000, windowsHide: true });
  paths[name] = path;
  return path;
}
async function resolve(name: string, extra: Parameters<typeof resolveDailyReflectionAuthoritativeDuration>[0] extends infer T ? Partial<T> : never = {}) {
  return resolveDailyReflectionAuthoritativeDuration({ filePath: paths[name]!, inputMethod: "browser_recording", ...extra });
}

it.each([
  ["normal.wav", 2000, "server_ffprobe"],
  ["live-21.webm", 21, "server_ffmpeg_decode"]
] as const)("measures audio beyond the Windows input path limit (%s)", async (name, milliseconds, source) => {
  const directory = join(root, "a".repeat(70), "b".repeat(70), "c".repeat(70));
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, name);
  expect(filePath.length).toBeGreaterThan(260);
  const original = await readFile(paths[name]);
  await writeFile(filePath, original);
  await expect(resolveDailyReflectionAuthoritativeDuration({ filePath, inputMethod: "browser_recording" }))
    .resolves.toMatchObject({ effectiveDurationMs: milliseconds, durationSource: source });
  expect(await readFile(filePath)).toEqual(original);
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "reflection-duration-tools-"));
  await generate("normal.wav", ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2", "-c:a", "pcm_s16le"]);
  for (const ms of [21, 179999, 180000, 180001]) {
    await generate(`live-${ms}.webm`, ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", String(ms / 1000), "-c:a", "libopus", "-f", "webm", "-live", "1"]);
  }
  await generate("metadata.webm", ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "12", "-c:a", "libopus"]);
  for (const name of ["metadata.webm", "live-180001.webm"]) {
    const bytes = await readFile(paths[name]);
    paths[`truncated-${name}`] = join(root, `truncated-${name}`);
    await writeFile(paths[`truncated-${name}`], bytes.subarray(0, Math.floor(bytes.length * 0.7)));
  }
  await generate("mixed.webm", ["-f", "lavfi", "-i", "color=black:s=16x16:r=1:d=4", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-c:v", "libvpx", "-c:a", "libopus"]);
  await generate("two-audio.webm", ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=4", "-map", "0:a", "-map", "1:a", "-c:a", "libopus"]);
  await generate("video-only.webm", ["-f", "lavfi", "-i", "color=black:s=16x16:r=1:d=1", "-c:v", "libvpx"]);
}, 60_000);
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("authoritative duration with real local tools", () => {
  it("uses one bounded packet probe for valid audio metadata and does not decode PCM", async () => {
    const diagnostics: DurationToolDiagnostic[] = [];
    await expect(resolve("normal.wav", { clientReportedDurationMs: 999999, onDiagnostic: (event) => diagnostics.push(event) }))
      .resolves.toMatchObject({ effectiveDurationMs: 2000, durationSource: "server_ffprobe", clientReportedDurationMs: 999999 });
    expect(diagnostics.map((event) => event.stage)).toEqual(["probe"]);
    expect(JSON.stringify(diagnostics)).not.toContain(root);
  });

  it.each([21, 179999, 180000, 180001])("decodes live WebM %i ms without ffprobe duration or Opus padding drift", async (ms) => {
    const before = await readFile(paths[`live-${ms}.webm`]);
    const { stdout } = await exec(getFfprobeExecutable(), ["-v", "error", "-show_entries", "format=duration", "-of", "json", paths[`live-${ms}.webm`]]);
    expect(JSON.parse(stdout).format?.duration).toBeUndefined();
    await expect(resolve(`live-${ms}.webm`)).resolves.toMatchObject({
      effectiveDurationMs: ms, durationSource: "server_ffmpeg_decode",
      processingProfile: ms <= 180000 ? "quick_reflection" : "full_recording"
    });
    expect(await readFile(paths[`live-${ms}.webm`])).toEqual(before);
  });

  it.each(["truncated-metadata.webm", "truncated-live-180001.webm"])("rejects %s even when header metadata or tool exit alone appears valid", async (name) => {
    await expect(resolve(name)).rejects.toMatchObject({ code: "daily_reflection_audio_invalid", retryable: false });
  });

  it.each(["mixed.webm", "two-audio.webm"])("measures and transcribes the same first audio track of %s", async (name) => {
    const duration = await resolve(name);
    expect(duration).toMatchObject({ effectiveDurationMs: 2000, requiresAudioExtraction: true, durationSource: "server_ffmpeg_decode" });
    const probe = vi.fn(async () => { throw new Error("must not re-probe format duration"); });
    const chunks = await planAudioChunks({ uploadId: `synthetic-${name}`, filePath: paths[name], mimeType: "audio/webm", authoritativeAudio: {
      uploadId: `synthetic-${name}`, effectiveDurationMs: duration.effectiveDurationMs, extractFirstAudioTrack: true
    } }, { probeDurationSeconds: probe });
    try {
      expect(probe).not.toHaveBeenCalled();
      expect(chunks).toHaveLength(1);
      expect(chunks[0].source.type).toBe("generated_chunk");
      expect(chunks[0].durationSeconds).toBe(2);
      const { stdout } = await exec(getFfprobeExecutable(), ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", chunks[0].source.path!]);
      const metadata = JSON.parse(stdout);
      expect(metadata.streams).toEqual([{ codec_type: "audio" }]);
      expect(Number(metadata.format.duration)).toBeGreaterThanOrEqual(2);
      expect(Number(metadata.format.duration)).toBeLessThan(2.2);
    } finally { await cleanupGeneratedAudioChunks(chunks); }
  });

  it("retains a single pure audio file and bypasses a failing second probe", async () => {
    const probe = vi.fn(async () => { throw new Error("unexpected re-probe"); });
    const split = vi.fn(async () => []);
    const chunks = await planAudioChunks({ uploadId: "one", filePath: paths["normal.wav"], mimeType: "audio/wav", authoritativeAudio: {
      uploadId: "one", effectiveDurationMs: 2000, extractFirstAudioTrack: false
    } }, { probeDurationSeconds: probe, splitAudio: split });
    expect(chunks[0].source).toEqual({ type: "uploaded_audio", path: paths["normal.wav"] });
    expect(probe).not.toHaveBeenCalled();
    expect(split).not.toHaveBeenCalled();
  });

  it("distinguishes no audio and unavailable tools", async () => {
    await expect(resolve("video-only.webm")).rejects.toMatchObject({ code: "daily_reflection_audio_no_track", retryable: false });
    vi.stubEnv("FFPROBE_PATH", join(root, "absent-tool.exe"));
    await expect(resolve("normal.wav")).rejects.toMatchObject({ code: "daily_reflection_duration_tool_unavailable", retryable: true });
  });

  it("bounds probe and decode against the combined remaining budget", async () => {
    await expect(resolve("normal.wav", { budgetMs: 0 })).rejects.toMatchObject({ code: "daily_reflection_duration_probe_timeout" });
    let clock = 1000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      await expect(resolve("live-180000.webm", { budgetMs: 10000, onDiagnostic: () => { clock += 11000; } }))
        .rejects.toMatchObject({ code: "daily_reflection_duration_decode_timeout" });
    } finally { now.mockRestore(); }
  });

  it("stops decode on abort and rejects a lost fence before publication", async () => {
    const controller = new AbortController();
    await expect(resolve("live-180000.webm", { signal: controller.signal, onDiagnostic: () => controller.abort() }))
      .rejects.toMatchObject({ code: "daily_reflection_upload_interrupted", retryable: true });
    let lost = false;
    const leaseError = new Error("synthetic_lease_lost");
    await expect(resolve("live-180000.webm", {
      onDiagnostic: () => { lost = true; },
      assertWritable: () => { if (lost) throw leaseError; }
    })).rejects.toBe(leaseError);
  });
});

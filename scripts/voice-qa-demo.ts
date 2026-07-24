import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT,
  getPcm16DurationMs,
  wrapPcm16LeAsWav
} from "@/lib/server/voice/audio";
import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";
import { getUserScopedStore } from "@/lib/server/auth/session";
import { createVoiceProvider } from "@/lib/server/voice/provider";
import type { VoiceProvider } from "@/lib/server/voice/types";
import { createMemoryVoiceQaAnswerer } from "@/lib/server/voice-qa/adapter";
import { VoiceQaBridge } from "@/lib/server/voice-qa/bridge";
import type { VoiceQaAnswerer } from "@/lib/server/voice-qa/types";

export type VoiceQaDemoCliOptions = {
  text: string;
  userId: string;
  scope: "current" | "week" | "all";
  uploadId?: string;
  referenceDate?: Date;
  outputDir: string;
};

export type VoiceQaDemoCliDependencies = {
  provider?: VoiceProvider;
  answerer?: VoiceQaAnswerer;
  stdout?: Pick<NodeJS.WriteStream, "write">;
};

const SAFE_STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/u;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function requiredValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1];
  if (!value?.trim() || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value.trim();
}

function parseReferenceDate(value: string) {
  if (!DATE_KEY_PATTERN.test(value)) {
    throw new Error("--reference-date must use YYYY-MM-DD");
  }
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("--reference-date must be a valid date");
  }
  return parsed;
}

export function parseVoiceQaDemoArgs(
  argv: string[],
  environment: Readonly<Record<string, string | undefined>> = process.env
): VoiceQaDemoCliOptions {
  let text: string | undefined;
  let userId: string | undefined;
  let scope: VoiceQaDemoCliOptions["scope"] = "all";
  let uploadId: string | undefined;
  let referenceDate: Date | undefined;
  let outputDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--text", "--user-id", "--scope", "--upload-id", "--reference-date", "--output-dir"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = requiredValue(argv, index, argument);
    index += 1;
    if (argument === "--text") text = value;
    else if (argument === "--user-id") userId = value;
    else if (argument === "--upload-id") uploadId = value;
    else if (argument === "--output-dir") outputDir = value;
    else if (argument === "--reference-date") referenceDate = parseReferenceDate(value);
    else if (value === "current" || value === "week" || value === "all") scope = value;
    else throw new Error("--scope must be current, week, or all");
  }

  if (!text) throw new Error("--text is required");
  if (!userId) throw new Error("--user-id is required");
  if (!SAFE_STORE_KEY_PATTERN.test(userId)) throw new Error("--user-id is invalid");
  if (uploadId && !SAFE_STORE_KEY_PATTERN.test(uploadId)) throw new Error("--upload-id is invalid");
  if (scope === "current" && !uploadId) {
    throw new Error("--upload-id is required when --scope current");
  }
  if (scope !== "week" && referenceDate) {
    throw new Error("--reference-date is only supported with --scope week");
  }

  const dataRoot = environment.APP_DATA_DIR?.trim() || ".data";
  return {
    text,
    userId,
    scope,
    ...(uploadId ? { uploadId } : {}),
    ...(referenceDate ? { referenceDate } : {}),
    outputDir: resolve(outputDir || dataRoot, outputDir ? "" : "voice-qa-demo")
  };
}

export async function runVoiceQaDemoCli(
  argv: string[],
  dependencies: VoiceQaDemoCliDependencies = {}
) {
  const options = parseVoiceQaDemoArgs(argv);
  const provider = dependencies.provider ?? createVoiceProvider();
  const answerer = dependencies.answerer ?? createMemoryVoiceQaAnswerer({
    userId: options.userId,
    store: getUserScopedStore(options.userId),
    scope: options.scope,
    ...(options.uploadId ? { uploadId: options.uploadId } : {}),
    ...(options.referenceDate ? { referenceDate: options.referenceDate } : {})
  });
  const bridge = new VoiceQaBridge({
    provider,
    answerer,
    userId: options.userId,
    scope: options.scope,
    ...(options.uploadId ? { uploadId: options.uploadId } : {}),
    responseMode: "VOICE",
    sessionConfig: {
      inputMode: "text",
      audioOutput: {
        format: "pcm_s16le",
        sampleRate: DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT.sampleRate,
        channels: DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT.channels
      }
    }
  });

  let response;
  await bridge.start();
  try {
    response = await bridge.submitTextQuery(options.text);
  } finally {
    await bridge.close();
  }

  await mkdir(options.outputDir, { recursive: true });
  const responsePath = resolve(options.outputDir, "response.wav");
  let wavSizeBytes = 0;
  let audioDurationMs = 0;
  if (response.audio) {
    const wav = wrapPcm16LeAsWav(response.audio, DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT);
    await writeFile(responsePath, wav);
    wavSizeBytes = wav.byteLength;
    audioDurationMs = Math.round(getPcm16DurationMs(
      response.audio,
      DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT
    ));
  }

  const snapshot = bridge.snapshot();
  const sessionPath = resolve(options.outputDir, "session.json");
  const sessionReport = {
    version: 1,
    sessionId: response.sessionId,
    state: snapshot.state,
    history: snapshot.history,
    scope: options.scope,
    ...(options.uploadId ? { uploadId: options.uploadId } : {}),
    transcriptChars: options.text.length,
    responseChars: response.text.length,
    answerId: response.answer?.id,
    citedSegmentIds: response.answer?.citedSegmentIds ?? [],
    citationCount: response.answer?.citations?.length ?? 0,
    errors: response.errors ?? [],
    audioSizeBytes: wavSizeBytes,
    audioDurationMs,
    ...(response.audio ? { responsePath } : {})
  };
  await writeFile(sessionPath, `${JSON.stringify(sessionReport, null, 2)}\n`, "utf8");

  const report = {
    sessionId: response.sessionId,
    state: snapshot.state,
    scope: options.scope,
    sessionPath,
    ...(response.audio ? { responsePath } : {}),
    audioSizeBytes: wavSizeBytes,
    audioDurationMs,
    citedSegmentCount: response.answer?.citedSegmentIds.length ?? 0,
    errors: response.errors ?? []
  };
  (dependencies.stdout ?? process.stdout).write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  loadRuntimeEnv();
  try {
    await runVoiceQaDemoCli(process.argv.slice(2));
  } catch (error) {
    console.error(
      `[voice-qa-demo] failed error_name=${error instanceof Error ? error.name : "unknown"} ` +
      `error_message=${JSON.stringify(error instanceof Error ? error.message : "unknown")}`
    );
    process.exitCode = 1;
  }
}

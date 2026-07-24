import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT,
  getPcm16DurationMs,
  wrapPcm16LeAsWav
} from "@/lib/server/voice/audio";
import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";
import { createVoiceProvider } from "@/lib/server/voice/provider";
import { synthesizeVoiceText } from "@/lib/server/voice/session";
import type { VoiceProvider } from "@/lib/server/voice/types";

export type VoiceDemoCliOptions = {
  text: string;
  outputPath: string;
};

export type VoiceDemoCliDependencies = {
  provider?: VoiceProvider;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  now?: () => number;
};

function requiredValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1];
  if (!value?.trim() || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseVoiceDemoArgs(
  argv: string[],
  environment: Readonly<Record<string, string | undefined>> = process.env
): VoiceDemoCliOptions {
  let text: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--text" && argument !== "--output") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = requiredValue(argv, index, argument);
    index += 1;
    if (argument === "--text") text = value;
    else outputPath = value;
  }
  if (!text?.trim()) {
    throw new Error("--text is required");
  }
  const dataRoot = environment.APP_DATA_DIR?.trim() || ".data";
  const resolvedOutput = resolve(outputPath?.trim() || dataRoot, outputPath ? "" : "voice-demo/output.wav");
  if (extname(resolvedOutput).toLowerCase() !== ".wav") {
    throw new Error("--output must use a .wav extension because the demo writes PCM16 WAV audio");
  }
  return { text, outputPath: resolvedOutput };
}

export async function runVoiceDemoCli(
  argv: string[],
  dependencies: VoiceDemoCliDependencies = {}
) {
  const options = parseVoiceDemoArgs(argv);
  const provider = dependencies.provider ?? createVoiceProvider();
  const result = await synthesizeVoiceText(options.text, {
    provider,
    sessionConfig: {
      inputMode: "text",
      audioOutput: {
        format: "pcm_s16le",
        sampleRate: DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT.sampleRate,
        channels: DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT.channels
      }
    },
    now: dependencies.now
  });
  const wav = wrapPcm16LeAsWav(result.audio, DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT);
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, wav);

  const report = {
    outputPath: options.outputPath,
    sessionId: result.sessionId,
    connectLatencyMs: result.connectLatencyMs,
    ttsLatencyMs: result.ttsLatencyMs,
    audioDurationMs: Math.round(getPcm16DurationMs(
      result.audio,
      DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT
    )),
    outputSizeBytes: wav.byteLength
  };
  (dependencies.stdout ?? process.stdout).write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  loadRuntimeEnv();
  try {
    await runVoiceDemoCli(process.argv.slice(2));
  } catch (error) {
    console.error(
      `[voice-demo] failed error_name=${error instanceof Error ? error.name : "unknown"} ` +
      `error_message=${JSON.stringify(error instanceof Error ? error.message : "unknown")}`
    );
    process.exitCode = 1;
  }
}

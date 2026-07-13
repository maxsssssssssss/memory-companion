import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AudioInsight, AudioUpload } from "@/lib/domain/types";
import { openaiAudioInsightProvider } from "@/lib/server/audio-insights/openai-provider";
import { JsonStore } from "@/lib/server/storage/json-store";

import { processUpload } from "./process-upload";

const { extractFfmpegAcousticFeaturesMock } = vi.hoisted(() => ({
  extractFfmpegAcousticFeaturesMock: vi.fn()
}));

vi.mock("@/lib/server/audio-features/ffmpeg-acoustic-features", () => ({
  extractFfmpegAcousticFeatures: extractFfmpegAcousticFeaturesMock
}));

let tempDir: string | undefined;

function restoreEnv(key: "TRANSCRIPTION_PROVIDER" | "EXTRACTION_PROVIDER" | "AUDIO_INSIGHT_PROVIDER" | "AUDIO_INSIGHT_FALLBACK_PROVIDER" | "EMOTION_SIGNAL_PROVIDER", value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  extractFfmpegAcousticFeaturesMock.mockReset();
});

describe("processUpload emotion signal provider integration", () => {
  it("does not inject rule emotion evidence by default when audio insights come from OpenAI", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-emotion-provider-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    extractFfmpegAcousticFeaturesMock.mockResolvedValue([]);
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const originalAudioInsightProvider = process.env.AUDIO_INSIGHT_PROVIDER;
    const originalAudioInsightFallbackProvider = process.env.AUDIO_INSIGHT_FALLBACK_PROVIDER;
    const originalEmotionSignalProvider = process.env.EMOTION_SIGNAL_PROVIDER;
    const openaiAnalyze = vi.spyOn(openaiAudioInsightProvider, "analyze").mockResolvedValue([
      {
        id: "openai_insight_neutral",
        uploadId: "upload_openai_default_emotion",
        sourceSegmentIds: ["seg_risk_1"],
        sourceTimeRange: { startSeconds: 5400, endSeconds: 5520 },
        speaker: { id: "speaker_2", role: "other", confidence: 0.72 },
        voice: { pace: "normal", volume: "unknown", pause: "unknown", overlap: false, confidence: 0.5 },
        toneLabels: ["unknown"],
        emotionLabels: ["neutral"],
        interactionLabels: ["unknown"],
        summary: "OpenAI provider returned a neutral interaction signal.",
        evidence: "The model did not identify a strong atmosphere signal.",
        confidence: 0.82
      }
    ]);

    const upload: AudioUpload = {
      id: "upload_openai_default_emotion",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-06-03",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      process.env.AUDIO_INSIGHT_PROVIDER = "openai";
      process.env.AUDIO_INSIGHT_FALLBACK_PROVIDER = "none";
      delete process.env.EMOTION_SIGNAL_PROVIDER;
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({ uploadId: upload.id, store });
      const storedAudioInsights = await store.read<AudioInsight[]>("audio-insights", upload.id);

      expect(openaiAudioInsightProvider.analyze).toHaveBeenCalledTimes(1);
      expect(result.audioInsights[0]).toMatchObject({
        id: "openai_insight_neutral",
        atmosphereLabels: ["unknown"],
        emotionEvidence: []
      });
      expect(storedAudioInsights?.[0]).toMatchObject({
        id: "openai_insight_neutral",
        atmosphereLabels: ["unknown"],
        emotionEvidence: []
      });
    } finally {
      openaiAnalyze.mockRestore();
      restoreEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
      restoreEnv("AUDIO_INSIGHT_PROVIDER", originalAudioInsightProvider);
      restoreEnv("AUDIO_INSIGHT_FALLBACK_PROVIDER", originalAudioInsightFallbackProvider);
      restoreEnv("EMOTION_SIGNAL_PROVIDER", originalEmotionSignalProvider);
    }
  });
});

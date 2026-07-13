import { describe, expect, it, vi } from "vitest";

import { classifySegment } from "@/lib/processing/classifier";
import { sampleTranscriptSegments } from "@/lib/processing/sample-transcript";

import { deepseekAudioInsightProvider } from "./deepseek-provider";
import { openaiAudioInsightProvider } from "./openai-provider";
import { getAudioInsightProvider } from "./provider";
import { ruleAudioInsightProvider } from "./rule-provider";

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("audio insight providers", () => {
  it("uses the rule provider by default", async () => {
    const originalProvider = process.env.AUDIO_INSIGHT_PROVIDER;
    delete process.env.AUDIO_INSIGHT_PROVIDER;

    try {
      const provider = getAudioInsightProvider();
      const insights = await provider.analyze("upload_test", sampleTranscriptSegments.map(classifySegment));

      expect(provider).toBe(ruleAudioInsightProvider);
      expect(insights.length).toBeGreaterThan(0);
      expect(insights.every((insight) => insight.uploadId === "upload_test")).toBe(true);
    } finally {
      if (originalProvider === undefined) {
        delete process.env.AUDIO_INSIGHT_PROVIDER;
      } else {
        process.env.AUDIO_INSIGHT_PROVIDER = originalProvider;
      }
    }
  });

  it("selects openai provider with rule fallback for known env values", () => {
    const originalProvider = process.env.AUDIO_INSIGHT_PROVIDER;

    try {
      process.env.AUDIO_INSIGHT_PROVIDER = "rule";
      expect(getAudioInsightProvider()).toBe(ruleAudioInsightProvider);

      process.env.AUDIO_INSIGHT_PROVIDER = "openai";
      expect(getAudioInsightProvider()).not.toBe(openaiAudioInsightProvider);
    } finally {
      if (originalProvider === undefined) {
        delete process.env.AUDIO_INSIGHT_PROVIDER;
      } else {
        process.env.AUDIO_INSIGHT_PROVIDER = originalProvider;
      }
    }
  });

  it("falls back to rule insights when openai analysis fails", async () => {
    const originalProvider = process.env.AUDIO_INSIGHT_PROVIDER;
    const originalFallbackProvider = process.env.AUDIO_INSIGHT_FALLBACK_PROVIDER;
    const openaiAnalyze = vi.spyOn(openaiAudioInsightProvider, "analyze").mockRejectedValue(new Error("model unavailable"));

    try {
      process.env.AUDIO_INSIGHT_PROVIDER = "openai";
      process.env.AUDIO_INSIGHT_FALLBACK_PROVIDER = "rule";
      const provider = getAudioInsightProvider();
      const insights = await provider.analyze("upload_test", sampleTranscriptSegments.map(classifySegment));

      expect(openaiAudioInsightProvider.analyze).toHaveBeenCalledTimes(1);
      expect(insights.length).toBeGreaterThan(0);
      expect(insights.every((insight) => insight.sourceSegmentIds.length > 0)).toBe(true);
    } finally {
      openaiAnalyze.mockRestore();
      if (originalProvider === undefined) {
        delete process.env.AUDIO_INSIGHT_PROVIDER;
      } else {
        process.env.AUDIO_INSIGHT_PROVIDER = originalProvider;
      }
      if (originalFallbackProvider === undefined) {
        delete process.env.AUDIO_INSIGHT_FALLBACK_PROVIDER;
      } else {
        process.env.AUDIO_INSIGHT_FALLBACK_PROVIDER = originalFallbackProvider;
      }
    }
  });

  it("falls back to rule insights when openai returns no valid insights", async () => {
    const originalProvider = process.env.AUDIO_INSIGHT_PROVIDER;
    const originalFallbackProvider = process.env.AUDIO_INSIGHT_FALLBACK_PROVIDER;
    const openaiAnalyze = vi.spyOn(openaiAudioInsightProvider, "analyze").mockResolvedValue([]);

    try {
      process.env.AUDIO_INSIGHT_PROVIDER = "openai";
      process.env.AUDIO_INSIGHT_FALLBACK_PROVIDER = "rule";
      const provider = getAudioInsightProvider();
      const insights = await provider.analyze("upload_test", sampleTranscriptSegments.map(classifySegment));

      expect(openaiAudioInsightProvider.analyze).toHaveBeenCalledTimes(1);
      expect(insights.length).toBeGreaterThan(0);
      expect(insights.every((insight) => insight.sourceSegmentIds.length > 0)).toBe(true);
    } finally {
      openaiAnalyze.mockRestore();
      if (originalProvider === undefined) {
        delete process.env.AUDIO_INSIGHT_PROVIDER;
      } else {
        process.env.AUDIO_INSIGHT_PROVIDER = originalProvider;
      }
      if (originalFallbackProvider === undefined) {
        delete process.env.AUDIO_INSIGHT_FALLBACK_PROVIDER;
      } else {
        process.env.AUDIO_INSIGHT_FALLBACK_PROVIDER = originalFallbackProvider;
      }
    }
  });

  it("selects DeepSeek and falls back to rule insights when its single request fails", async () => {
    const originalProvider = process.env.AUDIO_INSIGHT_PROVIDER;
    const originalFallbackProvider = process.env.AUDIO_INSIGHT_FALLBACK_PROVIDER;
    const deepseekAnalyze = vi
      .spyOn(deepseekAudioInsightProvider, "analyze")
      .mockRejectedValue(new Error("timeout"));

    try {
      process.env.AUDIO_INSIGHT_PROVIDER = "deepseek";
      process.env.AUDIO_INSIGHT_FALLBACK_PROVIDER = "rule";
      const provider = getAudioInsightProvider();
      const insights = await provider.analyze(
        "upload_test",
        sampleTranscriptSegments.map(classifySegment)
      );

      expect(deepseekAudioInsightProvider.analyze).toHaveBeenCalledTimes(1);
      expect(insights.length).toBeGreaterThan(0);
      expect(insights.every((insight) => insight.sourceSegmentIds.length > 0)).toBe(true);
    } finally {
      deepseekAnalyze.mockRestore();
      restoreEnv("AUDIO_INSIGHT_PROVIDER", originalProvider);
      restoreEnv("AUDIO_INSIGHT_FALLBACK_PROVIDER", originalFallbackProvider);
    }
  });
});

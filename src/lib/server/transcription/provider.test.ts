import { describe, expect, it, vi } from "vitest";
import { fixtureTranscriptionProvider } from "./fixture-provider";
import { openaiTranscriptionProvider } from "./openai-provider";
import { getTranscriptionProvider } from "./provider";
import { speakerAsrTranscriptionProvider } from "./speaker-asr-provider";

describe("transcription providers", () => {
  it("uses the fixture provider by default", async () => {
    const originalProvider = process.env.TRANSCRIPTION_PROVIDER;
    delete process.env.TRANSCRIPTION_PROVIDER;

    try {
      const provider = getTranscriptionProvider();
      const segments = await provider.transcribe({
        uploadId: "upload_test",
        filePath: "/tmp/audio.m4a",
        mimeType: "audio/mp4"
      });

      expect(segments.length).toBeGreaterThan(0);
      expect(segments.every((segment) => segment.uploadId === "upload_test")).toBe(true);
      expect(segments.some((segment) => segment.valueLabels.length > 0)).toBe(true);
    } finally {
      if (originalProvider === undefined) {
        delete process.env.TRANSCRIPTION_PROVIDER;
      } else {
        process.env.TRANSCRIPTION_PROVIDER = originalProvider;
      }
    }
  });

  it("selects fixture, OpenAI, and speaker-asr providers for known env values", () => {
    const originalProvider = process.env.TRANSCRIPTION_PROVIDER;

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      expect(getTranscriptionProvider()).toBe(fixtureTranscriptionProvider);

      process.env.TRANSCRIPTION_PROVIDER = "openai";
      expect(getTranscriptionProvider()).not.toBe(openaiTranscriptionProvider);

      process.env.TRANSCRIPTION_PROVIDER = "speaker-asr";
      expect(getTranscriptionProvider()).not.toBe(speakerAsrTranscriptionProvider);
    } finally {
      if (originalProvider === undefined) {
        delete process.env.TRANSCRIPTION_PROVIDER;
      } else {
        process.env.TRANSCRIPTION_PROVIDER = originalProvider;
      }
    }
  });

  it("throws for unknown transcription providers", () => {
    const originalProvider = process.env.TRANSCRIPTION_PROVIDER;

    try {
      process.env.TRANSCRIPTION_PROVIDER = "bogus";
      expect(() => getTranscriptionProvider()).toThrow("Unknown transcription provider: bogus");
    } finally {
      if (originalProvider === undefined) {
        delete process.env.TRANSCRIPTION_PROVIDER;
      } else {
        process.env.TRANSCRIPTION_PROVIDER = originalProvider;
      }
    }
  });

  it("falls back to fixture when OpenAI transcription fails", async () => {
    const originalProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalFallbackProvider = process.env.TRANSCRIPTION_FALLBACK_PROVIDER;
    const openaiTranscribe = vi
      .spyOn(openaiTranscriptionProvider, "transcribe")
      .mockRejectedValue(new Error("OpenAI transcription error"));

    try {
      process.env.TRANSCRIPTION_PROVIDER = "openai";
      process.env.TRANSCRIPTION_FALLBACK_PROVIDER = "fixture";
      const provider = getTranscriptionProvider();

      const segments = await provider.transcribe({
        uploadId: "upload_test",
        filePath: "/tmp/audio.m4a",
        mimeType: "audio/mp4"
      });

      expect(openaiTranscriptionProvider.transcribe).toHaveBeenCalledTimes(1);
      expect(segments.length).toBeGreaterThan(0);
      expect(segments.every((segment) => segment.uploadId === "upload_test")).toBe(true);
      expect(segments.some((segment) => segment.valueLabels.length > 0)).toBe(true);
    } finally {
      openaiTranscribe.mockRestore();
      if (originalProvider === undefined) {
        delete process.env.TRANSCRIPTION_PROVIDER;
      } else {
        process.env.TRANSCRIPTION_PROVIDER = originalProvider;
      }
      if (originalFallbackProvider === undefined) {
        delete process.env.TRANSCRIPTION_FALLBACK_PROVIDER;
      } else {
        process.env.TRANSCRIPTION_FALLBACK_PROVIDER = originalFallbackProvider;
      }
    }
  });
});

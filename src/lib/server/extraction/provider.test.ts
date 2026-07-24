import { describe, expect, it, vi } from "vitest";
import { classifySegment } from "@/lib/processing/classifier";
import { sampleTranscriptSegments } from "@/lib/processing/sample-transcript";
import { openaiExtractionProvider } from "./openai-provider";
import { getExtractionProvider } from "./provider";
import { ruleExtractionProvider } from "./rule-provider";

describe("extraction providers", () => {
  it("uses the rule provider by default", async () => {
    const originalProvider = process.env.EXTRACTION_PROVIDER;
    delete process.env.EXTRACTION_PROVIDER;

    try {
      const provider = getExtractionProvider();
      const items = await provider.extract("upload_test", sampleTranscriptSegments.map(classifySegment));

      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item) => item.uploadId === "upload_test")).toBe(true);
      expect(items.every((item) => item.sourceSegmentIds.length > 0)).toBe(true);
    } finally {
      if (originalProvider === undefined) {
        delete process.env.EXTRACTION_PROVIDER;
      } else {
        process.env.EXTRACTION_PROVIDER = originalProvider;
      }
    }
  });

  it("selects rule and OpenAI providers for known env values", () => {
    const originalProvider = process.env.EXTRACTION_PROVIDER;

    try {
      process.env.EXTRACTION_PROVIDER = "rule";
      expect(getExtractionProvider()).toBe(ruleExtractionProvider);

      process.env.EXTRACTION_PROVIDER = "openai";
      expect(getExtractionProvider()).not.toBe(openaiExtractionProvider);
    } finally {
      if (originalProvider === undefined) {
        delete process.env.EXTRACTION_PROVIDER;
      } else {
        process.env.EXTRACTION_PROVIDER = originalProvider;
      }
    }
  });

  it("throws for unknown extraction providers", () => {
    const originalProvider = process.env.EXTRACTION_PROVIDER;

    try {
      process.env.EXTRACTION_PROVIDER = "bogus";
      expect(() => getExtractionProvider()).toThrow("Unknown extraction provider: bogus");
    } finally {
      if (originalProvider === undefined) {
        delete process.env.EXTRACTION_PROVIDER;
      } else {
        process.env.EXTRACTION_PROVIDER = originalProvider;
      }
    }
  });

  it("falls back to rule extraction when OpenAI extraction fails", async () => {
    const originalProvider = process.env.EXTRACTION_PROVIDER;
    const originalFallbackProvider = process.env.EXTRACTION_FALLBACK_PROVIDER;
    const sensitiveError = "PRIVATE_TRANSCRIPT token=PRIVATE_TOKEN Authorization=PRIVATE_HEADER";
    const openaiExtract = vi
      .spyOn(openaiExtractionProvider, "extract")
      .mockRejectedValue(new Error(sensitiveError));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      process.env.EXTRACTION_PROVIDER = "openai";
      process.env.EXTRACTION_FALLBACK_PROVIDER = "rule";
      const provider = getExtractionProvider();
      const options = { semanticSegments: [], onProgress: vi.fn() };

      const classifiedSegments = sampleTranscriptSegments.map(classifySegment);
      const items = await provider.extract("upload_test", classifiedSegments, options);

      expect(openaiExtractionProvider.extract).toHaveBeenCalledTimes(1);
      expect(openaiExtractionProvider.extract).toHaveBeenCalledWith("upload_test", classifiedSegments, options);
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item) => item.sourceSegmentIds.length > 0)).toBe(true);
      const logs = consoleError.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
      expect(logs).toContain("error_name=Error");
      expect(logs).not.toContain(sensitiveError);
      expect(logs).not.toContain("PRIVATE_TRANSCRIPT");
      expect(logs).not.toContain("PRIVATE_TOKEN");
      expect(logs).not.toContain("PRIVATE_HEADER");
    } finally {
      consoleError.mockRestore();
      openaiExtract.mockRestore();
      if (originalProvider === undefined) {
        delete process.env.EXTRACTION_PROVIDER;
      } else {
        process.env.EXTRACTION_PROVIDER = originalProvider;
      }
      if (originalFallbackProvider === undefined) {
        delete process.env.EXTRACTION_FALLBACK_PROVIDER;
      } else {
        process.env.EXTRACTION_FALLBACK_PROVIDER = originalFallbackProvider;
      }
    }
  });
});

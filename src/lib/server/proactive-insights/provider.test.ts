import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProactiveInsightContext } from "@/lib/domain/proactive-insights";

import { createProactiveInsightProvider, getProactiveInsightProvider } from "./provider";

function context(): ProactiveInsightContext {
  return {
    schemaVersion: 1,
    scope: "current",
    referenceDate: "2026-07-10",
    dateRange: {
      startDate: "2026-07-10",
      endDate: "2026-07-10"
    },
    sourceUploadIds: ["upload_1"],
    distinctDates: ["2026-07-10"],
    truncated: false,
    evidence: [
      {
        evidenceId: "brief:item_1",
        kind: "brief",
        sourceType: "brief",
        sourceId: "item_1",
        uploadId: "upload_1",
        recordingDate: "2026-07-10",
        sourceSegmentIds: ["seg_1"],
        timeRange: {
          startSeconds: 1,
          endSeconds: 2
        },
        title: "Title",
        summary: "Summary",
        excerpt: "Excerpt"
      }
    ]
  };
}

const originalProvider = process.env.PROACTIVE_INSIGHT_PROVIDER;

afterEach(() => {
  if (originalProvider === undefined) {
    delete process.env.PROACTIVE_INSIGHT_PROVIDER;
  } else {
    process.env.PROACTIVE_INSIGHT_PROVIDER = originalProvider;
  }
});

describe("proactive insight provider selector", () => {
  it("defaults to the none provider when env is unset", async () => {
    delete process.env.PROACTIVE_INSIGHT_PROVIDER;
    const clientFactory = vi.fn();
    const provider = createProactiveInsightProvider({
      clientFactory
    });

    const result = await provider.generate({
      context: context()
    });

    expect(result.status).toBe("disabled");
    expect(result.provider).toBe("none");
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("returns disabled results for the none provider without constructing a client", async () => {
    process.env.PROACTIVE_INSIGHT_PROVIDER = "none";
    const clientFactory = vi.fn();
    const provider = createProactiveInsightProvider({
      clientFactory
    });

    const result = await provider.generate({
      context: context()
    });

    expect(result.status).toBe("disabled");
    expect(result.items).toEqual([]);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("throws for unknown providers", () => {
    process.env.PROACTIVE_INSIGHT_PROVIDER = "mystery";
    expect(() => getProactiveInsightProvider()).toThrow("Unknown proactive insight provider: mystery");
  });
});

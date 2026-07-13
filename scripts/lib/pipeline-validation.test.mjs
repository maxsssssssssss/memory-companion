import { describe, expect, it } from "vitest";
import {
  parseTunnelUrlFromText,
  redactSensitiveUrl,
  summarizeDayPayload
} from "./pipeline-validation.mjs";

describe("pipeline validation helpers", () => {
  it("extracts supported public tunnel URLs from command output", () => {
    expect(
      parseTunnelUrlFromText("Visit it at https://stable-demo.trycloudflare.com")
    ).toBe("https://stable-demo.trycloudflare.com");
    expect(parseTunnelUrlFromText("url=https://abc123.ngrok-free.app ready")).toBe(
      "https://abc123.ngrok-free.app"
    );
  });

  it("redacts internal audio access tokens in URLs and error messages", () => {
    expect(
      redactSensitiveUrl(
        "download failed: https://host.example/api/internal/audio/user/upload?token=secret-token&x=1"
      )
    ).toBe("download failed: https://host.example/api/internal/audio/user/upload?token=****&x=1");
  });

  it("summarizes the day response without leaking raw tokens", () => {
    const summary = summarizeDayPayload({
      upload: { id: "upload_1", status: "ready" },
      job: { id: "job_1", status: "ready" },
      segments: [
        { speaker: "speaker_1", text: "hello" },
        { speaker: "speaker_2", text: "hi" }
      ],
      audioInsights: [{ id: "insight_1" }],
      semanticSegments: [{ id: "semantic_1" }],
      briefItems: [{ id: "brief_1" }],
      relationshipSignalsAvailable: true,
      relationshipSignals: [
        {
          signalType: "boundary_respect",
          signalCategory: "positive",
          severity: "low",
          confidence: 0.72,
          summary: "A boundary was respected.",
          caution: undefined,
          evidenceSegments: [
            {
              segmentId: "seg_1",
              speaker: "speaker_1",
              startSeconds: 1,
              endSeconds: 2,
              text: "I need rest."
            }
          ]
        }
      ]
    });

    expect(summary).toMatchObject({
      uploadStatus: "ready",
      jobStatus: "ready",
      transcriptSegments: 2,
      speakers: 2,
      audioInsights: 1,
      semanticSegments: 1,
      briefItems: 1,
      relationshipSignals: 1,
      relationshipSignalsAvailable: true
    });
    expect(summary.cards).toEqual([
      {
        signalType: "boundary_respect",
        signalCategory: "positive",
        severity: "low",
        confidence: 0.72,
        summary: "A boundary was respected.",
        caution: undefined,
        evidence: [
          {
            segmentId: "seg_1",
            speaker: "speaker_1",
            startSeconds: 1,
            endSeconds: 2,
            text: "I need rest."
          }
        ]
      }
    ]);
  });
});

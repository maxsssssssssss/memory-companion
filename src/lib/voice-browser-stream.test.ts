import { describe, expect, it } from "vitest";

import { QuestionAnswerSchema } from "@/lib/domain/types";

import { VoiceBrowserAnswerMetadataSchema } from "./voice-browser-stream";

function canonicalAnswerWithLargeSourceMapping() {
  const sourceGroups = Array.from({ length: 6 }, (_, evidenceIndex) =>
    Array.from(
      { length: 24 },
      (_, sourceIndex) => `segment:${evidenceIndex + 1}:${sourceIndex + 1}`
    )
  );
  return QuestionAnswerSchema.parse({
    id: "answer:canonical/long-recording",
    uploadId: "upload_1",
    question: "Summarize the retained recording.",
    answer: "A grounded answer with several evidence groups. [E1][E2][E3][E4][E5][E6]",
    citedSegmentIds: sourceGroups.flat(),
    citations: sourceGroups.map((sourceSegmentIds, index) => ({
      id: `E${index + 1}`,
      title: `Evidence ${index + 1}`,
      startSeconds: index * 60,
      endSeconds: (index + 1) * 60,
      excerpt: `Grounded excerpt ${index + 1}`,
      sourceSegmentIds
    })),
    createdAt: "2026-07-27T00:00:00.000Z"
  });
}

describe("VoiceBrowserAnswerMetadataSchema", () => {
  it("accepts the complete canonical citation and source mapping", () => {
    const canonical = canonicalAnswerWithLargeSourceMapping();
    const metadata = {
      id: canonical.id,
      citedSegmentIds: canonical.citedSegmentIds,
      citations: canonical.citations ?? []
    };

    expect(metadata.citedSegmentIds.length).toBeGreaterThan(128);
    expect(VoiceBrowserAnswerMetadataSchema.parse(metadata)).toEqual(metadata);
  });
});

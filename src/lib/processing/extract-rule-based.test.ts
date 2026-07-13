import { describe, expect, it } from "vitest";
import { classifySegment } from "./classifier";
import { extractBriefItems } from "./extract-rule-based";
import { sampleTranscriptSegments } from "./sample-transcript";

describe("rule-based extraction", () => {
  it("classifies founder work segments by scene and value", () => {
    const segment = sampleTranscriptSegments[0];
    const classified = classifySegment(segment);

    expect(classified.sceneLabels).toContain("customer_call");
    expect(classified.valueLabels).toContain("commitment");
  });

  it("uses unknown scene label for unmatched text", () => {
    const classified = classifySegment({
      ...sampleTranscriptSegments[0],
      id: "seg_unknown_1",
      text: "今天早上九点开始记录。"
    });

    expect(classified.sceneLabels).toEqual(["unknown"]);
  });

  it("extracts brief items with evidence", () => {
    const customerSegment = sampleTranscriptSegments[0];
    const items = extractBriefItems("upload_demo", sampleTranscriptSegments.map(classifySegment));
    const commitmentItem = items.find((item) => item.category === "commitment");

    expect(items.map((item) => item.category)).toContain("commitment");
    expect(items.map((item) => item.category)).toContain("idea");
    expect(items.every((item) => item.sourceSegmentIds.length > 0)).toBe(true);
    expect(items.every((item) => item.transcriptExcerpt.length > 0)).toBe(true);
    expect(commitmentItem).toMatchObject({
      id: "brief_upload_demo_seg_customer_1_commitment_0",
      sourceSegmentIds: ["seg_customer_1"],
      sourceTimeRange: { startSeconds: 420, endSeconds: 510 },
      transcriptExcerpt: customerSegment.text
    });
  });

  it("copies topics defensively from classified segments", () => {
    const classifiedSegment = classifySegment(sampleTranscriptSegments[0]);
    const [item] = extractBriefItems("upload_demo", [classifiedSegment]);

    classifiedSegment.sceneLabels.push("unknown");

    expect(item.topics).toEqual(["customer_call", "team_management"]);
  });
});

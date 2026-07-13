import { classifySegment } from "@/lib/processing/classifier";
import { sampleTranscriptSegments } from "@/lib/processing/sample-transcript";
import type { TranscriptionProvider } from "./provider";

export const fixtureTranscriptionProvider: TranscriptionProvider = {
  async transcribe(input) {
    return sampleTranscriptSegments.map((segment) =>
      classifySegment({
        ...segment,
        uploadId: input.uploadId
      })
    );
  }
};

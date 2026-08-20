import { z } from "zod";

import { TranscriptSegmentSchema, type TranscriptSegment } from "@/lib/domain/types";

export function parseDailyReflectionCanonicalTranscript(
  raw: unknown,
  uploadId: string
): TranscriptSegment[] | null {
  const parsed = z.array(TranscriptSegmentSchema).safeParse(raw);
  if (
    !parsed.success
    || parsed.data.length === 0
    || parsed.data.some((segment) => segment.uploadId !== uploadId)
  ) {
    return null;
  }
  return parsed.data;
}

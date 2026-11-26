import { createHash } from "node:crypto";
import { z } from "zod";
import type { TranscriptSegment } from "@/lib/domain/types";
import { DcIdSchema } from "@/lib/domain/date-companion-stage2";
import type { QaConversationMessage } from "@/lib/server/retrieval/ai-qa";
import { recordingQaSegmentRevision } from "@/lib/domain/date-companion-recording-qa";

const citationSchema = z.object({
  sourceSegmentId: z.string().min(1).max(512),
  excerpt: z.string().min(1).max(220),
  uploadId: DcIdSchema.optional(),
  revision: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  authorizationRevision: z.string().regex(/^[a-f0-9]{64}$/u).optional()
}).strict();
export type PriorCitation = z.infer<typeof citationSchema>;
export const PriorCitationsSchema = z.array(citationSchema).max(32);

// The single-recording reader fingerprints this same tuple in the browser.
export function matchesRecordingRevision(citation: PriorCitation, segment: TranscriptSegment, reviewedRole?: "self" | "companion") {
  if (!citation.revision || citation.uploadId !== segment.uploadId) return false;
  const revision = recordingQaSegmentRevision(segment, reviewedRole);
  return createHash("sha256").update(revision).digest("hex") === citation.revision;
}

// Flat history has no server-authenticated answer text. Reconstitute only the
// previous basis from verified sources. Never insert client-authored excerpts.
export function verifiedPriorSources(
  segments: TranscriptSegment[], citations: PriorCitation[],
  matchesRevision: (citation: PriorCitation, segment: TranscriptSegment) => boolean = matchesRecordingRevision,
  requiresRevision?: (citation: PriorCitation) => boolean
): QaConversationMessage[] {
  const byId = new Map(segments.map(segment => [segment.id, segment]));
  const seen = new Set<string>();
  const conversation: QaConversationMessage[] = [];
  for (const citation of citations) {
    const source = byId.get(citation.sourceSegmentId);
    if (!source || seen.has(source.id)) continue;
    const text = source.text.replace(/\s+/gu, " ").trim();
    const excerpt = citation.excerpt.replace(/\s+/gu, " ").trim();
    const bound = matchesRevision(citation, source);
    if (citation.uploadId && citation.uploadId !== source.uploadId) continue;
    if ((citation.revision || requiresRevision?.(citation)) && !bound) continue;
    if (excerpt !== text && !(bound && text.length > 220 && excerpt === text.slice(0, 219) + "…")) continue;
    seen.add(source.id);
    conversation.push({ role: "assistant", content: "上轮使用的已核实依据：" + text });
  }
  return conversation.slice(-4);
}

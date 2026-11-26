import type { QuestionAnswer } from "@/lib/domain/types";
import { QA_INSUFFICIENT_EVIDENCE_ANSWER } from "@/lib/domain/qa-copy";
import type { SourceRefVM } from "@/lib/domain/date-companion";
import type { DayPayload } from "@/lib/domain/day-payload";
import { dateCompanionParticipantKey } from "@/lib/domain/date-companion-speaker";
import { recordingQaReviewedMaterials, recordingQaSegmentRevision } from "@/lib/domain/date-companion-recording-qa";
import type { DcInteractionRead } from "@/lib/domain/date-companion-stage2";

type Citation = NonNullable<QuestionAnswer["citations"]>[number];
export type CurrentQaEvidenceStatus = "current" | "changed" | "unavailable" | "unverified";

const compact = (text: string) => text.replace(/\s+/gu, " ").trim();

// Legacy answers did not persist an evidence kind or revision. These are the
// raw-source labels emitted by ai-qa.ts and local-analysis.ts, not topic titles.
// All other untyped citations may contain a summary, so a wording difference
// alone must never turn them into a changed transcript.
function isLegacyRawCitation(citation: Citation) {
  return !citation.contentKind && !citation.evidenceKind && citation.sourceSegmentIds.length === 1
    && /^(?:.+ 的原始转写|原始转写片段|本地录音片段)$/u.test(citation.title);
}

export async function recordingQaPaperSources(payload: DayPayload, record?: DcInteractionRead | null): Promise<SourceRefVM[]> {
  const { upload } = payload;
  const { materials, reviewed } = recordingQaReviewedMaterials(record, payload);
  const originals = new Map(payload.segments.map(s => [s.id, s]));
  return Promise.all(materials.segments.filter(segment => segment.uploadId === upload.id).map(async segment => {
    const role = reviewed.get(segment.id);
    const revision = recordingQaSegmentRevision(segment, role);
    const bytes = globalThis.crypto?.subtle
      ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(revision)) : null;
    return {
      id: segment.id, uploadId: upload.id, segmentIds: [segment.id], recordingDate: upload.recordingDate,
      quote: segment.text, startSeconds: segment.startSeconds, endSeconds: segment.endSeconds,
      speakerId: dateCompanionParticipantKey(originals.get(segment.id)!),
      ...(role ? { requiresReviewedSpeakerBinding: true as const } : {}),
      kind: "transcript" as const, presentation: "direct_quote" as const, canOpenTranscript: true, timeKnown: true,
      contentDigest: bytes ? Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("") : undefined
    };
  }));
}

function citationSources(citation: Citation, catalog: readonly SourceRefVM[], fresh = false): SourceRefVM[] {
  const matches: SourceRefVM[] = [];
  for (const id of citation.sourceSegmentIds) {
    const found = catalog.filter(s => s.segmentIds.includes(id));
    if (found.length !== 1) return [];
    const source = found[0];
    const binding = citation.sourceBindings?.find(b => b.segmentId === id);
    if ((!fresh || binding) && binding?.authorizationRevision !== source.authorizationRevision) return [];
    if (citation.sourceBindings && (!binding || binding.uploadId !== source.uploadId
      || !source.contentDigest || binding.revision !== source.contentDigest)) return [];
    matches.push(source);
  }
  return matches;
}

export function bindQaAnswerSources(answer: QuestionAnswer, catalog: readonly SourceRefVM[]): QuestionAnswer {
  if (!answer.citations?.length) return answer;
  return { ...answer, citations: answer.citations.map(citation => {
    const sources = citationSources(citation, catalog, true);
    if (!sources.length || sources.some(s => !s.contentDigest)) return citation;
    return { ...citation, sourceBindings: sources.map((s, i) => ({
      uploadId: s.uploadId, segmentId: citation.sourceSegmentIds[i], revision: s.contentDigest!,
      ...(s.authorizationRevision ? {authorizationRevision: s.authorizationRevision} : {})
    })) };
  }) };
}

type PaperCitation = { kind: "quote" | "self-report" | "derived" | "unavailable"; text: string; sources: SourceRefVM[] };

export function qaPriorCitations(history: readonly QuestionAnswer[], sources: readonly SourceRefVM[]) {
  return history.slice(-4).flatMap(answer => (answer.citations ?? []).flatMap(citation => {
    const evidence = resolveQaPaperCitation(citation, sources);
    if (evidence.kind !== "quote" && evidence.kind !== "self-report") return [];
    const binding = citation.sourceBindings?.[0];
    return [{sourceSegmentId: citation.sourceSegmentIds[0], excerpt: citation.excerpt,
      uploadId: evidence.sources[0].uploadId, revision: binding?.revision,
      ...(binding?.authorizationRevision ? { authorizationRevision: binding.authorizationRevision } : {})}];
  })).slice(-32);
}

/** Only canonical source rows can supply recording identity, speaker, time or literal speech. */
export function resolveQaPaperCitation(citation: Citation, catalog: readonly SourceRefVM[]): PaperCitation {
  const unavailable: PaperCitation = {kind: "unavailable", text: "这条依据目前无法核对。", sources: []};
  const sources = citationSources(citation, catalog);
  if (!sources.length) return unavailable;
  const raw = !citation.contentKind && (!citation.evidenceKind || citation.evidenceKind === "raw");
  const source = sources[0];
  const full = compact(source.quote);
  const excerpt = compact(citation.excerpt);
  const truncated = full.length > 220 && excerpt === full.slice(0, 219) + "…";
  if (raw && sources.length === 1 && source.presentation === "direct_quote" && (full === excerpt || truncated)) {
    // Without a revision only the stored excerpt, not the unseen suffix, can be vouched for.
    const snippetOnly = truncated && !citation.sourceBindings;
    return {
      kind: source.sourceOrigin === "user_reflection" || citation.sourceOrigin === "user_reflection" ? "self-report" : "quote",
      text: snippetOnly ? citation.excerpt : source.quote,
      sources: snippetOnly ? [{...source, quote: citation.excerpt, canOpenTranscript:false}] : sources
    };
  }
  if (citation.evidenceKind === "raw" || isLegacyRawCitation(citation)) return unavailable;
  return { kind: "derived", text: citation.sourceBindings
    ? citation.excerpt : `可核对所引的 ${sources.length} 段材料。`, sources };
}

/** A stored answer is readable only as a whole. Its citations must still describe this recording. */
export function recordingQaAnswerIsReadable(answer: QuestionAnswer, uploadId: string, catalog: readonly SourceRefVM[]) {
  if (answer.uploadId !== uploadId) return false;
  const citations = answer.citations ?? [];
  if (!citations.length || !answer.citedSegmentIds.length) {
    return !citations.length && !answer.citedSegmentIds.length && answer.answer === QA_INSUFFICIENT_EVIDENCE_ANSWER;
  }
  const cited = new Set(answer.citedSegmentIds);
  const covered = new Set(citations.flatMap(citation => citation.sourceSegmentIds));
  if (covered.size !== cited.size || [...covered].some(id => !cited.has(id))) return false;
  return citations.every(citation => {
    const resolved = resolveQaPaperCitation(citation, catalog);
    if (resolved.kind === "unavailable" || resolved.sources.some(source => source.uploadId !== uploadId)) return false;
    if (citation.sourceBindings?.length) return true;
    if (resolved.sources.some(source => source.requiresReviewedSpeakerBinding)) return false;
    // Older direct quotations can be checked word for word. A matching segment ID or an
    // unbound summary cannot certify the old answer or reconstruct a missing suffix.
    const source = catalog.find(row => row.uploadId === uploadId && row.segmentIds.includes(citation.sourceSegmentIds[0]));
    return (resolved.kind === "quote" || resolved.kind === "self-report")
      && (citation.evidenceKind === "raw" || isLegacyRawCitation(citation))
      && !!source && compact(source.quote) === compact(citation.excerpt);
  });
}

export function currentQaCitationEvidenceStatus(
  citation: Citation,
  textBySegmentId: ReadonlyMap<string, string> | undefined,
): CurrentQaEvidenceStatus {
  if (!textBySegmentId) return "unverified";
  if (citation.sourceSegmentIds.some(id => !textBySegmentId.has(id))) return "unavailable";
  if (citation.contentKind) return "unverified";
  const text = compact(citation.sourceSegmentIds.map(id => textBySegmentId.get(id)!).join(" "));
  const excerpt = compact(citation.excerpt);
  // The formal citation projection keeps at most 220 UTF-16 characters.
  const matches = excerpt === text || (excerpt.length === 220 && excerpt.endsWith("…")
    && text.length > 220 && text.startsWith(excerpt.slice(0, -1)));
  if (matches) return "current";
  return isLegacyRawCitation(citation) ? "changed" : "unverified";
}

export function currentQaAnswerEvidenceStatus(
  answer: QuestionAnswer,
  textBySegmentId: ReadonlyMap<string, string> | undefined,
  uploadId?: string,
): CurrentQaEvidenceStatus {
  if (uploadId && answer.uploadId !== uploadId) return "unavailable";
  if (!textBySegmentId) return "unverified";
  const statuses = (answer.citations ?? []).map(citation => currentQaCitationEvidenceStatus(citation, textBySegmentId));
  if (statuses.includes("changed")) return "changed";
  if (statuses.includes("unavailable") || answer.citedSegmentIds.some(id => !textBySegmentId.has(id))) return "unavailable";
  return statuses.includes("unverified") ? "unverified" : "current";
}

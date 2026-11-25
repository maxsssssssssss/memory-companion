import type { InteractionVM, PrepareVM, SourceRefVM } from "@/lib/domain/date-companion";
import type { PreparationSource } from "@/lib/domain/date-companion-preparation";
import type { PreviewClue, PreviewRecord } from "@/components/date-companion/prepare-notebook/model";
import type { FormalNotebookMaterials } from "./date-companion-notebook";

export function preparationSourceTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  const whole = Math.floor(seconds); return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The old preparation page's four groups, using its already-admitted VM. This
 * changes presentation only; it never promotes recap prose into selected notes. */
export function buildNotebookPastClues(input: {
  prepare: PrepareVM;
  interactions: InteractionVM[];
  relationshipName: string;
  speakerLabel: (source: SourceRefVM) => string | undefined;
}): FormalNotebookMaterials {
  const interactions = new Map(input.interactions.flatMap(record => record.relationshipInteractionId
    ? [[record.sourceUploadId ?? record.id, record] as const] : []));
  const records = new Map<string, PreviewRecord>();
  const convert = (source: SourceRefVM): PreparationSource => {
    const interaction = interactions.get(source.uploadId), interactionId = interaction?.relationshipInteractionId ?? "";
    const segmentId = source.segmentIds[0], label = input.speakerLabel(source);
    const projected: PreparationSource = {
      id: source.id, interactionId, recordingDate: source.recordingDate, quote: source.quote,
      ...(label === "我" ? { speakerRole: "self" as const } : label && label === input.relationshipName ? { speakerRole: "companion" as const } : {}),
      origin: "direct_conversation", valid: true,
      href: interactionId && segmentId ? `/date-companion/a/recap?interaction=${encodeURIComponent(interactionId)}&segment=${encodeURIComponent(segmentId)}#full-transcript` : "",
      fingerprint: source.contentDigest ?? JSON.stringify([source.id, source.uploadId, source.segmentIds, source.quote])
    };
    if (interactionId) {
      const record = records.get(interactionId) ?? { id: interactionId, title: interaction!.fileName || interaction!.title,
        date: interaction!.recordingDate, fullTranscript: false, sources: [], segments: [], sourceDetails: {} };
      record.sources = [...record.sources.filter(s => s.id !== projected.id), projected];
      record.sourceDetails = { ...record.sourceDetails, [projected.id]: { presentation: source.presentation,
        ...(label ? { speakerLabel: label } : {}), ...(source.presentation === "direct_quote" ? { time: preparationSourceTime(source.startSeconds) } : {}) } };
      if (projected.valid && segmentId && projected.quote) record.segments = [...record.segments.filter(s => s.id !== segmentId), {
        id: segmentId, speaker: label ?? "说话人待核对", text: projected.quote,
        time: source.presentation === "direct_quote" ? preparationSourceTime(source.startSeconds) ?? "" : ""
      }];
      records.set(interactionId, record);
    }
    return projected;
  };
  const groups = { mentioned: "recent", moment: "together", continue: "continue" } as const;
  const clues: PreviewClue[] = input.prepare.items.filter(item => item.disposition === "kept" && item.sources.length > 0 && item.kind !== "promise")
    .map(item => ({ id: item.id, group: groups[item.kind as keyof typeof groups], text: item.displayedText || item.proposedText, sources: item.sources.map(convert) }));
  for (const promise of input.prepare.openPromises) if (promise.status === "open" && promise.sources.length > 0) {
    clues.push({ id: promise.id, group: "promise", text: promise.text, sources: promise.sources.map(convert) });
  }
  return { records: [...records.values()], clues, status: clues.length ? "ready" : "empty" };
}

import type { DateCompanionPersonArchiveEntry, DateCompanionPersonArchiveState } from "@/lib/client/date-companion-people";
import type { DateCompanionConfirmedPerson, DateCompanionMemoryBridgeState, DateCompanionViewModel, InteractionVM, PromiseVM, RecapItemVM, SourceRefVM } from "@/lib/domain/date-companion";

export type ScrapbookMaterial = {
  id: string;
  kind: "recent" | "shared" | "archive" | "promise" | "suggestion";
  text: string;
  date: string;
  sources: SourceRefVM[];
  archiveSources?: DateCompanionPersonArchiveEntry["sources"];
  archiveEntry?: DateCompanionPersonArchiveEntry;
  promise?: PromiseVM;
};

/** A saved URL identifies the grant under which the reader first opened this paper. */
export function scrapbookReaderKey(material: ScrapbookMaterial) {
  const revisions = [...new Set([
    ...material.sources.flatMap(source => source.authorizationRevision ?? []),
    ...(material.archiveSources ?? []).flatMap(source => source.memoryEvidenceIds ?? [])
  ])].sort();
  return revisions.length ? JSON.stringify([material.id, revisions]) : material.id;
}

export function confirmedDirectory(state: DateCompanionMemoryBridgeState): DateCompanionConfirmedPerson[] {
  if (state.status !== "ready") return [];
  const self = state.mapping?.selfPersonId ?? state.selfBinding?.personId;
  return state.people.filter(p => p.id !== self && p.explicitlyConfirmed && p.status === "confirmed")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export function currentScrapbookPerson(state: DateCompanionMemoryBridgeState) {
  if (state.status !== "ready" || state.mapping?.status !== "confirmed" || state.selfBinding?.status !== "active") return null;
  const { selfPersonId, companionPersonId } = state.mapping;
  if (selfPersonId === companionPersonId || state.selfBinding.personId !== selfPersonId) return null;
  const confirmed = new Set(state.people.filter(p => p.explicitlyConfirmed && p.status === "confirmed").map(p => p.id));
  return confirmed.has(selfPersonId) && confirmed.has(companionPersonId) ? companionPersonId : null;
}

export function personScrapbookContent(
  id: string | null, state: DateCompanionMemoryBridgeState, archive: DateCompanionPersonArchiveState,
  vm: DateCompanionViewModel, relationshipId: string | null
) {
  const person = confirmedDirectory(state).find(p => p.id === id);
  const isCurrent = Boolean(person && relationshipId && vm.relationship?.status === "active" && vm.relationship.id === relationshipId && currentScrapbookPerson(state) === person.id);
  const materials: ScrapbookMaterial[] = [];
  const meetings: InteractionVM[] = isCurrent ? vm.recap.history.filter(m => m.persistenceStatus === "confirmed" &&
    m.relationshipInteractionId && m.sourceState !== "explicitly_deleted").sort((a, b) =>
    b.recordingDate.localeCompare(a.recordingDate) || a.relationshipInteractionId!.localeCompare(b.relationshipInteractionId!)) : [];
  const byId = new Map(meetings.map(m => [m.relationshipInteractionId, m]));
  const byUpload = new Map(meetings.map(m => [m.sourceUploadId, m]));
  function appendItem(item: RecapItemVM, kind: "recent" | "shared" | "suggestion") {
    const meeting = byId.get(item.interactionId);
    if (!meeting || item.disposition !== "kept" || !item.displayedText.trim()) return;
    const sources = item.sources.filter(s => s.uploadId === meeting.sourceUploadId && s.segmentIds.length && s.quote.trim());
    if (sources.length) materials.push({ id: item.id, kind, text: item.displayedText, date: meeting.recordingDate, sources });
  }
  if (isCurrent) {
    vm.person.remembered.forEach(item => appendItem(item, "recent"));
    vm.person.relationship.forEach(item => appendItem(item, "shared"));
    vm.person.conversationTopics?.forEach(item => appendItem(item, "suggestion"));
    for (const promise of vm.person.promises) {
      if (promise.relationshipId !== relationshipId) continue;
      const sources = promise.sources.filter(s => byUpload.has(s.uploadId) && s.segmentIds.length && s.quote.trim());
      if (sources.length) materials.push({ id: promise.id, kind: "promise", text: promise.text,
        date: sources[0].recordingDate, sources, promise });
    }
  }
  if (person && archive.status === "ready" && archive.archive.person.id === person.id) {
    for (const entry of archive.archive.entries) {
      const sources = entry.sources.filter(s => s.sourceSegmentId && s.quote.trim());
      if (!sources.length) continue;
      materials.push({ id: entry.id, kind: "archive", text: entry.summary || entry.title, date: entry.date,
        sources: [], archiveSources: sources, archiveEntry: entry });
    }
  }
  materials.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  return { person, isCurrent, materials, meetings };
}

"use client";

import { useEffect, useRef, useState } from "react";
import { createDateCompanionApi, DateCompanionApiError } from "@/lib/client/date-companion-api";
import { isLongTermEligible, type DateCompanionRelationshipAdapterOptions } from "@/lib/client/date-companion-adapter";
import { readDateCompanionPersonArchive, type DateCompanionPersonArchiveEntry } from "@/lib/client/date-companion-people";
import type { DateCompanionSessionValue } from "@/lib/client/date-companion-session";
import { readLocalDayPayload } from "@/lib/client/local-analysis";
import type { SourceRefVM, TranscriptLineVM } from "@/lib/domain/date-companion";
import { dateCompanionEvidenceSpeakerRole, dateCompanionParticipantKey, dateCompanionReadingSpeakerRole } from "@/lib/domain/date-companion-speaker";
import type { DcInteractionDetail } from "@/lib/domain/date-companion-stage2";
import { DayPayloadSchema } from "@/lib/domain/day-payload";
import { bookMeetingTitle } from "./book-recap";
import { formatTimestamp } from "./companion-transcript";
import { SourceInsert, SourceReadLoading, type ReaderSource } from "./companion-person-reader-sheet";
import type { SourcePaperEntry } from "./source-paper-motion";

interface ReaderMaterial {
  id: string;
  sources: SourceRefVM[];
  archiveEntry?: DateCompanionPersonArchiveEntry;
}

interface Props {
  material?: ReaderMaterial | null;
  session: DateCompanionSessionValue;
  personId: string;
  personName: string;
  currentPerson: boolean;
  fullId: string | null;
  onFull: (sourceId: string) => void;
  onBack: () => void;
  entry?: SourcePaperEntry | null;
}

type SavedFragment = Pick<ReaderSource, "id" | "date" | "presentation" | "subject" | "subjectLabel" | "sourceOrigin" | "sourceStatement">
  & { uploadId: string; segmentId: string; quote: string; evidenceId?: string };
const words = (value: string) => value.normalize("NFKC").trim();

/** The timeline endpoint authorizes the saved fragment. Reading a whole local
 * recording additionally requires an owned, confirmed relationship record and
 * the same evidence segment. The subject of a memory never supplies a speaker. */
export function personReaderSource(fragment: SavedFragment, detail: DcInteractionDetail | undefined,
  localTranscript: TranscriptLineVM[], name: string, admission: DateCompanionRelationshipAdapterOptions): ReaderSource {
  const saved: ReaderSource = {
    id: fragment.id, date: fragment.date, state: "ok", presentation: fragment.presentation,
    sourceOrigin: fragment.sourceOrigin, sourceStatement: fragment.sourceStatement,
    subject: fragment.subject, subjectLabel: fragment.subjectLabel, text: fragment.quote, speaker: null,
    recordTitle: "", time: null, segmentId: null, lines: []
  };
  const withdrawn: ReaderSource = { ...saved, state: "withdrawn", text: null };
  if (!detail) return fragment.evidenceId ? withdrawn : { ...saved, fragmentNote: "已保存人物档案中的这段原文。完整文字稿在此处不可用。" };
  if (detail.sourceUploadId !== fragment.uploadId || detail.status !== "confirmed" || !detail.confirmedAt ||
      detail.sourceState === "explicitly_deleted" || (fragment.evidenceId && detail.memoryBridge?.status !== "completed")) return withdrawn;
  const evidence = detail.recapItems.filter(item => fragment.evidenceId
    ? isLongTermEligible(detail, item, admission) : item.disposition === "kept").flatMap(item => item.evidence)
    .find(e => e.uploadId === fragment.uploadId && e.sourceSegmentId === fragment.segmentId &&
      (!fragment.evidenceId || e.id === fragment.evidenceId));
  if (!evidence) return fragment.evidenceId ? withdrawn : saved;
  if (fragment.presentation === "direct_quote" && words(evidence.quote) !== words(fragment.quote)) {
    // An archived link retains its own authorized snapshot. A changed
    // relationship source has to pass admission again before being shown.
    return fragment.evidenceId ? withdrawn : { ...saved, state: "mismatch" };
  }
  const label = (role?: "self" | "companion") => role === "self" ? "我" : role === "companion" ? name : undefined;
  saved.speaker = label(dateCompanionEvidenceSpeakerRole(detail, evidence)) ?? null;
  saved.time = formatTimestamp(evidence.startSeconds);
  saved.recordTitle = detail.originalName;
  if (!saved.speaker) return { ...saved, state: "pending" };
  const lines = localTranscript.filter(line => line.uploadId === detail.sourceUploadId);
  if (!lines.length) return saved;
  const target = lines.find(line => line.id === fragment.segmentId);
  if (!target || words(target.text) !== words(evidence.quote) ||
      (target.speakerId && evidence.speakerId && target.speakerId !== evidence.speakerId) ||
      Math.abs(target.startSeconds - evidence.startSeconds) > 0.01 || Math.abs(target.endSeconds - evidence.endSeconds) > 0.01) {
    return { ...saved, state: "mismatch" };
  }
  saved.segmentId = target.id;
  saved.lines = lines.map(line => ({ ...line, speakerLabel: label(dateCompanionReadingSpeakerRole(detail, {
    uploadId: line.uploadId, speakerId: line.speakerId, segmentIds: [line.id], quote: line.text,
    startSeconds: line.startSeconds, endSeconds: line.endSeconds
  })) || "说话人待核对" }));
  return saved;
}

function readTranscript(uploadId: string): TranscriptLineVM[] {
  try {
    const local = DayPayloadSchema.safeParse(readLocalDayPayload(uploadId));
    if (!local.success || local.data.upload.id !== uploadId ||
        (local.data.job?.status ?? local.data.upload.status) !== "ready") return [];
    return local.data.segments.map(line => ({ ...line, speakerId: dateCompanionParticipantKey(line) }));
  } catch { return []; } // Storage can be disabled; the authorized fragment is still readable.
}

async function loadSources(props: Props, signal: AbortSignal): Promise<ReaderSource[]> {
  const { session, material, currentPerson, personId, personName } = props;
  if (!material || session.auth.status !== "authenticated") return [];
  const relationshipId = session.relationshipState.status === "ready" ? session.relationshipState.relationship.id : undefined;
  const bridge = session.memoryBridgeState;
  if (bridge.status !== "ready" || !bridge.people.some(p => p.id === personId && p.explicitlyConfirmed)) return [];
  const inRelationship = !!relationshipId && currentPerson && bridge.mapping?.status === "confirmed" && bridge.mapping.companionPersonId === personId;
  const shouldReadArchive = Boolean(material.archiveEntry);
  let fragments: SavedFragment[];
  if (shouldReadArchive) {
    const archive = await readDateCompanionPersonArchive(personId, { signal });
    const entry = archive.entries.find(e => e.id === material.archiveEntry?.id);
    if (!entry) return [];
    fragments = entry.sources.map(s => ({ id: s.id, uploadId: s.uploadId, segmentId: s.sourceSegmentId, date: s.date,
      quote: s.quote, presentation: "direct_quote", sourceOrigin: entry.sourceOrigin, sourceStatement: entry.sourceStatement, subject: "unknown",
      subjectLabel: entry.shared ? personName + " · 涉及多人" : personName }));
  } else {
    if (!inRelationship) return [];
    fragments = material.sources.flatMap(s => s.segmentIds.length === 1 ? [{ id: s.id, evidenceId: s.id,
      uploadId: s.uploadId, segmentId: s.segmentIds[0], date: s.recordingDate, quote: s.quote,
      subject: s.memorySubject || "unknown", presentation: s.presentation, sourceOrigin: s.sourceOrigin, sourceStatement: s.sourceStatement }] : []);
  }
  const api = createDateCompanionApi();
  const records = inRelationship ? session.viewModel.recap.history : [];
  const ids = [...new Set(fragments.map(f => f.uploadId))];
  const pairs = await Promise.all(ids.map(async uploadId => {
    const record = records.find(item => item.sourceUploadId === uploadId);
    if (!relationshipId || !record?.relationshipInteractionId) return undefined;
    const detail = await api.getInteractionDetail(relationshipId, record.relationshipInteractionId, signal);
    if (detail.relationshipId !== relationshipId || detail.id !== record.relationshipInteractionId ||
        detail.sourceUploadId !== uploadId) throw new Error("来源记录与当前人物不一致，请重新读取。");
    return { uploadId, detail, title: bookMeetingTitle(record), lines: readTranscript(uploadId) };
  }));
  return fragments.map(f => {
    const match = pairs.find(entry => entry?.uploadId === f.uploadId);
    const source = personReaderSource(f, match?.detail, match?.lines || [], personName, bridge);
    return match ? { ...source, recordTitle: match.title } : source;
  });
}

type ReadState = { key: string; sources?: ReaderSource[]; error?: string };

export function CompanionPersonReader(props: Props) {
  const { session, personId, material, fullId } = props;
  const current = useRef(props);
  current.current = props;
  const [read, setRead] = useState<ReadState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const account = session.auth.status === "authenticated" ? session.auth.user.id : "";
  const relationship = session.relationshipState.status === "ready" ? session.relationshipState.relationship.id : "";
  const bridge = session.memoryBridgeState;
  const key = JSON.stringify([account, relationship, personId, props.currentPerson, props.personName, bridge.status,
    bridge.status === "ready" && bridge.mapping?.version, material?.id, material?.archiveEntry?.updatedAt,
    material?.archiveEntry?.sourceOrigin, material?.archiveEntry?.sourceStatement,
    material?.sources.map(s => [s.id, s.uploadId, s.segmentIds, s.quote, s.presentation, s.memorySubject, s.sourceOrigin, s.sourceStatement]),
    material?.archiveEntry?.sources.map(s => [s.id, s.uploadId, s.sourceSegmentId, s.quote])]);
  useEffect(() => {
    if (!current.current.material || current.current.session.memoryBridgeState.status !== "ready") return;
    const controller = new AbortController();
    const context = current.current;
    // Recheck retained admission on entry. The session preserves readable
    // items while the read runs and recomputes the authoritative projection.
    const admission = context.currentPerson ? context.session.ensureMemoryBridgeLoaded(true) : Promise.resolve();
    void Promise.all([loadSources(context, controller.signal), admission]).then(([sources]) => {
      if (!controller.signal.aborted) setRead({ key, sources });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const message = error instanceof DateCompanionApiError && [401,403,404].includes(error.status)
        ? "这份记录已不可访问，请重新核对人物和来源。"
        : "来源暂时没有读取成功，请重试。";
      setRead({ key, error: message });
    });
    return () => controller.abort();
  }, [key, attempt]);
  const result = read?.key === key ? read : null;
  const retry = () => {
    setRead(null);
    if (bridge.status === "error") void session.ensureMemoryBridgeLoaded(true);
    else setAttempt(a => a + 1);
  };
  const unavailable = !material || !account || (!relationship && !material.archiveEntry);
  const loading = !unavailable && !result?.error && bridge.status !== "error" && !result?.sources;
  const notice = unavailable
    ? <p className="pa-note">这条依据已不在当前人物可以核对的材料中。</p>
    : result?.error || bridge.status === "error"
      ? <div className="pa-note" role="alert">{result?.error || "人物身份暂时无法核实。"} <button className="pa-text" onClick={retry}>重新读取</button></div>
      : !result?.sources ? <SourceReadLoading count={material?.archiveEntry?.sources.length ?? material?.sources.filter(source=>source.segmentIds.length===1).length} />
      : !result.sources.length ? <p className="pa-note">这条依据已不在当前人物可以核对的材料中。</p> : undefined;
  return <SourceInsert material={{ sources: result?.sources ?? [] }} sourceId={fullId} mode={fullId ? "transcript" : "source"}
    readingScope={JSON.stringify([account, relationship, personId, material?.id])}
    notice={notice} loading={loading} onTranscript={props.onFull} onBack={props.onBack} entry={props.entry} />;
}

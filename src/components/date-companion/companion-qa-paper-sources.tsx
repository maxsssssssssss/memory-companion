import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DayPayload } from "@/lib/domain/day-payload";
import type { SourceRefVM } from "@/lib/domain/date-companion";
import type { QuestionAnswer, TranscriptSegment } from "@/lib/domain/types";
import { dateCompanionParticipantKey, type DateCompanionSpeakerReadingSource } from "@/lib/domain/date-companion-speaker";
import { recordingQaPaperSources, resolveQaPaperCitation } from "@/lib/client/date-companion-qa-evidence";
import type { DcInteractionRead } from "@/lib/domain/date-companion-stage2";
import { formatTimestamp } from "./companion-transcript";

export type PaperCitation = NonNullable<QuestionAnswer["citations"]>[number];
export type PaperEvidence = ReturnType<typeof resolveQaPaperCitation>;
export type QaSourceSpeakerLabel = (source: DateCompanionSpeakerReadingSource) => string | undefined;
const evidenceNames = { quote: "保存的原话", "self-report": "保存的自述", derived: "材料概括", unavailable: "依据暂不可核验" };

export function useRecordingQaCatalog(open: boolean, uploadId?: string, revision?: object, review?: DcInteractionRead,
  sourceDay?: (id: string) => DayPayload | null, exited = false) {
  const [read, setRead] = useState<{uploadId: string; revision?: object; review?: DcInteractionRead; sources: SourceRefVM[]}>();
  useLayoutEffect(() => { if (exited) setRead(undefined); }, [exited]);
  useEffect(() => {
    if (!open || !uploadId || !sourceDay) return;
    let current = true;
    const publish = (sources: SourceRefVM[]) => { if (current) setRead({uploadId, revision, review, sources}); };
    const day = sourceDay(uploadId);
    if (day) void recordingQaPaperSources(day, review).then(publish, () => publish([]));
    else publish([]);
    return () => { current = false; };
  }, [open, uploadId, revision, review, sourceDay]);
  return read?.uploadId === uploadId && read?.revision === revision && read?.review === review ? read?.sources : undefined;
}

function recordingTime(seconds: number | undefined) {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? formatTimestamp(seconds) : undefined;
}

function lineSpeaker(line: TranscriptSegment, confirmedLabel: QaSourceSpeakerLabel) {
  const speakerId = dateCompanionParticipantKey(line);
  if (!speakerId) return "说话人未识别";
  const label = confirmedLabel({
    uploadId: line.uploadId, speakerId, segmentIds: [line.id],
    quote: line.text, startSeconds: line.startSeconds, endSeconds: line.endSeconds
  });
  if (label) return label;
  const raw = line.speaker?.trim();
  // Keep an existing diarization marker. Free-form names and local aliases
  // cannot establish who spoke in this recording.
  if (raw && /^(?:(?:speaker|spk|voice|说话人|发言人)[\s_-]*[a-z\d_-]+|[a-z]|\d+)$/iu.test(raw)) {
    return `${raw}（身份待核对）`;
  }
  return "说话人待核对";
}

function sourceMetadata(source: SourceRefVM | undefined, kind: PaperEvidence["kind"], confirmedLabel: QaSourceSpeakerLabel) {
  if (!source) return "";
  return [kind === "quote" ? confirmedLabel(source) : undefined, source.recordingDate?.replaceAll("-", "."),
    source.timeKnown === true ? recordingTime(source.startSeconds) : undefined].filter(Boolean).join(" · ");
}

export function QaPaperCitations({ answer, sources, sourceSpeakerLabel, expanded, onExpand, onOpen, animateEdge }: {
  answer: QuestionAnswer; sources: readonly SourceRefVM[]; expanded: boolean;
  sourceSpeakerLabel: QaSourceSpeakerLabel;
  onExpand: () => void; onOpen: (index: number, button: HTMLButtonElement, keyboard: boolean) => void;
  animateEdge: (el: Element | null, part: "edge", keyboard: boolean) => void;
}) {
  const edge = useRef<HTMLSpanElement>(null);
  const intent = useRef(false);
  useLayoutEffect(() => {
    if (expanded && intent.current) animateEdge(edge.current, "edge", false);
    intent.current = false;
  }, [expanded, animateEdge]);
  const citations = answer.citations ?? [];
  if (!citations.length) return null;
  const item = (citation: PaperCitation, index: number) => {
    const evidence = resolveQaPaperCitation(citation, sources);
    const isQuote = evidence.kind === "quote" || evidence.kind === "self-report";
    const text = Array.from(evidence.text);
    const snippet = text.length > 55 ? text.slice(0, 54).join("") + "…" : evidence.text;
    return <div key={citation.id + "/" + index} className="qa-evidence-item">
      {evidence.kind === "unavailable" ? <p>这条依据已无法核验。</p> : <>
        {isQuote ? <blockquote>“{snippet}”</blockquote> : <p>{snippet}</p>}
        <div className="qa-evidence-meta"><span>{[evidence.kind !== "quote" ? evidenceNames[evidence.kind] : undefined,
          sourceMetadata(evidence.sources.length === 1 ? evidence.sources[0] : undefined, evidence.kind, sourceSpeakerLabel)].filter(Boolean).join(" · ")}</span>
          <button type="button" className="qa-link" onClick={e => onOpen(index, e.currentTarget, e.detail === 0)}>{evidence.kind === "quote" ? "查看原话" : "查看依据"} →</button></div>
      </>}
    </div>;
  };
  return <section className="qa-evidence" aria-label="回答依据">
    <div className="qa-evidence-head">{citations.length} 条依据</div>
    {expanded && <span className="qa-paper-edge" aria-hidden="true" ref={edge}/>}
    {item(citations[0], 0)}
    {citations.length > 1 && <button type="button" className="qa-link" aria-expanded={expanded} onClick={e => { intent.current = e.detail > 0; onExpand(); }}>
      {expanded ? "收起更多依据" : `展开其余 ${citations.length - 1} 条依据`}</button>}
    {expanded && citations.slice(1).map((citation, index) => item(citation, index + 1))}
  </section>;
}

export function verifiedDay(source: SourceRefVM, read: (uploadId: string) => DayPayload | null) {
  if (!source.canOpenTranscript || source.sourceOrigin === "user_reflection" || source.segmentIds.length !== 1) return null;
  const day = read(source.uploadId);
  if (day?.upload.id !== source.uploadId) return null;
  const matches = day.segments.filter(line => line.uploadId === source.uploadId && line.id === source.segmentIds[0]);
  if (matches.length !== 1) return null;
  const segment = matches[0];
  const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
  if (normalize(segment.text) !== normalize(source.quote)
    || (source.speakerId && dateCompanionParticipantKey(segment) !== source.speakerId && segment.speaker !== source.speakerId)
    || (source.timeKnown && (segment.startSeconds !== source.startSeconds || segment.endSeconds !== source.endSeconds))) return null;
  return day;
}

export function QaReadingPaper({ evidence, day, fullSource, sourceDay, sourceSpeakerLabel, onFull, animated, headingId }: {
  evidence: PaperEvidence | null; sourceDay: (uploadId: string) => DayPayload | null;
  sourceSpeakerLabel: QaSourceSpeakerLabel;
  day: DayPayload | null; fullSource?: SourceRefVM; onFull: (index: number, button: HTMLButtonElement) => void;
  animated: boolean; headingId: string;
}) {
  if (!evidence || evidence.kind === "unavailable") return <section className="qa-reading-paper">
    <h3 id={headingId} tabIndex={-1}>这条依据已无法核验</h3></section>;
  const readingFull = fullSource && evidence.kind !== "self-report";
  return <article className="qa-reading-paper">
    {animated && <span className="qa-paper-edge" aria-hidden="true" data-arrive="true"/>}
    <h3 id={headingId} tabIndex={-1}>{readingFull ? "完整文字稿" : evidenceNames[evidence.kind]}</h3>
    {readingFull ? day ? <>
      <p className="qa-reading-kicker">{[day.upload.originalName, day.upload.recordingDate?.replaceAll("-", ".")].filter(Boolean).join(" · ")}</p>
      {day.segments.filter(line => line.uploadId === day.upload.id).map(line => <section key={line.id} className="qa-segment" tabIndex={-1}
        data-target={line.id === fullSource.segmentIds[0]}>
        <small>{[lineSpeaker(line, sourceSpeakerLabel), recordingTime(line.startSeconds)].filter(Boolean).join(" · ")}</small><p>{line.text}</p></section>)}
    </> : <p>这份全文目前不可用。</p> : <>
      {evidence.kind === "derived" ? <p>{evidence.text}</p> : <blockquote>“{evidence.text}”</blockquote>}
      {evidence.sources.map((source, index) => <div className="qa-source-entry" key={source.uploadId + "/" + source.id}>
        {evidence.kind === "derived" && <blockquote>{source.quote}</blockquote>}
        <p className="qa-reading-kicker">{sourceMetadata(source, evidence.kind, sourceSpeakerLabel)}</p>
        {evidence.kind !== "self-report" && verifiedDay(source, sourceDay) ? <button type="button" className="qa-link"
          onClick={e => onFull(index, e.currentTarget)}>{evidence.sources.length > 1 ? `查看第 ${index + 1} 条依据的全文` : "查看完整文字稿"} →</button>
          : <p className="qa-source-unavailable">可在这里阅读已保存的片段，当前无法定位全文。</p>}
      </div>)}
    </>}
  </article>;
}

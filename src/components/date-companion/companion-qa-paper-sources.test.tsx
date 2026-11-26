import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import type { DayPayload } from "@/lib/domain/day-payload";
import type { SourceRefVM } from "@/lib/domain/date-companion";
import { bindQaAnswerSources, recordingQaAnswerIsReadable, recordingQaPaperSources } from "@/lib/client/date-companion-qa-evidence";
import type { DcInteractionDetail } from "@/lib/domain/date-companion-stage2";
import type { QuestionAnswer } from "@/lib/domain/types";
import { QaReadingPaper, verifiedDay, type QaSourceSpeakerLabel } from "./companion-qa-paper-sources";

const uploadId = "album";
const makeLine = (id: string, text: string, startSeconds: number, speaker?: string) => ({
  id, text, uploadId, startSeconds, endSeconds: startSeconds + 2, speaker, confidence: 1, sceneLabels: [], valueLabels: []
});
const day: DayPayload = {
  upload: { id: uploadId, recordingDate: "2026-11-05", originalName: "展厅.wav", mimeType: "audio/wav", sizeBytes: 64, status: "ready" },
  segments: [
    makeLine("a", "我想去看看。", 3, "speaker_0"), makeLine("b", "我还没有看过。", 8, "speaker_1"),
    makeLine("c", "这句没有确认身份。", 13, "speaker_9"), makeLine("d", "没有提供编号。", 20)
  ],
  audioInsights: [], semanticSegments: [], semanticSegmentsAvailable: true, briefItems: [], relationshipSignals: [],
  relationshipSignalsAvailable: false, proactiveInsights: [], proactiveInsightsAvailable: false,
  speakerAliases: { speaker_0: "跨场次别名" }, speakerAliasesByUploadId: { album: { speaker_1: "本机旧别名" } }
};
const source: SourceRefVM = {
  id: "snapshot-a", uploadId, segmentIds: ["a"], recordingDate: day.upload.recordingDate, startSeconds: 3, endSeconds: 5,
  quote: day.segments[0].text, speakerId: "local_speaker_0", memorySubject: "self", timeKnown: true,
  kind: "transcript", presentation: "direct_quote", canOpenTranscript: true
};
const props = { evidence: { kind: "quote" as const, sources: [source], text: source.quote }, sourceDay: () => day,
  onFull: () => {}, animated: false, headingId: "about-the-recording" };
const label: QaSourceSpeakerLabel = ({ uploadId: recordingId, speakerId }) => {
  if (recordingId !== uploadId) return undefined;
  if (speakerId === "local_speaker_0") return "小夏";
  if (speakerId === "local_speaker_1") return "我";
};
afterEach(cleanup);

describe("QA recording speaker attribution", () => {
  it("requires a new citation binding after reviewing a mixed label and preserves the raw full transcript", async () => {
    vi.stubGlobal("crypto", webcrypto);
    try {
      const speakerId = source.speakerId!, digest = "d".repeat(64), stamp = "2026-11-05T12:00:00Z";
      const two = {...day, segments: [day.segments[0], {...day.segments[1], speaker:day.segments[0].speaker}]};
      const record: DcInteractionDetail = {id:"rec", relationshipId:"r", sourceUploadId:uploadId,
        status:"confirmed", sourceState:"available", version:2, originalName:"展厅.wav", recordingDate:source.recordingDate,
        createdAt:stamp, updatedAt:stamp, participants:[{speakerId,role:"unresolved",reviewedSegments:[
          {sourceSegmentId:"a",contentDigest:digest,role:"self"}]}],recapItems:[{id:"item",interactionId:"rec",
          kind:"moment",proposedText:"展厅",displayedText:"展厅",disposition:"kept",version:1,sortOrder:0,
          evidence:[{id:"e",recapItemId:"item",uploadId,sourceSegmentId:"a",speakerId,quote:source.quote,
            startSeconds:3,endSeconds:5,createdAt:stamp,contentDigest:digest}]}]};
      const oldSources = await recordingQaPaperSources(two);
      const checked = await recordingQaPaperSources(two,record);
      expect(checked.map(row=>row.id)).toEqual(["a"]);
      expect(verifiedDay(checked[0],()=>two)?.segments).toHaveLength(2);
      const answer: QuestionAnswer = {id:"q",uploadId,question:"说了什么？",answer:"想去看看。",createdAt:stamp,
        citedSegmentIds:["a"],citations:[{id:"E1",title:"原始转写片段",excerpt:source.quote,startSeconds:3,endSeconds:5,sourceSegmentIds:["a"]}]};
      expect(recordingQaAnswerIsReadable(answer, uploadId, checked)).toBe(false);
      expect(recordingQaAnswerIsReadable(bindQaAnswerSources(answer,oldSources), uploadId, checked)).toBe(false);
      const current = bindQaAnswerSources(answer,checked);
      expect(recordingQaAnswerIsReadable(current,uploadId,checked)).toBe(true);
      record.participants[0].reviewedSegments![0].role="companion";
      expect(recordingQaAnswerIsReadable(current,uploadId,await recordingQaPaperSources(two,record))).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
  it("uses each segment's confirmed recording participant and preserves every original line", async () => {
    const sources = await recordingQaPaperSources(day);
    expect(sources[0].speakerId).toBe("local_speaker_0");
    expect(sources[0].speakerLabel).toBeUndefined();
    const { container, rerender } = render(<QaReadingPaper {...props} fullSource={source} day={verifiedDay(source, () => day)} sourceSpeakerLabel={label}/>);
    expect(screen.getByText("展厅.wav · 2026.11.05")).toBeVisible();
    expect([...container.querySelectorAll(".qa-segment small")].map(el => el.textContent)).toEqual([
      "小夏 · 0:03", "我 · 0:08", "speaker_9（身份待核对） · 0:13", "说话人未识别 · 0:20"
    ]);
    expect([...container.querySelectorAll(".qa-segment p")].map(el => el.textContent)).toEqual(day.segments.map(s => s.text));
    rerender(<QaReadingPaper {...props} fullSource={source} day={day} sourceSpeakerLabel={() => undefined}/>);
    expect(screen.getByText("speaker_0（身份待核对） · 0:03")).toBeVisible();
    expect(container.textContent).not.toContain("小夏");
  });

  it("keeps a saved fragment readable when the same segment has a different speaker, time or recording", () => {
    for (const change of [{ speakerId: "local_speaker_1" }, { startSeconds: 1 }, { uploadId: "other" }, { canOpenTranscript: false }]) {
      expect(verifiedDay({ ...source, ...change }, () => day)).toBeNull();
    }
    const fragment = { ...source, timeKnown: false, startSeconds: 0, canOpenTranscript: false };
    render(<QaReadingPaper {...props} day={null} evidence={{ ...props.evidence, sources: [fragment] }} sourceSpeakerLabel={label}/>);
    expect(screen.getByText(`“${source.quote}”`)).toBeVisible();
    expect(screen.queryByRole("button", { name: /全文/ })).toBeNull();
    expect(screen.queryByText(/0:00/)).toBeNull();
  });

  it("never offers recording speech or a full transcript for a user's saved self-report with matching words", () => {
    const selfReport = { ...source, sourceOrigin: "user_reflection" as const };
    expect(verifiedDay(selfReport, () => day)).toBeNull();
    render(<QaReadingPaper {...props} day={null} evidence={{ kind: "self-report", sources: [selfReport], text: source.quote }} sourceSpeakerLabel={label}/>);
    expect(screen.getByRole("heading", { name: "保存的自述" })).toBeVisible();
    expect(screen.queryByText(/小夏/)).toBeNull();
    expect(screen.queryByRole("button", { name: /全文/ })).toBeNull();
  });
});

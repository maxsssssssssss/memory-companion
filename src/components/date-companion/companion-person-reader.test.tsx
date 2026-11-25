import { describe, expect, it } from "vitest";
import type { DcInteractionDetail } from "@/lib/domain/date-companion-stage2";
import { personReaderSource } from "./companion-person-reader";
import { dateCompanionRetainedSourceKey } from "@/lib/client/date-companion-adapter";

const fragment = { id: "e1", uploadId: "u1", segmentId: "s1", evidenceId: "e1", date: "2026-11-04",
  presentation: "direct_quote" as const, quote: "我们一起印过这张。", subject: "both" as const };
const stamp = "2026-11-04T12:00:00.000Z";
const evidence = { id: "e1", uploadId: "u1", sourceSegmentId: "s1", recapItemId: "item",
  startSeconds: 10, endSeconds: 14, speakerId: "voice1", quote: fragment.quote, createdAt: stamp };
const detail: DcInteractionDetail = {
  id: "r1", relationshipId: "rel", sourceUploadId: "u1", originalName: "试印.wav", recordingDate: fragment.date,
  version: 1, status: "confirmed", sourceState: "server_cleaned", createdAt: stamp, updatedAt: stamp, confirmedAt: stamp,
  participants: [{ speakerId: "voice1", role: "self", confirmedAt: stamp }],
  recapItems: [{ id: "item", interactionId: "r1", kind: "moment", proposedText: "试印", displayedText: "共同印过",
    disposition: "kept", version: 1, sortOrder: 0, evidence: [evidence] }],
  memoryBridge: { status: "completed", retryable: false, updatedAt: stamp, attemptCount: 1 }
};
const line = { id: "s1", uploadId: "u1", startSeconds: 10, endSeconds: 14, speakerId: "voice1", text: fragment.quote };
const key = dateCompanionRetainedSourceKey(fragment.uploadId, fragment.segmentId);
const admission = { memoryRetainedSourceKeys: [key], retainedSubjects: { [key]: "both" as const } };

describe("formal person scrapbook reading", () => {
  it("labels only exact reviewed lines of the mixed group in the saved quote and the local full text", () => {
    const revised = structuredClone(detail);
    const digest = "c".repeat(64);
    revised.participants = [{ speakerId: "voice1", role: "unresolved", reviewedSegments: [
      {sourceSegmentId: "s1", contentDigest: digest, role: "companion"}
    ] }];
    revised.recapItems[0].evidence[0].contentDigest = digest;
    const result = personReaderSource(fragment, revised, [line, {...line, id: "s2", text: "这一段难以分开。"}], "小榆", admission);
    expect(result.speaker).toBe("小榆");
    expect(result.lines.map(item => item.speakerLabel)).toEqual(["小榆", "说话人待核对"]);
    revised.recapItems[0].evidence[0].contentDigest = "d".repeat(64);
    expect(personReaderSource(fragment, revised, [line], "小榆", admission).state).toBe("withdrawn");
  });
  it("separates the authenticated speaker from the retained memory's subject", () => {
    const source = personReaderSource(fragment, detail, [line], "小榆", admission);
    expect(source).toMatchObject({ state: "ok", speaker: "我", subject: "both", segmentId: "s1", time: "0:10" });
    expect(source.lines[0].speakerLabel).toBe("我");
  });
  it("keeps authorized fragments without a device transcript or a relationship recording", () => {
    expect(personReaderSource(fragment, detail, [], "小榆", admission)).toMatchObject({ text: fragment.quote, state: "ok", lines: [], segmentId: null });
    expect(personReaderSource({ ...fragment, evidenceId: undefined }, undefined, [line], "小榆", admission))
      .toMatchObject({ text: fragment.quote, speaker: null, time: null, lines: [], segmentId: null });
  });
  it.each([{ text: "不同的片段" }, { id: "s2" }, { speakerId: "other" }, { startSeconds: 11 }])(
    "keeps only the authorized saved words when the local segment has changed", change => {
      expect(personReaderSource(fragment, detail, [{ ...line, ...change }], "小榆", admission))
        .toMatchObject({ state: "mismatch", text: fragment.quote, lines: [], segmentId: null });
    });
  it("withholds an absent or revoked relationship source, even with a matching local day", () => {
    for (const record of [undefined, { ...detail, sourceState: "explicitly_deleted" as const },
      { ...detail, memoryBridge: undefined }, { ...detail, recapItems: [] }]) {
      expect(personReaderSource(fragment, record, [line], "小榆", admission)).toMatchObject({ state: "withdrawn", text: null, lines: [] });
    }
  });
  it("does not invent a signature for an unconfirmed identity or give its file to another recording", () => {
    expect(personReaderSource({ ...fragment, evidenceId: undefined }, { ...detail, participants: [] }, [line], "小榆", admission))
      .toMatchObject({ state: "pending", speaker: null, lines: [] });
    expect(personReaderSource(fragment, detail, [{ ...line, uploadId: "other" }], "小榆", admission).lines).toEqual([]);
  });
  it("rechecks the fresh detail's speaker and retention against the same rules as the directory", () => {
    const corrected = { ...detail, recapItems: [{ ...detail.recapItems[0], kind: "mentioned" as const }] };
    expect(personReaderSource(fragment, corrected, [line], "小榆", admission)).toMatchObject({ state: "withdrawn", text: null, lines: [] });
    expect(personReaderSource(fragment, detail, [line], "小榆", { ...admission, memoryRetainedSourceKeys: [] }))
      .toMatchObject({ state: "withdrawn", text: null, lines: [] });
  });
});

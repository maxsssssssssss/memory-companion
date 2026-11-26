import { describe, expect, it } from "vitest";
import { emptyDateCompanionViewModel, type InteractionVM, type SourceRefVM } from "@/lib/domain/date-companion";
import { buildNotebookPastClues, preparationSourceTime } from "./date-companion-notebook-materials";

const record: InteractionVM = { id: "upload-market", uploadIds: ["upload-market"], sourceUploadId: "upload-market", relationshipInteractionId: "record-market",
  recordingDate: "2026-11-12", fileName: "去看画的下午.m4a", title: "这次相处", status: "ready", transcript: [], persistenceStatus: "confirmed" };
const source: SourceRefVM = { id: "evidence-market", uploadId: record.id, segmentIds: ["segment-market"], recordingDate: record.recordingDate,
  startSeconds: 212, endSeconds: 218, speakerId: "speaker-self", quote: "我带上之前的展览册。", kind: "transcript", presentation: "direct_quote", canOpenTranscript: false };
const prepare = () => emptyDateCompanionViewModel().prepare;
const base = () => ({ prepare: prepare(), interactions: [record], relationshipName: "阿岚", speakerLabel: () => "我" });

describe("formal notebook past clue projection", () => {
  it("preserves the old page's exact four-group admission and final edited text", () => {
    const input = base();
    input.prepare.items = [
      { id: "fact-a", kind: "mentioned", title: "旧标题", proposedText: "旧摘要", displayedText: "最近在学木刻，暂时还没选作品。", disposition: "kept", sources: [source] },
      { id: "removed-a", kind: "moment", title: "移除", proposedText: "不应显示", displayedText: "不应显示", disposition: "excluded", sources: [source] },
      { id: "without-source", kind: "continue", title: "无来源", proposedText: "无依据", displayedText: "无依据", disposition: "kept", sources: [] },
      { id: "recap-promise", kind: "promise", title: "复盘约定", proposedText: "重复约定", displayedText: "重复约定", disposition: "kept", sources: [source] }
    ];
    input.prepare.openPromises = [
      { id: "promise-a", relationshipId: "relation-a", originatingRecapItemId: "recap-promise", text: "带上之前的展览册", status: "open", version: 1, sources: [source] },
      { id: "done-a", relationshipId: "relation-a", originatingRecapItemId: "done", text: "已经完成", status: "done", version: 1, sources: [source] }
    ];
    const projected = buildNotebookPastClues(input);
    expect(projected.clues?.map(clue => [clue.id, clue.group, clue.text])).toEqual([
      ["fact-a", "recent", "最近在学木刻，暂时还没选作品。"], ["promise-a", "promise", "带上之前的展览册"]
    ]);
    expect(projected.records?.[0]).toMatchObject({ id: "record-market", title: record.fileName, fullTranscript: false });
    expect(projected.records?.[0].sourceDetails?.[source.id]).toEqual({ presentation: "direct_quote", speakerLabel: "我", time: "3:32" });
    expect(projected.clues?.[0].sources[0].href).toContain("interaction=record-market&segment=segment-market");
  });

  it("keeps derived prose distinct and does not fabricate a timestamp or confirmed speaker", () => {
    const input = base(); input.speakerLabel = () => "";
    input.prepare.items = [{ id: "suggestion-a", kind: "continue", title: "建议", proposedText: "之后可以问问近况。", displayedText: "之后可以问问近况。",
      disposition: "kept", sources: [{ ...source, presentation: "derived_summary", kind: "semantic", startSeconds: Number.NaN }] }];
    const projected = buildNotebookPastClues(input);
    expect(projected.records?.[0].sourceDetails?.[source.id]).toEqual({ presentation: "derived_summary" });
    expect(projected.records?.[0].segments[0].time).toBe("");
    expect(projected.clues?.[0].sources[0].speakerRole).toBeUndefined();
    expect(preparationSourceTime(-1)).toBeUndefined();
  });

  it("does not invent a record destination from an upload ID without a formal interaction mapping", () => {
    const input = base(); input.interactions = []; input.prepare.items = [{ id: "item-a", kind: "mentioned", title: "近况", proposedText: "旧摘要", displayedText: "旧摘要", disposition: "kept", sources: [source] }];
    const projected = buildNotebookPastClues(input);
    expect(projected.clues?.[0].sources[0]).toMatchObject({ interactionId: "", quote: source.quote, href: "" });
    expect(projected.records).toEqual([]);
  });
});

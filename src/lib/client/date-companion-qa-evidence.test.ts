import { describe, expect, it } from "vitest";
import type { QuestionAnswer } from "@/lib/domain/types";
import { bindQaAnswerSources, currentQaAnswerEvidenceStatus, currentQaCitationEvidenceStatus, qaPriorCitations, resolveQaPaperCitation } from "./date-companion-qa-evidence";
import type { SourceRefVM } from "@/lib/domain/date-companion";

const citation = {
  id: "E1", title: "speaker_2 的原始转写", startSeconds: 10, endSeconds: 15,
  excerpt: "原先说的句子。", sourceSegmentIds: ["segment_2"]
};
const answer: QuestionAnswer = {
  id: "old_answer", uploadId: "recording_a", question: "聊了什么？", answer: "以前的回答。",
  citations: [citation], citedSegmentIds: ["segment_2"], createdAt: "2026-11-08T12:00:00.000Z"
};

describe("current interaction answer evidence", () => {
  it("distinguishes changed raw sources from an unavailable local transcript", () => {
    expect(currentQaCitationEvidenceStatus(citation, new Map([["segment_2", "现在保存的另一句。"]]))).toBe("changed");
    expect(currentQaCitationEvidenceStatus(citation, new Map())).toBe("unavailable");
    expect(currentQaCitationEvidenceStatus(citation, undefined)).toBe("unverified");
  });

describe("paper citations", () => {
  it("does not revive old citations or prior context when identical text is granted again", () => {
    const before = bindQaAnswerSources(answer,[source]);
    const granted = {...source, authorizationRevision:"a".repeat(64)};
    expect(resolveQaPaperCitation(before.citations![0],[granted]).kind).toBe("unavailable");
    expect(qaPriorCitations([answer,before],[granted])).toEqual([]);
    const after = bindQaAnswerSources(answer,[granted]);
    expect(resolveQaPaperCitation(after.citations![0],[granted]).kind).toBe("quote");
    expect(qaPriorCitations([after],[granted])[0]).toMatchObject({authorizationRevision:granted.authorizationRevision});
    expect(qaPriorCitations([after],[{...granted,authorizationRevision:"b".repeat(64)}])).toEqual([]);
  });
  const source: SourceRefVM = {id:"snapshot", uploadId:"recording_a", segmentIds:["segment_2"], quote:citation.excerpt,
    kind:"transcript", presentation:"direct_quote", recordingDate:"", startSeconds:0, endSeconds:2,
    canOpenTranscript:false, contentDigest:"version-a"};
  it("retains the recording and evidence revision even when the answer belongs to a person", () => {
    const saved = bindQaAnswerSources({...answer, uploadId:"person-a"}, [source]).citations![0];
    expect(resolveQaPaperCitation(saved, [source])).toMatchObject({kind:"quote", sources:[source]});
    for (const changed of [{...source, uploadId:"other"}, {...source, contentDigest:"version-b"}, {...source, quote:"改过的文字"}]) {
      expect(resolveQaPaperCitation(saved, [changed]).kind).toBe("unavailable");
    }
    expect(resolveQaPaperCitation(saved, []).sources).toEqual([]);
    expect(resolveQaPaperCitation(saved, [source, {...source, uploadId:"other"}]).kind).toBe("unavailable");
  });
  it("distinguishes self-report, derived content and several underlying segments", () => {
    expect(resolveQaPaperCitation(citation, [{...source, sourceOrigin:"user_reflection"}]).kind).toBe("self-report");
    expect(resolveQaPaperCitation({...citation,evidenceKind:"audio"}, [source]).kind).toBe("derived");
    const other = {...source,id:"s3",segmentIds:["s3"],quote:"另一条。"};
    const multi = {...citation,title:"一次概括",excerpt:"两段的概括",sourceSegmentIds:["segment_2","s3"],evidenceKind:"semantic" as const};
    const saved = bindQaAnswerSources({...answer,citations:[multi]},[source,other]).citations![0];
    expect(resolveQaPaperCitation(saved,[source,other])).toEqual({kind:"derived",text:"两段的概括",sources:[source,other]});
    expect(resolveQaPaperCitation(saved,[source]).kind).toBe("unavailable");
  });
});

  it("accepts formal whitespace compaction and 220-character truncation", () => {
    expect(currentQaCitationEvidenceStatus({ ...citation, excerpt: "一起 看书。" }, new Map([["segment_2", "一起\n  看书。"]]))).toBe("current");
    const long = "书店里的一段完整原话。".repeat(30);
    expect(currentQaCitationEvidenceStatus({ ...citation, excerpt: long.slice(0, 219) + "…" }, new Map([["segment_2", long]]))).toBe("current");
    expect(currentQaCitationEvidenceStatus({ ...citation, excerpt: "书店里…" }, new Map([["segment_2", long]]))).toBe("changed");
  });

  it("does not mistake a legitimate summary, navigation or unknown legacy excerpt for changed speech", () => {
    const texts = new Map([["segment_2", "我们下周到书店去。"]]);
    expect(currentQaCitationEvidenceStatus({ ...citation, title: "下周的安排" }, texts)).toBe("unverified");
    expect(currentQaCitationEvidenceStatus({ ...citation, contentKind: "user_confirmed_derived_content" }, texts)).toBe("unverified");
    expect(currentQaCitationEvidenceStatus({ ...citation, contentKind: "memory_navigation" }, texts)).toBe("unverified");
  });

  it("does not trust identical segment IDs from a different recording", () => {
    expect(currentQaAnswerEvidenceStatus(answer, new Map([["segment_2", citation.excerpt]]), "recording_b")).toBe("unavailable");
    expect(currentQaAnswerEvidenceStatus(answer, new Map([["segment_2", citation.excerpt]]), "recording_a")).toBe("current");
  });
});

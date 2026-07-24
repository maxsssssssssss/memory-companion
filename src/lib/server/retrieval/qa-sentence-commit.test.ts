import { describe, expect, it } from "vitest";

import type { QuestionAnswer } from "@/lib/domain/types";
import {
  createSentenceCommitManager,
  splitSentenceCommitUnits,
  summarizeSentenceCommits
} from "./qa-sentence-commit";

function answer(overrides: Partial<QuestionAnswer> = {}): QuestionAnswer {
  return {
    id: "answer_1",
    uploadId: "upload_1",
    question: "今天确认了什么？",
    answer: "已经确认周日下午的安排。[E1]",
    citedSegmentIds: ["segment_1"],
    citations: [{
      id: "E1",
      title: "周日下午安排",
      startSeconds: 10,
      endSeconds: 20,
      excerpt: "已经确认周日下午的安排。",
      sourceSegmentIds: ["segment_1"]
    }],
    createdAt: "2026-07-22T10:00:00.000Z",
    ...overrides
  };
}

function manager() {
  return createSentenceCommitManager({
    evidence: [
      { citationId: "E1", supportIds: ["segment_1"] },
      { citationId: "E2", supportIds: ["segment_2", "segment_shared"] }
    ]
  });
}

describe("SentenceCommitManager sentence boundaries", () => {
  it("splits Chinese and ASCII boundaries while keeping immediate citations aligned", () => {
    expect(splitSentenceCommitUnits("第一句。[E1] 第二句！[E2] Is this final? [E1] Yes; [E2]"))
      .toEqual([
        "第一句。[E1]",
        "第二句！[E2]",
        "Is this final? [E1]",
        "Yes; [E2]"
      ]);
  });

  it("keeps citations that arrive across token boundaries with the preceding sentence", () => {
    const commitManager = manager();

    const first = commitManager.ingestDelta('{"mode":"memory_answer","answer":"已经确认。');
    const second = commitManager.ingestDelta('[E');
    const third = commitManager.ingestDelta('1] 后续仍未知","citationIds":["E1"]}');

    expect(first.candidates).toEqual([]);
    expect(second.candidates).toEqual([]);
    expect(third.candidates.map((candidate) => candidate.sentence)).toEqual([
      "已经确认。[E1]"
    ]);
    expect(third.candidates.every((candidate) => candidate.safeForSpeech === false)).toBe(true);
  });

  it("does not attach a citation across a blank paragraph", () => {
    expect(splitSentenceCommitUnits("第一句。\n\n[E1] 第二句。[E2]"))
      .toEqual(["第一句。", "[E1] 第二句。[E2]"]);
  });

  it("keeps a semicolon clause with the following text until a hard boundary", () => {
    expect(splitSentenceCommitUnits("A；B。[E1]"))
      .toEqual(["A；B。[E1]"]);
    expect(splitSentenceCommitUnits("A，B。[E1]"))
      .toEqual(["A，B。[E1]"]);
  });

  it("keeps hard-boundary sentences as separate units", () => {
    expect(splitSentenceCommitUnits("A。[E1] B。[E2]"))
      .toEqual(["A。[E1]", "B。[E2]"]);
  });

  it("allows an explicit citation to close a soft-boundary unit", () => {
    expect(splitSentenceCommitUnits("A；[E1] B。[E2]"))
      .toEqual(["A；[E1]", "B。[E2]"]);
  });

  it("treats a newline as a hard boundary", () => {
    expect(splitSentenceCommitUnits("A[E1]\nB。[E2]"))
      .toEqual(["A[E1]", "B。[E2]"]);
  });

  it("handles escaped JSON string content without treating JSON syntax as answer text", () => {
    const commitManager = manager();
    const snapshot = commitManager.ingestDelta(
      '{"mode":"memory_answer","answer":"她说\\\"已经确认。\\\"[E1] 下一句还没结束","citationIds":["E1"]}'
    );

    expect(snapshot.candidates.map((candidate) => candidate.sentence)).toEqual([
      '她说"已经确认。"[E1]'
    ]);
  });
});

describe("SentenceCommitManager citation alignment", () => {
  it("commits a semicolon compound sentence as one grounded unit", () => {
    const commits = manager().commitValidatedAnswer(answer({
      answer: "A；B。[E1]"
    }));

    expect(commits).toEqual([expect.objectContaining({
      sequence: 1,
      sentence: "A；B。",
      citationIds: ["E1"],
      supportIds: ["segment_1"],
      status: "committed",
      reason: "grounded"
    })]);
  });

  it("commits two independently grounded hard-boundary sentences", () => {
    const commits = manager().commitValidatedAnswer(answer({
      answer: "A。[E1] B。[E2]",
      citedSegmentIds: ["segment_1", "segment_2", "segment_shared"],
      citations: [
        {
          id: "E1",
          title: "A",
          startSeconds: 10,
          endSeconds: 20,
          excerpt: "A。",
          sourceSegmentIds: ["segment_1"]
        },
        {
          id: "E2",
          title: "B",
          startSeconds: 20,
          endSeconds: 30,
          excerpt: "B。",
          sourceSegmentIds: ["segment_2", "segment_shared"]
        }
      ]
    }));

    expect(commits).toHaveLength(2);
    expect(commits.every((commit) => commit.status === "committed")).toBe(true);
    expect(commits.map((commit) => commit.reason)).toEqual(["grounded", "grounded"]);
  });

  it("maps an allowlisted citation to current evidence support IDs", () => {
    const commits = manager().commitValidatedAnswer(answer());

    expect(commits).toEqual([expect.objectContaining({
      sequence: 1,
      sentence: "已经确认周日下午的安排。",
      citationIds: ["E1"],
      supportIds: ["segment_1"],
      validated: true,
      groundingValidated: true,
      safeForSpeech: false,
      status: "committed"
    })]);
  });

  it("deduplicates repeated citations and support IDs in first-seen order", () => {
    const commits = manager().commitValidatedAnswer(answer({
      answer: "已经确认。[E2][E1][E2]",
      citedSegmentIds: ["segment_2", "segment_shared", "segment_1"],
      citations: [
        {
          id: "E2",
          title: "确认",
          startSeconds: 20,
          endSeconds: 30,
          excerpt: "已经确认。",
          sourceSegmentIds: ["segment_2", "segment_shared"]
        },
        {
          id: "E1",
          title: "安排",
          startSeconds: 10,
          endSeconds: 20,
          excerpt: "安排",
          sourceSegmentIds: ["segment_1"]
        }
      ]
    }));

    expect(commits[0]).toMatchObject({
      citationIds: ["E2", "E1"],
      supportIds: ["segment_2", "segment_shared", "segment_1"],
      groundingValidated: true,
      safeForSpeech: false
    });
  });

  it.each([
    ["越界引用。[E99]", "invalid_citation"],
    ["混合引用。[E1][E99]", "invalid_citation"],
    ["Memory 标签。[M1]", "invalid_citation"],
    ["小写引用。[e1]", "invalid_citation"],
    ["前导零引用。[E01]", "invalid_citation"],
    ["标点污染。[E1,][E1]", "invalid_citation"],
    ["范围引用。[E1/E2][E1]", "invalid_citation"],
    ["空格引用。[E 2][E1]", "invalid_citation"],
    ["嵌套引用。[[E2]][E1]", "invalid_citation"],
    ["全角引用。［E2］[E1]", "invalid_citation"]
  ])("withholds unsupported citation form: %s", (sentence, reason) => {
    const [commit] = manager().commitValidatedAnswer(answer({ answer: sentence }));

    expect(commit).toMatchObject({
      supportIds: [],
      safeForSpeech: false,
      status: "withheld",
      reason
    });
  });

  it("withholds a sentence when inline citations disagree with final citation metadata", () => {
    const [commit] = manager().commitValidatedAnswer(answer({
      answer: "已经确认。[E1]",
      citedSegmentIds: ["segment_2", "segment_shared"],
      citations: [{
        id: "E2",
        title: "其他事项",
        startSeconds: 20,
        endSeconds: 30,
        excerpt: "其他事项",
        sourceSegmentIds: ["segment_2", "segment_shared"]
      }]
    }));

    expect(commit).toMatchObject({
      safeForSpeech: false,
      status: "withheld",
      reason: "citation_metadata_mismatch"
    });
  });

  it("does not guess sentence support from response-level citations", () => {
    const [commit] = manager().commitValidatedAnswer(answer({
      answer: "已经确认周日下午的安排。"
    }));

    expect(commit).toMatchObject({
      citationIds: [],
      supportIds: [],
      safeForSpeech: false,
      status: "withheld",
      reason: "missing_sentence_support"
    });
  });

  it("withholds the whole response when global citations contain extra support", () => {
    const commits = manager().commitValidatedAnswer(answer({
      answer: "已经确认。[E1]",
      citedSegmentIds: ["segment_1", "segment_2", "segment_shared"],
      citations: [
        {
          id: "E1",
          title: "安排",
          startSeconds: 10,
          endSeconds: 20,
          excerpt: "已经确认。",
          sourceSegmentIds: ["segment_1"]
        },
        {
          id: "E2",
          title: "额外事项",
          startSeconds: 20,
          endSeconds: 30,
          excerpt: "额外事项",
          sourceSegmentIds: ["segment_2", "segment_shared"]
        }
      ]
    }));

    expect(commits).toEqual([expect.objectContaining({
      safeForSpeech: false,
      status: "withheld",
      reason: "citation_metadata_mismatch"
    })]);
  });

  it("rejects duplicate evidence and final citation IDs instead of using last-write-wins", () => {
    expect(() => createSentenceCommitManager({
      evidence: [
        { citationId: "E1", supportIds: ["segment_1"] },
        { citationId: "E1", supportIds: ["segment_2"] }
      ]
    })).toThrow(/duplicate citation ID/u);

    const commits = manager().commitValidatedAnswer(answer({
      citations: [
        {
          id: "E1",
          title: "冲突 A",
          startSeconds: 10,
          endSeconds: 20,
          excerpt: "A",
          sourceSegmentIds: ["segment_2"]
        },
        {
          id: "E1",
          title: "冲突 B",
          startSeconds: 20,
          endSeconds: 30,
          excerpt: "B",
          sourceSegmentIds: ["segment_1"]
        }
      ]
    }));

    expect(commits[0]).toMatchObject({
      safeForSpeech: false,
      reason: "citation_metadata_mismatch"
    });
  });

  it("normalizes trusted support ID whitespace before comparison and output", () => {
    const commitManager = createSentenceCommitManager({
      evidence: [{ citationId: "E1", supportIds: [" segment_1 ", "segment_1"] }]
    });

    expect(commitManager.commitValidatedAnswer(answer())[0]).toMatchObject({
      supportIds: ["segment_1"],
      groundingValidated: true,
      safeForSpeech: false
    });
  });

  it("does not release one sentence when another sentence lacks local support", () => {
    const commits = manager().commitValidatedAnswer(answer({
      answer: "已经确认。[E1] 但长期结果仍未知。"
    }));

    expect(commits).toHaveLength(2);
    expect(commits.every((commit) => commit.groundingValidated === false)).toBe(true);
    expect(commits[0]?.reason).toBe("response_not_fully_committable");
    expect(commits[1]?.reason).toBe("missing_sentence_support");
  });

  it("keeps an unsupported uncertainty sentence fail-closed", () => {
    const commits = manager().commitValidatedAnswer(answer({
      answer: "目前没有证据证明已经完成。现有证据只支持计划。[E1]"
    }));

    expect(commits).toHaveLength(2);
    expect(commits.every((commit) => commit.status === "withheld")).toBe(true);
    expect(commits.map((commit) => commit.reason)).toEqual([
      "missing_sentence_support",
      "response_not_fully_committable"
    ]);
  });

  it("continues to fail closed for an unknown citation", () => {
    const commits = manager().commitValidatedAnswer(answer({
      answer: "错误引用。[E99]"
    }));

    expect(commits).toEqual([expect.objectContaining({
      citationIds: ["E99"],
      supportIds: [],
      status: "withheld",
      reason: "invalid_citation"
    })]);
  });

  it("summarizes only content-free final commit outcomes", () => {
    const commits = manager().commitValidatedAnswer(answer({
      answer: "目前没有证据证明已经完成。现有证据只支持计划。[E1]"
    }));

    expect(summarizeSentenceCommits(commits)).toEqual({
      sentenceUnits: 2,
      committedUnits: 0,
      missingSentenceSupport: 1,
      citationMetadataMismatch: 0,
      responseNotFullyCommittable: 1
    });
  });
});

describe("SentenceCommitManager fail-closed behavior", () => {
  it("releases a grounded first sentence before the complete JSON answer arrives", () => {
    const commitManager = manager();

    commitManager.ingestDelta(
      '{"mode":"memory_answer","answer":"Confirmed the plan.[E1] The later status'
    );

    expect(commitManager.drainCommitted()).toEqual([
      expect.objectContaining({
        sequence: 1,
        sentence: "Confirmed the plan.",
        citationIds: ["E1"],
        supportIds: ["segment_1"],
        citedSegmentIds: ["segment_1"],
        groundingValidated: true,
        status: "committed"
      })
    ]);
    expect(commitManager.snapshot().state).toBe("open");
  });

  it("keeps a validated prefix while quarantining a later invalid sentence", () => {
    const commitManager = manager();

    commitManager.ingestDelta(
      '{"mode":"memory_answer","answer":"Confirmed the plan.[E1] Later claim.[E99]","citationIds":["E1"]}'
    );

    expect(commitManager.drainCommitted()).toEqual([
      expect.objectContaining({
        sentence: "Confirmed the plan.",
        supportIds: ["segment_1"],
        groundingValidated: true
      })
    ]);
    expect(commitManager.drainCommitted()).toEqual([]);
  });

  it("does not early-release unsupported or assistant-meta modes", () => {
    const unsupported = manager();
    unsupported.ingestDelta(
      '{"mode":"unsupported","answer":"There is no completion evidence.[E1]","citationIds":["E1"]}'
    );
    expect(unsupported.drainCommitted()).toEqual([]);

    const assistantMeta = manager();
    assistantMeta.ingestDelta(
      '{"mode":"assistant_meta","answer":"I can help.[E1]","citationIds":["E1"]}'
    );
    expect(assistantMeta.drainCommitted()).toEqual([]);
  });

  it("applies the deterministic policy gate after citation mapping", () => {
    const commitManager = createSentenceCommitManager({
      evidence: [{ citationId: "E1", supportIds: ["segment_1"] }],
      validateProvisionalSentence: (candidate) =>
        candidate.sentence.includes("ownership")
          ? "safety_boundary"
          : null
    });

    commitManager.ingestDelta(
      '{"mode":"memory_answer","answer":"Unsupported ownership claim.[E1]","citationIds":["E1"]}'
    );

    expect(commitManager.drainCommitted()).toEqual([]);
  });

  it("never exposes a provisional sentence as speech-safe", () => {
    const commitManager = manager();
    const snapshot = commitManager.ingestDelta(
      '{"mode":"memory_answer","answer":"未经最终校验的句子。[E1]'
    );

    expect(snapshot.candidates).toEqual([
      expect.objectContaining({
        sentence: "未经最终校验的句子。[E1]",
        safeForSpeech: false,
        validated: false
      })
    ]);
    expect(commitManager.cancel("provider_stream_error")).toBe(true);
    expect(commitManager.getCommitted()).toEqual([]);
  });

  it("is idempotent for the same validated answer and rejects late deltas", () => {
    const commitManager = manager();
    const first = commitManager.commitValidatedAnswer(answer());
    const second = commitManager.commitValidatedAnswer(answer());

    expect(second).toEqual(first);
    expect(() => commitManager.ingestDelta("late data")).toThrow(/finalized/u);
  });
});

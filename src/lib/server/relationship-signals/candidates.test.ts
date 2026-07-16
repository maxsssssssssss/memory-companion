// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "@/lib/domain/types";
import type { RawRelationshipSignalItem } from "@/lib/processing/relationship-signals";
import {
  reduceRelationshipSignalCandidates,
  type RelationshipSignalCandidate
} from "./candidates";

const uploadId = "upload_relationship_reducer";
const recordingDate = "2026-07-15";

function segment(id: string, chunkIndex: number, text: string): TranscriptSegment {
  return {
    id,
    uploadId,
    startSeconds: chunkIndex * 300 + 10,
    endSeconds: chunkIndex * 300 + 20,
    speaker: chunkIndex % 2 === 0 ? "speaker_1" : "speaker_2",
    text,
    confidence: 0.95,
    sceneLabels: [],
    valueLabels: []
  };
}

function candidate(input: {
  id: string;
  chunkIndex: number;
  signalType: RawRelationshipSignalItem["signalType"];
  summary: string;
  evidence: TranscriptSegment[];
  confidence?: number;
}): RelationshipSignalCandidate {
  return {
    id: input.id,
    uploadId,
    transcriptChunkId: `${uploadId}_chunk_${input.chunkIndex}`,
    chunkIndex: input.chunkIndex,
    item: {
      signalType: input.signalType,
      signalCategory: "positive",
      severity: "low",
      confidence: input.confidence ?? 0.82,
      summary: input.summary,
      explanation: `${input.summary}，这里只描述当前证据。`,
      involvedSpeakers: [...new Set(input.evidence.flatMap((item) => item.speaker ? [item.speaker] : []))],
      evidenceSegmentIds: input.evidence.map((item) => item.id),
      evidenceSegments: [],
      counterEvidence: [],
      acousticEvidence: [],
      textEvidence: input.evidence.map((item) => item.text),
      interactionEvidence: [],
      suggestedReflection: "之后可以回看这件具体事情的进展。"
    }
  };
}

function reduce(candidates: RelationshipSignalCandidate[], segments: TranscriptSegment[]) {
  const context = segment("relationship_context", 9, "这是一段关系互动记录，只描述当前证据。" );
  return reduceRelationshipSignalCandidates({
    uploadId,
    recordingDate,
    candidates,
    segments: [...segments, context],
    semanticSegments: [],
    audioInsights: [],
    createdAt: "2026-07-15T12:00:00.000Z"
  });
}

describe("relationship candidate reducer quality", () => {
  it("merges paraphrased candidates for the same event across adjacent chunks", () => {
    const first = segment("resume_1", 1, "我答应周六晚上八点前帮你检查简历项目描述。" );
    const second = segment("resume_2", 2, "周六八点前我会把简历批注版放回共享文件夹。" );
    const result = reduce([
      candidate({ id: "candidate_1", chunkIndex: 1, signalType: "clear_commitment", summary: "给出了检查简历的明确期限。", evidence: [first] }),
      candidate({ id: "candidate_2", chunkIndex: 2, signalType: "clear_commitment", summary: "再次确认简历批注的返回时间。", evidence: [second] })
    ], [first, second]);

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].evidenceSegments.map((item) => item.segmentId)).toEqual(["resume_1", "resume_2"]);
  });

  it("merges the same event even when confirming chunks are not adjacent", () => {
    const first = segment("resume_early", 0, "我周六晚上八点前检查你的简历。" );
    const later = segment("resume_later", 6, "简历还是按周六八点前返回批注的约定。" );
    const result = reduce([
      candidate({ id: "candidate_early", chunkIndex: 0, signalType: "clear_commitment", summary: "确认简历检查安排。", evidence: [first] }),
      candidate({ id: "candidate_later", chunkIndex: 6, signalType: "clear_commitment", summary: "重新确认简历批注期限。", evidence: [later] })
    ], [first, later]);

    expect(result.cards).toHaveLength(1);
  });

  it("does not merge different signal types just because the topic is shared", () => {
    const commitment = segment("pause_1", 3, "暂停前我会说明十分钟后回来继续沟通。" );
    const boundary = segment("pause_2", 3, "我接受你先暂停十分钟，也不会连续追问。" );
    const result = reduce([
      candidate({ id: "candidate_commitment", chunkIndex: 3, signalType: "clear_commitment", summary: "约定暂停后的返回时间。", evidence: [commitment] }),
      candidate({ id: "candidate_boundary", chunkIndex: 3, signalType: "boundary_respect", summary: "尊重暂停期间不被追问的边界。", evidence: [boundary] })
    ], [commitment, boundary]);

    expect(result.cards.map((card) => card.signalType).sort()).toEqual(["boundary_respect", "clear_commitment"]);
  });

  it("does not merge different events with the same signal type", () => {
    const resume = segment("resume_event", 1, "我周六前检查简历。" );
    const museum = segment("museum_event", 2, "我今晚查博物馆的预约时间。" );
    const result = reduce([
      candidate({ id: "candidate_resume", chunkIndex: 1, signalType: "clear_commitment", summary: "确认简历检查安排。", evidence: [resume] }),
      candidate({ id: "candidate_museum", chunkIndex: 2, signalType: "clear_commitment", summary: "确认博物馆预约查询安排。", evidence: [museum] })
    ], [resume, museum]);

    expect(result.cards).toHaveLength(2);
  });

  it("keeps independent actions separate even when they share one transcript segment", () => {
    const source = segment(
      "two_actions_one_segment",
      2,
      "我今晚查询博物馆预约时间，另外周六晚上八点前帮你检查简历。"
    );
    const result = reduce([
      candidate({
        id: "candidate_museum_same_segment",
        chunkIndex: 2,
        signalType: "clear_commitment",
        summary: "今晚查询博物馆预约开放时间。",
        evidence: [source]
      }),
      candidate({
        id: "candidate_resume_same_segment",
        chunkIndex: 2,
        signalType: "clear_commitment",
        summary: "周六晚上八点前检查简历。",
        evidence: [source]
      })
    ], [source]);

    expect(result.cards).toHaveLength(2);
    expect(new Set(result.audit.candidates.map((item) => item.clusterId)).size).toBe(2);
  });

  it("rejects a weak generic candidate instead of letting it crowd out grounded evidence", () => {
    const weak = segment("weak_1", 0, "嗯，我知道了。" );
    const strongA = segment("strong_1", 1, "你担心的是需求一直变化，很难建立确定节奏，对吗？" );
    const strongB = segment("strong_2", 1, "对，你这样复述以后我觉得被听明白了。" );
    const result = reduce([
      candidate({ id: "candidate_weak", chunkIndex: 0, signalType: "active_listening", summary: "回应里可能有倾听。", evidence: [weak], confidence: 0.4 }),
      candidate({ id: "candidate_strong", chunkIndex: 1, signalType: "active_listening", summary: "复述并确认了对方关于工作变化的具体担忧。", evidence: [strongA, strongB], confidence: 0.88 })
    ], [weak, strongA, strongB]);

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].evidenceSegments.map((item) => item.segmentId)).toEqual(["strong_1", "strong_2"]);
  });

  it("does not treat many evidence rows as a substitute for a specific observation", () => {
    const evidence = Array.from({ length: 8 }, (_, index) =>
      segment(`generic_${index}`, index, `第 ${index + 1} 段里有一次普通回应。`)
    );
    const result = reduce([
      candidate({
        id: "candidate_generic_many_rows",
        chunkIndex: 0,
        signalType: "active_listening",
        summary: "回应里出现了复述和确认对方感受的线索。",
        evidence,
        confidence: 0.7
      })
    ], evidence);

    expect(result.cards).toEqual([]);
    expect(result.audit.candidates[0]).toMatchObject({
      selected: false,
      rejectionReason: "insufficient_specificity"
    });
    expect(result.audit.candidates[0].score.genericityPenalty).toBeGreaterThan(0);
  });

  it("quality-gates ordinary chat and generic support while retaining specific support", () => {
    const greeting = segment("greeting", 0, "你好，今天天气不错。" );
    const genericSupport = segment("generic_support", 0, "我支持你。" );
    const concern = segment("specific_concern", 1, "我担心项目反复变更，晚上一直睡不着。" );
    const response = segment("specific_response", 1, "听起来你担心的是失去确定节奏，我可以先陪你把最急的部分理清。" );
    const result = reduce([
      candidate({ id: "candidate_greeting", chunkIndex: 0, signalType: "active_listening", summary: "普通寒暄里有回应。", evidence: [greeting] }),
      candidate({ id: "candidate_generic_support", chunkIndex: 0, signalType: "emotional_support", summary: "表达了支持。", evidence: [genericSupport] }),
      candidate({ id: "candidate_specific_support", chunkIndex: 1, signalType: "emotional_support", summary: "确认了项目反复变化带来的具体担忧，并提出陪伴梳理。", evidence: [concern, response], confidence: 0.88 })
    ], [greeting, genericSupport, concern, response]);

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].evidenceSegments.map((item) => item.segmentId)).toEqual(["specific_concern", "specific_response"]);
    expect(result.audit.candidates).toHaveLength(3);
    expect(result.audit.candidates.filter((item) => item.selected).map((item) => item.candidateId)).toEqual(["candidate_specific_support"]);
  });

  it("rejects extended small talk but retains concise support with a concrete action", () => {
    const smallTalk = segment(
      "extended_small_talk",
      0,
      "早上好，今天天气不错。路上通勤堵不堵？吃饭了吗？最近怎么样？"
    );
    const concreteSupport = segment(
      "concrete_support",
      1,
      "材料我先帮你看并整理重点，你去休息，晚一点我把修改建议发给你。"
    );
    const result = reduce([
      candidate({
        id: "candidate_extended_small_talk",
        chunkIndex: 0,
        signalType: "active_listening",
        summary: "双方聊了天气、通勤和吃饭，并互相询问近况。",
        evidence: [smallTalk],
        confidence: 0.84
      }),
      candidate({
        id: "candidate_concrete_support",
        chunkIndex: 1,
        signalType: "emotional_support",
        summary: "主动帮忙检查材料并约定返回修改建议，让对方先休息。",
        evidence: [concreteSupport],
        confidence: 0.68
      })
    ], [smallTalk, concreteSupport]);

    expect(result.cards).toHaveLength(1);
    expect(result.audit.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: "candidate_extended_small_talk", selected: false, rejectionReason: "generic_low_information" }),
      expect.objectContaining({ candidateId: "candidate_concrete_support", selected: true })
    ]));
  });

  it.each([
    "最近工作忙不忙？家里人都好吗？",
    "工作还顺利吗？家里最近都好吧？"
  ])("does not treat broad work or family check-ins as substantive relationship evidence: %s", (text) => {
    const smallTalk = segment(
      "broad_topic_small_talk",
      0,
      text
    );
    const result = reduce([
      candidate({
        id: "candidate_broad_topic_small_talk",
        chunkIndex: 0,
        signalType: "active_listening",
        summary: "主动询问了工作和家人的近况，并对对方的回答保持关注。",
        evidence: [smallTalk],
        confidence: 0.86
      })
    ], [smallTalk]);

    expect(result.cards).toEqual([]);
    expect(result.audit.candidates).toEqual([
      expect.objectContaining({
        candidateId: "candidate_broad_topic_small_talk",
        selected: false,
        rejectionReason: "generic_low_information",
        clusterId: null
      })
    ]);
  });

  it("recognizes paraphrased future commitments and boundary-respect actions", () => {
    const commitment = segment("commitment_paraphrase", 1, "三天内把修改稿发给你。" );
    const boundary = segment("boundary_paraphrase", 2, "好，先这样，我不再问了，等你准备好再说。" );
    const result = reduce([
      candidate({
        id: "candidate_commitment_paraphrase",
        chunkIndex: 1,
        signalType: "clear_commitment",
        summary: "约定三天内发送修改稿。",
        evidence: [commitment]
      }),
      candidate({
        id: "candidate_boundary_paraphrase",
        chunkIndex: 2,
        signalType: "boundary_respect",
        summary: "接受先停止追问并等待对方准备好。",
        evidence: [boundary]
      })
    ], [commitment, boundary]);

    expect(result.cards.map((card) => card.signalType).sort()).toEqual(["boundary_respect", "clear_commitment"]);
  });

  it("keeps candidate-to-card audit provenance when another candidate has no speaker", () => {
    const withSpeaker = segment("valid_speaker", 1, "明天晚上我帮你检查申请材料。" );
    const { speaker: _speaker, ...withoutSpeaker } = segment(
      "missing_speaker",
      0,
      "今晚我会查询预约时间。"
    );
    const result = reduce([
      candidate({
        id: "candidate_missing_speaker",
        chunkIndex: 0,
        signalType: "clear_commitment",
        summary: "今晚查询预约时间。",
        evidence: [withoutSpeaker]
      }),
      candidate({
        id: "candidate_valid_speaker",
        chunkIndex: 1,
        signalType: "clear_commitment",
        summary: "明天晚上检查申请材料。",
        evidence: [withSpeaker]
      })
    ], [withoutSpeaker, withSpeaker]);

    expect(result.cards).toHaveLength(1);
    expect(result.candidateIdsByCardId[result.cards[0].id]).toEqual(["candidate_valid_speaker"]);
    expect(result.audit.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: "candidate_missing_speaker", selected: false, rejectionReason: "speaker_missing" }),
      expect.objectContaining({ candidateId: "candidate_valid_speaker", selected: true })
    ]));
  });

  it("audits invalid source ids and non-verbatim candidate quotes", () => {
    const source = segment("source_1", 2, "我答应周六晚上检查并回复简历。" );
    const invalidSource = candidate({ id: "candidate_invalid_source", chunkIndex: 2, signalType: "clear_commitment", summary: "约定检查简历。", evidence: [source] });
    invalidSource.item.evidenceSegmentIds = ["missing_source"];
    const invalidQuote = candidate({ id: "candidate_invalid_quote", chunkIndex: 2, signalType: "clear_commitment", summary: "约定检查简历。", evidence: [source] });
    invalidQuote.item.textEvidence = ["这不是逐字引文"];

    const result = reduce([invalidSource, invalidQuote], [source]);

    expect(result.cards).toEqual([]);
    expect(result.audit.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: "candidate_invalid_source", selected: false, rejectionReason: "evidence_missing_or_invalid" }),
      expect.objectContaining({ candidateId: "candidate_invalid_quote", selected: false, rejectionReason: "evidence_quote_not_traceable" })
    ]));
  });
});

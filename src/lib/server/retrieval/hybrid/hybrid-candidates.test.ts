import { describe, expect, it } from "vitest";
import type { QaRetrievedEvidence } from "../ai-qa";
import {
  generateHybridCandidates,
  generateHybridCandidatesWithDiagnostics,
  hybridCandidateCitationValidity,
  retrieveRelationshipEvidence,
  retrieveTemporalEvidence
} from "./hybrid-candidates";
import { parseHybridQuery } from "./query-parser";
import { reciprocalRankFusion } from "./rrf";
import type { EvidenceRankingMetadata } from "./types";

function evidence(
  id: string,
  text: string,
  overrides: Partial<QaRetrievedEvidence> = {}
): QaRetrievedEvidence {
  return {
    id,
    kind: "raw",
    title: id,
    text,
    startSeconds: 0,
    endSeconds: 10,
    sourceSegmentIds: [`segment-${id}`],
    priority: 1,
    ...overrides
  };
}

describe("Hybrid query parser", () => {
  it("extracts lifecycle, relationship, entity, and temporal intent", () => {
    expect(parseHybridQuery("Alice 和我的关系后来怎么样，最终有什么变化？")).toMatchObject({
      temporalIntent: "final",
      entities: ["Alice"],
      types: expect.arrayContaining(["lifecycle", "relationship", "temporal"])
    });
  });

  it("inherits relationship intent and entity from the previous user turn", () => {
    expect(parseHybridQuery("那她呢？", [
      { role: "user", content: "Alice 和我的关系是什么？" },
      { role: "assistant", content: "需要查看可观察证据。" }
    ])).toMatchObject({
      inheritedRelationshipIntent: true,
      inheritedEntities: ["Alice"],
      entities: ["Alice"],
      types: expect.arrayContaining(["relationship"])
    });
  });

  it("recognizes communication agreements without extracting the concept as a person", () => {
    const query = parseHybridQuery("双方有哪些沟通方式和约定？");

    expect(query.types).toContain("relationship");
    expect(query.relationshipMode).toBe("speaker_pair");
    expect(query.entities).not.toContain("沟通方式");
    expect(query.entities).not.toContain("计划变化");
  });
});
describe("reciprocal rank fusion", () => {
  it("fuses rank positions without mixing raw channel scores", () => {
    const result = reciprocalRankFusion({
      dense: [{ id: "dense-only", rank: 1 }, { id: "shared", rank: 2 }],
      lexical: [{ id: "shared", rank: 1 }, { id: "lexical-only", rank: 2 }]
    });

    expect(result[0]).toMatchObject({
      id: "shared",
      ranks: { dense: 2, lexical: 1 }
    });
    expect(result.find((item) => item.id === "dense-only")?.ranks).toEqual({ dense: 1 });
  });
});

describe("Hybrid candidate generation", () => {
  it("unions dense, lexical, and structured evidence into a 30-50 candidate pool", () => {
    const canonical = [
      evidence("initial", "我最初想买燃油车。"),
      evidence("final", "后来我最终决定购买新能源车。"),
      evidence("alice", "Alice 在困难时提供了支持。", { kind: "relationship_signal" }),
      ...Array.from({ length: 35 }, (_, index) =>
        evidence(`noise-${index}`, `普通记录 ${index}`)
      )
    ];
    const metadata = new Map<string, EvidenceRankingMetadata>([
      ["final", { recordingDate: "2026-07-09", memoryType: "event", memoryStatus: "resolved" }],
      ["alice", { memoryType: "relationship_signal", memoryStatus: "active", entities: ["Alice"] }]
    ]);

    const candidates = generateHybridCandidates({
      question: "后来为什么最终选择新能源车？",
      evidence: canonical,
      currentCandidates: canonical.slice(2, 18),
      denseCandidates: [
        { rank: 1, score: 0.91, evidence: canonical[1]! },
        { rank: 2, score: 0.84, evidence: canonical[0]! },
        ...canonical.slice(18).map((item, index) => ({
          rank: index + 3,
          score: 0.5 - index / 100,
          evidence: item
        }))
      ],
      metadata,
      limit: 30
    });

    expect(candidates).toHaveLength(30);
    expect(candidates.map((item) => item.evidence.id)).toEqual(
      expect.arrayContaining(["initial", "final"])
    );
    expect(candidates.find((item) => item.evidence.id === "final")?.channelRanks).toEqual(
      expect.objectContaining({ dense: 1, structured: expect.any(Number) })
    );
    expect(hybridCandidateCitationValidity(candidates, canonical)).toBe(true);
  });

  it("promotes relationship alias evidence into the Top-10 quota", () => {
    const aliasEvidence = evidence("alice", "小艾在对话中明确表达了支持。", {
      kind: "relationship_signal"
    });
    const noise = Array.from({ length: 39 }, (_, index) =>
      evidence(`noise-${index}`, `普通记录 ${index}`)
    );
    const canonical = [...noise, aliasEvidence];
    const diagnostics = generateHybridCandidatesWithDiagnostics({
      question: "Alice 和我的关系是什么？",
      evidence: canonical,
      currentCandidates: noise.slice(0, 16),
      denseCandidates: [
        ...noise.slice(0, 29).map((item, index) => ({
          rank: index + 1,
          score: 0.9 - index / 100,
          evidence: item
        })),
        { rank: 30, score: 0.4, evidence: aliasEvidence }
      ],
      metadata: new Map([
        ["alice", {
          entityAliases: ["Alice", "小艾"],
          entities: ["小艾"],
          relationshipSourceValid: true
        }]
      ]),
      limit: 30,
      strategy: "quota_rrf"
    });

    expect(diagnostics.appliedQuotas.relationship).toBe(4);
    expect(diagnostics.candidates.findIndex((item) => item.evidence.id === "alice")).toBeLessThan(10);
    expect(diagnostics.channelIds.relationship).toContain("alice");
  });

  it("distinguishes an owner match from a speaker-only match", () => {
    const owner = evidence("owner", "Alice 的明确承诺。");
    const speakerOnly = evidence("speaker", "Alice 参与了这段对话。");
    const query = parseHybridQuery("Alice 和我的关系中，这是谁的承诺？");
    const results = retrieveRelationshipEvidence({
      query,
      evidence: [speakerOnly, owner],
      metadata: new Map([
        ["owner", { owners: ["Alice"], speakers: ["speaker_1"], relationshipSourceValid: true }],
        ["speaker", { owners: ["Bob"], speakers: ["Alice"], relationshipSourceValid: true }]
      ])
    });

    expect(query.relationshipMode).toBe("owner");
    expect(results.map((item) => item.evidence.id)).toEqual(["owner"]);
  });

  it("orders recordings by recording date and uses segment time only within one recording", () => {
    const oldLateSegment = evidence("old-late", "旧录音末尾", {
      startSeconds: 3_000,
      endSeconds: 3_010
    });
    const newEarlySegment = evidence("new-early", "新录音开头", {
      startSeconds: 1,
      endSeconds: 2
    });
    const query = parseHybridQuery("最近发生了什么？");
    const results = retrieveTemporalEvidence({
      query,
      evidence: [oldLateSegment, newEarlySegment],
      metadata: new Map([
        ["old-late", {
          recordingDate: "2026-07-01",
          recordingId: "old",
          segmentOrder: 3_000
        }],
        ["new-early", {
          recordingDate: "2026-07-08",
          recordingId: "new",
          segmentOrder: 1
        }]
      ])
    });

    expect(results.map((item) => item.evidence.id)).toEqual(["new-early", "old-late"]);
  });

  it("hard-filters an explicit calendar day inside the supplied scope universe", () => {
    const inScope = [
      evidence("day-4", "7月4日记录"),
      evidence("day-5", "7月5日记录")
    ];
    const results = retrieveTemporalEvidence({
      query: parseHybridQuery("2026年7月5日发生了什么？"),
      evidence: inScope,
      metadata: new Map([
        ["day-4", { recordingDate: "2026-07-04", recordingId: "u4" }],
        ["day-5", { recordingDate: "2026-07-05", recordingId: "u5" }],
        ["out-of-scope", { recordingDate: "2026-06-01", recordingId: "u0" }]
      ])
    });

    expect(results.map((item) => item.evidence.id)).toEqual(["day-5"]);
  });

  it.each([
    ["current", ["day-8"]],
    ["week", ["day-8", "day-4"]],
    ["all", ["day-8", "day-4", "day-1"]]
  ] as const)("does not widen the supplied %s date-boundary universe", (_scope, expectedIds) => {
    const allEvidence = [
      evidence("day-8", "最新记录"),
      evidence("day-4", "本周较早记录"),
      evidence("day-1", "更早记录")
    ];
    const expected = new Set<string>(expectedIds);
    const universe = allEvidence.filter((item) => expected.has(item.id));
    const results = retrieveTemporalEvidence({
      query: parseHybridQuery("最近发生了什么？"),
      evidence: universe,
      metadata: new Map([
        ["day-8", { recordingDate: "2026-07-08", recordingId: "r8" }],
        ["day-4", { recordingDate: "2026-07-04", recordingId: "r4" }],
        ["day-1", { recordingDate: "2026-07-01", recordingId: "r1" }]
      ])
    });

    expect(results.map((item) => item.evidence.id)).toEqual(expectedIds);
  });

  it("retains initial, changed, and final lifecycle representatives in the Top-16", () => {
    const chain = [
      evidence("initial", "最初计划购买燃油车，还在考虑。"),
      evidence("changed", "后来开始考虑新能源车，尚未决定。"),
      evidence("final", "最终决定购买新能源车，已经完成下单。")
    ];
    const noise = Array.from({ length: 30 }, (_, index) =>
      evidence(`noise-${index}`, `普通记录 ${index}`)
    );
    const diagnostics = generateHybridCandidatesWithDiagnostics({
      question: "买车这件事后来最终怎么决定的？",
      evidence: [...noise, ...chain],
      currentCandidates: noise.slice(0, 16),
      denseCandidates: [
        ...noise.slice(0, 27).map((item, index) => ({
          rank: index + 1,
          score: 0.9 - index / 100,
          evidence: item
        })),
        ...chain.map((item, index) => ({
          rank: 28 + index,
          score: 0.5 - index / 100,
          evidence: item
        }))
      ],
      metadata: new Map([
        ["initial", { recordingDate: "2026-07-01", memoryStatus: "active" }],
        ["changed", { recordingDate: "2026-07-04", memoryStatus: "active" }],
        ["final", { recordingDate: "2026-07-08", memoryStatus: "resolved" }]
      ]),
      strategy: "quota_rrf",
      limit: 30
    });

    expect(diagnostics.candidates.slice(0, 16).map((item) => item.evidence.id))
      .toEqual(expect.arrayContaining(["initial", "changed", "final"]));
  });

  it("keeps the Current Top-10 floor and Top-16 tail for guarded relationship fusion", () => {
    const canonical = Array.from({ length: 40 }, (_, index) =>
      evidence(`e-${index}`, index < 16 ? `双方沟通约定 ${index}` : `普通记录 ${index}`)
    );
    const current = canonical.slice(0, 16);
    const diagnostics = generateHybridCandidatesWithDiagnostics({
      question: "双方之前有哪些沟通方式和约定？",
      evidence: canonical,
      currentCandidates: current,
      denseCandidates: canonical.slice().reverse().map((item, index) => ({
        rank: index + 1,
        score: 0.99 - index / 100,
        evidence: item
      })),
      metadata: new Map(
        canonical.map((item, index) => [
          item.id,
          {
            recordingDate: `2026-07-${String((index % 20) + 1).padStart(2, "0")}`,
            recordingId: `recording-${index}`,
            relationshipSourceValid: true
          }
        ])
      ),
      limit: 30,
      strategy: "guarded_rrf"
    });

    const ids = diagnostics.candidates.map((item) => item.evidence.id);
    expect(new Set(ids.slice(0, 10))).toEqual(
      new Set(current.slice(0, 10).map((item) => item.id))
    );
    expect(ids.slice(-6)).toEqual(current.slice(10, 16).map((item) => item.id));
    expect(diagnostics.candidates[0]?.channelRanks.current).toBe(1);
    expect(hybridCandidateCitationValidity(diagnostics.candidates, canonical)).toBe(true);
  });
});

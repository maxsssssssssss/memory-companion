import { describe, expect, it, vi } from "vitest";
import { analyzeQaQueryIntent, assessQaLifecycleEvidence } from "../lifecycle-retrieval";
import {
  compactEvidencePromptForEvaluation,
  projectCompactEvidence
} from "./projection";
import { observeCompactEvidenceShadow } from "./shadow";
import type { CanonicalEvidenceProjectionItem } from "./types";

function evidenceItem(
  overrides: Partial<CanonicalEvidenceProjectionItem> = {}
): CanonicalEvidenceProjectionItem {
  return {
    id: "audio_1",
    kind: "audio_emotion",
    title: "speaker_2的语气/互动线索",
    text: [
      "语气/互动线索",
      "说话人：speaker_2；角色：other",
      "语气标签：serious",
      "情绪线索：interested",
      "互动标签：clear_commitment",
      "声音估计：语速normal，音量medium，停顿many",
      "声音依据：",
      "- 停顿变多：静音比例约42%",
      "气氛线索：serious",
      "- 认真讨论：acoustic，置信度72%：音量升高；特征：音量更高、停顿变多",
      "摘要：陶艺预约已经提交并付款成功。",
      "依据：确认通知已经收到。"
    ].join("\n"),
    startSeconds: 2_400,
    endSeconds: 2_520,
    sourceSegmentIds: ["seg_1", "seg_2"],
    ...overrides
  };
}

describe("Compact Evidence projection", () => {
  it("projects only existing Audio Insight summary and evidence fields", () => {
    const canonical = evidenceItem();
    const projection = projectCompactEvidence({
      evidence: [canonical],
      queryIntent: analyzeQaQueryIntent("陶艺预约后来怎么样？")
    });
    const view = projection.views[0]!;

    expect(view.projectionStatus).toBe("projected");
    expect(view.summary).toBe("陶艺预约已经提交并付款成功。");
    expect(view.evidence).toBe("确认通知已经收到。");
    expect(view.promptText).toContain("互动标签：clear_commitment");
    expect(view.promptText).toContain("摘要：陶艺预约已经提交并付款成功。");
    expect(view.promptText).toContain("依据：确认通知已经收到。");
    expect(view.promptText).not.toContain("声音估计");
    expect(view.promptText).not.toContain("语速normal");
    expect(view.promptText).not.toContain("音量更高");
    expect(view.promptText).not.toContain("停顿变多");
    expect(view.compactSerializedChars).toBeLessThan(view.originalSerializedChars);
    expect(projection.reductionRatio).toBeGreaterThan(0);
  });

  it("keeps citation order, canonical IDs, timestamps and source IDs unchanged", () => {
    const first = evidenceItem();
    const second = evidenceItem({
      id: "raw_1",
      kind: "raw",
      title: "speaker_1的原始转写",
      text: "周二晚上七点排练。",
      startSeconds: 600,
      endSeconds: 610,
      sourceSegmentIds: ["seg_raw"]
    });
    const projection = projectCompactEvidence({
      evidence: [first, second],
      queryIntent: analyzeQaQueryIntent("有哪些安排？")
    });

    expect(projection.views.map((view) => view.citationId)).toEqual(["E1", "E2"]);
    expect(projection.views.map((view) => view.canonicalEvidenceId)).toEqual([
      "audio_1",
      "raw_1"
    ]);
    expect(projection.views[0]?.sourceSegmentIds).toEqual(["seg_1", "seg_2"]);
    expect(projection.views[1]?.sourceSegmentIds).toEqual(["seg_raw"]);
    expect(projection.views[0]?.timestamp).toEqual({
      startSeconds: 2_400,
      endSeconds: 2_520
    });
    expect(projection.citationMappingUnchanged).toBe(true);
    expect(projection.sourceIdsUnchanged).toBe(true);

    projection.views[0]?.sourceSegmentIds.push("shadow_mutation");
    expect(first.sourceSegmentIds).toEqual(["seg_1", "seg_2"]);
  });

  it("leaves non-Audio Evidence prompt text byte-for-byte unchanged", () => {
    const raw = evidenceItem({
      id: "raw_1",
      kind: "raw",
      title: "speaker_1的原始转写",
      text: "  原始   文本\n保持事实  ",
      sourceSegmentIds: ["seg_raw"]
    });
    const projection = projectCompactEvidence({
      evidence: [raw],
      queryIntent: analyzeQaQueryIntent("说了什么？")
    });
    const view = projection.views[0]!;

    expect(view.projectionStatus).toBe("unchanged");
    expect(view.promptText).toBe(raw.text);
    expect(view.originalSerializedChars).toBe(view.compactSerializedChars);
    expect(projection.reductionRatio).toBe(0);
  });

  it("preserves lifecycle state and topic overlap for a valid projection", () => {
    const canonical = evidenceItem();
    const queryIntent = analyzeQaQueryIntent("陶艺预约后来怎么样？");
    const projection = projectCompactEvidence({
      evidence: [canonical],
      queryIntent
    });
    const view = projection.views[0]!;

    expect(view.lifecycle.unchanged).toBe(true);
    expect(view.lifecycle.compactState).toBe(
      assessQaLifecycleEvidence(
        queryIntent,
        `${canonical.title}\n${canonical.text}`
      ).state
    );
    expect(view.lifecycle.compactTopicOverlap).toBe(
      view.lifecycle.originalTopicOverlap
    );
    expect(projection.lifecycleStateUnchanged).toBe(true);
  });

  it("preserves mixed fulfilled and pending states for aggregate commitments", () => {
    const fulfilled = evidenceItem({
      id: "audio_fulfilled",
      text: [
        "语气/互动线索",
        "互动标签：clear_commitment",
        "声音估计：语速normal，音量medium，停顿few",
        "摘要：陶艺预约已经提交并付款成功。",
        "依据：确认通知也收到了。"
      ].join("\n")
    });
    const pending = evidenceItem({
      id: "audio_pending",
      sourceSegmentIds: ["seg_pending"],
      text: [
        "语气/互动线索",
        "互动标签：clear_commitment",
        "声音估计：语速normal，音量medium，停顿few",
        "摘要：她答应周二晚上陪同排练。",
        "依据：双方约定周二晚上七点排练。"
      ].join("\n")
    });
    const projection = projectCompactEvidence({
      evidence: [fulfilled, pending],
      queryIntent: analyzeQaQueryIntent("她答应的事情都做完了吗？")
    });

    expect(projection.views.map((view) => view.lifecycle.compactState)).toEqual([
      "resolved",
      "pending"
    ]);
    expect(projection.views.every((view) => view.lifecycle.unchanged)).toBe(true);
    expect(projection.fallbackItems).toBe(0);
  });

  it("falls back to the original item when projection changes lifecycle state", () => {
    const canonical = evidenceItem({
      text: [
        "语气/互动线索",
        "声音依据：",
        "- 状态：陶艺预约已经完成",
        "摘要：双方继续讨论陶艺预约。",
        "依据：双方交流了课程细节。"
      ].join("\n")
    });
    const projection = projectCompactEvidence({
      evidence: [canonical],
      queryIntent: analyzeQaQueryIntent("陶艺预约后来怎么样？")
    });
    const view = projection.views[0]!;

    expect(view.projectionStatus).toBe("fallback_original");
    expect(view.fallbackReason).toBe("lifecycle_state_changed");
    expect(view.promptText).toBe(canonical.text);
    expect(view.lifecycle.candidateState).not.toBe(view.lifecycle.originalState);
    expect(view.lifecycle.compactState).toBe(view.lifecycle.originalState);
    expect(view.lifecycle.unchanged).toBe(true);
    expect(projection.lifecycleStateUnchanged).toBe(true);
  });

  it("fails closed for user-corrected or unparseable Audio Evidence", () => {
    const corrected = evidenceItem({
      text: [
        "语气/互动线索",
        "用户纠正：",
        "- 紧张 -> 认真",
        "摘要：这段是在认真讨论。",
        "依据：用户已经纠正标签。"
      ].join("\n")
    });
    const unparseable = evidenceItem({
      id: "audio_2",
      text: "缺少结构化摘要和依据标记。",
      sourceSegmentIds: ["seg_3"]
    });
    const projection = projectCompactEvidence({
      evidence: [corrected, unparseable],
      queryIntent: analyzeQaQueryIntent("当时发生了什么？")
    });

    expect(projection.views[0]).toEqual(
      expect.objectContaining({
        projectionStatus: "fallback_original",
        fallbackReason: "user_correction_present",
        promptText: corrected.text
      })
    );
    expect(projection.views[1]).toEqual(
      expect.objectContaining({
        projectionStatus: "fallback_original",
        fallbackReason: "unparseable_audio_evidence",
        promptText: unparseable.text
      })
    );
    expect(projection.fallbackItems).toBe(2);
  });

  it("reports the exact compact prompt character count used by evaluation", () => {
    const projection = projectCompactEvidence({
      evidence: [
        evidenceItem(),
        evidenceItem({
          id: "raw_1",
          kind: "raw",
          text: "逐字证据。",
          sourceSegmentIds: ["seg_raw"]
        })
      ],
      queryIntent: analyzeQaQueryIntent("陶艺预约后来怎么样？")
    });

    expect(compactEvidencePromptForEvaluation(projection).length).toBe(
      projection.compactChars
    );
  });
});

describe("Compact Evidence shadow observer", () => {
  it("logs content-free metrics and confirms the Provider payload stays canonical", () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn()
    };
    const projection = observeCompactEvidenceShadow(
      {
        attempt: "sync",
        evidence: [evidenceItem()],
        queryIntent: analyzeQaQueryIntent("陶艺预约后来怎么样？")
      },
      logger
    );

    expect(projection).not.toBeNull();
    expect(logger.info).toHaveBeenCalledTimes(1);
    const message = String(logger.info.mock.calls[0]?.[0]);
    expect(message).toContain("EVIDENCE_COMPRESSION_SHADOW:");
    expect(message).toContain('"provider_payload":"canonical"');
    expect(message).toContain('"citation_mapping_unchanged":true');
    expect(message).toContain('"source_ids_unchanged":true');
    expect(message).not.toContain("陶艺预约已经提交并付款成功");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("cannot break QA when the shadow logger throws", () => {
    const projection = observeCompactEvidenceShadow(
      {
        attempt: "sync",
        evidence: [evidenceItem()],
        queryIntent: analyzeQaQueryIntent("陶艺预约后来怎么样？")
      },
      {
        info: vi.fn(() => {
          throw new Error("logger unavailable");
        }),
        warn: vi.fn(() => {
          throw new Error("warn unavailable");
        })
      }
    );

    expect(projection).toBeNull();
  });
});

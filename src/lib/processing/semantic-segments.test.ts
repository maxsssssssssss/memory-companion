import { describe, expect, it } from "vitest";

import type { TranscriptSegment } from "@/lib/domain/types";

import { buildSemanticSegments } from "./semantic-segments";

function segment(overrides: Partial<TranscriptSegment>): TranscriptSegment {
  return {
    id: "seg_base",
    uploadId: "upload_1",
    startSeconds: 0,
    endSeconds: 10,
    text: "默认片段文本",
    confidence: 0.9,
    sceneLabels: ["unknown"],
    valueLabels: [],
    ...overrides
  };
}

describe("buildSemanticSegments", () => {
  it("groups long contiguous meeting transcripts into multi-minute topic blocks", () => {
    const segments = Array.from({ length: 60 }, (_, index) =>
      segment({
        id: `seg_meeting_${index + 1}`,
        startSeconds: index * 20,
        endSeconds: (index + 1) * 20,
        text: `这段会议继续讨论产品发布会、渠道安排、销售目标和团队跟进，第 ${index + 1} 段补充上下文。`,
        sceneLabels: ["product_discussion", "team_management"],
        valueLabels: index % 15 === 0 ? ["task"] : []
      })
    );

    const result = buildSemanticSegments("upload_1", segments);

    expect(result.length).toBeLessThanOrEqual(3);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].sourceSegmentIds.length).toBeGreaterThan(10);
    expect(result[0].endSeconds - result[0].startSeconds).toBeGreaterThanOrEqual(300);
  });

  it("generates summary-style titles instead of clipping a raw sentence", () => {
    const result = buildSemanticSegments("upload_1", [
      segment({
        id: "seg_launch",
        startSeconds: 0,
        endSeconds: 180,
        text: "然后这次主要就是产品新品发布会，Flybus 2和Pro 2，还有T2会一起发，现场会有线下发布会和渠道会。",
        sceneLabels: ["product_discussion"]
      }),
      segment({
        id: "seg_sales",
        startSeconds: 180,
        endSeconds: 360,
        text: "今年产品销售目标里面Pro 2和渠道销售占比要重新看，客户费用和授权方案也要确认。",
        sceneLabels: ["customer_call"],
        valueLabels: ["decision"]
      })
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].title).toMatch(/新品发布|渠道销售|产品规划/);
    expect(result[0].title).toMatch(/决策|讨论|安排|梳理/);
    expect(result[0].title).not.toContain("然后这次主要");
    expect(result[0].summary).toContain("围绕新品发布、渠道销售展开");
  });

  it("uses conceptual fallback titles for product platform discussion instead of raw transcript fragments", () => {
    const result = buildSemanticSegments("upload_1", [
      segment({
        id: "seg_screen",
        startSeconds: 0,
        endSeconds: 240,
        text: "一个实体屏幕是有价值的，但是这个就像我经常拿那个电子曲笛举例，平板电脑原来是把CPU藏在键盘下面，显示屏和键盘变成附件，软件对你的期待和优势就不一样。",
        sceneLabels: ["unknown"]
      }),
      segment({
        id: "seg_platform",
        startSeconds: 300,
        endSeconds: 520,
        text: "但是他最大的问题就是他是一个软件，这个问题其实我想过，移动互联网时代平台不断更迭，网飞和Facebook都是从内容库和平台服务里出来的。",
        sceneLabels: ["unknown"]
      }),
      segment({
        id: "seg_ecosystem",
        startSeconds: 580,
        endSeconds: 720,
        text: "同心态不是在替代心态，一旦是这样的情况下，我们是合作伙伴，对手也可以在生态上合作，关键是平台决定和协同关系。",
        sceneLabels: ["unknown"]
      })
    ]);

    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.map((item) => item.title).join(" ")).not.toMatch(/一个实体屏幕|但是他最大的问题|同心态不是/);
    expect(result.map((item) => item.title).join(" ")).toMatch(/硬件形态|软件平台|生态合作/);
    expect(result.map((item) => item.summary).join(" ")).toMatch(/围绕硬件形态|围绕软件平台|围绕生态合作/);
    expect(result.flatMap((item) => item.tags)).toEqual(expect.arrayContaining(["产品"]));
  });

  it("merges adjacent related fragments and absorbs contextual low-information fragments", () => {
    const result = buildSemanticSegments("upload_1", [
      segment({
        id: "seg_customer",
        startSeconds: 10,
        endSeconds: 25,
        text: "今天跟客户续费的事情要开会同步一下。",
        confidence: 0.92,
        sceneLabels: ["customer_call"]
      }),
      segment({
        id: "seg_context",
        startSeconds: 28,
        endSeconds: 32,
        text: "要跟进。",
        confidence: 0.72,
        valueLabels: ["task"]
      }),
      segment({
        id: "seg_risk",
        startSeconds: 35,
        endSeconds: 55,
        text: "客户合同费用需要重新评估，销售团队先出授权方案。",
        confidence: 0.86,
        sceneLabels: ["customer_call", "team_management"],
        valueLabels: ["risk"]
      })
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].sourceSegmentIds).toEqual(["seg_customer", "seg_context", "seg_risk"]);
    expect(result[0].sourceTimeRange).toEqual({ startSeconds: 10, endSeconds: 55 });
    expect(result[0].summary).toContain("要跟进");
    expect(result[0].tags).toEqual(expect.arrayContaining(["客户", "会议", "任务", "风险"]));
  });

  it("hides pure low-information fragments instead of creating standalone paragraphs", () => {
    const result = buildSemanticSegments("upload_1", [
      segment({
        id: "seg_filler",
        startSeconds: 10,
        endSeconds: 12,
        text: "嗯。"
      }),
      segment({
        id: "seg_noise",
        startSeconds: 20,
        endSeconds: 25,
        text: "这扯淡的。"
      })
    ]);

    expect(result).toEqual([]);
  });

  it("excludes private content even when it has strong value labels or long text", () => {
    const result = buildSemanticSegments("upload_1", [
      segment({
        id: "seg_private_risk",
        startSeconds: 10,
        endSeconds: 20,
        text: "家庭健康这里有风险。",
        sceneLabels: ["private_content"],
        valueLabels: ["risk"]
      }),
      segment({
        id: "seg_private_long",
        startSeconds: 30,
        endSeconds: 70,
        text: "家庭私人事项这里讲了很多细节，但是不应该出现在时间轴语义段落里面。",
        sceneLabels: ["private_content"]
      })
    ]);

    expect(result).toEqual([]);
  });

  it("does not absorb private nearby context into business paragraphs", () => {
    const result = buildSemanticSegments("upload_1", [
      segment({
        id: "seg_private_context",
        startSeconds: 10,
        endSeconds: 20,
        text: "家庭健康这里有风险。",
        sceneLabels: ["private_content"],
        valueLabels: ["risk"]
      }),
      segment({
        id: "seg_customer",
        startSeconds: 25,
        endSeconds: 60,
        text: "客户续费合同需要销售今晚继续跟进。",
        sceneLabels: ["customer_call"],
        valueLabels: ["task"]
      })
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].sourceSegmentIds).toEqual(["seg_customer"]);
    expect(result[0].transcriptExcerpt).not.toContain("家庭健康");
    expect(result[0].tags).not.toContain("私人内容");
  });

  it("does not absorb stale low-information context across long gaps", () => {
    const result = buildSemanticSegments("upload_1", [
      segment({
        id: "seg_old_filler",
        startSeconds: 10,
        endSeconds: 12,
        text: "嗯。"
      }),
      segment({
        id: "seg_near_context",
        startSeconds: 1000,
        endSeconds: 1004,
        text: "要跟进。",
        valueLabels: ["task"]
      }),
      segment({
        id: "seg_customer",
        startSeconds: 1010,
        endSeconds: 1040,
        text: "客户续费合同需要销售今晚继续跟进。",
        sceneLabels: ["customer_call"],
        valueLabels: ["task"]
      })
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].sourceSegmentIds).toEqual(["seg_near_context", "seg_customer"]);
    expect(result[0].transcriptExcerpt).not.toContain("嗯");
  });

  it("retains short fragments with strong value labels", () => {
    const result = buildSemanticSegments("upload_1", [
      segment({
        id: "seg_risk",
        startSeconds: 60,
        endSeconds: 70,
        text: "延期风险。",
        confidence: 0.81,
        valueLabels: ["risk"]
      }),
      segment({
        id: "seg_decision",
        startSeconds: 90,
        endSeconds: 100,
        text: "定价先不改。",
        confidence: 0.93,
        valueLabels: ["decision"]
      })
    ]);

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.sourceSegmentIds)).toEqual([["seg_risk"], ["seg_decision"]]);
    expect(result.map((item) => item.valueLabels)).toEqual([["risk"], ["decision"]]);
  });

  it("sorts transcript segments and preserves source evidence for merged ranges", () => {
    const result = buildSemanticSegments("upload_1", [
      segment({
        id: "seg_late",
        startSeconds: 50,
        endSeconds: 80,
        text: "客户反馈里还有续费合同风险，今晚需要销售继续跟进。",
        confidence: 0.8,
        sceneLabels: ["customer_call"],
        valueLabels: ["risk"]
      }),
      segment({
        id: "seg_early",
        startSeconds: 20,
        endSeconds: 40,
        text: "客户续费会议先确认合同费用和销售目标。",
        confidence: 0.9,
        sceneLabels: ["customer_call"],
        valueLabels: ["decision"]
      })
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "semantic_upload_1_seg_early_seg_late",
      uploadId: "upload_1",
      sourceSegmentIds: ["seg_early", "seg_late"],
      sourceTimeRange: {
        startSeconds: 20,
        endSeconds: 80
      },
      confidence: 0.85
    });
  });

  it("uses the maximum end time for overlapping merged evidence ranges", () => {
    const result = buildSemanticSegments("upload_1", [
      segment({
        id: "seg_long",
        startSeconds: 0,
        endSeconds: 100,
        text: "客户续费会议先确认合同费用和销售目标。",
        sceneLabels: ["customer_call"],
        valueLabels: ["decision"]
      }),
      segment({
        id: "seg_overlap",
        startSeconds: 50,
        endSeconds: 60,
        text: "客户续费风险。",
        sceneLabels: ["customer_call"],
        valueLabels: ["risk"]
      })
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].sourceTimeRange).toEqual({ startSeconds: 0, endSeconds: 100 });
    expect(result[0].endSeconds).toBe(100);
  });
});

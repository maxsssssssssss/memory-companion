import type { TranscriptSegment } from "@/lib/domain/types";

export const sampleTranscriptSegments: TranscriptSegment[] = [
  {
    id: "seg_customer_1",
    uploadId: "upload_demo",
    startSeconds: 420,
    endSeconds: 510,
    speaker: "speaker_1",
    text: "我答应客户明天下午前把新的报价方案发过去，并且把试点范围缩小到客服团队。",
    confidence: 0.93,
    sceneLabels: [],
    valueLabels: []
  },
  {
    id: "seg_product_1",
    uploadId: "upload_demo",
    startSeconds: 1260,
    endSeconds: 1355,
    speaker: "speaker_1",
    text: "今天先决定 MVP 只做每日复盘，不做完整长期记忆。真正有价值的是证据链，每个结论都能回到原话。",
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: []
  },
  {
    id: "seg_reflection_1",
    uploadId: "upload_demo",
    startSeconds: 3600,
    endSeconds: 3710,
    speaker: "speaker_1",
    text: "一个产品想法：把创始人每天的碎片录音整理成战略假设和待验证问题，而不是普通会议纪要。",
    confidence: 0.88,
    sceneLabels: [],
    valueLabels: []
  },
  {
    id: "seg_risk_1",
    uploadId: "upload_demo",
    startSeconds: 5400,
    endSeconds: 5520,
    speaker: "speaker_2",
    text: "风险是如果转写没有时间点，后面的问答就没法证明答案来自哪里，用户不会信。",
    confidence: 0.86,
    sceneLabels: [],
    valueLabels: []
  }
];

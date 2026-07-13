import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AudioInsight, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";

import { Timeline } from "./timeline";

function segment(overrides: Partial<TranscriptSegment>): TranscriptSegment {
  return {
    id: "seg_base",
    uploadId: "upload_1",
    startSeconds: 60,
    endSeconds: 130,
    text: "默认片段文本",
    confidence: 0.93,
    sceneLabels: ["unknown"],
    valueLabels: [],
    ...overrides
  };
}

function semanticSegment(overrides: Partial<SemanticSegment>): SemanticSegment {
  return {
    id: "semantic_1",
    uploadId: "upload_1",
    title: "客户续费会议",
    summary: "讨论客户续费合同和授权方案。",
    startSeconds: 60,
    endSeconds: 180,
    tags: ["客户", "会议"],
    sceneLabels: ["customer_call"],
    valueLabels: ["decision"],
    confidence: 0.88,
    sourceSegmentIds: ["seg_1", "seg_2"],
    sourceTimeRange: { startSeconds: 60, endSeconds: 180 },
    transcriptExcerpt: "今天跟客户续费的事情要开会同步一下。客户合同费用需要重新评估。",
    ...overrides
  };
}

function audioInsight(overrides: Partial<AudioInsight>): AudioInsight {
  return {
    id: "insight_1",
    uploadId: "upload_1",
    sourceSegmentIds: ["seg_1"],
    sourceTimeRange: { startSeconds: 60, endSeconds: 90 },
    speaker: { id: "speaker_2", displayName: "对方", role: "other", confidence: 0.62 },
    voice: { pace: "normal", volume: "unknown", pause: "unknown", overlap: false, confidence: 0.35 },
    toneLabels: ["hesitant", "questioning"],
    emotionLabels: ["anxious"],
    interactionLabels: ["follow_up_question", "tension"],
    summary: "对方以试探方式追问预算风险。",
    evidence: "原文提到“预算是不是还有风险”。",
    confidence: 0.7,
    ...overrides
  };
}

describe("Timeline", () => {
  it("uses segment text for a short title when speaker is missing and hides unknown noise", () => {
    const segments: TranscriptSegment[] = [
      segment({
        id: "seg_1",
        text: "我们今天要约客户聊定价方案，先确认产品试用反馈，再决定下周会议议程。",
        sceneLabels: ["unknown", "customer_call", "product_discussion"],
        valueLabels: ["decision", "idea"]
      })
    ];

    render(<Timeline segments={segments} />);

    const summary = screen.getByLabelText("我们今天要约客户聊定价方案 片段摘要");

    expect(within(summary).queryByText("录音片段")).not.toBeInTheDocument();
    expect(within(summary).getByText("客户")).toBeInTheDocument();
    expect(within(summary).getByText("产品")).toBeInTheDocument();
    expect(within(summary).getByText("决策")).toBeInTheDocument();
    expect(within(summary).getByText("灵感/想法")).toBeInTheDocument();
    expect(within(summary).queryByText("未分类")).not.toBeInTheDocument();
  });

  it("filters low-information fragments and keeps business-relevant segments", () => {
    const segments: TranscriptSegment[] = [
      segment({
        id: "seg_meeting",
        text: "下午开会同步一下销售进展，再讨论下周安排。",
        startSeconds: 60,
        endSeconds: 120
      }),
      segment({
        id: "seg_chatter",
        text: "我们是其实想表达意思。",
        startSeconds: 180,
        endSeconds: 240
      }),
      segment({
        id: "seg_confirmation",
        text: "难道我还不清楚这事吗？",
        startSeconds: 300,
        endSeconds: 330
      }),
      segment({
        id: "seg_product",
        text: "客户合同费用需要重新评估，销售团队今晚先给出授权方案。",
        startSeconds: 360,
        endSeconds: 430
      })
    ];

    render(<Timeline segments={segments} />);

    const meetingSummary = screen.getByLabelText("下午开会同步一下销售进展 片段摘要");
    const productSummary = screen.getByLabelText("客户合同费用需要重新评估 片段摘要");

    expect(within(meetingSummary).getByText("会议")).toBeInTheDocument();
    expect(within(productSummary).getByText("客户")).toBeInTheDocument();
    expect(within(productSummary).getByText("团队")).toBeInTheDocument();
    expect(screen.queryByText("我们是其实想表达意思。")).not.toBeInTheDocument();
    expect(screen.queryByText("难道我还不清楚这事吗？")).not.toBeInTheDocument();
  });

  it("filters low-information fragments even when they have broad value labels", () => {
    const segments: TranscriptSegment[] = [
      segment({
        id: "seg_vague_task",
        text: "要跟进。",
        valueLabels: ["task"],
        startSeconds: 60,
        endSeconds: 75
      }),
      segment({
        id: "seg_vague_idea",
        text: "我们想还能表达意思就是说。",
        valueLabels: ["idea"],
        startSeconds: 90,
        endSeconds: 110
      })
    ];

    render(<Timeline segments={segments} />);

    expect(screen.getByText("本次没有足够有价值的时间轴内容。")).toBeInTheDocument();
    expect(screen.queryByText("要跟进。")).not.toBeInTheDocument();
    expect(screen.queryByText("我们想还能表达意思就是说。")).not.toBeInTheDocument();
  });

  it("filters low-information fragments even when they have business scene labels", () => {
    const segments: TranscriptSegment[] = [
      segment({
        id: "seg_mislabeled_product",
        text: "这些细节我们都要对的。",
        sceneLabels: ["product_discussion"],
        startSeconds: 60,
        endSeconds: 80
      }),
      segment({
        id: "seg_mislabeled_customer",
        text: "这个还能分场景吗？",
        sceneLabels: ["customer_call"],
        startSeconds: 100,
        endSeconds: 115
      })
    ];

    render(<Timeline segments={segments} />);

    expect(screen.getByText("本次没有足够有价值的时间轴内容。")).toBeInTheDocument();
    expect(screen.queryByText("这些细节我们都要对的。")).not.toBeInTheDocument();
    expect(screen.queryByText("这个还能分场景吗？")).not.toBeInTheDocument();
  });

  it("filters private fragments even when they have strong value labels", () => {
    const segments: TranscriptSegment[] = [
      segment({
        id: "seg_private_risk",
        text: "家庭健康这里有风险。",
        sceneLabels: ["private_content"],
        valueLabels: ["risk"],
        startSeconds: 60,
        endSeconds: 80
      })
    ];

    render(<Timeline segments={segments} />);

    expect(screen.getByText("本次没有足够有价值的时间轴内容。")).toBeInTheDocument();
    expect(screen.queryByText("家庭健康这里有风险。")).not.toBeInTheDocument();
  });

  it("keeps short segments when they have strong value labels", () => {
    const segments: TranscriptSegment[] = [
      segment({
        id: "seg_short_risk",
        text: "延期风险。",
        valueLabels: ["risk"],
        startSeconds: 60,
        endSeconds: 75
      }),
      segment({
        id: "seg_short_decision",
        text: "定价先不改。",
        valueLabels: ["decision"],
        startSeconds: 90,
        endSeconds: 110
      })
    ];

    render(<Timeline segments={segments} />);

    const riskSummary = screen.getByLabelText("延期风险 片段摘要");
    const decisionSummary = screen.getByLabelText("定价先不改 片段摘要");

    expect(within(riskSummary).getByText("风险")).toBeInTheDocument();
    expect(within(decisionSummary).getByText("决策")).toBeInTheDocument();
  });

  it("keeps strong value labels even when text matches a weak low-information pattern", () => {
    const segments: TranscriptSegment[] = [
      segment({
        id: "seg_risk_question",
        text: "难道延期风险还不清楚吗？",
        valueLabels: ["risk"],
        startSeconds: 60,
        endSeconds: 80
      })
    ];

    render(<Timeline segments={segments} />);

    const summary = screen.getByLabelText("难道延期风险还不清楚吗 片段摘要");

    expect(within(summary).getByText("风险")).toBeInTheDocument();
    expect(within(summary).getByText("难道延期风险还不清楚吗？")).toBeInTheDocument();
  });

  it("shows filtering statistics in the timeline meta row", () => {
    const segments: TranscriptSegment[] = [
      segment({
        id: "seg_kept",
        text: "今天开会讨论客户续费合同，先确认销售目标。",
        startSeconds: 60,
        endSeconds: 120
      }),
      segment({
        id: "seg_hidden",
        text: "这扯淡的。",
        startSeconds: 180,
        endSeconds: 190
      })
    ];

    render(<Timeline segments={segments} />);

    expect(
      screen.getByText((_, element) => {
        const text = element?.textContent?.replace(/\s+/g, " ").trim();
        return text === "展示 1 个关键片段 / 已隐藏 1 个低信息片段";
      })
    ).toBeInTheDocument();
  });

  it("shows an empty state when every segment is filtered", () => {
    const segments: TranscriptSegment[] = [
      segment({
        id: "seg_chatter_1",
        text: "所以其实也是想把这个。",
        startSeconds: 60,
        endSeconds: 80
      }),
      segment({
        id: "seg_chatter_2",
        text: "这个还能分场景吗？",
        startSeconds: 100,
        endSeconds: 115
      })
    ];

    render(<Timeline segments={segments} />);

    expect(screen.getByText("本次没有足够有价值的时间轴内容。")).toBeInTheDocument();
    expect(screen.queryByText("所以其实也是想把这个。")).not.toBeInTheDocument();
    expect(screen.queryByText("这个还能分场景吗？")).not.toBeInTheDocument();
  });

  it("does not mutate the input segments while sorting and filtering for display", () => {
    const segments: TranscriptSegment[] = [
      segment({
        id: "seg_late",
        text: "客户合同费用需要重新评估。",
        startSeconds: 180,
        endSeconds: 220
      }),
      segment({
        id: "seg_hidden",
        text: "这扯淡的。",
        startSeconds: 60,
        endSeconds: 75
      }),
      segment({
        id: "seg_early",
        text: "下午开会同步销售进展。",
        startSeconds: 120,
        endSeconds: 150
      })
    ];
    const originalSegments = segments.map((item) => ({
      ...item,
      sceneLabels: [...item.sceneLabels],
      valueLabels: [...item.valueLabels]
    }));

    render(<Timeline segments={segments} />);

    expect(segments).toEqual(originalSegments);
    expect(segments.map((item) => item.id)).toEqual(["seg_late", "seg_hidden", "seg_early"]);
  });

  it("infers risk task and idea tags from text without value labels", () => {
    const segments: TranscriptSegment[] = [
      segment({
        id: "seg_value_inference",
        text: "这里有延期风险，待办是今晚跟进客户，同时有个灵感可以试试新的定价方案。"
      })
    ];

    render(<Timeline segments={segments} />);

    const summary = screen.getByLabelText("这里有延期风险 片段摘要");

    expect(within(summary).getByText("风险")).toBeInTheDocument();
    expect(within(summary).getByText("任务")).toBeInTheDocument();
    expect(within(summary).getByText("灵感/想法")).toBeInTheDocument();
  });

  it("prefers semantic segments and shows their source evidence", () => {
    const rawSegments: TranscriptSegment[] = [
      segment({
        id: "seg_1",
        text: "今天跟客户续费的事情要开会同步一下。",
        startSeconds: 60,
        endSeconds: 90
      }),
      segment({
        id: "seg_2",
        text: "客户合同费用需要重新评估。",
        startSeconds: 100,
        endSeconds: 180
      }),
      segment({
        id: "seg_hidden",
        text: "嗯。",
        startSeconds: 200,
        endSeconds: 205
      })
    ];

    render(<Timeline segments={rawSegments} semanticSegments={[semanticSegment({})]} />);

    const summary = screen.getByLabelText("客户续费会议 语义段落摘要");

    expect(within(summary).getByText("客户续费会议")).toBeInTheDocument();
    expect(within(summary).getByText("讨论客户续费合同和授权方案。")).toBeInTheDocument();
    expect(within(summary).getByText("客户")).toHaveClass("tag-customer");
    expect(within(summary).getByText("会议")).toHaveClass("tag-meeting");
    expect(screen.queryByLabelText("今天跟客户续费的事情要开会同步一下 片段摘要")).not.toBeInTheDocument();
    expect(
      screen.getByText((_, element) => {
        const text = element?.textContent?.replace(/\s+/g, " ").trim();
        return text === "展示 1 个语义段落 / 已合并或隐藏 1 个原始片段";
      })
    ).toBeInTheDocument();

    const details = screen.getByText("客户续费会议").closest("details");
    expect(details).not.toBeNull();
    details?.setAttribute("open", "");

    expect(screen.getByText("证据片段：2 段原始转写")).toBeInTheDocument();
    expect(screen.getByText("查看 2 段原始转写")).toBeInTheDocument();
    expect(screen.queryByText("语义段落 ID：semantic_1")).not.toBeInTheDocument();
    expect(screen.queryByText("原始片段：seg_1, seg_2")).not.toBeInTheDocument();
    expect(screen.getAllByText(/今天跟客户续费的事情要开会同步一下/).length).toBeGreaterThan(0);
  });

  it("shows audio insight tags and evidence for semantic timeline cards", () => {
    const rawSegments: TranscriptSegment[] = [
      segment({
        id: "seg_1",
        text: "预算是不是还有风险？",
        startSeconds: 60,
        endSeconds: 90,
        speaker: "speaker_2"
      })
    ];

    render(
      <Timeline
        segments={rawSegments}
        audioInsights={[audioInsight({})]}
        semanticSegments={[
          semanticSegment({
            sourceSegmentIds: ["seg_1"],
            title: "预算风险追问",
            summary: "对方追问预算风险。",
            transcriptExcerpt: "预算是不是还有风险？"
          })
        ]}
      />
    );

    const summary = screen.getByLabelText("预算风险追问 语义段落摘要");

    expect(within(summary).getByText("语气: 犹豫、追问")).toHaveClass("tag-tone");
    expect(within(summary).getByText("情绪: 紧张")).toHaveClass("tag-emotion");
    expect(within(summary).getByText("互动: 紧张、追问")).toHaveClass("tag-interaction");

    const details = screen.getByText("预算风险追问").closest("details");
    details?.setAttribute("open", "");

    expect(screen.getByText("语气/互动线索")).toBeInTheDocument();
    expect(screen.getByText(/试探方式追问预算风险/)).toBeInTheDocument();
    expect(screen.getAllByText(/预算是不是还有风险/).length).toBeGreaterThan(0);
  });

  it("shows real acoustic feature tags when audio insights include waveform signals", () => {
    const rawSegments: TranscriptSegment[] = [
      segment({
        id: "seg_1",
        text: "预算是不是还有风险？",
        startSeconds: 60,
        endSeconds: 90,
        speaker: "speaker_2"
      })
    ];

    render(
      <Timeline
        segments={rawSegments}
        audioInsights={[
          audioInsight({
            voice: { pace: "normal", volume: "high", pause: "many", overlap: true, confidence: 0.74 }
          })
        ]}
        semanticSegments={[
          semanticSegment({
            sourceSegmentIds: ["seg_1"],
            title: "预算风险追问",
            summary: "对方追问预算风险。",
            transcriptExcerpt: "预算是不是还有风险？"
          })
        ]}
      />
    );

    const summary = screen.getByLabelText("预算风险追问 语义段落摘要");

    expect(within(summary).getByText("声音: 音量高、停顿多、多人重叠")).toHaveClass("tag-sound");
  });

  it("shows atmosphere tags and expandable emotion evidence on timeline cards", () => {
    const rawSegments: TranscriptSegment[] = [
      segment({
        id: "seg_1",
        text: "预算是不是还有风险？",
        startSeconds: 60,
        endSeconds: 90,
        speaker: "speaker_2"
      })
    ];

    render(
      <Timeline
        segments={rawSegments}
        audioInsights={[
          audioInsight({
            atmosphereLabels: ["serious", "tense"],
            emotionEvidence: [
              {
                id: "emotion_evidence_1",
                kind: "atmosphere",
                label: "认真偏紧",
                normalizedLabel: "tense",
                source: "acoustic",
                confidence: 0.72,
                detail: "音量升高、停顿变多，并且多人重叠。",
                sourceSegmentIds: ["seg_1"],
                sourceTimeRange: { startSeconds: 60, endSeconds: 90 },
                features: [
                  { name: "volume", label: "音量更高", value: "-16", unit: "dBFS" },
                  { name: "pause", label: "停顿变多", value: "42", unit: "%" }
                ]
              }
            ]
          })
        ]}
        semanticSegments={[
          semanticSegment({
            sourceSegmentIds: ["seg_1"],
            title: "预算风险追问",
            summary: "对方追问预算风险。",
            transcriptExcerpt: "预算是不是还有风险？"
          })
        ]}
      />
    );

    const summary = screen.getByLabelText("预算风险追问 语义段落摘要");

    expect(within(summary).getByText("气氛: 偏紧、认真")).toHaveClass("tag-atmosphere");

    const details = screen.getByText("预算风险追问").closest("details");
    details?.setAttribute("open", "");

    expect(screen.getByText("气氛证据 1 条")).toBeInTheDocument();
    expect(screen.getByText("认真偏紧")).toBeInTheDocument();
    expect(screen.getByText("声音 · 72%")).toBeInTheDocument();
    expect(screen.getByText("音量升高、停顿变多，并且多人重叠。")).toBeInTheDocument();
    expect(screen.getByText("音量更高")).toBeInTheDocument();
    expect(screen.getByText("停顿变多")).toBeInTheDocument();
  });

  it("uses upload-scoped speaker aliases for audio insight display without mutating raw speaker ids", () => {
    const rawSegments: TranscriptSegment[] = [
      segment({
        id: "seg_1",
        uploadId: "upload_1",
        text: "预算是不是还有风险？",
        startSeconds: 60,
        endSeconds: 90,
        speaker: "speaker_2"
      })
    ];

    render(
      <Timeline
        segments={rawSegments}
        audioInsights={[
          audioInsight({
            uploadId: "upload_1",
            speaker: { id: "speaker_2", role: "other", confidence: 0.62 },
            summary: "speaker_2 追问预算风险。",
            evidence: "speaker_2 提到预算是不是还有风险。"
          })
        ]}
        speakerAliasesByUploadId={{
          upload_1: {
            speaker_2: "张三"
          }
        }}
      />
    );

    const details = screen.getByText("speaker_2：预算是不是还有风险").closest("details");
    details?.setAttribute("open", "");

    expect(
      screen.getByText((_, element) => {
        const text = element?.textContent?.replace(/\s+/g, " ").trim();
        return text === "张三：张三 追问预算风险。张三 提到预算是不是还有风险。";
      })
    ).toBeInTheDocument();
    expect(screen.getByText(/张三 提到预算是不是还有风险/)).toBeInTheDocument();
  });

  it("keeps noisy audio insight labels compact on timeline cards", () => {
    const rawSegments: TranscriptSegment[] = [
      segment({
        id: "seg_1",
        text: "围绕产品规划和硬件风险继续讨论。",
        startSeconds: 60,
        endSeconds: 120
      }),
      segment({
        id: "seg_2",
        text: "有人反复追问方案取舍，也有人解释现在的限制。",
        startSeconds: 120,
        endSeconds: 180
      })
    ];

    render(
      <Timeline
        segments={rawSegments}
        audioInsights={[
          audioInsight({
            id: "insight_1",
            sourceSegmentIds: ["seg_1"],
            toneLabels: ["firm", "explaining", "questioning", "pushing_back", "serious"],
            emotionLabels: ["neutral", "dissatisfied"],
            interactionLabels: ["follow_up_question", "tension"]
          }),
          audioInsight({
            id: "insight_2",
            sourceSegmentIds: ["seg_2"],
            toneLabels: ["excited", "perfunctory", "explaining", "questioning"],
            emotionLabels: ["interested"],
            interactionLabels: ["topic_shift"]
          })
        ]}
        semanticSegments={[
          semanticSegment({
            sourceSegmentIds: ["seg_1", "seg_2"],
            title: "产品功能模式与场景组合",
            summary: "围绕产品规划、硬件风险和方案取舍展开。",
            tags: ["产品", "未决问题", "决策", "会议", "客户", "硬件", "任务", "风险", "生态", "商业"]
          })
        ]}
      />
    );

    const summary = screen.getByLabelText("产品功能模式与场景组合 语义段落摘要");

    expect(within(summary).getAllByText(/^语气:/)).toHaveLength(1);
    expect(within(summary).getByText("语气: 反驳、追问")).toHaveClass("tag-tone");
    expect(within(summary).getByText("情绪: 不满、感兴趣")).toHaveClass("tag-emotion");
    expect(within(summary).getByText("互动: 紧张、追问")).toHaveClass("tag-interaction");
    expect(within(summary).queryByText("语气: 解释")).not.toBeInTheDocument();
    expect(within(summary).queryByText("生态")).not.toBeInTheDocument();
    expect(within(summary).queryByText("商业")).not.toBeInTheDocument();
  });

  it("shows explainable voice signals and saves user corrections for an audio insight", async () => {
    const onSaveAudioInsightCorrection = vi.fn().mockResolvedValue(undefined);

    render(
      <Timeline
        segments={[
          segment({
            id: "seg_1",
            text: "预算是不是还有风险？",
            speaker: "speaker_2",
            valueLabels: ["risk"],
            startSeconds: 60,
            endSeconds: 90
          })
        ]}
        audioInsights={[
          audioInsight({
            voice: {
              pace: "normal",
              volume: "high",
              pause: "many",
              overlap: true,
              confidence: 0.72,
              explanations: [
                { kind: "volume", label: "音量更高", detail: "这一段平均音量约 -16 dBFS。", confidence: 0.72 },
                { kind: "pause", label: "停顿变多", detail: "静音和停顿占比约 42%。", confidence: 0.72 },
                { kind: "overlap", label: "多人重叠", detail: "speaker_2 与 speaker_1 的转写时间发生重叠。", confidence: 0.72 }
              ]
            }
          })
        ]}
        onSaveAudioInsightCorrection={onSaveAudioInsightCorrection}
      />
    );

    expect(screen.getByText("声音依据")).toBeInTheDocument();
    expect(screen.getByText("音量更高")).toBeInTheDocument();
    expect(screen.getByText("停顿变多")).toBeInTheDocument();
    expect(screen.getByText("多人重叠")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("原判断"), { target: { value: "紧张" } });
    fireEvent.change(screen.getByLabelText("改成"), { target: { value: "认真" } });
    fireEvent.change(screen.getByLabelText("补充说明"), { target: { value: "用户确认不是紧张，是认真讨论。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存纠正" }));

    await waitFor(() => {
      expect(onSaveAudioInsightCorrection).toHaveBeenCalledWith({
        uploadId: "upload_1",
        insightId: "insight_1",
        correction: {
          labelCorrections: [{ from: "紧张", to: "认真" }],
          note: "用户确认不是紧张，是认真讨论。"
        }
      });
    });
  });

  it("repairs raw-looking saved semantic paragraphs into readable timeline cards", () => {
    const rawSegments: TranscriptSegment[] = [
      segment({
        id: "seg_screen",
        text: "一个实体屏幕是有价值的，但是这个就像我经常拿那个电子曲笛举例，平板电脑原来是把CPU藏在键盘下面，显示屏和键盘变成附件，软件对你的期待和优势就不一样。",
        startSeconds: 1762,
        endSeconds: 1900
      })
    ];
    const savedRawSemantic = semanticSegment({
      id: "semantic_raw_screen",
      title: "一个实体屏幕是有价值的但是呢这个就像我经常拿那…",
      summary:
        "一个实体屏幕是有价值的但是呢这个就像我经常拿那个电子曲笛了最简单的例子就平板电脑平板电脑原来是什么呢原来就是把它分成派对原来的CPU是藏在键盘下面的显示屏是显示屏像派对本来就是说计算它是藏在前面的然后那个键盘变成一个附件了就你别看它只是 我讲待,是说软件对你的期待。软件才有它的优势,就是它。",
      tags: [],
      sceneLabels: ["unknown"],
      valueLabels: [],
      sourceSegmentIds: ["seg_screen"],
      sourceTimeRange: { startSeconds: 1762, endSeconds: 1900 },
      transcriptExcerpt: rawSegments[0].text,
      startSeconds: 1762,
      endSeconds: 1900
    });

    render(<Timeline segments={rawSegments} semanticSegments={[savedRawSemantic]} />);

    const summary = screen.getByLabelText("硬件形态与软件优势讨论 语义段落摘要");

    expect(within(summary).getByText("硬件形态与软件优势讨论")).toBeInTheDocument();
    expect(within(summary).getByText("产品")).toHaveClass("tag-product");
    expect(within(summary).getByText("硬件")).toHaveClass("tag-product");
    expect(within(summary).getByText("软件")).toHaveClass("tag-business");
    expect(within(summary).getByText(/围绕实体屏幕、平板电脑形态和软件优势展开/)).toBeInTheDocument();
    expect(within(summary).queryByText(/一个实体屏幕是有价值的但是呢/)).not.toBeInTheDocument();
  });

  it("can keep semantic mode empty after search instead of falling back to raw fragments", () => {
    const rawSegments: TranscriptSegment[] = [
      segment({
        id: "seg_1",
        text: "客户合同费用需要重新评估。",
        startSeconds: 60,
        endSeconds: 90
      })
    ];

    render(<Timeline segments={rawSegments} semanticSegments={[]} preferSemanticSegments />);

    expect(screen.getByText("本次没有足够有价值的时间轴内容。")).toBeInTheDocument();
    expect(screen.queryByLabelText("客户合同费用需要重新评估 片段摘要")).not.toBeInTheDocument();
  });
});

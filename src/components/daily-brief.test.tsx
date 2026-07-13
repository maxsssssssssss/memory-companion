import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AudioInsight, BriefItem } from "@/lib/domain/types";

import { DailyBrief } from "./daily-brief";

describe("DailyBrief", () => {
  it("renders the brief item title and evidence time", () => {
    const items: BriefItem[] = [
      {
        id: "brief_1",
        uploadId: "upload_1",
        category: "commitment",
        title: "今晚把 onboarding 草案发给王敏",
        body: "承诺今天下班前整理好 onboarding 草案并发送。",
        priority: "high",
        confidence: 0.92,
        status: "confirmed",
        sourceSegmentIds: ["seg_1"],
        sourceTimeRange: {
          startSeconds: 420,
          endSeconds: 510
        },
        transcriptExcerpt: "我今晚把 onboarding 草案发给王敏。",
        people: ["王敏"],
        topics: ["onboarding"]
      }
    ];

    render(<DailyBrief items={items} />);

    expect(screen.getByText("今晚把 onboarding 草案发给王敏")).toBeInTheDocument();
    expect(screen.getByText("来源 7:00-8:30")).toBeInTheDocument();
  });

  it("explains when transcription exists but no brief item was extracted", () => {
    render(<DailyBrief items={[]} transcriptSegmentCount={3} />);

    expect(screen.getByText("已完成转写，但没有提取到简报条目。")).toBeInTheDocument();
    expect(screen.getByText("可以切到时间轴查看原文片段，或换一种问法在问答里追问。")).toBeInTheDocument();
  });

  it("explains when transcription returned no usable text", () => {
    render(<DailyBrief items={[]} transcriptSegmentCount={0} />);

    expect(screen.getByText("没有识别到可用文字。")).toBeInTheDocument();
    expect(screen.getByText("可能是录音里没有清晰人声、音量过低或过载，或转写服务返回了空结果。")).toBeInTheDocument();
  });

  it("hides the atmosphere rail when there is no evidence", () => {
    render(<DailyBrief items={[]} transcriptSegmentCount={0} audioInsights={[]} />);

    expect(screen.queryByText("今日互动气氛")).not.toBeInTheDocument();
  });

  it("shows explainable atmosphere evidence in the right rail", () => {
    const audioInsights: AudioInsight[] = [
      {
        id: "insight_1",
        uploadId: "upload_1",
        sourceSegmentIds: ["seg_1"],
        sourceTimeRange: { startSeconds: 60, endSeconds: 90 },
        speaker: { id: "speaker_1", displayName: "大叔", role: "other", confidence: 0.7 },
        voice: { pace: "normal", volume: "high", pause: "many", overlap: true, confidence: 0.72 },
        toneLabels: ["serious"],
        emotionLabels: ["anxious"],
        interactionLabels: ["tension"],
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
            features: [{ name: "pause", label: "停顿变多", value: "42", unit: "%" }]
          }
        ],
        summary: "对方追问预算风险。",
        evidence: "预算是不是还有风险？",
        confidence: 0.74
      }
    ];

    render(<DailyBrief items={[]} audioInsights={audioInsights} transcriptSegmentCount={1} />);

    expect(screen.getByText("今日互动气氛")).toBeInTheDocument();
    expect(screen.getByText("认真 x1")).toHaveClass("tag-atmosphere");
    expect(screen.getByText("偏紧 x1")).toHaveClass("tag-atmosphere");
    expect(screen.getByText("认真偏紧")).toBeInTheDocument();
    expect(screen.getByText(/1:00-1:30 · 声音 · 72%/)).toBeInTheDocument();
    expect(screen.getByText("音量升高、停顿变多，并且多人重叠。")).toBeInTheDocument();
    expect(screen.getByText("这些只作为复盘线索，需要和原文一起看，不代表心理诊断。")).toBeInTheDocument();
  });

  it("saves speaker aliases from the side rail editor", async () => {
    const onSaveSpeakerAliases = vi.fn().mockResolvedValue(undefined);

    render(
      <DailyBrief
        items={[]}
        speakerAliasTargets={[
          { uploadId: "upload_1", speakerId: "speaker_1" },
          { uploadId: "upload_1", speakerId: "speaker_2" }
        ]}
        speakerAliasesByUploadId={{ upload_1: { speaker_2: "我" } }}
        onSaveSpeakerAliases={onSaveSpeakerAliases}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("speaker_1"), { target: { value: "张三" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onSaveSpeakerAliases).toHaveBeenCalledWith({
        upload_1: {
          speaker_1: "张三",
          speaker_2: "我"
        }
      });
    });
  });
});

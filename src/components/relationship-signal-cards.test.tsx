import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RelationshipSignalCard } from "@/lib/domain/types";
import { RelationshipSignalCards } from "./relationship-signal-cards";

const card: RelationshipSignalCard = {
  id: "relationship_signal_upload_1_1",
  uploadId: "upload_1",
  date: "2026-07-09",
  signalType: "boundary_respect",
  signalCategory: "positive",
  severity: "low",
  confidence: 0.84,
  summary: "对方接受了先停一下的边界表达。",
  explanation: "这只是当前片段里的积极互动线索，不代表长期关系结论。",
  involvedSpeakers: ["speaker_1", "speaker_2"],
  timeRange: { startSeconds: 10, endSeconds: 35 },
  evidenceSegments: [
    {
      segmentId: "seg_1",
      speaker: "speaker_1",
      startSeconds: 10,
      endSeconds: 20,
      text: "刚才你一直追问的时候我有点不舒服，我想先停一下。"
    },
    {
      segmentId: "seg_2",
      speaker: "speaker_2",
      startSeconds: 20,
      endSeconds: 35,
      text: "好，我听到了。我们可以先停一下，你愿意的话再慢慢说。"
    }
  ],
  textEvidence: ["我想先停一下", "我们可以先停一下"],
  suggestedReflection: "可以留意后续对方是否也能持续尊重类似表达。",
  createdAt: "2026-07-09T00:00:00.000Z"
};

describe("RelationshipSignalCards", () => {
  it("renders a gentle empty state", () => {
    render(<RelationshipSignalCards cards={[]} />);

    expect(screen.getByText("关系信号")).toBeInTheDocument();
    expect(screen.getByText("这段录音里暂未提取到足够明确的关系信号。")).toBeInTheDocument();
  });

  it("renders grouped relationship signal card details", () => {
    render(<RelationshipSignalCards cards={[card]} />);

    expect(screen.getByText("积极信号")).toBeInTheDocument();
    expect(screen.getByText("尊重边界")).toBeInTheDocument();
    expect(screen.getByText("对方接受了先停一下的边界表达。")).toBeInTheDocument();
    expect(screen.getByText("84%")).toBeInTheDocument();
    expect(screen.getByText("speaker_1, speaker_2")).toBeInTheDocument();
    expect(screen.getByText(/0:10-0:35/)).toBeInTheDocument();
    expect(screen.getByText("可以留意后续对方是否也能持续尊重类似表达。")).toBeInTheDocument();
    expect(screen.getByText(/刚才你一直追问/)).toBeInTheDocument();
  });
});

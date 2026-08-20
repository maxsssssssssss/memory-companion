import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const realtimeSessionMock = vi.hoisted(() => ({
  failStart: false,
  instances: [] as Array<{
    options: {
      onStateChange?: (state: "idle" | "listening" | "thinking" | "speaking") => void;
      onTranscript?: (value: string) => void;
      onAnswer?: (value: string) => void;
      onTurnCompleted?: (value: {
        id: string;
        question: string;
        answer: string;
        citedSegmentIds: string[];
        citations: [];
      }) => void;
    };
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>
}));

vi.mock("./browser-realtime-voice", () => ({
  BrowserRealtimeVoiceSession: class {
    readonly start = vi.fn(async () => {
      if (realtimeSessionMock.failStart) {
        throw new Error("voice_realtime_unsupported");
      }
      this.options.onStateChange?.("listening");
    });
    readonly stop = vi.fn(async () => {
      this.options.onStateChange?.("idle");
    });

    constructor(readonly options: typeof realtimeSessionMock.instances[number]["options"]) {
      realtimeSessionMock.instances.push(this);
    }
  }
}));

import { BrowserVoiceQa } from "./browser-voice-qa";

describe("Browser realtime Voice QA", () => {
  beforeEach(() => {
    realtimeSessionMock.failStart = false;
    realtimeSessionMock.instances.splice(0);
  });

  it("selects the development realtime path and keeps turns evidence-bearing", async () => {
    const onTurnCompleted = vi.fn();
    const { container, unmount } = render(
      <BrowserVoiceQa
        realtimeEnabled
        scope="all"
        onTurnCompleted={onTurnCompleted}
      />
    );

    expect(
      container.querySelector('[data-voice-input-mode="realtime"]')
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /开始语音提问/u }));
    await waitFor(() => {
      expect(realtimeSessionMock.instances).toHaveLength(1);
      expect(realtimeSessionMock.instances[0].start).toHaveBeenCalledTimes(1);
    });

    const session = realtimeSessionMock.instances[0];
    session.options.onTranscript?.("今天有什么变化？");
    session.options.onStateChange?.("thinking");
    session.options.onAnswer?.("项目已经确认。");
    session.options.onTurnCompleted?.({
      id: "answer-1",
      question: "今天有什么变化？",
      answer: "项目已经确认。",
      citedSegmentIds: ["segment-1"],
      citations: []
    });

    expect(await screen.findByText("今天有什么变化？")).toBeInTheDocument();
    expect(screen.getByText("项目已经确认。")).toBeInTheDocument();
    expect(onTurnCompleted).toHaveBeenCalledWith(expect.objectContaining({
      id: "answer-1",
      citedSegmentIds: ["segment-1"]
    }));

    fireEvent.click(screen.getByRole("button", { name: /取消语音回答/u }));
    await waitFor(() => {
      expect(session.stop).toHaveBeenCalledTimes(1);
    });
    unmount();
  });

  it("keeps Direct comparison on the established push-to-talk path", () => {
    const { container } = render(
      <BrowserVoiceQa realtimeEnabled answerMode="direct" />
    );

    expect(
      container.querySelector('[data-voice-input-mode="realtime"]')
    ).toBeNull();
    expect(realtimeSessionMock.instances).toHaveLength(0);
  });

  it("falls back to push-to-talk after a realtime startup failure", async () => {
    realtimeSessionMock.failStart = true;
    const { container } = render(<BrowserVoiceQa realtimeEnabled />);

    fireEvent.click(screen.getByRole("button", { name: /开始语音提问/u }));
    await waitFor(() => {
      expect(
        container.querySelector('[data-voice-input-mode="realtime"]')
      ).toBeNull();
    });
    expect(realtimeSessionMock.instances[0].start).toHaveBeenCalledTimes(1);
  });
});

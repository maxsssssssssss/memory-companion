import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { QaVoiceWorkspace, useQaVoiceWorkspace } from "./qa-voice-workspace";

function VoiceContextProbe() {
  const voice = useQaVoiceWorkspace();
  return (
    <output
      data-active={String(Boolean(voice?.active))}
      data-scope={voice?.scope}
      data-upload-id={voice?.uploadId}
      data-reference-date={voice?.referenceDate}
      data-disabled-reason={voice?.unavailableReason}
    >
      文字问答
    </output>
  );
}

describe("QaVoiceWorkspace", () => {
  afterEach(() => cleanup());

  it("provides the formal voice configuration without mounting a side panel", () => {
    render(
      <QaVoiceWorkspace active scope="current" uploadId="upload_1">
        <VoiceContextProbe />
      </QaVoiceWorkspace>
    );

    const probe = screen.getByText("文字问答");
    expect(probe).toHaveAttribute("data-active", "true");
    expect(probe).toHaveAttribute("data-scope", "current");
    expect(probe).toHaveAttribute("data-upload-id", "upload_1");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("marks the voice configuration inactive with no mounted side panel", () => {
    render(
      <QaVoiceWorkspace active={false} scope="current" uploadId="upload_1">
        <VoiceContextProbe />
      </QaVoiceWorkspace>
    );

    expect(screen.getByText("文字问答")).toHaveAttribute("data-active", "false");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("keeps week context and unavailable reasons for the composer button", () => {
    const reason = "语音问答暂不支持浏览器本地优先数据。";
    render(
      <QaVoiceWorkspace active scope="week" referenceDate="2026-07-20" unavailableReason={reason}>
        <VoiceContextProbe />
      </QaVoiceWorkspace>
    );

    const probe = screen.getByText("文字问答");
    expect(probe).toHaveAttribute("data-scope", "week");
    expect(probe).toHaveAttribute("data-reference-date", "2026-07-20");
    expect(probe).toHaveAttribute("data-disabled-reason", reason);
  });

  it("does not send a reference date outside week scope", () => {
    render(
      <QaVoiceWorkspace active scope="all" referenceDate="2026-07-20">
        <VoiceContextProbe />
      </QaVoiceWorkspace>
    );

    expect(screen.getByText("文字问答")).not.toHaveAttribute("data-reference-date");
  });
});

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VoicePlayer } from "./voice-player";

describe("VoicePlayer", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("revokes its blob URL after unmount", async () => {
    const revokeObjectURL = vi.fn();
    const pause = vi.mocked(HTMLMediaElement.prototype.pause);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:voice"),
      revokeObjectURL
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const { unmount } = render(
      <VoicePlayer
        audioBase64="AQID"
        mimeType="audio/wav"
        onPlaying={vi.fn()}
        onEnded={vi.fn()}
        onError={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByLabelText("AI 语音回答")).toHaveAttribute("src", "blob:voice"));
    unmount();

    expect(pause).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:voice");
  });

  it("reports playback completion", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:voice"),
      revokeObjectURL: vi.fn()
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const onEnded = vi.fn();
    render(
      <VoicePlayer
        audioBase64="AQID"
        onPlaying={vi.fn()}
        onEnded={onEnded}
        onError={vi.fn()}
      />
    );

    const player = await screen.findByLabelText("AI 语音回答");
    fireEvent.ended(player);

    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("keeps manual controls available when autoplay is blocked", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:voice"),
      revokeObjectURL: vi.fn()
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(
      new DOMException("autoplay blocked", "NotAllowedError")
    );
    const onAutoplayBlocked = vi.fn();
    const onError = vi.fn();
    render(
      <VoicePlayer
        audioBase64="AQID"
        onPlaying={vi.fn()}
        onEnded={vi.fn()}
        onError={onError}
        onAutoplayBlocked={onAutoplayBlocked}
      />
    );

    const player = await screen.findByLabelText("AI 语音回答");
    await waitFor(() => expect(onAutoplayBlocked).toHaveBeenCalledTimes(1));

    expect(player).toBeInTheDocument();
    expect(player).toHaveAttribute("controls");
    expect(onError).not.toHaveBeenCalled();
  });
});

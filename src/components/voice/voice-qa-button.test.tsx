import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VoiceQAButton } from "./voice-qa-button";

describe("VoiceQAButton", () => {
  it("starts while idle and stops while listening", () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(
      <VoiceQAButton state="idle" onStart={onStart} onStop={onStop} />
    );

    fireEvent.click(screen.getByRole("button", { name: "开始语音提问" }));
    expect(onStart).toHaveBeenCalledTimes(1);

    rerender(<VoiceQAButton state="listening" onStart={onStart} onStop={onStop} />);
    fireEvent.click(screen.getByRole("button", { name: "结束录音" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it.each(["thinking", "speaking"] as const)("cannot start another turn while %s", (state) => {
    render(<VoiceQAButton state={state} onStart={vi.fn()} onStop={vi.fn()} />);

    expect(screen.getByRole("button")).toBeDisabled();
  });
});

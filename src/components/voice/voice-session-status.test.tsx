import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { VoiceSessionStatus } from "./voice-session-status";

describe("VoiceSessionStatus", () => {
  it("announces the active voice state", () => {
    render(<VoiceSessionStatus state="thinking" />);

    expect(screen.getByRole("status")).toHaveTextContent("正在查找相关记忆");
  });
});

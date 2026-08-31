import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DailyReflectionSessionValue } from "@/lib/client/daily-reflection-session";

import { armCaptureContextIntent, armVoiceAutostartIntent } from "./reflection-capture-intent";
import { ReflectionCapture } from "./reflection-capture";

const state = vi.hoisted(() => ({
  contentProps: null as Record<string, unknown> | null,
  router: {
    replace: vi.fn()
  },
  session: null as unknown as DailyReflectionSessionValue
}));

vi.mock("next/navigation", () => ({
  useRouter: () => state.router
}));

vi.mock("./reflection-app-shell", () => ({
  useReflectionApp: () => ({
    browserRecordingEnabled: true,
    session: state.session,
    toySyncEnabled: true
  })
}));

vi.mock("./daily-reflection-shell", () => ({
  DailyReflectionShellContent: (props: Record<string, unknown>) => {
    state.contentProps = props;
    return <div data-testid="capture-content" />;
  }
}));

function session(): DailyReflectionSessionValue {
  return {
    auth: {
      status: "authenticated",
      user: { id: "account_1", email: "user@example.com", name: null }
    },
    reflectionId: null,
    startNew: vi.fn()
  } as unknown as DailyReflectionSessionValue;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  state.contentProps = null;
  state.session = session();
});

describe("ReflectionCapture voice autostart bridge", () => {
  it("consumes the Home intent once and passes it only to record mode", async () => {
    armVoiceAutostartIntent();
    const view = render(<ReflectionCapture forceNew method="record" />);

    await waitFor(() => expect(state.contentProps?.autoStartVoice).toBe(true));
    expect(state.session.startNew).toHaveBeenCalledTimes(1);

    view.unmount();
    state.contentProps = null;
    render(<ReflectionCapture forceNew method="record" />);
    await waitFor(() => expect(state.contentProps?.autoStartVoice).toBe(false));
  });

  it("does not autostart a direct deep link or a different capture mode", async () => {
    const direct = render(<ReflectionCapture forceNew method="record" />);
    await waitFor(() => expect(state.contentProps?.autoStartVoice).toBe(false));
    direct.unmount();

    armVoiceAutostartIntent();
    state.contentProps = null;
    render(<ReflectionCapture forceNew method="upload" />);
    await waitFor(() => expect(state.contentProps?.autoStartVoice).toBe(false));
  });

  it("consumes one session-scoped reflection prompt without changing capture behavior", async () => {
    armCaptureContextIntent("回看这个决定：是否仍然适合？");
    render(<ReflectionCapture forceNew />);

    expect(await screen.findByLabelText("继续思考的提示")).toHaveTextContent(
      "回看这个决定：是否仍然适合？"
    );
    expect(state.contentProps?.autoStartVoice).toBe(false);
  });
});

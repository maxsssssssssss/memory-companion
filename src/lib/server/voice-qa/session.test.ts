// @vitest-environment node

import { describe, expect, it } from "vitest";

import { VoiceQaSession, VoiceQaSessionTransitionError } from "./session";

function clock(...timestamps: string[]) {
  const values = timestamps.map((value) => new Date(value));
  return () => values.shift() ?? new Date(timestamps.at(-1) ?? 0);
}

describe("VoiceQaSession", () => {
  it("tracks the listening, thinking, speaking, and idle lifecycle", () => {
    const session = new VoiceQaSession({
      id: " voice-session-1 ",
      userId: " user-1 ",
      now: clock(
        "2026-07-20T08:00:00.000Z",
        "2026-07-20T08:00:01.000Z",
        "2026-07-20T08:00:02.000Z",
        "2026-07-20T08:00:03.000Z",
        "2026-07-20T08:00:04.000Z",
        "2026-07-20T08:00:05.000Z"
      )
    });

    expect(session.snapshot()).toMatchObject({
      id: "voice-session-1",
      userId: "user-1",
      state: "idle",
      startedAt: "2026-07-20T08:00:00.000Z"
    });

    session.transition("listening");
    session.transition("thinking");
    session.transition("speaking");
    session.transition("idle");
    const closed = session.transition("closed");

    expect(closed.state).toBe("closed");
    expect(closed.history).toEqual([
      { from: null, to: "idle", at: "2026-07-20T08:00:00.000Z" },
      { from: "idle", to: "listening", at: "2026-07-20T08:00:01.000Z" },
      { from: "listening", to: "thinking", at: "2026-07-20T08:00:02.000Z" },
      { from: "thinking", to: "speaking", at: "2026-07-20T08:00:03.000Z" },
      { from: "speaking", to: "idle", at: "2026-07-20T08:00:04.000Z" },
      { from: "idle", to: "closed", at: "2026-07-20T08:00:05.000Z" }
    ]);
  });

  it("supports text-simulated input through idle to thinking", () => {
    const session = new VoiceQaSession({ id: "text-session" });

    expect(session.transition("thinking").state).toBe("thinking");
    expect(session.transition("idle").state).toBe("idle");
  });

  it("rejects illegal transitions without mutating state or history", () => {
    const session = new VoiceQaSession({ id: "voice-session-2" });
    const before = session.snapshot();

    expect(() => session.transition("speaking")).toThrow(VoiceQaSessionTransitionError);
    expect(() => session.transition("speaking")).toThrow(
      "Illegal Voice QA session transition: idle -> speaking"
    );
    expect(session.snapshot()).toEqual(before);
  });

  it("keeps closed sessions terminal", () => {
    const session = new VoiceQaSession({ id: "voice-session-3" });
    session.transition("closed");

    expect(() => session.transition("idle")).toThrow(VoiceQaSessionTransitionError);
    expect(session.state).toBe("closed");
  });

  it("returns defensive copies of state history", () => {
    const session = new VoiceQaSession({ id: "voice-session-4" });
    const snapshot = session.snapshot();
    snapshot.history.push({ from: "idle", to: "closed", at: "2026-01-01T00:00:00.000Z" });

    expect(session.history).toHaveLength(1);
    expect(session.state).toBe("idle");
  });
});

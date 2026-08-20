// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  RealtimeVoiceFiveTurnStableGate,
  RealtimeVoiceStableGateError,
  requireAuthorizedRealtimeVoiceProviderSession
} from "./realtime-voice-five-turn-gate";

function completeTurn(
  gate: RealtimeVoiceFiveTurnStableGate,
  turnSequence: number,
  inputAtMs: number,
  serverAtMs: number,
  playbackAtMs: number
) {
  gate.startInput(turnSequence, inputAtMs);
  gate.observeServerTerminal({ turnSequence, status: "completed", atMs: serverAtMs });
  gate.observeBrowserTerminal({
    turnSequence,
    status: "completed",
    productState: "listening",
    citationValid: true,
    spokenProjectionClean: true,
    atMs: playbackAtMs
  });
}

describe("RealtimeVoiceFiveTurnStableGate", () => {
  it("waits for slow playback before admitting each of five inputs and closes after turn five", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const gate = new RealtimeVoiceFiveTurnStableGate(20_000);
    let previousPlaybackAtMs = 0;

    for (let turnSequence = 1; turnSequence <= 5; turnSequence += 1) {
      const inputAtMs = previousPlaybackAtMs + 100;
      const serverAtMs = inputAtMs + 1_000;
      const playbackAtMs = serverAtMs + 8_000;
      completeTurn(gate, turnSequence, inputAtMs, serverAtMs, playbackAtMs);
      expect(inputAtMs).toBeGreaterThan(previousPlaybackAtMs);
      expect(gate.snapshot).toMatchObject({
        completedTurns: turnSequence,
        nextTurnSequence: turnSequence + 1,
        lastPlaybackCompleteAtMs: playbackAtMs
      });
      previousPlaybackAtMs = playbackAtMs;
    }

    gate.closeSession(previousPlaybackAtMs + 1);
    expect(gate.snapshot).toMatchObject({
      completedTurns: 5,
      sessionClosed: true
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed instead of treating the next input as a barge-in while playback is pending", () => {
    const gate = new RealtimeVoiceFiveTurnStableGate();
    gate.startInput(1, 100);
    gate.observeServerTerminal({ turnSequence: 1, status: "completed", atMs: 1_000 });

    expect(() => gate.startInput(2, 2_000)).toThrowError(
      new RealtimeVoiceStableGateError("previous_turn_playback_pending")
    );
    expect(gate.snapshot).toMatchObject({
      completedTurns: 0,
      activeTurnSequence: 1,
      failureCode: "previous_turn_playback_pending"
    });
  });

  it.each([
    ["server", "interrupted", "server_terminal_interrupted"],
    ["browser", "interrupted", "browser_terminal_interrupted"],
    ["browser", "failed", "browser_terminal_failed"]
  ] as const)("fails on %s %s and never advances", (layer, status, code) => {
    const gate = new RealtimeVoiceFiveTurnStableGate();
    gate.startInput(1, 100);
    if (layer === "server") {
      expect(() => gate.observeServerTerminal({
        turnSequence: 1,
        status,
        atMs: 200
      })).toThrow(code);
    } else {
      gate.observeServerTerminal({ turnSequence: 1, status: "completed", atMs: 200 });
      expect(() => gate.observeBrowserTerminal({
        turnSequence: 1,
        status,
        productState: "listening",
        citationValid: true,
        spokenProjectionClean: true,
        atMs: 300
      })).toThrow(code);
    }
    expect(gate.snapshot).toMatchObject({ completedTurns: 0, failureCode: code });
    expect(() => gate.startInput(2, 400)).toThrow(code);
  });

  it("fails on timeout and does not admit another turn", () => {
    const gate = new RealtimeVoiceFiveTurnStableGate(1_000);
    gate.startInput(1, 100);
    expect(() => gate.assertWithinTurnDeadline(1_101)).toThrow("turn_timeout");
    expect(() => gate.startInput(2, 1_200)).toThrow("turn_timeout");
  });

  it("rejects duplicate and stale terminals without advancing", () => {
    const duplicate = new RealtimeVoiceFiveTurnStableGate();
    duplicate.startInput(1, 100);
    duplicate.observeServerTerminal({ turnSequence: 1, status: "completed", atMs: 200 });
    expect(() => duplicate.observeServerTerminal({
      turnSequence: 1,
      status: "completed",
      atMs: 201
    })).toThrow("duplicate_server_terminal");

    const stale = new RealtimeVoiceFiveTurnStableGate();
    stale.startInput(1, 100);
    expect(() => stale.observeBrowserTerminal({
      turnSequence: 2,
      status: "completed",
      productState: "listening",
      citationValid: true,
      spokenProjectionClean: true,
      atMs: 300
    })).toThrow("stale_browser_terminal");
  });

  it("allows exactly one close only after the fifth playback completion", () => {
    const early = new RealtimeVoiceFiveTurnStableGate();
    expect(() => early.closeSession(1)).toThrow("session_closed_before_five_playbacks");

    const gate = new RealtimeVoiceFiveTurnStableGate();
    for (let turnSequence = 1; turnSequence <= 5; turnSequence += 1) {
      completeTurn(
        gate,
        turnSequence,
        turnSequence * 1_000,
        turnSequence * 1_000 + 100,
        turnSequence * 1_000 + 500
      );
    }
    gate.closeSession(5_501);
    expect(() => gate.closeSession(5_502)).toThrow("duplicate_session_close");
  });

  it("defaults the real Provider budget to zero and requires an explicit single-session grant", () => {
    expect(() => requireAuthorizedRealtimeVoiceProviderSession({})).toThrow(
      "realtime_provider_sessions_disabled"
    );
    expect(() => requireAuthorizedRealtimeVoiceProviderSession({
      PHASE1_MAX_PROVIDER_SESSIONS: "2"
    })).toThrow("invalid_realtime_provider_session_budget");
    expect(requireAuthorizedRealtimeVoiceProviderSession({
      PHASE1_MAX_PROVIDER_SESSIONS: "1"
    })).toBe(1);
  });
});

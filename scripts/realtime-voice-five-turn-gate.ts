export const REALTIME_VOICE_FIVE_TURN_COUNT = 5;
export const DEFAULT_REALTIME_VOICE_TURN_TIMEOUT_MS = 70_000;

export type RealtimeVoiceStableGateStatus = "completed" | "failed" | "interrupted";

export class RealtimeVoiceStableGateError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RealtimeVoiceStableGateError";
  }
}

type ActiveGateTurn = {
  turnSequence: number;
  inputStartedAtMs: number;
  serverTerminalAtMs?: number;
};

export type RealtimeVoiceStableGateSnapshot = {
  nextTurnSequence: number;
  activeTurnSequence?: number;
  completedTurns: number;
  lastPlaybackCompleteAtMs?: number;
  sessionClosed: boolean;
  failureCode?: string;
};

export class RealtimeVoiceFiveTurnStableGate {
  private activeTurn?: ActiveGateTurn;
  private nextTurnSequence = 1;
  private completedTurns = 0;
  private lastPlaybackCompleteAtMs?: number;
  private sessionClosed = false;
  private failureCode?: string;

  constructor(
    private readonly turnTimeoutMs = DEFAULT_REALTIME_VOICE_TURN_TIMEOUT_MS
  ) {
    if (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs <= 0) {
      throw new RealtimeVoiceStableGateError("invalid_turn_timeout");
    }
  }

  get snapshot(): RealtimeVoiceStableGateSnapshot {
    return {
      nextTurnSequence: this.nextTurnSequence,
      ...(this.activeTurn
        ? { activeTurnSequence: this.activeTurn.turnSequence }
        : {}),
      completedTurns: this.completedTurns,
      ...(this.lastPlaybackCompleteAtMs !== undefined
        ? { lastPlaybackCompleteAtMs: this.lastPlaybackCompleteAtMs }
        : {}),
      sessionClosed: this.sessionClosed,
      ...(this.failureCode ? { failureCode: this.failureCode } : {})
    };
  }

  startInput(turnSequence: number, atMs: number) {
    this.assertHealthy();
    if (this.sessionClosed) return this.fail("session_already_closed");
    if (this.activeTurn) return this.fail("previous_turn_playback_pending");
    if (turnSequence !== this.nextTurnSequence) {
      return this.fail("input_turn_out_of_order");
    }
    if (
      this.lastPlaybackCompleteAtMs !== undefined &&
      atMs <= this.lastPlaybackCompleteAtMs
    ) {
      return this.fail("input_started_before_previous_playback_complete");
    }
    this.activeTurn = { turnSequence, inputStartedAtMs: atMs };
  }

  observeServerTerminal(input: {
    turnSequence: number;
    status: RealtimeVoiceStableGateStatus;
    atMs: number;
  }) {
    const turn = this.requireActiveTurn(input.turnSequence, "server_terminal");
    if (turn.serverTerminalAtMs !== undefined) {
      return this.fail("duplicate_server_terminal");
    }
    if (input.status !== "completed") {
      return this.fail(`server_terminal_${input.status}`);
    }
    turn.serverTerminalAtMs = input.atMs;
  }

  observeBrowserTerminal(input: {
    turnSequence: number;
    status: RealtimeVoiceStableGateStatus;
    productState: string;
    citationValid: boolean;
    spokenProjectionClean: boolean;
    atMs: number;
  }) {
    const turn = this.requireActiveTurn(input.turnSequence, "browser_terminal");
    if (turn.serverTerminalAtMs === undefined) {
      return this.fail("browser_terminal_before_server_terminal");
    }
    if (input.status !== "completed") {
      return this.fail(`browser_terminal_${input.status}`);
    }
    if (input.productState !== "listening") {
      return this.fail("browser_not_listening_after_playback");
    }
    if (!input.citationValid) return this.fail("citation_invalid");
    if (!input.spokenProjectionClean) {
      return this.fail("spoken_projection_not_clean");
    }
    if (input.atMs < turn.serverTerminalAtMs) {
      return this.fail("browser_terminal_before_server_terminal");
    }
    this.lastPlaybackCompleteAtMs = input.atMs;
    this.completedTurns += 1;
    this.nextTurnSequence += 1;
    this.activeTurn = undefined;
  }

  assertWithinTurnDeadline(nowMs: number) {
    this.assertHealthy();
    if (
      this.activeTurn &&
      nowMs - this.activeTurn.inputStartedAtMs > this.turnTimeoutMs
    ) {
      this.fail("turn_timeout");
    }
  }

  closeSession(atMs: number) {
    this.assertHealthy();
    if (this.sessionClosed) return this.fail("duplicate_session_close");
    if (this.activeTurn || this.completedTurns !== REALTIME_VOICE_FIVE_TURN_COUNT) {
      return this.fail("session_closed_before_five_playbacks");
    }
    if (
      this.lastPlaybackCompleteAtMs === undefined ||
      atMs <= this.lastPlaybackCompleteAtMs
    ) {
      return this.fail("session_closed_before_final_playback_complete");
    }
    this.sessionClosed = true;
  }

  private requireActiveTurn(turnSequence: number, event: string) {
    this.assertHealthy();
    if (!this.activeTurn) this.fail(`stale_${event}`);
    if (this.activeTurn?.turnSequence !== turnSequence) {
      this.fail(`stale_${event}`);
    }
    return this.activeTurn!;
  }

  private assertHealthy() {
    if (this.failureCode) throw new RealtimeVoiceStableGateError(this.failureCode);
  }

  private fail(code: string): never {
    this.failureCode ??= code;
    throw new RealtimeVoiceStableGateError(this.failureCode);
  }
}

export function requireAuthorizedRealtimeVoiceProviderSession(
  environment: Readonly<Record<string, string | undefined>> = process.env
) {
  const raw = environment.PHASE1_MAX_PROVIDER_SESSIONS?.trim() || "0";
  if (raw !== "1") {
    throw new RealtimeVoiceStableGateError(
      raw === "0"
        ? "realtime_provider_sessions_disabled"
        : "invalid_realtime_provider_session_budget"
    );
  }
  return 1 as const;
}

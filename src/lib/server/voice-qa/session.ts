import type {
  VoiceQaSessionHistoryEntry,
  VoiceQaSessionSnapshot,
  VoiceQaSessionState
} from "./types";

export type VoiceQaSessionOptions = {
  id: string;
  userId?: string;
  now?: () => Date;
};

const LEGAL_TRANSITIONS: Readonly<Record<VoiceQaSessionState, readonly VoiceQaSessionState[]>> = {
  idle: ["listening", "thinking", "closed"],
  listening: ["thinking", "idle", "closed"],
  thinking: ["speaking", "idle", "closed"],
  speaking: ["idle", "closed"],
  closed: []
};

export class VoiceQaSessionTransitionError extends Error {
  constructor(
    readonly from: VoiceQaSessionState,
    readonly to: VoiceQaSessionState
  ) {
    super(`Illegal Voice QA session transition: ${from} -> ${to}`);
    this.name = "VoiceQaSessionTransitionError";
  }
}

function requireIdentifier(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}

function timestamp(now: () => Date) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("Voice QA session clock must return a valid Date");
  }
  return value.toISOString();
}

export class VoiceQaSession {
  readonly id: string;
  readonly userId?: string;
  readonly startedAt: string;

  private currentState: VoiceQaSessionState = "idle";
  private readonly stateHistory: VoiceQaSessionHistoryEntry[];
  private readonly now: () => Date;

  constructor(options: VoiceQaSessionOptions) {
    this.id = requireIdentifier(options.id, "Voice QA session id");
    this.userId = options.userId === undefined
      ? undefined
      : requireIdentifier(options.userId, "Voice QA user id");
    this.now = options.now ?? (() => new Date());
    this.startedAt = timestamp(this.now);
    this.stateHistory = [{ from: null, to: "idle", at: this.startedAt }];
  }

  get state(): VoiceQaSessionState {
    return this.currentState;
  }

  get history(): VoiceQaSessionHistoryEntry[] {
    return this.stateHistory.map((entry) => ({ ...entry }));
  }

  transition(nextState: VoiceQaSessionState): VoiceQaSessionSnapshot {
    if (!LEGAL_TRANSITIONS[this.currentState].includes(nextState)) {
      throw new VoiceQaSessionTransitionError(this.currentState, nextState);
    }

    const previousState = this.currentState;
    this.currentState = nextState;
    this.stateHistory.push({
      from: previousState,
      to: nextState,
      at: timestamp(this.now)
    });
    return this.snapshot();
  }

  snapshot(): VoiceQaSessionSnapshot {
    return {
      id: this.id,
      state: this.currentState,
      ...(this.userId ? { userId: this.userId } : {}),
      startedAt: this.startedAt,
      history: this.history
    };
  }
}

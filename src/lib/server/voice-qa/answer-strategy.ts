import type { QuestionAnswer } from "@/lib/domain/types";
import {
  answerQuestionWithAI,
  type AnswerQuestionWithAIInput
} from "@/lib/server/retrieval/ai-qa";

export type VoiceAnswerMode = "agent" | "direct";

export type VoiceAnswerStrategyInput = AnswerQuestionWithAIInput & {
  answerMode?: VoiceAnswerMode;
};

export type VoiceAnswerQuestionDelegate = (
  input: VoiceAnswerStrategyInput
) => Promise<QuestionAnswer>;

export interface VoiceAnswerStrategy {
  readonly mode: VoiceAnswerMode;
  answer(input: AnswerQuestionWithAIInput): Promise<QuestionAnswer>;
}

function withAnswerMode(
  input: AnswerQuestionWithAIInput,
  answerMode: VoiceAnswerMode
): VoiceAnswerStrategyInput {
  const next = Object.create(
    Object.getPrototypeOf(input),
    Object.getOwnPropertyDescriptors(input)
  ) as VoiceAnswerStrategyInput;
  Object.defineProperty(next, "answerMode", {
    value: answerMode,
    enumerable: true,
    configurable: true
  });
  return next;
}

export class VoiceAnswerModeConfigurationError extends Error {
  constructor(value: string) {
    super(`VOICE_ANSWER_MODE must be agent or direct; received ${JSON.stringify(value)}`);
    this.name = "VoiceAnswerModeConfigurationError";
  }
}

/**
 * Resolves the server-owned answer mode. Empty configuration preserves the
 * production Agent QA path; any other unknown value fails closed.
 */
export function resolveVoiceAnswerMode(
  value: string | undefined = process.env.VOICE_ANSWER_MODE
): VoiceAnswerMode {
  const normalized = value?.trim();
  if (!normalized) return "agent";
  if (normalized === "agent" || normalized === "direct") return normalized;
  throw new VoiceAnswerModeConfigurationError(normalized);
}

export class AgentQAAnswerStrategy implements VoiceAnswerStrategy {
  readonly mode = "agent" as const;

  constructor(private readonly delegate: VoiceAnswerQuestionDelegate) {}

  answer(input: AnswerQuestionWithAIInput) {
    return this.delegate(withAnswerMode(input, this.mode));
  }
}

export class DirectContextAnswerStrategy implements VoiceAnswerStrategy {
  readonly mode = "direct" as const;

  constructor(private readonly delegate: VoiceAnswerQuestionDelegate) {}

  answer(input: AnswerQuestionWithAIInput) {
    return this.delegate(withAnswerMode(input, this.mode));
  }
}

export type CreateVoiceAnswerStrategyOptions = {
  mode?: VoiceAnswerMode;
  answerQuestionWithAI?: VoiceAnswerQuestionDelegate;
};

export function createVoiceAnswerStrategy(
  options: CreateVoiceAnswerStrategyOptions = {}
): VoiceAnswerStrategy {
  const mode = options.mode ?? resolveVoiceAnswerMode();
  const delegate = options.answerQuestionWithAI ?? answerQuestionWithAI;
  return mode === "direct"
    ? new DirectContextAnswerStrategy(delegate)
    : new AgentQAAnswerStrategy(delegate);
}

import { resolveQaPromptInstruction } from "@/lib/domain/qa-prompts";

type QaPromptOverrideBody = {
  promptPresetId?: unknown;
  qaPromptPresetId?: unknown;
  customPrompt?: unknown;
  customQaPrompt?: unknown;
};

export function qaPromptInstructionFromBody(body: QaPromptOverrideBody) {
  const hasOverride =
    body.promptPresetId !== undefined ||
    body.qaPromptPresetId !== undefined ||
    body.customPrompt !== undefined ||
    body.customQaPrompt !== undefined;

  return hasOverride ? resolveQaPromptInstruction(body) : undefined;
}

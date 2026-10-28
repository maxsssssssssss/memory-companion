/** Learning-only request policy. Persist the resolved character limit on new
 * tasks; existing tasks keep their saved budget. No cumulative token quota. */
export const LEARNING_AGENT_DEFAULT_INPUT_CHARS = 200_000;
export const LEARNING_AGENT_MAX_INPUT_CHARS = 1_000_000;
// DeepSeek V4 Pro's published context is 1,048,576 tokens. A conservative UTF-8
// byte allowance also covers non-ASCII text; it is not an exact tokenizer or a
// claim that a particular gateway deployment exposes the entire model window.
export const LEARNING_AGENT_CONTEXT_WINDOW = 1_048_576;
export const LEARNING_AGENT_CONTEXT_RESERVE = 32_768;

export function learningAgentInputChars(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env.LEARNING_AGENT_DECISION_MAX_INPUT_CHARS?.trim();
  if (raw === undefined) return LEARNING_AGENT_DEFAULT_INPUT_CHARS;
  const value = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value < 1000 || value > LEARNING_AGENT_MAX_INPUT_CHARS)
    throw new RangeError("learning_agent_input_limit_invalid");
  return value;
}

import { AgentFailure } from "@/lib/server/agent/types";
import type { AgentModelConfig } from "@/lib/server/agent/model";

export function agentModelConfig(env: Readonly<Record<string, string | undefined>> = process.env): AgentModelConfig {
  const apiKey = env.LEARNING_AGENT_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
  const model = env.LEARNING_AGENT_DECISION_MODEL?.trim();
  const maxInputChars = Number(env.LEARNING_AGENT_DECISION_MAX_INPUT_CHARS);
  const maxOutputTokens = Number(env.LEARNING_AGENT_DECISION_MAX_OUTPUT_TOKENS);
  const requestTimeoutMs = Number(env.LEARNING_AGENT_DECISION_REQUEST_TIMEOUT_MS ?? 120000);
  let url: URL;
  try { url = new URL(env.OPENAI_BASE_URL ?? ""); } catch { throw new AgentFailure("known_failure", "agent_model_not_configured"); }
  if (!apiKey || env.LEARNING_AGENT_DECISION_PROVIDER !== "tokenhub" || model !== "deepseek-v4-pro"
      || !["http:", "https:"].includes(url.protocol) || url.hostname !== "tokenhub.vision-intelligence.tech" || url.port
      || !["/", "/v1", "/v1/"].includes(url.pathname) || url.username || url.password || url.search || url.hash
      || !Number.isInteger(maxInputChars) || maxInputChars < 1000 || maxInputChars > 48000
      || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 256 || maxOutputTokens > 8000
      || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 120000)
    throw new AgentFailure("known_failure", "agent_model_not_configured");
  return { baseURL: "https://tokenhub.vision-intelligence.tech/v1", apiKey, model, maxInputChars, maxOutputTokens, requestTimeoutMs };
}

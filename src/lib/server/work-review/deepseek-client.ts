import OpenAI from "openai";

import {
  assertWorkReviewAnalysisProfileSupported,
  WorkReviewRuntimeConfigError,
  type WorkReviewAnalysisProviderProfile
} from "./runtime-config";

const OFFICIAL_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/** Dedicated Work Review credentials; never consult shared OpenAI/OpenRouter settings. */
export function createWorkReviewDeepSeekClient(input: {
  profile: WorkReviewAnalysisProviderProfile;
  env?: Readonly<Record<string, string | undefined>>;
}) {
  if (input.profile.provider !== "deepseek-structured-json") {
    throw new WorkReviewRuntimeConfigError(
      "work_review_deepseek_profile_required",
      "Work Review DeepSeek client requires a DeepSeek analysis profile"
    );
  }
  assertWorkReviewAnalysisProfileSupported(input.profile);
  const env = input.env ?? process.env;
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new WorkReviewRuntimeConfigError(
      "work_review_deepseek_api_key_missing",
      "DEEPSEEK_API_KEY is required for Work Review DeepSeek analysis"
    );
  }
  const baseURL = (env.DEEPSEEK_BASE_URL?.trim() || OFFICIAL_DEEPSEEK_BASE_URL).replace(/\/+$/, "");
  if (baseURL !== OFFICIAL_DEEPSEEK_BASE_URL) {
    throw new WorkReviewRuntimeConfigError(
      "work_review_deepseek_base_url_invalid",
      "Work Review DeepSeek analysis requires the official root endpoint"
    );
  }
  return new OpenAI({
    apiKey,
    baseURL: OFFICIAL_DEEPSEEK_BASE_URL,
    timeout: input.profile.timeoutMs,
    maxRetries: 0,
    fetchOptions: { redirect: "error" },
    logLevel: "off",
    organization: null,
    project: null
  });
}

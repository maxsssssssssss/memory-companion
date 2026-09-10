import OpenAI from "openai";

import {
  assertWorkReviewAnalysisProfileSupported,
  WorkReviewRuntimeConfigError,
  type WorkReviewAnalysisProviderProfile
} from "./runtime-config";

const TOKENHUB_BASE_URL = "https://tokenhub.vision-intelligence.tech/v1";

/** Bind the adopted TokenHub credential to HTTPS without reading saved provider settings. */
export function createWorkReviewTokenHubClient(input: {
  profile: WorkReviewAnalysisProviderProfile;
  env?: Readonly<Record<string, string | undefined>>;
}) {
  if (input.profile.provider !== "tokenhub-structured-json") {
    throw new WorkReviewRuntimeConfigError(
      "work_review_tokenhub_profile_required",
      "Work Review TokenHub client requires a TokenHub analysis profile"
    );
  }
  assertWorkReviewAnalysisProfileSupported(input.profile);
  const env = input.env ?? process.env;
  let configured: URL | undefined;
  try { configured = new URL(env.OPENAI_BASE_URL?.trim() ?? ""); } catch { /* Safe config error below. */ }
  if (!configured || !["http:", "https:"].includes(configured.protocol)
    || configured.hostname !== "tokenhub.vision-intelligence.tech"
    || configured.username || configured.password || configured.port || configured.search || configured.hash
    || !["/", "/v1", "/v1/"].includes(configured.pathname)) {
    throw new WorkReviewRuntimeConfigError(
      "work_review_tokenhub_base_url_invalid",
      "Work Review TokenHub analysis requires the configured TokenHub endpoint"
    );
  }
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new WorkReviewRuntimeConfigError(
      "work_review_tokenhub_api_key_missing",
      "The configured TokenHub OPENAI_API_KEY is required for Work Review analysis"
    );
  }
  return new OpenAI({
    apiKey,
    baseURL: TOKENHUB_BASE_URL,
    timeout: input.profile.timeoutMs,
    maxRetries: 0,
    fetchOptions: { redirect: "error" },
    logLevel: "off",
    organization: null,
    project: null,
    ...(env.OPENAI_AUTH_HEADER_MODE?.trim().toLowerCase() === "raw"
      ? { defaultHeaders: { Authorization: apiKey } } : {})
  });
}

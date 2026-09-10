// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkReviewDeepSeekClient } from "./deepseek-client";
import { resolveWorkReviewExtractorProfile } from "./runtime-config";

const profile = resolveWorkReviewExtractorProfile({
  WORK_REVIEW_EXTRACTOR_PROVIDER: "deepseek-structured-json",
  WORK_REVIEW_EXTRACTOR_MODEL: "deepseek-v4-flash",
  WORK_REVIEW_EXTRACTOR_REASONING_EFFORT: "none"
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Work Review DeepSeek client", () => {
  it("uses only dedicated credentials and a non-redirecting request with zero retries", async () => {
    vi.stubEnv("OPENAI_API_KEY", "PRIVATE_OPENAI_KEY");
    vi.stubEnv("OPENAI_ORG_ID", "PRIVATE_OPENAI_ORG");
    vi.stubEnv("OPENAI_PROJECT_ID", "PRIVATE_OPENAI_PROJECT");
    vi.stubEnv("OPENAI_AUTH_HEADER_MODE", "raw");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("{}", {
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetch);
    const client = createWorkReviewDeepSeekClient({
      profile,
      env: {
        DEEPSEEK_API_KEY: "  PRIVATE_DEEPSEEK_KEY  ",
        DEEPSEEK_BASE_URL: "https://api.deepseek.com///",
        OPENAI_API_KEY: "PRIVATE_OTHER_KEY",
        OPENROUTER_API_KEY: "PRIVATE_ROUTER_KEY",
        OPENAI_BASE_URL: "https://private-other.example"
      }
    });
    expect(client.maxRetries).toBe(0);
    expect(client.timeout).toBe(profile.timeoutMs);
    expect(client.logLevel).toBe("off");
    expect(client.organization).toBeNull();
    expect(client.project).toBeNull();
    const response = await client.responses.create({ model: profile.model, input: "fixture" }).asResponse();
    await response.text();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.deepseek.com/responses");
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer PRIVATE_DEEPSEEK_KEY");
    expect(headers.has("openai-organization")).toBe(false);
    expect(headers.has("openai-project")).toBe(false);
  });

  it("defaults to the official root when the dedicated endpoint is absent", () => {
    const client = createWorkReviewDeepSeekClient({ profile, env: { DEEPSEEK_API_KEY: "fixture" } });
    expect(client.baseURL).toBe("https://api.deepseek.com");
  });

  it("does not substitute OpenAI/OpenRouter credentials when the dedicated key is missing", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(() => createWorkReviewDeepSeekClient({ profile, env: {
      OPENAI_API_KEY: "PRIVATE_OPENAI_KEY", OPENROUTER_API_KEY: "PRIVATE_ROUTER_KEY"
    } })).toThrowError(expect.objectContaining({ code: "work_review_deepseek_api_key_missing" }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "https://private-route.example",
    "https://api.deepseek.com/v1",
    "https://api.deepseek.com?secret=PRIVATE_QUERY",
    "https://PRIVATE_USER:PRIVATE_PASSWORD@api.deepseek.com",
    "http://api.deepseek.com",
    "https://api.deepseek.com/#PRIVATE_FRAGMENT"
  ])("fails closed on a non-allowlisted endpoint without requests or raw diagnostics", (baseURL) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const logs = [vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    let failure: unknown;
    try {
      createWorkReviewDeepSeekClient({ profile, env: { DEEPSEEK_API_KEY: "PRIVATE_KEY", DEEPSEEK_BASE_URL: baseURL } });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "work_review_deepseek_base_url_invalid" });
    expect(String(failure)).not.toContain(baseURL);
    expect(String(failure)).not.toContain("PRIVATE");
    expect(fetch).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each(["fixture", "openai-compatible-structured-json"] as const)("rejects %s before constructing a client", (provider) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(() => createWorkReviewDeepSeekClient({
      profile: { ...profile, provider }, env: { DEEPSEEK_API_KEY: "fixture" }
    })).toThrowError(expect.objectContaining({ code: "work_review_deepseek_profile_required" }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks a directly injected DeepSeek model before constructing a client", () => {
    expect(() => createWorkReviewDeepSeekClient({
      profile: { ...profile, model: "PRIVATE_UNSUPPORTED_MODEL" }, env: { DEEPSEEK_API_KEY: "fixture" }
    })).toThrowError(expect.objectContaining({ code: "work_review_analysis_model_unsupported" }));
  });
});

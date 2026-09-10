// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkReviewTokenHubClient } from "./tokenhub-client";
import { resolveWorkReviewExtractorProfile } from "./runtime-config";

const profile = resolveWorkReviewExtractorProfile({
  WORK_REVIEW_EXTRACTOR_PROVIDER: "tokenhub-structured-json",
  WORK_REVIEW_EXTRACTOR_MODEL: "deepseek-v4-pro",
  WORK_REVIEW_EXTRACTOR_REASONING_EFFORT: "none"
});
const env = { OPENAI_BASE_URL: "http://tokenhub.vision-intelligence.tech", OPENAI_API_KEY: "PRIVATE_TOKENHUB_KEY" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Work Review TokenHub client", () => {
  it("uses the TokenHub key over HTTPS /v1 with no shared routing, redirects or retries", async () => {
    vi.stubEnv("OPENAI_ORG_ID", "PRIVATE_ORG");
    vi.stubEnv("OPENAI_PROJECT_ID", "PRIVATE_PROJECT");
    vi.stubEnv("OPENAI_LOG", "debug");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("{}", {
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetch);
    const client = createWorkReviewTokenHubClient({ profile, env: {
      ...env, OPENROUTER_API_KEY: "PRIVATE_ROUTER_KEY", DEEPSEEK_API_KEY: "PRIVATE_OFFICIAL_KEY"
    } });
    expect(client.maxRetries).toBe(0);
    expect(client.timeout).toBe(profile.timeoutMs);
    expect(client.logLevel).toBe("off");
    expect(client.organization).toBeNull();
    expect(client.project).toBeNull();
    await (await client.responses.create({ model: profile.model, input: "fixture" }).asResponse()).text();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://tokenhub.vision-intelligence.tech/v1/responses");
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer PRIVATE_TOKENHUB_KEY");
    expect(headers.has("openai-organization")).toBe(false);
    expect(headers.has("openai-project")).toBe(false);
  });

  it.each([undefined, "https://api.openai.com/v1", "https://tokenhub.vision-intelligence.tech/wrong",
    "https://PRIVATE_USER:PRIVATE_PASSWORD@tokenhub.vision-intelligence.tech",
    "https://tokenhub.vision-intelligence.tech?secret=PRIVATE_QUERY",
    "https://tokenhub.vision-intelligence.tech/#PRIVATE_FRAGMENT",
    "https://tokenhub.vision-intelligence.tech:9999"])("rejects unbound credentials before network access", (baseURL) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    let failure: unknown;
    try { createWorkReviewTokenHubClient({ profile, env: { ...env, OPENAI_BASE_URL: baseURL } }); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "work_review_tokenhub_base_url_invalid" });
    expect(String(failure)).not.toContain("PRIVATE");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not substitute official DeepSeek or OpenRouter keys", () => {
    expect(() => createWorkReviewTokenHubClient({ profile, env: {
      ...env, OPENAI_API_KEY: " ", DEEPSEEK_API_KEY: "fixture", OPENROUTER_API_KEY: "fixture"
    } })).toThrowError(expect.objectContaining({ code: "work_review_tokenhub_api_key_missing" }));
  });

  it.each(["fixture", "openai-compatible-structured-json", "deepseek-structured-json"] as const)(
    "rejects a %s profile instead of rerouting it", (provider) => {
      expect(() => createWorkReviewTokenHubClient({ profile: { ...profile, provider }, env }))
        .toThrowError(expect.objectContaining({ code: "work_review_tokenhub_profile_required" }));
    }
  );
});

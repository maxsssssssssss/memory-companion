import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { OpenAIMock } = vi.hoisted(() => ({
  OpenAIMock: vi.fn()
}));

vi.mock("openai", () => ({
  default: OpenAIMock
}));

import { createOpenAIClient, resolveOpenAIClientProvider } from "./client";

describe("createOpenAIClient", () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalOpenAiBase = process.env.OPENAI_BASE_URL;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const originalOpenRouterBase = process.env.OPENROUTER_BASE_URL;
  const originalReferer = process.env.OPENROUTER_HTTP_REFERER;
  const originalAppTitle = process.env.OPENROUTER_APP_TITLE;
  const originalAuthHeaderMode = process.env.OPENAI_AUTH_HEADER_MODE;

  beforeEach(() => {
    OpenAIMock.mockReset();
  });

  afterEach(() => {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
    if (originalOpenAiBase === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = originalOpenAiBase;
    }
    if (originalOpenRouterKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    }
    if (originalOpenRouterBase === undefined) {
      delete process.env.OPENROUTER_BASE_URL;
    } else {
      process.env.OPENROUTER_BASE_URL = originalOpenRouterBase;
    }
    if (originalReferer === undefined) {
      delete process.env.OPENROUTER_HTTP_REFERER;
    } else {
      process.env.OPENROUTER_HTTP_REFERER = originalReferer;
    }
    if (originalAppTitle === undefined) {
      delete process.env.OPENROUTER_APP_TITLE;
    } else {
      process.env.OPENROUTER_APP_TITLE = originalAppTitle;
    }
    if (originalAuthHeaderMode === undefined) {
      delete process.env.OPENAI_AUTH_HEADER_MODE;
    } else {
      process.env.OPENAI_AUTH_HEADER_MODE = originalAuthHeaderMode;
    }
  });

  it("supports OPENROUTER_API_KEY fallback key", () => {
    process.env.OPENROUTER_API_KEY = "openrouter_key";

    createOpenAIClient();

    expect(OpenAIMock).toHaveBeenCalledWith({
      apiKey: "openrouter_key",
      organization: undefined,
      project: undefined,
      timeout: 600000,
      maxRetries: 2
    });
  });

  it("falls back to OPENROUTER_API_KEY when OPENAI_API_KEY is empty", () => {
    process.env.OPENAI_API_KEY = "   ";
    process.env.OPENROUTER_API_KEY = "openrouter_key";

    createOpenAIClient();

    expect(OpenAIMock).toHaveBeenCalledWith({
      apiKey: "openrouter_key",
      organization: undefined,
      project: undefined,
      timeout: 600000,
      maxRetries: 2
    });
  });

  it("prefers OPENROUTER_BASE_URL when using OPENROUTER_API_KEY", () => {
    process.env.OPENAI_API_KEY = "";
    process.env.OPENROUTER_API_KEY = "openrouter_key";
    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
    process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

    createOpenAIClient();

    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "openrouter_key",
        baseURL: "https://openrouter.ai/api/v1"
      })
    );
  });

  it("uses OpenRouter key when OpenRouter base URL is configured with both keys present", () => {
    process.env.OPENAI_API_KEY = "openai_key";
    process.env.OPENROUTER_API_KEY = "openrouter_key";
    process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.OPENROUTER_HTTP_REFERER = "https://example.com";
    process.env.OPENROUTER_APP_TITLE = "Founder Daily Brief";

    createOpenAIClient();

    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "openrouter_key",
        baseURL: "https://openrouter.ai/api/v1",
        defaultHeaders: {
          "HTTP-Referer": "https://example.com",
          "X-Title": "Founder Daily Brief"
        }
      })
    );
  });

  it("uses locally configured OpenRouter key before default environment keys", () => {
    process.env.OPENAI_API_KEY = "default_openai_key";
    process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

    createOpenAIClient({ openRouterApiKey: "user_openrouter_key" });

    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "user_openrouter_key",
        baseURL: "https://openrouter.ai/api/v1"
      })
    );
  });

  it("can send the API key as the raw Authorization header for Nexus-compatible gateways", () => {
    process.env.OPENAI_API_KEY = "nexus_key";
    process.env.OPENAI_BASE_URL = "http://tokenhub.vision-intelligence.tech";
    process.env.OPENAI_AUTH_HEADER_MODE = "raw";

    createOpenAIClient();

    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "nexus_key",
        baseURL: "http://tokenhub.vision-intelligence.tech",
        defaultHeaders: {
          Authorization: "nexus_key"
        }
      })
    );
  });

  it("identifies a Tokenhub base URL as an OpenAI-compatible provider", () => {
    process.env.OPENAI_API_KEY = "tokenhub_key";
    process.env.OPENAI_BASE_URL = "http://tokenhub.vision-intelligence.tech";
    process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

    expect(resolveOpenAIClientProvider()).toBe("openai-compatible");
  });

  it("identifies a user-scoped OpenRouter key as the OpenRouter provider", () => {
    process.env.OPENAI_API_KEY = "tokenhub_key";
    process.env.OPENAI_BASE_URL = "http://tokenhub.vision-intelligence.tech";

    expect(resolveOpenAIClientProvider({ openRouterApiKey: "user_openrouter_key" })).toBe("openrouter");
  });
});

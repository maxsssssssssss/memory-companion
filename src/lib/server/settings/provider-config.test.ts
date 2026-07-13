import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonStore } from "../storage/json-store";
import {
  getProviderSettingsView,
  getQaModelPreference,
  getQaPromptPreference,
  QaModelProviderMismatchError
} from "./provider-config";

const storeMock = {
  read: vi.fn(),
  write: vi.fn(),
  delete: vi.fn(),
  list: vi.fn()
};

describe("provider config", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENROUTER_QA_MODEL;
    delete process.env.OPENAI_QA_MODEL;
    delete process.env.OPENAI_TEXT_MODEL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_BASE_URL;
    delete process.env.APP_DATA_DIR;
    delete process.env.APP_STORAGE_MODE;
  });

  it("uses OPENAI_QA_MODEL for Tokenhub and warns about the ignored OpenRouter model", async () => {
    storeMock.read.mockResolvedValue({ apiKeyMode: "default" });
    process.env.OPENAI_API_KEY = "tokenhub_key";
    process.env.OPENAI_BASE_URL = "http://tokenhub.vision-intelligence.tech";
    process.env.OPENAI_QA_MODEL = "gpt-5.5";
    process.env.OPENROUTER_QA_MODEL = "openai/gpt-5-mini";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(getQaModelPreference(storeMock as unknown as JsonStore)).resolves.toBe("gpt-5.5");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("ignored_env=OPENROUTER_QA_MODEL"));
  });

  it("rejects an OpenRouter-style model configured for Tokenhub", async () => {
    storeMock.read.mockResolvedValue({ apiKeyMode: "default" });
    process.env.OPENAI_API_KEY = "tokenhub_key";
    process.env.OPENAI_BASE_URL = "http://tokenhub.vision-intelligence.tech";
    process.env.OPENAI_QA_MODEL = "openai/gpt-5-mini";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(getQaModelPreference(storeMock as unknown as JsonStore)).rejects.toBeInstanceOf(QaModelProviderMismatchError);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("QA model provider mismatch"));
  });

  it("keeps OPENROUTER_QA_MODEL for a user-scoped OpenRouter provider", async () => {
    storeMock.read.mockResolvedValue({ apiKeyMode: "custom", openRouterApiKey: "user_openrouter_key" });
    process.env.OPENAI_QA_MODEL = "gpt-5.5";
    process.env.OPENROUTER_QA_MODEL = "openai/gpt-5-mini";
    process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(getQaModelPreference(storeMock as unknown as JsonStore)).resolves.toBe("openai/gpt-5-mini");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("ignored_env=OPENAI_QA_MODEL"));
  });

  it("does not let the extraction text model override the QA default", async () => {
    storeMock.read.mockResolvedValue({ apiKeyMode: "default" });
    process.env.OPENAI_TEXT_MODEL = "gpt-4.1-mini";

    await expect(getQaModelPreference(storeMock as unknown as JsonStore)).resolves.not.toBe("gpt-4.1-mini");
  });

  it("uses a saved custom QA prompt when the custom role is selected", async () => {
    storeMock.read.mockResolvedValue({
      apiKeyMode: "default",
      qaPromptPresetId: "custom",
      customQaPrompt: "请像听课助教一样回答，优先整理概念、例子和复习问题。"
    });

    await expect(getQaPromptPreference(storeMock as unknown as JsonStore)).resolves.toContain("听课助教");
  });

  it("falls back to a preset QA prompt when custom role text is empty", async () => {
    storeMock.read.mockResolvedValue({
      apiKeyMode: "default",
      qaPromptPresetId: "negotiation",
      customQaPrompt: "   "
    });

    await expect(getQaPromptPreference(storeMock as unknown as JsonStore)).resolves.toContain("商务谈判");
  });

  it("exposes server storage paths for internal online validation", async () => {
    storeMock.read.mockResolvedValue({ apiKeyMode: "default" });
    process.env.APP_DATA_DIR = "/var/data/daily-brief";
    process.env.APP_STORAGE_MODE = "server";

    await expect(getProviderSettingsView(storeMock as unknown as JsonStore)).resolves.toEqual(
      expect.objectContaining({
        storageMode: "server",
        canOpenDataFolder: false,
        dataDirectory: "/var/data/daily-brief",
        uploadsDirectory: "/var/data/daily-brief/uploads",
        apiKeyStoragePath: "/var/data/daily-brief/settings/provider-config.json"
      })
    );
  });
});

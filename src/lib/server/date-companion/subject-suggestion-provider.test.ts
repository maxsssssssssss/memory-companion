import { describe, expect, it, vi } from "vitest";

import {
  DATE_COMPANION_SUBJECT_DEFAULT_TIMEOUT_MS,
  DATE_COMPANION_SUBJECT_MODEL,
  QwenDateCompanionSubjectSuggestionProvider,
  SubjectSuggestionProviderOutputError,
  SubjectSuggestionProviderUnavailableError,
  mapDateCompanionSubjectClassification,
  resolveDateCompanionSubjectSuggestionConfig
} from "./subject-suggestion-provider";

const config = {
  baseUrl: "http://127.0.0.1:8700/v1",
  apiKey: "test-only",
  model: DATE_COMPANION_SUBJECT_MODEL,
  reasoningEnabled: false as const,
  timeoutMs: DATE_COMPANION_SUBJECT_DEFAULT_TIMEOUT_MS
};

function source(canonicalSourceKey = "a".repeat(64)) {
  return {
    canonicalSourceKey,
    quote: "我希望我们下周一起去看展。",
    recapContexts: [{
      recapItemId: "recap_1",
      kind: "moment" as const,
      text: "下周一起看展"
    }]
  };
}

describe("Qwen Date Companion Subject suggestion provider", () => {
  it("pins Qwen3.6-27B, false thinking and a loopback endpoint", () => {
    expect(resolveDateCompanionSubjectSuggestionConfig({
      VLLM_BASE_URL: "http://localhost:8700/v1",
      VLLM_API_KEY: "secret",
      VLLM_MODEL: DATE_COMPANION_SUBJECT_MODEL,
      VLLM_ENABLE_THINKING: "false",
      NODE_ENV: "test"
    } as NodeJS.ProcessEnv)).toEqual({
      baseUrl: "http://localhost:8700/v1",
      apiKey: "secret",
      model: DATE_COMPANION_SUBJECT_MODEL,
      reasoningEnabled: false,
      timeoutMs: DATE_COMPANION_SUBJECT_DEFAULT_TIMEOUT_MS
    });
    expect(resolveDateCompanionSubjectSuggestionConfig({
      DATE_COMPANION_SUBJECT_SUGGESTION_TIMEOUT_MS: "120000",
      NODE_ENV: "test"
    } as NodeJS.ProcessEnv).timeoutMs).toBe(120_000);
    expect(() => resolveDateCompanionSubjectSuggestionConfig({
      VLLM_BASE_URL: "https://external.example/v1",
      NODE_ENV: "test"
    } as NodeJS.ProcessEnv)).toThrow(/loopback/u);
    expect(() => resolveDateCompanionSubjectSuggestionConfig({
      VLLM_ENABLE_THINKING: "true",
      NODE_ENV: "test"
    } as NodeJS.ProcessEnv)).toThrow(/must be false/u);
    expect(() => resolveDateCompanionSubjectSuggestionConfig({
      DATE_COMPANION_SUBJECT_SUGGESTION_TIMEOUT_MS: "forever",
      NODE_ENV: "test"
    } as NodeJS.ProcessEnv)).toThrow(/must be an integer/u);
    expect(() => resolveDateCompanionSubjectSuggestionConfig({
      DATE_COMPANION_SUBJECT_SUGGESTION_TIMEOUT_MS: "999999",
      NODE_ENV: "test"
    } as NodeJS.ProcessEnv)).toThrow(/between 60000 and 300000/u);
  });

  it("uses one temperature-zero strict JSON-schema request for the whole batch", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request).toMatchObject({
        model: DATE_COMPANION_SUBJECT_MODEL,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
        response_format: {
          type: "json_schema",
          json_schema: { strict: true }
        }
      });
      expect(request).not.toHaveProperty("response_format.json_schema.schema.properties.suggestions.items.properties.proposedSubject");
      expect(request).not.toHaveProperty("response_format.json_schema.schema.properties.suggestions.items.properties.reasonCode");
      expect(request).toHaveProperty(
        "response_format.json_schema.schema.properties.suggestions.items.properties.classification.enum",
        [
          "self_explicit",
          "companion_explicit",
          "both_mutual",
          "unknown_third_party",
          "unknown_mixed_subject",
          "unknown_ambiguous_pronoun",
          "unknown_insufficient_context",
          "unknown_low_confidence"
        ]
      );
      expect(JSON.stringify(request)).not.toContain("gpt-5.5");
      return Response.json({
        choices: [{
          message: {
            content: JSON.stringify({
              suggestions: [
                {
                  canonicalSourceKey: "a".repeat(64),
                  classification: "both_mutual",
                  confidence: 0.96
                },
                {
                  canonicalSourceKey: "b".repeat(64),
                  classification: "companion_explicit",
                  confidence: 0.93
                }
              ]
            })
          }
        }]
      });
    });
    const provider = new QwenDateCompanionSubjectSuggestionProvider({ config, fetch: fetchMock });
    const result = await provider.suggest([source(), source("b".repeat(64))]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.map((item) => item.proposedSubject)).toEqual(["both", "companion"]);
  });

  it("uses the configured timeout and does not retry an unavailable Provider", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true
        });
      })
    );
    const provider = new QwenDateCompanionSubjectSuggestionProvider({
      config: { ...config, timeoutMs: 10 },
      fetch: fetchMock
    });
    await expect(provider.suggest([source()])).rejects.toBeInstanceOf(
      SubjectSuggestionProviderUnavailableError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails low confidence, third-party and mixed-subject results closed to unknown", async () => {
    const outputs = [
      { classification: "self_explicit", confidence: 0.79 },
      { classification: "unknown_third_party", confidence: 0.99 },
      { classification: "unknown_mixed_subject", confidence: 0.99 }
    ];
    const fetchMock = vi.fn(async () => Response.json({
      choices: [{
        message: {
          content: JSON.stringify({
            suggestions: outputs.map((output, index) => ({
              canonicalSourceKey: String.fromCharCode(97 + index).repeat(64),
              ...output
            }))
          })
        }
      }]
    }));
    const provider = new QwenDateCompanionSubjectSuggestionProvider({ config, fetch: fetchMock });
    const result = await provider.suggest([
      source("a".repeat(64)),
      source("b".repeat(64)),
      source("c".repeat(64))
    ]);
    expect(result.map((item) => item.proposedSubject)).toEqual(["unknown", "unknown", "unknown"]);
    expect(result.map((item) => item.reasonCode)).toEqual(["low_confidence", "third_party", "mixed_subject"]);
  });

  it("maps every indivisible classification to one deterministic Subject and reason", () => {
    const mappings = [
      ["self_explicit", "self", "explicit_self_reference"],
      ["companion_explicit", "companion", "explicit_companion_reference"],
      ["both_mutual", "both", "mutual_relationship_context"],
      ["unknown_third_party", "unknown", "third_party"],
      ["unknown_mixed_subject", "unknown", "mixed_subject"],
      ["unknown_ambiguous_pronoun", "unknown", "ambiguous_pronoun"],
      ["unknown_insufficient_context", "unknown", "insufficient_context"],
      ["unknown_low_confidence", "unknown", "low_confidence"]
    ] as const;
    expect(mappings.map(([classification]) => mapDateCompanionSubjectClassification({
      canonicalSourceKey: "a".repeat(64),
      classification,
      confidence: 0.95
    }))).toEqual(mappings.map(([, proposedSubject, reasonCode]) => ({
      canonicalSourceKey: "a".repeat(64),
      proposedSubject,
      confidence: 0.95,
      reasonCode
    })));
  });

  it("rejects the legacy cross-combinable Provider shape", async () => {
    const provider = new QwenDateCompanionSubjectSuggestionProvider({
      config,
      fetch: vi.fn(async () => Response.json({
        choices: [{
          message: {
            content: JSON.stringify({
              suggestions: [{
                canonicalSourceKey: "a".repeat(64),
                proposedSubject: "both",
                confidence: 0.96,
                reasonCode: "explicit_companion_reference"
              }]
            })
          }
        }]
      }))
    });
    await expect(provider.suggest([source()])).rejects.toBeInstanceOf(
      SubjectSuggestionProviderOutputError
    );
  });

  it("rejects malformed Provider content instead of inventing a result", async () => {
    const provider = new QwenDateCompanionSubjectSuggestionProvider({
      config,
      fetch: vi.fn(async () => Response.json({
        choices: [{ message: { content: "not-json" } }]
      }))
    });
    await expect(provider.suggest([source()])).rejects.toBeInstanceOf(
      SubjectSuggestionProviderOutputError
    );
  });
});

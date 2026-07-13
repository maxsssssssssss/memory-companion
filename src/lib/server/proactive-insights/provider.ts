import type { ProactiveInsightContext } from "@/lib/domain/proactive-insights";

import { createDeepseekProactiveInsightProvider, type ProactiveInsightRunResult } from "./deepseek-provider";
import type { ProactiveInsightMemoryContext } from "./memory-context";

type ProviderName = "deepseek" | "none";

type ProviderDependencies = Parameters<typeof createDeepseekProactiveInsightProvider>[0];

export type ProactiveInsightProvider = {
  generate(input: {
    context: ProactiveInsightContext;
    memoryContext?: ProactiveInsightMemoryContext;
    sourceFingerprint?: string;
    createdAt?: string;
    maxItems?: number;
  }): Promise<ProactiveInsightRunResult>;
};

function normalizeProviderName(value: string | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function getProviderNameByEnv(): ProviderName {
  const providerName = normalizeProviderName(process.env.PROACTIVE_INSIGHT_PROVIDER);
  if (!providerName || providerName === "none") {
    return "none";
  }
  if (providerName === "deepseek") {
    return "deepseek";
  }
  throw new Error(`Unknown proactive insight provider: ${providerName}`);
}

function disabledProvider(): ProactiveInsightProvider {
  return {
    async generate(input) {
      return {
        status: "disabled",
        items: [],
        provider: "none",
        model: undefined,
        elapsedMs: 0,
        sourceFingerprint: input.sourceFingerprint ?? "disabled"
      };
    }
  };
}

export function createProactiveInsightProvider(deps: ProviderDependencies = {}): ProactiveInsightProvider {
  return getProviderNameByEnv() === "deepseek" ? createDeepseekProactiveInsightProvider(deps) : disabledProvider();
}

export function getProactiveInsightProvider(deps: ProviderDependencies = {}) {
  return createProactiveInsightProvider(deps);
}

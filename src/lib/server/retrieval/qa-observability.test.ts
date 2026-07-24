import { describe, expect, it, vi } from "vitest";

import {
  QaExecutionDiagnosticsSchema,
  notifyQaExecutionDiagnostics,
  safeElapsedMs,
  type QaExecutionDiagnostics
} from "./qa-observability";

function diagnostics(
  overrides: Partial<QaExecutionDiagnostics> = {}
): QaExecutionDiagnostics {
  return {
    answerMode: "agent",
    memoryRetrievalMs: 4,
    relationshipContextBuildingMs: 2,
    rerankingMs: 1,
    promptConstructionMs: 3,
    llmGenerationMs: 40,
    responseValidationMs: 2,
    totalMs: 52,
    promptCharacters: 1_200,
    responseCharacters: 160,
    evidenceCount: 8,
    providerCallCount: 1,
    fallbackReason: "none",
    ...overrides
  };
}

describe("QaExecutionDiagnosticsSchema", () => {
  it("accepts complete non-negative diagnostics and explicit null measurements", () => {
    expect(QaExecutionDiagnosticsSchema.parse(diagnostics())).toEqual(diagnostics());

    const withUnavailableStages = diagnostics({
      memoryRetrievalMs: null,
      relationshipContextBuildingMs: null,
      promptCharacters: null,
      responseCharacters: null
    });
    expect(QaExecutionDiagnosticsSchema.parse(withUnavailableStages)).toEqual(withUnavailableStages);
  });

  it("requires every timing field instead of treating a missing measurement as zero", () => {
    const missing = { ...diagnostics() } as Record<string, unknown>;
    delete missing.rerankingMs;

    expect(QaExecutionDiagnosticsSchema.safeParse(missing).success).toBe(false);
  });

  it("rejects null or missing values for non-nullable required fields", () => {
    expect(QaExecutionDiagnosticsSchema.safeParse({
      ...diagnostics(),
      totalMs: null
    }).success).toBe(false);

    const missing = { ...diagnostics() } as Record<string, unknown>;
    delete missing.providerCallCount;
    expect(QaExecutionDiagnosticsSchema.safeParse(missing).success).toBe(false);
  });

  it("rejects unknown fields, invalid counts, and an unbounded fallback reason", () => {
    expect(QaExecutionDiagnosticsSchema.safeParse({
      ...diagnostics(),
      rawPrompt: "private content"
    }).success).toBe(false);
    expect(QaExecutionDiagnosticsSchema.safeParse(diagnostics({
      evidenceCount: -1
    })).success).toBe(false);
    expect(QaExecutionDiagnosticsSchema.safeParse(diagnostics({
      fallbackReason: "x".repeat(129)
    })).success).toBe(false);
  });
});

describe("safeElapsedMs", () => {
  it("rounds monotonic elapsed time and clamps invalid or negative intervals", () => {
    expect(safeElapsedMs(10, 21.6)).toBe(12);
    expect(safeElapsedMs(21, 10)).toBe(0);
    expect(safeElapsedMs(Number.NaN, 10)).toBe(0);
    expect(safeElapsedMs(10, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("notifyQaExecutionDiagnostics", () => {
  it("delivers a validated snapshot to the observer", () => {
    const observer = vi.fn();

    notifyQaExecutionDiagnostics(observer, diagnostics());

    expect(observer).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledWith(diagnostics());
  });

  it("isolates observer failures and logs only the error name", () => {
    const observer = vi.fn(() => {
      throw new TypeError("private provider response must not be logged");
    });
    const logger = { warn: vi.fn() };

    expect(() => notifyQaExecutionDiagnostics(observer, diagnostics(), logger)).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      "[qa-observability] observer_failed error_name=TypeError"
    );
    expect(logger.warn.mock.calls.flat().join(" ")).not.toContain("private provider response");
  });

  it("isolates asynchronous observer rejection", async () => {
    const observer = vi.fn(async () => {
      throw new RangeError("private context");
    });
    const logger = { warn: vi.fn() };

    notifyQaExecutionDiagnostics(observer, diagnostics({ answerMode: "direct" }), logger);
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.warn).toHaveBeenCalledWith(
      "[qa-observability] observer_failed error_name=RangeError"
    );
  });
});

import { describe, expect, it } from "vitest";

import type {
  QaProviderModelQuestion,
  QaProviderModelRuntime
} from "./qa-provider-model-benchmark";
import {
  buildDsLifecyclePromptExperimentReport,
  createDsLifecyclePromptSchedule,
  DS_LIFECYCLE_PROMPT_RULES,
  effectiveDsPromptInstruction,
  type DsLifecyclePromptRun
} from "./ds-lifecycle-prompt-experiment";

const runtime: QaProviderModelRuntime = {
  alias: "ds-v4",
  modelId: "deepseek-v4-flash",
  wireApi: "chat",
  route: "configured_deepseek",
  sdkMaxRetries: 2
};

const question: QaProviderModelQuestion = {
  id: "q034",
  category: "lifecycle",
  question: "她答应的事情都做完了吗？",
  expectedScope: "current",
  evaluation: {
    kind: "aggregate_lifecycle",
    expectedState: "partial_or_unknown",
    requiredAnswerAnyOf: []
  }
};

function run(
  variant: DsLifecyclePromptRun["prompt_variant"],
  round: number,
  correct: boolean
): DsLifecyclePromptRun {
  return {
    run_id: `${variant}-${round}`,
    round,
    execution_order: round === 2 ? 2 : 1,
    prompt_variant: variant,
    status: "completed",
    model_id: runtime.modelId,
    wire_api: runtime.wireApi,
    route: runtime.route,
    evidence_count: 4,
    evidence_digest: "fixed-evidence",
    prompt_characters: variant === "current" ? 7467 : 7798,
    ttft_ms: 1000 + round,
    generation_latency_ms: 2000 + round,
    total_latency_ms: 2100 + round,
    answer: correct
      ? "不能确认都已完成；现有记录同时包含已完成和仍待执行的承诺。[E1][E2]"
      : "她答应的事情都已经完成。[E1]",
    citation_valid: true,
    lifecycle_correct: correct,
    final_quality_pass: correct,
    fallback_status: "none",
    provider_path: "native_answer",
    error_name: null,
    error_code: null
  };
}

describe("DS lifecycle prompt experiment", () => {
  it("interleaves the two prompt variants over exactly three rounds", () => {
    expect(createDsLifecyclePromptSchedule()).toEqual([
      { round: 1, executionOrder: 1, variant: "current" },
      { round: 1, executionOrder: 2, variant: "lifecycle_enhanced" },
      { round: 2, executionOrder: 1, variant: "lifecycle_enhanced" },
      { round: 2, executionOrder: 2, variant: "current" },
      { round: 3, executionOrder: 1, variant: "current" },
      { round: 3, executionOrder: 2, variant: "lifecycle_enhanced" }
    ]);
  });

  it("only appends the lifecycle rules to the enhanced instruction", () => {
    const base = "现有 benchmark prompt";

    expect(effectiveDsPromptInstruction(base, "current")).toBe(base);
    expect(effectiveDsPromptInstruction(base, "lifecycle_enhanced")).toBe(
      `${base}\n\n${DS_LIFECYCLE_PROMPT_RULES}`
    );
  });

  it("requires six completed runs with one fixed evidence digest", () => {
    const schedule = createDsLifecyclePromptSchedule();
    const runs = schedule.map((entry) =>
      run(entry.variant, entry.round, entry.variant === "lifecycle_enhanced")
    );
    const report = buildDsLifecyclePromptExperimentReport({
      question,
      contextDigest: "context",
      memoryContextDigest: "memory",
      contextUnchanged: true,
      runtime,
      basePromptInstruction: "现有 benchmark prompt",
      referenceEvidenceDigest: "fixed-evidence",
      schedule,
      runs,
      generatedAt: "2026-07-23T00:00:00.000Z"
    });

    expect(report.integrity.valid).toBe(true);
    expect(report.aggregates.current).toMatchObject({
      correct: 0,
      wrong: 3,
      fallback: 0
    });
    expect(report.aggregates.lifecycle_enhanced).toMatchObject({
      correct: 3,
      wrong: 0,
      fallback: 0
    });
    expect(report.interpretation_signal).toBe("prompt_adaptation_supported");
  });

  it("invalidates the experiment when retrieval evidence changes", () => {
    const schedule = createDsLifecyclePromptSchedule();
    const runs = schedule.map((entry, index) => ({
      ...run(entry.variant, entry.round, true),
      evidence_digest: index === 5 ? "changed-evidence" : "fixed-evidence"
    }));
    const report = buildDsLifecyclePromptExperimentReport({
      question,
      contextDigest: "context",
      memoryContextDigest: "memory",
      contextUnchanged: true,
      runtime,
      basePromptInstruction: "现有 benchmark prompt",
      referenceEvidenceDigest: "fixed-evidence",
      schedule,
      runs
    });

    expect(report.integrity.valid).toBe(false);
    expect(report.integrity.distinct_evidence_digests).toBe(2);
    expect(report.interpretation_signal).toBe("invalid_experiment");
  });
});

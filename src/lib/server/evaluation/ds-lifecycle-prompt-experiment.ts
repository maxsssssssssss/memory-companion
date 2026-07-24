import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { buildHumanizedQaSystemPrompt } from "@/lib/server/retrieval/ai-qa";

import {
  evaluateQaProviderModelQuality,
  qaProviderModelEvidenceDigest,
  type QaProviderModelExecution,
  type QaProviderModelQuality,
  type QaProviderModelQuestion,
  type QaProviderModelRuntime
} from "./qa-provider-model-benchmark";

export const DS_LIFECYCLE_PROMPT_EXPERIMENT_VERSION = 1;
export const DS_LIFECYCLE_PROMPT_RULES = [
  "Important reasoning rules:",
  "1. A commitment is not a completion.",
  "2. A scheduled or planned event is not proof that the action happened.",
  "3. Confirmation of an arrangement does not mean fulfillment.",
  "4. Only explicit evidence of execution means completed.",
  "5. If completion evidence is missing: clearly state that completion cannot be confirmed."
].join("\n");

export type DsLifecyclePromptVariant = "current" | "lifecycle_enhanced";

export type DsLifecyclePromptScheduleEntry = {
  round: number;
  executionOrder: 1 | 2;
  variant: DsLifecyclePromptVariant;
};

export type DsLifecyclePromptRun = {
  run_id: string;
  round: number;
  execution_order: 1 | 2;
  prompt_variant: DsLifecyclePromptVariant;
  status: "completed" | "failed";
  model_id: string;
  wire_api: "chat" | "responses";
  route: QaProviderModelRuntime["route"];
  evidence_count: number | null;
  evidence_digest: string | null;
  prompt_characters: number | null;
  ttft_ms: number | null;
  generation_latency_ms: number | null;
  total_latency_ms: number | null;
  answer: string | null;
  citation_valid: boolean | null;
  lifecycle_correct: boolean | null;
  final_quality_pass: boolean | null;
  fallback_status: string;
  provider_path: QaProviderModelQuality["providerPath"] | null;
  error_name: string | null;
  error_code: string | null;
};

type DsLifecyclePromptAggregate = {
  planned: number;
  completed: number;
  failed: number;
  correct: number;
  wrong: number;
  fallback: number;
  citation_valid: number;
  mean_ttft_ms: number | null;
  median_ttft_ms: number | null;
  mean_generation_latency_ms: number | null;
  median_generation_latency_ms: number | null;
  mean_total_latency_ms: number | null;
  median_total_latency_ms: number | null;
  min_total_latency_ms: number | null;
  max_total_latency_ms: number | null;
};

export type DsLifecyclePromptExperimentReport = {
  version: 1;
  generated_at: string;
  execution: {
    remote: true;
    serialized: true;
    application_requests: number;
    sdk_max_retries: number;
    schedule: DsLifecyclePromptScheduleEntry[];
  };
  source: {
    dataset_version: "long-recording-60m-v1";
    context_digest: string;
    memory_context_digest: string;
    question_id: "q034";
    question_digest: string;
    reference_evidence_digest: string | null;
  };
  model: {
    alias: "ds-v4";
    model_id: string;
    wire_api: "chat" | "responses";
    route: QaProviderModelRuntime["route"];
  };
  prompts: {
    base_instruction_digest: string;
    base_instruction_characters: number;
    lifecycle_rules_digest: string;
    lifecycle_rules_characters: number;
    variants: Record<DsLifecyclePromptVariant, {
      system_prompt_digest: string;
      system_prompt_characters: number;
    }>;
  };
  integrity: {
    valid: boolean;
    completed_runs: number;
    expected_runs: 6;
    current_runs: number;
    lifecycle_enhanced_runs: number;
    distinct_evidence_digests: number;
    distinct_evidence_counts: number;
    evidence_matches_reference: boolean | null;
    context_unchanged: boolean;
  };
  runs: DsLifecyclePromptRun[];
  aggregates: Record<DsLifecyclePromptVariant, DsLifecyclePromptAggregate>;
  interpretation_signal:
    | "prompt_adaptation_supported"
    | "model_limitation_not_resolved"
    | "baseline_variability_inconclusive"
    | "inconclusive"
    | "invalid_experiment";
  limitations: string[];
};

export function stableExperimentDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createDsLifecyclePromptSchedule(
  rounds = 3
): DsLifecyclePromptScheduleEntry[] {
  if (rounds !== 3) {
    throw new Error("DS lifecycle prompt experiment requires exactly 3 rounds");
  }
  const orders: Array<[DsLifecyclePromptVariant, DsLifecyclePromptVariant]> = [
    ["current", "lifecycle_enhanced"],
    ["lifecycle_enhanced", "current"],
    ["current", "lifecycle_enhanced"]
  ];
  return orders.flatMap((variants, roundIndex) =>
    variants.map((variant, orderIndex) => ({
      round: roundIndex + 1,
      executionOrder: (orderIndex + 1) as 1 | 2,
      variant
    }))
  );
}

export function effectiveDsPromptInstruction(
  basePromptInstruction: string,
  variant: DsLifecyclePromptVariant
) {
  const base = basePromptInstruction.trim();
  return variant === "lifecycle_enhanced"
    ? [base, DS_LIFECYCLE_PROMPT_RULES].filter(Boolean).join("\n\n")
    : base;
}

function fallbackStatus(execution: QaProviderModelExecution) {
  return execution.diagnostics?.fallbackReason ??
    execution.streamTrace?.fallbackReason ??
    "diagnostics_unavailable";
}

function safeErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,80}$/u.test(code)
    ? code
    : null;
}

export function completedDsLifecyclePromptRun(input: {
  schedule: DsLifecyclePromptScheduleEntry;
  question: QaProviderModelQuestion;
  execution: QaProviderModelExecution;
}): DsLifecyclePromptRun {
  const fallback = fallbackStatus(input.execution);
  const quality = evaluateQaProviderModelQuality({
    question: input.question,
    answer: input.execution.answer,
    evidence: input.execution.evidence,
    fallbackStatus: fallback
  });
  return {
    run_id: `r${input.schedule.round}-${input.schedule.variant}-${randomUUID()}`,
    round: input.schedule.round,
    execution_order: input.schedule.executionOrder,
    prompt_variant: input.schedule.variant,
    status: "completed",
    model_id: input.execution.modelId,
    wire_api: input.execution.wireApi,
    route: input.execution.route,
    evidence_count: input.execution.evidence.length,
    evidence_digest: qaProviderModelEvidenceDigest(input.execution.evidence),
    prompt_characters: input.execution.diagnostics?.promptCharacters ?? null,
    ttft_ms: input.execution.streamTrace?.latencies.firstTokenMs ?? null,
    generation_latency_ms: input.execution.diagnostics?.llmGenerationMs ??
      input.execution.streamTrace?.latencies.totalStreamMs ??
      null,
    total_latency_ms: input.execution.totalLatencyMs,
    answer: input.execution.answer.answer,
    citation_valid:
      quality.citation.finalValid && quality.citation.inlineMetadataAligned,
    lifecycle_correct: quality.lifecycle.pass,
    final_quality_pass: quality.finalQualityPass,
    fallback_status: fallback,
    provider_path: quality.providerPath,
    error_name: null,
    error_code: null
  };
}

export function failedDsLifecyclePromptRun(input: {
  schedule: DsLifecyclePromptScheduleEntry;
  runtime: QaProviderModelRuntime;
  error: unknown;
}): DsLifecyclePromptRun {
  return {
    run_id: `r${input.schedule.round}-${input.schedule.variant}-${randomUUID()}`,
    round: input.schedule.round,
    execution_order: input.schedule.executionOrder,
    prompt_variant: input.schedule.variant,
    status: "failed",
    model_id: input.runtime.modelId,
    wire_api: input.runtime.wireApi,
    route: input.runtime.route,
    evidence_count: null,
    evidence_digest: null,
    prompt_characters: null,
    ttft_ms: null,
    generation_latency_ms: null,
    total_latency_ms: null,
    answer: null,
    citation_valid: null,
    lifecycle_correct: null,
    final_quality_pass: null,
    fallback_status: "execution_error",
    provider_path: null,
    error_name: input.error instanceof Error ? input.error.name : "unknown",
    error_code: safeErrorCode(input.error)
  };
}

function mean(values: number[]) {
  return values.length === 0
    ? null
    : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

function aggregate(
  runs: DsLifecyclePromptRun[],
  planned: number
): DsLifecyclePromptAggregate {
  const completed = runs.filter((run) => run.status === "completed");
  const metric = (
    key: "ttft_ms" | "generation_latency_ms" | "total_latency_ms"
  ) => completed.flatMap((run) => run[key] === null ? [] : [run[key]]);
  const ttft = metric("ttft_ms");
  const generation = metric("generation_latency_ms");
  const total = metric("total_latency_ms");
  return {
    planned,
    completed: completed.length,
    failed: planned - completed.length,
    correct: completed.filter((run) => run.final_quality_pass).length,
    wrong: completed.filter((run) => run.final_quality_pass === false).length,
    fallback: completed.filter((run) => run.fallback_status !== "none").length,
    citation_valid: completed.filter((run) => run.citation_valid).length,
    mean_ttft_ms: mean(ttft),
    median_ttft_ms: median(ttft),
    mean_generation_latency_ms: mean(generation),
    median_generation_latency_ms: median(generation),
    mean_total_latency_ms: mean(total),
    median_total_latency_ms: median(total),
    min_total_latency_ms: total.length > 0 ? Math.min(...total) : null,
    max_total_latency_ms: total.length > 0 ? Math.max(...total) : null
  };
}

function interpretation(
  valid: boolean,
  aggregates: DsLifecyclePromptExperimentReport["aggregates"]
): DsLifecyclePromptExperimentReport["interpretation_signal"] {
  if (!valid) return "invalid_experiment";
  const current = aggregates.current;
  const enhanced = aggregates.lifecycle_enhanced;
  if (enhanced.correct === 3 && current.correct < 3) {
    return "prompt_adaptation_supported";
  }
  if (enhanced.correct < 3 && enhanced.correct <= current.correct) {
    return "model_limitation_not_resolved";
  }
  if (enhanced.correct === 3 && current.correct === 3) {
    return "baseline_variability_inconclusive";
  }
  return "inconclusive";
}

export function buildDsLifecyclePromptExperimentReport(input: {
  question: QaProviderModelQuestion;
  contextDigest: string;
  memoryContextDigest: string;
  contextUnchanged: boolean;
  runtime: QaProviderModelRuntime;
  basePromptInstruction: string;
  referenceEvidenceDigest?: string;
  schedule: DsLifecyclePromptScheduleEntry[];
  runs: DsLifecyclePromptRun[];
  generatedAt?: string;
}): DsLifecyclePromptExperimentReport {
  const completed = input.runs.filter((run) => run.status === "completed");
  const evidenceDigests = new Set(
    completed.flatMap((run) => run.evidence_digest ? [run.evidence_digest] : [])
  );
  const evidenceCounts = new Set(
    completed.flatMap((run) => run.evidence_count === null ? [] : [run.evidence_count])
  );
  const referenceEvidenceDigest = input.referenceEvidenceDigest?.trim() || null;
  const evidenceMatchesReference = referenceEvidenceDigest === null
    ? null
    : evidenceDigests.size === 1 && evidenceDigests.has(referenceEvidenceDigest);
  const currentRuns = input.runs.filter((run) => run.prompt_variant === "current");
  const enhancedRuns = input.runs.filter(
    (run) => run.prompt_variant === "lifecycle_enhanced"
  );
  const valid =
    input.runs.length === 6 &&
    completed.length === 6 &&
    currentRuns.length === 3 &&
    enhancedRuns.length === 3 &&
    evidenceDigests.size === 1 &&
    evidenceCounts.size === 1 &&
    evidenceMatchesReference !== false &&
    input.contextUnchanged;
  const aggregates = {
    current: aggregate(currentRuns, 3),
    lifecycle_enhanced: aggregate(enhancedRuns, 3)
  };
  const currentInstruction = effectiveDsPromptInstruction(
    input.basePromptInstruction,
    "current"
  );
  const enhancedInstruction = effectiveDsPromptInstruction(
    input.basePromptInstruction,
    "lifecycle_enhanced"
  );
  const currentSystemPrompt = buildHumanizedQaSystemPrompt(
    "current",
    currentInstruction
  );
  const enhancedSystemPrompt = buildHumanizedQaSystemPrompt(
    "current",
    enhancedInstruction
  );
  return {
    version: DS_LIFECYCLE_PROMPT_EXPERIMENT_VERSION,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    execution: {
      remote: true,
      serialized: true,
      application_requests: input.schedule.length,
      sdk_max_retries: input.runtime.sdkMaxRetries,
      schedule: input.schedule
    },
    source: {
      dataset_version: "long-recording-60m-v1",
      context_digest: input.contextDigest,
      memory_context_digest: input.memoryContextDigest,
      question_id: "q034",
      question_digest: stableExperimentDigest(input.question.question),
      reference_evidence_digest: referenceEvidenceDigest
    },
    model: {
      alias: "ds-v4",
      model_id: input.runtime.modelId,
      wire_api: input.runtime.wireApi,
      route: input.runtime.route
    },
    prompts: {
      base_instruction_digest: stableExperimentDigest(input.basePromptInstruction),
      base_instruction_characters: input.basePromptInstruction.length,
      lifecycle_rules_digest: stableExperimentDigest(DS_LIFECYCLE_PROMPT_RULES),
      lifecycle_rules_characters: DS_LIFECYCLE_PROMPT_RULES.length,
      variants: {
        current: {
          system_prompt_digest: stableExperimentDigest(currentSystemPrompt),
          system_prompt_characters: currentSystemPrompt.length
        },
        lifecycle_enhanced: {
          system_prompt_digest: stableExperimentDigest(enhancedSystemPrompt),
          system_prompt_characters: enhancedSystemPrompt.length
        }
      }
    },
    integrity: {
      valid,
      completed_runs: completed.length,
      expected_runs: 6,
      current_runs: currentRuns.length,
      lifecycle_enhanced_runs: enhancedRuns.length,
      distinct_evidence_digests: evidenceDigests.size,
      distinct_evidence_counts: evidenceCounts.size,
      evidence_matches_reference: evidenceMatchesReference,
      context_unchanged: input.contextUnchanged
    },
    runs: input.runs,
    aggregates,
    interpretation_signal: interpretation(valid, aggregates),
    limitations: [
      "Each prompt variant has only three real API samples; this is a directional prompt-adaptation check, not a statistically conclusive model evaluation.",
      "Latency includes current external provider load and configured SDK retry behavior.",
      "The enhanced prompt is longer, so small latency differences cannot be attributed to model speed alone.",
      "Lifecycle correctness uses the unchanged q034 deterministic benchmark rubric and is supplemented by answer-text review.",
      "No production model, retrieval path, Agent QA prompt builder, or validation rule is changed."
    ]
  };
}

function metric(value: number | null) {
  return value === null ? "N/A" : value.toLocaleString("en-US");
}

export function renderDsLifecyclePromptExperimentReport(
  report: DsLifecyclePromptExperimentReport
) {
  const summaryRows = ([
    ["Current DS", report.aggregates.current],
    ["Lifecycle enhanced DS", report.aggregates.lifecycle_enhanced]
  ] as const).map(([label, value]) =>
    `| ${label} | ${value.correct} | ${value.wrong} | ${value.fallback} | ${metric(value.mean_total_latency_ms)} ms mean (${metric(value.median_total_latency_ms)} ms median) |`
  );
  const runRows = report.runs.map((run) =>
    `| ${run.round} | ${run.execution_order} | ${run.prompt_variant} | ${run.status} | ${metric(run.ttft_ms)} | ${metric(run.generation_latency_ms)} | ${metric(run.total_latency_ms)} | ${run.citation_valid === null ? "N/A" : run.citation_valid ? "pass" : "fail"} | ${run.lifecycle_correct === null ? "N/A" : run.lifecycle_correct ? "pass" : "fail"} | ${run.fallback_status} | ${run.answer ?? "N/A"} |`
  );
  return `# DS v4 q034 Lifecycle Prompt Adaptation

## Experiment integrity

- Question: q034, “她答应的事情都做完了吗？”
- Application-level Provider requests: ${report.execution.application_requests}
- Serialized, interleaved order: current/enhanced, enhanced/current, current/enhanced
- Context digest: \`${report.source.context_digest}\`
- Evidence digest reference: \`${report.source.reference_evidence_digest ?? "not supplied"}\`
- Distinct observed Evidence digests: ${report.integrity.distinct_evidence_digests}
- Evidence matches reference: ${report.integrity.evidence_matches_reference === null ? "not checked" : report.integrity.evidence_matches_reference}
- Integrity gate: ${report.integrity.valid ? "pass" : "fail"}
- Production default changed: no

## Results

| Prompt | Correct | Wrong | Fallback | Latency |
| --- | ---: | ---: | ---: | --- |
${summaryRows.join("\n")}

## Per-run details

| Round | Order | Prompt | Status | TTFT ms | Generation ms | Total ms | Citation | Lifecycle | Fallback | Answer |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | --- | --- | --- |
${runRows.join("\n")}

## Interpretation

Signal: \`${report.interpretation_signal}\`.

This signal must be read with the three-sample limitation. It indicates whether
the five explicit lifecycle rules improved q034 under fixed retained context; it
does not by itself prove a general model capability difference.

## Limitations

${report.limitations.map((item) => `- ${item}`).join("\n")}
`;
}

async function atomicWrite(path: string, content: string) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeDsLifecyclePromptExperimentJson(
  path: string,
  report: DsLifecyclePromptExperimentReport
) {
  await atomicWrite(path, `${JSON.stringify(report, null, 2)}\n`);
}

export async function writeDsLifecyclePromptExperimentMarkdown(
  path: string,
  report: DsLifecyclePromptExperimentReport
) {
  await atomicWrite(path, renderDsLifecyclePromptExperimentReport(report));
}

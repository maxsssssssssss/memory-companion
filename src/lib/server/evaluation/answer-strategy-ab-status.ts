import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

const PartialStatusSchema = z.object({
  status: z.enum(["running", "completed", "failed"]),
  updatedAt: z.string().datetime(),
  completedRuns: z.number().int().nonnegative(),
  totalRuns: z.number().int().positive(),
  currentRun: z.object({
    run_id: z.string(),
    question_id: z.string(),
    category: z.string(),
    round: z.number().int().positive(),
    answer_mode: z.enum(["agent", "direct"]),
    execution_order: z.union([z.literal(1), z.literal(2)]),
    started_at: z.string().datetime()
  }).nullable().optional(),
  error: z.object({
    error_name: z.string(),
    error_code: z.string().nullable()
  }).nullable().optional(),
  report: z.object({
    runs: z.array(z.object({
      answer_mode: z.enum(["agent", "direct"]),
      status: z.enum(["completed", "failed"]),
      total_latency_ms: z.number().int().nonnegative().nullable(),
      fallback_status: z.string()
    }).passthrough())
  }).passthrough()
}).strict();

export type AnswerStrategyBenchmarkStatusOptions = {
  partialReportPath: string;
  watch: boolean;
  intervalMs: number;
};

function requiredValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1];
  if (!value?.trim() || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value.trim();
}

export function parseAnswerStrategyBenchmarkStatusArgs(argv: string[]) {
  let partialReportPath =
    "reports/long-recording-60m-answer-strategy-ab.partial.json";
  let watch = false;
  let intervalMs = 2_000;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--watch") {
      watch = true;
      continue;
    }
    if (argument !== "--partial" && argument !== "--interval-ms") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = requiredValue(argv, index, argument);
    index += 1;
    if (argument === "--partial") partialReportPath = value;
    else intervalMs = Number(value);
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 500 || intervalMs > 60_000) {
    throw new Error("--interval-ms must be an integer between 500 and 60000");
  }
  return { partialReportPath: resolve(partialReportPath), watch, intervalMs };
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
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export function summarizeAnswerStrategyBenchmarkStatus(
  input: z.infer<typeof PartialStatusSchema>,
  now = new Date()
) {
  const runs = input.report.runs;
  const latencies = runs.flatMap((run) =>
    run.total_latency_ms === null ? [] : [run.total_latency_ms]
  );
  const meanLatencyMs = mean(latencies);
  const medianLatencyMs = median(latencies);
  const remainingRuns = Math.max(0, input.totalRuns - input.completedRuns);
  const terminal = input.status !== "running";
  const currentRunStartedAt = input.currentRun?.started_at;
  return {
    status: input.status,
    completed_runs: input.completedRuns,
    total_runs: input.totalRuns,
    progress_percent: Math.round((input.completedRuns / input.totalRuns) * 10_000) / 100,
    agent_runs: runs.filter((run) => run.answer_mode === "agent").length,
    direct_runs: runs.filter((run) => run.answer_mode === "direct").length,
    failed_runs: runs.filter((run) => run.status === "failed").length,
    fallback_runs: runs.filter(
      (run) => run.status === "completed" && run.fallback_status !== "none"
    ).length,
    mean_run_latency_ms: meanLatencyMs,
    median_run_latency_ms: medianLatencyMs,
    estimated_remaining_ms:
      terminal || medianLatencyMs === null ? terminal ? 0 : null : medianLatencyMs * remainingRuns,
    eta_basis: "median_completed_run_latency",
    current_run: input.currentRun ?? null,
    current_run_elapsed_ms: terminal || !currentRunStartedAt
      ? null
      : Math.max(0, now.getTime() - new Date(currentRunStartedAt).getTime()),
    error: input.error ?? null,
    updated_at: input.updatedAt,
    stale_for_seconds: terminal
      ? null
      : Math.max(
        0,
        Math.round((now.getTime() - new Date(input.updatedAt).getTime()) / 1_000)
      )
  };
}

export async function readAnswerStrategyBenchmarkStatus(
  partialReportPath: string,
  now = new Date()
) {
  try {
    const raw = await readFile(resolve(partialReportPath), "utf8");
    return summarizeAnswerStrategyBenchmarkStatus(
      PartialStatusSchema.parse(JSON.parse(raw)),
      now
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

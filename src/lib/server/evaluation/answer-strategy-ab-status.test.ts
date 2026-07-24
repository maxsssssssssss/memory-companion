// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  parseAnswerStrategyBenchmarkStatusArgs,
  summarizeAnswerStrategyBenchmarkStatus
} from "./answer-strategy-ab-status";

describe("answer strategy A/B status monitor", () => {
  it("parses one-shot and watch options", () => {
    expect(parseAnswerStrategyBenchmarkStatusArgs([])).toMatchObject({
      watch: false,
      intervalMs: 2_000
    });
    expect(parseAnswerStrategyBenchmarkStatusArgs([
      "--watch",
      "--partial",
      "reports/custom.partial.json",
      "--interval-ms",
      "1000"
    ])).toMatchObject({ watch: true, intervalMs: 1_000 });
  });

  it("reports live counts, failures, fallback, and ETA", () => {
    const status = summarizeAnswerStrategyBenchmarkStatus({
      status: "running",
      updatedAt: "2026-07-22T00:00:10.000Z",
      completedRuns: 2,
      totalRuns: 10,
      report: {
        runs: [
          {
            answer_mode: "agent",
            status: "completed",
            total_latency_ms: 1_000,
            fallback_status: "none"
          },
          {
            answer_mode: "direct",
            status: "completed",
            total_latency_ms: 3_000,
            fallback_status: "provider_error"
          }
        ]
      }
    }, new Date("2026-07-22T00:00:15.000Z"));

    expect(status).toMatchObject({
      completed_runs: 2,
      total_runs: 10,
      progress_percent: 20,
      agent_runs: 1,
      direct_runs: 1,
      failed_runs: 0,
      fallback_runs: 1,
      mean_run_latency_ms: 2_000,
      median_run_latency_ms: 2_000,
      estimated_remaining_ms: 16_000,
      eta_basis: "median_completed_run_latency",
      stale_for_seconds: 5
    });
  });

  it("reports the current run elapsed time and clears staleness at a terminal state", () => {
    const base = {
      updatedAt: "2026-07-22T00:00:10.000Z",
      completedRuns: 0,
      totalRuns: 10,
      currentRun: {
        run_id: "r01-q001-agent",
        question_id: "q001",
        category: "fact",
        round: 1,
        answer_mode: "agent" as const,
        execution_order: 1 as const,
        started_at: "2026-07-22T00:00:09.000Z"
      },
      report: { runs: [] }
    };
    expect(summarizeAnswerStrategyBenchmarkStatus(
      { ...base, status: "running" },
      new Date("2026-07-22T00:00:15.000Z")
    )).toMatchObject({
      current_run_elapsed_ms: 6_000,
      stale_for_seconds: 5,
      estimated_remaining_ms: null
    });
    expect(summarizeAnswerStrategyBenchmarkStatus(
      {
        ...base,
        status: "failed",
        error: { error_name: "Error", error_code: null }
      },
      new Date("2026-07-22T00:00:15.000Z")
    )).toMatchObject({
      status: "failed",
      current_run_elapsed_ms: null,
      stale_for_seconds: null,
      estimated_remaining_ms: 0,
      error: { error_name: "Error", error_code: null }
    });
  });
});

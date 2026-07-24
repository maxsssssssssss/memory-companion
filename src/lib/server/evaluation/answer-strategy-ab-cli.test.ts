// @vitest-environment node

import { describe, expect, it } from "vitest";

import { parseAnswerStrategyBenchmarkArgs } from "./answer-strategy-ab-cli";

const required = ["--user-id", "user_1", "--upload-id", "upload_1"];

describe("answer strategy A/B CLI", () => {
  it("defaults to a network-free plan", () => {
    const options = parseAnswerStrategyBenchmarkArgs(required, {});
    expect(options.remote).toBe(false);
    expect(options.rounds).toBe(3);
    expect(options.datasetPath).toMatch(/long-recording-60m\.json$/u);
  });

  it("requires both explicit remote switches", () => {
    expect(() => parseAnswerStrategyBenchmarkArgs([...required, "--remote"], {})).toThrow(
      "RUN_ANSWER_STRATEGY_AB_REMOTE_VERIFY=1"
    );
    expect(parseAnswerStrategyBenchmarkArgs(
      [...required, "--remote"],
      { RUN_ANSWER_STRATEGY_AB_REMOTE_VERIFY: "1" }
    ).remote).toBe(true);
  });

  it("rejects invalid rounds and unsafe store keys", () => {
    expect(() => parseAnswerStrategyBenchmarkArgs(
      [...required, "--rounds", "2"],
      {}
    )).toThrow("between 3 and 20");
    expect(() => parseAnswerStrategyBenchmarkArgs(
      ["--user-id", "../user", "--upload-id", "upload_1"],
      {}
    )).toThrow("safe store key");
  });
});

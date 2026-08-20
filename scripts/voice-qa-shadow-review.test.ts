// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  parseVoiceQaShadowReviewArgs
} from "./voice-qa-shadow-review";

describe("voice-qa-shadow-review CLI", () => {
  it("parses replay case filters and resolves private paths", () => {
    expect(parseVoiceQaShadowReviewArgs([
      "replay",
      "--user",
      "user_1",
      "--case",
      "case_1",
      "--case",
      "case_2",
      "--data-root",
      ".data"
    ])).toMatchObject({
      command: "replay",
      userId: "user_1",
      caseIds: ["case_1", "case_2"]
    });
  });

  it("requires private JSON only for import commands", () => {
    expect(() => parseVoiceQaShadowReviewArgs([
      "attach-question",
      "--user",
      "user_1"
    ])).toThrow("--input is required");
    expect(() => parseVoiceQaShadowReviewArgs([
      "status",
      "--user",
      "user_1",
      "--input",
      "private.json"
    ])).toThrow("--input is not supported");
  });

  it("supports private Gold templates and fail-closed blind generation case filters", () => {
    expect(parseVoiceQaShadowReviewArgs([
      "gold-template",
      "--user",
      "user_1",
      "--case",
      "case_1",
      "--output",
      ".data/users/user_1/evaluation/voice-qa-shadow-review-v1/gold.json"
    ])).toMatchObject({
      command: "gold-template",
      caseIds: ["case_1"]
    });
    expect(parseVoiceQaShadowReviewArgs([
      "blind-generate",
      "--user",
      "user_1",
      "--case",
      "case_1"
    ])).toMatchObject({
      command: "blind-generate",
      caseIds: ["case_1"]
    });
  });
});
